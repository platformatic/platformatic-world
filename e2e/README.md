# e2e

Next.js workbench + integration tests for `@platformatic/world` and
`@platformatic/workflow`. Structured to mirror Vercel's community-world e2e
setup so the same tests (our ports in `test/vercel-e2e.test.ts` and
Vercel's upstream suite) behave the same way against our stack.

## Scripts

- `npm run build` — `WORKFLOW_PUBLIC_MANIFEST=1 next build`
- `npm test` — local suite (`workflow.test.ts` + `cbor-e2e.test.ts`)
- `npm run test:vercel` — Vercel-compat suite (`vercel-e2e.test.ts`)

## `WORKFLOW_PUBLIC_MANIFEST=1`

Build-time env var consumed by `@workflow/next`. When set, the plugin copies
the generated `app/.well-known/workflow/v1/manifest.json` into `public/` so
Next.js serves it as a static asset at
`GET /.well-known/workflow/v1/manifest.json`. Without it, the manifest is
only used internally by the bundler and the URL returns 404.

Several tests (`stepFunctionAsStartArgWorkflow`, `wellKnownAgentWorkflow`,
Vercel's `getWorkflowMetadata` helper) look workflows up by fetching the
manifest over HTTP, so they need the file to be publicly served. Vercel's
own community-world CI (`e2e-community-world.yml`) sets the same flag at
build time, so our build matches theirs.

Introduced by [vercel/workflow#963](https://github.com/vercel/workflow/pull/963);
only mentioned in `@workflow/next`'s CHANGELOG upstream.
