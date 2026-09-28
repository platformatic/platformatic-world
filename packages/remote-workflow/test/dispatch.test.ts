import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import { once } from 'node:events'
import {
  createWorld,
  setRemoteEndpointRegistryProvider,
  type RemoteEndpointSchemas,
} from '@platformatic/world'
import {
  createOperationKey,
  dispatchRemoteOperation,
  validateRemoteBudget,
  type DispatchRuntime,
} from '../src/dispatch.ts'

const ICC_APPLICATION_ID = 'b53f45b5-a463-4d4f-b209-4a64949157b0'
const schemas: RemoteEndpointSchemas = {
  inputSchema: {
    type: 'object',
    required: ['sku'],
    properties: { sku: { type: 'string' } },
  },
  outputSchema: {
    type: 'object',
    required: ['reservationId'],
    properties: { reservationId: { type: 'string' } },
  },
}

async function jsonBody (request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson (response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

afterEach(() => setRemoteEndpointRegistryProvider(undefined))

describe('remote dispatch adapter', () => {
  it('uses the optional-epoch handshake once and replays the frozen World record', async (t) => {
    const requests: any[] = []
    let stored: any
    const server = createServer(async (request, response) => {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/api/v1/apps/caller/runs/run-1/remote-operations')
      const body = await jsonBody(request)
      requests.push(body)

      if (stored) {
        sendJson(response, 200, stored)
      } else if (!body.resolution) {
        sendJson(response, 428, {
          code: 'endpoint_resolution_required',
          message: 'resolution required',
        })
      } else {
        stored = {
          ...body,
          schemaHash: body.resolution.schemaHash,
          epoch: body.resolution.epoch,
          status: 'staged',
        }
        sendJson(response, 201, stored)
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    })

    const address = server.address()
    assert.ok(address && typeof address === 'object')
    let providerCalls = 0
    setRemoteEndpointRegistryProvider(() => {
      providerCalls++
      return {
        iccApplicationId: ICC_APPLICATION_ID,
        resolve: endpoint => endpoint === 'inventory.reserve'
          ? {
              owner: 'inventory',
              schemaHash: 'schema-v1',
              transport: 'pull',
              policy: {},
              epoch: 17,
            }
          : undefined,
        getSchema: hash => hash === 'schema-v1' ? schemas : undefined,
      }
    })

    const runtime: DispatchRuntime = {
      getContext: () => ({
        workflowRunId: 'run-1',
        dispatchStepId: 'step//app/workflows/order//dispatchRemoteOperation',
        ordinal: 'step_01K4DURABLE000000000000001',
      }),
      createWorld: () => createWorld({
        serviceUrl: `http://127.0.0.1:${address.port}`,
        appId: 'caller',
        deploymentVersion: 'test',
      }),
    }

    const expectedKey = createOperationKey(
      'run-1',
      'step//app/workflows/order//dispatchRemoteOperation',
      'inventory.reserve',
      'step_01K4DURABLE000000000000001'
    )
    const first = await dispatchRemoteOperation(
      'inventory.reserve',
      { sku: 'SKU-1' },
      { budget: 30_000 },
      runtime
    )
    assert.deepEqual(first, {
      ok: true,
      operationKey: expectedKey,
      schemaHash: 'schema-v1',
      epoch: 17,
    })
    assert.equal(providerCalls, 1)
    assert.equal(requests.length, 2)
    assert.equal(Object.hasOwn(requests[0], 'epoch'), false)
    assert.equal(Object.hasOwn(requests[0], 'resolution'), false)
    assert.equal(requests[0].budget.remaining, 30_000)
    assert.equal(requests[1].resolution.iccApplicationId, ICC_APPLICATION_ID)

    // Replay must use the immutable record even if the caller registry vanishes.
    setRemoteEndpointRegistryProvider(undefined)
    const replayed = await dispatchRemoteOperation(
      'inventory.reserve',
      { sku: 'SKU-1' },
      { budget: 30_000 },
      runtime
    )
    assert.deepEqual(replayed, first)
    assert.equal(providerCalls, 1)
    assert.equal(requests.length, 3)
    assert.equal(Object.hasOwn(requests[2], 'resolution'), false)
  })

  it('maps deterministic World rejection details and closes the client', async () => {
    let closed = false
    const operationKey = createOperationKey('run', 'step', 'endpoint', 'ordinal')
    const result = await dispatchRemoteOperation('endpoint', null, { budget: 1_000 }, {
      getContext: () => ({
        workflowRunId: 'run',
        dispatchStepId: 'step',
        ordinal: 'ordinal',
      }),
      createWorld: () => ({
        remoteOperations: {
          stage: async () => {
            throw Object.assign(new Error('payload rejected'), {
              code: 'schema_invalid_input',
              statusCode: 422,
            })
          },
          get: async () => undefined,
        },
        close: async () => { closed = true },
      }),
    })
    assert.deepEqual(result, {
      ok: false,
      operationKey,
      code: 'schema_invalid_input',
      message: 'payload rejected',
    })
    assert.equal(closed, true)
  })

  it('rethrows transient transport errors so the durable step can retry', async () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT']) {
      const transportError = Object.assign(new Error(`transport failure: ${code}`), { code })
      await assert.rejects(
        dispatchRemoteOperation('endpoint', null, { budget: 1_000 }, {
          getContext: () => ({
            workflowRunId: 'run',
            dispatchStepId: 'step',
            ordinal: 'ordinal',
          }),
          createWorld: () => ({
            remoteOperations: {
              stage: async () => { throw transportError },
              get: async () => undefined,
            },
            close: async () => {},
          }),
        }),
        error => error === transportError
      )
    }
  })

  it('validates the durable budget range before dispatch', () => {
    assert.doesNotThrow(() => validateRemoteBudget(1_000))
    assert.doesNotThrow(() => validateRemoteBudget(2_147_483_647))
    for (const budget of [999, 2_147_483_648]) {
      assert.throws(
        () => validateRemoteBudget(budget),
        /must be an integer between 1000 and 2147483647 milliseconds/
      )
    }
  })
})
