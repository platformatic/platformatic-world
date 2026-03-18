import neostandard, { resolveIgnoresFromGitignore } from 'neostandard'

export default neostandard({
  ts: true,
  ignores: [
    ...resolveIgnoresFromGitignore(),
    'e2e/app/.well-known/',
    'packages/world/dist/',
    'packages/workflow/dist/',
  ],
})
