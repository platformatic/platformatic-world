// Decides which process drains the queue.
//
// Postgres hands every replica the same table, so exactly one may poll it and
// leader election is required. A transport whose broker distributes work itself
// (an SQS queue, a Kafka consumer group) needs no election at all, and passes
// createAlwaysLeaderCoordinator. Keeping this out of the poller is what makes
// that a one-line change rather than a rewrite.

import createLeaderElector from '@platformatic/leader'
import type pg from 'pg'

const LEADER_LOCK_ID = 42424242

export interface Coordinator {
  start (): void
  stop (): Promise<void> | void
  isLeader (): boolean
}

// For a transport whose broker distributes work itself. It still has to
// announce leadership: the poller only starts draining when the callback says
// so, and a coordinator that never calls it would simply never consume.
export function createAlwaysLeaderCoordinator (
  onLeadershipChange: (isLeader: boolean) => void
): Coordinator {
  return {
    start () { onLeadershipChange(true) },
    stop () { onLeadershipChange(false) },
    isLeader: () => true,
  }
}

export function createPostgresCoordinator (
  pool: pg.Pool, log: any, onLeadershipChange: (isLeader: boolean) => void
): Coordinator {
  const leader = createLeaderElector({
    pool,
    // Leader election only -- dummy channel required by @platformatic/leader@0.1.0
    // TODO: remove channels once @platformatic/leader supports election-only mode
    channels: [],
    lock: LEADER_LOCK_ID,
    log,
    onLeadershipChange,
  })
  return {
    start: () => leader.start(),
    stop: () => leader.stop(),
    isLeader: () => leader.isLeader(),
  }
}
