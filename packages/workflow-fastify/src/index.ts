import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile, access } from 'node:fs/promises'
import fp from 'fastify-plugin'
import { createWorld } from '@platformatic/world'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

export interface WorkflowFastifyOptions {
  // Directory containing the built `.well-known/workflow/v1` artifacts produced
  // by `workflow build --target standalone`. Defaults to `process.cwd()`.
  buildDir?: string
  // Register this app's queue handler with the workflow engine on boot.
  // Defaults to true. A no-op in Kubernetes/ICC (ICC registers handlers there).
  register?: boolean
}

// Shape of `.well-known/workflow/v1/manifest.json` (only the fields used here).
export interface WorkflowManifest {
  version?: string
  workflows: Record<string, Record<string, { workflowId: string }>>
  [key: string]: unknown
}

// Flattened map of workflow function name -> workflowId, across all source files.
export type WorkflowIds = Record<string, string>

declare module 'fastify' {
  interface FastifyInstance {
    // The parsed workflow manifest produced by the standalone build.
    workflowManifest: WorkflowManifest
    // workflow function name -> workflowId, e.g. `app.workflows.handleSignup`.
    // Pass to start(): start({ workflowId: app.workflows.handleSignup }, args).
    workflows: WorkflowIds
  }
}

type WebHandler = (req: Request) => Promise<Response>

const PREFIX = '/.well-known/workflow/v1'

// Fastify plugin that mounts the Vercel Workflow SDK callback handlers
// (flow/step/webhook) produced by the standalone build and wires them to
// `@platformatic/world`. It also parses the manifest and decorates the app with
// `workflows` (name -> workflowId) so callers can trigger runs without re-reading
// the manifest. The app keeps full ownership of its lifecycle; this plugin only
// adds routes, decorators, and a startup registration hook.
async function workflowFastify (
  app: FastifyInstance,
  opts: WorkflowFastifyOptions = {}
): Promise<void> {
  const base = join(opts.buildDir ?? process.cwd(), '.well-known/workflow/v1')

  // The standalone build emits one bundle per handler. The extension and module
  // format vary by SDK version: v5 emits ESM `.mjs`; v4 emits `.js` (flow/step
  // CommonJS, webhook ESM). Resolve the actual file by base name, and for an
  // ambiguous `.js` normalize it to .cjs/.mjs (sniffed) so the host app's
  // package.json "type" is irrelevant. Then import and pick the POST export
  // (named for ESM, or off the default export for CommonJS).
  const exists = async (p: string): Promise<boolean> => {
    try { await access(p); return true } catch { return false }
  }
  const load = async (name: string): Promise<WebHandler> => {
    let target: string | undefined
    for (const ext of ['.mjs', '.cjs', '.js']) {
      const candidate = join(base, name + ext)
      if (!await exists(candidate)) continue
      if (ext === '.js') {
        const src = await readFile(candidate, 'utf8')
        const isCjs = /\bmodule\.exports\b/.test(src) || /\bexports\.[\w$]/.test(src)
        target = candidate.replace(/\.js$/, isCjs ? '.cjs' : '.mjs')
        await writeFile(target, src)
      } else {
        target = candidate
      }
      break
    }
    if (target === undefined) throw new Error(`workflow handler ${name} not found in ${base}`)
    const mod = await import(pathToFileURL(target).href) as Record<string, unknown> & { default?: Record<string, unknown> }
    const handler = (mod.POST ?? mod.default?.POST ?? mod.default) as WebHandler | undefined
    if (typeof handler !== 'function') throw new Error(`workflow handler ${name} has no POST export`)
    return handler
  }
  const [flow, step, webhook] = await Promise.all([
    load('flow'),
    load('step'),
    load('webhook'),
  ])

  // Parse the manifest and expose name -> workflowId so callers don't re-read it.
  const manifestRaw = await readFile(join(base, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestRaw) as WorkflowManifest
  const workflows: WorkflowIds = {}
  for (const file of Object.values(manifest.workflows ?? {})) {
    for (const [name, meta] of Object.entries(file)) workflows[name] = meta.workflowId
  }
  app.decorate('workflowManifest', manifest)
  app.decorate('workflows', workflows)

  const mount = (handler: WebHandler) => async (req: FastifyRequest, reply: FastifyReply) => {
    const res = await handler(toWebRequest(req))
    reply.code(res.status)
    res.headers.forEach((value, key) => reply.header(key, value))
    return reply.send(Buffer.from(await res.arrayBuffer()))
  }

  // Mount the callback routes inside an encapsulated child so the raw-body
  // content-type parser they need (workflow bodies are JSON or CBOR, consumed as
  // a Buffer) does not affect the parent app's own JSON routes.
  await app.register(async (routes) => {
    routes.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
    routes.post(`${PREFIX}/flow`, mount(flow))
    routes.post(`${PREFIX}/step`, mount(step))
    routes.post(`${PREFIX}/webhook/:token`, mount(webhook))
    routes.get(`${PREFIX}/webhook/:token`, mount(webhook))
    routes.get(`${PREFIX}/manifest.json`, async (_req, reply) => {
      reply.type('application/json')
      return reply.send(manifestRaw)
    })
  })

  if (opts.register !== false) {
    const world = createWorld()
    app.addHook('onReady', async () => { await world.start?.() })
    app.addHook('onClose', async () => { await world.close?.() })
  }
}

function toWebRequest (req: FastifyRequest): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
  }
  const method = req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  // Buffer is a Uint8Array view, a valid BodyInit; cast to satisfy the DOM lib type.
  return new Request(`http://workflow.local${req.url}`, {
    method,
    headers,
    body: hasBody ? (req.body as Buffer) as unknown as BodyInit : undefined,
  })
}

// fastify-plugin so the `workflows` / `workflowManifest` decorators (and the
// world lifecycle hooks) attach to the caller's instance rather than an
// encapsulated child.
export default fp(workflowFastify, {
  name: '@platformatic/workflow-fastify',
  fastify: '5.x',
})
