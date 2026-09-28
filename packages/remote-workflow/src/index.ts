import { createHook } from 'workflow'
import { dispatchRemoteOperation, validateRemoteBudget } from './dispatch.js'
import { errorForCode, errorForOutcome } from './errors.js'
import type { RemoteOutcome } from './wire.js'

export interface RemoteEndpoint<Input = unknown, Output = unknown> {
  input: Input
  output: Output
}

// Generated endpoint declarations merge into this interface.
export interface RemoteEndpoints {}

type EndpointName = Extract<keyof RemoteEndpoints, string>
type EndpointInput<Name extends EndpointName> =
  RemoteEndpoints[Name] extends RemoteEndpoint<infer Input, any> ? Input : never
type EndpointOutput<Name extends EndpointName> =
  RemoteEndpoints[Name] extends RemoteEndpoint<any, infer Output> ? Output : never

export interface RemoteOptions {
  /** Total schedule-to-completion budget in milliseconds. */
  budget?: number
  /** Optional registry epoch assertion. New operations normally use the resolved epoch. */
  epoch?: number
}

const DEFAULT_BUDGET_MS = 30_000

export function remote<Name extends EndpointName> (
  endpoint: Name,
  input: EndpointInput<Name>,
  options?: RemoteOptions
): Promise<EndpointOutput<Name>>
export function remote<Input = unknown, Output = unknown, const Name extends string = string> (
  endpoint: Name,
  input: Name extends EndpointName ? EndpointInput<Extract<Name, EndpointName>> : Input,
  options?: RemoteOptions
): Promise<Name extends EndpointName ? EndpointOutput<Extract<Name, EndpointName>> : Output>
export async function remote<Input, Output> (
  endpoint: string,
  input: Input,
  options: RemoteOptions = {}
): Promise<Output> {
  const budget = options.budget ?? DEFAULT_BUDGET_MS
  validateRemoteBudget(budget)

  const dispatch = await dispatchRemoteOperation(endpoint, input, { budget, epoch: options.epoch })
  if (!dispatch.ok) {
    throw errorForCode(dispatch.code, dispatch.message, { operationKey: dispatch.operationKey })
  }

  using hook = createHook<RemoteOutcome<Output>>({ token: dispatch.operationKey })
  const outcome = await hook
  if (outcome.ok) return outcome.value
  throw errorForOutcome(dispatch.operationKey, outcome)
}

export {
  RemoteError,
  RemoteNotClaimedError,
  RemoteFailedError,
  RemoteTimedOutError,
  RemoteCancelledError,
  RemoteUnavailableError,
} from './errors.js'
export { createOperationKey } from './dispatch.js'
export { defineRemote } from './handler.js'
export type { DefinedRemoteHandlers, RemoteHandlerDefinition, RemoteHandlerDefinitions, RemoteWorkflow } from './handler.js'
export {
  REMOTE_HANDLER_CLAIM_BATCH_MAX,
  REMOTE_HANDLER_INLINE_MAX_BYTES,
  REMOTE_HANDLER_MANIFEST_MAX_BYTES,
  REMOTE_HANDLER_OPERATION_KEY_MAX_BYTES,
  createDefaultRemoteHandlerAdapter,
  createRemoteHandlerTransport,
  createRemoteHandlerWorker,
  readRemoteHandlerManifest,
  registerRemoteHandlerRuntime,
  validateRemoteHandlerManifest,
} from './runtime.js'
export type {
  RemoteHandlerAdapter,
  RemoteHandlerCommandClient,
  RemoteHandlerCommandReply,
  RemoteHandlerIdentity,
  RemoteHandlerManifest,
  RemoteHandlerRun,
  RemoteHandlerTransport,
  RemoteHandlerWorker,
  RemoteHandlerWorkerOptions,
} from './runtime.js'
export type * from './wire.js'
