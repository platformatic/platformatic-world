# Remote steps testing guide

This guide validates remote steps across Workflow SDK, Platformatic World,
Watt, Watt Extra, ICC, and Desk. A test passes only when the durable operation,
transport exchange, handler run, hook resumption, and caller workflow outcome
agree; an accepted request alone is not evidence of completion.

## Architecture under test

The application topology is deliberately combined:

- one Watt application ID owns both the caller workflows and remote handlers;
- ICC's server-issued application UUID is the remote protocol tenant;
- the Watt application ID is the handler `service` identity;
- ICC resolves the deployed version and supplies it as `versionLabel`.

Do not model the caller and handler as separately deployed Watt applications.
Separate deployments receive different ICC application UUIDs and therefore
cannot rendezvous in the same tenant registry.

There are two supported delivery paths to the same durable reservation/start,
status, cancellation, and outcome machinery:

1. **Pull:** Watt Extra opens the authenticated application WebSocket to ICC,
   registers the public manifest, announces durable caller operations, claims
   handler work, and reports starts and outcomes.
2. **Push:** ICC signs HTTP requests to routes mounted by
   `@platformatic/workflow-fastify` on the application's existing Fastify
   server. Watt Extra does not create a listener. The adapter receives its
   identity, private manifest, secret, runtime, and shared replay store from the
   owning application.

No cross-process request, response, log, or public manifest may expose a
Workflow SDK `workflowId`. Only the private handler manifest may contain one.

### Workflow SDK v4 and v5 callbacks

`@platformatic/workflow-fastify` supports both standalone layouts:

- SDK v4 loads `flow`, `step`, and `webhook` callback bundles and mounts the
  flow, step, and webhook routes.
- SDK v5 loads the combined `flow.mjs`, `webhook.mjs`, and
  `__step_registrations.mjs`; it mounts flow and webhook routes and must not
  expose a separate step route.

The callback and push routes consume byte-preserving bodies inside an
encapsulated Fastify scope. A sibling application JSON route must continue to
receive an ordinarily parsed object.

## Frozen artifacts and limits

Platformatic World's remote builder uses the Workflow SDK `onAfterBundle`
hook to write both artifacts next to `.well-known/workflow/v1/manifest.json`.
Endpoint entries are sorted by name, schemas use JSON Schema draft-07, and
`manifestHash` is the lowercase SHA-256 of the canonical endpoint array.

The public `remote-manifest.json` has exactly this shape and never contains
workflow IDs:

```json
{
  "v": 1,
  "manifestHash": "<64 lowercase hex characters>",
  "endpoints": [
    {
      "name": "inventory.reserve",
      "inputSchema": {},
      "outputSchema": {}
    }
  ]
}
```

The private `remote-handlers.json` has exactly this shape, is read only by the
handler application, and is never registered or served publicly:

```json
{
  "v": 1,
  "manifestHash": "<same 64 lowercase hex characters>",
  "handlers": {
    "inventory.reserve": {
      "workflowId": "<Workflow SDK workflow ID>"
    }
  }
}
```

Malformed private top-level keys or handler-entry keys must fail application
boot. A caller-only build with no `remote.ts` emits neither remote artifact.

These values are part of the implemented contract and are not undecided test
parameters:

| Limit | Frozen value | Required boundary assertion |
| --- | ---: | --- |
| Inline JSON input or outcome | 256 KiB (262,144 UTF-8 bytes) | exact limit accepted; one byte over rejected |
| Signed push HTTP raw body | 256 KiB (262,144 bytes) | exact limit reaches authentication/routing; one byte over is `413` |
| Pull WebSocket frame | 1 MiB (1,048,576 bytes) | exact limit accepted; one byte over rejected without partial state |
| Claim batch | 16 operations | queue 17 and prove the first batch is 16 and no batch exceeds 16 |
| Claim lease | 30 seconds | heartbeat preserves ownership; expiry fences the old token and redelivers |
| Delivery attempts | 5 | the fifth attempt is final; no sixth delivery is made |

Desk's full acceptance lane exercises the real 30-second production lease.
Focused owner-package tests may use fake clocks, but the cross-repository gate
must not shorten this interval.

## Signed inbound push protocol

