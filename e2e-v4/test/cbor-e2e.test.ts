// Same CBOR ground-truth assertions as e2e-v5/test/cbor-e2e.test.ts, but
// exercising the v4 SDK path (workflow@4.2.4 → @workflow/core@4.2.4 →
// @workflow/world@4.1.1). CBOR was backported to v4.1.0-beta.17, so a v4
// SDK also passes specVersion=3 to world.queue() and the DB rows should
// come out as payload_encoding='cbor'.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT } from '@workflow/world'
import { createPlatformaticWorld } from '@platformatic/world'
import { setup, DB_URL, DEPLOYMENT_VERSION, type E2eContext } from './helper.ts'

let ctx: E2eContext

before(async () => {
  ctx = await setup()
}, { timeout: 60_000 })

after(() => ctx?.kill())

test('v4: world declares specVersion = SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT', () => {
  const world = createPlatformaticWorld({
    serviceUrl: ctx.wfUrl,
    appId: 'default',
    deploymentVersion: DEPLOYMENT_VERSION,
  })
  assert.equal(world.specVersion, SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT)
  assert.equal(world.specVersion, 3)
})

test('v4: health endpoint reports specVersion >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT', { timeout: 10_000 }, async () => {
  const res = await fetch(`${ctx.nextUrl}/.well-known/workflow/v1/flow?__health`, { method: 'POST' })
  assert.equal(res.status, 200)
  const body = await res.json() as { specVersion: number; healthy: boolean }
  assert.equal(body.healthy, true)
  assert.ok(body.specVersion >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT, `expected specVersion >= 3, got ${body.specVersion}`)
})

test('v4: workflow run enqueues messages with payload_encoding=cbor', { timeout: 30_000 }, async () => {
  // Run addTenWorkflow end-to-end and verify the DB has CBOR rows — the
  // ground-truth signal that the v4 SDK negotiated CBOR with our world
  // via world.specVersion=3 and sent application/cbor bodies.
  const res = await fetch(`${ctx.nextUrl}/api/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 5 }),
  })
  assert.equal(res.status, 200)
  const { runId } = await res.json() as { runId: string, result: number }

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
