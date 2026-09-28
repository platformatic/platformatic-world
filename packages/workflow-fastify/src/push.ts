import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'

export const REMOTE_HANDLER_PUSH_BODY_LIMIT = 256 * 1024
export const REMOTE_HANDLER_PUSH_REPLAY_TTL_MS = 5 * 60 * 1000
export const REMOTE_HANDLER_PUSH_TIMESTAMP_WINDOW_SECONDS = 300

const MINIMUM_BUDGET_MS = 1_000
const MAXIMUM_BUDGET_MS = 2_147_483_647

const RUN_ID_PATTERN = /^wrun_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface RemoteHandlerPushIdentity {
  // ICC application UUID. This is the remote protocol tenant.
  tenant: string
  // Watt application ID. This is the handler service identity.
  service: string
  // Deployment version resolved by ICC, never inferred by this package.
  versionLabel: string
}

export interface RemoteHandlerPushManifest {
  v: 1
  manifestHash: string
  handlers: Record<string, { workflowId: string }>
}

export interface RemoteHandlerPushReplayStore {
  // Must atomically claim a nonce only when it does not exist, for ttlMs.
  claim: (nonce: string, ttlMs: number) => Promise<boolean>
}

export type RemoteHandlerPushOutcome =
  | { ok: true, value: unknown }
  | { ok: false, kind: 'failed' | 'cancelled', error: { code: string, message: string } }

export type RemoteHandlerPushStatus =
  | { status: 'running' }
  | { status: 'terminal', outcome: RemoteHandlerPushOutcome }

export interface RemoteHandlerPushRuntime {
  reserve: (operation: { operationKey: string, budget: { remaining: number } }) => Promise<{
    handlerRunId: string
    duplicate?: boolean
  }>
  start: (operation: {
    workflowId: string
    operationKey: string
    handlerRunId: string
    deadlineAt: number
    payload: unknown
  }) => Promise<{ runId?: string } | void>
  status: (handlerRunId: string) => Promise<RemoteHandlerPushStatus | null>
  cancel?: (operation: { operationKey: string, handlerRunId: string }) => Promise<{ cancelled: boolean }>
}

export interface RemoteHandlerPushOptions {
  identity: RemoteHandlerPushIdentity
  manifest: RemoteHandlerPushManifest
  runtime: RemoteHandlerPushRuntime
  secret: string | Buffer
  replayStore: RemoteHandlerPushReplayStore
  now?: () => number
}

export interface RemoteHandlerPushRequest {
  method: string
  path: string
  headers?: Record<string, string | string[] | undefined>
  body?: string | Buffer | Uint8Array
}

export interface RemoteHandlerPushResponse {
  statusCode: number
  body: unknown
}

interface ReceiverError extends Error {
  statusCode: number
  code: string
}

function receiverError (statusCode: number, code: string, message: string): ReceiverError {
  return Object.assign(new Error(message), { statusCode, code })
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord (value: unknown): value is Record<string, unknown> {
  return isRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function requireIdentity (identity: RemoteHandlerPushIdentity): Readonly<RemoteHandlerPushIdentity> {
  if (!isRecord(identity)) throw new TypeError('Remote handler push identity is required')
  for (const key of ['tenant', 'service', 'versionLabel'] as const) {
    if (typeof identity[key] !== 'string' || identity[key].length === 0) {
      throw new TypeError(`Remote handler push identity ${key} must be a non-empty string`)
    }
  }
  if (!UUID_PATTERN.test(identity.tenant)) {
    throw new TypeError('Remote handler push identity tenant must be an ICC application UUID')
  }
  return Object.freeze({
    tenant: identity.tenant,
    service: identity.service,
    versionLabel: identity.versionLabel,
  })
}

function requireManifest (manifest: RemoteHandlerPushManifest): ReadonlyMap<string, string> {
  if (!isPlainRecord(manifest) || manifest.v !== 1 ||
      typeof manifest.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.manifestHash) ||
      !isPlainRecord(manifest.handlers) || Object.keys(manifest).sort().join(',') !== 'handlers,manifestHash,v') {
    throw new TypeError('Remote handler push manifest is invalid')
  }
  const handlers = new Map<string, string>()
  for (const [endpoint, handler] of Object.entries(manifest.handlers)) {
    if (endpoint.length === 0 || endpoint.length > 1024 || !isPlainRecord(handler) ||
        Object.keys(handler).join(',') !== 'workflowId' ||
        typeof handler.workflowId !== 'string' || handler.workflowId.length === 0) {
      throw new TypeError('Remote handler push manifest is invalid')
    }
    handlers.set(endpoint, handler.workflowId)
  }
  return handlers
}

function requireSecret (secret: string | Buffer): Buffer {
  const value = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret
  if (!Buffer.isBuffer(value) || value.length < 32) {
    throw new TypeError('Remote handler push secret must contain at least 32 bytes')
  }
  return Buffer.from(value)
}

function rawBody (body: RemoteHandlerPushRequest['body']): Buffer {
  if (body === undefined) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  throw receiverError(400, 'malformed_request', 'Remote handler push body must be provided as raw bytes')
}

function pathname (path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw receiverError(400, 'malformed_request', 'Remote handler push path is required')
  }
  try {
    return new URL(path, 'http://remote-handler.invalid').pathname
  } catch {
    throw receiverError(400, 'malformed_request', 'Remote handler push path is invalid')
  }
}

