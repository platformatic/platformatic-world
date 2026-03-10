import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createK8sTokenValidator } from './k8s-token.ts'
import { Unauthorized, Forbidden } from '../errors.ts'

export interface AuthConfig {
  mode: 'k8s-token' | 'none'
  defaultAppId?: number
  k8s?: {
    apiServer: string
    caCert?: string
    adminServiceAccount?: string
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    appId: number
    isAdmin: boolean
  }
}

// Paths that skip auth entirely (health/metrics are on the Watt metrics port)
const PUBLIC_PATHS = new Set<string>()

// Paths that require admin access (not app-level auth)
function isAdminPath (url: string): boolean {
  return (url.startsWith('/api/v1/apps') && (
    url.endsWith('/k8s-binding') ||
    url.match(/^\/api\/v1\/apps\/?$/) !== null
  )) || url.startsWith('/api/v1/versions/')
}

async function authPlugin (app: FastifyInstance, config: AuthConfig): Promise<void> {
  app.decorateRequest('appId', 0)
  app.decorateRequest('isAdmin', false)

  // No-auth mode: set appId from config and skip all token parsing
  if (config.mode === 'none') {
    app.addHook('onRequest', async (request: FastifyRequest) => {
      request.appId = config.defaultAppId || 0
      request.isAdmin = true
    })
    return
  }

  const validateK8s = config.k8s
    ? createK8sTokenValidator(app.pg, config.k8s)
    : null

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0]

    if (PUBLIC_PATHS.has(url)) return

    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Unauthorized('missing or invalid Authorization header')
    }

    const token = authHeader.slice(7)

    let applicationId: number | null = null

    if (validateK8s) {
      const k8sResult = await validateK8s(token)
      if (k8sResult) {
        applicationId = k8sResult.applicationId
        if (k8sResult.isAdmin) {
          request.isAdmin = true
        }
      }
    }

    if (applicationId === null && !request.isAdmin) {
      if (isAdminPath(url)) {
        throw new Forbidden('admin access required')
      }
      throw new Unauthorized('invalid credentials')
    }

    if (applicationId !== null) {
      request.appId = applicationId
    }

    // Admin can access app-scoped endpoints when appId is in URL
    if (request.isAdmin && applicationId === null) {
      const appIdMatch = url.match(/\/api\/v1\/apps\/([^/]+)/)
      if (appIdMatch) {
        const result = await app.pg.query(
          'SELECT id FROM workflow_applications WHERE app_id = $1',
          [appIdMatch[1]]
        )
        if (result.rows.length > 0) {
          request.appId = result.rows[0].id
        }
      }
      return
    }

    // Admin-only endpoints reject non-admin tokens
    if (isAdminPath(url) && !request.isAdmin) {
      throw new Forbidden('admin access required')
    }

    // Verify URL appId matches auth-derived appId
    const appIdMatch = url.match(/\/api\/v1\/apps\/([^/]+)/)
    if (appIdMatch) {
      const result = await app.pg.query(
        'SELECT id FROM workflow_applications WHERE app_id = $1',
        [appIdMatch[1]]
      )
      if (result.rows.length === 0 || result.rows[0].id !== applicationId) {
        throw new Forbidden('app ID mismatch')
      }
    }
  })
}

// Break encapsulation so decorators and hooks propagate to sibling plugins
const skipOverride = Symbol.for('skip-override')
;(authPlugin as any)[skipOverride] = true

export default authPlugin
