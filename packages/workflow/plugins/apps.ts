import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { AppNotFound, AppBindingConflict, Forbidden, BadRequest } from '../lib/errors.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function appsPlugin (app: FastifyInstance): Promise<void> {
  // Create application
  app.post('/api/v1/apps', async (request, reply) => {
    if (!request.isAdmin) throw new Forbidden('admin access required')

    const { appId, iccApplicationId } = request.body as { appId: string, iccApplicationId?: string }
    if (!appId) throw new BadRequest('appId is required')
    if (iccApplicationId !== undefined && !UUID_PATTERN.test(iccApplicationId)) {
      throw new BadRequest('iccApplicationId must be a UUID')
    }

    let result
    try {
      result = await app.pg.query(
        `INSERT INTO workflow_applications (app_id, icc_application_id) VALUES ($1, $2::uuid)
         ON CONFLICT (app_id) DO UPDATE
           SET icc_application_id = COALESCE(workflow_applications.icc_application_id,
                                             EXCLUDED.icc_application_id)
           WHERE workflow_applications.icc_application_id IS NULL
              OR EXCLUDED.icc_application_id IS NULL
              OR workflow_applications.icc_application_id = EXCLUDED.icc_application_id
         RETURNING app_id, icc_application_id, (xmax = 0) AS created`,
        [appId, iccApplicationId || null]
      )
    } catch (error: any) {
      if (error.code === '23505') {
        throw new AppBindingConflict('ICC application ID is already bound to another World application')
      }
      throw error
    }
    if (result.rows.length === 0) {
      throw new AppBindingConflict('World application is already bound to a different ICC application ID')
    }

    reply.code(result.rows[0].created ? 201 : 200)
    return { appId, iccApplicationId: result.rows[0].icc_application_id || undefined }
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
       ON CONFLICT (application_id, namespace, service_account) DO NOTHING`,
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
