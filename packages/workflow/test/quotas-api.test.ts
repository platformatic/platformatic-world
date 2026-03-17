import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('quotas API', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should return default quotas when none are set', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/quotas`
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.maxRuns, 10_000)
    assert.equal(body.maxEventsPerRun, 100_000)
    assert.equal(body.maxQueuePerMinute, 100_000)
    assert.equal(body.isDefault, true)
  })

  it('should set custom quotas', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/quotas`,
      payload: {
        maxRuns: 500,
        maxEventsPerRun: 5000,
        maxQueuePerMinute: 200
      }
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.maxRuns, 500)
    assert.equal(body.maxEventsPerRun, 5000)
    assert.equal(body.maxQueuePerMinute, 200)
  })

  it('should return custom quotas after setting', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/quotas`
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.maxRuns, 500)
    assert.equal(body.maxEventsPerRun, 5000)
    assert.equal(body.maxQueuePerMinute, 200)
    assert.equal(body.isDefault, false)
  })

  it('should allow partial quota updates', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/quotas`,
      payload: {
        maxRuns: 1000
      }
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.maxRuns, 1000)
    // Unspecified fields get defaults
    assert.equal(body.maxEventsPerRun, 100_000)
    assert.equal(body.maxQueuePerMinute, 100_000)
  })

  it('should reject empty payload', async () => {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/quotas`,
      payload: {}
    })

    assert.equal(response.statusCode, 400)
  })
})
