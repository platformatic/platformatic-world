import type { World } from '@workflow/world'
import type { HttpClient } from './client.ts'

export const REMOTE_HANDLER_DEADLINE_ATTRIBUTE = '$platformatic.remote.deadline'

const RUN_ID_PATTERN = /^wrun_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i
const WORKFLOW_QUEUE_PATTERN = /^__(?:[a-z][a-z0-9]*_)?wkf_workflow_.+$/
const MAXIMUM_OPERATION_KEY_BYTES = 1024
const MINIMUM_BUDGET_MS = 1_000
const MAXIMUM_BUDGET_MS = 2_147_483_647
const DEFAULT_ACTIVE_PAGE_LIMIT = 16
const MAXIMUM_ACTIVE_PAGE_LIMIT = 16

export interface ReserveRemoteHandlerRun {
  operationKey: string
  budget: { remaining: number }
}

export interface RemoteHandlerRunReservation {
  handlerRunId: string
}

export interface ActiveRemoteHandlerRun {
  operationKey: string
  handlerRunId: string
  deadlineAt: number
}

export interface ActiveRemoteHandlerRunsPage {
  data: ActiveRemoteHandlerRun[]
  cursor: string | null
  hasMore: boolean
}

export interface ListActiveRemoteHandlerRunsOptions {
  cursor?: string
  limit?: number
}

export interface CancelRemoteHandlerRun {
  operationKey: string
  handlerRunId: string
}

export interface CancelRemoteHandlerRunResult {
  cancelled: boolean
}

export interface RemoteHandlerRuns {
  reserve: (reservation: ReserveRemoteHandlerRun) => Promise<RemoteHandlerRunReservation>
  listActive: (options?: ListActiveRemoteHandlerRunsOptions) => Promise<ActiveRemoteHandlerRunsPage>
  cancel: (run: CancelRemoteHandlerRun) => Promise<CancelRemoteHandlerRunResult>
}

export interface RemoteHandlerStartOptions {
  operationKey: string
  handlerRunId: string
  deadlineAt: number
  attributes?: Record<string, string>
}

export interface PreparedRemoteHandlerStart {
  world: World
  attributes: Record<string, string>
  allowReservedAttributes: true
}

function validateOperationKey (operationKey: unknown): asserts operationKey is string {
  if (typeof operationKey !== 'string' || operationKey.length === 0) {
    throw new TypeError('remote handler operationKey must be a non-empty string')
  }
  if (Buffer.byteLength(operationKey, 'utf8') > MAXIMUM_OPERATION_KEY_BYTES) {
    throw new RangeError(`remote handler operationKey must not exceed ${MAXIMUM_OPERATION_KEY_BYTES} UTF-8 bytes`)
  }
}

function validateReservation (reservation: ReserveRemoteHandlerRun): void {
  if (!reservation || typeof reservation !== 'object') {
    throw new TypeError('remote handler reservation must be an object')
  }
  validateOperationKey(reservation.operationKey)
  if (!reservation.budget || !Number.isSafeInteger(reservation.budget.remaining) ||
      reservation.budget.remaining < MINIMUM_BUDGET_MS || reservation.budget.remaining > MAXIMUM_BUDGET_MS) {
    throw new RangeError(
      `remote handler budget.remaining must be between ${MINIMUM_BUDGET_MS} and ${MAXIMUM_BUDGET_MS} milliseconds`
    )
  }
}

function validateHandlerRunId (handlerRunId: unknown): asserts handlerRunId is string {
  if (typeof handlerRunId !== 'string' || !RUN_ID_PATTERN.test(handlerRunId)) {
    throw new TypeError('remote handler handlerRunId must be a wrun_ prefixed ULID')
  }
}

function validateListOptions (options: ListActiveRemoteHandlerRunsOptions): number {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('remote handler active run options must be an object')
  }
  if (options.cursor !== undefined) validateOperationKey(options.cursor)
  const limit = options.limit ?? DEFAULT_ACTIVE_PAGE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_ACTIVE_PAGE_LIMIT) {
    throw new RangeError(`remote handler active run limit must be between 1 and ${MAXIMUM_ACTIVE_PAGE_LIMIT}`)
  }
  return limit
}

