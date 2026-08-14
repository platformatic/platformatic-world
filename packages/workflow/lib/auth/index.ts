import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createK8sTokenValidator } from './k8s-token.ts'
import { Unauthorized, Forbidden, AppNotFound } from '../errors.ts'

export interface AuthConfig {
  // Present when the platform supplies an identity to verify. Authentication is
  // enabled exactly when the means to perform it is supplied, so "authenticate
  // but without the config to do so" is unrepresentable.
  k8s?: {
    apiServer: string
    caCert?: string
    adminServiceAccount?: string
    saTokenPath?: string
  }
  // Resolve the tenant from the URL rather than pinning one application.
  multiTenant: boolean
  // Used when multiTenant is false.
  defaultAppId?: number
}

declare module 'fastify' {
  interface FastifyRequest {
    appId: number
    isAdmin: boolean
  }
}

// Paths that skip auth entirely
const PUBLIC_PATHS = new Set<string>(['/status'])

// Paths that require admin access (not app-level auth)
function isAdminPath (url: string): boolean {
  return (url.startsWith('/api/v1/apps') && (
    url.endsWith('/k8s-binding') ||
    url.match(/^\/api\/v1\/apps\/?$/) !== null
  )) || url.startsWith('/api/v1/versions/')
}

// Resolve an application named in the URL. Throws rather than leaving appId at
// its default, which would scope queries to application_id = 0 and make an
// unknown application look like an empty one.
async function resolveApp (app: FastifyInstance, appLabel: string): Promise<number> {
  const result = await app.pg.query(
    'SELECT id FROM workflow_applications WHERE app_id = $1',
    [appLabel]
  )
  if (result.rows.length === 0) throw new AppNotFound(appLabel)
  return result.rows[0].id
}

async function authPlugin (app: FastifyInstance, config: AuthConfig): Promise<void> {
  app.decorateRequest('appId', 0)
  app.decorateRequest('isAdmin', false)

  const validateK8s = config.k8s
    ? createK8sTokenValidator(app.pg, config.k8s, app.log)
    : null

  // Unauthenticated: every caller is admin. Tenancy still applies on managed
  // platforms, where the client names its application in the URL and ICC is the
  // one that registered it.
  if (!validateK8s) {
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const url = request.url.split('?')[0]
      if (PUBLIC_PATHS.has(url)) return

      request.isAdmin = true

      const appIdMatch = config.multiTenant
        ? url.match(/^\/api\/v1\/apps\/([^/]+)/)
        : null
      request.appId = appIdMatch
        ? await resolveApp(app, appIdMatch[1])
        : config.defaultAppId || 0
    })
    return
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0]

    if (PUBLIC_PATHS.has(url)) return

    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Unauthorized('missing or invalid Authorization header')
    }

    const token = authHeader.slice(7)

    let applicationIds: number[] = []

    if (validateK8s) {
      const k8sResult = await validateK8s(token)
      if (k8sResult) {
        applicationIds = k8sResult.applicationIds
        if (k8sResult.isAdmin) {
          request.isAdmin = true
        }
      }
    }

    if (applicationIds.length === 0 && !request.isAdmin) {
      if (isAdminPath(url)) {
        throw new Forbidden('admin access required')
      }
      throw new Unauthorized('invalid credentials')
    }

    // Admin can access app-scoped endpoints when appId is in URL
    if (request.isAdmin && applicationIds.length === 0) {
      const appIdMatch = url.match(/\/api\/v1\/apps\/([^/]+)/)
      if (appIdMatch) {
        request.appId = await resolveApp(app, appIdMatch[1])
      }
      return
    }

    // Admin-only endpoints reject non-admin tokens
    if (isAdminPath(url) && !request.isAdmin) {
      throw new Forbidden('admin access required')
    }

    // Resolve which app this request is for.
    // With a single binding, use it directly. With multiple bindings
    // (shared service account), resolve from the URL's appId.
    const appIdMatch = url.match(/\/api\/v1\/apps\/([^/]+)/)
    if (applicationIds.length === 1) {
      request.appId = applicationIds[0]
      // Still verify URL appId matches if present
      if (appIdMatch) {
        const result = await app.pg.query(
          'SELECT id FROM workflow_applications WHERE app_id = $1',
          [appIdMatch[1]]
        )
        if (result.rows.length === 0 || result.rows[0].id !== applicationIds[0]) {
          throw new Forbidden('app ID mismatch')
        }
      }
    } else if (appIdMatch) {
      // Multiple bindings — resolve app from URL
      const result = await app.pg.query(
        'SELECT id FROM workflow_applications WHERE app_id = $1',
        [appIdMatch[1]]
      )
      if (result.rows.length === 0 || !applicationIds.includes(result.rows[0].id)) {
        throw new Forbidden('app ID mismatch')
      }
      request.appId = result.rows[0].id
    } else if (applicationIds.length > 0) {
      // No URL appId and multiple bindings — use the first
      request.appId = applicationIds[0]
    }
  })
}

// Break encapsulation so decorators and hooks propagate to sibling plugins
const skipOverride = Symbol.for('skip-override')
;(authPlugin as any)[skipOverride] = true

export default authPlugin
