import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hkdfSync, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import autoload from '@fastify/autoload'
import pg from 'pg'
import Postgrator from 'postgrator'
import { decode } from 'cbor-x'
import { deriveRunPayloadKeys, hydrateStepArguments } from '@workflow/core/serialization'
import { setupTest, teardownTest, type TestContext } from './helper.ts'
import { hashRemoteEndpointSchemas } from '../lib/remote-endpoints.ts'
import { applyRemoteUpdates, deliverRemoteOutcomes, expireRemoteOperations } from '../queue/remote-outcomes.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INLINE_PAYLOAD_LIMIT = 256 * 1024
const BASE_CONNECTION_STRING = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL
const DEFAULT_ICC_APPLICATION_ID = '11111111-1111-4111-8111-111111111111'
const TEST_SCHEMA_NAME = `wld1_test_${randomBytes(8).toString('hex')}`
const TEST_CONNECTION_URL = new URL(BASE_CONNECTION_STRING)
TEST_CONNECTION_URL.searchParams.set('options', `-c search_path=${TEST_SCHEMA_NAME}`)

before(async () => {
  const pool = new pg.Pool({ connectionString: BASE_CONNECTION_STRING })
  try {
    await pool.query(`CREATE SCHEMA ${TEST_SCHEMA_NAME}`)
    // initDb intentionally uses Postgrator's default schema-table setting.
    // Seed its bookkeeping table in the isolated search path so this test
    // never reads or mutates the suite's public migration state.
    await pool.query(
      `CREATE TABLE ${TEST_SCHEMA_NAME}.schemaversion (
         version BIGINT PRIMARY KEY,
         name TEXT,
         md5 TEXT,
         run_at TIMESTAMPTZ
       )`
    )
    await pool.query(`INSERT INTO ${TEST_SCHEMA_NAME}.schemaversion (version) VALUES (0)`)
  } finally {
    await pool.end()
  }
  process.env.DATABASE_URL = TEST_CONNECTION_URL.toString()
})

