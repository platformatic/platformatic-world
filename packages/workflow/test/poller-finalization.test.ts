import { randomUUID } from 'node:crypto'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { encode } from 'cbor-x'
import {
  ensureRunForWorkflowDelivery, handleDispatchResult, handleExhaustedMessage, handleNoRoute,
  reclaimExpiredDeliveries, sanitizeTargetUrl,
} from '../queue/poller.ts'
import { getRetryDelay } from '../queue/retry.ts'
import { setupTest, teardownTest, failQueries, type TestContext } from './helper.ts'

describe('poller failure finalization', () => {
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

  async function createRun (status = 'running'): Promise<string> {
    const runId = `run-${randomUUID()}`
    await ctx.app.pg.query(
      `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status, started_at)
       VALUES ($1, $2, 'wf', 'v1', $3, NOW())`,
      [runId, applicationId, status]
    )
    return runId
  }

  interface MessageOptions {
    queueName?: string
    runId?: string
    status?: string
    attempts?: number
    payload?: unknown
    payloadBytes?: Buffer
    deploymentVersion?: string
    lastFailure?: unknown
  }

  async function createMessage (opts: MessageOptions = {}): Promise<any> {
    const encoding = opts.payloadBytes ? 'cbor' : 'json'
    const inserted = await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
         (queue_name, run_id, deployment_version, application_id, payload, payload_bytes,
          payload_encoding, status, attempts, last_failure)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [opts.queueName ?? '__wkf_workflow_wf', opts.runId ?? '', opts.deploymentVersion ?? 'v1', applicationId,
        opts.payloadBytes ? null : JSON.stringify(opts.payload ?? {}), opts.payloadBytes ?? null,
        encoding, opts.status ?? 'pending', opts.attempts ?? 0, opts.lastFailure ?? null]
    )
    return inserted.rows[0]
  }

  async function withClient<T> (fn: (client: any) => Promise<T>): Promise<T> {
    const client = await ctx.app.pg.connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  }

  async function message (id: number): Promise<any> {
    return (await ctx.app.pg.query('SELECT * FROM workflow_queue_messages WHERE id = $1', [id])).rows[0]
  }

  async function run (id: string): Promise<any> {
    return (await ctx.app.pg.query('SELECT * FROM workflow_runs WHERE id = $1', [id])).rows[0]
  }

  it('sanitizes target URLs and rejects unparseable ones', () => {
    assert.equal(sanitizeTargetUrl('https://user:pw@example.com/flow?token=x#frag'), 'https://example.com/flow')
    assert.equal(sanitizeTargetUrl('not a url'), undefined)
  })

  it('never creates a run for a delivery that names none', async () => {
    let queries = 0
    const client = { async query () { queries++; return { rows: [] } } }
    await ensureRunForWorkflowDelivery(client as any, { run_id: '', queue_name: '__wkf_workflow_wf', application_id: 1 })
    assert.equal(queries, 0)
  })

  it('backs retries off exponentially up to a minute', () => {
    assert.equal(getRetryDelay(1), 2000)
    assert.equal(getRetryDelay(3), 8000)
    assert.equal(getRetryDelay(20), 60_000)
  })

  describe('handleDispatchResult', () => {
    it('schedules a retry with the failure detail while attempts remain', async () => {
      const msg = await createMessage({ runId: await createRun() })
      await withClient(client => handleDispatchResult(client, msg, { success: false, statusCode: 0 }))

      const row = await message(msg.id)
      assert.equal(row.status, 'failed')
      assert.equal(row.attempts, 1)
      assert.ok(row.next_retry_at > new Date())
      assert.equal(row.last_failure.code, 'DISPATCH_ERROR')
      assert.equal(row.last_failure.message, 'Target request failed')
      assert.equal(row.last_failure.statusCode, 0)
      assert.equal(row.last_failure.target.url, undefined)
    })

    it('defers a redelivery when the handler asks for one, keeping the CBOR payload', async () => {
      const payloadBytes = Buffer.from(encode({ runId: 'r1' }))
      const msg = await createMessage({ runId: await createRun(), payloadBytes })
      await withClient(client => handleDispatchResult(client, msg, { success: true, statusCode: 200, timeoutSeconds: 30 }))

      assert.equal((await message(msg.id)).status, 'delivered')
      const deferred = await ctx.app.pg.query(
        "SELECT * FROM workflow_queue_messages WHERE run_id = $1 AND status = 'deferred'",
        [msg.run_id]
      )
      assert.equal(deferred.rows.length, 1)
      assert.equal(deferred.rows[0].payload, null)
      assert.deepEqual(deferred.rows[0].payload_bytes, payloadBytes)
      assert.ok(deferred.rows[0].deliver_at > new Date())
    })

    it('ignores a negative timeout and rolls back when persisting fails', async () => {
      const negative = await createMessage({ runId: await createRun() })
      await withClient(client => handleDispatchResult(client, negative, { success: true, statusCode: 200, timeoutSeconds: -1 }))
      const followUps = await ctx.app.pg.query(
        'SELECT id FROM workflow_queue_messages WHERE run_id = $1 AND id != $2',
        [negative.run_id, negative.id]
      )
      assert.equal(followUps.rows.length, 0)

      const msg = await createMessage({ runId: await createRun() })
      const restore = failQueries(ctx.app.pg, /SET status = 'delivered'/)
      try {
        await assert.rejects(
          withClient(client => handleDispatchResult(client, msg, { success: true, statusCode: 200 })),
          /injected query failure/
        )
      } finally {
        restore()
      }
      assert.equal((await message(msg.id)).status, 'pending')
    })
  })

  describe('handleNoRoute', () => {
    it('schedules a retry while attempts remain, and rolls back on failure', async () => {
      const msg = await createMessage({ runId: await createRun() })
      await withClient(client => handleNoRoute(client, msg))
      const row = await message(msg.id)
      assert.equal(row.status, 'failed')
      assert.equal(row.attempts, 1)
      assert.equal(row.last_failure.code, 'ROUTE_NOT_FOUND')

      const failing = await createMessage({ runId: await createRun() })
      const restore = failQueries(ctx.app.pg, /SET status = 'failed', attempts/)
      try {
        await assert.rejects(withClient(client => handleNoRoute(client, failing)), /injected query failure/)
      } finally {
        restore()
      }
      assert.equal((await message(failing.id)).status, 'pending')
    })

    it('fails a step-queue run at the retry ceiling, once', async () => {
      const runId = await createRun()
      const msg = await createMessage({ runId, queueName: '__wkf_step_work', attempts: 9, payload: { notAStep: true } })
      await withClient(client => handleNoRoute(client, msg))
      // A second pass finds the message already dead and leaves the run alone.
      await withClient(client => handleNoRoute(client, msg))

      assert.equal((await message(msg.id)).status, 'dead')
      assert.equal((await run(runId)).status, 'failed')
      const events = await ctx.app.pg.query("SELECT id FROM workflow_events WHERE run_id = $1 AND event_type = 'run_failed'", [runId])
      assert.equal(events.rows.length, 1)
    })
  })

  describe('handleExhaustedMessage', () => {
    it('finalizes with the recorded failure, creating the run a workflow delivery never reached', async () => {
      const runId = `run-${randomUUID()}`
      const payload = {
        runId,
        runInput: { workflowName: 'from-payload', deploymentId: 'd-payload', executionContext: { traceId: 't' }, specVersion: 2 },
      }
      const lastFailure = { code: 'HTTP_503', message: 'Target returned HTTP 503', attempt: 10 }
      // The run row does not exist yet: run_created never landed.
      const msg = await createMessage({ runId, status: 'failed', attempts: 10, payload, lastFailure })

      await withClient(client => handleExhaustedMessage(client, msg))

      const row = await message(msg.id)
      assert.equal(row.status, 'dead')
      assert.equal(row.last_failure.code, 'HTTP_503')
      const created = await run(runId)
      assert.equal(created.status, 'failed')
      assert.equal(created.workflow_name, 'from-payload')
      assert.equal(created.deployment_id, 'd-payload')
      assert.deepEqual(created.execution_context, { traceId: 't' })
      assert.equal(created.spec_version, 2)
    })

    it('derives the run from the queue name when the payload is unreadable or empty', async () => {
      const unreadable = `run-${randomUUID()}`
      const garbled = await createMessage({ runId: unreadable, status: 'failed', attempts: 10, payloadBytes: Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff]), deploymentVersion: '' })
      await withClient(client => handleExhaustedMessage(client, garbled))
      const fromQueue = await run(unreadable)
      assert.equal(fromQueue.workflow_name, 'wf')
      assert.equal(fromQueue.deployment_id, 'unknown')
      assert.equal(fromQueue.status, 'failed')
      const dead = await message(garbled.id)
      assert.equal(dead.last_failure.code, 'RETRY_EXHAUSTED')

      const blank = `run-${randomUUID()}`
      const unnamed = await createMessage({ runId: blank, status: 'failed', attempts: 10, payload: { runInput: { workflowName: '' } } })
      await withClient(client => handleExhaustedMessage(client, unnamed))
      assert.equal((await run(blank)).workflow_name, 'unknown')
    })

    it('leaves an already-terminal run and a message without a run untouched', async () => {
      const runId = await createRun('completed')
      const msg = await createMessage({ runId, status: 'failed', attempts: 10 })
      await withClient(client => handleExhaustedMessage(client, msg))
      assert.equal((await message(msg.id)).status, 'dead')
      assert.equal((await run(runId)).status, 'completed')

      const orphan = await createMessage({ status: 'failed', attempts: 10, queueName: 'webhook' })
      await withClient(client => handleExhaustedMessage(client, orphan))
      assert.equal((await message(orphan.id)).status, 'dead')
    })

    it('does nothing when another poller already finalized the message, and rolls back on failure', async () => {
      const runId = await createRun()
      const msg = await createMessage({ runId, status: 'dead', attempts: 10 })
      await withClient(client => handleExhaustedMessage(client, msg))
      assert.equal((await run(runId)).status, 'running')

      const failing = await createMessage({ runId, status: 'failed', attempts: 10 })
      const restore = failQueries(ctx.app.pg, /SET status = 'dead', last_failure = \$4/)
      try {
        await assert.rejects(withClient(client => handleExhaustedMessage(client, failing)), /injected query failure/)
      } finally {
        restore()
      }
      assert.equal((await message(failing.id)).status, 'failed')
    })

    it('resolves a background step that is missing or already terminal without failing the run', async () => {
      const runId = await createRun()
      const missing = await createMessage({ runId, status: 'failed', attempts: 10, payload: { stepId: 'never-created' } })
      await withClient(client => handleExhaustedMessage(client, missing))
      assert.equal((await run(runId)).status, 'running')

      const stepId = `step-${randomUUID()}`
      await ctx.app.pg.query(
        `INSERT INTO workflow_steps (id, run_id, application_id, correlation_id, step_name, status)
         VALUES ($1, $2, $3, $4, 'done', 'completed')`,
        [randomUUID(), runId, applicationId, stepId]
      )
      const terminal = await createMessage({ runId, status: 'failed', attempts: 10, payload: { stepId } })
      await withClient(client => handleExhaustedMessage(client, terminal))
      assert.equal((await run(runId)).status, 'running')
      const stepEvents = await ctx.app.pg.query("SELECT id FROM workflow_events WHERE run_id = $1 AND event_type = 'step_failed'", [runId])
      assert.equal(stepEvents.rows.length, 0)
    })

    it('fails the run for a step-queue message whose CBOR payload is unreadable', async () => {
      const runId = await createRun()
      const msg = await createMessage({
        runId,
        queueName: '__wkf_step_work',
        status: 'failed',
        attempts: 10,
        payloadBytes: Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff]),
      })
      await withClient(client => handleExhaustedMessage(client, msg))
      assert.equal((await run(runId)).status, 'failed')
    })
  })

  describe('reclaimExpiredDeliveries', () => {
    it('logs and reports zero when finalizing an exhausted delivery fails', async () => {
      const runId = await createRun()
      const msg = await createMessage({ runId, status: 'delivered', attempts: 10 })
      await ctx.app.pg.query("UPDATE workflow_queue_messages SET delivered_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [msg.id])

      const errors: any[] = []
      const log = { warn () {}, info () {}, error (obj: any, text: string) { errors.push({ err: obj.err, text }) } }
      const restore = failQueries(ctx.app.pg, /SET status = 'dead', last_failure = \$3/)
      try {
        const reclaimed = await withClient(client => reclaimExpiredDeliveries(client, log, 60))
        assert.equal(reclaimed, 0)
      } finally {
        restore()
      }
      assert.equal(errors.length, 1)
      assert.equal(errors[0].text, 'Delivery reclaim error')
      assert.equal((await message(msg.id)).status, 'delivered')
      assert.equal((await run(runId)).status, 'running')
      await ctx.app.pg.query('DELETE FROM workflow_queue_messages WHERE id = $1', [msg.id])
    })
  })
})
