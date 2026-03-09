# Vercel E2E Test Coverage

Reference: [packages/core/e2e/e2e.test.ts](https://github.com/vercel/workflow/blob/main/packages/core/e2e/e2e.test.ts)
Dashboard: https://useworkflow.dev/worlds

## Score: 55 implemented / 3 N/A = 58

| # | Vercel Test | Status | Notes |
|---|-------------|--------|-------|
| 1 | addTenWorkflow (99_e2e.ts) | ✅ | |
| 2 | addTenWorkflow (98_duplicate_case.ts) | ✅ | |
| 3 | wellKnownAgentWorkflow | ✅ | `.well-known/agent/v1/steps.ts` discovered via manifest, started with SDK `start()`. |
| 4 | react rendering in step | ⏭ N/A | Vercel skips with `skipIf(!(isNext && isLocal))`. Requires Next.js local deployment + eval hack for React bundling. Skipped even by Vercel's own Postgres world. |
| 5 | promiseAllWorkflow | ✅ | |
| 6 | promiseRaceWorkflow | ✅ | |
| 7 | promiseAnyWorkflow | ✅ | |
| 8 | importedStepOnlyWorkflow | ✅ | |
| 9 | readableStreamWorkflow | ✅ | Vercel skips only for `isLocalDeployment()` (local world uses in-process EventEmitter). We are NOT local. |
| 10 | hookWorkflow | ✅ | |
| 11 | hookWorkflow not resumable via webhook | ✅ | |
| 12 | webhookWorkflow | ✅ | `respondWith: 'manual'` works when the call to `req.respondWith()` is inside a step function (matches Vercel's pattern). |
| 13 | webhook route invalid token | ✅ | |
| 14 | sleepingWorkflow | ✅ | |
| 15 | parallelSleepWorkflow | ✅ | |
| 16 | nullByteWorkflow | ✅ | |
| 17 | workflowAndStepMetadataWorkflow | ✅ | |
| 18 | outputStreamWorkflow | ✅ | Vercel skips only for `isLocalDeployment()`. We are NOT local. |
| 19 | outputStreamInsideStepWorkflow | ✅ | Vercel skips only for `isLocalDeployment()`. We are NOT local. |
| 20 | fetchWorkflow | ✅ | |
| 21 | promiseRaceStressTestWorkflow | ✅ | |
| 22 | errorWorkflowNested | ✅ | |
| 23 | errorWorkflowCrossFile | ✅ | |
| 24 | errorStepBasic | ✅ | |
| 25 | errorStepCrossFile | ✅ | |
| 26 | errorRetrySuccess | ✅ | Vercel runs with 60s timeout, no skip. |
| 27 | errorRetryFatal | ✅ | |
| 28 | errorRetryCustomDelay | ✅ | |
| 29 | errorRetryDisabled (maxRetries=0) | ✅ | |
| 30 | serverError5xxRetryWorkflow | ✅ | |
| 31 | errorFatalCatchable | ✅ | |
| 32 | stepDirectCallWorkflow | ✅ | |
| 33 | hookCleanupTestWorkflow | ✅ | |
| 34 | concurrent hook token conflict | ✅ | |
| 35 | hookDisposeTestWorkflow | ✅ | Block-scope disposal works without TC39 `using` keyword. |
| 36 | stepFunctionPassingWorkflow | ✅ | |
| 37 | stepFunctionWithClosureWorkflow | ✅ | |
| 38 | closureVariableWorkflow | ✅ | |
| 39 | spawnWorkflowFromStepWorkflow | ✅ | |
| 40 | health check (HTTP) | ✅ | Vercel skips this for non-local (`skipIf(!isLocalDeployment())`). We run it since we support direct HTTP access. |
| 41 | health check (queue-based) | ✅ | Uses `getWorld()` + `healthCheck()` from `workflow/runtime`. |
| 42 | health check (CLI) | ⏭ N/A | Requires the `workflow` CLI binary (`cliHealthJson()`). The CLI is a standalone tool distributed with the Workflow SDK monorepo, not available as a standalone installable for third-party worlds. |
| 43 | pathsAliasWorkflow | ✅ | |
| 44 | Calculator.calculate | ✅ | |
| 45 | AllInOneService.processNumber | ✅ | |
| 46 | ChainableService.processWithThis | ✅ | |
| 47 | thisSerializationWorkflow | ✅ | |
| 48 | customSerializationWorkflow | ✅ | |
| 49 | instanceMethodStepWorkflow | ✅ | |
| 50 | crossContextSerdeWorkflow | ✅ | |
| 51 | stepFunctionAsStartArgWorkflow | ✅ | Uses manifest for stepId lookup, matching Vercel's approach. |
| 52 | cancelRun | ✅ | |
| 53 | cancelRun via CLI | ⏭ N/A | Same as #42 — requires the `workflow` CLI binary (`cliCancel()`). |
| 54 | pages router: addTenWorkflow | ✅ | Next.js Pages Router `/api/trigger-pages` endpoint. |
| 55 | pages router: promiseAllWorkflow | ✅ | Same as #54. |
| 56 | pages router: sleepingWorkflow | ✅ | Same as #54. |
| 57 | hookWithSleepWorkflow | ✅ | `void sleep('1d')` works cross-process — Vercel runs for all worlds. |
| 58 | sleepWithSequentialStepsWorkflow | ✅ | Same as #57. |

## N/A Tests (3)

- **React rendering** (#4): `skipIf(!(isNext && isLocal))` — requires local Next.js deployment with eval hack for React bundling. Skipped by ALL remote worlds including Vercel's own Postgres world.
- **CLI binary** (#42, #53): Require the `workflow` CLI tool (`cliHealthJson()`, `cliCancel()`), which is part of the SDK monorepo and not independently installable for third-party worlds.
