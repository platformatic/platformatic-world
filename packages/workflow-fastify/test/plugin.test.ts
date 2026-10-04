import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import workflowFastify from '../src/index.ts'

// Build a throwaway `.well-known/workflow/v1` tree with tiny stand-in handlers:
// flow/step as CommonJS (as the real standalone build emits them) and webhook as
// ESM. Each handler echoes what it received so we can assert the Fastify <-> Web
// request/response adaptation done by the plugin.
async function makeBuildDir () {
  const dir = await mkdtemp(join(tmpdir(), 'wf-fastify-'))
  const base = join(dir, '.well-known/workflow/v1')
  await mkdir(base, { recursive: true })

  const cjs = (label: string) => `
'use strict'
module.exports.POST = async (req) => {
  const body = await req.text()
  return new Response(JSON.stringify({ handler: '${label}', method: req.method, body }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-handler': '${label}' }
  })
}
`
  const esm = `
export const POST = async (req) => {
  const url = new URL(req.url)
  return new Response(JSON.stringify({ handler: 'webhook', method: req.method, path: url.pathname }), {
    status: 202,
    headers: { 'content-type': 'application/json', 'x-handler': 'webhook' }
  })
}
`
  await writeFile(join(base, 'flow.js'), cjs('flow'))
  await writeFile(join(base, 'step.js'), cjs('step'))
  await writeFile(join(base, 'webhook.js'), esm)
  await writeFile(join(base, 'manifest.json'), JSON.stringify({
    version: '1',
    workflows: {
      'workflows/signup.ts': {
        handleSignup: { workflowId: 'workflow//./workflows/signup//handleSignup' }
      }
    }
  }))
  return dir
}

async function buildApp (buildDir: string) {
  const app = Fastify()
  await app.register(workflowFastify, { buildDir, register: false })
  return app
}

test('mounts flow handler and adapts request body + response', async (t) => {
  const dir = await makeBuildDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp(dir)
  t.after(() => app.close())

  const res = await app.inject({
    method: 'POST',
    url: '/.well-known/workflow/v1/flow',
    payload: 'hello-flow',
    headers: { 'content-type': 'application/octet-stream' }
  })

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(res.headers['x-handler'], 'flow')
  const json = res.json()
  assert.strictEqual(json.handler, 'flow')
  assert.strictEqual(json.method, 'POST')
  assert.strictEqual(json.body, 'hello-flow')
})

test('mounts step handler (CommonJS) and forwards body', async (t) => {
  const dir = await makeBuildDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp(dir)
  t.after(() => app.close())

  const res = await app.inject({
    method: 'POST',
    url: '/.well-known/workflow/v1/step',
    payload: 'run-step'
  })

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(res.json().handler, 'step')
  assert.strictEqual(res.json().body, 'run-step')
})

test('mounts webhook handler (ESM) on GET and POST', async (t) => {
  const dir = await makeBuildDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp(dir)
  t.after(() => app.close())

  const post = await app.inject({ method: 'POST', url: '/.well-known/workflow/v1/webhook/tok123', payload: 'x' })
  assert.strictEqual(post.statusCode, 202)
  assert.strictEqual(post.json().handler, 'webhook')
  assert.strictEqual(post.json().path, '/.well-known/workflow/v1/webhook/tok123')

  const get = await app.inject({ method: 'GET', url: '/.well-known/workflow/v1/webhook/tok123' })
  assert.strictEqual(get.statusCode, 202)
  assert.strictEqual(get.json().method, 'GET')
})

test('serves the manifest', async (t) => {
  const dir = await makeBuildDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp(dir)
  t.after(() => app.close())

  const res = await app.inject({ method: 'GET', url: '/.well-known/workflow/v1/manifest.json' })
  assert.strictEqual(res.statusCode, 200)
  assert.match(res.headers['content-type'] as string, /application\/json/)
  assert.strictEqual(res.json().workflows['workflows/signup.ts'].handleSignup.workflowId,
    'workflow//./workflows/signup//handleSignup')
})

test('decorates the app with workflows (name -> workflowId) and the manifest', async (t) => {
  const dir = await makeBuildDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp(dir)
  t.after(() => app.close())
  await app.ready()

  assert.strictEqual(app.workflows.handleSignup, 'workflow//./workflows/signup//handleSignup')
  assert.strictEqual(app.workflowManifest.version, '1')
})

test('raw-body parser stays encapsulated: parent JSON routes are unaffected', async (t) => {
  const dir = await makeBuildDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp(dir)
  t.after(() => app.close())
  // A sibling route on the parent must still parse JSON normally even though the
  // plugin registers a catch-all buffer parser for its callback routes.
  app.post('/api/echo', async (req) => ({ got: req.body }))
  await app.ready()

  const res = await app.inject({
    method: 'POST',
    url: '/api/echo',
    payload: { email: 'a@b.c' },
    headers: { 'content-type': 'application/json' }
  })
  assert.strictEqual(res.statusCode, 200)
  assert.deepStrictEqual(res.json(), { got: { email: 'a@b.c' } })
})

