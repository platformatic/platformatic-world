// Cross-file helper functions for error propagation tests.
// Adapted from Vercel's workflow SDK e2e suite (Apache-2.0 license).

// Plain function that throws (used in workflow context)
export function throwError (): never {
  throw new Error('Error from imported helper module')
}

export function callThrower (): never {
  throwError()
  return undefined as never
}

// Step function that throws (used in step context)
function throwErrorFromStep (): never {
  throw new Error('Step error from imported helper module')
}

export async function stepThatThrowsFromHelper (): Promise<never> {
  'use step'
  throwErrorFromStep()
  return undefined as never
}
stepThatThrowsFromHelper.maxRetries = 0
