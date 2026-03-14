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
      // In K8s, ICC registers queue handlers with proper FQDN URLs
      // (http://<service>.<namespace>.svc.cluster.local:<port>/...) so the
      // workflow service can dispatch cross-namespace.  Registering here with
      // localhost would create a duplicate handler that fails when picked.
      if (isRunningInK8s()) return

      // Local dev (no ICC) — register with localhost so the workflow service
      // running on the same machine can reach us.
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

function saPath (file: string): string {
  const base = process.env.PLT_WORLD_SA_PATH || '/var/run/secrets/kubernetes.io/serviceaccount'
  return `${base}/${file}`
}

function isRunningInK8s (): boolean {
  try {
    readFileSync(saPath('token'))
    return true
  } catch {
    return false
  }
}

async function readVersionFromK8sApi (): Promise<string | undefined> {
  try {
    const token = readFileSync(saPath('token'), 'utf8').trim()
    const namespace = readFileSync(saPath('namespace'), 'utf8').trim()
    const podName = process.env.HOSTNAME
    if (!podName) return undefined

    const ca = readFileSync(saPath('ca.crt'))
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
