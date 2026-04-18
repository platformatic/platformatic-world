import type { HttpClient } from './client.ts'
import type { MessageId, ValidQueueName, QueuePayload, QueueOptions } from '@workflow/world'
import { SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT } from '@workflow/world'
import { CborTransport, DualTransport, JsonTransport, drainStream, type Transport } from './transport.ts'

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

const cborTransport = new CborTransport()
const jsonTransport = new JsonTransport()
const dualTransport = new DualTransport()

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
    const transport: Transport = useCbor ? cborTransport : jsonTransport

    try {
      const result = useCbor
        ? await client.postRaw('/queue', transport.serialize(envelope), transport.contentType)
        : await client.post('/queue', envelope)

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
        const bytes = await drainStream(req.body as unknown as ReadableStream<Uint8Array>)
        body = dualTransport.deserialize(bytes) as typeof body
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
