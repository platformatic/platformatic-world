import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import workflowFastify, {
  createRemoteHandlerPushReceiver,
  createRemoteHandlerPushSignature,
  createValkeyRemoteHandlerPushReplayStore,
  mountRemoteHandlerPushRoutes,
  REMOTE_HANDLER_PUSH_BODY_LIMIT,
  REMOTE_HANDLER_PUSH_REPLAY_TTL_MS,
  type RemoteHandlerPushManifest,
  type RemoteHandlerPushOptions,
  type RemoteHandlerPushReplayStore,
  type RemoteHandlerPushRequest,
  type RemoteHandlerPushRuntime,
  type RemoteHandlerPushStatus,
} from '../dist/index.js'

const NOW_SECONDS = 2_000_000_000
const SECRET = 'a sufficiently private test secret'
const HANDLER_RUN_ID = 'wrun_01K4ZQ7V1A2B3C4D5E6F7G8H9J'
const OTHER_HANDLER_RUN_ID = 'wrun_01K4ZQ7V1A2B3C4D5E6F7G8H9K'
const MANIFEST: RemoteHandlerPushManifest = {
  v: 1,
  manifestHash: 'a'.repeat(64),
  handlers: {
    'payments.charge': { workflowId: 'workflow//workflows/payments//charge' },
  },
}

interface Harness {
  receiver: ReturnType<typeof createRemoteHandlerPushReceiver>
  runtime: RemoteHandlerPushRuntime
  calls: {
    reserve: Array<Parameters<RemoteHandlerPushRuntime['reserve']>[0]>
    start: Array<Parameters<RemoteHandlerPushRuntime['start']>[0]>
    status: string[]
    cancel: Array<Parameters<NonNullable<RemoteHandlerPushRuntime['cancel']>>[0]>
  }
  statuses: Map<string, RemoteHandlerPushStatus>
  claims: Array<{ nonce: string, ttlMs: number }>
  request: (input: Omit<RemoteHandlerPushRequest, 'headers'> & {
    nonce?: string
    timestamp?: string
    secret?: string
  }) => Promise<Awaited<ReturnType<Harness['receiver']['handle']>>>
}

function harness (overrides: Partial<RemoteHandlerPushOptions> & {
  runtime?: Partial<RemoteHandlerPushRuntime>
} = {}): Harness {
  const calls: Harness['calls'] = { reserve: [], start: [], status: [], cancel: [] }
  const statuses = new Map<string, RemoteHandlerPushStatus>()
  const reservations = new Map<string, string>()
  const claims: Harness['claims'] = []
  const claimed = new Set<string>()
  const runtime: RemoteHandlerPushRuntime = {
    async reserve (operation) {
      calls.reserve.push(operation)
      const existing = reservations.get(operation.operationKey)
      if (existing) return { handlerRunId: existing, duplicate: true }
      reservations.set(operation.operationKey, HANDLER_RUN_ID)
      return { handlerRunId: HANDLER_RUN_ID }
    },
    async start (operation) {
      calls.start.push(operation)
      statuses.set(operation.handlerRunId, { status: 'running' })
      return { runId: operation.handlerRunId }
    },
    async status (handlerRunId) {
      calls.status.push(handlerRunId)
      return statuses.get(handlerRunId) ?? null
    },
    async cancel (operation) {
      calls.cancel.push(operation)
      return { cancelled: true }
    },
    ...overrides.runtime,
  }
  const replayStore: RemoteHandlerPushReplayStore = overrides.replayStore ?? {
    async claim (nonce, ttlMs) {
      claims.push({ nonce, ttlMs })
      if (claimed.has(nonce)) return false
      claimed.add(nonce)
      return true
    },
  }
  const receiver = createRemoteHandlerPushReceiver({
    identity: {
      tenant: '4d43f8a8-0618-4d3d-a738-20bd830988fa',
      service: 'payments-api',
      versionLabel: 'production-2026-09-05',
    },
    manifest: MANIFEST,
    secret: SECRET,
    replayStore,
    now: () => NOW_SECONDS * 1000,
    ...overrides,
    runtime,
  })
  let nextNonce = 0
  return {
    receiver,
    runtime,
    calls,
    statuses,
    claims,
    async request ({ nonce = `nonce-${++nextNonce}`, timestamp = String(NOW_SECONDS), secret = SECRET, ...request }) {
      const body = request.body ?? Buffer.alloc(0)
      return receiver.handle({
        ...request,
        body,
        headers: {
          'x-pltf-timestamp': timestamp,
          'x-pltf-nonce': nonce,
          'x-pltf-signature': createRemoteHandlerPushSignature({
            secret,
            timestamp,
            nonce,
            method: request.method,
            path: request.path,
            body,
          }),
        },
      })
    },
  }
}

