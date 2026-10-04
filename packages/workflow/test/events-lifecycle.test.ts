import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { setupTest, teardownTest, failQueries, type TestContext } from './helper.ts'
import { encodeData } from '../plugins/events.ts'

describe('event lifecycle', () => {
  let ctx: TestContext
  let applicationId: number

  before(async () => {
    ctx = await setupTest()
    const app = await ctx.app.pg.query('SELECT id FROM workflow_applications WHERE app_id = $1', [ctx.appId])
    applicationId = app.rows[0].id
  })

  after(async () => {
    await teardownTest(ctx)
  })

  async function post (runId: string, payload: any, query = ''): Promise<{ status: number, body: any }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events${query}`,
      payload,
    })
    return { status: res.statusCode, body: res.json() }
  }

  async function createRun (specVersion: number | undefined = 2, eventData: any = {}): Promise<string> {
    const runId = `wrun_${randomBytes(8).toString('hex')}`
    const { status } = await post(runId, {
      eventType: 'run_created',
      specVersion,
      eventData: { deploymentId: 'v1', workflowName: 'lifecycle', ...eventData },
    })
    assert.equal(status, 200)
    return runId
  }

  async function addHookAndWait (runId: string): Promise<void> {
    await post(runId, { eventType: 'hook_created', correlationId: 'hook-1', eventData: { token: randomUUID() } })
    await post(runId, { eventType: 'wait_created', correlationId: 'wait-1', eventData: {} })
  }

  async function hookAndWaitStatus (runId: string): Promise<string[]> {
    const hook = await ctx.app.pg.query('SELECT status FROM workflow_hooks WHERE run_id = $1', [runId])
    const wait = await ctx.app.pg.query('SELECT status FROM workflow_waits WHERE run_id = $1', [runId])
    return [hook.rows[0].status, wait.rows[0].status]
  }

  describe('terminal run events', () => {
    it('run_failed records the error, cleans up and is idempotent', async () => {
      const runId = await createRun()
      await addHookAndWait(runId)

      const failed = await post(runId, { eventType: 'run_failed', eventData: { error: { message: 'boom' } } })
      assert.equal(failed.status, 200)
      assert.equal(failed.body.event.eventType, 'run_failed')
      assert.equal(failed.body.run.status, 'failed')
      assert.deepEqual(failed.body.run.error, { message: 'boom' })
      assert.ok(failed.body.run.completedAt)
      assert.deepEqual(await hookAndWaitStatus(runId), ['disposed', 'completed'])

      const again = await post(runId, { eventType: 'run_failed', eventData: { error: 'later' } })
      assert.equal(again.status, 200)
      assert.equal(again.body.event, null)
      assert.deepEqual(again.body.run.error, { message: 'boom' })
    })

    it('run_failed without an error leaves it unset, and does not override a completed run', async () => {
      const bare = await createRun()
      const failed = await post(bare, { eventType: 'run_failed' })
      assert.equal(failed.body.run.status, 'failed')
      assert.equal(failed.body.run.error, undefined)

      const completed = await createRun()
      await post(completed, { eventType: 'run_completed' })
      const late = await post(completed, { eventType: 'run_failed', eventData: { error: 'too late' } })
      assert.equal(late.body.event, null)
      assert.equal(late.body.run.status, 'completed')
    })

    it('run_completed without output is idempotent', async () => {
      const runId = await createRun()
      const first = await post(runId, { eventType: 'run_completed' })
      assert.equal(first.body.run.status, 'completed')
      assert.equal(first.body.run.output, undefined)
      const second = await post(runId, { eventType: 'run_completed', eventData: { output: { late: true } } })
      assert.equal(second.body.event, null)
    })

    it('run_cancelled disposes hooks and completes waits', async () => {
      const runId = await createRun()
      await addHookAndWait(runId)

      const cancelled = await post(runId, { eventType: 'run_cancelled' })
      assert.equal(cancelled.status, 200)
      assert.equal(cancelled.body.event.eventType, 'run_cancelled')
      assert.equal(cancelled.body.run.status, 'cancelled')
      assert.deepEqual(await hookAndWaitStatus(runId), ['disposed', 'completed'])
    })

    it('run_expired stamps expiry and disposes hooks', async () => {
      const runId = await createRun()
      await addHookAndWait(runId)

      const expired = await post(runId, { eventType: 'run_expired' })
      assert.equal(expired.status, 200)
      assert.equal(expired.body.run.status, 'expired')
      assert.ok(expired.body.run.expiredAt)
      assert.equal((await hookAndWaitStatus(runId))[0], 'disposed')
    })

    it('answers 404 for an unknown run instead of tripping the event foreign key', async () => {
      for (const eventType of ['run_completed', 'run_failed', 'run_cancelled', 'run_expired']) {
        const res = await post('no-such-run', { eventType })
        assert.equal(res.status, 404, eventType)
        assert.match(res.body.message, /no-such-run/)
      }
    })

    it('run_started without bootstrap data cannot recover an unknown run', async () => {
      const res = await post(`wrun_${randomBytes(8).toString('hex')}`, { eventType: 'run_started' })
      assert.equal(res.status, 404)
    })

    it('run_started bootstraps a run with no input and is deduplicated', async () => {
      const runId = `wrun_${randomBytes(8).toString('hex')}`
      const payload = { eventType: 'run_started', eventData: { workflowName: 'lifecycle', deploymentId: 'v1' } }
      const first = await post(runId, payload)
      assert.equal(first.status, 200)
      assert.equal(first.body.run.status, 'running')
      assert.equal(first.body.run.input, undefined)

      const second = await post(runId, payload)
      assert.equal(second.body.event, null)
      assert.equal(second.body.run.status, 'running')
    })

    it('run_created is quiet about an existing run whose creation event is gone', async () => {
      const runId = await createRun()
      await ctx.app.pg.query('DELETE FROM workflow_events WHERE run_id = $1', [runId])
      const res = await post(runId, { eventType: 'run_created', eventData: { deploymentId: 'v1', workflowName: 'lifecycle' } })
      assert.equal(res.status, 200)
      assert.equal(res.body.event, null)
      assert.equal(res.body.run.runId, runId)
    })

    it('rejects an unknown event type and rolls back', async () => {
      const runId = await createRun()
      const res = await post(runId, { eventType: 'run_teleported' })
      assert.equal(res.status, 400)
      assert.match(res.body.message, /unknown event type: run_teleported/)
    })
  })

  describe('step events', () => {
    async function createStep (runId: string, correlationId = 'step-1'): Promise<void> {
      const res = await post(runId, { eventType: 'step_created', correlationId, eventData: { stepName: 'work', input: { n: 1 } } })
      assert.equal(res.status, 200)
    }

    it('step_created is idempotent and returns the existing step', async () => {
      const runId = await createRun()
      await createStep(runId)
      const again = await post(runId, { eventType: 'step_created', correlationId: 'step-1', eventData: { stepName: 'work' } })
      assert.equal(again.status, 200)
      assert.equal(again.body.step.stepName, 'work')
      const events = await ctx.app.pg.query("SELECT id FROM workflow_events WHERE run_id = $1 AND event_type = 'step_created'", [runId])
      assert.equal(events.rows.length, 1)
    })

    it('step_created without event data fails on the step name constraint', async () => {
      const runId = await createRun()
      const res = await post(runId, { eventType: 'step_created', correlationId: 'step-x' })
      assert.equal(res.status, 500)
    })

    it('step_failed records the error and is idempotent', async () => {
      const runId = await createRun()
      await createStep(runId)
      await post(runId, { eventType: 'step_started', correlationId: 'step-1' })

      const failed = await post(runId, { eventType: 'step_failed', correlationId: 'step-1', eventData: { error: 'plain message' } })
      assert.equal(failed.status, 200)
      assert.equal(failed.body.step.status, 'failed')
      assert.equal(failed.body.step.error, 'plain message')

      const again = await post(runId, { eventType: 'step_failed', correlationId: 'step-1' })
      assert.equal(again.body.event, null)
      assert.equal(again.body.step.status, 'failed')
    })

    it('step_failed does not override a completed step, and tolerates a missing one', async () => {
      const runId = await createRun()
      await createStep(runId)
      await post(runId, { eventType: 'step_started', correlationId: 'step-1' })
      await post(runId, { eventType: 'step_completed', correlationId: 'step-1', eventData: { result: { ok: true } } })
      const late = await post(runId, { eventType: 'step_failed', correlationId: 'step-1', eventData: { error: 'late' } })
      assert.equal(late.body.event, null)
      assert.equal(late.body.step.status, 'completed')

      const orphan = await post(runId, { eventType: 'step_failed', correlationId: 'never-created' })
      assert.equal(orphan.status, 200)
      assert.equal(orphan.body.step, undefined)
      assert.equal(orphan.body.event.eventType, 'step_failed')
    })

    it('step_completed is idempotent, and tolerates a missing step or result', async () => {
      const runId = await createRun()
      await createStep(runId)
      await post(runId, { eventType: 'step_started', correlationId: 'step-1' })
      const first = await post(runId, { eventType: 'step_completed', correlationId: 'step-1' })
      assert.equal(first.body.step.status, 'completed')
      assert.equal(first.body.step.output, undefined)
      const second = await post(runId, { eventType: 'step_completed', correlationId: 'step-1' })
      assert.equal(second.body.event, null)

      const orphan = await post(runId, { eventType: 'step_completed', correlationId: 'never-created' })
      assert.equal(orphan.body.step, undefined)
    })

    it('step_retrying parks the step until retryAfter, then the retry bumps the attempt', async () => {
      const runId = await createRun()
      await createStep(runId)
      await post(runId, { eventType: 'step_started', correlationId: 'step-1' })

      const retryAfter = new Date(Date.now() + 60_000).toISOString()
      const retrying = await post(runId, {
        eventType: 'step_retrying',
        correlationId: 'step-1',
        eventData: { error: { message: 'flaky' }, retryAfter },
      })
      assert.equal(retrying.status, 200)
      assert.equal(retrying.body.step.status, 'pending')
      assert.equal(retrying.body.step.retryAfter, retryAfter)

      const tooEarly = await post(runId, { eventType: 'step_started', correlationId: 'step-1' })
      assert.equal(tooEarly.status, 425)
      assert.equal(tooEarly.body.meta.retryAfter, retryAfter)

      await post(runId, { eventType: 'step_retrying', correlationId: 'step-1' })
      const retried = await post(runId, { eventType: 'step_started', correlationId: 'step-1' })
      assert.equal(retried.status, 200)
      assert.equal(retried.body.step.attempt, 2)
      assert.equal(retried.body.step.retryAfter, undefined)
    })

    it('step_retrying tolerates a missing step', async () => {
      const runId = await createRun()
      const res = await post(runId, { eventType: 'step_retrying', correlationId: 'never-created' })
      assert.equal(res.status, 200)
      assert.equal(res.body.step, undefined)
    })

    it('step_started is rejected on a terminal step and deduplicated while running', async () => {
      const runId = await createRun()
      await createStep(runId)
      const started = await post(runId, { eventType: 'step_started', correlationId: 'step-1', eventData: { attempt: 3 } })
      assert.equal(started.body.step.attempt, 3)

      const duplicate = await post(runId, { eventType: 'step_started', correlationId: 'step-1', eventData: { attempt: 3 } })
      assert.equal(duplicate.status, 200)
      assert.equal(duplicate.body.event.eventType, 'step_started')

      // A different attempt while running is a genuine new start.
      const next = await post(runId, { eventType: 'step_started', correlationId: 'step-1', eventData: { attempt: 4 } })
      assert.equal(next.body.step.attempt, 4)

      await post(runId, { eventType: 'step_completed', correlationId: 'step-1' })
      const terminal = await post(runId, { eventType: 'step_started', correlationId: 'step-1' })
      assert.equal(terminal.status, 409)
    })

    it('a running step with no start event on record reports a null event', async () => {
      const runId = await createRun()
      await createStep(runId)
      await post(runId, { eventType: 'step_started', correlationId: 'step-1' })
      await ctx.app.pg.query("DELETE FROM workflow_events WHERE run_id = $1 AND event_type = 'step_started'", [runId])
      const res = await post(runId, { eventType: 'step_started', correlationId: 'step-1' })
      assert.equal(res.status, 200)
      assert.equal(res.body.event, null)
      assert.equal(res.body.step.status, 'running')
    })

    it('step_started without a step or input only records the event', async () => {
      const runId = await createRun()
      const res = await post(runId, { eventType: 'step_started', correlationId: 'never-created' })
      assert.equal(res.status, 200)
      assert.equal(res.body.step, undefined)
    })

    it('a lazy step_started creates and claims the step, and the loser gets 409', async () => {
      const runId = await createRun()
      const payload = { eventType: 'step_started', correlationId: 'lazy-1', eventData: { stepName: 'lazy', input: { n: 1 } } }
      const winner = await post(runId, payload)
      assert.equal(winner.status, 200)
      assert.equal(winner.body.step.status, 'running')
      assert.equal(winner.body.step.attempt, 1)

      // A retry finds the running step and is deduplicated rather than re-claimed.
      const again = await post(runId, payload)
      assert.equal(again.status, 200)

      // A concurrent claimer that did not see the row yet loses the insert.
      const racing = await ctx.app.pg.connect()
      try {
        await racing.query('BEGIN')
        await racing.query(
          `INSERT INTO workflow_steps (id, run_id, application_id, correlation_id, step_name, status)
           VALUES ($1, $2, $3, 'lazy-2', 'lazy', 'running')`,
          [randomUUID(), runId, applicationId]
        )
        const loser = post(runId, { ...payload, correlationId: 'lazy-2' })
        // The loser blocks on the uncommitted row; committing resolves it as a conflict.
        await sleep(200)
        await racing.query('COMMIT')
        const res = await loser
        assert.equal(res.status, 409)
        assert.match(res.body.message, /already claimed/)
      } finally {
        racing.release()
      }
    })
  })

  describe('hooks and waits', () => {
    it('hook_created retried by the same run returns the existing hook', async () => {
      const runId = await createRun()
      const token = randomUUID()
      const payload = {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        eventData: { token, ownerId: 'o', projectId: 'p', environment: 'e', metadata: { a: 1 }, isWebhook: true },
      }
      const first = await post(runId, payload)
      assert.equal(first.body.hook.isWebhook, true)
      assert.deepEqual(first.body.hook.metadata, { a: 1 })
      assert.equal(first.body.hook.ownerId, 'o')

      const retry = await post(runId, payload)
      assert.equal(retry.status, 200)
      assert.equal(retry.body.hook.hookId, 'hook-1')
      assert.equal(retry.body.event.eventType, 'hook_created')
    })

    it('hook_received and hook_disposed update the hook, or just log without one', async () => {
      const runId = await createRun()
      await post(runId, { eventType: 'hook_created', correlationId: 'hook-1', eventData: { token: randomUUID() } })

      const received = await post(runId, { eventType: 'hook_received', correlationId: 'hook-1', eventData: { payload: { x: 1 } } })
      assert.equal(received.body.hook.status, 'received')
      assert.ok(received.body.hook.receivedAt)

      const disposed = await post(runId, { eventType: 'hook_disposed', correlationId: 'hook-1' })
      assert.equal(disposed.body.hook.status, 'disposed')
      assert.ok(disposed.body.hook.disposedAt)

      for (const eventType of ['hook_received', 'hook_disposed']) {
        const unknown = await post(runId, { eventType, correlationId: 'never-created' })
        assert.equal(unknown.status, 200)
        assert.equal(unknown.body.hook, undefined)
        const uncorrelated = await post(runId, { eventType })
        assert.equal(uncorrelated.status, 200)
        assert.equal(uncorrelated.body.hook, undefined)
      }
    })

    it('wait_created is idempotent and wait_completed tolerates a missing wait', async () => {
      const runId = await createRun()
      const resumeAt = new Date(Date.now() + 60_000).toISOString()
      const first = await post(runId, { eventType: 'wait_created', correlationId: 'wait-1', eventData: { resumeAt } })
      assert.equal(first.body.wait.resumeAt, resumeAt)
      const second = await post(runId, { eventType: 'wait_created', correlationId: 'wait-1' })
      assert.equal(second.body.wait.waitId, first.body.wait.waitId)
      assert.equal(second.body.event.eventId, first.body.event.eventId)

      const done = await post(runId, { eventType: 'wait_completed', correlationId: 'wait-1' })
      assert.equal(done.body.wait.status, 'completed')
      const again = await post(runId, { eventType: 'wait_completed', correlationId: 'wait-1' })
      assert.equal(again.body.event, null)

      const orphan = await post(runId, { eventType: 'wait_completed', correlationId: 'never-created' })
      assert.equal(orphan.status, 200)
      assert.equal(orphan.body.wait, undefined)
    })
  })

  describe('data encoding and formatting', () => {
    it('stores binary input unchanged rather than JSON-encoding it', () => {
      const bytes = [0, 255, 16, 32]
      assert.deepEqual(encodeData(new Uint8Array(bytes)), Buffer.from(bytes))
      assert.deepEqual(encodeData(Buffer.from(bytes)), Buffer.from(bytes))
      assert.equal(encodeData(null), null)
      assert.equal(encodeData(undefined), null)
    })

    it('round-trips binary, text, and JSON-looking payloads', async () => {
      const runId = await createRun(2, { input: Buffer.from([1, 2, 3, 4]).toString('base64'), executionContext: { traceId: 't' } })
      const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/apps/${ctx.appId}/runs/${runId}` })
      const run = res.json()
      assert.equal(run.input, 'AQIDBA==')
      assert.deepEqual(run.executionContext, { traceId: 't' })

      // Bytes that merely start like JSON are returned as base64, not parsed.
      await ctx.app.pg.query('UPDATE workflow_runs SET output = $2 WHERE id = $1', [runId, Buffer.from('{not json')])
      const odd = (await ctx.app.inject({ method: 'GET', url: `/api/v1/apps/${ctx.appId}/runs/${runId}` })).json()
      assert.equal(odd.output, Buffer.from('{not json').toString('base64'))
    })

    it('resolveData=none strips payloads from runs, steps and events but keeps attr_set data', async () => {
      const runId = await createRun(4, { input: { big: true } })
      await post(runId, { eventType: 'step_created', correlationId: 'step-1', eventData: { stepName: 'work', input: { n: 1 } } })
      const attr = await post(runId, {
        eventType: 'attr_set',
        specVersion: 4,
        eventData: { writer: { type: 'workflow' }, changes: [{ key: 'k', value: 'v' }] },
      }, '?resolveData=none')
      assert.equal(attr.status, 200)
      assert.equal(attr.body.run.input, undefined)
      assert.deepEqual(attr.body.event.eventData.changes, [{ key: 'k', value: 'v' }])

      const step = await post(runId, { eventType: 'step_started', correlationId: 'step-1' }, '?resolveData=none')
      assert.equal(step.body.step.input, undefined)
      assert.equal(step.body.event.eventData, undefined)
    })
  })

  describe('attribute validation', () => {
    async function attrSet (runId: string, eventData: any, extra: any = {}) {
      return post(runId, { eventType: 'attr_set', specVersion: 4, eventData, ...extra })
    }

    it('rejects malformed initial attributes', async () => {
      const cases: [any, RegExp][] = [
        [['a'], /attributes must be an object/],
        [null, /attributes must be an object/],
        ['text', /attributes must be an object/],
        [{ k: 1 }, /attribute value must be a string/],
        [{ '': 'v' }, /attribute key must not be empty/],
        [{ ['k'.repeat(257)]: 'v' }, /attribute key length exceeds limit/],
        [{ $reserved: 'v' }, /reserved prefix/],
        [{ k: 'v'.repeat(257) }, /attribute value byte length exceeds limit/],
        [Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v'])), /attribute count would exceed limit/],
      ]
      for (const [attributes, message] of cases) {
        const res = await post(`wrun_${randomBytes(8).toString('hex')}`, {
          eventType: 'run_created',
          specVersion: 4,
          eventData: { deploymentId: 'v1', workflowName: 'lifecycle', attributes },
        })
        assert.equal(res.status, 400, JSON.stringify(attributes).slice(0, 40))
        assert.match(res.body.message, message)
      }
    })

    it('allows reserved keys only when asked', async () => {
      const runId = await createRun(4, { attributes: { $system: 'v' }, allowReservedAttributes: true })
      const run = (await ctx.app.inject({ method: 'GET', url: `/api/v1/apps/${ctx.appId}/runs/${runId}` })).json()
      assert.deepEqual(run.attributes, { $system: 'v' })

      const refused = await attrSet(runId, { writer: { type: 'workflow' }, changes: [{ key: '$other', value: 'v' }] })
      assert.equal(refused.status, 400)
      const allowed = await attrSet(runId, { writer: { type: 'workflow' }, allowReservedAttributes: true, changes: [{ key: '$other', value: 'v' }] })
      assert.deepEqual(allowed.body.run.attributes, { $system: 'v', $other: 'v' })
    })

    it('rejects malformed attr_set writers and changes', async () => {
      const runId = await createRun(4)
      const change = [{ key: 'k', value: 'v' }]
      const cases: [any, RegExp][] = [
        [undefined, /changes must be an array/],
        [{ writer: { type: 'workflow' }, changes: 'nope' }, /changes must be an array/],
        [{ writer: { type: 'workflow' }, changes: [] }, /changes must not be empty/],
        [{ changes: change }, /writer must be workflow or step/],
        [{ writer: 'workflow', changes: change }, /writer must be workflow or step/],
        [{ writer: ['workflow'], changes: change }, /writer must be workflow or step/],
        [{ writer: { type: 'robot' }, changes: change }, /writer must be workflow or step/],
        [{ writer: { type: 'workflow', extra: 1 }, changes: change }, /only accepts type/],
        [{ writer: { type: 'step', stepId: 's', attempt: 1, extra: 1 }, changes: change }, /step attribute writer requires/],
        [{ writer: { type: 'step', stepId: 1, attempt: 1 }, changes: change }, /step attribute writer requires/],
        [{ writer: { type: 'step', stepId: '', attempt: 1 }, changes: change }, /step attribute writer requires/],
        [{ writer: { type: 'step', stepId: 's', attempt: 1.5 }, changes: change }, /step attribute writer requires/],
        [{ writer: { type: 'step', stepId: 's', attempt: 0 }, changes: change }, /step attribute writer requires/],
        [{ writer: { type: 'workflow' }, changes: [null] }, /require a string key/],
        [{ writer: { type: 'workflow' }, changes: ['k'] }, /require a string key/],
        [{ writer: { type: 'workflow' }, changes: [['k']] }, /require a string key/],
        [{ writer: { type: 'workflow' }, changes: [{ key: 1, value: 'v' }] }, /require a string key/],
        [{ writer: { type: 'workflow' }, changes: [{ key: 'k', value: 1 }] }, /require a string key/],
        [{ writer: { type: 'workflow' }, changes: [{ key: 'k', value: 'a' }, { key: 'k', value: 'b' }] }, /appears more than once/],
      ]
      for (const [eventData, message] of cases) {
        const res = await attrSet(runId, eventData)
        assert.equal(res.status, 400, JSON.stringify(eventData))
        assert.match(res.body.message, message)
      }
    })

    it('applies step-written changes, deletes with null, and deduplicates by correlation', async () => {
      const runId = await createRun(4, { attributes: { keep: '1', drop: '2' } })
      const eventData = {
        writer: { type: 'step', stepId: 'step-1', attempt: 1 },
        changes: [{ key: 'drop', value: null }, { key: 'added', value: '3' }],
      }
      const first = await attrSet(runId, eventData, { correlationId: 'attr-1' })
      assert.deepEqual(first.body.run.attributes, { keep: '1', added: '3' })

      const duplicate = await attrSet(runId, { ...eventData, changes: [{ key: 'other', value: 'x' }] }, { correlationId: 'attr-1' })
      assert.equal(duplicate.status, 200)
      assert.equal(duplicate.body.event.eventId, first.body.event.eventId)
      assert.deepEqual(duplicate.body.run.attributes, { keep: '1', added: '3' })
    })

    it('rejects attr_set for unknown, pre-spec-4 and terminal runs', async () => {
      const change = { writer: { type: 'workflow' }, changes: [{ key: 'k', value: 'v' }] }
      assert.equal((await attrSet('no-such-run', change)).status, 404)

      const legacy = await createRun(3)
      assert.equal((await attrSet(legacy, change)).status, 400)
      const unversioned = await createRun(undefined)
      assert.equal((await attrSet(unversioned, change)).status, 400)

      const modern = await createRun(4)
      assert.equal((await post(modern, { eventType: 'attr_set', specVersion: 3, eventData: change })).status, 400)
      assert.equal((await post(modern, { eventType: 'attr_set', eventData: change })).status, 400)
      await post(modern, { eventType: 'run_completed' })
      const terminal = await attrSet(modern, change)
      assert.equal(terminal.status, 400)
      assert.match(terminal.body.message, /terminal state: completed/)
    })
  })

  describe('event listing', () => {
    it('ignores a cursor that is neither a slot id nor a serial id', async () => {
      const runId = await createRun()
      for (const cursor of ['garbage', 'evnt_00000000000000000000000000']) {
        const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events?cursor=${cursor}&limit=1` })
        assert.equal(res.statusCode, 200)
        assert.equal(res.json().data[0].eventType, 'run_created')
      }
    })

    it('defaults the correlation listing to ascending with no cursor', async () => {
      const runId = await createRun()
      await post(runId, { eventType: 'hook_received', correlationId: `corr-${runId}`, eventData: { payload: 1 } })
      const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/apps/${ctx.appId}/events/by-correlation?correlationId=corr-${runId}&cursor=garbage` })
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().data.length, 1)
      assert.equal(res.json().hasMore, false)
    })
  })

  describe('failures inside the transaction', () => {
    it('rolls back a single event and reports a 500 without leaking a meta', async () => {
      const runId = await createRun()
      const restore = failQueries(ctx.app.pg, /INSERT INTO workflow_waits/)
      try {
        const res = await post(runId, { eventType: 'wait_created', correlationId: 'wait-1' })
        assert.equal(res.status, 500)
        assert.equal(res.body.error, 'Internal Server Error')
        assert.equal(res.body.meta, undefined)
      } finally {
        restore()
      }
      const events = await ctx.app.pg.query("SELECT id FROM workflow_events WHERE run_id = $1 AND event_type = 'wait_created'", [runId])
      assert.equal(events.rows.length, 0)
    })
  })
})
