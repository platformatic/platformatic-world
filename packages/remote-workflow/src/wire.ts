export interface WireEnvelope<TType extends string, TBody> {
  v: 1
  type: TType
  tenant: string
  body: TBody
}

export interface Budget {
  remaining: number
}

export type RemoteErrorCode =
  | 'endpoint_unknown'
  | 'endpoint_withdrawn'
  | 'schema_invalid_input'
  | 'schema_invalid_output'
  | 'admission_rejected'
  | 'budget_exhausted'
  | 'manifest_conflict'
  | 'start_rejected'
  | 'dead_letter'

export type RemoteOutcome<T> =
  | { ok: true, value: T, handlerRunId?: string }
  | {
    ok: false
    kind: 'failed' | 'cancelled' | 'not_claimed' | 'unavailable'
    error?: { code: RemoteErrorCode | string, message: string }
    detail?: { code?: RemoteErrorCode | string, message?: string }
    handlerRunId?: string
  }

export interface AnnounceOperationBody {
  operationKey: string
  endpoint: string
  payload?: unknown
  payloadRef?: string
  budget: Budget
  epoch: number
}

export interface PollUpdate<T = unknown> {
  operationKey: string
  kind: 'started' | 'completed' | 'failed' | 'cancelled_ack'
  handlerRunId?: string
  outcome?: RemoteOutcome<T>
}

export interface ClaimBody {
  service: string
  versionLabel: string
  capacity: number
}

export interface ClaimedOperation {
  operationKey: string
  endpoint: string
  payload?: unknown
  payloadRef?: string
  token: string
  budget: Budget
}

export interface ReportStartedBody {
  token: string
  handlerRunId: string
}

export interface ReportResultBody<T = unknown> {
  token: string
  outcome: RemoteOutcome<T>
}
