// Adapted from Vercel Workflow SDK e2e suite (Apache-2.0)
// https://github.com/vercel/workflow/blob/main/workbench/example/workflows/serde-steps.ts

// The upstream source uses `./serde-models.js`. With workflow@5.0.0-beta.21+
// this file is registered as a step module (via the patched
// @workflow/builders fast-discovery — see patches/), which makes Turbopack
// process this import directly instead of routing it through esbuild's
// bundle. Turbopack does not perform `.js -> .ts` rewriting for imports
// reached through the generated `__step_registrations.js`, so we drop the
// extension here.
import { Vector } from './serde-models'

export async function scaleVector (vector: Vector, factor: number) {
  'use step'
  return vector.scale(factor)
}

export async function addVectors (v1: Vector, v2: Vector) {
  'use step'
  return v1.add(v2)
}

export async function createVector (x: number, y: number, z: number) {
  'use step'
  return new Vector(x, y, z)
}

export async function sumVectors (vectors: Vector[]) {
  'use step'
  let totalX = 0
  let totalY = 0
  let totalZ = 0
  for (const v of vectors) {
    totalX += v.x
    totalY += v.y
    totalZ += v.z
  }
  return new Vector(totalX, totalY, totalZ)
}
