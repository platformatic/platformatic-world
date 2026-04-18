import { request as undiciRequest } from 'undici'
import { decode, encode } from 'cbor-x'

export interface DispatchResult {
  success: boolean
  timeoutSeconds?: number
  statusCode: number
}

export interface DispatchInput {
  url: string
  queueName: string
  messageId: number
  payload: unknown
  payloadBytes: Buffer | null
  payloadEncoding: 'json' | 'cbor'
  attempt: number
}

export async function dispatchMessage (input: DispatchInput): Promise<DispatchResult> {
  const meta = {
    queueName: input.queueName,
    messageId: `msg_${input.messageId}`,
    attempt: input.attempt,
  }

  let body: Buffer
  let contentType: string
  if (input.payloadEncoding === 'cbor') {
    const message = decode(input.payloadBytes!)
    body = Buffer.from(encode({ message, meta }))
    contentType = 'application/cbor'
  } else {
    body = Buffer.from(JSON.stringify({ message: input.payload, meta }))
    contentType = 'application/json'
  }

  try {
    const response = await undiciRequest(input.url, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      headersTimeout: 30_000,
      bodyTimeout: 300_000, // 5 minutes for step execution
    })

    const statusCode = response.statusCode

    if (statusCode >= 200 && statusCode < 300) {
      try {
        const parsed = await response.body.json() as { timeoutSeconds?: number }
        return {
          success: true,
          timeoutSeconds: parsed?.timeoutSeconds,
          statusCode,
        }
      } catch {
        await response.body.dump()
        return { success: true, statusCode }
      }
    }

    // 425 = step retryAfter not reached yet — extract the retryAfter and
    // treat as a deferred re-queue instead of a failure (avoids double backoff)
    if (statusCode === 425) {
      let delaySecs = 1
      try {
        const parsed = await response.body.json() as { meta?: { retryAfter?: string } }
        if (parsed?.meta?.retryAfter) {
          const retryAt = new Date(parsed.meta.retryAfter)
          delaySecs = Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000))
        }
      } catch {
        await response.body.dump()
      }
      return { success: true, timeoutSeconds: delaySecs, statusCode }
    }

    await response.body.dump()
    return { success: false, statusCode }
  } catch {
    return { success: false, statusCode: 0 }
  }
}
