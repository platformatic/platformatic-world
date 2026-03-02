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
import { createPoller } from './queue/poller.ts'

export interface AppConfig {
  connectionString: string
  auth: AuthConfig
  enablePoller?: boolean
}

export async function buildApp (config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })

  // Database
  const pool = await initDb({ connectionString: config.connectionString })
  decorateDb(app, pool)

  // Auth
  await app.register(authPlugin, config.auth)

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

  // Queue poller
  if (config.enablePoller !== false) {
    const poller = createPoller(pool)
    app.addHook('onReady', async () => {
      poller.start()
    })
    app.addHook('onClose', async () => {
      poller.stop()
    })
  }

  return app
}
