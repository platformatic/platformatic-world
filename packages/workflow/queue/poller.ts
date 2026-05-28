import pg from 'pg'
import createLeaderElector from '@platformatic/leader'
import { routeMessage } from './router.ts'
import { dispatchMessage, type DispatchResult } from './dispatcher.ts'
import { getRetryDelay, isMaxAttempts } from './retry.ts'

const ORPHAN_CHECK_INTERVAL = 60_000
// Safety-net poll interval: scheduleNextWakeup() is fire-and-forget to avoid
// blocking pendingNotify re-runs. When multiple executeOnce() cycles run
// back-to-back, two concurrent scheduleNextWakeup() calls can race — the
// second clears the first's deferredTimer, then queries the DB after the
// deferred message's deliver_at has passed NOW(), finding nothing to schedule.
// The deferred message is stuck: deliver_at in the past but status still
// 'deferred', with no timer or notification to trigger promotion.
// This interval ensures executeOnce() runs periodically regardless, so any
// stuck deferred messages are promoted within a bounded time window.
const SAFETY_POLL_INTERVAL = 5_000
const LEADER_LOCK_ID = 42424242
const DEFERRED_CHANNEL = 'deferred_messages'
// Upper bound on dispatches in flight at once. Each dispatch is an independent
// task (see processMessage), so a single slow/hung handler can no longer block
// the poll loop; this cap just bounds concurrency and the in-flight set size.
const MAX_INFLIGHT = 200

