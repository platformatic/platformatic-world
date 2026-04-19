// Minimal workflow + step for v4-SDK compatibility testing.
// Kept tiny on purpose — the goal is to prove a v4 SDK can use
// @platformatic/world end-to-end, not to re-test every pattern.

export async function add (a: number, b: number) {
  'use step'
  return a + b
}

export async function addTenWorkflow (input: number) {
  'use workflow'
  const a = await add(input, 2)
  const b = await add(a, 3)
  const c = await add(b, 5)
  return c
}
