import { randomUUID } from 'node:crypto'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { reclaimExpiredDeliveries } from '../queue/poller.ts'
import { setupTest, teardownTest, type TestContext } from './helper.ts'

const silentLog = { warn () {}, error () {}, info () {} }

describe('delivery reclaim', () => {
  let ctx: TestContext
  let applicationId: number

  before(async () => {
    ctx = await setupTest()
    const app = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [ctx.appId]
    )
    applicationId = app.rows[0].id
  })

  after(async () => {
    await teardownTest(ctx)
  })

  async function makeRun (status = 'running'): Promise<string> {
    const runId = `wrun_${randomUUID()}`
    await ctx.app.pg.query(
      `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status)
       VALUES ($1, $2, 'wf', 'v1', $3)`,
      [runId, applicationId, status]
    )
    return runId
  }

  async function makeMessage (runId: string, opts: { deliveredSecondsAgo?: number, status?: string, attempts?: number } = {}) {
    const { deliveredSecondsAgo, status = 'delivered', attempts = 0 } = opts
    const res = await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
         (queue_name, run_id, deployment_version, application_id, payload, status, attempts, delivered_at)
       VALUES ('__wkf_workflow_wf', $1, 'v1', $2, '{}'::jsonb, $3, $4,
               CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() - make_interval(secs => $5::int) END)
       RETURNING id`,
      [runId, applicationId, status, attempts, deliveredSecondsAgo ?? null]
    )
    return res.rows[0].id
  }

  async function withClient<T> (fn: (c: any) => Promise<T>): Promise<T> {
    const client = await ctx.app.pg.connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  }

  it('leaves an idle run alone: waiting on a hook is not a fault', async () => {
    // The regression. The run is 'running' with nothing outstanding, exactly
    // like an eve session parked between turns.
    const runId = await makeRun()
    await ctx.app.pg.query(
      'UPDATE workflow_runs SET updated_at = NOW() - INTERVAL \'2 hours\' WHERE id = $1',
      [runId]
    )
    await ctx.app.pg.query(
      `INSERT INTO workflow_hooks (id, run_id, application_id, token, correlation_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [randomUUID(), runId, applicationId, `${runId}:turn-control:0`, randomUUID()]
    )

    const reclaimed = await withClient(c => reclaimExpiredDeliveries(c, silentLog, 60))
    assert.equal(reclaimed, 0)

    const run = await ctx.app.pg.query('SELECT status FROM workflow_runs WHERE id = $1', [runId])
    assert.equal(run.rows[0].status, 'running', 'an idle run must not be failed')
  })

  it('redelivers a message whose executor never reported back', async () => {
    const runId = await makeRun()
    const msgId = await makeMessage(runId, { deliveredSecondsAgo: 3600, attempts: 1 })

    const reclaimed = await withClient(c => reclaimExpiredDeliveries(c, silentLog, 60))
    assert.equal(reclaimed, 1)

    const msg = await ctx.app.pg.query(
      'SELECT status, attempts, delivered_at FROM workflow_queue_messages WHERE id = $1',
      [msgId]
    )
    assert.equal(msg.rows[0].status, 'pending', 'must go back for another attempt')
    assert.equal(msg.rows[0].attempts, 2, 'redelivery counts as an attempt')
    assert.equal(msg.rows[0].delivered_at, null)

    const run = await ctx.app.pg.query('SELECT status FROM workflow_runs WHERE id = $1', [runId])
    assert.equal(run.rows[0].status, 'running', 'the run resumes rather than failing')
  })

  it('does not touch a delivery that is still within the timeout', async () => {
    const runId = await makeRun()
    const msgId = await makeMessage(runId, { deliveredSecondsAgo: 10 })

    const reclaimed = await withClient(c => reclaimExpiredDeliveries(c, silentLog, 600))
    assert.equal(reclaimed, 0)

    const msg = await ctx.app.pg.query('SELECT status FROM workflow_queue_messages WHERE id = $1', [msgId])
    assert.equal(msg.rows[0].status, 'delivered')
  })

  it('fails the run once redelivery attempts are exhausted', async () => {
    const runId = await makeRun()
    const msgId = await makeMessage(runId, { deliveredSecondsAgo: 3600, attempts: 10 })

    await withClient(c => reclaimExpiredDeliveries(c, silentLog, 60))

    const msg = await ctx.app.pg.query('SELECT status FROM workflow_queue_messages WHERE id = $1', [msgId])
    assert.equal(msg.rows[0].status, 'dead', 'nothing left to retry')

    const run = await ctx.app.pg.query('SELECT status, error FROM workflow_runs WHERE id = $1', [runId])
    assert.equal(run.rows[0].status, 'failed')
    assert.match(run.rows[0].error.toString('utf8'), /DELIVERY_TIMEOUT/)
  })

  it('ignores messages whose run already reached a terminal state', async () => {
    const runId = await makeRun('completed')
    const msgId = await makeMessage(runId, { deliveredSecondsAgo: 3600 })

    const reclaimed = await withClient(c => reclaimExpiredDeliveries(c, silentLog, 60))
    assert.equal(reclaimed, 0)

    const msg = await ctx.app.pg.query('SELECT status FROM workflow_queue_messages WHERE id = $1', [msgId])
    assert.equal(msg.rows[0].status, 'delivered')
  })
})
