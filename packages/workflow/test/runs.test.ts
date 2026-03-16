import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('runs', () => {
  let ctx: TestContext
  let runId: string

  before(async () => {
    ctx = await setupTest()

    // Create a run for testing
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: {
          deploymentId: 'v1.0.0',
          workflowName: 'test-wf',
          input: { key: 'value' },
        },
      },
    })
    runId = JSON.parse(response.body).run.runId
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should get a run by ID', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.runId, runId)
    assert.equal(body.status, 'pending')
    assert.equal(body.workflowName, 'test-wf')
  })

  it('should get a run without data when resolveData=none', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}?resolveData=none`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.input, undefined)
  })

  it('should return 404 for nonexistent run', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/nonexistent`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 404)
  })

  it('should list runs', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.ok(Array.isArray(body.data))
    assert.ok(body.data.length >= 1)
  })

  it('should filter runs by status', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs?status=pending`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    const body = JSON.parse(response.body)
    assert.ok(body.data.every((r: any) => r.status === 'pending'))
  })

  it('should filter runs by workflowName', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs?workflowName=test-wf`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    const body = JSON.parse(response.body)
    assert.ok(body.data.every((r: any) => r.workflowName === 'test-wf'))
  })
})

describe('workflow template', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should return step template from a completed run', async () => {
    // Create a run
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1', workflowName: 'template-wf' },
      },
    })
    const templateRunId = JSON.parse(createRes.body).run.runId

    // Create steps
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${templateRunId}/events`,
      payload: { eventType: 'step_created', correlationId: 'step-a', eventData: { stepName: 'step//generatePrompts' } },
    })
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${templateRunId}/events`,
      payload: { eventType: 'step_started', correlationId: 'step-a' },
    })
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${templateRunId}/events`,
      payload: { eventType: 'step_completed', correlationId: 'step-a', eventData: { result: 'ok' } },
    })
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${templateRunId}/events`,
      payload: { eventType: 'step_created', correlationId: 'step-b', eventData: { stepName: 'step//generateImage' } },
    })
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${templateRunId}/events`,
      payload: { eventType: 'step_started', correlationId: 'step-b' },
    })
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${templateRunId}/events`,
      payload: { eventType: 'step_completed', correlationId: 'step-b', eventData: { result: 'ok' } },
    })

    // Complete the run
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${templateRunId}/events`,
      payload: { eventType: 'run_completed', eventData: { output: 'done' } },
    })

    // Fetch template
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/workflows/template-wf/template?deploymentId=v1`,
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.sourceRunId, templateRunId)
    assert.equal(body.steps.length, 2)
    assert.equal(body.steps[0].stepName, 'step//generatePrompts')
    assert.equal(body.steps[0].order, 0)
    assert.equal(body.steps[1].stepName, 'step//generateImage')
    assert.equal(body.steps[1].order, 1)
  })

  it('should return 404 when no completed run exists', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/workflows/nonexistent-wf/template?deploymentId=v99`,
    })

    assert.equal(response.statusCode, 404)
  })

  it('should return template without deploymentId filter', async () => {
    // The completed run from the previous test should be found
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/workflows/template-wf/template`,
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.steps.length, 2)
  })
})
