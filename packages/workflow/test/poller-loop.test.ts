import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import Fastify from 'fastify'
import autoload from '@fastify/autoload'
import { createPoller } from '../queue/poller.ts'
import { setupTest, teardownTest, interceptQueries, type QueryInterceptor, type TestContext } from './helper.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONNECTION_STRING = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'

interface LogEntry {
  level: string
  text: string
  err?: any
}

function recordingLog () {
  const entries: LogEntry[] = []
  const at = (level: string) => (...args: any[]) => {
    const text = typeof args[0] === 'string' ? args[0] : args[1]
    entries.push({ level, text, err: args[0]?.err })
  }
  return { entries, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') }
}

async function waitFor<T> (check: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Make promise-style checkouts fail, as an exhausted or unreachable pool would.
// pg-pool's own query() checks out with a callback and is left alone.
function failCheckouts (pool: any): () => void {
  const connect = pool.connect
  pool.connect = function (callback?: unknown) {
    if (typeof callback === 'function') return connect.call(pool, callback)
    return Promise.reject(new Error('pool exhausted'))
  }
  return () => { pool.connect = connect }
}

describe('poller loop', () => {
  let ctx: TestContext
  let applicationId: number
  let target: Server
  let targetUrl: string
  const received: any[] = []
  // What the handler answers for the next deliveries, keyed by run id.
  const replies = new Map<string, { status: number, body: string }>()

  before(async () => {
    ctx = await setupTest()
    const app = await ctx.app.pg.query('SELECT id FROM workflow_applications WHERE app_id = $1', [ctx.appId])
    applicationId = app.rows[0].id

    target = createServer((req, res) => {
      let data = ''
      req.on('data', (chunk: Buffer) => { data += chunk })
      req.on('end', () => {
        const body = JSON.parse(data)
        received.push(body)
        const reply = replies.get(body.message.runId) ?? { status: 200, body: '{}' }
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(reply.body)
      })
    })
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`

    await ctx.app.pg.query(
      `INSERT INTO workflow_queue_handlers (application_id, pod_id, deployment_version, workflow_url, step_url, webhook_url)
       VALUES ($1, 'pod-loop', 'v-loop', $2, $3, $4)`,
      [applicationId, `${targetUrl}/flow`, `${targetUrl}/step`, `${targetUrl}/webhook`]
    )
  })

  after(async () => {
    await teardownTest(ctx)
    await new Promise<void>(resolve => target.close(() => resolve()))
  })

  interface Running {
    pool: pg.Pool
    log: ReturnType<typeof recordingLog>
    poller: ReturnType<typeof createPoller>
  }

  // Each poller gets its own pool: ending it is what releases the session-level
  // leader lock, so the next poller can be elected.
  async function withPoller (fn: (running: Running) => Promise<void>, connectionString = CONNECTION_STRING): Promise<void> {
    const pool = new pg.Pool({ connectionString: CONNECTION_STRING })
    const log = recordingLog()
    const poller = createPoller(pool, connectionString, log)
    poller.start()
    try {
      await waitFor(() => logged(log, 'This instance is the leader'), 'leadership')
      await fn({ pool, log, poller })
    } finally {
      await poller.stop()
      await pool.end()
    }
  }

  function logged (log: ReturnType<typeof recordingLog>, text: string): LogEntry | undefined {
    return log.entries.find(entry => entry.text === text)
  }

  function listening (log: ReturnType<typeof recordingLog>): number {
    return log.entries.filter(entry => entry.text === 'Listening to notification channel').length
  }

  async function enqueue (overrides: Record<string, any> = {}): Promise<{ id: number, runId: string }> {
    const runId = overrides.runId ?? `run-${randomUUID()}`
    const row = {
      queue_name: '__wkf_workflow_loop',
      deployment_version: 'v-loop',
      status: 'pending',
      attempts: 0,
      deliver_at: null,
      delivered_at: null,
      ...overrides,
    }
    const inserted = await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
         (queue_name, run_id, deployment_version, application_id, payload, status, attempts, deliver_at, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [row.queue_name, runId, row.deployment_version, applicationId, JSON.stringify({ runId }),
        row.status, row.attempts, row.deliver_at, row.delivered_at]
    )
    return { id: inserted.rows[0].id, runId }
  }

  async function notify (): Promise<void> {
    await ctx.app.pg.query("SELECT pg_notify('deferred_messages', '{}')")
  }

  async function status (id: number): Promise<string> {
    return (await ctx.app.pg.query('SELECT status FROM workflow_queue_messages WHERE id = $1', [id])).rows[0].status
  }

  function delivered (id: number): Promise<boolean> {
    return waitFor(async () => await status(id) === 'delivered', `message ${id} to be delivered`)
  }

  it('dispatches on NOTIFY, retries unroutable messages, and finalizes exhausted ones', async () => {
    await withPoller(async ({ log }) => {
      await waitFor(() => listening(log) === 1, 'the LISTEN connection')

      const routed = await enqueue()
      const unroutable = await enqueue({ deployment_version: 'v-unregistered' })
      const runId = `run-${randomUUID()}`
      await ctx.app.pg.query(
        `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status)
         VALUES ($1, $2, 'loop', 'v-loop', 'running')`,
        [runId, applicationId]
      )
      const exhausted = await enqueue({ runId, status: 'failed', attempts: 10 })
      await notify()

      await delivered(routed.id)
      const dispatch = received.find(body => body.message.runId === routed.runId)
      assert.equal(dispatch.meta.queueName, '__wkf_workflow_loop')
      assert.equal(dispatch.meta.messageId, `msg_${routed.id}`)

      await waitFor(async () => await status(unroutable.id) === 'failed', 'the unroutable message to be scheduled for retry')
      await waitFor(async () => await status(exhausted.id) === 'dead', 'the exhausted message to be finalized')
      const run = await ctx.app.pg.query('SELECT status FROM workflow_runs WHERE id = $1', [runId])
      assert.equal(run.rows[0].status, 'failed')
    })
  })

  it('wakes itself for a deferred message when it comes due', async () => {
    await withPoller(async ({ log }) => {
      await waitFor(() => listening(log) === 1, 'the LISTEN connection')
      const later = await enqueue({ status: 'deferred', deliver_at: new Date(Date.now() + 600) })
      await notify()
      await sleep(100)
      // A second poll reschedules the wake-up rather than stacking timers.
      await notify()
      assert.equal(await status(later.id), 'deferred')
      await delivered(later.id)
    })
  })

  it('coalesces notifications that arrive while a poll is running', async () => {
    await withPoller(async ({ pool, log }) => {
      await waitFor(() => listening(log) === 1, 'the LISTEN connection')
      await sleep(100)

      let polls = 0
      const held = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const restore = interceptQueries(pool, async (sql) => {
        if (!sql.includes("WHERE status = 'deferred' AND deliver_at <= NOW()")) return
        if (++polls === 1) {
          entered.resolve()
          await held.promise
        }
      })
      try {
        await notify()
        await entered.promise
        await notify()
        await notify()
        await sleep(100)
        assert.equal(polls, 1)
        held.resolve()
        await waitFor(() => polls === 2, 'the coalesced follow-up poll')
        await sleep(100)
        assert.equal(polls, 2)
      } finally {
        held.resolve()
        restore()
      }
    })
  })

  it('logs a failed poll, wake-up or dispatch and keeps going', async () => {
    await withPoller(async ({ pool, log }) => {
      await waitFor(() => listening(log) === 1, 'the LISTEN connection')
      await sleep(100)

      const once = (pattern: string): QueryInterceptor => {
        let failed = false
        return (sql) => {
          if (failed || !sql.includes(pattern)) return
          failed = true
          throw new Error(`injected failure: ${pattern}`)
        }
      }

      let restore = interceptQueries(pool, once("WHERE status = 'deferred' AND deliver_at <= NOW()"))
      await notify()
      await waitFor(() => logged(log, 'Executor error'), 'the poll failure to be logged')
      restore()

      restore = interceptQueries(pool, once('EXTRACT(EPOCH'))
      await notify()
      await waitFor(() => logged(log, 'Schedule wakeup error'), 'the wake-up failure to be logged')
      restore()

      // No connection to poll with: logged, not an unhandled rejection.
      log.entries.length = 0
      restore = failCheckouts(pool)
      await notify()
      const failure = await waitFor(() => logged(log, 'Executor error'), 'the failed checkout to be logged')
      assert.equal(failure.err.message, 'pool exhausted')
      restore()

      // The first routing attempt fails; the message stays pending and the next poll delivers it.
      restore = interceptQueries(pool, once('FROM workflow_deployment_versions'))
      const msg = await enqueue()
      await notify()
      await waitFor(() => logged(log, 'Dispatch task error'), 'the dispatch failure to be logged')
      await delivered(msg.id)
      restore()
    })
  })

  it('reconnects the LISTEN connection when it drops', async () => {
    await withPoller(async ({ log }) => {
      await waitFor(() => listening(log) === 1, 'the LISTEN connection')
      await ctx.app.pg.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE query = 'LISTEN "deferred_messages"' AND pid != pg_backend_pid()`
      )
      await waitFor(() => logged(log, 'LISTEN connection error'), 'the dropped connection to be noticed')
      await waitFor(() => listening(log) === 2, 'the LISTEN connection to be re-established')
      // The drop is reported more than once, but must open exactly one new listener.
      await sleep(300)
      assert.equal(listening(log), 2)
      const listeners = await ctx.app.pg.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE query = 'LISTEN \"deferred_messages\"'")
      assert.equal(listeners.rows[0].n, 1)

      const msg = await enqueue()
      await notify()
      await delivered(msg.id)
    })
  })

  it('keeps retrying an unreachable LISTEN endpoint, and stops cleanly mid-retry', async () => {
    await withPoller(async ({ log }) => {
      await waitFor(() => logged(log, 'Failed to setup LISTEN connection'), 'the failed connection to be logged')
      assert.equal(listening(log), 0)
      // stop() runs inside the one-second retry window and must cancel the retry.
    }, 'postgresql://wf:wf@127.0.0.1:1/workflow')
  })

  it('ignores a notification that arrives during shutdown', async () => {
    const end = pg.Client.prototype.end
    let late = 0
    await withPoller(async ({ log }) => {
      await waitFor(() => listening(log) === 1, 'the LISTEN connection')
      await sleep(100)
      pg.Client.prototype.end = function (this: pg.Client, ...args: any[]) {
        // Deliver one last notification before the LISTEN connection closes.
        if (this.listenerCount('notification') > 0) {
          late++
          this.emit('notification', { channel: 'deferred_messages', payload: '{}' })
        }
        return end.apply(this, args as any)
      } as any
    }).finally(() => {
      pg.Client.prototype.end = end
    })
    assert.equal(late, 1)
  })

  it('finishes a poll that is still running when the poller stops', async () => {
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let restore = () => {}
    const log = recordingLog()
    const pool = new pg.Pool({ connectionString: CONNECTION_STRING })
    const poller = createPoller(pool, CONNECTION_STRING, log)
    poller.start()
    try {
      await waitFor(() => listening(log) === 1, 'the LISTEN connection')
      await sleep(100)
      let holding = true
      restore = interceptQueries(pool, async (sql) => {
        if (!holding || !sql.includes("WHERE status = 'deferred' AND deliver_at <= NOW()")) return
        holding = false
        entered.resolve()
        await held.promise
      })
      await notify()
      await entered.promise
      await notify()
      await sleep(50)
      await poller.stop()
      held.resolve()
      await sleep(200)
      assert.equal(logged(log, 'Executor error'), undefined)
      assert.equal(logged(log, 'Schedule wakeup error'), undefined)
    } finally {
      held.resolve()
      restore()
      await poller.stop()
      await pool.end()
    }
  })

  it('reclaims expired deliveries on its interval and steps down when it loses the lock', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'scheduler.wait'] })
    const pool = new pg.Pool({ connectionString: CONNECTION_STRING })
    const log = recordingLog()
    let leader = true
    const restore = interceptQueries(pool, (sql) => {
      if (!leader && sql.includes('pg_try_advisory_lock')) return { rows: [{ leader: false }] }
    })
    const poller = createPoller(pool, CONNECTION_STRING, log)
    poller.start()
    try {
      await waitFor(() => listening(log) === 1, 'the LISTEN connection')
      await sleep(100)

      const runId = `run-${randomUUID()}`
      await ctx.app.pg.query(
        `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status)
         VALUES ($1, $2, 'loop', 'v-loop', 'running')`,
        [runId, applicationId]
      )
      const stuck = await enqueue({ runId, status: 'delivered', delivered_at: new Date(Date.now() - 3_600_000) })
      const idle = await enqueue({ status: 'delivered', delivered_at: new Date() })

      // One reclaim interval: the stuck delivery is handed back and redelivered.
      t.mock.timers.tick(60_000)
      await waitFor(() => logged(log, 'Reclaimed delivered messages whose executor never reported back'), 'the reclaim')
      await waitFor(async () => {
        const row = await ctx.app.pg.query('SELECT status, attempts FROM workflow_queue_messages WHERE id = $1', [stuck.id])
        return row.rows[0].status === 'delivered' && row.rows[0].attempts === 1
      }, 'the reclaimed message to be redelivered')
      assert.equal(await status(idle.id), 'delivered')

      // A second interval finds nothing to reclaim.
      t.mock.timers.tick(60_000)
      await sleep(100)

      // A reclaim that cannot get a connection is logged, not an unhandled rejection.
      const restoreCheckouts = failCheckouts(pool)
      t.mock.timers.tick(60_000)
      const failure = await waitFor(() => logged(log, 'Delivery reclaim error'), 'the failed reclaim to be logged')
      assert.equal(failure.err.message, 'pool exhausted')
      restoreCheckouts()

      // The lock is gone on the next leadership check: polling stops.
      leader = false
      t.mock.timers.tick(10_000)
      await waitFor(() => logged(log, 'This instance was the leader but is not anymore'), 'the step-down')
      const orphan = await enqueue()
      await notify()
      await sleep(200)
      assert.equal(await status(orphan.id), 'pending')

      // Leadership returns: polling resumes and the waiting message is delivered.
      leader = true
      t.mock.timers.tick(10_000)
      await delivered(orphan.id)
    } finally {
      restore()
      const stopping = poller.stop()
      // Wake the leader loop so it observes the abort.
      t.mock.timers.tick(10_000)
      await stopping
      await pool.end()
    }
  })
})

