import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { Pool } from 'undici'
import { encode } from 'cbor-x'

const K8S_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'

export interface ClientConfig {
  serviceUrl: string
  appId: string
}

export type QueryParams = Record<string, string | undefined>
export type Encoding = 'json' | 'cbor'

function createAPIError (statusCode: number, text: string): Error {
  let meta: any
  try {
    const parsed = JSON.parse(text)
    meta = parsed.meta
  } catch {
    // Not JSON
  }
  const err: any = new Error(`HTTP ${statusCode}: ${text}`)
  // Only set WorkflowAPIError name for specific status codes the SDK expects
  if (statusCode === 409 || statusCode === 410 || statusCode === 425 || statusCode === 429) {
    err.name = 'WorkflowAPIError'
  }
  err.status = statusCode
  err.statusCode = statusCode
  if (meta) err.meta = meta
  return err
}

function assertPath (path: string): void {
  if (!path.startsWith('/')) {
    throw new Error(`client path must start with '/': ${JSON.stringify(path)}`)
  }
  if (path.includes('//')) {
    throw new Error(`client path contains '//': ${JSON.stringify(path)}`)
  }
}

function buildQuery (query?: QueryParams): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, v)
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

export class HttpClient {
  #pool: Pool
  #baseUrl: string
  #token: string | null

  constructor (config: ClientConfig) {
    this.#pool = new Pool(config.serviceUrl)
    this.#baseUrl = `/api/v1/apps/${config.appId}`
    this.#token = null
    try {
      this.#token = readFileSync(K8S_TOKEN_PATH, 'utf8').trim()
    } catch {
      // Not running in K8s — single-tenant mode, no auth needed
    }
  }

  #authHeaders (): Record<string, string> {
    if (this.#token) {
      return { authorization: `Bearer ${this.#token}` }
    }
    return {}
  }

  #path (path: string, query?: QueryParams): string {
    assertPath(path)
    return `${this.#baseUrl}${path}${buildQuery(query)}`
  }

  async post (path: string, body: unknown, query?: QueryParams, encoding: Encoding = 'json'): Promise<any> {
    const isCbor = encoding === 'cbor'
    const contentType = isCbor ? 'application/cbor' : 'application/json'
    const serialized = isCbor ? Buffer.from(encode(body)) : JSON.stringify(body)

    const headers: Record<string, string> = { 'content-type': contentType, ...this.#authHeaders() }

    const response = await this.#pool.request({
      method: 'POST',
      path: this.#path(path, query),
      headers,
      body: serialized,
    })

    if (response.statusCode >= 400) {
      const text = await response.body.text()
      throw createAPIError(response.statusCode, text)
    }

    if (response.statusCode === 204) {
      await response.body.dump()
      return undefined
    }

    return response.body.json()
  }

  async get (path: string, query?: QueryParams): Promise<any> {
    const response = await this.#pool.request({
      method: 'GET',
      path: this.#path(path, query),
      headers: this.#authHeaders(),
    })

    if (response.statusCode >= 400) {
      const text = await response.body.text()
      throw createAPIError(response.statusCode, text)
    }

    return response.body.json()
  }

  async put (path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<any> {
    const putHeaders: Record<string, string> = { 'content-type': 'application/json', ...this.#authHeaders(), ...extraHeaders }

    const response = await this.#pool.request({
      method: 'PUT',
      path: this.#path(path),
      headers: putHeaders,
      body: JSON.stringify(body),
    })

    if (response.statusCode >= 400) {
      const text = await response.body.text()
      throw createAPIError(response.statusCode, text)
    }

    if (response.statusCode === 204) {
      await response.body.dump()
      return undefined
    }

    return response.body.json()
  }

  async getRaw (path: string, query?: QueryParams): Promise<Buffer> {
    const response = await this.#pool.request({
      method: 'GET',
      path: this.#path(path, query),
      headers: this.#authHeaders(),
    })

    if (response.statusCode >= 400) {
      const text = await response.body.text()
      throw createAPIError(response.statusCode, text)
    }

    const chunks: Buffer[] = []
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  async getStream (path: string, query?: QueryParams): Promise<Readable> {
    const response = await this.#pool.request({
      method: 'GET',
      path: this.#path(path, query),
      headers: this.#authHeaders(),
    })

    if (response.statusCode >= 400) {
      const text = await response.body.text()
      throw createAPIError(response.statusCode, text)
    }

    return Readable.from(response.body)
  }

  async close (): Promise<void> {
    await this.#pool.close()
  }
}
