import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  createPlatformaticWorld,
  createStaticRemoteEndpointRegistry,
  REMOTE_ENDPOINT_REGISTRY_PROVIDER,
  setRemoteEndpointRegistryProvider,
  type StageRemoteOperation,
} from '../src/index.ts'

const ICC_APPLICATION_ID = '11111111-1111-4111-8111-111111111111'
const SCHEMA_HASH = '966d77cc864448a2d621e8ca68ae497452dab9a285954ceb6b80906bab5a2ff2'

afterEach(() => setRemoteEndpointRegistryProvider(undefined))

test('uses the global worker bridge ABI and bypasses it for exact replay', async () => {
  const stored = new Map<string, any>()
  const received: any[] = []
  const server = createServer(async (request, response) => {
    const body = await readJson(request)
    received.push(body)
    const existing = stored.get(body.operationKey)
    if (existing) return json(response, 200, existing)
    if (!body.resolution) return json(response, 428, { code: 'endpoint_resolution_required' })
    stored.set(body.operationKey, body)
    return json(response, 201, body)
  })
  const serviceUrl = await listen(server)
  const world = createPlatformaticWorld({
    serviceUrl,
    appId: 'caller-label',
    deploymentVersion: 'v1',
  })
  let providerCalls = 0
  const registry = createStaticRemoteEndpointRegistry({
    iccApplicationId: ICC_APPLICATION_ID,
    endpoints: {
      'inventory.reserve': {
        owner: 'inventory',
        schemaHash: SCHEMA_HASH,
        transport: 'pull',
        policy: {},
        epoch: 7,
      },
    },
    schemas: {
      [SCHEMA_HASH]: { inputSchema: { type: 'object' }, outputSchema: { type: 'boolean' } },
    },
  })
  assert.equal(
    REMOTE_ENDPOINT_REGISTRY_PROVIDER,
    Symbol.for('@platformatic/world/remote-endpoint-registry-provider/v1')
  )
  ;(globalThis as any)[Symbol.for('@platformatic/world/remote-endpoint-registry-provider/v1')] = () => {
    assert.equal(received.length, 1, 'the provider is consulted only after the 428 probe response')
    providerCalls++
    return registry
  }
  assert.equal(
    (globalThis as any)[REMOTE_ENDPOINT_REGISTRY_PROVIDER] instanceof Function,
    true,
    'Watt Extra can populate the frozen Symbol.for slot without importing World'
  )

  const operation = remoteOperation('first')
  try {
    const created = await world.remoteOperations.stage('run-1', operation)
    assert.equal(created.resolution.epoch, 7)
    assert.equal(created.resolution.iccApplicationId, ICC_APPLICATION_ID)
    assert.equal(created.resolution.schemaHash, SCHEMA_HASH)
    assert.equal(providerCalls, 1)
    assert.equal(received.length, 2)
    assert.equal('resolution' in received[0], false)
    assert.equal('epoch' in received[0], false)

    setRemoteEndpointRegistryProvider(undefined)
    assert.equal((await world.remoteOperations.stage('run-1', operation)).operationKey, 'first')
    assert.equal(providerCalls, 1)

    setRemoteEndpointRegistryProvider(() => { throw new Error('mutated registry must not be consulted') })
    assert.equal((await world.remoteOperations.stage('run-1', operation)).operationKey, 'first')
    assert.equal(providerCalls, 1)
  } finally {
    await world.close()
    await close(server)
  }
})

test('deduplicates concurrent first dispatches through the two-pass handshake', async () => {
  const stored = new Map<string, any>()
  const server = createServer(async (request, response) => {
    const body = await readJson(request)
    const existing = stored.get(body.operationKey)
    if (existing) return json(response, 200, existing)
    if (!body.resolution) return json(response, 428, { code: 'endpoint_resolution_required' })
    stored.set(body.operationKey, body)
    return json(response, 201, body)
  })
  const serviceUrl = await listen(server)
  const world = createPlatformaticWorld({ serviceUrl, appId: 'caller-label', deploymentVersion: 'v1' })
  setRemoteEndpointRegistryProvider(() => createStaticRemoteEndpointRegistry({
    iccApplicationId: ICC_APPLICATION_ID,
    endpoints: {
      'inventory.reserve': {
        owner: 'inventory', schemaHash: SCHEMA_HASH, transport: 'pull', policy: {}, epoch: 7,
      },
    },
    schemas: { [SCHEMA_HASH]: { inputSchema: true, outputSchema: true } },
  }))

  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => world.remoteOperations.stage('run-1', remoteOperation('concurrent')))
    )
    assert.equal(results.length, 12)
    assert.equal(stored.size, 1)
  } finally {
    await world.close()
    await close(server)
  }
})

