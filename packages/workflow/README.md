# @platformatic/workflow

Workflow orchestration service for [Vercel Workflow DevKit](https://useworkflow.dev) on self-hosted Kubernetes. Manages all workflow state (runs, steps, events, hooks, streams) and routes queue messages to the correct deployment version.

## Quick Start

```bash
# Start PostgreSQL
docker run -d --name workflow-pg \
  -e POSTGRES_USER=wf -e POSTGRES_PASSWORD=wf -e POSTGRES_DB=workflow \
  -p 5434:5432 postgres:17-alpine

# Start the workflow service
npx @platformatic/workflow postgresql://wf:wf@localhost:5434/workflow
```

The service starts on `http://localhost:3042`. Migrations run automatically on first start.

## CLI Options

```
npx @platformatic/workflow <database-url> [options]

Options:
  --host, -H    Listen host (default: 0.0.0.0)
  --port, -p    Listen port (default: 3042)
  --help        Show help
```

## Operating Modes

**Single-tenant** (local dev) — No K8s service account token detected. No authentication, one implicit application auto-provisioned.

**Multi-tenant** (Kubernetes) — K8s service account token present. All requests authenticated via K8s TokenReview API. Per-application isolation enforced at the SQL level.

## API

All app-scoped endpoints are prefixed with `/api/v1/apps/:appId`.

### Core

| Method | Path | Description |
|---|---|---|
| `POST` | `/runs/:runId/events` | Create an event (main write path) |
| `GET` | `/runs/:runId/events` | List events for a run |
| `GET` | `/runs/:runId` | Get run by ID |
| `GET` | `/runs` | List runs (filters: `status`, `workflowName`, `deploymentId`) |
| `GET` | `/runs/:runId/steps` | List steps for a run |
| `GET` | `/hooks` | List hooks (filter: `runId`) |
| `GET` | `/hooks/by-token/:token` | Get hook by token |

### Actions

| Method | Path | Description |
|---|---|---|
| `POST` | `/runs/:runId/replay` | Replay a completed run |
| `POST` | `/runs/:runId/cancel` | Cancel a running run |
| `POST` | `/runs/:runId/wake-up` | Cancel active sleeps |
| `GET` | `/workflows/:workflowName/template` | Step template from last completed run |

### Queue & Streams

| Method | Path | Description |
|---|---|---|
| `POST` | `/queue` | Enqueue a message (accepts `application/json` or `application/cbor`) |
| `POST` | `/handlers` | Register queue handler endpoints |
| `PUT` | `/runs/:runId/streams/:name` | Write stream chunks |
| `GET` | `/runs/:runId/streams` | List stream names |
| `GET` | `/runs/:runId/streams/:name/chunks` | Paginated stream chunks (`?limit`, `?cursor`) |
| `GET` | `/runs/:runId/streams/:name/info` | Stream metadata (`tailIndex`, `done`) |

#### Queue payload encoding

Messages are stored in the encoding they arrive in. JSON bodies land in the `payload` JSONB column; CBOR bodies land in `payload_bytes` (BYTEA) with `payload_encoding = 'cbor'`. The dispatcher forwards to handler URLs with a matching `Content-Type`, so a run's transport format stays consistent end-to-end across retries and re-enqueues.

Migration `002.do.sql` adds `payload_bytes` + `payload_encoding` columns and an XOR constraint (exactly one of `payload` / `payload_bytes` per row). The undo migration refuses to run while any `payload_encoding = 'cbor'` rows exist — drain the queue before downgrading.

### Admin (requires admin service account)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/apps` | Provision application |
| `POST` | `/api/v1/apps/:appId/k8s-binding` | Create K8s ServiceAccount binding |
| `GET` | `/api/v1/apps/:appId/quotas` | Get quotas |
| `PUT` | `/api/v1/apps/:appId/quotas` | Set quotas (`maxRuns`, `maxEventsPerRun`, `maxQueuePerMinute`) |
| `POST` | `/api/v1/apps/:appId/versions/:deploymentId/expire` | Force-expire a version |

### Health

| Endpoint | Description |
|---|---|
| `GET /ready` | Readiness probe |
| `GET /status` | Liveness probe |
| `GET /metrics` | Prometheus metrics |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | | PostgreSQL connection string (or pass as CLI argument) |
| `PORT` | `3042` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP listen host |
| `K8S_API_SERVER` | `https://kubernetes.default.svc` | K8s API server (multi-tenant only) |
| `K8S_ADMIN_SERVICE_ACCOUNT` | | Admin service account (`namespace:name`) |
| `WF_ENABLE_POLLER` | `true` | Enable queue poller/dispatcher |

## Kubernetes Deployment

In production, the service runs as part of the [Platformatic](https://platformatic.dev/) Helm chart with [ICC](https://icc.platformatic.dev/) handling service discovery and handler registration. See the [Operator Guide](https://github.com/platformatic/platformatic-world/blob/main/doc/operator-guide.md) for details.

## License

Apache-2.0
