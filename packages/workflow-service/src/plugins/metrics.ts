import type { FastifyInstance } from 'fastify'

// Simple in-memory counters for Prometheus-compatible metrics
const counters: Record<string, number> = {
  events_created_total: 0,
  runs_created_total: 0,
  messages_dispatched_total: 0,
  messages_dead_lettered_total: 0,
  messages_retried_total: 0,
}

const histograms: Record<string, number[]> = {
  request_duration_ms: [],
  queue_dispatch_duration_ms: [],
}

export function incrementCounter (name: string, amount = 1): void {
  if (name in counters) counters[name] += amount
}

export function recordHistogram (name: string, value: number): void {
  if (name in histograms) {
    const arr = histograms[name]
    arr.push(value)
    // Keep last 10000 values to prevent unbounded growth
    if (arr.length > 10_000) arr.splice(0, arr.length - 10_000)
  }
}

function computeHistogramStats (values: number[]) {
  if (values.length === 0) return { count: 0, sum: 0, avg: 0, p50: 0, p95: 0, p99: 0 }

  const sorted = [...values].sort((a, b) => a - b)
  const count = sorted.length
  const sum = sorted.reduce((a, b) => a + b, 0)

  return {
    count,
    sum,
    avg: sum / count,
    p50: sorted[Math.floor(count * 0.5)],
    p95: sorted[Math.floor(count * 0.95)],
    p99: sorted[Math.floor(count * 0.99)],
  }
}

export default async function metricsPlugin (app: FastifyInstance): Promise<void> {
  // Track request duration
  app.addHook('onResponse', async (request, reply) => {
    recordHistogram('request_duration_ms', reply.elapsedTime)
  })

  // Track event/run creation
  app.addHook('onSend', async (request, reply, payload) => {
    const url = request.url
    if (request.method === 'POST' && url.includes('/events')) {
      incrementCounter('events_created_total')
      const body = request.body as any
      if (body?.eventType === 'run_created') {
        incrementCounter('runs_created_total')
      }
    }
    return payload
  })

  app.get('/metrics', async (_request, reply) => {
    const lines: string[] = []

    // Counters
    for (const [name, value] of Object.entries(counters)) {
      lines.push(`# TYPE wf_${name} counter`)
      lines.push(`wf_${name} ${value}`)
    }

    // Gauges from DB
    const [activeRuns, queueDepth, poolTotal, poolIdle] = await Promise.all([
      app.pg.query("SELECT COUNT(*)::int as count FROM workflow_runs WHERE status IN ('pending', 'running')"),
      app.pg.query("SELECT COUNT(*)::int as count FROM workflow_queue_messages WHERE status IN ('pending', 'deferred', 'failed')"),
      Promise.resolve({ rows: [{ count: app.pg.totalCount }] }),
      Promise.resolve({ rows: [{ count: app.pg.idleCount }] }),
    ])

    lines.push('# TYPE wf_active_runs gauge')
    lines.push(`wf_active_runs ${activeRuns.rows[0].count}`)
    lines.push('# TYPE wf_queue_depth gauge')
    lines.push(`wf_queue_depth ${queueDepth.rows[0].count}`)
    lines.push('# TYPE wf_db_pool_total gauge')
    lines.push(`wf_db_pool_total ${poolTotal.rows[0].count}`)
    lines.push('# TYPE wf_db_pool_idle gauge')
    lines.push(`wf_db_pool_idle ${poolIdle.rows[0].count}`)

    // Histograms
    for (const [name, values] of Object.entries(histograms)) {
      const stats = computeHistogramStats(values)
      lines.push(`# TYPE wf_${name} summary`)
      lines.push(`wf_${name}_count ${stats.count}`)
      lines.push(`wf_${name}_sum ${stats.sum.toFixed(2)}`)
      lines.push(`wf_${name}{quantile="0.5"} ${stats.p50.toFixed(2)}`)
      lines.push(`wf_${name}{quantile="0.95"} ${stats.p95.toFixed(2)}`)
      lines.push(`wf_${name}{quantile="0.99"} ${stats.p99.toFixed(2)}`)
    }

    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
    return lines.join('\n') + '\n'
  })
}
