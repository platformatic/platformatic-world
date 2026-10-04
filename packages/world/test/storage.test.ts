import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from '../src/lib/storage.ts'

interface Call {
  method: 'get' | 'post'
  path: string
  query: any
  body?: any
}

function fakeClient (respond: (call: Call) => any) {
  const calls: Call[] = []
  const client = {
    calls,
    async get (path: string, query: any) {
      const call: Call = { method: 'get', path, query }
      calls.push(call)
      return respond(call)
    },
    async post (path: string, body: any, query: any) {
      const call: Call = { method: 'post', path, query, body }
      calls.push(call)
      return respond(call)
    }
  }
  return client
}

function httpError (statusCode: number): Error {
  const err: any = new Error(`HTTP ${statusCode}`)
  err.statusCode = statusCode
  return err
}

const BYTES = new Uint8Array([1, 2, 3, 4])
const BASE64 = 'AQIDBA=='
const ISO = '2026-01-02T03:04:05.000Z'

describe('storage.runs', () => {
  it('get restores dates and binary fields', async () => {
    const client = fakeClient(() => ({
      runId: 'run-1',
      createdAt: ISO,
      input: BASE64,
      output: 'not base64!',
      error: '',
      eventData: { createdAt: ISO, payload: BASE64 }
    }))
    const storage = createStorage(client as any)

    const run = await storage.runs.get('run-1', {
      resolveData: 'all',
      pagination: { limit: 10, cursor: 'c1', sortOrder: 'asc' }
    })

    assert.equal(client.calls[0].path, '/runs/run-1')
    assert.deepEqual(client.calls[0].query, { resolveData: 'all', limit: '10', cursor: 'c1', sortOrder: 'asc' })
    assert.ok(run.createdAt instanceof Date)
    assert.deepEqual(run.input, BYTES)
    assert.equal(run.output, 'not base64!')
    assert.equal(run.error, '')
    assert.ok(run.eventData.createdAt instanceof Date)
    assert.deepEqual(run.eventData.payload, BYTES)
  })

  it('get passes through empty and non-object results', async () => {
    const results: any[] = [null, 'plain']
    const storage = createStorage(fakeClient(() => results.shift()) as any)

    assert.equal(await storage.runs.get('run-1'), null)
    assert.equal(await storage.runs.get('run-1'), 'plain')
  })

  it('get names a 404 WorkflowRunNotFoundError', async () => {
    const storage = createStorage(fakeClient(() => { throw httpError(404) }) as any)

    await assert.rejects(
      storage.runs.get('run-1'),
      (err: any) => err.name === 'WorkflowRunNotFoundError' && err.runId === 'run-1'
    )
  })

  it('get rethrows other failures untouched', async () => {
    const storage = createStorage(fakeClient(() => { throw httpError(500) }) as any)

    await assert.rejects(
      storage.runs.get('run-1'),
      (err: any) => err.name === 'Error' && err.runId === undefined
    )
  })

  it('list forwards filters and restores each entry', async () => {
    const client = fakeClient(() => ({ data: [{ runId: 'run-1', createdAt: ISO }] }))
    const storage = createStorage(client as any)

    const result = await storage.runs.list({ workflowName: 'wf', status: 'running' })

    assert.deepEqual(client.calls[0].query, { workflowName: 'wf', status: 'running' })
    assert.ok(result.data[0].createdAt instanceof Date)
  })

  it('list works without params or data', async () => {
    const client = fakeClient(() => undefined)
    const storage = createStorage(client as any)

    assert.equal(await storage.runs.list(), undefined)
    assert.deepEqual(client.calls[0].query, {})
  })
})

describe('storage.steps', () => {
  it('get falls back to a placeholder run id', async () => {
    const client = fakeClient(() => ({ stepId: 'step-1', startedAt: ISO }))
    const storage = createStorage(client as any)

    const step = await storage.steps.get(undefined, 'step-1')
    await storage.steps.get('run-1', 'step-1')

    assert.equal(client.calls[0].path, '/runs/_/steps/step-1')
    assert.equal(client.calls[1].path, '/runs/run-1/steps/step-1')
    assert.ok(step.startedAt instanceof Date)
  })

  it('list restores each entry', async () => {
    const client = fakeClient(() => ({ data: [{ stepId: 'step-1', completedAt: ISO }] }))
    const storage = createStorage(client as any)

    const result = await storage.steps.list({ runId: 'run-1' })

    assert.equal(client.calls[0].path, '/runs/run-1/steps')
    assert.ok(result.data[0].completedAt instanceof Date)
  })
})

