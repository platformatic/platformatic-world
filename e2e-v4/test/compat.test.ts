// v4-SDK compat: prove the code paths not covered by addTenWorkflow work —
// hooks, sleeps, streams (exercising the v4 flat `writeToStream` aliases),
// step retry, and fatal-error bubbling.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { setup, waitForRunStatus, waitForHookByToken, configureWorldFromEnvAndLoadSdk, resumeHook, DB_URL, DEPLOYMENT_VERSION, type E2eContext } from './helper.ts'

let ctx: E2eContext

before(async () => {
  ctx = await setup()
  await configureWorldFromEnvAndLoadSdk(ctx.wfUrl, DEPLOYMENT_VERSION)
}, { timeout: 60_000 })

after(() => ctx?.kill())

async function trigger (workflow: string, args: any[] = [], waitForResult = false): Promise<{ runId: string, result?: any }> {
  const res = await fetch(`${ctx.nextUrl}/api/trigger-e2e`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow, args, waitForResult }),
  })
  assert.equal(res.status, 200, `trigger ${workflow} failed: ${res.status}`)
  return res.json() as Promise<{ runId: string, result?: any }>
}

test('v4: sleepingWorkflow — short sleep promoted via deferred queue', { timeout: 30_000 }, async () => {
  const { runId, result } = await trigger('sleepingWorkflow', [500], true)
  assert.ok(runId)
  assert.ok(result.elapsedMs >= 500, `elapsed ${result.elapsedMs}ms should be ≥ 500ms`)
  assert.ok(result.elapsedMs < 10_000, `elapsed ${result.elapsedMs}ms unreasonably long`)
})

test('v4: errorRetrySuccessWorkflow — step retries until success', { timeout: 60_000 }, async () => {
  const { result } = await trigger('errorRetrySuccessWorkflow', [], true)
  assert.equal(result.finalAttempt, 3, 'expected 3 attempts before success')
})

test('v4: errorFatalWorkflow — FatalError bubbles and is catchable', { timeout: 30_000 }, async () => {
  const { result } = await trigger('errorFatalWorkflow', [], true)
  assert.equal(result.caught, true)
  assert.match(result.message, /Fatal step error/)
})

test('v4: hookWorkflow — createHook + resume via hook_received', { timeout: 30_000 }, async () => {
  const token = `v4-hook-${Math.random().toString(36).slice(2)}`

  const { runId } = await trigger('hookWorkflow', [token])
  const hook = await waitForHookByToken(ctx.wfUrl, token)
  assert.equal(hook.token, token)

  await resumeHook(token, { done: true, from: 'v4-test' })

  const run = await waitForRunStatus(ctx.wfUrl, runId, 'completed')
  assert.equal(run.status, 'completed')
})

test('v4: outputStreamWorkflow — getWritable() routes through flat streamer methods', { timeout: 30_000 }, async () => {
  const { runId, result } = await trigger('outputStreamWorkflow', [], true)
  assert.equal(result, 'done')

  // Verify the stream was actually written through to the DB. The v4 SDK
  // calls `world.writeToStream(name, runId, chunk)` internally; if our
  // flat-method aliases were broken we'd see zero chunks.
  const client = new pg.Client(DB_URL)
  await client.connect()
  try {
    const { rows } = await client.query(
      'SELECT chunk_index FROM workflow_stream_chunks WHERE run_id = $1 AND is_closed = FALSE ORDER BY chunk_index ASC',
      [runId]
    )
    assert.ok(rows.length >= 1, `expected ≥ 1 chunk, got ${rows.length}`)
  } finally {
    await client.end()
  }
})
