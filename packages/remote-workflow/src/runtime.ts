import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ActiveRemoteHandlerRun } from '@platformatic/world'
import type { ClaimedOperation, RemoteOutcome, WireEnvelope } from './wire.ts'

export const REMOTE_HANDLER_CLAIM_BATCH_MAX = 16
export const REMOTE_HANDLER_INLINE_MAX_BYTES = 256 * 1024
export const REMOTE_HANDLER_MANIFEST_MAX_BYTES = 1024 * 1024
export const REMOTE_HANDLER_OPERATION_KEY_MAX_BYTES = 1024

export interface RemoteHandlerManifest {
  v: 1
  manifestHash: string
  handlers: Record<string, { workflowId: string }>
}

export interface RemoteHandlerIdentity {
  tenant: string
  service: string
  versionLabel: string
  manifestHash: string
}

export interface RemoteHandlerCommandReply<T = unknown> {
  success: boolean
  result?: T
  error?: { name?: string, code?: string, message?: string }
}

/**
 * The small request surface implemented by the host runtime's authenticated
 * ICC command transport. The host owns connection setup and request
 * correlation; this package owns only the remote-handler protocol.
 */
export interface RemoteHandlerCommandClient {
  request<T = unknown> (envelope: Omit<WireEnvelope<string, Record<string, unknown>>, 'v'> & { v: 1 | 2 }): Promise<RemoteHandlerCommandReply<T>>
}

export interface RemoteHandlerTransport {
  announceHandler (): Promise<void>
  claim (capacity: number): Promise<ClaimedOperation[]>
  heartbeat (tokens: string[]): Promise<void>
  reportStarted (input: { token: string, handlerRunId: string }): Promise<void>
  reportResult (input: { token: string, outcome: RemoteOutcome<unknown> }): Promise<void>
  reconcileHandlerRuns? (runs: Array<{ operationKey: string, handlerRunId: string }>): Promise<Array<{ operationKey: string, action: 'keep' | 'cancel' | 'unknown' }>>
  close? (): Promise<void>
}

export interface RemoteHandlerRun {
  returnValue?: unknown
  cancel: (options: { cancelReason: string }) => Promise<unknown>
}

export interface RemoteHandlerAdapter {
  reserve: (input: { operationKey: string, remaining: number }) => Promise<{ handlerRunId: string }>
  start: (input: {
    workflowId: string
    operationKey: string
    handlerRunId: string
    deadlineAt: number
    payload: unknown
  }) => Promise<RemoteHandlerRun>
  result: (run: RemoteHandlerRun) => Promise<unknown>
  cancel?: (run: RemoteHandlerRun) => Promise<unknown>
  listActive?: (options?: { cursor?: string, limit?: number }) => Promise<{
    data: ActiveRemoteHandlerRun[]
    cursor: string | null
    hasMore: boolean
  }>
  cancelActive?: (run: ActiveRemoteHandlerRun) => Promise<unknown>
  close?: () => Promise<void>
}

export interface RemoteHandlerWorkerOptions {
  identity: RemoteHandlerIdentity
  manifest: RemoteHandlerManifest
  transport: RemoteHandlerTransport
  adapter: RemoteHandlerAdapter
  capacity?: number
  claimBatchMax?: number
  heartbeatIntervalMs?: number
  workerId?: string
  now?: () => number
  wait?: (delay: number) => Promise<void>
  log?: Pick<Console, 'error' | 'warn'>
}

export interface RemoteHandlerWorker {
  start: () => Promise<void>
  close: () => Promise<void>
}

const noopWorker: RemoteHandlerWorker = Object.freeze({
  async start () {},
  async close () {},
})

function sleep (delay: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delay))
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage (error: unknown): string {
  const message = isRecord(error) && typeof error.message === 'string' ? error.message : undefined
  return (message && message.length > 0 ? message : 'Remote handler workflow failed').slice(0, 16 * 1024)
}

function errorCode (error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code.slice(0, 128) : 'workflow_failed'
}

function isCancelled (error: unknown): boolean {
  return isRecord(error) && (error.name === 'WorkflowRunCancelledError' || error.code === 'workflow_run_cancelled')
}

