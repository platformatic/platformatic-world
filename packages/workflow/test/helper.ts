import { randomBytes, createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'

const BASE_CONNECTION_STRING = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'

export interface TestContext {
  app: FastifyInstance
  appId: string
  apiKey: string
}

export async function setupTest (): Promise<TestContext> {
  const appIdStr = `test-app-${randomBytes(4).toString('hex')}`

  const app = await buildApp({
    connectionString: BASE_CONNECTION_STRING,
    singleTenant: true,
    defaultAppId: appIdStr,
    enablePoller: false,
  })

  await app.ready()

  // Get the auto-provisioned app's numeric ID
  const appResult = await app.pg.query(
    'SELECT id FROM workflow_applications WHERE app_id = $1',
    [appIdStr]
  )
  const applicationId = appResult.rows[0].id

  // Create an API key for tests that need one
  const apiKey = `wfk_${randomBytes(32).toString('hex')}`
  const keyHash = createHash('sha256').update(apiKey).digest('hex')
  const keyPrefix = apiKey.slice(0, 12)

  await app.pg.query(
    `INSERT INTO workflow_app_keys (application_id, key_hash, key_prefix)
     VALUES ($1, $2, $3)`,
    [applicationId, keyHash, keyPrefix]
  )

  return {
    app,
    appId: appIdStr,
    apiKey,
  }
}

export async function teardownTest (ctx: TestContext): Promise<void> {
  const appResult = await ctx.app.pg.query(
    'SELECT id FROM workflow_applications WHERE app_id = $1',
    [ctx.appId]
  )

  if (appResult.rows.length > 0) {
    const applicationId = appResult.rows[0].id

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
    await ctx.app.pg.query('DELETE FROM workflow_app_quotas WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_app_keys WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_app_k8s_bindings WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [applicationId])
  }

  await ctx.app.close()
}
