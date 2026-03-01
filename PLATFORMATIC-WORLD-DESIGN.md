# Platformatic World: Design Document

**Status:** Active
**Last Updated:** March 2026

---

## 1. Problem Statement

Workflow DevKit uses deterministic replay with position-based correlationIds (see [UPGRADE-SEMANTICS.md](./UPGRADE-SEMANTICS.md) for the full analysis). When a workflow resumes, it re-executes the entire workflow function from the beginning, matching step calls to cached results in the event log by correlationId. This works correctly only when the workflow code is the same version that started the run.

The existing world implementations each solve part of the problem:

| World | Durable State | Deployment-Aware Routing | Safe Upgrades |
|---|---|---|---|
| Local | No | N/A | Safe by isolation (no state survives) |
| Postgres | Yes | No | Unsafe — new code replays old events |
| Vercel | Yes | Yes (Vercel infrastructure) | Safe |

The Postgres world provides durability but no deployment-aware routing. When new code deploys, in-flight runs replay against the wrong code version, causing silent data corruption (wrong cached results returned to wrong steps) or runtime errors (unconsumed events).

**Goal:** Create a `PlatformaticWorld` that provides the safety of the Vercel world in self-hosted Kubernetes environments, using the same skew protection principles that ICC already implements for HTTP traffic.

---

## 2. Key Insight: Workflow Runs Are Sessions

ICC's skew protection solves exactly this problem for HTTP requests: when a user starts a session on version N, all subsequent requests continue on version N via cookie-based routing through the Gateway API.

Workflow runs have the same property. A run started on version N must continue executing on version N until it reaches a terminal state. The `deploymentId` stored in every `run_created` event is the equivalent of the `__plt_dpl` cookie — it identifies which deployment version owns that run.

The difference is the transport: HTTP requests flow through the Gateway API, but workflow queue messages flow through the World's queue system. The Platformatic World needs to apply the same version-pinning to queue messages that ICC's HTTPRoute rules apply to HTTP requests.

---

## 3. Design Rationale

### 3.1 Why All Operations Go Through a Central Service

The first design we considered split responsibilities: pods access Postgres directly for storage, ICC handles queue routing only. This approach failed because ICC could not safely determine when a deployment version had no in-flight workflow runs — making version decommissioning unreliable.

The workflow runtime has three suspension primitives with different visibility characteristics:

| Suspension Type | Queue Message? | Pod Heartbeat? | Resume Mechanism |
|---|---|---|---|
| **Step execution** | Yes | Yes (pod executing) | Queue dispatch |
| **Sleep / Wait** | No (event only) | No (pod idle) | Timer → `wait_completed` event → re-queue |
| **Hook / Webhook** | No (event only) | No (pod idle) | External HTTP → `hook_received` event → re-queue |

Steps are fully visible — they produce queue messages and execute on pods. But hooks and waits are invisible: they write events to the app's Postgres and then the pod finishes. No queue message exists. No pod has the run in memory. The run is suspended indefinitely (hooks) or until a future time (waits), waiting for an external trigger.

This creates three concrete failure modes in the split design:

**Gap 1: Webhook-suspended runs are invisible.** A workflow registers a webhook and suspends. The pod finishes — nothing in memory, no heartbeat signal, no queue message. ICC sees zero RPS, zero heartbeat-reported runs, zero pending queue messages — and concludes the version is safe to expire. When the webhook arrives hours later via HTTP, the Gateway routes it to the active version's pod (external callers don't have session cookies). That pod looks up the token in Postgres, finds the run belongs to an expired version — but the version's pods are scaled to zero. The run is unrecoverable.

**Gap 2: Orphaned runs after pod crashes.** A pod crashes mid-replay, before reaching the suspension handler. The consumed queue message is gone, the pod is dead, no heartbeat. The run is stuck in `running` status forever with no way to resume. No retry will happen because no message exists.

**Gap 3: Inaccurate draining decisions.** Heartbeats only track actively-executing runs. Suspended runs (waiting for webhooks or timers) are not "active" on any pod. When ICC scales a draining version to zero replicas, all heartbeat visibility is lost.

ICC's draining checker must answer: "Are there any non-terminal workflow runs for deployment version X?" In the split design, ICC cannot answer this question reliably. It can only approximate via queue messages (misses hooks and waits) and pod heartbeats (misses suspended runs, stale after crashes). The only authoritative source is the workflow runs table — which ICC does not have access to.

Several patches to the split design were considered:

- **Pods report suspended runs in heartbeats.** But pods don't know about runs they haven't recently executed. A suspended run from before a pod restart is invisible.
- **ICC checks its queue table for pending/deferred messages.** Covers steps and sleeps, but not hooks (hooks create no queue message).
- **Pods register hooks with ICC via a new API.** Possible, but adds a coordination point and moves ICC closer to owning storage anyway.
- **Webhook endpoints route through a central service.** A service maintains a hook registry and resolves `token → run → deploymentId`. This is exactly what the final design does.

