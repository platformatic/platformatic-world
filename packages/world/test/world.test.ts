import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorld, createPlatformaticWorld } from '../src/index.ts'

test('throws when PLT_WORLD_SERVICE_URL is not set', () => {
  const original = process.env.PLT_WORLD_SERVICE_URL
  delete process.env.PLT_WORLD_SERVICE_URL

  try {
    assert.throws(
      () => createWorld(),
      { message: 'PLT_WORLD_SERVICE_URL environment variable is required' }
    )
  } finally {
    if (original) process.env.PLT_WORLD_SERVICE_URL = original
  }
})

test('returns correct shape when options provided', async () => {
  const world = createWorld({
    serviceUrl: 'http://localhost:3042',
    appId: 'test-app',
    deploymentVersion: 'v1',
  })

  assert.equal(typeof world.queue, 'function')
  assert.equal(typeof world.createQueueHandler, 'function')
  assert.equal(typeof world.getDeploymentId, 'function')
  assert.equal(typeof world.close, 'function')
  assert.ok(world.runs)
  assert.ok(world.events)

  const deploymentId = await world.getDeploymentId()
  assert.equal(deploymentId, 'v1')

  await world.close()
})

test('reads from env vars', async () => {
  const originalUrl = process.env.PLT_WORLD_SERVICE_URL
  const originalAppId = process.env.PLT_WORLD_APP_ID
  const originalVersion = process.env.PLT_WORLD_DEPLOYMENT_VERSION

  process.env.PLT_WORLD_SERVICE_URL = 'http://localhost:9999'
  process.env.PLT_WORLD_APP_ID = 'env-app'
  process.env.PLT_WORLD_DEPLOYMENT_VERSION = 'env-v2'

  try {
    const world = createWorld()
    const deploymentId = await world.getDeploymentId()
    assert.equal(deploymentId, 'env-v2')
    await world.close()
  } finally {
    if (originalUrl) process.env.PLT_WORLD_SERVICE_URL = originalUrl
    else delete process.env.PLT_WORLD_SERVICE_URL
    if (originalAppId) process.env.PLT_WORLD_APP_ID = originalAppId
    else delete process.env.PLT_WORLD_APP_ID
    if (originalVersion) process.env.PLT_WORLD_DEPLOYMENT_VERSION = originalVersion
    else delete process.env.PLT_WORLD_DEPLOYMENT_VERSION
  }
})

test('defaults deploymentVersion to local', async () => {
  const originalUrl = process.env.PLT_WORLD_SERVICE_URL
  const originalVersion = process.env.PLT_WORLD_DEPLOYMENT_VERSION

  process.env.PLT_WORLD_SERVICE_URL = 'http://localhost:9999'
  delete process.env.PLT_WORLD_DEPLOYMENT_VERSION

  try {
    const world = createWorld()
    const deploymentId = await world.getDeploymentId()
    assert.equal(deploymentId, 'local')
    await world.close()
  } finally {
    if (originalUrl) process.env.PLT_WORLD_SERVICE_URL = originalUrl
    else delete process.env.PLT_WORLD_SERVICE_URL
    if (originalVersion) process.env.PLT_WORLD_DEPLOYMENT_VERSION = originalVersion
    else delete process.env.PLT_WORLD_DEPLOYMENT_VERSION
  }
})

test('works without optional fields', async () => {
  const world = createWorld({
    serviceUrl: 'http://localhost:9999',
    appId: 'minimal-app',
    deploymentVersion: 'local',
  })
  assert.equal(typeof world.queue, 'function')
  await world.close()
})

test('falls back to local when not in K8s and no env var', async () => {
  const originalUrl = process.env.PLT_WORLD_SERVICE_URL
  const originalVersion = process.env.PLT_WORLD_DEPLOYMENT_VERSION

  process.env.PLT_WORLD_SERVICE_URL = 'http://localhost:9999'
  delete process.env.PLT_WORLD_DEPLOYMENT_VERSION

  try {
    const world = createWorld()
    const deploymentId = await world.getDeploymentId()
    assert.equal(deploymentId, 'local')
    await world.close()
  } finally {
    if (originalUrl) process.env.PLT_WORLD_SERVICE_URL = originalUrl
    else delete process.env.PLT_WORLD_SERVICE_URL
    if (originalVersion) process.env.PLT_WORLD_DEPLOYMENT_VERSION = originalVersion
    else delete process.env.PLT_WORLD_DEPLOYMENT_VERSION
  }
})

