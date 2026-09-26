// Drains the queue and delivers each message to the pod that should run it.
//
// Three collaborators, and the split matters:
//   - QueueStore (./store.ts)      durable state. Always Postgres.
//   - BrokerTransport (./transport.ts)  carries ready messages. Pluggable.
//   - the delivery policy below    routing, dispatch, retry, finalization. Ours.
//
// The Postgres pool is still a parameter, but only for the routing table:
// registered handlers are our data, not the broker's, whatever moves the bytes.

import type pg from 'pg'
import { routeMessage } from './router.ts'
import { dispatchMessage, type DispatchResult } from './dispatcher.ts'
import { getRetryDelay, isMaxAttempts } from './retry.ts'
import {
  failureDetail,
  finalizeFailure,
  lockRunForFailureFinalization,
  type RegisteredTarget,
} from './delivery.ts'
import type { FailureFinalizer, QueueMessage, QueueStore } from './store.ts'
import type { BrokerTransport } from './transport.ts'
import type { Coordinator } from './coordinator.ts'

// How often delivered-but-unacknowledged messages are reclaimed.
const RECLAIM_CHECK_INTERVAL = 60_000
// Safety-net poll interval. scheduleNextWakeup() is fire-and-forget so it does
// not block pendingNotify re-runs, which means two cycles can race and leave a
// due message with no timer pointing at it. This bounds how long that lasts.
const SAFETY_POLL_INTERVAL = 5_000
// Upper bound on dispatches in flight at once. Each is its own task, so one
// slow handler cannot block the loop; this just bounds concurrency.
const MAX_INFLIGHT = 200
// Outbox entries handed to the broker per cycle.
const RELAY_BATCH = 100

// The domain half of a terminal failure, handed to the store so it can run
// inside the transaction that records the dead letter.
export const failureFinalizer: FailureFinalizer = {
  lock: lockRunForFailureFinalization,
  finalize: finalizeFailure,
}

// No pod is registered for this message's deployment version, or that version
// expired. Retry under the ceiling, then give up: it can never be delivered to
// code that would understand it.
export async function onNoRoute (store: QueueStore, msg: QueueMessage): Promise<void> {
  const attempts = msg.attempts + 1
  const failure = failureDetail(
    msg, attempts, 'ROUTE_NOT_FOUND',
    'No registered target is available for this queue delivery'
  )
  if (isMaxAttempts(attempts)) await store.deadLetter(msg, failure, failureFinalizer)
  else await store.scheduleRetry(msg, getRetryDelay(attempts), failure)
}

export async function onDispatchResult (
  store: QueueStore,
  msg: QueueMessage,
  result: DispatchResult,
  target?: RegisteredTarget
): Promise<void> {
  if (result.success) {
    // A numeric timeoutSeconds means the handler asked to be called back: 0 for
    // immediately, more for a deferred re-invocation (the 425 retryAfter path).
    const continuation = typeof result.timeoutSeconds === 'number'
      ? { delaySeconds: result.timeoutSeconds }
      : undefined
    await store.ack(msg, continuation)
    return
  }

  const attempts = msg.attempts + 1
  const error = result.error || { code: 'DISPATCH_ERROR', message: 'Target request failed' }
  const failure = failureDetail(msg, attempts, error.code, error.message, target, result.statusCode)

  if (isMaxAttempts(attempts)) await store.deadLetter(msg, failure, failureFinalizer)
  else await store.scheduleRetry(msg, getRetryDelay(attempts), failure)
}