function failedOutcome (code: string, message: string, kind: 'failed' | 'cancelled' = 'failed'): RemoteOutcome<unknown> {
  return { ok: false, kind, error: { code, message } }
}

function normalizeOutcome (value: unknown): RemoteOutcome<unknown> {
  try {
    const serialized = JSON.stringify({ ok: true, value })
    if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= REMOTE_HANDLER_INLINE_MAX_BYTES) {
      const parsed = JSON.parse(serialized) as { ok: true, value: unknown }
      if (Object.hasOwn(parsed, 'value')) return parsed
    }
  } catch {}
  return failedOutcome('admission_rejected', 'Remote handler result exceeds the 256 KiB inline limit')
}

function workflowFailure (error: unknown): RemoteOutcome<unknown> {
  return failedOutcome(isCancelled(error) ? 'cancelled' : errorCode(error), errorMessage(error), isCancelled(error) ? 'cancelled' : 'failed')
}

function validateManifest (value: unknown): RemoteHandlerManifest {
  if (!isRecord(value) || value.v !== 1 || typeof value.manifestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.manifestHash) || !isRecord(value.handlers) ||
      Object.keys(value).sort().join(',') !== 'handlers,manifestHash,v') {
    throw new TypeError('Remote handler manifest is invalid')
  }

  const handlers: Record<string, { workflowId: string }> = {}
  for (const endpoint of Object.keys(value.handlers).sort()) {
    const handler = value.handlers[endpoint]
    if (endpoint.length === 0 || endpoint.length > REMOTE_HANDLER_OPERATION_KEY_MAX_BYTES ||
        !isRecord(handler) || Object.keys(handler).join(',') !== 'workflowId' ||
        typeof handler.workflowId !== 'string' || handler.workflowId.length === 0 || handler.workflowId.length > 4096) {
      throw new TypeError(`Remote handler ${JSON.stringify(endpoint)} is invalid`)
    }
    handlers[endpoint] = Object.freeze({ workflowId: handler.workflowId })
  }
  return Object.freeze({ v: 1, manifestHash: value.manifestHash, handlers: Object.freeze(handlers) })
}

function validateClaimedOperation (value: unknown): asserts value is ClaimedOperation {
  if (!isRecord(value) || typeof value.operationKey !== 'string' || value.operationKey.length === 0 ||
      Buffer.byteLength(value.operationKey, 'utf8') > REMOTE_HANDLER_OPERATION_KEY_MAX_BYTES ||
      typeof value.endpoint !== 'string' || value.endpoint.length === 0 || value.endpoint.length > REMOTE_HANDLER_OPERATION_KEY_MAX_BYTES ||
      typeof value.token !== 'string' || value.token.length === 0 || value.token.length > 128 ||
      !isRecord(value.budget) || typeof value.budget.remaining !== 'number' ||
      !Number.isSafeInteger(value.budget.remaining) || value.budget.remaining < 0) {
    throw protocolError('ICC returned an invalid remote handler operation')
  }
  const hasPayload = Object.hasOwn(value, 'payload')
  const hasPayloadRef = Object.hasOwn(value, 'payloadRef')
  if (hasPayload === hasPayloadRef) throw protocolError('ICC returned a remote operation without exactly one payload form')
}

export async function readRemoteHandlerManifest (path: string): Promise<RemoteHandlerManifest> {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('Remote handler manifest path is required')
  const contents = await readFile(path, 'utf8')
  if (Buffer.byteLength(contents, 'utf8') > REMOTE_HANDLER_MANIFEST_MAX_BYTES) {
    throw new RangeError('Remote handler manifest exceeds the 1 MiB limit')
  }
  let value: unknown
  try { value = JSON.parse(contents) } catch (error) {
    throw new TypeError('Remote handler manifest is not valid JSON', { cause: error })
  }
  return validateManifest(value)
}

function protocolError (message: string, code = 'remote_handler_protocol_error'): Error {
  return Object.assign(new Error(message), { code })
}

function responseBody<T> (type: string, tenant: string, response: RemoteHandlerCommandReply<unknown>): T {
  if (!response || response.success !== true) {
    const message = response?.error?.message ?? `ICC remote ${type} request failed`
    throw protocolError(message, response?.error?.code ?? 'remote_handler_request_failed')
  }
  const envelope = response.result
  if (!isRecord(envelope) || (envelope.v !== 1 && !(type === 'reconcile_handler_runs' && envelope.v === 2)) ||
      envelope.type !== type || envelope.tenant !== tenant || !isRecord(envelope.body)) {
    throw protocolError(`ICC returned an invalid ${type} response`)
  }
  return envelope.body as T
}

