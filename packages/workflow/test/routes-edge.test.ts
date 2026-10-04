import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import autoload from '@fastify/autoload'
import fp from 'fastify-plugin'
import { setupTest, teardownTest, failQueries, interceptQueries, type TestContext } from './helper.ts'
import { routeMessage } from '../queue/router.ts'
import appsPlugin from '../plugins/apps.ts'
import versionsPlugin from '../plugins/versions.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('route edge cases', () => {
  let ctx: TestContext
  let applicationId: number

  before(async () => {
    ctx = await setupTest()
    const app = await ctx.app.pg.query('SELECT id FROM workflow_applications WHERE app_id = $1', [ctx.appId])
    applicationId = app.rows[0].id
  })

  after(async () => {
    await teardownTest(ctx)
  })

  function call (method: string, path: string, payload?: unknown, headers?: Record<string, string>) {
    return ctx.app.inject({ method: method as any, url: `/api/v1/apps/${ctx.appId}${path}`, payload: payload as any, headers })
  }

  async function createRun (specVersion = 2, workflowName = 'edge'): Promise<string> {
    const runId = `wrun_${randomBytes(8).toString('hex')}`
    const res = await call('POST', `/runs/${runId}/events`, {
      eventType: 'run_created',
      specVersion,
      eventData: { deploymentId: 'v1', workflowName },
    })
    assert.equal(res.statusCode, 200)
    return runId
  }

  it('leaves /status public in single-tenant mode', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/status' })
    assert.notEqual(res.statusCode, 401)
    assert.notEqual(res.statusCode, 500)
  })

  describe('queue', () => {
    it('rejects an undecodable CBOR body', async () => {
      const res = await call('POST', '/queue', Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff]), { 'content-type': 'application/cbor' })
      assert.equal(res.statusCode, 500)
    })

    it('rejects an envelope without a queue name, message, or content type', async () => {
      assert.equal((await call('POST', '/queue', { queueName: '__wkf_workflow_x' })).statusCode, 400)
      assert.equal((await call('POST', '/queue', { message: {} })).statusCode, 400)
      const bare = await ctx.app.inject({ method: 'POST', url: `/api/v1/apps/${ctx.appId}/queue` })
      assert.equal(bare.statusCode, 400)
    })

    it('answers a lost idempotency race with 409, immediate or deferred', async () => {
      for (const delaySeconds of [0, 30]) {
        const idempotencyKey = `race-${randomUUID()}`
        const envelope = { queueName: '__wkf_workflow_race', message: { runId: 'r' }, idempotencyKey, delaySeconds }
        assert.equal((await call('POST', '/queue', envelope)).statusCode, 201)

        // The duplicate pre-check misses a row another request is committing.
        const restore = interceptQueries(ctx.app.pg, (sql) => {
          if (sql.includes('WHERE idempotency_key = $1')) return { rows: [] }
        })
        try {
          const res = await call('POST', '/queue', envelope)
          assert.equal(res.statusCode, 409)
          assert.match(res.json().message, new RegExp(idempotencyKey))
        } finally {
          restore()
        }
      }
    })

    it('surfaces other insert failures, immediate or deferred', async () => {
      const restore = failQueries(ctx.app.pg, /INSERT INTO workflow_queue_messages/)
      try {
        for (const delaySeconds of [0, 30]) {
          const res = await call('POST', '/queue', { queueName: '__wkf_workflow_x', message: { runId: 'r' }, delaySeconds })
          assert.equal(res.statusCode, 500)
        }
      } finally {
        restore()
      }
    })

    it('routes to nothing when no handler is registered', async () => {
      assert.equal(await routeMessage(ctx.app.pg, applicationId, 'never-registered', '__wkf_workflow_x'), null)
    })
  })

  describe('handlers', () => {
    it('accepts machineId in place of podId', async () => {
      const res = await call('POST', '/handlers', {
        machineId: 'machine-1',
        deploymentVersion: 'v-machine',
        endpoints: { workflow: 'http://h/flow', step: 'http://h/step', webhook: 'http://h/webhook' },
      })
      assert.equal(res.statusCode, 201)
      const row = await ctx.app.pg.query('SELECT pod_id FROM workflow_queue_handlers WHERE application_id = $1 AND deployment_version = $2', [applicationId, 'v-machine'])
      assert.equal(row.rows[0].pod_id, 'machine-1')
    })

    it('rolls back a failed registration', async () => {
      const restore = failQueries(ctx.app.pg, /INSERT INTO workflow_queue_handlers/)
      try {
        const res = await call('POST', '/handlers', {
          podId: 'pod-rollback',
          deploymentVersion: 'v1',
          endpoints: { workflow: 'http://h/flow', step: 'http://h/step', webhook: 'http://h/webhook' },
        })
        assert.equal(res.statusCode, 500)
      } finally {
        restore()
      }
    })
  })

  describe('dead letters', () => {
    it('pages with a cursor and rejects a non-numeric message id', async () => {
      const paged = await call('GET', '/dead-letters?cursor=1&limit=1')
      assert.equal(paged.statusCode, 200)
      assert.equal((await call('POST', '/dead-letters/msg_nope/retry')).statusCode, 400)
    })

    it('reports the original error even when the rollback fails too', async () => {
      const restore = interceptQueries(ctx.app.pg, async (sql, _params, run) => {
        if (sql !== 'ROLLBACK') return
        await run()
        throw new Error('connection lost')
      })
      try {
        const res = await call('POST', '/dead-letters/msg_2147483000/retry')
        assert.equal(res.statusCode, 400)
        assert.match(res.json().message, /message not found/)
      } finally {
        restore()
      }
    })
  })

  describe('draining', () => {
    it('rolls back a failed expiry', async () => {
      const runId = await createRun()
      const restore = failQueries(ctx.app.pg, /UPDATE workflow_deployment_versions SET status = 'expired'/)
      try {
        assert.equal((await call('POST', '/versions/v1/expire')).statusCode, 500)
      } finally {
        restore()
      }
      const run = await ctx.app.pg.query('SELECT status FROM workflow_runs WHERE id = $1', [runId])
      assert.equal(run.rows[0].status, 'pending')
    })
  })

  describe('encryption', () => {
    it('requires a run id and returns no key when none was provisioned', async () => {
      assert.equal((await call('GET', '/encryption-key')).statusCode, 400)
      await ctx.app.pg.query('DELETE FROM workflow_encryption_keys WHERE application_id = $1', [applicationId])
      const res = await call('GET', '/encryption-key?runId=run-1')
      assert.deepEqual(res.json(), { key: null })
    })
  })

  describe('quotas', () => {
    it('fills unspecified limits with the defaults', async () => {
      const res = await call('PUT', '/quotas', { maxEventsPerRun: 5000 })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), { maxRuns: 10_000, maxEventsPerRun: 5000, maxQueuePerMinute: 100_000 })
      await ctx.app.pg.query('DELETE FROM workflow_app_quotas WHERE application_id = $1', [applicationId])
      await call('PUT', '/quotas', { maxRuns: 10_000 })
      await ctx.app.pg.query('DELETE FROM workflow_app_quotas WHERE application_id = $1', [applicationId])
    })
  })

  describe('run actions', () => {
    it('answers 404 when cancelling or waking an unknown run', async () => {
      assert.equal((await call('POST', '/runs/no-such-run/cancel')).statusCode, 404)
      assert.equal((await call('POST', '/runs/no-such-run/wake-up')).statusCode, 404)
    })

    it('rolls back a failed replay', async () => {
      const runId = await createRun()
      const countRuns = async () => (await ctx.app.pg.query(
        'SELECT COUNT(*)::int AS count FROM workflow_runs WHERE application_id = $1',
        [applicationId]
      )).rows[0].count
      const before = await countRuns()
      const restore = failQueries(ctx.app.pg, /INSERT INTO workflow_queue_messages/)
      try {
        assert.equal((await call('POST', `/runs/${runId}/replay`)).statusCode, 500)
      } finally {
        restore()
      }
      // The replay's new run was inserted in the same transaction and must be gone.
      assert.equal(await countRuns(), before)
    })
  })

  describe('runs', () => {
    it('filters by deployment and pages with a cursor', async () => {
      const workflowName = `paged-${randomBytes(4).toString('hex')}`
      const first = await createRun(2, workflowName)
      await sleep(5)
      const second = await createRun(2, workflowName)

      const page = (await call('GET', `/runs?workflowName=${workflowName}&deploymentId=v1&limit=1`)).json()
      assert.equal(page.data[0].runId, second)
      assert.equal(page.hasMore, true)
      assert.ok(page.cursor)

      const next = (await call('GET', `/runs?workflowName=${workflowName}&limit=1&cursor=${encodeURIComponent(page.cursor)}`)).json()
      assert.equal(next.data[0].runId, first)
      assert.equal(next.hasMore, false)
      assert.equal(next.cursor, null)

      // A zero limit still reports more rows, but has no row to fence on.
      const empty = (await call('GET', `/runs?workflowName=${workflowName}&limit=0`)).json()
      assert.deepEqual(empty, { data: [], cursor: null, hasMore: true })
    })

    it('groups overlapping steps in the template and tolerates unstarted ones', async () => {
      const workflowName = `template-${randomBytes(4).toString('hex')}`
      const runId = await createRun(2, workflowName)
      await ctx.app.pg.query("UPDATE workflow_runs SET status = 'completed' WHERE id = $1", [runId])
      const base = Date.now()
      const at = (ms: number | null) => ms === null ? null : new Date(base + ms)
      // [created, started, completed] in ms offsets: a and b overlap, c never
      // started, d started but never completed.
      const steps: [string, number, number | null, number | null][] = [
        ['a', 0, 0, 100],
        ['b', 10, 50, 150],
        ['c', 200, null, null],
        ['d', 300, 300, null],
      ]
      for (const [name, created, started, completed] of steps) {
        await ctx.app.pg.query(
          `INSERT INTO workflow_steps (id, run_id, application_id, correlation_id, step_name, status, created_at, started_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8)`,
          [randomUUID(), runId, applicationId, name, name, at(created), at(started), at(completed)]
        )
      }

      const template = (await call('GET', `/workflows/${workflowName}/template`)).json()
      assert.deepEqual(template.steps, [
        { stepName: 'a', order: 0, parallelGroup: 0 },
        { stepName: 'b', order: 0, parallelGroup: 0 },
        { stepName: 'c', order: 1 },
        { stepName: 'd', order: 2 },
      ])
      assert.equal(template.hasHooks, false)
    })
  })

  describe('hooks', () => {
    it('answers 404 for an unknown token', async () => {
      assert.equal((await call('GET', '/hooks/by-token/no-such-token')).statusCode, 404)
    })

    it('lists live hooks across runs and pages with a cursor', async () => {
      const runId = await createRun()
      for (const correlationId of ['hook-a', 'hook-b', 'hook-c']) {
        await call('POST', `/runs/${runId}/events`, { eventType: 'hook_created', correlationId, eventData: { token: randomUUID() } })
      }
      await call('POST', `/runs/${runId}/events`, { eventType: 'hook_disposed', correlationId: 'hook-c' })

      const page = (await call('GET', '/hooks?limit=1')).json()
      assert.equal(page.data.length, 1)
      assert.equal(page.hasMore, true)
      assert.equal(page.cursor, '1')

      const rest = (await call('GET', `/hooks?limit=100&cursor=${page.cursor}`)).json()
      assert.equal(rest.hasMore, false)
      const all: string[] = [page.data[0].hookId]
      for (const hook of rest.data) all.push(hook.hookId)
      assert.deepEqual(all, ['hook-a', 'hook-b'])
    })
  })

  describe('events', () => {
    function batch (runId: string, events: any[] | undefined) {
      return call('POST', `/runs/${runId}/events/batch`, events === undefined ? {} : { events })
    }

    it('rejects a batch for the null run or without an events array', async () => {
      assert.equal((await batch('null', [{ event: { eventType: 'step_created' } }])).statusCode, 400)
      assert.equal((await batch('any-run', undefined)).statusCode, 400)
      const bare = await ctx.app.inject({ method: 'POST', url: `/api/v1/apps/${ctx.appId}/runs/any-run/events/batch` })
      assert.equal(bare.statusCode, 400)
    })

    it('fails a batch whose events lack a correlation id or data, and writes nothing', async () => {
      const runId = await createRun(6)
      const uncorrelated = await batch(runId, [{ event: { eventType: 'step_created', eventData: { stepName: 'a' } } }])
      assert.equal(uncorrelated.statusCode, 500)
      const noData = await batch(runId, [{ event: { eventType: 'step_created', correlationId: 'step-1' } }])
      assert.equal(noData.statusCode, 500)
      const events = await ctx.app.pg.query("SELECT id FROM workflow_events WHERE run_id = $1 AND event_type = 'step_created'", [runId])
      assert.equal(events.rows.length, 0)
    })

    it('batches a bare wait and an unversioned step', async () => {
      const runId = await createRun(6)
      const res = await batch(runId, [
        { event: { eventType: 'wait_created', correlationId: 'wait-1' } },
        { event: { eventType: 'step_created', correlationId: 'step-1', eventData: { stepName: 'a' } } },
      ])
      assert.equal(res.statusCode, 200)
      const [wait, step] = res.json().results
      assert.equal(wait.wait.resumeAt, null)
      assert.equal(wait.wait.specVersion, null)
      assert.equal(step.step.specVersion, null)
    })

    it('refuses a batched claim on a terminal step and bumps the attempt on a retry', async () => {
      const runId = await createRun(6)
      const pair = [
        { event: { eventType: 'step_created', correlationId: 'step-1', eventData: { stepName: 'a' } } },
        { event: { eventType: 'step_started', correlationId: 'step-1' } },
      ]
      assert.equal((await batch(runId, pair)).json().results[1].step.attempt, 1)

      await call('POST', `/runs/${runId}/events`, { eventType: 'step_retrying', correlationId: 'step-1' })
      const retried = await batch(runId, pair)
      assert.equal(retried.json().results[1].step.attempt, 2)

      await call('POST', `/runs/${runId}/events`, { eventType: 'step_completed', correlationId: 'step-1' })
      const terminal = await batch(runId, pair)
      assert.equal(terminal.statusCode, 400)
      assert.match(terminal.json().message, /already terminal/)
    })

    it('reports an empty skip list when the skipped slot is not this tenant\'s', async () => {
      const runId = await createRun(6)
      // Slot 2 is taken by a row scoped to another application.
      await ctx.app.pg.query(
        "INSERT INTO workflow_events (run_id, application_id, event_type) VALUES ($1, $2, 'noop')",
        [runId, applicationId + 1_000_000]
      )
      const res = await call('POST', `/runs/${runId}/events?eventCount=1`, { eventType: 'wait_created', correlationId: 'wait-1' })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      assert.deepEqual(body.events, [])
      assert.equal(body.cursor, null)
      assert.equal(body.hasMore, false)
      await ctx.app.pg.query('DELETE FROM workflow_events WHERE run_id = $1 AND application_id = $2', [runId, applicationId + 1_000_000])
    })

    it('fails cleanly on events missing their required data', async () => {
      const runId = await createRun()
      assert.equal((await call('POST', `/runs/wrun_${randomBytes(8).toString('hex')}/events`, { eventType: 'run_created' })).statusCode, 500)
      assert.equal((await call('POST', `/runs/${runId}/events`, { eventType: 'hook_created', correlationId: 'hook-x' })).statusCode, 500)
    })

    it('rejects bootstrap attributes on a pre-spec-4 run_started', async () => {
      const res = await call('POST', `/runs/wrun_${randomBytes(8).toString('hex')}/events`, {
        eventType: 'run_started',
        specVersion: 3,
        eventData: { workflowName: 'edge', deploymentId: 'v1', attributes: { k: 'v' } },
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().message, /specVersion 4 or newer/)
    })

    it('scopes a correlation listing to the named run, and spans runs without one', async () => {
      // Slot-numbered runs count their own steps and waits, so two runs
      // legitimately share a correlation id.
      const correlationId = `wait-${randomBytes(4).toString('hex')}`
      const first = await createRun(6)
      const second = await createRun(6)
      for (const runId of [first, second]) {
        await call('POST', `/runs/${runId}/events`, { eventType: 'wait_created', correlationId })
      }

      const runsOf = async (query: string): Promise<string[]> => {
        const res = await call('GET', `/events/by-correlation?correlationId=${correlationId}${query}`)
        assert.equal(res.statusCode, 200)
        const out: string[] = []
        for (const event of res.json().data) out.push(event.runId)
        return out
      }
      assert.deepEqual(await runsOf(`&runId=${first}`), [first])
      assert.deepEqual(await runsOf(`&runId=${second}`), [second])
      assert.deepEqual(await runsOf('&runId=no-such-run'), [])
      assert.deepEqual(await runsOf(''), [first, second])
    })

    it('lists nothing, with a null cursor, for a run or correlation without events', async () => {
      const byRun = (await call('GET', '/runs/no-such-run/events')).json()
      assert.deepEqual(byRun, { data: [], cursor: null, hasMore: false })
      const byCorrelation = (await call('GET', '/events/by-correlation?correlationId=no-such-correlation')).json()
      assert.deepEqual(byCorrelation, { data: [], cursor: null, hasMore: false })
    })
  })
})

