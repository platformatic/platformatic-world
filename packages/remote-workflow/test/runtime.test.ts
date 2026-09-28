import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  REMOTE_HANDLER_CLAIM_BATCH_MAX,
  createRemoteHandlerTransport,
  createRemoteHandlerWorker,
  registerRemoteHandlerRuntime,
  validateRemoteHandlerManifest,
  type RemoteHandlerAdapter,
  type RemoteHandlerCommandClient,
  type RemoteHandlerTransport,
} from '../src/runtime.ts'

const manifest = {
  v: 1 as const,
  manifestHash: 'a'.repeat(64),
  handlers: {
    'inventory.reserve': { workflowId: 'workflow//inventory//reserve' },
  },
}

const identity = {
  tenant: '11111111-1111-4111-8111-111111111111',
  service: 'inventory',
  versionLabel: 'v1',
  manifestHash: manifest.manifestHash,
}

function waitFor (predicate: () => boolean, timeout = 2_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() - started >= timeout) return reject(new Error('timed out waiting for test condition'))
      setTimeout(check, 5)
    }
    check()
  })
}

function adapter (calls: { reserve: unknown[], start: unknown[], results: unknown[] }): RemoteHandlerAdapter {
  return {
    async reserve (input) {
      calls.reserve.push(input)
      return { handlerRunId: 'wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV' }
    },
    async start (input) {
      calls.start.push(input)
      return { returnValue: { reservationId: 'r1' }, cancel: async () => {} }
    },
    async result (run) {
      calls.results.push(run)
      return run.returnValue
    },
  }
}

function transport (operations: any[], calls: Record<string, unknown[]>): RemoteHandlerTransport {
  return {
    async announceHandler () { calls.announce.push(identity) },
    async claim (capacity) {
      calls.claim.push(capacity)
      return operations.splice(0, capacity)
    },
    async heartbeat (tokens) { calls.heartbeat.push(tokens) },
    async reportStarted (input) { calls.started.push(input) },
    async reportResult (input) { calls.results.push(input) },
  }
}

async function yieldToEventLoop (delay: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.min(delay, 1)))
}

describe('remote handler manifest', () => {
  it('accepts the private artifact shape and rejects extra fields', () => {
    assert.deepEqual(validateRemoteHandlerManifest(manifest), manifest)
    assert.throws(() => validateRemoteHandlerManifest({ ...manifest, extra: true }), /invalid/)
    assert.throws(() => validateRemoteHandlerManifest({ ...manifest, manifestHash: 'not-a-hash' }), /invalid/)
  })
})

describe('ICC remote handler transport', () => {
  it('wraps handler requests in the authenticated remote envelope', async () => {
    const requests: unknown[] = []
    const client: RemoteHandlerCommandClient = {
      async request (envelope) {
        requests.push(envelope)
        return {
          success: true,
          result: { v: envelope.v, type: envelope.type, tenant: envelope.tenant, body: envelope.type === 'claim' ? { operations: [] } : { runs: [] } },
        }
      },
    }
    const remote = createRemoteHandlerTransport({ tenant: identity.tenant, identity, client, reconciliation: true })

    await remote.announceHandler()
    assert.deepEqual(await remote.claim(REMOTE_HANDLER_CLAIM_BATCH_MAX), [])
    await remote.reconcileHandlerRuns!([{ operationKey: 'op-1', handlerRunId: 'wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV' }])

    assert.equal((requests[0] as any).type, 'announce_handler')
    assert.equal((requests[1] as any).body.capacity, REMOTE_HANDLER_CLAIM_BATCH_MAX)
    assert.equal((requests[2] as any).v, 2)
    assert.equal((requests[2] as any).type, 'reconcile_handler_runs')
  })

  it('rejects malformed claim operations before the worker can execute them', async () => {
    const client: RemoteHandlerCommandClient = {
      async request () {
        return {
          success: true,
          result: {
            v: 1,
            type: 'claim',
            tenant: identity.tenant,
            body: {
              operations: [{
                operationKey: 'op-1',
                endpoint: 'inventory.reserve',
                payload: {},
                payloadRef: 'not-allowed',
                token: 'token-1',
                budget: { remaining: 10_000 },
              }],
            },
          },
        }
      },
    }
    const remote = createRemoteHandlerTransport({ tenant: identity.tenant, identity, client })
    await assert.rejects(remote.claim(1), /exactly one payload form/)
  })
})

describe('remote handler worker', () => {
  it('is a no-op when an application has no remote handler transport', async () => {
    const worker = await registerRemoteHandlerRuntime({})
    await worker.start()
    await worker.close()
  })

  it('claims, starts, and reports a workflow result', async () => {
    const calls: Record<string, unknown[]> = { announce: [], claim: [], heartbeat: [], started: [], results: [] }
    const operations = [{
      operationKey: 'op-1',
      endpoint: 'inventory.reserve',
      payload: { sku: 'ABC' },
      token: 'token-1',
      budget: { remaining: 10_000 },
    }]
    const worker = createRemoteHandlerWorker({
      identity,
      manifest,
      transport: transport(operations, calls),
      adapter: adapter({ reserve: [], start: [], results: [] }),
      wait: yieldToEventLoop,
      heartbeatIntervalMs: 0,
    })

    await worker.start()
    await waitFor(() => calls.results.length === 1)
    await worker.close()

    assert.equal(calls.announce.length, 1)
    assert.deepEqual(calls.started, [{ token: 'token-1', handlerRunId: 'wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV' }])
    assert.deepEqual((calls.results[0] as any).outcome, { ok: true, value: { reservationId: 'r1' } })
  })

  it('caps a claim at the ICC batch maximum', async () => {
    const calls: Record<string, unknown[]> = { announce: [], claim: [], heartbeat: [], started: [], results: [] }
    const worker = createRemoteHandlerWorker({
      identity,
      manifest,
      transport: transport([], calls),
      adapter: adapter({ reserve: [], start: [], results: [] }),
      capacity: REMOTE_HANDLER_CLAIM_BATCH_MAX * 2,
      claimBatchMax: REMOTE_HANDLER_CLAIM_BATCH_MAX * 2,
      wait: yieldToEventLoop,
      heartbeatIntervalMs: 0,
    })
    await worker.start()
    await waitFor(() => calls.claim.length > 0)
    await worker.close()
    assert.equal(calls.claim[0], REMOTE_HANDLER_CLAIM_BATCH_MAX)
  })

  it('reports withdrawn endpoints and payload references without starting them', async () => {
    const calls: Record<string, unknown[]> = { announce: [], claim: [], heartbeat: [], started: [], results: [] }
    const adapterCalls = { reserve: [], start: [], results: [] }
    const operations = [
      { operationKey: 'missing', endpoint: 'missing', payload: {}, token: 'token-1', budget: { remaining: 10_000 } },
      { operationKey: 'reference', endpoint: 'inventory.reserve', payloadRef: 'blob-1', token: 'token-2', budget: { remaining: 10_000 } },
    ]
    const worker = createRemoteHandlerWorker({
      identity,
      manifest,
      transport: transport(operations, calls),
      adapter: adapter(adapterCalls),
      wait: yieldToEventLoop,
      heartbeatIntervalMs: 0,
    })
    await worker.start()
    await waitFor(() => calls.results.length === 2)
    await worker.close()

    assert.deepEqual((calls.results[0] as any).outcome.error.code, 'endpoint_withdrawn')
    assert.deepEqual((calls.results[1] as any).outcome.error.code, 'start_rejected')
    assert.deepEqual(adapterCalls.reserve, [])
  })
})