function dispatchBody (overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    operationKey: 'operation-1',
    endpoint: 'payments.charge',
    payload: { amount: 42 },
    budget: { remaining: 30_000 },
    ...overrides,
  }))
}

test('signs the frozen v1 canonical request with uppercase method and a query-free path', () => {
  const body = Buffer.from('{ "meaning": 42 }')
  const digest = createHash('sha256').update(body).digest('hex')
  const expected = createHmac('sha256', SECRET)
    .update(`v1\n${NOW_SECONDS}\nnonce-1\nPOST\n/remote/v1/dispatch\n${digest}`)
    .digest('hex')

  assert.equal(createRemoteHandlerPushSignature({
    secret: SECRET,
    timestamp: String(NOW_SECONDS),
    nonce: 'nonce-1',
    method: 'post',
    path: '/remote/v1/dispatch?ignored=true',
    body,
  }), expected)
  assert.match(expected, /^[a-f0-9]{64}$/)
})

test('dispatches an inline payload through reservation and start without exposing workflowId', async () => {
  const h = harness()
  const response = await h.request({
    method: 'POST',
    path: '/remote/v1/dispatch?delivery=1',
    body: dispatchBody(),
  })

  assert.deepEqual(response, { statusCode: 200, body: { handlerRunId: HANDLER_RUN_ID } })
  assert.deepEqual(h.calls.reserve, [{ operationKey: 'operation-1', budget: { remaining: 30_000 } }])
  assert.deepEqual(h.calls.start, [{
    workflowId: 'workflow//workflows/payments//charge',
    operationKey: 'operation-1',
    handlerRunId: HANDLER_RUN_ID,
    deadlineAt: NOW_SECONDS * 1000 + 30_000,
    payload: { amount: 42 },
  }])
  assert.doesNotMatch(JSON.stringify(response.body), /workflow\/\//)
  assert.deepEqual(h.receiver.identity, {
    tenant: '4d43f8a8-0618-4d3d-a738-20bd830988fa',
    service: 'payments-api',
    versionLabel: 'production-2026-09-05',
  })
  assert.ok(Object.isFrozen(h.receiver.identity))
})

test('returns 409 with the same run and starts only once for a repeated operation key', async () => {
  const h = harness()
  const first = await h.request({ method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody() })
  const duplicate = await h.request({ method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody() })

  assert.equal(first.statusCode, 200)
  assert.deepEqual(duplicate, { statusCode: 409, body: { handlerRunId: HANDLER_RUN_ID } })
  assert.equal(h.calls.reserve.length, 2)
  assert.equal(h.calls.start.length, 1)
})

test('coalesces concurrent dispatches for an operation key', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let reservations = 0
  const h = harness({
    runtime: {
      async reserve () {
        reservations++
        await blocked
        return { handlerRunId: HANDLER_RUN_ID }
      },
    },
  })
  const first = h.request({ method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody(), nonce: 'concurrent-1' })
  const duplicate = h.request({ method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody(), nonce: 'concurrent-2' })
  await new Promise(resolve => setImmediate(resolve))
  release()

  const responses = await Promise.all([first, duplicate])
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409])
  assert.equal(reservations, 1)
  assert.equal(h.calls.start.length, 1)
})

