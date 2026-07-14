import pg from 'pg'
import createLeaderElector from '@platformatic/leader'
import { decode, encode } from 'cbor-x'
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

interface FailureDetail {
  code: string
  message: string
  at: string
  attempt: number
  statusCode?: number
  target: {
    queueName: string
    deploymentVersion: string
    url?: string
  }
}

interface RegisteredTarget {
  url: string
}

export function sanitizeTargetUrl (value: string): string | undefined {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().slice(0, 1024)
  } catch {
    return undefined
  }
}

function failureDetail (
  msg: any,
  attempt: number,
  code: string,
  message: string,
  target?: RegisteredTarget,
  statusCode?: number
): FailureDetail {
  return {
    code: code.slice(0, 64),
    message: message.slice(0, 512),
    at: new Date().toISOString(),
    attempt,
    ...(statusCode !== undefined ? { statusCode } : {}),
    target: {
      queueName: String(msg.queue_name).slice(0, 256),
      deploymentVersion: String(msg.deployment_version).slice(0, 256),
      ...(target?.url ? { url: sanitizeTargetUrl(target.url) } : {}),
    },
  }
}

function queuePayload (msg: any): any {
  return msg.payload_encoding === 'cbor' ? decode(msg.payload_bytes) : msg.payload
}

// A valid v5 devalue payload containing a plain diagnostic object. Keeping the
// user-facing error small avoids persisting transport response bodies or stacks.
function terminalError (failure: FailureDetail): Buffer {
  const value = [{ name: 1, message: 2, code: 3 }, 'QueueDeliveryError', failure.message, failure.code]
  return Buffer.from(`devl${JSON.stringify(value)}`)
}

function eventError (error: Buffer): Buffer {
  return Buffer.from(JSON.stringify({ error: error.toString('base64') }))
}

async function failRun (client: pg.PoolClient, msg: any, failure: FailureDetail): Promise<void> {
  const error = terminalError(failure)
  const failed = await client.query(
    `UPDATE workflow_runs
     SET status = 'failed', error = $3, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND application_id = $2 AND status IN ('pending', 'running')
     RETURNING id`,
    [msg.run_id, msg.application_id, error]
  )
  if (failed.rows.length === 0) return

  await client.query(
    `UPDATE workflow_hooks SET status = 'disposed', disposed_at = NOW()
     WHERE run_id = $1 AND application_id = $2 AND status != 'disposed'`,
    [msg.run_id, msg.application_id]
  )
  await client.query(
    `UPDATE workflow_waits SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE run_id = $1 AND application_id = $2 AND status = 'waiting'`,
    [msg.run_id, msg.application_id]
  )
  await client.query(
    `INSERT INTO workflow_events (run_id, application_id, event_type, event_data)
     SELECT $1::varchar, $2::integer, 'run_failed', $3
     WHERE NOT EXISTS (
       SELECT 1 FROM workflow_events
       WHERE run_id = $1 AND application_id = $2 AND event_type = 'run_failed'
     )`,
    [msg.run_id, msg.application_id, eventError(error)]
  )
}

