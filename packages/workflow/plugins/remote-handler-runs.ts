import fp from 'fastify-plugin'
import { ulid } from 'ulid'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { BadRequest, RemoteOperationError } from '../lib/errors.ts'
import { cancelWorkflowRun } from '../lib/run-cancellation.ts'

const MAXIMUM_OPERATION_KEY_BYTES = 1024
const MINIMUM_BUDGET_MS = 1_000
const MAXIMUM_BUDGET_MS = 2_147_483_647
const RUN_ID_PATTERN = /^wrun_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i
const DEFAULT_ACTIVE_PAGE_LIMIT = 16
const MAXIMUM_ACTIVE_PAGE_LIMIT = 16
const DEFAULT_REAPER_BATCH_SIZE = 100
const REAPER_INTERVAL_MS = 5_000

interface ReserveHandlerRunBody {
  operationKey: string
  budget: { remaining: number }
}

interface CancelHandlerRunBody {
  operationKey: string
  handlerRunId: string
}

export interface ReapExpiredHandlerRunsResult {
  examined: number
  cancelled: number
}

function validateOperationKey (value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteOperationError('admission_rejected', 'operationKey must be a non-empty string', 422)
  }
  if (Buffer.byteLength(value, 'utf8') > MAXIMUM_OPERATION_KEY_BYTES) {
    throw new RemoteOperationError(
      'admission_rejected',
      `operationKey must not exceed ${MAXIMUM_OPERATION_KEY_BYTES} UTF-8 bytes`,
      422
    )
  }
  return value
}

function validateReservation (value: unknown): ReserveHandlerRunBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteOperationError('admission_rejected', 'request body must be an object', 422)
  }

  const body = value as ReserveHandlerRunBody
  validateOperationKey(body.operationKey)
  if (!body.budget || !Number.isSafeInteger(body.budget.remaining) ||
      body.budget.remaining < MINIMUM_BUDGET_MS || body.budget.remaining > MAXIMUM_BUDGET_MS) {
    throw new RemoteOperationError(
      'admission_rejected',
      `budget.remaining must be between ${MINIMUM_BUDGET_MS} and ${MAXIMUM_BUDGET_MS} milliseconds`,
      422
    )
  }

  return body
}

function validateCancellation (value: unknown): CancelHandlerRunBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteOperationError('admission_rejected', 'request body must be an object', 422)
  }
  const body = value as CancelHandlerRunBody
  validateOperationKey(body.operationKey)
  if (typeof body.handlerRunId !== 'string' || !RUN_ID_PATTERN.test(body.handlerRunId)) {
    throw new RemoteOperationError('admission_rejected', 'handlerRunId must be a wrun_ prefixed ULID', 422)
  }
  return body
}

function activeRunsQuery (value: unknown): { cursor?: string, limit: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequest('query must be an object')
  }
  const query = value as Record<string, unknown>
  const unknown = Object.keys(query).filter(key => key !== 'cursor' && key !== 'limit')
  if (unknown.length > 0) throw new BadRequest(`unknown query parameter ${JSON.stringify(unknown[0])}`)

  let cursor: string | undefined
  if (query.cursor !== undefined) {
    try {
      cursor = validateOperationKey(query.cursor)
    } catch (error) {
      throw new BadRequest((error as Error).message)
    }
  }

  let limit = DEFAULT_ACTIVE_PAGE_LIMIT
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[1-9][0-9]*$/.test(query.limit)) {
      throw new BadRequest('limit must be a positive integer')
    }
    limit = Number(query.limit)
    if (!Number.isSafeInteger(limit) || limit > MAXIMUM_ACTIVE_PAGE_LIMIT) {
      throw new BadRequest(`limit must not exceed ${MAXIMUM_ACTIVE_PAGE_LIMIT}`)
    }
  }
  return { cursor, limit }
}

function budgetExhausted (): RemoteOperationError {
  return new RemoteOperationError('budget_exhausted', 'remote handler run reservation has expired', 408)
}

