import fp from 'fastify-plugin'
import { EventEmitter } from 'node:events'
import pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { BadRequest } from '../lib/errors.ts'

function isHealthCheckStream (name: string): boolean {
  return name.startsWith('__health_check__')
}

async function streamsPlugin (app: FastifyInstance): Promise<void> {
  // Shared LISTEN client + EventEmitter for stream notifications
  const streamEvents = new EventEmitter()
  let listenClient: pg.Client | null = null

  // In-memory storage for health check streams (no real run_id, skip DB)
  const healthStreams = new Map<string, { chunks: Buffer[]; closed: boolean }>()

  async function setupListener (): Promise<void> {
    listenClient = new pg.Client({ connectionString: app.pgConnectionString })
    await listenClient.connect()
    await listenClient.query('LISTEN stream_update')
    listenClient.on('notification', (msg) => {
      if (msg.channel === 'stream_update' && msg.payload) {
        streamEvents.emit(msg.payload)
      }
    })
  }

  await setupListener()

  app.addHook('onClose', async () => {
    if (listenClient) {
      await listenClient.end()
      listenClient = null
    }
  })

  async function notifyStream (streamName: string): Promise<void> {
    if (isHealthCheckStream(streamName)) {
      // Health check streams are in-memory only — emit directly
      streamEvents.emit(streamName)
      return
    }
    await app.pg.query("SELECT pg_notify('stream_update', $1)", [streamName])
  }

  // Write chunk(s) to a stream
  app.put('/api/v1/apps/:appId/runs/:runId/streams/:name', async (request, reply) => {
    const { runId, name } = request.params as { runId: string; name: string }
    const appId = request.appId
    const isMulti = request.headers['x-stream-multi'] === 'true'
    const isDone = request.headers['x-stream-done'] === 'true'

    // Health check streams bypass the DB (no real run_id)
    if (isHealthCheckStream(name)) {
      if (!healthStreams.has(name)) {
        healthStreams.set(name, { chunks: [], closed: false })
      }
      const hs = healthStreams.get(name)!

      if (isDone) {
        hs.closed = true
      } else if (isMulti) {
        const chunks = request.body as any[]
        if (!Array.isArray(chunks)) throw new BadRequest('body must be an array for multi-write')
        for (const chunk of chunks) {
          const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk.data || chunk, 'base64')
          hs.chunks.push(data)
        }
      } else {
        const body = request.body as any
        const data = typeof body === 'string'
          ? Buffer.from(body, 'utf-8')
          : Buffer.isBuffer(body)
            ? body
            : Buffer.from(body.data || JSON.stringify(body), 'base64')
        hs.chunks.push(data)
      }

      await notifyStream(name)
      reply.code(204)
      return
    }

    if (isDone) {
      await app.pg.query(
        `INSERT INTO workflow_stream_chunks (stream_name, run_id, application_id, chunk_index, data, is_closed)
         VALUES ($1, $2, $3, -1, $4, TRUE)
         ON CONFLICT DO NOTHING`,
        [name, runId, appId, Buffer.alloc(0)]
      )
      await notifyStream(name)
      reply.code(204)
      return
    }

    if (isMulti) {
      const chunks = request.body as any[]
      if (!Array.isArray(chunks)) throw new BadRequest('body must be an array for multi-write')

      const maxResult = await app.pg.query(
        `SELECT COALESCE(MAX(chunk_index), -1) as max_idx FROM workflow_stream_chunks
         WHERE stream_name = $1 AND run_id = $2 AND application_id = $3 AND is_closed = FALSE`,
        [name, runId, appId]
      )
      let idx = maxResult.rows[0].max_idx + 1

      const client = await app.pg.connect()
      try {
        await client.query('BEGIN')
        for (const chunk of chunks) {
          const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk.data || chunk, 'base64')
          await client.query(
            `INSERT INTO workflow_stream_chunks (stream_name, run_id, application_id, chunk_index, data)
             VALUES ($1, $2, $3, $4, $5)`,
            [name, runId, appId, idx++, data]
          )
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    } else {
      const body = request.body as any
      const data = typeof body === 'string'
        ? Buffer.from(body, 'utf-8')
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(body.data || JSON.stringify(body), 'base64')

      const maxResult = await app.pg.query(
        `SELECT COALESCE(MAX(chunk_index), -1) as max_idx FROM workflow_stream_chunks
         WHERE stream_name = $1 AND run_id = $2 AND application_id = $3 AND is_closed = FALSE`,
        [name, runId, appId]
      )
      const idx = maxResult.rows[0].max_idx + 1

      await app.pg.query(
        `INSERT INTO workflow_stream_chunks (stream_name, run_id, application_id, chunk_index, data)
         VALUES ($1, $2, $3, $4, $5)`,
        [name, runId, appId, idx, data]
      )
    }

    await notifyStream(name)
    reply.code(204)
  })

  // Read stream chunks — streaming mode (stream=true) uses LISTEN/NOTIFY
  app.get('/api/v1/apps/:appId/streams/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    const query = request.query as { startIndex?: string; stream?: string }
    const appId = request.appId
    const startIndex = parseInt(query.startIndex || '0', 10)

    if (query.stream === 'true') {
      reply.raw.writeHead(200, { 'content-type': 'application/octet-stream' })

      // Health check streams use in-memory storage
      if (isHealthCheckStream(name)) {
        let done = false

        function flushHealth (): void {
          const hs = healthStreams.get(name)
          if (!hs) return

          for (const buf of hs.chunks) {
            if (buf.byteLength > 0) {
              reply.raw.write(buf)
            }
          }
          hs.chunks = []

          if (hs.closed) {
            done = true
            reply.raw.end()
            healthStreams.delete(name)
          }
        }

        flushHealth()
        if (done) return reply

        return new Promise((resolve) => {
          const onUpdate = () => {
            if (done) return
            flushHealth()
            if (done) {
              streamEvents.removeListener(name, onUpdate)
              resolve(reply)
            }
          }
          streamEvents.on(name, onUpdate)

          request.raw.on('close', () => {
            done = true
            streamEvents.removeListener(name, onUpdate)
            resolve(reply)
          })
        })
      }

      let nextIndex = startIndex
      let done = false

      async function flush (): Promise<void> {
        const result = await app.pg.query(
          `SELECT data, chunk_index FROM workflow_stream_chunks
           WHERE stream_name = $1 AND application_id = $2 AND chunk_index >= $3 AND is_closed = FALSE
           ORDER BY chunk_index ASC`,
          [name, appId, nextIndex]
        )

        for (const row of result.rows) {
          const buf = row.data as Buffer
          if (buf.byteLength > 0) {
            reply.raw.write(buf)
          }
          nextIndex = row.chunk_index + 1
        }

        const closedResult = await app.pg.query(
          `SELECT 1 FROM workflow_stream_chunks
           WHERE stream_name = $1 AND application_id = $2 AND is_closed = TRUE
           LIMIT 1`,
          [name, appId]
        )

        if (closedResult.rows.length > 0) {
          done = true
          reply.raw.end()
        }
      }

      // Flush any existing chunks first
      await flush()
      if (done) return reply

      // Wait for NOTIFY events to flush new chunks
      return new Promise((resolve) => {
        const onUpdate = async () => {
          if (done) return
          await flush()
          if (done) {
            streamEvents.removeListener(name, onUpdate)
            resolve(reply)
          }
        }
        streamEvents.on(name, onUpdate)

        // Clean up if client disconnects
        request.raw.on('close', () => {
          done = true
          streamEvents.removeListener(name, onUpdate)
          resolve(reply)
        })
      })
    }

    // Legacy binary mode
    const result = await app.pg.query(
      `SELECT data, chunk_index FROM workflow_stream_chunks
       WHERE stream_name = $1 AND application_id = $2 AND chunk_index >= $3 AND is_closed = FALSE
       ORDER BY chunk_index ASC`,
      [name, appId, startIndex]
    )

    reply.header('content-type', 'application/octet-stream')
    const chunks = result.rows.map(row => row.data)
    if (chunks.length === 0) {
      return Buffer.alloc(0)
    }
    return Buffer.concat(chunks)
  })

  // List streams for a run
  app.get('/api/v1/apps/:appId/runs/:runId/streams', async (request) => {
    const { runId } = request.params as { runId: string }
    const appId = request.appId

    const result = await app.pg.query(
      `SELECT DISTINCT stream_name FROM workflow_stream_chunks
       WHERE run_id = $1 AND application_id = $2`,
      [runId, appId]
    )

    return result.rows.map(row => row.stream_name)
  })
}

export default fp(streamsPlugin, { name: 'streams', dependencies: ['auth'] })
