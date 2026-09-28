import { assertRemoteSchemas, canonicalizeRemoteValue, type RemoteJsonSchema } from './remote-schema.ts'

const REMOTE_DEFINITIONS = Symbol.for('@platformatic/remote-workflow/handler-definitions/v1')
export type RemoteWorkflow<Input = unknown, Output = unknown> = ((input: Input) => Output | Promise<Output>) & { readonly workflowId?: string }
export interface RemoteHandlerDefinition<Input = any, Output = any> {
  workflow: RemoteWorkflow<Input, Output>
  inputSchema: RemoteJsonSchema
  outputSchema: RemoteJsonSchema
}
export type RemoteHandlerDefinitions = Record<string, RemoteHandlerDefinition>
export interface DefinedRemoteHandlers<Definitions extends RemoteHandlerDefinitions = RemoteHandlerDefinitions> {
  readonly definitions: Readonly<Definitions>
  readonly [REMOTE_DEFINITIONS]: true
}

export function defineRemote<const Definitions extends RemoteHandlerDefinitions> (definitions: Definitions): DefinedRemoteHandlers<Definitions> {
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(definitions))) {
    throw new TypeError('Remote handler definitions must be a plain object')
  }
  const normalized: Record<string, RemoteHandlerDefinition> = Object.create(null)
  for (const name of Object.keys(definitions)) {
    if (name.length === 0 || name.length > 1024) throw new TypeError('Remote endpoint name must contain between 1 and 1024 characters')
    const definition = definitions[name]
    if (!definition || typeof definition !== 'object' || Array.isArray(definition) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(definition))) {
      throw new TypeError(`Remote endpoint ${JSON.stringify(name)} must be a plain object`)
    }
    if (Object.keys(definition).sort().join(',') !== 'inputSchema,outputSchema,workflow') {
      throw new TypeError(`Remote endpoint ${JSON.stringify(name)} must contain only workflow, inputSchema, and outputSchema`)
    }
    if (typeof definition.workflow !== 'function') throw new TypeError(`Remote endpoint ${JSON.stringify(name)} workflow must be a function`)
    if (!Object.hasOwn(definition, 'inputSchema') || !Object.hasOwn(definition, 'outputSchema')) {
      throw new TypeError(`Remote endpoint ${JSON.stringify(name)} requires inputSchema and outputSchema`)
    }
    assertRemoteSchemas(definition)
    normalized[name] = Object.freeze({
      workflow: definition.workflow,
      inputSchema: JSON.parse(canonicalizeRemoteValue(definition.inputSchema)),
      outputSchema: JSON.parse(canonicalizeRemoteValue(definition.outputSchema)),
    })
  }
  return Object.freeze({ definitions: Object.freeze(normalized) as Readonly<Definitions>, [REMOTE_DEFINITIONS]: true as const })
}

export function isDefinedRemoteHandlers (value: unknown): value is DefinedRemoteHandlers {
  return Boolean(value && typeof value === 'object' && (value as Record<PropertyKey, unknown>)[REMOTE_DEFINITIONS] === true)
}
