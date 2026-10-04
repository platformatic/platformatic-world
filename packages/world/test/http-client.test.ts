import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decode } from 'cbor-x'
import { HttpClient } from '../src/lib/client.ts'

interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

describe('HttpClient', () => {
  let server: Server
  let client: HttpClient
  const requests: Recorded[] = []

  function reply (res: ServerResponse, status: number, body?: string, contentType = 'application/json') {
    res.writeHead(status, body === undefined ? {} : { 'content-type': contentType })
    res.end(body)
  }

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const url = req.url || ''
        requests.push({ method: req.method || '', url, headers: req.headers, body: Buffer.concat(chunks) })
        const route = url.replace('/api/v1/apps/app', '').split('?')[0]
        if (route === '/empty') return reply(res, 204)
        if (route === '/invalid') return reply(res, 400, JSON.stringify({ message: 'bad', meta: { field: 'x' } }))
        if (route === '/conflict') return reply(res, 409, 'duplicate', 'text/plain')
        if (route === '/gone') return reply(res, 410, '{}')
        if (route === '/early') return reply(res, 425, '{}')
        if (route === '/limited') return reply(res, 429, '{}')
        if (route === '/broken') return reply(res, 500, 'oops', 'text/plain')
        if (route === '/raw') return reply(res, 200, 'raw-bytes', 'application/octet-stream')
        reply(res, 200, JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    client = new HttpClient({ serviceUrl: `http://127.0.0.1:${port}`, appId: 'app' })
  })

  after(async () => {
    await client.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  function last (): Recorded {
    return requests[requests.length - 1]
  }

  it('post sends JSON by default and CBOR on request', async () => {
    assert.deepEqual(await client.post('/ok', { a: 1 }, { cursor: 'c1', skipped: undefined }), { ok: true })
    assert.equal(last().url, '/api/v1/apps/app/ok?cursor=c1')
    assert.equal(last().headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(last().body.toString()), { a: 1 })

    await client.post('/ok', { b: 2 }, { skipped: undefined }, 'cbor')
    assert.equal(last().url, '/api/v1/apps/app/ok')
    assert.equal(last().headers['content-type'], 'application/cbor')
    assert.deepEqual(decode(last().body), { b: 2 })
  })

  it('post and put resolve undefined on 204', async () => {
    assert.equal(await client.post('/empty', {}), undefined)
    assert.equal(await client.put('/empty', {}), undefined)
  })

  it('put merges extra headers', async () => {
    assert.deepEqual(await client.put('/ok', { a: 1 }, { 'x-stream-done': 'true' }), { ok: true })
    assert.equal(last().method, 'PUT')
    assert.equal(last().headers['x-stream-done'], 'true')
  })

  it('getStream returns a readable body', async () => {
    const stream = await client.getStream('/raw')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString(), 'raw-bytes')
  })

  it('names errors by status and carries the server meta', async () => {
    await assert.rejects(client.post('/invalid', {}), (err: any) => {
      assert.equal(err.name, 'WorkflowWorldError')
      assert.equal(err.statusCode, 400)
      assert.equal(err.status, 400)
      assert.deepEqual(err.meta, { field: 'x' })
      return true
    })
    for (const route of ['/conflict', '/gone', '/early', '/limited']) {
      await assert.rejects(client.get(route), (err: any) => err.name === 'WorkflowAPIError' && err.meta === undefined)
    }
    await assert.rejects(client.get('/broken'), (err: any) => err.name === 'Error' && err.statusCode === 500)
  })

  it('every method rejects on an error status', async () => {
    await assert.rejects(client.put('/broken', {}), /HTTP 500: oops/)
    await assert.rejects(client.getStream('/broken'), /HTTP 500: oops/)
  })

  it('rejects malformed paths before sending', async () => {
    const before = requests.length
    await assert.rejects(client.get('runs'), /must start with '\/'/)
    await assert.rejects(client.get('/runs//steps'), /contains '\/\/'/)
    assert.equal(requests.length, before)
  })
})
