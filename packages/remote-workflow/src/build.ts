import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import ts from 'typescript'
import { defineRemote, type DefinedRemoteHandlers, type RemoteHandlerDefinitions } from './handler.ts'
import { hashRemoteValue } from './remote-schema.ts'
import type { RemoteManifest, RemoteManifestEndpoint } from './manifest.ts'
import type { RemoteHandlerManifest } from './runtime.ts'

export type PrivateRemoteHandlersManifest = RemoteHandlerManifest
export interface RemoteDefinitionSource { read (): Promise<DefinedRemoteHandlers | null> }
export interface RemoteArtifactBuildResult {
  remoteManifestPath: string
  privateHandlersPath: string
  manifest: RemoteManifest
  privateHandlers: PrivateRemoteHandlersManifest
}
export interface BuildRemoteArtifactsOptions {
  rootDir: string
  workflowManifestPath: string
  outputDir?: string
  definitionSource?: RemoteDefinitionSource
}

interface WorkflowCandidate { file: string, name: string, workflowId: string }
interface WorkflowReference { module: string, name: string }
interface SerializedRemoteDefinition { inputSchema: unknown, outputSchema: unknown, workflowId?: string }

const artifactBuildQueues = new Map<string, Promise<void>>()

async function executeRemoteDefinitionBundle (path: string): Promise<Record<string, SerializedRemoteDefinition>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(path))
    let definitions: Record<string, SerializedRemoteDefinition> | undefined
    worker.once('message', value => { definitions = value })
    worker.once('error', reject)
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`Application remote.ts worker exited with code ${code}`))
      else if (!definitions) reject(new TypeError('Application remote.ts produced no handler definitions'))
      else resolve(definitions)
    })
  })
}

async function exists (path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error: any) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export class FileRemoteDefinitionSource implements RemoteDefinitionSource {
  readonly path: string
  constructor (rootDir: string) { this.path = join(resolve(rootDir), 'remote.ts') }
  async read (): Promise<DefinedRemoteHandlers | null> {
    if (!await exists(this.path)) return null
    const temporaryPath = join(dirname(this.path), `.platformatic-remote-${process.pid}-${randomUUID()}.mjs`)
    try {
      const result = await build({
        absWorkingDir: dirname(this.path),
        bundle: true,
        external: ['@platformatic/remote-workflow', '@platformatic/remote-workflow/*'],
        format: 'esm',
        logLevel: 'silent',
        outfile: temporaryPath,
        platform: 'node',
        plugins: [{
          name: 'file-url',
          setup (builder) {
            builder.onResolve({ filter: /^file:/ }, ({ path }) => ({ path: fileURLToPath(path) }))
          },
        }],
        stdin: {
          contents: `
            import remote from ${JSON.stringify(pathToFileURL(this.path).href)}
            import { parentPort } from 'node:worker_threads'
            const marker = Symbol.for('@platformatic/remote-workflow/handler-definitions/v1')
            if (!remote || typeof remote !== 'object' || remote[marker] !== true) {
              throw new TypeError('Application remote.ts must default export defineRemote({...})')
            }
            const definitions = Object.fromEntries(Object.entries(remote.definitions).map(([name, definition]) => [name, {
              inputSchema: definition.inputSchema,
              outputSchema: definition.outputSchema,
              workflowId: definition.workflow.workflowId,
            }]))
            parentPort.postMessage(definitions)
          `,
          loader: 'ts',
          resolveDir: dirname(this.path),
          sourcefile: 'platformatic-remote-definition-loader.ts',
        },
        target: 'node22',
        write: false,
      })
      if (result.outputFiles.length !== 1) throw new TypeError('Application remote.ts build produced an unexpected output')
      await writeFile(temporaryPath, result.outputFiles[0].contents)
      const serialized = await executeRemoteDefinitionBundle(temporaryPath)
      const definitions: RemoteHandlerDefinitions = {}
      for (const [name, definition] of Object.entries(serialized)) {
        const workflow = Object.assign(function remoteWorkflowReference () {},
          typeof definition.workflowId === 'string' ? { workflowId: definition.workflowId } : {})
        definitions[name] = {
          workflow,
          inputSchema: definition.inputSchema as RemoteHandlerDefinitions[string]['inputSchema'],
          outputSchema: definition.outputSchema as RemoteHandlerDefinitions[string]['outputSchema'],
        }
      }
      return defineRemote(definitions)
    } finally {
      await removeIfPresent(temporaryPath)
    }
  }
}

