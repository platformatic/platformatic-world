import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import {
  applyRemoteUpdates,
  deliverRemoteOutcomes,
  expireRemoteOperations,
  type RemoteUpdate,
} from '../queue/remote-outcomes.ts'
import { RemoteOperationError } from '../lib/errors.ts'

const MAX_UPDATE_BATCH = 100
const SWEEP_INTERVAL_MS = 1_000

async function remoteOutcomesPlugin (app: FastifyInstance): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  let activeSweep: Promise<void> | undefined

  function sweep (): Promise<void> {
    if (activeSweep) return activeSweep
    activeSweep = (async () => {
      try {
        const expired = await expireRemoteOperations(app.pg)
        const delivered = await deliverRemoteOutcomes(app.pg)
        if (expired > 0 || delivered > 0) {
          app.log.info({ expired, delivered }, 'Remote outcome sweep reconciled operations')
        }
      } catch (error) {
        app.log.error({ err: error }, 'Remote outcome sweep failed')
      }
    })().finally(() => {
      activeSweep = undefined
    })
    return activeSweep
  }

  app.post('/api/v1/apps/:appId/remote-operations/updates', async (request) => {
    const value = request.body as { updates?: RemoteUpdate[] } | undefined
    if (!value || !Array.isArray(value.updates) || value.updates.length > MAX_UPDATE_BATCH) {
      throw new RemoteOperationError(
        'admission_rejected',
        `updates must be an array with at most ${MAX_UPDATE_BATCH} entries`,
        422
      )
    }
    const applied = await applyRemoteUpdates(app.pg, request.appId, value.updates)
    const delivered = await deliverRemoteOutcomes(app.pg, { applicationId: request.appId })
    if (applied.length > 0 || delivered > 0) {
      app.log.info(
        { received: value.updates.length, applied: applied.length, delivered },
        'Remote operation updates reconciled'
      )
    }
    return { applied: applied.length, delivered }
  })

  app.addHook('onReady', async () => {
    timer = setInterval(sweep, SWEEP_INTERVAL_MS)
    timer.unref()
    await sweep()
  })
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer)
    await activeSweep
  })
}

export default fp(remoteOutcomesPlugin, {
  name: 'remote-outcomes',
  dependencies: ['auth', 'remote-operations'],
})
