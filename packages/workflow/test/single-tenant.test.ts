import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest, type TestContext } from './helper.ts'

let ctx: TestContext

before(async () => {
  ctx = await setupTest()
})

after(async () => {
  await teardownTest(ctx)
})

test('default app is auto-provisioned', async () => {
  const result = await ctx.app.pg.query(
    'SELECT id, app_id FROM workflow_applications WHERE app_id = $1',
    [ctx.appId]
  )
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].app_id, ctx.appId)
})

test('POST /api/v1/apps/:appId/events works without auth header', async () => {
  const runResponse = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/events`,
    payload: {
      eventType: 'test_event',
      eventData: { hello: 'world' },
    },
  })
  assert.equal(runResponse.statusCode < 500, true, `Expected non-500, got ${runResponse.statusCode}: ${runResponse.body}`)
})

test('GET runs works without auth', async () => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/apps/${ctx.appId}/runs`,
  })
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.ok(Array.isArray(body.data))
})

test('POST queue message works without auth', async () => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/queue`,
    payload: {
      queueName: 'test-queue',
      message: { action: 'test' },
    },
  })
  assert.equal(response.statusCode, 201)
  const body = JSON.parse(response.body)
  assert.ok(body.messageId.startsWith('msg_'))
})
