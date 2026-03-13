import fp from 'fastify-plugin'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { RunNotFound, BadRequest } from '../lib/errors.ts'
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
    const newRunId = randomUUID()

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

      // Enqueue flow message targeting the original deployment version
      const queueName = `__wkf_workflow_${row.workflow_name}`
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

      const result = await client.query(
        `UPDATE workflow_runs SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND application_id = $2 AND status IN ('pending', 'running')
         RETURNING *`,
        [runId, appId]
      )

      if (result.rows.length === 0) {
        const existing = await client.query(
          'SELECT status FROM workflow_runs WHERE id = $1 AND application_id = $2',
          [runId, appId]
        )
        if (existing.rows.length === 0) throw new RunNotFound(runId)
        throw new BadRequest(`run is already in terminal state: ${existing.rows[0].status}`)
      }

      // Clean up hooks and waits
      await client.query(
        `UPDATE workflow_hooks SET status = 'disposed', disposed_at = NOW()
         WHERE run_id = $1 AND application_id = $2 AND status != 'disposed'`,
        [runId, appId]
      )
      await client.query(
        `UPDATE workflow_waits SET status = 'completed', completed_at = NOW(), updated_at = NOW()
         WHERE run_id = $1 AND application_id = $2 AND status = 'waiting'`,
        [runId, appId]
      )

      // Dead-letter queued messages for this run
      await client.query(
        `UPDATE workflow_queue_messages SET status = 'dead'
         WHERE run_id = $1 AND application_id = $2 AND status IN ('pending', 'deferred', 'failed')`,
        [runId, appId]
      )

      // Create cancel event
      await client.query(
        `INSERT INTO workflow_events (run_id, application_id, event_type)
         VALUES ($1, $2, 'run_cancelled')`,
        [runId, appId]
      )

      await client.query('COMMIT')
      return formatRun(result.rows[0])
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
           AND queue_name LIKE '__wkf_step_%'`,
        [runId, appId]
      )
      await app.pg.query("SELECT pg_notify('deferred_messages', '{}')")
    }

    return { stoppedCount: result.rows.length }
  })
}

export default fp(runActionsPlugin, { name: 'run-actions', dependencies: ['auth'] })
