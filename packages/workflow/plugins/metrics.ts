import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'

async function metricsPlugin (app: FastifyInstance): Promise<void> {
  const prom = globalThis.platformatic?.prometheus
  if (!prom) return

  const { registry, client } = prom
  const { Counter, Gauge } = client

  const eventsCreated = new Counter({
    name: 'wf_events_created_total',
    help: 'Total workflow events created',
    registers: [registry],
  })

  const runsCreated = new Counter({
    name: 'wf_runs_created_total',
    help: 'Total workflow runs created',
    registers: [registry],
  })

  // Gauges self-register on the registry via `registers` option.
  // The `collect` callback runs at scrape time.
  const gauges = [
    new Gauge({
      name: 'wf_active_runs',
      help: 'Active workflow runs',
      registers: [registry],
      async collect () {
        const result = await app.pg.query("SELECT COUNT(*)::int as count FROM workflow_runs WHERE status IN ('pending', 'running')")
        this.set(result.rows[0].count)
      },
    }),
    new Gauge({
      name: 'wf_queue_depth',
      help: 'Queue messages pending or deferred',
      registers: [registry],
      async collect () {
        const result = await app.pg.query("SELECT COUNT(*)::int as count FROM workflow_queue_messages WHERE status IN ('pending', 'deferred', 'failed')")
        this.set(result.rows[0].count)
      },
    }),
    new Gauge({
      name: 'wf_db_pool_total',
      help: 'Total DB pool connections',
      registers: [registry],
      collect () { this.set(app.pg.totalCount) },
    }),
    new Gauge({
      name: 'wf_db_pool_idle',
      help: 'Idle DB pool connections',
      registers: [registry],
      collect () { this.set(app.pg.idleCount) },
    }),
  ]

  app.addHook('onClose', () => {
    for (const g of gauges) {
      registry.removeSingleMetric(g.name)
    }
  })

  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.method === 'POST' && request.url.includes('/events')) {
      eventsCreated.inc()
      const body = request.body as any
      if (body?.eventType === 'run_created') {
        runsCreated.inc()
      }
    }
    return payload
  })
}

export default fp(metricsPlugin, { name: 'metrics', dependencies: ['db'] })
