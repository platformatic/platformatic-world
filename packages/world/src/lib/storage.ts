import type { HttpClient } from './client.ts'

function buildQuery (params: any): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {}
  if (params?.resolveData) query.resolveData = params.resolveData
  if (params?.pagination?.limit) query.limit = String(params.pagination.limit)
  if (params?.pagination?.cursor) query.cursor = params.pagination.cursor
  if (params?.pagination?.sortOrder) query.sortOrder = params.pagination.sortOrder
  return query
}

// Uint8Array is lost through JSON serialization, so we base64-encode before HTTP
// and restore on the way back. The workflow service's encodeData/decodeData handles base64.
const SERIALIZED_DATA_FIELDS = ['input', 'output', 'result', 'payload', 'metadata']

function serializeForHttp (data: any): any {
  if (!data || typeof data !== 'object') return data
  const copy = { ...data }
  if (copy.eventData && typeof copy.eventData === 'object') {
    copy.eventData = { ...copy.eventData }
    for (const field of SERIALIZED_DATA_FIELDS) {
      if (copy.eventData[field] instanceof Uint8Array) {
        copy.eventData[field] = Buffer.from(copy.eventData[field]).toString('base64')
      }
    }
  }
  return copy
}

function tryRestoreBase64 (value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value
  try {
    const buf = Buffer.from(value, 'base64')
    if (buf.length > 0 && buf.toString('base64') === value) {
      return new Uint8Array(buf)
    }
  } catch {
    // Not base64
  }
  return value
}

function restoreUint8Arrays (obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  for (const field of SERIALIZED_DATA_FIELDS) {
    obj[field] = tryRestoreBase64(obj[field])
  }
  // Also restore inside eventData (for event objects)
  if (obj.eventData && typeof obj.eventData === 'object') {
    for (const field of SERIALIZED_DATA_FIELDS) {
      obj.eventData[field] = tryRestoreBase64(obj.eventData[field])
    }
  }
  return obj
}

function coerceDates (obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  for (const key of ['createdAt', 'updatedAt', 'startedAt', 'completedAt', 'expiredAt', 'resumeAt', 'retryAfter']) {
    if (typeof obj[key] === 'string') obj[key] = new Date(obj[key])
  }
  return obj
}

function restoreEntity (obj: any): any {
  if (!obj) return obj
  coerceDates(obj)
  restoreUint8Arrays(obj)
  return obj
}

function coerceResponseDates (result: any): any {
  if (result?.data) {
    result.data = result.data.map(restoreEntity)
  }
  return result
}

export function createStorage (client: HttpClient) {
  return {
    runs: {
      get: (async (id: string, params?: any) => {
        const result = await client.get(`/runs/${id}`, buildQuery(params))
        return restoreEntity(result)
      }) as any,

      list: (async (params?: any) => {
        const query = buildQuery(params)
        if (params?.workflowName) query.workflowName = params.workflowName
        if (params?.status) query.status = params.status
        const result = await client.get('/runs', query)
        return coerceResponseDates(result)
      }) as any,
    },

    steps: {
      get: (async (_runId: string | undefined, stepId: string, params?: any) => {
        const runId = _runId || '_'
        const result = await client.get(`/runs/${runId}/steps/${stepId}`, buildQuery(params))
        return restoreEntity(result)
      }) as any,

      list: (async (params: any) => {
        const result = await client.get(`/runs/${params.runId}/steps`, buildQuery(params))
        return coerceResponseDates(result)
      }) as any,
    },

    events: {
      create: async (runId: string | null, data: any, params?: any) => {
        const runIdPath = runId === null ? 'null' : runId
        const query = buildQuery(params)
        const serialized = serializeForHttp(data)
        const result = await client.post(`/runs/${runIdPath}/events`, serialized, query)
        if (result?.event) restoreEntity(result.event)
        if (result?.run) restoreEntity(result.run)
        if (result?.step) restoreEntity(result.step)
        if (result?.hook) restoreEntity(result.hook)
        if (result?.wait) restoreEntity(result.wait)
        return result
      },

      list: async (params: any) => {
        const result = await client.get(`/runs/${params.runId}/events`, buildQuery(params))
        return coerceResponseDates(result)
      },

      listByCorrelationId: async (params: any) => {
        const query = buildQuery(params)
        query.correlationId = params.correlationId
        const result = await client.get('/events/by-correlation', query)
        return coerceResponseDates(result)
      },
    },

    hooks: {
      get: async (hookId: string, params?: any) => {
        const result = await client.get(`/hooks/${hookId}`, buildQuery(params))
        return coerceDates(result)
      },

      getByToken: async (token: string, params?: any) => {
        const result = await client.get(`/hooks/by-token/${token}`, buildQuery(params))
        return coerceDates(result)
      },

      list: async (params: any) => {
        const query = buildQuery(params)
        if (params?.runId) query.runId = params.runId
        const result = await client.get('/hooks', query)
        return coerceResponseDates(result)
      },
    },
  }
}
