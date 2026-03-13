import { readFileSync } from 'node:fs'
import { request as undiciRequest, Agent } from 'undici'
import type pg from 'pg'

interface K8sConfig {
  apiServer: string
  caCert?: string
  adminServiceAccount?: string
}

export interface K8sValidationResult {
  applicationId: number | null
  isAdmin: boolean
}

interface CacheEntry {
  applicationId: number | null
  isAdmin: boolean
  expiresAt: number
}

const EXPIRY_BUFFER = 30_000 // 30 seconds before actual expiry

export function createK8sTokenValidator (pool: pg.Pool, config: K8sConfig) {
  const cache = new Map<string, CacheEntry>()

  let dispatcher: Agent | undefined
  if (config.caCert) {
    try {
      const ca = readFileSync(config.caCert, 'utf-8')
      dispatcher = new Agent({
        connect: { ca },
      })
    } catch {
      // CA cert file not available, proceed without custom CA
    }
  }

  // Read this pod's own SA token to authenticate with the K8s API server
  let ownToken: string | undefined
  try {
    ownToken = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf-8').trim()
  } catch {
    // Token not available
  }

  return async function validateK8sToken (token: string): Promise<K8sValidationResult | null> {
    // Check cache
    const cached = cache.get(token)
    if (cached && cached.expiresAt > Date.now()) {
      return { applicationId: cached.applicationId, isAdmin: cached.isAdmin }
    }

    // Call K8s TokenReview API
    const reviewBody = JSON.stringify({
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenReview',
      spec: { token },
    })

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ownToken) {
      headers.Authorization = `Bearer ${ownToken}`
    }

    const response = await undiciRequest(
      `${config.apiServer}/apis/authentication.k8s.io/v1/tokenreviews`,
      {
        method: 'POST',
        headers,
        body: reviewBody,
        dispatcher,
      }
    )

    if (response.statusCode >= 400) {
      await response.body.dump()
      return null
    }

    const review = await response.body.json() as {
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

    // Check if this is the admin service account (e.g. ICC)
    const identity = `${namespace}:${serviceAccount}`
    const isAdmin = config.adminServiceAccount === identity

    // Look up binding (admin identities may not have one)
    const result = await pool.query(
      `SELECT application_id FROM workflow_app_k8s_bindings
       WHERE namespace = $1 AND service_account = $2`,
      [namespace, serviceAccount]
    )

    const applicationId = result.rows.length > 0 ? result.rows[0].application_id : null

    if (applicationId === null && !isAdmin) return null

    // Cache with TTL (use a conservative 5-minute cache for K8s tokens)
    cache.set(token, {
      applicationId,
      isAdmin,
      expiresAt: Date.now() + 5 * 60 * 1000 - EXPIRY_BUFFER,
    })

    return { applicationId, isAdmin }
  }
}
