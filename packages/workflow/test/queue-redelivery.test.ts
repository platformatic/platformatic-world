// Crash and redelivery behaviour.
//
// These are the assertions the design leans on when the transport is remote and
// the broker can hand the same message over twice: a lost ack, or an outbox
// relay that republished after crashing. The claim is that a duplicate can
// never reach the workflow handler, and that a consumer that dies mid-flight
// gets its message back rather than stranding the run.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setupTest, teardownTest, type TestContext } from './helper.ts'
import { createQueueBackend } from '../queue/factory.ts'
import { failureFinalizer } from '../queue/poller.ts'
import { reclaimExpiredDeliveries } from '../queue/stores/postgres.ts'
import type { QueueStore } from '../queue/store.ts'
import type { BrokerTransport } from '../queue/transport.ts'

const silentLog = { info () {}, warn () {}, error () {} }

describe('queue crash and redelivery', () => {
  let ctx: TestContext
  let store: QueueStore
  let transport: BrokerTransport
  let applicationId: number

  before(async () => {
    ctx = await setupTest()
    const backend = createQueueBackend(ctx.app.pg, ctx.app.pgConnectionString, silentLog, 'postgres')
    store = backend.store
    transport = backend.transport
    const app = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1', [ctx.appId]
    )
    applicationId = app.rows[0].id
  })

  after(async () => {
    await transport.close()
    await teardownTest(ctx)
  })

  async function seed (): Promise<{ runId: string, messageId: any }> {
    const runId = `wrun_rd_${randomBytes(6).toString('hex')}`
    await ctx.app.pg.query(
      `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status, spec_version)
       VALUES ($1, $2, 'redelivery', 'v1', 'running', 7)`,
      [runId, applicationId]
    )
    const { messageId } = await store.enqueue({
      queueName: '__wkf_workflow_redelivery',
      applicationId,
      runId,
      deploymentVersion: 'v1',
      payload: JSON.stringify({ runId }),
      payloadBytes: null,
      payloadEncoding: 'json',
    })
    return { runId, messageId }
  }

  it('refuses to re-dispatch a message the broker redelivered after a lost ack', async () => {
    const { messageId } = await seed()
    const claimed = await store.claimForDispatch(messageId)
    assert.ok(claimed)

    // Broker redelivers because the ack never landed. The gate must refuse it,
    // otherwise the workflow handler would run a second time.
    assert.equal(await store.claimForDispatch(messageId), null)
  })

  it('refuses to dispatch a message whose run was already failed', async () => {
    const { messageId } = await seed()
    const claimed = await store.claimForDispatch(messageId)
    await store.deadLetter(claimed!, {
      code: 'HTTP_500',
      message: 'terminal',
      at: new Date().toISOString(),
      attempt: 10,
      target: { queueName: claimed!.queue_name, deploymentVersion: 'v1' },
    }, failureFinalizer)

    // The ack after the dead letter is what a remote transport can lose. The
    // redelivery must not reach the handler.
    assert.equal(await store.claimForDispatch(messageId), null)
    const row = (await ctx.app.pg.query(
      'SELECT status FROM workflow_queue_messages WHERE id = $1', [messageId]
    )).rows[0]
    assert.equal(row.status, 'dead')
  })

  it('returns a message whose consumer died mid-dispatch', async () => {
    const { messageId } = await seed()
    const claimed = await store.claimForDispatch(messageId)
    assert.ok(claimed, 'claimed, then the process dies before reporting back')

    // Nothing else reclaims a 'delivered' message: the retry paths only touch
    // pending, deferred and failed. Age it past the visibility timeout.
    await ctx.app.pg.query(
      "UPDATE workflow_queue_messages SET delivered_at = NOW() - interval '20 minutes' WHERE id = $1",
      [messageId]
    )
    const client = await ctx.app.pg.connect()
    try {
      assert.equal(await reclaimExpiredDeliveries(client, silentLog, 60), 1)
    } finally {
      client.release()
    }

    const again = await store.claimForDispatch(messageId)
    assert.ok(again, 'the message is claimable again after reclaim')
    assert.equal(again!.attempts, 1, 'the lost delivery counted as an attempt')
  })

  it('leaves an idle run alone: no message outstanding is not a fault', async () => {
    const { messageId } = await seed()
    // Delivered and acked long ago; the run is parked on a hook. Reclaim must
    // not resurrect it, or every long-lived workflow would be redelivered.
    await store.claimForDispatch(messageId)
    await ctx.app.pg.query(
      `UPDATE workflow_queue_messages SET status = 'dead', delivered_at = NOW() - interval '20 minutes'
       WHERE id = $1`,
      [messageId]
    )
    const client = await ctx.app.pg.connect()
    try {
      assert.equal(await reclaimExpiredDeliveries(client, silentLog, 60), 0)
    } finally {
      client.release()
    }
  })

  it('republishing from the outbox does not duplicate a delivery', async () => {
    const { messageId } = await seed()
    // A relay that crashed between publish and markPublished publishes again.
    // publish() is required to be idempotent on messageId, and the gate covers
    // the rest: only one claim can ever win.
    await transport.publish(messageId, {
      queueName: '__wkf_workflow_redelivery',
      payload: JSON.stringify({}),
      payloadBytes: null,
      payloadEncoding: 'json',
    })
    await transport.publish(messageId, {
      queueName: '__wkf_workflow_redelivery',
      payload: JSON.stringify({}),
      payloadBytes: null,
      payloadEncoding: 'json',
    })
    assert.ok(await store.claimForDispatch(messageId))
    assert.equal(await store.claimForDispatch(messageId), null)
  })
})

