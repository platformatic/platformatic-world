import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest, type TestContext } from './helper.ts'

describe('run quota', () => {
  let ctx: TestContext
  let applicationId: number

  before(async () => {
    ctx = await setupTest()
    const appResult = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [ctx.appId]
    )
    applicationId = appResult.rows[0].id

    // Set a very low quota before any API calls (so cache gets the right value)
    await ctx.app.pg.query(
      `INSERT INTO workflow_app_quotas (application_id, max_runs, max_events_per_run, max_queue_per_minute)
       VALUES ($1, 1, 10000, 1000)`,
      [applicationId]
    )
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should enforce run quota', async () => {
    // Create the first run (should succeed)
    const res1 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        eventData: { workflowName: 'quota-test', deploymentId: 'v1' },
      },
    })
    assert.equal(res1.statusCode, 200)

    // Create a second run (should be rejected — 1 active run already exists)
    const res2 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        eventData: { workflowName: 'quota-test-2', deploymentId: 'v1' },
      },
    })
    assert.equal(res2.statusCode, 429)
  })
})

describe('event quota', () => {
  let ctx: TestContext
  let applicationId: number

  before(async () => {
    ctx = await setupTest()
    const appResult = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [ctx.appId]
    )
    applicationId = appResult.rows[0].id

    // Set low event quota before any API calls
    await ctx.app.pg.query(
      `INSERT INTO workflow_app_quotas (application_id, max_runs, max_events_per_run, max_queue_per_minute)
       VALUES ($1, 10000, 2, 1000)`,
      [applicationId]
    )
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should enforce event quota per run', async () => {
    // Create a run (event #1 for this run)
    const runRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        eventData: { workflowName: 'event-quota-test', deploymentId: 'v1' },
      },
    })
    assert.equal(runRes.statusCode, 200)
    const runId = JSON.parse(runRes.body).run.runId

    // Second event (run_started) — event #2 for this run
    const res2 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: { eventType: 'run_started' },
    })
    assert.equal(res2.statusCode, 200)

    // Third event should fail (quota is 2)
    const res3 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_created',
        correlationId: 'corr-1',
        eventData: { stepName: 'step-1' },
      },
    })
    assert.equal(res3.statusCode, 429)
  })
})

describe('queue rate limit', () => {
  let ctx: TestContext
  let applicationId: number

  before(async () => {
    ctx = await setupTest()
    const appResult = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [ctx.appId]
    )
    applicationId = appResult.rows[0].id

    // Set very low queue rate limit before any API calls
    await ctx.app.pg.query(
      `INSERT INTO workflow_app_quotas (application_id, max_runs, max_events_per_run, max_queue_per_minute)
       VALUES ($1, 10000, 10000, 1)`,
      [applicationId]
    )
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should enforce queue rate limit', async () => {
    // First queue message should succeed
    const res1 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: 'rate-test',
        message: { data: 1 },
      },
    })
    assert.equal(res1.statusCode, 201)

    // Second should be rate-limited
    const res2 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: 'rate-test',
        message: { data: 2 },
      },
    })
    assert.equal(res2.statusCode, 429)
  })
})
