import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import autoload from '@fastify/autoload'
import type { FastifyInstance } from 'fastify'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ECS supplies no service account token, so the service runs unauthenticated.
// Tenancy still applies, resolved from the application named in the URL.
describe('multi-tenancy without authentication (ECS)', () => {
  let app: FastifyInstance
  const appA = `ecs-a-${randomBytes(4).toString('hex')}`
  const appB = `ecs-b-${randomBytes(4).toString('hex')}`
  const ids: Record<string, number> = {}
  let savedEcs: string | undefined
  let savedSaPath: string | undefined

  before(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'
    process.env.WF_ENABLE_POLLER = 'false'
    savedEcs = process.env.ECS_CONTAINER_METADATA_URI_V4
    savedSaPath = process.env.PLT_WORLD_SA_PATH
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/test'
    // Point service account discovery at a path that does not exist, so the
    // run looks like ECS even if the suite executes inside a cluster.
    process.env.PLT_WORLD_SA_PATH = join(__dirname, 'no-such-serviceaccount')

    app = Fastify({ logger: false })
    await app.register(autoload, { dir: join(__dirname, '..', 'plugins') })
    await app.ready()

    for (const appId of [appA, appB]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/apps', payload: { appId } })
      assert.ok(res.statusCode === 201 || res.statusCode === 200, `registering ${appId}: ${res.statusCode}`)
      const row = await app.pg.query('SELECT id FROM workflow_applications WHERE app_id = $1', [appId])
      ids[appId] = row.rows[0].id
      await app.pg.query(
        `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [`run-${appId}`, ids[appId], `wf-${appId}`, 'd1', 'completed']
      )
    }
  })

  after(async () => {
    for (const appId of [appA, appB]) {
      if (ids[appId]) {
        await app.pg.query('DELETE FROM workflow_runs WHERE application_id = $1', [ids[appId]])
        await app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [ids[appId]])
      }
    }
    await app.close()
    if (savedEcs === undefined) delete process.env.ECS_CONTAINER_METADATA_URI_V4
    else process.env.ECS_CONTAINER_METADATA_URI_V4 = savedEcs
    if (savedSaPath === undefined) delete process.env.PLT_WORLD_SA_PATH
    else process.env.PLT_WORLD_SA_PATH = savedSaPath
  })

  it('starts multi-tenant with no authentication configured', () => {
    assert.equal(app.authConfig.multiTenant, true)
    assert.equal(app.authConfig.k8s, undefined, 'ECS supplies no identity to verify')
    assert.equal(app.authConfig.defaultAppId, undefined, 'no single implicit tenant')
  })

  it('scopes a request to the application named in the URL', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/apps/${appA}/runs` })
    assert.equal(res.statusCode, 200)
    const runs = res.json().data
    assert.deepEqual(runs.map((r: { runId: string }) => r.runId), [`run-${appA}`])
  })

  it('does not leak runs across tenants', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/apps/${appB}/runs` })
    assert.equal(res.statusCode, 200)
    const runs = res.json().data
    assert.deepEqual(runs.map((r: { runId: string }) => r.runId), [`run-${appB}`])
    assert.ok(!runs.some((r: { runId: string }) => r.runId === `run-${appA}`))
  })

  it('reads a run from its own tenant but not from another', async () => {
    const own = await app.inject({ method: 'GET', url: `/api/v1/apps/${appA}/runs/run-${appA}` })
    assert.equal(own.statusCode, 200)

    const other = await app.inject({ method: 'GET', url: `/api/v1/apps/${appB}/runs/run-${appA}` })
    assert.equal(other.statusCode, 404, "another tenant's run must not be readable")
  })

  it('rejects an application ICC never registered', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/apps/never-registered/runs' })
    // Must fail closed. Previously an unresolved application left appId at 0,
    // so this returned 200 with an empty list and a typo looked like an empty
    // tenant. The shared error handler in events.ts drops `code`, so match on
    // the message instead.
    assert.equal(res.statusCode, 404)
    assert.match(res.json().message, /never-registered/)
  })
})
