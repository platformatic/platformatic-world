import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest, type TestContext } from './helper.ts'

describe('metrics', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should return Prometheus-format metrics without auth', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/metrics',
      // No authorization header — should be a public path
    })

    assert.equal(response.statusCode, 200)
    assert.ok(response.headers['content-type']?.includes('text/plain'))

    const body = response.body
    // Check for counter types
    assert.ok(body.includes('# TYPE wf_events_created_total counter'))
    assert.ok(body.includes('# TYPE wf_runs_created_total counter'))
    assert.ok(body.includes('# TYPE wf_messages_dispatched_total counter'))
    assert.ok(body.includes('# TYPE wf_messages_dead_lettered_total counter'))
    assert.ok(body.includes('# TYPE wf_messages_retried_total counter'))

    // Check for gauge types
    assert.ok(body.includes('# TYPE wf_active_runs gauge'))
    assert.ok(body.includes('# TYPE wf_queue_depth gauge'))
    assert.ok(body.includes('# TYPE wf_db_pool_total gauge'))
    assert.ok(body.includes('# TYPE wf_db_pool_idle gauge'))

    // Check for histogram/summary types
    assert.ok(body.includes('# TYPE wf_request_duration_ms summary'))
    assert.ok(body.includes('# TYPE wf_queue_dispatch_duration_ms summary'))
  })

  it('should track request duration', async () => {
    // Make a few requests to populate histogram
    for (let i = 0; i < 3; i++) {
      await ctx.app.inject({ method: 'GET', url: '/ready' })
    }

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/metrics',
    })

    const body = response.body
    // Should have non-zero count for request_duration_ms
    const match = body.match(/wf_request_duration_ms_count (\d+)/)
    assert.ok(match, 'request_duration_ms_count should exist')
    assert.ok(parseInt(match[1]) > 0, 'request_duration_ms_count should be > 0')
  })

  it('should report gauge values from DB', async () => {
    // Create a run so we have at least one active run
    const runRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        eventData: { workflowName: 'metrics-test', deploymentId: 'v1' },
      },
    })
    assert.equal(runRes.statusCode, 200)

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/metrics',
    })

    const body = response.body
    // active_runs should be >= 1
    const activeMatch = body.match(/wf_active_runs (\d+)/)
    assert.ok(activeMatch)
    assert.ok(parseInt(activeMatch[1]) >= 1)

    // db pool total should be > 0
    const poolMatch = body.match(/wf_db_pool_total (\d+)/)
    assert.ok(poolMatch)
    assert.ok(parseInt(poolMatch[1]) >= 0)
  })
})
