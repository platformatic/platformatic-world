// Adapted from Vercel Workflow SDK e2e suite (Apache-2.0)
// https://github.com/vercel/workflow/blob/main/workbench/example/workflows/_imported_step_only.ts
export async function importedStepOnly () {
  'use step'
  return 'imported-step-only-ok'
}
