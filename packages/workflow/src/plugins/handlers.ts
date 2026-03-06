import type { FastifyInstance } from 'fastify'
import { BadRequest } from '../lib/errors.ts'

export default async function handlersPlugin (app: FastifyInstance): Promise<void> {
  // Register pod queue handler endpoints
  app.post('/api/v1/apps/:appId/handlers', async (request, reply) => {
    const appId = request.appId
    const body = request.body as {
      podId: string
      deploymentVersion: string
      endpoints: {
        workflow: string
        step: string
        webhook: string
      }
    }

    if (!body.podId || !body.deploymentVersion || !body.endpoints) {
      throw new BadRequest('podId, deploymentVersion, and endpoints are required')
    }

    await app.pg.query(
      `INSERT INTO workflow_queue_handlers (application_id, pod_id, deployment_version, workflow_url, step_url, webhook_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (application_id, pod_id) DO UPDATE SET
         deployment_version = $3,
         workflow_url = $4,
         step_url = $5,
         webhook_url = $6,
         last_heartbeat = NOW()`,
      [appId, body.podId, body.deploymentVersion,
        body.endpoints.workflow, body.endpoints.step, body.endpoints.webhook]
    )

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
