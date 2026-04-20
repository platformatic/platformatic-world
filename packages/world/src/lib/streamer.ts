import { Readable } from 'node:stream'
import type { HttpClient } from './client.ts'
import type { GetChunksOptions, StreamChunksResponse, StreamInfoResponse } from '@workflow/world'

// Canonical internals. Each method takes exactly the arguments its route
// needs — `read`'s route (`GET /streams/:name`) is scoped by name alone,
// so it carries no runId. Both public shapes below (v4 flat, v5 `streams.*`)
// delegate to these.
//
// Why two shapes? @workflow/core@5.x renamed the streamer namespace and
// flipped the runId/name argument order; @workflow/core@4.x still calls
// the flat methods. Supporting both SDKs at runtime is a deliberate
// concession so the world can be dropped into either SDK version.
export function createStreamer (client: HttpClient) {
  async function write (runId: string, name: string, chunk: string | Uint8Array): Promise<void> {
    const data = Buffer.from(chunk).toString('base64')
    await client.put(`/runs/${runId}/streams/${name}`, { data })
  }

  async function writeMulti (runId: string, name: string, chunks: (string | Uint8Array)[]): Promise<void> {
    const encoded = chunks.map(chunk =>
      typeof chunk === 'string'
        ? { data: chunk, type: 'string' }
        : { data: Buffer.from(chunk).toString('base64'), type: 'binary' }
    )
    await client.put(`/runs/${runId}/streams/${name}`, encoded, {
      'x-stream-multi': 'true',
    })
  }

  async function closeStream (runId: string, name: string): Promise<void> {
    await client.put(`/runs/${runId}/streams/${name}`, {}, {
      'x-stream-done': 'true',
    })
  }

  async function read (name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
    const query: Record<string, string> = { stream: 'true' }
    if (startIndex !== undefined) query.startIndex = String(startIndex)
    const readable = await client.getStream(`/streams/${name}`, query)
    const web = Readable.toWeb(readable) as ReadableStream<Uint8Array>
    // Undici hands us pool-backed Buffers whose ArrayBuffer can't be detached.
    // The SDK enqueues into a ReadableByteStream downstream which calls
    // ArrayBuffer.transfer() — on a pool buffer that throws. `new Uint8Array(chunk)`
    // allocates a standalone ArrayBuffer and copies, which is detachable.
    return web.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform (chunk, controller) {
        controller.enqueue(new Uint8Array(chunk))
      },
    }))
  }

  async function list (runId: string): Promise<string[]> {
    return client.get(`/runs/${runId}/streams`)
  }

  async function getChunks (runId: string, name: string, options?: GetChunksOptions): Promise<StreamChunksResponse> {
    const query: Record<string, string> = {}
    if (options?.limit !== undefined) query.limit = String(options.limit)
    if (options?.cursor !== undefined) query.cursor = String(options.cursor)
    const result = await client.get(`/runs/${runId}/streams/${name}/chunks`, query)
    return {
      ...result,
      data: result.data.map((chunk: { index: number; data: string }) => ({
        index: chunk.index,
        data: Buffer.from(chunk.data, 'base64'),
      })),
    }
  }

  async function getInfo (runId: string, name: string): Promise<StreamInfoResponse> {
    return client.get(`/runs/${runId}/streams/${name}/info`)
  }

  // v5 shape — `streams.*`, (runId, name, ...) argument order.
  // `streams.get` takes runId that the name-scoped route doesn't need; the
  // adapter swallows it rather than letting an unused arg leak into the impl.
  const streams = {
    write,
    writeMulti,
    close: closeStream,
    get: (_runId: string, name: string, startIndex?: number) => read(name, startIndex),
    list,
    getChunks,
    getInfo,
  }

  // v4 shape — flat methods, (name, runId, ...) argument order.
  return {
    streams,
    writeToStream: (name: string, runId: string, chunk: string | Uint8Array) => write(runId, name, chunk),
    writeToStreamMulti: (name: string, runId: string, chunks: (string | Uint8Array)[]) => writeMulti(runId, name, chunks),
    closeStream: (name: string, runId: string) => closeStream(runId, name),
    readFromStream: read,
    listStreamsByRunId: list,
    getStreamChunks: (name: string, runId: string, options?: GetChunksOptions) => getChunks(runId, name, options),
    getStreamInfo: (name: string, runId: string) => getInfo(runId, name),
  }
}
