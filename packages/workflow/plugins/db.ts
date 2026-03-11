import fp from 'fastify-plugin'
import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { initDb, decorateDb } from '../lib/db.ts'
import type { AuthConfig } from '../lib/auth/index.ts'

declare module 'fastify' {
  interface FastifyInstance {
    authConfig: AuthConfig
  }
}

async function dbPlugin (app: FastifyInstance): Promise<void> {
  const connectionString = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'

  const pool = await initDb({ connectionString })
  decorateDb(app, pool, connectionString)

  // Detect mode and build auth config
  const isK8s = existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')

  let authConfig: AuthConfig

  if (isK8s) {
    const authMode = (process.env.WF_AUTH_MODE || 'k8s-token') as 'api-key' | 'k8s-token' | 'both'
    authConfig = {
      mode: authMode,
      k8s: authMode !== 'api-key'
        ? {
            apiServer: process.env.K8S_API_SERVER || 'https://kubernetes.default.svc',
            caCert: process.env.K8S_CA_CERT || '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
            adminServiceAccount: process.env.K8S_ADMIN_SERVICE_ACCOUNT,
          }
        : undefined,
    }
    app.log.info('Starting in multi-tenant mode (K8s detected)')
  } else {
    const appIdStr = process.env.PLT_WORLD_APP_ID || 'default'
    const result = await pool.query(
      `INSERT INTO workflow_applications (app_id)
       VALUES ($1)
       ON CONFLICT (app_id) DO UPDATE SET app_id = $1
       RETURNING id`,
      [appIdStr]
    )
    authConfig = { mode: 'none', defaultAppId: result.rows[0].id }
    app.log.info('Starting in single-tenant mode (no K8s detected)')
  }

  app.decorate('authConfig', authConfig)
}

export default fp(dbPlugin, { name: 'db' })
