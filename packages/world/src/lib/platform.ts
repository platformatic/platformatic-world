import { readFileSync } from 'node:fs'

// Location of the mounted Kubernetes service account, overridable for testing.
export function saPath (file: string): string {
  const base = process.env.PLT_WORLD_SA_PATH || '/var/run/secrets/kubernetes.io/serviceaccount'
  return `${base}/${file}`
}

// A readable service account token is what marks the pod as running in K8s.
export function isRunningInK8s (): boolean {
  try {
    readFileSync(saPath('token'))
    return true
  } catch {
    return false
  }
}

// ECS injects a task-scoped metadata endpoint into every container. Note that
// AWS_EXECUTION_ENV is not used: Lambda sets it too, with a different prefix.
export function isRunningInEcs (): boolean {
  return Boolean(process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.ECS_CONTAINER_METADATA_URI)
}

// A managed platform is one where ICC assigns the application and version and
// registers handlers at reachable URLs. Distinct from having an identity to
// authenticate with, which only K8s provides.
export function isManagedPlatform (): boolean {
  return isRunningInK8s() || isRunningInEcs()
}
