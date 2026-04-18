# @platformatic/world

Drop-in [World](https://useworkflow.dev/docs/deploying) implementation for [Vercel Workflow DevKit](https://useworkflow.dev) on self-hosted Kubernetes. Routes workflow state through a central [Workflow Service](https://github.com/platformatic/platformatic-world/tree/main/packages/workflow) that pins each run to the deployment version that started it.

## Installation

```bash
npm install @platformatic/world
```

## Usage

### With the Vercel Workflow SDK

Set two environment variables and the SDK discovers the world automatically:

```bash
WORKFLOW_TARGET_WORLD=@platformatic/world
PLT_WORLD_SERVICE_URL=http://localhost:3042
```

Your app needs to call `world.start()` once on server startup to register a queue handler. In Next.js, use `instrumentation.ts`:

```typescript
// instrumentation.ts
export async function register() {
  if (process.env.PLT_WORLD_SERVICE_URL) {
    const { createWorld } = await import('@platformatic/world')
    const world = createWorld()
    await world.start?.()
  }
}
```

For other frameworks, call `world.start()` during your server's startup.

In Kubernetes with [ICC](https://icc.platformatic.dev/), handler registration is automatic — `world.start()` is a no-op.

### Direct usage

```typescript
import { createWorld } from '@platformatic/world'

const world = createWorld({
  serviceUrl: 'http://localhost:3042',
  appId: 'my-app',
  deploymentVersion: 'v1',
})

// world implements the full World interface:
// storage (runs, events, steps, hooks), queue, streams, encryption
```

## Configuration

### `createWorld(options?)`

High-level factory with automatic config resolution from environment variables.

| Option | Env var | Default | Description |
|---|---|---|---|
| `serviceUrl` | `PLT_WORLD_SERVICE_URL` | *required* | Workflow Service URL |
| `appId` | `PLT_WORLD_APP_ID` | `package.json` name | Application identifier |
| `deploymentVersion` | `PLT_WORLD_DEPLOYMENT_VERSION` | K8s label or `'local'` | Deployment version |

In Kubernetes, the deployment version is auto-detected from the pod's `plt.dev/version` label via the K8s API.

### `createPlatformaticWorld(config)`

Low-level factory — all fields required, no env var resolution.

```typescript
import { createPlatformaticWorld } from '@platformatic/world'

const world = createPlatformaticWorld({
  serviceUrl: 'http://localhost:3042',
  appId: 'my-app',
  deploymentVersion: 'v1',
})
```

## Spec version support

`@platformatic/world` declares `specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT` (3). In practice:

- Runs created by `start()` are tagged with spec v3.
- Queue messages between client and server use CBOR framing. CBOR preserves `Uint8Array` natively (JSON does not), so binary workflow input survives the queue round-trip without base64 wrapping.
- `createQueueHandler` accepts both CBOR and JSON inbound via a dual transport. A v3 client can be deployed against a v2-only server during rollout; a v2 client can be deployed against a v3 server.

Peer dependency: `@workflow/world` ≥ 5.0.0-beta.1 (the first release exporting `SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT`).

## License

Apache-2.0
