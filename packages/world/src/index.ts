import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSharedContext } from '@platformatic/globals'
import type { World } from '@workflow/world'
import { HttpClient } from './lib/client.ts'
import type { ClientConfig } from './lib/client.ts'
import { createStorage } from './lib/storage.ts'
import { createQueue } from './lib/queue.ts'
import type { QueueConfig } from './lib/queue.ts'
import { createStreamer } from './lib/streamer.ts'
import { createEncryption } from './lib/encryption.ts'

export interface PlatformaticWorldConfig extends ClientConfig, QueueConfig {}

const SPEC_VERSION_SUPPORTS_ATTRIBUTES = 4

export function createPlatformaticWorld (config: PlatformaticWorldConfig): World {
  const client = new HttpClient(config)

  return {
    specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES,
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
        podId: `plt-world-${process.pid}`,
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

// Read the deployment version from the watt runtime shared context, if something
// pushed one there. getSharedContext returns { get, update } inside a runtime, or
// undefined off-runtime with throwOnMissing:false -- a safe no-op standalone.
async function versionFromSharedContext (): Promise<string | undefined> {
  try {
    const shared = getSharedContext({ throwOnMissing: false }) as
      { get?: () => unknown } | undefined
    if (!shared?.get) return undefined
    const ctx = await shared.get() as { deploymentVersion?: string } | undefined
    return ctx?.deploymentVersion
  } catch {
    return undefined
  }
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

  const runningInK8s = isRunningInK8s()
  const explicitAppId = options?.appId || process.env.PLT_WORLD_APP_ID
  if (runningInK8s && !explicitAppId) {
    throw new Error('World application ID is required in Kubernetes; set options.appId or PLT_WORLD_APP_ID')
  }
  const appId = explicitAppId || readAppName()
  const explicitVersion = options?.deploymentVersion ||
    process.env.PLT_WORLD_DEPLOYMENT_VERSION ||
    process.env.PLT_DEPLOYMENT_VERSION
  // Version comes from the environment first: options, PLT_WORLD_DEPLOYMENT_VERSION,
  // or PLT_DEPLOYMENT_VERSION. No K8s API read.
  const config: PlatformaticWorldConfig = {
    serviceUrl,
    appId,
    deploymentVersion: explicitVersion || 'local',
    // In K8s ICC assigns the version, so a 'local' stamp means "not resolved yet" and
    // must not be used to enqueue (see queue.ts). Standalone/local dev keeps 'local'.
    requireResolvedVersion: runningInK8s,
  }

  // No explicit version: start at 'local'. When running inside a watt runtime, the
  // version can be provided later via the shared context, so refresh before each
  // queue read and latch it -- the pod starts stamping the real version with no
  // restart. Off-runtime (standalone) this is a no-op.
  if (!explicitVersion) {
    config.refreshDeploymentVersion = async () => {
      if (config.deploymentVersion !== 'local') return
      const version = await versionFromSharedContext()
      if (version) config.deploymentVersion = version
    }
  }

  const world = createPlatformaticWorld(config)

  return world
}

export { HttpClient } from './lib/client.ts'
export type { ClientConfig } from './lib/client.ts'
export type { QueueConfig } from './lib/queue.ts'
