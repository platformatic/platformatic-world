import { createHash } from 'node:crypto'
import type pg from 'pg'

interface CacheEntry {
  applicationId: number
  expiresAt: number
}

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export function hashApiKey (key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function createApiKeyValidator (pool: pg.Pool) {
  const cache = new Map<string, CacheEntry>()

  return async function validateApiKey (token: string): Promise<number | null> {
    const hash = hashApiKey(token)

    // Check cache first
    const cached = cache.get(hash)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.applicationId
    }

    const result = await pool.query(
      `SELECT application_id FROM workflow_app_keys
       WHERE key_hash = $1 AND revoked_at IS NULL`,
      [hash]
    )

    if (result.rows.length === 0) {
      cache.delete(hash)
      return null
    }

    const applicationId = result.rows[0].application_id
    cache.set(hash, { applicationId, expiresAt: Date.now() + CACHE_TTL })

    // Evict expired entries periodically
    if (cache.size > 1000) {
      const now = Date.now()
      for (const [k, v] of cache) {
        if (v.expiresAt <= now) cache.delete(k)
      }
    }

    return applicationId
  }
}
