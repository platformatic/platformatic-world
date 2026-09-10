// The Postgres QueueStore: the default, and the only store there is.
//
// Every transport uses this. What varies is only who carries a ready message to
// a consumer (see ../transport.ts), never where its durable state lives.
//
// It is also the only store that can keep a terminal failure atomic:
// dead-lettering a message and failing the run it belongs to commit together,
// so a run is never left running against a message nobody will retry. With a
// remote transport the broker ack happens after that commit, and a lost ack is
// harmless because claimForDispatch refuses the redelivery.

import type pg from 'pg'
import { MAX_ATTEMPTS } from '../retry.ts'
import { failRun, failureDetail, lockRunForFailureFinalization, type FailureDetail } from '../delivery.ts'
import type {
  EnqueueRequest, MessageId, OutboxEntry, QueueMessage, QueueStore,
} from '../store.ts'

const DEFERRED_CHANNEL = 'deferred_messages'
const DEFAULT_VISIBILITY_TIMEOUT_S = 900
const VISIBILITY_TIMEOUT_S = Number(process.env.WF_DELIVERY_VISIBILITY_TIMEOUT_S) > 0
  ? Number(process.env.WF_DELIVERY_VISIBILITY_TIMEOUT_S)
  : DEFAULT_VISIBILITY_TIMEOUT_S

