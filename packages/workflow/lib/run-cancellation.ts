import type pg from 'pg'

export interface CancelWorkflowRunResult {
  cancelled: boolean
  run: any | null
}

/**
 * Atomically make cancellation the first terminal transition for a run.
 *
 * The caller owns the surrounding transaction. The conditional UPDATE locks
 * the run row and serializes against terminal event writers; cleanup and the
 * cancellation event are emitted only by the transaction that changed the
 * run from active to cancelled.
 */
export async function cancelWorkflowRun (
  client: pg.PoolClient,
  applicationId: number,
  runId: string
): Promise<CancelWorkflowRunResult> {
  const result = await client.query(
    `UPDATE workflow_runs SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND application_id = $2 AND status IN ('pending', 'running')
     RETURNING *`,
    [runId, applicationId]
  )

  if (result.rows.length === 0) {
    const existing = await client.query(
      'SELECT * FROM workflow_runs WHERE id = $1 AND application_id = $2',
      [runId, applicationId]
    )
    return { cancelled: false, run: existing.rows[0] ?? null }
  }

  await client.query(
    `UPDATE workflow_hooks SET status = 'disposed', disposed_at = NOW()
     WHERE run_id = $1 AND application_id = $2 AND status != 'disposed'`,
    [runId, applicationId]
  )
  await client.query(
    `UPDATE workflow_waits SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE run_id = $1 AND application_id = $2 AND status = 'waiting'`,
    [runId, applicationId]
  )
  await client.query(
    `UPDATE workflow_queue_messages SET status = 'dead'
     WHERE run_id = $1 AND application_id = $2 AND status IN ('pending', 'deferred', 'failed')`,
    [runId, applicationId]
  )
  await client.query(
    `INSERT INTO workflow_events (run_id, application_id, event_type)
     VALUES ($1, $2, 'run_cancelled')`,
    [runId, applicationId]
  )

  return { cancelled: true, run: result.rows[0] }
}
