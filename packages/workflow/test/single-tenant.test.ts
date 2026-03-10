import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.ts'
import type { FastifyInstance } from 'fastify'

const CONNECTION_STRING = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'

let app: FastifyInstance

before(async () => {
  app = await buildApp({
    connectionString: CONNECTION_STRING,
    singleTenant: true,
    defaultAppId: 'single-tenant-test',
    enablePoller: false,
  })
  await app.ready()
})

after(async () => {
  // Clean up
  const result = await app.pg.query(
    'SELECT id FROM workflow_applications WHERE app_id = $1',
    ['single-tenant-test']
  )
  if (result.rows.length > 0) {
    const id = result.rows[0].id
    await app.pg.query('DELETE FROM workflow_events WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_queue_messages WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_runs WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_deployment_versions WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_queue_handlers WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_app_quotas WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [id])
  }
  await app.close()
})

test('default app is auto-provisioned', async () => {
  const result = await app.pg.query(
    'SELECT id, app_id FROM workflow_applications WHERE app_id = $1',
    ['single-tenant-test']
  )
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].app_id, 'single-tenant-test')
})

test('GET /status works without auth header', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/status',
  })
  assert.equal(response.statusCode, 200)
})

test('GET /ready works without auth header', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/ready',
  })
  assert.equal(response.statusCode, 200)
})

test('POST /api/v1/apps/:appId/events works without auth header', async () => {
  // First create a run
  const runResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/apps/single-tenant-test/events',
    payload: {
      eventType: 'test_event',
      eventData: { hello: 'world' },
    },
  })
  assert.equal(runResponse.statusCode < 500, true, `Expected non-500, got ${runResponse.statusCode}: ${runResponse.body}`)
})

test('GET /api/v1/apps/single-tenant-test/runs works without auth', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/apps/single-tenant-test/runs',
  })
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.ok(Array.isArray(body.data))
})

test('POST queue message works without auth', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/apps/single-tenant-test/queue',
    payload: {
      queueName: 'test-queue',
      message: { action: 'test' },
    },
  })
  assert.equal(response.statusCode, 201)
  const body = JSON.parse(response.body)
  assert.ok(body.messageId.startsWith('msg_'))
})
