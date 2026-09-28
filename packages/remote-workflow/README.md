# `@platformatic/remote-workflow`

Durable, typed calls from a Workflow SDK workflow to a remote workflow
handler. A call records a shared dispatch step in Platformatic World, then waits
on a hook whose token is the deterministic operation key.

```ts
import { remote } from '@platformatic/remote-workflow'

const reservation = await remote<
  { sku: string, quantity: number },
  { reservationId: string }
>('inventory.reserve', { sku: 'ABC', quantity: 2 }, { budget: 30_000 })
```

Generated declarations can merge registered endpoints into
`RemoteEndpoints`; registered names then infer both input and output types.
Explicit type parameters remain available for endpoints that are not in a
generated registry.

## Handler definitions and build artifacts

A handler application defines its endpoints in `remote.ts` at the application
root. The file must default export `defineRemote({...})`:

```ts
import { defineRemote } from '@platformatic/remote-workflow'
import { reserve } from './workflows/inventory.js'

export default defineRemote({
  'inventory.reserve': {
    workflow: reserve,
    inputSchema: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['reservationId'] }
  }
})
```

Wire `createRemoteAfterBundleHook()` into the Workflow SDK builder's
`onAfterBundle` option. The hook reads the completed SDK `manifest.json` and
writes `remote-manifest.json` and the private `remote-handlers.json` to the
application's canonical `.well-known/workflow/v1` directory. Pass `outputDir`
to override that destination. The public artifact contains only the sorted
endpoint names and schemas; workflow IDs occur only in the private handler
artifact. A missing `remote.ts` is a caller-only build and produces neither
artifact.

Custom build integrations can call `buildRemoteHandlerArtifacts()` directly,
or run:

```sh
platformatic-remote-workflow build --root . --workflow-manifest .well-known/workflow/v1/manifest.json
```

Malformed definitions, unsupported schema dialects, and workflow symbols that
cannot be resolved uniquely against the authoritative Workflow SDK manifest
fail the build.

## Durable identity and replay

The operation key is a collision-safe hash of the workflow run ID, transformed
dispatch step name, durable step ID, and endpoint. The dispatch step calls
`@platformatic/world`, whose endpoint registry provider performs the internal
resolution handshake only for a new operation. An exact replay reads the
stored epoch and schema hash without consulting the current registry.

The supplied `budget` is written to the durable operation. World derives and
owns the deadline. The addon deliberately does not race the result hook against
`sleep()`: the RMT-4 restart probe showed that such a race can select a
different winner during replay. Total-budget timeout delivery (RMT-6) remains
gated on World delivering the durable deadline outcome.

## Errors

Calls reject with one of these stable classes:

- `RemoteNotClaimedError` for a schedule-to-start expiry
- `RemoteFailedError` for a handler or schema failure
- `RemoteTimedOutError` when the durable total budget is exhausted
- `RemoteCancelledError` after cancellation acknowledgement
- `RemoteUnavailableError` for endpoint, admission, manifest, or start failures

All extend `RemoteError` and may carry `operationKey`, `handlerRunId`, and the
frozen wire error `code`.

## Runtime configuration

The caller-side `@platformatic/world` instance requires
`PLT_WORLD_SERVICE_URL` and its World application label (`PLT_WORLD_APP_ID` or
`PLT_APP_NAME`). The host runtime supplies the endpoint registry cache through
`@platformatic/world`'s provider slot. The registry's `iccApplicationId` is a
separate, immutable ICC tenant UUID; it is never derived from the World URL
label.

Phase 1 accepts inline JSON payloads up to 256 KiB and admits budgets of at
least one second. Blob-backed payload transport is intentionally not enabled.

## Pull-handler protocol runtime

This package exports the framework-neutral protocol/runtime primitives consumed
by Platformatic's `@platformatic/workflowsdk` capability. It does not open an
ICC socket and does not depend on a framework-specific runtime. The host
supplies the authenticated transport's correlated request client; this package translates the
`announce_handler`, `claim`, `heartbeat`, `report_started`, `report_result`,
and `reconcile_handler_runs` protocol into a durable World-backed handler
worker:

```ts
import {
  createRemoteHandlerTransport,
  readRemoteHandlerManifest,
  registerRemoteHandlerRuntime,
  createDefaultRemoteHandlerAdapter,
} from '@platformatic/remote-workflow'

const manifest = await readRemoteHandlerManifest('./remote-handlers.json')
const identity = {
  service: process.env.PLT_APP_NAME!,
  versionLabel: process.env.PLT_DEPLOYMENT_VERSION!,
  manifestHash: manifest.manifestHash,
}
const transport = createRemoteHandlerTransport({
  tenant: process.env.PLT_ICC_APPLICATION_ID!,
  identity,
  client: iccSocketClient,
  // Set only after ICC advertises handlerReconciliationVersion: 2.
  reconciliation: true,
})

const worker = await registerRemoteHandlerRuntime({
  identity: { ...identity, tenant: process.env.PLT_ICC_APPLICATION_ID! },
  manifest,
  transport,
  adapter: await createDefaultRemoteHandlerAdapter(process.cwd()),
})
```

The worker caps every claim at 16 operations, rejects withdrawn endpoints and
blob references in protocol v1, heartbeats pre-start leases, reports terminal
outcomes within the 256 KiB inline limit, and reconciles active World handler
runs when the ICC protocol advertises reconciliation support. Applications that
do not configure a transport receive a no-op worker and retain the ordinary
local Workflow SDK behavior.

## Observability

World's authenticated active-operation feed is the source of truth for work
that ICC must claim or cancel. Terminal results remain in World until their
caller hook is resumed, and expired handler reservations remain recoverable by
the reaper. Successful update batches, deadline sweeps, and handler-run reaping
emit count-only structured log summaries. These summaries deliberately exclude
payloads, operation keys, handler-run IDs, workflow IDs, signatures, and
secrets. The World service also exposes its standard Prometheus endpoint at
`GET /metrics` for process and HTTP telemetry.

## Verification

From the repository root:

```sh
pnpm -C packages/world build
pnpm -C packages/remote-workflow test
pnpm -C packages/remote-workflow build
pnpm -C packages/remote-workflow typecheck
pnpm lint
pnpm test
```
