import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import autoload from '@fastify/autoload'
import type { FastifyInstance } from 'fastify'
import { createK8sTokenValidator } from '../lib/auth/k8s-token.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ENV_KEYS = ['PLT_WORLD_SA_PATH', 'K8S_API_SERVER', 'K8S_CA_CERT', 'K8S_ADMIN_SERVICE_ACCOUNT', 'ECS_CONTAINER_METADATA_URI_V4', 'ECS_CONTAINER_METADATA_URI']

// Kubernetes supplies a service account token, so the service authenticates
// every request through TokenReview and scopes it to the bound applications.
describe('authentication in Kubernetes', () => {
  const suffix = randomBytes(4).toString('hex')
  const namespace = `ns-${suffix}`
  const appA = `k8s-a-${suffix}`
  const appB = `k8s-b-${suffix}`
  const appC = `k8s-c-${suffix}`
  const saDir = join(tmpdir(), `plt-wf-auth-k8s-${suffix}`)
  const ids: Record<string, number> = {}
  const saved: Record<string, string | undefined> = {}
  const warnings: any[] = []
  let app: FastifyInstance
  let k8sApi: Server

  // TokenReview answers keyed by the token under review.
  const identities: Record<string, string> = {
    admin: `system:serviceaccount:${namespace}:icc`,
    single: `system:serviceaccount:${namespace}:only-a`,
    shared: `system:serviceaccount:${namespace}:a-and-b`,
    unbound: `system:serviceaccount:${namespace}:nobody`
  }

  function request (token: string | null, method: string, url: string, payload?: unknown) {
    const headers: Record<string, string> = {}
    if (token !== null) headers.authorization = `Bearer ${token}`
    return app.inject({ method: method as any, url, headers, payload: payload as any })
  }

  before(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'
    process.env.WF_ENABLE_POLLER = 'false'

    mkdirSync(saDir, { recursive: true })
    writeFileSync(join(saDir, 'token'), 'service-own-token')
    writeFileSync(join(saDir, 'ca.crt'), 'not a real certificate')

    k8sApi = createServer((req, res) => {
      let data = ''
      req.on('data', (chunk: Buffer) => { data += chunk })
      req.on('end', () => {
        const token = JSON.parse(data).spec.token
        if (token === 'outage') {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('apiserver down')
          return
        }
        const username = identities[token]
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          status: username ? { authenticated: true, user: { username } } : { authenticated: false }
        }))
      })
    })
    await new Promise<void>(resolve => k8sApi.listen(0, '127.0.0.1', resolve))
    const { port } = k8sApi.address() as { port: number }

    process.env.PLT_WORLD_SA_PATH = saDir
    process.env.K8S_API_SERVER = `http://127.0.0.1:${port}`
    process.env.K8S_ADMIN_SERVICE_ACCOUNT = `${namespace}:icc`
    delete process.env.K8S_CA_CERT
    delete process.env.ECS_CONTAINER_METADATA_URI_V4
    delete process.env.ECS_CONTAINER_METADATA_URI

    app = Fastify({ logger: false })
    await app.register(autoload, { dir: join(__dirname, '..', 'plugins') })
    await app.ready()
    app.log.warn = ((obj: any) => { warnings.push(obj) }) as any

    for (const appId of [appA, appB, appC]) {
      const created = await request('admin', 'POST', '/api/v1/apps', { appId })
      assert.equal(created.statusCode, 201)
      const row = await app.pg.query('SELECT id FROM workflow_applications WHERE app_id = $1', [appId])
      ids[appId] = row.rows[0].id
      await app.pg.query(
        `INSERT INTO workflow_runs (id, application_id, workflow_name, deployment_id, status)
         VALUES ($1, $2, 'wf', 'd1', 'completed')`,
        [`run-${appId}`, ids[appId]]
      )
    }
    const bindings: [string, string][] = [[appA, 'only-a'], [appA, 'a-and-b'], [appB, 'a-and-b']]
    for (const [appId, serviceAccount] of bindings) {
      const bound = await request('admin', 'POST', `/api/v1/apps/${appId}/k8s-binding`, { namespace, serviceAccount })
      assert.equal(bound.statusCode, 201)
    }
  })

  after(async () => {
    for (const id of Object.values(ids)) {
      await app.pg.query('DELETE FROM workflow_runs WHERE application_id = $1', [id])
      await app.pg.query('DELETE FROM workflow_app_k8s_bindings WHERE application_id = $1', [id])
      await app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [id])
    }
    await app.close()
    await new Promise<void>(resolve => k8sApi.close(() => resolve()))
    rmSync(saDir, { recursive: true, force: true })
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  async function runIds (token: string, appId: string): Promise<string[]> {
    const res = await request(token, 'GET', `/api/v1/apps/${appId}/runs`)
    assert.equal(res.statusCode, 200)
    const out: string[] = []
    for (const run of res.json().data) out.push(run.runId)
    return out
  }

  it('starts multi-tenant with the mounted service account as its identity', () => {
    assert.equal(app.authConfig.multiTenant, true)
    assert.deepEqual(app.authConfig.k8s, {
      apiServer: process.env.K8S_API_SERVER,
      caCert: join(saDir, 'ca.crt'),
      adminServiceAccount: `${namespace}:icc`,
      saTokenPath: join(saDir, 'token')
    })
  })

  it('leaves /status public', async () => {
    const res = await request(null, 'GET', '/status?verbose=1')
    assert.notEqual(res.statusCode, 401)
  })

  it('rejects a missing or non-bearer Authorization header', async () => {
    assert.equal((await request(null, 'GET', `/api/v1/apps/${appA}/runs`)).statusCode, 401)
    const basic = await app.inject({
      method: 'GET',
      url: `/api/v1/apps/${appA}/runs`,
      headers: { authorization: 'Basic dXNlcjpwYXNz' }
    })
    assert.equal(basic.statusCode, 401)
  })

  it('rejects a token the cluster does not recognise', async () => {
    assert.equal((await request('forged', 'GET', `/api/v1/apps/${appA}/runs`)).statusCode, 401)
    // Admin endpoints answer 403 rather than 401 so the caller learns the route exists but is off limits.
    assert.equal((await request('forged', 'GET', '/api/v1/apps')).statusCode, 403)
  })

  it('rejects an authenticated service account with no binding', async () => {
    assert.equal((await request('unbound', 'GET', `/api/v1/apps/${appA}/runs`)).statusCode, 401)
  })

  it('reports a TokenReview outage instead of silently failing every caller', async () => {
    warnings.length = 0
    assert.equal((await request('outage', 'GET', `/api/v1/apps/${appA}/runs`)).statusCode, 401)
    assert.deepEqual(warnings, [{ statusCode: 500, body: 'apiserver down' }])
  })

  it('lets the admin service account reach any application', async () => {
    assert.deepEqual(await runIds('admin', appA), [`run-${appA}`])
    assert.deepEqual(await runIds('admin', appC), [`run-${appC}`])
    assert.equal((await request('admin', 'GET', '/api/v1/apps/never-registered/runs')).statusCode, 404)
  })

  it('scopes a single-binding service account to its application', async () => {
    assert.deepEqual(await runIds('single', appA), [`run-${appA}`])
    assert.equal((await request('single', 'GET', `/api/v1/apps/${appB}/runs`)).statusCode, 403)
    assert.equal((await request('single', 'GET', '/api/v1/apps/never-registered/runs')).statusCode, 403)
    // No application in the URL: the binding alone identifies the tenant.
    assert.equal((await request('single', 'GET', '/no-such-route')).statusCode, 404)
  })

  it('resolves a shared service account from the URL, within its bindings', async () => {
    assert.deepEqual(await runIds('shared', appA), [`run-${appA}`])
    assert.deepEqual(await runIds('shared', appB), [`run-${appB}`])
    assert.equal((await request('shared', 'GET', `/api/v1/apps/${appC}/runs`)).statusCode, 403)
    assert.equal((await request('shared', 'GET', '/api/v1/apps/never-registered/runs')).statusCode, 403)
    assert.equal((await request('shared', 'GET', '/no-such-route')).statusCode, 404)
  })

  it('keeps admin endpoints away from application tokens', async () => {
    assert.equal((await request('single', 'POST', '/api/v1/apps', { appId: 'x' })).statusCode, 403)
    assert.equal((await request('single', 'POST', `/api/v1/apps/${appA}/k8s-binding`, { namespace, serviceAccount: 'x' })).statusCode, 403)
    assert.equal((await request('shared', 'POST', '/api/v1/versions/notify', {})).statusCode, 403)
    assert.equal((await request('single', 'GET', `/api/v1/apps/${appA}/quotas`)).statusCode, 403)
    assert.equal((await request('single', 'PUT', `/api/v1/apps/${appA}/quotas`, { maxRuns: 1 })).statusCode, 403)
    assert.equal((await request('single', 'GET', `/api/v1/apps/${appA}/versions/d1/status`)).statusCode, 403)
    assert.equal((await request('single', 'POST', `/api/v1/apps/${appA}/versions/d1/expire`)).statusCode, 403)
  })
})

