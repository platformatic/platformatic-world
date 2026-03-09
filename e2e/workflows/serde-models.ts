// Adapted from Vercel Workflow SDK e2e suite (Apache-2.0)
// https://github.com/vercel/workflow/blob/main/workbench/example/workflows/serde-models.ts

export class Vector {
  constructor (public x: number, public y: number, public z: number) {}

  static [Symbol.for('workflow-serialize')] (instance: Vector) {
    return { x: instance.x, y: instance.y, z: instance.z }
  }

  static [Symbol.for('workflow-deserialize')] (data: { x: number, y: number, z: number }) {
    return new Vector(data.x, data.y, data.z)
  }

  magnitude (): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z)
  }

  add (other: Vector): Vector {
    return new Vector(this.x + other.x, this.y + other.y, this.z + other.z)
  }

  scale (factor: number): Vector {
    return new Vector(this.x * factor, this.y * factor, this.z * factor)
  }
}
