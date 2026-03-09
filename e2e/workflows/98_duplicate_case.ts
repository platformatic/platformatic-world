// Adapted from Vercel Workflow SDK e2e suite (Apache-2.0)
// https://github.com/vercel/workflow/blob/main/workbench/example/workflows/98_duplicate_case.ts

// Duplicate workflow from e2e.ts to ensure we handle unique IDs
export async function addTenWorkflow (input: number) {
  'use workflow'
  const a = await add(input, 2)
  const b = await add(a, 3)
  const c = await add(b, 5)
  return c
}

export async function add (a: number, b: number) {
  'use step'
  return a + b
}
