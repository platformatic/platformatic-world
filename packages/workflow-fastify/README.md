# @platformatic/workflow-fastify

A Fastify plugin that runs [Vercel Workflow SDK](https://workflow-sdk.dev) workflows
without Nitro, backed by [`@platformatic/world`](../world).

It mounts the workflow callback handlers produced by the standalone build and
registers this app's queue handler with the workflow engine. Your app keeps full
ownership of its own lifecycle (Fastify owns `listen()`, hooks, plugins); this
plugin only adds routes and a startup hook.

## How it works

1. `npx workflow build --target standalone` transforms your `'use workflow'` /
   `'use step'` files and emits, under `.well-known/workflow/v1/` (the plugin
   resolves the bundle extension automatically: v5 emits `.mjs`, v4 emits `.js`):
   - `flow` — workflow orchestration handler (`POST`, a Web `Request => Response`)
   - `step` — step execution handler
   - `webhook` — webhook resume handler
   - `manifest.json` — workflow/step ids + graph
2. This plugin imports those handlers and mounts them on Fastify, adapting
   Fastify `request`/`reply` to the Web `Request`/`Response` they expect.
3. On boot it calls `@platformatic/world`'s `start()` to register the callback
   endpoints with the engine. In Kubernetes/ICC this is a no-op (ICC registers
   them).

The build is the only step that needs the SDK's transform. At runtime this
plugin needs no bundler.

## Usage

```bash
npm i @platformatic/workflow-fastify @platformatic/world fastify workflow
```

```ts
import Fastify from 'fastify'
import { start } from 'workflow/api'
import workflowFastify from '@platformatic/workflow-fastify'

const app = Fastify()
await app.register(workflowFastify) // mounts .well-known/workflow/v1/*

// Trigger by workflow id (from the generated manifest) — no transform needed
// on this file, because start() accepts a WorkflowMetadata { workflowId }.
app.post('/api/signup', async (req) => {
  const run = await start({ workflowId: 'workflow//./workflows/signup//handleSignup' }, [req.body.email])
  return { runId: run.runId }
})

await app.listen({ port: Number(process.env.PORT) })
```

Build workflows before starting:

```bash
npx workflow build --target standalone
```

## Options

| Option | Default | Description |
|---|---|---|
| `buildDir` | `process.cwd()` | Directory containing `.well-known/workflow/v1` |
| `register` | `true` | Register the queue handler on boot (no-op under ICC) |

## Environment

The SDK and the world resolve from environment variables:

```
WORKFLOW_TARGET_WORLD=@platformatic/world
PLT_WORLD_SERVICE_URL=http://<workflow-engine>:3042
PLT_WORLD_APP_ID=<app id>                 # optional, defaults to package name
PLT_WORLD_DEPLOYMENT_VERSION=<version>    # optional; auto-detected in K8s
PORT=<port>                               # used to register the callback URL locally
```
