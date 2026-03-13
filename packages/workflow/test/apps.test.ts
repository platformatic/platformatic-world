import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest, type TestContext } from './helper.ts'

describe('apps - CRUD operations', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should create a new application', async () => {
    const appId = `crud-test-${Date.now()}`
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      payload: { appId },
    })
    assert.equal(response.statusCode, 201)
    const body = JSON.parse(response.body)
    assert.equal(body.appId, appId)

    // Verify in DB
    const result = await ctx.app.pg.query(
      'SELECT app_id FROM workflow_applications WHERE app_id = $1',
      [appId]
    )
    assert.equal(result.rows.length, 1)

    // Cleanup
    await ctx.app.pg.query('DELETE FROM workflow_applications WHERE app_id = $1', [appId])
  })

  it('should be idempotent - return 200 if app already exists', async () => {
    const appId = `idempotent-test-${Date.now()}`

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      payload: { appId },
    })
    assert.equal(first.statusCode, 201)

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      payload: { appId },
    })
    assert.equal(second.statusCode, 200)
    assert.equal(JSON.parse(second.body).appId, appId)

    await ctx.app.pg.query('DELETE FROM workflow_applications WHERE app_id = $1', [appId])
  })

  it('should return 400 when appId is missing', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      payload: {},
    })
    assert.equal(response.statusCode, 400)
  })

  it('should create a k8s binding', async () => {
    const appId = `binding-test-${Date.now()}`

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      payload: { appId },
    })

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/k8s-binding`,
      payload: { namespace: 'test-ns', serviceAccount: 'test-sa' },
    })
    assert.equal(response.statusCode, 201)
    const body = JSON.parse(response.body)
    assert.equal(body.appId, appId)
    assert.equal(body.namespace, 'test-ns')
    assert.equal(body.serviceAccount, 'test-sa')

    // Verify in DB
    const result = await ctx.app.pg.query(
      `SELECT namespace, service_account FROM workflow_app_k8s_bindings
       WHERE namespace = $1 AND service_account = $2`,
      ['test-ns', 'test-sa']
    )
    assert.equal(result.rows.length, 1)

    // Cleanup
    await ctx.app.pg.query(
      'DELETE FROM workflow_app_k8s_bindings WHERE namespace = $1 AND service_account = $2',
      ['test-ns', 'test-sa']
    )
    await ctx.app.pg.query('DELETE FROM workflow_applications WHERE app_id = $1', [appId])
  })

  it('should upsert k8s binding on conflict', async () => {
    const appId1 = `upsert-test-1-${Date.now()}`
    const appId2 = `upsert-test-2-${Date.now()}`

    await ctx.app.inject({ method: 'POST', url: '/api/v1/apps', payload: { appId: appId1 } })
    await ctx.app.inject({ method: 'POST', url: '/api/v1/apps', payload: { appId: appId2 } })

    // Create binding for app1
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId1}/k8s-binding`,
      payload: { namespace: 'upsert-ns', serviceAccount: 'upsert-sa' },
    })

    // Same namespace+serviceAccount for app2 should upsert
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId2}/k8s-binding`,
      payload: { namespace: 'upsert-ns', serviceAccount: 'upsert-sa' },
    })
    assert.equal(response.statusCode, 201)

    // Verify binding now points to app2
    const app2Result = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [appId2]
    )
    const bindingResult = await ctx.app.pg.query(
      `SELECT application_id FROM workflow_app_k8s_bindings
       WHERE namespace = $1 AND service_account = $2`,
      ['upsert-ns', 'upsert-sa']
    )
    assert.equal(bindingResult.rows[0].application_id, app2Result.rows[0].id)

    // Cleanup
    await ctx.app.pg.query(
      'DELETE FROM workflow_app_k8s_bindings WHERE namespace = $1 AND service_account = $2',
      ['upsert-ns', 'upsert-sa']
    )
    await ctx.app.pg.query('DELETE FROM workflow_applications WHERE app_id = $1', [appId1])
    await ctx.app.pg.query('DELETE FROM workflow_applications WHERE app_id = $1', [appId2])
  })

  it('should return 404 when creating binding for non-existent app', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps/does-not-exist/k8s-binding',
      payload: { namespace: 'ns', serviceAccount: 'sa' },
    })
    assert.equal(response.statusCode, 404)
  })

  it('should return 400 when binding fields are missing', async () => {
    const appId = `bad-binding-${Date.now()}`
    await ctx.app.inject({ method: 'POST', url: '/api/v1/apps', payload: { appId } })

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/k8s-binding`,
      payload: { namespace: 'ns' },
    })
    assert.equal(response.statusCode, 400)

    await ctx.app.pg.query('DELETE FROM workflow_applications WHERE app_id = $1', [appId])
  })

  it('should delete a k8s binding', async () => {
    const appId = `delete-binding-${Date.now()}`
    await ctx.app.inject({ method: 'POST', url: '/api/v1/apps', payload: { appId } })
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/k8s-binding`,
      payload: { namespace: 'del-ns', serviceAccount: 'del-sa' },
    })

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/apps/${appId}/k8s-binding`,
      payload: { namespace: 'del-ns', serviceAccount: 'del-sa' },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(JSON.parse(response.body).deleted, true)

    // Verify deletion
    const result = await ctx.app.pg.query(
      `SELECT id FROM workflow_app_k8s_bindings
       WHERE namespace = $1 AND service_account = $2`,
      ['del-ns', 'del-sa']
    )
    assert.equal(result.rows.length, 0)

    await ctx.app.pg.query('DELETE FROM workflow_applications WHERE app_id = $1', [appId])
  })

  it('should return 404 when deleting binding for non-existent app', async () => {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/apps/does-not-exist/k8s-binding',
      payload: { namespace: 'ns', serviceAccount: 'sa' },
    })
    assert.equal(response.statusCode, 404)
  })
})
