import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  NEXT_URL,
  WF_URL,
  restartNextApp,
  resumeHook,
  runE2eWorkflow,
  setup,
  teardown,
  triggerE2eWorkflow,
  waitForHookByToken,
  waitForRunStatus,
  type SpawnedProcess,
} from './helper.ts'

let wfService: SpawnedProcess
let nextApp: SpawnedProcess

before(async () => {
  ({ wfService, nextApp } = await setup())
}, { timeout: 60_000 })

after(() => teardown(wfService, nextApp))

async function getRunEvents (runId: string): Promise<any[]> {
  const response = await fetch(`${WF_URL}/api/v1/apps/default/runs/${runId}/events`)
  assert.equal(response.status, 200)
  const { data } = await response.json() as { data: any[] }
  return data
}

async function waitForEventCount (
  runId: string,
  eventType: string,
  count: number,
  timeoutMs = 15_000
): Promise<any[]> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const events = await getRunEvents(runId)
    if (events.filter((event) => event.eventType === eventType).length >= count) {
      return events
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${count} ${eventType} events in ${runId}`)
}

test('RMT-2: local start calls mint distinct run IDs', { timeout: 30_000 }, async () => {
  const firstRunId = await triggerE2eWorkflow('runIdProbeWorkflow')
  const secondRunId = await triggerE2eWorkflow('runIdProbeWorkflow')

  assert.match(firstRunId, /^wrun_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.match(secondRunId, /^wrun_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.notEqual(firstRunId, secondRunId)

  await Promise.all([
    waitForRunStatus(firstRunId, 'completed'),
    waitForRunStatus(secondRunId, 'completed'),
  ])
})

test('RMT-3: repeated calls have stable, unique durable correlation IDs', { timeout: 30_000 }, async () => {
  const { runId, result } = await runE2eWorkflow('repeatedRemoteStepWorkflow')
  assert.deepEqual(result, [
    'before',
    'loop-0',
    'loop-1',
    'parallel-0',
    'parallel-1',
  ])

  const events = await getRunEvents(runId)
  const stepStarted = events.filter((event) =>
    event.eventType === 'step_started' &&
    event.eventData?.stepName === 'step//./workflows/remote-steps-probes//recordRemoteStepInvocation'
  )
  const correlations = stepStarted.map((event) => event.correlationId)
  const completedCorrelations = events
    .filter((event) =>
      event.eventType === 'step_completed' &&
      event.eventData?.stepName === 'step//./workflows/remote-steps-probes//recordRemoteStepInvocation'
    )
    .map((event) => event.correlationId)

  assert.equal(correlations.length, 5)
  assert.equal(new Set(correlations).size, correlations.length)
  // The final two steps are deliberately started in parallel. Their event
  // order is scheduler-dependent; durability requires stable identities, not
  // lexicographic start order.
  assert.deepEqual(completedCorrelations.sort(), [...correlations].sort())
})

test('RMT-4: hook versus sleep replay is deterministic across worker restart', { timeout: 45_000 }, async () => {
  const token = `rmt4-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const runId = await triggerE2eWorkflow('hookSleepRaceProbeWorkflow', [token])
  await waitForHookByToken(token)

  await waitForEventCount(runId, 'wait_completed', 1)
  nextApp = await restartNextApp(nextApp)

  await waitForEventCount(runId, 'wait_created', 2)
  await resumeHook(token, { iteration: 1 })

  await waitForRunStatus(runId, 'completed')
  const { getRun } = await import('workflow/api')
  const output = await getRun<string[]>(runId).returnValue
  assert.deepEqual(output, ['sleep-0', 'sleep-1', 'sleep-2'])

  const events = await getRunEvents(runId)
  const hookReceivedIndex = events.findIndex((event) => event.eventType === 'hook_received')
  const secondWaitCompletedIndex = events.findIndex((event, index) =>
    event.eventType === 'wait_completed' &&
    events.slice(0, index + 1).filter((candidate) => candidate.eventType === 'wait_completed').length === 2
  )
  assert.notEqual(hookReceivedIndex, -1)
  assert.notEqual(secondWaitCompletedIndex, -1)
  assert.ok(hookReceivedIndex < secondWaitCompletedIndex)

  const ready = await fetch(NEXT_URL)
  assert.ok(ready.ok)
})
