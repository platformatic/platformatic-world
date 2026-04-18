import { Readable } from 'node:stream'
import type { HttpClient } from './client.ts'
import type { GetChunksOptions, StreamChunksResponse, StreamInfoResponse } from '@workflow/world'

export function createStreamer (client: HttpClient) {
  return {
    streams: {
      async write (runId: string, name: string, chunk: string | Uint8Array): Promise<void> {
        const data = Buffer.from(chunk).toString('base64')
        await client.put(`/runs/${runId}/streams/${name}`, { data })
      },

      async writeMulti (runId: string, name: string, chunks: (string | Uint8Array)[]): Promise<void> {
        const encoded = chunks.map(chunk =>
          typeof chunk === 'string'
            ? { data: chunk, type: 'string' }
            : { data: Buffer.from(chunk).toString('base64'), type: 'binary' }
        )
        await client.put(`/runs/${runId}/streams/${name}`, encoded, {
          'x-stream-multi': 'true',
        })
      },

      async close (runId: string, name: string): Promise<void> {
        await client.put(`/runs/${runId}/streams/${name}`, {}, {
          'x-stream-done': 'true',
        })
      },

      async get (_runId: string, name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
        const query: Record<string, string> = { stream: 'true' }
        if (startIndex !== undefined) {
          query.startIndex = String(startIndex)
        }
        const readable = await client.getStream(`/streams/${name}`, query)
        return Readable.toWeb(readable) as ReadableStream<Uint8Array>
      },

      async list (runId: string): Promise<string[]> {
        return client.get(`/runs/${runId}/streams`)
      },

      async getChunks (runId: string, name: string, options?: GetChunksOptions): Promise<StreamChunksResponse> {
        const query: Record<string, string> = {}
        if (options?.limit !== undefined) query.limit = String(options.limit)
        if (options?.cursor !== undefined) query.cursor = String(options.cursor)
        const result = await client.get(`/runs/${runId}/streams/${name}/chunks`, query)
        return {
          ...result,
          data: result.data.map((chunk: { index: number; data: string }) => ({
            index: chunk.index,
            data: new Uint8Array(Buffer.from(chunk.data, 'base64')),
          })),
        }
      },

      async getInfo (runId: string, name: string): Promise<StreamInfoResponse> {
        return client.get(`/runs/${runId}/streams/${name}/info`)
      },
    },
  }
}
