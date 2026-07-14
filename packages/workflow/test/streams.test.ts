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

  it('should allocate unique contiguous indexes for concurrent writes', async () => {
    const streamName = `stream-concurrent-${Date.now()}`
    const expectedData: string[] = []
    const writes = Array.from({ length: 10 }, (_, index) => {
      const single = `single-${index}`
      const multi = [`multi-${index}-a`, `multi-${index}-b`]
      expectedData.push(single, ...multi)
      return [
        ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
          headers: { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
          payload: JSON.stringify(single),
        }),
        ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
          headers: {
            authorization: `Bearer ${ctx.apiKey}`,
            'content-type': 'application/json',
            'x-stream-multi': 'true',
          },
          payload: JSON.stringify(multi),
        }),
      ]
    }).flat()

    const responses = await Promise.all(writes)
    assert.ok(responses.every(response => response.statusCode === 204))

    const chunksRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}/chunks?limit=1000`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    const page = JSON.parse(chunksRes.body) as { data: { index: number; data: string }[] }
    const actualData = page.data.map(chunk => Buffer.from(chunk.data, 'base64').toString())

    assert.deepEqual(page.data.map(chunk => chunk.index), Array.from({ length: 30 }, (_, index) => index))
    assert.deepEqual(actualData.toSorted(), expectedData.toSorted())
    for (let index = 0; index < 10; index++) {
      const first = actualData.indexOf(`multi-${index}-a`)
      assert.equal(actualData[first + 1], `multi-${index}-b`)
    }
  })

  it('should make close idempotent and reject later writes', async () => {
    const streamName = `stream-idempotent-close-${Date.now()}`
    const close = () => ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/json',
        'x-stream-done': 'true',
      },
      payload: JSON.stringify({}),
    })

    assert.equal((await close()).statusCode, 204)
    assert.equal((await close()).statusCode, 204)

    const writeRes = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
      headers: { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify('too late'),
    })
    assert.equal(writeRes.statusCode, 400)

    const appResult = await ctx.app.pg.query('SELECT id FROM workflow_applications WHERE app_id = $1', [ctx.appId])
    const closeResult = await ctx.app.pg.query(
      `SELECT COUNT(*)::int AS count FROM workflow_stream_chunks
       WHERE application_id = $1 AND run_id = $2 AND stream_name = $3 AND is_closed = TRUE`,
      [appResult.rows[0].id, runId, streamName]
    )
    assert.equal(closeResult.rows[0].count, 1)
  })

  it('should coalesce live flushes while the current flush is pending', async () => {
    const streamName = `stream-live-single-flight-${Date.now()}`
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
      headers: { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify('first'),
    })

    const pool = ctx.app.pg as any
    const query = pool.query
    const initialFlush = Promise.withResolvers<void>()
    const releaseFlush = Promise.withResolvers<void>()
    let flushes = 0
    let activeFlushes = 0
    let maxActiveFlushes = 0

    pool.query = async (...args: any[]) => {
      const isFlush = typeof args[0] === 'string' && args[0].includes('WITH stream_state AS') && args[1]?.[0] === streamName
      if (!isFlush) return query.call(pool, ...args)

      activeFlushes++
      maxActiveFlushes = Math.max(maxActiveFlushes, activeFlushes)
      try {
        const result = await query.call(pool, ...args)
        if (++flushes === 1) {
          initialFlush.resolve()
          await releaseFlush.promise
        }
        return result
      } finally {
        activeFlushes--
      }
    }

    try {
      const readPromise = ctx.app.inject({
        method: 'GET',
        url: `/api/v1/apps/${ctx.appId}/streams/${streamName}?stream=true`,
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      })
      await initialFlush.promise

      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${streamName}`,
        headers: { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
        payload: JSON.stringify('second'),
      })
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

      releaseFlush.resolve()
      const readRes = await readPromise
      assert.equal(readRes.body, 'firstsecond')
      assert.equal(maxActiveFlushes, 1)
      assert.equal(flushes, 2)
    } finally {
      releaseFlush.resolve()
      pool.query = query
    }
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
