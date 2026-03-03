import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createApiKeyValidator } from './api-key.ts'
import { createK8sTokenValidator } from './k8s-token.ts'
import { validateMasterKey } from './master-key.ts'
import { Unauthorized, Forbidden } from '../errors.ts'

export interface AuthConfig {
  mode: 'api-key' | 'k8s-token' | 'both'
  masterKey: string
  k8s?: {
    apiServer: string
    caCert?: string
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    appId: number
    isMasterKey: boolean
  }
}

// Paths that skip auth entirely
const PUBLIC_PATHS = new Set(['/ready', '/status', '/metrics'])

// Paths that require master key (not app-level auth)
function isMasterKeyPath (url: string): boolean {
  return url.startsWith('/api/v1/apps') && (
    url.endsWith('/keys/rotate') ||
    url.endsWith('/k8s-binding') ||
    url.match(/^\/api\/v1\/apps\/?$/) !== null
  ) || url.startsWith('/api/v1/versions/')
}

async function authPlugin (app: FastifyInstance, config: AuthConfig): Promise<void> {
  const validateApiKey = createApiKeyValidator(app.pg)
  const validateK8s = config.k8s
    ? createK8sTokenValidator(app.pg, config.k8s)
    : null

  app.decorateRequest('appId', 0)
  app.decorateRequest('isMasterKey', false)

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0]

    if (PUBLIC_PATHS.has(url)) return

    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Unauthorized('missing or invalid Authorization header')
    }

    const token = authHeader.slice(7)

    // Check master key first for admin endpoints
    if (validateMasterKey(token, config.masterKey)) {
      request.isMasterKey = true
      // Master key can also access app-scoped endpoints when appId is in URL
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

    // Master-key-only endpoints reject non-master tokens
    if (isMasterKeyPath(url)) {
      throw new Forbidden('master key required')
    }

    // Try API key validation
    let applicationId: number | null = null

    if (config.mode === 'api-key' || config.mode === 'both') {
      applicationId = await validateApiKey(token)
    }

    if (applicationId === null && (config.mode === 'k8s-token' || config.mode === 'both')) {
      if (validateK8s) {
        applicationId = await validateK8s(token)
      }
    }

    if (applicationId === null) {
      throw new Unauthorized('invalid credentials')
    }

    request.appId = applicationId

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
