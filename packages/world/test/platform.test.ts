import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isRunningInK8s, isRunningInEcs, isManagedPlatform } from '../src/lib/platform.ts'
import { createWorld } from '../src/index.ts'

const ECS_VARS = ['ECS_CONTAINER_METADATA_URI_V4', 'ECS_CONTAINER_METADATA_URI']

function withEnv (vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(restore)
}

// Nothing is mounted or set in the test process, so this is the standalone case.
const NOT_ECS = Object.fromEntries(ECS_VARS.map(v => [v, undefined]))

test('standalone is neither K8s nor ECS, and is not managed', async () => {
  await withEnv({ PLT_WORLD_SA_PATH: join(tmpdir(), 'plt-world-absent'), ...NOT_ECS }, () => {
    assert.equal(isRunningInK8s(), false)
    assert.equal(isRunningInEcs(), false)
    assert.equal(isManagedPlatform(), false)
  })
})

test('ECS is detected from the task metadata endpoint', async () => {
  await withEnv({
    PLT_WORLD_SA_PATH: join(tmpdir(), 'plt-world-absent'),
    ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/abc',
    ECS_CONTAINER_METADATA_URI: undefined,
  }, () => {
    assert.equal(isRunningInEcs(), true)
    assert.equal(isRunningInK8s(), false, 'ECS supplies no service account identity')
    assert.equal(isManagedPlatform(), true)
  })
})

test('the older v3 metadata variable is also honoured', async () => {
  await withEnv({
    PLT_WORLD_SA_PATH: join(tmpdir(), 'plt-world-absent'),
    ECS_CONTAINER_METADATA_URI_V4: undefined,
    ECS_CONTAINER_METADATA_URI: 'http://169.254.170.2/v3/abc',
  }, () => {
    assert.equal(isRunningInEcs(), true)
    assert.equal(isManagedPlatform(), true)
  })
})

test('K8s is managed and additionally supplies an identity', async () => {
  const saDir = join(tmpdir(), `plt-world-platform-k8s-${process.pid}`)
  mkdirSync(saDir, { recursive: true })
  writeFileSync(join(saDir, 'token'), 'sa-token')
  try {
    await withEnv({ PLT_WORLD_SA_PATH: saDir, ...NOT_ECS }, () => {
      assert.equal(isRunningInK8s(), true)
      assert.equal(isManagedPlatform(), true)
    })
  } finally {
    rmSync(saDir, { recursive: true, force: true })
  }
})

test('on ECS an explicit application ID is required', async () => {
  await withEnv({
    PLT_WORLD_SA_PATH: join(tmpdir(), 'plt-world-absent'),
    ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/abc',
    ECS_CONTAINER_METADATA_URI: undefined,
    PLT_WORLD_SERVICE_URL: 'http://localhost:9999',
    PLT_WORLD_APP_ID: undefined,
  }, async () => {
    assert.throws(
      () => createWorld(),
      { message: 'World application ID is required on a managed platform; set options.appId or PLT_WORLD_APP_ID' }
    )
    const world = createWorld({ appId: 'explicit-app' })
    await world.close()
  })
})

test('on ECS start() does not self-register handlers', async () => {
  let handlerCalled = false
  const server = createServer((req, res) => {
    if (req.url?.includes('/handlers')) handlerCalled = true
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ registered: true }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }

  try {
    await withEnv({
      PLT_WORLD_SA_PATH: join(tmpdir(), 'plt-world-absent'),
      ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/abc',
      ECS_CONTAINER_METADATA_URI: undefined,
      PLT_WORLD_SERVICE_URL: `http://127.0.0.1:${port}`,
      PLT_WORLD_APP_ID: 'ecs-app',
      PORT: String(port),
    }, async () => {
      const world = createWorld()
      await world.start()
      await world.close()
      assert.equal(handlerCalled, false, 'ICC registers handlers on a managed platform')
    })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
