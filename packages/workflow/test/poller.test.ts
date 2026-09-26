import { randomUUID } from 'node:crypto'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { decode, encode } from 'cbor-x'
import { onDispatchResult, onNoRoute } from '../queue/poller.ts'
import { createPostgresQueueStore } from '../queue/stores/postgres.ts'

const silentLog = { info () {}, warn () {}, error () {} }
const makeStore = (ctx: TestContext) =>
  createPostgresQueueStore(ctx.app.pg, silentLog, 'postgres')
import { setupTest, teardownTest, type TestContext } from './helper.ts'

describe('poller result handling', () => {
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

  async function createRun (workflowName: string): Promise<string> {
    const runId = `run-${randomUUID()}`
    await ctx.app.pg.query(
      `INSERT INTO workflow_runs
         (id, application_id, workflow_name, deployment_id, status, started_at)
       VALUES ($1, $2, $3, 'v1', 'running', NOW())`,
      [runId, applicationId, workflowName]
    )
    return runId
  }

  it('finalizes a workflow delivery failure exactly once and sanitizes target metadata', async () => {
    const runId = await createRun('terminal-workflow')
    await ctx.app.pg.query(
      `INSERT INTO workflow_hooks
         (id, run_id, application_id, correlation_id, token)
       VALUES ($1, $2, $3, 'hook-1', $4)`,
      [randomUUID(), runId, applicationId, randomUUID()]
    )
    await ctx.app.pg.query(
      `INSERT INTO workflow_waits (id, run_id, application_id, correlation_id)
       VALUES ($1, $2, $3, 'wait-1')`,
      [randomUUID(), runId, applicationId]
    )
    const inserted = await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
         (queue_name, run_id, deployment_version, application_id, payload, status, attempts)
       VALUES ('__wkf_workflow_terminal-workflow', $1, 'v1', $2, $3, 'pending', 9)
       RETURNING *`,
      [runId, applicationId, JSON.stringify({ runId })]
    )
    const msg = inserted.rows[0]
    const store = makeStore(ctx)
    const failure = {
      success: false,
      statusCode: 503,
      error: { code: 'HTTP_503', message: 'Target returned HTTP 503' },
    }
    const target = {
      url: 'https://user:password@example.com/flow?token=secret#fragment',
    }
    await onDispatchResult(store, msg, failure, target)
    await onDispatchResult(store, msg, failure, target)

    const message = (await ctx.app.pg.query(
      `SELECT status, attempts, last_failure, dead_at, failure_finalized_at
       FROM workflow_queue_messages WHERE id = $1`,
      [msg.id]
    )).rows[0]
    assert.equal(message.status, 'dead')
    assert.equal(message.attempts, 10)
    assert.equal(message.last_failure.target.url, 'https://example.com/flow')
    assert.ok(message.dead_at)
    assert.ok(message.failure_finalized_at)

    const run = (await ctx.app.pg.query(
      'SELECT status FROM workflow_runs WHERE id = $1',
      [runId]
    )).rows[0]
    assert.equal(run.status, 'failed')
    const events = await ctx.app.pg.query(
      `SELECT id FROM workflow_events
       WHERE run_id = $1 AND event_type = 'run_failed'`,
      [runId]
    )
    assert.equal(events.rows.length, 1)
    assert.equal((await ctx.app.pg.query(
      'SELECT status FROM workflow_hooks WHERE run_id = $1',
      [runId]
    )).rows[0].status, 'disposed')
    assert.equal((await ctx.app.pg.query(
      'SELECT status FROM workflow_waits WHERE run_id = $1',
      [runId]
    )).rows[0].status, 'completed')
  })

  for (const encoding of ['json', 'cbor'] as const) {
    for (const queueKind of ['step', 'workflow'] as const) {
      it(`finalizes a ${encoding.toUpperCase()} ${queueKind}-queue background step failure with one continuation`, async () => {
        const workflowName = `background-${encoding}`
        const runId = await createRun(workflowName)
        const stepId = `step-${randomUUID()}`
        await ctx.app.pg.query(
          `INSERT INTO workflow_steps
             (id, run_id, application_id, correlation_id, step_name, status, started_at)
           VALUES ($1, $2, $3, $4, 'background-step', 'running', NOW())`,
          [randomUUID(), runId, applicationId, stepId]
        )
        const payload = { workflowName, workflowRunId: runId, workflowStartedAt: Date.now(), stepId }
        const inserted = await ctx.app.pg.query(
          `INSERT INTO workflow_queue_messages
             (queue_name, run_id, deployment_version, application_id,
              payload, payload_bytes, payload_encoding, status, attempts)
           VALUES ($1, $2, 'v1', $3, $4, $5, $6, 'pending', 9)
           RETURNING *`,
          [queueKind === 'step' ? `__wkf_step_${stepId}` : `__wkf_workflow_${workflowName}`, runId, applicationId,
            encoding === 'json' ? JSON.stringify(payload) : null,
            encoding === 'cbor' ? Buffer.from(encode(payload)) : null,
            encoding]
        )
        await onDispatchResult(makeStore(ctx), inserted.rows[0], {
          success: false,
          statusCode: 0,
          error: { code: 'ECONNRESET', message: 'Target connection was reset' },
        })

        const step = (await ctx.app.pg.query(
          'SELECT status FROM workflow_steps WHERE run_id = $1 AND correlation_id = $2',
          [runId, stepId]
        )).rows[0]
        assert.equal(step.status, 'failed')
        assert.equal((await ctx.app.pg.query(
          'SELECT status FROM workflow_runs WHERE id = $1',
          [runId]
        )).rows[0].status, 'running')
        assert.equal((await ctx.app.pg.query(
          `SELECT id FROM workflow_events
           WHERE run_id = $1 AND event_type = 'step_failed' AND correlation_id = $2`,
          [runId, stepId]
        )).rows.length, 1)

        const continuations = await ctx.app.pg.query(
          `SELECT payload, payload_bytes, payload_encoding
           FROM workflow_queue_messages
           WHERE run_id = $1 AND queue_name = $2 AND status = 'pending'`,
          [runId, `__wkf_workflow_${workflowName}`]
        )
        assert.equal(continuations.rows.length, 1)
        const continuation = encoding === 'json'
          ? continuations.rows[0].payload
          : decode(continuations.rows[0].payload_bytes)
        assert.equal(continuation.runId, runId)
        assert.equal(continuations.rows[0].payload_encoding, encoding)
      })
    }
  }

  it('counts a no-route attempt before deciding it is terminal', async () => {
    const inserted = await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
         (queue_name, run_id, deployment_version, application_id, payload, status, attempts)
       VALUES ('webhook', '', 'v1', $1, '{}', 'pending', 9)
       RETURNING *`,
      [applicationId]
    )
    await onNoRoute(makeStore(ctx), inserted.rows[0])
    const row = (await ctx.app.pg.query(
      'SELECT status, attempts, last_failure, updated_at FROM workflow_queue_messages WHERE id = $1',
      [inserted.rows[0].id]
    )).rows[0]
    assert.equal(row.status, 'dead')
    assert.equal(row.attempts, 10)
    assert.equal(row.last_failure.code, 'ROUTE_NOT_FOUND')
    assert.ok(row.updated_at)
  })

  it('re-enqueues a successful continuation once, gated by claimForDispatch', async () => {
    const runId = await createRun('successful-continuation')
    const inserted = await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
         (queue_name, run_id, deployment_version, application_id, payload, status)
       VALUES ('__wkf_workflow_successful-continuation', $1, 'v1', $2, $3, 'pending')
       RETURNING *`,
      [runId, applicationId, JSON.stringify({ runId })]
    )
    const store = makeStore(ctx)
    const result = { success: true, statusCode: 200, timeoutSeconds: 0 }
    // The gate, not the handler, is what makes this exactly-once: a second
    // claim of the same message returns null, so the continuation is written
    // once however many times the broker redelivers it.
    const claimed = await store.claimForDispatch(inserted.rows[0].id)
    assert.ok(claimed, 'first claim wins')
    assert.equal(await store.claimForDispatch(inserted.rows[0].id), null, 'second claim is refused')
    await onDispatchResult(store, claimed!, result)

    // 'acked', not 'delivered': a completed delivery has to leave the state
    // reclaimExpired treats as an abandoned one.
    assert.equal((await ctx.app.pg.query(
      'SELECT status FROM workflow_queue_messages WHERE id = $1',
      [inserted.rows[0].id]
    )).rows[0].status, 'acked')
    const continuations = await ctx.app.pg.query(
      `SELECT id FROM workflow_queue_messages
       WHERE run_id = $1 AND queue_name = '__wkf_workflow_successful-continuation'
         AND status = 'pending'`,
      [runId]
    )
    assert.equal(continuations.rows.length, 1)
  })
})
