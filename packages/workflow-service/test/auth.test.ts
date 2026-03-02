import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest, MASTER_KEY } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('auth', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should reject requests without auth header', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs`,
    })
    assert.equal(response.statusCode, 401)
  })

  it('should reject requests with invalid API key', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs`,
      headers: { authorization: 'Bearer invalid-key' },
    })
    assert.equal(response.statusCode, 401)
  })

  it('should accept requests with valid API key', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(response.statusCode, 200)
  })

  it('should reject app-scoped requests with wrong app ID', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/apps/nonexistent-app/runs',
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(response.statusCode, 403)
  })

  it('should accept master key for admin endpoints', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/keys/rotate`,
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    })
    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.ok(body.apiKey.startsWith('wfk_'))

    // Update ctx.apiKey for subsequent tests
    ctx.apiKey = body.apiKey
  })

  it('should reject app key for admin endpoints', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/keys/rotate`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(response.statusCode, 403)
  })

  it('should allow public paths without auth', async () => {
    const ready = await ctx.app.inject({ method: 'GET', url: '/ready' })
    assert.equal(ready.statusCode, 200)

    const status = await ctx.app.inject({ method: 'GET', url: '/status' })
    assert.equal(status.statusCode, 200)
  })
})
