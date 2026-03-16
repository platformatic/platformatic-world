import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { RunNotFound } from '../lib/errors.ts'
import { formatRun } from './events.ts'

async function runsPlugin (app: FastifyInstance): Promise<void> {
  // Get run by ID
  app.get('/api/v1/apps/:appId/runs/:runId', async (request) => {
    const { runId } = request.params as { runId: string }
    const query = request.query as { resolveData?: string }
    const appId = request.appId

    const result = await app.pg.query(
      'SELECT * FROM workflow_runs WHERE id = $1 AND application_id = $2',
      [runId, appId]
    )

    if (result.rows.length === 0) throw new RunNotFound(runId)
    return formatRun(result.rows[0], query.resolveData)
  })

  // List runs
  app.get('/api/v1/apps/:appId/runs', async (request) => {
    const query = request.query as {
      workflowName?: string
      status?: string
      deploymentId?: string
      limit?: string
      cursor?: string
      resolveData?: string
    }
    const appId = request.appId
    const limit = Math.min(parseInt(query.limit || '50', 10), 1000)
    const conditions = ['application_id = $1']
    const params: any[] = [appId]
    let paramIdx = 2

    if (query.workflowName) {
      conditions.push(`workflow_name = $${paramIdx++}`)
      params.push(query.workflowName)
    }
    if (query.status) {
      conditions.push(`status = $${paramIdx++}`)
      params.push(query.status)
    }
    if (query.deploymentId) {
      conditions.push(`deployment_id = $${paramIdx++}`)
      params.push(query.deploymentId)
    }
    if (query.cursor) {
      conditions.push(`created_at < $${paramIdx++}`)
      params.push(new Date(query.cursor))
    }

    params.push(limit + 1)

    const result = await app.pg.query(
      `SELECT * FROM workflow_runs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramIdx}`,
      params
    )

    const hasMore = result.rows.length > limit
    const data = result.rows.slice(0, limit).map(row => formatRun(row, query.resolveData))
    const nextCursor = hasMore && data.length > 0
      ? result.rows[limit - 1].created_at.toISOString()
      : null

    return { data, cursor: nextCursor, hasMore }
  })
  // Get workflow step template from the most recent completed run
  // Used by the UI to pre-render step placeholders for in-progress runs
  app.get('/api/v1/apps/:appId/workflows/:workflowName/template', async (request, reply) => {
    const { workflowName } = request.params as { workflowName: string }
    const query = request.query as { deploymentId?: string }
    const appId = request.appId

    const conditions = ['r.application_id = $1', 'r.workflow_name = $2', "r.status = 'completed'"]
    const params: any[] = [appId, workflowName]
    let paramIdx = 3

    if (query.deploymentId) {
      conditions.push(`r.deployment_id = $${paramIdx++}`)
      params.push(query.deploymentId)
    }

    // Find the most recent completed run
    const runResult = await app.pg.query(
      `SELECT r.id FROM workflow_runs r
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.created_at DESC LIMIT 1`,
      params
    )

    if (runResult.rows.length === 0) {
      reply.code(404)
      return { error: 'No completed run found for this workflow' }
    }

    const sourceRunId = runResult.rows[0].id

    // Get all steps from that run, ordered by creation time
    const stepsResult = await app.pg.query(
      `SELECT step_name, created_at, started_at, completed_at
       FROM workflow_steps
       WHERE run_id = $1 AND application_id = $2
       ORDER BY created_at ASC`,
      [sourceRunId, appId]
    )

    // Check for hooks and waits
    const hooksResult = await app.pg.query(
      'SELECT COUNT(*) as count FROM workflow_hooks WHERE run_id = $1 AND application_id = $2',
      [sourceRunId, appId]
    )
    const waitsResult = await app.pg.query(
      'SELECT COUNT(*) as count FROM workflow_waits WHERE run_id = $1 AND application_id = $2',
      [sourceRunId, appId]
    )

    // Build step template with parallel group detection
    const steps: { stepName: string; order: number; parallelGroup?: number }[] = []
    let currentOrder = 0
    let currentGroupId = 0
    let prevEnd = 0

    for (let i = 0; i < stepsResult.rows.length; i++) {
      const row = stepsResult.rows[i]
      const start = new Date(row.started_at || row.created_at).getTime()
      const end = new Date(row.completed_at || row.started_at || row.created_at).getTime()

      if (i > 0 && start < prevEnd) {
        // Overlaps with previous — same parallel group
        steps[steps.length - 1].parallelGroup = currentGroupId
        steps.push({ stepName: row.step_name, order: currentOrder, parallelGroup: currentGroupId })
      } else {
        if (i > 0) {
          currentOrder++
          currentGroupId++
        }
        steps.push({ stepName: row.step_name, order: currentOrder })
      }

      prevEnd = Math.max(prevEnd, end)
    }

    return {
      steps,
      hasHooks: parseInt(hooksResult.rows[0].count) > 0,
      hasWaits: parseInt(waitsResult.rows[0].count) > 0,
      sourceRunId
    }
  })
}

export default fp(runsPlugin, { name: 'runs', dependencies: ['auth'] })
