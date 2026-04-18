import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('events', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should create a run via run_created event', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: {
          deploymentId: 'v1.0.0',
          workflowName: 'test-workflow',
          input: { foo: 'bar' },
        },
      },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.ok(body.event)
    assert.ok(body.run)
    assert.equal(body.event.eventType, 'run_created')
    assert.equal(body.run.status, 'pending')
    assert.equal(body.run.workflowName, 'test-workflow')
    assert.equal(body.run.deploymentId, 'v1.0.0')
    assert.ok(body.run.runId)
  })

  it('should handle full run lifecycle', async () => {
    // Create run
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: {
          deploymentId: 'v1.0.0',
          workflowName: 'lifecycle-test',
          input: { data: 'test' },
        },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId

    // Start run
    const startRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: { eventType: 'run_started', specVersion: 2 },
    })
    assert.equal(JSON.parse(startRes.body).run.status, 'running')

    // Create step
    const stepRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_created',
        correlationId: 'step-1',
        specVersion: 2,
        eventData: {
          stepName: 'fetchData',
          input: { url: 'https://example.com' },
        },
      },
    })
    assert.ok(JSON.parse(stepRes.body).step)
    assert.equal(JSON.parse(stepRes.body).step.status, 'pending')

    // Start step
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_started',
        correlationId: 'step-1',
        specVersion: 2,
        eventData: { attempt: 1 },
      },
    })

    // Complete step
    const completeStepRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_completed',
        correlationId: 'step-1',
        specVersion: 2,
        eventData: { result: { data: 'fetched' } },
      },
    })
    assert.equal(JSON.parse(completeStepRes.body).step.status, 'completed')

    // Complete run
    const completeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_completed',
        specVersion: 2,
        eventData: { output: { result: 'success' } },
      },
    })
    assert.equal(JSON.parse(completeRes.body).run.status, 'completed')

    // List events
    const eventsRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    const events = JSON.parse(eventsRes.body)
    assert.equal(events.data.length, 6) // run_created, run_started, step_created, step_started, step_completed, run_completed
  })

  it('should handle hook_created with token conflict', async () => {
    // workflow_hooks has a partial unique index on token WHERE status='pending'
    // that is global across apps — a hard-coded token would collide with
    // leftovers from a crashed prior run (teardown only runs on success).
    const token = `conflict-token-${randomBytes(8).toString('hex')}`

    // Create a run first
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'hook-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId

    // Create hook
    const hookRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        specVersion: 2,
        eventData: { token },
      },
    })
    assert.ok(JSON.parse(hookRes.body).hook)

    // Create another hook with same token → should get hook_conflict
    const conflictRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'hook_created',
        correlationId: 'hook-2',
        specVersion: 2,
        eventData: { token },
      },
    })
    const conflict = JSON.parse(conflictRes.body)
    assert.equal(conflict.event.eventType, 'hook_conflict')
  })

  it('should handle wait lifecycle', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'wait-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId

    // Create wait
    const waitRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'wait_created',
        correlationId: 'wait-1',
        specVersion: 2,
        eventData: { resumeAt: new Date(Date.now() + 60_000).toISOString() },
      },
    })
    const wait = JSON.parse(waitRes.body)
    assert.ok(wait.wait)
    assert.equal(wait.wait.status, 'waiting')

    // Complete wait
    const completeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'wait_completed',
        correlationId: 'wait-1',
        specVersion: 2,
      },
    })
    const completed = JSON.parse(completeRes.body)
    assert.equal(completed.wait.status, 'completed')
  })
})
