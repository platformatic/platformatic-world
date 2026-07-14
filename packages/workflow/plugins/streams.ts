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
        if (hs.closed) throw new BadRequest('stream is already closed')
        const chunks = request.body as any[]
        if (!Array.isArray(chunks)) throw new BadRequest('body must be an array for multi-write')
        for (const chunk of chunks) {
          const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk.data || chunk, 'base64')
          hs.chunks.push(data)
        }
      } else {
        if (hs.closed) throw new BadRequest('stream is already closed')
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

    const chunks = isMulti ? request.body as any[] : null
    if (isMulti && !Array.isArray(chunks)) throw new BadRequest('body must be an array for multi-write')

    const client = await app.pg.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended(json_build_array($1::integer, $2::text, $3::text)::text, 0)
         )`,
        [appId, runId, name]
      )

      const closedResult = await client.query(
        `SELECT 1 FROM workflow_stream_chunks
         WHERE stream_name = $1 AND run_id = $2 AND application_id = $3 AND is_closed = TRUE
         LIMIT 1`,
        [name, runId, appId]
      )

      if (isDone) {
        if (closedResult.rows.length === 0) {
          await client.query(
            `INSERT INTO workflow_stream_chunks (stream_name, run_id, application_id, chunk_index, data, is_closed)
             VALUES ($1, $2, $3, -1, $4, TRUE)`,
            [name, runId, appId, Buffer.alloc(0)]
          )
        }
      } else {
        if (closedResult.rows.length > 0) throw new BadRequest('stream is already closed')

        const maxResult = await client.query(
          `SELECT COALESCE(MAX(chunk_index), -1) AS max_idx FROM workflow_stream_chunks
           WHERE stream_name = $1 AND run_id = $2 AND application_id = $3 AND is_closed = FALSE`,
          [name, runId, appId]
        )
        let idx = maxResult.rows[0].max_idx + 1

        if (chunks) {
          for (const chunk of chunks) {
            const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk.data || chunk, 'base64')
            await client.query(
              `INSERT INTO workflow_stream_chunks (stream_name, run_id, application_id, chunk_index, data)
               VALUES ($1, $2, $3, $4, $5)`,
              [name, runId, appId, idx++, data]
            )
          }
        } else {
          const body = request.body as any
          const data = typeof body === 'string'
            ? Buffer.from(body, 'utf-8')
            : Buffer.isBuffer(body)
              ? body
              : Buffer.from(body.data || JSON.stringify(body), 'base64')

          await client.query(
            `INSERT INTO workflow_stream_chunks (stream_name, run_id, application_id, chunk_index, data)
             VALUES ($1, $2, $3, $4, $5)`,
            [name, runId, appId, idx, data]
          )
        }
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
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

      async function flush (): Promise<boolean> {
        const result = await app.pg.query(
          `WITH stream_state AS (
             SELECT EXISTS (
               SELECT 1 FROM workflow_stream_chunks
               WHERE stream_name = $1 AND application_id = $2 AND is_closed = TRUE
             ) AS is_closed
           ), chunks AS (
             SELECT data, chunk_index FROM workflow_stream_chunks
             WHERE stream_name = $1 AND application_id = $2 AND chunk_index >= $3 AND is_closed = FALSE
           )
           SELECT chunks.data, chunks.chunk_index, stream_state.is_closed
           FROM stream_state
           LEFT JOIN chunks ON TRUE
           ORDER BY chunks.chunk_index ASC NULLS LAST`,
          [name, appId, nextIndex]
        )

        for (const row of result.rows) {
          if (row.chunk_index === null) continue
          const buf = row.data as Buffer
          if (buf.byteLength > 0) {
            reply.raw.write(buf)
          }
          nextIndex = row.chunk_index + 1
        }

        const done = result.rows[0].is_closed as boolean
        if (done) {
          reply.raw.end()
        }
        return done
      }

      return new Promise((resolve) => {
        let done = false
        let flushing = false
        let pending = false

        function cleanup (): void {
          if (done) return
          done = true
          streamEvents.removeListener(name, onUpdate)
          request.raw.removeListener('close', onClose)
          resolve(reply)
        }

        function onClose (): void {
          cleanup()
        }

        function onUpdate (): void {
          if (done) return
          if (flushing) {
            pending = true
            return
          }

          flushing = true
          const drain = async () => {
            do {
              pending = false
              if (await flush()) cleanup()
            } while (pending && !done)
          }
          const finish = () => {
            flushing = false
            if (pending && !done) onUpdate()
          }
          drain().then(finish, err => {
            cleanup()
            reply.raw.destroy(err as Error)
            finish()
          })
        }

        streamEvents.on(name, onUpdate)
        request.raw.on('close', onClose)
        onUpdate()
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

  // Paginated chunk retrieval. Cursor is the last chunk_index returned, so
  // `WHERE chunk_index > cursor` advances the window. Default limit 100, max 1000.
  app.get('/api/v1/apps/:appId/runs/:runId/streams/:name/chunks', async (request) => {
    const { runId, name } = request.params as { runId: string; name: string }
    const appId = request.appId
    const query = request.query as { limit?: string; cursor?: string }

    const rawLimit = query.limit ? parseInt(query.limit, 10) : 100
    const limit = Math.max(1, Math.min(1000, Number.isFinite(rawLimit) ? rawLimit : 100))
    const cursor = query.cursor ? parseInt(query.cursor, 10) : -1

    const pageResult = await app.pg.query(
      `SELECT chunk_index, data FROM workflow_stream_chunks
       WHERE stream_name = $1 AND run_id = $2 AND application_id = $3
         AND is_closed = FALSE AND chunk_index > $4
       ORDER BY chunk_index ASC
       LIMIT $5`,
      [name, runId, appId, cursor, limit]
    )

    const data = pageResult.rows.map(row => ({
      index: row.chunk_index as number,
      data: (row.data as Buffer).toString('base64'),
    }))

    const nextCursor = data.length > 0 ? String(data[data.length - 1].index) : null

    // hasMore: is there any chunk beyond the last one returned?
    let hasMore = false
    if (nextCursor !== null) {
      const moreResult = await app.pg.query(
        `SELECT 1 FROM workflow_stream_chunks
         WHERE stream_name = $1 AND run_id = $2 AND application_id = $3
           AND is_closed = FALSE AND chunk_index > $4
         LIMIT 1`,
        [name, runId, appId, Number(nextCursor)]
      )
      hasMore = moreResult.rows.length > 0
    }

    const closedResult = await app.pg.query(
      `SELECT 1 FROM workflow_stream_chunks
       WHERE stream_name = $1 AND run_id = $2 AND application_id = $3 AND is_closed = TRUE
       LIMIT 1`,
      [name, runId, appId]
    )
    const done = closedResult.rows.length > 0

    return {
      data,
      cursor: hasMore ? nextCursor : null,
      hasMore,
      done,
    }
  })

  // Stream metadata: tailIndex (-1 if no chunks) + done flag.
  app.get('/api/v1/apps/:appId/runs/:runId/streams/:name/info', async (request) => {
    const { runId, name } = request.params as { runId: string; name: string }
    const appId = request.appId

    const tailResult = await app.pg.query(
      `SELECT COALESCE(MAX(chunk_index), -1)::int AS tail_index
       FROM workflow_stream_chunks
       WHERE stream_name = $1 AND run_id = $2 AND application_id = $3 AND is_closed = FALSE`,
      [name, runId, appId]
    )

    const closedResult = await app.pg.query(
      `SELECT 1 FROM workflow_stream_chunks
       WHERE stream_name = $1 AND run_id = $2 AND application_id = $3 AND is_closed = TRUE
       LIMIT 1`,
      [name, runId, appId]
    )

    return {
      tailIndex: tailResult.rows[0].tail_index as number,
      done: closedResult.rows.length > 0,
    }
  })
}

export default fp(streamsPlugin, { name: 'streams', dependencies: ['auth'] })
