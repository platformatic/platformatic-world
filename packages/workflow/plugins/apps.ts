import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { AppNotFound, Forbidden, BadRequest } from '../lib/errors.ts'

async function appsPlugin (app: FastifyInstance): Promise<void> {
  // Create application
  app.post('/api/v1/apps', async (request, reply) => {
    if (!request.isAdmin) throw new Forbidden('admin access required')

    const { appId } = request.body as { appId: string }
    if (!appId) throw new BadRequest('appId is required')

    const result = await app.pg.query(
      `INSERT INTO workflow_applications (app_id) VALUES ($1)
       ON CONFLICT (app_id) DO NOTHING
       RETURNING app_id`,
      [appId]
    )

    reply.code(result.rows.length > 0 ? 201 : 200)
    return { appId }
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

export default fp(appsPlugin, { name: 'apps', dependencies: ['auth'] })
