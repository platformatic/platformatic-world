// Test scenarios adapted from Vercel's workflow SDK e2e suite.
// Original: https://github.com/vercel/workflow (Apache-2.0 license)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const WORKFLOW_ROOT = join(ROOT, '..', 'packages', 'workflow')

const WF_PORT = 23_042
const NEXT_PORT = 23_456
const WF_URL = `http://localhost:${WF_PORT}`
const NEXT_URL = `http://localhost:${NEXT_PORT}`
const DEPLOYMENT_VERSION = 'e2e-test'
const DB_URL = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'

interface SpawnedProcess {
  proc: ReturnType<typeof spawn>
  kill: () => void
}

function startProcess (cmd: string, args: string[], env: Record<string, string>, cwd: string): SpawnedProcess {
  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${cmd}] ${d}`))
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${cmd}] ${d}`))

  return {
    proc,
    kill () {
      try {
        process.kill(-proc.pid!, 'SIGKILL')
      } catch {
        // Process already dead
      }
    },
  }
}

async function waitForReady (url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function waitForRunStatus (runId: string, status: string, timeoutMs = 30_000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${WF_URL}/api/v1/apps/default/runs/${runId}`)
    if (res.ok) {
      const run = await res.json()
      if (run.status === status) return run
      if (status !== 'failed' && status !== 'cancelled') {
        if (run.status === 'failed' || run.status === 'cancelled') {
          throw new Error(`Run ${runId} reached terminal state: ${run.status} — ${JSON.stringify(run.error)}`)
        }
      }
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for run ${runId} to reach status ${status}`)
}

async function getHooksByRunId (runId: string): Promise<any[]> {
  const res = await fetch(`${WF_URL}/api/v1/apps/default/hooks?runId=${runId}`)
  assert.equal(res.status, 200)
  const { data } = await res.json() as { data: any[] }
  return data
}

async function waitForHookByToken (token: string, timeoutMs = 15_000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${WF_URL}/api/v1/apps/default/hooks/by-token/${encodeURIComponent(token)}`)
    if (res.ok) return await res.json()
    await sleep(500)
  }
  throw new Error(`Timed out waiting for hook with token ${token}`)
}

// Lazy-loaded SDK function (require world to be configured first)
let sdkResumeHook: (tokenOrHook: any, payload: any) => Promise<any>

async function loadSdkHookFunctions (): Promise<void> {
  if (sdkResumeHook) return
  const api = await import('workflow/api')
  sdkResumeHook = api.resumeHook
}

async function cancelRun (runId: string): Promise<void> {
  const res = await fetch(`${WF_URL}/api/v1/apps/default/runs/${runId}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventType: 'run_cancelled',
      correlationId: runId,
      eventData: {},
    }),
  })
  assert.equal(res.status, 200, `Cancel run failed: ${res.status}`)
}

async function triggerE2eWorkflow (workflow: string, args: any[] = []): Promise<string> {
  const res = await fetch(`${NEXT_URL}/api/trigger-e2e`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow, args }),
  })
  assert.equal(res.status, 200, `trigger ${workflow} failed: ${res.status}`)
  const { runId } = await res.json() as { runId: string }
  assert.ok(runId, `${workflow} should return a runId`)
  return runId
}

async function runE2eWorkflow (workflow: string, args: any[] = []): Promise<{ runId: string, result: any }> {
  const res = await fetch(`${NEXT_URL}/api/trigger-e2e`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow, args, waitForResult: true }),
  })
  assert.equal(res.status, 200, `trigger ${workflow} failed: ${res.status}`)
  return await res.json() as { runId: string, result: any }
}

