import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { setupTest, teardownTest, type TestContext } from './helper.ts'
import { reapExpiredRemoteHandlerRuns } from '../plugins/remote-handler-runs.ts'

const BASE_CONNECTION_STRING = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL
const TEST_SCHEMA_NAME = `handler_reconciliation_${randomBytes(8).toString('hex')}`
const TEST_CONNECTION_URL = new URL(BASE_CONNECTION_STRING)
TEST_CONNECTION_URL.searchParams.set('options', `-c search_path=${TEST_SCHEMA_NAME}`)

before(async () => {
  const pool = new pg.Pool({ connectionString: BASE_CONNECTION_STRING })
  try {
    await pool.query(`CREATE SCHEMA ${TEST_SCHEMA_NAME}`)
    await pool.query(
      `CREATE TABLE ${TEST_SCHEMA_NAME}.schemaversion (
         version BIGINT PRIMARY KEY,
         name TEXT,
         md5 TEXT,
         run_at TIMESTAMPTZ
       )`
    )
    await pool.query(`INSERT INTO ${TEST_SCHEMA_NAME}.schemaversion (version) VALUES (0)`)
  } finally {
    await pool.end()
  }
  process.env.DATABASE_URL = TEST_CONNECTION_URL.toString()
})

after(async () => {
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL
  const pool = new pg.Pool({ connectionString: BASE_CONNECTION_STRING })
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA_NAME} CASCADE`)
  } finally {
    await pool.end()
  }
})

function unique (prefix: string): string {
  return `${prefix}-${randomBytes(5).toString('hex')}`
}

async function applicationId (ctx: TestContext): Promise<number> {
  return (await ctx.app.pg.query(
    'SELECT id FROM workflow_applications WHERE app_id = $1',
    [ctx.appId]
  )).rows[0].id
}

async function reserveAndCreate (
  ctx: TestContext,
  operationKey: string,
  status: 'pending' | 'running' = 'running'
): Promise<string> {
  const reservation = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/remote-handler-runs/reserve`,
    payload: { operationKey, budget: { remaining: 60_000 } },
  })
  assert.equal(reservation.statusCode, 201, reservation.body)
  const handlerRunId = reservation.json().handlerRunId
  const created = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/runs/${handlerRunId}/events`,
    payload: {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'v1',
        workflowName: 'workflow//handler//test',
        input: {},
      },
    },
  })
  assert.equal(created.statusCode, 200, created.body)
  if (status === 'running') {
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${handlerRunId}/events`,
      payload: { eventType: 'run_started', specVersion: 7 },
    })
    assert.equal(started.statusCode, 200, started.body)
  }
  return handlerRunId
}

function listActive (ctx: TestContext, query = '') {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/apps/${ctx.appId}/remote-handler-runs/active${query}`,
  })
}

function cancel (ctx: TestContext, operationKey: string, handlerRunId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/remote-handler-runs/cancel`,
    payload: { operationKey, handlerRunId },
  })
}

