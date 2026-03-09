// Tests adapted from Vercel's workflow SDK e2e suite.
// Original: https://github.com/vercel/workflow (Apache-2.0 license)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  setup, teardown, triggerE2eWorkflow, runE2eWorkflow,
  waitForRunStatus, waitForHookByToken, getHooksByRunId,
  cancelRun, resumeHook,
  NEXT_URL,
  type SpawnedProcess,
} from './helper.ts'

let wfService: SpawnedProcess
let nextApp: SpawnedProcess

before(async () => {
  ({ wfService, nextApp } = await setup())
}, { timeout: 60_000 })

after(() => teardown(wfService, nextApp))

// ---- Core workflow patterns ----

test('addTen: multi-step chaining', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('addTenWorkflow', [5])
  assert.equal(result, 15)
})

test('promiseAll: parallel steps', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('promiseAllWorkflow')
  assert.equal(result, 'ABC')
})

test('promiseRace: first step wins', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('promiseRaceWorkflow')
  assert.equal(result, 'B')
})

test('promiseAny: one step fails, others succeed', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('promiseAnyWorkflow')
  assert.equal(result, 'B')
})

test('promiseRace stress test: 5 concurrent races', { timeout: 120_000 }, async () => {
  const { result } = await runE2eWorkflow('promiseRaceStressTestWorkflow')
  assert.deepEqual([...result].sort((a: number, b: number) => a - b), [0, 1, 2, 3, 4])
})

// ---- Sleep / deferred delivery ----

test('sleeping: deferred delivery', { timeout: 60_000 }, async () => {
  const startTime = Date.now()
  const runId = await triggerE2eWorkflow('sleepingWorkflow')
  const run = await waitForRunStatus(runId, 'completed', 45_000)
  const elapsed = Date.now() - startTime
  assert.equal(run.status, 'completed')
  assert.ok(elapsed >= 9_000, `sleep should be at least 9s, got ${elapsed}ms`)
})

test('parallelSleep: concurrent sleeps', { timeout: 30_000 }, async () => {
  const startTime = Date.now()
  const runId = await triggerE2eWorkflow('parallelSleepWorkflow')
  const run = await waitForRunStatus(runId, 'completed', 20_000)
  const elapsed = Date.now() - startTime
  assert.equal(run.status, 'completed')
  assert.ok(elapsed < 8_000, `parallel sleeps should overlap, took ${elapsed}ms`)
})

// ---- Data integrity ----

test('nullByte: data integrity', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('nullByteWorkflow')
  assert.equal(result, 'null byte \0')
})

test('fetch: network inside step', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('fetchWorkflow')
  assert.equal(result.userId, 1)
  assert.equal(result.id, 1)
  assert.ok(result.title)
})

// ---- Error handling ----

test('errorRetry: step retries until success', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('errorRetrySuccessWorkflow')
  assert.equal(result.finalAttempt, 3)
})

test('errorFatal: no retries on FatalError', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('errorFatalWorkflow')
  assert.equal(result.caught, true)
  assert.equal(result.message, 'Fatal step error')
})

test('errorFatalCatchable: FatalError can be caught with FatalError.is()', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('errorFatalCatchable')
  assert.equal(result.caught, true)
  assert.equal(result.isFatal, true)
})

test('errorRetryFatal: FatalError fails immediately without retries', { timeout: 30_000 }, async () => {
  const runId = await triggerE2eWorkflow('errorRetryFatal')
  const run = await waitForRunStatus(runId, 'failed', 30_000)
  assert.equal(run.status, 'failed')
})

test('errorRetryCustomDelay: RetryableError respects retryAfter', { timeout: 120_000 }, async () => {
  const startTime = Date.now()
  const runId = await triggerE2eWorkflow('errorRetryCustomDelay')
  const run = await waitForRunStatus(runId, 'completed', 90_000)
  const elapsed = Date.now() - startTime
  assert.equal(run.status, 'completed')
  assert.ok(elapsed >= 9_000, `retry delay should be at least 9s, got ${elapsed}ms`)
})