export async function reapExpiredRemoteHandlerRuns (
  pool: pg.Pool,
  { batchSize = DEFAULT_REAPER_BATCH_SIZE, cutoff = new Date() }: {
    batchSize?: number
    cutoff?: Date
  } = {}
): Promise<ReapExpiredHandlerRunsResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('remote handler reaper batchSize must be a positive safe integer')
  }
  if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
    throw new TypeError('remote handler reaper cutoff must be a valid Date')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const expired = await client.query(
      `SELECT application_id, operation_key, handler_run_id
       FROM workflow_remote_handler_runs
       WHERE deadline_at <= $1
       ORDER BY deadline_at ASC, application_id ASC, operation_key COLLATE "C" ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [cutoff, batchSize]
    )

    let cancelled = 0
    for (const row of expired.rows) {
      const result = await cancelWorkflowRun(client, row.application_id, row.handler_run_id)
      if (result.cancelled) cancelled++
    }
    if (expired.rows.length > 0) {
      await client.query(
        `DELETE FROM workflow_remote_handler_runs
         WHERE (application_id, operation_key) IN (
           SELECT * FROM UNNEST($1::integer[], $2::varchar[])
         )`,
        [
          expired.rows.map(row => row.application_id),
          expired.rows.map(row => row.operation_key),
        ]
      )
    }
    await client.query('COMMIT')
    return { examined: expired.rows.length, cancelled }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function remoteHandlerRunsPlugin (app: FastifyInstance): Promise<void> {
  let reaperTimer: NodeJS.Timeout | undefined
  let activeReaper: Promise<void> | undefined

  function runReaper (): Promise<void> {
    if (activeReaper) return activeReaper
    activeReaper = reapExpiredRemoteHandlerRuns(app.pg)
      .then(result => {
        if (result.examined > 0) {
          app.log.info(result, 'Remote handler run reaper reconciled expired reservations')
        }
      })
      .catch(error => app.log.error({ err: error }, 'Remote handler run reaper failed'))
      .finally(() => { activeReaper = undefined })
    return activeReaper
  }

  app.get('/api/v1/apps/:appId/remote-handler-runs/active', async (request) => {
    const { cursor, limit } = activeRunsQuery(request.query)
    const result = await app.pg.query(
      `SELECT h.operation_key, h.handler_run_id, h.deadline_at
       FROM workflow_remote_handler_runs h
       INNER JOIN workflow_runs r
         ON r.application_id = h.application_id AND r.id = h.handler_run_id
       WHERE h.application_id = $1
         AND r.status IN ('pending', 'running')
         AND ($2::varchar IS NULL OR h.operation_key COLLATE "C" > $2::varchar COLLATE "C")
       ORDER BY h.operation_key COLLATE "C" ASC
       LIMIT $3`,
      [request.appId, cursor ?? null, limit + 1]
    )
    const hasMore = result.rows.length > limit
    const data = result.rows.slice(0, limit).map(row => ({
      operationKey: row.operation_key,
      handlerRunId: row.handler_run_id,
      deadlineAt: new Date(row.deadline_at).getTime(),
    }))
    return {
      data,
      cursor: hasMore ? data[data.length - 1].operationKey : null,
      hasMore,
    }
  })

  app.post('/api/v1/apps/:appId/remote-handler-runs/reserve', async (request, reply) => {
    const body = validateReservation(request.body)
    const appId = request.appId
    const client = await app.pg.connect()

    try {
      await client.query('BEGIN')

      let row = (await client.query(
        `SELECT handler_run_id, deadline_at,
                deadline_at <= statement_timestamp() AS expired
         FROM workflow_remote_handler_runs
         WHERE application_id = $1 AND operation_key = $2
         FOR UPDATE`,
        [appId, body.operationKey]
      )).rows[0]

      if (row) {
        if (row.expired) throw budgetExhausted()

        row = (await client.query(
          `UPDATE workflow_remote_handler_runs
           SET deadline_at = LEAST(
             deadline_at,
             statement_timestamp() + $3::bigint * INTERVAL '1 millisecond'
           )
           WHERE application_id = $1 AND operation_key = $2
             AND deadline_at > statement_timestamp()
           RETURNING handler_run_id, deadline_at`,
          [appId, body.operationKey, body.budget.remaining]
        )).rows[0]
        if (!row) throw budgetExhausted()

        await client.query('COMMIT')
        reply.code(200)
        return { handlerRunId: row.handler_run_id }
      }

      const handlerRunId = `wrun_${ulid()}`
      const inserted = await client.query(
        `INSERT INTO workflow_remote_handler_runs
           (application_id, operation_key, handler_run_id, deadline_at)
         VALUES (
           $1,
           $2,
           $3,
           statement_timestamp() + $4::bigint * INTERVAL '1 millisecond'
         )
         ON CONFLICT (application_id, operation_key) DO NOTHING
         RETURNING handler_run_id, deadline_at`,
        [appId, body.operationKey, handlerRunId, body.budget.remaining]
      )

      const created = inserted.rows.length > 0
      row = inserted.rows[0]
      if (!row) {
        row = (await client.query(
          `SELECT handler_run_id, deadline_at,
                  deadline_at <= statement_timestamp() AS expired
           FROM workflow_remote_handler_runs
           WHERE application_id = $1 AND operation_key = $2
           FOR UPDATE`,
          [appId, body.operationKey]
        )).rows[0]
        if (!row || row.expired) throw budgetExhausted()

        row = (await client.query(
          `UPDATE workflow_remote_handler_runs
           SET deadline_at = LEAST(
             deadline_at,
             statement_timestamp() + $3::bigint * INTERVAL '1 millisecond'
           )
           WHERE application_id = $1 AND operation_key = $2
             AND deadline_at > statement_timestamp()
           RETURNING handler_run_id, deadline_at`,
          [appId, body.operationKey, body.budget.remaining]
        )).rows[0]
        if (!row) throw budgetExhausted()
      }

      await client.query('COMMIT')
      reply.code(created ? 201 : 200)
      return { handlerRunId: row.handler_run_id }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.post('/api/v1/apps/:appId/remote-handler-runs/cancel', async (request) => {
    const body = validateCancellation(request.body)
    const appId = request.appId
    const client = await app.pg.connect()
    try {
      await client.query('BEGIN')
      const mapping = await client.query(
        `SELECT handler_run_id
         FROM workflow_remote_handler_runs
         WHERE application_id = $1 AND operation_key = $2
         FOR UPDATE`,
        [appId, body.operationKey]
      )
      if (mapping.rows[0]?.handler_run_id !== body.handlerRunId) {
        await client.query('COMMIT')
        return { cancelled: false }
      }

      const result = await cancelWorkflowRun(client, appId, body.handlerRunId)
      await client.query('COMMIT')
      return { cancelled: result.cancelled }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.addHook('onReady', async () => {
    reaperTimer = setInterval(runReaper, REAPER_INTERVAL_MS)
    reaperTimer.unref()
    await runReaper()
  })
  app.addHook('onClose', async () => {
    if (reaperTimer) clearInterval(reaperTimer)
    await activeReaper
  })
}

export default fp(remoteHandlerRunsPlugin, { name: 'remote-handler-runs', dependencies: ['auth'] })
