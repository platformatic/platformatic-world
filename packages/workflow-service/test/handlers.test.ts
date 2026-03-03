import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('handlers', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should register a handler', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/handlers`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        podId: 'pod-1',
        deploymentVersion: 'v1.0.0',
        endpoints: {
          workflow: 'http://pod-1:3000/workflow',
          step: 'http://pod-1:3000/step',
          webhook: 'http://pod-1:3000/webhook',
        },
      },
    })

    assert.equal(res.statusCode, 201)
    assert.deepEqual(JSON.parse(res.body), { registered: true })
  })

  it('should upsert handler on duplicate podId', async () => {
    // Register again with updated URLs
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/handlers`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        podId: 'pod-1',
        deploymentVersion: 'v2.0.0',
        endpoints: {
          workflow: 'http://pod-1:3000/workflow-v2',
          step: 'http://pod-1:3000/step-v2',
          webhook: 'http://pod-1:3000/webhook-v2',
        },
      },
    })

    assert.equal(res.statusCode, 201)

    // Verify the handler was updated (check DB directly)
    const result = await ctx.app.pg.query(
      `SELECT deployment_version, workflow_url FROM workflow_queue_handlers
       WHERE application_id = (SELECT id FROM workflow_applications WHERE app_id = $1) AND pod_id = 'pod-1'`,
      [ctx.appId]
    )
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0].deployment_version, 'v2.0.0')
    assert.equal(result.rows[0].workflow_url, 'http://pod-1:3000/workflow-v2')
  })

  it('should reject handler without required fields', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/handlers`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: { podId: 'pod-2' },
    })

    assert.equal(res.statusCode, 400)
  })

  it('should deregister a handler', async () => {
    // Register first
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/handlers`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        podId: 'pod-to-delete',
        deploymentVersion: 'v1.0.0',
        endpoints: {
          workflow: 'http://pod:3000/workflow',
          step: 'http://pod:3000/step',
          webhook: 'http://pod:3000/webhook',
        },
      },
    })

    // Deregister
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/apps/${ctx.appId}/handlers/pod-to-delete`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { deregistered: true })

    // Verify it's gone
    const result = await ctx.app.pg.query(
      `SELECT id FROM workflow_queue_handlers
       WHERE application_id = (SELECT id FROM workflow_applications WHERE app_id = $1) AND pod_id = 'pod-to-delete'`,
      [ctx.appId]
    )
    assert.equal(result.rows.length, 0)
  })
})
