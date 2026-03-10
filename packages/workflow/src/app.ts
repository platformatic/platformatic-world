import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { initDb, decorateDb } from './lib/db.ts'
import authPlugin from './lib/auth/index.ts'
import type { AuthConfig } from './lib/auth/index.ts'
import healthPlugin from './plugins/health.ts'
import appsPlugin from './plugins/apps.ts'
import eventsPlugin from './plugins/events.ts'
import runsPlugin from './plugins/runs.ts'
import stepsPlugin from './plugins/steps.ts'
import hooksPlugin from './plugins/hooks.ts'
import streamsPlugin from './plugins/streams.ts'
import encryptionPlugin from './plugins/encryption.ts'
import handlersPlugin from './plugins/handlers.ts'
import queuePlugin from './plugins/queue.ts'
import drainingPlugin from './plugins/draining.ts'
import versionsPlugin from './plugins/versions.ts'
import deadLettersPlugin from './plugins/dead-letters.ts'
import metricsPlugin from './plugins/metrics.ts'
import { createPoller } from './queue/poller.ts'

export interface AppConfig {
  connectionString: string
  auth?: AuthConfig
  singleTenant?: boolean
  defaultAppId?: string
  enablePoller?: boolean
}

export async function buildApp (config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: globalThis.platformatic?.logger,
    logger: !globalThis.platformatic?.logger,
  })

  // Database
  const pool = await initDb({ connectionString: config.connectionString })
  decorateDb(app, pool, config.connectionString)

  // Single-tenant: auto-provision default app and construct auth config
  let authConfig: AuthConfig
  if (config.singleTenant) {
    const appIdStr = config.defaultAppId || 'default'
    const result = await pool.query(
      `INSERT INTO workflow_applications (app_id)
       VALUES ($1)
       ON CONFLICT (app_id) DO UPDATE SET app_id = $1
       RETURNING id`,
      [appIdStr]
    )
    authConfig = { mode: 'none', defaultAppId: result.rows[0].id }
  } else {
    authConfig = config.auth!
  }

  // Auth
  await app.register(authPlugin, authConfig)

  // Plugins
  await app.register(healthPlugin)
  await app.register(appsPlugin)
  await app.register(eventsPlugin)
  await app.register(runsPlugin)
  await app.register(stepsPlugin)
  await app.register(hooksPlugin)
  await app.register(streamsPlugin)
  await app.register(encryptionPlugin)
  await app.register(handlersPlugin)
  await app.register(queuePlugin)
  await app.register(drainingPlugin)
  await app.register(versionsPlugin)
  await app.register(deadLettersPlugin)
  await app.register(metricsPlugin)

  // Queue poller
  if (config.enablePoller !== false) {
    const poller = createPoller(pool)
    app.addHook('onReady', async () => {
      await poller.start(config.connectionString)
    })
    app.addHook('onClose', async () => {
      await poller.stop()
    })
  }

  return app
}
