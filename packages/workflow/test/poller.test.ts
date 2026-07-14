import { randomUUID } from 'node:crypto'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { decode, encode } from 'cbor-x'
import { handleDispatchResult, handleNoRoute } from '../queue/poller.ts'
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

  it('terminalizes a workflow delivery exactly once and sanitizes target metadata', async () => {
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
    const client = await ctx.app.pg.connect()
    try {
      const failure = {
        success: false,
        statusCode: 503,
        error: { code: 'HTTP_503', message: 'Target returned HTTP 503' },
      }
      const target = {
        url: 'https://user:password@example.com/flow?token=secret#fragment',
      }
      await handleDispatchResult(client, msg, failure, target)
      await handleDispatchResult(client, msg, failure, target)
    } finally {
      client.release()
    }

    const message = (await ctx.app.pg.query(
      `SELECT status, attempts, last_failure, dead_at, terminalized_at
       FROM workflow_queue_messages WHERE id = $1`,
      [msg.id]
    )).rows[0]
    assert.equal(message.status, 'dead')
    assert.equal(message.attempts, 10)
    assert.equal(message.last_failure.target.url, 'https://example.com/flow')
    assert.ok(message.dead_at)
    assert.ok(message.terminalized_at)

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
      it(`terminalizes a ${encoding.toUpperCase()} ${queueKind}-queue background step with one continuation`, async () => {
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
        const client = await ctx.app.pg.connect()
        try {
          await handleDispatchResult(client, inserted.rows[0], {
            success: false,
            statusCode: 0,
            error: { code: 'ECONNRESET', message: 'Target connection was reset' },
          })
        } finally {
          client.release()
        }

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
    const client = await ctx.app.pg.connect()
    try {
      await handleNoRoute(client, inserted.rows[0])
    } finally {
      client.release()
    }
    const row = (await ctx.app.pg.query(
      'SELECT status, attempts, last_failure, updated_at FROM workflow_queue_messages WHERE id = $1',
      [inserted.rows[0].id]
    )).rows[0]
    assert.equal(row.status, 'dead')
    assert.equal(row.attempts, 10)
    assert.equal(row.last_failure.code, 'ROUTE_NOT_FOUND')
    assert.ok(row.updated_at)
  })

  it('re-enqueues a successful continuation only when delivery wins the predicate', async () => {
    const runId = await createRun('successful-continuation')
    const inserted = await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
         (queue_name, run_id, deployment_version, application_id, payload, status)
       VALUES ('__wkf_workflow_successful-continuation', $1, 'v1', $2, $3, 'pending')
       RETURNING *`,
      [runId, applicationId, JSON.stringify({ runId })]
    )
    const client = await ctx.app.pg.connect()
    try {
      const result = { success: true, statusCode: 200, timeoutSeconds: 0 }
      await handleDispatchResult(client, inserted.rows[0], result)
      await handleDispatchResult(client, inserted.rows[0], result)
    } finally {
      client.release()
    }

    assert.equal((await ctx.app.pg.query(
      'SELECT status FROM workflow_queue_messages WHERE id = $1',
      [inserted.rows[0].id]
    )).rows[0].status, 'delivered')
    const continuations = await ctx.app.pg.query(
      `SELECT id FROM workflow_queue_messages
       WHERE run_id = $1 AND queue_name = '__wkf_workflow_successful-continuation'
         AND status = 'pending'`,
      [runId]
    )
    assert.equal(continuations.rows.length, 1)
  })
})
