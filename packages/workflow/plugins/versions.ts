import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { Forbidden, BadRequest } from '../lib/errors.ts'

async function versionsPlugin (app: FastifyInstance): Promise<void> {
  // Version notification — called by ICC
  app.post('/api/v1/versions/notify', async (request) => {
    if (!request.isAdmin) throw new Forbidden('admin access required')

    const body = request.body as {
      applicationId: string
      deploymentVersion: string
      status: 'active' | 'draining' | 'expired'
    }

    if (!body.applicationId || !body.deploymentVersion || !body.status) {
      throw new BadRequest('applicationId, deploymentVersion, and status are required')
    }

    const appResult = await app.pg.query(
      'SELECT id FROM workflow_applications WHERE app_id = $1',
      [body.applicationId]
    )
    if (appResult.rows.length === 0) {
      throw new BadRequest(`application ${body.applicationId} not found`)
    }

    const applicationId = appResult.rows[0].id

    await app.pg.query(
      `INSERT INTO workflow_deployment_versions (application_id, deployment_version, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (application_id, deployment_version) DO UPDATE SET
         status = $3,
         updated_at = NOW()`,
      [applicationId, body.deploymentVersion, body.status]
    )

    return { updated: true }
  })
}

export default fp(versionsPlugin, { name: 'versions', dependencies: ['auth'] })
