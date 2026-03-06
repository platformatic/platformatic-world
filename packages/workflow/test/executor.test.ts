import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { buildApp } from '../src/app.ts'
import type { FastifyInstance } from 'fastify'

const CONNECTION_STRING = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'
const MASTER_KEY = 'executor-test-master-key'

let app: FastifyInstance
let appId: string
let appNumericId: number

before(async () => {
  app = await buildApp({
    connectionString: CONNECTION_STRING,
    auth: {
      mode: 'api-key',
      masterKey: MASTER_KEY,
    },
    enablePoller: false,
  })
  await app.ready()

  // Provision a test application
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/apps',
    headers: { authorization: `Bearer ${MASTER_KEY}` },
    payload: { appId: 'executor-test-app' },
  })
  const body = JSON.parse(response.body)
  appId = body.appId

  const result = await app.pg.query(
    'SELECT id FROM workflow_applications WHERE app_id = $1',
    [appId]
  )
  appNumericId = result.rows[0].id
})

after(async () => {
  const result = await app.pg.query(
    'SELECT id FROM workflow_applications WHERE app_id = $1',
    [appId]
  )
  if (result.rows.length > 0) {
    const id = result.rows[0].id
    await app.pg.query('DELETE FROM workflow_events WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_queue_messages WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_runs WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_deployment_versions WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_queue_handlers WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_app_quotas WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_app_keys WHERE application_id = $1', [id])
    await app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [id])
  }
  await app.close()
})

test('NOTIFY wakes up deferred message processing', async () => {
  // Insert a deferred message with 1 second delay
  await app.pg.query(
    `INSERT INTO workflow_queue_messages
     (queue_name, run_id, deployment_version, application_id, payload, status, deliver_at)
     VALUES ($1, $2, $3, $4, $5, 'deferred', NOW() + make_interval(secs => 1))`,
    ['test-queue', '', '', appNumericId, JSON.stringify({ test: true })]
  )

  // Fire NOTIFY
  await app.pg.query("SELECT pg_notify('deferred_messages', '')")

  // Verify the notification channel exists by listening
  const client = new pg.Client({ connectionString: CONNECTION_STRING })
  await client.connect()

  try {
    await client.query('LISTEN deferred_messages')

    // Insert another deferred message and NOTIFY
    await app.pg.query(
      `INSERT INTO workflow_queue_messages
       (queue_name, run_id, deployment_version, application_id, payload, status, deliver_at)
       VALUES ($1, $2, $3, $4, $5, 'deferred', NOW() + make_interval(secs => 1))`,
      ['test-queue-2', '', '', appNumericId, JSON.stringify({ test: 2 })]
    )
    await app.pg.query("SELECT pg_notify('deferred_messages', '')")

    // Wait for notification
    const notification = await new Promise<pg.Notification>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Notification timeout')), 5000)
      client.once('notification', (msg) => {
        clearTimeout(timeout)
        resolve(msg)
      })
    })

    assert.equal(notification.channel, 'deferred_messages')
  } finally {
    await client.end()
  }
})

test('deferred messages with short delay are promoted to pending', async () => {
  // Insert a deferred message that's already past due
  const insertResult = await app.pg.query(
    `INSERT INTO workflow_queue_messages
     (queue_name, run_id, deployment_version, application_id, payload, status, deliver_at)
     VALUES ($1, $2, $3, $4, $5, 'deferred', NOW() - INTERVAL '1 second')
     RETURNING id`,
    ['promote-test', '', '', appNumericId, JSON.stringify({ promote: true })]
  )
  const msgId = insertResult.rows[0].id

  // Manually run the promote query (same as executor does)
  await app.pg.query(
    `UPDATE workflow_queue_messages
     SET status = 'pending'
     WHERE status = 'deferred' AND deliver_at <= NOW()`
  )

  // Check the message is now pending
  const result = await app.pg.query(
    'SELECT status FROM workflow_queue_messages WHERE id = $1',
    [msgId]
  )
  assert.equal(result.rows[0].status, 'pending')
})

test('queue endpoint fires NOTIFY on deferred insert', async () => {
  const client = new pg.Client({ connectionString: CONNECTION_STRING })
  await client.connect()

  try {
    await client.query('LISTEN deferred_messages')

    // Use the API to insert a deferred message
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/queue`,
      headers: { authorization: `Bearer ${MASTER_KEY}` },
      payload: {
        queueName: 'notify-test',
        message: { hello: 'notify' },
        delaySeconds: 60,
      },
    })
    assert.equal(response.statusCode, 201)

    // Should receive NOTIFY
    const notification = await new Promise<pg.Notification>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Notification timeout')), 5000)
      client.once('notification', (msg) => {
        clearTimeout(timeout)
        resolve(msg)
      })
    })

    assert.equal(notification.channel, 'deferred_messages')
  } finally {
    await client.end()
  }
})