Each patch moves the split design closer to centralizing all workflow state. The fundamental issue is that safe decommissioning requires authoritative knowledge of all non-terminal runs, and that knowledge must live in a single, accessible place.

### 3.2 Why the Service Is Separate from ICC

The next iteration we considered bundled all workflow operations directly into ICC. This solved the visibility problem but introduced a scalability concern: ICC is a control plane (version registry, HTTPRoute management, autoscaling, draining). Adding high-throughput workflow CRUD turns it into a data plane too, and the two have very different scaling characteristics.

A control plane handles infrequent, high-impact operations (version detection, route updates, scaling decisions). A workflow data plane handles frequent, high-throughput operations (event writes on every step, event reads on every replay, queue dispatches). Bundling both into one process means workflow throughput is constrained by control plane resources, and control plane stability is affected by workflow load spikes.

The solution is a separate Workflow Service — independently scalable, focused on workflow CRUD and queue routing, managed by ICC as cluster infrastructure.

---

## 4. Architecture

```
┌────────────────────────────────────────────────────────────┐
│                     ICC Control Plane                       │
│                                                            │
│  Version Registry    HTTPRoute Manager    Draining Checker │
│  ┌──────────────┐   ┌────────────────┐   ┌─────────────┐ │
│  │ myapp v1.2.3 │   │  HTTP routing  │   │ queries WF  │ │
│  │  (draining)  │   │  (browsers)    │   │ Service for │ │
│  │ myapp v1.2.4 │   │                │   │ active runs │ │
│  │  (active)    │   │                │   └──────┬──────┘ │
│  └──────────────┘   └────────────────┘          │        │
│                                                  │        │
│  Manages WF Service lifecycle (deploy, scale)    │        │
└──────────────────────────────────────────────────┼────────┘
                                                   │
                                                   ▼
                                    ┌──────────────────────────┐
                                    │    Workflow Service       │
                                    │   (independently scaled) │
                                    │                          │
                                    │  Storage API   Queue     │
                                    │  ┌─────────┐  Router    │
                                    │  │ events  │  ┌───────┐ │
                                    │  │ runs    │  │routes │ │
                                    │  │ steps   │  │by dpl │ │
                                    │  │ hooks   │  │  Id   │ │
                                    │  │ streams │  └───┬───┘ │
                                    │  └────┬────┘     │     │
                                    │       │          │     │
                                    │  ┌────▼──────────▼──┐  │
                                    │  │    PostgreSQL     │  │
                                    │  │  (WF Service DB)  │  │
                                    │  └──────────────────┘  │
                                    └──────────────┬─────────┘
                                                   │
                                     ┌─────────────┼─────────────┐
                                     │             │             │
                                     ▼             ▼             ▼
                            ┌──────────────┐ ┌──────────────┐
                            │  Watt Pod    │ │  Watt Pod    │
                            │  v1.2.3      │ │  v1.2.4      │
                            │              │ │              │
                            │ Workflow Cap │ │ Workflow Cap │
                            │ ┌──────────┐ │ │ ┌──────────┐ │
                            │ │ Plt World│ │ │ │ Plt World│ │
                            │ │          │ │ │ │          │ │
                            │ │ All ops ─┼─┼─┼─┼──▶ WF Svc│ │
                            │ │          │ │ │ │          │ │
                            │ └──────────┘ │ │ └──────────┘ │
                            │  (no DB)     │ │  (no DB)     │
                            └──────────────┘ └──────────────┘
```

**Three-tier separation:**

- **ICC (control plane):** Version registry, HTTPRoute management, autoscaling, draining decisions. Manages the Workflow Service's lifecycle (deploys, scales, monitors). Queries the Workflow Service API for draining checks. Does **not** handle any workflow CRUD.
- **Workflow Service (data plane):** Handles all World operations — storage (events, runs, steps, hooks, streams), queue routing, deferred delivery, webhook token resolution. Owns its PostgreSQL database. Scales independently based on workflow throughput.
- **Pods (executors):** Stateless. Talk exclusively to the Workflow Service. No database access, no ICC dependency for workflow operations.

---

## 5. Key Design Decisions

- **Workflow Service owns the database.** The service manages the schema, runs migrations, and holds the connection pool. Pods never touch Postgres directly. Per-application isolation is achieved via `application_id` scoping.
- **No local queue — the Workflow Service is the sole queue system.** Every `world.queue()` call goes to the Workflow Service. It handles both immediate and deferred delivery. No graphile-worker, no in-process message broker.
- **Pods are stateless executors.** A pod receives a message from the Workflow Service, executes workflow/step code, and calls the service API to store results. If a pod dies mid-execution, the service retries the message on another pod of the same version.
- **ICC manages the service's lifecycle.** ICC deploys the Workflow Service as cluster infrastructure (like the Gateway), scales it based on load, and monitors its health. ICC does not run workflow CRUD itself.
- **ICC queries the service for draining.** For draining decisions, ICC calls the Workflow Service's draining API to get authoritative run counts per deployment version. No heartbeat estimation.
- **Credentials stay centralized.** Pods need only the Workflow Service URL and an auth token. No Postgres credentials distributed to application pods.