after(async () => {
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL

  const pool = new pg.Pool({ connectionString: BASE_CONNECTION_STRING })
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA_NAME} CASCADE`)
  } finally {
    await pool.end()
  }
})

describe('remote operation records', () => {
  let ctx: TestContext
  let runId: string

  before(async () => {
    ctx = await setupTest()
    await bindIccApplication(ctx, DEFAULT_ICC_APPLICATION_ID)
    runId = await createRun(ctx, 'remote-operation-records')
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('stages an immutable inline operation and promotes it with step completion', async () => {
    const operationKey = unique('operation')
    const ordinal = unique('ordinal')
    const dispatchStepId = 'step//remote//dispatch'
    await createAndStartStep(ctx, runId, ordinal, dispatchStepId)

    const request = operation(operationKey, ordinal, dispatchStepId)
    const staged = await stage(ctx, runId, request)
    assert.equal(staged.statusCode, 201, staged.body)
    assert.deepEqual(staged.json().payload, request.payload)
    assert.equal(staged.json().endpoint, 'inventory.reserve')
    assert.equal(staged.json().epoch, 7)
    assert.equal(staged.json().claimAttempts, 0)
    assert.equal(staged.json().status, 'staged')
    assert.equal('target' in staged.json(), false, 'WLD-1 must not persist a resolved target')
    assert.equal(staged.json().scheduledAt, undefined)

    const invisible = await ctx.app.pg.query(
      `SELECT operation_key FROM workflow_remote_operations
       WHERE application_id = $1 AND status = 'pending'`,
      [await applicationId(ctx)]
    )
    assert.equal(invisible.rows.some(row => row.operation_key === operationKey), false)

    const firstDeadline = staged.json().deadlineAt
    const retrieved = await getOperation(ctx, runId, operationKey)
    assert.equal(retrieved.statusCode, 200)
    assert.equal(retrieved.json().deadlineAt, firstDeadline)

    const completed = await completeStep(ctx, runId, ordinal)
    assert.equal(completed.statusCode, 200, completed.body)

    const pending = await getOperation(ctx, runId, operationKey)
    assert.equal(pending.json().status, 'pending')
    assert.ok(pending.json().scheduledAt)

    // A network retry sees the original immutable record and cannot extend
    // its budget or move its lifecycle state backwards.
    const retried = await stage(ctx, runId, {
      ...request,
      payload: { quantity: 2, sku: 'SKU-1' },
    })
    assert.equal(retried.statusCode, 200, retried.body)
    assert.equal(retried.json().status, 'pending')
    assert.equal(retried.json().deadlineAt, firstDeadline)
    assert.equal(retried.json().epoch, 7)
    assert.equal(retried.json().claimAttempts, 0)

    const replayedCompletion = await completeStep(ctx, runId, ordinal)
    assert.equal(replayedCompletion.statusCode, 200)
    assert.equal((await getOperation(ctx, runId, operationKey)).json().status, 'pending')

    await ctx.app.pg.query(
      `UPDATE workflow_remote_operations SET claim_attempts = 4
       WHERE application_id = $1 AND operation_key = $2`,
      [await applicationId(ctx), operationKey]
    )
    const advisoryRetry = await stage(ctx, runId, request)
    assert.equal(advisoryRetry.statusCode, 200)
    assert.equal(advisoryRetry.json().claimAttempts, 4)

    const epochMutation = await stage(ctx, runId, {
      ...request,
      epoch: 8,
    })
    assert.equal(epochMutation.statusCode, 409)
    assert.equal(epochMutation.json().code, 'operation_conflict')

    const mutatedReplay = await stage(ctx, runId, {
      ...request,
      payload: { sku: 'MUTATED', quantity: 2 },
    })
    assert.equal(mutatedReplay.statusCode, 409)
    assert.equal(mutatedReplay.json().code, 'operation_conflict')
    assert.deepEqual((await getOperation(ctx, runId, operationKey)).json().payload, request.payload)
    assert.equal((await getOperation(ctx, runId, operationKey)).json().epoch, 7)
    assert.equal((await getOperation(ctx, runId, operationKey)).json().claimAttempts, 4)
  })

  it('uses the shared canonical schema hash and pins the verified output schema', async () => {
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
    assert.equal(
      hashRemoteEndpointSchemas(schemas),
      '966d77cc864448a2d621e8ca68ae497452dab9a285954ceb6b80906bab5a2ff2'
    )

    const operationKey = unique('schema-pinned')
    const request = operation(operationKey, unique('ordinal'), undefined, {
      payload: { a: 'valid', z: 42 },
    })
    delete request.epoch
    const unresolved = await rawStage(ctx, runId, request)
    assert.equal(unresolved.statusCode, 428)
    assert.equal(unresolved.json().code, 'endpoint_resolution_required')

    const frozen = remoteResolution(DEFAULT_ICC_APPLICATION_ID, 7, schemas)
    const staged = await stage(ctx, runId, { ...request, resolution: frozen })
    assert.equal(staged.statusCode, 201, staged.body)
    assert.equal(staged.json().epoch, 7)
    assert.equal(staged.json().schemaHash, hashRemoteEndpointSchemas(schemas))

    // Mutating the registry's object after dispatch cannot mutate the JSONB snapshot.
    schemas.outputSchema.minimum = 99
    await ctx.app.pg.query(
      'UPDATE workflow_remote_operations SET claim_attempts = 5 WHERE operation_key = $1',
      [operationKey]
    )
    const stored = (await ctx.app.pg.query(
      `SELECT icc_application_id, schema_hash, output_schema, claim_attempts
       FROM workflow_remote_operations WHERE operation_key = $1`,
      [operationKey]
    )).rows[0]
    assert.equal(stored.icc_application_id, DEFAULT_ICC_APPLICATION_ID)
    assert.equal(stored.schema_hash, frozen.schemaHash)
    assert.equal(stored.output_schema.minimum, 1e-7)
    assert.equal(stored.claim_attempts, 5)

    // Exact replay needs neither ICC nor a registry resolution, and a supplied
    // mutated resolution cannot rewrite the pinned schema or advisory counter.
    const replayed = await rawStage(ctx, runId, request)
    assert.equal(replayed.statusCode, 200, replayed.body)
    assert.equal(replayed.json().claimAttempts, 5)
    const ignoredMutation = await rawStage(ctx, runId, {
      ...request,
      resolution: {
        ...frozen,
        iccApplicationId: '99999999-9999-4999-8999-999999999999',
        outputSchema: { type: 'null' },
      },
    })
    assert.equal(ignoredMutation.statusCode, 200, ignoredMutation.body)
    const afterReplay = (await ctx.app.pg.query(
      'SELECT output_schema, claim_attempts FROM workflow_remote_operations WHERE operation_key = $1',
      [operationKey]
    )).rows[0]
    assert.equal(afterReplay.output_schema.minimum, 1e-7)
    assert.equal(afterReplay.claim_attempts, 5)

    await assert.rejects(
      ctx.app.pg.query(
        'UPDATE workflow_remote_operations SET schema_hash = $1 WHERE operation_key = $2',
        ['NOT-A-CONTENT-HASH', operationKey]
      ),
      (error: any) => error.code === '23514'
    )
    await assert.rejects(
      ctx.app.pg.query(
        'UPDATE workflow_remote_operations SET output_schema = $1::jsonb WHERE operation_key = $2',
        [JSON.stringify('not-a-schema'), operationKey]
      ),
      (error: any) => error.code === '23514'
    )
    await assert.rejects(
      ctx.app.pg.query(
        'UPDATE workflow_remote_operations SET icc_application_id = $1 WHERE operation_key = $2',
        ['99999999-9999-4999-8999-999999999999', operationKey]
      ),
      (error: any) => error.code === '23503'
    )
  })

  it('rejects invalid inputs and unverified schema catalog entries without writing a row', async () => {
    const schemas = {
      inputSchema: {
        type: 'object',
        required: ['quantity'],
        properties: { quantity: { type: 'integer', minimum: 1 } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
    }
    const invalidKey = unique('invalid-input')
    const invalid = operation(invalidKey, unique('ordinal'), undefined, {
      payload: { quantity: 'two' },
      resolution: remoteResolution(DEFAULT_ICC_APPLICATION_ID, 7, schemas),
    })
    const rejected = await stage(ctx, runId, invalid)
    assert.equal(rejected.statusCode, 422, rejected.body)
    assert.equal(rejected.json().code, 'schema_invalid_input')

    const corruptKey = unique('corrupt-schema')
    const corrupt = operation(corruptKey, unique('ordinal'), undefined, {
      payload: { quantity: 2 },
      resolution: {
        ...remoteResolution(DEFAULT_ICC_APPLICATION_ID, 7, schemas),
        schemaHash: '0'.repeat(64),
      },
    })
    const corruptResponse = await stage(ctx, runId, corrupt)
    assert.equal(corruptResponse.statusCode, 422)
    assert.equal(corruptResponse.json().code, 'admission_rejected')

    const malformedKey = unique('malformed-resolution')
    const malformed = operation(malformedKey, unique('ordinal'), undefined, {
      payload: { quantity: 2 },
      resolution: {
        ...remoteResolution(DEFAULT_ICC_APPLICATION_ID, 7, schemas),
        owner: '',
      },
    })
    const malformedResponse = await stage(ctx, runId, malformed)
    assert.equal(malformedResponse.statusCode, 422)
    assert.equal(malformedResponse.json().code, 'admission_rejected')

    const unsupportedKey = unique('unsupported-schema')
    const unsupportedSchemas = {
      inputSchema: { type: 'array', prefixItems: [{ type: 'string' }] },
      outputSchema: true,
    }
    const unsupported = operation(unsupportedKey, unique('ordinal'), undefined, {
      payload: [],
      resolution: remoteResolution(DEFAULT_ICC_APPLICATION_ID, 7, unsupportedSchemas),
    })
    const unsupportedResponse = await stage(ctx, runId, unsupported)
    assert.equal(unsupportedResponse.statusCode, 422)
    assert.equal(unsupportedResponse.json().code, 'admission_rejected')

    const withdrawnKey = unique('withdrawn-epoch')
    const withdrawn = operation(withdrawnKey, unique('ordinal'), undefined, {
      payload: { quantity: 2 },
      resolution: remoteResolution(DEFAULT_ICC_APPLICATION_ID, 8, schemas),
    })
    const withdrawnResponse = await stage(ctx, runId, withdrawn)
    assert.equal(withdrawnResponse.statusCode, 409)
    assert.equal(withdrawnResponse.json().code, 'endpoint_withdrawn')

    const rows = await ctx.app.pg.query(
      'SELECT operation_key FROM workflow_remote_operations WHERE operation_key = ANY($1)',
      [[invalidKey, corruptKey, malformedKey, unsupportedKey, withdrawnKey]]
    )
    assert.equal(rows.rows.length, 0)
  })

  it('pins one immutable resolution across concurrent first dispatches without an epoch hint', async () => {
    const operationKey = unique('concurrent-resolution')
    const request = operation(operationKey, unique('ordinal'))
    delete request.epoch
    const resolutions = [
      remoteResolution(DEFAULT_ICC_APPLICATION_ID, 7, { inputSchema: true, outputSchema: { const: 'a' } }),
      remoteResolution(DEFAULT_ICC_APPLICATION_ID, 8, { inputSchema: true, outputSchema: { const: 'b' } }),
    ]
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => rawStage(ctx, runId, {
      ...request,
      resolution: resolutions[index % resolutions.length],
    })))
    assert.equal(responses.filter(response => response.statusCode === 201).length, 1)
    assert.equal(responses.filter(response => response.statusCode === 200).length, 11)

    const stored = (await ctx.app.pg.query(
      `SELECT epoch, schema_hash, output_schema FROM workflow_remote_operations
       WHERE operation_key = $1`,
      [operationKey]
    )).rows[0]
    const winner = resolutions.find(resolution => resolution.epoch === Number(stored.epoch))
    assert.ok(winner)
    assert.equal(stored.schema_hash, winner.schemaHash)
    assert.deepEqual(stored.output_schema, winner.outputSchema)
  })

  it('rolls the WLD2 insert back when the database rejects the transaction', async () => {
    const operationKey = unique('wld2-rollback')
    await ctx.app.pg.query('ALTER TABLE workflow_remote_operations DROP CONSTRAINT IF EXISTS reject_wld2_insert_probe')
    await ctx.app.pg.query(
      `ALTER TABLE workflow_remote_operations ADD CONSTRAINT reject_wld2_insert_probe
       CHECK (operation_key IS DISTINCT FROM '${operationKey}') NOT VALID`
    )
    try {
      assert.equal((await stage(ctx, runId, operation(operationKey, unique('ordinal')))).statusCode, 500)
    } finally {
      await ctx.app.pg.query('ALTER TABLE workflow_remote_operations DROP CONSTRAINT reject_wld2_insert_probe')
    }
    assert.equal((await ctx.app.pg.query(
      'SELECT COUNT(*)::integer AS count FROM workflow_remote_operations WHERE operation_key = $1',
      [operationKey]
    )).rows[0].count, 0)
  })

  it('promotes only the operation owned by the completing dispatch step', async () => {
    const operationKey = unique('wrong-step')
    const ordinal = unique('ordinal')
    await createAndStartStep(ctx, runId, ordinal, 'step//actual')
    assert.equal((await stage(ctx, runId, operation(operationKey, ordinal, 'step//different'))).statusCode, 201)

    assert.equal((await completeStep(ctx, runId, ordinal)).statusCode, 200)
    assert.equal((await getOperation(ctx, runId, operationKey)).json().status, 'staged')
  })

  it('enforces inline payload and total-budget admission constraints', async () => {
    const exactPayload = 'x'.repeat(INLINE_PAYLOAD_LIMIT - 2)
    const exact = await stage(ctx, runId, operation(unique('exact'), unique('ordinal'), undefined, {
      payload: exactPayload,
      budget: { remaining: 1_000 },
    }))
    assert.equal(exact.statusCode, 201, exact.body)

    const storedSize = await ctx.app.pg.query(
      'SELECT payload_size_bytes FROM workflow_remote_operations WHERE operation_key = $1',
      [exact.json().operationKey]
    )
    assert.equal(storedSize.rows[0].payload_size_bytes, INLINE_PAYLOAD_LIMIT)

    const tooLarge = await stage(ctx, runId, operation(unique('large'), unique('ordinal'), undefined, {
      payload: 'x'.repeat(INLINE_PAYLOAD_LIMIT - 1),
    }))
    assert.equal(tooLarge.statusCode, 413)
    assert.equal(tooLarge.json().code, 'admission_rejected')

    const payloadRef = await stage(ctx, runId, {
      ...operation(unique('ref'), unique('ordinal')),
      payloadRef: 's3://not-supported',
    })
    assert.equal(payloadRef.statusCode, 422)

    const missingPayload = operation(unique('missing'), unique('ordinal'))
    delete missingPayload.payload
    assert.equal((await stage(ctx, runId, missingPayload)).statusCode, 422)

    const badBudgets = [0, 999, 1_000.5, Number.MAX_SAFE_INTEGER]
    for (const remaining of badBudgets) {
      const response = await stage(ctx, runId, operation(unique('budget'), unique('ordinal'), undefined, {
        budget: { remaining },
      }))
      assert.ok(response.statusCode === 408 || response.statusCode === 422, response.body)
    }

    for (const epoch of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await stage(ctx, runId, operation(unique('epoch'), unique('ordinal'), undefined, { epoch }))
      assert.equal(response.statusCode, 422, response.body)
    }

    await assert.rejects(
      ctx.app.pg.query(
        `UPDATE workflow_remote_operations SET claim_attempts = -1
         WHERE operation_key = $1`,
        [exact.json().operationKey]
      ),
      (error: any) => error.code === '23514'
    )
    await assert.rejects(
      ctx.app.pg.query(
        `UPDATE workflow_remote_operations SET epoch = -1
         WHERE operation_key = $1`,
        [exact.json().operationKey]
      ),
      (error: any) => error.code === '23514'
    )
    assert.equal((await getOperation(ctx, runId, exact.json().operationKey)).json().claimAttempts, 0)
    assert.equal((await getOperation(ctx, runId, exact.json().operationKey)).json().epoch, 7)
  })

  it('bounds externally supplied operation identities before persistence', async () => {
    const oversizedOperationKey = 'é'.repeat(513)
    const oversizedKey = await stage(ctx, runId, operation(oversizedOperationKey, unique('ordinal')))
    assert.equal(oversizedKey.statusCode, 422, oversizedKey.body)
    assert.equal(oversizedKey.json().code, 'admission_rejected')
    assert.match(oversizedKey.json().message, /1024 UTF-8 bytes/)

    const oversizedEndpoint = await stage(ctx, runId, operation(
      unique('oversized-endpoint'),
      unique('ordinal'),
      undefined,
      { endpoint: 'e'.repeat(1025) }
    ))
    assert.equal(oversizedEndpoint.statusCode, 422, oversizedEndpoint.body)
    assert.equal(oversizedEndpoint.json().code, 'admission_rejected')
    assert.match(oversizedEndpoint.json().message, /1024 characters/)

    const rows = await ctx.app.pg.query(
      'SELECT COUNT(*)::integer AS count FROM workflow_remote_operations WHERE operation_key = $1',
      [oversizedOperationKey]
    )
    assert.equal(rows.rows[0].count, 0)
  })

  it('deduplicates concurrent retries and rejects concurrent identity conflicts', async () => {
    const operationKey = unique('concurrent')
    const ordinal = unique('ordinal')
    const request = operation(operationKey, ordinal)
    const retries = await Promise.all(Array.from({ length: 12 }, () => stage(ctx, runId, request)))
    assert.equal(retries.filter(response => response.statusCode === 201).length, 1)
    assert.equal(retries.filter(response => response.statusCode === 200).length, 11)

    const rows = await ctx.app.pg.query(
      `SELECT * FROM workflow_remote_operations
       WHERE application_id = $1 AND operation_key = $2`,
      [await applicationId(ctx), operationKey]
    )
    assert.equal(rows.rows.length, 1)

    const conflictingOrdinal = unique('ordinal')
    const conflicting = await Promise.all([
      stage(ctx, runId, operation(unique('winner-a'), conflictingOrdinal)),
      stage(ctx, runId, operation(unique('winner-b'), conflictingOrdinal)),
    ])
    assert.deepEqual(conflicting.map(response => response.statusCode).sort(), [201, 409])

    const identityRows = await ctx.app.pg.query(
      `SELECT operation_key FROM workflow_remote_operations
       WHERE application_id = $1 AND caller_run_id = $2
         AND dispatch_step_id = $3 AND ordinal = $4`,
      [await applicationId(ctx), runId, 'step//remote//dispatch', conflictingOrdinal]
    )
    assert.equal(identityRows.rows.length, 1)
  })

  it('rolls promotion and step completion back when the event cannot commit', async () => {
    const operationKey = unique('rollback')
    const ordinal = unique('rollback-ordinal')
    await createAndStartStep(ctx, runId, ordinal)
    assert.equal((await stage(ctx, runId, operation(operationKey, ordinal))).statusCode, 201)

    await ctx.app.pg.query('ALTER TABLE workflow_events DROP CONSTRAINT IF EXISTS reject_remote_promotion_probe')
    await ctx.app.pg.query(
      `ALTER TABLE workflow_events ADD CONSTRAINT reject_remote_promotion_probe
       CHECK (correlation_id IS DISTINCT FROM '${ordinal}') NOT VALID`
    )
    try {
      const failed = await completeStep(ctx, runId, ordinal)
      assert.equal(failed.statusCode, 500)
    } finally {
      await ctx.app.pg.query('ALTER TABLE workflow_events DROP CONSTRAINT reject_remote_promotion_probe')
    }

    assert.equal((await getOperation(ctx, runId, operationKey)).json().status, 'staged')
    const step = await ctx.app.pg.query(
      `SELECT status FROM workflow_steps
       WHERE application_id = $1 AND run_id = $2 AND correlation_id = $3`,
      [await applicationId(ctx), runId, ordinal]
    )
    assert.equal(step.rows[0].status, 'running')

    const completions = await ctx.app.pg.query(
      `SELECT id FROM workflow_events
       WHERE application_id = $1 AND run_id = $2
         AND event_type = 'step_completed' AND correlation_id = $3`,
      [await applicationId(ctx), runId, ordinal]
    )
    assert.equal(completions.rows.length, 0)

    assert.equal((await completeStep(ctx, runId, ordinal)).statusCode, 200)
    assert.equal((await getOperation(ctx, runId, operationKey)).json().status, 'pending')
  })

  it('does not stage operations for missing or cross-run identities', async () => {
    const missingRun = await stage(ctx, unique('missing-run'), operation(unique('missing'), unique('ordinal')))
    assert.equal(missingRun.statusCode, 404)

    const otherRunId = await createRun(ctx, 'other-run')
    const operationKey = unique('run-scoped')
    assert.equal((await stage(ctx, runId, operation(operationKey, unique('ordinal')))).statusCode, 201)
    assert.equal((await getOperation(ctx, otherRunId, operationKey)).statusCode, 404)
  })
})

describe('remote operation outcomes', () => {
  let ctx: TestContext
  let runId: string

  before(async () => {
    ctx = await setupTest()
    await bindIccApplication(ctx, DEFAULT_ICC_APPLICATION_ID)
    runId = await createRun(ctx, 'remote-operation-outcomes')
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('validates and delivers a terminal result exactly once', async () => {
    const operationKey = unique('completed')
    const ordinal = unique('ordinal')
    const schemas = {
      inputSchema: true,
      outputSchema: {
        type: 'object',
        required: ['reservationId'],
        properties: { reservationId: { type: 'string' } },
        additionalProperties: false,
      },
    }
    await createAndStartStep(ctx, runId, ordinal)
    assert.equal((await stage(ctx, runId, operation(operationKey, ordinal, undefined, {
      resolution: remoteResolution(DEFAULT_ICC_APPLICATION_ID, 7, schemas),
    }))).statusCode, 201)
    await completeStep(ctx, runId, ordinal)
    await createHook(ctx, runId, operationKey)

    const started = await applyUpdates(ctx, [{
      operationKey,
      kind: 'started',
      handlerRunId: 'handler-run-1',
    }])
    assert.equal(started.statusCode, 200, started.body)
    assert.deepEqual(started.json(), { applied: 1, delivered: 0 })

    const outcome = { ok: true, value: { reservationId: 'reservation-1' } }
    const completed = await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      handlerRunId: 'handler-run-1',
      outcome,
    }])
    assert.equal(completed.statusCode, 200, completed.body)
    assert.deepEqual(completed.json(), { applied: 1, delivered: 1 })

    const stored = (await getOperation(ctx, runId, operationKey)).json()
    assert.equal(stored.status, 'completed')
    assert.equal(stored.handlerRunId, 'handler-run-1')
    assert.deepEqual(stored.outcome, outcome)
    assert.ok(stored.outcomeDeliveredAt)

    const duplicate = await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      handlerRunId: 'handler-run-1',
      outcome,
    }])
    assert.deepEqual(duplicate.json(), { applied: 0, delivered: 0 })

    const mutatedReplay = await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      handlerRunId: 'mutated-handler-run',
      outcome: { ok: true, value: { reservationId: 'mutated' } },
    }])
    assert.deepEqual(mutatedReplay.json(), { applied: 0, delivered: 0 })
    assert.deepEqual((await getOperation(ctx, runId, operationKey)).json().outcome, outcome)

    const appDbId = await applicationId(ctx)
    assert.equal((await ctx.app.pg.query(
      "SELECT COUNT(*)::integer AS count FROM workflow_events WHERE application_id = $1 AND event_type = 'hook_received' AND correlation_id = $2",
      [appDbId, `hook-${operationKey}`]
    )).rows[0].count, 1)
    assert.equal((await ctx.app.pg.query(
      'SELECT COUNT(*)::integer AS count FROM workflow_queue_messages WHERE application_id = $1 AND idempotency_key = $2',
      [appDbId, `remote-result:${operationKey}`]
    )).rows[0].count, 1)
    const eventPayload = JSON.parse((await ctx.app.pg.query(
      "SELECT event_data FROM workflow_events WHERE application_id = $1 AND event_type = 'hook_received' AND correlation_id = $2",
      [appDbId, `hook-${operationKey}`]
    )).rows[0].event_data.toString('utf8'))
    assert.equal(eventPayload.token, operationKey)
    assert.equal(typeof eventPayload.payload, 'string')
    assert.deepEqual(
      await hydrateStepArguments(
        new Uint8Array(Buffer.from(eventPayload.payload, 'base64')),
        runId,
        undefined
      ),
      { ...outcome, handlerRunId: 'handler-run-1' }
    )
    const continuation = (await ctx.app.pg.query(
      'SELECT payload FROM workflow_queue_messages WHERE application_id = $1 AND idempotency_key = $2',
      [appDbId, `remote-result:${operationKey}`]
    )).rows[0].payload
    assert.deepEqual(continuation, { runId })
  })

  it('turns invalid handler output into a deterministic failed outcome', async () => {
    const operationKey = unique('invalid-output')
    const ordinal = unique('ordinal')
    const schemas = { inputSchema: true, outputSchema: { type: 'integer' } }
    await createAndStartStep(ctx, runId, ordinal)
    await stage(ctx, runId, operation(operationKey, ordinal, undefined, {
      resolution: remoteResolution(DEFAULT_ICC_APPLICATION_ID, 7, schemas),
    }))
    await completeStep(ctx, runId, ordinal)
    await createHook(ctx, runId, operationKey)

    const response = await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      outcome: { ok: true, value: 'not-an-integer' },
    }])
    assert.equal(response.statusCode, 200, response.body)
    const stored = (await getOperation(ctx, runId, operationKey)).json()
    assert.equal(stored.status, 'failed')
    assert.equal(stored.outcome.ok, false)
    assert.equal(stored.outcome.error.code, 'schema_invalid_output')
    assert.ok(stored.outcomeDeliveredAt)
  })

  it('keeps a fast outcome durable until its hook exists', async () => {
    const operationKey = unique('fast-outcome')
    const ordinal = unique('ordinal')
    await createAndStartStep(ctx, runId, ordinal)
    await stage(ctx, runId, operation(operationKey, ordinal))
    await completeStep(ctx, runId, ordinal)

    const response = await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      outcome: { ok: true, value: { accepted: true } },
    }])
    assert.deepEqual(response.json(), { applied: 1, delivered: 0 })
    assert.equal((await getOperation(ctx, runId, operationKey)).json().outcomeDeliveredAt, undefined)

    await createHook(ctx, runId, operationKey)
    assert.equal(await deliverRemoteOutcomes(ctx.app.pg), 1)
    assert.ok((await getOperation(ctx, runId, operationKey)).json().outcomeDeliveredAt)
  })

  it('expires the durable total budget and resumes the hook with budget_exhausted', async () => {
    const operationKey = unique('expired')
    const ordinal = unique('ordinal')
    await createAndStartStep(ctx, runId, ordinal)
    await stage(ctx, runId, operation(operationKey, ordinal))
    await completeStep(ctx, runId, ordinal)
    await createHook(ctx, runId, operationKey)
    await ctx.app.pg.query(
      `UPDATE workflow_remote_operations
       SET created_at = NOW() - INTERVAL '2 seconds', deadline_at = NOW() - INTERVAL '1 second'
       WHERE operation_key = $1`,
      [operationKey]
    )

    assert.equal(await expireRemoteOperations(ctx.app.pg), 1)
    assert.equal(await deliverRemoteOutcomes(ctx.app.pg), 1)
    const stored = (await getOperation(ctx, runId, operationKey)).json()
    assert.equal(stored.status, 'failed')
    assert.equal(stored.outcome.error.code, 'budget_exhausted')
    assert.ok(stored.outcomeDeliveredAt)

    const lateResult = await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      handlerRunId: 'late-handler',
      outcome: { ok: true, value: { tooLate: true } },
    }])
    assert.deepEqual(lateResult.json(), { applied: 0, delivered: 0 })
    assert.equal((await getOperation(ctx, runId, operationKey)).json().outcome.error.code, 'budget_exhausted')
  })

  it('enforces the deadline while applying an update, before the periodic sweep', async () => {
    const operationKey = unique('late-before-sweep')
    const ordinal = unique('ordinal')
    await preparePendingOperation(ctx, runId, operationKey, ordinal)
    await createHook(ctx, runId, operationKey)
    await ctx.app.pg.query(
      `UPDATE workflow_remote_operations
       SET created_at = NOW() - INTERVAL '2 seconds', deadline_at = NOW() - INTERVAL '1 second'
       WHERE application_id = $1 AND operation_key = $2`,
      [await applicationId(ctx), operationKey]
    )

    const response = await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      outcome: { ok: true, value: { arrived: 'too-late' } },
    }])
    assert.equal(response.statusCode, 200, response.body)
    const stored = (await getOperation(ctx, runId, operationKey)).json()
    assert.equal(stored.status, 'failed')
    assert.equal(stored.outcome.error.code, 'budget_exhausted')
    assert.ok(stored.outcomeDeliveredAt)
  })

  it('rejects malformed updates and invalid state transitions deterministically', async () => {
    const operationKey = unique('invalid-transition')
    const ordinal = unique('ordinal')
    await createAndStartStep(ctx, runId, ordinal)
    assert.equal((await stage(ctx, runId, operation(operationKey, ordinal))).statusCode, 201)

    for (const invalid of [null, 1, 'update', {}]) {
      const response = await applyUpdates(ctx, [invalid])
      assert.equal(response.statusCode, 422, response.body)
      assert.equal(response.json().code, 'admission_rejected')
    }

    const invalidKind = await applyUpdates(ctx, [{ operationKey, kind: 'unknown' }])
    assert.equal(invalidKind.statusCode, 422, invalidKind.body)
    assert.equal(invalidKind.json().code, 'admission_rejected')

    const oversizedKey = await applyUpdates(ctx, [{
      operationKey: 'é'.repeat(513),
      kind: 'started',
      handlerRunId: 'handler-before-dispatch',
    }])
    assert.equal(oversizedKey.statusCode, 422, oversizedKey.body)
    assert.equal(oversizedKey.json().code, 'admission_rejected')
    assert.match(oversizedKey.json().message, /1024 UTF-8 bytes/)

    const invalidTransition = await applyUpdates(ctx, [{
      operationKey,
      kind: 'started',
      handlerRunId: 'handler-before-dispatch',
    }])
    assert.equal(invalidTransition.statusCode, 409, invalidTransition.body)
    assert.equal(invalidTransition.json().code, 'operation_conflict')
    assert.equal((await getOperation(ctx, runId, operationKey)).json().status, 'staged')

    const invalidTerminal = await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      outcome: { ok: true, value: null },
    }])
    assert.equal(invalidTerminal.statusCode, 409, invalidTerminal.body)
    assert.equal(invalidTerminal.json().code, 'operation_conflict')
  })

  it('preserves the originating namespace and uses CBOR for a spec-3 continuation', async () => {
    const namespacedRunId = await createRun(ctx, 'namespaced-remote-outcome', 3)
    const operationKey = unique('namespaced')
    const ordinal = unique('ordinal')
    await preparePendingOperation(ctx, namespacedRunId, operationKey, ordinal, 3)
    const appDbId = await applicationId(ctx)
    await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
         (queue_name, run_id, deployment_version, application_id,
          payload_bytes, payload_encoding, status)
       VALUES ($1, $2, 'v1', $3, $4, 'cbor', 'delivered')`,
      ['__acme_wkf_workflow_namespaced-remote-outcome', namespacedRunId, appDbId,
        Buffer.from([])]
    )
    await createHook(ctx, namespacedRunId, operationKey, 3)

    const response = await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      outcome: { ok: true, value: { accepted: true } },
    }])
    assert.equal(response.statusCode, 200, response.body)
    const continuation = (await ctx.app.pg.query(
      `SELECT queue_name, payload, payload_bytes, payload_encoding
       FROM workflow_queue_messages
       WHERE application_id = $1 AND idempotency_key = $2`,
      [appDbId, `remote-result:${operationKey}`]
    )).rows[0]
    assert.equal(continuation.queue_name, '__acme_wkf_workflow_namespaced-remote-outcome')
    assert.equal(continuation.payload_encoding, 'cbor')
    assert.equal(continuation.payload, null)
    assert.deepEqual(decode(continuation.payload_bytes), { runId: namespacedRunId })
  })

  it('encrypts a hook outcome that the Workflow SDK can hydrate', async () => {
    const operationKey = unique('encrypted')
    const ordinal = unique('ordinal')
    const appDbId = await applicationId(ctx)
    const secret = randomBytes(32)
    await ctx.app.pg.query(
      `INSERT INTO workflow_encryption_keys (application_id, secret)
       VALUES ($1, $2)`,
      [appDbId, secret]
    )

    try {
      await preparePendingOperation(ctx, runId, operationKey, ordinal)
      await createHook(ctx, runId, operationKey)
      const outcome = { ok: true, value: { encrypted: true } }
      const response = await applyUpdates(ctx, [{ operationKey, kind: 'completed', outcome }])
      assert.equal(response.statusCode, 200, response.body)

      const eventData = JSON.parse((await ctx.app.pg.query(
        `SELECT event_data FROM workflow_events
         WHERE application_id = $1 AND event_type = 'hook_received' AND correlation_id = $2`,
        [appDbId, `hook-${operationKey}`]
      )).rows[0].event_data.toString('utf8'))
      const rawKey = new Uint8Array(hkdfSync(
        'sha256', secret, runId, 'workflow-encryption', 32
      ))
      const keys = await deriveRunPayloadKeys(rawKey)
      assert.deepEqual(
        await hydrateStepArguments(
          new Uint8Array(Buffer.from(eventData.payload, 'base64')),
          runId,
          keys
        ),
        outcome
      )
    } finally {
      await ctx.app.pg.query(
        'DELETE FROM workflow_encryption_keys WHERE application_id = $1',
        [appDbId]
      )
    }
  })

  it('does not let hookless rows at the front of a batch starve a ready outcome', async () => {
    const appDbId = await applicationId(ctx)
    const prefix = unique('hookless')
    const schemaHash = hashRemoteEndpointSchemas({ inputSchema: true, outputSchema: true })
    await ctx.app.pg.query(
      `INSERT INTO workflow_remote_operations
         (application_id, operation_key, caller_run_id, dispatch_step_id, ordinal,
          endpoint, icc_application_id, schema_hash, output_schema, epoch, payload,
          payload_size_bytes, budget_remaining_ms, deadline_at, status, outcome, completed_at)
       SELECT $1, $2 || ordinal::text, $3, $2 || '-dispatch-' || ordinal::text,
              $2 || '-ordinal-' || ordinal::text, 'inventory.reserve', $4, $5, 'true',
              7, '{}', 2, 30000, NOW() + INTERVAL '30 seconds', 'completed',
              $6::jsonb, NOW() - INTERVAL '1 minute'
       FROM generate_series(1, 100) ordinal`,
      [appDbId, prefix, runId, DEFAULT_ICC_APPLICATION_ID, schemaHash,
        JSON.stringify({ ok: true, value: null })]
    )

    const readyKey = unique('ready-after-hookless')
    await preparePendingOperation(ctx, runId, readyKey, unique('ordinal'))
    assert.equal((await applyUpdates(ctx, [{
      operationKey: readyKey,
      kind: 'completed',
      outcome: { ok: true, value: { ready: true } },
    }])).json().delivered, 0)
    await createHook(ctx, runId, readyKey)

    assert.equal(await deliverRemoteOutcomes(ctx.app.pg, {
      applicationId: appDbId,
      batchSize: 100,
    }), 1)
    assert.ok((await getOperation(ctx, runId, readyKey)).json().outcomeDeliveredAt)
  })

  it('delivers once when two replicas sweep concurrently', async () => {
    const operationKey = unique('concurrent-delivery')
    await preparePendingOperation(ctx, runId, operationKey, unique('ordinal'))
    assert.equal((await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      outcome: { ok: true, value: { concurrent: true } },
    }])).json().delivered, 0)
    await createHook(ctx, runId, operationKey)
    const appDbId = await applicationId(ctx)

    const delivered = await Promise.all([
      deliverRemoteOutcomes(ctx.app.pg, { applicationId: appDbId }),
      deliverRemoteOutcomes(ctx.app.pg, { applicationId: appDbId }),
    ])
    assert.equal(delivered[0] + delivered[1], 1)
    assert.equal((await ctx.app.pg.query(
      `SELECT COUNT(*)::integer AS count FROM workflow_events
       WHERE application_id = $1 AND event_type = 'hook_received' AND correlation_id = $2`,
      [appDbId, `hook-${operationKey}`]
    )).rows[0].count, 1)
  })

  it('serializes delivery with a concurrent terminal run transition', async () => {
    const terminalRunId = await createRun(ctx, 'remote-outcome-terminal-race')
    const operationKey = unique('run-transition')
    await preparePendingOperation(ctx, terminalRunId, operationKey, unique('ordinal'))
    assert.equal((await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      outcome: { ok: true, value: { shouldResume: false } },
    }])).json().delivered, 0)
    await createHook(ctx, terminalRunId, operationKey)
    const appDbId = await applicationId(ctx)
    const client = await ctx.app.pg.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT id FROM workflow_runs
         WHERE application_id = $1 AND id = $2
         FOR UPDATE`,
        [appDbId, terminalRunId]
      )
      await client.query(
        `UPDATE workflow_runs SET status = 'cancelled', completed_at = NOW()
         WHERE application_id = $1 AND id = $2`,
        [appDbId, terminalRunId]
      )
      await client.query(
        `UPDATE workflow_hooks SET status = 'disposed', disposed_at = NOW()
         WHERE application_id = $1 AND run_id = $2 AND status = 'pending'`,
        [appDbId, terminalRunId]
      )

      assert.equal(await deliverRemoteOutcomes(ctx.app.pg, { applicationId: appDbId }), 0)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    assert.equal(await deliverRemoteOutcomes(ctx.app.pg, { applicationId: appDbId }), 1)
    assert.ok((await getOperation(ctx, terminalRunId, operationKey)).json().outcomeDeliveredAt)
    assert.equal((await ctx.app.pg.query(
      `SELECT COUNT(*)::integer AS count FROM workflow_events
       WHERE application_id = $1 AND event_type = 'hook_received' AND correlation_id = $2`,
      [appDbId, `hook-${operationKey}`]
    )).rows[0].count, 0)
    assert.equal((await ctx.app.pg.query(
      `SELECT COUNT(*)::integer AS count FROM workflow_queue_messages
       WHERE application_id = $1 AND idempotency_key = $2`,
      [appDbId, `remote-result:${operationKey}`]
    )).rows[0].count, 0)
  })

  it('rolls back hook delivery when its continuation key belongs to another message', async () => {
    const operationKey = unique('delivery-rollback')
    await preparePendingOperation(ctx, runId, operationKey, unique('ordinal'))
    assert.equal((await applyUpdates(ctx, [{
      operationKey,
      kind: 'completed',
      outcome: { ok: true, value: { rollback: true } },
    }])).json().delivered, 0)
    const appDbId = await applicationId(ctx)
    await ctx.app.pg.query(
      `INSERT INTO workflow_queue_messages
         (idempotency_key, queue_name, run_id, deployment_version, application_id,
          payload, payload_encoding, status)
       VALUES ($1, '__wkf_workflow_other', 'other-run', 'other-version', $2,
               '{}', 'json', 'pending')`,
      [`remote-result:${operationKey}`, appDbId]
    )
    await createHook(ctx, runId, operationKey)

    await assert.rejects(
      deliverRemoteOutcomes(ctx.app.pg, { applicationId: appDbId }),
      (error: any) => error.code === 'operation_conflict'
    )
    assert.equal((await getOperation(ctx, runId, operationKey)).json().outcomeDeliveredAt, undefined)
    assert.equal((await ctx.app.pg.query(
      `SELECT status FROM workflow_hooks
       WHERE application_id = $1 AND run_id = $2 AND token = $3`,
      [appDbId, runId, operationKey]
    )).rows[0].status, 'pending')
    assert.equal((await ctx.app.pg.query(
      `SELECT COUNT(*)::integer AS count FROM workflow_events
       WHERE application_id = $1 AND event_type = 'hook_received' AND correlation_id = $2`,
      [appDbId, `hook-${operationKey}`]
    )).rows[0].count, 0)

    await ctx.app.pg.query(
      'DELETE FROM workflow_queue_messages WHERE application_id = $1 AND idempotency_key = $2',
      [appDbId, `remote-result:${operationKey}`]
    )
    assert.equal(await deliverRemoteOutcomes(ctx.app.pg, { applicationId: appDbId }), 1)
  })
})

describe('remote operation announcement feed', () => {
  let ctx: TestContext
  let runId: string

  before(async () => {
    ctx = await setupTest()
    await bindIccApplication(ctx, DEFAULT_ICC_APPLICATION_ID)
    runId = await createRun(ctx, 'remote-operation-announcements')
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('uses deterministic keyset pagination for claimable pending and started operations', async () => {
    const prefix = unique('feed')
    const keys = {
      first: `${prefix}-a`,
      second: `${prefix}-b`,
      terminal: `${prefix}-c`,
      staged: `${prefix}-d`,
      expired: `${prefix}-e`,
      belowMinimumBudget: `${prefix}-f`,
    }

    for (const [name, operationKey] of Object.entries(keys)) {
      const ordinal = `${prefix}-${name}`
      await createAndStartStep(ctx, runId, ordinal)
      assert.equal((await stage(ctx, runId, operation(operationKey, ordinal))).statusCode, 201)
      if (name !== 'staged') assert.equal((await completeStep(ctx, runId, ordinal)).statusCode, 200)
    }

    assert.equal((await applyUpdates(ctx, [{
      operationKey: keys.second,
      kind: 'started',
      handlerRunId: `${prefix}-handler`,
    }])).statusCode, 200)
    assert.equal((await applyUpdates(ctx, [{
      operationKey: keys.terminal,
      kind: 'completed',
      outcome: { ok: true, value: { done: true } },
    }])).statusCode, 200)
    await ctx.app.pg.query(
      'UPDATE workflow_remote_operations SET deadline_at = statement_timestamp() WHERE operation_key = $1',
      [keys.expired]
    )
    await ctx.app.pg.query(
      `UPDATE workflow_remote_operations
       SET deadline_at = statement_timestamp() + INTERVAL '500 milliseconds'
       WHERE operation_key = $1`,
      [keys.belowMinimumBudget]
    )

    const firstPage = await listActive(ctx, { limit: 1, cursor: `${prefix}-0` })
    assert.equal(firstPage.statusCode, 200, firstPage.body)
    assert.equal(firstPage.json().hasMore, true)
    assert.equal(firstPage.json().cursor, keys.first)
    assert.deepEqual(firstPage.json().data.map((item: any) => item.operationKey), [keys.first])

    const announce = firstPage.json().data[0]
    assert.deepEqual(Object.keys(announce).sort(), [
      'budget',
      'cancelRequested',
      'endpoint',
      'epoch',
      'operationKey',
      'payload',
    ])
    assert.equal(announce.endpoint, 'inventory.reserve')
    assert.deepEqual(announce.payload, { sku: 'SKU-1', quantity: 2 })
    assert.equal(announce.epoch, 7)
    assert.equal(announce.cancelRequested, false)
    assert.ok(Number.isInteger(announce.budget.remaining))
    assert.ok(announce.budget.remaining > 0 && announce.budget.remaining <= 30_000)
    assert.equal('callerRunId' in announce, false)
    assert.equal('dispatchStepId' in announce, false)

    const secondPage = await listActive(ctx, { limit: 1, cursor: firstPage.json().cursor })
    assert.equal(secondPage.statusCode, 200, secondPage.body)
    assert.deepEqual(secondPage.json().data.map((item: any) => item.operationKey), [keys.second])
    assert.equal(secondPage.json().hasMore, false)
    assert.equal(secondPage.json().cursor, null)

    const repeated = await listActive(ctx, { cursor: `${prefix}-0` })
    assert.deepEqual(repeated.json().data.map((item: any) => item.operationKey), [keys.first, keys.second])
    assert.deepEqual(
      repeated.json().data.map(({ budget: _budget, ...item }: any) => item),
      [firstPage.json().data[0], secondPage.json().data[0]]
        .map(({ budget: _budget, ...item }: any) => item)
    )
  })

  it('retains cancellation tombstones and treats every terminal caller run as cancellation', async () => {
    const cancelledRunId = await createRun(ctx, 'cancelled-operation-announcement')
    const cancelledKey = unique('cancelled-operation')
    await preparePendingOperation(ctx, cancelledRunId, cancelledKey, unique('cancelled-ordinal'))
    const cancelled = await applyUpdates(ctx, [{ operationKey: cancelledKey, kind: 'cancelled_ack' }])
    assert.equal(cancelled.statusCode, 200, cancelled.body)

    const failedCallerRunId = await createRun(ctx, 'failed-caller-announcement')
    const failedCallerKey = unique('failed-caller-operation')
    await preparePendingOperation(ctx, failedCallerRunId, failedCallerKey, unique('failed-caller-ordinal'))
    await ctx.app.pg.query(
      `UPDATE workflow_runs SET status = 'failed', completed_at = NOW(), updated_at = NOW()
       WHERE application_id = $1 AND id = $2`,
      [await applicationId(ctx), failedCallerRunId]
    )

    const retained = (await listActive(ctx)).json().data
    const cancelledAnnouncement = retained.find((item: any) => item.operationKey === cancelledKey)
    const terminalCallerAnnouncement = retained.find((item: any) => item.operationKey === failedCallerKey)
    assert.ok(cancelledAnnouncement)
    assert.ok(terminalCallerAnnouncement)
    assert.equal(cancelledAnnouncement.cancelRequested, true)
    assert.equal(terminalCallerAnnouncement.cancelRequested, true)
    assert.ok(cancelledAnnouncement.budget.remaining > 0)

    await ctx.app.pg.query(
      `UPDATE workflow_remote_operations SET deadline_at = statement_timestamp()
       WHERE application_id = $1 AND operation_key = $2`,
      [await applicationId(ctx), cancelledKey]
    )
    assert.equal(
      (await listActive(ctx)).json().data.some((item: any) => item.operationKey === cancelledKey),
      false
    )
  })

  it('rejects malformed and unbounded pagination queries', async () => {
    for (const query of [
      '?limit=0',
      '?limit=-1',
      '?limit=01',
      '?limit=1.5',
      '?limit=1001',
      '?limit=nope',
      '?cursor=',
      `?cursor=${encodeURIComponent('é'.repeat(513))}`,
      '?unexpected=true',
      '?limit=1&limit=2',
    ]) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/apps/${ctx.appId}/remote-operations/active${query}`,
      })
      assert.equal(response.statusCode, 400, `${query}: ${response.body}`)
    }
  })
})

