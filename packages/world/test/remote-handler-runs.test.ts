import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  createPlatformaticWorld,
  createRemoteHandlerStartOptions,
  REMOTE_HANDLER_DEADLINE_ATTRIBUTE,
} from '../src/index.ts'

const HANDLER_RUN_ID = 'wrun_01K4ZQ7V1A2B3C4D5E6F7G8H9J'

test('reserves a handler run through the app-scoped World client', async () => {
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/api/v1/apps/handler-label/remote-handler-runs/reserve')
    assert.deepEqual(await readJson(request), {
      operationKey: 'operation-1',
      budget: { remaining: 30_000 },
    })
    json(response, 201, { handlerRunId: HANDLER_RUN_ID })
  })
  const serviceUrl = await listen(server)
  const world = createPlatformaticWorld({ serviceUrl, appId: 'handler-label', deploymentVersion: 'v1' })

  try {
    assert.deepEqual(await world.remoteHandlerRuns.reserve({
      operationKey: 'operation-1',
      budget: { remaining: 30_000 },
    }), { handlerRunId: HANDLER_RUN_ID })
  } finally {
    await world.close()
    await close(server)
  }
})

test('lists and idempotently cancels active handler runs through the app-scoped client', async () => {
  let requestNumber = 0
  const deadlineAt = Date.now() + 30_000
  const server = createServer(async (request, response) => {
    requestNumber++
    if (requestNumber === 1) {
      assert.equal(request.method, 'GET')
      assert.equal(request.url, '/api/v1/apps/handler-label/remote-handler-runs/active?cursor=operation-0&limit=1')
      json(response, 200, {
        data: [{ operationKey: 'operation-1', handlerRunId: HANDLER_RUN_ID, deadlineAt }],
        cursor: 'operation-1',
        hasMore: true,
      })
      return
    }
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/api/v1/apps/handler-label/remote-handler-runs/cancel')
    assert.deepEqual(await readJson(request), {
      operationKey: 'operation-1',
      handlerRunId: HANDLER_RUN_ID,
    })
    json(response, 200, { cancelled: requestNumber === 2 })
  })
  const serviceUrl = await listen(server)
  const world = createPlatformaticWorld({ serviceUrl, appId: 'handler-label', deploymentVersion: 'v1' })

  try {
    assert.deepEqual(await world.remoteHandlerRuns.listActive({ cursor: 'operation-0', limit: 1 }), {
      data: [{ operationKey: 'operation-1', handlerRunId: HANDLER_RUN_ID, deadlineAt }],
      cursor: 'operation-1',
      hasMore: true,
    })
    assert.deepEqual(await world.remoteHandlerRuns.cancel({
      operationKey: 'operation-1',
      handlerRunId: HANDLER_RUN_ID,
    }), { cancelled: true })
    assert.deepEqual(await world.remoteHandlerRuns.cancel({
      operationKey: 'operation-1',
      handlerRunId: HANDLER_RUN_ID,
    }), { cancelled: false })
  } finally {
    await world.close()
    await close(server)
  }
})

test('rejects malformed reservations and malformed service replies', async () => {
  const server = createServer((_request, response) => json(response, 200, { handlerRunId: 'not-a-run' }))
  const serviceUrl = await listen(server)
  const world = createPlatformaticWorld({ serviceUrl, appId: 'handler-label', deploymentVersion: 'v1' })

  try {
    await assert.rejects(
      world.remoteHandlerRuns.reserve({ operationKey: '', budget: { remaining: 1_000 } }),
      /operationKey must be a non-empty string/
    )
    await assert.rejects(
      world.remoteHandlerRuns.reserve({ operationKey: 'operation-1', budget: { remaining: 999 } }),
      /between 1000 and 2147483647 milliseconds/
    )
    await assert.rejects(
      world.remoteHandlerRuns.reserve({ operationKey: 'operation-1', budget: { remaining: 2_147_483_648 } }),
      /between 1000 and 2147483647 milliseconds/
    )
    await assert.rejects(
      world.remoteHandlerRuns.reserve({ operationKey: 'operation-1', budget: { remaining: 1_000 } }),
      (error: any) => error.code === 'remote_handler_reservation_invalid'
    )
    await assert.rejects(
      world.remoteHandlerRuns.listActive({ limit: 17 }),
      /limit must be between 1 and 16/
    )
    await assert.rejects(
      world.remoteHandlerRuns.cancel({ operationKey: 'operation-1', handlerRunId: 'not-a-run' }),
      /wrun_ prefixed ULID/
    )
  } finally {
    await world.close()
    await close(server)
  }
})

test('accepts exact handler reservation budget boundaries', async () => {
  const received: unknown[] = []
  const server = createServer(async (request, response) => {
    received.push(await readJson(request))
    json(response, 201, { handlerRunId: HANDLER_RUN_ID })
  })
  const serviceUrl = await listen(server)
  const world = createPlatformaticWorld({ serviceUrl, appId: 'handler-label', deploymentVersion: 'v1' })

  try {
    await world.remoteHandlerRuns.reserve({ operationKey: 'minimum', budget: { remaining: 1_000 } })
    await world.remoteHandlerRuns.reserve({ operationKey: 'maximum', budget: { remaining: 2_147_483_647 } })
    assert.deepEqual(received, [
      { operationKey: 'minimum', budget: { remaining: 1_000 } },
      { operationKey: 'maximum', budget: { remaining: 2_147_483_647 } },
    ])
  } finally {
    await world.close()
    await close(server)
  }
})