describe('poller plugin', () => {
  it('starts the poller with the service and stops it on close', async () => {
    const saved = { poller: process.env.WF_ENABLE_POLLER, appId: process.env.PLT_WORLD_APP_ID }
    process.env.DATABASE_URL = CONNECTION_STRING
    process.env.PLT_WORLD_APP_ID = `poller-plugin-${randomUUID().slice(0, 8)}`
    delete process.env.WF_ENABLE_POLLER

    const app = Fastify({ logger: false })
    await app.register(autoload, { dir: join(__dirname, '..', 'plugins') })
    await app.ready()
    const applicationId = (await app.pg.query('SELECT id FROM workflow_applications WHERE app_id = $1', [process.env.PLT_WORLD_APP_ID])).rows[0].id
    try {
      // No handler is registered, so the running poller schedules a retry.
      const inserted = await app.pg.query(
        `INSERT INTO workflow_queue_messages (queue_name, run_id, deployment_version, application_id, payload, status)
         VALUES ('__wkf_workflow_plugin', '', 'v1', $1, '{}', 'pending')
         RETURNING id`,
        [applicationId]
      )
      await app.pg.query("SELECT pg_notify('deferred_messages', '{}')")
      await waitFor(async () => {
        const row = await app.pg.query('SELECT status FROM workflow_queue_messages WHERE id = $1', [inserted.rows[0].id])
        return row.rows[0].status === 'failed'
      }, 'the plugin poller to pick the message up')
    } finally {
      await app.pg.query('DELETE FROM workflow_queue_messages WHERE application_id = $1', [applicationId])
      await app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [applicationId])
      await app.close()
      process.env.WF_ENABLE_POLLER = saved.poller
      process.env.PLT_WORLD_APP_ID = saved.appId
    }
  })
})
