import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSharedContext } from '@platformatic/globals'
import type { World } from '@workflow/world'
import { isManagedPlatform } from './lib/platform.ts'
import { HttpClient } from './lib/client.ts'
import type { ClientConfig } from './lib/client.ts'
import { createStorage } from './lib/storage.ts'
import { createQueue } from './lib/queue.ts'
import type { QueueConfig } from './lib/queue.ts'
import { createStreamer } from './lib/streamer.ts'
import { createEncryption } from './lib/encryption.ts'

export interface PlatformaticWorldConfig extends ClientConfig, QueueConfig {}

interface ServiceCapabilitiesResponse {
  specVersion?: unknown
  capabilities?: {
    eventsCreateBatch?: unknown
  }
}

// The batch writer requires both the service-side endpoint and the slot
// identity protocol. This is deliberately kept as a local structural type so
// this adapter remains source-compatible with @workflow/world 4.x; the SDK
// capability field is optional and added by the dependent runtime PR.
type PlatformaticWorldCapabilities = {
  eventsCreateBatch?: boolean
}

export interface PlatformaticWorldWithCapabilities {
  capabilities: PlatformaticWorldCapabilities
  /** Resolve backend capabilities once before enabling optional fast paths. */
  refreshCapabilities(): Promise<void>
}

// Spec 6 requires slot-numbered event ids, provided by migration 009.
const SPEC_VERSION_SUPPORTS_SLOT_IDENTITY = 6
// Atomic slot allocation keeps the log dense, so spec 7 needs no noop writer.
// The read path still passes through backend-created noop events.
const SPEC_VERSION_SUPPORTS_SEALED_LOG = 7

// Reimplemented because the type-only @workflow/world dependency is pinned to v4.
const warnedEnvValues = new Set<string>()

// Match the SDK flag semantics, including one warning per invalid value.
function envFlag (name: string, fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const normalized = raw.toLowerCase()
  if (normalized === '0' || normalized === 'false') return false
  if (normalized === '1' || normalized === 'true') return true
  const key = `${name}=${raw}`
  if (!warnedEnvValues.has(key)) {
    warnedEnvValues.add(key)
    console.warn(`[workflow] Ignoring ${name}: expected 0/1/true/false; using default ${fallback}`)
  }
  return fallback
}

function mintedSpecVersion (env: NodeJS.ProcessEnv = process.env): number {
  return envFlag('WORKFLOW_SEALED_LOG', true, env)
    ? SPEC_VERSION_SUPPORTS_SEALED_LOG
    : SPEC_VERSION_SUPPORTS_SLOT_IDENTITY
}

export function createPlatformaticWorld (config: PlatformaticWorldConfig): World & PlatformaticWorldWithCapabilities {
  const client = new HttpClient(config)

  // A capability probe is started exactly once when the World lifecycle (or the
  // SDK runtime) explicitly refreshes it. Until that promise is awaited the
  // capability stays absent, so a caller that starts work immediately remains
  // on the conservative single-event path. Missing endpoints, malformed
  // responses, and transport errors all fail closed.
  const capabilities: PlatformaticWorldCapabilities = {}
  let capabilityProbe: Promise<boolean> | undefined
  const probeCapabilities = (): Promise<boolean> => {
    capabilityProbe ??= client.get('/capabilities').then((response: ServiceCapabilitiesResponse) => {
      const specVersion = response?.specVersion
      return typeof specVersion === 'number' && Number.isInteger(specVersion) &&
        specVersion >= SPEC_VERSION_SUPPORTS_SLOT_IDENTITY &&
        response?.capabilities?.eventsCreateBatch === true
    }).catch(() => {
      // An older workflow service returns 404 and an unavailable service is not
      // evidence of support. The existing single-event API remains unchanged.
      return false
    })
    return capabilityProbe
  }
  const refreshCapabilities = async (): Promise<void> => {
    const supportsBatch = await probeCapabilities()
    if (supportsBatch) capabilities.eventsCreateBatch = true
  }

  return {
    specVersion: mintedSpecVersion(),
    // @workflow/world 4.x does not type this optional v5 capability yet. The
    // upcoming SDK contract adds the same structural field and gates the core
    // batch path on it.
    capabilities,
    refreshCapabilities,
    ...createStorage(client),
    ...createQueue(client, config),
    ...createStreamer(client),
    getEncryptionKeyForRun: createEncryption(client),
    async start () {
      await refreshCapabilities()
      // In K8s, ICC registers queue handlers with proper FQDN URLs
      // (http://<service>.<namespace>.svc.cluster.local:<port>/...) so the
      // workflow service can dispatch cross-namespace.  Registering here with
      // localhost would create a duplicate handler that fails when picked.
      if (isManagedPlatform()) return

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

function readAppName (): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    return pkg.name || 'default'
  } catch {
    return 'default'
  }
}

export function createWorld (options?: Partial<CreateWorldOptions>): World & PlatformaticWorldWithCapabilities {
  const serviceUrl = options?.serviceUrl || process.env.PLT_WORLD_SERVICE_URL
  if (!serviceUrl) {
    throw new Error('PLT_WORLD_SERVICE_URL environment variable is required')
  }

  const managed = isManagedPlatform()
  // PLT_APP_NAME is the platform's own name for the application (watt-extra
  // resolves it the same way), so it is preferred over the package name.
  const explicitAppId = options?.appId ||
    process.env.PLT_WORLD_APP_ID ||
    process.env.PLT_APP_NAME
  const appId = explicitAppId || readAppName()
  if (managed && !explicitAppId) {
    // The package name is not guaranteed unique -- a Next.js app is often just
    // "next" -- and where apps share a service account the binding check cannot
    // catch a wrong claim. Say which ID was assumed rather than failing.
    console.warn(
      `[@platformatic/world] no application ID configured; assuming "${appId}" from package.json. ` +
      'Set PLT_WORLD_APP_ID if this is not the application registered with the workflow service.'
    )
  }
  const explicitVersion = options?.deploymentVersion ||
    process.env.PLT_WORLD_DEPLOYMENT_VERSION ||
    process.env.PLT_DEPLOYMENT_VERSION
  // Version comes from the environment first: options, PLT_WORLD_DEPLOYMENT_VERSION,
  // or PLT_DEPLOYMENT_VERSION. No K8s API read.
  const config: PlatformaticWorldConfig = {
    serviceUrl,
    appId,
    deploymentVersion: explicitVersion || 'local',
    // On a managed platform ICC assigns the version, so a 'local' stamp means "not
    // resolved yet" and must not be used to enqueue (see queue.ts). Standalone
    // keeps 'local'.
    requireResolvedVersion: managed,
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
