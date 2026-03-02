import { randomBytes } from 'node:crypto'
import pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'

const BASE_CONNECTION_STRING = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5433/workflow'
const MASTER_KEY = 'test-master-key-for-testing'

export { MASTER_KEY }

export interface TestContext {
  app: FastifyInstance
  appId: string
  apiKey: string
  masterKey: string
}

export async function setupTest (): Promise<TestContext> {
  const app = await buildApp({
    connectionString: BASE_CONNECTION_STRING,
    auth: {
      mode: 'api-key',
      masterKey: MASTER_KEY,
    },
    enablePoller: false, // Disable poller in tests
  })

  await app.ready()

  // Provision a test application
  const appIdStr = `test-app-${randomBytes(4).toString('hex')}`
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/apps',
    headers: { authorization: `Bearer ${MASTER_KEY}` },
    payload: { appId: appIdStr },
  })

  const body = JSON.parse(response.body)

  return {
    app,
    appId: body.appId,
    apiKey: body.apiKey,
    masterKey: MASTER_KEY,
  }
}

export async function teardownTest (ctx: TestContext): Promise<void> {
  // Clean up test data
  const appResult = await ctx.app.pg.query(
    'SELECT id FROM workflow_applications WHERE app_id = $1',
    [ctx.appId]
  )

  if (appResult.rows.length > 0) {
    const applicationId = appResult.rows[0].id

    // Delete in correct order (foreign keys)
    await ctx.app.pg.query('DELETE FROM workflow_stream_chunks WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_waits WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_hooks WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_steps WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_events WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_queue_messages WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_queue_handlers WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_runs WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_encryption_keys WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_deployment_versions WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_app_keys WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_app_k8s_bindings WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [applicationId])
  }

  await ctx.app.close()
}