describe('service bootstrap', () => {
  it('refuses to start without DATABASE_URL', async () => {
    const saved = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    const app = Fastify({ logger: false })
    try {
      await assert.rejects(
        app.register(autoload, { dir: join(__dirname, '..', 'plugins') }).ready(),
        /DATABASE_URL environment variable is required/
      )
    } finally {
      process.env.DATABASE_URL = saved
      await app.close()
    }
  })

  it('provisions the "default" application when none is named', async () => {
    const saved = process.env.PLT_WORLD_APP_ID
    delete process.env.PLT_WORLD_APP_ID
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'
    process.env.WF_ENABLE_POLLER = 'false'
    const app = Fastify({ logger: false })
    try {
      await app.register(autoload, { dir: join(__dirname, '..', 'plugins') })
      await app.ready()
      const row = await app.pg.query("SELECT id FROM workflow_applications WHERE app_id = 'default'")
      assert.equal(app.authConfig.defaultAppId, row.rows[0].id)
    } finally {
      if (saved !== undefined) process.env.PLT_WORLD_APP_ID = saved
      await app.close()
    }
  })
})

// The auth hook already keeps non-admin callers off these routes. Each handler
// also refuses them on its own, so a hook regression cannot expose it.
describe('admin routes guard themselves', () => {
  it('refuses a non-admin request that reaches the handler', async () => {
    const app = Fastify({ logger: false })
    await app.register(fp(async (instance) => {
      instance.decorateRequest('isAdmin', false)
      instance.decorateRequest('appId', 0)
    }, { name: 'auth' }))
    await app.register(appsPlugin)
    await app.register(versionsPlugin)

    try {
      const routes: [string, string][] = [
        ['POST', '/api/v1/apps'],
        ['POST', '/api/v1/apps/some-app/k8s-binding'],
        ['DELETE', '/api/v1/apps/some-app/k8s-binding'],
        ['POST', '/api/v1/versions/notify'],
      ]
      for (const [method, url] of routes) {
        const res = await app.inject({ method: method as any, url, payload: {} })
        assert.equal(res.statusCode, 403, `${method} ${url}`)
      }
    } finally {
      await app.close()
    }
  })
})
