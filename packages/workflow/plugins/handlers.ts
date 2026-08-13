import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { BadRequest } from '../lib/errors.ts'

async function handlersPlugin (app: FastifyInstance): Promise<void> {
  // Register machine- or version-service-scoped queue handler endpoints
  app.post('/api/v1/apps/:appId/handlers', async (request, reply) => {
    const appId = request.appId
    const body = request.body as {
      podId?: string
      machineId?: string
      deploymentVersion: string
      serviceScoped?: boolean
      endpoints: {
        workflow: string
        step: string
        webhook: string
      }
    }

    const machineId = body.podId ?? body.machineId
    if (!machineId || !body.deploymentVersion || !body.endpoints) {
      throw new BadRequest('podId (or machineId), deploymentVersion, and endpoints are required')
    }

    const client = await app.pg.connect()
    try {
      await client.query('BEGIN')

      // Registrations for one application are serialized so an old
      // machine-scoped caller cannot race a service-scoped registration and
      // recreate a row after the latter has consolidated the version.
      await client.query(
        'SELECT id FROM workflow_applications WHERE id = $1 FOR UPDATE',
        [appId]
      )

      await client.query(
        `INSERT INTO workflow_queue_handlers
           (application_id, pod_id, deployment_version, workflow_url, step_url, webhook_url, service_scoped)
         SELECT $1::integer, $2::varchar, $3::varchar, $4::varchar,
                $5::varchar, $6::varchar, $7::boolean
         WHERE $7::boolean OR NOT EXISTS (
           SELECT 1 FROM workflow_queue_handlers
           WHERE application_id = $1::integer
             AND deployment_version = $3::varchar
             AND service_scoped
         )
         ON CONFLICT (application_id, pod_id) DO UPDATE SET
           deployment_version = $3::varchar,
           workflow_url = $4::varchar,
           step_url = $5::varchar,
           webhook_url = $6::varchar,
           service_scoped = $7::boolean,
           last_heartbeat = NOW()`,
        [appId, machineId, body.deploymentVersion,
          body.endpoints.workflow, body.endpoints.step, body.endpoints.webhook,
          body.serviceScoped === true]
      )

      if (body.serviceScoped === true) {
        // ICC registers one version-scoped Service endpoint, not a pod/task
        // endpoint. Replace obsolete machine-scoped rows for this version only.
        // Active and expiring versions retain their independent handlers; the
        // expire endpoint is what removes a version's final row.
        await client.query(
          `DELETE FROM workflow_queue_handlers
           WHERE application_id = $1 AND deployment_version = $2 AND pod_id != $3`,
          [appId, body.deploymentVersion, machineId]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    reply.code(201)
    return { registered: true }
  })

  // Deregister pod
  app.delete('/api/v1/apps/:appId/handlers/:podId', async (request) => {
    const { podId } = request.params as { podId: string }
    const appId = request.appId

    await app.pg.query(
      'DELETE FROM workflow_queue_handlers WHERE application_id = $1 AND pod_id = $2',
      [appId, podId]
    )

    return { deregistered: true }
  })
}

export default fp(handlersPlugin, { name: 'handlers', dependencies: ['auth'] })