test('errorRetryDisabled: maxRetries=0 disables retries', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('errorRetryDisabled')
  assert.equal(result.failed, true)
  assert.equal(result.attempt, 1)
})

test('errorStepBasic: step error caught in workflow', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('errorStepBasic')
  assert.equal(result.caught, true)
  assert.ok(result.message.includes('Step error message'), `Expected "Step error message" in: ${result.message}`)
})

test('errorWorkflowNested: nested error causes workflow to fail', { timeout: 30_000 }, async () => {
  const runId = await triggerE2eWorkflow('errorWorkflowNested')
  const run = await waitForRunStatus(runId, 'failed', 30_000)
  assert.equal(run.status, 'failed')
})

test('errorWorkflowCrossFile: error from imported helper causes workflow failure', { timeout: 30_000 }, async () => {
  const runId = await triggerE2eWorkflow('errorWorkflowCrossFile')
  const run = await waitForRunStatus(runId, 'failed', 30_000)
  assert.equal(run.status, 'failed')
})

test('errorStepCrossFile: step error from imported helper is caught', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('errorStepCrossFile')
  assert.equal(result.caught, true)
  assert.ok(result.message.includes('Step error from imported helper module'), `Expected error message, got: ${result.message}`)
})

// Retry exponential backoff means 3 attempts takes longer than 120s with default delays.
test.skip('errorRetrySuccess: regular Error retries until success (with metadata)', { timeout: 120_000 }, async () => {
  const { result } = await runE2eWorkflow('errorRetrySuccess')
  assert.equal(result.finalAttempt, 3)
})

// ---- Spawn / metadata ----

test('spawnWorkflowFromStep: child workflow', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('spawnWorkflowFromStepWorkflow', [7])
  assert.equal(result.parentInput, 7)
  assert.equal(result.childResult.childResult, 14)
  assert.ok(result.childRunId)
})

test('workflowAndStepMetadata: metadata propagation', { timeout: 30_000 }, async () => {
  const { runId, result } = await runE2eWorkflow('workflowAndStepMetadataWorkflow')

  assert.ok(result.workflowMetadata)
  assert.ok(result.stepMetadata)
  assert.ok(result.innerWorkflowMetadata)

  assert.equal(result.workflowMetadata.workflowRunId, runId)
  assert.equal(result.innerWorkflowMetadata.workflowRunId, runId)
  assert.equal(result.stepMetadata.workflowRunId, undefined)

  assert.ok(result.workflowMetadata.workflowStartedAt)
  assert.equal(result.stepMetadata.workflowStartedAt, undefined)

  assert.equal(result.workflowMetadata.stepId, undefined)
  assert.ok(result.stepMetadata.attempt >= 1)
  assert.ok(result.stepMetadata.stepStartedAt)
})

// ---- Step function patterns ----

test('stepFunctionPassing: step fn reference passed as argument', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('stepFunctionPassingWorkflow')
  assert.equal(result, 40)
})

test('stepFunctionWithClosure: closure vars preserved', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('stepFunctionWithClosureWorkflow')
  assert.equal(result, 'Wrapped: Result: 21')
})

test('closureVariable: nested step with closure vars', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('closureVariableWorkflow', [7])
  assert.equal(result, 'Result: 21')
})

test('thisSerialization: .call() and .apply() on step fns', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('thisSerializationWorkflow', [10])
  assert.equal(result, 300)
})

