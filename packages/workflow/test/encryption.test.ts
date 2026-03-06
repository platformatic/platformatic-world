import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('encryption', () => {
  let ctx: TestContext
  let runId: string

  before(async () => {
    ctx = await setupTest()

    // Create a run
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1', workflowName: 'enc-test', input: {} },
      },
    })
    runId = JSON.parse(response.body).run.runId
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should return an encryption key for a run', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/encryption-key?runId=${runId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.ok(body.key)
    // Key should be base64 encoded 32 bytes
    const buf = Buffer.from(body.key, 'base64')
    assert.equal(buf.length, 32)
  })

  it('should return deterministic keys for the same run', async () => {
    const res1 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/encryption-key?runId=${runId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    const res2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/encryption-key?runId=${runId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(JSON.parse(res1.body).key, JSON.parse(res2.body).key)
  })

  it('should return different keys for different runs', async () => {
    const res1 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/encryption-key?runId=${runId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    const res2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/encryption-key?runId=different-run-id`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.notEqual(JSON.parse(res1.body).key, JSON.parse(res2.body).key)
  })
})