test('rejects withdrawn endpoints and invalid inline dispatch fields', async () => {
  const h = harness()
  const withdrawn = await h.request({
    method: 'POST',
    path: '/remote/v1/dispatch',
    body: dispatchBody({ endpoint: 'missing' }),
  })
  const reference = await h.request({
    method: 'POST',
    path: '/remote/v1/dispatch',
    body: dispatchBody({ payloadRef: 'blob:1' }),
  })
  const exhausted = await h.request({
    method: 'POST',
    path: '/remote/v1/dispatch',
    body: dispatchBody({ budget: { remaining: 999 } }),
  })
  const excessive = await h.request({
    method: 'POST',
    path: '/remote/v1/dispatch',
    body: dispatchBody({ budget: { remaining: 2_147_483_648 } }),
  })

  assert.equal(withdrawn.statusCode, 422)
  assert.equal((withdrawn.body as any).error.code, 'endpoint_withdrawn')
  assert.equal(reference.statusCode, 422)
  assert.match((reference.body as any).error.message, /inline payload/)
  assert.equal(exhausted.statusCode, 422)
  assert.equal((exhausted.body as any).error.code, 'budget_exhausted')
  assert.equal(excessive.statusCode, 422)
  assert.equal((excessive.body as any).error.code, 'start_rejected')
  assert.equal(h.calls.reserve.length, 0)
})

test('accepts exact remote handler push budget boundaries', async () => {
  const reserved: number[] = []
  for (const [index, remaining] of [1_000, 2_147_483_647].entries()) {
    const h = harness()
    const response = await h.request({
      method: 'POST',
      path: '/remote/v1/dispatch',
      nonce: `budget-boundary-${index}`,
      body: dispatchBody({ operationKey: `operation-boundary-${index}`, budget: { remaining } }),
    })
    assert.equal(response.statusCode, 200)
    reserved.push(...h.calls.reserve.map(call => call.budget.remaining))
  }
  assert.deepEqual(reserved, [1_000, 2_147_483_647])
})

test('reports running and bounded terminal status without exposing workflowId', async () => {
  const h = harness()
  h.statuses.set(HANDLER_RUN_ID, { status: 'running' })
  h.statuses.set(OTHER_HANDLER_RUN_ID, {
    status: 'terminal',
    outcome: { ok: true, value: { charged: true } },
  })

  const running = await h.request({ method: 'GET', path: `/remote/v1/operations/${HANDLER_RUN_ID}` })
  const terminal = await h.request({ method: 'GET', path: `/remote/v1/operations/${OTHER_HANDLER_RUN_ID}?poll=1` })

  assert.deepEqual(running, { statusCode: 200, body: { status: 'running' } })
  assert.deepEqual(terminal, {
    statusCode: 200,
    body: { status: 'terminal', outcome: { ok: true, value: { charged: true } } },
  })
  assert.doesNotMatch(JSON.stringify([running.body, terminal.body]), /workflowId/)
})

test('returns 404 for unknown status and rejects malformed run paths or GET bodies', async () => {
  const h = harness()
  const unknown = await h.request({ method: 'GET', path: `/remote/v1/operations/${HANDLER_RUN_ID}` })
  const malformed = await h.request({ method: 'GET', path: '/remote/v1/operations/not-a-run' })
  const withBody = await h.request({
    method: 'GET',
    path: `/remote/v1/operations/${HANDLER_RUN_ID}`,
    body: '{}',
  })

  assert.equal(unknown.statusCode, 404)
  assert.equal((unknown.body as any).error.code, 'handler_run_unknown')
  assert.equal(malformed.statusCode, 400)
  assert.equal(withBody.statusCode, 400)
})

test('cancels by operation and handler run identity and degrades to 501 when unsupported', async () => {
  const h = harness()
  const body = Buffer.from(JSON.stringify({ operationKey: 'operation-1', handlerRunId: HANDLER_RUN_ID }))
  const response = await h.request({ method: 'POST', path: '/remote/v1/cancel', body })
  assert.deepEqual(response, { statusCode: 200, body: { cancelled: true } })
  assert.deepEqual(h.calls.cancel, [{ operationKey: 'operation-1', handlerRunId: HANDLER_RUN_ID }])

  const withoutCancel = harness({ runtime: { cancel: undefined } })
  assert.deepEqual(
    await withoutCancel.request({ method: 'POST', path: '/remote/v1/cancel', body }),
    { statusCode: 501, body: { cancelled: false } }
  )

  const invalid = harness({ runtime: { async cancel () { return {} as any } } })
  const invalidResponse = await invalid.request({ method: 'POST', path: '/remote/v1/cancel', body })
  assert.equal(invalidResponse.statusCode, 500)
  assert.equal((invalidResponse.body as any).error.code, 'remote_handler_unavailable')
})

