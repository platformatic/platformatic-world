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

    assert.equal(res.statusCode, 201, res.body)
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

  it('should preserve multiple machine-scoped handlers for the same version', async () => {
    const register = async (podId: string, host: string) => ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/handlers`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        podId,
        deploymentVersion: 'v-multi',
        endpoints: {
          workflow: `http://${host}/workflow`,
          step: `http://${host}/step`,
          webhook: `http://${host}/webhook`,
        },
      },
    })

    assert.equal((await register('pod-a', 'pod-a')).statusCode, 201)
    assert.equal((await register('pod-b', 'pod-b')).statusCode, 201)

    const result = await ctx.app.pg.query(
      `SELECT pod_id FROM workflow_queue_handlers
       WHERE application_id = (SELECT id FROM workflow_applications WHERE app_id = $1)
         AND deployment_version = 'v-multi'
       ORDER BY pod_id`,
      [ctx.appId]
    )
    assert.deepEqual(result.rows, [{ pod_id: 'pod-a' }, { pod_id: 'pod-b' }])
  })

  it('should keep one service-scoped handler per active or expiring version', async () => {
    const register = async (
      podId: string,
      deploymentVersion: string,
      host: string,
      serviceScoped = false
    ) => {
      return ctx.app.inject({
        method: 'POST',
        url: `/api/v1/apps/${ctx.appId}/handlers`,
        headers: { authorization: `Bearer ${ctx.apiKey}` },
        payload: {
          podId,
          deploymentVersion,
          serviceScoped,
          endpoints: {
            workflow: `http://${host}/workflow`,
            step: `http://${host}/step`,
            webhook: `http://${host}/webhook`,
          },
        },
      })
    }

    assert.equal((await register('old-task-id', 'v3.0.0', 'invalid-task-host')).statusCode, 201)
    assert.equal((await register('platformatic/v3.0.0', 'v3.0.0', 'version-service', true)).statusCode, 201)
    assert.equal((await register('platformatic/v4.0.0', 'v4.0.0', 'next-version-service', true)).statusCode, 201)

    // A caller from before service-scoped registrations were introduced must
    // not displace or compete with the stable version Service.
    assert.equal((await register('late-old-task-id', 'v3.0.0', 'late-invalid-host')).statusCode, 201)

    const result = await ctx.app.pg.query(
      `SELECT pod_id, deployment_version, workflow_url, service_scoped FROM workflow_queue_handlers
       WHERE application_id = (SELECT id FROM workflow_applications WHERE app_id = $1)
         AND deployment_version IN ('v3.0.0', 'v4.0.0')
       ORDER BY deployment_version`,
      [ctx.appId]
    )

    assert.deepEqual(result.rows, [
      {
        pod_id: 'platformatic/v3.0.0',
        deployment_version: 'v3.0.0',
        workflow_url: 'http://version-service/workflow',
        service_scoped: true,
      },
      {
        pod_id: 'platformatic/v4.0.0',
        deployment_version: 'v4.0.0',
        workflow_url: 'http://next-version-service/workflow',
        service_scoped: true,
      },
    ])
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
