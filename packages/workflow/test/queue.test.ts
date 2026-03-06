import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('queue', () => {
  let ctx: TestContext
  let runId: string

  before(async () => {
    ctx = await setupTest()

    // Create a run
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'queue-test', input: {} },
      },
    })
    runId = JSON.parse(response.body).run.runId
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should enqueue an immediate message', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_test',
        message: { runId },
        deploymentId: 'v1.0.0',
      },
    })

    assert.equal(response.statusCode, 201)
    const body = JSON.parse(response.body)
    assert.ok(body.messageId)
    assert.ok(body.messageId.startsWith('msg_'))
  })

  it('should enqueue a deferred message', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_test',
        message: { runId },
        deploymentId: 'v1.0.0',
        delaySeconds: 60,
      },
    })

    assert.equal(response.statusCode, 201)
    const body = JSON.parse(response.body)
    assert.ok(body.messageId)
    assert.equal(body.scheduled, true)
    assert.ok(body.deliverAt)
  })

  it('should reject duplicate idempotency keys', async () => {
    const key = `idem-${Date.now()}`

    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_test',
        message: { runId },
        deploymentId: 'v1.0.0',
        idempotencyKey: key,
      },
    })

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_test',
        message: { runId },
        deploymentId: 'v1.0.0',
        idempotencyKey: key,
      },
    })

    assert.equal(response.statusCode, 409)
  })
})