describe('Kubernetes auth configuration defaults', () => {
  it('falls back to the in-cluster API server and honours K8S_CA_CERT', async () => {
    const saved: Record<string, string | undefined> = {}
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    const saDir = join(tmpdir(), `plt-wf-auth-k8s-defaults-${randomBytes(4).toString('hex')}`)
    mkdirSync(saDir, { recursive: true })
    writeFileSync(join(saDir, 'token'), 'service-own-token')

    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'
    process.env.WF_ENABLE_POLLER = 'false'
    process.env.PLT_WORLD_SA_PATH = saDir
    process.env.K8S_CA_CERT = join(saDir, 'custom-ca.crt')
    delete process.env.K8S_API_SERVER
    delete process.env.K8S_ADMIN_SERVICE_ACCOUNT

    const app = Fastify({ logger: false })
    try {
      await app.register(autoload, { dir: join(__dirname, '..', 'plugins') })
      await app.ready()
      assert.deepEqual(app.authConfig.k8s, {
        apiServer: 'https://kubernetes.default.svc',
        caCert: join(saDir, 'custom-ca.crt'),
        adminServiceAccount: undefined,
        saTokenPath: join(saDir, 'token')
      })
    } finally {
      await app.close()
      rmSync(saDir, { recursive: true, force: true })
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })

  it('proceeds without a custom CA when the certificate file is unreadable', async () => {
    const k8sApi = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: { authenticated: false } }))
    })
    await new Promise<void>(resolve => k8sApi.listen(0, '127.0.0.1', resolve))
    const { port } = k8sApi.address() as { port: number }
    const pool = { query: async () => ({ rows: [] }) }

    try {
      const validate = createK8sTokenValidator(pool as any, {
        apiServer: `http://127.0.0.1:${port}`,
        caCert: join(tmpdir(), 'plt-wf-no-such-ca.crt'),
        saTokenPath: join(tmpdir(), 'plt-wf-no-such-token')
      })
      assert.equal(await validate('anything'), null)
    } finally {
      await new Promise<void>(resolve => k8sApi.close(() => resolve()))
    }
  })
})
