import { existsSync } from 'node:fs'

// Mirrors packages/world/src/lib/platform.ts. Duplicated deliberately: the
// service must not take a dependency on the client package.

// Location of the mounted Kubernetes service account, overridable for testing.
export function saPath (file: string): string {
  const base = process.env.PLT_WORLD_SA_PATH || '/var/run/secrets/kubernetes.io/serviceaccount'
  return `${base}/${file}`
}

// A service account token is what marks the process as running in K8s.
export function isRunningInK8s (): boolean {
  return existsSync(saPath('token'))
}

// ECS injects a task-scoped metadata endpoint into every container. Note that
// AWS_EXECUTION_ENV is not used: Lambda sets it too, with a different prefix.
export function isRunningInEcs (): boolean {
  return Boolean(process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.ECS_CONTAINER_METADATA_URI)
}

// A managed platform is one where ICC provisions applications, so tenancy
// applies even when there is no identity to authenticate.
export function isManagedPlatform (): boolean {
  return isRunningInK8s() || isRunningInEcs()
}
