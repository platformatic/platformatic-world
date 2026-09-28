import fp from 'fastify-plugin'
import { monotonicFactory } from 'ulid'
import type { FastifyInstance } from 'fastify'

const ulid = monotonicFactory()
import { RunNotFound, BadRequest } from '../lib/errors.ts'
import { cancelWorkflowRun } from '../lib/run-cancellation.ts'
import { workflowQueueName } from '../queue/names.ts'
import { formatRun, encodeData } from './events.ts'

async function runActionsPlugin (app: FastifyInstance): Promise<void> {
  // Replay a run — creates a NEW run with the same workflow and input,
  // targeting the SAME deployment version as the original run.
  app.post('/api/v1/apps/:appId/runs/:runId/replay', async (request) => {
    const { runId } = request.params as { runId: string }
    const appId = request.appId

    const original = await app.pg.query(
      'SELECT * FROM workflow_runs WHERE id = $1 AND application_id = $2',
      [runId, appId]
    )
    if (original.rows.length === 0) throw new RunNotFound(runId)

    const row = original.rows[0]
    const newRunId = `wrun_${ulid()}`

    const client = await app.pg.connect()
    try {
      await client.query('BEGIN')

      // Create the new run with the original's deployment_id
      await client.query(
        `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status, input, execution_context, spec_version)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)`,
        [newRunId, appId, row.workflow_name, row.deployment_id, row.input, row.execution_context, row.spec_version]
      )

      // Create run_created event
      await client.query(
        `INSERT INTO workflow_events (run_id, application_id, event_type, event_data, spec_version)
         VALUES ($1, $2, 'run_created', $3, $4)`,
        [newRunId, appId, encodeData({
          workflowName: row.workflow_name,
          deploymentId: row.deployment_id,
          replayedFrom: runId
        }), row.spec_version]
      )

      // Preserve the namespace used by the original run when one was persisted.
      const originalQueue = await client.query(
        `SELECT queue_name FROM workflow_queue_messages
         WHERE run_id = $1 AND application_id = $2
           AND queue_name ~ '^__([a-z][a-z0-9]*_)?wkf_workflow_.+$'
         ORDER BY id ASC LIMIT 1`,
        [runId, appId]
      )
      const queueName = originalQueue.rows[0]?.queue_name || workflowQueueName(row.workflow_name)
      await client.query(
        `INSERT INTO workflow_queue_messages
         (queue_name, run_id, deployment_version, application_id, payload, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [queueName, newRunId, row.deployment_id, appId,
          JSON.stringify({ runId: newRunId })]
      )

      await client.query('COMMIT')

      // Wake the poller
      await app.pg.query("SELECT pg_notify('deferred_messages', '{}')")

      const newRow = (await app.pg.query('SELECT * FROM workflow_runs WHERE id = $1', [newRunId])).rows[0]
      return formatRun(newRow)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // Cancel an active run
  app.post('/api/v1/apps/:appId/runs/:runId/cancel', async (request) => {
    const { runId } = request.params as { runId: string }
    const appId = request.appId

    const client = await app.pg.connect()
    try {
      await client.query('BEGIN')

      const result = await cancelWorkflowRun(client, appId, runId)
      if (!result.run) throw new RunNotFound(runId)
      if (!result.cancelled) throw new BadRequest(`run is already in terminal state: ${result.run.status}`)

      await client.query('COMMIT')
      return formatRun(result.run)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // Wake up — cancel all pending sleeps (waits) for a run
  app.post('/api/v1/apps/:appId/runs/:runId/wake-up', async (request) => {
    const { runId } = request.params as { runId: string }
    const appId = request.appId

    const existing = await app.pg.query(
      'SELECT id FROM workflow_runs WHERE id = $1 AND application_id = $2',
      [runId, appId]
    )
    if (existing.rows.length === 0) throw new RunNotFound(runId)

    const result = await app.pg.query(
      `UPDATE workflow_waits SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE run_id = $1 AND application_id = $2 AND status = 'waiting'
       RETURNING id, correlation_id`,
      [runId, appId]
    )

    // Promote any deferred messages so steps resume
    if (result.rows.length > 0) {
      await app.pg.query(
        `UPDATE workflow_queue_messages SET status = 'pending', deliver_at = NULL
         WHERE run_id = $1 AND application_id = $2 AND status = 'deferred'
           AND queue_name ~ '^__([a-z][a-z0-9]*_)?wkf_(workflow|step)_.+$'`,
        [runId, appId]
      )
      await app.pg.query("SELECT pg_notify('deferred_messages', '{}')")
    }

    return { stoppedCount: result.rows.length }
  })
}

export default fp(runActionsPlugin, { name: 'run-actions', dependencies: ['auth'] })
