import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { initDb, decorateDb } from '../lib/db.ts'
import { saPath, isRunningInK8s, isManagedPlatform } from '../lib/platform.ts'
import type { AuthConfig } from '../lib/auth/index.ts'

declare module 'fastify' {
  interface FastifyInstance {
    authConfig: AuthConfig
  }
}

async function dbPlugin (app: FastifyInstance): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required')
  }

  const pool = await initDb({ connectionString })
  decorateDb(app, pool, connectionString)

  // Two independent axes, both derived from platform-injected facts. K8s
  // supplies an identity to verify; K8s and ECS both mean ICC provisions
  // applications, so tenancy applies with or without authentication.
  const isK8s = isRunningInK8s()
  const multiTenant = isManagedPlatform()

  let authConfig: AuthConfig

  if (multiTenant) {
    authConfig = {
      multiTenant: true,
      k8s: isK8s
        ? {
            apiServer: process.env.K8S_API_SERVER || 'https://kubernetes.default.svc',
            caCert: process.env.K8S_CA_CERT || saPath('ca.crt'),
            adminServiceAccount: process.env.K8S_ADMIN_SERVICE_ACCOUNT,
            saTokenPath: saPath('token'),
          }
        : undefined,
    }
    app.log.info({ authenticated: isK8s }, 'Starting in multi-tenant mode')
  } else {
    const appIdStr = process.env.PLT_WORLD_APP_ID || 'default'
    const result = await pool.query(
      `INSERT INTO workflow_applications (app_id)
       VALUES ($1)
       ON CONFLICT (app_id) DO UPDATE SET app_id = $1
       RETURNING id`,
      [appIdStr]
    )
    authConfig = { multiTenant: false, defaultAppId: result.rows[0].id }
    app.log.info('Starting in single-tenant mode (unmanaged)')
  }

  app.decorate('authConfig', authConfig)
}

export default fp(dbPlugin, { name: 'db' })
