import { HttpClient } from './lib/client.ts'
import type { ClientConfig } from './lib/client.ts'
import { createStorage } from './lib/storage.ts'
import { createQueue } from './lib/queue.ts'
import type { QueueConfig } from './lib/queue.ts'
import { createStreamer } from './lib/streamer.ts'
import { createEncryption } from './lib/encryption.ts'

export interface PlatformaticWorldConfig extends ClientConfig, QueueConfig {}

export function createPlatformaticWorld (config: PlatformaticWorldConfig) {
  const client = new HttpClient(config)

  return {
    ...createStorage(client),
    ...createQueue(client, config),
    ...createStreamer(client),
    getEncryptionKeyForRun: createEncryption(client),
    async close () {
      await client.close()
    },
  }
}

export { HttpClient } from './lib/client.ts'
export type { ClientConfig } from './lib/client.ts'
export type { QueueConfig } from './lib/queue.ts'