test('env var takes precedence over K8s API lookup', async () => {
  const originalUrl = process.env.PLT_WORLD_SERVICE_URL
  const originalVersion = process.env.PLT_WORLD_DEPLOYMENT_VERSION

  process.env.PLT_WORLD_SERVICE_URL = 'http://localhost:9999'
  process.env.PLT_WORLD_DEPLOYMENT_VERSION = 'from-env'

  try {
    const world = createWorld()
    const deploymentId = await world.getDeploymentId()
    assert.equal(deploymentId, 'from-env')
    await world.close()
  } finally {
    if (originalUrl) process.env.PLT_WORLD_SERVICE_URL = originalUrl
    else delete process.env.PLT_WORLD_SERVICE_URL
    if (originalVersion) process.env.PLT_WORLD_DEPLOYMENT_VERSION = originalVersion
    else delete process.env.PLT_WORLD_DEPLOYMENT_VERSION
  }
})

test('start() registers handlers in local dev (not K8s)', async () => {
  let handlerRequest: any = null

  const server = createServer((req, res) => {
    if (req.url?.includes('/handlers') && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk })
      req.on('end', () => {
        handlerRequest = JSON.parse(body)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ registered: true }))
      })
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  await new Promise<void>((resolve) => { server.listen(0, resolve) })
  const port = (server.address() as any).port

  const originalPort = process.env.PORT
  process.env.PORT = String(port)

  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://localhost:${port}`,
      appId: 'test-app',
      deploymentVersion: 'v1',
    })

    await world.start!()

    assert.ok(handlerRequest, 'handler registration request should have been made')
    assert.equal(handlerRequest.deploymentVersion, 'v1')
    assert.ok(handlerRequest.endpoints.workflow.includes('/.well-known/workflow/v1/flow'))
    assert.ok(handlerRequest.endpoints.step.includes('/.well-known/workflow/v1/step'))
    assert.ok(handlerRequest.endpoints.webhook.includes('/.well-known/workflow/v1/webhook'))

    await world.close()
  } finally {
    if (originalPort) process.env.PORT = originalPort
    else delete process.env.PORT
    server.close()
  }
})

test('start() skips handler registration in K8s (ICC handles it)', async () => {
  let handlerCalled = false

  const server = createServer((req, res) => {
    if (req.url?.includes('/handlers')) {
      handlerCalled = true
    }
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ registered: true }))
  })

  await new Promise<void>((resolve) => { server.listen(0, resolve) })
  const port = (server.address() as any).port

  // Create a fake K8s service account directory
  const fakeSaDir = join(tmpdir(), `plt-world-test-sa-${process.pid}`)
  mkdirSync(fakeSaDir, { recursive: true })
  writeFileSync(join(fakeSaDir, 'token'), 'fake-sa-token')

  const originalPort = process.env.PORT
  const originalSaPath = process.env.PLT_WORLD_SA_PATH
  process.env.PORT = String(port)
  process.env.PLT_WORLD_SA_PATH = fakeSaDir

  try {
    const world = createPlatformaticWorld({
      serviceUrl: `http://localhost:${port}`,
      appId: 'test-app',
      deploymentVersion: 'v1',
    })

    await world.start!()

    assert.equal(handlerCalled, false, 'handler registration should NOT be called in K8s')

    await world.close()
  } finally {
    if (originalPort) process.env.PORT = originalPort
    else delete process.env.PORT
    if (originalSaPath) process.env.PLT_WORLD_SA_PATH = originalSaPath
    else delete process.env.PLT_WORLD_SA_PATH
    rmSync(fakeSaDir, { recursive: true, force: true })
    server.close()
  }
})
