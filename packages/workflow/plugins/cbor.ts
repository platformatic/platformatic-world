import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { decode } from 'cbor-x'

export interface CborBody {
  raw: Buffer
  decoded: unknown
}

async function cborPlugin (app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/cbor',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      try {
        const buf = body as Buffer
        done(null, { raw: buf, decoded: decode(buf) })
      } catch (err) {
        done(err as Error)
      }
    }
  )
}

export default fp(cborPlugin, { name: 'cbor' })
