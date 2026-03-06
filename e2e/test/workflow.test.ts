import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const WORKFLOW_ROOT = join(ROOT, '..', 'packages', 'workflow')

const WF_PORT = 3042
const NEXT_PORT = 3456
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
        // Kill process group to ensure all children are terminated
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
      if (run.status === 'failed' || run.status === 'cancelled') {
        throw new Error(`Run ${runId} reached terminal state: ${run.status} — ${JSON.stringify(run.error)}`)
      }
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for run ${runId} to reach status ${status}`)
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
  // 1. Start the workflow service in single-tenant mode
  wfService = startProcess('node', ['src/server.ts'], {
    DATABASE_URL: DB_URL,
    PORT: String(WF_PORT),
  }, WORKFLOW_ROOT)

  await waitForReady(`${WF_URL}/status`)

  // 2. Start the Next.js app (already built)
  nextApp = startProcess('npx', ['next', 'start', '-p', String(NEXT_PORT)], {
    WORKFLOW_TARGET_WORLD: '@platformatic/world',
    PLT_WORLD_SERVICE_URL: WF_URL,
    PLT_WORLD_APP_ID: 'default',
    PLT_WORLD_DEPLOYMENT_VERSION: DEPLOYMENT_VERSION,
  }, ROOT)

  await waitForReady(NEXT_URL)

  // 3. Register queue handlers so the workflow service knows where to dispatch
  await registerHandlers()
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
