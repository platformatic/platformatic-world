// Workflow-domain consequences of a queue delivery: what it means for a run, a
// step, and the event log when a message cannot be delivered.
//
// Deliberately separate from the transport that carries the message. Claiming,
// leasing, acking, retrying and dead-lettering are queue mechanics and could be
// swapped for another broker; everything here has to happen identically no
// matter what moved the bytes, because it writes the durable event log the
// runtime replays.

import type pg from 'pg'
import { decode, encode } from 'cbor-x'
import { isStepQueue, isWorkflowQueue, workflowNameFromQueue, workflowQueueNameLike } from './names.ts'

export interface FailureDetail {
  code: string
  message: string
  at: string
  attempt: number
  statusCode?: number
  target: {
    queueName: string
    deploymentVersion: string
    url?: string
  }
}

export interface RegisteredTarget {
  url: string
}

export function sanitizeTargetUrl (value: string): string | undefined {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().slice(0, 1024)
  } catch {
    return undefined
  }
}

export function failureDetail (
  msg: any,
  attempt: number,
  code: string,
  message: string,
  target?: RegisteredTarget,
  statusCode?: number
): FailureDetail {
  return {
    code: code.slice(0, 64),
    message: message.slice(0, 512),
    at: new Date().toISOString(),
    attempt,
    ...(statusCode !== undefined ? { statusCode } : {}),
    target: {
      queueName: String(msg.queue_name).slice(0, 256),
      deploymentVersion: String(msg.deployment_version).slice(0, 256),
      ...(target?.url ? { url: sanitizeTargetUrl(target.url) } : {}),
    },
  }
}

export function queuePayload (msg: any): any {
  return msg.payload_encoding === 'cbor' ? decode(msg.payload_bytes) : msg.payload
}

// A valid v5 devalue payload containing a plain diagnostic object. Keeping the
// user-facing error small avoids persisting transport response bodies or stacks.
export function terminalError (failure: FailureDetail): Buffer {
  const value = [{ name: 1, message: 2, code: 3 }, 'QueueDeliveryError', failure.message, failure.code]
  return Buffer.from(`devl${JSON.stringify(value)}`)
}

export function eventError (error: Buffer): Buffer {
  return Buffer.from(JSON.stringify({ error: error.toString('base64') }))
}

export async function failRun (client: pg.PoolClient, msg: any, failure: FailureDetail): Promise<void> {
  const error = terminalError(failure)
  const failed = await client.query(
    `UPDATE workflow_runs
     SET status = 'failed', error = $3, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND application_id = $2 AND status IN ('pending', 'running')
     RETURNING id`,
    [msg.run_id, msg.application_id, error]
  )
  if (failed.rows.length === 0) return

  await client.query(
    `UPDATE workflow_hooks SET status = 'disposed', disposed_at = NOW()
     WHERE run_id = $1 AND application_id = $2 AND status != 'disposed'`,
    [msg.run_id, msg.application_id]
  )
  await client.query(
    `UPDATE workflow_waits SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE run_id = $1 AND application_id = $2 AND status = 'waiting'`,
    [msg.run_id, msg.application_id]
  )
  await client.query(
    `INSERT INTO workflow_events (run_id, application_id, event_type, event_data)
     SELECT $1::varchar, $2::integer, 'run_failed', $3
     WHERE NOT EXISTS (
       SELECT 1 FROM workflow_events
       WHERE run_id = $1 AND application_id = $2 AND event_type = 'run_failed'
     )`,
    [msg.run_id, msg.application_id, eventError(error)]
  )
}

