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

describe('spec alignment', () => {
  let ctx: TestContext

  before(async () => { ctx = await setupTest() })
  after(async () => { await teardownTest(ctx) })

  it('routes namespaced queue names by the spec grammar, not a bare prefix', async () => {
    // The spec allows __{namespace}_wkf_workflow_<id> (WORKFLOW_QUEUE_NAMESPACE).
    // Matching the un-namespaced literal sent these to the webhook handler.
    const { isWorkflowQueue, isStepQueue, workflowNameFromQueue, workflowQueueNameLike } =
      await import('../queue/names.ts')

    assert.ok(isWorkflowQueue('__wkf_workflow_greet'))
    assert.ok(isWorkflowQueue('__acme_wkf_workflow_greet'))
    assert.equal(workflowNameFromQueue('__acme_wkf_workflow_greet'), 'greet')
    assert.ok(isStepQueue('__acme_wkf_step_add'))
    assert.ok(!isWorkflowQueue('__acme_wkf_step_add'))
    assert.ok(!isWorkflowQueue('webhook'))
    // A namespace must be lowercase alphanumeric starting with a letter.
    assert.ok(!isWorkflowQueue('__9bad_wkf_workflow_greet'))

    // An invalid WORKFLOW_QUEUE_NAMESPACE must fail loudly where the prefix is
    // built (as the spec's getQueueTopicPrefix does), not silently produce a
    // name that routes to the webhook handler.
    const { workflowQueueName } = await import('../queue/names.ts')
    const previousNs = process.env.WORKFLOW_QUEUE_NAMESPACE
    try {
      process.env.WORKFLOW_QUEUE_NAMESPACE = 'acme'
      assert.equal(workflowQueueName('greet'), '__acme_wkf_workflow_greet')
      for (const bad of ['Bad_Name', '9lives', 'has-dash', 'UPPER']) {
        process.env.WORKFLOW_QUEUE_NAMESPACE = bad
        assert.throws(() => workflowQueueName('greet'), /WORKFLOW_QUEUE_NAMESPACE/)
      }
      delete process.env.WORKFLOW_QUEUE_NAMESPACE
      assert.equal(workflowQueueName('greet'), '__wkf_workflow_greet')
    } finally {
      if (previousNs === undefined) delete process.env.WORKFLOW_QUEUE_NAMESPACE
      else process.env.WORKFLOW_QUEUE_NAMESPACE = previousNs
    }

    // A continuation stays in the namespace the original arrived on.
    assert.equal(workflowQueueNameLike('__acme_wkf_workflow_greet', 'other'), '__acme_wkf_workflow_other')
    assert.equal(workflowQueueNameLike('__acme_wkf_step_add', 'other'), '__acme_wkf_workflow_other')
    assert.equal(workflowQueueNameLike('webhook', 'other'), '__wkf_workflow_other')
  })

  it('refuses to enqueue for an expired deployment version', async () => {
    const appRow = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1', [ctx.appId]
    )
    await ctx.app.pg.query(
      `INSERT INTO workflow_deployment_versions (application_id, deployment_version, status)
       VALUES ($1, 'v-expired', 'expired')
       ON CONFLICT (application_id, deployment_version) DO UPDATE SET status = 'expired'`,
      [appRow.rows[0].id]
    )

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_expired-version',
        message: { runId: 'wrun_expired' },
        deploymentId: 'v-expired',
      },
    })
    // 410 is what the World client reports through isDeploymentUnavailableError.
    assert.equal(res.statusCode, 410)

    // A draining version still accepts work, matching routeMessage().
    await ctx.app.pg.query(
      `INSERT INTO workflow_deployment_versions (application_id, deployment_version, status)
       VALUES ($1, 'v-draining', 'draining')
       ON CONFLICT (application_id, deployment_version) DO UPDATE SET status = 'draining'`,
      [appRow.rows[0].id]
    )
    const draining = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_draining-version',
        message: { runId: 'wrun_draining' },
        deploymentId: 'v-draining',
      },
    })
    assert.equal(draining.statusCode, 201)
  })

  it('still dedupes an already-accepted message after its version expires', async () => {
    // A retry of a message we already enqueued must answer 409, which the SDK
    // reads as successful deduplication. Answering 410 would tell it the
    // delivery is terminally undeliverable and could fail a healthy run.
    const appRow = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1', [ctx.appId]
    )
    const key = `idem-${randomBytes(8).toString('hex')}`
    const send = () => ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/queue`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        queueName: '__wkf_workflow_dedupe-after-expiry',
        message: { runId: 'wrun_dedupe' },
        deploymentId: 'v-dedupe',
        idempotencyKey: key,
      },
    })

    assert.equal((await send()).statusCode, 201)

    await ctx.app.pg.query(
      `INSERT INTO workflow_deployment_versions (application_id, deployment_version, status)
       VALUES ($1, 'v-dedupe', 'expired')
       ON CONFLICT (application_id, deployment_version) DO UPDATE SET status = 'expired'`,
      [appRow.rows[0].id]
    )

    assert.equal((await send()).statusCode, 409)
  })
})
