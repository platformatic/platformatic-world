import type { HttpClient } from './client.ts'

function buildQuery (params: any): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {}
  if (params?.resolveData) query.resolveData = params.resolveData
  if (params?.pagination?.limit) query.limit = String(params.pagination.limit)
  if (params?.pagination?.cursor) query.cursor = params.pagination.cursor
  if (params?.pagination?.sortOrder) query.sortOrder = params.pagination.sortOrder
  return query
}

function coerceDates (obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  for (const key of ['createdAt', 'updatedAt', 'startedAt', 'completedAt', 'expiredAt', 'resumeAt', 'retryAfter']) {
    if (typeof obj[key] === 'string') obj[key] = new Date(obj[key])
  }
  return obj
}

function coerceResponseDates (result: any): any {
  if (result?.data) {
    result.data = result.data.map(coerceDates)
  }
  return result
}

export function createStorage (client: HttpClient) {
  return {
    runs: {
      get: (async (id: string, params?: any) => {
        const result = await client.get(`/runs/${id}`, buildQuery(params))
        return coerceDates(result)
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
        return coerceDates(result)
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
        const result = await client.post(`/runs/${runIdPath}/events`, data, query)
        if (result?.event) coerceDates(result.event)
        if (result?.run) coerceDates(result.run)
        if (result?.step) coerceDates(result.step)
        if (result?.hook) coerceDates(result.hook)
        if (result?.wait) coerceDates(result.wait)
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