export async function ensureRunForWorkflowDelivery (client: pg.PoolClient, msg: any): Promise<void> {
  if (!msg.run_id) return
  let payload
  try {
    payload = queuePayload(msg)
  } catch {}
  const runInput = payload?.runInput
  const workflowName = typeof runInput?.workflowName === 'string'
    ? runInput.workflowName
    : workflowNameFromQueue(msg.queue_name)
  const deploymentId = typeof runInput?.deploymentId === 'string'
    ? runInput.deploymentId
    : msg.deployment_version

  await client.query(
    `INSERT INTO workflow_runs
       (id, application_id, workflow_name, deployment_id, status, execution_context, spec_version)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [msg.run_id, msg.application_id, workflowName || 'unknown', deploymentId || 'unknown',
      runInput?.executionContext || null, runInput?.specVersion || null]
  )
}

export async function failBackgroundStep (client: pg.PoolClient, msg: any, failure: FailureDetail): Promise<boolean> {
  let payload
  try {
    payload = queuePayload(msg)
  } catch {
    return false
  }
  if (!payload || typeof payload.stepId !== 'string') return false

  const step = await client.query(
    `SELECT s.id, s.status, r.workflow_name
     FROM workflow_steps s
     JOIN workflow_runs r ON r.id = s.run_id AND r.application_id = s.application_id
     WHERE s.run_id = $1 AND s.application_id = $2 AND s.correlation_id = $3
     FOR UPDATE OF s`,
    [msg.run_id, msg.application_id, payload.stepId]
  )
  // A valid background-step payload must never directly fail the whole run.
  // A missing/terminal step means another path already resolved its state.
  if (step.rows.length === 0 || ['completed', 'failed', 'cancelled'].includes(step.rows[0].status)) return true

  const error = terminalError(failure)
  await client.query(
    `UPDATE workflow_steps
     SET status = 'failed', error = $3, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND application_id = $2`,
    [step.rows[0].id, msg.application_id, error]
  )
  await client.query(
    `INSERT INTO workflow_events
       (run_id, application_id, event_type, correlation_id, event_data)
     VALUES ($1, $2, 'step_failed', $3, $4)`,
    [msg.run_id, msg.application_id, payload.stepId, eventError(error)]
  )

  const continuation = { runId: msg.run_id }
  const payloadJson = msg.payload_encoding === 'json' ? JSON.stringify(continuation) : null
  const payloadBytes = msg.payload_encoding === 'cbor' ? Buffer.from(encode(continuation)) : null
  await client.query(
    `INSERT INTO workflow_queue_messages
       (queue_name, run_id, deployment_version, application_id,
        payload, payload_bytes, payload_encoding, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
    [workflowQueueNameLike(msg.queue_name, step.rows[0].workflow_name), msg.run_id, msg.deployment_version,
      msg.application_id, payloadJson, payloadBytes, msg.payload_encoding]
  )
  await client.query("SELECT pg_notify('deferred_messages', '{}')")
  return true
}

export async function finalizeFailure (client: pg.PoolClient, msg: any, failure: FailureDetail): Promise<void> {
  // v5 dispatches background steps through the workflow queue, while v4 uses
  // a dedicated step queue. The payload is the authoritative discriminator.
  if (await failBackgroundStep(client, msg, failure)) return
  if (isWorkflowQueue(msg.queue_name)) {
    await failRun(client, msg, failure)
  } else if (isStepQueue(msg.queue_name)) {
    await failRun(client, msg, failure)
  }
}

export async function lockRunForFailureFinalization (client: pg.PoolClient, msg: any): Promise<void> {
  if (!msg.run_id) return
  if (isWorkflowQueue(msg.queue_name)) await ensureRunForWorkflowDelivery(client, msg)
  await client.query(
    'SELECT id FROM workflow_runs WHERE id = $1 AND application_id = $2 FOR UPDATE',
    [msg.run_id, msg.application_id]
  )
}

// A message stuck in 'delivered' means its executor never reported back, most
// likely because it died mid-step. Nothing else reclaims it: the retry paths
// only touch 'pending', 'deferred' and 'failed'. Redelivering resumes the run
// rather than failing it.
//
// Deliberately scoped to messages, not runs. A run with no message outstanding
// is idle, not stuck -- it may be parked on a hook for days -- and inactivity
// is not a fault in a durable workflow.
