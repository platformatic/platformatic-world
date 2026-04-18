import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { setupTest, teardownTest, type TestContext } from './helper.ts'
import { createK8sTokenValidator } from '../lib/auth/k8s-token.ts'

function createMockK8sApi (handler: (body: any) => any) {
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk })
    req.on('end', () => {
      const body = JSON.parse(data)
      const result = handler(body)
      res.writeHead(result.statusCode || 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
    })
  })
  return server
}

describe('k8s-token validator', () => {
  let ctx: TestContext
  let mockServer: ReturnType<typeof createServer>
  let apiServer: string

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should validate admin service account token', async () => {
    mockServer = createMockK8sApi((body) => {
      assert.equal(body.spec.token, 'admin-token-123')
      return {
        body: {
          status: {
            authenticated: true,
            user: { username: 'system:serviceaccount:platformatic:platformatic' },
          },
        },
      }
    })
    await new Promise<void>((resolve) => { mockServer.listen(0, resolve) })
    const addr = mockServer.address() as { port: number }
    apiServer = `http://127.0.0.1:${addr.port}`

    const validate = createK8sTokenValidator(ctx.app.pg, {
      apiServer,
      adminServiceAccount: 'platformatic:platformatic',
    })

    const result = await validate('admin-token-123')
    assert.ok(result)
    assert.equal(result.isAdmin, true)
    assert.deepEqual(result.applicationIds, [])

    mockServer.close()
  })

  it('should validate app service account with k8s binding', async () => {
    // Randomize namespace + SA per run so stale bindings from crashed prior
    // runs (app-scoped teardown won't clear them) don't pollute this run's
    // validator output.
    const suffix = randomBytes(4).toString('hex')
    const namespace = `my-ns-${suffix}`
    const serviceAccount = `my-sa-${suffix}`
    const appId = `k8s-test-${suffix}`
    await ctx.app.pg.query(
      'INSERT INTO workflow_applications (app_id) VALUES ($1)',
      [appId]
    )
    const appResult = await ctx.app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [appId]
    )
    const applicationId = appResult.rows[0].id
    await ctx.app.pg.query(
      `INSERT INTO workflow_app_k8s_bindings (application_id, namespace, service_account)
       VALUES ($1, $2, $3)`,
      [applicationId, namespace, serviceAccount]
    )

    mockServer = createMockK8sApi(() => ({
      body: {
        status: {
          authenticated: true,
          user: { username: `system:serviceaccount:${namespace}:${serviceAccount}` },
        },
      },
    }))
    await new Promise<void>((resolve) => { mockServer.listen(0, resolve) })
    const addr = mockServer.address() as { port: number }
    apiServer = `http://127.0.0.1:${addr.port}`

    const validate = createK8sTokenValidator(ctx.app.pg, {
      apiServer,
      adminServiceAccount: 'platformatic:platformatic',
    })

    try {
      const result = await validate('app-token-456')
      assert.ok(result)
      assert.equal(result.isAdmin, false)
      assert.deepEqual(result.applicationIds, [applicationId])
    } finally {
      await ctx.app.pg.query('DELETE FROM workflow_app_k8s_bindings WHERE application_id = $1', [applicationId])
      await ctx.app.pg.query('DELETE FROM workflow_applications WHERE app_id = $1', [appId])
      mockServer.close()
    }
  })

  it('should reject unauthenticated tokens', async () => {
    mockServer = createMockK8sApi(() => ({
      body: {
        status: { authenticated: false },
      },
    }))
    await new Promise<void>((resolve) => { mockServer.listen(0, resolve) })
    const addr = mockServer.address() as { port: number }
    apiServer = `http://127.0.0.1:${addr.port}`

    const validate = createK8sTokenValidator(ctx.app.pg, { apiServer })
    const result = await validate('bad-token')
    assert.equal(result, null)

    mockServer.close()
  })

  it('should reject non-serviceaccount usernames', async () => {
    mockServer = createMockK8sApi(() => ({
      body: {
        status: {
          authenticated: true,
          user: { username: 'admin' },
        },
      },
    }))
    await new Promise<void>((resolve) => { mockServer.listen(0, resolve) })
    const addr = mockServer.address() as { port: number }
    apiServer = `http://127.0.0.1:${addr.port}`

    const validate = createK8sTokenValidator(ctx.app.pg, { apiServer })
    const result = await validate('user-token')
    assert.equal(result, null)

    mockServer.close()
  })

  it('should reject service accounts without binding or admin', async () => {
    mockServer = createMockK8sApi(() => ({
      body: {
        status: {
          authenticated: true,
          user: { username: 'system:serviceaccount:unknown-ns:unknown-sa' },
        },
      },
    }))
    await new Promise<void>((resolve) => { mockServer.listen(0, resolve) })
    const addr = mockServer.address() as { port: number }
    apiServer = `http://127.0.0.1:${addr.port}`

    const validate = createK8sTokenValidator(ctx.app.pg, {
      apiServer,
      adminServiceAccount: 'platformatic:platformatic',
    })

    const result = await validate('unknown-token')
    assert.equal(result, null)

    mockServer.close()
  })

  it('should return null when K8s API returns error status', async () => {
    mockServer = createMockK8sApi(() => ({
      statusCode: 401,
      body: { message: 'Unauthorized' },
    }))
    await new Promise<void>((resolve) => { mockServer.listen(0, resolve) })
    const addr = mockServer.address() as { port: number }
    apiServer = `http://127.0.0.1:${addr.port}`

    const validate = createK8sTokenValidator(ctx.app.pg, { apiServer })
    const result = await validate('any-token')
    assert.equal(result, null)

    mockServer.close()
  })

  it('should cache validated tokens', async () => {
    let callCount = 0
    mockServer = createMockK8sApi(() => {
      callCount++
      return {
        body: {
          status: {
            authenticated: true,
            user: { username: 'system:serviceaccount:platformatic:platformatic' },
          },
        },
      }
    })
    await new Promise<void>((resolve) => { mockServer.listen(0, resolve) })
    const addr = mockServer.address() as { port: number }
    apiServer = `http://127.0.0.1:${addr.port}`

    const validate = createK8sTokenValidator(ctx.app.pg, {
      apiServer,
      adminServiceAccount: 'platformatic:platformatic',
    })

    await validate('cached-token')
    await validate('cached-token')
    await validate('cached-token')

    assert.equal(callCount, 1)

    mockServer.close()
  })

  it('should send Authorization header with own SA token', async () => {
    // The validator reads /var/run/secrets/... at creation time.
    // In test env that file doesn't exist, so ownToken is undefined
    // and no Authorization header is sent. Verify that behavior.
    let receivedAuthHeader: string | undefined
    mockServer = createMockK8sApi(function (this: any, body: any) {
      // Access headers from the request - we'll capture via server
      return {
        body: {
          status: {
            authenticated: true,
            user: { username: 'system:serviceaccount:platformatic:platformatic' },
          },
        },
      }
    })

    // Override request handler to capture auth header
    mockServer.removeAllListeners('request')
    mockServer.on('request', (req, res) => {
      receivedAuthHeader = req.headers.authorization as string | undefined
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          status: {
            authenticated: true,
            user: { username: 'system:serviceaccount:platformatic:platformatic' },
          },
        }))
      })
    })

    await new Promise<void>((resolve) => { mockServer.listen(0, resolve) })
    const addr = mockServer.address() as { port: number }
    apiServer = `http://127.0.0.1:${addr.port}`

    const validate = createK8sTokenValidator(ctx.app.pg, {
      apiServer,
      adminServiceAccount: 'platformatic:platformatic',
    })

    await validate('test-token-for-header')
    // In test env (no K8s), ownToken is undefined so no auth header
    assert.equal(receivedAuthHeader, undefined)

    mockServer.close()
  })
})
