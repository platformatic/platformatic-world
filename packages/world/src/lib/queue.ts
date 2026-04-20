import type { HttpClient } from './client.ts'
import type { MessageId, ValidQueueName, QueuePayload, QueueOptions } from '@workflow/world'
import { SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT } from '@workflow/world'
import { decode } from 'cbor-x'

export interface QueueConfig {
  deploymentVersion: string
}

interface EnqueueEnvelope {
  queueName: ValidQueueName
  message: QueuePayload
  deploymentId?: string
  idempotencyKey?: string
  delaySeconds?: number
}

async function readRequestBody (req: Request): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  const reader = (req.body as unknown as ReadableStream<Uint8Array>).getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export function createQueue (client: HttpClient, config: QueueConfig) {
  const queue = async (queueName: ValidQueueName, message: QueuePayload, opts?: QueueOptions): Promise<{ messageId: MessageId | null }> => {
    const envelope: EnqueueEnvelope = {
      queueName,
      message,
      deploymentId: opts?.deploymentId ?? config.deploymentVersion,
      idempotencyKey: opts?.idempotencyKey,
      delaySeconds: opts?.delaySeconds,
    }

    // Default to CBOR when specVersion is missing: our world declares
    // specVersion = SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT, so every run
    // we handle is already on the CBOR path. Matches world-vercel's default.
    const useCbor = (opts?.specVersion ?? SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT) >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT

    try {
      const result = await client.post('/queue', envelope, undefined, useCbor ? 'cbor' : 'json')
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
      const contentType = req.headers.get('content-type') || ''
      let body: { message: unknown; meta: { queueName: ValidQueueName; messageId: MessageId; attempt: number } }

      if (contentType.includes('application/cbor')) {
        const bytes = await readRequestBody(req)
        // CBOR-first with a JSON fallback lets a v2 client reach a v3 server
        // during rollout without content negotiation.
        try {
          body = decode(bytes) as typeof body
        } catch {
          body = JSON.parse(bytes.toString('utf8')) as typeof body
        }
      } else {
        body = await req.json() as typeof body
      }

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
