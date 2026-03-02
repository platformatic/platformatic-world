import { buildApp } from './app.ts'

const connectionString = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5433/workflow'
const masterKey = process.env.WF_MASTER_KEY || 'dev-master-key'
const authMode = (process.env.WF_AUTH_MODE || 'api-key') as 'api-key' | 'k8s-token' | 'both'

const app = await buildApp({
  connectionString,
  auth: {
    mode: authMode,
    masterKey,
    k8s: authMode !== 'api-key'
      ? {
          apiServer: process.env.K8S_API_SERVER || 'https://kubernetes.default.svc',
          caCert: process.env.K8S_CA_CERT || '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
        }
      : undefined,
  },
  enablePoller: true,
})

const port = parseInt(process.env.PORT || '3042', 10)
const host = process.env.HOST || '0.0.0.0'

await app.listen({ port, host })
