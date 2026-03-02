import { randomBytes, hkdfSync } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { BadRequest } from '../lib/errors.ts'

export default async function encryptionPlugin (app: FastifyInstance): Promise<void> {
  app.get('/api/v1/apps/:appId/encryption-key', async (request) => {
    const query = request.query as { runId?: string }
    const appId = request.appId

    if (!query.runId) throw new BadRequest('runId is required')

    // Get or create app secret
    let secretRow = await app.pg.query(
      'SELECT secret FROM workflow_encryption_keys WHERE application_id = $1',
      [appId]
    )

    if (secretRow.rows.length === 0) {
      const secret = randomBytes(32)
      await app.pg.query(
        `INSERT INTO workflow_encryption_keys (application_id, secret)
         VALUES ($1, $2)
         ON CONFLICT (application_id) DO NOTHING`,
        [appId, secret]
      )
      secretRow = await app.pg.query(
        'SELECT secret FROM workflow_encryption_keys WHERE application_id = $1',
        [appId]
      )
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
