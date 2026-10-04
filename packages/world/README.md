# @platformatic/world

Drop-in [World](https://useworkflow.dev/docs/deploying) implementation for [Vercel Workflow DevKit](https://useworkflow.dev) on self-hosted Kubernetes and AWS ECS. Routes workflow state through a central [Workflow Service](https://github.com/platformatic/platformatic-world/tree/main/packages/workflow) that pins each run to the deployment version that started it.

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

On Kubernetes or ECS with [ICC](https://icc.platformatic.dev/), handler registration is automatic — `world.start()` is a no-op. See the repository's [ECS guide](../../README-ECS.md) for ECS configuration and its network-trusted security model.

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
| `deploymentVersion` | `PLT_WORLD_DEPLOYMENT_VERSION` | `'local'` | Deployment version assigned by ICC on managed platforms |

On Kubernetes and ECS, ICC supplies the deployment version through the application environment/runtime context.

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

`@platformatic/world` declares `specVersion: 8` (`SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM`), which tracks the SDK's `SPEC_VERSION_CURRENT`. Setting `WORKFLOW_SEALED_LOG=0` drops it to 6 (`SPEC_VERSION_SUPPORTS_SLOT_IDENTITY`), the lowest version the v5 runtime still admits.

Spec 8 is a *reader* contract: a run we stamp is executed by a runtime that understands an involuntary `hook_disposed{forceClaimedBy}`. It does not mean this World can perform a hook takeover — that is the separate `hookForceClaim` capability, which we leave unset, so the runtime rejects `createHook({ experimental_force: true })` against us.

Queue transport is independent of this. Messages use CBOR framing from spec 3 onward, which preserves `Uint8Array` natively (JSON does not), so binary workflow input survives the round-trip without base64 wrapping. `createQueueHandler` accepts both CBOR and JSON inbound, so client and server can be rolled out in either order.

Peer dependency: `@workflow/world` `>=4.5.0 <6`. It is a genuine runtime requirement, not just a type: `lib/queue.ts` imports `SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT` live, and the host application supplies the package.

## Workflow SDK compatibility

Our World API is typed against **`@workflow/world@5.x`** (npm `latest`), and the same world instance also works at runtime against the v4 SDK line (npm `previous`).

| Installed `workflow` SDK | Works at runtime | Notes |
|---|---|---|
| `workflow@5.x` (npm `latest`) | ✅ | The declared API. The SDK calls `world.streams.*` (nested namespace, `runId`-first argument order). |
| `workflow@4.x` (npm `previous`) | ✅ | The v4 SDK calls the flat methods (`writeToStream`, `getStreamChunks`, ...), which we keep exposed alongside the v5 namespace. |

We verify both lines in CI: `e2e-v5/` runs against `workflow@5.x` and hosts the Vercel-compat suite, `e2e-v4/` runs against `workflow@4.x` to guard the v4 runtime path.

The v5 streamer changes (PR [#1293](https://github.com/vercel/workflow/pull/1293), namespace rename + `runId`-first argument order, required `runId` on `steps.get`) are additive from our side: `lib/streamer.ts` returns both shapes from one object, each delegating to shared internals, so whichever SDK is loaded calls the names it knows.

## License

Apache-2.0