async function ensureRunForWorkflowDelivery (client: pg.PoolClient, msg: any): Promise<void> {
  if (!msg.run_id) return
  let payload
  try {
    payload = queuePayload(msg)
  } catch {}
  const runInput = payload?.runInput
  const workflowName = typeof runInput?.workflowName === 'string'
    ? runInput.workflowName
    : msg.queue_name.slice('__wkf_workflow_'.length)
  const deploymentId = typeof runInput?.deploymentId === 'string'
    ? runInput.deploymentId
    : msg.deployment_version

  await client.query(
    `INSERT INTO workflow_runs
       (id, application_id, workflow_name, deployment_id, status, execution_context, spec_version)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [msg.run_id, msg.application_id, workflowName || 'unknown', deploymentId || 'unknown',
      runInput?.executionContext || null, runInput?.specVersion || null]
  )
}

async function failBackgroundStep (client: pg.PoolClient, msg: any, failure: FailureDetail): Promise<boolean> {
  let payload
  try {
    payload = queuePayload(msg)
  } catch {
    return false
  }
  if (!payload || typeof payload.stepId !== 'string') return false

  const step = await client.query(
    `SELECT s.id, s.status, r.workflow_name
     FROM workflow_steps s
     JOIN workflow_runs r ON r.id = s.run_id AND r.application_id = s.application_id
     WHERE s.run_id = $1 AND s.application_id = $2 AND s.correlation_id = $3
     FOR UPDATE OF s`,
    [msg.run_id, msg.application_id, payload.stepId]
  )
  // A valid background-step payload must never directly fail the whole run.
  // A missing/terminal step means another path already resolved its state.
  if (step.rows.length === 0 || ['completed', 'failed', 'cancelled'].includes(step.rows[0].status)) return true

  const error = terminalError(failure)
  await client.query(
    `UPDATE workflow_steps
     SET status = 'failed', error = $3, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND application_id = $2`,
    [step.rows[0].id, msg.application_id, error]
  )
  await client.query(
    `INSERT INTO workflow_events
       (run_id, application_id, event_type, correlation_id, event_data)
     VALUES ($1, $2, 'step_failed', $3, $4)`,
    [msg.run_id, msg.application_id, payload.stepId, eventError(error)]
  )

  const continuation = { runId: msg.run_id }
  const payloadJson = msg.payload_encoding === 'json' ? JSON.stringify(continuation) : null
  const payloadBytes = msg.payload_encoding === 'cbor' ? Buffer.from(encode(continuation)) : null
  await client.query(
    `INSERT INTO workflow_queue_messages
       (queue_name, run_id, deployment_version, application_id,
        payload, payload_bytes, payload_encoding, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
    [`__wkf_workflow_${step.rows[0].workflow_name}`, msg.run_id, msg.deployment_version,
      msg.application_id, payloadJson, payloadBytes, msg.payload_encoding]
  )
  await client.query("SELECT pg_notify('deferred_messages', '{}')")
  return true
}

async function terminalize (client: pg.PoolClient, msg: any, failure: FailureDetail): Promise<void> {
  // v5 dispatches background steps through the workflow queue, while v4 uses
  // a dedicated step queue. The payload is the authoritative discriminator.
  if (await failBackgroundStep(client, msg, failure)) return
  if (msg.queue_name.startsWith('__wkf_workflow_')) {
    await failRun(client, msg, failure)
  } else if (msg.queue_name.startsWith('__wkf_step_')) {
    await failRun(client, msg, failure)
  }
}

async function lockRunForTerminalization (client: pg.PoolClient, msg: any): Promise<void> {
  if (!msg.run_id) return
  if (msg.queue_name.startsWith('__wkf_workflow_')) await ensureRunForWorkflowDelivery(client, msg)
  await client.query(
    'SELECT id FROM workflow_runs WHERE id = $1 AND application_id = $2 FOR UPDATE',
    [msg.run_id, msg.application_id]
  )
}

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
      // 1. Terminalize rows left at the retry ceiling by older pollers.
      const exhausted = await client.query(
        `SELECT * FROM workflow_queue_messages
         WHERE status = 'failed' AND attempts >= 10
         ORDER BY created_at ASC
         LIMIT 100`
      )
      for (const msg of exhausted.rows) {
        await handleExhaustedMessage(client, msg)
      }

      // 2. Promote deferred messages that are due
      await client.query(
        `UPDATE workflow_queue_messages
         SET status = 'pending', updated_at = NOW()
         WHERE status = 'deferred' AND deliver_at <= NOW()`
      )

      // 3. Retry failed messages that are due
      await client.query(
        `UPDATE workflow_queue_messages
         SET status = 'pending', updated_at = NOW()
         WHERE status = 'failed' AND next_retry_at <= NOW() AND attempts < 10`
      )

      // 4. Claim pending messages (excluding those already in flight) and
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

      // 5. Schedule next wake-up based on earliest deferred/retry message
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
      try { await handleDispatchResult(client, msg, result, route) } finally { client.release() }
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
        await client.query('BEGIN')
        try {
          await client.query(
            'SELECT id FROM workflow_runs WHERE id = $1 AND application_id = $2 FOR UPDATE',
            [orphan.id, orphan.application_id]
          )
          const msg = {
            run_id: orphan.id,
            application_id: orphan.application_id,
            queue_name: '__wkf_workflow_orphaned',
            deployment_version: orphan.deployment_id,
          }
          await failRun(client, msg, failureDetail(msg, 0, 'ORPHANED', 'Run orphaned: no activity for 15 minutes'))
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK')
          throw err
        }
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

export async function handleExhaustedMessage (client: pg.PoolClient, msg: any): Promise<void> {
  const failure = msg.last_failure || failureDetail(
    msg,
    msg.attempts,
    'RETRY_EXHAUSTED',
    'Queue delivery exhausted all retry attempts'
  )

  await client.query('BEGIN')
  try {
    await lockRunForTerminalization(client, msg)
    const updated = await client.query(
      `UPDATE workflow_queue_messages
       SET status = 'dead', last_failure = $4, dead_at = NOW(), terminalized_at = NOW(),
           next_retry_at = NULL, updated_at = NOW()
       WHERE id = $1 AND application_id = $2 AND status = 'failed' AND attempts = $3
       RETURNING id`,
      [msg.id, msg.application_id, msg.attempts, failure]
    )
    if (updated.rows.length > 0) await terminalize(client, msg, failure)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

export async function handleNoRoute (client: pg.PoolClient, msg: any): Promise<void> {
  const attempts = msg.attempts + 1
  const failure = failureDetail(
    msg,
    attempts,
    'ROUTE_NOT_FOUND',
    'No registered target is available for this queue delivery'
  )

  await client.query('BEGIN')
  try {
    if (isMaxAttempts(attempts)) {
      await lockRunForTerminalization(client, msg)
      const updated = await client.query(
        `UPDATE workflow_queue_messages
         SET status = 'dead', attempts = $4, last_failure = $5, dead_at = NOW(),
             terminalized_at = NOW(), next_retry_at = NULL, updated_at = NOW()
         WHERE id = $1 AND application_id = $2 AND status = 'pending' AND attempts = $3
         RETURNING id`,
        [msg.id, msg.application_id, msg.attempts, attempts, failure]
      )
      if (updated.rows.length > 0) await terminalize(client, msg, failure)
    } else {
      const delay = getRetryDelay(attempts)
      await client.query(
        `UPDATE workflow_queue_messages
         SET status = 'failed', attempts = $4, last_failure = $5,
             next_retry_at = NOW() + make_interval(secs => $6), updated_at = NOW()
         WHERE id = $1 AND application_id = $2 AND status = 'pending' AND attempts = $3`,
        [msg.id, msg.application_id, msg.attempts, attempts, failure, delay / 1000]
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

export async function handleDispatchResult (
  client: pg.PoolClient,
  msg: any,
  result: DispatchResult,
  target?: RegisteredTarget
): Promise<void> {
  await client.query('BEGIN')
  try {
    if (result.success) {
      const delivered = await client.query(
        `UPDATE workflow_queue_messages
         SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND application_id = $2 AND status = 'pending' AND attempts = $3
         RETURNING id`,
        [msg.id, msg.application_id, msg.attempts]
      )

      if (delivered.rows.length > 0 && typeof result.timeoutSeconds === 'number') {
        const payloadJson = msg.payload_encoding === 'json' ? JSON.stringify(msg.payload) : null
        const payloadBytes = msg.payload_encoding === 'cbor' ? msg.payload_bytes : null
        if (result.timeoutSeconds > 0) {
          await client.query(
            `INSERT INTO workflow_queue_messages
               (queue_name, run_id, deployment_version, application_id,
                payload, payload_bytes, payload_encoding, status, deliver_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'deferred', NOW() + make_interval(secs => $8))`,
            [msg.queue_name, msg.run_id, msg.deployment_version, msg.application_id,
              payloadJson, payloadBytes, msg.payload_encoding, result.timeoutSeconds]
          )
          await client.query("SELECT pg_notify('deferred_messages', '{}')")
        } else if (result.timeoutSeconds === 0) {
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
      }
    } else {
      const attempts = msg.attempts + 1
      const error = result.error || { code: 'DISPATCH_ERROR', message: 'Target request failed' }
      const failure = failureDetail(msg, attempts, error.code, error.message, target, result.statusCode)

      if (isMaxAttempts(attempts)) {
        await lockRunForTerminalization(client, msg)
        const updated = await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'dead', attempts = $4, last_failure = $5, dead_at = NOW(),
               terminalized_at = NOW(), next_retry_at = NULL, updated_at = NOW()
           WHERE id = $1 AND application_id = $2 AND status = 'pending' AND attempts = $3
           RETURNING id`,
          [msg.id, msg.application_id, msg.attempts, attempts, failure]
        )
        if (updated.rows.length > 0) await terminalize(client, msg, failure)
      } else {
        const delay = getRetryDelay(attempts)
        await client.query(
          `UPDATE workflow_queue_messages
           SET status = 'failed', attempts = $4, last_failure = $5,
               next_retry_at = NOW() + make_interval(secs => $6), updated_at = NOW()
           WHERE id = $1 AND application_id = $2 AND status = 'pending' AND attempts = $3`,
          [msg.id, msg.application_id, msg.attempts, attempts, failure, delay / 1000]
        )
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}