describe('remote operation persistence', () => {
  it('survives a service restart without changing its deadline', async () => {
    const appId = unique('restart-app')
    const first = await setupTest(appId)
    await bindIccApplication(first, DEFAULT_ICC_APPLICATION_ID)
    const runId = await createRun(first, 'restart-persistence')
    const operationKey = unique('restart-operation')
    const staged = await stage(first, runId, operation(operationKey, unique('ordinal')))
    assert.equal(staged.statusCode, 201)
    const deadlineAt = staged.json().deadlineAt
    await first.app.pg.query(
      'UPDATE workflow_remote_operations SET claim_attempts = 3 WHERE operation_key = $1',
      [operationKey]
    )
    await first.app.close()

    const restarted = await setupTest(appId)
    try {
      const persisted = await getOperation(restarted, runId, operationKey)
      assert.equal(persisted.statusCode, 200)
      assert.equal(persisted.json().status, 'staged')
      assert.equal(persisted.json().deadlineAt, deadlineAt)
      assert.equal(persisted.json().epoch, 7)
      assert.equal(persisted.json().claimAttempts, 3)
      assert.equal(persisted.json().schemaHash, hashRemoteEndpointSchemas({ inputSchema: true, outputSchema: true }))
      const pinned = (await restarted.app.pg.query(
        `SELECT icc_application_id, output_schema FROM workflow_remote_operations
         WHERE operation_key = $1`,
        [operationKey]
      )).rows[0]
      assert.equal(pinned.icc_application_id, DEFAULT_ICC_APPLICATION_ID)
      assert.equal(pinned.output_schema, true)
    } finally {
      await teardownTest(restarted)
    }
  })

  it('reannounces pending operations after restart and recomputes their remaining budget', async () => {
    const appId = unique('feed-restart-app')
    const first = await setupTest(appId)
    await bindIccApplication(first, DEFAULT_ICC_APPLICATION_ID)
    const runId = await createRun(first, 'feed-restart')
    const operationKey = unique('feed-restart-operation')
    const ordinal = unique('feed-restart-ordinal')
    await preparePendingOperation(first, runId, operationKey, ordinal)
    const beforeRestart = (await listActive(first)).json().data
      .find((item: any) => item.operationKey === operationKey)
    assert.ok(beforeRestart)
    await first.app.close()

    const restarted = await setupTest(appId)
    try {
      const afterRestart = (await listActive(restarted)).json().data
        .find((item: any) => item.operationKey === operationKey)
      assert.ok(afterRestart)
      assert.deepEqual(
        { ...afterRestart, budget: undefined },
        { ...beforeRestart, budget: undefined }
      )
      assert.ok(afterRestart.budget.remaining > 0)
      assert.ok(afterRestart.budget.remaining <= beforeRestart.budget.remaining)
    } finally {
      await teardownTest(restarted)
    }
  })

  it('replays a nested operation after restart without rereading its parent deadline', async () => {
    const appId = unique('nested-restart-app')
    const first = await setupTest(appId)
    await bindIccApplication(first, DEFAULT_ICC_APPLICATION_ID)
    const runId = await createRun(first, 'nested-restart')
    await setRunAttributes(first, runId, {
      '$platformatic.remote.deadline': String(Date.now() + 10_000),
    })
    const request = operation(unique('nested-restart-operation'), unique('nested-restart-ordinal'))
    const staged = await stage(first, runId, request)
    assert.equal(staged.statusCode, 201, staged.body)
    await setRunAttributes(first, runId, {
      '$platformatic.remote.deadline': 'invalid-after-first-commit',
    })
    await first.app.close()

    const restarted = await setupTest(appId)
    try {
      const replay = await stage(restarted, runId, request)
      assert.equal(replay.statusCode, 200, replay.body)
      assert.equal(replay.json().deadlineAt, staged.json().deadlineAt)
      assert.deepEqual(replay.json().budget, staged.json().budget)
    } finally {
      await teardownTest(restarted)
    }
  })

  it('keeps a handler run reservation stable across a service restart', async () => {
    const appId = unique('handler-reservation-restart-app')
    const operationKey = unique('handler-reservation-restart-operation')
    const first = await setupTest(appId)
    const reserved = await reserveHandlerRun(first, operationKey, 30_000)
    assert.equal(reserved.statusCode, 201, reserved.body)
    const handlerRunId = reserved.json().handlerRunId
    await first.app.close()

    const restarted = await setupTest(appId)
    try {
      const replay = await reserveHandlerRun(restarted, operationKey, 20_000)
      assert.equal(replay.statusCode, 200, replay.body)
      assert.equal(replay.json().handlerRunId, handlerRunId)
    } finally {
      await teardownTest(restarted)
    }
  })
})

