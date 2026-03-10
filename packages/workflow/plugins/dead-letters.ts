import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { BadRequest } from '../lib/errors.ts'

async function deadLettersPlugin (app: FastifyInstance): Promise<void> {
  // List dead-lettered messages
  app.get('/api/v1/apps/:appId/dead-letters', async (request) => {
    const appId = request.appId
    const query = request.query as { limit?: string; cursor?: string; queueName?: string }
    const limit = Math.min(parseInt(query.limit || '50', 10), 200)
    const offset = query.cursor ? parseInt(query.cursor, 10) : 0

    const conditions = ['application_id = $1', "status = 'dead'"]
    const params: any[] = [appId]
    let paramIdx = 2

    if (query.queueName) {
      conditions.push(`queue_name = $${paramIdx++}`)
      params.push(query.queueName)
    }

    params.push(limit + 1)
    params.push(offset)

    const result = await app.pg.query(
      `SELECT id, idempotency_key, queue_name, run_id, deployment_version, payload, attempts, created_at
       FROM workflow_queue_messages
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params
    )

    const hasMore = result.rows.length > limit
    const data = result.rows.slice(0, limit).map(row => ({
      messageId: `msg_${row.id}`,
      idempotencyKey: row.idempotency_key,
      queueName: row.queue_name,
      runId: row.run_id,
      deploymentVersion: row.deployment_version,
      payload: row.payload,
      attempts: row.attempts,
      createdAt: row.created_at,
    }))
    const nextCursor = hasMore ? String(offset + limit) : null

    return { data, cursor: nextCursor, hasMore }
  })

  // Retry a dead-lettered message
  app.post('/api/v1/apps/:appId/dead-letters/:messageId/retry', async (request) => {
    const appId = request.appId
    const { messageId } = request.params as { messageId: string }
    const numericId = parseInt(messageId.replace('msg_', ''), 10)

    if (isNaN(numericId)) throw new BadRequest('invalid messageId')

    const result = await app.pg.query(
      `UPDATE workflow_queue_messages
       SET status = 'pending', attempts = 0, next_retry_at = NULL
       WHERE id = $1 AND application_id = $2 AND status = 'dead'
       RETURNING id`,
      [numericId, appId]
    )

    if (result.rows.length === 0) {
      throw new BadRequest('message not found or not in dead state')
    }

    return { retried: true, messageId: `msg_${numericId}` }
  })
}

export default fp(deadLettersPlugin, { name: 'dead-letters', dependencies: ['auth'] })
