import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function transform (file: string): string {
  return execFileSync('pnpm', [
    '-C',
    'e2e-v5',
    'exec',
    'workflow',
    'transform',
    `../remote-steps/probes/${file}`,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
}

test('RMT-1: importing a workflow does not create a run', () => {
  const clientOutput = transform('rmt1-client.ts')
  assert.doesNotMatch(clientOutput, /\.workflowId\s*=/)
  assert.doesNotMatch(clientOutput, /__private_workflows\.set/)
  assert.doesNotMatch(clientOutput, /wrun_/)

  const workflowOutput = transform('rmt1-workflow.ts')
  const workflowId = 'workflow//./../remote-steps/probes/rmt1-workflow//settle'
  assert.match(workflowOutput, new RegExp(`settle\\.workflowId = "${workflowId}"`))
  assert.match(workflowOutput, new RegExp(`__private_workflows\\.set\\("${workflowId}"`))
  assert.doesNotMatch(workflowOutput, /wrun_/)
})
