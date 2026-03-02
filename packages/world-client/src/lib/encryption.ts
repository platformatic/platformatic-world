import type { HttpClient } from './client.ts'

export function createEncryption (client: HttpClient) {
  return async function getEncryptionKeyForRun (runOrId: any, context?: Record<string, unknown>): Promise<Uint8Array | undefined> {
    const runId = typeof runOrId === 'string' ? runOrId : runOrId?.runId
    if (!runId) return undefined

    const result = await client.get('/encryption-key', { runId })
    if (!result?.key) return undefined

    // Decode base64 key to Uint8Array
    const buffer = Buffer.from(result.key, 'base64')
    return new Uint8Array(buffer)
  }
}
