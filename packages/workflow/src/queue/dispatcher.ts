import { request as undiciRequest } from 'undici'

export interface DispatchResult {
  success: boolean
  timeoutSeconds?: number
  statusCode: number
}

export async function dispatchMessage (
  url: string,
  queueName: string,
  messageId: number,
  message: unknown,
  attempt: number
): Promise<DispatchResult> {
  try {
    const response = await undiciRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        meta: {
          queueName,
          messageId: `msg_${messageId}`,
          attempt,
        },
      }),
      headersTimeout: 30_000,
      bodyTimeout: 300_000, // 5 minutes for step execution
    })

    const statusCode = response.statusCode

    if (statusCode >= 200 && statusCode < 300) {
      try {
        const body = await response.body.json() as { timeoutSeconds?: number }
        return {
          success: true,
          timeoutSeconds: body?.timeoutSeconds,
          statusCode,
        }
      } catch {
        await response.body.dump()
        return { success: true, statusCode }
      }
    }

    await response.body.dump()
    return { success: false, statusCode }
  } catch {
    return { success: false, statusCode: 0 }
  }
}
