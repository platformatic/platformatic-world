import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { encode } from 'cbor-x'
import { DuplicateIdempotencyKey, BadRequest } from '../lib/errors.ts'
import { checkQueueRateLimit } from '../lib/quotas.ts'
import type { CborBody } from './cbor.ts'

interface Envelope {
  queueName: string
  message: any
  deploymentId?: string
  idempotencyKey?: string
  delaySeconds?: number
}

async function queuePlugin (app: FastifyInstance): Promise<void> {
  app.post('/api/v1/apps/:appId/queue', async (request, reply) => {
    const appId = request.appId
    const contentType = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase()

    let envelope: Envelope
    let encoding: 'json' | 'cbor'
    if (contentType === 'application/cbor') {
      const parsed = request.body as CborBody
      envelope = parsed.decoded as Envelope
      encoding = 'cbor'
    } else {
      envelope = request.body as Envelope
      encoding = 'json'
    }

    if (!envelope || !envelope.queueName || !envelope.message) {
      throw new BadRequest('queueName and message are required')
    }

    await checkQueueRateLimit(app, appId)

    const runId = envelope.message.runId || envelope.message.workflowRunId || ''
    const deploymentVersion = envelope.deploymentId || ''

    if (envelope.idempotencyKey) {
      const existing = await app.pg.query(
        'SELECT id FROM workflow_queue_messages WHERE idempotency_key = $1',
        [envelope.idempotencyKey]
      )
      if (existing.rows.length > 0) {
        throw new DuplicateIdempotencyKey(envelope.idempotencyKey)
      }
    }

    // For cbor, we store the encoded message bytes so dispatch can forward
    // without re-encoding the envelope. For json, the existing JSONB column.
    const payloadJson = encoding === 'json' ? JSON.stringify(envelope.message) : null
    const payloadBytes = encoding === 'cbor' ? Buffer.from(encode(envelope.message)) : null

    const delaySeconds = envelope.delaySeconds || 0

    if (delaySeconds > 0) {
      let result
      try {
        result = await app.pg.query(
          `INSERT INTO workflow_queue_messages
           (idempotency_key, queue_name, run_id, deployment_version, application_id,
            payload, payload_bytes, payload_encoding, status, deliver_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'deferred', NOW() + make_interval(secs => $9))
           RETURNING id`,
          [envelope.idempotencyKey || null, envelope.queueName, runId, deploymentVersion, appId,
            payloadJson, payloadBytes, encoding, delaySeconds]
        )
      } catch (err: any) {
        if (err.code === '23505') throw new DuplicateIdempotencyKey(envelope.idempotencyKey || '')
        throw err
      }

      const messageId = result.rows[0].id

      await app.pg.query("SELECT pg_notify('deferred_messages', '{}')")

      reply.code(201)
      return {
        messageId: `msg_${messageId}`,
        scheduled: true,
        deliverAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      }
    }

    let insertResult
    try {
      insertResult = await app.pg.query(
        `INSERT INTO workflow_queue_messages
         (idempotency_key, queue_name, run_id, deployment_version, application_id,
          payload, payload_bytes, payload_encoding, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
         RETURNING id`,
        [envelope.idempotencyKey || null, envelope.queueName, runId, deploymentVersion, appId,
          payloadJson, payloadBytes, encoding]
      )
    } catch (err: any) {
      if (err.code === '23505') throw new DuplicateIdempotencyKey(envelope.idempotencyKey || '')
      throw err
    }

    const messageId = insertResult.rows[0].id

    await app.pg.query("SELECT pg_notify('deferred_messages', '{}')")

    reply.code(201)
    return { messageId: `msg_${messageId}` }
  })
}

export default fp(queuePlugin, { name: 'queue', dependencies: ['auth', 'cbor'] })
