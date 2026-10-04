import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decode, encode } from 'cbor-x'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
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

describe('dispatcher responses and failures', () => {
  let server: ReturnType<typeof createServer>
  let base = ''

  function input (path: string) {
    return {
      url: `${base}${path}`,
      queueName: '__wkf_workflow_test',
      messageId: 7,
      payload: { runId: 'r1' },
      payloadBytes: null,
      payloadEncoding: 'json' as const,
      attempt: 0,
    }
  }

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume()
      req.on('end', () => {
        if (req.url === '/plain') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('ok')
        } else if (req.url === '/early') {
          res.writeHead(425, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ meta: { retryAfter: new Date(Date.now() + 30_000).toISOString() } }))
        } else if (req.url === '/early-no-meta') {
          res.writeHead(425, { 'content-type': 'application/json' })
          res.end('{}')
        } else {
          res.writeHead(425, { 'content-type': 'text/plain' })
          res.end('too early')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('treats a 2xx without a JSON body as delivered', async () => {
    assert.deepEqual(await dispatchMessage(input('/plain')), { success: true, statusCode: 200 })
  })

  it('turns a 425 into a deferred redelivery at retryAfter', async () => {
    const withMeta = await dispatchMessage(input('/early'))
    assert.equal(withMeta.success, true)
    assert.equal(withMeta.statusCode, 425)
    assert.ok(withMeta.timeoutSeconds! >= 29 && withMeta.timeoutSeconds! <= 30)

    assert.deepEqual(await dispatchMessage(input('/early-no-meta')), { success: true, timeoutSeconds: 1, statusCode: 425 })
    assert.deepEqual(await dispatchMessage(input('/early-not-json')), { success: true, timeoutSeconds: 1, statusCode: 425 })
  })

  it('reports a refused connection', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, resolve))
    const { port } = closed.address() as AddressInfo
    await new Promise<void>((resolve) => closed.close(() => resolve()))

    const result = await dispatchMessage({ ...input(''), url: `http://127.0.0.1:${port}/flow` })
    assert.deepEqual(result, {
      success: false,
      statusCode: 0,
      error: { code: 'ECONNREFUSED', message: 'Target connection was refused' },
    })
  })

  it('maps transport error codes to bounded messages', async () => {
    const original = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    const pool = agent.get('http://target.test')
    const cases: [string | undefined, string, string][] = [
      ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'Target response headers timed out'],
      ['UND_ERR_BODY_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'Target response body timed out'],
      ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'Target connection timed out'],
      ['ECONNRESET', 'ECONNRESET', 'Target connection was reset'],
      ['ENOTFOUND', 'ENOTFOUND', 'Target host was not found'],
      ['err-weird.code', 'ERR_WEIRD_CODE', 'Target request failed'],
      [undefined, 'DISPATCH_ERROR', 'Target request failed'],
      ['', 'DISPATCH_ERROR', 'Target request failed'],
    ]
    try {
      for (const [code, expectedCode, message] of cases) {
        const error = new Error('transport failure')
        if (code !== undefined) Object.assign(error, { code })
        pool.intercept({ path: '/flow', method: 'POST' }).replyWithError(error)
        const result = await dispatchMessage({ ...input(''), url: 'http://target.test/flow' })
        assert.deepEqual(result, { success: false, statusCode: 0, error: { code: expectedCode, message } })
      }
    } finally {
      setGlobalDispatcher(original)
      await agent.close()
    }
  })
})