/** Adapt a host-provided correlated ICC command client to the handler API. */
export function createRemoteHandlerTransport (options: {
  tenant: string
  identity: Omit<RemoteHandlerIdentity, 'tenant'>
  client: RemoteHandlerCommandClient
  reconciliation?: boolean
}): RemoteHandlerTransport {
  if (!isRecord(options) || typeof options.tenant !== 'string' || options.tenant.length === 0 ||
      !isRecord(options.identity) || !options.client || typeof options.client.request !== 'function') {
    throw new TypeError('Remote handler transport requires a tenant, identity, and command client')
  }

  const request = async <T> (type: string, body: Record<string, unknown>, version: 1 | 2 = 1): Promise<T> => {
    const response = await options.client.request({ v: version, type, tenant: options.tenant, body })
    return responseBody<T>(type, options.tenant, response)
  }

  const transport: RemoteHandlerTransport = {
    async announceHandler () {
      await request('announce_handler', {
        service: options.identity.service,
        versionLabel: options.identity.versionLabel,
        manifestHash: options.identity.manifestHash,
      })
    },
    async claim (capacity) {
      const body = await request<{ operations?: unknown[] }>('claim', {
        service: options.identity.service,
        versionLabel: options.identity.versionLabel,
        capacity,
      })
      if (!Array.isArray(body.operations)) throw protocolError('ICC returned an invalid remote claim page')
      for (const operation of body.operations) validateClaimedOperation(operation)
      return body.operations as ClaimedOperation[]
    },
    async heartbeat (tokens) {
      await request('heartbeat', { tokens })
    },
    async reportStarted (input) {
      await request('report_started', input)
    },
    async reportResult (input) {
      await request('report_result', input)
    },
  }
  if (options.reconciliation === true) {
    transport.reconcileHandlerRuns = async runs => {
      const body = await request<{ runs?: unknown[] }>('reconcile_handler_runs', { runs }, 2)
      if (!Array.isArray(body.runs)) throw protocolError('ICC returned an invalid remote handler reconciliation response')
      return body.runs as Array<{ operationKey: string, action: 'keep' | 'cancel' | 'unknown' }>
    }
  }
  return transport
}