test('maps typed admission failures to a retry-safe 422 response', async () => {
  const h = harness({
    runtime: {
      async reserve () {
        throw Object.assign(new Error('internal admission detail'), {
          statusCode: 408,
          code: 'budget_exhausted',
        })
      },
    },
  })
  const response = await h.request({ method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody() })
  assert.equal(response.statusCode, 422)
  assert.deepEqual(response.body, {
    error: { code: 'start_rejected', message: 'Remote handler workflow could not be started' },
  })
})

test('authenticates exact body, method, and path before claiming the nonce', async () => {
  const h = harness()
  const body = dispatchBody()
  const timestamp = String(NOW_SECONDS)
  const nonce = 'bound-request'
  const signature = createRemoteHandlerPushSignature({
    secret: SECRET,
    timestamp,
    nonce,
    method: 'POST',
    path: '/remote/v1/dispatch',
    body,
  })
  const cases: RemoteHandlerPushRequest[] = [
    { method: 'POST', path: '/remote/v1/dispatch', body: Buffer.concat([body, Buffer.from(' ')]), headers: signedHeaders(timestamp, nonce, signature) },
    { method: 'GET', path: '/remote/v1/dispatch', body, headers: signedHeaders(timestamp, nonce, signature) },
    { method: 'POST', path: '/remote/v1/cancel', body, headers: signedHeaders(timestamp, nonce, signature) },
    { method: 'POST', path: '/remote/v1/dispatch', body, headers: signedHeaders(timestamp, nonce, signature.toUpperCase()) },
    { method: 'POST', path: '/remote/v1/dispatch', body, headers: {} },
  ]

  for (const request of cases) {
    const response = await h.receiver.handle(request)
    assert.equal(response.statusCode, 401)
    assert.equal((response.body as any).error.code, 'authentication_failed')
  }
  assert.equal(h.claims.length, 0)
})

test('claims each authenticated nonce atomically for exactly five minutes', async () => {
  const h = harness()
  const first = await h.request({
    method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody(), nonce: 'one-use-only',
  })
  const replay = await h.request({
    method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody(), nonce: 'one-use-only',
  })

  assert.equal(first.statusCode, 200)
  assert.equal(replay.statusCode, 409)
  assert.equal((replay.body as any).error.code, 'replay_detected')
  assert.deepEqual(h.claims, [
    { nonce: 'one-use-only', ttlMs: REMOTE_HANDLER_PUSH_REPLAY_TTL_MS },
    { nonce: 'one-use-only', ttlMs: REMOTE_HANDLER_PUSH_REPLAY_TTL_MS },
  ])
})

test('accepts the timestamp-window boundary and rejects stale or future requests', async () => {
  const acceptedPast = await harness().request({
    method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody(), timestamp: String(NOW_SECONDS - 300),
  })
  const acceptedFuture = await harness().request({
    method: 'POST',
    path: '/remote/v1/dispatch',
    body: dispatchBody(),
    timestamp: String(NOW_SECONDS + 300),
  })
  const stale = await harness().request({
    method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody(), timestamp: String(NOW_SECONDS - 301),
  })
  const future = await harness().request({
    method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody(), timestamp: String(NOW_SECONDS + 301),
  })

  assert.equal(acceptedPast.statusCode, 200)
  assert.equal(acceptedFuture.statusCode, 200)
  assert.equal(stale.statusCode, 401)
  assert.equal(future.statusCode, 401)
})

