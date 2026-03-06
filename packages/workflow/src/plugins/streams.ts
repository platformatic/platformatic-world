import type { FastifyInstance } from 'fastify'
import { BadRequest } from '../lib/errors.ts'

export default async function streamsPlugin (app: FastifyInstance): Promise<void> {
  // Write chunk(s) to a stream
  app.put('/api/v1/apps/:appId/runs/:runId/streams/:name', async (request, reply) => {
    const { runId, name } = request.params as { runId: string; name: string }
    const appId = request.appId
    const isMulti = request.headers['x-stream-multi'] === 'true'
    const isDone = request.headers['x-stream-done'] === 'true'

    if (isDone) {
      // Mark stream as closed by inserting a sentinel chunk
      await app.pg.query(
        `INSERT INTO workflow_stream_chunks (stream_name, run_id, application_id, chunk_index, data, is_closed)
         VALUES ($1, $2, $3, -1, $4, TRUE)
         ON CONFLICT DO NOTHING`,
        [name, runId, appId, Buffer.alloc(0)]
      )
      reply.code(204)
      return
    }

    if (isMulti) {
      const chunks = request.body as any[]
      if (!Array.isArray(chunks)) throw new BadRequest('body must be an array for multi-write')

      // Get current max index
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

    reply.code(204)
  })

  // Read stream chunks
  app.get('/api/v1/apps/:appId/streams/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    const query = request.query as { startIndex?: string }
    const appId = request.appId
    const startIndex = parseInt(query.startIndex || '0', 10)

    const result = await app.pg.query(
      `SELECT data, chunk_index, is_closed FROM workflow_stream_chunks
       WHERE stream_name = $1 AND application_id = $2 AND chunk_index >= $3 AND is_closed = FALSE
       ORDER BY chunk_index ASC`,
      [name, appId, startIndex]
    )

    // Return as an array of base64-encoded chunks
    reply.header('content-type', 'application/octet-stream')

    // Create a ReadableStream-like response
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
