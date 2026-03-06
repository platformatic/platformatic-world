import type { FastifyInstance } from 'fastify'
import { Forbidden } from '../lib/errors.ts'

export default async function drainingPlugin (app: FastifyInstance): Promise<void> {
  // Get version status — called by ICC
  app.get('/api/v1/apps/:appId/versions/:deploymentId/status', async (request) => {
    if (!request.isMasterKey) throw new Forbidden('master key required')

    const { deploymentId } = request.params as { deploymentId: string }
    const appId = request.appId

    const [runs, hooks, waits, messages] = await Promise.all([
      app.pg.query(
        `SELECT COUNT(*)::int as count FROM workflow_runs
         WHERE application_id = $1 AND deployment_id = $2 AND status IN ('pending', 'running')`,
        [appId, deploymentId]
      ),
      app.pg.query(
        `SELECT COUNT(*)::int as count FROM workflow_hooks h
         JOIN workflow_runs r ON h.run_id = r.id
         WHERE h.application_id = $1 AND r.deployment_id = $2 AND h.status NOT IN ('disposed')`,
        [appId, deploymentId]
      ),
      app.pg.query(
        `SELECT COUNT(*)::int as count FROM workflow_waits w
         JOIN workflow_runs r ON w.run_id = r.id
         WHERE w.application_id = $1 AND r.deployment_id = $2 AND w.status = 'waiting'`,
        [appId, deploymentId]
      ),
      app.pg.query(
        `SELECT COUNT(*)::int as count FROM workflow_queue_messages
         WHERE application_id = $1 AND deployment_version = $2 AND status IN ('pending', 'deferred', 'failed')`,
        [appId, deploymentId]
      ),
    ])

    return {
      activeRuns: runs.rows[0].count,
      pendingHooks: hooks.rows[0].count,
      pendingWaits: waits.rows[0].count,
      queuedMessages: messages.rows[0].count,
    }
  })

  // Force-expire a deployment version — called by ICC
  app.post('/api/v1/apps/:appId/versions/:deploymentId/expire', async (request) => {
    if (!request.isMasterKey) throw new Forbidden('master key required')

    const { deploymentId } = request.params as { deploymentId: string }
    const appId = request.appId

    const client = await app.pg.connect()
    try {
      await client.query('BEGIN')

      // 1. Cancel all in-flight runs
      const cancelledRuns = await client.query(
        `UPDATE workflow_runs SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
         WHERE application_id = $1 AND deployment_id = $2 AND status IN ('pending', 'running')
         RETURNING id`,
        [appId, deploymentId]
      )

      // 2. Create run_cancelled events
      for (const row of cancelledRuns.rows) {
        await client.query(
          `INSERT INTO workflow_events (run_id, application_id, event_type, event_data)
           VALUES ($1, $2, 'run_cancelled', NULL)`,
          [row.id, appId]
        )
      }

      // 3. Dispose hooks for the cancelled runs only
      if (cancelledRuns.rows.length > 0) {
        const runIds = cancelledRuns.rows.map(r => r.id)
        await client.query(
          `UPDATE workflow_hooks SET status = 'disposed', disposed_at = NOW()
           WHERE application_id = $1 AND run_id = ANY($2::varchar[]) AND status != 'disposed'`,
          [appId, runIds]
        )
      }

      // 4. Dead-letter queued messages
      const deadLettered = await client.query(
        `UPDATE workflow_queue_messages SET status = 'dead'
         WHERE application_id = $1 AND deployment_version = $2
           AND status IN ('pending', 'deferred', 'failed')
         RETURNING id`,
        [appId, deploymentId]
      )

      // 5. Deregister handlers
      await client.query(
        `DELETE FROM workflow_queue_handlers
         WHERE application_id = $1 AND deployment_version = $2`,
        [appId, deploymentId]
      )

      // 6. Update version status
      await client.query(
        `UPDATE workflow_deployment_versions SET status = 'expired', updated_at = NOW()
         WHERE application_id = $1 AND deployment_version = $2`,
        [appId, deploymentId]
      )

      await client.query('COMMIT')

      return {
        cancelledRuns: cancelledRuns.rows.length,
        deadLetteredMessages: deadLettered.rows.length,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}
