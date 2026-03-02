import { readFileSync } from 'node:fs'
import type pg from 'pg'

interface K8sConfig {
  apiServer: string
  caCert?: string
}

interface CacheEntry {
  applicationId: number
  expiresAt: number
}

const EXPIRY_BUFFER = 30_000 // 30 seconds before actual expiry

export function createK8sTokenValidator (pool: pg.Pool, config: K8sConfig) {
  const cache = new Map<string, CacheEntry>()

  let caCert: string | undefined
  if (config.caCert) {
    try {
      caCert = readFileSync(config.caCert, 'utf-8')
    } catch {
      // CA cert file not available, will skip TLS verification
    }
  }

  return async function validateK8sToken (token: string): Promise<number | null> {
    // Check cache
    const cached = cache.get(token)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.applicationId
    }

    // Call K8s TokenReview API
    const reviewBody = JSON.stringify({
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenReview',
      spec: { token },
    })

    const response = await fetch(
      `${config.apiServer}/apis/authentication.k8s.io/v1/tokenreviews`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reviewBody,
      }
    )

    if (!response.ok) return null

    const review = await response.json() as {
      status: {
        authenticated: boolean
        user?: { username: string }
        error?: string
      }
    }

    if (!review.status.authenticated || !review.status.user) return null

    // Parse service account: system:serviceaccount:<namespace>:<name>
    const parts = review.status.user.username.split(':')
    if (parts.length !== 4 || parts[0] !== 'system' || parts[1] !== 'serviceaccount') {
      return null
    }

    const namespace = parts[2]
    const serviceAccount = parts[3]

    // Look up binding
    const result = await pool.query(
      `SELECT application_id FROM workflow_app_k8s_bindings
       WHERE namespace = $1 AND service_account = $2`,
      [namespace, serviceAccount]
    )

    if (result.rows.length === 0) return null

    const applicationId = result.rows[0].application_id

    // Cache with TTL (use a conservative 5-minute cache for K8s tokens)
    cache.set(token, {
      applicationId,
      expiresAt: Date.now() + 5 * 60 * 1000 - EXPIRY_BUFFER,
    })

    return applicationId
  }
}