function parseWorkflowManifest (value: unknown): WorkflowCandidate[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Workflow SDK manifest must be an object')
  const workflows = (value as { workflows?: unknown }).workflows
  if (!workflows || typeof workflows !== 'object' || Array.isArray(workflows)) throw new TypeError('Workflow SDK manifest must contain a workflows object')
  const candidates: WorkflowCandidate[] = []
  for (const file of Object.keys(workflows).sort()) {
    const entries = (workflows as Record<string, unknown>)[file]
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new TypeError(`Workflow SDK manifest file ${JSON.stringify(file)} is invalid`)
    for (const name of Object.keys(entries).sort()) {
      const workflowId = (entries as Record<string, { workflowId?: unknown }>)[name]?.workflowId
      if (typeof workflowId !== 'string' || workflowId.length === 0) throw new TypeError(`Workflow SDK manifest entry ${JSON.stringify(`${file}:${name}`)} has no workflowId`)
      candidates.push({ file, name, workflowId })
    }
  }
  return candidates
}

function propertyName (name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
}

function parseWorkflowReferences (path: string, source: string): Map<string, WorkflowReference> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imports = new Map<string, WorkflowReference>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      imports.set(element.name.text, {
        module: statement.moduleSpecifier.text,
        name: element.propertyName?.text ?? element.name.text,
      })
    }
  }
  const exports = file.statements.filter(statement => ts.isExportAssignment(statement) && !statement.isExportEquals) as ts.ExportAssignment[]
  if (exports.length !== 1 || !ts.isCallExpression(exports[0].expression) ||
      !ts.isIdentifier(exports[0].expression.expression) || exports[0].expression.expression.text !== 'defineRemote' ||
      exports[0].expression.arguments.length !== 1 || !ts.isObjectLiteralExpression(exports[0].expression.arguments[0])) {
    throw new TypeError('Application remote.ts must default export defineRemote({...}) with an object literal')
  }
  const references = new Map<string, WorkflowReference>()
  for (const property of exports[0].expression.arguments[0].properties) {
    if (!ts.isPropertyAssignment(property)) throw new TypeError('Remote endpoint definitions must use static property assignments')
    const endpoint = propertyName(property.name)
    if (!endpoint) throw new TypeError('Remote endpoint names must be static strings')
    if (references.has(endpoint)) throw new TypeError(`Duplicate remote endpoint ${JSON.stringify(endpoint)}`)
    if (!ts.isObjectLiteralExpression(property.initializer)) throw new TypeError(`Remote endpoint ${JSON.stringify(endpoint)} must be an object literal`)
    const workflowProperties = property.initializer.properties.filter(candidate =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === 'workflow'
    ) as ts.PropertyAssignment[]
    if (workflowProperties.length !== 1 || !ts.isIdentifier(workflowProperties[0].initializer)) {
      throw new TypeError(`Remote endpoint ${JSON.stringify(endpoint)} workflow must be a named import`)
    }
    const reference = imports.get(workflowProperties[0].initializer.text)
    if (!reference || !reference.module.startsWith('.')) {
      throw new TypeError(`Remote endpoint ${JSON.stringify(endpoint)} workflow must be a relative named import`)
    }
    references.set(endpoint, reference)
  }
  return references
}

function withoutSourceExtension (path: string): string {
  return ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(path))
    ? path.slice(0, -extname(path).length)
    : path
}

function workflowIdForReference (
  endpoint: string,
  reference: WorkflowReference,
  rootDir: string,
  candidates: WorkflowCandidate[]
): string {
  const sourcePath = withoutSourceExtension(resolve(rootDir, reference.module))
  const matches = candidates.filter(candidate =>
    candidate.name === reference.name && withoutSourceExtension(resolve(rootDir, candidate.file)) === sourcePath
  )
  if (matches.length !== 1) {
    throw new TypeError(`Remote endpoint ${JSON.stringify(endpoint)} import ${JSON.stringify(`${reference.module}#${reference.name}`)} matches ${matches.length} Workflow SDK manifest entries; workflow identity is ambiguous`)
  }
  return matches[0].workflowId
}

function resolveWorkflowId (
  endpoint: string,
  workflow: Function & { workflowId?: string },
  candidates: WorkflowCandidate[],
  rootDir: string,
  reference?: WorkflowReference
): string {
  if (typeof workflow.workflowId === 'string' && workflow.workflowId.length > 0) {
    const matches = candidates.filter(candidate => candidate.workflowId === workflow.workflowId)
    if (matches.length === 0) throw new TypeError(`Remote endpoint ${JSON.stringify(endpoint)} workflowId is not present in the Workflow SDK manifest`)
    if (reference && workflowIdForReference(endpoint, reference, rootDir, candidates) !== workflow.workflowId) {
      throw new TypeError(`Remote endpoint ${JSON.stringify(endpoint)} transformed workflowId disagrees with its imported workflow`)
    }
    return workflow.workflowId
  }
  if (!reference) throw new TypeError(`Remote endpoint ${JSON.stringify(endpoint)} has no transformed workflowId or static imported workflow reference`)
  return workflowIdForReference(endpoint, reference, rootDir, candidates)
}

async function writeIfChanged (path: string, contents: string, generation: string): Promise<void> {
  try { if (await readFile(path, 'utf8') === contents) return } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
  const temporaryPath = `${path}.${process.pid}.${generation}.tmp`
  try {
    await writeFile(temporaryPath, contents)
    await rename(temporaryPath, path)
  } finally {
    await removeIfPresent(temporaryPath)
  }
}
async function removeIfPresent (path: string): Promise<void> {
  try { await unlink(path) } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
}

async function withArtifactBuildLock<T> (key: string, operation: () => Promise<T>): Promise<T> {
  const previous = artifactBuildQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => current)
  artifactBuildQueues.set(key, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (artifactBuildQueues.get(key) === tail) artifactBuildQueues.delete(key)
  }
}