test('fails closed when replay protection is unavailable or returns a non-true claim', async () => {
  const unavailable = harness({
    replayStore: { async claim () { throw new Error('Valkey is down') } },
  })
  const uncertain = harness({
    replayStore: { async claim () { return undefined as unknown as boolean } },
  })

  const unavailableResponse = await unavailable.request({ method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody() })
  const uncertainResponse = await uncertain.request({ method: 'POST', path: '/remote/v1/dispatch', body: dispatchBody() })
  assert.equal(unavailableResponse.statusCode, 503)
  assert.equal((unavailableResponse.body as any).error.code, 'remote_handler_unavailable')
  assert.equal(uncertainResponse.statusCode, 409)
  assert.equal(unavailable.calls.reserve.length, 0)
  assert.equal(uncertain.calls.reserve.length, 0)
})

test('accepts an exact 256 KiB raw request and rejects one additional byte', async () => {
  const h = harness()
  const compact = dispatchBody()
  const exact = Buffer.concat([compact, Buffer.alloc(REMOTE_HANDLER_PUSH_BODY_LIMIT - compact.length, 0x20)])
  assert.equal(exact.length, REMOTE_HANDLER_PUSH_BODY_LIMIT)

  const accepted = await h.request({ method: 'POST', path: '/remote/v1/dispatch', body: exact })
  const oversized = await h.request({
    method: 'POST', path: '/remote/v1/dispatch', body: Buffer.concat([exact, Buffer.from(' ')]),
  })
  assert.equal(accepted.statusCode, 200)
  assert.equal(oversized.statusCode, 413)
  assert.equal((oversized.body as any).error.code, 'payload_too_large')
  assert.equal(h.claims.length, 1)
})

test('rejects malformed JSON, invalid UTF-8, and non-object bodies after authentication', async () => {
  const h = harness()
  for (const body of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from('[]')]) {
    const response = await h.request({ method: 'POST', path: '/remote/v1/dispatch', body })
    assert.equal(response.statusCode, 400)
    assert.equal((response.body as any).error.code, 'malformed_request')
  }
  assert.equal(h.calls.reserve.length, 0)
})

test('normalizes invalid and oversized terminal outputs to a bounded failure', async () => {
  const h = harness()
  h.statuses.set(HANDLER_RUN_ID, {
    status: 'terminal',
    outcome: { ok: true, value: 'x'.repeat(REMOTE_HANDLER_PUSH_BODY_LIMIT) },
  })
  const oversized = await h.request({ method: 'GET', path: `/remote/v1/operations/${HANDLER_RUN_ID}` })
  assert.equal(oversized.statusCode, 200)
  assert.equal((oversized.body as any).outcome.error.code, 'schema_invalid_output')
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.body)) < REMOTE_HANDLER_PUSH_BODY_LIMIT)

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  h.statuses.set(OTHER_HANDLER_RUN_ID, { status: 'terminal', outcome: { ok: true, value: cyclic } })
  const invalid = await h.request({ method: 'GET', path: `/remote/v1/operations/${OTHER_HANDLER_RUN_ID}` })
  assert.equal((invalid.body as any).outcome.error.code, 'schema_invalid_output')
})

test('rejects malformed private manifests at startup, including unknown keys', () => {
  const base = {
    identity: {
      tenant: '4d43f8a8-0618-4d3d-a738-20bd830988fa',
      service: 'service',
      versionLabel: 'version',
    },
    runtime: {
      async reserve () { return { handlerRunId: HANDLER_RUN_ID } },
      async start () {},
      async status () { return null },
    },
    secret: SECRET,
    replayStore: { async claim () { return true } },
  }
  assert.throws(() => createRemoteHandlerPushReceiver({
    ...base,
    manifest: { ...MANIFEST, extra: true } as RemoteHandlerPushManifest,
  }), /manifest is invalid/)
  assert.throws(() => createRemoteHandlerPushReceiver({
    ...base,
    manifest: {
      ...MANIFEST,
      handlers: { endpoint: { workflowId: 'private', extra: true } as any },
    },
  }), /manifest is invalid/)
  assert.throws(() => createRemoteHandlerPushReceiver({
    ...base,
    manifest: { ...MANIFEST, manifestHash: 'A'.repeat(64) },
  }), /manifest is invalid/)
})

