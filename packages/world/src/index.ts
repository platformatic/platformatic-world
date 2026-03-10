import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { World } from '@workflow/world'
import { HttpClient } from './lib/client.ts'
import type { ClientConfig } from './lib/client.ts'
import { createStorage } from './lib/storage.ts'
import { createQueue } from './lib/queue.ts'
import type { QueueConfig } from './lib/queue.ts'
import { createStreamer } from './lib/streamer.ts'
import { createEncryption } from './lib/encryption.ts'

export interface PlatformaticWorldConfig extends ClientConfig, QueueConfig {}

export function createPlatformaticWorld (config: PlatformaticWorldConfig): World {
  const client = new HttpClient(config)

  return {
    ...createStorage(client),
    ...createQueue(client, config),
    ...createStreamer(client),
    getEncryptionKeyForRun: createEncryption(client),
    async start () {
      // Register this process as a queue handler with the workflow service.
      // The test server (world-testing) sets process.env.PORT after listening.
      const port = process.env.PORT
      if (!port) return
      const baseUrl = `http://localhost:${port}`
      await client.post('/handlers', {
        podId: process.env.PLT_WORLD_POD_ID || `plt-world-${process.pid}`,
        deploymentVersion: config.deploymentVersion,
        endpoints: {
          workflow: `${baseUrl}/.well-known/workflow/v1/flow`,
          step: `${baseUrl}/.well-known/workflow/v1/step`,
          webhook: `${baseUrl}/.well-known/workflow/v1/webhook`,
        },
      })
    },
    async close () {
      await client.close()
    },
  }
}

export interface CreateWorldOptions {
  serviceUrl: string
  appId: string
  deploymentVersion: string
}

function readAppName (): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    return pkg.name || 'default'
  } catch {
    return 'default'
  }
}

export function createWorld (options?: Partial<CreateWorldOptions>): World {
  const serviceUrl = options?.serviceUrl || process.env.PLT_WORLD_SERVICE_URL
  if (!serviceUrl) {
    throw new Error('PLT_WORLD_SERVICE_URL environment variable is required')
  }

  const appId = options?.appId || process.env.PLT_WORLD_APP_ID || readAppName()
  const deploymentVersion = options?.deploymentVersion || process.env.PLT_WORLD_DEPLOYMENT_VERSION || 'local'

  return createPlatformaticWorld({ serviceUrl, appId, deploymentVersion })
}

export { HttpClient } from './lib/client.ts'
export type { ClientConfig } from './lib/client.ts'
export type { QueueConfig } from './lib/queue.ts'
