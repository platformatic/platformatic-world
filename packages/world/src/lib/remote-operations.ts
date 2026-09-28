import type { HttpClient } from './client.ts'

export type RemoteJsonSchema = Record<string, unknown> | boolean

export interface RemoteEndpointSchemas {
  inputSchema: RemoteJsonSchema
  outputSchema: RemoteJsonSchema
}

export interface ResolvedRemoteEndpoint {
  owner: string
  schemaHash: string
  transport: 'pull' | 'push'
  policy: Record<string, unknown>
  epoch: number
}

export interface RemoteEndpointRegistry {
  readonly iccApplicationId: string
  resolve: (
    endpoint: string
  ) => ResolvedRemoteEndpoint | undefined | Promise<ResolvedRemoteEndpoint | undefined>
  getSchema: (
    schemaHash: string
  ) => RemoteEndpointSchemas | undefined | Promise<RemoteEndpointSchemas | undefined>
}

// The provider supplies a caller-side cache for fast feedback only. Its schema
// snapshot is sent to World for deterministic validation, but ICC remains the
// authoritative registry and must independently validate announce admission.
export type RemoteEndpointRegistryProvider = (
) => RemoteEndpointRegistry | Promise<RemoteEndpointRegistry>

export interface StageRemoteOperation {
  operationKey: string
  dispatchStepId: string
  ordinal: string
  endpoint: string
  epoch?: number
  payload: unknown
  budget: { remaining: number }
}

export interface RemoteOperations {
  stage: (runId: string, operation: StageRemoteOperation) => Promise<any>
  get: (runId: string, operationKey: string) => Promise<any>
  listActive: (options?: ListActiveRemoteOperationsOptions) => Promise<ActiveRemoteOperationsPage>
  applyUpdates: (updates: RemoteOperationUpdate[]) => Promise<{ applied: number, delivered: number }>
}

export interface ListActiveRemoteOperationsOptions {
  cursor?: string
  limit?: number
}

export interface ActiveRemoteOperation {
  operationKey: string
  endpoint: string
  payload: unknown
  budget: { remaining: number }
  epoch: number
  cancelRequested: boolean
}

export interface ActiveRemoteOperationsPage {
  data: ActiveRemoteOperation[]
  cursor: string | null
  hasMore: boolean
}

export interface RemoteOperationUpdate {
  operationKey: string
  kind: 'started' | 'completed' | 'failed' | 'cancelled_ack'
  handlerRunId?: string
  outcome?: unknown
}

export interface StaticRemoteEndpointRegistryConfig {
  iccApplicationId: string
  endpoints: Record<string, ResolvedRemoteEndpoint>
  schemas: Record<string, RemoteEndpointSchemas>
}

export const REMOTE_ENDPOINT_REGISTRY_PROVIDER = Symbol.for(
  '@platformatic/world/remote-endpoint-registry-provider/v1'
)

function globalRegistryProvider (): RemoteEndpointRegistryProvider | undefined {
  const provider = (globalThis as any)[REMOTE_ENDPOINT_REGISTRY_PROVIDER]
  return typeof provider === 'function' ? provider : undefined
}

export function setRemoteEndpointRegistryProvider (
  provider: RemoteEndpointRegistryProvider | undefined
): void {
  if (provider) {
    ;(globalThis as any)[REMOTE_ENDPOINT_REGISTRY_PROVIDER] = provider
  } else {
    delete (globalThis as any)[REMOTE_ENDPOINT_REGISTRY_PROVIDER]
  }
}

export function createStaticRemoteEndpointRegistry (
  configured: StaticRemoteEndpointRegistryConfig
): RemoteEndpointRegistry {
  const endpoints = new Map(Object.entries(configured.endpoints))
  const schemas = new Map(Object.entries(configured.schemas))
  return {
    iccApplicationId: configured.iccApplicationId,
    resolve: endpoint => endpoints.get(endpoint),
    getSchema: schemaHash => schemas.get(schemaHash),
  }
}

function endpointUnknown (endpoint: string): Error {
  const error: any = new Error(`Unknown remote endpoint ${JSON.stringify(endpoint)}`)
  error.code = 'endpoint_unknown'
  error.statusCode = 404
  return error
}

function protocolError (message: string): Error {
  const error: any = new Error(message)
  error.code = 'remote_registry_protocol_error'
  return error
}

export function createRemoteOperations (client: HttpClient): RemoteOperations {
  return {
    async stage (runId, operation) {
      const path = `/runs/${runId}/remote-operations`
      try {
        return await client.post(path, operation)
      } catch (error: any) {
        if (error.statusCode !== 428 || error.code !== 'endpoint_resolution_required') throw error
      }

      const provider = globalRegistryProvider()
      if (!provider) throw protocolError('Remote endpoint registry provider is not configured')
      const registry = await provider()
      const endpoint = await registry.resolve(operation.endpoint)
      if (!endpoint) throw endpointUnknown(operation.endpoint)
      const schemas = await registry.getSchema(endpoint.schemaHash)
      if (!schemas) {
        throw protocolError(`Remote schema catalog has no entry for ${JSON.stringify(endpoint.schemaHash)}`)
      }

      try {
        return await client.post(path, {
          ...operation,
          resolution: {
            iccApplicationId: registry.iccApplicationId,
            ...endpoint,
            ...schemas,
          },
        })
      } catch (error: any) {
        if (error.statusCode === 428 && error.code === 'endpoint_resolution_required') {
          throw protocolError('Workflow service requested endpoint resolution more than once')
        }
        throw error
      }
    },
    get: (runId, operationKey) => client.get(`/runs/${runId}/remote-operations/${operationKey}`),
    listActive: options => client.get('/remote-operations/active', {
      cursor: options?.cursor,
      limit: options?.limit === undefined ? undefined : String(options.limit),
    }),
    applyUpdates: updates => client.post('/remote-operations/updates', { updates }),
  }
}
