import { createHash } from 'node:crypto'
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import { RemoteOperationError } from './errors.ts'

export type RemoteJsonSchema = Record<string, unknown> | boolean

export interface RemoteEndpointSchemas {
  inputSchema: RemoteJsonSchema
  outputSchema: RemoteJsonSchema
}

export interface FrozenRemoteEndpointResolution {
  iccApplicationId: string
  owner: string
  schemaHash: string
  transport: 'pull' | 'push'
  policy: Record<string, unknown>
  epoch: number
  inputSchema: RemoteJsonSchema
  outputSchema: RemoteJsonSchema
}

const DRAFT_07_SCHEMA = 'http://json-schema.org/draft-07/schema#'
const ajv = new Ajv({
  allErrors: true,
  strictSchema: true,
  strictTypes: false,
  // Formats are annotations in the v1 remote-step contract. This also keeps
  // registry ingestion and dispatch-time validation independent of optional
  // ajv-formats installations in different processes.
  validateFormats: false,
})
const inputValidators = new Map<string, ValidateFunction>()
const outputValidators = new Map<string, ValidateFunction>()

function admissionError (message: string): RemoteOperationError {
  return new RemoteOperationError('admission_rejected', message, 422)
}

function assertUnicodeScalarString (value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) throw new TypeError('canonical JSON cannot contain an unpaired surrogate')
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) throw new TypeError('canonical JSON cannot contain an unpaired surrogate')
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('canonical JSON cannot contain an unpaired surrogate')
    }
  }
}

function canonicalize (value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') {
    assertUnicodeScalarString(value)
    return JSON.stringify(value)
  }
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
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError('canonical JSON cannot contain sparse arrays')
        }
        items.push(canonicalize(value[index], seen))
      }
      return `[${items.join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON requires plain objects')
    }
    const keys = Object.keys(value).sort()
    const entries = keys.map(key => {
      assertUnicodeScalarString(key)
      return `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], seen)}`
    })
    return `{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

// RFC 8785 JSON Canonicalization Scheme. The implementation deliberately
// rejects values outside I-JSON instead of silently changing their meaning.
export function canonicalizeRemoteSchemaValue (value: unknown): string {
  return canonicalize(value, new Set())
}

export function hashRemoteEndpointSchemas (schemas: RemoteEndpointSchemas): string {
  return createHash('sha256')
    .update(canonicalizeRemoteSchemaValue({
      inputSchema: schemas.inputSchema,
      outputSchema: schemas.outputSchema,
    }), 'utf8')
    .digest('hex')
}

export function assertResolvedRemoteEndpoint (
  name: string,
  endpoint: FrozenRemoteEndpointResolution
): void {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw admissionError(`Remote endpoint ${JSON.stringify(name)} has invalid registry metadata`)
  }
  if (typeof endpoint.iccApplicationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(endpoint.iccApplicationId)) {
    throw admissionError(`Remote endpoint ${JSON.stringify(name)} has an invalid ICC application ID`)
  }
  if (typeof endpoint.owner !== 'string' || endpoint.owner.length === 0) {
    throw admissionError(`Remote endpoint ${JSON.stringify(name)} has an invalid owner`)
  }
  if (!/^[0-9a-f]{64}$/.test(endpoint.schemaHash)) {
    throw admissionError(`Remote endpoint ${JSON.stringify(name)} has an invalid schemaHash`)
  }
  if (endpoint.transport !== 'pull' && endpoint.transport !== 'push') {
    throw admissionError(`Remote endpoint ${JSON.stringify(name)} has an invalid transport`)
  }
  if (!endpoint.policy || typeof endpoint.policy !== 'object' || Array.isArray(endpoint.policy)) {
    throw admissionError(`Remote endpoint ${JSON.stringify(name)} has an invalid policy`)
  }
  if (!Number.isSafeInteger(endpoint.epoch) || endpoint.epoch < 0) {
    throw admissionError(`Remote endpoint ${JSON.stringify(name)} has an invalid epoch`)
  }
}

