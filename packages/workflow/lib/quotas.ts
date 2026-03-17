import type { FastifyInstance } from 'fastify'

interface QuotaCache {
  maxRuns: number
  maxEventsPerRun: number
  maxQueuePerMinute: number
  fetchedAt: number
}

const CACHE_TTL = 60_000 // 1 minute
const quotaCache = new Map<number, QuotaCache>()
const queueCounters = new Map<string, { count: number; resetAt: number }>()

export const DEFAULT_QUOTAS = {
  maxRuns: 10_000,
  maxEventsPerRun: 100_000,
  maxQueuePerMinute: 100_000,
}

export function invalidateQuotaCache (appId: number): void {
  quotaCache.delete(appId)
}

async function getQuotas (app: FastifyInstance, appId: number): Promise<QuotaCache> {
  const cached = quotaCache.get(appId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached

  const result = await app.pg.query(
    'SELECT max_runs, max_events_per_run, max_queue_per_minute FROM workflow_app_quotas WHERE application_id = $1',
    [appId]
  )

  const quotas: QuotaCache = {
    maxRuns: result.rows.length > 0 ? result.rows[0].max_runs : DEFAULT_QUOTAS.maxRuns,
    maxEventsPerRun: result.rows.length > 0 ? result.rows[0].max_events_per_run : DEFAULT_QUOTAS.maxEventsPerRun,
    maxQueuePerMinute: result.rows.length > 0 ? result.rows[0].max_queue_per_minute : DEFAULT_QUOTAS.maxQueuePerMinute,
    fetchedAt: Date.now(),
  }

  quotaCache.set(appId, quotas)
  return quotas
}

export async function checkRunQuota (app: FastifyInstance, appId: number): Promise<void> {
  const quotas = await getQuotas(app, appId)

  const result = await app.pg.query(
    "SELECT COUNT(*)::int as count FROM workflow_runs WHERE application_id = $1 AND status IN ('pending', 'running')",
    [appId]
  )

  if (result.rows[0].count >= quotas.maxRuns) {
    const err = new Error('Run quota exceeded') as any
    err.statusCode = 429
    throw err
  }
}

export async function checkEventQuota (app: FastifyInstance, appId: number, runId: string): Promise<void> {
  const quotas = await getQuotas(app, appId)

  const result = await app.pg.query(
    'SELECT COUNT(*)::int as count FROM workflow_events WHERE application_id = $1 AND run_id = $2',
    [appId, runId]
  )

  if (result.rows[0].count >= quotas.maxEventsPerRun) {
    const err = new Error('Event quota exceeded for this run') as any
    err.statusCode = 429
    throw err
  }
}

export async function checkQueueRateLimit (app: FastifyInstance, appId: number): Promise<void> {
  const quotas = await getQuotas(app, appId)
  const key = `queue_${appId}`
  const now = Date.now()

  let counter = queueCounters.get(key)
  if (!counter || now >= counter.resetAt) {
    counter = { count: 0, resetAt: now + 60_000 }
    queueCounters.set(key, counter)
  }

  counter.count++

  if (counter.count > quotas.maxQueuePerMinute) {
    const err = new Error('Queue rate limit exceeded') as any
    err.statusCode = 429
    throw err
  }
}
