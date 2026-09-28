import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertRemoteEndpointSchemas,
  canonicalizeRemoteSchemaValue,
  hashRemoteEndpointSchemas,
} from '../lib/remote-endpoints.ts'

const schemas = {
  inputSchema: {
    type: 'object',
    required: ['a'],
    properties: { z: { type: 'number' }, a: { type: 'string' } },
  },
  outputSchema: {
    oneOf: [false, { type: 'array', items: true }],
    minimum: 1e-7,
  },
}

test('matches the cross-repository RFC 8785 schema hash vector', () => {
  const canonical = canonicalizeRemoteSchemaValue(schemas)
  assert.equal(
    canonical,
    '{"inputSchema":{"properties":{"a":{"type":"string"},"z":{"type":"number"}},' +
      '"required":["a"],"type":"object"},"outputSchema":{"minimum":1e-7,' +
      '"oneOf":[false,{"items":true,"type":"array"}]}}'
  )
  assert.equal(
    hashRemoteEndpointSchemas(schemas),
    '966d77cc864448a2d621e8ca68ae497452dab9a285954ceb6b80906bab5a2ff2'
  )
})

test('hashes member-order variants identically while preserving array order', () => {
  assert.equal(
    hashRemoteEndpointSchemas({
      outputSchema: { minimum: 1e-7, oneOf: [false, { items: true, type: 'array' }] },
      inputSchema: {
        properties: { a: { type: 'string' }, z: { type: 'number' } },
        type: 'object',
        required: ['a'],
      },
    }),
    hashRemoteEndpointSchemas(schemas)
  )
  assert.notEqual(
    hashRemoteEndpointSchemas({ ...schemas, outputSchema: { ...schemas.outputSchema, oneOf: [...schemas.outputSchema.oneOf].reverse() } }),
    hashRemoteEndpointSchemas(schemas)
  )
})

test('rejects values outside the RFC 8785 I-JSON domain', () => {
  const cyclic: any = {}
  cyclic.self = cyclic
  const sparse = Array(1)
  for (const value of [NaN, Infinity, undefined, 1n, new Date(), cyclic, sparse, '\ud800']) {
    assert.throws(() => canonicalizeRemoteSchemaValue(value), TypeError)
  }
})

test('accepts only draft-07 schemas, either implicit or explicitly declared', () => {
  const implicit = { inputSchema: { type: 'string' }, outputSchema: true }
  assert.doesNotThrow(() => assertRemoteEndpointSchemas(hashRemoteEndpointSchemas(implicit), implicit))

  const explicit = {
    inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'array' },
    outputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'boolean' },
  }
  assert.doesNotThrow(() => assertRemoteEndpointSchemas(hashRemoteEndpointSchemas(explicit), explicit))

  const schemaKeywordsAsData = {
    inputSchema: { const: { $async: true, $schema: 'application-data' } },
    outputSchema: true,
  }
  assert.doesNotThrow(() => {
    assertRemoteEndpointSchemas(hashRemoteEndpointSchemas(schemaKeywordsAsData), schemaKeywordsAsData)
  })

  const annotatedFormat = {
    inputSchema: { type: 'string', format: 'email' },
    outputSchema: { type: 'string', format: 'application-defined' },
  }
  assert.doesNotThrow(() => {
    assertRemoteEndpointSchemas(hashRemoteEndpointSchemas(annotatedFormat), annotatedFormat)
  })

  for (const rejected of [
    {
      inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' },
      outputSchema: true,
    },
    {
      inputSchema: { type: 'array', prefixItems: [{ type: 'string' }] },
      outputSchema: true,
    },
    {
      inputSchema: { type: 'not-a-draft-07-type' },
      outputSchema: true,
    },
  ]) {
    assert.throws(
      () => assertRemoteEndpointSchemas(hashRemoteEndpointSchemas(rejected), rejected),
      isAdmissionError
    )
  }
})

test('rejects asynchronous schemas without creating an unhandled rejection', async () => {
  let unhandled: unknown
  const onUnhandled = (error: unknown) => { unhandled = error }
  process.once('unhandledRejection', onUnhandled)
  try {
    for (const rejected of [
      { inputSchema: { $async: true, type: 'string' }, outputSchema: true },
      { inputSchema: true, outputSchema: { $async: true, type: 'string' } },
    ]) {
      assert.throws(
        () => assertRemoteEndpointSchemas(hashRemoteEndpointSchemas(rejected), rejected),
        isAdmissionError
      )
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(unhandled, undefined)
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})

function isAdmissionError (error: any): boolean {
  return error?.code === 'admission_rejected' && error?.statusCode === 422
}
