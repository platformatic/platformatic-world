import type pg from 'pg'
import { routeMessage } from './router.ts'
import { dispatchMessage } from './dispatcher.ts'
import { getRetryDelay, isMaxAttempts } from './retry.ts'

const POLL_INTERVAL = 5_000 // 5 seconds

export function createPoller (pool: pg.Pool) {
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function poll (): Promise<void> {
    if (running) return
    running = true

    const client = await pool.connect()
    try {
      // Try to acquire advisory lock (only one poller should run)
      const lockResult = await client.query('SELECT pg_try_advisory_lock(42424242)')
      if (!lockResult.rows[0].pg_try_advisory_lock) {
        return // Another instance is polling
      }

      try {
        // 1. Promote deferred messages that are due
        const promoted = await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'pending'
           WHERE status = 'deferred' AND deliver_at <= NOW()
           RETURNING *`
        )

        // 2. Retry failed messages that are due
        const retries = await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'pending'
           WHERE status = 'failed' AND next_retry_at <= NOW() AND attempts < 10
           RETURNING *`
        )

        // 3. Dispatch all pending messages
        const pending = await client.query(
          `SELECT * FROM workflow_queue_messages
           WHERE status = 'pending'
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 100`
        )

        for (const msg of pending.rows) {
          await dispatchSingleMessage(client, pool, msg)
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(42424242)')
      }
    } catch (err) {
      // Log but don't crash the poller
      console.error('Poller error:', err)
    } finally {
      client.release()
      running = false
    }
  }

  async function dispatchSingleMessage (client: pg.PoolClient, pool: pg.Pool, msg: any): Promise<void> {
    const route = await routeMessage(pool, msg.application_id, msg.deployment_version, msg.queue_name)

    if (!route) {
      // No handler or version expired
      if (isMaxAttempts(msg.attempts)) {
        await client.query(
          `UPDATE workflow_queue_messages SET status = 'dead', updated_at = NOW()
           WHERE id = $1`,
          [msg.id]
        )
      } else {
        const delay = getRetryDelay(msg.attempts)
        await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'failed', attempts = attempts + 1,
               next_retry_at = NOW() + make_interval(secs => $2)
           WHERE id = $1`,
          [msg.id, delay / 1000]
        )
      }
      return
    }

    const result = await dispatchMessage(
      route.url,
      msg.queue_name,
      msg.id,
      msg.payload,
      msg.attempts
    )

    if (result.success) {
      if (typeof result.timeoutSeconds === 'number' && result.timeoutSeconds > 0) {
        // Re-queue with delay (sleep/wait continuation)
        await client.query(
          `INSERT INTO workflow_queue_messages
           (queue_name, run_id, deployment_version, application_id, payload, status, deliver_at)
           VALUES ($1, $2, $3, $4, $5, 'deferred', NOW() + make_interval(secs => $6))`,
          [msg.queue_name, msg.run_id, msg.deployment_version, msg.application_id,
           JSON.stringify(msg.payload), result.timeoutSeconds]
        )
      }
      await client.query(
        `UPDATE workflow_queue_messages SET status = 'delivered', delivered_at = NOW()
         WHERE id = $1`,
        [msg.id]
      )
    } else {
      const attempts = msg.attempts + 1
      if (isMaxAttempts(attempts)) {
        await client.query(
          `UPDATE workflow_queue_messages SET status = 'dead', attempts = $2
           WHERE id = $1`,
          [msg.id, attempts]
        )
      } else {
        const delay = getRetryDelay(attempts)
        await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'failed', attempts = $2,
               next_retry_at = NOW() + make_interval(secs => $3)
           WHERE id = $1`,
          [msg.id, attempts, delay / 1000]
        )
      }
    }
  }

  return {
    start () {
      if (timer) return
      timer = setInterval(poll, POLL_INTERVAL)
      // Run immediately on start
      poll()
    },
    stop () {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
