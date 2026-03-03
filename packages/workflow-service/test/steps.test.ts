import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('steps', () => {
  let ctx: TestContext
  let runId: string
  let stepCorrelationId: string

  before(async () => {
    ctx = await setupTest()

    // Create a run and some steps
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1', workflowName: 'steps-test', input: {} },
      },
    })
    runId = JSON.parse(createRes.body).run.runId

    stepCorrelationId = 'step-corr-1'

    // Create step
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_created',
        correlationId: stepCorrelationId,
        specVersion: 2,
        eventData: { stepName: 'fetchData', input: { url: 'https://example.com' } },
      },
    })

    // Create a second step
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_created',
        correlationId: 'step-corr-2',
        specVersion: 2,
        eventData: { stepName: 'processData', input: { mode: 'fast' } },
      },
    })
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should list steps for a run', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/steps`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.data.length, 2)
    assert.equal(body.data[0].stepName, 'fetchData')
    assert.equal(body.data[1].stepName, 'processData')
  })

  it('should get a step by ID', async () => {
    // First get the step ID from the list
    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/steps`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    const stepId = JSON.parse(listRes.body).data[0].stepId

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/steps/${stepId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(res.statusCode, 200)
    const step = JSON.parse(res.body)
    assert.equal(step.stepId, stepId)
    assert.equal(step.stepName, 'fetchData')
    assert.equal(step.status, 'pending')
  })

  it('should return 404 for nonexistent step', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/steps/nonexistent`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(res.statusCode, 404)
  })

  it('should get step without data when resolveData=none', async () => {
    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/steps`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    const stepId = JSON.parse(listRes.body).data[0].stepId

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/steps/${stepId}?resolveData=none`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(res.statusCode, 200)
    const step = JSON.parse(res.body)
    assert.equal(step.input, undefined)
  })

  it('should paginate steps', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/steps?limit=1`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.data.length, 1)
    assert.equal(body.hasMore, true)
    assert.ok(body.cursor)

    // Fetch next page
    const res2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/steps?limit=1&cursor=${body.cursor}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    const body2 = JSON.parse(res2.body)
    assert.equal(body2.data.length, 1)
    assert.equal(body2.hasMore, false)
    assert.equal(body2.data[0].stepName, 'processData')
  })
})