describe('remote handler run reservations', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest(unique('handler-reservations'))
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('atomically reserves one fresh run id and never extends its deadline', async () => {
    const operationKey = unique('handler-operation')
    const concurrent = await Promise.all(
      Array.from({ length: 16 }, () => reserveHandlerRun(ctx, operationKey, 30_000))
    )
    const handlerRunIds = new Set(concurrent.map(response => response.json().handlerRunId))
    assert.equal(handlerRunIds.size, 1)
    assert.match([...handlerRunIds][0], /^wrun_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    assert.equal(concurrent.filter(response => response.statusCode === 201).length, 1)
    assert.equal(concurrent.every(response => response.statusCode === 200 || response.statusCode === 201), true)

    const appDbId = await applicationId(ctx)
    const original = (await ctx.app.pg.query(
      `SELECT handler_run_id, deadline_at FROM workflow_remote_handler_runs
       WHERE application_id = $1 AND operation_key = $2`,
      [appDbId, operationKey]
    )).rows[0]
    assert.ok(original)

    const shortened = await reserveHandlerRun(ctx, operationKey, 5_000)
    assert.equal(shortened.statusCode, 200, shortened.body)
    assert.equal(shortened.json().handlerRunId, original.handler_run_id)
    const shorterDeadline = (await ctx.app.pg.query(
      `SELECT deadline_at FROM workflow_remote_handler_runs
       WHERE application_id = $1 AND operation_key = $2`,
      [appDbId, operationKey]
    )).rows[0].deadline_at
    assert.ok(new Date(shorterDeadline).getTime() < new Date(original.deadline_at).getTime())

    const notExtended = await reserveHandlerRun(ctx, operationKey, 60_000)
    assert.equal(notExtended.statusCode, 200, notExtended.body)
    const finalDeadline = (await ctx.app.pg.query(
      `SELECT deadline_at FROM workflow_remote_handler_runs
       WHERE application_id = $1 AND operation_key = $2`,
      [appDbId, operationKey]
    )).rows[0].deadline_at
    assert.equal(new Date(finalDeadline).getTime(), new Date(shorterDeadline).getTime())
    assert.equal((await ctx.app.pg.query(
      `SELECT COUNT(*)::integer AS count FROM workflow_remote_handler_runs
       WHERE application_id = $1 AND operation_key = $2`,
      [appDbId, operationKey]
    )).rows[0].count, 1)
  })

  it('rejects invalid input and preserves an expired reservation as a tombstone', async () => {
    for (const [payload, message] of [
      [{ operationKey: '', budget: { remaining: 1_000 } }, 'non-empty string'],
      [{ operationKey: 'x', budget: { remaining: 999 } }, 'between 1000 and 2147483647 milliseconds'],
      [{ operationKey: 'x', budget: { remaining: 2_147_483_648 } }, 'between 1000 and 2147483647 milliseconds'],
      [{ operationKey: 'é'.repeat(513), budget: { remaining: 1_000 } }, '1024 UTF-8 bytes'],
    ] as const) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/apps/${ctx.appId}/remote-handler-runs/reserve`,
        payload,
      })
      assert.equal(response.statusCode, 422, response.body)
      assert.match(response.json().message, new RegExp(message))
    }

    const largest = await reserveHandlerRun(ctx, 'é'.repeat(512), 2_147_483_647)
    assert.equal(largest.statusCode, 201, largest.body)
    const largestDeadline = (await ctx.app.pg.query(
      `SELECT deadline_at FROM workflow_remote_handler_runs
       WHERE application_id = $1 AND operation_key = $2`,
      [await applicationId(ctx), 'é'.repeat(512)]
    )).rows[0].deadline_at
    assert.equal(Number.isFinite(new Date(largestDeadline).getTime()), true)

    const operationKey = unique('expired-handler-operation')
    const reserved = await reserveHandlerRun(ctx, operationKey, 30_000)
    assert.equal(reserved.statusCode, 201, reserved.body)
    const handlerRunId = reserved.json().handlerRunId
    await ctx.app.pg.query(
      `UPDATE workflow_remote_handler_runs SET deadline_at = NOW() - INTERVAL '1 second'
       WHERE application_id = $1 AND operation_key = $2`,
      [await applicationId(ctx), operationKey]
    )

    const expired = await reserveHandlerRun(ctx, operationKey, 30_000)
    assert.equal(expired.statusCode, 408, expired.body)
    assert.equal(expired.json().code, 'budget_exhausted')
    assert.equal((await ctx.app.pg.query(
      `SELECT handler_run_id FROM workflow_remote_handler_runs
       WHERE application_id = $1 AND operation_key = $2`,
      [await applicationId(ctx), operationKey]
    )).rows[0].handler_run_id, handlerRunId)
  })

  it('scopes the same operation key to the authenticated World application', async () => {
    const other = await setupTest(unique('other-handler-app'))
    try {
      const operationKey = unique('tenant-local-handler-operation')
      const own = await reserveHandlerRun(ctx, operationKey, 30_000)
      const theirs = await reserveHandlerRun(other, operationKey, 30_000)
      assert.equal(own.statusCode, 201, own.body)
      assert.equal(theirs.statusCode, 201, theirs.body)
      assert.notEqual(own.json().handlerRunId, theirs.json().handlerRunId)

      const rows = await ctx.app.pg.query(
        `SELECT a.app_id, r.handler_run_id
         FROM workflow_remote_handler_runs r
         INNER JOIN workflow_applications a ON a.id = r.application_id
         WHERE r.operation_key = $1
         ORDER BY a.app_id`,
        [operationKey]
      )
      assert.equal(rows.rows.length, 2)
    } finally {
      await teardownTest(other)
    }
  })

  it('keeps reservation, run creation, and enqueue retries idempotent across crash windows', async () => {
    for (const crashWindow of ['after-reserve', 'after-run-created', 'after-enqueue'] as const) {
      const operationKey = unique(crashWindow)
      const reserved = await reserveHandlerRun(ctx, operationKey, 30_000)
      assert.equal(reserved.statusCode, 201, reserved.body)
      const handlerRunId = reserved.json().handlerRunId

      if (crashWindow === 'after-run-created') {
        assert.equal((await createHandlerRun(ctx, handlerRunId)).statusCode, 200)
      } else if (crashWindow === 'after-enqueue') {
        assert.equal((await enqueueHandlerRun(ctx, operationKey, handlerRunId)).statusCode, 201)
      }

      assert.equal((await reserveHandlerRun(ctx, operationKey, 29_000)).json().handlerRunId, handlerRunId)
      assert.equal((await createHandlerRun(ctx, handlerRunId)).statusCode, 200)
      assert.equal((await createHandlerRun(ctx, handlerRunId)).statusCode, 200)
      const firstQueueRetry = await enqueueHandlerRun(ctx, operationKey, handlerRunId)
      assert.equal(
        firstQueueRetry.statusCode,
        crashWindow === 'after-enqueue' ? 409 : 201,
        firstQueueRetry.body
      )
      assert.equal((await enqueueHandlerRun(ctx, operationKey, handlerRunId)).statusCode, 409)

      const appDbId = await applicationId(ctx)
      assert.equal((await ctx.app.pg.query(
        `SELECT COUNT(*)::integer AS count FROM workflow_runs
         WHERE application_id = $1 AND id = $2`,
        [appDbId, handlerRunId]
      )).rows[0].count, 1)
      assert.equal((await ctx.app.pg.query(
        `SELECT COUNT(*)::integer AS count FROM workflow_events
         WHERE application_id = $1 AND run_id = $2 AND event_type = 'run_created'`,
        [appDbId, handlerRunId]
      )).rows[0].count, 1)
      assert.equal((await ctx.app.pg.query(
        `SELECT COUNT(*)::integer AS count FROM workflow_queue_messages
         WHERE application_id = $1 AND idempotency_key = $2`,
        [appDbId, `remote-handler:${operationKey}`]
      )).rows[0].count, 1)
    }
  })
})

describe('nested remote operation budgets', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest(unique('nested-budgets'))
    await bindIccApplication(ctx, DEFAULT_ICC_APPLICATION_ID)
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('clamps a nested dispatch to the handler deadline and preserves the requested budget', async () => {
    const runId = await createRun(ctx, 'nested-clamped')
    const parentDeadline = Date.now() + 8_000
    await setRunAttributes(ctx, runId, { '$platformatic.remote.deadline': String(parentDeadline) })
    const request = operation(unique('nested-clamped'), unique('ordinal'))
    const staged = await stage(ctx, runId, request)
    assert.equal(staged.statusCode, 201, staged.body)
    assert.equal(staged.json().budget.remaining, request.budget.remaining)
    assert.equal(new Date(staged.json().deadlineAt).getTime(), parentDeadline)
  })

  it('keeps an explicitly smaller child budget', async () => {
    const runId = await createRun(ctx, 'nested-smaller')
    await setRunAttributes(ctx, runId, { '$platformatic.remote.deadline': String(Date.now() + 30_000) })
    const before = Date.now()
    const staged = await stage(ctx, runId, operation(unique('nested-smaller'), unique('ordinal'), undefined, {
      budget: { remaining: 2_000 },
    }))
    const deadline = new Date(staged.json().deadlineAt).getTime()
    assert.equal(staged.statusCode, 201, staged.body)
    assert.ok(deadline >= before + 1_800)
    assert.ok(deadline <= Date.now() + 2_050)
  })

  it('fails closed for malformed or exhausted inherited deadlines without writing an operation', async () => {
    for (const [value, statusCode, code] of [
      ['not-a-timestamp', 422, 'admission_rejected'],
      [String(Number.MAX_SAFE_INTEGER + 1), 422, 'admission_rejected'],
      [String(Number.MAX_SAFE_INTEGER), 422, 'admission_rejected'],
      [String(Date.now() + 500), 408, 'budget_exhausted'],
      [String(Date.now() - 1), 408, 'budget_exhausted'],
    ] as const) {
      const runId = await createRun(ctx, `nested-invalid-${statusCode}`)
      await setRunAttributes(ctx, runId, { '$platformatic.remote.deadline': value })
      const operationKey = unique('nested-invalid')
      const response = await stage(ctx, runId, operation(operationKey, unique('ordinal')))
      assert.equal(response.statusCode, statusCode, response.body)
      assert.equal(response.json().code, code)
      assert.equal((await ctx.app.pg.query(
        `SELECT COUNT(*)::integer AS count FROM workflow_remote_operations
         WHERE application_id = $1 AND operation_key = $2`,
        [await applicationId(ctx), operationKey]
      )).rows[0].count, 0)
    }
  })

  it('returns the durable first result on replay without rereading a mutated parent deadline', async () => {
    const runId = await createRun(ctx, 'nested-replay')
    await setRunAttributes(ctx, runId, { '$platformatic.remote.deadline': String(Date.now() + 8_000) })
    const request = operation(unique('nested-replay'), unique('ordinal'))
    const first = await stage(ctx, runId, request)
    assert.equal(first.statusCode, 201, first.body)

    await setRunAttributes(ctx, runId, { '$platformatic.remote.deadline': 'mutated-invalid-value' })
    const replay = await stage(ctx, runId, request)
    assert.equal(replay.statusCode, 200, replay.body)
    assert.equal(replay.json().deadlineAt, first.json().deadlineAt)
    assert.equal(replay.json().schemaHash, first.json().schemaHash)
  })
})

describe('remote operation tenant isolation', () => {
  it('allows tenant-local keys while rejecting cross-tenant run access', async () => {
    const savedEcs = process.env.ECS_CONTAINER_METADATA_URI_V4
    const savedSaPath = process.env.PLT_WORLD_SA_PATH
    process.env.DATABASE_URL = TEST_CONNECTION_URL.toString()
    process.env.WF_ENABLE_POLLER = 'false'
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/remote-operation-test'
    process.env.PLT_WORLD_SA_PATH = join(__dirname, 'no-such-serviceaccount')

    const app = Fastify({ logger: false })
    await app.register(autoload, { dir: join(__dirname, '..', 'plugins') })
    await app.ready()
    const tenantA = unique('tenant-a')
    const tenantB = unique('tenant-b')
    const tenantC = unique('tenant-unbound')
    const tenantAIccId = '22222222-2222-4222-8222-222222222222'
    const tenantBIccId = '33333333-3333-4333-8333-333333333333'
    const ids: number[] = []

    try {
      for (const [appId, iccApplicationId] of [[tenantA, tenantAIccId], [tenantB, tenantBIccId]]) {
        assert.equal((await app.inject({
          method: 'POST',
          url: '/api/v1/apps',
          payload: { appId, iccApplicationId },
        })).statusCode, 201)
        ids.push((await app.pg.query(
          'SELECT id FROM workflow_applications WHERE app_id = $1',
          [appId]
        )).rows[0].id)
      }
      assert.equal((await app.inject({
        method: 'POST',
        url: '/api/v1/apps',
        payload: { appId: tenantC },
      })).statusCode, 201)
      ids.push((await app.pg.query(
        'SELECT id FROM workflow_applications WHERE app_id = $1',
        [tenantC]
      )).rows[0].id)

      assert.equal((await app.inject({
        method: 'POST',
        url: '/api/v1/apps',
        payload: { appId: tenantA, iccApplicationId: tenantBIccId },
      })).statusCode, 409, 'ICC bindings are immutable')
      assert.equal((await app.inject({
        method: 'POST',
        url: '/api/v1/apps',
        payload: { appId: unique('duplicate-icc'), iccApplicationId: tenantAIccId },
      })).statusCode, 409, 'an ICC UUID cannot be bound to two World applications')

      const runA = await createRun({ app, appId: tenantA }, 'tenant-a-workflow')
      const runB = await createRun({ app, appId: tenantB }, 'tenant-b-workflow')
      const runC = await createRun({ app, appId: tenantC }, 'tenant-unbound-workflow')
      const sharedKey = unique('shared-key')
      const tenantAContext = { app, appId: tenantA, iccApplicationId: tenantAIccId }
      const tenantBContext = { app, appId: tenantB, iccApplicationId: tenantBIccId }
      const ordinalA = unique('ordinal-a')
      const ordinalB = unique('ordinal-b')
      await createAndStartStep(tenantAContext, runA, ordinalA)
      await createAndStartStep(tenantBContext, runB, ordinalB)
      assert.equal((await stage(tenantAContext, runA, operation(sharedKey, ordinalA, undefined, { epoch: 11 }))).statusCode, 201)
      assert.equal((await stage(tenantBContext, runB, operation(sharedKey, ordinalB, undefined, { epoch: 12 }))).statusCode, 201)

      const ownA = await getOperation(tenantAContext, runA, sharedKey)
      const ownB = await getOperation(tenantBContext, runB, sharedKey)
      assert.equal(ownA.statusCode, 200)
      assert.equal(ownB.statusCode, 200)
      assert.notEqual(ownA.json().callerRunId, ownB.json().callerRunId)
      assert.equal(ownA.json().epoch, 11)
      assert.equal(ownB.json().epoch, 12)
      assert.equal(ownA.json().claimAttempts, 0)
      assert.equal(ownB.json().claimAttempts, 0)

      assert.equal((await completeStep(tenantAContext, runA, ordinalA)).statusCode, 200)
      assert.equal((await completeStep(tenantBContext, runB, ordinalB)).statusCode, 200)
      await createHook(tenantAContext, runA, sharedKey)
      await createHook(tenantBContext, runB, sharedKey)

      const tenantAOutcome = { ok: true, value: { tenant: 'a' } }
      const tenantBOutcome = { ok: true, value: { tenant: 'b' } }
      assert.equal((await applyRemoteUpdates(app.pg, ids[0], [{
        operationKey: sharedKey,
        kind: 'completed',
        outcome: tenantAOutcome,
      }])).length, 1)
      assert.equal((await applyRemoteUpdates(app.pg, ids[1], [{
        operationKey: sharedKey,
        kind: 'completed',
        outcome: tenantBOutcome,
      }])).length, 1)

      const completedA = await applyUpdates(tenantAContext, [{
        operationKey: sharedKey,
        kind: 'completed',
        outcome: tenantAOutcome,
      }])
      assert.equal(completedA.statusCode, 200, completedA.body)
      assert.deepEqual(completedA.json(), { applied: 0, delivered: 1 })
      assert.equal((await getOperation(tenantBContext, runB, sharedKey)).json().status, 'completed')
      assert.equal((await getOperation(tenantBContext, runB, sharedKey)).json().outcomeDeliveredAt, undefined)

      const completedB = await applyUpdates(tenantBContext, [{
        operationKey: sharedKey,
        kind: 'completed',
        outcome: tenantBOutcome,
      }])
      assert.equal(completedB.statusCode, 200, completedB.body)
      assert.deepEqual(completedB.json(), { applied: 0, delivered: 1 })
      const sharedContinuations = await app.pg.query(
        `SELECT application_id, run_id FROM workflow_queue_messages
         WHERE idempotency_key = $1 ORDER BY application_id`,
        [`remote-result:${sharedKey}`]
      )
      assert.deepEqual(sharedContinuations.rows, [
        { application_id: ids[0], run_id: runA },
        { application_id: ids[1], run_id: runB },
      ])

      assert.equal((await getOperation(tenantBContext, runA, sharedKey)).statusCode, 404)
      assert.equal(
        (await stage(tenantBContext, runA, operation(unique('cross-tenant'), unique('ordinal')))).statusCode,
        404
      )

      const forged = operation(unique('forged-icc'), unique('ordinal'), undefined, {
        resolution: remoteResolution(tenantBIccId, 7),
      })
      assert.equal((await stage(tenantAContext, runA, forged)).statusCode, 403)

      const unboundContext = { app, appId: tenantC, iccApplicationId: tenantAIccId }
      assert.equal((await stage(
        unboundContext,
        runC,
        operation(unique('unbound'), unique('ordinal'))
      )).statusCode, 409)

      const cancelRunA = await createRun(tenantAContext, 'tenant-a-cancellation')
      const cancelRunB = await createRun(tenantBContext, 'tenant-b-cancellation')
      const cancelKey = unique('shared-cancel-key')
      await preparePendingOperation(tenantAContext, cancelRunA, cancelKey, unique('cancel-a'))
      await preparePendingOperation(tenantBContext, cancelRunB, cancelKey, unique('cancel-b'))
      const beforeCancelA = (await listActive(tenantAContext)).json().data
        .find((item: any) => item.operationKey === cancelKey)
      const beforeCancelB = (await listActive(tenantBContext)).json().data
        .find((item: any) => item.operationKey === cancelKey)
      assert.ok(beforeCancelA)
      assert.ok(beforeCancelB)
      assert.equal(beforeCancelA.cancelRequested, false)
      assert.equal(beforeCancelB.cancelRequested, false)
      await app.pg.query(
        `UPDATE workflow_runs SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
         WHERE application_id = $1 AND id = $2`,
        [ids[0], cancelRunA]
      )

      const activeA = (await listActive(tenantAContext)).json().data
        .find((item: any) => item.operationKey === cancelKey)
      const activeB = (await listActive(tenantBContext)).json().data
        .find((item: any) => item.operationKey === cancelKey)
      assert.ok(activeA)
      assert.ok(activeB)
      assert.equal(activeA.cancelRequested, true)
      assert.equal(activeB.cancelRequested, false)
      assert.equal('callerRunId' in activeA, false)
      assert.equal('callerRunId' in activeB, false)
    } finally {
      for (const id of ids) {
        await app.pg.query('DELETE FROM workflow_remote_operations WHERE application_id = $1', [id])
        await app.pg.query('DELETE FROM workflow_queue_messages WHERE application_id = $1', [id])
        await app.pg.query('DELETE FROM workflow_hooks WHERE application_id = $1', [id])
        await app.pg.query('DELETE FROM workflow_steps WHERE application_id = $1', [id])
        await app.pg.query('DELETE FROM workflow_events WHERE application_id = $1', [id])
        await app.pg.query('DELETE FROM workflow_runs WHERE application_id = $1', [id])
        await app.pg.query('DELETE FROM workflow_applications WHERE id = $1', [id])
      }
      await app.close()
      if (savedEcs === undefined) delete process.env.ECS_CONTAINER_METADATA_URI_V4
      else process.env.ECS_CONTAINER_METADATA_URI_V4 = savedEcs
      if (savedSaPath === undefined) delete process.env.PLT_WORLD_SA_PATH
      else process.env.PLT_WORLD_SA_PATH = savedSaPath
    }
  })
})

describe('remote operation migration', () => {
  it('guards WLD1 rows, then upgrades and downgrades without modifying workflow data', async () => {
    const schemaName = `wld1_migration_${randomBytes(8).toString('hex')}`
    const pool = new pg.Pool({ connectionString: BASE_CONNECTION_STRING })
    const client = await pool.connect()
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`)
      await client.query(`SET search_path TO ${schemaName}`)
      const migrator = new Postgrator({
        migrationPattern: join(__dirname, '..', 'migrations', '*.sql'),
        driver: 'pg',
        currentSchema: schemaName,
        execQuery: (query: string) => client.query(query),
      })
      await migrator.migrate('009')
      await client.query("INSERT INTO workflow_applications (id, app_id) VALUES (1, 'legacy-app')")
      await client.query(
        `INSERT INTO workflow_runs
           (id, application_id, workflow_name, deployment_id, status, spec_version)
         VALUES ('legacy-run', 1, 'legacy-workflow', 'v1', 'running', 2)`
      )
      await client.query(
        `INSERT INTO workflow_events
           (run_id, application_id, event_type, correlation_id, spec_version)
         VALUES ('legacy-run', 1, 'run_started', 'legacy-event', 2)`
      )

      await migrator.migrate('010')
      assert.equal((await client.query("SELECT to_regclass('workflow_remote_operations') AS table_name")).rows[0].table_name, 'workflow_remote_operations')
      assert.equal((await client.query("SELECT status FROM workflow_runs WHERE id = 'legacy-run'")).rows[0].status, 'running')
      assert.equal((await client.query("SELECT COUNT(*)::integer AS count FROM workflow_events WHERE run_id = 'legacy-run'")).rows[0].count, 1)
      assert.deepEqual((await client.query(
        `SELECT column_name, character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflow_remote_operations'
           AND column_name IN ('operation_key', 'endpoint')
         ORDER BY column_name`,
        [schemaName]
      )).rows, [
        { column_name: 'endpoint', character_maximum_length: 1024 },
        { column_name: 'operation_key', character_maximum_length: 1024 },
      ])

      await client.query(
        `INSERT INTO workflow_remote_operations
           (application_id, operation_key, caller_run_id, dispatch_step_id, ordinal,
            endpoint, epoch, payload, payload_size_bytes, budget_remaining_ms, deadline_at)
         VALUES (1, 'migration-operation', 'legacy-run', 'dispatch', 'ordinal',
                 'inventory.reserve', 7, '{}', 2, 1000, NOW() + INTERVAL '1 second')`
      )
      const migratedOperation = (await client.query(
        "SELECT epoch, claim_attempts FROM workflow_remote_operations WHERE operation_key = 'migration-operation'"
      )).rows[0]
      assert.equal(migratedOperation.epoch, '7')
      assert.equal(migratedOperation.claim_attempts, 0)

      await assert.rejects(
        migrator.migrate('011'),
        (error: any) => error.code === '55000' || error.cause?.code === '55000'
      )
      assert.equal((await client.query(
        `SELECT COUNT(*)::integer AS count FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflow_remote_operations'
           AND column_name = 'schema_hash'`,
        [schemaName]
      )).rows[0].count, 0, 'the failed migration rolls its DDL back')

      await client.query("DELETE FROM workflow_remote_operations WHERE operation_key = 'migration-operation'")
      await migrator.migrate('011')
      assert.equal((await client.query(
        `SELECT COUNT(*)::integer AS count FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflow_remote_operations'
           AND column_name IN ('icc_application_id', 'schema_hash', 'output_schema')`,
        [schemaName]
      )).rows[0].count, 3)

      await migrator.migrate('012')
      assert.equal((await client.query(
        `SELECT COUNT(*)::integer AS count FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflow_remote_operations'
           AND column_name IN ('handler_run_id', 'outcome', 'completed_at', 'outcome_delivered_at')`,
        [schemaName]
      )).rows[0].count, 4)

      await migrator.migrate('014')
      assert.equal((await client.query(
        "SELECT to_regclass('workflow_remote_handler_runs') AS table_name"
      )).rows[0].table_name, 'workflow_remote_handler_runs')
      assert.deepEqual((await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflow_remote_handler_runs'
         ORDER BY ordinal_position`,
        [schemaName]
      )).rows.map(row => row.column_name), [
        'application_id',
        'operation_key',
        'handler_run_id',
        'deadline_at',
        'created_at',
      ])
      await migrator.migrate('013')
      assert.equal((await client.query(
        "SELECT to_regclass('workflow_remote_handler_runs') AS table_name"
      )).rows[0].table_name, null)

      const migrationIccId = '44444444-4444-4444-8444-444444444444'
      await client.query(
        'UPDATE workflow_applications SET icc_application_id = $1 WHERE id = 1',
        [migrationIccId]
      )
      await client.query(
        `INSERT INTO workflow_remote_operations
           (application_id, operation_key, caller_run_id, dispatch_step_id, ordinal,
            endpoint, icc_application_id, schema_hash, output_schema, epoch, payload,
            payload_size_bytes, budget_remaining_ms, deadline_at, status, outcome, completed_at)
         VALUES (1, 'terminal-migration-operation', 'legacy-run', 'dispatch', 'terminal-ordinal',
                 'inventory.reserve', $1, $2, 'true', 7, '{}', 2, 1000,
                 NOW() + INTERVAL '1 second', 'completed', $3, NOW())`,
        [migrationIccId, hashRemoteEndpointSchemas({ inputSchema: true, outputSchema: true }),
          JSON.stringify({ ok: true, value: null })]
      )
      await assert.rejects(
        migrator.migrate('011'),
        (error: any) => error.code === '55000' || error.cause?.code === '55000'
      )
      assert.equal((await client.query(
        `SELECT COUNT(*)::integer AS count FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflow_remote_operations'
           AND column_name = 'outcome'`,
        [schemaName]
      )).rows[0].count, 1, 'the failed downgrade rolls its DDL back')
      await client.query("DELETE FROM workflow_remote_operations WHERE operation_key = 'terminal-migration-operation'")

      await client.query("INSERT INTO workflow_applications (id, app_id) VALUES (2, 'other-legacy-app')")
      await client.query(
        `INSERT INTO workflow_runs
           (id, application_id, workflow_name, deployment_id, status, spec_version)
         VALUES ('other-legacy-run', 2, 'legacy-workflow', 'v1', 'running', 2)`
      )
      await client.query(
        `INSERT INTO workflow_hooks
           (id, run_id, application_id, correlation_id, token)
         VALUES ('legacy-hook-1', 'legacy-run', 1, 'correlation-1', 'shared-hook-token'),
                ('legacy-hook-2', 'other-legacy-run', 2, 'correlation-2', 'shared-hook-token')`
      )
      await client.query(
        `INSERT INTO workflow_queue_messages
           (idempotency_key, queue_name, run_id, deployment_version, application_id, payload)
         VALUES ('shared-idempotency-key', '__wkf_workflow_legacy', 'legacy-run', 'v1', 1, '{}'),
                ('shared-idempotency-key', '__wkf_workflow_legacy', 'other-legacy-run', 'v1', 2, '{}')`
      )
      await assert.rejects(
        migrator.migrate('011'),
        (error: any) => error.code === '55000' || error.cause?.code === '55000'
      )
      assert.equal((await client.query(
        `SELECT COUNT(*)::integer AS count FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflow_remote_operations'
           AND column_name = 'outcome'`,
        [schemaName]
      )).rows[0].count, 1, 'tenant-local uniqueness downgrade guard rolls back its DDL')
      await client.query('DELETE FROM workflow_hooks WHERE application_id = 2')
      await client.query('DELETE FROM workflow_queue_messages WHERE application_id = 2')

      await migrator.migrate('009')
      assert.equal((await client.query("SELECT to_regclass('workflow_remote_operations') AS table_name")).rows[0].table_name, null)
      assert.equal((await client.query("SELECT status FROM workflow_runs WHERE id = 'legacy-run'")).rows[0].status, 'running')
      assert.equal((await client.query("SELECT COUNT(*)::integer AS count FROM workflow_events WHERE run_id = 'legacy-run'")).rows[0].count, 1)
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
      client.release()
      await pool.end()
    }
  })
})

function unique (prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`
}

function operation (
  operationKey: string,
  ordinal: string,
  dispatchStepId = 'step//remote//dispatch',
  overrides: Record<string, unknown> = {}
): any {
  return {
    operationKey,
    dispatchStepId,
    ordinal,
    endpoint: 'inventory.reserve',
    epoch: 7,
    payload: { sku: 'SKU-1', quantity: 2 },
    budget: { remaining: 30_000 },
    ...overrides,
  }
}

async function applicationId (ctx: TestContext): Promise<number> {
  const result = await ctx.app.pg.query(
    'SELECT id FROM workflow_applications WHERE app_id = $1',
    [ctx.appId]
  )
  return result.rows[0].id
}

async function createRun (ctx: TestContext, workflowName: string, specVersion = 2): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
    payload: {
      eventType: 'run_created',
      specVersion,
      eventData: { deploymentId: 'v1', workflowName, input: {} },
    },
  })
  assert.equal(response.statusCode, 200, response.body)
  return response.json().run.runId
}

async function createAndStartStep (
  ctx: TestContext,
  runId: string,
  correlationId: string,
  stepName = 'step//remote//dispatch',
  specVersion = 2
): Promise<void> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
    payload: {
      eventType: 'step_created',
      correlationId,
      specVersion,
      eventData: { stepName, input: {} },
    },
  })
  assert.equal(created.statusCode, 200, created.body)
  const started = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
    payload: { eventType: 'step_started', correlationId, specVersion, eventData: { attempt: 1 } },
  })
  assert.equal(started.statusCode, 200, started.body)
}

