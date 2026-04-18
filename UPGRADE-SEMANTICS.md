# How Workflow DevKit Handles Upgrades and Deployments

## The Core Model: Deterministic Replay

Workflow DevKit uses **deterministic replay** with **event sourcing**. This is the single most important thing to understand about its upgrade semantics.

When a workflow resumes, it doesn't "pick up where it left off." It **re-executes the entire workflow function from the beginning**, replaying cached results from the event log. The runtime creates a sandboxed VM (`node:vm`) with:

- **Seeded `Math.random()`** using `seedrandom(runId)` — identical across replays
- **Fixed `Date.now()`** returning the timestamp from the event log
- **Deterministic `crypto.getRandomValues()`** — derived from the same RNG
- **Banned `setTimeout`/`setInterval`** — throws errors to prevent non-deterministic scheduling

## How Step Matching Works (The Critical Mechanism)

Each time a workflow calls a step function, it generates a `correlationId`:

```js
const correlationId = `step_${ctx.generateUlid()}`;
```

The ULID generator is created with the seeded RNG:

```js
const ulid = monotonicFactory(() => vmGlobalThis.Math.random());
// ...
generateUlid: () => ulid(+startedAt),
```

Since `Math.random()` is seeded with `runId` and ULIDs are generated monotonically from a fixed timestamp, **the same workflow code will always produce the same sequence of correlationIds in the same order**.

The event consumer processes events sequentially. Each step subscriber checks:

```js
if (event.correlationId !== correlationId) {
    return EventConsumerResult.NotConsumed;  // Not my event
}
if (event.eventType === 'step_completed') {
    // Return the cached result — don't re-execute
    const hydratedResult = await hydrateStepReturnValue(event.eventData.result, ...);
    resolve(hydratedResult);
    return EventConsumerResult.Finished;
}
```

When an event has no matching `step_completed` in the log, the step throws `WorkflowSuspension` — signaling the runtime to queue the step for actual execution.

## What Happens During a Deployment

### The Execution Cycle

```
1. Client → world.queue("__wkf_workflow_myWorkflow", {runId})
2. Queue handler loads ALL events for runId (sorted ascending)
3. Workflow function re-executes from the beginning in sandboxed VM
4. For each step call:
   a. Generate correlationId (deterministic)
   b. Check event log for matching step_completed
   c. If found → return cached result (skip execution)
   d. If not found → throw WorkflowSuspension
5. Suspension handler creates step_created events + queues step execution
6. Step executes → step_completed event → workflow re-queued
7. Goto step 2
```

### The Upgrade Scenario

Consider this workflow deployed as v1:

```js
'use workflow'
export default async function orderFlow(order) {
  const validated = await validateOrder(order)     // step 1 → correlationId_A
  const payment   = await chargeCard(validated)     // step 2 → correlationId_B
  const shipped   = await shipOrder(payment)        // step 3 → correlationId_C
  return shipped
}
```

A run starts, `validateOrder` and `chargeCard` complete. The workflow is suspended waiting for `shipOrder`. The event log contains:

```
run_created      (correlationId: null)
run_started      (correlationId: null)
step_created     (correlationId: correlationId_A, stepName: validateOrder)
step_completed   (correlationId: correlationId_A, result: {...})
step_created     (correlationId: correlationId_B, stepName: chargeCard)
step_completed   (correlationId: correlationId_B, result: {...})
step_created     (correlationId: correlationId_C, stepName: shipOrder)
```

Now v2 is deployed. Here's what matters:

## Safe Changes (Workflow Continues Correctly)

### 1. Modifying step implementation without changing step order

```js
// v2: Changed shipOrder internals
export async function shipOrder(payment) {
  'use step'
  // Changed from FedEx to UPS
  return await callUPS(payment)
}
```

This is safe. The step hasn't executed yet (`step_created` exists but no `step_completed`). When the queue dispatches `shipOrder`, it runs the **new v2 code**. The correlationId sequence is unchanged, so replay of `validateOrder` and `chargeCard` works — their cached results are returned from the event log.

### 2. Modifying code inside already-completed steps

If you change `validateOrder`'s implementation, it doesn't matter for in-flight runs — the result is replayed from the event log, the new code never executes for that step in that run.

### 3. Adding steps at the end

```js
// v2: Added notification step after shipOrder
const shipped = await shipOrder(payment)       // step 3 → correlationId_C
await notifyCustomer(shipped)                  // step 4 → correlationId_D (new)
return shipped
```

Safe for in-flight runs. Steps 1-3 replay from cache. Step 4 is new and will suspend + execute normally.

## Dangerous Changes (Workflow Breaks)

### 1. Reordering steps

```js
// v2: Moved chargeCard before validateOrder
const payment   = await chargeCard(order)      // step 1 → correlationId_A
const validated = await validateOrder(payment)  // step 2 → correlationId_B
```

**This breaks.** The ULID generator produces the same sequence (`correlationId_A`, `correlationId_B`, ...) regardless of which step function occupies each position. Now `chargeCard` at position 1 gets `correlationId_A`, which matches `validateOrder`'s completed event. The wrong cached result is returned, and the workflow produces incorrect data or crashes.

