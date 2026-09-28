import { createHash } from 'node:crypto'
import { Ajv } from 'ajv'

export type RemoteJsonSchema = Record<string, unknown> | boolean
export interface RemoteEndpointSchemas { inputSchema: RemoteJsonSchema, outputSchema: RemoteJsonSchema }
const DRAFT_07_SCHEMA = 'http://json-schema.org/draft-07/schema#'

function assertUnicodeScalarString (value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) throw new TypeError('canonical JSON cannot contain an unpaired surrogate')
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError('canonical JSON cannot contain an unpaired surrogate')
  }
}

function canonicalize (value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') { assertUnicodeScalarString(value); return JSON.stringify(value) }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new TypeError('canonical JSON contains a non-JSON value')
  if (seen.has(value)) throw new TypeError('canonical JSON cannot contain cycles')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items: string[] = []
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError('canonical JSON cannot contain sparse arrays')
        items.push(canonicalize(value[index], seen))
      }
      if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError('canonical JSON cannot contain non-JSON array properties')
      }
      return `[${items.join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical JSON requires plain objects')
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('canonical JSON cannot contain symbol properties')
    return `{${Object.keys(value).sort().map(key => {
      assertUnicodeScalarString(key)
      return `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], seen)}`
    }).join(',')}}`
  } finally { seen.delete(value) }
}

export function canonicalizeRemoteValue (value: unknown): string { return canonicalize(value, new Set()) }
export function hashRemoteValue (value: unknown): string {
  return createHash('sha256').update(canonicalizeRemoteValue(value), 'utf8').digest('hex')
}

function validateSchema (kind: 'input' | 'output', schema: RemoteJsonSchema): void {
  if (typeof schema !== 'boolean' && (!schema || typeof schema !== 'object' || Array.isArray(schema))) {
    throw new TypeError(`Remote ${kind} schema must be an object or boolean`)
  }
  canonicalizeRemoteValue(schema)
  if (typeof schema === 'object') {
    if (Object.hasOwn(schema, '$schema') && schema.$schema !== DRAFT_07_SCHEMA) {
      throw new TypeError(`Remote ${kind} schema uses an unsupported JSON Schema dialect; expected ${DRAFT_07_SCHEMA}`)
    }
    if (Object.hasOwn(schema, '$async')) throw new TypeError(`Remote ${kind} schema must not use $async`)
  }
  try {
    const validate = new Ajv({ allErrors: true, strict: false, strictSchema: true, validateFormats: false }).compile(schema)
    if ((validate as typeof validate & { $async?: boolean }).$async) throw new TypeError(`Remote ${kind} schema compiled to an asynchronous validator`)
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('Remote ')) throw error
    throw new TypeError(`Remote ${kind} schema is not valid draft-07 JSON Schema: ${error instanceof Error ? error.message : 'compilation failed'}`)
  }
}

export function assertRemoteSchemas (schemas: RemoteEndpointSchemas): void {
  validateSchema('input', schemas.inputSchema)
  validateSchema('output', schemas.outputSchema)
}