function header (headers: RemoteHandlerPushRequest['headers'], name: string): string | undefined {
  if (!headers) return undefined
  const value = headers[name] ?? headers[name.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

function canonicalRequest (request: {
  timestamp: string
  nonce: string
  method: string
  path: string
  body: Buffer
}): string {
  const digest = createHash('sha256').update(request.body).digest('hex')
  return `v1\n${request.timestamp}\n${request.nonce}\n${request.method.toUpperCase()}\n${pathname(request.path)}\n${digest}`
}

export function createRemoteHandlerPushSignature (request: {
  secret: string | Buffer
  timestamp: string
  nonce: string
  method: string
  path: string
  body?: string | Buffer | Uint8Array
}): string {
  return createHmac('sha256', requireSecret(request.secret))
    .update(canonicalRequest({ ...request, body: rawBody(request.body) }))
    .digest('hex')
}

function safeSignatureEqual (actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) return false
  const actualBytes = Buffer.from(actual, 'hex')
  const expectedBytes = Buffer.from(expected, 'hex')
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function parseJsonBody (body: Buffer): Record<string, unknown> {
  if (body.length === 0) throw receiverError(400, 'malformed_request', 'Remote handler push JSON body is required')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw receiverError(400, 'malformed_request', 'Remote handler push body is not valid UTF-8')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw receiverError(400, 'malformed_request', 'Remote handler push body is not valid JSON')
  }
  if (!isRecord(value)) throw receiverError(400, 'malformed_request', 'Remote handler push body must be an object')
  return value
}

function jsonBytes (value: unknown): number {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    throw receiverError(422, 'start_rejected', 'Remote handler payload is not JSON serializable')
  }
  if (json === undefined) throw receiverError(422, 'start_rejected', 'Remote handler payload is not JSON serializable')
  return Buffer.byteLength(json, 'utf8')
}

function validateOperationKey (operationKey: unknown): asserts operationKey is string {
  if (typeof operationKey !== 'string' || operationKey.length === 0 ||
      Buffer.byteLength(operationKey, 'utf8') > 1024) {
    throw receiverError(422, 'start_rejected', 'operationKey must be a non-empty string of at most 1024 UTF-8 bytes')
  }
}

function validateHandlerRunId (handlerRunId: unknown): asserts handlerRunId is string {
  if (typeof handlerRunId !== 'string' || !RUN_ID_PATTERN.test(handlerRunId)) {
    throw receiverError(400, 'malformed_request', 'handlerRunId must be a wrun_ prefixed ULID')
  }
}

function validateDispatch (body: Record<string, unknown>): {
  operationKey: string
  endpoint: string
  payload: unknown
  remaining: number
} {
  validateOperationKey(body.operationKey)
  if (typeof body.endpoint !== 'string' || body.endpoint.length === 0 || body.endpoint.length > 1024) {
    throw receiverError(422, 'start_rejected', 'endpoint must be a non-empty string of at most 1024 characters')
  }
  if (!Object.hasOwn(body, 'payload') || Object.hasOwn(body, 'payloadRef')) {
    throw receiverError(422, 'start_rejected', 'Remote handler push v1 requires an inline payload')
  }
  if (jsonBytes(body.payload) > REMOTE_HANDLER_PUSH_BODY_LIMIT) {
    throw receiverError(413, 'payload_too_large', 'Remote handler payload exceeds the 256 KiB inline limit')
  }
  if (!isRecord(body.budget) || !Number.isSafeInteger(body.budget.remaining)) {
    throw receiverError(422, 'start_rejected', 'Remote handler push budget must be an integer')
  }
  if ((body.budget.remaining as number) < MINIMUM_BUDGET_MS) {
    throw receiverError(422, 'budget_exhausted', 'Remote handler push requires at least 1000ms of remaining budget')
  }
  if ((body.budget.remaining as number) > MAXIMUM_BUDGET_MS) {
    throw receiverError(422, 'start_rejected', `Remote handler push budget must not exceed ${MAXIMUM_BUDGET_MS}ms`)
  }
  return {
    operationKey: body.operationKey,
    endpoint: body.endpoint,
    payload: structuredClone(body.payload),
    remaining: body.budget.remaining as number,
  }
}

