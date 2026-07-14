import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decode, encode } from 'cbor-x'
import { dispatchMessage } from '../queue/dispatcher.ts'

interface Received {
  contentType: string
  body: Buffer
}

describe('dispatcher', () => {
  let port = 0
  let received: Received[]
  let server: ReturnType<typeof createServer>

  before(async () => {
    received = []
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        received.push({
          contentType: req.headers['content-type'] || '',
          body: Buffer.concat(chunks),
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({}))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    port = (server.address() as AddressInfo).port
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('JSON row dispatches with application/json', async () => {
    const result = await dispatchMessage({
      url: `http://localhost:${port}/flow`,
      queueName: '__wkf_workflow_test',
      messageId: 1,
      payload: { runId: 'r1' },
      payloadBytes: null,
      payloadEncoding: 'json',
      attempt: 0,
    })

    assert.equal(result.success, true)
    const last = received[received.length - 1]
    assert.match(last.contentType, /application\/json/)
    const body = JSON.parse(last.body.toString('utf8'))
    assert.equal(body.message.runId, 'r1')
    assert.equal(body.meta.messageId, 'msg_1')
    assert.equal(body.meta.attempt, 0)
  })

  it('CBOR row dispatches with application/cbor', async () => {
    const messageObj = { runId: 'r2', bytes: new Uint8Array([1, 2, 3]) }
    const result = await dispatchMessage({
      url: `http://localhost:${port}/flow`,
      queueName: '__wkf_workflow_test',
      messageId: 2,
      payload: null,
      payloadBytes: Buffer.from(encode(messageObj)),
      payloadEncoding: 'cbor',
      attempt: 1,
    })

    assert.equal(result.success, true)
    const last = received[received.length - 1]
    assert.match(last.contentType, /application\/cbor/)
    const decoded = decode(last.body) as any
    assert.equal(decoded.message.runId, 'r2')
    assert.ok(decoded.message.bytes instanceof Uint8Array)
    assert.deepEqual(Array.from(decoded.message.bytes), [1, 2, 3])
    assert.equal(decoded.meta.messageId, 'msg_2')
    assert.equal(decoded.meta.attempt, 1)
  })

  it('reads timeoutSeconds from JSON response', async () => {
    const timeoutServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ timeoutSeconds: 10 }))
    })
    await new Promise<void>((resolve) => timeoutServer.listen(0, resolve))
    const p = (timeoutServer.address() as AddressInfo).port

    try {
      const result = await dispatchMessage({
        url: `http://localhost:${p}/flow`,
        queueName: '__wkf_workflow_test',
        messageId: 3,
        payload: { runId: 'r3' },
        payloadBytes: null,
        payloadEncoding: 'json',
        attempt: 0,
      })
      assert.equal(result.timeoutSeconds, 10)
    } finally {
      await new Promise<void>((resolve) => timeoutServer.close(() => resolve()))
    }
  })

  it('returns a bounded normalized HTTP error without the response body', async () => {
    const errorServer = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end(`secret-${'x'.repeat(1000)}`)
    })
    await new Promise<void>((resolve) => errorServer.listen(0, resolve))
    const p = (errorServer.address() as AddressInfo).port

    try {
      const result = await dispatchMessage({
        url: `http://localhost:${p}/flow`,
        queueName: '__wkf_workflow_test',
        messageId: 4,
        payload: { runId: 'r4' },
        payloadBytes: null,
        payloadEncoding: 'json',
        attempt: 9,
      })
      assert.equal(result.success, false)
      assert.equal(result.statusCode, 503)
      assert.deepEqual(result.error, {
        code: 'HTTP_503',
        message: 'Target returned HTTP 503',
      })
    } finally {
      await new Promise<void>((resolve) => errorServer.close(() => resolve()))
    }
  })
})