async function buildRemoteHandlerArtifactsLocked (options: BuildRemoteArtifactsOptions, workflowManifestPath: string): Promise<RemoteArtifactBuildResult | null> {
  const outputDir = resolve(options.rootDir, options.outputDir ?? dirname(workflowManifestPath))
  const remoteManifestPath = join(outputDir, 'remote-manifest.json')
  const privateHandlersPath = join(outputDir, 'remote-handlers.json')
  const source = options.definitionSource ?? new FileRemoteDefinitionSource(options.rootDir)
  const remote = await source.read()
  if (remote === null) {
    await Promise.all([removeIfPresent(remoteManifestPath), removeIfPresent(privateHandlersPath)])
    return null
  }
  const candidates = parseWorkflowManifest(JSON.parse(await readFile(workflowManifestPath, 'utf8')))
  const references = source instanceof FileRemoteDefinitionSource
    ? parseWorkflowReferences(source.path, await readFile(source.path, 'utf8'))
    : new Map<string, WorkflowReference>()
  if (references.size > 0) {
    const runtimeNames = Object.keys(remote.definitions).sort()
    const sourceNames = [...references.keys()].sort()
    if (runtimeNames.join('\0') !== sourceNames.join('\0')) throw new TypeError('Executed remote.ts definitions disagree with its static endpoint declarations')
  }
  const endpoints: RemoteManifestEndpoint[] = []
  const handlers: Record<string, { workflowId: string }> = {}
  for (const name of Object.keys(remote.definitions).sort()) {
    const definition = remote.definitions[name]
    endpoints.push({ name, inputSchema: definition.inputSchema, outputSchema: definition.outputSchema })
    handlers[name] = { workflowId: resolveWorkflowId(name, definition.workflow, candidates, options.rootDir, references.get(name)) }
  }
  const manifestHash = hashRemoteValue(endpoints)
  const manifest: RemoteManifest = { v: 1, manifestHash, endpoints }
  const privateHandlers: PrivateRemoteHandlersManifest = { v: 1, manifestHash, handlers }
  const generation = randomUUID()
  await Promise.all([
    writeIfChanged(remoteManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, generation),
    writeIfChanged(privateHandlersPath, `${JSON.stringify(privateHandlers, null, 2)}\n`, generation),
  ])
  return { remoteManifestPath, privateHandlersPath, manifest, privateHandlers }
}

export async function buildRemoteHandlerArtifacts (options: BuildRemoteArtifactsOptions): Promise<RemoteArtifactBuildResult | null> {
  const workflowManifestPath = resolve(options.workflowManifestPath)
  const outputDir = resolve(options.rootDir, options.outputDir ?? dirname(workflowManifestPath))
  return withArtifactBuildLock(outputDir, () => buildRemoteHandlerArtifactsLocked(options, workflowManifestPath))
}

export interface WorkflowAfterBundleResult { workingDir: string, artifacts: readonly { kind: string, path: string }[] }
export function createRemoteAfterBundleHook (options: { rootDir?: string, outputDir?: string } = {}) {
  return async (result: WorkflowAfterBundleResult): Promise<RemoteArtifactBuildResult | null> => {
    const manifests = result.artifacts.filter(artifact => artifact.kind === 'manifest')
    if (manifests.length !== 1) throw new TypeError(`Workflow SDK after-bundle result contains ${manifests.length} manifest artifacts`)
    const rootDir = resolve(options.rootDir ?? result.workingDir)
    return buildRemoteHandlerArtifacts({
      rootDir,
      workflowManifestPath: manifests[0].path,
      outputDir: options.outputDir ?? join(rootDir, '.well-known/workflow/v1'),
    })
  }
}
