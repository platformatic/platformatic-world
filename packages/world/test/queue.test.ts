import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decode, encode } from 'cbor-x'
import { SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT } from '@workflow/world'
import { createPlatformaticWorld } from '../src/index.ts'

interface RecordedRequest {
  contentType: string
  body: Buffer
  path: string
}

async function startRecordingServer (messageId = 'abc'): Promise<{ port: number; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      requests.push({
        contentType: req.headers['content-type'] || '',
        body: Buffer.concat(chunks),
        path: req.url || '',
      })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ messageId }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('queue() with specVersion 3 uses CBOR transport', async () => {
  const srv = await startRecordingServer('msg_1')
  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://localhost:${srv.port}`,
      appId: 'app',
      deploymentVersion: 'v1',
    })

    await world.queue('__wkf_workflow_test' as any, { runId: 'r1' } as any, {
      specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
    })

    assert.equal(srv.requests.length, 1)
    const recorded = srv.requests[0]
    assert.match(recorded.contentType, /application\/cbor/)
    const decoded = decode(recorded.body) as any
    assert.equal(decoded.queueName, '__wkf_workflow_test')
    assert.equal(decoded.message.runId, 'r1')
    assert.equal(decoded.deploymentId, 'v1')

    await world.close!()
  } finally {
    await srv.close()
  }
})

test('queue() without specVersion defaults to CBOR transport', async () => {
  // Our world declares specVersion = SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  // so missing specVersion in the opts is treated as v3 to stay consistent with
  // how we tag our own runs. SDK paths that omit specVersion therefore still
  // produce CBOR messages instead of silently falling back to JSON.
  const srv = await startRecordingServer('msg_2')
  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://localhost:${srv.port}`,
      appId: 'app',
      deploymentVersion: 'v1',
    })

    await world.queue('__wkf_workflow_test' as any, { runId: 'r2' } as any, {})

    assert.equal(srv.requests.length, 1)
    const recorded = srv.requests[0]
    assert.match(recorded.contentType, /application\/cbor/)
    const decoded = decode(recorded.body) as any
    assert.equal(decoded.queueName, '__wkf_workflow_test')
    assert.equal(decoded.message.runId, 'r2')

    await world.close!()
  } finally {
    await srv.close()
  }
})

test('queue() with specVersion 2 uses JSON transport', async () => {
  const srv = await startRecordingServer('msg_3')
  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://localhost:${srv.port}`,
      appId: 'app',
      deploymentVersion: 'v1',
    })

    await world.queue('__wkf_workflow_test' as any, { runId: 'r3' } as any, {
      specVersion: 2,
    })

    assert.match(srv.requests[0].contentType, /application\/json/)

    await world.close!()
  } finally {
    await srv.close()
  }
})

test('queue() CBOR round-trips Uint8Array in message', async () => {
  const srv = await startRecordingServer('msg_4')
  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://localhost:${srv.port}`,
      appId: 'app',
      deploymentVersion: 'v1',
    })

    const bytes = new Uint8Array([0x00, 0xFF, 0x10, 0x20])
    await world.queue(
      '__wkf_workflow_test' as any,
      { runId: 'r4', runInput: { input: bytes, deploymentId: 'v1', workflowName: 'w', specVersion: 3 } } as any,
      { specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT }
    )

    const decoded = decode(srv.requests[0].body) as any
    const roundTripped = decoded.message.runInput.input
    assert.ok(roundTripped instanceof Uint8Array, `expected Uint8Array, got ${roundTripped?.constructor?.name}`)
    assert.deepEqual(Array.from(roundTripped), [0x00, 0xFF, 0x10, 0x20])

    await world.close!()
  } finally {
    await srv.close()
  }
})

test('createQueueHandler accepts JSON', async () => {
  const world = createPlatformaticWorld({
    serviceUrl: 'http://localhost:9999',
    appId: 'app',
    deploymentVersion: 'v1',
  })

  let received: any
  const handler = world.createQueueHandler('__wkf_workflow_' as any, async (message, meta) => {
    received = { message, meta }
  })

  const req = new Request('http://localhost/flow', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { runId: 'r1' },
      meta: { queueName: '__wkf_workflow_test', messageId: 'm1', attempt: 1 },
    }),
  })
  const res = await handler(req)
  assert.equal(res.status, 200)
  assert.equal(received.message.runId, 'r1')
  assert.equal(received.meta.messageId, 'm1')

  await world.close!()
})

test('createQueueHandler accepts CBOR', async () => {
  const world = createPlatformaticWorld({
    serviceUrl: 'http://localhost:9999',
    appId: 'app',
    deploymentVersion: 'v1',
  })

  let received: any
  const handler = world.createQueueHandler('__wkf_workflow_' as any, async (message, meta) => {
    received = { message, meta }
  })

  const body = encode({
    message: { runId: 'r2', bytes: new Uint8Array([1, 2, 3]) },
    meta: { queueName: '__wkf_workflow_test', messageId: 'm2', attempt: 2 },
  })
  const req = new Request('http://localhost/flow', {
    method: 'POST',
    headers: { 'content-type': 'application/cbor' },
    body: Buffer.from(body),
  })
  const res = await handler(req)
  assert.equal(res.status, 200)
  assert.equal(received.message.runId, 'r2')
  assert.ok(received.message.bytes instanceof Uint8Array)
  assert.deepEqual(Array.from(received.message.bytes), [1, 2, 3])

  await world.close!()
})

test('world declares specVersion 3', () => {
  const world = createPlatformaticWorld({
    serviceUrl: 'http://localhost:9999',
    appId: 'app',
    deploymentVersion: 'v1',
  })
  assert.equal(world.specVersion, SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT)
  assert.equal(world.specVersion, 3)
})
