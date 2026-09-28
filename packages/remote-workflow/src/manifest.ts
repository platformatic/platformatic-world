import { readFile } from 'node:fs/promises'
import { assertRemoteSchemas, hashRemoteValue, type RemoteJsonSchema } from './remote-schema.ts'

export interface RemoteManifestEndpoint { name: string, inputSchema: RemoteJsonSchema, outputSchema: RemoteJsonSchema }
export interface RemoteManifest { v: 1, manifestHash: string, endpoints: RemoteManifestEndpoint[] }
export interface ManifestSource { read (): Promise<RemoteManifest | null> }

function isObject (value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
}

export function assertRemoteManifest (value: unknown): asserts value is RemoteManifest {
  if (!isObject(value) || value.v !== 1 || typeof value.manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.manifestHash) ||
      !Array.isArray(value.endpoints) || Object.keys(value).sort().join(',') !== 'endpoints,manifestHash,v') throw new TypeError('Invalid remote manifest')
  let previousName: string | undefined
  for (const endpoint of value.endpoints) {
    if (!isObject(endpoint) || Object.keys(endpoint).sort().join(',') !== 'inputSchema,name,outputSchema' ||
        typeof endpoint.name !== 'string' || endpoint.name.length === 0 || endpoint.name.length > 1024 ||
        !Object.hasOwn(endpoint, 'inputSchema') || !Object.hasOwn(endpoint, 'outputSchema') ||
        (previousName !== undefined && endpoint.name <= previousName)) throw new TypeError('Invalid remote manifest endpoint')
    assertRemoteSchemas({
      inputSchema: endpoint.inputSchema as RemoteJsonSchema,
      outputSchema: endpoint.outputSchema as RemoteJsonSchema
    })
    previousName = endpoint.name
  }
  if (hashRemoteValue(value.endpoints) !== value.manifestHash) throw new TypeError('Remote manifest hash does not match its endpoints')
}

export async function readRemoteManifest (path: string): Promise<RemoteManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  assertRemoteManifest(value)
  return value
}

export class FileManifestSource implements ManifestSource {
  readonly path: string
  constructor (path: string) { this.path = path }
  async read (): Promise<RemoteManifest | null> {
    try { return await readRemoteManifest(this.path) } catch (error: any) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
}
