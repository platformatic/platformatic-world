import { timingSafeEqual } from 'node:crypto'

export function validateMasterKey (provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false
  try {
    return timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(expected)
    )
  } catch {
    return false
  }
}
