import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { Pool } from 'undici'

const K8S_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'

export interface ClientConfig {
  serviceUrl: string
  appId: string
}

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

export class HttpClient {
  #pool: Pool
  #baseUrl: string
  #appId: string
  #token: string | null

  constructor (config: ClientConfig) {
    this.#pool = new Pool(config.serviceUrl)
    this.#baseUrl = `/api/v1/apps/${config.appId}`
    this.#appId = config.appId
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

  async post (path: string, body: unknown, query?: Record<string, string | undefined>): Promise<any> {
    let fullPath = `${this.#baseUrl}${path}`
    if (query) {
      const url = new URL(`http://localhost${fullPath}`)
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
      fullPath = `${url.pathname}${url.search}`
    }

    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.#authHeaders() }

    const response = await this.#pool.request({
      method: 'POST',
      path: fullPath,
      headers,
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

  async postRaw (path: string, body: Buffer, contentType: string, query?: Record<string, string | undefined>): Promise<any> {
    let fullPath = `${this.#baseUrl}${path}`
    if (query) {
      const url = new URL(`http://localhost${fullPath}`)
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
      fullPath = `${url.pathname}${url.search}`
    }

    const headers: Record<string, string> = { 'content-type': contentType, ...this.#authHeaders() }

    const response = await this.#pool.request({
      method: 'POST',
      path: fullPath,
      headers,
      body,
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

  async get (path: string, query?: Record<string, string | undefined>): Promise<any> {
    const url = new URL(`http://localhost${this.#baseUrl}${path}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
    }

    const response = await this.#pool.request({
      method: 'GET',
      path: `${url.pathname}${url.search}`,
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
      path: `${this.#baseUrl}${path}`,
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

  async getRaw (path: string, query?: Record<string, string | undefined>): Promise<Buffer> {
    const url = new URL(`http://localhost${this.#baseUrl}${path}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
    }

    const response = await this.#pool.request({
      method: 'GET',
      path: `${url.pathname}${url.search}`,
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

  async getStream (path: string, query?: Record<string, string | undefined>): Promise<Readable> {
    const url = new URL(`http://localhost${this.#baseUrl}${path}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
    }

    const response = await this.#pool.request({
      method: 'GET',
      path: `${url.pathname}${url.search}`,
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
