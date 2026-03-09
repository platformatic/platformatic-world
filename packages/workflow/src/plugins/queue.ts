import type { FastifyInstance } from 'fastify'
import { DuplicateIdempotencyKey, BadRequest } from '../lib/errors.ts'
import { routeMessage } from '../queue/router.ts'
import { dispatchMessage } from '../queue/dispatcher.ts'
import { getRetryDelay } from '../queue/retry.ts'
import { checkQueueRateLimit } from './quotas.ts'

export default async function queuePlugin (app: FastifyInstance): Promise<void> {
  app.post('/api/v1/apps/:appId/queue', async (request, reply) => {
    const appId = request.appId
    const body = request.body as {
      queueName: string
      message: any
      deploymentId?: string
      idempotencyKey?: string
      delaySeconds?: number
    }

    if (!body.queueName || !body.message) {
      throw new BadRequest('queueName and message are required')
    }

    await checkQueueRateLimit(app, appId)

    // Extract runId from payload
    const runId = body.message.runId || body.message.workflowRunId || ''
    const deploymentVersion = body.deploymentId || ''

    // Check idempotency
    if (body.idempotencyKey) {
      const existing = await app.pg.query(
        'SELECT id FROM workflow_queue_messages WHERE idempotency_key = $1',
        [body.idempotencyKey]
      )
      if (existing.rows.length > 0) {
        throw new DuplicateIdempotencyKey(body.idempotencyKey)
      }
    }

    const delaySeconds = body.delaySeconds || 0

    if (delaySeconds > 0) {
      // Deferred delivery
      let result
      try {
        result = await app.pg.query(
          `INSERT INTO workflow_queue_messages
           (idempotency_key, queue_name, run_id, deployment_version, application_id, payload, status, deliver_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'deferred', NOW() + make_interval(secs => $7))
           RETURNING id`,
          [body.idempotencyKey || null, body.queueName, runId, deploymentVersion, appId,
            JSON.stringify(body.message), delaySeconds]
        )
      } catch (err: any) {
        if (err.code === '23505') throw new DuplicateIdempotencyKey(body.idempotencyKey || '')
        throw err
      }

      const messageId = result.rows[0].id

      // Wake the executor so it can recalculate its timer
      await app.pg.query("SELECT pg_notify('deferred_messages', '')")

      reply.code(201)
      return {
        messageId: `msg_${messageId}`,
        scheduled: true,
        deliverAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      }
    }

    // Immediate delivery — insert and attempt dispatch
    let insertResult
    try {
      insertResult = await app.pg.query(
        `INSERT INTO workflow_queue_messages
         (idempotency_key, queue_name, run_id, deployment_version, application_id, payload, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING id`,
        [body.idempotencyKey || null, body.queueName, runId, deploymentVersion, appId,
          JSON.stringify(body.message)]
      )
    } catch (err: any) {
      if (err.code === '23505') throw new DuplicateIdempotencyKey(body.idempotencyKey || '')
      throw err
    }

    const messageId = insertResult.rows[0].id

    // Try immediate dispatch
    const route = await routeMessage(app.pg, appId, deploymentVersion, body.queueName)
    if (route) {
      const dispResult = await dispatchMessage(
        route.url, body.queueName, messageId, body.message, 0
      )

      if (dispResult.success) {
        // Handle timeoutSeconds (re-queue with delay)
        if (typeof dispResult.timeoutSeconds === 'number' && dispResult.timeoutSeconds > 0) {
          await app.pg.query(
            `INSERT INTO workflow_queue_messages
             (queue_name, run_id, deployment_version, application_id, payload, status, deliver_at)
             VALUES ($1, $2, $3, $4, $5, 'deferred', NOW() + make_interval(secs => $6))`,
            [body.queueName, runId, deploymentVersion, appId,
              JSON.stringify(body.message), dispResult.timeoutSeconds]
          )
          await app.pg.query("SELECT pg_notify('deferred_messages', '')")
        }

        await app.pg.query(
          `UPDATE workflow_queue_messages SET status = 'delivered', delivered_at = NOW()
           WHERE id = $1`,
          [messageId]
        )

        reply.code(201)
        return { messageId: `msg_${messageId}`, routedTo: deploymentVersion }
      }

      // Dispatch failed — mark for retry
      const delay = getRetryDelay(1)
      await app.pg.query(
        `UPDATE workflow_queue_messages
         SET status = 'failed', attempts = 1,
             next_retry_at = NOW() + make_interval(secs => $2)
         WHERE id = $1`,
        [messageId, delay / 1000]
      )
    }

    // Return accepted — will be dispatched by poller
    reply.code(201)
    return { messageId: `msg_${messageId}` }
  })
}