function normalizeActivePage (value: any, limit: number): ActiveRemoteHandlerRunsPage {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.data) || value.data.length > limit ||
      typeof value.hasMore !== 'boolean' ||
      (value.cursor !== null && typeof value.cursor !== 'string') ||
      (value.hasMore && (!value.cursor || value.data.length === 0))) {
    throw new Error('Workflow service returned an invalid active remote handler runs page')
  }
  const data = value.data.map((run: any) => {
    if (!run || typeof run !== 'object' || Array.isArray(run)) {
      throw new Error('Workflow service returned an invalid active remote handler run')
    }
    validateOperationKey(run.operationKey)
    validateHandlerRunId(run.handlerRunId)
    if (!Number.isSafeInteger(run.deadlineAt) || run.deadlineAt <= 0) {
      throw new Error('Workflow service returned an invalid remote handler run deadline')
    }
    return {
      operationKey: run.operationKey,
      handlerRunId: run.handlerRunId,
      deadlineAt: run.deadlineAt,
    }
  })
  if (value.cursor !== null) validateOperationKey(value.cursor)
  if (value.hasMore && value.cursor !== data[data.length - 1].operationKey) {
    throw new Error('Workflow service returned a non-advancing active remote handler runs cursor')
  }
  return { data, cursor: value.cursor, hasMore: value.hasMore }
}

export function createRemoteHandlerRuns (client: HttpClient): RemoteHandlerRuns {
  return {
    async reserve (reservation) {
      validateReservation(reservation)
      const result = await client.post('/remote-handler-runs/reserve', reservation)
      if (!result || typeof result !== 'object' || !RUN_ID_PATTERN.test(result.handlerRunId)) {
        const error: any = new Error('Workflow service returned an invalid remote handler run reservation')
        error.code = 'remote_handler_reservation_invalid'
        throw error
      }
      return { handlerRunId: result.handlerRunId }
    },
    async listActive (options = {}) {
      const limit = validateListOptions(options)
      const result = await client.get('/remote-handler-runs/active', {
        cursor: options.cursor,
        limit: String(limit),
      })
      return normalizeActivePage(result, limit)
    },
    async cancel (run) {
      if (!run || typeof run !== 'object') throw new TypeError('remote handler cancellation must be an object')
      validateOperationKey(run.operationKey)
      validateHandlerRunId(run.handlerRunId)
      const result = await client.post('/remote-handler-runs/cancel', run)
      if (!result || typeof result !== 'object' || typeof result.cancelled !== 'boolean') {
        throw new Error('Workflow service returned an invalid remote handler cancellation result')
      }
      return { cancelled: result.cancelled }
    },
  }
}

export function createRemoteHandlerStartOptions (
  world: World,
  options: RemoteHandlerStartOptions
): PreparedRemoteHandlerStart {
  if (!world || typeof world !== 'object') throw new TypeError('remote handler World is required')
  validateOperationKey(options?.operationKey)
  validateHandlerRunId(options?.handlerRunId)
  if (!Number.isSafeInteger(options?.deadlineAt) || options.deadlineAt <= 0 ||
      !Number.isFinite(new Date(options.deadlineAt).getTime())) {
    throw new RangeError('remote handler deadlineAt must be a positive Unix millisecond timestamp')
  }
  for (const key of Object.keys(options.attributes ?? {})) {
    if (key.startsWith('$')) {
      throw new TypeError(`remote handler attribute ${JSON.stringify(key)} uses reserved prefix "$"`)
    }
  }

  const bareRunId = options.handlerRunId.slice('wrun_'.length)
  const idempotencyKey = `remote-handler:${options.operationKey}`
  const incompatibleRuntime = (): Error => {
    const error: any = new Error(
      'remote handler starts require Workflow SDK v5 with World.createRunId support'
    )
    error.code = 'remote_handler_runtime_unsupported'
    return error
  }
  const wrappedWorld = {
    ...world,
    events: {
      ...world.events,
      create: (runId: any, event: any, eventOptions?: any) => {
        if (event?.eventType === 'run_created' && runId !== options.handlerRunId) {
          throw incompatibleRuntime()
        }
        return world.events.create(runId, event, eventOptions)
      },
    },
    // v5 passes its start options when minting the workflow run id. Its
    // cross-deployment health check asks for an unrelated correlation id with
    // no arguments, which must remain delegated to the underlying World.
    createRunId: (startOptions?: Readonly<Record<string, unknown>>) => startOptions === undefined
      ? (world as any).createRunId?.()
      : bareRunId,
    queue: (queueName: any, message: any, queueOptions?: any) => {
      const isHealthCheck = message?.__healthCheck === true
      const isWorkflowStart = typeof queueName === 'string' &&
        WORKFLOW_QUEUE_PATTERN.test(queueName) && !isHealthCheck

      if (!isWorkflowStart) return world.queue(queueName, message, queueOptions)
      if (message?.runId !== options.handlerRunId) throw incompatibleRuntime()

      return world.queue(queueName, message, { ...queueOptions, idempotencyKey })
    },
  } as World

  return {
    world: wrappedWorld,
    attributes: {
      ...options.attributes,
      [REMOTE_HANDLER_DEADLINE_ATTRIBUTE]: String(options.deadlineAt),
    },
    allowReservedAttributes: true,
  }
}