export function createPoller (pool: pg.Pool, connectionString: string, log: any) {
  let stopped = false
  let deferredTimer: ReturnType<typeof setTimeout> | null = null
  let orphanTimer: ReturnType<typeof setInterval> | null = null
  let safetyTimer: ReturnType<typeof setInterval> | null = null
  let listenClient: pg.Client | null = null
  let executing = false
  let pendingNotify = false
  // Messages currently being dispatched in their own task. They stay 'pending'
  // in the DB until their task resolves, so a crash re-dispatches them; this set
  // just prevents the next poll from picking them up again while in flight.
  const inFlight = new Set<number>()

  // Leader election only — dummy channel required by @platformatic/leader@0.1.0
  // TODO: remove channels once @platformatic/leader supports election-only mode
  const leader = createLeaderElector({
    pool,
    lock: LEADER_LOCK_ID,
    log,
    channels: [],
    onLeadershipChange: (isLeader: boolean) => {
      if (isLeader) {
        startPolling()
      } else {
        stopPolling()
      }
    },
  })

  function startPolling (): void {
    stopped = false
    setupListener()
    orphanTimer = setInterval(checkOrphans, ORPHAN_CHECK_INTERVAL)
    safetyTimer = setInterval(() => execute(), SAFETY_POLL_INTERVAL)
    execute()
  }

  function stopPolling (): void {
    stopped = true
    if (deferredTimer) { clearTimeout(deferredTimer); deferredTimer = null }
    if (orphanTimer) { clearInterval(orphanTimer); orphanTimer = null }
    if (safetyTimer) { clearInterval(safetyTimer); safetyTimer = null }
    teardownListener()
  }

  // Dedicated LISTEN client — not from the pool
  function setupListener (): void {
    listenClient = new pg.Client({ connectionString })
    listenClient.on('error', (err) => {
      log.error({ err }, 'LISTEN connection error')
      if (!stopped && leader.isLeader()) {
        setTimeout(() => setupListener(), 1000)
      }
    })

    listenClient.connect()
      .then(() => listenClient!.query(`LISTEN "${DEFERRED_CHANNEL}"`))
      .then(() => {
        log.info({ channel: DEFERRED_CHANNEL }, 'Listening to notification channel')
      })
      .catch((err) => {
        log.error({ err }, 'Failed to setup LISTEN connection')
        if (!stopped && leader.isLeader()) {
          setTimeout(() => setupListener(), 1000)
        }
      })

    listenClient.on('notification', () => {
      execute()
    })
  }

  function teardownListener (): void {
    if (listenClient) {
      listenClient.end().catch(() => {})
      listenClient = null
    }
  }

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
      if (pendingNotify && !stopped) {
        pendingNotify = false
        setImmediate(() => execute())
      }
    }
  }

  async function executeOnce (): Promise<void> {
    const client = await pool.connect()
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

      // 3. Claim pending messages (excluding those already in flight) and
      // dispatch each in its own task. We do NOT await the dispatches here:
      // a single slow or hung handler must not block the poll loop (the
      // single-flight `executing` guard would otherwise freeze the whole queue
      // for up to the dispatch bodyTimeout). Each task updates its own message.
      const capacity = MAX_INFLIGHT - inFlight.size
      if (capacity > 0) {
        const inFlightIds = Array.from(inFlight)
        const pending = await client.query(
          `SELECT * FROM workflow_queue_messages
           WHERE status = 'pending' AND NOT (id = ANY($1::bigint[]))
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2`,
          [inFlightIds, capacity]
        )

        for (const msg of pending.rows) {
          if (inFlight.has(msg.id)) continue
          inFlight.add(msg.id)
          // Fire-and-forget: the task owns its message's result handling.
          processMessage(msg)
        }
      }

      // 4. Schedule next wake-up based on earliest deferred/retry message
      // Fire-and-forget: must not block executeOnce so pendingNotify re-runs
      // are not delayed, and so re-runs use their own pool connection for the query
      scheduleNextWakeup()
    } catch (err) {
      log.error({ err }, 'Executor error')
    } finally {
      client.release()
    }
  }

  // Dispatch a single message and persist its result on a dedicated client, so
  // a slow handler ties up only its own task (and one connection, briefly, for
  // the result write) rather than the shared poll loop. The message stays
  // 'pending' until this resolves; on completion it is removed from `inFlight`
  // so a failed dispatch is retried on the next poll.
  async function processMessage (msg: any): Promise<void> {
    try {
      const route = await routeMessage(pool, msg.application_id, msg.deployment_version, msg.queue_name)
      if (!route) {
        const client = await pool.connect()
        try { await handleNoRoute(client, msg) } finally { client.release() }
        return
      }

      const result = await dispatchMessage({
        url: route.url,
        queueName: msg.queue_name,
        messageId: msg.id,
        payload: msg.payload,
        payloadBytes: msg.payload_bytes,
        payloadEncoding: msg.payload_encoding,
        attempt: msg.attempts,
      })
      log.info(`[POLLER] dispatched msgId=${msg.id} queue=${msg.queue_name} encoding=${msg.payload_encoding} status=${result.statusCode} timeoutSeconds=${result.timeoutSeconds} success=${result.success}`)

      const client = await pool.connect()
      try { await handleDispatchResult(client, msg, result) } finally { client.release() }
    } catch (err) {
      // Leave the message 'pending'; removing it from inFlight (below) lets the
      // next poll retry it.
      log.error({ err, msgId: msg.id }, 'Dispatch task error')
    } finally {
      inFlight.delete(msg.id)
      // A slot freed up — nudge the poller in case messages are waiting.
      if (!stopped) execute()
    }
  }

  async function checkOrphans (): Promise<void> {
    if (stopped) return

    const client = await pool.connect()
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
    } catch (err) {
      log.error({ err }, 'Orphan check error')
    } finally {
      client.release()
    }
  }

  async function scheduleNextWakeup (): Promise<void> {
    if (stopped) return
    if (deferredTimer) {
      clearTimeout(deferredTimer)
      deferredTimer = null
    }

    try {
      const result = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (MIN(next_time) - NOW())) AS secs
         FROM (
           SELECT deliver_at AS next_time FROM workflow_queue_messages
             WHERE status = 'deferred' AND deliver_at > NOW()
           UNION ALL
           SELECT next_retry_at AS next_time FROM workflow_queue_messages
             WHERE status = 'failed' AND next_retry_at > NOW() AND attempts < 10
         ) t`
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
      log.error({ err }, 'Schedule wakeup error')
    }
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
      // Re-enqueue preserves the original encoding so the next dispatch
      // continues using the same Content-Type as the run's specVersion.
      const payloadJson = msg.payload_encoding === 'json' ? JSON.stringify(msg.payload) : null
      const payloadBytes = msg.payload_encoding === 'cbor' ? msg.payload_bytes : null

      if (typeof result.timeoutSeconds === 'number' && result.timeoutSeconds > 0) {
        const delaySecs = result.timeoutSeconds
        await client.query(
          `INSERT INTO workflow_queue_messages
           (queue_name, run_id, deployment_version, application_id,
            payload, payload_bytes, payload_encoding, status, deliver_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'deferred', NOW() + make_interval(secs => $8))`,
          [msg.queue_name, msg.run_id, msg.deployment_version, msg.application_id,
            payloadJson, payloadBytes, msg.payload_encoding, delaySecs]
        )
        await client.query("SELECT pg_notify('deferred_messages', '{}')")
      } else if (typeof result.timeoutSeconds === 'number' && result.timeoutSeconds === 0) {
        await client.query(
          `INSERT INTO workflow_queue_messages
           (queue_name, run_id, deployment_version, application_id,
            payload, payload_bytes, payload_encoding, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
          [msg.queue_name, msg.run_id, msg.deployment_version, msg.application_id,
            payloadJson, payloadBytes, msg.payload_encoding]
        )
        await client.query("SELECT pg_notify('deferred_messages', '{}')")
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
      stopped = false
      leader.start()
    },
    async stop () {
      stopped = true
      stopPolling()
      teardownListener()
      await leader.stop()
    },
  }
}