test('never exposes the internal 428 and surfaces server schema errors at the call site', async () => {
  let resolvedRequests = 0
  const server = createServer(async (request, response) => {
    const body = await readJson(request)
    if (!body.resolution) return json(response, 428, { code: 'endpoint_resolution_required' })
    resolvedRequests++
    if (body.operationKey === 'double-428') {
      return json(response, 428, { code: 'endpoint_resolution_required' })
    }
    return json(response, 422, { code: 'schema_invalid_input', error: 'input failed validation' })
  })
  const serviceUrl = await listen(server)
  const world = createPlatformaticWorld({ serviceUrl, appId: 'caller-label', deploymentVersion: 'v1' })
  setRemoteEndpointRegistryProvider(() => createStaticRemoteEndpointRegistry({
    iccApplicationId: ICC_APPLICATION_ID,
    endpoints: {
      'inventory.reserve': {
        owner: 'inventory', schemaHash: SCHEMA_HASH, transport: 'pull', policy: {}, epoch: 7,
      },
    },
    schemas: { [SCHEMA_HASH]: { inputSchema: true, outputSchema: true } },
  }))

  try {
    await assert.rejects(
      world.remoteOperations.stage('run-1', remoteOperation('invalid-schema')),
      (error: any) => error.statusCode === 422 && error.code === 'schema_invalid_input'
    )
    await assert.rejects(
      world.remoteOperations.stage('run-1', remoteOperation('double-428')),
      (error: any) => error.code === 'remote_registry_protocol_error' && error.statusCode === undefined
    )
    setRemoteEndpointRegistryProvider(undefined)
    await assert.rejects(
      world.remoteOperations.stage('run-1', remoteOperation('missing-provider')),
      (error: any) => error.code === 'remote_registry_protocol_error' && error.statusCode === undefined
    )
    assert.equal(resolvedRequests, 2, 'each dispatch retries at most once')
  } finally {
    await world.close()
    await close(server)
  }
})

test('forwards ICC updates to the World outcome endpoint', async () => {
  const updates = [{
    operationKey: 'operation-1',
    kind: 'completed' as const,
    handlerRunId: 'handler-run-1',
    outcome: { ok: true, value: { reservationId: 'reservation-1' } },
  }]
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/api/v1/apps/caller-label/remote-operations/updates')
    assert.deepEqual(await readJson(request), { updates })
    json(response, 200, { applied: 1, delivered: 1 })
  })
  const serviceUrl = await listen(server)
  const world = createPlatformaticWorld({ serviceUrl, appId: 'caller-label', deploymentVersion: 'v1' })
  try {
    assert.deepEqual(await world.remoteOperations.applyUpdates(updates), { applied: 1, delivered: 1 })
  } finally {
    await world.close()
    await close(server)
  }
})

test('forwards active-operation pagination to the tenant-scoped World endpoint', async () => {
  const page = {
    data: [{
      operationKey: 'operation / 1',
      endpoint: 'inventory.reserve',
      payload: { sku: 'SKU-1' },
      budget: { remaining: 29_000 },
      epoch: 7,
      cancelRequested: false,
    }],
    cursor: 'operation / 1',
    hasMore: true,
  }
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'GET')
    assert.equal(
      request.url,
      '/api/v1/apps/caller-label/remote-operations/active?cursor=previous+%2F+key&limit=17'
    )
    json(response, 200, page)
  })
  const serviceUrl = await listen(server)
  const world = createPlatformaticWorld({ serviceUrl, appId: 'caller-label', deploymentVersion: 'v1' })
  try {
    assert.deepEqual(
      await world.remoteOperations.listActive({ cursor: 'previous / key', limit: 17 }),
      page
    )
  } finally {
    await world.close()
    await close(server)
  }
})

function remoteOperation (operationKey: string): StageRemoteOperation {
  return {
    operationKey,
    dispatchStepId: 'step//remote//dispatch',
    ordinal: 'ordinal-1',
    endpoint: 'inventory.reserve',
    payload: { sku: 'SKU-1' },
    budget: { remaining: 30_000 },
  }
}

async function readJson (request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json (response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function listen (server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  return `http://127.0.0.1:${address.port}`
}

async function close (server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
