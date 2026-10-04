// The default transport: Postgres carries the messages too.
//
// Degenerate by design. Store and transport are the same system here, so
// publish is a no-op and receive reads the ready ids the store already has.
// The message's real lease is the store's claimForDispatch, which is true for
// every transport; what this tracks in `leased` is only which ids have been
// handed to a dispatch task in this process, so one poll cycle does not hand
// the same id out twice.
//
// It exists so the boundary in ../transport.ts is honest rather than
// hypothetical: everything a remote broker would have to do is already routed
// through these five methods, and nothing else in the service reaches past
// them.

import type pg from 'pg'
import type { BrokerTransport, LeasedMessage } from '../transport.ts'
import type { MessageId, QueueStore } from '../store.ts'

const DEFERRED_CHANNEL = 'deferred_messages'

export function createPostgresTransport (
  store: QueueStore, connectionString: string, log: any
): BrokerTransport {
  let listenClient: pg.Client | null = null
  let stopped = false
  // Ids handed out by receive() and not yet acked. Postgres has no visibility
  // timeout of its own at this layer, so this keeps one poll cycle from handing
  // the same id to two dispatch tasks; a crash simply forgets it, and the
  // store's reclaimExpired covers the message.
  const leased = new Set<MessageId>()

  function forget (leaseId: string): void {
    leased.delete(leaseId)
    const asNumber = Number(leaseId)
    if (!Number.isNaN(asNumber)) leased.delete(asNumber)
  }

  return {
    name: 'postgres',

    async publish () {
      // Nothing to hand over: the store and the transport are the same system.
      // The relay still calls this and then stamps published_at, so every
      // producer goes through one path and none can be forgotten.
    },

    async receive (max: number): Promise<LeasedMessage[]> {
      const ids = await store.readyMessageIds(max, Array.from(leased))
      for (const id of ids) leased.add(id)
      return ids.map(messageId => ({ messageId, leaseId: String(messageId) }))
    },

    async ack (leaseId: string) {
      forget(leaseId)
    },

    async release (leaseId: string) {
      // Postgres has no visibility timeout at this layer, so a lease that is
      // never released is excluded from receive() for the life of the process,
      // even after the store hands the row back to 'pending'.
      forget(leaseId)
    },

    async subscribe (onWake: () => void) {
      const pgMod = (await import('pg')).default
      const connect = (): void => {
        listenClient = new pgMod.Client({ connectionString })
        listenClient.on('error', (err: any) => {
          log.error({ err }, 'LISTEN connection error')
          if (!stopped) setTimeout(connect, 1000)
        })
        listenClient.connect()
          .then(() => listenClient!.query(`LISTEN "${DEFERRED_CHANNEL}"`))
          .then(() => { log.info({ channel: DEFERRED_CHANNEL }, 'Listening to notification channel') })
          .catch((err: any) => {
            log.error({ err }, 'Failed to setup LISTEN connection')
            if (!stopped) setTimeout(connect, 1000)
          })
        listenClient.on('notification', () => onWake())
      }
      connect()
    },

    async close () {
      stopped = true
      leased.clear()
      if (listenClient) {
        listenClient.end().catch(() => {})
        listenClient = null
      }
    },
  }
}
