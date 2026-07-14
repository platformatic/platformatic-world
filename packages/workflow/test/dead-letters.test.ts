import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest, type TestContext } from './helper.ts'

describe('dead-letters', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  async function createDeadMessage (queueName: string, payload: any, terminalized = false): Promise<number> {
    const appResult = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [ctx.appId]
    )
    const applicationId = appResult.rows[0].id

    const result = await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
       (queue_name, run_id, deployment_version, application_id, payload, status, attempts,
        last_failure, dead_at, terminalized_at)
       VALUES ($1, 'run-1', 'v1', $2, $3, 'dead', 10, $4, NOW(),
               CASE WHEN $5 THEN NOW() ELSE NULL END)
       RETURNING id`,
      [queueName, applicationId, JSON.stringify(payload), {
        code: 'HTTP_503',
        message: 'Target returned HTTP 503',
      }, terminalized]
    )
    return result.rows[0].id
  }

  it('should list dead-lettered messages', async () => {
    await createDeadMessage('queue-a', { data: 1 })
    await createDeadMessage('queue-b', { data: 2 })

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/dead-letters`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.ok(Array.isArray(body.data))
    assert.ok(body.data.length >= 2)
    assert.equal(body.data[0].queueName, 'queue-b') // newest first
    assert.equal(body.data[0].lastFailure.code, 'HTTP_503')
    assert.ok(body.data[0].deadAt)
    assert.equal(body.data[0].terminalizedAt, null)
  })

  it('should filter by queueName', async () => {
    await createDeadMessage('filtered-queue', { test: true })

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/dead-letters?queueName=filtered-queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.ok(body.data.length >= 1)
    for (const msg of body.data) {
      assert.equal(msg.queueName, 'filtered-queue')
    }
  })

  it('should retry a dead message', async () => {
    const id = await createDeadMessage('retry-queue', { retry: true })

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/dead-letters/msg_${id}/retry`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.retried, true)

    // Verify message is now pending
    const check = await ctx.app.pg.query(
      'SELECT status, attempts FROM workflow_queue_messages WHERE id = $1',
      [id]
    )
    assert.equal(check.rows[0].status, 'pending')
    assert.equal(check.rows[0].attempts, 0)
  })

  it('should reject retry for non-dead message', async () => {
    const appResult = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [ctx.appId]
    )
    const applicationId = appResult.rows[0].id

    const result = await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
       (queue_name, run_id, deployment_version, application_id, payload, status)
       VALUES ('q', 'run-1', 'v1', $1, '{}', 'pending')
       RETURNING id`,
      [applicationId]
    )
    const id = result.rows[0].id

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/dead-letters/msg_${id}/retry`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 400)
  })

  it('should reject retry for a terminalized dead message', async () => {
    const id = await createDeadMessage('terminalized-queue', { retry: false }, true)
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/dead-letters/msg_${id}/retry`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 400)
    const check = await ctx.app.pg.query(
      'SELECT status, terminalized_at FROM workflow_queue_messages WHERE id = $1',
      [id]
    )
    assert.equal(check.rows[0].status, 'dead')
    assert.ok(check.rows[0].terminalized_at)
  })

  it('should paginate dead letters', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/dead-letters?limit=1`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.data.length, 1)
    assert.ok(body.hasMore)
    assert.ok(body.cursor)
  })
})
