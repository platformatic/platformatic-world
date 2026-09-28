import fp from 'fastify-plugin'
import { isDeepStrictEqual } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { BadRequest, RemoteOperationError, RunNotFound } from '../lib/errors.ts'
import {
  assertRemoteEndpointInput,
  assertRemoteEndpointSchemas,
  assertResolvedRemoteEndpoint,
  type FrozenRemoteEndpointResolution,
} from '../lib/remote-endpoints.ts'

const INLINE_PAYLOAD_LIMIT = 256 * 1024
const MAXIMUM_OPERATION_KEY_BYTES = 1024
const MAXIMUM_ENDPOINT_LENGTH = 1024
const MINIMUM_BUDGET_MS = 1_000
const MAXIMUM_BUDGET_MS = 2_147_483_647
const DEFAULT_ACTIVE_PAGE_LIMIT = 100
const MAXIMUM_ACTIVE_PAGE_LIMIT = 1_000
const REMOTE_HANDLER_DEADLINE_ATTRIBUTE = '$platformatic.remote.deadline'

interface StageOperationBody {
  operationKey: string
  dispatchStepId: string
  ordinal: string
  endpoint: string
  epoch?: number
  payload: unknown
  payloadRef?: unknown
  budget: { remaining: number }
  resolution?: FrozenRemoteEndpointResolution
}

function requireNonEmptyString (value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteOperationError('admission_rejected', `${field} must be a non-empty string`, 422)
  }
  return value
}

function validateOperationKey (value: unknown): string {
  const operationKey = requireNonEmptyString(value, 'operationKey')
  if (Buffer.byteLength(operationKey, 'utf8') > MAXIMUM_OPERATION_KEY_BYTES) {
    throw new RemoteOperationError(
      'admission_rejected',
      `operationKey must not exceed ${MAXIMUM_OPERATION_KEY_BYTES} UTF-8 bytes`,
      422
    )
  }
  return operationKey
}

function validateEndpoint (value: unknown): string {
  const endpoint = requireNonEmptyString(value, 'endpoint')
  if (endpoint.length > MAXIMUM_ENDPOINT_LENGTH) {
    throw new RemoteOperationError(
      'admission_rejected',
      `endpoint must not exceed ${MAXIMUM_ENDPOINT_LENGTH} characters`,
      422
    )
  }
  return endpoint
}

function validateStageBody (value: unknown): { body: StageOperationBody, payloadJson: string, payloadBytes: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteOperationError('admission_rejected', 'request body must be an object', 422)
  }

  const body = value as StageOperationBody
  validateOperationKey(body.operationKey)
  requireNonEmptyString(body.dispatchStepId, 'dispatchStepId')
  requireNonEmptyString(body.ordinal, 'ordinal')
  validateEndpoint(body.endpoint)

  if (body.epoch !== undefined && (!Number.isSafeInteger(body.epoch) || body.epoch < 0)) {
    throw new RemoteOperationError('admission_rejected', 'epoch must be a non-negative integer', 422)
  }

  if (!body.budget || !Number.isSafeInteger(body.budget.remaining)) {
    throw new RemoteOperationError('admission_rejected', 'budget.remaining must be an integer', 422)
  }
  if (body.budget.remaining < MINIMUM_BUDGET_MS) {
    throw new RemoteOperationError(
      'budget_exhausted',
      `budget.remaining must be at least ${MINIMUM_BUDGET_MS} milliseconds`,
      408
    )
  }
  if (body.budget.remaining > MAXIMUM_BUDGET_MS) {
    throw new RemoteOperationError(
      'admission_rejected',
      `budget.remaining must not exceed ${MAXIMUM_BUDGET_MS} milliseconds`,
      422
    )
  }
  if (Object.prototype.hasOwnProperty.call(body, 'payloadRef')) {
    throw new RemoteOperationError(
      'admission_rejected',
      'payloadRef is not supported; remote operation payloads must be inline JSON',
      422
    )
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'payload')) {
    throw new RemoteOperationError('admission_rejected', 'payload is required', 422)
  }

  let payloadJson: string | undefined
  try {
    payloadJson = JSON.stringify(body.payload)
  } catch {
    throw new RemoteOperationError('admission_rejected', 'payload must be valid JSON', 422)
  }
  if (payloadJson === undefined) {
    throw new RemoteOperationError('admission_rejected', 'payload must be valid JSON', 422)
  }

  const payloadBytes = Buffer.byteLength(payloadJson, 'utf8')
  if (payloadBytes > INLINE_PAYLOAD_LIMIT) {
    throw new RemoteOperationError(
      'admission_rejected',
      `inline payload exceeds ${INLINE_PAYLOAD_LIMIT} bytes`,
      413
    )
  }

  return { body, payloadJson, payloadBytes }
}

