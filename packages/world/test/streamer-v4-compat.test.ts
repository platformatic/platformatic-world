// Verifies @workflow/core@4.x can still use this world even though we
// type against @workflow/world@5.x. v4 callers use flat methods with
// (name, runId, ...) argument order; we expose them as thin wrappers
// over the v5 `streams.*` shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPlatformaticWorld } from '../src/index.ts'

interface Recorded {
  method: string
  url: string
  body: string
  headers: Record<string, string | string[] | undefined>
}

async function recordingServer (): Promise<{ port: number; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      requests.push({
        method: req.method || '',
        url: req.url || '',
        body: Buffer.concat(chunks).toString('utf8'),
        headers: req.headers,
      })
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  return { port, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('v4 writeToStream(name, runId, chunk) forwards to /runs/:runId/streams/:name', async () => {
  const srv = await recordingServer()
  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://localhost:${srv.port}`,
      appId: 'app',
      deploymentVersion: 'v1',
    }) as any
    await world.writeToStream('my-stream', 'wrun_abc', 'hello')
    assert.equal(srv.requests.length, 1)
    const req = srv.requests[0]
    assert.equal(req.method, 'PUT')
    assert.equal(req.url, '/api/v1/apps/app/runs/wrun_abc/streams/my-stream')
    const body = JSON.parse(req.body)
    assert.equal(Buffer.from(body.data, 'base64').toString('utf8'), 'hello')
    await world.close!()
  } finally {
    await srv.close()
  }
})

test('v4 writeToStreamMulti(name, runId, chunks) forwards with x-stream-multi', async () => {
  const srv = await recordingServer()
  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://localhost:${srv.port}`,
      appId: 'app',
      deploymentVersion: 'v1',
    }) as any
    await world.writeToStreamMulti('s', 'wrun_xyz', ['a', 'b'])
    assert.equal(srv.requests[0].headers['x-stream-multi'], 'true')
    assert.equal(srv.requests[0].url, '/api/v1/apps/app/runs/wrun_xyz/streams/s')
    await world.close!()
  } finally {
    await srv.close()
  }
})

test('v4 closeStream(name, runId) sends x-stream-done', async () => {
  const srv = await recordingServer()
  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://localhost:${srv.port}`,
      appId: 'app',
      deploymentVersion: 'v1',
    }) as any
    await world.closeStream('s', 'wrun_zzz')
    assert.equal(srv.requests[0].headers['x-stream-done'], 'true')
    assert.equal(srv.requests[0].url, '/api/v1/apps/app/runs/wrun_zzz/streams/s')
    await world.close!()
  } finally {
    await srv.close()
  }
})

test('v4 listStreamsByRunId(runId) hits /runs/:runId/streams', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/v1/apps/app/runs/wrun_list/streams') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(['a', 'b']))
    } else {
      res.writeHead(404); res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://localhost:${port}`,
      appId: 'app',
      deploymentVersion: 'v1',
    }) as any
    const names = await world.listStreamsByRunId('wrun_list')
    assert.deepEqual(names, ['a', 'b'])
    await world.close!()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('v4 surface coexists with v5 streams.* on the same world', () => {
  const world = createPlatformaticWorld({
    serviceUrl: 'http://localhost:9999',
    appId: 'app',
    deploymentVersion: 'v1',
  }) as any
  // v4 shape
  assert.equal(typeof world.writeToStream, 'function')
  assert.equal(typeof world.writeToStreamMulti, 'function')
  assert.equal(typeof world.closeStream, 'function')
  assert.equal(typeof world.readFromStream, 'function')
  assert.equal(typeof world.listStreamsByRunId, 'function')
  // v5 shape
  assert.equal(typeof world.streams.write, 'function')
  assert.equal(typeof world.streams.writeMulti, 'function')
  assert.equal(typeof world.streams.close, 'function')
  assert.equal(typeof world.streams.get, 'function')
  assert.equal(typeof world.streams.list, 'function')
  assert.equal(typeof world.streams.getChunks, 'function')
  assert.equal(typeof world.streams.getInfo, 'function')
})
