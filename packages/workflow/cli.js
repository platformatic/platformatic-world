#!/usr/bin/env node

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

// Show help
if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
  console.log(`@platformatic/workflow - Workflow orchestration service for Vercel Workflow DevKit

Usage:
  npx @platformatic/workflow <database-url>
  npx @platformatic/workflow --help

Examples:
  npx @platformatic/workflow postgresql://user:pass@localhost:5432/workflow
  npx @platformatic/workflow postgresql://user:pass@localhost:5432/workflow --port 4000

Options:
  --host <host>      Bind address (default: 0.0.0.0)
  --port <port>      Listen port (default: 3042)
  --help, -h         Show this help message

The service runs in single-tenant mode (no auth) by default.
For multi-tenant mode with K8s authentication, deploy via the Platformatic Helm chart.

Documentation: https://github.com/platformatic/platformatic-world`)
  process.exit(0)
}

// Parse args: first positional arg is the database URL, rest are flags
let databaseUrl = process.env.DATABASE_URL
let host = process.env.HOST || '0.0.0.0'
let port = process.env.PORT || '3042'

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host' && args[i + 1]) {
    host = args[++i]
  } else if (args[i] === '--port' && args[i + 1]) {
    port = args[++i]
  } else if (!args[i].startsWith('-') && !databaseUrl) {
    databaseUrl = args[i]
  }
}

if (!databaseUrl) {
  console.error('Error: Database URL is required.')
  console.error('')
  console.error('Usage:')
  console.error('  npx @platformatic/workflow postgresql://user:pass@localhost:5432/workflow')
  console.error('')
  process.exit(1)
}

process.env.DATABASE_URL = databaseUrl
process.env.HOST = host
process.env.PORT = port

const wattpmBin = resolve(__dirname, 'node_modules', 'wattpm', 'bin', 'cli.js')

const child = spawn(process.execPath, [wattpmBin, 'start'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: process.env
})

child.on('exit', (code) => process.exit(code || 0))
child.on('error', (err) => {
  console.error('Failed to start workflow service:', err.message)
  process.exit(1)
})