function assertDraft7Schema (kind: 'input' | 'output', schema: RemoteJsonSchema): void {
  if (typeof schema === 'boolean') return
  if (Object.prototype.hasOwnProperty.call(schema, '$schema') && schema.$schema !== DRAFT_07_SCHEMA) {
    throw admissionError(
      `Remote ${kind} schema uses an unsupported JSON Schema dialect; expected ${DRAFT_07_SCHEMA}`
    )
  }
  if (Object.prototype.hasOwnProperty.call(schema, '$async')) {
    throw admissionError(`Remote ${kind} schema must not use $async`)
  }
}

function compileSchema (
  kind: 'input' | 'output',
  schemaHash: string,
  schema: RemoteJsonSchema
): ValidateFunction {
  const validators = kind === 'input' ? inputValidators : outputValidators
  let validate = validators.get(schemaHash)
  if (validate) return validate

  assertDraft7Schema(kind, schema)
  try {
    validate = ajv.compile(schema)
  } catch (error: any) {
    throw admissionError(
      `Remote ${kind} schema is not valid draft-07 JSON Schema: ${error?.message || 'compilation failed'}`
    )
  }
  if ((validate as ValidateFunction & { $async?: boolean }).$async) {
    throw admissionError(`Remote ${kind} schema compiled to an asynchronous validator`)
  }
  validators.set(schemaHash, validate)
  return validate
}

export function assertRemoteEndpointSchemas (
  expectedHash: string,
  schemas: RemoteEndpointSchemas
): void {
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas) ||
      !Object.prototype.hasOwnProperty.call(schemas, 'inputSchema') ||
      !Object.prototype.hasOwnProperty.call(schemas, 'outputSchema')) {
    throw admissionError(`Remote schema catalog entry ${JSON.stringify(expectedHash)} is invalid`)
  }
  for (const [kind, schema] of Object.entries(schemas)) {
    if (typeof schema !== 'boolean' &&
        (!schema || typeof schema !== 'object' || Array.isArray(schema))) {
      throw admissionError(`Remote ${kind} for catalog entry ${JSON.stringify(expectedHash)} is invalid`)
    }
  }
  let actualHash: string
  try {
    actualHash = hashRemoteEndpointSchemas(schemas)
  } catch (error: any) {
    throw admissionError(
      `Remote schema catalog entry ${JSON.stringify(expectedHash)} cannot be canonicalized: ` +
      `${error?.message || 'invalid JSON'}`
    )
  }
  if (actualHash !== expectedHash) {
    throw admissionError(
      `Remote schema catalog entry ${JSON.stringify(expectedHash)} hashes to ${JSON.stringify(actualHash)}`
    )
  }
  compileSchema('input', expectedHash, schemas.inputSchema)
  compileSchema('output', expectedHash, schemas.outputSchema)
}

function validationErrors (errors: ErrorObject[] | null | undefined): string {
  return (errors || []).map(error => {
    const location = error.instancePath || '/'
    return `${location} ${error.message || error.keyword}`
  }).join('; ')
}

export function assertRemoteEndpointInput (
  schemaHash: string,
  inputSchema: RemoteJsonSchema,
  value: unknown
): void {
  const validate = compileSchema('input', schemaHash, inputSchema)
  if (!validate(value)) {
    const details = validationErrors(validate.errors)
    throw new RemoteOperationError(
      'schema_invalid_input',
      `Remote endpoint input does not match its schema${details ? `: ${details}` : ''}`,
      422
    )
  }
}

export function assertRemoteEndpointOutput (
  schemaHash: string,
  outputSchema: RemoteJsonSchema,
  value: unknown
): void {
  const validate = compileSchema('output', schemaHash, outputSchema)
  if (!validate(value)) {
    const details = validationErrors(validate.errors)
    throw new RemoteOperationError(
      'schema_invalid_output',
      `Remote endpoint output does not match its schema${details ? `: ${details}` : ''}`,
      422
    )
  }
}
