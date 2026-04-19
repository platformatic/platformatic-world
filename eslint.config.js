import neostandard, { resolveIgnoresFromGitignore } from 'neostandard'

export default neostandard({
  ts: true,
  ignores: [
    ...resolveIgnoresFromGitignore(),
    'e2e-v5/app/.well-known/',
    'e2e-v4/app/.well-known/',
    'packages/world/dist/',
    'packages/workflow/dist/',
  ],
})