The v1 adapter mounts these routes on the combined application's Fastify
server:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/remote/v1/dispatch` | reserve and start a handler run |
| `GET` | `/remote/v1/operations/:handlerRunId` | return running or terminal status |
| `POST` | `/remote/v1/cancel` | cancel a reserved handler run |

The JSON request bodies do not contain a top-level protocol `v` field. A
dispatch carries `operationKey`, `endpoint`, inline `payload`, and
`budget.remaining`; cancellation carries only `operationKey` and
`handlerRunId`. Status puts the handler run ID in the path and has no body.

Every request must include exactly these authentication headers:

```text
x-pltf-timestamp: <Unix seconds>
x-pltf-nonce: <unique nonce>
x-pltf-signature: <lowercase hex HMAC-SHA256>
```

Compute the signature over the exact raw body bytes and this canonical string:

```text
v1\n<unix-seconds>\n<nonce>\n<METHOD>\n<pathname>\n<SHA256(body)>
```

`METHOD` is uppercase, `pathname` excludes the query string, and both digests
use lowercase hexadecimal. The shared secret must contain at least 32 encoded
bytes. Compare signatures in constant time. Accept timestamps at the inclusive
plus-or-minus 300-second boundary and reject older or further-future values.

After a valid signature, claim the nonce atomically for exactly five minutes
in a shared Valkey store. The production helper performs one
`SET <key> 1 PX 300000 NX`; it has no in-memory fallback. A duplicate nonce is
rejected, and a replay-store error or ambiguous result fails closed.

Dispatch is idempotent by `operationKey`: an original start returns `200`, and
an already-reserved or already-started operation returns `409` with the same
`handlerRunId` without starting a second workflow. Unknown endpoints and
admission failures return a bounded `422`; transport or runtime failures stay
retryable. Cancellation returns `501` only when the injected runtime does not
support cancellation.

## Record exact source inputs

Every Desk or cross-repository result must record immutable revisions:

```text
platformatic_sha=
workflow_sdk_sha=
world_sha=
watt_extra_sha=
icc_sha=
desk_sha=
seed=
scenario=
```

Do not silently use the current checkout of another repository. Desk's staging
script checks the expected HEAD and tracked cleanliness for each source,
builds and packs the local packages, writes a frozen fixture lockfile, and
records the SHAs in `sources.json`.

## Run the current Desk harness

The concrete Kubernetes harness lives on Desk's
`remote-steps/integration-harness` branch. Its primary `remote-steps-app`
contains both caller and handler workflows. `remote-steps-attacker` is a
separate ICC tenant used for authorization checks, and
`remote-steps-wire-proxy` supplies deterministic hold, drop, disconnect, and
orphan boundaries while retaining only sanitized metadata.

Use Node.js 24 and install Docker, k3d, kubectl, and Helm. The launcher creates
the PostgreSQL and Valkey services inside the cluster; it does not require a
separate host database. `node cli.js doctor` reports any missing local tool.

From that Desk checkout:

```bash
npm install
node cli.js doctor

export PLATFORMATIC_REPO=/path/to/platformatic
export WORKFLOW_SDK_REPO=/path/to/workflow-sdk
export WORKFLOW_REPO=/path/to/platformatic-world-remote-steps-integration
export WATT_EXTRA_REPO=/path/to/watt-extra
export ICC_REPO=/path/to/icc-3

scripts/remote-steps-up.sh
```

The launcher verifies the pinned checkouts, builds ICC and the local packages,
starts the `remote-steps` profile, and deploys the proxy, combined primary app,
and attacker. It prints the exact environment needed by the test command.

Run the exact command printed by the launcher so the result includes its staged
source file. Its shape is:

```bash
REMOTE_STEPS_PROFILE=remote-steps \
REMOTE_STEPS_SOURCES=/path/printed/by/launcher/sources.json \
  scripts/remote-steps-smoke.sh

REMOTE_STEPS_PROFILE=remote-steps \
REMOTE_STEPS_SOURCES=/path/printed/by/launcher/sources.json \
  scripts/remote-steps-smoke.sh --full
