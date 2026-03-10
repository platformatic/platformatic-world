import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('auth - single-tenant mode', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should work without auth header in single-tenant mode', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs`,
    })
    assert.equal(response.statusCode, 200)
  })

  it('should have admin access in single-tenant mode', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      payload: { appId: `admin-test-${Date.now()}` },
    })
    assert.equal(response.statusCode, 201)
  })

  it('should allow public paths without auth', async () => {
    const ready = await ctx.app.inject({ method: 'GET', url: '/ready' })
    assert.equal(ready.statusCode, 200)

    const status = await ctx.app.inject({ method: 'GET', url: '/status' })
    assert.equal(status.statusCode, 200)
  })
})
