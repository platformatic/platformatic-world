import { existsSync, readFileSync } from 'node:fs'
import { request as undiciRequest, Agent } from 'undici'
import type pg from 'pg'

const K8S_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'

interface K8sConfig {
  apiServer: string
  caCert?: string
  adminServiceAccount?: string
  saTokenPath?: string
}

interface Logger {
  warn: (obj: object, msg: string) => void
}

export interface K8sValidationResult {
  applicationIds: number[]
  isAdmin: boolean
}

interface CacheEntry {
  applicationIds: number[]
  isAdmin: boolean
  expiresAt: number
}

const EXPIRY_BUFFER = 30_000 // 30 seconds before actual expiry

export function createK8sTokenValidator (pool: pg.Pool, config: K8sConfig, logger?: Logger) {
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

  // This pod's own SA token authenticates the TokenReview call. It is read per
  // call because the kubelet rotates it and a copy cached here would expire
  // within a day, making every caller look unauthenticated.
  const saTokenPath = config.saTokenPath || K8S_TOKEN_PATH
  const inK8s = existsSync(saTokenPath)

  return async function validateK8sToken (token: string): Promise<K8sValidationResult | null> {
    // Check cache
    const cached = cache.get(token)
    if (cached && cached.expiresAt > Date.now()) {
      return { applicationIds: cached.applicationIds, isAdmin: cached.isAdmin }
    }

    // Call K8s TokenReview API
    const reviewBody = JSON.stringify({
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenReview',
      spec: { token },
    })

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (inK8s) {
      headers.Authorization = `Bearer ${readFileSync(saTokenPath, 'utf-8').trim()}`
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
      // Our own credentials or connectivity failed, not the caller's. Log it so
      // this is not silently reported to every caller as invalid credentials.
      const body = await response.body.text()
      logger?.warn({ statusCode: response.statusCode, body }, 'TokenReview request failed')
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

    const applicationIds = result.rows.map((r: { application_id: number }) => r.application_id)

    if (applicationIds.length === 0 && !isAdmin) return null

    // Cache with TTL (use a conservative 5-minute cache for K8s tokens)
    cache.set(token, {
      applicationIds,
      isAdmin,
      expiresAt: Date.now() + 5 * 60 * 1000 - EXPIRY_BUFFER,
    })

    return { applicationIds, isAdmin }
  }
}
