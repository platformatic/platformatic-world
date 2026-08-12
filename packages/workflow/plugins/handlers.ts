import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { BadRequest } from '../lib/errors.ts'

async function handlersPlugin (app: FastifyInstance): Promise<void> {
  // Register pod queue handler endpoints
  app.post('/api/v1/apps/:appId/handlers', async (request, reply) => {
    const appId = request.appId
    const body = request.body as {
      podId?: string
      machineId?: string
      deploymentVersion: string
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
      await client.query(
        `INSERT INTO workflow_queue_handlers (application_id, pod_id, deployment_version, workflow_url, step_url, webhook_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (application_id, pod_id) DO UPDATE SET
           deployment_version = $3,
           workflow_url = $4,
           step_url = $5,
           webhook_url = $6,
           last_heartbeat = NOW()`,
        [appId, machineId, body.deploymentVersion,
          body.endpoints.workflow, body.endpoints.step, body.endpoints.webhook]
      )

      // ICC registers a version-scoped Service endpoint, not a pod/task
      // endpoint. Keep exactly that logical handler when an installation moves
      // from the old machine-scoped identity to the stable service identity.
      // Other deployment versions remain independently routable, including
      // while expiring; the expire endpoint is still what removes their row.
      await client.query(
        `DELETE FROM workflow_queue_handlers
         WHERE application_id = $1 AND deployment_version = $2 AND pod_id != $3`,
        [appId, body.deploymentVersion, machineId]
      )
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