```

The equivalent npm shortcut is `npm run remote-steps:test -- --full`; preserve
the two printed environment variables when using it. The script also accepts
`--restart-icc` and `--output /absolute/path/result.json`.

The smoke suite checks source provenance, registration before announcement,
the public manifest, absence of workflow-ID leakage, a real pull-delivered
remote echo, one durable handler reservation, handler-run ID shape, schema
hash, and distinct primary/attacker tenants.

The full suite additionally checks exact 256 KiB pull input/output boundaries,
the 16-operation claim batch, ELU claim throttling, the real 30-second lease
with redelivery and token fencing after a handler crash,
caller-cancellation reconciliation, mixed ICC reconciliation versions, pinned
registry epochs, World replay without live registry state, tenant isolation,
nested budget clamping, and ICC restart with idempotent manifest replay. Its
push lane checks changed-manifest live delta routing, signed dispatch and
terminal polling, idempotence, replay rejection, unknown and withdrawn
endpoints, terminal `422` no-retry behavior, schema rejection, explicit
cancellation/status, and dead-lettering after exactly five attempts.

Use `REMOTE_STEPS_REUSE_CLUSTER=1` only when the existing cluster was created
from the same profile and exact source inputs. The current image-mode
invocation is:

```bash
export REMOTE_STEPS_MODE=images
export REMOTE_STEPS_ICC_IMAGE_REPOSITORY=registry.example/icc
export REMOTE_STEPS_ICC_IMAGE_TAG=immutable-build-tag
export REMOTE_STEPS_WORLD_IMAGE_REPOSITORY=registry.example/workflow
export REMOTE_STEPS_WORLD_IMAGE_TAG=immutable-build-tag
scripts/remote-steps-up.sh
```

Digest-qualified fixture images may be supplied with
`REMOTE_STEPS_PRIMARY_IMAGE`, `REMOTE_STEPS_ATTACKER_IMAGE`, and
`REMOTE_STEPS_PROXY_IMAGE`. Tagged images require the explicit, non-gating
`REMOTE_STEPS_ALLOW_TAGGED_IMAGES=1` escape hatch.

Desk stages the push-capable private artifact and mounts the optional
`workflow-fastify` push adapter when ICC provisions its secret and identity.
The full scenario driver exercises both pull and push in the same combined
application. Do not substitute a second handler application or a Watt Extra
listener.

## Fast repository gates

### Workflow SDK

```bash
pnpm --filter @workflow/builders test
pnpm --filter @workflow/builders typecheck
pnpm --filter @workflow/world-vercel test
pnpm lint
```

These tests own the generic `onAfterBundle` lifecycle and caller-supplied run
identifier behavior. Platformatic-specific manifest semantics stay in World.

### Platformatic World

```bash
docker compose up -d
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm test:e2e:v5
```

Focused remote packages and compatibility checks:

```bash
pnpm -C packages/remote-workflow test
pnpm -C packages/remote-workflow typecheck
pnpm -C packages/workflow-fastify test
node --test --test-concurrency=1 packages/workflow/test/remote-operations.test.ts
```

`workflow-fastify` tests must cover both the v4 flow/step/webhook layout and the
v5 combined flow/step-registration/webhook layout, including the missing v5
step route and unaffected sibling JSON parsers.

### Watt and Watt Extra

```bash
# Platformatic core/Watt
pnpm -C packages/basic test
pnpm -C packages/basic lint
pnpm -C packages/runtime run test:multiple-workers
pnpm -C packages/runtime run test:types
pnpm -C packages/runtime lint
pnpm -C packages/itc test

