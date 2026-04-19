import { Readable } from 'node:stream'
import type { HttpClient } from './client.ts'
import type { GetChunksOptions, StreamChunksResponse, StreamInfoResponse } from '@workflow/world'

export function createStreamer (client: HttpClient) {
  const streams = {
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
      const web = Readable.toWeb(readable) as ReadableStream<Uint8Array>
      // Buffers from undici use a shared ArrayBuffer pool whose memory is
      // not detachable. Downstream, the SDK enqueues into a ReadableByte-
      // Stream which calls ArrayBuffer.transfer(), and a pooled buffer
      // throws "ArrayBuffer is not detachable". Copy each chunk into a
      // standalone ArrayBuffer at the boundary.
      return web.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform (chunk, controller) {
          const copy = new Uint8Array(chunk.byteLength)
          copy.set(chunk)
          controller.enqueue(copy)
        },
      }))
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
        data: result.data.map((chunk: { index: number; data: string }) => {
          const src = Buffer.from(chunk.data, 'base64')
          const copy = new Uint8Array(src.byteLength)
          copy.set(src)
          return { index: chunk.index, data: copy }
        }),
      }
    },

    async getInfo (runId: string, name: string): Promise<StreamInfoResponse> {
      return client.get(`/runs/${runId}/streams/${name}/info`)
    },
  }

  // v4.1.1 stable is the primary type target — its `Streamer` interface
  // uses flat methods with (name, runId) argument order. The nested
  // `streams.*` object is kept as a runtime-only addition so callers on
  // @workflow/core@5.x (which expects `streams.*` with (runId, name))
  // still work without an SDK downgrade.
  return {
    streams,
    async writeToStream (name: string, runId: string, chunk: string | Uint8Array): Promise<void> {
      return streams.write(runId, name, chunk)
    },
    async writeToStreamMulti (name: string, runId: string, chunks: (string | Uint8Array)[]): Promise<void> {
      return streams.writeMulti(runId, name, chunks)
    },
    async closeStream (name: string, runId: string): Promise<void> {
      return streams.close(runId, name)
    },
    async readFromStream (name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      return streams.get('', name, startIndex)
    },
    async listStreamsByRunId (runId: string): Promise<string[]> {
      return streams.list(runId)
    },
    async getStreamChunks (name: string, runId: string, options?: GetChunksOptions): Promise<StreamChunksResponse> {
      return streams.getChunks(runId, name, options)
    },
    async getStreamInfo (name: string, runId: string): Promise<StreamInfoResponse> {
      return streams.getInfo(runId, name)
    },
  }
}
