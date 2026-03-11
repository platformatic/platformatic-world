import type pg from 'pg'

export interface RouteResult {
  url: string
  podId: string
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

  // Find registered handlers for this version
  const handlers = await pool.query(
    `SELECT pod_id, workflow_url, step_url, webhook_url FROM workflow_queue_handlers
     WHERE application_id = $1 AND deployment_version = $2
     ORDER BY last_heartbeat DESC`,
    [appId, deploymentVersion]
  )

  if (handlers.rows.length === 0) return null

  // Round-robin: pick based on a simple random selection
  const handler = handlers.rows[Math.floor(Math.random() * handlers.rows.length)]

  // Determine target URL based on queue name
  let url: string
  if (queueName.startsWith('__wkf_step_')) {
    url = handler.step_url
  } else if (queueName.startsWith('__wkf_workflow_')) {
    url = handler.workflow_url
  } else {
    url = handler.webhook_url
  }

  return { url, podId: handler.pod_id }
}
