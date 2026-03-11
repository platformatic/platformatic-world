import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { createPoller } from '../queue/poller.ts'

async function pollerPlugin (app: FastifyInstance): Promise<void> {
  if (process.env.WF_ENABLE_POLLER === 'false') return

  const poller = createPoller(app.pg, app.pgConnectionString, app.log)
  app.addHook('onReady', async () => { poller.start() })
  app.addHook('onClose', async () => { await poller.stop() })
}

export default fp(pollerPlugin, { name: 'poller', dependencies: ['db', 'auth'] })
