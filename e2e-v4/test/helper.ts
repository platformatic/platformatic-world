// Minimal e2e harness for the v4-SDK workbench.

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createServer } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const WORKFLOW_ROOT = join(ROOT, '..', 'packages', 'workflow')

export const DEPLOYMENT_VERSION = 'e2e-v4-test'
export const DB_URL = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'

export interface E2eContext {
  wfUrl: string
  nextUrl: string
  kill: () => void
}

function pickFreePort (): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, () => {
      const port = (srv.address() as any).port
      srv.close(() => resolve(port))
    })
  })
}

function startProcess (cmd: string, args: string[], env: Record<string, string>, cwd: string) {
  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${cmd}] ${d}`))
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${cmd}] ${d}`))
  return proc
}

async function waitForReady (url: string, timeoutMs = 60_000, acceptAny = false): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok || acceptAny) return
    } catch {}
    await sleep(500)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

export async function waitForRunStatus (wfUrl: string, runId: string, status: string, timeoutMs = 30_000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${wfUrl}/api/v1/apps/default/runs/${runId}`)
    if (res.ok) {
      const run = await res.json() as any
      if (run.status === status) return run
      if (status !== 'failed' && status !== 'cancelled' &&
          (run.status === 'failed' || run.status === 'cancelled')) {
        throw new Error(`Run ${runId} reached terminal state ${run.status}: ${JSON.stringify(run.error)}`)
      }
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for run ${runId} -> ${status}`)
}

export async function waitForHookByToken (wfUrl: string, token: string, timeoutMs = 15_000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${wfUrl}/api/v1/apps/default/hooks/by-token/${encodeURIComponent(token)}`)
    if (res.ok) return res.json()
    await sleep(250)
  }
  throw new Error(`Timed out waiting for hook token ${token}`)
}

// Hook resume needs the SDK's own payload serialization (devalue framing).
// Posting the event via plain HTTP from the test process would skip that
// and the workflow replay wouldn't be able to decode the resume payload.
let sdkResumeHook: ((tokenOrHook: any, payload: any) => Promise<any>) | undefined

export async function configureWorldFromEnvAndLoadSdk (wfUrl: string, deploymentVersion: string): Promise<void> {
  process.env.WORKFLOW_TARGET_WORLD = '@platformatic/world'
  process.env.PLT_WORLD_SERVICE_URL = wfUrl
  process.env.PLT_WORLD_APP_ID = 'default'
  process.env.PLT_WORLD_DEPLOYMENT_VERSION = deploymentVersion
  if (sdkResumeHook) return
  const api = await import('workflow/api')
  sdkResumeHook = api.resumeHook
}

export async function resumeHook (token: string, payload: any): Promise<any> {
  if (!sdkResumeHook) throw new Error('configureWorldFromEnvAndLoadSdk() must be called first')
  return sdkResumeHook(token, payload)
}

export async function setup (): Promise<E2eContext> {
  const wfPort = await pickFreePort()
  const nextPort = await pickFreePort()
  const wfUrl = `http://localhost:${wfPort}`
  const nextUrl = `http://localhost:${nextPort}`

  const wf = startProcess('npx', ['wattpm', 'start', '-c', 'watt-test.json'], {
    DATABASE_URL: DB_URL,
    PORT: String(wfPort),
  }, WORKFLOW_ROOT)
  await waitForReady(`${wfUrl}/api/v1/apps/default/runs`)

  const { default: pg } = await import('pg')
  const client = new pg.Client(DB_URL)
  await client.connect()
  await client.query('TRUNCATE workflow_events, workflow_hooks, workflow_queue_messages, workflow_steps, workflow_waits, workflow_stream_chunks, workflow_runs, workflow_queue_handlers CASCADE')
  await client.end()

  const next = startProcess('npx', ['next', 'start', '-p', String(nextPort)], {
    WORKFLOW_TARGET_WORLD: '@platformatic/world',
    PLT_WORLD_SERVICE_URL: wfUrl,
    PLT_WORLD_APP_ID: 'default',
    PLT_WORLD_DEPLOYMENT_VERSION: DEPLOYMENT_VERSION,
  }, ROOT)
  await waitForReady(nextUrl, 60_000, true)

  const res = await fetch(`${wfUrl}/api/v1/apps/default/handlers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      podId: 'e2e-v4-pod',
      deploymentVersion: DEPLOYMENT_VERSION,
      endpoints: {
        workflow: `${nextUrl}/.well-known/workflow/v1/flow`,
        step: `${nextUrl}/.well-known/workflow/v1/step`,
        webhook: `${nextUrl}/.well-known/workflow/v1/webhook`,
      },
    }),
  })
  if (!res.ok) throw new Error(`Failed to register handlers: ${res.status}`)

  return {
    wfUrl,
    nextUrl,
    kill () {
      try { process.kill(-next.pid!, 'SIGKILL') } catch {}
      try { process.kill(-wf.pid!, 'SIGKILL') } catch {}
    },
  }
}
