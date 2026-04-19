This file provides guidance to AI coding agents like Claude Code (claude.ai/code), Cursor AI, Codex, Gemini CLI, GitHub Copilot, and other AI coding assistants when working with code in this repository.

# Platformatic World

Deployment-aware workflow orchestration for self-hosted Kubernetes environments. Routes queue messages through a central Fastify service that pins each workflow run to its originating deployment version.

## Commands

```bash
# Prerequisites: Docker running, Node >= 22.19.0, pnpm >= 10

# Start PostgreSQL (port 5434)
docker compose up -d

# Install dependencies
pnpm install

# Lint (neostandard + ESLint 9 flat config, root eslint.config.js)
pnpm lint

# Run all tests (workflow + world, excludes e2e)
pnpm test

# Run a single test file
node --test --test-concurrency=1 packages/workflow/test/events.test.ts

# Run e2e tests (requires PostgreSQL on port 5434)
pnpm test:e2e:v5      # smoke suite against workflow@5.0.0-beta SDK
pnpm test:e2e:v4      # smoke suite against workflow@4.2.x stable SDK
pnpm test:e2e:vercel  # full Vercel-ported suite (~220s)
```

## Monorepo Layout

pnpm workspace with three packages:

- **`packages/workflow/`** (`@platformatic/workflow`) — Fastify 5 REST API. Owns storage, queue routing, deployment lifecycle. Multi-tenant with per-app isolation.
- **`packages/world/`** (`@platformatic/world`) — Thin HTTP client (undici Pool) implementing the `@workflow/world` `World` interface.
- **`e2e-v5/`** — Next.js test app + end-to-end test suites on `workflow@5.0.0-beta.x` (matches Vercel's main-branch CI).
- **`e2e-v4/`** — Same workbench pattern, pinned to `workflow@4.2.x` stable. Guards the v4 runtime path.

## TypeScript

Uses Node's native type stripping (Node 22+). No build step, no `tsconfig` compilation. Run `.ts` files directly with `node`.

## Testing

- Test runner: `node:test` (not Jest, not Vitest)
- Workflow tests: `--test-concurrency=1` — required because tests share the same PostgreSQL database
- World tests: integration tests that need a running workflow service
- Test helper at `packages/workflow/test/helper.ts` — `setupTest()` creates an isolated app context with random `appId`; `teardownTest()` cleans up all rows for that app
- PostgreSQL connection: `postgresql://wf:wf@localhost:5434/workflow` (via `docker-compose.yml`)

## Linting

ESLint 9 flat config with `neostandard` (TypeScript mode). Single root `eslint.config.js`.

## Architecture

### Workflow Service (`packages/workflow/`)

Fastify 5 app built with `@fastify/autoload` loading plugins from `plugins/` directory.

Key components:
- **`plugins/`** — One file per API domain (events, runs, steps, hooks, streams, queue, encryption, handlers, draining, versions, dead-letters, quotas, metrics, health, apps)
- **`lib/db.ts`** — pg.Pool + Postgrator migrations. The `decorateDb()` function is called on the root app (not inside a plugin) so `app.pg` is available everywhere
- **`lib/auth/`** — Auth plugin using `Symbol.for('skip-override')` to break Fastify encapsulation, making its `onRequest` hook apply to sibling plugins
- **`queue/`** — Queue router (deployment-aware routing), HTTP dispatcher, background poller (deferred delivery, retries, orphan detection)
- **`migrations/`** — Postgrator SQL migrations (`001.do.sql` through `003.do.sql`)

### World Client (`packages/world/`)

Thin HTTP client wrapping undici Pool. Implements storage, queue, streaming, and encryption interfaces by calling the workflow service REST API.

### Multi-Tenancy

Every authenticated request resolves to an `application_id`. All SQL queries scope by `WHERE application_id = $appId`. Auth auto-detects: single-tenant (no auth, local dev) vs multi-tenant (K8s ServiceAccount token validation via TokenReview API).

### Queue Routing

Messages carry a `deployment_version` from the originating run. The router looks up registered handlers for that version and dispatches via HTTP POST. Failed dispatches use exponential backoff (up to 10 attempts), then dead-letter.
