import type { HttpClient } from './client.ts'
import type { MessageId, ValidQueueName, QueuePayload, QueueOptions } from '@workflow/world'

export interface QueueConfig {
  deploymentVersion: string
}

export function createQueue (client: HttpClient, config: QueueConfig) {
  const queue = async (queueName: ValidQueueName, message: QueuePayload, opts?: QueueOptions): Promise<{ messageId: MessageId | null }> => {
    try {
      const result = await client.post('/queue', {
        queueName,
        message,
        deploymentId: opts?.deploymentId ?? config.deploymentVersion,
        idempotencyKey: opts?.idempotencyKey,
        delaySeconds: opts?.delaySeconds,
      })

      return { messageId: (result?.messageId ?? null) as MessageId | null }
    } catch (err: any) {
      // 409 = duplicate idempotency key, treat as success (message already processed)
      if (err.statusCode === 409) {
        return { messageId: null }
      }
      throw err
    }
  }

  const createQueueHandler = (_prefix: string, handler: (message: unknown, meta: { attempt: number; queueName: ValidQueueName; messageId: MessageId }) => Promise<void | { timeoutSeconds: number }>) => {
    return async (req: Request): Promise<Response> => {
      const body = await req.json() as { message: unknown; meta: { queueName: ValidQueueName; messageId: MessageId; attempt: number } }
      const result = await handler(body.message, body.meta)

      // The queue service handles re-queuing based on the timeoutSeconds in the response.
      // Do not re-queue here to avoid creating duplicate deferred messages.
      return Response.json(result ?? {})
    }
  }

  const getDeploymentId = async (): Promise<string> => {
    return config.deploymentVersion
  }

  return { queue, createQueueHandler, getDeploymentId }
}
