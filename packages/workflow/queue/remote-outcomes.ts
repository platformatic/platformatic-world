import { hkdfSync } from 'node:crypto'
import { encode } from 'cbor-x'
import type pg from 'pg'
import { importKey } from '@workflow/core/encryption'
import { dehydrateStepReturnValue } from '@workflow/core/serialization'
import { RemoteOperationError } from '../lib/errors.ts'
import { assertRemoteEndpointOutput } from '../lib/remote-endpoints.ts'
import { workflowQueueName, workflowQueueNameLike } from './names.ts'

const INLINE_OUTCOME_LIMIT = 256 * 1024
const MAXIMUM_OPERATION_KEY_BYTES = 1024
const DEFAULT_BATCH_SIZE = 100
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'dead_letter'])
const ACTIVE_STATUSES = new Set(['pending', 'started'])
const BUDGET_EXHAUSTED_OUTCOME = {
  ok: false,
  kind: 'failed',
  error: {
    code: 'budget_exhausted',
    message: 'Remote operation exceeded its total execution budget',
  },
}

export interface RemoteUpdate {
  operationKey: string
  kind: 'started' | 'completed' | 'failed' | 'cancelled_ack'
  handlerRunId?: string
  outcome?: unknown
}

function updateError (code: string, message: string, statusCode = 422): RemoteOperationError {
  return new RemoteOperationError(code, message, statusCode)
}

function requireString (value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw updateError('admission_rejected', `${field} must be a non-empty string`)
  }
  return value
}

function validateOperationKey (value: unknown): string {
  const operationKey = requireString(value, 'operationKey')
  if (Buffer.byteLength(operationKey, 'utf8') > MAXIMUM_OPERATION_KEY_BYTES) {
    throw updateError(
      'admission_rejected',
      `operationKey must not exceed ${MAXIMUM_OPERATION_KEY_BYTES} UTF-8 bytes`
    )
  }
  return operationKey
}

function assertUpdate (value: unknown): asserts value is RemoteUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw updateError('admission_rejected', 'each remote update must be an object')
  }
}

function canonicalOutcome (row: any, update: RemoteUpdate): { status: string, outcome: any } {
  const supplied = update.outcome as any
  if (update.kind === 'cancelled_ack' && supplied === undefined) {
    return {
      status: 'cancelled',
      outcome: {
        ok: false,
        kind: 'cancelled',
      },
    }
  }
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || typeof supplied.ok !== 'boolean') {
    throw updateError('admission_rejected', `terminal update ${JSON.stringify(update.kind)} requires an outcome`)
  }

  if (update.kind === 'completed') {
    if (supplied.ok !== true || !Object.prototype.hasOwnProperty.call(supplied, 'value')) {
      throw updateError('admission_rejected', 'completed update requires an ok outcome with a value')
    }
    try {
      assertRemoteEndpointOutput(row.schema_hash, row.output_schema, supplied.value)
      return { status: 'completed', outcome: supplied }
    } catch (error) {
      if (!(error instanceof RemoteOperationError) || error.code !== 'schema_invalid_output') throw error
      return {
        status: 'failed',
        outcome: {
          ok: false,
          kind: 'failed',
          error: { code: error.code, message: error.message },
        },
      }
    }
  }

  if (supplied.ok !== false) {
    throw updateError('admission_rejected', `${update.kind} update requires a failed outcome`)
  }
  const expectedKind = update.kind === 'cancelled_ack' ? 'cancelled' : 'failed'
  if (supplied.kind !== expectedKind) {
    throw updateError('admission_rejected', `${update.kind} update requires outcome kind ${expectedKind}`)
  }
  const status = supplied.error?.code === 'dead_letter' ? 'dead_letter' : expectedKind
  return { status, outcome: supplied }
}

function assertOutcomeSize (outcome: unknown): void {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(outcome)
  } catch {
    throw updateError('admission_rejected', 'remote outcome must be valid JSON')
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > INLINE_OUTCOME_LIMIT) {
    throw updateError('admission_rejected', `inline outcome exceeds ${INLINE_OUTCOME_LIMIT} bytes`, 413)
  }
}

function sameHandlerRun (stored: unknown, supplied: unknown): boolean {
  return supplied === undefined || stored === null || stored === supplied
}

async function expireLockedOperation (client: pg.PoolClient, row: any): Promise<any> {
  return (await client.query(
    `UPDATE workflow_remote_operations
     SET status = 'failed', outcome = $3::jsonb, completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE application_id = $1 AND operation_key = $2
       AND status IN ('staged', 'pending', 'started')
     RETURNING *`,
    [row.application_id, row.operation_key, JSON.stringify(BUDGET_EXHAUSTED_OUTCOME)]
  )).rows[0]
}

