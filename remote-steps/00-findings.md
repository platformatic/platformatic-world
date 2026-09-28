# Remote steps Phase 0 probe findings

These findings are evidence for the remote-step design. This branch contains
probe fixtures only; it does not add a remote-step runtime, storage schema, or
ICC integration.

## Reproduction baseline

- Platformatic World commit: `77e8f4256ef525c18c60066aa9ebf08067e15def`
- `@platformatic/world` / repository version: `0.12.1`
- `workflow` and `@workflow/core`: `5.0.0-beta.46`
- `@workflow/world`: `5.0.0-beta.31`
- transitive `@workflow/world-vercel` inspected for RMT-2: `5.0.0-beta.42`
- Next.js: `16.3.3`
- Node.js used for the recorded run: `v24.19.0`
- PostgreSQL fixture: `postgres:18`, as pinned by `docker-compose.yml`

From a clean checkout, run:

```sh
docker compose up -d
pnpm install --frozen-lockfile
pnpm build
pnpm -C packages/workflow build
pnpm -C e2e-v5 build
pnpm test:remote-steps-probes
```

RMT-1 can also be run alone after dependency installation:

```sh
node --test remote-steps/probes/rmt1-transform.test.ts
```

RMT-2 through RMT-4 can be run alone after both package builds and the Next.js
build:

```sh
pnpm -C e2e-v5 test:remote-steps-probes
```

## RMT-1: imported workflow identity

**Status: passed locally.**

The client fixture imports and re-exports `settle` without calling `start()`.
Transforming that client leaves the import/re-export intact and emits neither
workflow registration nor a run ID. Transforming the workflow definition
attaches this literal identity in both workflow and step modes:

```text
workflow//./../remote-steps/probes/rmt1-workflow//settle
```

The transform registers that ID in `globalThis.__private_workflows` but emits no
`wrun_` value. Therefore import-time identity is workflow metadata, not a
workflow run. A run is created only when `start()` executes.

## RMT-2: caller-selected run identity

**Local live evidence: passed for the behavior the current public API exposes.**

Two sequential `start()` calls through the real Platformatic World harness
completed as two distinct runs. One recorded run produced:

```text
wrun_01M1N03MKZHZ2K8TQYHPRTBSDT
wrun_01M1N03MN11JK45XEFSS2GRQHT
```

The exact IDs vary by run; the executable assertion checks their ULID shape,
inequality, and successful completion.

**Installed type and source inspection: passed.**

- `@workflow/core/dist/runtime/start.d.ts` has no `runId` member in
  `StartOptionsBase`.
- `@workflow/core/dist/runtime/start.js` creates
  `wrun_${world.createRunId(opts)}` when the World implements the hook and falls
  back to its own monotonic ULID otherwise.
- `@workflow/world` declares optional `World.createRunId(options)`.
- Platformatic World's `packages/world/src/index.ts` does not implement the
  hook, so the core fallback generated the locally observed IDs.
- `@workflow/world-vercel/dist/create-run-id.js` implements the hook and embeds
  the selected Vercel region in a monotonic ULID. Its priority is
  `options.region`, `VERCEL_REGION`, then `iad1`.

The former experiment—calling `start()` twice with the same caller-supplied
run ID—is no longer expressible through the current public `StartOptions` type.
Remote-step idempotency must consequently use a separate operation key; it
must not depend on choosing the child workflow run ID.

**Live Vercel deployment evidence: not run.**

No authenticated Vercel probe deployment or matching project/team/environment
configuration was available in this checkout. Source inspection is not a
substitute for exercising two starts against the deployed Vercel World, so this
part remains open and must not be reported as passed.

## RMT-3: repeated step-call correlation

**Status: passed locally.**

The workflow invokes one step before a loop, twice in the loop, and twice in a
`Promise.all`. The observed result was:

```json
["before", "loop-0", "loop-1", "parallel-0", "parallel-1"]
```

The five `step_started` events all had this dispatch identity:

```text
step//./workflows/remote-steps-probes//recordRemoteStepInvocation
```

One recorded run (`wrun_01M1N03N60FHB9JWD93F405DXC`) produced these durable
correlation IDs, in event order:

```text
step_01M1N03N60QEATV8VKQ8RJMV6Q
step_01M1N03N60QEATV8VKQ8RJMV6R
step_01M1N03N60QEATV8VKQ8RJMV6S
step_01M1N03N60QEATV8VKQ8RJMV6T
step_01M1N03N60QEATV8VKQ8RJMV6V
```

The executable assertion checks a count of five, uniqueness, and monotonic
lexical order. This supports using the durable correlation/step ID as the
per-invocation operation identity and the step name as the dispatch identity.
The literal IDs themselves are samples, not constants.

## RMT-4: hook-versus-sleep replay after worker restart

**Status: passed locally; the result exposes a fallback requirement.**

The probe starts a hook and races that same hook against a one-second sleep in
three loop iterations. After the first `wait_completed`, the Next.js worker is
killed, restarted on the same port, and its handlers are registered again.
The hook is resumed only after the second `wait_created` is durable.

For recorded run `wrun_01M1N03P6CAJ17NJ7P1S2PKDDG`, the relevant event order
was:

```text
hook_created   hook_01M1N03P6C7Z6RRNAPDY4N6E7G
wait_created   wait_01M1N03P6C7Z6RRNAPDY4N6E7H
wait_completed wait_01M1N03P6C7Z6RRNAPDY4N6E7H
wait_created   wait_01M1N03P6C7Z6RRNAPDY4N6E7J
hook_received  hook_01M1N03P6C7Z6RRNAPDY4N6E7G
wait_completed wait_01M1N03P6C7Z6RRNAPDY4N6E7J
wait_created   wait_01M1N03P6C7Z6RRNAPDY4N6E7K
wait_completed wait_01M1N03P6C7Z6RRNAPDY4N6E7K
```

Although `hook_received` precedes the second `wait_completed`, replay returned:

```json
["sleep-0", "sleep-1", "sleep-2"]
```

The test resolves the result through `getRun().returnValue` after restart and
asserts the event ordering above structurally. The remote-step fallback cannot
infer a fresh race winner from current wall-clock timing after replay or worker
loss. It needs a durable deadline/timer representation and must preserve the
winner already encoded by the event log.

## Decisions carried forward

- Keep dispatch identity (the transformed step name) separate from invocation
  identity (the durable step correlation ID).
- Give remote-step starts their own idempotency key; child run IDs are minted by
  the selected World.
- Persist fallback deadlines and derive timeout behavior from durable state,
  not from a restarted worker's clock or a newly evaluated race.
- Treat live Vercel RMT-2 as an explicit prerequisite before claiming parity
  across local and Vercel Worlds.
