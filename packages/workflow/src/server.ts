import { existsSync } from 'node:fs'
import { buildApp } from './app.ts'
import type { AppConfig } from './app.ts'

const connectionString = process.env.DATABASE_URL || 'postgresql://wf:wf@localhost:5434/workflow'
const isK8s = existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')

let appConfig: AppConfig

if (isK8s) {
  // Multi-tenant mode (K8s)
  appConfig = {
    connectionString,
    auth: {
      mode: 'k8s-token',
      k8s: {
        apiServer: process.env.K8S_API_SERVER || 'https://kubernetes.default.svc',
        caCert: process.env.K8S_CA_CERT || '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
        adminServiceAccount: process.env.K8S_ADMIN_SERVICE_ACCOUNT,
      },
    },
    enablePoller: true,
  }
  console.log('Starting in multi-tenant mode (K8s detected)')
} else {
  // Single-tenant mode (local dev)
  appConfig = {
    connectionString,
    singleTenant: true,
    defaultAppId: process.env.PLT_WORLD_APP_ID || 'default',
    enablePoller: true,
  }
  console.log('Starting in single-tenant mode (no K8s detected)')
}

const app = await buildApp(appConfig)

const port = parseInt(process.env.PORT || '3042', 10)
const host = process.env.HOST || '0.0.0.0'

await app.listen({ port, host })