function validateCancel (body: Record<string, unknown>): { operationKey: string, handlerRunId: string } {
  validateOperationKey(body.operationKey)
  validateHandlerRunId(body.handlerRunId)
  return { operationKey: body.operationKey, handlerRunId: body.handlerRunId }
}

function publicError (error: unknown): RemoteHandlerPushResponse {
  const candidate = isRecord(error) ? error : {}
  const candidateStatus = Number.isInteger(candidate.statusCode) ? candidate.statusCode as number : 500
  const statusCode = candidateStatus >= 400 && candidateStatus <= 599 ? candidateStatus : 500
  if (statusCode >= 500) {
    return {
      statusCode,
      body: { error: { code: 'remote_handler_unavailable', message: 'Remote handler push request failed' } },
    }
  }
  return {
    statusCode,
    body: {
      error: {
        code: typeof candidate.code === 'string' ? candidate.code : 'malformed_request',
        message: error instanceof Error ? error.message : 'Remote handler push request failed',
      },
    },
  }
}

function isNotFound (error: unknown): boolean {
  return isRecord(error) && (error.statusCode === 404 || error.name === 'WorkflowRunNotFoundError')
}

function normalizeStatus (status: RemoteHandlerPushStatus): RemoteHandlerPushStatus {
  if (!isRecord(status)) throw new Error('Remote handler runtime returned an invalid status')
  if (status.status === 'running') return { status: 'running' }
  if (status.status !== 'terminal' || !isRecord(status.outcome)) {
    throw new Error('Remote handler runtime returned an invalid status')
  }
  const outcome = status.outcome
  if (outcome.ok === true && Object.hasOwn(outcome, 'value')) {
    let json: string | undefined
    try {
      json = JSON.stringify({ ok: true, value: outcome.value })
    } catch {
      // Invalid or cyclic values are normalized to a bounded protocol failure.
    }
    if (json !== undefined && Buffer.byteLength(json, 'utf8') <= REMOTE_HANDLER_PUSH_BODY_LIMIT) {
      const normalized = JSON.parse(json) as RemoteHandlerPushOutcome
      if (Object.hasOwn(normalized, 'value')) return { status: 'terminal', outcome: normalized }
    }
    return {
      status: 'terminal',
      outcome: {
        ok: false,
        kind: 'failed',
        error: {
          code: 'schema_invalid_output',
          message: 'Remote handler result cannot be represented within the 256 KiB inline limit',
        },
      },
    }
  }
  if (outcome.ok === false && (outcome.kind === 'failed' || outcome.kind === 'cancelled') &&
      isRecord(outcome.error) && typeof outcome.error.code === 'string' && outcome.error.code.length > 0 &&
      typeof outcome.error.message === 'string' && outcome.error.message.length > 0) {
    return {
      status: 'terminal',
      outcome: {
        ok: false,
        kind: outcome.kind,
        error: {
          code: outcome.error.code.slice(0, 128),
          message: outcome.error.message.slice(0, 16 * 1024),
        },
      },
    }
  }
  throw new Error('Remote handler runtime returned an invalid status')
}

