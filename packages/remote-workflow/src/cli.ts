#!/usr/bin/env node
import { resolve } from 'node:path'
import { buildRemoteHandlerArtifacts } from './build.js'

function usage (): never { throw new Error('Usage: platformatic-remote-workflow build [--root <application-root>] [--workflow-manifest <manifest.json>]') }
async function main (): Promise<void> {
  const args = process.argv.slice(2)
  if (args.shift() !== 'build') usage()
  let rootDir = process.cwd()
  let workflowManifestPath: string | undefined
  while (args.length > 0) {
    const option = args.shift()
    const value = args.shift()
    if (!value) usage()
    if (option === '--root') rootDir = resolve(value)
    else if (option === '--workflow-manifest') workflowManifestPath = resolve(value)
    else usage()
  }
  workflowManifestPath ??= resolve(rootDir, '.well-known/workflow/v1/manifest.json')
  await buildRemoteHandlerArtifacts({ rootDir, workflowManifestPath })
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