export function createRemoteHandlerWorker (options: RemoteHandlerWorkerOptions): RemoteHandlerWorker {
  if (!options || !isRecord(options.manifest) || !options.transport || !options.adapter) {
    throw new TypeError('Remote handler worker requires a manifest, transport, and adapter')
  }
  const manifest = validateManifest(options.manifest)
  if (options.identity.manifestHash !== manifest.manifestHash) {
    throw new TypeError('Remote handler identity manifest hash does not match the private manifest')
  }
  const capacity = options.capacity ?? REMOTE_HANDLER_CLAIM_BATCH_MAX
  const claimBatchMax = Math.min(options.claimBatchMax ?? REMOTE_HANDLER_CLAIM_BATCH_MAX, REMOTE_HANDLER_CLAIM_BATCH_MAX)
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000
  if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(claimBatchMax) || claimBatchMax < 1) {
    throw new RangeError('Remote handler worker capacity must be a positive integer')
  }
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 0) {
    throw new RangeError('Remote handler heartbeat interval must be a non-negative integer')
  }

  const workerId = options.workerId ?? randomUUID()
  const now = options.now ?? Date.now
  const wait = options.wait ?? sleep
  const log = options.log ?? console
  const active = new Set<Promise<void>>()
  let running = true
  let startPromise: Promise<void> | undefined
  let loopPromise: Promise<void> | undefined

  async function requestUntilDeadline<T> (deadlineAt: number, action: () => Promise<T>): Promise<T> {
    let lastError: unknown
    while (true) {
      if (!running || now() >= deadlineAt) break
      try {
        return await action()
      } catch (error) {
        lastError = error
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
        if (code === 'admission_rejected' || code === 'budget_exhausted' || code === 'remote_handler_claim_stale') throw error
        await wait(Math.min(250, Math.max(1, deadlineAt - now())))
      }
    }
    throw lastError ?? new Error('Remote handler operation deadline expired')
  }

  async function report (operation: ClaimedOperation, deadlineAt: number, outcome: RemoteOutcome<unknown>): Promise<void> {
    try {
      await requestUntilDeadline(deadlineAt, () => options.transport.reportResult({ token: operation.token, outcome }))
    } catch (error) {
      log.warn?.({ err: error, operationKey: operation.operationKey }, 'Failed to report remote handler result')
    }
  }

  async function reconcile (): Promise<void> {
    if (!options.adapter.listActive || !options.transport.reconcileHandlerRuns) return
    let cursor: string | undefined
    do {
      const page = await options.adapter.listActive({ cursor, limit: REMOTE_HANDLER_CLAIM_BATCH_MAX })
      if (!page || !Array.isArray(page.data) || page.data.length > REMOTE_HANDLER_CLAIM_BATCH_MAX) {
        throw new Error('World returned an invalid active remote handler runs page')
      }
      if (page.data.length > 0) {
        const actions = await options.transport.reconcileHandlerRuns(page.data.map(run => ({
          operationKey: run.operationKey,
          handlerRunId: run.handlerRunId,
        })))
        for (const action of actions) {
          if (action.action === 'cancel') {
            const run = page.data.find(candidate => candidate.operationKey === action.operationKey)
            if (run) await options.adapter.cancelActive?.(run)
          }
        }
      }
      cursor = page.hasMore ? page.cursor ?? undefined : undefined
      if (!running) break
    } while (cursor !== undefined)
  }

  async function execute (operation: ClaimedOperation): Promise<void> {
    const deadlineAt = now() + operation.budget.remaining
    const handler = manifest.handlers[operation.endpoint]
    if (!handler) {
      await report(operation, deadlineAt, failedOutcome('endpoint_withdrawn', `Remote endpoint ${JSON.stringify(operation.endpoint)} is no longer exported`))
      return
    }
    if (!Object.hasOwn(operation, 'payload')) {
      await report(operation, deadlineAt, failedOutcome('start_rejected', 'Remote payload references are not supported by this handler'))
      return
    }
    if (deadlineAt <= now()) {
      await report(operation, deadlineAt, failedOutcome('budget_exhausted', 'Remote handler budget was exhausted before start'))
      return
    }

    let run: RemoteHandlerRun | undefined
    let handlerRunId: string
    let heartbeat: NodeJS.Timeout | undefined
    try {
      if (heartbeatIntervalMs > 0) {
        heartbeat = setInterval(() => {
          options.transport.heartbeat([operation.token]).catch(error => {
            log.warn?.({ err: error, operationKey: operation.operationKey }, 'Failed to heartbeat remote handler claim')
          })
        }, heartbeatIntervalMs)
        heartbeat.unref()
      }
      const reservation = await options.adapter.reserve({
        operationKey: operation.operationKey,
        remaining: Math.floor(deadlineAt - now()),
      })
      handlerRunId = reservation.handlerRunId
      if (typeof handlerRunId !== 'string' || handlerRunId.length === 0) throw new Error('World returned an invalid remote handler run reservation')
      run = await options.adapter.start({
        workflowId: handler.workflowId,
        operationKey: operation.operationKey,
        handlerRunId,
        deadlineAt,
        payload: operation.payload,
      })
      await requestUntilDeadline(deadlineAt, () => options.transport.reportStarted({ token: operation.token, handlerRunId }))
    } catch (error) {
      if (run) {
        try { await options.adapter.cancel?.(run) } catch (cancelError) {
          log.warn?.({ err: cancelError, operationKey: operation.operationKey }, 'Failed to cancel an unacknowledged remote handler run')
        }
      }
      await report(operation, deadlineAt, failedOutcome('start_rejected', errorMessage(error)))
      return
    } finally {
      if (heartbeat) clearInterval(heartbeat)
    }

    try {
      await report(operation, deadlineAt, normalizeOutcome(await options.adapter.result(run)))
    } catch (error) {
      await report(operation, deadlineAt, workflowFailure(error))
    }
  }

  async function claimAndLaunch (): Promise<boolean> {
    const available = capacity - active.size
    if (available <= 0) {
      if (active.size > 0) await Promise.race(active)
      return false
    }
    const operations = await options.transport.claim(Math.min(available, claimBatchMax))
    if (!Array.isArray(operations)) throw new Error('ICC returned an invalid remote claim page')
    if (operations.length > Math.min(available, claimBatchMax)) throw new Error('ICC returned more remote operations than requested')
    for (const operation of operations) {
      const task = execute(operation).catch(error => {
        log.error?.({ err: error, operationKey: operation?.operationKey, workerId }, 'Remote handler execution failed')
      }).finally(() => active.delete(task))
      active.add(task)
    }
    return operations.length === 0
  }

  async function loop (): Promise<void> {
    while (true) {
      if (!running) break
      try {
        if (await claimAndLaunch()) await wait(250)
      } catch (error) {
        if (!running) break
        log.warn?.({ err: error, workerId }, 'Remote handler claim loop failed')
        await wait(250)
      }
    }
  }

  async function start (): Promise<void> {
    if (!startPromise) {
      startPromise = (async () => {
        await options.transport.announceHandler()
        await reconcile()
        if (running && !loopPromise) loopPromise = loop()
      })()
    }
    await startPromise
  }

  async function close (): Promise<void> {
    if (!running) return
    running = false
    await options.transport.close?.()
    await options.adapter.close?.()
  }

  return { start, close }
}

