import type { FastifyInstance } from 'fastify'

export default async function healthPlugin (app: FastifyInstance): Promise<void> {
  app.get('/ready', async () => {
    await app.pg.query('SELECT 1')
    return { status: 'ok' }
  })

  app.get('/status', async () => {
    return { status: 'ok' }
  })
}
