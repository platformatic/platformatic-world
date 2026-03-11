import fp from 'fastify-plugin'
import { hkdfSync } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { BadRequest } from '../lib/errors.ts'

async function encryptionPlugin (app: FastifyInstance): Promise<void> {
  app.get('/api/v1/apps/:appId/encryption-key', async (request) => {
    const query = request.query as { runId?: string }
    const appId = request.appId

    if (!query.runId) throw new BadRequest('runId is required')

    // Only return a key if one was explicitly provisioned for this app
    const secretRow = await app.pg.query(
      'SELECT secret FROM workflow_encryption_keys WHERE application_id = $1',
      [appId]
    )

    if (secretRow.rows.length === 0) {
      return { key: null }
    }

    const secret = secretRow.rows[0].secret

    // Derive per-run key via HKDF
    const derivedKey = hkdfSync(
      'sha256',
      secret,
      query.runId, // salt
      'workflow-encryption', // info
      32 // 256-bit key
    )

    return { key: Buffer.from(derivedKey).toString('base64') }
  })
}

export default fp(encryptionPlugin, { name: 'encryption', dependencies: ['auth'] })