function complete (ctx: TestContext, handlerRunId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/runs/${handlerRunId}/events`,
    payload: {
      eventType: 'run_completed',
      specVersion: 7,
      eventData: { output: { completed: true } },
    },
  })
}

describe('remote handler run reconciliation', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest(unique('handler-reconciliation'))
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('lists only locally owned active reserved runs with bounded keyset pagination', async () => {
    const prefix = unique('list')
    const firstKey = `${prefix}-a`
    const secondKey = `${prefix}-b`
    const terminalKey = `${prefix}-c`
    const firstRunId = await reserveAndCreate(ctx, firstKey, 'pending')
    const secondRunId = await reserveAndCreate(ctx, secondKey)
    const terminalRunId = await reserveAndCreate(ctx, terminalKey)
    assert.equal((await complete(ctx, terminalRunId)).statusCode, 200)

    const firstPage = await listActive(ctx, `?cursor=${encodeURIComponent(`${prefix}-0`)}&limit=1`)
    assert.equal(firstPage.statusCode, 200, firstPage.body)
    assert.deepEqual(firstPage.json(), {
      data: [{
        operationKey: firstKey,
        handlerRunId: firstRunId,
        deadlineAt: firstPage.json().data[0].deadlineAt,
      }],
      cursor: firstKey,
      hasMore: true,
    })
    assert.ok(Number.isSafeInteger(firstPage.json().data[0].deadlineAt))
    assert.deepEqual(Object.keys(firstPage.json().data[0]).sort(), [
      'deadlineAt',
      'handlerRunId',
      'operationKey',
    ])

    const secondPage = await listActive(ctx, `?cursor=${encodeURIComponent(firstKey)}&limit=1`)
    assert.deepEqual(secondPage.json().data.map((run: any) => run.handlerRunId), [secondRunId])
    assert.equal(secondPage.json().hasMore, false)
    assert.equal(secondPage.json().cursor, null)
    assert.equal(
      (await listActive(ctx)).json().data.some((run: any) => run.operationKey === terminalKey),
      false
    )

    const other = await setupTest(unique('other-handler-reconciliation'))
    try {
      assert.deepEqual((await listActive(other)).json(), { data: [], cursor: null, hasMore: false })
      const crossTenant = await cancel(other, firstKey, firstRunId)
      assert.equal(crossTenant.statusCode, 200, crossTenant.body)
      assert.deepEqual(crossTenant.json(), { cancelled: false })
    } finally {
      await teardownTest(other)
    }
  })

  it('rejects malformed and unbounded inventory requests', async () => {
    for (const query of [
      '?limit=0',
      '?limit=17',
      '?limit=1.5',
      '?cursor=',
      `?cursor=${encodeURIComponent('é'.repeat(513))}`,
      '?unexpected=true',
    ]) {
      const response = await listActive(ctx, query)
      assert.equal(response.statusCode, 400, `${query}: ${response.body}`)
    }
    const invalidCancel = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/remote-handler-runs/cancel`,
      payload: { operationKey: 'key', handlerRunId: 'not-a-run' },
    })
    assert.equal(invalidCancel.statusCode, 422, invalidCancel.body)
  })

  it('cancels through the exact reservation once and cleans active resources', async () => {
    const operationKey = unique('cancel')
    const handlerRunId = await reserveAndCreate(ctx, operationKey)
    const appId = await applicationId(ctx)
    await ctx.app.pg.query(
      `INSERT INTO workflow_hooks
         (id, run_id, application_id, correlation_id, token, status)
       VALUES ($1, $2, $3, 'handler-hook', $4, 'pending')`,
      [unique('hook'), handlerRunId, appId, unique('token')]
    )
    await ctx.app.pg.query(
      `INSERT INTO workflow_waits
         (id, run_id, application_id, correlation_id, status)
       VALUES ($1, $2, $3, 'handler-wait', 'waiting')`,
      [unique('wait'), handlerRunId, appId]
    )
    await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
         (queue_name, run_id, deployment_version, application_id, payload, status)
       VALUES ('__wkf_workflow_handler', $1, 'v1', $2, '{}', 'pending')`,
      [handlerRunId, appId]
    )

    const responses = await Promise.all([
      cancel(ctx, operationKey, handlerRunId),
      cancel(ctx, operationKey, handlerRunId),
    ])
    assert.equal(responses.every(response => response.statusCode === 200), true)
    assert.deepEqual(responses.map(response => response.json().cancelled).sort(), [false, true])
    assert.equal((await cancel(ctx, operationKey, handlerRunId)).json().cancelled, false)

    const state = (await ctx.app.pg.query(
      `SELECT r.status,
              (SELECT status FROM workflow_hooks WHERE run_id = r.id LIMIT 1) AS hook_status,
              (SELECT status FROM workflow_waits WHERE run_id = r.id LIMIT 1) AS wait_status,
              (SELECT status FROM workflow_queue_messages WHERE run_id = r.id LIMIT 1) AS message_status,
              (SELECT COUNT(*)::integer FROM workflow_events
               WHERE run_id = r.id AND event_type = 'run_cancelled') AS cancel_events
       FROM workflow_runs r WHERE r.application_id = $1 AND r.id = $2`,
      [appId, handlerRunId]
    )).rows[0]
    assert.deepEqual(state, {
      status: 'cancelled',
      hook_status: 'disposed',
      wait_status: 'completed',
      message_status: 'dead',
      cancel_events: 1,
    })

    const delayedStart = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${handlerRunId}/events`,
      payload: { eventType: 'run_started', specVersion: 7 },
    })
    assert.equal(delayedStart.statusCode, 200, delayedStart.body)
    assert.equal(delayedStart.json().run.status, 'cancelled')
    assert.equal((await ctx.app.pg.query(
      `SELECT COUNT(*)::integer AS count FROM workflow_events
       WHERE application_id = $1 AND run_id = $2 AND event_type = 'run_started'`,
      [appId, handlerRunId]
    )).rows[0].count, 1)

    const otherOperation = unique('mapping-mismatch')
    const otherRunId = await reserveAndCreate(ctx, otherOperation)
    assert.equal((await cancel(ctx, otherOperation, handlerRunId)).json().cancelled, false)
    assert.equal((await ctx.app.pg.query(
      'SELECT status FROM workflow_runs WHERE application_id = $1 AND id = $2',
      [appId, otherRunId]
    )).rows[0].status, 'running')
  })

  it('makes the first terminal transition win a completion-cancellation race', async () => {
    const appId = await applicationId(ctx)
    for (let index = 0; index < 8; index++) {
      const operationKey = unique(`terminal-race-${index}`)
      const handlerRunId = await reserveAndCreate(ctx, operationKey)
      const [cancelled, completed] = await Promise.all([
        cancel(ctx, operationKey, handlerRunId),
        complete(ctx, handlerRunId),
      ])
      assert.equal(cancelled.statusCode, 200, cancelled.body)
      assert.equal(completed.statusCode, 200, completed.body)

      const row = (await ctx.app.pg.query(
        `SELECT status,
                (SELECT COUNT(*)::integer FROM workflow_events
                 WHERE run_id = $2 AND event_type IN ('run_cancelled', 'run_completed')) AS terminal_events
         FROM workflow_runs WHERE application_id = $1 AND id = $2`,
        [appId, handlerRunId]
      )).rows[0]
      assert.ok(row.status === 'cancelled' || row.status === 'completed')
      assert.equal(row.terminal_events, 1)
      assert.equal(cancelled.json().cancelled, row.status === 'cancelled')
    }
  })

  it('reaps only a bounded deadline page and retains every mapping before its deadline', async () => {
    const operationKeys = Array.from({ length: 3 }, (_, index) => unique(`expired-${index}`)).sort()
    const runIds = []
    for (const operationKey of operationKeys) runIds.push(await reserveAndCreate(ctx, operationKey))
    const appId = await applicationId(ctx)
    await ctx.app.pg.query(
      `UPDATE workflow_remote_handler_runs
       SET deadline_at = NOW() + INTERVAL '5 seconds'
       WHERE application_id = $1 AND operation_key = ANY($2)`,
      [appId, operationKeys]
    )
    const cutoff = new Date(Date.now() + 10_000)

    const first = await reapExpiredRemoteHandlerRuns(ctx.app.pg, { batchSize: 2, cutoff })
    assert.deepEqual(first, { examined: 2, cancelled: 2 })
    assert.equal((await ctx.app.pg.query(
      'SELECT COUNT(*)::integer AS count FROM workflow_remote_handler_runs WHERE application_id = $1 AND operation_key = ANY($2)',
      [appId, operationKeys]
    )).rows[0].count, 1)

    const second = await reapExpiredRemoteHandlerRuns(ctx.app.pg, { batchSize: 2, cutoff })
    assert.deepEqual(second, { examined: 1, cancelled: 1 })
    assert.equal((await ctx.app.pg.query(
      'SELECT COUNT(*)::integer AS count FROM workflow_remote_handler_runs WHERE application_id = $1 AND operation_key = ANY($2)',
      [appId, operationKeys]
    )).rows[0].count, 0)
    const statuses = await ctx.app.pg.query(
      'SELECT status FROM workflow_runs WHERE application_id = $1 AND id = ANY($2)',
      [appId, runIds]
    )
    assert.deepEqual(statuses.rows.map(row => row.status), ['cancelled', 'cancelled', 'cancelled'])

    const retainedKey = unique('retained-before-deadline')
    const retainedRunId = await reserveAndCreate(ctx, retainedKey)
    assert.deepEqual(
      await reapExpiredRemoteHandlerRuns(ctx.app.pg, { batchSize: 16, cutoff: new Date() }),
      { examined: 0, cancelled: 0 }
    )
    assert.equal((await ctx.app.pg.query(
      `SELECT COUNT(*)::integer AS count FROM workflow_remote_handler_runs
       WHERE application_id = $1 AND operation_key = $2 AND handler_run_id = $3`,
      [appId, retainedKey, retainedRunId]
    )).rows[0].count, 1)

    const terminalKey = unique('terminal-expired')
    const terminalRunId = await reserveAndCreate(ctx, terminalKey)
    assert.equal((await complete(ctx, terminalRunId)).statusCode, 200)
    await ctx.app.pg.query(
      `UPDATE workflow_remote_handler_runs
       SET deadline_at = NOW() + INTERVAL '5 seconds'
       WHERE application_id = $1 AND operation_key = $2`,
      [appId, terminalKey]
    )
    assert.deepEqual(
      await reapExpiredRemoteHandlerRuns(ctx.app.pg, { batchSize: 16, cutoff }),
      { examined: 1, cancelled: 0 }
    )
    assert.equal((await ctx.app.pg.query(
      `SELECT COUNT(*)::integer AS count FROM workflow_remote_handler_runs
       WHERE application_id = $1 AND operation_key = $2`,
      [appId, terminalKey]
    )).rows[0].count, 0)
    assert.equal((await ctx.app.pg.query(
      `SELECT COUNT(*)::integer AS count FROM workflow_events
       WHERE application_id = $1 AND run_id = $2 AND event_type = 'run_cancelled'`,
      [appId, terminalRunId]
    )).rows[0].count, 0)
  })
})
