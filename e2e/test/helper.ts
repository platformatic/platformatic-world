import assert from 'node:assert/strict'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const WORKFLOW_ROOT = join(ROOT, '..', 'packages', 'workflow')

// Random ports per run avoid races with the kernel's TIME_WAIT on a fixed
// port across back-to-back test invocations (EADDRINUSE on :::PORT).
function pickPort (): number {
  return 30_000 + Math.floor(Math.random() * 20_000)
}
export const WF_PORT = pickPort()
export const NEXT_PORT = pickPort()
export const WF_URL = `http://localhost:${WF_PORT}`
export const NEXT_URL = `http://localhost:${NEXT_PORT}`
export const DEPLOYMENT_VERSION = 'e2e-test'
export const DB_URL = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'

export interface SpawnedProcess {
  proc: ReturnType<typeof spawn>
  kill: () => void
}

export function startProcess (cmd: string, args: string[], env: Record<string, string>, cwd: string): SpawnedProcess {
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

export async function waitForReady (url: string, timeoutMs = 60_000): Promise<void> {
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

export async function waitForRunStatus (runId: string, status: string, timeoutMs = 60_000): Promise<any> {
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

export async function getHooksByRunId (runId: string): Promise<any[]> {
  const res = await fetch(`${WF_URL}/api/v1/apps/default/hooks?runId=${runId}`)
  assert.equal(res.status, 200)
  const { data } = await res.json() as { data: any[] }
  return data
}

export async function waitForHookByToken (token: string, timeoutMs = 15_000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${WF_URL}/api/v1/apps/default/hooks/by-token/${encodeURIComponent(token)}`)
    if (res.ok) return await res.json()
    await sleep(500)
  }
  throw new Error(`Timed out waiting for hook with token ${token}`)
}

// Lazy-loaded SDK function (require world to be configured first)
let sdkResumeHook: ((tokenOrHook: any, payload: any) => Promise<any>) | undefined

export async function loadSdkHookFunctions (): Promise<void> {
  if (sdkResumeHook) return
  const api = await import('workflow/api')
  sdkResumeHook = api.resumeHook
}

export async function resumeHook (tokenOrHook: any, payload: any): Promise<any> {
  return sdkResumeHook(tokenOrHook, payload)
}

export async function cancelRun (runId: string): Promise<void> {
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

export async function triggerE2eWorkflow (workflow: string, args: any[] = []): Promise<string> {
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

export async function runE2eWorkflow (workflow: string, args: any[] = []): Promise<{ runId: string, result: any }> {
  const res = await fetch(`${NEXT_URL}/api/trigger-e2e`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow, args, waitForResult: true }),
  })
  assert.equal(res.status, 200, `trigger ${workflow} failed: ${res.status}`)
  return await res.json() as { runId: string, result: any }
}

export async function registerHandlers (): Promise<void> {
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

export function killPort (port: number) {
  try {
    if (process.platform === 'darwin') {
      execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' })
    } else {
      execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' })
    }
  } catch {}
}

// `killPort` sends SIGKILL but the OS holds the socket briefly. Block until
// a fresh bind would succeed so the next spawn doesn't race into EADDRINUSE.
// Next.js binds on `::` (dual-stack) and wattpm on `0.0.0.0`; we probe both
// sequentially because concurrent binds on the same port on IPv4 + IPv6
// self-collide on Linux where `::` is dual-stack by default.
export async function waitForPortFree (port: number, timeoutMs = 10_000): Promise<void> {
  const net = await import('node:net')
  const probe = (host: string) => new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await probe('0.0.0.0') && await probe('::')) return
    await sleep(200)
  }
  throw new Error(`Port ${port} still in use after ${timeoutMs}ms`)
}

export async function triggerPagesWorkflow (workflowFn: string, args: any[] = []): Promise<string> {
  const url = new URL('/api/trigger-pages', NEXT_URL)
  url.searchParams.set('workflowFn', workflowFn)
  if (args.length > 0) {
    url.searchParams.set('args', args.map(String).join(','))
  }
  const res = await fetch(url, { method: 'POST' })
  assert.equal(res.status, 200, `trigger-pages ${workflowFn} failed: ${res.status}`)
  const { runId } = await res.json() as { runId: string }
  assert.ok(runId, `${workflowFn} should return a runId`)
  return runId
}

export async function setup (): Promise<{ wfService: SpawnedProcess, nextApp: SpawnedProcess }> {
  // Kill any leftover processes on our ports. Tests run with metrics
  // disabled (watt-test.json), so 9090 is not ours to claim — an external
  // wattpm on the dev machine may legitimately hold it.
  killPort(WF_PORT)
  killPort(NEXT_PORT)
  await waitForPortFree(WF_PORT)
  await waitForPortFree(NEXT_PORT)

  // 1. Start the workflow service in single-tenant mode via Watt.
  // watt-test.json disables runtime.metrics (otherwise wattpm tries to bind
  // 9090 and logs a FATAL when another process holds it).
  const wfService = startProcess('npx', ['wattpm', 'start', '-c', 'watt-test.json'], {
    DATABASE_URL: DB_URL,
    PORT: String(WF_PORT),
  }, WORKFLOW_ROOT)

  await waitForReady(`${WF_URL}/api/v1/apps/default/runs`)

  // 2. Clean up stale data from any previous test runs
  const { default: pg } = await import('pg')
  const client = new pg.Client(DB_URL)
  await client.connect()
  await client.query('TRUNCATE workflow_events, workflow_hooks, workflow_queue_messages, workflow_steps, workflow_waits, workflow_stream_chunks, workflow_runs, workflow_queue_handlers CASCADE')
  await client.end()

  // 3. Start the Next.js app (already built)
  const nextApp = startProcess('npx', ['next', 'start', '-p', String(NEXT_PORT)], {
    WORKFLOW_TARGET_WORLD: '@platformatic/world',
    PLT_WORLD_SERVICE_URL: WF_URL,
    PLT_WORLD_APP_ID: 'default',
    PLT_WORLD_DEPLOYMENT_VERSION: DEPLOYMENT_VERSION,
  }, ROOT)

  await waitForReady(NEXT_URL)

  // 4. Register queue handlers
  await registerHandlers()

  // 5. Configure the world for SDK functions in the test process
  process.env.WORKFLOW_TARGET_WORLD = '@platformatic/world'
  process.env.PLT_WORLD_SERVICE_URL = WF_URL
  process.env.PLT_WORLD_APP_ID = 'default'
  process.env.PLT_WORLD_DEPLOYMENT_VERSION = DEPLOYMENT_VERSION
  await loadSdkHookFunctions()

  return { wfService, nextApp }
}

export async function teardown (wfService: SpawnedProcess, nextApp: SpawnedProcess) {
  nextApp?.kill()
  wfService?.kill()
  // Wait for the kernel to release the ports so the next test run starts
  // clean. Without this, back-to-back `npm run test:e2e` invocations race
  // into EADDRINUSE before TIME_WAIT expires.
  try {
    await waitForPortFree(WF_PORT, 5000)
    await waitForPortFree(NEXT_PORT, 5000)
  } catch {}
}
