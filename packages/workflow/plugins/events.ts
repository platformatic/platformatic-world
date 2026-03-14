import fp from 'fastify-plugin'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { RunNotFound, BadRequest } from '../lib/errors.ts'
import { checkRunQuota, checkEventQuota } from '../lib/quotas.ts'
import type pg from 'pg'

// Encode data as binary for storage. Supports both Uint8Array (base64) and JSON.
function encodeData (data: unknown): Buffer | null {
  if (data === undefined || data === null) return null
  if (data instanceof Uint8Array || Buffer.isBuffer(data)) return Buffer.from(data)
  // If it's a base64-encoded string representing binary, decode it
  if (typeof data === 'string') {
    try {
      return Buffer.from(data, 'base64')
    } catch {
      return Buffer.from(JSON.stringify(data))
    }
  }
  return Buffer.from(JSON.stringify(data))
}

function decodeData (buf: Buffer | null): unknown {
  if (buf === null) return undefined
  // Try to detect if it's JSON
  if (buf[0] === 0x7b || buf[0] === 0x5b || buf[0] === 0x22) {
    try {
      return JSON.parse(buf.toString('utf-8'))
    } catch {
      // Not JSON, return as base64
    }
  }
  return buf.toString('base64')
}

function formatEvent (row: any, resolveData?: string) {
  const event: any = {
    eventId: String(row.id),
    runId: row.run_id,
    eventType: row.event_type,
    createdAt: row.created_at,
    specVersion: row.spec_version,
  }
  if (row.correlation_id) event.correlationId = row.correlation_id
  if (resolveData !== 'none' && row.event_data) {
    event.eventData = decodeData(row.event_data)
  }
  return event
}