function completeStep (ctx: TestContext, runId: string, correlationId: string, specVersion = 2) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
    payload: {
      eventType: 'step_completed',
      correlationId,
      specVersion,
      eventData: { result: { operationKey: 'recorded' } },
    },
  })
}

async function createHook (
  ctx: TestContext,
  runId: string,
  operationKey: string,
  specVersion = 2
): Promise<void> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
    payload: {
      eventType: 'hook_created',
      correlationId: `hook-${operationKey}`,
      specVersion,
      eventData: { token: operationKey },
    },
  })
  assert.equal(response.statusCode, 200, response.body)
}

async function preparePendingOperation (
  ctx: TestContext,
  runId: string,
  operationKey: string,
  ordinal: string,
  specVersion = 2
): Promise<void> {
  await createAndStartStep(ctx, runId, ordinal, 'step//remote//dispatch', specVersion)
  const staged = await stage(ctx, runId, operation(operationKey, ordinal))
  assert.equal(staged.statusCode, 201, staged.body)
  const completed = await completeStep(ctx, runId, ordinal, specVersion)
  assert.equal(completed.statusCode, 200, completed.body)
}

function applyUpdates (ctx: TestContext, updates: any[]) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/remote-operations/updates`,
    payload: { updates },
  })
}

function listActive (ctx: TestContext, query: { cursor?: string, limit?: number } = {}) {
  const params = new URLSearchParams()
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const suffix = params.size > 0 ? `?${params}` : ''
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/apps/${ctx.appId}/remote-operations/active${suffix}`,
  })
}