---

## 6. Workflow Service API

The Workflow Service exposes REST endpoints that map directly to the World interface operations. All endpoints are scoped by application ID.

### 6.1 Events

```
POST   /api/v1/apps/:appId/runs/:runId/events
  Body: { eventType, correlationId, eventData, specVersion }
  → Creates an event in the run's event log

GET    /api/v1/apps/:appId/runs/:runId/events
  Query: ?order=asc
  → Returns all events for the run (used during replay)

GET    /api/v1/apps/:appId/runs/:runId/events/last
  → Returns the last event (used for status checks)
```

### 6.2 Runs

```
POST   /api/v1/apps/:appId/runs
  Body: { runId, workflowName, deploymentId, input, specVersion }
  → Creates a new run

GET    /api/v1/apps/:appId/runs/:runId
  → Returns run state (status, deploymentId, createdAt, etc.)

PATCH  /api/v1/apps/:appId/runs/:runId
  Body: { status, result, error }
  → Updates run state (e.g., mark completed/failed/cancelled)

GET    /api/v1/apps/:appId/runs
  Query: ?status=running&deploymentId=1.2.3&limit=50
  → Lists runs with filters
```

### 6.3 Steps

```
POST   /api/v1/apps/:appId/runs/:runId/steps
  Body: { stepId, correlationId, stepName, input }
  → Creates a step record

PATCH  /api/v1/apps/:appId/runs/:runId/steps/:stepId
  Body: { status, result, error }
  → Updates step state

GET    /api/v1/apps/:appId/runs/:runId/steps/:stepId
  → Returns step state
```

### 6.4 Hooks

```
POST   /api/v1/apps/:appId/hooks
  Body: { hookId, runId, correlationId, token }
  → Registers a hook (webhook endpoint)

GET    /api/v1/apps/:appId/hooks/:token
  → Looks up a hook by token (used when webhook is received)

PATCH  /api/v1/apps/:appId/hooks/:hookId
  Body: { status, payload }
  → Updates hook state (e.g., when webhook payload is received)
```

### 6.5 Streams

```
POST   /api/v1/apps/:appId/streams/:streamId/chunks
  Body: { data, index }
  → Writes a chunk to a stream

POST   /api/v1/apps/:appId/streams/:streamId/close
  → Closes a stream

GET    /api/v1/apps/:appId/streams/:streamId
  → Reads all chunks from a stream (Server-Sent Events or JSON array)

GET    /api/v1/apps/:appId/runs/:runId/streams
  → Lists streams for a run
```

### 6.6 Queue

```
POST   /api/v1/apps/:appId/queue
  Body: { queueName, message, deploymentId, idempotencyKey, delaySeconds }
  → Enqueues a message (immediate or deferred delivery)
```

**Response (immediate delivery):**
```json
{ "messageId": "msg_...", "routedTo": "1.2.3" }
```

**Response (deferred delivery):**
```json
{ "messageId": "msg_...", "scheduled": true, "deliverAt": "2026-03-01T12:05:00Z" }
```

**Error responses:**
- `404` — No active/draining deployment for the run's version
- `409` — Duplicate message (idempotency key already processed)
- `503` — No healthy pods for the target version

### 6.7 Encryption

```
GET    /api/v1/apps/:appId/encryption-key?runId=...
  → Returns the derived encryption key for a run
```

Per-app secrets are stored in the service's database. Per-run keys are derived from `secret + runId`. Pods receive derived keys only.

### 6.8 Draining API (Called by ICC)

```
GET    /api/v1/apps/:appId/versions/:deploymentId/status
  → Returns { activeRuns, pendingHooks, pendingWaits, queuedMessages }

POST   /api/v1/apps/:appId/versions/:deploymentId/expire
  → Force-cancels all in-flight runs for this version, dead-letters queued messages
```

These endpoints are called by ICC's draining checker, not by pods. They provide the authoritative run counts that ICC needs for safe decommissioning.

### 6.9 Handler Registration

```
POST   /api/v1/apps/:appId/handlers
  Body: { podId, deploymentVersion, endpoints: { workflow, step, webhook } }
  → Registers a pod's queue handler endpoints

DELETE /api/v1/apps/:appId/handlers/:podId
  → Deregisters a pod (on shutdown)
```

When pods start, they register their queue handler endpoints with the Workflow Service. The service uses these for dispatching queue messages.

### 6.10 Version Notification (Called by ICC)

