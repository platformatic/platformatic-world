import type { FastifyInstance } from 'fastify'
import { StepNotFound } from '../lib/errors.ts'
import { formatStep } from './events.ts'

export default async function stepsPlugin (app: FastifyInstance): Promise<void> {
  // Get step by ID
  app.get('/api/v1/apps/:appId/runs/:runId/steps/:stepId', async (request) => {
    const { runId, stepId } = request.params as { runId: string; stepId: string }
    const query = request.query as { resolveData?: string }
    const appId = request.appId

    const result = await app.pg.query(
      'SELECT * FROM workflow_steps WHERE id = $1 AND run_id = $2 AND application_id = $3',
      [stepId, runId, appId]
    )

    if (result.rows.length === 0) throw new StepNotFound(stepId)
    return formatStep(result.rows[0], query.resolveData)
  })

  // List steps for a run
  app.get('/api/v1/apps/:appId/runs/:runId/steps', async (request) => {
    const { runId } = request.params as { runId: string }
    const query = request.query as { limit?: string; cursor?: string; resolveData?: string }
    const appId = request.appId
    const limit = Math.min(parseInt(query.limit || '100', 10), 1000)
    const offset = query.cursor ? parseInt(query.cursor, 10) : 0

    const result = await app.pg.query(
      `SELECT * FROM workflow_steps
       WHERE run_id = $1 AND application_id = $2
       ORDER BY created_at ASC
       LIMIT $3 OFFSET $4`,
      [runId, appId, limit + 1, offset]
    )

    const hasMore = result.rows.length > limit
    const data = result.rows.slice(0, limit).map(row => formatStep(row, query.resolveData))
    const nextCursor = hasMore ? String(offset + limit) : null

    return { data, cursor: nextCursor, hasMore }
  })
}
