// The durable record of every queue message.
//
// Always Postgres, whatever carries the bytes. Scheduling, dedupe, status,
// attempt counts and dead letters live here because they are workflow
// semantics, not broker operations: a sleep() can outlive any broker's delay
// ceiling, the dead-letter admin API has to work the same regardless of
// transport, and dead-lettering a message has to commit in the same
// transaction as failing the run it belongs to.
//
// Keeping these out of the transport contract is deliberate. A Redis or SQS
// backend implements BrokerTransport (./transport.ts) and nothing here, so it
// never has to grow a notion of a run, an attempt ceiling, or a finalizer.

import type { FailureDetail } from './delivery.ts'

export type MessageId = number | string

// The shape the rest of the service reads. Snake_case because delivery.ts, the
// dispatcher and the dead-letter API already speak it.
export interface QueueMessage {
  id: MessageId
  application_id: number
  queue_name: string
  run_id: string | null
  deployment_version: string
  payload: unknown
  payload_bytes: Buffer | null
  payload_encoding: 'json' | 'cbor'
  attempts: number
  last_failure?: FailureDetail | null
}

export interface EnqueueRequest {
  queueName: string
  applicationId: number
  runId: string
  deploymentVersion: string
  payload: unknown
  payloadBytes: Buffer | null
  payloadEncoding: 'json' | 'cbor'
  idempotencyKey?: string | null
  delaySeconds?: number
}

// The workflow-domain half of a terminal failure, in two phases so a store can
// preserve lock ordering: `lock` runs before the message row is updated (it
// takes the run row, which is the order the queue has always used and which
// keeps concurrent finalizations from deadlocking), `finalize` runs after, and
// only when this caller actually won the update.
export interface FailureFinalizer {
  lock (client: any, msg: QueueMessage): Promise<void>
  finalize (client: any, msg: QueueMessage, failure: FailureDetail): Promise<void>
}

// One entry the outbox relay still has to hand to a remote broker. Empty for
// the Postgres transport, where the row and its publication commit together.
export interface OutboxEntry {
  messageId: MessageId
  queueName: string
  payload: unknown
  payloadBytes: Buffer | null
  payloadEncoding: 'json' | 'cbor'
}

export interface QueueStore {
  enqueue (req: EnqueueRequest): Promise<{ messageId: MessageId, ready: boolean }>

  // Candidate messages that are ready to run. Returns ids only: whether a
  // message may actually be dispatched is decided by claimForDispatch.
  readyMessageIds (limit: number, excludeIds: MessageId[]): Promise<MessageId[]>

  // The redelivery gate, and the real lease. Compare-and-set ready -> delivered.
  // Returns null when the message is no longer dispatchable (already delivered,
  // dead, or failed), which is what makes a duplicate broker delivery harmless:
  // it can never reach the workflow handler.
  claimForDispatch (messageId: MessageId): Promise<QueueMessage | null>

  // Delivery succeeded. Must move the message to a terminal state: a claimed
  // message sits in 'delivered' and reclaimExpired treats anything still there
  // past the visibility timeout as an executor that died, so a success left in
  // 'delivered' would be redispatched 15 minutes later against a live run.
  // `continuation` re-publishes the same payload when the handler asked to be
  // re-invoked (the 425 retryAfter path); 0 means now.
  ack (msg: QueueMessage, continuation?: { delaySeconds: number }): Promise<void>

  // Undo a claim whose dispatch task threw before recording any outcome, so
  // the message is immediately claimable again rather than waiting on
  // reclaimExpired. Must be called before releasing the transport lease.
  releaseClaim (msg: QueueMessage): Promise<void>

  scheduleRetry (msg: QueueMessage, delayMs: number, failure: FailureDetail): Promise<void>
  deadLetter (msg: QueueMessage, failure: FailureDetail, f: FailureFinalizer): Promise<void>

  // Deferred and retry-due messages that are now ready.
  promoteDue (): Promise<void>
  nextWakeupMs (): Promise<number | null>

  // Messages past the retry ceiling, awaiting finalization.
  claimExhausted (limit: number): Promise<QueueMessage[]>
  finalizeExhausted (msg: QueueMessage, f: FailureFinalizer): Promise<void>

  // Redeliver messages whose consumer took the lease and never reported back.
  reclaimExpired (): Promise<number>

  // Outbox: committed but not yet handed to the broker. See
  // QUEUE-PLUGGABILITY.md, "The dual write, and the outbox that resolves it".
  takeUnpublished (limit: number): Promise<OutboxEntry[]>
  markPublished (messageId: MessageId): Promise<void>
}

declare module 'fastify' {
  interface FastifyInstance {
    queueStore: QueueStore
  }
}
