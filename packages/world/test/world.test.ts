import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorld } from '../src/index.ts'

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

test('apiKey is optional', async () => {
  const originalKey = process.env.PLT_WORLD_API_KEY
  delete process.env.PLT_WORLD_API_KEY

  try {
    const world = createWorld({
      serviceUrl: 'http://localhost:9999',
      appId: 'no-key-app',
      deploymentVersion: 'local',
    })
    assert.equal(typeof world.queue, 'function')
    await world.close()
  } finally {
    if (originalKey) process.env.PLT_WORLD_API_KEY = originalKey
  }
})