### 2. Inserting steps in the middle

```js
// v2: Added fraud check between validate and charge
const validated = await validateOrder(order)    // step 1 → correlationId_A ✓
const fraud     = await checkFraud(validated)   // step 2 → correlationId_B ← gets chargeCard's result!
const payment   = await chargeCard(fraud)       // step 3 → correlationId_C ← gets shipOrder's event
```

Same problem — every step after the insertion gets the wrong correlationId mapping.

### 3. Removing a step from the middle

```js
// v2: Removed validateOrder
const payment = await chargeCard(order)         // step 1 → correlationId_A ← gets validateOrder's result!
const shipped = await shipOrder(payment)        // step 2 → correlationId_B ← gets chargeCard's result!
```

The event consumer may also trigger the **unconsumed event check**. If an event in the log can't be consumed by any callback, the runtime throws:

```js
onUnconsumedEvent: (event) => {
    workflowDiscontinuation.reject(new WorkflowRuntimeError(
        `Unconsumed event in event log: eventType=${event.eventType}, ...`
    ));
}
```

### 4. Changing control flow (adding/removing conditionals)

```js
// v2: Added conditional that skips chargeCard for free orders
if (order.total > 0) {
    const payment = await chargeCard(validated)  // only called conditionally
}
```

If the old run had `chargeCard` execute but the new code's conditional doesn't reach it, the step's subscriber is never registered, and its event becomes unconsumed → runtime error.

## Waiting Mechanisms

Workflow has three suspension primitives, each affected differently by upgrades:

**1. Steps** (`useStep`) — The primary concern. Explained above.

**2. Hooks/Webhooks** — External callbacks resume the workflow:
- Hook tokens are stored in the event log
- When an external system calls `/.well-known/workflow/v1/webhook/:token`, the runtime creates a `hook_received` event
- The workflow replays and the hook's promise resolves with the payload
- **Upgrade risk**: If code changes the hook's position in the workflow, same correlationId mismatch applies

**3. Sleep/Wait** — Temporal suspension:
- `wait_created` event stores a `resumeAt` timestamp
- World implementation schedules re-execution at that time
- Wait items are materialized as entities to prevent duplicate `wait_completed` events
- **Upgrade risk**: Same as steps — position-dependent correlationId

## The World's Role in Deployments

The World (storage backend) is mostly upgrade-agnostic. It stores events and routes messages:

```
world.events.create(runId, event)   // Append to immutable log
world.runs.get(runId)               // Read run entity
world.queue(queueName, message)     // Dispatch execution
```

However, the Vercel World adds **deployment-aware encryption**:

```js
const rawKey = await world.getEncryptionKeyForRun?.(runId, { deploymentId, ... });
```

Each deployment has its own encryption key. When resuming a run across deployments, the World fetches the original deployment's key via API:

```ts
deriveRunKey(deploymentKey, projectId, runId)     // Same deployment
fetchRunKey(deploymentId, projectId, runId)       // Cross-deployment
```

The `specVersion` field on each run tracks the event format version. The runtime uses this to correctly deserialize data regardless of the current SDK version:

```
SPEC_VERSION_LEGACY    // Pre-event-sourcing (< 4.1)
SPEC_VERSION_CURRENT   // Binary devalue format with "devl" prefix
```

## Recommended Deployment Strategies

### 1. Versioned Workflows (Safest)

Create a new workflow function with a different name for breaking changes:

```js
// v1: Keep running for in-flight executions
export default async function orderFlow_v1(order) { ... }

// v2: New runs use this
export default async function orderFlow_v2(order) { ... }
```

Since workflow names are part of the queue path (`__wkf_workflow_orderFlow_v1`), the two versions are completely isolated. Old runs finish with old code, new runs use new code.

### 2. Append-Only Changes (Safe for Simple Cases)

Only add steps at the end. Never reorder, remove, or insert in the middle. This preserves correlationId alignment for in-flight runs while allowing evolution.

### 3. Drain and Deploy (Operationally Simple)

Wait for all in-flight runs to complete (or cancel them), then deploy the new version. This avoids replay mismatches entirely but requires downtime or a draining mechanism.

### 4. Feature Flags in Steps (Not in Workflow)

Put conditional logic inside step implementations, not in the workflow function. Since step internals don't affect replay (only the step's position matters), this is safe:

```js
export async function chargeCard(validated) {
  'use step'
  // Safe: conditional inside step, not affecting step ordering
  if (validated.region === 'EU') {
    return chargeEU(validated)
  }
  return chargeUS(validated)
}
```

## Summary

| Change Type | Safe? | Why |
|---|---|---|
| Modify step implementation | Yes | Cached results replayed; new code only runs for not-yet-completed steps |
| Add steps at end | Yes | Existing correlationIds unchanged |
| Reorder steps | **No** | CorrelationId sequence breaks — wrong cached results returned |
| Insert steps in middle | **No** | Shifts all subsequent correlationIds |
| Remove steps | **No** | Unconsumed events in log → runtime error |
| Change conditionals around steps | **No** | Step registration order changes → correlationId mismatch |
| New workflow name | Yes | Completely isolated queue and event log |
| Modify non-step code | Yes | Doesn't affect event log or correlationIds |