function formatRun (row: any, resolveData?: string) {
  const run: any = {
    runId: row.id,
    status: row.status,
    deploymentId: row.deployment_id,
    workflowName: row.workflow_name,
    specVersion: row.spec_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (resolveData !== 'none') {
    run.input = decodeData(row.input)
    run.output = decodeData(row.output)
  } else {
    run.input = undefined
    run.output = undefined
  }
  if (row.error) run.error = row.error
  if (row.execution_context) run.executionContext = row.execution_context
  if (row.started_at) run.startedAt = row.started_at
  if (row.completed_at) run.completedAt = row.completed_at
  if (row.expired_at) run.expiredAt = row.expired_at
  return run
}

function formatStep (row: any, resolveData?: string) {
  const step: any = {
    runId: row.run_id,
    stepId: row.id,
    stepName: row.step_name,
    status: row.status,
    attempt: row.attempt,
    specVersion: row.spec_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (resolveData !== 'none') {
    step.input = decodeData(row.input)
    step.output = decodeData(row.output)
  } else {
    step.input = undefined
    step.output = undefined
  }
  if (row.error) step.error = row.error
  if (row.started_at) step.startedAt = row.started_at
  if (row.completed_at) step.completedAt = row.completed_at
  if (row.retry_after) step.retryAfter = row.retry_after
  return step
}

function formatHook (row: any) {
  const hook: any = {
    runId: row.run_id,
    hookId: row.correlation_id,
    token: row.token,
    status: row.status,
    ownerId: row.owner_id,
    projectId: row.project_id,
    environment: row.environment,
    metadata: decodeData(row.metadata),
    createdAt: row.created_at,
    specVersion: row.spec_version,
    isWebhook: row.is_webhook ?? false,
  }
  if (row.received_at) hook.receivedAt = row.received_at
  if (row.disposed_at) hook.disposedAt = row.disposed_at
  return hook
}

function formatWait (row: any) {
  return {
    waitId: row.id,
    runId: row.run_id,
    status: row.status,
    resumeAt: row.resume_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    specVersion: row.spec_version,
  }
}

async function insertEvent (client: pg.PoolClient, runId: string, appId: number, body: any): Promise<any> {
  const eventData = body.eventData ? encodeData(body.eventData) : null
  const result = await client.query(
    `INSERT INTO workflow_events (run_id, application_id, event_type, correlation_id, event_data, spec_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [runId, appId, body.eventType, body.correlationId || null, eventData, body.specVersion || null]
  )
  return result.rows[0]
}

async function eventsPlugin (app: FastifyInstance): Promise<void> {
  // Custom error handler to include meta in error responses (for SDK compatibility)
  app.setErrorHandler((error: any, _request, reply) => {
    const statusCode = error.statusCode || 500
    const response: any = {
      statusCode,
      error: statusCode >= 500 ? 'Internal Server Error' : error.message,
      message: error.message,
    }
    if (error.meta) response.meta = error.meta
    reply.code(statusCode).send(response)
  })

  // Create event (main write path)
  // Raise body limit to 20 MB — step outputs can include generated images
  // (e.g. Gemini image generation) that exceed Fastify's 1 MB default.
  app.post('/api/v1/apps/:appId/runs/:runId/events', { bodyLimit: 20 * 1024 * 1024 }, async (request) => {
    const { runId: rawRunId } = request.params as { runId: string }
    const body = request.body as any
    const appId = request.appId
    const resolveData = (request.query as any).resolveData

    // Quota checks
    if (body.eventType === 'run_created') {
      await checkRunQuota(app, appId)
    } else if (rawRunId !== 'null') {
      await checkEventQuota(app, appId, rawRunId)
    }

    const client = await app.pg.connect()
    try {
      await client.query('BEGIN')

      let result: any

      switch (body.eventType) {
        case 'run_created': {
          const runId = rawRunId === 'null' ? randomUUID() : rawRunId
          const eventData = body.eventData || {}
          const input = encodeData(eventData.input)

          await client.query(
            `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status, input, execution_context, spec_version)
             VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)`,
            [runId, appId, eventData.workflowName, eventData.deploymentId, input, eventData.executionContext || null, body.specVersion || null]
          )

          const eventRow = await insertEvent(client, runId, appId, body)
          const runRow = (await client.query('SELECT * FROM workflow_runs WHERE id = $1', [runId])).rows[0]

          result = { event: formatEvent(eventRow, resolveData), run: formatRun(runRow, resolveData) }
          break
        }

        case 'run_started': {
          await client.query(
            `UPDATE workflow_runs SET status = 'running', started_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND application_id = $2`,
            [rawRunId, appId]
          )
          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const runRow = (await client.query('SELECT * FROM workflow_runs WHERE id = $1', [rawRunId])).rows[0]
          if (!runRow) throw new RunNotFound(rawRunId)
          result = { event: formatEvent(eventRow, resolveData), run: formatRun(runRow, resolveData) }
          break
        }

        case 'run_completed': {
          // Skip duplicate completions
          const runCheck = await client.query(
            'SELECT status FROM workflow_runs WHERE id = $1 AND application_id = $2',
            [rawRunId, appId]
          )
          if (runCheck.rows.length > 0 && runCheck.rows[0].status === 'completed') {
            await client.query('COMMIT')
            const runRow = (await client.query('SELECT * FROM workflow_runs WHERE id = $1', [rawRunId])).rows[0]
            return { event: null, run: formatRun(runRow, resolveData) }
          }
          const output = body.eventData?.output ? encodeData(body.eventData.output) : null
          await client.query(
            `UPDATE workflow_runs SET status = 'completed', output = $3, completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND application_id = $2`,
            [rawRunId, appId, output]
          )
          // Clean up all hooks and waits for this run
          await client.query(
            'UPDATE workflow_hooks SET status = \'disposed\', disposed_at = NOW() WHERE run_id = $1 AND application_id = $2 AND status != \'disposed\'',
            [rawRunId, appId]
          )
          await client.query(
            'UPDATE workflow_waits SET status = \'completed\', completed_at = NOW(), updated_at = NOW() WHERE run_id = $1 AND application_id = $2 AND status = \'waiting\'',
            [rawRunId, appId]
          )
          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const runRow = (await client.query('SELECT * FROM workflow_runs WHERE id = $1', [rawRunId])).rows[0]
          if (!runRow) throw new RunNotFound(rawRunId)
          result = { event: formatEvent(eventRow, resolveData), run: formatRun(runRow, resolveData) }
          break
        }

        case 'run_failed': {
          // Skip duplicate failures
          const runFailCheck = await client.query(
            'SELECT status FROM workflow_runs WHERE id = $1 AND application_id = $2',
            [rawRunId, appId]
          )
          if (runFailCheck.rows.length > 0 && (runFailCheck.rows[0].status === 'failed' || runFailCheck.rows[0].status === 'completed')) {
            await client.query('COMMIT')
            const runRow = (await client.query('SELECT * FROM workflow_runs WHERE id = $1', [rawRunId])).rows[0]
            return { event: null, run: formatRun(runRow, resolveData) }
          }
          const rawError = body.eventData?.error
          const error = rawError
            ? {
                message: typeof rawError === 'string' ? rawError : (rawError.message || JSON.stringify(rawError)),
                code: body.eventData.errorCode,
              }
            : null
          await client.query(
            `UPDATE workflow_runs SET status = 'failed', error = $3, completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND application_id = $2`,
            [rawRunId, appId, error ? JSON.stringify(error) : null]
          )
          await client.query(
            'UPDATE workflow_hooks SET status = \'disposed\', disposed_at = NOW() WHERE run_id = $1 AND application_id = $2 AND status != \'disposed\'',
            [rawRunId, appId]
          )
          await client.query(
            'UPDATE workflow_waits SET status = \'completed\', completed_at = NOW(), updated_at = NOW() WHERE run_id = $1 AND application_id = $2 AND status = \'waiting\'',
            [rawRunId, appId]
          )
          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const runRow = (await client.query('SELECT * FROM workflow_runs WHERE id = $1', [rawRunId])).rows[0]
          if (!runRow) throw new RunNotFound(rawRunId)
          result = { event: formatEvent(eventRow, resolveData), run: formatRun(runRow, resolveData) }
          break
        }

        case 'run_cancelled': {
          await client.query(
            `UPDATE workflow_runs SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND application_id = $2`,
            [rawRunId, appId]
          )
          await client.query(
            'UPDATE workflow_hooks SET status = \'disposed\', disposed_at = NOW() WHERE run_id = $1 AND application_id = $2 AND status != \'disposed\'',
            [rawRunId, appId]
          )
          await client.query(
            'UPDATE workflow_waits SET status = \'completed\', completed_at = NOW(), updated_at = NOW() WHERE run_id = $1 AND application_id = $2 AND status = \'waiting\'',
            [rawRunId, appId]
          )
          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const runRow = (await client.query('SELECT * FROM workflow_runs WHERE id = $1', [rawRunId])).rows[0]
          if (!runRow) throw new RunNotFound(rawRunId)
          result = { event: formatEvent(eventRow, resolveData), run: formatRun(runRow, resolveData) }
          break
        }

        case 'run_expired': {
          await client.query(
            `UPDATE workflow_runs SET status = 'expired', expired_at = NOW(), completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND application_id = $2`,
            [rawRunId, appId]
          )
          await client.query(
            'UPDATE workflow_hooks SET status = \'disposed\', disposed_at = NOW() WHERE run_id = $1 AND application_id = $2 AND status != \'disposed\'',
            [rawRunId, appId]
          )
          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const runRow = (await client.query('SELECT * FROM workflow_runs WHERE id = $1', [rawRunId])).rows[0]
          if (!runRow) throw new RunNotFound(rawRunId)
          result = { event: formatEvent(eventRow, resolveData), run: formatRun(runRow, resolveData) }
          break
        }

        case 'step_created': {
          const stepId = randomUUID()
          const eventData = body.eventData || {}
          const input = encodeData(eventData.input)

          const insertResult = await client.query(
            `INSERT INTO workflow_steps (id, run_id, application_id, correlation_id, step_name, status, input, spec_version)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
             ON CONFLICT (run_id, correlation_id, step_name) DO NOTHING
             RETURNING id`,
            [stepId, rawRunId, appId, body.correlationId, eventData.stepName, input, body.specVersion || null]
          )

          // If the insert was a no-op (duplicate), fetch the existing step
          let actualStepId = insertResult.rows[0]?.id
          if (!actualStepId) {
            const existing = await client.query(
              'SELECT id FROM workflow_steps WHERE run_id = $1 AND correlation_id = $2 AND step_name = $3 LIMIT 1',
              [rawRunId, body.correlationId, eventData.stepName]
            )
            actualStepId = existing.rows[0]?.id
          }

          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const stepRow = actualStepId
            ? (await client.query('SELECT * FROM workflow_steps WHERE id = $1', [actualStepId])).rows[0]
            : null
          result = { event: formatEvent(eventRow, resolveData), step: stepRow ? formatStep(stepRow, resolveData) : undefined }
          break
        }

        case 'step_started': {
          // Find step by correlation_id + run_id (LIMIT 1 to handle any legacy duplicates)
          const stepResult = await client.query(
            'SELECT * FROM workflow_steps WHERE run_id = $1 AND correlation_id = $2 AND application_id = $3 LIMIT 1',
            [rawRunId, body.correlationId, appId]
          )

          if (stepResult.rows.length > 0) {
            const step = stepResult.rows[0]

            // Check if step is in a terminal state (completed/cancelled)
            if (step.status === 'completed' || step.status === 'cancelled') {
              await client.query('COMMIT')
              const err: any = new Error(`Step ${body.correlationId} is in terminal state: ${step.status}`)
              err.statusCode = 409
              throw err
            }

            // Check if retry_after timestamp hasn't been reached yet
            if (step.retry_after && new Date(step.retry_after) > new Date()) {
              await client.query('COMMIT')
              const err: any = new Error(`Step ${body.correlationId} retryAfter not reached`)
              err.statusCode = 425
              err.meta = { retryAfter: new Date(step.retry_after).toISOString() }
              throw err
            }

            // Increment attempt when retrying: after a retry cycle (step_started →
            // error → step_retrying → step_started), started_at is already set.
            // We can't rely on retry_after because the SDK only sends retryAfter
            // for RetryableError — regular errors have retry_after = NULL.
            const isRetry = step.status === 'pending' && step.started_at !== null
            const attempt = isRetry ? step.attempt + 1 : (body.eventData?.attempt || step.attempt || 1)

            await client.query(
              `UPDATE workflow_steps SET status = 'running', attempt = $3, retry_after = NULL, started_at = COALESCE(started_at, NOW()), updated_at = NOW()
               WHERE id = $1 AND application_id = $2`,
              [step.id, appId, attempt]
            )
          }

          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const stepRow = stepResult.rows.length > 0
            ? (await client.query('SELECT * FROM workflow_steps WHERE id = $1', [stepResult.rows[0].id])).rows[0]
            : null
          result = { event: formatEvent(eventRow, resolveData), step: stepRow ? formatStep(stepRow, resolveData) : undefined }
          break
        }

        case 'step_completed': {
          const resultData = body.eventData?.result ? encodeData(body.eventData.result) : null
          const stepResult = await client.query(
            'SELECT id, status FROM workflow_steps WHERE run_id = $1 AND correlation_id = $2 AND application_id = $3 LIMIT 1',
            [rawRunId, body.correlationId, appId]
          )
          // Skip duplicate completions — the SDK may retry after a transient
          // failure even though the first request succeeded server-side.
          if (stepResult.rows.length > 0 && stepResult.rows[0].status === 'completed') {
            await client.query('COMMIT')
            const stepRow = (await client.query('SELECT * FROM workflow_steps WHERE id = $1', [stepResult.rows[0].id])).rows[0]
            return { event: null, step: formatStep(stepRow, resolveData) }
          }
          if (stepResult.rows.length > 0) {
            await client.query(
              `UPDATE workflow_steps SET status = 'completed', output = $3, completed_at = NOW(), updated_at = NOW()
               WHERE id = $1 AND application_id = $2`,
              [stepResult.rows[0].id, appId, resultData]
            )
          }
          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const stepRow = stepResult.rows.length > 0
            ? (await client.query('SELECT * FROM workflow_steps WHERE id = $1', [stepResult.rows[0].id])).rows[0]
            : null
          result = { event: formatEvent(eventRow, resolveData), step: stepRow ? formatStep(stepRow, resolveData) : undefined }
          break
        }

        case 'step_failed': {
          const error = body.eventData
            ? { message: String(body.eventData.error || ''), stack: body.eventData.stack }
            : null
          const stepResult = await client.query(
            'SELECT id, status FROM workflow_steps WHERE run_id = $1 AND correlation_id = $2 AND application_id = $3 LIMIT 1',
            [rawRunId, body.correlationId, appId]
          )
          // Skip duplicate failures — same idempotency guard as step_completed.
          if (stepResult.rows.length > 0 && (stepResult.rows[0].status === 'failed' || stepResult.rows[0].status === 'completed')) {
            await client.query('COMMIT')
            const stepRow = (await client.query('SELECT * FROM workflow_steps WHERE id = $1', [stepResult.rows[0].id])).rows[0]
            return { event: null, step: formatStep(stepRow, resolveData) }
          }
          if (stepResult.rows.length > 0) {
            await client.query(
              `UPDATE workflow_steps SET status = 'failed', error = $3, completed_at = NOW(), updated_at = NOW()
               WHERE id = $1 AND application_id = $2`,
              [stepResult.rows[0].id, appId, error ? JSON.stringify(error) : null]
            )
          }
          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const stepRow = stepResult.rows.length > 0
            ? (await client.query('SELECT * FROM workflow_steps WHERE id = $1', [stepResult.rows[0].id])).rows[0]
            : null
          result = { event: formatEvent(eventRow, resolveData), step: stepRow ? formatStep(stepRow, resolveData) : undefined }
          break
        }

        case 'step_retrying': {
          const error = body.eventData
            ? { message: String(body.eventData.error || ''), stack: body.eventData.stack }
            : null
          const retryAfter = body.eventData?.retryAfter ? new Date(body.eventData.retryAfter) : null
          const stepResult = await client.query(
            'SELECT id FROM workflow_steps WHERE run_id = $1 AND correlation_id = $2 AND application_id = $3 LIMIT 1',
            [rawRunId, body.correlationId, appId]
          )
          if (stepResult.rows.length > 0) {
            await client.query(
              `UPDATE workflow_steps SET status = 'pending', error = $3, retry_after = $4, updated_at = NOW()
               WHERE id = $1 AND application_id = $2`,
              [stepResult.rows[0].id, appId, error ? JSON.stringify(error) : null, retryAfter]
            )
          }
          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const stepRow = stepResult.rows.length > 0
            ? (await client.query('SELECT * FROM workflow_steps WHERE id = $1', [stepResult.rows[0].id])).rows[0]
            : null
          result = { event: formatEvent(eventRow, resolveData), step: stepRow ? formatStep(stepRow, resolveData) : undefined }
          break
        }

        case 'hook_created': {
          const hookId = randomUUID()
          const eventData = body.eventData || {}
          const metadata = eventData.metadata ? encodeData(eventData.metadata) : null

          // ON CONFLICT DO NOTHING handles the partial unique index atomically.
          // If another active hook with the same token exists, the INSERT is skipped.
          const insertResult = await client.query(
            `INSERT INTO workflow_hooks (id, run_id, application_id, correlation_id, token, owner_id, project_id, environment, metadata, spec_version, is_webhook)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (token) WHERE status = 'pending' DO NOTHING
             RETURNING id`,
            [hookId, rawRunId, appId, body.correlationId, eventData.token,
              eventData.ownerId || '', eventData.projectId || '', eventData.environment || '',
              metadata, body.specVersion || null, eventData.isWebhook ?? false]
          )

          if (insertResult.rows.length === 0) {
            // Token conflict — another active hook already exists
            const conflictBody = {
              eventType: 'hook_conflict',
              correlationId: body.correlationId,
              eventData: { token: eventData.token },
              specVersion: body.specVersion,
            }
            const eventRow = await insertEvent(client, rawRunId, appId, conflictBody)
            await client.query('COMMIT')
            return { event: formatEvent(eventRow, resolveData) }
          }

          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const hookRow = (await client.query('SELECT * FROM workflow_hooks WHERE id = $1', [hookId])).rows[0]
          result = { event: formatEvent(eventRow, resolveData), hook: formatHook(hookRow) }
          break
        }

        case 'hook_received': {
          // Update hook status to received
          let hookRow = null
          if (body.correlationId) {
            const hookResult = await client.query(
              `UPDATE workflow_hooks SET status = 'received', received_at = NOW()
               WHERE run_id = $1 AND correlation_id = $2 AND application_id = $3
               RETURNING *`,
              [rawRunId, body.correlationId, appId]
            )
            if (hookResult.rows.length > 0) hookRow = hookResult.rows[0]
          }
          const eventRow = await insertEvent(client, rawRunId, appId, body)

          result = { event: formatEvent(eventRow, resolveData), hook: hookRow ? formatHook(hookRow) : undefined }
          break
        }

        case 'hook_disposed': {
          // Mark hook as disposed
          let hookRow = null
          if (body.correlationId) {
            const hookResult = await client.query(
              `UPDATE workflow_hooks SET status = 'disposed', disposed_at = NOW()
               WHERE run_id = $1 AND correlation_id = $2 AND application_id = $3
               RETURNING *`,
              [rawRunId, body.correlationId, appId]
            )
            if (hookResult.rows.length > 0) hookRow = hookResult.rows[0]
          }
          const eventRow = await insertEvent(client, rawRunId, appId, body)
          result = { event: formatEvent(eventRow, resolveData), hook: hookRow ? formatHook(hookRow) : undefined }
          break
        }

        case 'wait_created': {
          const waitId = randomUUID()
          const eventData = body.eventData || {}
          const resumeAt = eventData.resumeAt ? new Date(eventData.resumeAt) : null

          await client.query(
            `INSERT INTO workflow_waits (id, run_id, application_id, correlation_id, status, resume_at, spec_version)
             VALUES ($1, $2, $3, $4, 'waiting', $5, $6)`,
            [waitId, rawRunId, appId, body.correlationId, resumeAt, body.specVersion || null]
          )

          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const waitRow = (await client.query('SELECT * FROM workflow_waits WHERE id = $1', [waitId])).rows[0]
          result = { event: formatEvent(eventRow, resolveData), wait: formatWait(waitRow) }
          break
        }

        case 'wait_completed': {
          const waitResult = await client.query(
            'SELECT id, status FROM workflow_waits WHERE run_id = $1 AND correlation_id = $2 AND application_id = $3',
            [rawRunId, body.correlationId, appId]
          )
          // Skip duplicate completions — same idempotency guard as step_completed.
          if (waitResult.rows.length > 0 && waitResult.rows[0].status === 'completed') {
            await client.query('COMMIT')
            const waitRow = (await client.query('SELECT * FROM workflow_waits WHERE id = $1', [waitResult.rows[0].id])).rows[0]
            return { event: null, wait: formatWait(waitRow) }
          }
          if (waitResult.rows.length > 0) {
            await client.query(
              `UPDATE workflow_waits SET status = 'completed', completed_at = NOW(), updated_at = NOW()
               WHERE id = $1`,
              [waitResult.rows[0].id]
            )
          }
          const eventRow = await insertEvent(client, rawRunId, appId, body)
          const waitRow = waitResult.rows.length > 0
            ? (await client.query('SELECT * FROM workflow_waits WHERE id = $1', [waitResult.rows[0].id])).rows[0]
            : null
          result = { event: formatEvent(eventRow, resolveData), wait: waitRow ? formatWait(waitRow) : undefined }
          break
        }

        default:
          throw new BadRequest(`unknown event type: ${body.eventType}`)
      }

      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // List events for a run
  app.get('/api/v1/apps/:appId/runs/:runId/events', async (request) => {
    const { runId } = request.params as { runId: string }
    const query = request.query as { limit?: string; cursor?: string; sortOrder?: string; resolveData?: string }
    const appId = request.appId
    const limit = Math.min(parseInt(query.limit || '100', 10), 1000)
    const sortOrder = query.sortOrder === 'desc' ? 'DESC' : 'ASC'
    const cursor = query.cursor ? parseInt(query.cursor, 10) : 0

    const result = await app.pg.query(
      `SELECT * FROM workflow_events
       WHERE run_id = $1 AND application_id = $2 AND id > $3
       ORDER BY id ${sortOrder}
       LIMIT $4`,
      [runId, appId, cursor, limit + 1]
    )

    const hasMore = result.rows.length > limit
    const data = result.rows.slice(0, limit).map(row => formatEvent(row, query.resolveData))
    const nextCursor = hasMore && data.length > 0 ? String(result.rows[limit - 1].id) : null

    return { data, cursor: nextCursor, hasMore }
  })

  // List events by correlation ID
  app.get('/api/v1/apps/:appId/events/by-correlation', async (request) => {
    const query = request.query as { correlationId: string; limit?: string; cursor?: string; resolveData?: string }
    const appId = request.appId
    const limit = Math.min(parseInt(query.limit || '100', 10), 1000)
    const cursor = query.cursor ? parseInt(query.cursor, 10) : 0

    const result = await app.pg.query(
      `SELECT * FROM workflow_events
       WHERE application_id = $1 AND correlation_id = $2 AND id > $3
       ORDER BY id ASC
       LIMIT $4`,
      [appId, query.correlationId, cursor, limit + 1]
    )

    const hasMore = result.rows.length > limit
    const data = result.rows.slice(0, limit).map(row => formatEvent(row, query.resolveData))
    const nextCursor = hasMore && data.length > 0 ? String(result.rows[limit - 1].id) : null

    return { data, cursor: nextCursor, hasMore }
  })
}

export { formatRun, formatStep, formatHook, formatWait, formatEvent, decodeData, encodeData }

export default fp(eventsPlugin, { name: 'events', dependencies: ['auth'] })
