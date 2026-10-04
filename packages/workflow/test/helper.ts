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

function sqlOf (query: any): string {
  return typeof query === 'string' ? query : query?.text ?? ''
}

// Returning undefined lets the query through; returning anything else answers
// it in place of the database; throwing makes it fail. `run` executes the real
// query, for interceptors that need it to happen before they interfere.
export type QueryInterceptor = (sql: string, params: any[] | undefined, run: () => Promise<any>) => unknown

// Fault injection: route every query on the pool, and on clients checked out
// of it, through `intercept`. Returns a function that restores the pool. Used
// to drive ROLLBACK, error-logging and defensive read-back paths, which a
// healthy database never reaches.
export function interceptQueries (pool: any, intercept: QueryInterceptor): () => void {
  const originalConnect = pool.connect
  const originalQuery = pool.query

  function wrap (target: any, original: any) {
    return async function (query: any, ...rest: any[]) {
      const run = () => original.call(target, query, ...rest)
      const answer = await intercept(sqlOf(query), Array.isArray(rest[0]) ? rest[0] : query?.values, run)
      if (answer !== undefined) return answer
      return run()
    }
  }

  pool.query = wrap(pool, originalQuery)
  pool.connect = async function (callback?: unknown) {
    // pg-pool's own query() checks a client out with a callback: leave that alone.
    if (typeof callback === 'function') return originalConnect.call(pool, callback)
    const client = await originalConnect.call(pool)
    const clientQuery = client.query
    const clientRelease = client.release
    client.query = wrap(client, clientQuery)
    client.release = function (...args: any[]) {
      client.query = clientQuery
      return clientRelease.apply(client, args)
    }
    return client
  }

  return () => {
    pool.connect = originalConnect
    pool.query = originalQuery
  }
}

// Make every query whose SQL matches `pattern` reject.
export function failQueries (pool: any, pattern: RegExp, error: Error = new Error('injected query failure')): () => void {
  return interceptQueries(pool, (sql) => {
    if (pattern.test(sql)) throw error
  })
}
