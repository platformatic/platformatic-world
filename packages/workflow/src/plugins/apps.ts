import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { hashApiKey } from '../lib/auth/api-key.ts'
import { AppNotFound, Forbidden, BadRequest } from '../lib/errors.ts'

export default async function appsPlugin (app: FastifyInstance): Promise<void> {
  // Create application + issue first API key
  app.post('/api/v1/apps', async (request, reply) => {
    if (!request.isAdmin) throw new Forbidden('admin access required')

    const { appId } = request.body as { appId: string }
    if (!appId) throw new BadRequest('appId is required')

    const apiKey = `wfk_${randomBytes(32).toString('hex')}`
    const keyHash = hashApiKey(apiKey)
    const keyPrefix = apiKey.slice(0, 12)

    const client = await app.pg.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        'INSERT INTO workflow_applications (app_id) VALUES ($1) RETURNING id',
        [appId]
      )
      const applicationId = result.rows[0].id
      await client.query(
        `INSERT INTO workflow_app_keys (application_id, key_hash, key_prefix)
         VALUES ($1, $2, $3)`,
        [applicationId, keyHash, keyPrefix]
      )
      await client.query('COMMIT')

      reply.code(201)
      return { appId, apiKey }
    } catch (err: any) {
      await client.query('ROLLBACK')
      if (err.code === '23505') {
        throw new BadRequest(`application ${appId} already exists`)
      }
      throw err
    } finally {
      client.release()
    }
  })

  // Rotate API key
  app.post('/api/v1/apps/:appId/keys/rotate', async (request) => {
    if (!request.isAdmin) throw new Forbidden('admin access required')

    const { appId } = request.params as { appId: string }

    const appResult = await app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [appId]
    )
    if (appResult.rows.length === 0) throw new AppNotFound(appId)
    const applicationId = appResult.rows[0].id

    const newKey = `wfk_${randomBytes(32).toString('hex')}`
    const keyHash = hashApiKey(newKey)
    const keyPrefix = newKey.slice(0, 12)

    const client = await app.pg.connect()
    try {
      await client.query('BEGIN')
      // Revoke all existing keys
      await client.query(
        `UPDATE workflow_app_keys SET revoked_at = NOW()
         WHERE application_id = $1 AND revoked_at IS NULL`,
        [applicationId]
      )
      // Issue new key
      await client.query(
        `INSERT INTO workflow_app_keys (application_id, key_hash, key_prefix)
         VALUES ($1, $2, $3)`,
        [applicationId, keyHash, keyPrefix]
      )
      await client.query('COMMIT')

      return { appId, apiKey: newKey }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // Create K8s binding
  app.post('/api/v1/apps/:appId/k8s-binding', async (request, reply) => {
    if (!request.isAdmin) throw new Forbidden('admin access required')

    const { appId } = request.params as { appId: string }
    const { namespace, serviceAccount } = request.body as { namespace: string; serviceAccount: string }

    if (!namespace || !serviceAccount) {
      throw new BadRequest('namespace and serviceAccount are required')
    }

    const appResult = await app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [appId]
    )
    if (appResult.rows.length === 0) throw new AppNotFound(appId)

    await app.pg.query(
      `INSERT INTO workflow_app_k8s_bindings (application_id, namespace, service_account)
       VALUES ($1, $2, $3)
       ON CONFLICT (namespace, service_account) DO UPDATE SET application_id = $1`,
      [appResult.rows[0].id, namespace, serviceAccount]
    )

    reply.code(201)
    return { appId, namespace, serviceAccount }
  })

  // Delete K8s binding
  app.delete('/api/v1/apps/:appId/k8s-binding', async (request) => {
    if (!request.isAdmin) throw new Forbidden('admin access required')

    const { appId } = request.params as { appId: string }
    const { namespace, serviceAccount } = request.body as { namespace: string; serviceAccount: string }

    const appResult = await app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [appId]
    )
    if (appResult.rows.length === 0) throw new AppNotFound(appId)

    await app.pg.query(
      `DELETE FROM workflow_app_k8s_bindings
       WHERE application_id = $1 AND namespace = $2 AND service_account = $3`,
      [appResult.rows[0].id, namespace, serviceAccount]
    )

    return { deleted: true }
  })
}
