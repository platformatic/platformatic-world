import type pg from 'pg'

export interface RouteResult {
  url: string
}

export async function routeMessage (
  pool: pg.Pool,
  appId: number,
  deploymentVersion: string,
  queueName: string
): Promise<RouteResult | null> {
  // Check version status
  const versionResult = await pool.query(
    `SELECT status FROM workflow_deployment_versions
     WHERE application_id = $1 AND deployment_version = $2`,
    [appId, deploymentVersion]
  )

  if (versionResult.rows.length > 0 && versionResult.rows[0].status === 'expired') {
    return null // Version expired
  }

  // Find registered destinations for this version.
  const registrations = await pool.query(
    `SELECT workflow_url, step_url, webhook_url FROM workflow_queue_handlers
     WHERE application_id = $1 AND deployment_version = $2
     ORDER BY last_heartbeat DESC`,
    [appId, deploymentVersion]
  )

  if (registrations.rows.length === 0) return null

  const queueMatch = queueName.match(/^__(?:[a-z][a-z0-9]*_)?wkf_(workflow|step)_.+$/)
  const urlField = queueMatch?.[1] === 'step'
    ? 'step_url'
    : queueMatch?.[1] === 'workflow' ? 'workflow_url' : 'webhook_url'
  const urls = [...new Set(registrations.rows.map(registration => registration[urlField]))]
  const url = urls[Math.floor(Math.random() * urls.length)]

  return { url }
}
