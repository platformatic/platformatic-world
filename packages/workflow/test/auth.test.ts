import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { buildApp } from '../src/app.ts'
import type { FastifyInstance } from 'fastify'

const BASE_CONNECTION_STRING = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'

describe('auth', () => {
  let app: FastifyInstance
  let appId: string
  let apiKey: string

  before(async () => {
    app = await buildApp({
      connectionString: BASE_CONNECTION_STRING,
      auth: {
        mode: 'api-key',
      },
      enablePoller: false,
    })
    await app.ready()

    // Provision app directly in DB (no admin API needed)
    appId = `auth-test-${randomBytes(4).toString('hex')}`
    const appResult = await app.pg.query(
      'INSERT INTO workflow_applications (app_id) VALUES ($1) RETURNING id',
      [appId]
    )
    const applicationId = appResult.rows[0].id

    apiKey = `wfk_${randomBytes(32).toString('hex')}`
    const keyHash = createHash('sha256').update(apiKey).digest('hex')
    const keyPrefix = apiKey.slice(0, 12)

    await app.pg.query(
      `INSERT INTO workflow_app_keys (application_id, key_hash, key_prefix)
       VALUES ($1, $2, $3)`,
      [applicationId, keyHash, keyPrefix]
    )
  })

  after(async () => {
    const result = await app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [appId]
    )
    if (result.rows.length > 0) {
      const id = result.rows[0].id
      await app.pg.query('DELETE FROM workflow_app_keys WHERE application_id = $1', [id])
      await app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [id])
    }
    await app.close()
  })

  it('should reject requests without auth header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/apps/${appId}/runs`,
    })
    assert.equal(response.statusCode, 401)
  })

  it('should reject requests with invalid API key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/apps/${appId}/runs`,
      headers: { authorization: 'Bearer invalid-key' },
    })
    assert.equal(response.statusCode, 401)
  })

  it('should accept requests with valid API key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/apps/${appId}/runs`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
    assert.equal(response.statusCode, 200)
  })

  it('should reject app-scoped requests with wrong app ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/apps/nonexistent-app/runs',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    assert.equal(response.statusCode, 403)
  })

  it('should reject admin endpoints with app key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/keys/rotate`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
    assert.equal(response.statusCode, 403)
  })

  it('should allow public paths without auth', async () => {
    const ready = await app.inject({ method: 'GET', url: '/ready' })
    assert.equal(ready.statusCode, 200)

    const status = await app.inject({ method: 'GET', url: '/status' })
    assert.equal(status.statusCode, 200)
  })
})
