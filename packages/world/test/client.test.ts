import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createPlatformaticWorld } from '../src/index.ts'
import { SERVICE_URL, provisionApp } from './helper.ts'

// These are integration tests requiring a running workflow-service and PostgreSQL.
// To run: docker-compose up -d && node packages/workflow-service/src/server.ts &
// Then: node --test packages/world/test/client.test.ts

describe('PlatformaticWorld client', () => {
  let world: ReturnType<typeof createPlatformaticWorld>
  let appId: string

  before(async () => {
    // Check if service is running
    try {
      const res = await fetch(`${SERVICE_URL}/status`)
      if (!res.ok) throw new Error('Service not running')
    } catch {
      // Skip tests if service isn't running
      console.log('Workflow service not running at', SERVICE_URL, '— skipping integration tests')
      return
    }

    const app = await provisionApp()
    appId = app.appId

    world = createPlatformaticWorld({
      serviceUrl: SERVICE_URL,
      appId,
      deploymentVersion: 'v1.0.0',
    })
  })

  after(async () => {
    if (world) await world.close()
  })

  it('should return the deployment ID', async () => {
    if (!world) return
    const id = await world.getDeploymentId()
    assert.equal(id, 'v1.0.0')
  })

  it('should create a run and retrieve it', async () => {
    if (!world) return

    const result = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: 2,
      eventData: {
        deploymentId: 'v1.0.0',
        workflowName: 'client-test',
        input: { hello: 'world' },
      },
    })

    assert.ok(result.event)
    assert.ok(result.run)
    assert.equal(result.run.status, 'pending')

    // Get the run
    const run = await world.runs.get(result.run.runId)
    assert.equal(run.runId, result.run.runId)
    assert.equal(run.workflowName, 'client-test')
  })

  it('should handle full lifecycle', async () => {
    if (!world) return

    // Create run
    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: 2,
      eventData: { deploymentId: 'v1.0.0', workflowName: 'full-lifecycle', input: { data: 1 } },
    })
    const runId = created.run!.runId

    // Start run
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: 2,
    })

    // Create and complete a step
    await world.events.create(runId, {
      eventType: 'step_created',
      correlationId: 'step-1',
      specVersion: 2,
      eventData: { stepName: 'myStep', input: {} },
    })

    await world.events.create(runId, {
      eventType: 'step_completed',
      correlationId: 'step-1',
      specVersion: 2,
      eventData: { result: { done: true } },
    })

    // Complete run
    await world.events.create(runId, {
      eventType: 'run_completed',
      specVersion: 2,
      eventData: { output: { finished: true } },
    })

    // Verify final state
    const run = await world.runs.get(runId)
    assert.equal(run.status, 'completed')

    // List events
    const events = await world.events.list({ runId })
    assert.ok(events.data.length >= 4)
  })

  it('should queue messages', async () => {
    if (!world) return

    const result = await world.queue('__wkf_workflow_test', { runId: 'test-run' }, {
      deploymentId: 'v1.0.0',
    })

    assert.ok(result.messageId)
  })

  it('should return undefined when no encryption key is provisioned', async () => {
    if (!world) return

    const key = await world.getEncryptionKeyForRun('some-run-id')
    assert.equal(key, undefined)
  })
})
