// Location of the mounted Kubernetes service account, overridable for testing.
export function saPath (file: string): string {
  const base = process.env.PLT_WORLD_SA_PATH || '/var/run/secrets/kubernetes.io/serviceaccount'
  return `${base}/${file}`
}
