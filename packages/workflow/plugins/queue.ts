import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { encode } from 'cbor-x'
import { DuplicateIdempotencyKey, BadRequest, VersionExpired } from '../lib/errors.ts'
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

    const runId = envelope.message.runId || envelope.message.workflowRunId || ''
    const deploymentVersion = envelope.deploymentId || ''

    await checkQueueRateLimit(app, appId)

    if (envelope.idempotencyKey) {
      const existing = await app.pg.query(
        'SELECT id FROM workflow_queue_messages WHERE idempotency_key = $1',
        [envelope.idempotencyKey]
      )
      if (existing.rows.length > 0) {
        throw new DuplicateIdempotencyKey(envelope.idempotencyKey)
      }
    }

    // Fail fast when the target deployment version is expired. routeMessage()
    // already refuses to dispatch to an expired version, so accepting the
    // message here only buys it ten doomed delivery attempts before the poller
    // dead-letters it. 410 is the spec's "this deployment cannot receive the
    // message" signal, which the World client surfaces through
    // isDeploymentUnavailableError() so the SDK can re-route instead of retry.
    // Draining versions still accept work, matching routeMessage().
    if (deploymentVersion) {
      const version = await app.pg.query(
        `SELECT status FROM workflow_deployment_versions
         WHERE application_id = $1 AND deployment_version = $2`,
        [appId, deploymentVersion]
      )
      if (version.rows[0]?.status === 'expired') throw new VersionExpired(deploymentVersion)
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
