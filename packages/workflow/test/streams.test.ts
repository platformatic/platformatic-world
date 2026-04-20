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

  it('getInfo returns tailIndex=-1 before any chunks', async () => {
    const streamName = `stream-info-empty-${Date.now()}`
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}/info`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(res.statusCode, 200)
    const info = JSON.parse(res.body)
    assert.equal(info.tailIndex, -1)
    assert.equal(info.done, false)
  })

  it('getInfo returns tail and done=true after close', async () => {
    const streamName = `stream-info-${Date.now()}`

    for (const chunk of ['aa', 'bb', 'cc']) {
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
        headers: { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
        payload: JSON.stringify(chunk),
      })
    }

    let res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}/info`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    let info = JSON.parse(res.body)
    assert.equal(info.tailIndex, 2)
    assert.equal(info.done, false)

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/json',
        'x-stream-done': 'true',
      },
      payload: JSON.stringify({}),
    })

    res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}/info`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    info = JSON.parse(res.body)
    assert.equal(info.tailIndex, 2)
    assert.equal(info.done, true)
  })

  it('getChunks paginates with cursor', async () => {
    const streamName = `stream-chunks-${Date.now()}`

    const chunks = ['alpha', 'beta', 'gamma', 'delta']
    for (const c of chunks) {
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
        headers: { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
        payload: JSON.stringify(c),
      })
    }

    const collected: string[] = []
    let cursor: string | null = null
    let iterations = 0
    do {
      const qs = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2'
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}/chunks${qs}`,
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      })
      assert.equal(res.statusCode, 200)
      const page = JSON.parse(res.body) as { data: { index: number; data: string }[]; cursor: string | null; hasMore: boolean; done: boolean }
      for (const ch of page.data) {
        collected.push(Buffer.from(ch.data, 'base64').toString('utf-8'))
      }
      cursor = page.cursor
      if (++iterations > 10) throw new Error('pagination runaway')
    } while (cursor)

    assert.deepEqual(collected, chunks)
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