test('prepares idempotent start options without changing the underlying World', async () => {
  const queued: any[] = []
  const queueResult = { messageId: 'message-1' }
  const world: any = {
    specVersion: 7,
    events: { create: async () => ({}) },
    queue: async (...args: any[]) => {
      queued.push(args)
      return queueResult
    },
    getDeploymentId: async () => 'v1',
    createRunId: () => 'original',
  }
  const deadlineAt = Date.now() + 30_000
  const prepared = createRemoteHandlerStartOptions(world, {
    operationKey: 'operation-1',
    handlerRunId: HANDLER_RUN_ID,
    deadlineAt,
    attributes: { user: 'kept' },
  })

  assert.notEqual(prepared.world, world)
  assert.equal(world.createRunId(), 'original')
  assert.equal((prepared.world as any).createRunId(), 'original')
  assert.equal((prepared.world as any).createRunId({}), HANDLER_RUN_ID.slice('wrun_'.length))
  assert.deepEqual(prepared.attributes, {
    user: 'kept',
    [REMOTE_HANDLER_DEADLINE_ATTRIBUTE]: String(deadlineAt),
  })
  assert.equal(prepared.allowReservedAttributes, true)

  const result = await prepared.world.queue('__wkf_workflow_settle' as any, { runId: HANDLER_RUN_ID } as any, {
    deploymentId: 'v1',
    idempotencyKey: 'caller-value-must-not-win',
  } as any)
  assert.equal(result, queueResult)
  assert.deepEqual(queued, [[
    '__wkf_workflow_settle',
    { runId: HANDLER_RUN_ID },
    { deploymentId: 'v1', idempotencyKey: 'remote-handler:operation-1' },
  ]])
})

test('rejects caller-controlled reserved attributes', () => {
  const world: any = {}
  assert.throws(
    () => createRemoteHandlerStartOptions(world, {
      operationKey: 'operation-1',
      handlerRunId: HANDLER_RUN_ID,
      deadlineAt: Date.now() + 30_000,
      attributes: { $rootRunId: 'wrun_attacker_controlled' },
    }),
    /uses reserved prefix "\$"/
  )
})

test('uses the reserved run through the real v5 start path without consuming its key for health checks', async () => {
  const { start } = await import('../../../e2e-v5/node_modules/workflow/dist/api.js')
  const queued: any[] = []
  const created: any[] = []
  const baseWorld: any = {
    specVersion: 7,
    createRunId: () => 'health-correlation',
    getDeploymentId: async () => 'v1',
    events: {
      create: async (...args: any[]) => {
        created.push(args)
        return { run: { runId: args[0], status: 'pending' } }
      },
    },
    queue: async (...args: any[]) => {
      queued.push(args)
      return { messageId: `message-${queued.length}` }
    },
    streams: {
      get: async () => new ReadableStream({
        start (controller) {
          controller.enqueue(new TextEncoder().encode('healthy'))
          controller.close()
        },
      }),
    },
  }
  const prepared = createRemoteHandlerStartOptions(baseWorld, {
    operationKey: 'operation-1',
    handlerRunId: HANDLER_RUN_ID,
    deadlineAt: Date.now() + 30_000,
  })
  const workflow: any = async () => {}
  workflow.workflowId = 'remote-handler-workflow'

  const run = await start(workflow, [], { ...prepared, deploymentId: 'v2' } as any)

  assert.equal(run.runId, HANDLER_RUN_ID)
  assert.equal(created.length, 1)
  assert.equal(created[0][0], HANDLER_RUN_ID)
  assert.equal(queued.length, 2)
  assert.equal(queued[0][1].__healthCheck, true)
  assert.equal(queued[0][2].idempotencyKey, undefined)
  assert.equal(queued[1][1].runId, HANDLER_RUN_ID)
  assert.equal(queued[1][2].idempotencyKey, 'remote-handler:operation-1')
})

test('fails closed through the real v4 start path before creating or enqueueing a random run', async () => {
  const { start } = await import('../../../e2e-v4/node_modules/workflow/dist/api.js')
  let created = 0
  let queued = 0
  const baseWorld: any = {
    specVersion: 7,
    getDeploymentId: async () => 'v1',
    events: {
      create: async () => {
        created++
        return { run: { status: 'pending' } }
      },
    },
    queue: async () => {
      queued++
      return { messageId: 'message-1' }
    },
  }
  const prepared = createRemoteHandlerStartOptions(baseWorld, {
    operationKey: 'operation-1',
    handlerRunId: HANDLER_RUN_ID,
    deadlineAt: Date.now() + 30_000,
  })
  const workflow: any = async () => {}
  workflow.workflowId = 'remote-handler-workflow'

  await assert.rejects(
    start(workflow, [], prepared as any),
    (error: any) => error.code === 'remote_handler_runtime_unsupported'
  )
  assert.equal(created, 0)
  assert.equal(queued, 0)
})

async function readJson (request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json (response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function listen (server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  return `http://127.0.0.1:${address.port}`
}

async function close (server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
