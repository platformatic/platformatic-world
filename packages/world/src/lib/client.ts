import { Pool } from 'undici'

export interface ClientConfig {
  serviceUrl: string
  appId: string
  apiKey?: string
}

export class HttpClient {
  #pool: Pool
  #baseUrl: string
  #appId: string
  #apiKey: string | undefined

  constructor (config: ClientConfig) {
    this.#pool = new Pool(config.serviceUrl)
    this.#baseUrl = `/api/v1/apps/${config.appId}`
    this.#appId = config.appId
    this.#apiKey = config.apiKey
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

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`

    const response = await this.#pool.request({
      method: 'POST',
      path: fullPath,
      headers,
      body: JSON.stringify(body),
    })

    if (response.statusCode >= 400) {
      const text = await response.body.text()
      throw Object.assign(new Error(`HTTP ${response.statusCode}: ${text}`), {
        statusCode: response.statusCode,
      })
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

    const getHeaders: Record<string, string> = {}
    if (this.#apiKey) getHeaders.authorization = `Bearer ${this.#apiKey}`

    const response = await this.#pool.request({
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: getHeaders,
    })

    if (response.statusCode >= 400) {
      const text = await response.body.text()
      throw Object.assign(new Error(`HTTP ${response.statusCode}: ${text}`), {
        statusCode: response.statusCode,
      })
    }

    return response.body.json()
  }

  async put (path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<any> {
    const putHeaders: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders }
    if (this.#apiKey) putHeaders.authorization = `Bearer ${this.#apiKey}`

    const response = await this.#pool.request({
      method: 'PUT',
      path: `${this.#baseUrl}${path}`,
      headers: putHeaders,
      body: JSON.stringify(body),
    })

    if (response.statusCode >= 400) {
      const text = await response.body.text()
      throw Object.assign(new Error(`HTTP ${response.statusCode}: ${text}`), {
        statusCode: response.statusCode,
      })
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

    const rawHeaders: Record<string, string> = {}
    if (this.#apiKey) rawHeaders.authorization = `Bearer ${this.#apiKey}`

    const response = await this.#pool.request({
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: rawHeaders,
    })

    if (response.statusCode >= 400) {
      const text = await response.body.text()
      throw Object.assign(new Error(`HTTP ${response.statusCode}: ${text}`), {
        statusCode: response.statusCode,
      })
    }

    const chunks: Buffer[] = []
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  async close (): Promise<void> {
    await this.#pool.close()
  }
}