describe('storage.events', () => {
  it('create serializes binary event data and restores every returned entity', async () => {
    const client = fakeClient(() => ({
      event: { eventId: 'e1', createdAt: ISO, eventData: { input: BASE64 } },
      run: { runId: 'run-1', createdAt: ISO },
      step: { stepId: 's1', createdAt: ISO },
      hook: { hookId: 'h1', createdAt: ISO, metadata: BASE64 },
      wait: { waitId: 'w1', resumeAt: ISO },
      events: [{ eventId: 'e0', createdAt: ISO }]
    }))
    const storage = createStorage(client as any)

    const result = await storage.events.create('run-1', {
      eventType: 'step_created',
      eventData: { input: BYTES, stepName: 'first' }
    }, { eventCount: 0 })

    assert.equal(client.calls[0].path, '/runs/run-1/events')
    assert.deepEqual(client.calls[0].query, { eventCount: '0' })
    assert.equal(client.calls[0].body.eventData.input, BASE64)
    assert.equal(client.calls[0].body.eventData.stepName, 'first')
    assert.deepEqual(result.event.eventData.input, BYTES)
    assert.ok(result.run.createdAt instanceof Date)
    assert.ok(result.step.createdAt instanceof Date)
    assert.deepEqual(result.hook.metadata, BYTES)
    assert.ok(result.wait.resumeAt instanceof Date)
    assert.ok(result.events[0].createdAt instanceof Date)
  })

  it('create maps a null run id and tolerates bare payloads', async () => {
    const results: any[] = [undefined, {}]
    const client = fakeClient(() => results.shift())
    const storage = createStorage(client as any)

    assert.equal(await storage.events.create(null, { eventType: 'run_created' }), undefined)
    assert.deepEqual(await storage.events.create('run-1', null), {})

    assert.equal(client.calls[0].path, '/runs/null/events')
    assert.deepEqual(client.calls[0].body, { eventType: 'run_created' })
    assert.equal(client.calls[1].body, null)
  })

  it('createBatch tolerates sparse results', async () => {
    const results: any[] = [{ results: [null, { status: 409 }, { run: { runId: 'run-1', createdAt: ISO } }] }, {}]
    const storage = createStorage(fakeClient(() => results.shift()) as any)
    const events = [{ event: { eventType: 'step_created' } }]

    const first = await storage.events.createBatch('run-1', events)
    assert.ok(first.results[2].run.createdAt instanceof Date)
    assert.deepEqual(await storage.events.createBatch('run-1', events), {})
  })

  it('createBatch rejects a non-array', async () => {
    const storage = createStorage(fakeClient(() => ({})) as any)

    await assert.rejects(
      storage.events.createBatch('run-1', undefined as any),
      (err: any) => err.name === 'WorkflowWorldError'
    )
  })

  it('get, list and listByCorrelationId hit their routes', async () => {
    const client = fakeClient((call) => call.path.endsWith('/e1')
      ? { eventId: 'e1', createdAt: ISO }
      : { data: [{ eventId: 'e1', createdAt: ISO }] })
    const storage = createStorage(client as any)

    const event = await storage.events.get('run-1', 'e1')
    const list = await storage.events.list({ runId: 'run-1' })
    const byCorrelation = await storage.events.listByCorrelationId({ runId: 'run-1', correlationId: 'corr-1' })
    await storage.events.listByCorrelationId({ correlationId: 'corr-1' })

    assert.equal(client.calls[0].path, '/runs/run-1/events/e1')
    assert.equal(client.calls[1].path, '/runs/run-1/events')
    assert.equal(client.calls[2].path, '/events/by-correlation')
    // v5 names the run; a v4 caller does not and gets the application-wide listing.
    assert.deepEqual(client.calls[2].query, { correlationId: 'corr-1', runId: 'run-1' })
    assert.deepEqual(client.calls[3].query, { correlationId: 'corr-1' })
    assert.ok(event.createdAt instanceof Date)
    assert.ok(list.data[0].createdAt instanceof Date)
    assert.ok(byCorrelation.data[0].createdAt instanceof Date)
  })
})

describe('storage.hooks', () => {
  it('get and getByToken restore the hook', async () => {
    const client = fakeClient(() => ({ hookId: 'h1', createdAt: ISO, metadata: BASE64 }))
    const storage = createStorage(client as any)

    const byId = await storage.hooks.get('h1')
    const byToken = await storage.hooks.getByToken('tok')

    assert.equal(client.calls[0].path, '/hooks/h1')
    assert.equal(client.calls[1].path, '/hooks/by-token/tok')
    assert.deepEqual(byId.metadata, BYTES)
    assert.ok(byToken.createdAt instanceof Date)
  })

  it('get and getByToken name a 404 HookNotFoundError', async () => {
    const storage = createStorage(fakeClient(() => { throw httpError(404) }) as any)

    await assert.rejects(
      storage.hooks.get('h1'),
      (err: any) => err.name === 'HookNotFoundError' && err.hookId === 'h1'
    )
    await assert.rejects(
      storage.hooks.getByToken('tok'),
      (err: any) => err.name === 'HookNotFoundError' && err.token === 'tok'
    )
  })

  it('get and getByToken rethrow other failures untouched', async () => {
    const storage = createStorage(fakeClient(() => { throw httpError(503) }) as any)

    await assert.rejects(storage.hooks.get('h1'), (err: any) => err.name === 'Error')
    await assert.rejects(storage.hooks.getByToken('tok'), (err: any) => err.name === 'Error')
  })

  it('list filters by run when asked', async () => {
    const client = fakeClient(() => ({ data: [{ hookId: 'h1', createdAt: ISO }] }))
    const storage = createStorage(client as any)

    const filtered = await storage.hooks.list({ runId: 'run-1' })
    await storage.hooks.list({})

    assert.deepEqual(client.calls[0].query, { runId: 'run-1' })
    assert.deepEqual(client.calls[1].query, {})
    assert.ok(filtered.data[0].createdAt instanceof Date)
  })
})