test('rejects a non-UUID tenant identity and secrets shorter than 32 bytes', () => {
  const h = harness()
  assert.throws(() => createRemoteHandlerPushReceiver({
    identity: { ...h.receiver.identity, tenant: 'not-an-icc-app-uuid' },
    manifest: MANIFEST,
    runtime: h.runtime,
    secret: SECRET,
    replayStore: { async claim () { return true } },
  }), /ICC application UUID/)
  assert.throws(() => createRemoteHandlerPushReceiver({
    identity: h.receiver.identity,
    manifest: MANIFEST,
    runtime: h.runtime,
    secret: Buffer.alloc(31),
    replayStore: { async claim () { return true } },
  }), /at least 32 bytes/)
})

test('implements replay claims with one atomic Valkey SET NX PX operation', async () => {
  const calls: unknown[][] = []
  const store = createValkeyRemoteHandlerPushReplayStore({
    prefix: 'tenant:app:',
    client: {
      async set (...args) {
        calls.push(args)
        return calls.length === 1 ? 'OK' : null
      },
    },
  })

  assert.equal(await store.claim('nonce-1', 300_000), true)
  assert.equal(await store.claim('nonce-1', 300_000), false)
  assert.deepEqual(calls, [
    ['tenant:app:nonce-1', '1', 'PX', 300_000, 'NX'],
    ['tenant:app:nonce-1', '1', 'PX', 300_000, 'NX'],
  ])
})

test('workflow-fastify optionally mounts push routes with byte-identical JSON bodies', async (t) => {
  const dir = await makeBuildDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const h = harness()
  const app = Fastify()
  t.after(() => app.close())
  await app.register(workflowFastify, {
    buildDir: dir,
    register: false,
    push: {
      identity: h.receiver.identity,
      manifest: MANIFEST,
      runtime: h.runtime,
      secret: SECRET,
      replayStore: { async claim () { return true } },
      now: () => NOW_SECONDS * 1000,
    },
  })

  const raw = '{\n  "operationKey": "operation-fastify",\n  "endpoint": "payments.charge",\n  "payload": { "amount" : 42 },\n  "budget": { "remaining": 30000 }\n}'
  const timestamp = String(NOW_SECONDS)
  const nonce = 'fastify-raw-json'
  const response = await app.inject({
    method: 'POST',
    url: '/remote/v1/dispatch?delivery=fastify',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...signedHeaders(timestamp, nonce, createRemoteHandlerPushSignature({
        secret: SECRET,
        timestamp,
        nonce,
        method: 'POST',
        path: '/remote/v1/dispatch?delivery=fastify',
        body: raw,
      })),
    },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { handlerRunId: HANDLER_RUN_ID })
  assert.deepEqual(h.calls.start[0].payload, { amount: 42 })

  const statusPath = `/remote/v1/operations/${HANDLER_RUN_ID}?poll=fastify`
  const statusNonce = 'fastify-status'
  const status = await app.inject({
    method: 'GET',
    url: statusPath,
    headers: signedHeaders(timestamp, statusNonce, createRemoteHandlerPushSignature({
      secret: SECRET,
      timestamp,
      nonce: statusNonce,
      method: 'GET',
      path: statusPath,
    })),
  })
  assert.equal(status.statusCode, 200)
  assert.deepEqual(status.json(), { status: 'running' })

  const cancelPath = '/remote/v1/cancel'
  const cancelBody = JSON.stringify({ operationKey: 'operation-fastify', handlerRunId: HANDLER_RUN_ID })
  const cancelNonce = 'fastify-cancel'
  const cancel = await app.inject({
    method: 'POST',
    url: cancelPath,
    payload: cancelBody,
    headers: {
      'content-type': 'application/json',
      ...signedHeaders(timestamp, cancelNonce, createRemoteHandlerPushSignature({
        secret: SECRET,
        timestamp,
        nonce: cancelNonce,
        method: 'POST',
        path: cancelPath,
        body: cancelBody,
      })),
    },
  })
  assert.equal(cancel.statusCode, 200)
  assert.deepEqual(cancel.json(), { cancelled: true })
  assert.deepEqual(h.calls.cancel, [{ operationKey: 'operation-fastify', handlerRunId: HANDLER_RUN_ID }])
})

