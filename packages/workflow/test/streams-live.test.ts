import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { EventEmitter } from 'node:events'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import autoload from '@fastify/autoload'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import { setupTest, teardownTest, failQueries, interceptQueries, type TestContext } from './helper.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Keep listeners for one event name registered even after they are removed, so
// a notification can still reach a reader that has already gone: the late or
// reentrant delivery its `done` guard exists for.
function keepListeners (eventName: string): () => void {
  const removeListener = EventEmitter.prototype.removeListener
  EventEmitter.prototype.removeListener = function (this: EventEmitter, event: string | symbol, listener: (...args: any[]) => void) {
    if (event === eventName) return this
    return removeListener.call(this, event, listener)
  } as any
  return () => { EventEmitter.prototype.removeListener = removeListener }
}

describe('streams: live reads and health checks', () => {
  let ctx: TestContext
  let runId: string
  let port: number

  before(async () => {
    ctx = await setupTest()
    runId = `wrun_${randomBytes(8).toString('hex')}`
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      payload: { eventType: 'run_created', specVersion: 2, eventData: { deploymentId: 'v1', workflowName: 'streams-live' } },
    })
    assert.equal(created.statusCode, 200)
    // A real socket: client disconnects cannot be simulated through inject().
    await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    port = (ctx.app.server.address() as AddressInfo).port
  })

  after(async () => {
    await teardownTest(ctx)
  })

  function unique (prefix: string): string {
    return `${prefix}-${randomBytes(4).toString('hex')}`
  }

  function write (name: string, body: unknown, headers: Record<string, string> = {}) {
    return ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${name}`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify(body),
    })
  }

  function close (name: string) {
    return write(name, {}, { 'x-stream-done': 'true' })
  }

  function read (name: string, query = 'stream=true') {
    return ctx.app.inject({ method: 'GET', url: `/api/v1/apps/${ctx.appId}/streams/${name}?${query}` })
  }

  // Open a live read over a real connection and resolve once headers arrive.
  function openLive (name: string): Promise<{ req: ClientRequest, res: IncomingMessage }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: `/api/v1/apps/${ctx.appId}/streams/${name}?stream=true` })
      req.on('response', res => resolve({ req, res }))
      req.on('error', reject)
      req.end()
    })
  }

  function closed (res: IncomingMessage): Promise<void> {
    return new Promise(resolve => { res.on('close', () => resolve()) })
  }

  describe('database-backed streams', () => {
    it('accepts base64 object chunks, single and multi', async () => {
      const name = unique('objects')
      assert.equal((await write(name, { data: Buffer.from('one').toString('base64') })).statusCode, 204)
      const multi = await write(name, [{ data: Buffer.from('two').toString('base64') }, 'three'], { 'x-stream-multi': 'true' })
      assert.equal(multi.statusCode, 204)
      assert.equal((await read(name, '')).body, 'onetwothree')
    })

    it('accepts byte-array chunks and treats an object without data as empty', async () => {
      const name = unique('fallbacks')
      assert.equal((await write(name, [[104, 105]], { 'x-stream-multi': 'true' })).statusCode, 204)
      assert.equal((await write(name, {})).statusCode, 204)
      assert.equal((await read(name, '')).body, 'hi')
      const info = await ctx.app.inject({ method: 'GET', url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${name}/info` })
      assert.equal(info.json().tailIndex, 1)
    })

    it('rejects a multi-write whose body is not an array', async () => {
      const res = await write(unique('not-array'), { data: 'AA==' }, { 'x-stream-multi': 'true' })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().message, /must be an array/)
    })

    it('reads an unwritten stream as empty in legacy mode', async () => {
      const res = await read(unique('never-written'), '')
      assert.equal(res.statusCode, 200)
      assert.equal(res.body, '')
    })

    it('ends a live read at once for a stream closed without chunks', async () => {
      const name = unique('closed-empty')
      await close(name)
      const res = await read(name)
      assert.equal(res.statusCode, 200)
      assert.equal(res.body, '')
    })

    it('skips empty chunks on a live read', async () => {
      const name = unique('empty-chunk')
      await write(name, '')
      await write(name, 'data')
      await close(name)
      assert.equal((await read(name)).body, 'data')
    })

    it('clamps and defaults the chunk page size', async () => {
      const name = unique('paging')
      const base = `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/${name}/chunks`
      const empty = (await ctx.app.inject({ method: 'GET', url: base })).json()
      assert.deepEqual(empty, { data: [], cursor: null, hasMore: false, done: false })

      await write(name, ['a', 'b'], { 'x-stream-multi': 'true' })
      const garbage = (await ctx.app.inject({ method: 'GET', url: `${base}?limit=abc` })).json()
      assert.equal(garbage.data.length, 2)
      const floor = (await ctx.app.inject({ method: 'GET', url: `${base}?limit=-5` })).json()
      assert.equal(floor.data.length, 1)
      assert.equal(floor.hasMore, true)
      assert.equal(floor.cursor, '0')
    })

    it('stops following a stream when the reader disconnects', async () => {
      const name = unique('disconnect')
      await write(name, 'first')
      const { req, res } = await openLive(name)
      const done = closed(res)
      res.resume()
      req.destroy()
      await done
      await sleep(50)

      // The writer is unaffected by the departed reader.
      assert.equal((await write(name, 'second')).statusCode, 204)
      assert.equal((await close(name)).statusCode, 204)
    })

    it('survives a reader that disconnects while a flush is in flight', async () => {
      const name = unique('disconnect-mid-flush')
      await write(name, 'first')
      const { req, res } = await openLive(name)
      const done = closed(res)
      res.resume()
      await sleep(50)

      const held = Promise.withResolvers<void>()
      const flushing = Promise.withResolvers<void>()
      const restore = interceptQueries(ctx.app.pg, async (sql, params, run) => {
        if (!sql.includes('WITH stream_state AS') || params?.[0] !== name) return
        const result = await run()
        flushing.resolve()
        await held.promise
        return result
      })
      try {
        await close(name)
        await flushing.promise
        req.destroy()
        await done
        await sleep(50)
        // The flush now completes for a reader that is already gone.
        held.resolve()
        await sleep(50)
      } finally {
        held.resolve()
        restore()
      }
      assert.equal((await read(name)).body, 'first')
    })

    it('ignores a notification that reaches a reader after it disconnected', async () => {
      const name = unique('late-notification')
      await write(name, 'first')
      let flushes = 0
      const restoreListeners = keepListeners(name)
      const restoreQueries = interceptQueries(ctx.app.pg, (sql, params) => {
        if (sql.includes('WITH stream_state AS') && params?.[0] === name) flushes++
      })
      try {
        const { req, res } = await openLive(name)
        const done = closed(res)
        res.resume()
        await sleep(50)
        req.destroy()
        await done
        await sleep(50)
        const before = flushes
        assert.equal((await write(name, 'second')).statusCode, 204)
        await sleep(100)
        // The departed reader is still notified, and must not flush again.
        assert.equal(flushes, before)
      } finally {
        restoreQueries()
        restoreListeners()
      }
    })

    it('drops the connection when a flush fails', async () => {
      const name = unique('flush-fails')
      await write(name, 'first')
      const restore = failQueries(ctx.app.pg, /WITH stream_state AS/)
      try {
        // The failure hits before any chunk is sent, so the client sees a reset
        // rather than a truncated 200.
        await assert.rejects(openLive(name), { code: 'ECONNRESET' })
      } finally {
        restore()
      }
    })
  })

  describe('health check streams', () => {
    it('buffers chunks in memory and replays them to a reader after close', async () => {
      const name = unique('__health_check__replay')
      assert.equal((await write(name, 'text')).statusCode, 204)
      assert.equal((await write(name, { data: Buffer.from('-b64').toString('base64') })).statusCode, 204)
      assert.equal((await write(name, ['-multi', { data: Buffer.from('-obj').toString('base64') }, ''], { 'x-stream-multi': 'true' })).statusCode, 204)
      assert.equal((await write(name, [[45, 114, 97, 119]], { 'x-stream-multi': 'true' })).statusCode, 204)
      assert.equal((await write(name, {})).statusCode, 204)
      assert.equal((await close(name)).statusCode, 204)

      const res = await read(name)
      assert.equal(res.statusCode, 200)
      assert.equal(res.body, 'text-b64-multi-obj-raw')

      // Nothing was persisted: the stream lives only in memory.
      const rows = await ctx.app.pg.query('SELECT 1 FROM workflow_stream_chunks WHERE stream_name = $1', [name])
      assert.equal(rows.rows.length, 0)
    })

    it('rejects writes after close and malformed multi-writes', async () => {
      const name = unique('__health_check__closed')
      await close(name)
      assert.equal((await write(name, 'late')).statusCode, 400)
      assert.equal((await write(name, ['late'], { 'x-stream-multi': 'true' })).statusCode, 400)

      const open = unique('__health_check__not-array')
      const res = await write(open, { data: 'AA==' }, { 'x-stream-multi': 'true' })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().message, /must be an array/)
    })

    it('follows a stream live until it closes', async () => {
      const name = unique('__health_check__live')
      const reading = read(name)
      await sleep(50)
      await write(name, 'ping')
      await sleep(20)
      await write(name, '-pong')
      await close(name)
      const res = await reading
      assert.equal(res.body, 'ping-pong')
    })

    it('ignores a notification that reaches a reader after it disconnected', async () => {
      const name = unique('__health_check__late')
      await write(name, 'first')
      const restoreListeners = keepListeners(name)
      try {
        const { req, res } = await openLive(name)
        const done = closed(res)
        res.resume()
        await sleep(50)
        req.destroy()
        await done
        await sleep(50)
        assert.equal((await write(name, 'late')).statusCode, 204)
      } finally {
        restoreListeners()
      }
      // The departed reader did not swallow the chunk: the next reader gets it.
      await close(name)
      assert.equal((await read(name)).body, 'late')
    })

    it('stops following when the reader disconnects', async () => {
      const name = unique('__health_check__disconnect')
      // A first chunk flushes the response headers, so the client has a response to abandon.
      await write(name, 'first')
      const { req, res } = await openLive(name)
      const done = closed(res)
      res.resume()
      req.destroy()
      await done
      await sleep(50)
      assert.equal((await write(name, 'nobody listening')).statusCode, 204)
    })
  })
})

