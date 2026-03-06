const MAX_ATTEMPTS = 10
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000

export function getRetryDelay (attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS)
}

export function isMaxAttempts (attempt: number): boolean {
  return attempt >= MAX_ATTEMPTS
}

export { MAX_ATTEMPTS }