function sameOperation (row: any, runId: string, body: StageOperationBody): boolean {
  return row.operation_key === body.operationKey &&
    row.caller_run_id === runId &&
    row.dispatch_step_id === body.dispatchStepId &&
    row.ordinal === body.ordinal &&
    row.endpoint === body.endpoint &&
    (body.epoch === undefined || Number(row.epoch) === body.epoch) &&
    Number(row.budget_remaining_ms) === body.budget.remaining &&
    isDeepStrictEqual(row.payload, body.payload)
}

function inheritedRemoteDeadline (attributes: unknown): number | undefined {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes) ||
      !Object.prototype.hasOwnProperty.call(attributes, REMOTE_HANDLER_DEADLINE_ATTRIBUTE)) {
    return undefined
  }

  const value = (attributes as Record<string, unknown>)[REMOTE_HANDLER_DEADLINE_ATTRIBUTE]
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new RemoteOperationError(
      'admission_rejected',
      `${REMOTE_HANDLER_DEADLINE_ATTRIBUTE} must be a positive Unix millisecond timestamp string`,
      422
    )
  }
  const deadline = Number(value)
  if (!Number.isSafeInteger(deadline) || !Number.isFinite(new Date(deadline).getTime())) {
    throw new RemoteOperationError(
      'admission_rejected',
      `${REMOTE_HANDLER_DEADLINE_ATTRIBUTE} must be a supported Unix millisecond timestamp`,
      422
    )
  }
  return deadline
}

function operationResponse (row: any): any {
  return {
    operationKey: row.operation_key,
    callerRunId: row.caller_run_id,
    dispatchStepId: row.dispatch_step_id,
    ordinal: row.ordinal,
    endpoint: row.endpoint,
    schemaHash: row.schema_hash,
    epoch: Number(row.epoch),
    payload: row.payload,
    budget: { remaining: Number(row.budget_remaining_ms) },
    deadlineAt: row.deadline_at,
    status: row.status,
    claimAttempts: row.claim_attempts,
    handlerRunId: row.handler_run_id || undefined,
    outcome: row.outcome || undefined,
    createdAt: row.created_at,
    scheduledAt: row.scheduled_at || undefined,
    completedAt: row.completed_at || undefined,
    outcomeDeliveredAt: row.outcome_delivered_at || undefined,
    updatedAt: row.updated_at,
  }
}

function activeOperationsQuery (value: unknown): { cursor?: string, limit: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequest('query must be an object')
  }

  const query = value as Record<string, unknown>
  const unknown = Object.keys(query).filter(key => key !== 'cursor' && key !== 'limit')
  if (unknown.length > 0) {
    throw new BadRequest(`unknown query parameter ${JSON.stringify(unknown[0])}`)
  }

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

