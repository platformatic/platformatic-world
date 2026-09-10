// What actually carries a ready message to a consumer.
//
// This is the pluggable half, and the whole of it: a new backend implements
// these methods and nothing else. Nothing here knows what a run, an attempt
// ceiling or a deployment version is, because none of that is a broker's job.
// Scheduling, dedupe, status and dead letters stay in the QueueStore
// (./store.ts) for every transport.
//
// Delivery is at-least-once by construction. A transport may hand the same
// message over twice (a lost ack, an outbox relay that republished after
// crashing); QueueStore.claimForDispatch is the gate that makes that safe, so a
// transport is never required to deduplicate.

import type { MessageId } from './store.ts'

export interface LeasedMessage {
  messageId: MessageId
  // Opaque handle for acking this particular delivery. For a broker that has no
  // separate concept, the message id itself is a fine lease id.
  leaseId: string
}

export interface BrokerTransport {
  readonly name: string

  // Hand a committed message to the broker. Called by the outbox relay, never
  // in the enqueue transaction: the store commits first, then this publishes.
  // Must be idempotent on messageId, since the relay retries.
  publish (messageId: MessageId, entry: { queueName: string, payload: unknown, payloadBytes: Buffer | null, payloadEncoding: 'json' | 'cbor' }): Promise<void>

  // Take up to `max` messages for this consumer.
  receive (max: number): Promise<LeasedMessage[]>

  // This delivery is settled: its fate is recorded in the store, and the
  // broker's copy can go.
  ack (leaseId: string): Promise<void>

  // This delivery was NOT settled -- the consumer threw before recording an
  // outcome -- so the message must become available again. A broker with a
  // visibility timeout could reach the same state by doing nothing, but a
  // transport that tracks leases in memory has to be told, or the message is
  // stranded for the life of the process.
  release (leaseId: string): Promise<void>

  // Wake the poll loop when work arrives, where the transport can push. A
  // transport with no push support may return without subscribing; the poller
  // keeps its safety-net interval either way.
  subscribe (onWake: () => void): Promise<void>

  close (): Promise<void>
}
