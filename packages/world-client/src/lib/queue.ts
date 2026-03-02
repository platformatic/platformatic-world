import type { HttpClient } from './client.ts'

export interface QueueConfig {
  deploymentVersion: string
}

export function createQueue (client: HttpClient, config: QueueConfig) {
  const queue = async (queueName: string, message: unknown, opts?: any): Promise<{ messageId: string | null }> => {
    const result = await client.post('/queue', {
      queueName,
      message,
      deploymentId: opts?.deploymentId ?? config.deploymentVersion,
      idempotencyKey: opts?.idempotencyKey,
      delaySeconds: opts?.delaySeconds,
    })

    return { messageId: result?.messageId ?? null }
  }

  const createQueueHandler = (_prefix: string, handler: (message: unknown, meta: any) => Promise<void | { timeoutSeconds: number }>) => {
    return async (req: Request): Promise<Response> => {
      const body = await req.json() as { message: unknown; meta: { queueName: string; messageId: string; attempt: number } }
      const result = await handler(body.message, body.meta)

      if (typeof result?.timeoutSeconds === 'number') {
        // Re-queue with delay for sleep/wait continuation
        await queue(body.meta.queueName, body.message, {
          deploymentId: config.deploymentVersion,
          delaySeconds: result.timeoutSeconds,
        })
      }

      return Response.json(result ?? {})
    }
  }

  const getDeploymentId = async (): Promise<string> => {
    return config.deploymentVersion
  }

  return { queue, createQueueHandler, getDeploymentId }
}
