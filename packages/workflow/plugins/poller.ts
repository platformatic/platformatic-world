import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { createPoller } from '../queue/poller.ts'
import { createQueueBackend } from '../queue/factory.ts'

async function pollerPlugin (app: FastifyInstance): Promise<void> {
  const { driver, store, transport, makeCoordinator } =
    createQueueBackend(app.pg, app.pgConnectionString, app.log)
  app.log.info({ driver }, 'Queue transport selected')

  const poller = createPoller(store, transport, app.pg, app.log, makeCoordinator)

  app.decorate('queueStore', store)

  // WF_ENABLE_POLLER=false means this process must not drain the queue, but it
  // may still enqueue, so the store is decorated either way.
  if (process.env.WF_ENABLE_POLLER === 'false') {
    app.addHook('onClose', async () => { await transport.close() })
    return
  }

  app.addHook('onReady', async () => { poller.start() })
  app.addHook('onClose', async () => { await poller.stop() })
}

export default fp(pollerPlugin, { name: 'poller', dependencies: ['db', 'auth'] })
