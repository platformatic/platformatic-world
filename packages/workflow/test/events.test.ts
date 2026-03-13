import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { stringify as devalueStringify } from 'devalue'
import { setupTest, teardownTest } from './helper.ts'
import { decodeData, encodeData } from '../plugins/events.ts'
import type { TestContext } from './helper.ts'

describe('decodeData', () => {
  it('should decode plain JSON buffers', () => {
    const buf = Buffer.from(JSON.stringify({ hello: 'world' }))
    assert.deepEqual(decodeData(buf), { hello: 'world' })
  })

  it('should return undefined for null', () => {
    assert.equal(decodeData(null), undefined)
  })

  it('should return base64 for non-JSON binary', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03])
    assert.equal(typeof decodeData(buf), 'string')
  })

  it('should decode devl-prefixed devalue buffers', () => {
    const obj = { version: 'v2', podId: 'pod-abc' }
    const payload = devalueStringify(obj)
    const buf = Buffer.concat([Buffer.from('devl'), Buffer.from(payload)])
    assert.deepEqual(decodeData(buf), obj)
  })

  it('should decode base64 fields inside event data objects', () => {
    // Simulate SDK: result is base64-encoded devl+devalue
    const stepResult = { greeting: 'Hello World' }
    const devlBuf = Buffer.concat([Buffer.from('devl'), Buffer.from(devalueStringify(stepResult))])
    const resultBase64 = devlBuf.toString('base64')

    const eventData = JSON.stringify({ result: resultBase64, stepName: 'myStep' })
    const decoded = decodeData(Buffer.from(eventData)) as any
    assert.deepEqual(decoded.result, stepResult)
    assert.equal(decoded.stepName, 'myStep')
  })

  it('should decode base64 fields with plain JSON inside', () => {
    const inner = { foo: 'bar' }
    const innerBase64 = Buffer.from(JSON.stringify(inner)).toString('base64')
    const outer = JSON.stringify({ output: innerBase64 })
    const decoded = decodeData(Buffer.from(outer)) as any
    assert.deepEqual(decoded.output, inner)
  })

  it('should not mangle non-base64 string fields', () => {
    const data = JSON.stringify({ result: 'just a string', name: 'test' })
    const decoded = decodeData(Buffer.from(data)) as any
    assert.equal(decoded.name, 'test')
  })

  it('should round-trip through encodeData and decodeData', () => {
    const obj = { count: 42, items: ['a', 'b'] }
    const encoded = encodeData(obj)
    assert.deepEqual(decodeData(encoded), obj)
  })
})

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
        eventData: { token: 'unique-token-123' },
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
        eventData: { token: 'unique-token-123' },
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