test('standalone push route mounting preserves signed JSON bytes', async (t) => {
  const h = harness()
  const app = Fastify()
  t.after(() => app.close())
  await mountRemoteHandlerPushRoutes(app, {
    identity: h.receiver.identity,
    manifest: MANIFEST,
    runtime: h.runtime,
    secret: SECRET,
    replayStore: { async claim () { return true } },
    now: () => NOW_SECONDS * 1000,
  })

  const raw = '{\n  "operationKey": "operation-standalone",\n  "endpoint": "payments.charge",\n  "payload": { "amount" : 42 },\n  "budget": { "remaining": 30000 }\n}'
  const timestamp = String(NOW_SECONDS)
  const nonce = 'standalone-raw-json'
  const response = await app.inject({
    method: 'POST',
    url: '/remote/v1/dispatch?delivery=standalone',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...signedHeaders(timestamp, nonce, createRemoteHandlerPushSignature({
        secret: SECRET,
        timestamp,
        nonce,
        method: 'POST',
        path: '/remote/v1/dispatch?delivery=standalone',
        body: raw,
      })),
    },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { handlerRunId: HANDLER_RUN_ID })
  assert.deepEqual(h.calls.start[0].payload, { amount: 42 })
})

test('workflow-fastify enforces the exact 256 KiB route body limit', async (t) => {
  const dir = await makeBuildDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const h = harness()
  const app = Fastify()
  t.after(() => app.close())
  await app.register(workflowFastify, {
    buildDir: dir,
    register: false,
    push: {
      identity: h.receiver.identity,
      manifest: MANIFEST,
      runtime: h.runtime,
      secret: SECRET,
      replayStore: { async claim () { return true } },
      now: () => NOW_SECONDS * 1000,
    },
  })
  const compact = dispatchBody({ operationKey: 'operation-fastify-limit' })
  const exact = Buffer.concat([compact, Buffer.alloc(REMOTE_HANDLER_PUSH_BODY_LIMIT - compact.length, 0x20)])
  const timestamp = String(NOW_SECONDS)
  const exactNonce = 'fastify-exact-limit'
  const exactResponse = await app.inject({
    method: 'POST',
    url: '/remote/v1/dispatch',
    payload: exact,
    headers: {
      'content-type': 'application/json',
      ...signedHeaders(timestamp, exactNonce, createRemoteHandlerPushSignature({
        secret: SECRET,
        timestamp,
        nonce: exactNonce,
        method: 'POST',
        path: '/remote/v1/dispatch',
        body: exact,
      })),
    },
  })
  assert.equal(exactResponse.statusCode, 200)

  const oversized = Buffer.concat([exact, Buffer.from(' ')])
  const oversizedNonce = 'fastify-over-limit'
  const oversizedResponse = await app.inject({
    method: 'POST',
    url: '/remote/v1/dispatch',
    payload: oversized,
    headers: {
      'content-type': 'application/json',
      ...signedHeaders(timestamp, oversizedNonce, createRemoteHandlerPushSignature({
        secret: SECRET,
        timestamp,
        nonce: oversizedNonce,
        method: 'POST',
        path: '/remote/v1/dispatch',
        body: oversized,
      })),
    },
  })
  assert.equal(oversizedResponse.statusCode, 413)
})

function signedHeaders (timestamp: string, nonce: string, signature: string): Record<string, string> {
  return {
    'x-pltf-timestamp': timestamp,
    'x-pltf-nonce': nonce,
    'x-pltf-signature': signature,
  }
}

async function makeBuildDir (): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wf-fastify-push-'))
  const base = join(dir, '.well-known/workflow/v1')
  await mkdir(base, { recursive: true })
  await writeFile(join(base, 'flow.mjs'), 'export const POST = async () => new Response("flow")\n')
  await writeFile(join(base, '__step_registrations.mjs'), 'export const steps = {}\n')
  await writeFile(join(base, 'webhook.mjs'), 'export const POST = async () => new Response("webhook")\n')
  await writeFile(join(base, 'manifest.json'), JSON.stringify({ workflows: {} }))
  return dir
}
