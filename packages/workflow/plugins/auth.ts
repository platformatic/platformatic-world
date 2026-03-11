import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import authPlugin from '../lib/auth/index.ts'

async function authWrapper (app: FastifyInstance): Promise<void> {
  await app.register(authPlugin, app.authConfig)
}

export default fp(authWrapper, { name: 'auth', dependencies: ['db'] })