async function remoteOperationsPlugin (app: FastifyInstance): Promise<void> {
  // This feed is consumed by the local Watt control plane. Authentication
  // resolves the URL application label to request.appId before this query, and
  // every selected row is scoped to that numeric tenant id. Caller run ids are
  // used only for the cancellation join and never leave World.
  app.get('/api/v1/apps/:appId/remote-operations/active', async (request) => {
    const { cursor, limit } = activeOperationsQuery(request.query)
    const result = await app.pg.query(
      `SELECT o.operation_key, o.endpoint, o.payload, o.epoch,
              LEAST(
                o.budget_remaining_ms,
                CEIL(EXTRACT(EPOCH FROM (o.deadline_at - statement_timestamp())) * 1000)::bigint
              )::integer AS budget_remaining_ms,
              (o.status = 'cancelled' OR r.status NOT IN ('pending', 'running')) AS cancel_requested
       FROM workflow_remote_operations o
       INNER JOIN workflow_runs r
         ON r.application_id = o.application_id AND r.id = o.caller_run_id
       WHERE o.application_id = $1
         AND (
           (
             o.status IN ('pending', 'started')
             AND (
               (r.status IN ('pending', 'running') AND
                o.deadline_at >= statement_timestamp() + INTERVAL '1 second')
               OR
               (r.status NOT IN ('pending', 'running') AND o.deadline_at > statement_timestamp())
             )
           )
           OR (o.status = 'cancelled' AND o.deadline_at > statement_timestamp())
         )
         AND ($2::varchar IS NULL OR o.operation_key COLLATE "C" > $2::varchar COLLATE "C")
       ORDER BY o.operation_key COLLATE "C" ASC
       LIMIT $3`,
      [request.appId, cursor || null, limit + 1]
    )

    const hasMore = result.rows.length > limit
    const rows = result.rows.slice(0, limit)
    const data = rows.map(row => ({
      operationKey: row.operation_key,
      endpoint: row.endpoint,
      payload: row.payload,
      budget: { remaining: Number(row.budget_remaining_ms) },
      epoch: Number(row.epoch),
      cancelRequested: row.cancel_requested,
    }))

    return {
      data,
      cursor: hasMore ? data[data.length - 1].operationKey : null,
      hasMore,
    }
  })

  app.post('/api/v1/apps/:appId/runs/:runId/remote-operations', async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const appId = request.appId
    const { body, payloadJson, payloadBytes } = validateStageBody(request.body)
    const client = await app.pg.connect()

    try {
      await client.query('BEGIN')

      const run = await client.query(
        `SELECT id, attributes, statement_timestamp() AS request_time
         FROM workflow_runs WHERE application_id = $1 AND id = $2`,
        [appId, runId]
      )
      if (run.rows.length === 0) throw new RunNotFound(runId)

      let row = (await client.query(
        `SELECT * FROM workflow_remote_operations
         WHERE application_id = $1 AND operation_key = $2
         FOR UPDATE`,
        [appId, body.operationKey]
      )).rows[0]

      if (!row) {
        row = (await client.query(
          `SELECT * FROM workflow_remote_operations
           WHERE application_id = $1 AND caller_run_id = $2
             AND dispatch_step_id = $3 AND ordinal = $4
           FOR UPDATE`,
          [appId, runId, body.dispatchStepId, body.ordinal]
        )).rows[0]
      }

      if (row) {
        if (!sameOperation(row, runId, body)) {
          throw new RemoteOperationError(
            'operation_conflict',
            'operation identity was already used with different dispatch data',
            409
          )
        }
        await client.query('COMMIT')
        reply.code(200)
        return operationResponse(row)
      }

      const requestTime = new Date(run.rows[0].request_time).getTime()
      const inheritedDeadline = inheritedRemoteDeadline(run.rows[0].attributes)
      if (inheritedDeadline !== undefined && inheritedDeadline - requestTime < MINIMUM_BUDGET_MS) {
        throw new RemoteOperationError(
          'budget_exhausted',
          `remote operation has less than ${MINIMUM_BUDGET_MS} milliseconds remaining`,
          408
        )
      }

      const endpoint = body.resolution
      if (!endpoint) {
        throw new RemoteOperationError(
          'endpoint_resolution_required',
          `Remote endpoint ${JSON.stringify(body.endpoint)} requires a frozen registry resolution`,
          428
        )
      }
      assertResolvedRemoteEndpoint(body.endpoint, endpoint)
      if (body.epoch !== undefined && endpoint.epoch !== body.epoch) {
        throw new RemoteOperationError(
          'endpoint_withdrawn',
          `Remote endpoint ${JSON.stringify(body.endpoint)} changed epoch`,
          409
        )
      }
      const application = await client.query(
        'SELECT icc_application_id FROM workflow_applications WHERE id = $1',
        [appId]
      )
      const boundIccApplicationId = application.rows[0]?.icc_application_id
      if (!boundIccApplicationId) {
        throw new RemoteOperationError(
          'admission_rejected',
          'World application is not bound to an ICC application ID',
          409
        )
      }
      const resolutionIccApplicationId = endpoint.iccApplicationId.toLowerCase()
      if (boundIccApplicationId !== resolutionIccApplicationId) {
        throw new RemoteOperationError(
          'admission_rejected',
          'Frozen resolution belongs to a different ICC application',
          403
        )
      }
      const schemas = { inputSchema: endpoint.inputSchema, outputSchema: endpoint.outputSchema }
      // This caller-supplied snapshot provides deterministic, fail-fast UX at
      // the call site; it is not a registry authorization boundary. ICC must
      // independently validate announce admission against its authoritative
      // tenant-scoped registry before making the operation claimable.
      assertRemoteEndpointSchemas(endpoint.schemaHash, schemas)
      assertRemoteEndpointInput(endpoint.schemaHash, schemas.inputSchema, body.payload)

      const inserted = await client.query(
        `INSERT INTO workflow_remote_operations
           (application_id, operation_key, caller_run_id, dispatch_step_id, ordinal,
            endpoint, icc_application_id, schema_hash, output_schema, epoch, payload, payload_size_bytes,
            budget_remaining_ms, deadline_at)
         SELECT $1, $2, $3, $4, $5, $6, $7::uuid, $8, $9::jsonb, $10::bigint, $11::jsonb,
                $12, $13::integer,
                LEAST(
                  statement_timestamp() + $13::bigint * INTERVAL '1 millisecond',
                  COALESCE($14::timestamptz, 'infinity'::timestamptz)
                )
         WHERE LEAST(
                 statement_timestamp() + $13::bigint * INTERVAL '1 millisecond',
                 COALESCE($14::timestamptz, 'infinity'::timestamptz)
               ) >= statement_timestamp() + INTERVAL '1 second'
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [appId, body.operationKey, runId, body.dispatchStepId, body.ordinal,
          body.endpoint, resolutionIccApplicationId, endpoint.schemaHash,
          JSON.stringify(schemas.outputSchema), endpoint.epoch,
          payloadJson, payloadBytes, body.budget.remaining,
          inheritedDeadline === undefined ? null : new Date(inheritedDeadline)]
      )

      const created = inserted.rows.length > 0
      row = inserted.rows[0]
      if (!row) {
        row = (await client.query(
          `SELECT * FROM workflow_remote_operations
           WHERE application_id = $1 AND operation_key = $2
           FOR UPDATE`,
          [appId, body.operationKey]
        )).rows[0]

        if (!row) {
          row = (await client.query(
            `SELECT * FROM workflow_remote_operations
             WHERE application_id = $1 AND caller_run_id = $2
               AND dispatch_step_id = $3 AND ordinal = $4
             FOR UPDATE`,
            [appId, runId, body.dispatchStepId, body.ordinal]
          )).rows[0]
        }

        if (!row) {
          throw new RemoteOperationError(
            'budget_exhausted',
            `remote operation has less than ${MINIMUM_BUDGET_MS} milliseconds remaining`,
            408
          )
        }

        if (!sameOperation(row, runId, body)) {
          throw new RemoteOperationError(
            'operation_conflict',
            'operation identity was already used with different dispatch data',
            409
          )
        }
      }

      await client.query('COMMIT')
      reply.code(created ? 201 : 200)
      return operationResponse(row)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.get('/api/v1/apps/:appId/runs/:runId/remote-operations/:operationKey', async (request) => {
    const { runId, operationKey } = request.params as { runId: string, operationKey: string }
    const result = await app.pg.query(
      `SELECT * FROM workflow_remote_operations
       WHERE application_id = $1 AND caller_run_id = $2 AND operation_key = $3`,
      [request.appId, runId, operationKey]
    )
    if (result.rows.length === 0) {
      throw new RemoteOperationError(
        'operation_not_found',
        `Remote operation ${JSON.stringify(operationKey)} was not found`,
        404
      )
    }
    return operationResponse(result.rows[0])
  })
}

export default fp(remoteOperationsPlugin, { name: 'remote-operations', dependencies: ['auth'] })