export function createPostgresQueueStore (
  pool: pg.Pool, log: any, transportName: string
): QueueStore {
  async function inTransaction<T> (fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async function notify (): Promise<void> {
    await pool.query(`SELECT pg_notify('${DEFERRED_CHANNEL}', '{}')`)
  }

  return {
    async enqueue (req: EnqueueRequest) {
      const delaySeconds = req.delaySeconds || 0
      const deferred = delaySeconds > 0
      const result = await pool.query(
        `INSERT INTO workflow_queue_messages
           (idempotency_key, queue_name, run_id, deployment_version, application_id,
            payload, payload_bytes, payload_encoding, status, deliver_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 CASE WHEN $10::int > 0 THEN NOW() + make_interval(secs => $10::int) ELSE NULL END)
         RETURNING id`,
        [req.idempotencyKey || null, req.queueName, req.runId, req.deploymentVersion,
          req.applicationId, req.payload, req.payloadBytes, req.payloadEncoding,
          deferred ? 'deferred' : 'pending', delaySeconds]
      )
      await notify()
      return { messageId: result.rows[0].id as MessageId, ready: !deferred }
    },

    async readyMessageIds (limit, excludeIds) {
      // Only messages the transport has actually been handed. With an inline
      // transport that is every committed row; with a relay it excludes rows
      // still waiting to be published.
      const { rows } = await pool.query(
        `SELECT id FROM workflow_queue_messages
         WHERE status = 'pending' AND published_at IS NOT NULL
           AND NOT (id = ANY($1::bigint[]))
         ORDER BY created_at ASC
         LIMIT $2`,
        [excludeIds, limit]
      )
      return rows.map(r => r.id as MessageId)
    },

    async claimForDispatch (messageId) {
      // The gate. A message may be dispatched exactly once per attempt, and only
      // from 'pending'. A redelivery of something already delivered, dead or
      // failed loses the CAS and is dropped before it can reach the handler.
      const { rows } = await pool.query(
        `UPDATE workflow_queue_messages
         SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [messageId]
      )
      return (rows[0] as QueueMessage) ?? null
    },

    async ack (msg, continuation) {
      // One transaction, deliberately. Marking the delivery terminal and
      // writing the continuation it asked for have to commit together: if the
      // ack landed and the continuation did not, the run would be waiting on a
      // message that no longer exists and nothing would redeliver it, because
      // 'acked' is exactly the state reclaimExpired skips.
      await inTransaction(async (client) => {
        await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'acked', acked_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND application_id = $2 AND status = 'delivered'`,
          [msg.id, msg.application_id]
        )
        if (!continuation) return

        const { delaySeconds } = continuation
        const payloadJson = msg.payload_encoding === 'json' ? JSON.stringify(msg.payload) : null
        const payloadBytes = msg.payload_encoding === 'cbor' ? msg.payload_bytes : null
        await client.query(
          `INSERT INTO workflow_queue_messages
             (queue_name, run_id, deployment_version, application_id,
              payload, payload_bytes, payload_encoding, status, deliver_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   CASE WHEN $9::int > 0 THEN NOW() + make_interval(secs => $9::int) ELSE NULL END)`,
          [msg.queue_name, msg.run_id, msg.deployment_version, msg.application_id,
            payloadJson, payloadBytes, msg.payload_encoding,
            delaySeconds > 0 ? 'deferred' : 'pending', delaySeconds]
        )
        await client.query(`SELECT pg_notify('${DEFERRED_CHANNEL}', '{}')`)
      })
    },

    async releaseClaim (msg) {
      // The dispatch task threw without recording an outcome, so the claim has
      // to go back before the transport re-offers the message: a redelivery
      // would otherwise lose claimForDispatch (the row is still 'delivered')
      // and be acked without ever executing, leaving recovery to the
      // 15-minute reclaimer. Attempts are untouched, since no delivery
      // actually happened.
      await pool.query(
        `UPDATE workflow_queue_messages
         SET status = 'pending', delivered_at = NULL, updated_at = NOW()
         WHERE id = $1 AND application_id = $2 AND status = 'delivered'`,
        [msg.id, msg.application_id]
      )
    },

    async scheduleRetry (msg, delayMs, failure) {
      await pool.query(
        `UPDATE workflow_queue_messages
         SET status = 'failed', attempts = $4, last_failure = $5,
             next_retry_at = NOW() + make_interval(secs => $6), updated_at = NOW()
         WHERE id = $1 AND application_id = $2 AND attempts = $3`,
        [msg.id, msg.application_id, msg.attempts, msg.attempts + 1, failure, delayMs / 1000]
      )
    },

    async deadLetter (msg, failure, f) {
      await inTransaction(async (client) => {
        await f.lock(client, msg)
        const updated = await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'dead', attempts = $4, last_failure = $5, dead_at = NOW(),
               failure_finalized_at = NOW(), next_retry_at = NULL, updated_at = NOW()
           WHERE id = $1 AND application_id = $2 AND attempts = $3 AND status != 'dead'
           RETURNING id`,
          [msg.id, msg.application_id, msg.attempts, msg.attempts + 1, failure]
        )
        if (updated.rows.length > 0) await f.finalize(client, msg, failure)
      })
    },

    async promoteDue () {
      await pool.query(
        `UPDATE workflow_queue_messages
         SET status = 'pending', updated_at = NOW(), published_at = NULL, published_to = NULL
         WHERE status = 'deferred' AND deliver_at <= NOW()`
      )
      await pool.query(
        `UPDATE workflow_queue_messages
         SET status = 'pending', updated_at = NOW(), published_at = NULL, published_to = NULL
         WHERE status = 'failed' AND next_retry_at <= NOW() AND attempts < $1`,
        [MAX_ATTEMPTS]
      )
    },

    async nextWakeupMs () {
      const result = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (MIN(next_time) - NOW())) AS secs
         FROM (
           SELECT deliver_at AS next_time FROM workflow_queue_messages
             WHERE status = 'deferred' AND deliver_at > NOW()
           UNION ALL
           SELECT next_retry_at AS next_time FROM workflow_queue_messages
             WHERE status = 'failed' AND next_retry_at > NOW() AND attempts < $1
         ) t`,
        [MAX_ATTEMPTS]
      )
      const secs = result.rows[0]?.secs
      if (secs === null || secs === undefined) return null
      return Math.max(Math.ceil(Number(secs) * 1000), 50)
    },

    async claimExhausted (limit) {
      const { rows } = await pool.query(
        `SELECT * FROM workflow_queue_messages
         WHERE status = 'failed' AND attempts >= $1
         ORDER BY created_at ASC
         LIMIT $2`,
        [MAX_ATTEMPTS, limit]
      )
      return rows as QueueMessage[]
    },

    async finalizeExhausted (msg, f) {
      const failure: FailureDetail = msg.last_failure || {
        code: 'RETRY_EXHAUSTED',
        message: 'Queue delivery exhausted all retry attempts',
        at: new Date().toISOString(),
        attempt: msg.attempts,
        target: { queueName: msg.queue_name, deploymentVersion: msg.deployment_version },
      }
      await inTransaction(async (client) => {
        await f.lock(client, msg)
        const updated = await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'dead', last_failure = $4, dead_at = NOW(), failure_finalized_at = NOW(),
               next_retry_at = NULL, updated_at = NOW()
           WHERE id = $1 AND application_id = $2 AND status = 'failed' AND attempts = $3
           RETURNING id`,
          [msg.id, msg.application_id, msg.attempts, failure]
        )
        if (updated.rows.length > 0) await f.finalize(client, msg, failure)
      })
    },

    async reclaimExpired () {
      const client = await pool.connect()
      try {
        return await reclaimExpiredDeliveries(client, log, VISIBILITY_TIMEOUT_S)
      } finally {
        client.release()
      }
    },

    async takeUnpublished (limit) {
      // Not yet handed over at all, or handed to a different transport than the
      // one running now. The second case is a driver change: those rows were
      // marked published against a broker that no longer carries them, so they
      // have to go again or they are never delivered.
      const { rows } = await pool.query(
        `SELECT id, queue_name, payload, payload_bytes, payload_encoding
         FROM workflow_queue_messages
         WHERE status = 'pending'
           AND (published_at IS NULL OR published_to IS DISTINCT FROM $2)
         ORDER BY created_at ASC
         LIMIT $1`,
        [limit, transportName]
      )
      return rows.map(r => ({
        messageId: r.id as MessageId,
        queueName: r.queue_name,
        payload: r.payload,
        payloadBytes: r.payload_bytes,
        payloadEncoding: r.payload_encoding,
      })) as OutboxEntry[]
    },

    async markPublished (messageId) {
      await pool.query(
        'UPDATE workflow_queue_messages SET published_at = NOW(), published_to = $2 WHERE id = $1',
        [messageId, transportName]
      )
    },
  }
}

// Exported for direct testing; the store calls it through reclaimExpired().
export async function reclaimExpiredDeliveries (
  client: pg.PoolClient,
  log: any,
  visibilityTimeoutS: number = VISIBILITY_TIMEOUT_S
): Promise<number> {
  try {
    // Under the retry ceiling: hand it back to the poller for another attempt.
    const reclaimed = await client.query(
      `UPDATE workflow_queue_messages m
       SET status = 'pending', attempts = m.attempts + 1,
           delivered_at = NULL, updated_at = NOW(), published_at = NULL, published_to = NULL
       FROM workflow_runs r
       WHERE m.run_id = r.id
         AND m.status = 'delivered'
         AND m.delivered_at < NOW() - make_interval(secs => $1)
         AND r.status IN ('pending', 'running')
         AND m.attempts < $2
       RETURNING m.id, m.run_id, m.queue_name, m.attempts`,
      [visibilityTimeoutS, MAX_ATTEMPTS]
    )

    if (reclaimed.rows.length > 0) {
      log.warn(
        { count: reclaimed.rows.length, visibilityTimeoutS },
        'Reclaimed delivered messages whose executor never reported back'
      )
    }

    // At the ceiling there is nothing left to retry, so finalize rather than
    // leave the run running forever.
    const exhausted = await client.query(
      `SELECT m.id, m.run_id, m.application_id, m.queue_name, m.deployment_version, m.attempts
       FROM workflow_queue_messages m
       JOIN workflow_runs r ON r.id = m.run_id
       WHERE m.status = 'delivered'
         AND m.delivered_at < NOW() - make_interval(secs => $1)
         AND r.status IN ('pending', 'running')
         AND m.attempts >= $2
       LIMIT 10`,
      [visibilityTimeoutS, MAX_ATTEMPTS]
    )

    for (const msg of exhausted.rows) {
      await client.query('BEGIN')
      try {
        const failure = failureDetail(
          msg, msg.attempts, 'DELIVERY_TIMEOUT',
          `Message delivered but never acknowledged within ${visibilityTimeoutS}s, and retries are exhausted`
        )
        await lockRunForFailureFinalization(client, msg)
        await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'dead', last_failure = $3, dead_at = NOW(),
               failure_finalized_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND application_id = $2 AND status = 'delivered'`,
          [msg.id, msg.application_id, failure]
        )
        await failRun(client, msg, failure)
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    }
    return reclaimed.rows.length
  } catch (err) {
    log.error({ err }, 'Delivery reclaim error')
    return 0
  }
}