async function registerHandlers (): Promise<void> {
  const res = await fetch(`${WF_URL}/api/v1/apps/default/handlers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      podId: 'e2e-test-pod',
      deploymentVersion: DEPLOYMENT_VERSION,
      endpoints: {
        workflow: `${NEXT_URL}/.well-known/workflow/v1/flow`,
        step: `${NEXT_URL}/.well-known/workflow/v1/step`,
        webhook: `${NEXT_URL}/.well-known/workflow/v1/webhook`,
      },
    }),
  })
  if (!res.ok) {
    throw new Error(`Failed to register handlers: ${res.status} ${await res.text()}`)
  }
}

let wfService: SpawnedProcess
let nextApp: SpawnedProcess

before(async () => {
  // 1. Start the workflow service in single-tenant mode (runs migrations, creates tables)
  wfService = startProcess('node', ['src/server.ts'], {
    DATABASE_URL: DB_URL,
    PORT: String(WF_PORT),
  }, WORKFLOW_ROOT)

  await waitForReady(`${WF_URL}/status`)

  // 2. Clean up stale data from any previous test runs (tables exist after migrations)
  const { default: pg } = await import('pg')
  const client = new pg.Client(DB_URL)
  await client.connect()
  await client.query('TRUNCATE workflow_events, workflow_hooks, workflow_queue_messages, workflow_steps, workflow_waits, workflow_stream_chunks, workflow_runs, workflow_queue_handlers CASCADE')
  await client.end()

  // 3. Start the Next.js app (already built)
  nextApp = startProcess('npx', ['next', 'start', '-p', String(NEXT_PORT)], {
    WORKFLOW_TARGET_WORLD: '@platformatic/world',
    PLT_WORLD_SERVICE_URL: WF_URL,
    PLT_WORLD_APP_ID: 'default',
    PLT_WORLD_DEPLOYMENT_VERSION: DEPLOYMENT_VERSION,
  }, ROOT)

  await waitForReady(NEXT_URL)

  // 4. Register queue handlers so the workflow service knows where to dispatch
  await registerHandlers()

  // 5. Configure the world for hook/webhook SDK functions in the test process
  process.env.WORKFLOW_TARGET_WORLD = '@platformatic/world'
  process.env.PLT_WORLD_SERVICE_URL = WF_URL
  process.env.PLT_WORLD_APP_ID = 'default'
  process.env.PLT_WORLD_DEPLOYMENT_VERSION = DEPLOYMENT_VERSION
  await loadSdkHookFunctions()
}, { timeout: 60_000 })

after(() => {
  nextApp?.kill()
  wfService?.kill()
})

test('trigger workflow and verify it completes', { timeout: 30_000 }, async () => {
  const triggerRes = await fetch(`${NEXT_URL}/api/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Platformatic' }),
  })

  assert.equal(triggerRes.status, 200)
  const { runId } = await triggerRes.json() as { runId: string }
  assert.ok(runId, 'should return a runId')

  // Wait for the run to complete
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

// ---- Vercel e2e compatibility tests ----

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
  // 10 parallel 1s sleeps should complete in ~2-3s, not 10s
  assert.ok(elapsed < 8_000, `parallel sleeps should overlap, took ${elapsed}ms`)
})

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

test('errorRetry: step retries until success', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('errorRetrySuccessWorkflow')
  assert.equal(result.finalAttempt, 3)
})

test('errorFatal: no retries on FatalError', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('errorFatalWorkflow')
  assert.equal(result.caught, true)
  assert.equal(result.message, 'Fatal step error')
})

test('spawnWorkflowFromStep: child workflow', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('spawnWorkflowFromStepWorkflow', [7])
  assert.equal(result.parentInput, 7)
  assert.equal(result.childResult.childResult, 14)
  assert.ok(result.childRunId)
})

// ---- New e2e tests ----

test('promiseAny: one step fails, others succeed', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('promiseAnyWorkflow')
  assert.equal(result, 'B')
})

