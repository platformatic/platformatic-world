// Selects the queue transport.
//
// WF_QUEUE_DRIVER names the transport; the store is always Postgres, because
// scheduling, dedupe, status and dead letters are workflow semantics rather
// than broker operations (see ../QUEUE-PLUGGABILITY.md). Unset means postgres,
// so an install that configures nothing keeps exactly the queue it has today.
//
// A backend brings its own coordinator, so adding a transport means adding a
// case here and nothing else. A broker that distributes work itself passes
// createAlwaysLeaderCoordinator from ./coordinator.ts as its makeCoordinator.

import type pg from 'pg'
import { createPostgresQueueStore } from './stores/postgres.ts'
import { createPostgresTransport } from './transports/postgres.ts'
import { createPostgresCoordinator, type Coordinator } from './coordinator.ts'
import type { QueueStore } from './store.ts'
import type { BrokerTransport } from './transport.ts'

export type CoordinatorFactory = (onLeadershipChange: (isLeader: boolean) => void) => Coordinator

export interface QueueBackend {
  driver: string
  store: QueueStore
  transport: BrokerTransport
  // Whether this backend needs an elected leader. Postgres does: every replica
  // sees the same table. A broker that distributes work itself does not, and
  // says so here rather than in the plugin, so registering a backend is the
  // only change a new transport requires.
  makeCoordinator: CoordinatorFactory
}

export const DEFAULT_QUEUE_DRIVER = 'postgres'

export function resolveQueueDriver (): string {
  return process.env.WF_QUEUE_DRIVER || DEFAULT_QUEUE_DRIVER
}

export function createQueueBackend (
  pool: pg.Pool, connectionString: string, log: any, driver = resolveQueueDriver()
): QueueBackend {
  switch (driver) {
    case 'postgres': {
      const store = createPostgresQueueStore(pool, log, driver)
      return {
        driver,
        store,
        transport: createPostgresTransport(store, connectionString, log),
        makeCoordinator: (onChange) => createPostgresCoordinator(pool, log, onChange),
      }
    }
    default:
      throw new Error(
        `Unknown WF_QUEUE_DRIVER ${JSON.stringify(driver)}. Supported: ${DEFAULT_QUEUE_DRIVER}`
      )
  }
}
