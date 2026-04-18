import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { decode, encode } from 'cbor-x'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('queue', () => {
  let ctx: TestContext
  let runId: string

  before(async () => {
    ctx = await setupTest()

    // Create a run
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'queue-test', input: {} },
      },
    })
    runId = JSON.parse(response.body).run.runId
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should enqueue an immediate message', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_test',
        message: { runId },
        deploymentId: 'v1.0.0',
      },
    })

    assert.equal(response.statusCode, 201)
    const body = JSON.parse(response.body)
    assert.ok(body.messageId)
    assert.ok(body.messageId.startsWith('msg_'))
  })

  it('should enqueue a deferred message', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_test',
        message: { runId },
        deploymentId: 'v1.0.0',
        delaySeconds: 60,
      },
    })

    assert.equal(response.statusCode, 201)
    const body = JSON.parse(response.body)
    assert.ok(body.messageId)
    assert.equal(body.scheduled, true)
    assert.ok(body.deliverAt)
  })

  it('JSON enqueue stores payload JSONB with encoding=json', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_test',
        message: { runId, marker: 'json-marker' },
        deploymentId: 'v1.0.0',
      },
    })
    assert.equal(response.statusCode, 201)
    const msgId = Number(JSON.parse(response.body).messageId.slice(4))
    const row = await ctx.app.pg.query(
      'SELECT payload, payload_bytes, payload_encoding FROM workflow_queue_messages WHERE id = $1',
      [msgId]
    )
    assert.equal(row.rows[0].payload_encoding, 'json')
    assert.equal(row.rows[0].payload.marker, 'json-marker')
    assert.equal(row.rows[0].payload_bytes, null)
  })

  it('CBOR enqueue stores payload_bytes with encoding=cbor', async () => {
    const envelope = {
      queueName: '__wkf_workflow_test',
      message: { runId, bytes: new Uint8Array([1, 2, 3, 4]) },
      deploymentId: 'v1.0.0',
    }
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/cbor',
      },
      payload: Buffer.from(encode(envelope)),
    })
    assert.equal(response.statusCode, 201)
    const msgId = Number(JSON.parse(response.body).messageId.slice(4))
    const row = await ctx.app.pg.query(
      'SELECT payload, payload_bytes, payload_encoding FROM workflow_queue_messages WHERE id = $1',
      [msgId]
    )
    assert.equal(row.rows[0].payload_encoding, 'cbor')
    assert.equal(row.rows[0].payload, null)
    assert.ok(Buffer.isBuffer(row.rows[0].payload_bytes))
    const decoded = decode(row.rows[0].payload_bytes) as any
    assert.equal(decoded.runId, runId)
    assert.ok(decoded.bytes instanceof Uint8Array)
    assert.deepEqual(Array.from(decoded.bytes), [1, 2, 3, 4])
  })

  it('CBOR deferred enqueue stores payload_bytes with encoding=cbor', async () => {
    const envelope = {
      queueName: '__wkf_workflow_test',
      message: { runId, marker: 'cbor-deferred' },
      deploymentId: 'v1.0.0',
      delaySeconds: 60,
    }
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/cbor',
      },
      payload: Buffer.from(encode(envelope)),
    })
    assert.equal(response.statusCode, 201)
    const body = JSON.parse(response.body)
    assert.equal(body.scheduled, true)
    const msgId = Number(body.messageId.slice(4))
    const row = await ctx.app.pg.query(
      'SELECT payload_encoding, status FROM workflow_queue_messages WHERE id = $1',
      [msgId]
    )
    assert.equal(row.rows[0].payload_encoding, 'cbor')
    assert.equal(row.rows[0].status, 'deferred')
  })

  it('idempotency conflict spans JSON and CBOR formats', async () => {
    const key = `idem-mixed-${randomBytes(8).toString('hex')}`

    const jsonResp = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_test',
        message: { runId },
        deploymentId: 'v1.0.0',
        idempotencyKey: key,
      },
    })
    assert.equal(jsonResp.statusCode, 201)

    const cborResp = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'content-type': 'application/cbor',
      },
      payload: Buffer.from(encode({
        queueName: '__wkf_workflow_test',
        message: { runId },
        deploymentId: 'v1.0.0',
        idempotencyKey: key,
      })),
    })
    assert.equal(cborResp.statusCode, 409)
  })

  it('should reject duplicate idempotency keys', async () => {
    const key = `idem-${randomBytes(8).toString('hex')}`

    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_test',
        message: { runId },
        deploymentId: 'v1.0.0',
        idempotencyKey: key,
      },
    })

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_test',
        message: { runId },
        deploymentId: 'v1.0.0',
        idempotencyKey: key,
      },
    })

    assert.equal(response.statusCode, 409)
  })
})