```
POST   /api/v1/versions/notify
  Body: { applicationId, deploymentVersion, status: "active" | "draining" | "expired" }
```

When ICC detects a new deployment version (via Machinist/watt-extra), it notifies the Workflow Service so the service knows which versions are active, draining, or expired. This allows the service to reject queue submissions for expired versions immediately rather than attempting delivery.

---

## 7. World Interface Implementation

The Platformatic World is a thin HTTP client to the Workflow Service. Every operation is a REST call.

```typescript
class PlatformaticWorld implements World {
  #serviceUrl: string
  #appId: string
  #deploymentVersion: string

  constructor({ serviceUrl, appId, deploymentVersion }) {
    this.#serviceUrl = serviceUrl
    this.#appId = appId
    this.#deploymentVersion = deploymentVersion
  }

  // --- Storage: all delegated to Workflow Service REST API ---

  events = {
    create: async (runId, event) => {
      return this.#post(`/runs/${runId}/events`, event)
    },
    list: async (runId, opts) => {
      return this.#get(`/runs/${runId}/events`, opts)
    },
    getLast: async (runId) => {
      return this.#get(`/runs/${runId}/events/last`)
    },
  }

  runs = {
    create: async (run) => {
      return this.#post('/runs', { ...run, deploymentId: this.#deploymentVersion })
    },
    get: async (runId) => {
      return this.#get(`/runs/${runId}`)
    },
    update: async (runId, data) => {
      return this.#patch(`/runs/${runId}`, data)
    },
    list: async (filters) => {
      return this.#get('/runs', filters)
    },
  }

  // steps, hooks, streams follow the same pattern...

  // --- Queue: routed through Workflow Service ---

  async queue(queueName, message, opts) {
    return this.#post('/queue', {
      queueName,
      message,
      deploymentId: opts?.deploymentId ?? this.#deploymentVersion,
      idempotencyKey: opts?.idempotencyKey,
      delaySeconds: opts?.delaySeconds,
    })
  }

  createQueueHandler(prefix, handler) {
    return async (req) => {
      const { message, meta } = await req.json()
      const result = await handler(message, meta)
      return Response.json(result ?? {})
    }
  }

  async getDeploymentId() {
    return this.#deploymentVersion
  }

  async getEncryptionKeyForRun(runOrId, context?) {
    const runId = typeof runOrId === 'string' ? runOrId : runOrId.runId
    const { key } = await this.#get(`/encryption-key`, { runId })
    return key
  }

  // --- HTTP helpers ---

  async #post(path, body) {
    const res = await fetch(`${this.#serviceUrl}/api/v1/apps/${this.#appId}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.json()
  }

  async #get(path, query?) {
    const url = new URL(`${this.#serviceUrl}/api/v1/apps/${this.#appId}${path}`)
    if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, String(v)))
    const res = await fetch(url)
    return res.json()
  }

  async #patch(path, body) {
    const res = await fetch(`${this.#serviceUrl}/api/v1/apps/${this.#appId}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.json()
  }
}
```

---

## 8. Queue Routing and Reliability

### 8.1 Message Flow

```
Workflow Runtime (Pod v1.2.3)
    │
    │  world.queue('__wkf_step_myStep', { workflowRunId, stepId, ... })
    │
    ▼
Workflow Service
    │
    │  1. Extract deploymentId from message
    │  2. Find registered pod endpoint for that deploymentId
    │  3. POST message to pod's queue handler endpoint
    │
    ▼
Workflow Runtime (Pod v1.2.3)  ← same version that started the run
    │
    │  Handler executes the step
    │  Step result stored via Workflow Service API
    │  world.queue('__wkf_workflow_myWorkflow', { runId }) to resume
    │
    ▼
Workflow Service
    │
    │  Routes workflow resumption back to v1.2.3
    │
    ▼
Workflow Runtime (Pod v1.2.3)  ← replays with correct code
```

### 8.2 Routing Rules

The queue router applies the same version-pinning logic as ICC's HTTPRoute rules:

1. **Extract the run ID** from the queue message. For workflow messages, it is `message.runId`. For step messages, it is `message.workflowRunId`.

2. **Look up the deployment version** for that run. The `deploymentId` is included in the queue message by the originating pod (it was stored in the `run_created` event and is available to the runtime).

3. **Route to the correct deployment:**
   - If the run's `deploymentId` matches an `active` or `draining` version → route to that version's pod endpoint.
   - If the run's `deploymentId` matches an `expired` version → the run cannot be resumed. Return an error (the run may need to be cancelled).
   - If no deployment version is found (new run, no `deploymentId` in message) → route to the `active` version.

4. **Deliver the message** via HTTP POST to the target pod's registered queue handler endpoint. When multiple pods exist for the same version, the service load-balances across them.

### 8.3 Deferred Message Delivery

The workflow runtime uses `delaySeconds` in three situations:

1. **`sleep()` / `wait()`** — Temporal suspension. The runtime queues a wake-up message with a delay equal to the sleep duration.
2. **Hook conflict retries** — When a hook event arrives while the workflow is mid-execution, the runtime re-queues with a short delay.
3. **Suspension handler timeout** — The `handleSuspension()` function returns a `timeoutSeconds` that the world uses to schedule the next workflow invocation.

The Workflow Service handles deferred messages with a `deliver_at` timestamp:

1. **On receive:** If `delaySeconds > 0`, the service inserts the message into `workflow_queue_messages` with `deliver_at = NOW() + delaySeconds` and `status = 'deferred'`. Returns immediately with `{ messageId, scheduled: true }`.
2. **Periodic poller:** A poller on the service leader (using Postgres advisory locks to prevent duplicate polling) runs every 5 seconds:
   ```sql
   UPDATE workflow_queue_messages
   SET status = 'pending'
   WHERE status = 'deferred' AND deliver_at <= NOW()
   RETURNING *
   ```
3. **Dispatch:** Each returned message is dispatched through the normal routing logic (look up `deploymentId`, route to correct pod).

**Precision:** The poller interval (default 5s, configurable) determines the maximum delay overshoot. A message with `delaySeconds: 60` will be delivered between 60–65 seconds later. This is acceptable for workflow sleeps, which are typically minutes or hours.

**Reliability:** Deferred messages are persisted in Postgres. If the service restarts, the poller picks them up on the next tick. Messages are never lost.

### 8.4 Message Lifecycle

```
                          delaySeconds > 0
  Received ──────────────────────────────────▶ Deferred
     │                                            │
     │ delaySeconds == 0                          │ deliver_at reached
     ▼                                            ▼
  Pending ──────────────────────────────────▶ Dispatched
     │                                            │
     │ pod returns error                          │ pod returns 200
     ▼                                            ▼
  Retrying (exp backoff) ──────────────────▶ Delivered
     │
     │ max retries exhausted
     ▼
   Dead
```

- **Deferred → Pending:** The periodic poller promotes deferred messages when `deliver_at <= NOW()`.
- **Pending → Dispatched:** The service routes the message to the correct pod and POSTs it.
- **Dispatched → Delivered:** The pod processes the message and returns 200.
- **Dispatched → Retrying:** The pod returns an error or is unreachable. The service retries with exponential backoff (1s, 2s, 4s, 8s, up to 60s). Default max retries: 10.
- **Retrying → Dead:** After exhausting retries, the message is moved to dead-letter status. Operators are alerted.

### 8.5 Idempotency

The `idempotencyKey` (typically the step's `correlationId`) prevents duplicate processing. The service stores processed keys with a TTL matching the grace period. Duplicate submissions return `409 Conflict` with the original `messageId`.

### 8.6 Ordering Guarantees

Queue messages for the same run are not guaranteed to be processed in order — the workflow runtime already handles this via event replay. Each workflow invocation loads the full event log and replays from the beginning, so message ordering does not affect correctness.

### 8.7 Deferred Message Guarantees

Deferred messages are persisted in Postgres and survive restarts. The poller uses `FOR UPDATE SKIP LOCKED` to ensure exactly-once pickup in multi-replica deployments (only the leader polls, enforced via Postgres advisory locks). If the leader fails, another replica acquires the lock and takes over polling.

---

## 9. Database Schema

The Workflow Service manages its own PostgreSQL database. Per-application isolation is achieved via `application_id` foreign keys.

### 9.1 Core Workflow Tables

```sql
-- Per-application workflow runs
CREATE TABLE workflow_runs (
  id              VARCHAR PRIMARY KEY,
  application_id  INTEGER NOT NULL,
  workflow_name   VARCHAR NOT NULL,
  deployment_id   VARCHAR NOT NULL,
  status          VARCHAR NOT NULL DEFAULT 'created',
  input           JSONB,
  result          JSONB,
  error           JSONB,
  spec_version    VARCHAR NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wr_app_status ON workflow_runs (application_id, status);
CREATE INDEX idx_wr_app_deployment ON workflow_runs (application_id, deployment_id);

-- Immutable event log per run
CREATE TABLE workflow_events (
  id              SERIAL PRIMARY KEY,
  run_id          VARCHAR NOT NULL REFERENCES workflow_runs(id),
  application_id  INTEGER NOT NULL,
  event_type      VARCHAR NOT NULL,
  correlation_id  VARCHAR,
  event_data      JSONB,
  spec_version    VARCHAR NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_we_run_id ON workflow_events (run_id, id ASC);

-- Step records
CREATE TABLE workflow_steps (
  id              VARCHAR PRIMARY KEY,
  run_id          VARCHAR NOT NULL REFERENCES workflow_runs(id),
  application_id  INTEGER NOT NULL,
  correlation_id  VARCHAR NOT NULL,
  step_name       VARCHAR NOT NULL,
  status          VARCHAR NOT NULL DEFAULT 'created',
  input           JSONB,
  result          JSONB,
  error           JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ws_run_id ON workflow_steps (run_id);

-- Webhook hooks
CREATE TABLE workflow_hooks (
  id              VARCHAR PRIMARY KEY,
  run_id          VARCHAR NOT NULL REFERENCES workflow_runs(id),
  application_id  INTEGER NOT NULL,
  correlation_id  VARCHAR NOT NULL,
  token           VARCHAR NOT NULL UNIQUE,
  status          VARCHAR NOT NULL DEFAULT 'pending',
  payload         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wh_token ON workflow_hooks (token);

-- Stream chunks (for DurableAgent output)
CREATE TABLE workflow_stream_chunks (
  id              SERIAL PRIMARY KEY,
  stream_id       VARCHAR NOT NULL,
  run_id          VARCHAR NOT NULL REFERENCES workflow_runs(id),
  application_id  INTEGER NOT NULL,
  chunk_index     INTEGER NOT NULL,
  data            BYTEA NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wsc_stream ON workflow_stream_chunks (stream_id, chunk_index ASC);
CREATE INDEX idx_wsc_run ON workflow_stream_chunks (run_id);
```

### 9.2 Queue Tables

```sql
-- Registered queue handler endpoints per pod
CREATE TABLE workflow_queue_handlers (
  id              SERIAL PRIMARY KEY,
  deployment_version VARCHAR NOT NULL,
  application_id  INTEGER NOT NULL,
  pod_id          VARCHAR NOT NULL,
  workflow_url    VARCHAR NOT NULL,
  step_url        VARCHAR NOT NULL,
  webhook_url     VARCHAR NOT NULL,
  registered_at   TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (application_id, pod_id)
);

-- Queue messages (immediate + deferred + retries + dead-letter)
CREATE TABLE workflow_queue_messages (
  id              SERIAL PRIMARY KEY,
  idempotency_key VARCHAR,
  queue_name      VARCHAR NOT NULL,
  run_id          VARCHAR NOT NULL,
  deployment_version VARCHAR NOT NULL,
  application_id  INTEGER NOT NULL,
  payload         JSONB NOT NULL,
  status          VARCHAR DEFAULT 'pending',  -- deferred, pending, delivered, failed, dead
  attempts        INTEGER DEFAULT 0,
  deliver_at      TIMESTAMPTZ,     -- NULL = immediate, set = deferred delivery
  next_retry_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  UNIQUE (idempotency_key)
);

-- Deferred message poller: find messages due for delivery
CREATE INDEX idx_wqm_deferred ON workflow_queue_messages (deliver_at)
  WHERE status = 'deferred';

-- Retry poller: find messages ready for retry
CREATE INDEX idx_wqm_status_retry ON workflow_queue_messages (status, next_retry_at)
  WHERE status = 'failed';

-- Pending dispatch queue
CREATE INDEX idx_wqm_pending ON workflow_queue_messages (created_at)
  WHERE status = 'pending';

CREATE INDEX idx_wqm_run_id ON workflow_queue_messages (run_id);
```

### 9.3 Encryption Keys

```sql
CREATE TABLE workflow_encryption_keys (
  application_id  INTEGER NOT NULL,
  secret          BYTEA NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (application_id)
);
```

---

## 10. ICC Integration

ICC does not handle any workflow CRUD. Its responsibilities are limited to:

### 10.1 Workflow Service Lifecycle Management

ICC deploys and manages the Workflow Service as cluster infrastructure:

- **Deployment:** ICC creates the Workflow Service Deployment and Service in the `platformatic` namespace during cluster setup (similar to how it sets up the Gateway).
- **Scaling:** ICC monitors the Workflow Service's resource usage and scales it based on request throughput and latency. This is independent of application pod scaling.
- **Health monitoring:** ICC checks the service's health endpoint and restarts it if unhealthy.
- **Database provisioning:** ICC provisions the Workflow Service's PostgreSQL database (or the service connects to a pre-existing instance via configuration).

### 10.2 Draining Checks

ICC's draining checker calls the Workflow Service's draining API to determine if a version can be safely expired:

```
GET /api/v1/apps/:appId/versions/:deploymentId/status
→ { activeRuns: 3, pendingHooks: 1, pendingWaits: 0, queuedMessages: 5 }
```

A version can be expired when:
1. **Zero HTTP RPS** (existing Prometheus check)
2. **Zero active workflow runs** (Workflow Service reports `activeRuns: 0`)
3. **Zero pending hooks** (no webhook-suspended runs)
4. **Zero queued messages** (no pending deliveries)

This is authoritative — the Workflow Service answers from its own database. No estimation, no stale heartbeats, no blind spots.

### 10.3 Force-Expiration

When the grace period expires and in-flight runs remain, ICC calls:

```
POST /api/v1/apps/:appId/versions/:deploymentId/expire
```

The Workflow Service:
1. Marks all in-flight runs as `cancelled` with a structured error.
2. Moves deferred and pending queue messages for the version to dead-letter.
3. Returns a summary of cancelled runs and dead-lettered messages.

ICC then:
4. Removes the version's HTTPRoute rules.
5. Scales the Deployment to 0 replicas.

### 10.4 Dashboard Extensions

The ICC dashboard's skew protection view is extended with workflow-specific information:

- **In-flight runs count** per draining version — shows how many workflow runs are blocking expiration.
- **Run details** — clickable list of active runs for a draining version, with run ID, workflow name, status, and age.
- **Force-expire warning** — when force-expiring a version with in-flight runs, the dashboard shows a confirmation dialog listing the runs that will be cancelled.

---

## 11. Webhook Routing

Since the Workflow Service owns the hook registry, webhook routing is straightforward:

1. External webhook arrives: `POST /.well-known/workflow/v1/webhook/:token`
2. The Gateway routes this to the Workflow Service (via a dedicated HTTPRoute or through any pod that forwards to the service).
3. The Workflow Service looks up the hook by `token` in `workflow_hooks` → gets `run_id` → gets `deployment_id` from `workflow_runs`.
4. The service stores the webhook payload in the hook record.
5. The service queues a workflow resume message routed to the correct deployment version.

Webhook tokens are inherently run-scoped. Since the Workflow Service owns the hook table, it can resolve `token → run → deploymentId` in a single query — no additional routing rules needed.

---

## 12. Deployment Lifecycle

The complete lifecycle of a deployment version, combining HTTP and workflow skew protection:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│   Active    │────▶│   Draining   │────▶│   Expiring  │────▶│   Expired    │
│             │     │              │     │             │     │              │
│ New HTTP    │     │ Pinned HTTP  │     │ No HTTP     │     │ Scaled to 0  │
│ sessions    │     │ sessions     │     │ traffic     │     │ No routing   │
│ New workflow│     │ In-flight    │     │ Remaining   │     │ Runs         │
│ runs        │     │ runs         │     │ runs cancel │     │ cancelled    │
└─────────────┘     └──────────────┘     └─────────────┘     └──────────────┘
                                               │
                                               │ Grace period
                                               │ exceeded
                                               ▼
                                     Force-cancel in-flight
                                     runs for this version
```

**Transition triggers:**

- **Active → Draining:** A newer version is detected by ICC.
- **Draining → Expiring:** Zero HTTP RPS AND zero in-flight workflow runs AND zero pending hooks AND zero queued messages, OR grace period exceeded.
- **Expiring → Expired:** In-flight runs cancelled (via Workflow Service expire API), HTTPRoute rules removed, Deployment scaled to 0.

---

## 13. Trade-offs

### Advantages

- **Safe decommissioning.** The Workflow Service has authoritative knowledge of all in-flight runs, pending hooks, and queued messages. The draining query is a direct database check — no estimation, no stale heartbeats, no blind spots. The service also detects orphaned runs (stuck in `running` with no recent activity) and can re-queue or alert.
- **Independent scalability.** The Workflow Service scales independently from ICC and from application pods. A burst of workflow activity scales the service without affecting ICC's control plane. ICC handles version transitions without being bottlenecked by workflow I/O.
- **ICC stays lean.** ICC retains its focused role as a control plane: version registry, HTTPRoute management, autoscaling, draining orchestration. No workflow CRUD, no event storage, no queue routing, no database migration management for workflow tables.
- **Simple pod model.** Pods have a single dependency: the Workflow Service URL. No Postgres connection strings, no ICC URL for workflow operations, no database drivers.
- **Centralized observability.** The Workflow Service has complete visibility into all workflow state — active runs per app per version, event log inspection, queue depth, delivery latency, retry rates, cross-application metrics.
- **Centralized schema management.** The Workflow Service runs its own migrations. Applications don't need to manage workflow schema versions.
- **Multi-tenancy.** The service can enforce per-application quotas, rate limits, and access control at the API layer.
- **Webhook resolution.** Solved natively — the service owns the hook table and can resolve `token → run → deploymentId` in a single query.

### Disadvantages

- **Replay latency.** Workflow replay loads the entire event log on every resume. With direct Postgres, this is ~0.5ms. Here, it's an HTTP round-trip to the Workflow Service (~1-5ms within a cluster). The events endpoint returns the full list in a single response, so the overhead is one round-trip per replay, not per event. For most workflows (tens of steps, seconds-to-minutes execution), this is acceptable.
- **Additional service to operate.** The Workflow Service is a new deployment — its own pods, database, health checks, scaling policies. Mitigated by ICC managing the service's lifecycle automatically. Operators configure it once (database connection, resource limits), and ICC handles deployment, scaling, and health monitoring.
- **Workflow Service as dependency.** If the service goes down, all workflow operations stop. Mitigated by running multiple replicas behind a Kubernetes Service. Write operations are append-only or single-row updates. If the service is temporarily down, pods can buffer writes locally and retry. Note: in any design, if the queue router goes down, pods can't make progress anyway — the additional failure mode here is storage unavailability, which is marginal.
- **Network bandwidth.** All workflow data flows through the Workflow Service. For workflows with large payloads (e.g., AI agent conversations with many tool calls), this adds network hops.

---

## 14. Comparison with Existing Worlds

| Aspect | Local | Postgres | Vercel | **Platformatic** |
|---|---|---|---|---|
| Storage | Filesystem | PostgreSQL | Vercel API | **Workflow Service (PostgreSQL)** |
| Queue | In-process | graphile-worker | Vercel Queue | **Workflow Service queue router** |
| Deferred messages | In-process timer | graphile-worker delay | Vercel Queue delay | **Workflow Service deferred delivery** |
| Deployment routing | N/A | None | Vercel infra | **Workflow Service (deploymentId routing)** |
| Encryption | None | None | Per-deployment keys | **Per-app shared secret** (optional) |
| Durability | None | Full | Full | **Full** |
| Multi-version safety | By isolation | Unsafe | Safe | **Safe** |
| Draining | N/A | N/A | Vercel manages | **ICC queries Workflow Service** |
| Safe decommissioning | N/A | N/A | Vercel manages | **Authoritative — all run states visible** |
| Infrastructure | None | PostgreSQL | Vercel | **K8s + ICC + Workflow Service + PostgreSQL** |

---

## 15. Implementation Phases

### Phase 1 — Workflow Service Core

- Create the Workflow Service as a Fastify application.
- Implement database schema and migrations.
- Implement CRUD endpoints for events, runs, steps, hooks, streams.
- Implement encryption key management.
- Implement handler registration API.
- Unit tests with mock workflow data.

### Phase 2 — Queue Router + Deferred Delivery

- Implement `POST /api/v1/apps/:appId/queue` for message routing.
- Implement deferred delivery: `deliver_at` storage, periodic poller with advisory locks.
- Implement deployment-version routing from `deploymentId` in messages.
- Add retry logic with exponential backoff.
- Add idempotency key deduplication.

### Phase 3 — Platformatic World Client

- Implement `PlatformaticWorld` as an HTTP client to the Workflow Service.
- Implement `createQueueHandler()` for receiving dispatched messages.
- Add `"platformatic"` world option to the `@platformatic/workflow` capability config.
- Integration tests: create a workflow, execute steps, verify state via service API.

### Phase 4 — ICC Integration

- Implement Workflow Service lifecycle management in ICC (deploy, scale, monitor).
- Implement draining API calls from ICC's draining checker.
- Implement force-expiration flow (ICC → Workflow Service → cancel runs).
- Implement version notification (ICC → Workflow Service).
- Dashboard extensions for workflow run visibility per version.
- E2E tests: deploy v2 while v1 has in-flight runs, verify v1 runs complete on v1 code.

### Phase 5 — Reliability + Multi-Tenancy

- Rate limiting per application.
- Quota enforcement (max runs, max events per run).
- Local write-ahead buffering on pod side for service transient failures.
- Dead-letter handling and alerting.
- Orphaned run detection and recovery.
- Metrics: API latency, throughput, error rates, queue depth.

---

## 16. Open Questions

1. **Authentication.** How do pods authenticate with the Workflow Service? Options: (a) per-pod JWT issued during watt-extra registration, (b) shared secret per application, (c) mTLS within the cluster. ICC-to-service authentication can use a separate mechanism.

2. **Data retention.** The Workflow Service can enforce per-app retention policies (e.g., delete completed runs older than 30 days). What defaults make sense?

3. **Migration from Postgres world.** If an application already uses `@workflow/world-postgres`, how does it migrate? The Workflow Service could provide an import API, or the first deployment with `world: "platformatic"` could trigger migration from the app's existing database.

4. **API versioning.** The service API mirrors the World interface. If the interface changes in a future SDK version, the API must remain backward-compatible. Use `/api/v1/` prefix and add `/api/v2/` for breaking changes.

5. **Large payloads.** Should the service support streaming for large step results and stream chunks, or is JSON-over-HTTP sufficient?

6. **Shared vs dedicated database.** Should the Workflow Service use its own dedicated PostgreSQL instance, or can it share ICC's database with a separate schema? A dedicated instance provides better isolation; a shared instance reduces operational overhead.

7. **Webhook ingress.** Should the Workflow Service be directly accessible from outside the cluster (for webhook callbacks), or should webhooks always route through the Gateway to a pod, which forwards to the service? Direct access is simpler but exposes the service to the internet.