describe('queue delivery lifecycle', () => {
  let ctx: TestContext
  let store: QueueStore
  let transport: BrokerTransport
  let applicationId: number

  before(async () => {
    ctx = await setupTest()
    const backend = createQueueBackend(ctx.app.pg, ctx.app.pgConnectionString, silentLog, 'postgres')
    store = backend.store
    transport = backend.transport
    const app = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1', [ctx.appId]
    )
    applicationId = app.rows[0].id
  })

  after(async () => {
    await transport.close()
    await teardownTest(ctx)
  })

  const enqueue = () => store.enqueue({
    queueName: '__wkf_workflow_lifecycle',
    applicationId,
    runId: '',
    deploymentVersion: 'v1',
    payload: JSON.stringify({}),
    payloadBytes: null,
    payloadEncoding: 'json',
  })

  it('leaves an acknowledged delivery alone when reclaim runs', async () => {
    const runId = `wrun_ack_${randomBytes(6).toString('hex')}`
    await ctx.app.pg.query(
      `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status, spec_version)
       VALUES ($1, $2, 'lifecycle', 'v1', 'running', 7)`,
      [runId, applicationId]
    )
    const { messageId } = await store.enqueue({
      queueName: '__wkf_workflow_lifecycle',
      applicationId,
      runId,
      deploymentVersion: 'v1',
      payload: JSON.stringify({ runId }),
      payloadBytes: null,
      payloadEncoding: 'json',
    })
    const msg = await store.claimForDispatch(messageId)
    await store.ack(msg!)

    // The run is still going, as a long workflow's would be. A successful
    // delivery must not be resurrected once the visibility timeout passes.
    await ctx.app.pg.query(
      "UPDATE workflow_queue_messages SET delivered_at = NOW() - interval '20 minutes' WHERE id = $1",
      [messageId]
    )
    const client = await ctx.app.pg.connect()
    try {
      assert.equal(await reclaimExpiredDeliveries(client, silentLog, 60), 0)
    } finally {
      client.release()
    }
    const row = (await ctx.app.pg.query(
      'SELECT status, acked_at FROM workflow_queue_messages WHERE id = $1', [messageId]
    )).rows[0]
    assert.equal(row.status, 'acked')
    assert.ok(row.acked_at)
  })

  it('makes a message dispatchable again after a dispatch task throws', async () => {
    const { messageId } = await enqueue()
    for (const entry of await store.takeUnpublished(10)) {
      await transport.publish(entry.messageId, entry)
      await store.markPublished(entry.messageId)
    }
    const [leased] = (await transport.receive(50)).filter(m => String(m.messageId) === String(messageId))
    assert.ok(leased, 'the message was offered')
    assert.ok(!(await transport.receive(50)).some(m => String(m.messageId) === String(messageId)),
      'a leased message is not offered twice')

    // The full failure path, both layers: the task claims, then throws before
    // recording any outcome. Releasing only the transport lease is not enough
    // -- the store row would still be 'delivered', so the redelivery would lose
    // claimForDispatch and be acked without ever executing.
    const claimed = await store.claimForDispatch(messageId)
    assert.ok(claimed, 'the task claimed the message')
    await store.releaseClaim(claimed!)
    await transport.release(leased.leaseId)

    const reoffered = (await transport.receive(50)).filter(m => String(m.messageId) === String(messageId))
    assert.equal(reoffered.length, 1, 'a released message is offered again')
    const reclaimed = await store.claimForDispatch(messageId)
    assert.ok(reclaimed, 'and the store lets the redelivery actually run')
    assert.equal(reclaimed!.attempts, 0, 'no delivery happened, so no attempt was spent')
  })

  it('keeps a continuation and its acknowledgement in one transaction', async () => {
    const { messageId } = await enqueue()
    const claimed = await store.claimForDispatch(messageId)
    await store.ack(claimed!, { delaySeconds: 0 })

    const original = (await ctx.app.pg.query(
      'SELECT status FROM workflow_queue_messages WHERE id = $1', [messageId]
    )).rows[0]
    assert.equal(original.status, 'acked')
    const continuations = await ctx.app.pg.query(
      `SELECT id, published_at FROM workflow_queue_messages
       WHERE queue_name = $1 AND id <> $2 AND status = 'pending'`,
      [claimed!.queue_name, messageId]
    )
    assert.equal(continuations.rows.length, 1, 'the continuation committed with the ack')
    assert.equal(continuations.rows[0].published_at, null, 'and goes through the outbox')
  })

  it('returns a retried dead letter to the outbox', async () => {
    const runId = `wrun_dl_${randomBytes(6).toString('hex')}`
    await ctx.app.pg.query(
      `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status, spec_version)
       VALUES ($1, $2, 'deadletter', 'v1', 'running', 7)`,
      [runId, applicationId]
    )
    const { messageId } = await store.enqueue({
      queueName: '__wkf_workflow_deadletter',
      applicationId,
      runId,
      deploymentVersion: 'v1',
      payload: JSON.stringify({ runId }),
      payloadBytes: null,
      payloadEncoding: 'json',
    })
    // Dead, but not finalized, which is what the retry endpoint accepts.
    await ctx.app.pg.query(
      `UPDATE workflow_queue_messages
       SET status = 'dead', dead_at = NOW(), published_at = NOW(), failure_finalized_at = NULL
       WHERE id = $1`,
      [messageId]
    )

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/dead-letters/msg_${messageId}/retry`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(res.statusCode, 200)

    const row = (await ctx.app.pg.query(
      'SELECT status, published_at FROM workflow_queue_messages WHERE id = $1', [messageId]
    )).rows[0]
    assert.equal(row.status, 'pending')
    // Its broker copy was acked when it died, so it has to be published again.
    assert.equal(row.published_at, null)
  })
})

describe('queue coordinator', () => {
  it('announces leadership so a broker-distributed backend actually drains', async () => {
    // The poller only starts draining when the callback reports true. A
    // coordinator that never calls it leaves the queue silently unconsumed,
    // which is what an always-leader constant did.
    const { createAlwaysLeaderCoordinator } = await import('../queue/coordinator.ts')
    const seen: boolean[] = []
    const coordinator = createAlwaysLeaderCoordinator(isLeader => seen.push(isLeader))

    assert.deepEqual(seen, [], 'nothing announced before start')
    coordinator.start()
    assert.deepEqual(seen, [true], 'leadership announced on start')
    assert.equal(coordinator.isLeader(), true)
    await coordinator.stop()
    assert.deepEqual(seen, [true, false], 'and relinquished on stop')
  })
})

describe('queue driver change', () => {
  let ctx: TestContext
  let applicationId: number

  before(async () => {
    ctx = await setupTest()
    const app = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1', [ctx.appId]
    )
    applicationId = app.rows[0].id
  })

  after(async () => { await teardownTest(ctx) })

  it('republishes pending messages when the transport changes underneath them', async () => {
    const { createPostgresQueueStore } = await import('../queue/stores/postgres.ts')
    const onPostgres = createPostgresQueueStore(ctx.app.pg, silentLog, 'postgres')

    const { messageId } = await onPostgres.enqueue({
      queueName: '__wkf_workflow_driver-change',
      applicationId,
      runId: '',
      deploymentVersion: 'v1',
      payload: JSON.stringify({}),
      payloadBytes: null,
      payloadEncoding: 'json',
    })

    // Delivered to the transport that was running at the time.
    for (const entry of await onPostgres.takeUnpublished(100)) {
      await onPostgres.markPublished(entry.messageId)
    }
    assert.ok(!(await onPostgres.takeUnpublished(100)).some(e => String(e.messageId) === String(messageId)),
      'settled against the transport that published it')
    const row = (await ctx.app.pg.query(
      'SELECT published_to FROM workflow_queue_messages WHERE id = $1', [messageId]
    )).rows[0]
    assert.equal(row.published_to, 'postgres')

    // WF_QUEUE_DRIVER changes. The message was never sent to this broker, so
    // being marked published is not enough: it has to go again, or it is
    // stranded for good.
    const onRedis = createPostgresQueueStore(ctx.app.pg, silentLog, 'redis')
    assert.ok((await onRedis.takeUnpublished(100)).some(e => String(e.messageId) === String(messageId)),
      'a pending message is re-offered to the new transport')

    await onRedis.markPublished(messageId)
    assert.ok(!(await onRedis.takeUnpublished(100)).some(e => String(e.messageId) === String(messageId)),
      'and settles once the new transport has it')
  })
})
