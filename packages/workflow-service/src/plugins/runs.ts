import type { FastifyInstance } from 'fastify'
import { RunNotFound } from '../lib/errors.ts'
import { formatRun } from './events.ts'

export default async function runsPlugin (app: FastifyInstance): Promise<void> {
  // Get run by ID
  app.get('/api/v1/apps/:appId/runs/:runId', async (request) => {
    const { runId } = request.params as { runId: string }
    const query = request.query as { resolveData?: string }
    const appId = request.appId

    const result = await app.pg.query(
      'SELECT * FROM workflow_runs WHERE id = $1 AND application_id = $2',
      [runId, appId]
    )

    if (result.rows.length === 0) throw new RunNotFound(runId)
    return formatRun(result.rows[0], query.resolveData)
  })

  // List runs
  app.get('/api/v1/apps/:appId/runs', async (request) => {
    const query = request.query as {
      workflowName?: string
      status?: string
      deploymentId?: string
      limit?: string
      cursor?: string
      resolveData?: string
    }
    const appId = request.appId
    const limit = Math.min(parseInt(query.limit || '50', 10), 1000)
    const conditions = ['application_id = $1']
    const params: any[] = [appId]
    let paramIdx = 2

    if (query.workflowName) {
      conditions.push(`workflow_name = $${paramIdx++}`)
      params.push(query.workflowName)
    }
    if (query.status) {
      conditions.push(`status = $${paramIdx++}`)
      params.push(query.status)
    }
    if (query.deploymentId) {
      conditions.push(`deployment_id = $${paramIdx++}`)
      params.push(query.deploymentId)
    }
    if (query.cursor) {
      conditions.push(`created_at < $${paramIdx++}`)
      params.push(new Date(query.cursor))
    }

    params.push(limit + 1)

    const result = await app.pg.query(
      `SELECT * FROM workflow_runs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramIdx}`,
      params
    )

    const hasMore = result.rows.length > limit
    const data = result.rows.slice(0, limit).map(row => formatRun(row, query.resolveData))
    const nextCursor = hasMore && data.length > 0
      ? result.rows[limit - 1].created_at.toISOString()
      : null

    return { data, cursor: nextCursor, hasMore }
  })
}
