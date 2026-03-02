import { randomBytes } from 'node:crypto'

// This helper is used for integration tests that require a running workflow service.
// Start the service first: node --experimental-strip-types packages/workflow-service/src/server.ts

export const SERVICE_URL = process.env.WF_SERVICE_URL || 'http://localhost:3042'
export const MASTER_KEY = process.env.WF_MASTER_KEY || 'dev-master-key'

export async function provisionApp (): Promise<{ appId: string; apiKey: string }> {
  const appId = `test-${randomBytes(4).toString('hex')}`

  const response = await fetch(`${SERVICE_URL}/api/v1/apps`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${MASTER_KEY}`,
    },
    body: JSON.stringify({ appId }),
  })

  if (!response.ok) {
    throw new Error(`Failed to provision app: ${response.status} ${await response.text()}`)
  }

  return response.json() as Promise<{ appId: string; apiKey: string }>
}
