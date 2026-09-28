import type { RemoteErrorCode, RemoteOutcome } from './wire.js'

export interface RemoteErrorOptions {
  operationKey?: string
  handlerRunId?: string
  code?: string
  cause?: unknown
}

export class RemoteError extends Error {
  operationKey?: string
  handlerRunId?: string
  code?: string

  constructor (message: string, options: RemoteErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.operationKey = options.operationKey
    this.handlerRunId = options.handlerRunId
    this.code = options.code
  }
}

export class RemoteNotClaimedError extends RemoteError {}
export class RemoteFailedError extends RemoteError {}
export class RemoteTimedOutError extends RemoteError {}
export class RemoteCancelledError extends RemoteError {}
export class RemoteUnavailableError extends RemoteError {}

export function errorForCode (
  code: RemoteErrorCode | string,
  message: string,
  options: Omit<RemoteErrorOptions, 'code'> = {}
): RemoteError {
  const errorOptions = { ...options, code }
  switch (code) {
    case 'budget_exhausted':
      return new RemoteTimedOutError(message, errorOptions)
    case 'dead_letter':
    case 'schema_invalid_input':
    case 'schema_invalid_output':
      return new RemoteFailedError(message, errorOptions)
    case 'endpoint_unknown':
    case 'endpoint_withdrawn':
    case 'admission_rejected':
    case 'manifest_conflict':
    case 'start_rejected':
    default:
      return new RemoteUnavailableError(message, errorOptions)
  }
}

export function errorForOutcome<T> (
  operationKey: string,
  outcome: Exclude<RemoteOutcome<T>, { ok: true }>
): RemoteError {
  const code = outcome.error?.code || outcome.detail?.code
  const message = outcome.error?.message ||
    outcome.detail?.message ||
    `Remote operation ${operationKey} ${outcome.kind}`
  const options = { operationKey, handlerRunId: outcome.handlerRunId, code }
  if (code === 'budget_exhausted') return new RemoteTimedOutError(message, options)
  switch (outcome.kind) {
    case 'not_claimed': return new RemoteNotClaimedError(message, options)
    case 'cancelled': return new RemoteCancelledError(message, options)
    case 'unavailable': return new RemoteUnavailableError(message, options)
    default: return new RemoteFailedError(message, options)
  }
}
