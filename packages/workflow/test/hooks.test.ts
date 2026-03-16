import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('hooks', () => {
  let ctx: TestContext
  let runId: string
  let hookToken: string

  before(async () => {
    ctx = await setupTest()

    // Create a run
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1', workflowName: 'hooks-test', input: {} },
      },
    })
    runId = JSON.parse(createRes.body).run.runId

    hookToken = `hook-token-${Date.now()}`

    // Create hook
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        specVersion: 2,
        eventData: {
          token: hookToken,
          ownerId: 'user-1',
          projectId: 'proj-1',
          environment: 'production',
        },
      },
    })
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should get a hook by ID', async () => {
    // Get hook ID from list
    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/hooks?runId=${runId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    const hookId = JSON.parse(listRes.body).data[0].hookId

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/hooks/${hookId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(res.statusCode, 200)
    const hook = JSON.parse(res.body)
    assert.equal(hook.hookId, hookId)
    assert.equal(hook.token, hookToken)
    assert.equal(hook.status, 'pending')
    assert.equal(hook.ownerId, 'user-1')
    assert.equal(hook.projectId, 'proj-1')
    assert.equal(hook.environment, 'production')
  })

  it('should get a hook by token', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/hooks/by-token/${hookToken}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(res.statusCode, 200)
    const hook = JSON.parse(res.body)
    assert.equal(hook.token, hookToken)
    assert.equal(hook.runId, runId)
  })

  it('should return 404 for nonexistent hook', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/hooks/nonexistent`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(res.statusCode, 404)
  })

  it('should list hooks filtered by runId', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/hooks?runId=${runId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.ok(body.data.length >= 1)
    assert.equal(body.data[0].runId, runId)
  })

  it('should update hook status on hook_received', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'hook_received',
        correlationId: 'hook-1',
        specVersion: 2,
        eventData: { payload: { data: 'received' } },
      },
    })

    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.ok(body.hook)
    assert.equal(body.hook.status, 'received')
    assert.ok(body.hook.receivedAt)
  })

  it('should update hook status on hook_disposed', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'hook_disposed',
        correlationId: 'hook-1',
        specVersion: 2,
      },
    })

    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.ok(body.hook)
    assert.equal(body.hook.status, 'disposed')

    // Disposed hooks should still appear when listing by runId (for run detail view)
    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/hooks?runId=${runId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(JSON.parse(listRes.body).data.length, 1)
    assert.equal(JSON.parse(listRes.body).data[0].status, 'disposed')
  })
})