export async function applyRemoteUpdates (
  pool: pg.Pool,
  applicationId: number,
  updates: RemoteUpdate[]
): Promise<any[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const applied: any[] = []

    for (const update of updates) {
      assertUpdate(update)
      validateOperationKey(update.operationKey)
      if (!['started', 'completed', 'failed', 'cancelled_ack'].includes(update.kind)) {
        throw updateError('admission_rejected', 'remote update kind is invalid')
      }
      if (update.handlerRunId !== undefined) requireString(update.handlerRunId, 'handlerRunId')

      const row = (await client.query(
        `SELECT *, deadline_at <= clock_timestamp() AS budget_expired
         FROM workflow_remote_operations
         WHERE application_id = $1 AND operation_key = $2
         FOR UPDATE`,
        [applicationId, update.operationKey]
      )).rows[0]
      // ICC updates are redeliverable and can outlive retention in World. A
      // stale unknown key is therefore ignored rather than blocking the batch.
      if (!row) continue

      if (TERMINAL_STATUSES.has(row.status)) continue
      if (row.budget_expired) {
        applied.push(await expireLockedOperation(client, row))
        continue
      }

      if (update.kind === 'started') {
        if (row.status === 'started') {
          if (!sameHandlerRun(row.handler_run_id, update.handlerRunId)) {
            throw updateError('operation_conflict', 'remote update changed the handler run identity', 409)
          }
          if (update.outcome !== undefined) {
            throw updateError('admission_rejected', 'started update must not include an outcome')
          }
          if (!update.handlerRunId) {
            throw updateError('admission_rejected', 'started update requires handlerRunId')
          }
          continue
        }
        if (row.status !== 'pending') {
          throw updateError(
            'operation_conflict',
            `started update cannot transition an operation from ${JSON.stringify(row.status)}`,
            409
          )
        }
        if (!sameHandlerRun(row.handler_run_id, update.handlerRunId)) {
          throw updateError('operation_conflict', 'remote update changed the handler run identity', 409)
        }
        if (update.outcome !== undefined) {
          throw updateError('admission_rejected', 'started update must not include an outcome')
        }
        if (!update.handlerRunId) {
          throw updateError('admission_rejected', 'started update requires handlerRunId')
        }
        const updated = (await client.query(
          `UPDATE workflow_remote_operations
           SET status = 'started', handler_run_id = COALESCE(handler_run_id, $3), updated_at = NOW()
           WHERE application_id = $1 AND operation_key = $2
           RETURNING *`,
          [applicationId, update.operationKey, update.handlerRunId || null]
        )).rows[0]
        applied.push(updated)
        continue
      }

      // The first durable terminal outcome wins. ICC updates are redeliverable,
      // and a handler result may race a locally enforced budget or cancellation;
      // a later delivery must never rewrite (or poison retries of) the result
      // already used to resume the workflow.
      if (!ACTIVE_STATUSES.has(row.status)) {
        throw updateError(
          'operation_conflict',
          `terminal update cannot transition an operation from ${JSON.stringify(row.status)}`,
          409
        )
      }
      if (!sameHandlerRun(row.handler_run_id, update.handlerRunId)) {
        throw updateError('operation_conflict', 'remote update changed the handler run identity', 409)
      }

      const normalized = canonicalOutcome(row, update)
      assertOutcomeSize(normalized.outcome)

      const updated = (await client.query(
        `UPDATE workflow_remote_operations
         SET status = $3, handler_run_id = COALESCE(handler_run_id, $4), outcome = $5::jsonb,
             completed_at = NOW(), updated_at = NOW()
         WHERE application_id = $1 AND operation_key = $2
         RETURNING *`,
        [applicationId, update.operationKey, normalized.status,
          update.handlerRunId || null, JSON.stringify(normalized.outcome)]
      )).rows[0]
      applied.push(updated)
    }

    await client.query('COMMIT')
    return applied
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function expireRemoteOperations (
  pool: pg.Pool,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number> {
  const result = await pool.query(
    `UPDATE workflow_remote_operations
     SET status = 'failed', outcome = $2::jsonb, completed_at = NOW(), updated_at = NOW()
     WHERE (application_id, operation_key) IN (
       SELECT application_id, operation_key
       FROM workflow_remote_operations
       WHERE status IN ('staged', 'pending', 'started') AND deadline_at <= NOW()
       ORDER BY deadline_at ASC, operation_key ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING operation_key`,
    [batchSize, JSON.stringify(BUDGET_EXHAUSTED_OUTCOME)]
  )
  return result.rows.length
}

async function serializeHookPayload (client: pg.PoolClient, row: any): Promise<Buffer> {
  const secret = await client.query(
    'SELECT secret FROM workflow_encryption_keys WHERE application_id = $1',
    [row.application_id]
  )
  let key
  if (secret.rows.length > 0) {
    const derived = hkdfSync('sha256', secret.rows[0].secret, row.caller_run_id, 'workflow-encryption', 32)
    key = await importKey(new Uint8Array(derived), ['encrypt'])
  }

  const hookOutcome = row.handler_run_id
    ? { ...row.outcome, handlerRunId: row.handler_run_id }
    : row.outcome
  const serialized = await dehydrateStepReturnValue(
    hookOutcome,
    row.caller_run_id,
    key,
    [],
    globalThis,
    Number(row.spec_version) < 2,
    false,
    false
  )
  const payload = serialized instanceof Uint8Array
    ? Buffer.from(serialized).toString('base64')
    : serialized
  return Buffer.from(JSON.stringify({
    ...(Number(row.spec_version) < 2 ? {} : { token: row.operation_key }),
    payload,
  }))
}

export interface DeliverRemoteOutcomesOptions {
  batchSize?: number
  applicationId?: number
}

export async function deliverRemoteOutcomes (
  pool: pg.Pool,
  options: DeliverRemoteOutcomesOptions = {}
): Promise<number> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const applicationId = options.applicationId ?? null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query(
      `SELECT o.*, r.workflow_name, r.deployment_id, r.spec_version,
              r.status AS run_status,
              (
                SELECT m.queue_name
                FROM workflow_queue_messages m
                WHERE m.run_id = o.caller_run_id
                  AND m.application_id = o.application_id
                  AND m.queue_name ~ '^__([a-z][a-z0-9]*_)?wkf_workflow_.+$'
                ORDER BY m.id ASC
                LIMIT 1
              ) AS source_queue_name
       FROM workflow_remote_operations o
       JOIN workflow_runs r
         ON r.id = o.caller_run_id AND r.application_id = o.application_id
       WHERE o.status IN ('completed', 'failed', 'cancelled', 'dead_letter')
         AND o.outcome_delivered_at IS NULL
         AND ($2::integer IS NULL OR o.application_id = $2)
         AND (
           r.status NOT IN ('pending', 'running')
           OR EXISTS (
             SELECT 1 FROM workflow_hooks h
             WHERE h.application_id = o.application_id
               AND h.run_id = o.caller_run_id
               AND h.token = o.operation_key
           )
         )
       ORDER BY o.completed_at ASC, o.operation_key ASC
       FOR UPDATE OF o, r SKIP LOCKED
       LIMIT $1`,
      [batchSize, applicationId]
    )

    let delivered = 0
    for (const row of selected.rows) {
      if (!['pending', 'running'].includes(row.run_status)) {
        await markDelivered(client, row)
        delivered++
        continue
      }

      const hook = (await client.query(
        `SELECT * FROM workflow_hooks
         WHERE application_id = $1 AND run_id = $2 AND token = $3
         ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'received' THEN 1 ELSE 2 END,
                  created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [row.application_id, row.caller_run_id, row.operation_key]
      )).rows[0]
      // The dispatch step and hook creation are separate log writes. A fast
      // result can arrive in between; leave it durable for the next sweep.
      if (!hook) continue
      if (hook.status !== 'pending') {
        await markDelivered(client, row)
        delivered++
        continue
      }

      const eventData = await serializeHookPayload(client, row)
      await client.query(
        `INSERT INTO workflow_events
           (run_id, application_id, event_type, correlation_id, event_data, spec_version)
         VALUES ($1, $2, 'hook_received', $3, $4, $5)`,
        [row.caller_run_id, row.application_id, hook.correlation_id, eventData, row.spec_version]
      )
      await client.query(
        `UPDATE workflow_hooks SET status = 'received', received_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [hook.id]
      )

      const continuation = { runId: row.caller_run_id }
      const useCbor = Number(row.spec_version) >= 3
      const queueName = row.source_queue_name
        ? workflowQueueNameLike(row.source_queue_name, row.workflow_name)
        : workflowQueueName(row.workflow_name)
      const idempotencyKey = `remote-result:${row.operation_key}`
      const queued = await client.query(
        `INSERT INTO workflow_queue_messages
           (idempotency_key, queue_name, run_id, deployment_version,
            application_id, payload, payload_bytes, payload_encoding, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
         ON CONFLICT (application_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [idempotencyKey, queueName,
          row.caller_run_id, row.deployment_id, row.application_id,
          useCbor ? null : JSON.stringify(continuation),
          useCbor ? Buffer.from(encode(continuation)) : null,
          useCbor ? 'cbor' : 'json']
      )
      if (queued.rows.length === 0) {
        const existing = (await client.query(
          `SELECT run_id, deployment_version, queue_name
           FROM workflow_queue_messages
           WHERE application_id = $1 AND idempotency_key = $2`,
          [row.application_id, idempotencyKey]
        )).rows[0]
        if (!existing || existing.run_id !== row.caller_run_id ||
            existing.deployment_version !== row.deployment_id || existing.queue_name !== queueName) {
          throw updateError(
            'operation_conflict',
            'remote continuation idempotency key belongs to a different queue message',
            409
          )
        }
      }
      await markDelivered(client, row)
      delivered++
    }

    if (delivered > 0) await client.query("SELECT pg_notify('deferred_messages', '{}')")
    await client.query('COMMIT')
    return delivered
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function markDelivered (client: pg.PoolClient, row: any): Promise<void> {
  await client.query(
    `UPDATE workflow_remote_operations
     SET outcome_delivered_at = NOW(), updated_at = NOW()
     WHERE application_id = $1 AND operation_key = $2 AND outcome_delivered_at IS NULL`,
    [row.application_id, row.operation_key]
  )
}
