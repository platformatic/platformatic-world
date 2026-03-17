import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { Forbidden, BadRequest } from '../lib/errors.ts'
import { DEFAULT_QUOTAS, invalidateQuotaCache } from '../lib/quotas.ts'

async function quotasPlugin (app: FastifyInstance): Promise<void> {
  // Get quotas for an app (admin only)
  app.get('/api/v1/apps/:appId/quotas', async (request) => {
    if (!request.isAdmin) throw new Forbidden('admin access required')

    const appId = request.appId

    const result = await app.pg.query(
      'SELECT max_runs, max_events_per_run, max_queue_per_minute FROM workflow_app_quotas WHERE application_id = $1',
      [appId]
    )

    if (result.rows.length === 0) {
      return {
        maxRuns: DEFAULT_QUOTAS.maxRuns,
        maxEventsPerRun: DEFAULT_QUOTAS.maxEventsPerRun,
        maxQueuePerMinute: DEFAULT_QUOTAS.maxQueuePerMinute,
        isDefault: true
      }
    }

    return {
      maxRuns: result.rows[0].max_runs,
      maxEventsPerRun: result.rows[0].max_events_per_run,
      maxQueuePerMinute: result.rows[0].max_queue_per_minute,
      isDefault: false
    }
  })

  // Set quotas for an app (admin only)
  app.put('/api/v1/apps/:appId/quotas', async (request) => {
    if (!request.isAdmin) throw new Forbidden('admin access required')

    const appId = request.appId
    const body = request.body as {
      maxRuns?: number
      maxEventsPerRun?: number
      maxQueuePerMinute?: number
    }

    if (!body || (body.maxRuns === undefined && body.maxEventsPerRun === undefined && body.maxQueuePerMinute === undefined)) {
      throw new BadRequest('at least one quota field is required: maxRuns, maxEventsPerRun, maxQueuePerMinute')
    }

    const maxRuns = body.maxRuns ?? DEFAULT_QUOTAS.maxRuns
    const maxEventsPerRun = body.maxEventsPerRun ?? DEFAULT_QUOTAS.maxEventsPerRun
    const maxQueuePerMinute = body.maxQueuePerMinute ?? DEFAULT_QUOTAS.maxQueuePerMinute

    await app.pg.query(
      `INSERT INTO workflow_app_quotas (application_id, max_runs, max_events_per_run, max_queue_per_minute)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (application_id) DO UPDATE SET
         max_runs = $2,
         max_events_per_run = $3,
         max_queue_per_minute = $4,
         updated_at = NOW()`,
      [appId, maxRuns, maxEventsPerRun, maxQueuePerMinute]
    )

    invalidateQuotaCache(appId)

    return { maxRuns, maxEventsPerRun, maxQueuePerMinute }
  })
}

export default fp(quotasPlugin, { name: 'quotas', dependencies: ['auth'] })
