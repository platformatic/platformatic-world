import { decode, encode } from 'cbor-x'

export interface Transport {
  readonly contentType: string
  serialize (value: unknown): Buffer
  deserialize (bytes: Buffer): unknown
}

export class JsonTransport implements Transport {
  readonly contentType = 'application/json'
  serialize (value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value))
  }

  deserialize (bytes: Buffer): unknown {
    return JSON.parse(bytes.toString('utf8'))
  }
}

export class CborTransport implements Transport {
  readonly contentType = 'application/cbor'
  serialize (value: unknown): Buffer {
    return Buffer.from(encode(value))
  }

  deserialize (bytes: Buffer): unknown {
    return decode(bytes)
  }
}

export class DualTransport implements Transport {
  readonly contentType = 'application/cbor'
  serialize (value: unknown): Buffer {
    return Buffer.from(encode(value))
  }

  deserialize (bytes: Buffer): unknown {
    try {
      return decode(bytes)
    } catch {
      return JSON.parse(bytes.toString('utf8'))
    }
  }
}

export async function drainStream (stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
    }
  }
  const buf = Buffer.allocUnsafe(total)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk, offset)
    offset += chunk.byteLength
  }
  return buf
}
