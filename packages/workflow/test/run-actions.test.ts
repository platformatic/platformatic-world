import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('run-actions', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  async function createRun (deploymentId: string, workflowName: string, input: any = { foo: 'bar' }) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId, workflowName, input }
      }
    })
    assert.equal(response.statusCode, 200)
    return JSON.parse(response.body).run
  }

  async function startRun (runId: string) {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      payload: { eventType: 'run_started', specVersion: 2 }
    })
  }

  async function completeRun (runId: string) {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      payload: {
        eventType: 'run_completed',
        specVersion: 2,
        eventData: { output: { result: 'done' } }
      }
    })
  }

  it('should replay a completed run with the same deployment version', async () => {
    const run = await createRun('v1', 'replay-test', { value: 42 })
    await startRun(run.runId)
    await completeRun(run.runId)

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${run.runId}/replay`,
      payload: {}
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.ok(body.runId)
    assert.notEqual(body.runId, run.runId)
    assert.equal(body.deploymentId, 'v1')
    assert.equal(body.workflowName, 'replay-test')
    assert.equal(body.status, 'pending')
  })

  it('should replay a run targeting the original version, not the current', async () => {
    const runV1 = await createRun('v1', 'version-check')
    await startRun(runV1.runId)
    await completeRun(runV1.runId)

    // Deploy v2 and create a run
    const runV2 = await createRun('v2', 'version-check')
    await startRun(runV2.runId)
    await completeRun(runV2.runId)

    // Replay the v1 run — should target v1, not v2
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runV1.runId}/replay`,
      payload: {}
    })

    const replayed = JSON.parse(response.body)
    assert.equal(replayed.deploymentId, 'v1')
  })

  it('should create a queue message when replaying', async () => {
    const run = await createRun('v1', 'queue-check')
    await startRun(run.runId)
    await completeRun(run.runId)

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${run.runId}/replay`,
      payload: {}
    })

    const replayed = JSON.parse(response.body)

    // Verify queue message was created
    const messages = await ctx.app.pg.query(
      `SELECT * FROM workflow_queue_messages WHERE run_id = $1`,
      [replayed.runId]
    )
    assert.equal(messages.rows.length, 1)
    assert.equal(messages.rows[0].queue_name, '__wkf_workflow_queue-check')
    assert.equal(messages.rows[0].deployment_version, 'v1')
    assert.equal(messages.rows[0].status, 'pending')
  })

  it('should return 404 for non-existent run', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/00000000-0000-0000-0000-000000000000/replay`,
      payload: {}
    })
    assert.equal(response.statusCode, 404)
  })

  it('should cancel a running run', async () => {
    const run = await createRun('v1', 'cancel-test')
    await startRun(run.runId)

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${run.runId}/cancel`,
      payload: {}
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.status, 'cancelled')
  })

  it('should not cancel an already completed run', async () => {
    const run = await createRun('v1', 'cancel-completed')
    await startRun(run.runId)
    await completeRun(run.runId)

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${run.runId}/cancel`,
      payload: {}
    })

    assert.equal(response.statusCode, 400)
  })

  it('should wake up a sleeping run', async () => {
    const run = await createRun('v1', 'wake-up-test')
    await startRun(run.runId)

    // Create a wait (sleep)
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${run.runId}/events`,
      payload: {
        eventType: 'wait_created',
        correlationId: 'sleep-1',
        specVersion: 2,
        eventData: { resumeAt: new Date(Date.now() + 60000).toISOString() }
      }
    })

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${run.runId}/wake-up`,
      payload: {}
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.stoppedCount, 1)
  })
})
