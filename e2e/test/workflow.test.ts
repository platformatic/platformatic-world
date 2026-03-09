import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  setup, teardown, waitForRunStatus,
  NEXT_URL, WF_URL,
  type SpawnedProcess,
} from './helper.ts'

let wfService: SpawnedProcess
let nextApp: SpawnedProcess

before(async () => {
  ({ wfService, nextApp } = await setup())
}, { timeout: 60_000 })

after(() => teardown(wfService, nextApp))

test('trigger workflow and verify it completes', { timeout: 30_000 }, async () => {
  const triggerRes = await fetch(`${NEXT_URL}/api/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Platformatic' }),
  })

  assert.equal(triggerRes.status, 200)
  const { runId } = await triggerRes.json() as { runId: string }
  assert.ok(runId, 'should return a runId')

  const run = await waitForRunStatus(runId, 'completed')
  assert.equal(run.status, 'completed')
})

test('workflow service has the run with events', { timeout: 10_000 }, async () => {
  const runsRes = await fetch(`${WF_URL}/api/v1/apps/default/runs`)
  assert.equal(runsRes.status, 200)
  const { data: runs } = await runsRes.json() as { data: any[] }
  assert.ok(runs.length > 0, 'should have at least one run')

  const runId = runs[0].runId
  const eventsRes = await fetch(`${WF_URL}/api/v1/apps/default/runs/${runId}/events`)
  assert.equal(eventsRes.status, 200)
  const { data: events } = await eventsRes.json() as { data: any[] }
  assert.ok(events.length >= 2, 'should have at least run_created and run_completed events')
})