# Watt Extra
pnpm install --frozen-lockfile
pnpm test
```

Worker extensions provide lifecycle and ITC primitives but cannot own HTTP
responses. Watt Extra owns the authenticated outbound ICC WebSocket, manifest
and operation announcements, pull claims, heartbeats, reports, polling, and
reconciliation. Its focused tests use a fake ICC and cover reconnect and
acknowledgement correlation.

### ICC

```bash
docker compose up -d
pnpm install --frozen-lockfile
node ./services/main/node_modules/@fastify/secure-session/genkey.js > .session-key
pnpm -C services/main test
pnpm -C services/control-plane test
pnpm -C services/scaler test
pnpm lint
```

ICC tests require PostgreSQL and both configured Valkey instances. Session and
push secrets must be ephemeral and must not appear in artifacts.

## Required deterministic coverage

### Durable API and identity

- Operation keys are stable across replay and distinct for repeated calls.
- Loop and left-to-right `Promise.all` calls retain durable correlation.
- Every frozen wire error maps to one typed public error.
- Endpoint inference, explicit types, and declaration merging compile in
  positive and negative type tests.
- Registration and dispatch use the ICC application UUID tenant, combined Watt
  application ID service, and resolved deployment version.
- No captured cross-process object contains `workflowId` at any depth.

### World durability

- An operation is not announced before its dispatch step is durable.
- Operation state and step result become visible atomically; a forced
  transaction failure rolls both back.
- Exact retries are idempotent and conflicting retries are rejected.
- Tenant-scoped keys cannot read or mutate another tenant's rows.
- Restart before and after promotion preserves the same result.
- Registry, outcome, and policy changes cannot alter a replayed operation.
- Concurrent deadline and result release produces exactly one terminal winner.

### Pull coordination

- Boot snapshot, ordered deltas, stale deltas, gaps, synchronous misses, and
  reconnect snapshots are covered.
- Registration is idempotent for an unchanged hash and rejects conflicting
  content for the same version label.
- File and `onAfterBundle` manifest sources produce identical messages.
- `defineRemote` setup/teardown runs once per worker lifecycle.
- Duplicate claims reserve and start only one handler run.
- Heartbeats extend a valid lease; expiry fences the old token.
- Start rejection is distinct from handler workflow failure.
- Terminal outcomes survive restart and can be reported again.
- ICC can lose soft dispatch/lease state and reconstruct progress from caller
  and handler announcements.

### Signed push coordination

At minimum, owner-package tests and the Desk push lane must cover:

- dispatch `200`, duplicate/concurrent dispatch `409`, stable handler-run ID,
  and exactly one reservation/start;
- running and bounded terminal status, unknown-run `404`, cancellation success,
  and optional cancellation `501`;
- exact canonical signature bytes, uppercase method, query-free pathname, and
  altered method/path/body/signature rejection;
- timestamp acceptance at both 300-second boundaries and stale/future
  rejection beyond them;
- one atomic five-minute nonce claim, replay rejection across app replicas, and
  fail-closed replay-store outage;
- malformed JSON, invalid UTF-8, unexpected private-manifest keys, invalid ICC
  tenant UUID, and secrets shorter than 32 bytes;
- exact 256 KiB raw body and inline outcome boundaries plus one-byte-over
  rejection;
- all failures remaining opaque and never returning `workflowId`.

ICC's push delivery tests additionally prove bounded retry/backoff for timeouts
and `5xx`, no retry after a terminal `422`, status polling through running to
terminal, cancellation behavior, the 30-second lease heartbeat, and exhaustion
after exactly five delivery attempts.

## Crash matrix

Use proxy barriers and a fake clock where possible; do not synchronize a race
only with sleeps.

1. Kill the caller before the durable write: no announcement exists.
2. Kill it after the write but before announce: restart re-announces the same
   operation key.
3. Kill it after announce but before Started is consumed: re-announce is safe.
4. Kill the handler after claim but before Started: lease expiry redelivers.
5. Kill it after start but before ICC observes Started: the same reservation
   prevents a second handler workflow.
6. Kill it after terminal persistence but before report: restart reports the
   same outcome.
7. Kill World after receiving the terminal update but before hook promotion:
   restart completes the hook once.
8. Release deadline and result barriers together: exactly one outcome wins.
9. Kill ICC during announce, claim, Started, result, push dispatch, and push
   polling: reconstructed soft state does not change the durable result.
10. Withdraw or change a schema during a run: existing work uses the pinned
    epoch/schema and new work sees the new registry state.

## Extending Desk automation

Keep new end-to-end behavior in Desk's existing combined primary fixture and
scenario driver:

1. Add handler behavior to
   `fixtures/remote-steps-app/workflows/handlers.ts` and declare its draft-07
   schemas in application-root `remote.ts`.
2. Drive pull calls only through `POST /__test/runs`; never invoke the handler
   workflow directly.
3. For push, use the disjoint `fixture.push.*` endpoints produced by
   `fixtures/remote-steps-app/build.mjs`. Submit work through ICC, not directly
   to the Fastify route, for the end-to-end success case.
4. Add a narrowly scoped signed-request helper for receiver-negative cases. It
   must obtain the ephemeral test secret without printing or writing it, sign
   the exact raw bytes, and send requests through a temporary port-forward to
   the same `remote-steps-app` pod.
5. Add proxy controls for push dispatch/status/cancel observations without
   recording headers, nonces, signatures, payloads, workflow IDs, or raw
   handler-run IDs. Store only hashes and encoded sizes.
6. Add table-driven push cases for auth, replay, timestamps, malformed bodies,
   all exact size boundaries, idempotency, status, cancellation, retry, and the
   fifth-attempt ceiling. Use a shared Valkey nonce and two app replicas for the
   cross-replica replay case.
7. Add explicit barriers immediately before and after every new durable
   boundary, and add a crash-matrix scenario where process death can interrupt
   it.
8. Assert durable World rows and final caller outcomes in addition to HTTP and
   proxy events. Every scenario must also run the sanitized-timeline assertion.
9. Add the small deterministic case to `npm test`, the production-shaped case
   to `scripts/remote-steps-smoke.sh --full`, and ICC restart coverage to
   `--restart-icc` where applicable.

Prefer proxy rules over sleeps. An orphan rule retains the authenticated ICC
side after the application side disappears, making fencing deterministic
without a production failpoint.

## CI cadence and artifacts

Every pull request runs owner-package unit, type, lint, schema, authorization,
duplicate-delivery, and replay tests. Stack/release gates run the Desk smoke and
full suites with exact revisions, the complete crash matrix, both pull and
push, and ICC total-loss reconstruction. Scheduled jobs repeat concurrency and
restart seeds, run mixed outcome/cancellation/timeout soak tests, and perform
protected live push and Kubernetes scale-from-zero checks.

Every multiprocess job uploads, even on failure:

- `result.json` with scenario, seed, exact source revisions, verdict, and failed
  invariants;
- a sanitized chronological protocol timeline;
- World event-log and remote-operation snapshots;
- manifest/schema hashes, registry epoch, snapshots, and deltas;
- combined Watt/Watt Extra, ICC, World, and proxy logs;
- process exits, signals, fault timestamps, and benchmark data.

Never retain raw credentials, signing material, authorization headers, nonces,
claim tokens, private manifests, handler-run IDs, workflow IDs, or arbitrary
payloads. When correlation is necessary, retain only a SHA-256 digest and byte
count.
