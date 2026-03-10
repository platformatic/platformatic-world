import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { createPoller } from '../queue/poller.ts'

async function pollerPlugin (app: FastifyInstance): Promise<void> {
  if (process.env.WF_ENABLE_POLLER === 'false') return

  const poller = createPoller(app.pg)
  app.addHook('onReady', async () => {
    await poller.start(app.pgConnectionString)
  })
  app.addHook('onClose', async () => {
    await poller.stop()
  })
}

export default fp(pollerPlugin, { name: 'poller', dependencies: ['db', 'auth'] })
