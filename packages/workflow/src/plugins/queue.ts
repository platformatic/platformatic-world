import type { FastifyInstance } from 'fastify'
import { DuplicateIdempotencyKey, BadRequest } from '../lib/errors.ts'
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
      const cappedDelay = delaySeconds
      let result
      try {
        result = await app.pg.query(
          `INSERT INTO workflow_queue_messages
           (idempotency_key, queue_name, run_id, deployment_version, application_id, payload, status, deliver_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'deferred', NOW() + make_interval(secs => $7))
           RETURNING id`,
          [body.idempotencyKey || null, body.queueName, runId, deploymentVersion, appId,
            JSON.stringify(body.message), cappedDelay]
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
        deliverAt: new Date(Date.now() + cappedDelay * 1000).toISOString(),
      }
    }

    // Immediate delivery — insert as pending and let the poller dispatch asynchronously.
    // This prevents synchronous dispatch chains that block the SDK's Promise.race().
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

    // Wake the poller to dispatch this message asynchronously
    await app.pg.query("SELECT pg_notify('deferred_messages', '')")

    reply.code(201)
    return { messageId: `msg_${messageId}` }
  })
}