function stage (ctx: TestContext, runId: string, payload: any) {
  const schemas = { inputSchema: true, outputSchema: true }
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/runs/${runId}/remote-operations`,
    payload: {
      ...payload,
      resolution: payload.resolution || {
        iccApplicationId: (ctx as TestContext & { iccApplicationId?: string }).iccApplicationId ||
          DEFAULT_ICC_APPLICATION_ID,
        owner: 'inventory',
        schemaHash: hashRemoteEndpointSchemas(schemas),
        transport: 'pull',
        policy: {},
        epoch: payload.epoch,
        ...schemas,
      },
    },
  })
}

function rawStage (ctx: TestContext, runId: string, payload: any) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/runs/${runId}/remote-operations`,
    payload,
  })
}

function reserveHandlerRun (ctx: TestContext, operationKey: string, remaining: number) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/remote-handler-runs/reserve`,
    payload: { operationKey, budget: { remaining } },
  })
}

function createHandlerRun (ctx: TestContext, handlerRunId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/runs/${handlerRunId}/events`,
    payload: {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'v1',
        workflowName: 'workflow//handler//settle',
        input: {},
      },
    },
  })
}

function enqueueHandlerRun (ctx: TestContext, operationKey: string, handlerRunId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/apps/${ctx.appId}/queue`,
    payload: {
      queueName: '__wkf_workflow_workflow//handler//settle',
      deploymentId: 'v1',
      idempotencyKey: `remote-handler:${operationKey}`,
      message: { runId: handlerRunId },
    },
  })
}

async function setRunAttributes (
  ctx: TestContext,
  runId: string,
  attributes: Record<string, unknown>
): Promise<void> {
  await ctx.app.pg.query(
    `UPDATE workflow_runs SET attributes = $3::jsonb
     WHERE application_id = $1 AND id = $2`,
    [await applicationId(ctx), runId, JSON.stringify(attributes)]
  )
}

function remoteResolution (
  iccApplicationId: string,
  epoch: number,
  schemas = { inputSchema: true, outputSchema: true }
) {
  return {
    iccApplicationId,
    owner: 'inventory',
    schemaHash: hashRemoteEndpointSchemas(schemas),
    transport: 'pull',
    policy: {},
    epoch,
    ...schemas,
  }
}

async function bindIccApplication (ctx: TestContext, iccApplicationId: string): Promise<void> {
  await ctx.app.pg.query(
    'UPDATE workflow_applications SET icc_application_id = $1 WHERE app_id = $2',
    [iccApplicationId, ctx.appId]
  )
}

function getOperation (ctx: TestContext, runId: string, operationKey: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/apps/${ctx.appId}/runs/${runId}/remote-operations/${operationKey}`,
  })
}
