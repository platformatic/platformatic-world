// Proves @platformatic/world (typed against v4.1.1 stable) works at
// runtime against `workflow@4.2.4` stable. The v4 SDK calls the flat
// streamer methods (`writeToStream`, `getStreamChunks`, ...); our world
// types are already aligned with that shape.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setup, type E2eContext } from './helper.ts'

let ctx: E2eContext

before(async () => {
  ctx = await setup()
}, { timeout: 60_000 })

after(() => ctx?.kill())

test('v4 SDK: addTenWorkflow completes through the full pipeline', { timeout: 60_000 }, async () => {
  const res = await fetch(`${ctx.nextUrl}/api/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 5 }),
  })
  assert.equal(res.status, 200)
  const { runId, result } = await res.json() as { runId: string, result: number }
  assert.ok(runId)
  // 5 + 2 = 7, 7 + 3 = 10, 10 + 5 = 15
  assert.equal(result, 15)
})
