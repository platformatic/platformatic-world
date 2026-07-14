import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('events', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should create a run via run_created event', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: {
          deploymentId: 'v1.0.0',
          workflowName: 'test-workflow',
          input: { foo: 'bar' },
        },
      },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.ok(body.event)
    assert.ok(body.run)
    assert.equal(body.event.eventType, 'run_created')
    assert.equal(body.run.status, 'pending')
    assert.equal(body.run.workflowName, 'test-workflow')
    assert.equal(body.run.deploymentId, 'v1.0.0')
    assert.ok(body.run.runId)
  })

  it('should be idempotent on duplicate run_created for the same runId', async () => {
    // The SDK retries the trigger endpoint on transient errors. A second
    // POST for the same runId must return 200 (with the existing run state),
    // not 500 from the workflow_runs unique constraint, and must not append
    // a duplicate run_created event to the log.
    const runId = `wrun_idempotent_${randomBytes(8).toString('hex')}`
    const payload = {
      eventType: 'run_created',
      specVersion: 2,
      eventData: {
        deploymentId: 'v1.0.0',
        workflowName: 'idempotent-test',
        input: { n: 1 },
      },
    }

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload,
    })
    assert.equal(first.statusCode, 200)
    const firstBody = JSON.parse(first.body)
    assert.equal(firstBody.run.runId, runId)

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload,
    })
    assert.equal(second.statusCode, 200)
    const secondBody = JSON.parse(second.body)
    assert.equal(secondBody.run.runId, runId)

    // Exactly one run_created event in the log, no duplicates.
    const eventsRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(eventsRes.statusCode, 200)
    const events = JSON.parse(eventsRes.body)
    const runCreatedEvents = events.data.filter((e: any) => e.eventType === 'run_created')
    assert.equal(runCreatedEvents.length, 1, 'expected exactly one run_created event')
  })

  it('should handle full run lifecycle', async () => {
    // Create run
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: {
          deploymentId: 'v1.0.0',
          workflowName: 'lifecycle-test',
          input: { data: 'test' },
        },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId

    // Start run
    const startRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: { eventType: 'run_started', specVersion: 2 },
    })
    assert.equal(JSON.parse(startRes.body).run.status, 'running')

    // Create step
    const stepRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_created',
        correlationId: 'step-1',
        specVersion: 2,
        eventData: {
          stepName: 'fetchData',
          input: { url: 'https://example.com' },
        },
      },
    })
    assert.ok(JSON.parse(stepRes.body).step)
    assert.equal(JSON.parse(stepRes.body).step.status, 'pending')

    // Start step
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_started',
        correlationId: 'step-1',
        specVersion: 2,
        eventData: { attempt: 1 },
      },
    })

    // Complete step
    const completeStepRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_completed',
        correlationId: 'step-1',
        specVersion: 2,
        eventData: { result: { data: 'fetched' } },
      },
    })
    assert.equal(JSON.parse(completeStepRes.body).step.status, 'completed')

    // Complete run
    const completeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_completed',
        specVersion: 2,
        eventData: { output: { result: 'success' } },
      },
    })
    assert.equal(JSON.parse(completeRes.body).run.status, 'completed')

    // List events
    const eventsRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    const events = JSON.parse(eventsRes.body)
    assert.equal(events.data.length, 6) // run_created, run_started, step_created, step_started, step_completed, run_completed
  })

  it('should handle hook_created with token conflict', async () => {
    // workflow_hooks has a partial unique index on token WHERE status='pending'
    // that is global across apps — a hard-coded token would collide with
    // leftovers from a crashed prior run (teardown only runs on success).
    const token = `conflict-token-${randomBytes(8).toString('hex')}`

    // Create a run first
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'hook-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId

    // Create hook
    const hookRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        specVersion: 2,
        eventData: { token },
      },
    })
    assert.ok(JSON.parse(hookRes.body).hook)

    // Create another hook with same token → should get hook_conflict
    const conflictRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'hook_created',
        correlationId: 'hook-2',
        specVersion: 2,
        eventData: { token },
      },
    })
    const conflict = JSON.parse(conflictRes.body)
    assert.equal(conflict.event.eventType, 'hook_conflict')
  })

  it('should handle wait lifecycle', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'wait-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId

    // Create wait
    const waitRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'wait_created',
        correlationId: 'wait-1',
        specVersion: 2,
        eventData: { resumeAt: new Date(Date.now() + 60_000).toISOString() },
      },
    })
    const wait = JSON.parse(waitRes.body)
    assert.ok(wait.wait)
    assert.equal(wait.wait.status, 'waiting')

    // Complete wait
    const completeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'wait_completed',
        correlationId: 'wait-1',
        specVersion: 2,
      },
    })
    const completed = JSON.parse(completeRes.body)
    assert.equal(completed.wait.status, 'completed')
  })

  it('paginates run events in both directions without dropping the cursor', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'pagination-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId
    const run = await ctx.app.pg.query('SELECT application_id FROM workflow_runs WHERE id = $1', [runId])
    await ctx.app.pg.query(
      `INSERT INTO workflow_events (run_id, application_id, event_type)
       SELECT $1, $2, 'pagination_event' FROM generate_series(1, 4)
       RETURNING id`,
      [runId, run.rows[0].application_id]
    )
    const allEvents = await ctx.app.pg.query('SELECT id FROM workflow_events WHERE run_id = $1 ORDER BY id ASC', [runId])
    const ids = allEvents.rows.map(row => String(row.id))
    const baseUrl = `/api/v1/apps/${ctx.appId}/runs/${runId}/events`
    const headers = { authorization: `Bearer ${ctx.apiKey}` }

    const first = JSON.parse((await ctx.app.inject({ method: 'GET', url: `${baseUrl}?limit=3`, headers })).body)
    assert.deepEqual(first.data.map((event: any) => event.eventId), ids.slice(0, 3))
    assert.equal(first.cursor, ids[2])
    assert.equal(first.hasMore, true)

    const final = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}?limit=3&cursor=${first.cursor}`,
      headers,
    })).body)
    assert.deepEqual(final.data.map((event: any) => event.eventId), ids.slice(3))
    assert.equal(final.cursor, ids.at(-1))
    assert.equal(final.hasMore, false)

    const empty = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}?cursor=${final.cursor}`,
      headers,
    })).body)
    assert.deepEqual(empty.data, [])
    assert.equal(empty.cursor, final.cursor)

    const later = await ctx.app.pg.query(
      `INSERT INTO workflow_events (run_id, application_id, event_type)
       VALUES ($1, $2, 'later_event') RETURNING id`,
      [runId, run.rows[0].application_id]
    )
    const incremental = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}?cursor=${final.cursor}`,
      headers,
    })).body)
    assert.deepEqual(incremental.data.map((event: any) => event.eventId), [String(later.rows[0].id)])
    assert.equal(incremental.cursor, String(later.rows[0].id))

    const desc = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}?limit=2&sortOrder=desc`,
      headers,
    })).body)
    assert.deepEqual(desc.data.map((event: any) => event.eventId), [String(later.rows[0].id), ids.at(-1)])
    assert.equal(desc.cursor, ids.at(-1))

    const descNext = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}?limit=2&sortOrder=desc&cursor=${desc.cursor}`,
      headers,
    })).body)
    assert.deepEqual(descNext.data.map((event: any) => event.eventId), ids.slice(-3, -1).reverse())
  })

  it('paginates correlation events in both directions and preserves empty-page cursors', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'correlation-pagination-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId
    const run = await ctx.app.pg.query('SELECT application_id FROM workflow_runs WHERE id = $1', [runId])
    const correlationId = `pagination-${randomBytes(8).toString('hex')}`
    const inserted = await ctx.app.pg.query(
      `INSERT INTO workflow_events (run_id, application_id, event_type, correlation_id)
       SELECT $1, $2, 'correlation_event', $3 FROM generate_series(1, 4)
       RETURNING id`,
      [runId, run.rows[0].application_id, correlationId]
    )
    const ids = inserted.rows.map(row => String(row.id))
    const baseUrl = `/api/v1/apps/${ctx.appId}/events/by-correlation?correlationId=${correlationId}`
    const headers = { authorization: `Bearer ${ctx.apiKey}` }

    const first = JSON.parse((await ctx.app.inject({ method: 'GET', url: `${baseUrl}&limit=2`, headers })).body)
    assert.deepEqual(first.data.map((event: any) => event.eventId), ids.slice(0, 2))
    assert.equal(first.cursor, ids[1])
    assert.equal(first.hasMore, true)

    const final = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}&limit=2&cursor=${first.cursor}`,
      headers,
    })).body)
    assert.deepEqual(final.data.map((event: any) => event.eventId), ids.slice(2))
    assert.equal(final.cursor, ids.at(-1))
    assert.equal(final.hasMore, false)

    const empty = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}&cursor=${final.cursor}`,
      headers,
    })).body)
    assert.deepEqual(empty.data, [])
    assert.equal(empty.cursor, final.cursor)

    const desc = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}&limit=2&sortOrder=desc`,
      headers,
    })).body)
    assert.deepEqual(desc.data.map((event: any) => event.eventId), ids.slice(-2).reverse())
    assert.equal(desc.cursor, ids.at(-2))

    const descFinal = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}&limit=2&sortOrder=desc&cursor=${desc.cursor}`,
      headers,
    })).body)
    assert.deepEqual(descFinal.data.map((event: any) => event.eventId), ids.slice(0, 2).reverse())
    assert.equal(descFinal.cursor, ids[0])
    assert.equal(descFinal.hasMore, false)
  })
})