export async function registerRemoteHandlerRuntime (options: {
  identity?: RemoteHandlerIdentity
  manifest?: RemoteHandlerManifest
  transport?: RemoteHandlerTransport
  adapter?: RemoteHandlerAdapter
  applicationRoot?: string
  capacity?: number
  heartbeatIntervalMs?: number
  log?: Pick<Console, 'error' | 'warn'>
}): Promise<RemoteHandlerWorker> {
  if (!options?.identity || !options.manifest || !options.transport) return noopWorker
  const adapter = options.adapter ?? (options.applicationRoot ? await createDefaultRemoteHandlerAdapter(options.applicationRoot) : undefined)
  if (!adapter) throw new TypeError('A remote handler adapter or applicationRoot is required')
  const worker = createRemoteHandlerWorker({ ...options, identity: options.identity, manifest: options.manifest, transport: options.transport, adapter })
  await worker.start()
  return worker
}

async function importFromApplication (applicationRoot: string, specifier: string): Promise<any> {
  const require = createRequire(resolve(applicationRoot, 'package.json'))
  return import(pathToFileURL(require.resolve(specifier)).href)
}

export async function createDefaultRemoteHandlerAdapter (applicationRoot: string): Promise<RemoteHandlerAdapter> {
  const [workflowModule, worldModule] = await Promise.all([
    importFromApplication(applicationRoot, 'workflow/api'),
    importFromApplication(applicationRoot, '@platformatic/world'),
  ])
  if (typeof workflowModule.start !== 'function' || typeof worldModule.createWorld !== 'function' ||
      typeof worldModule.createRemoteHandlerStartOptions !== 'function') {
    throw new Error('Installed Workflow SDK and @platformatic/world do not expose remote handler start support')
  }
  const world = worldModule.createWorld()
  return {
    reserve: input => world.remoteHandlerRuns.reserve({ operationKey: input.operationKey, budget: { remaining: input.remaining } }),
    async start (input) {
      const prepared = worldModule.createRemoteHandlerStartOptions(world, input)
      const run = await workflowModule.start({ workflowId: input.workflowId }, [input.payload], {
        world: prepared.world,
        attributes: prepared.attributes,
        allowReservedAttributes: prepared.allowReservedAttributes,
      })
      if (run?.runId !== input.handlerRunId) throw new Error('Workflow SDK started a different remote handler run ID')
      return run
    },
    result: async run => run.returnValue,
    cancel: run => run.cancel({ cancelReason: 'Remote operation was no longer claimable' }),
    async listActive (options) {
      return world.remoteHandlerRuns.listActive(options)
    },
    cancelActive: run => world.remoteHandlerRuns.cancel({ operationKey: run.operationKey, handlerRunId: run.handlerRunId }),
    close: () => world.close(),
  }
}

export { validateManifest as validateRemoteHandlerManifest }
