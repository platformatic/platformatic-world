import pg from 'pg'
import Postgrator from 'postgrator'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface DbConfig {
  connectionString: string
}

export async function initDb (config: DbConfig): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: config.connectionString })

  // Run migrations
  const client = await pool.connect()
  try {
    const postgrator = new Postgrator({
      migrationPattern: join(__dirname, '..', 'migrations', '*.sql'),
      driver: 'pg',
      execQuery: (query: string) => client.query(query),
    })
    await postgrator.migrate()
  } finally {
    client.release()
  }

  return pool
}

export function decorateDb (app: FastifyInstance, pool: pg.Pool, connectionString: string): void {
  app.decorate('pg', pool)
  app.decorate('pgConnectionString', connectionString)
  app.addHook('onClose', async () => {
    await pool.end()
  })
}

declare module 'fastify' {
  interface FastifyInstance {
    pg: pg.Pool
    pgConnectionString: string
  }
}