test('directStepCall: calling a step function outside workflow context', { timeout: 30_000 }, async () => {
  const res = await fetch(`${NEXT_URL}/api/test-direct-step-call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 3, y: 4 }),
  })
  assert.equal(res.status, 200)
  const { result } = await res.json() as { result: number }
  assert.equal(result, 7)
})

// ---- Serialization ----

test('customSerialization: class with WORKFLOW_SERIALIZE/DESERIALIZE', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('customSerializationWorkflow', [3, 4])
  assert.deepEqual(result, {
    original: { x: 3, y: 4 },
    scaled: { x: 6, y: 8 },
    scaledAgain: { x: 18, y: 24 },
    sum: { x: 9, y: 12 },
  })
})

test('instanceMethodStep: instance methods as steps', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('instanceMethodStepWorkflow', [5])
  assert.deepEqual(result, {
    initialValue: 5,
    added: 15,
    multiplied: 15,
    description: { label: 'test counter', value: 5 },
    added2: 150,
  })
})

// ---- Static method workflows ----

test('Calculator: static method steps in separate class', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('calculatorCompute', [3, 4])
  assert.deepEqual(result, { sum: 7, product: 12 })
})

test('AllInOneService: static workflow + step in same class', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('allInOneServiceWorkflow', ['hello world'])
  assert.deepEqual(result, { processed: 'HELLO WORLD' })
})

test('ChainableService: pipeline of static method steps', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('chainableServicePipeline', [5])
  assert.deepEqual(result, { a: 10, b: 20, c: 400 })
})

// ---- Hooks ----

test('hookWorkflow: pause and resume via hook API', { timeout: 60_000 }, async () => {
  const token = Math.random().toString(36).slice(2)
  const customData = Math.random().toString(36).slice(2)

  const runId = await triggerE2eWorkflow('hookWorkflow', [token, customData])
  await waitForHookByToken(token)

  await resumeHook(token, { message: 'one', customData })
  await sleep(3_000)

  await resumeHook(token, { message: 'two', customData })
  await sleep(3_000)

  await resumeHook(token, { message: 'three', customData, done: true })

  const run = await waitForRunStatus(runId, 'completed', 30_000)
  assert.equal(run.status, 'completed')
})

test('hookWorkflow: not resumable via public webhook endpoint', { timeout: 60_000 }, async () => {
  const token = Math.random().toString(36).slice(2)
  const customData = Math.random().toString(36).slice(2)

  const runId = await triggerE2eWorkflow('hookWorkflow', [token, customData])
  await waitForHookByToken(token)

  const res = await fetch(
    `${NEXT_URL}/.well-known/workflow/v1/webhook/${encodeURIComponent(token)}`,
    { method: 'POST', body: JSON.stringify({ message: 'should-be-rejected' }) }
  )
  assert.equal(res.status, 404)

  await resumeHook(token, { message: 'via-server', customData, done: true })

  const run = await waitForRunStatus(runId, 'completed', 30_000)
  assert.equal(run.status, 'completed')
})

test('hookCleanupTest: hook token reuse after workflow completion', { timeout: 90_000 }, async () => {
  const token = Math.random().toString(36).slice(2)
  const customData = Math.random().toString(36).slice(2)

  const runId1 = await triggerE2eWorkflow('hookCleanupTestWorkflow', [token, customData])
  await waitForHookByToken(token)

  await resumeHook(token, { message: 'test-message-1', customData })
  await waitForRunStatus(runId1, 'completed', 30_000)

  await triggerE2eWorkflow('hookCleanupTestWorkflow', [token, customData])

  await sleep(3_000)
  await waitForHookByToken(token)

  await resumeHook(token, { message: 'test-message-2', customData })
  const hook2 = await waitForHookByToken(token)
  const run2 = await waitForRunStatus(hook2.runId, 'completed', 30_000)
  assert.equal(run2.status, 'completed')
})

test('concurrent hook token conflict: two workflows cannot use same token', { timeout: 60_000 }, async () => {
  const token = Math.random().toString(36).slice(2)
  const customData = Math.random().toString(36).slice(2)

  const runId1 = await triggerE2eWorkflow('hookCleanupTestWorkflow', [token, customData])
  await waitForHookByToken(token)

  const runId2 = await triggerE2eWorkflow('hookCleanupTestWorkflow', [token, customData])

  const run2 = await waitForRunStatus(runId2, 'failed', 30_000)
  assert.equal(run2.status, 'failed')

  await resumeHook(token, { message: 'test-concurrent', customData })
  const run1 = await waitForRunStatus(runId1, 'completed', 30_000)
  assert.equal(run1.status, 'completed')
})

// Requires TC39 explicit resource management (`using` keyword) for auto-hook-disposal on block exit.
test.skip('hookDisposeTest: hook token reuse after explicit disposal while running', { timeout: 90_000 }, async () => {
  const token = Math.random().toString(36).slice(2)
  const customData = Math.random().toString(36).slice(2)

  const runId1 = await triggerE2eWorkflow('hookDisposeTestWorkflow', [token, customData])
  await waitForHookByToken(token)

  await resumeHook(token, { message: 'first-payload', customData })
  await sleep(3_000)

  const runId2 = await triggerE2eWorkflow('hookDisposeTestWorkflow', [token, customData])
  await sleep(5_000)
  await waitForHookByToken(token)

  await resumeHook(token, { message: 'second-payload', customData })

  const run1 = await waitForRunStatus(runId1, 'completed', 30_000)
  assert.equal(run1.status, 'completed')
  const run2 = await waitForRunStatus(runId2, 'completed', 30_000)
  assert.equal(run2.status, 'completed')
})

// ---- Webhooks ----

// respondWith: 'manual' uses a TransformStream that doesn't work cross-process.
test.skip('webhookWorkflow: HTTP-triggered resume with 3 webhook types', { timeout: 60_000 }, async () => {
  const runId = await triggerE2eWorkflow('webhookWorkflow')
  await sleep(5_000)
  const hooks = await getHooksByRunId(runId)
  assert.ok(hooks.length >= 3, `Expected 3 hooks, got ${hooks.length}`)
})

test('webhook route with invalid token returns 404', { timeout: 10_000 }, async () => {
  const res = await fetch(
    `${NEXT_URL}/.well-known/workflow/v1/webhook/${encodeURIComponent('invalid-token')}`,
    { method: 'POST', body: JSON.stringify({}) }
  )
  assert.equal(res.status, 404)
})

// ---- Cancel ----

test('cancelRun: cancelling a running workflow', { timeout: 60_000 }, async () => {
  const runId = await triggerE2eWorkflow('sleepingWorkflow')
  await sleep(3_000)
  await cancelRun(runId)
  const run = await waitForRunStatus(runId, 'cancelled', 15_000)
  assert.equal(run.status, 'cancelled')
})

// ---- Sleep + concurrent patterns (void sleep blocks completion cross-process) ----

// `void sleep('1d')` creates a forever-pending wait that blocks workflow completion.
test.skip('hookWithSleep: hook payloads delivered correctly with concurrent sleep', { timeout: 90_000 }, async () => {
  const token = Math.random().toString(36).slice(2)

  const runId = await triggerE2eWorkflow('hookWithSleepWorkflow', [token])
  await waitForHookByToken(token)

  await resumeHook(token, { type: 'subscribe', id: 1 })
  await sleep(3_000)

  await resumeHook(token, { type: 'subscribe', id: 2 })
  await sleep(3_000)

  await resumeHook(token, { type: 'done', done: true })

  const run = await waitForRunStatus(runId, 'completed', 30_000)
  assert.equal(run.status, 'completed')
})

test.skip('sleepWithSequentialSteps: sequential steps work with concurrent sleep', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('sleepWithSequentialStepsWorkflow')
  assert.deepEqual(result, { a: 3, b: 6, c: 10, shouldCancel: false })
})

// ---- Health checks ----

test('health check endpoint (HTTP): flow and step endpoints respond', { timeout: 30_000 }, async () => {
  const flowRes = await fetch(`${NEXT_URL}/.well-known/workflow/v1/flow?__health`, {
    method: 'POST',
  })
  assert.equal(flowRes.status, 200)
  const flowBody = await flowRes.text()
  assert.ok(flowBody.includes('healthy'), `Expected health response, got: ${flowBody}`)

  const stepRes = await fetch(`${NEXT_URL}/.well-known/workflow/v1/step?__health`, {
    method: 'POST',
  })
  assert.equal(stepRes.status, 200)
  const stepBody = await stepRes.text()
  assert.ok(stepBody.includes('healthy'), `Expected health response, got: ${stepBody}`)
})
