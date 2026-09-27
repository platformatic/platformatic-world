import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPlatformaticWorld } from '../src/index.ts'

interface CapabilityServerOptions {
  statusCode?: number
  body?: unknown
}

async function capabilityServer (options: CapabilityServerOptions = {}) {
  const requests: string[] = []
  const server = createServer((req, res) => {
    const url = req.url || ''
    if (url === '/api/v1/apps/app/capabilities') {
      requests.push(url)
      res.writeHead(options.statusCode ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(options.body ?? {
        specVersion: 7,
        capabilities: { eventsCreateBatch: true },
      }))
      return
    }

    if (url.endsWith('/events/batch') && req.method === 'POST') {
      requests.push(url)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [] }))
      return
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function buildWorld (port: number) {
  const world = createPlatformaticWorld({
    serviceUrl: `http://127.0.0.1:${port}`,
    appId: 'app',
    deploymentVersion: 'test',
  })
  // start() awaits the one-time probe. No PORT means it does not attempt
  // handler registration, so these tests cover only capability negotiation.
  await world.start?.()
  return world as typeof world & { capabilities: { eventsCreateBatch?: boolean } }
}

test('does not advertise support before the async probe is awaited', async () => {
  const server = await capabilityServer()
  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://127.0.0.1:${server.port}`,
      appId: 'app',
      deploymentVersion: 'test',
    })
    assert.notEqual(world.capabilities.eventsCreateBatch, true)
    assert.equal(server.requests.length, 0)
    await world.refreshCapabilities()
    assert.equal(world.capabilities.eventsCreateBatch, true)
    assert.equal(server.requests.filter((url) => url.endsWith('/capabilities')).length, 1)
    await world.close?.()
  } finally {
    await server.close()
  }
})

test('declares events.createBatch only when the service advertises it', async () => {
  const server = await capabilityServer()
  try {
    const world = await buildWorld(server.port)
    assert.equal(world.capabilities.eventsCreateBatch, true)
    assert.equal(server.requests.filter((url) => url.endsWith('/capabilities')).length, 1)
    await world.close?.()
  } finally {
    await server.close()
  }
})

test('fails closed when a service omits the batch capability', async () => {
  const server = await capabilityServer({
    body: { specVersion: 7, capabilities: {} },
  })
  try {
    const world = await buildWorld(server.port)
    assert.notEqual(world.capabilities.eventsCreateBatch, true)
    assert.equal(server.requests.filter((url) => url.endsWith('/capabilities')).length, 1)
    await world.close?.()
  } finally {
    await server.close()
  }
})

test('fails closed when an older service returns 404', async () => {
  const server = await capabilityServer({ statusCode: 404 })
  try {
    const world = await buildWorld(server.port)
    assert.notEqual(world.capabilities.eventsCreateBatch, true)
    assert.equal(server.requests.filter((url) => url.endsWith('/capabilities')).length, 1)
    await world.close?.()
  } finally {
    await server.close()
  }
})

test('fails closed when the service advertises an old capability protocol', async () => {
  const server = await capabilityServer({
    body: { specVersion: 5, capabilities: { eventsCreateBatch: true } },
  })
  try {
    const world = await buildWorld(server.port)
    assert.notEqual(world.capabilities.eventsCreateBatch, true)
    assert.equal(server.requests.filter((url) => url.endsWith('/capabilities')).length, 1)
    await world.close?.()
  } finally {
    await server.close()
  }
})

test('fails closed when the capability document is malformed', async () => {
  const server = await capabilityServer({
    body: { specVersion: '7', capabilities: { eventsCreateBatch: true } },
  })
  try {
    const world = await buildWorld(server.port)
    assert.notEqual(world.capabilities.eventsCreateBatch, true)
    assert.equal(server.requests.filter((url) => url.endsWith('/capabilities')).length, 1)
    await world.close?.()
  } finally {
    await server.close()
  }
})

test('does not probe capabilities for every event batch', async () => {
  const server = await capabilityServer()
  try {
    const world = await buildWorld(server.port)
    await world.events.createBatch?.('run-1', [{ event: { eventType: 'step_created', correlationId: 'a' } }] as any)
    await world.events.createBatch?.('run-1', [{ event: { eventType: 'step_created', correlationId: 'b' } }] as any)
    assert.equal(server.requests.filter((url) => url.endsWith('/capabilities')).length, 1)
    assert.equal(server.requests.filter((url) => url.endsWith('/events/batch')).length, 2)
    await world.close?.()
  } finally {
    await server.close()
  }
})
