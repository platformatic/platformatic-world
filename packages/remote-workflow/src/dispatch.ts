import { createHash } from 'node:crypto'
import { createWorld } from '@platformatic/world'
import type { RemoteOperations } from '@platformatic/world'
import { getStepMetadata, getWorkflowMetadata } from 'workflow'
import type { RemoteErrorCode } from './wire.js'

export interface DispatchOptions {
  budget: number
  epoch?: number
}

export interface DispatchContext {
  workflowRunId: string
  dispatchStepId: string
  ordinal: string
}

export interface StagedRemoteOperation {
  operationKey: string
  schemaHash: string
  epoch: number
}

export type DispatchResult =
  | ({ ok: true } & StagedRemoteOperation)
  | {
    ok: false
    operationKey: string
    code: RemoteErrorCode | string
    message: string
  }

interface DispatchWorld {
  remoteOperations: RemoteOperations
  close?: () => Promise<void>
}

const REMOTE_PROTOCOL_ERROR_CODES = new Set([
  'endpoint_unknown',
  'endpoint_withdrawn',
  'schema_invalid_input',
  'schema_invalid_output',
  'admission_rejected',
  'budget_exhausted',
  'manifest_conflict',
  'start_rejected',
  'dead_letter',
  'operation_conflict',
  'remote_registry_protocol_error',
])

export const MINIMUM_REMOTE_BUDGET_MS = 1_000
export const MAXIMUM_REMOTE_BUDGET_MS = 2_147_483_647

export function validateRemoteBudget (budget: number): void {
  if (!Number.isSafeInteger(budget) || budget < MINIMUM_REMOTE_BUDGET_MS ||
      budget > MAXIMUM_REMOTE_BUDGET_MS) {
    throw new RangeError(
      `remote options.budget must be an integer between ${MINIMUM_REMOTE_BUDGET_MS} and ${MAXIMUM_REMOTE_BUDGET_MS} milliseconds`
    )
  }
}

export interface DispatchRuntime {
  getContext: () => DispatchContext
  createWorld: () => DispatchWorld
}

const defaultRuntime: DispatchRuntime = {
  getContext () {
    const { workflowRunId } = getWorkflowMetadata()
    const { stepName: dispatchStepId, stepId: ordinal } = getStepMetadata()
    return { workflowRunId, dispatchStepId, ordinal }
  },
  createWorld,
}

function hashPart (value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`
}

export function createOperationKey (
  callerRunId: string,
  dispatchStepId: string,
  endpoint: string,
  ordinal: string
): string {
  const digest = createHash('sha256')
    .update([callerRunId, dispatchStepId, endpoint, ordinal].map(hashPart).join('|'))
    .digest('hex')
  return `rop_${digest}`
}

function dispatchError (error: unknown): { code: string, message: string } | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as { code?: unknown, message?: unknown, statusCode?: unknown, status?: unknown }
  if (typeof candidate.code !== 'string') return undefined
  const status = candidate.statusCode ?? candidate.status
  if (status === undefined) {
    if (!REMOTE_PROTOCOL_ERROR_CODES.has(candidate.code)) return undefined
  } else if (typeof status !== 'number' || status < 400 || status >= 500) {
    return undefined
  }
  return {
    code: candidate.code,
    message: typeof candidate.message === 'string' ? candidate.message : candidate.code,
  }
}

export async function dispatchRemoteOperation (
  endpoint: string,
  input: unknown,
  options: DispatchOptions,
  runtime: DispatchRuntime = defaultRuntime
): Promise<DispatchResult> {
  'use step'

  validateRemoteBudget(options.budget)
  const { workflowRunId, dispatchStepId, ordinal } = runtime.getContext()
  const operationKey = createOperationKey(workflowRunId, dispatchStepId, endpoint, ordinal)
  const world = runtime.createWorld()
  try {
    const operation = await world.remoteOperations.stage(workflowRunId, {
      operationKey,
      dispatchStepId,
      ordinal,
      endpoint,
      payload: input,
      budget: { remaining: options.budget },
      ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
    }) as StagedRemoteOperation
    return {
      ok: true,
      operationKey: operation.operationKey,
      schemaHash: operation.schemaHash,
      epoch: operation.epoch,
    }
  } catch (error) {
    const mapped = dispatchError(error)
    if (!mapped) throw error
    return { ok: false, operationKey, ...mapped }
  } finally {
    await world.close?.()
  }
}
