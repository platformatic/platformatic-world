import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Agent } from 'undici'
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

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const SA_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace'
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'

function isRunningInK8s (): boolean {
  try {
    readFileSync(SA_TOKEN_PATH)
    return true
  } catch {
    return false
  }
}

async function readVersionFromK8sApi (): Promise<string | undefined> {
  try {
    const token = readFileSync(SA_TOKEN_PATH, 'utf8').trim()
    const namespace = readFileSync(SA_NAMESPACE_PATH, 'utf8').trim()
    const podName = process.env.HOSTNAME
    if (!podName) return undefined

    const ca = readFileSync(SA_CA_PATH)
    const dispatcher = new Agent({ connect: { ca } })
    const res = await fetch(
      `https://kubernetes.default.svc/api/v1/namespaces/${namespace}/pods/${podName}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        dispatcher,
      } as RequestInit
    )

    if (!res.ok) return undefined
    const pod = await res.json() as { metadata?: { labels?: Record<string, string> } }
    return pod?.metadata?.labels?.['plt.dev/version'] || undefined
  } catch {
    return undefined
  }
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
  const explicitVersion = options?.deploymentVersion || process.env.PLT_WORLD_DEPLOYMENT_VERSION
  const config = { serviceUrl, appId, deploymentVersion: explicitVersion || 'local' }
  const world = createPlatformaticWorld(config)

  if (!explicitVersion && isRunningInK8s()) {
    const originalStart = world.start!
    world.start = async function () {
      const version = await readVersionFromK8sApi()
      if (version) config.deploymentVersion = version
      return originalStart.call(this)
    }
  }

  return world
}

export { HttpClient } from './lib/client.ts'
export type { ClientConfig } from './lib/client.ts'
export type { QueueConfig } from './lib/queue.ts'