export function createRemoteHandlerPushReceiver (options: RemoteHandlerPushOptions): {
  identity: Readonly<RemoteHandlerPushIdentity>
  handle: (request: RemoteHandlerPushRequest) => Promise<RemoteHandlerPushResponse>
} {
  const identity = requireIdentity(options.identity)
  const handlers = requireManifest(options.manifest)
  const secret = requireSecret(options.secret)
  const { runtime, replayStore } = options
  const now = options.now ?? Date.now
  if (!runtime || typeof runtime.reserve !== 'function' || typeof runtime.start !== 'function' ||
      typeof runtime.status !== 'function') {
    throw new TypeError('Remote handler push runtime must provide reserve, start, and status')
  }
  if (!replayStore || typeof replayStore.claim !== 'function') {
    throw new TypeError('Remote handler push replayStore.claim is required')
  }
  if (typeof now !== 'function') throw new TypeError('Remote handler push clock must be a function')

  const dispatches = new Map<string, Promise<{ handlerRunId: string, duplicate: boolean }>>()

  async function authenticate (request: {
    method: string
    path: string
    headers: RemoteHandlerPushRequest['headers']
    body: Buffer
  }): Promise<void> {
    const timestamp = header(request.headers, 'x-pltf-timestamp')
    const nonce = header(request.headers, 'x-pltf-nonce')
    const signature = header(request.headers, 'x-pltf-signature')
    if (!/^(?:0|[1-9][0-9]*)$/.test(timestamp ?? '') || !NONCE_PATTERN.test(nonce ?? '')) {
      throw receiverError(401, 'authentication_failed', 'Remote handler push authentication failed')
    }
    const timestampSeconds = Number(timestamp)
    const currentSeconds = Math.floor(now() / 1000)
    if (!Number.isSafeInteger(timestampSeconds) ||
        Math.abs(currentSeconds - timestampSeconds) > REMOTE_HANDLER_PUSH_TIMESTAMP_WINDOW_SECONDS) {
      throw receiverError(401, 'authentication_failed', 'Remote handler push authentication failed')
    }
    const expected = createHmac('sha256', secret)
      .update(canonicalRequest({ timestamp: timestamp!, nonce: nonce!, ...request }))
      .digest('hex')
    if (!safeSignatureEqual(signature, expected)) {
      throw receiverError(401, 'authentication_failed', 'Remote handler push authentication failed')
    }
    let accepted: boolean
    try {
      accepted = await replayStore.claim(nonce!, REMOTE_HANDLER_PUSH_REPLAY_TTL_MS)
    } catch {
      throw receiverError(503, 'replay_store_unavailable', 'Remote handler replay protection is unavailable')
    }
    if (accepted !== true) throw receiverError(409, 'replay_detected', 'Remote handler push nonce was already used')
  }

  async function status (handlerRunId: string): Promise<RemoteHandlerPushStatus> {
    try {
      const value = await runtime.status(handlerRunId)
      if (value === null) throw receiverError(404, 'handler_run_unknown', 'Remote handler run was not found')
      return normalizeStatus(value)
    } catch (error) {
      if (isNotFound(error)) throw receiverError(404, 'handler_run_unknown', 'Remote handler run was not found')
      throw error
    }
  }

  async function startDispatch (operation: ReturnType<typeof validateDispatch>, deadlineAt: number): Promise<{
    handlerRunId: string
    duplicate: boolean
  }> {
    const workflowId = handlers.get(operation.endpoint)
    if (!workflowId) {
      throw receiverError(422, 'endpoint_withdrawn', `Remote endpoint ${JSON.stringify(operation.endpoint)} is no longer exported`)
    }
    const reservation = await runtime.reserve({
      operationKey: operation.operationKey,
      budget: { remaining: operation.remaining },
    })
    const handlerRunId = reservation?.handlerRunId
    if (typeof handlerRunId !== 'string' || !RUN_ID_PATTERN.test(handlerRunId)) {
      throw new Error('Remote handler runtime returned an invalid run reservation')
    }
    let duplicate = reservation.duplicate === true
    if (!duplicate) {
      try {
        duplicate = await runtime.status(handlerRunId) !== null
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    }
    if (!duplicate) {
      const started = await runtime.start({
        workflowId,
        operationKey: operation.operationKey,
        handlerRunId,
        deadlineAt,
        payload: operation.payload,
      })
      if (started?.runId !== undefined && started.runId !== handlerRunId) {
        throw new Error('Remote handler runtime started a different run ID')
      }
    }
    return { handlerRunId, duplicate }
  }

  async function dispatch (body: Record<string, unknown>): Promise<RemoteHandlerPushResponse> {
    const operation = validateDispatch(body)
    const deadlineAt = now() + operation.remaining
    let pending = dispatches.get(operation.operationKey)
    const duplicateInProcess = pending !== undefined
    if (!pending) {
      pending = startDispatch(operation, deadlineAt).finally(() => dispatches.delete(operation.operationKey))
      dispatches.set(operation.operationKey, pending)
    }
    try {
      const result = await pending
      return {
        statusCode: duplicateInProcess || result.duplicate ? 409 : 200,
        body: { handlerRunId: result.handlerRunId },
      }
    } catch (error) {
      if (isRecord(error) && ['start_rejected', 'admission_rejected', 'budget_exhausted'].includes(String(error.code))) {
        throw receiverError(422, 'start_rejected', 'Remote handler workflow could not be started')
      }
      if (isRecord(error) && Number.isInteger(error.statusCode)) throw error
      throw error
    }
  }

  async function route (method: string, path: string, body: Buffer): Promise<RemoteHandlerPushResponse> {
    if (method === 'POST' && path === '/remote/v1/dispatch') return dispatch(parseJsonBody(body))
    if (method === 'POST' && path === '/remote/v1/cancel') {
      if (typeof runtime.cancel !== 'function') return { statusCode: 501, body: { cancelled: false } }
      const result = await runtime.cancel(validateCancel(parseJsonBody(body)))
      if (!isRecord(result) || typeof result.cancelled !== 'boolean') {
        throw new Error('Remote handler runtime returned an invalid cancellation result')
      }
      return { statusCode: 200, body: { cancelled: result.cancelled } }
    }
    if (method === 'GET' && path.startsWith('/remote/v1/operations/')) {
      if (body.length !== 0) throw receiverError(400, 'malformed_request', 'Remote handler status requests must not contain a body')
      const encoded = path.slice('/remote/v1/operations/'.length)
      let handlerRunId: string
      try { handlerRunId = decodeURIComponent(encoded) } catch {
        throw receiverError(400, 'malformed_request', 'Remote handler run path is malformed')
      }
      if (handlerRunId.includes('/')) throw receiverError(400, 'malformed_request', 'Remote handler run path is malformed')
      validateHandlerRunId(handlerRunId)
      return { statusCode: 200, body: await status(handlerRunId) }
    }
    return { statusCode: 404, body: { error: { code: 'not_found', message: 'Remote handler push route was not found' } } }
  }

  async function handle (request: RemoteHandlerPushRequest): Promise<RemoteHandlerPushResponse> {
    try {
      if (typeof request?.method !== 'string' || request.method.length === 0) {
        throw receiverError(400, 'malformed_request', 'Remote handler push method is required')
      }
      const body = rawBody(request.body)
      if (body.length > REMOTE_HANDLER_PUSH_BODY_LIMIT) {
        throw receiverError(413, 'payload_too_large', 'Remote handler push body exceeds the 256 KiB limit')
      }
      const path = pathname(request.path)
      const method = request.method.toUpperCase()
      await authenticate({ method, path, headers: request.headers, body })
      return await route(method, path, body)
    } catch (error) {
      return publicError(error)
    }
  }

  return Object.freeze({ identity, handle })
}

export function createValkeyRemoteHandlerPushReplayStore ({
  client,
  prefix = 'remote-handler-push:nonce:',
}: {
  client: { set: (...args: [string, string, 'PX', number, 'NX']) => Promise<unknown> }
  prefix?: string
}): RemoteHandlerPushReplayStore {
  if (!client || typeof client.set !== 'function') {
    throw new TypeError('Remote handler replay Valkey client must provide set')
  }
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('Remote handler replay Valkey prefix must be a non-empty string')
  }
  return Object.freeze({
    async claim (nonce: string, ttlMs: number) {
      return await client.set(`${prefix}${nonce}`, '1', 'PX', ttlMs, 'NX') === 'OK'
    },
  })
}

function fastifyRequest (request: FastifyRequest): RemoteHandlerPushRequest {
  return {
    method: request.method,
    path: request.raw.url ?? request.url,
    headers: request.headers,
    body: request.body as Buffer | undefined,
  }
}

export async function mountRemoteHandlerPushRoutes (
  app: FastifyInstance,
  options: RemoteHandlerPushOptions
): Promise<void> {
  const receiver = createRemoteHandlerPushReceiver(options)
  await app.register(async (routes) => {
    routes.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
    routes.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
    const route = (method: 'GET' | 'POST', url: string): void => {
      routes.route({
        method,
        url,
        bodyLimit: REMOTE_HANDLER_PUSH_BODY_LIMIT,
        async handler (request, reply) {
          const response = await receiver.handle(fastifyRequest(request))
          return reply.code(response.statusCode).send(response.body)
        },
      })
    }
    route('POST', '/remote/v1/dispatch')
    route('GET', '/remote/v1/operations/:handlerRunId')
    route('POST', '/remote/v1/cancel')
  })
}
