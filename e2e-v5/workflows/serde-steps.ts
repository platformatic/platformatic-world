// Adapted from Vercel Workflow SDK e2e suite (Apache-2.0)
// https://github.com/vercel/workflow/blob/main/workbench/example/workflows/serde-steps.ts

import { Vector } from './serde-models.js'

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
