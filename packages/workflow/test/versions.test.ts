import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('versions', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should notify a new version', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/versions/notify',
      payload: {
        applicationId: ctx.appId,
        deploymentVersion: 'v1.0.0',
        status: 'active',
      },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { updated: true })
  })

  it('should upsert version status', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/versions/notify',
      payload: {
        applicationId: ctx.appId,
        deploymentVersion: 'v2.0.0',
        status: 'active',
      },
    })

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/versions/notify',
      payload: {
        applicationId: ctx.appId,
        deploymentVersion: 'v2.0.0',
        status: 'draining',
      },
    })

    assert.equal(res.statusCode, 200)

    const result = await ctx.app.pg.query(
      `SELECT status FROM workflow_deployment_versions
       WHERE application_id = (SELECT id FROM workflow_applications WHERE app_id = $1)
         AND deployment_version = 'v2.0.0'`,
      [ctx.appId]
    )
    assert.equal(result.rows[0].status, 'draining')
  })

  it('should reject with missing fields', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/versions/notify',
      payload: {
        applicationId: ctx.appId,
      },
    })

    assert.equal(res.statusCode, 400)
  })

  it('should reject for nonexistent application', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/versions/notify',
      payload: {
        applicationId: 'nonexistent-app',
        deploymentVersion: 'v1.0.0',
        status: 'active',
      },
    })

    assert.equal(res.statusCode, 400)
  })
})
