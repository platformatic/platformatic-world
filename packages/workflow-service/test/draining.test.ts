import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest, MASTER_KEY } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('draining', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should return version status with counts', async () => {
    // Create some runs
    for (let i = 0; i < 3; i++) {
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
        headers: { authorization: `Bearer ${ctx.apiKey}` },
        payload: {
          eventType: 'run_created',
          specVersion: 2,
          eventData: { deploymentId: 'v2.0.0', workflowName: 'drain-test', input: {} },
        },
      })
      const runId = JSON.parse(createRes.body).run.runId
      // Start the run
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
        headers: { authorization: `Bearer ${ctx.apiKey}` },
        payload: { eventType: 'run_started', specVersion: 2 },
      })
    }

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/versions/v2.0.0/status`,
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.activeRuns, 3)
    assert.equal(typeof body.pendingHooks, 'number')
    assert.equal(typeof body.pendingWaits, 'number')
    assert.equal(typeof body.queuedMessages, 'number')
  })

  it('should force-expire a version', async () => {
    // Create and start a run
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v3.0.0', workflowName: 'expire-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: { eventType: 'run_started', specVersion: 2 },
    })

    // Force expire
    const expireRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/versions/v3.0.0/expire`,
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    })

    assert.equal(expireRes.statusCode, 200)
    const body = JSON.parse(expireRes.body)
    assert.equal(body.cancelledRuns, 1)

    // Verify run is cancelled
    const runRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(JSON.parse(runRes.body).status, 'cancelled')
  })

  it('should reject draining endpoints without master key', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/versions/v1/status`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(response.statusCode, 403)
  })
})
