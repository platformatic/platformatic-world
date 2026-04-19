import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT } from '@workflow/world'
import { createPlatformaticWorld } from '@platformatic/world'
import {
  setup, teardown, waitForRunStatus,
  NEXT_URL, WF_URL, DB_URL, DEPLOYMENT_VERSION,
  type SpawnedProcess,
} from './helper.ts'

let wfService: SpawnedProcess
let nextApp: SpawnedProcess

before(async () => {
  ({ wfService, nextApp } = await setup())
}, { timeout: 60_000 })

after(() => teardown(wfService, nextApp))

test('world declares specVersion = SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT', () => {
  const world = createPlatformaticWorld({
    serviceUrl: WF_URL,
    appId: 'default',
    deploymentVersion: DEPLOYMENT_VERSION,
  })
  assert.equal(world.specVersion, SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT)
  assert.equal(world.specVersion, 3)
})

test('health endpoint reports specVersion >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT', { timeout: 10_000 }, async () => {
  const res = await fetch(`${NEXT_URL}/.well-known/workflow/v1/flow?__health`, { method: 'POST' })
  assert.equal(res.status, 200)
  const body = await res.json() as { specVersion: number; healthy: boolean }
  assert.equal(body.healthy, true)
  assert.ok(body.specVersion >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT, `expected specVersion >= 3, got ${body.specVersion}`)
})

// Handler-level CBOR/JSON decoding is covered by the world unit tests
// (packages/world/test/queue.test.ts). The end-to-end signal we care about
// here is that a real workflow run actually produces CBOR-encoded rows, which
// the next test asserts directly against the DB.

test('workflow run enqueues messages with payload_encoding=cbor', { timeout: 30_000 }, async () => {
  // Actually runs a workflow end-to-end and asserts the queue stored
  // messages as CBOR — the ground-truth signal that the client sent CBOR,
  // the server parsed it, and the row carries the right encoding.
  const triggerRes = await fetch(`${NEXT_URL}/api/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'CBOR' }),
  })
  assert.equal(triggerRes.status, 200)
  const { runId } = await triggerRes.json() as { runId: string }

  await waitForRunStatus(runId, 'completed')

  const client = new pg.Client(DB_URL)
  await client.connect()
  try {
    const { rows } = await client.query(
      `SELECT payload_encoding, (payload IS NULL) AS payload_null, (payload_bytes IS NOT NULL) AS bytes_present
       FROM workflow_queue_messages WHERE run_id = $1`,
      [runId]
    )
    assert.ok(rows.length > 0, 'expected at least one queue message for the run')
    for (const row of rows) {
      assert.equal(row.payload_encoding, 'cbor', `row stored with encoding=${row.payload_encoding}`)
      assert.equal(row.payload_null, true, 'payload JSONB must be null for CBOR row')
      assert.equal(row.bytes_present, true, 'payload_bytes must be present for CBOR row')
    }
  } finally {
    await client.end()
  }
})