test('promiseRace stress test: 5 concurrent races', { timeout: 120_000 }, async () => {
  const { result } = await runE2eWorkflow('promiseRaceStressTestWorkflow')
  assert.deepEqual([...result].sort((a: number, b: number) => a - b), [0, 1, 2, 3, 4])
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

test('errorWorkflowNested: nested error causes workflow to fail', { timeout: 30_000 }, async () => {
  const runId = await triggerE2eWorkflow('errorWorkflowNested')
  const run = await waitForRunStatus(runId, 'failed', 30_000)
  assert.equal(run.status, 'failed')
})

test('errorStepBasic: step error caught in workflow', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('errorStepBasic')
  assert.equal(result.caught, true)
  assert.ok(result.message.includes('Step error message'), `Expected "Step error message" in: ${result.message}`)
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

test('errorFatalCatchable: FatalError can be caught with FatalError.is()', { timeout: 30_000 }, async () => {
  const { result } = await runE2eWorkflow('errorFatalCatchable')
  assert.equal(result.caught, true)
  assert.equal(result.isFatal, true)
})

test('stepFunctionPassing: step fn reference passed as argument', { timeout: 60_000 }, async () => {
  const { result } = await runE2eWorkflow('stepFunctionPassingWorkflow')
  // doubleNumber(10) = 20, then * 2 = 40
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
  // 10 * 2 * 3 * 5 = 300
  assert.equal(result, 300)
})

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

// ---- Hook/Webhook tests (require mid-workflow interaction) ----

test('hookWorkflow: pause and resume via hook API', { timeout: 60_000 }, async () => {
  const token = Math.random().toString(36).slice(2)
  const customData = Math.random().toString(36).slice(2)

  const runId = await triggerE2eWorkflow('hookWorkflow', [token, customData])

  // Wait for hook to be registered
  await waitForHookByToken(token)

  // Resume with first payload using SDK (pass token string)
  await sdkResumeHook(token, { message: 'one', customData })
  await sleep(3_000)

  // Resume with second payload
  await sdkResumeHook(token, { message: 'two', customData })
  await sleep(3_000)

  // Resume with third payload (done=true to break the loop)
  await sdkResumeHook(token, { message: 'three', customData, done: true })

  const run = await waitForRunStatus(runId, 'completed', 30_000)
  assert.equal(run.status, 'completed')
})

// respondWith: 'manual' uses a TransformStream to pipe the webhook HTTP request body into
// the workflow execution context. This only works when the webhook route handler and the
// workflow run in the same process (as in Vercel's deployment model). In our architecture
// the queue dispatcher delivers work via HTTP to a separate Next.js process, so the
// TransformStream cannot be shared. The default (202) and static (e.g. 402) response modes
// work fine cross-process — only 'manual' is affected.
// See: https://github.com/vercel/workflow/blob/main/packages/core/e2e/e2e.test.ts
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

test('hookCleanupTest: hook token reuse after workflow completion', { timeout: 90_000 }, async () => {
  const token = Math.random().toString(36).slice(2)
  const customData = Math.random().toString(36).slice(2)

  // Start first workflow
  const runId1 = await triggerE2eWorkflow('hookCleanupTestWorkflow', [token, customData])
  await waitForHookByToken(token)

  // Resume first workflow using SDK
  await sdkResumeHook(token, { message: 'test-message-1', customData })
  await waitForRunStatus(runId1, 'completed', 30_000)

  // Start second workflow with same token (should work since first completed)
  await triggerE2eWorkflow('hookCleanupTestWorkflow', [token, customData])

  // Wait for the new hook to appear (old one was cleaned up)
  await sleep(3_000)
  await waitForHookByToken(token)

  // Resume second workflow using SDK
  await sdkResumeHook(token, { message: 'test-message-2', customData })
  const hook2 = await waitForHookByToken(token)
  const run2 = await waitForRunStatus(hook2.runId, 'completed', 30_000)
  assert.equal(run2.status, 'completed')
})

test('cancelRun: cancelling a running workflow', { timeout: 60_000 }, async () => {
  // Start a long-running workflow (30s sleep)
  const runId = await triggerE2eWorkflow('sleepingWorkflow')

  // Wait for it to start
  await sleep(3_000)

  // Cancel it
  await cancelRun(runId)

  // Verify it was cancelled
  const run = await waitForRunStatus(runId, 'cancelled', 15_000)
  assert.equal(run.status, 'cancelled')
})