export function createPoller (
  store: QueueStore,
  transport: BrokerTransport,
  pool: pg.Pool,
  log: any,
  makeCoordinator: (onLeadershipChange: (isLeader: boolean) => void) => Coordinator
) {
  // Starts true: nothing is drained until the coordinator grants leadership, so
  // a wake-up that arrives before then is a no-op rather than an unelected poll.
  let stopped = true
  let deferredTimer: ReturnType<typeof setTimeout> | null = null
  let reclaimTimer: ReturnType<typeof setInterval> | null = null
  let safetyTimer: ReturnType<typeof setInterval> | null = null
  let executing = false
  let pendingNotify = false
  const inFlight = new Set<string>()

  const coordinator = makeCoordinator((isLeader: boolean) => {
    if (isLeader) startPolling()
    else stopPolling()
  })

  function startPolling (): void {
    stopped = false
    reclaimTimer = setInterval(runReclaim, RECLAIM_CHECK_INTERVAL)
    safetyTimer = setInterval(() => execute(), SAFETY_POLL_INTERVAL)
    execute()
  }

  function stopPolling (): void {
    stopped = true
    if (deferredTimer) { clearTimeout(deferredTimer); deferredTimer = null }
    if (reclaimTimer) { clearInterval(reclaimTimer); reclaimTimer = null }
    if (safetyTimer) { clearInterval(safetyTimer); safetyTimer = null }
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
    try {
      // 1. Finalize messages left at the retry ceiling.
      for (const msg of await store.claimExhausted(100)) {
        await store.finalizeExhausted(msg, failureFinalizer)
      }

      // 2. Promote deferred and retry-due messages.
      await store.promoteDue()

      // 3. Outbox relay: hand committed-but-unpublished messages to the broker.
      // Empty for the Postgres transport, where the two commit together.
      await relayOutbox()

      // 4. Take ready messages from the transport and dispatch each in its own
      // task. We do NOT await them: one slow handler must not block the loop.
      const capacity = MAX_INFLIGHT - inFlight.size
      if (capacity > 0) {
        for (const leased of await transport.receive(capacity)) {
          if (inFlight.has(leased.leaseId)) continue
          inFlight.add(leased.leaseId)
          processMessage(leased.messageId, leased.leaseId)
        }
      }

      // 5. Schedule the next wake-up. Fire-and-forget so pendingNotify re-runs
      // are not delayed behind it.
      scheduleNextWakeup()
    } catch (err) {
      log.error({ err }, 'Executor error')
    }
  }

  // Commit-then-publish. A crash before publishing leaves the entry for the next
  // cycle; a crash between publishing and marking republishes, which the
  // dispatch gate below makes harmless.
  async function relayOutbox (): Promise<void> {
    const entries = await store.takeUnpublished(RELAY_BATCH)
    for (const entry of entries) {
      try {
        await transport.publish(entry.messageId, entry)
        await store.markPublished(entry.messageId)
      } catch (err) {
        log.error({ err, messageId: entry.messageId }, 'Outbox publish failed; will retry')
        return
      }
    }
  }

  async function processMessage (messageId: QueueMessage['id'], leaseId: string): Promise<void> {
    let claimed: QueueMessage | null = null
    try {
      // The gate. Postgres decides whether this message may run, not the broker.
      // A redelivery of something already delivered, dead or failed loses the
      // compare-and-set and is dropped here, before it can reach the handler.
      const msg = await store.claimForDispatch(messageId)
      if (!msg) {
        await transport.ack(leaseId)
        return
      }
      claimed = msg

      const route = await routeMessage(pool, msg.application_id, msg.deployment_version, msg.queue_name)
      if (!route) {
        await onNoRoute(store, msg)
        await transport.ack(leaseId)
        return
      }

      const result = await dispatchMessage({
        url: route.url,
        queueName: msg.queue_name,
        messageId: msg.id as number,
        payload: msg.payload,
        payloadBytes: msg.payload_bytes,
        payloadEncoding: msg.payload_encoding,
        attempt: msg.attempts,
      })
      log.info(`[POLLER] dispatched msgId=${msg.id} queue=${msg.queue_name} encoding=${msg.payload_encoding} status=${result.statusCode} timeoutSeconds=${result.timeoutSeconds} success=${result.success}`)

      await onDispatchResult(store, msg, result, route)
      await transport.ack(leaseId)
    } catch (err) {
      // Nothing was recorded for this delivery, so hand the broker's copy back
      // rather than leaving it leased. The store still has the row as
      // 'delivered' and reclaimExpired is the backstop if the release is lost.
      log.error({ err, msgId: messageId }, 'Dispatch task error')
      // Return the claim first, then the lease. The other order re-offers a
      // message the store would still refuse to hand out.
      if (claimed) {
        await store.releaseClaim(claimed).catch((claimErr) => {
          log.error({ err: claimErr, msgId: messageId }, 'Failed to release queue claim')
        })
      }
      await transport.release(leaseId).catch((releaseErr) => {
        log.error({ err: releaseErr, msgId: messageId }, 'Failed to release queue lease')
      })
    } finally {
      inFlight.delete(leaseId)
      if (!stopped) execute()
    }
  }

  async function runReclaim (): Promise<void> {
    if (stopped) return
    try {
      const reclaimed = await store.reclaimExpired()
      if (reclaimed > 0) execute()
    } catch (err) {
      log.error({ err }, 'Delivery reclaim error')
    }
  }

  async function scheduleNextWakeup (): Promise<void> {
    if (stopped) return
    if (deferredTimer) {
      clearTimeout(deferredTimer)
      deferredTimer = null
    }
    try {
      const ms = await store.nextWakeupMs()
      if (ms !== null) {
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
      // Subscribed once, for the life of the process, not per leadership term.
      // Re-subscribing on every acquisition would leak a connection each time a
      // leader lost and regained the lock, and the wake-up itself is harmless
      // when this instance is not the leader: execute() returns early.
      transport.subscribe(() => execute()).catch((err) => {
        log.error({ err }, 'Failed to subscribe to queue notifications')
      })
      coordinator.start()
    },
    async stop () {
      stopped = true
      stopPolling()
      await transport.close()
      await coordinator.stop()
    },
  }
}
