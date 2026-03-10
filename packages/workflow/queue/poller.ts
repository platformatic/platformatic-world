import pg from 'pg'
import { routeMessage } from './router.ts'
import { dispatchMessage, type DispatchResult } from './dispatcher.ts'
import { getRetryDelay, isMaxAttempts } from './retry.ts'

const ORPHAN_CHECK_INTERVAL = 60_000 // 60 seconds

export function createPoller (pool: pg.Pool) {
  let stopped = false
  let deferredTimer: ReturnType<typeof setTimeout> | null = null
  let orphanTimer: ReturnType<typeof setInterval> | null = null
  let listenClient: pg.Client | null = null
  let executing = false
  let pendingNotify = false

  async function execute (): Promise<void> {
    if (stopped) return

    if (executing) {
      pendingNotify = true
      return
    }
    executing = true

    try {
      await executeOnce()
    } finally {
      executing = false
      // If a NOTIFY arrived during execution, re-run to pick up new messages
      if (pendingNotify && !stopped) {
        pendingNotify = false
        setImmediate(() => execute())
      }
    }
  }

  async function executeOnce (): Promise<void> {
    const client = await pool.connect()
    try {
      const lockResult = await client.query('SELECT pg_try_advisory_lock(42424242)')
      if (!lockResult.rows[0].pg_try_advisory_lock) {
        return
      }

      try {
        // 1. Promote deferred messages that are due
        await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'pending'
           WHERE status = 'deferred' AND deliver_at <= NOW()`
        )

        // 2. Retry failed messages that are due
        await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'pending'
           WHERE status = 'failed' AND next_retry_at <= NOW() AND attempts < 10`
        )

        // 3. Dispatch all pending messages
        const pending = await client.query(
          `SELECT * FROM workflow_queue_messages
           WHERE status = 'pending'
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 100`
        )

        // Dispatch all messages concurrently (HTTP calls in parallel)
        // then process results sequentially (DB updates on same client)
        const dispatchResults = await Promise.all(
          pending.rows.map(async (msg: any) => {
            const route = await routeMessage(pool, msg.application_id, msg.deployment_version, msg.queue_name)
            if (!route) {
              return { msg, route: null, result: null }
            }
            const result = await dispatchMessage(
              route.url, msg.queue_name, msg.id, msg.payload, msg.attempts
            )
            console.log(`[POLLER] dispatched msgId=${msg.id} queue=${msg.queue_name} status=${result.statusCode} timeoutSeconds=${result.timeoutSeconds} success=${result.success}`)
            return { msg, route, result }
          })
        )

        for (const { msg, route, result } of dispatchResults) {
          if (!route || !result) {
            await handleNoRoute(client, msg)
            continue
          }
          await handleDispatchResult(client, msg, result)
        }

        // 4. Schedule next wake-up based on earliest deferred message
        scheduleNextWakeup(pool)
      } finally {
        await client.query('SELECT pg_advisory_unlock(42424242)')
      }
    } catch (err) {
      console.error('Executor error:', err)
    } finally {
      client.release()
    }
  }

  async function checkOrphans (): Promise<void> {
    if (stopped) return

    const client = await pool.connect()
    try {
      const lockResult = await client.query('SELECT pg_try_advisory_lock(42424242)')
      if (!lockResult.rows[0].pg_try_advisory_lock) {
        return
      }

      try {
        const orphans = await client.query(
          `SELECT id, application_id, deployment_id FROM workflow_runs
           WHERE status = 'running'
             AND updated_at < NOW() - INTERVAL '15 minutes'
             AND id NOT IN (
               SELECT DISTINCT run_id FROM workflow_queue_messages
               WHERE status IN ('pending', 'deferred', 'failed')
             )
           LIMIT 10`
        )

        for (const orphan of orphans.rows) {
          await client.query(
            `UPDATE workflow_runs SET status = 'failed', error = $2, completed_at = NOW(), updated_at = NOW()
             WHERE id = $1`,
            [orphan.id, JSON.stringify({ message: 'Run orphaned: no activity for 15 minutes', code: 'ORPHANED' })]
          )
          await client.query(
            `INSERT INTO workflow_events (run_id, application_id, event_type, event_data)
             VALUES ($1, $2, 'run_failed', NULL)`,
            [orphan.id, orphan.application_id]
          )
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(42424242)')
      }
    } catch (err) {
      console.error('Orphan check error:', err)
    } finally {
      client.release()
    }
  }

  async function scheduleNextWakeup (pool: pg.Pool): Promise<void> {
    if (stopped) return
    if (deferredTimer) {
      clearTimeout(deferredTimer)
      deferredTimer = null
    }

    try {
      const result = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (MIN(deliver_at) - NOW())) AS secs
         FROM workflow_queue_messages
         WHERE status = 'deferred' AND deliver_at > NOW()`
      )

      const secs = result.rows[0]?.secs
      if (secs !== null && secs !== undefined) {
        const ms = Math.max(Math.ceil(Number(secs) * 1000), 50)
        deferredTimer = setTimeout(() => {
          deferredTimer = null
          execute()
        }, ms)
      }
    } catch (err) {
      console.error('Schedule wakeup error:', err)
    }
  }

  async function setupListener (connectionString: string): Promise<void> {
    listenClient = new pg.Client({ connectionString })
    listenClient.on('error', (err) => {
      console.error('LISTEN connection error:', err)
      // Attempt reconnection
      if (!stopped) {
        setTimeout(() => setupListener(connectionString), 1000)
      }
    })

    await listenClient.connect()
    await listenClient.query('LISTEN deferred_messages')

    listenClient.on('notification', () => {
      // Wake up executor immediately on NOTIFY
      execute()
    })
  }

  async function handleNoRoute (client: pg.PoolClient, msg: any): Promise<void> {
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
  }

  async function handleDispatchResult (client: pg.PoolClient, msg: any, result: DispatchResult): Promise<void> {
    if (result.success) {
      if (typeof result.timeoutSeconds === 'number' && result.timeoutSeconds > 0) {
        const delaySecs = result.timeoutSeconds
        await client.query(
          `INSERT INTO workflow_queue_messages
           (queue_name, run_id, deployment_version, application_id, payload, status, deliver_at)
           VALUES ($1, $2, $3, $4, $5, 'deferred', NOW() + make_interval(secs => $6))`,
          [msg.queue_name, msg.run_id, msg.deployment_version, msg.application_id,
            JSON.stringify(msg.payload), delaySecs]
        )
        // NOTIFY so executor reschedules its timer
        await client.query("SELECT pg_notify('deferred_messages', '')")
      } else if (typeof result.timeoutSeconds === 'number' && result.timeoutSeconds === 0) {
        // Immediate re-dispatch (e.g. hook conflict) — insert as pending
        await client.query(
          `INSERT INTO workflow_queue_messages
           (queue_name, run_id, deployment_version, application_id, payload, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')`,
          [msg.queue_name, msg.run_id, msg.deployment_version, msg.application_id,
            JSON.stringify(msg.payload)]
        )
        await client.query("SELECT pg_notify('deferred_messages', '')")
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
    async start (connectionString?: string) {
      stopped = false

      // Set up LISTEN/NOTIFY if connection string provided
      if (connectionString) {
        try {
          await setupListener(connectionString)
        } catch (err) {
          console.error('Failed to setup LISTEN connection:', err)
        }
      }

      // Run immediately on start to catch up
      execute()

      // Periodic orphan detection
      orphanTimer = setInterval(checkOrphans, ORPHAN_CHECK_INTERVAL)
    },
    async stop () {
      stopped = true
      if (deferredTimer) {
        clearTimeout(deferredTimer)
        deferredTimer = null
      }
      if (orphanTimer) {
        clearInterval(orphanTimer)
        orphanTimer = null
      }
      if (listenClient) {
        try {
          await listenClient.end()
        } catch {
          // ignore close errors
        }
        listenClient = null
      }
    },
  }
}
