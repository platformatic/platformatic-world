import { Readable } from 'node:stream'
import type { HttpClient } from './client.ts'

export function createStreamer (client: HttpClient) {
  return {
    async writeToStream (name: string, runId: string, chunk: string | Uint8Array): Promise<void> {
      const data = Buffer.from(chunk).toString('base64')
      await client.put(`/runs/${runId}/streams/${name}`, { data })
    },

    async writeToStreamMulti (name: string, runId: string, chunks: (string | Uint8Array)[]): Promise<void> {
      const encoded = chunks.map(chunk =>
        typeof chunk === 'string'
          ? { data: chunk, type: 'string' }
          : { data: Buffer.from(chunk).toString('base64'), type: 'binary' }
      )

      await client.put(`/runs/${runId}/streams/${name}`, encoded, {
        'x-stream-multi': 'true',
      })
    },

    async closeStream (name: string, runId: string): Promise<void> {
      await client.put(`/runs/${runId}/streams/${name}`, {}, {
        'x-stream-done': 'true',
      })
    },

    async readFromStream (name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      const query: Record<string, string> = { stream: 'true' }
      if (startIndex !== undefined) {
        query.startIndex = String(startIndex)
      }

      const readable = await client.getStream(`/streams/${name}`, query)
      return Readable.toWeb(readable) as ReadableStream<Uint8Array>
    },

    async listStreamsByRunId (runId: string): Promise<string[]> {
      return client.get(`/runs/${runId}/streams`)
    },
  }
}
