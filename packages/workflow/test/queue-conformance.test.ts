// Contract every queue backend must satisfy.
//
// Written against the QueueStore + BrokerTransport interfaces rather than any
// one implementation, so a second transport (Redis, SQS) is wired in by adding
// a case to BACKENDS and has to earn the same guarantees. Today only the
// Postgres backend exists, which is the point: these are the assertions that
// tell us whether the next one is correct.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setupTest, teardownTest, type TestContext } from './helper.ts'
import { createQueueBackend } from '../queue/factory.ts'
import { failureFinalizer } from '../queue/poller.ts'
import type { QueueStore } from '../queue/store.ts'
import type { BrokerTransport } from '../queue/transport.ts'

const silentLog = { info () {}, warn () {}, error () {} }

const BACKENDS = ['postgres']

for (const driver of BACKENDS) {
  describe(`queue backend conformance: ${driver}`, () => {
    let ctx: TestContext
    let store: QueueStore
    let transport: BrokerTransport
    let applicationId: number

    before(async () => {
      ctx = await setupTest()
      const backend = createQueueBackend(ctx.app.pg, ctx.app.pgConnectionString, silentLog, driver)
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

    // What the poller does each cycle before receiving: hand committed messages
    // to the transport. For Postgres publish is a no-op and this only stamps
    // published_at, but it runs for every backend so no producer can bypass it.
    async function relay (): Promise<void> {
      for (const entry of await store.takeUnpublished(100)) {
        await transport.publish(entry.messageId, entry)
        await store.markPublished(entry.messageId)
      }
    }

    const enqueue = (over: Record<string, unknown> = {}) => store.enqueue({
      queueName: `__wkf_workflow_conformance-${randomBytes(4).toString('hex')}`,
      applicationId,
      runId: '',
      deploymentVersion: 'v1',
      payload: JSON.stringify({ hello: 'world' }),
      payloadBytes: null,
      payloadEncoding: 'json',
      ...over,
    } as any)

    it('makes an enqueued message receivable once relayed', async () => {
      const { messageId, ready } = await enqueue()
      assert.equal(ready, true)
      await relay()
      const received = await transport.receive(50)
      assert.ok(received.some(m => String(m.messageId) === String(messageId)))
    })

    it('does not offer a deferred message before it is due', async () => {
      const { messageId, ready } = await enqueue({ delaySeconds: 3600 })
      assert.equal(ready, false)
      await relay()
      const received = await transport.receive(50)
      assert.ok(!received.some(m => String(m.messageId) === String(messageId)))
    })

    it('claims a message exactly once', async () => {
      const { messageId } = await enqueue()
      const first = await store.claimForDispatch(messageId)
      assert.ok(first, 'first claim wins')
      assert.equal(first!.attempts, 0)
      // The gate: whatever the transport does, a second claim is refused.
      assert.equal(await store.claimForDispatch(messageId), null)
    })

    it('reports the next wake-up for a deferred message', async () => {
      await enqueue({ delaySeconds: 60 })
      const ms = await store.nextWakeupMs()
      assert.ok(ms !== null && ms > 0 && ms <= 60_000, `expected a due time, got ${ms}`)
    })

    it('returns a retried message to ready once its backoff elapses', async () => {
      const { messageId } = await enqueue()
      const msg = await store.claimForDispatch(messageId)
      await store.scheduleRetry(msg!, 0, {
        code: 'HTTP_503',
        message: 'boom',
        at: new Date().toISOString(),
        attempt: 1,
        target: { queueName: msg!.queue_name, deploymentVersion: 'v1' },
      })
      await store.promoteDue()
      const again = await store.claimForDispatch(messageId)
      assert.ok(again, 'a retried message becomes claimable again')
      assert.equal(again!.attempts, 1, 'the retry counted an attempt')
    })

    it('keeps a message out of the ready set until the relay has published it', async () => {
      const { messageId } = await enqueue()
      // Committed but not yet handed to the transport: not offerable yet. This
      // is what stops a producer that writes a row directly from being marked
      // published without ever having been sent.
      assert.ok((await store.takeUnpublished(100)).some(e => String(e.messageId) === String(messageId)))
      assert.ok(!(await transport.receive(50)).some(m => String(m.messageId) === String(messageId)))

      await relay()
      assert.ok(!(await store.takeUnpublished(100)).some(e => String(e.messageId) === String(messageId)))
      assert.ok((await transport.receive(50)).some(m => String(m.messageId) === String(messageId)))
    })

    it('dead-letters a message and finalizes it in one step', async () => {
      const runId = `wrun_conf_${randomBytes(6).toString('hex')}`
      await ctx.app.pg.query(
        `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status, spec_version)
         VALUES ($1, $2, 'conformance', 'v1', 'running', 7)`,
        [runId, applicationId]
      )
      const { messageId } = await enqueue({ runId, queueName: '__wkf_workflow_conformance' })
      const msg = await store.claimForDispatch(messageId)
      await store.deadLetter(msg!, {
        code: 'HTTP_500',
        message: 'terminal',
        at: new Date().toISOString(),
        attempt: 10,
        target: { queueName: msg!.queue_name, deploymentVersion: 'v1' },
      }, failureFinalizer)

      const row = (await ctx.app.pg.query(
        'SELECT status, dead_at FROM workflow_queue_messages WHERE id = $1', [messageId]
      )).rows[0]
      assert.equal(row.status, 'dead')
      assert.ok(row.dead_at)
      const run = (await ctx.app.pg.query(
        'SELECT status FROM workflow_runs WHERE id = $1', [runId]
      )).rows[0]
      assert.equal(run.status, 'failed', 'the run is finalized with the dead letter')
    })
  })
}
