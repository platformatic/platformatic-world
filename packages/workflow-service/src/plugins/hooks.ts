import type { FastifyInstance } from 'fastify'
import { HookNotFound } from '../lib/errors.ts'
import { formatHook } from './events.ts'

export default async function hooksPlugin (app: FastifyInstance): Promise<void> {
  // Get hook by ID
  app.get('/api/v1/apps/:appId/hooks/:hookId', async (request) => {
    const { hookId } = request.params as { hookId: string }
    const appId = request.appId

    const result = await app.pg.query(
      'SELECT * FROM workflow_hooks WHERE id = $1 AND application_id = $2',
      [hookId, appId]
    )

    if (result.rows.length === 0) throw new HookNotFound(hookId)
    return formatHook(result.rows[0])
  })

  // Get hook by token
  app.get('/api/v1/apps/:appId/hooks/by-token/:token', async (request) => {
    const { token } = request.params as { token: string }
    const appId = request.appId

    const result = await app.pg.query(
      'SELECT * FROM workflow_hooks WHERE token = $1 AND application_id = $2',
      [token, appId]
    )

    if (result.rows.length === 0) throw new HookNotFound(token)
    return formatHook(result.rows[0])
  })

  // List hooks
  app.get('/api/v1/apps/:appId/hooks', async (request) => {
    const query = request.query as { runId?: string; limit?: string; cursor?: string }
    const appId = request.appId
    const limit = Math.min(parseInt(query.limit || '100', 10), 1000)

    const offset = query.cursor ? parseInt(query.cursor, 10) : 0

    const conditions = ['application_id = $1', "status != 'disposed'"]
    const params: any[] = [appId]
    let paramIdx = 2

    if (query.runId) {
      conditions.push(`run_id = $${paramIdx++}`)
      params.push(query.runId)
    }

    params.push(limit + 1)
    params.push(offset)

    const result = await app.pg.query(
      `SELECT * FROM workflow_hooks
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params
    )

    const hasMore = result.rows.length > limit
    const data = result.rows.slice(0, limit).map(formatHook)
    const nextCursor = hasMore ? String(offset + limit) : null

    return { data, cursor: nextCursor, hasMore }
  })
}
