import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import autoload from '@fastify/autoload'
import type { FastifyInstance } from 'fastify'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE_CONNECTION_STRING = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'

export interface TestContext {
  app: FastifyInstance
  appId: string
}

export async function setupTest (): Promise<TestContext> {
  const appIdStr = `test-app-${randomBytes(4).toString('hex')}`

  process.env.DATABASE_URL = BASE_CONNECTION_STRING
  process.env.PLT_WORLD_APP_ID = appIdStr
  process.env.WF_ENABLE_POLLER = 'false'

  const app = Fastify({ logger: false })
  await app.register(autoload, { dir: join(__dirname, '..', 'plugins') })
  await app.ready()

  return {
    app,
    appId: appIdStr,
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
    await ctx.app.pg.query('DELETE FROM workflow_app_k8s_bindings WHERE application_id = $1', [applicationId])
    await ctx.app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [applicationId])
  }

  await ctx.app.close()
}
