import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('streams', () => {
  let ctx: TestContext
  let runId: string

  before(async () => {
    ctx = await setupTest()

    // Create a run
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1', workflowName: 'streams-test', input: {} },
      },
    })
    runId = JSON.parse(createRes.body).run.runId
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should write and read a single chunk', async () => {
    const streamName = `stream-single-${Date.now()}`

    // Write a chunk
    const writeRes = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify('hello world'),
    })
    assert.equal(writeRes.statusCode, 204)

    // Read the stream
    const readRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/streams/${streamName}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(readRes.statusCode, 200)
    assert.equal(readRes.body, 'hello world')
  })

  it('should write multiple chunks', async () => {
    const streamName = `stream-multi-${Date.now()}`

    // Write chunks via multi-write
    const writeRes = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/json',
        'x-stream-multi': 'true',
      },
      payload: JSON.stringify(['chunk1', 'chunk2', 'chunk3']),
    })
    assert.equal(writeRes.statusCode, 204)

    // Read all chunks
    const readRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/streams/${streamName}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(readRes.statusCode, 200)
    assert.equal(readRes.body, 'chunk1chunk2chunk3')
  })

  it('should close a stream', async () => {
    const streamName = `stream-close-${Date.now()}`

    // Write a chunk
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify('data'),
    })

    // Close the stream
    const closeRes = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/json',
        'x-stream-done': 'true',
      },
      payload: JSON.stringify({}),
    })
    assert.equal(closeRes.statusCode, 204)
  })

  it('should read with startIndex', async () => {
    const streamName = `stream-offset-${Date.now()}`

    // Write multiple chunks
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/json',
        'x-stream-multi': 'true',
      },
      payload: JSON.stringify(['aaa', 'bbb', 'ccc']),
    })

    // Read starting from index 1 (skip first chunk)
    const readRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/streams/${streamName}?startIndex=1`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(readRes.statusCode, 200)
    assert.equal(readRes.body, 'bbbccc')
  })

  it('should list streams for a run', async () => {
    const streamName = `stream-list-${Date.now()}`

    // Write to a named stream
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify('data'),
    })

    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(listRes.statusCode, 200)
    const names = JSON.parse(listRes.body) as string[]
    assert.ok(names.includes(streamName))
  })
})