// Fastify hands the handlers a Buffer only when the host registers a raw body
// parser; the service itself does not, so this builds an app that does.
describe('streams: raw binary bodies', () => {
  it('stores a parsed binary body unchanged, for database and health streams', async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'
    process.env.WF_ENABLE_POLLER = 'false'
    const savedAppId = process.env.PLT_WORLD_APP_ID
    const appId = `raw-${randomBytes(4).toString('hex')}`
    process.env.PLT_WORLD_APP_ID = appId

    const app = Fastify({ logger: false })
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
    await app.register(autoload, { dir: join(__dirname, '..', 'plugins') })
    await app.ready()
    const applicationId = app.authConfig.defaultAppId
    const bytes = Buffer.from([0x7b, 0x00, 0xff, 0x10])
    const put = (name: string, headers: Record<string, string> = {}) => app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${appId}/runs/run-raw/streams/${name}`,
      headers: { 'content-type': 'application/octet-stream', ...headers },
      payload: bytes,
    })

    try {
      await app.pg.query(
        `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status)
         VALUES ('run-raw-' || $1, $2, 'raw', 'v1', 'running')`,
        [appId, applicationId]
      )
      const stored = await app.inject({
        method: 'PUT',
        url: `/api/v1/apps/${appId}/runs/run-raw-${appId}/streams/raw`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: bytes,
      })
      assert.equal(stored.statusCode, 204)
      const read = await app.inject({ method: 'GET', url: `/api/v1/apps/${appId}/streams/raw` })
      assert.deepEqual(read.rawPayload, bytes)

      assert.equal((await put('__health_check__raw')).statusCode, 204)
      await app.inject({
        method: 'PUT',
        url: `/api/v1/apps/${appId}/runs/run-raw/streams/__health_check__raw`,
        headers: { 'content-type': 'application/json', 'x-stream-done': 'true' },
        payload: '{}',
      })
      const health = await app.inject({ method: 'GET', url: `/api/v1/apps/${appId}/streams/__health_check__raw?stream=true` })
      assert.deepEqual(health.rawPayload, bytes)
    } finally {
      await app.pg.query('DELETE FROM workflow_stream_chunks WHERE application_id = $1', [applicationId])
      await app.pg.query('DELETE FROM workflow_runs WHERE application_id = $1', [applicationId])
      await app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [applicationId])
      await app.close()
      process.env.PLT_WORLD_APP_ID = savedAppId
    }
  })
})