The fundamental constraint is that **correlationIds are position-based, not content-based**. The deterministic ULID generator ensures the same sequence on every replay, but any structural change to the step call sequence invalidates the mapping between new code and old events.

## Critique: Postgres World and Production Safety

The problems described above are theoretical with the **local** world but very real with the **Postgres** world.

With the local world, each deployment typically gets a fresh filesystem (new container, new serverless instance). Old in-flight runs are effectively abandoned — you lose them, but you don't get silent data corruption from a mismatched replay.

With Postgres, every in-flight run is sitting in a shared database waiting to resume. When new code deploys, those runs will replay against the new workflow function. If the step sequence changed structurally, you get one of two outcomes:

1. **Silent corruption** — a step gets a cached result that belongs to a different step (same correlationId, different step). The workflow continues with wrong data.
2. **Loud failure** — unconsumed events in the log trigger a runtime error.

Outcome 1 is the scarier one because there is no indication that anything went wrong.

**There are no built-in safeguards.** The runtime does not:

- Tag workflow definitions with a version
- Compare the current code's step sequence against the event log
- Warn when a structural change conflicts with in-flight runs
- Provide a migration mechanism for evolving workflows
- Prevent a new deployment from resuming old runs with incompatible code

The system trusts that the developer maintains structural compatibility across every deployment, which is a significant operational risk for any long-running workflow in production.

Using Postgres is not *impossible*, but it requires strict discipline:

- Always use **versioned workflow names** for breaking changes (`orderFlow_v1` → `orderFlow_v2`)
- Only make **append-only** step changes to existing workflows
- Put conditional logic **inside steps**, never around step calls
- Consider a **drain-before-deploy** strategy for workflows that cannot be versioned

Without external tooling (CI checks comparing manifests across versions, a drain mechanism, or runtime compatibility validation), the Postgres world is unsafe for any workflow that may have in-flight runs at deployment time.

## What's Needed for Self-Hosted Production: Skew Protection

The Vercel world solves the upgrade problem by keeping both deployments alive simultaneously and routing each run to the deployment that created it. The `deploymentId` stored in every `run_created` event is the routing key — the queue infrastructure sends step executions back to the matching deployment's code, not the latest one.

This is essentially **skew protection**: old runs execute against old code, new runs execute against new code. No replay mismatch is possible because each run only ever sees the workflow function it was started with.

For self-hosted production with the Postgres world, two pieces are needed:

**1. Skew protection (deployment-aware routing)** — Run multiple deployment versions side by side, routing queue messages to the deployment that matches the run's `deploymentId`. This prevents any in-flight workflow from replaying against code it wasn't started with.

**2. Drain mechanism** — Once all runs belonging to an old deployment reach a terminal state (completed, failed, cancelled), retire that deployment. Without this, old deployments accumulate forever.

The three world implementations each solve different parts of this problem:

| World | Durable State | Deployment-Aware Routing | Production-Safe |
|---|---|---|---|
| Local | No (fresh filesystem per deploy) | N/A (no state to route) | Safe by isolation, but no durability |
| Postgres | Yes (shared database) | **No** | Unsafe without external routing layer |
| Vercel | Yes (Vercel infrastructure) | Yes (built into queue system) | Safe |

The missing layer for self-hosted Postgres production is a **deployment-aware message broker** — something that sits between the workflow runtime and the Postgres world, inspects the `deploymentId` on each run, and dispatches step/workflow executions to the correct running instance of the application. This is what Vercel's queue infrastructure provides out of the box and what a self-hosted setup would need to build or adopt to achieve the same safety guarantees.

---

## Spec Version and Transport Rollout

`@platformatic/world` declares `specVersion = SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT` (3). This flows as follows:

1. The **world** declares its highest supported spec version (`world.specVersion`).
2. The **runtime** tags new runs with that value via `events.create('run_created', { specVersion })`. The server persists it in `workflow_runs.spec_version`.
3. The **queue client** picks a transport per message: CBOR when `opts.specVersion >= 3`, JSON otherwise. Our client falls back to CBOR when `opts.specVersion` is missing, since every run we create is already v3.
4. The **server** stores the message in its arriving encoding (`payload` JSONB or `payload_bytes` BYTEA + `payload_encoding = 'cbor'`). The dispatcher forwards with a matching `Content-Type`.

### Three-step rollout

1. Deploy a server that accepts CBOR (`@platformatic/workflow >= 0.7.0`) while clients continue sending JSON. No behaviour change yet — CBOR acceptance is additive.
2. Deploy clients that send CBOR (`@platformatic/world >= 0.7.0`). Inbound mix moves toward `application/cbor`; verify with `SELECT payload_encoding, COUNT(*) FROM workflow_queue_messages GROUP BY 1`.
3. Once all in-flight runs are v3, the JSON path is dormant. Kept indefinitely for handler back-compat (a v2 client can still talk to a v3 server).

### Downgrade

Forward-only. The `002.undo.sql` migration refuses to run while any `payload_encoding = 'cbor'` rows exist — drain the queue first, then roll back the server.