test('throws a clear error when a handler has no POST export', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-fastify-bad-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const base = join(dir, '.well-known/workflow/v1')
  await mkdir(base, { recursive: true })
  await writeFile(join(base, 'flow.js'), 'module.exports = {}\n')
  await writeFile(join(base, 'step.js'), 'module.exports.POST = async () => new Response("ok")\n')
  await writeFile(join(base, 'webhook.js'), 'export const POST = async () => new Response("ok")\n')

  const app = Fastify()
  t.after(() => app.close())
  await assert.rejects(
    app.register(workflowFastify, { buildDir: dir, register: false }).ready(),
    /workflow handler flow has no POST export/
  )
})

test('loads native ESM .mjs handlers (v5 standalone build)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-fastify-mjs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const base = join(dir, '.well-known/workflow/v1')
  await mkdir(base, { recursive: true })
  const mjs = (label: string, status: number) => `
export const POST = async (req) => new Response(JSON.stringify({ handler: '${label}', method: req.method }), {
  status: ${status},
  headers: { 'content-type': 'application/json', 'x-handler': '${label}' }
})
`
  await writeFile(join(base, 'flow.mjs'), mjs('flow', 200))
  await writeFile(join(base, 'step.mjs'), mjs('step', 200))
  await writeFile(join(base, 'webhook.mjs'), mjs('webhook', 202))
  await writeFile(join(base, 'manifest.json'), JSON.stringify({ workflows: {} }))

  const app = await buildApp(dir)
  t.after(() => app.close())

  const flow = await app.inject({ method: 'POST', url: '/.well-known/workflow/v1/flow', payload: 'x' })
  assert.strictEqual(flow.statusCode, 200)
  assert.strictEqual(flow.json().handler, 'flow')

  const hook = await app.inject({ method: 'GET', url: '/.well-known/workflow/v1/webhook/abc' })
  assert.strictEqual(hook.statusCode, 202)
})

test('defaults buildDir to the working directory and tolerates a manifest without workflows', async (t) => {
  const dir = await makeBuildDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, '.well-known/workflow/v1/manifest.json'), JSON.stringify({ version: '1' }))

  const originalCwd = process.cwd()
  process.chdir(dir)
  t.after(() => process.chdir(originalCwd))

  const app = Fastify()
  t.after(() => app.close())
  await app.register(workflowFastify, { register: false })
  await app.ready()

  assert.deepStrictEqual(app.workflows, {})
  assert.strictEqual(app.workflowManifest.version, '1')
})

test('throws a clear error when a handler bundle is missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-fastify-missing-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, '.well-known/workflow/v1'), { recursive: true })

  const app = Fastify()
  t.after(() => app.close())
  await assert.rejects(
    app.register(workflowFastify, { buildDir: dir, register: false }).ready(),
    // The three bundles load in parallel, so any of them may be reported first.
    /workflow handler (flow|step|webhook) not found in/
  )
})

test('forwards multi-value headers joined and skips unset ones', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-fastify-headers-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const base = join(dir, '.well-known/workflow/v1')
  await mkdir(base, { recursive: true })
  const echo = `
export const POST = async (req) => Response.json({
  multi: req.headers.get('x-multi'),
  unset: req.headers.has('x-unset')
})
`
  await writeFile(join(base, 'flow.mjs'), echo)
  await writeFile(join(base, 'step.mjs'), echo)
  await writeFile(join(base, 'webhook.mjs'), echo)
  await writeFile(join(base, 'manifest.json'), JSON.stringify({ workflows: {} }))

  const app = Fastify()
  t.after(() => app.close())
  // A host-app hook can leave a header as an array or clear it to undefined.
  app.addHook('onRequest', async (req) => {
    req.headers['x-multi'] = ['a', 'b']
    req.headers['x-unset'] = undefined
  })
  await app.register(workflowFastify, { buildDir: dir, register: false })

  const res = await app.inject({ method: 'POST', url: '/.well-known/workflow/v1/flow', payload: 'x' })
  assert.deepStrictEqual(res.json(), { multi: 'a, b', unset: false })
})

test('registers with the workflow service on ready and closes the world on close', async (t) => {
  const dir = await makeBuildDir()
  t.after(() => rm(dir, { recursive: true, force: true }))

  const registrations: any[] = []
  const service = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => {
      registrations.push({ url: req.url, body: JSON.parse(body) })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => service.close(() => resolve())))
  const { port } = service.address() as AddressInfo

  const saved = {
    PLT_WORLD_SERVICE_URL: process.env.PLT_WORLD_SERVICE_URL,
    PLT_WORLD_APP_ID: process.env.PLT_WORLD_APP_ID,
    PLT_WORLD_DEPLOYMENT_VERSION: process.env.PLT_WORLD_DEPLOYMENT_VERSION,
    PORT: process.env.PORT
  }
  process.env.PLT_WORLD_SERVICE_URL = `http://127.0.0.1:${port}`
  process.env.PLT_WORLD_APP_ID = 'fastify-app'
  process.env.PLT_WORLD_DEPLOYMENT_VERSION = 'v1'
  process.env.PORT = '4321'
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const app = Fastify()
  await app.register(workflowFastify, { buildDir: dir })
  await app.ready()

  assert.strictEqual(registrations.length, 1)
  assert.strictEqual(registrations[0].url, '/api/v1/apps/fastify-app/handlers')
  assert.strictEqual(registrations[0].body.deploymentVersion, 'v1')
  assert.strictEqual(registrations[0].body.endpoints.workflow, 'http://localhost:4321/.well-known/workflow/v1/flow')

  await app.close()
})
