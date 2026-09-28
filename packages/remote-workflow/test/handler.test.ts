import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { hashRemoteValue } from '../src/remote-schema.ts'
import {
  buildRemoteHandlerArtifacts,
  createRemoteAfterBundleHook,
  type DefinedRemoteHandlers,
  type RemoteDefinitionSource,
} from '../src/build.ts'
import { defineRemote } from '../src/handler.ts'
import { FileManifestSource } from '../src/manifest.ts'

const inputSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['sku'],
  properties: { sku: { type: 'string' } },
}
const outputSchema = { type: 'object', properties: { reservationId: { type: 'string' } } }

function source (definitions: DefinedRemoteHandlers | null): RemoteDefinitionSource {
  return { async read () { return definitions } }
}

async function fixture () {
  const root = await mkdtemp(join(tmpdir(), 'platformatic-remote-'))
  const manifestDir = join(root, '.well-known', 'workflow', 'v1')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(manifestDir, { recursive: true }))
  const workflowManifestPath = join(manifestDir, 'manifest.json')
  await writeFile(workflowManifestPath, JSON.stringify({
    version: '1.0.0',
    workflows: {
      'workflows/inventory.ts': { reserve: { workflowId: 'workflow//workflows/inventory//reserve' } },
      'workflows/payments.ts': { charge: { workflowId: 'workflow//workflows/payments//charge' } },
    },
  }))
  return { root, manifestDir, workflowManifestPath }
}

describe('defineRemote', () => {
  it('matches the shared remote-schema JCS conformance vector', () => {
    assert.equal(hashRemoteValue({
      inputSchema: {
        required: ['a'],
        properties: { z: { type: 'number' }, a: { type: 'string' } },
        type: 'object'
      },
      outputSchema: { oneOf: [false, { items: true, type: 'array' }], minimum: 0.0000001 }
    }), '966d77cc864448a2d621e8ca68ae497452dab9a285954ceb6b80906bab5a2ff2')
  })

  it('validates and snapshots handler definitions', () => {
    async function reserve (_input: { sku: string }) { return { reservationId: 'r1' } }
    const mutableInput = structuredClone(inputSchema)
    const remote = defineRemote({ 'inventory.reserve': { workflow: reserve, inputSchema: mutableInput, outputSchema } })
    mutableInput.properties.sku.type = 'number'
    assert.equal((remote.definitions['inventory.reserve'].inputSchema as any).properties.sku.type, 'string')
    assert.ok(Object.isFrozen(remote.definitions))
  })

  it('rejects malformed definitions and non-draft-07 schemas', () => {
    assert.throws(() => defineRemote(null as any), /plain object/)
    assert.throws(() => defineRemote({ '': { workflow () {}, inputSchema: true, outputSchema: true } }), /endpoint name/)
    assert.throws(() => defineRemote({ bad: { workflow: 42, inputSchema: true, outputSchema: true } } as any), /workflow must be a function/)
    assert.throws(() => defineRemote({ bad: { workflow () {}, inputSchema: true, outputSchema: true, workflowId: 'leak' } } as any), /must contain only/)
    assert.throws(() => defineRemote({
      bad: {
        workflow () {},
        inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema' },
        outputSchema: true,
      }
    }), /unsupported JSON Schema dialect/)
    assert.throws(() => defineRemote({ bad: { workflow () {}, inputSchema: { $async: false }, outputSchema: true } }), /must not use \$async/)
    assert.doesNotThrow(() => defineRemote({ formats: { workflow () {}, inputSchema: { type: 'string', format: 'not-installed' }, outputSchema: true } }))
  })
})

describe('remote handler artifact build', () => {
  it('writes stable sorted public and private artifacts adjacent to the Workflow SDK manifest', async () => {
    const { root, workflowManifestPath } = await fixture()
    const charge = Object.assign(async function charge (_input: unknown) {}, {
      workflowId: 'workflow//workflows/payments//charge'
    })
    const reserve = Object.assign(async function reserve (_input: unknown) {}, {
      workflowId: 'workflow//workflows/inventory//reserve'
    })
    const definitions = defineRemote({
      'payments.charge': { workflow: charge, inputSchema: true, outputSchema: false },
      'inventory.reserve': { workflow: reserve, inputSchema, outputSchema },
    })
    const first = await buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath, definitionSource: source(definitions) })
    assert.ok(first)
    assert.deepEqual(first.manifest.endpoints.map(endpoint => endpoint.name), ['inventory.reserve', 'payments.charge'])
    assert.match(first.manifest.manifestHash, /^[0-9a-f]{64}$/)
    assert.equal(first.manifest.manifestHash, '3edb389cfde9c725c379773523b95275ee883ea2fd0af91ef9d4f12867a02467')
    assert.deepEqual(Object.keys(first.manifest), ['v', 'manifestHash', 'endpoints'])
    assert.doesNotMatch(JSON.stringify(first.manifest), /workflowId|workflow\/\//)
    assert.deepEqual(first.privateHandlers.handlers, {
      'inventory.reserve': { workflowId: 'workflow//workflows/inventory//reserve' },
      'payments.charge': { workflowId: 'workflow//workflows/payments//charge' },
    })
    assert.equal(first.remoteManifestPath, join(root, '.well-known/workflow/v1/remote-manifest.json'))
    assert.equal(first.privateHandlersPath, join(root, '.well-known/workflow/v1/remote-handlers.json'))

    const stableTimestamp = new Date('2000-01-01T00:00:00.000Z')
    await utimes(first.remoteManifestPath, stableTimestamp, stableTimestamp)
    const before = await stat(first.remoteManifestPath)
    const second = await buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath, definitionSource: source(definitions) })
    assert.equal((await stat(second!.remoteManifestPath)).mtimeMs, before.mtimeMs)
    assert.deepEqual(await new FileManifestSource(first.remoteManifestPath).read(), first.manifest)
  })

  it('uses transformed workflowId metadata, accepts repeated IDs, and rejects missing identities', async () => {
    const { root, workflowManifestPath } = await fixture()
    const transformed = Object.assign(async function renamed () {}, { workflowId: 'workflow//workflows/inventory//reserve' })
    const exact = defineRemote({ exact: { workflow: transformed, inputSchema: true, outputSchema: true } })
    assert.equal((await buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath, definitionSource: source(exact) }))!.privateHandlers.handlers.exact.workflowId,
      'workflow//workflows/inventory//reserve')

    async function missing () {}
    const missingDefinition = defineRemote({ missing: { workflow: missing, inputSchema: true, outputSchema: true } })
    await assert.rejects(buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath, definitionSource: source(missingDefinition) }), /no transformed workflowId/)

    const duplicateNameManifest = JSON.parse(await readFile(workflowManifestPath, 'utf8'))
    duplicateNameManifest.workflows['workflows/other.ts'] = { reserve: { workflowId: 'workflow//workflows/inventory//reserve' } }
    await writeFile(workflowManifestPath, JSON.stringify(duplicateNameManifest))
    assert.equal((await buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath, definitionSource: source(exact) }))!.privateHandlers.handlers.exact.workflowId,
      'workflow//workflows/inventory//reserve')
  })

  it('treats a missing remote.ts as caller-only and removes stale remote artifacts', async () => {
    const { root, manifestDir, workflowManifestPath } = await fixture()
    await writeFile(join(manifestDir, 'remote-manifest.json'), 'stale')
    await writeFile(join(manifestDir, 'remote-handlers.json'), 'stale')
    assert.equal(await buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath }), null)
    await assert.rejects(stat(join(manifestDir, 'remote-manifest.json')), { code: 'ENOENT' })
    await assert.rejects(stat(join(manifestDir, 'remote-handlers.json')), { code: 'ENOENT' })
  })

  it('loads application-root remote.ts and supports the after-bundle seam', async () => {
    const { root, workflowManifestPath } = await fixture()
    const packageEntry = new URL('../src/handler.ts', import.meta.url).href
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'workflows'), { recursive: true }))
    await writeFile(join(root, 'workflows/inventory.ts'), 'export async function reserve (input) { return input }')
    const manifest = JSON.parse(await readFile(workflowManifestPath, 'utf8'))
    manifest.workflows['node_modules/inventory-copy.ts'] = {
      reserve: { workflowId: 'workflow//workflows/inventory//reserve' }
    }
    await writeFile(workflowManifestPath, JSON.stringify(manifest))
    await writeFile(join(root, 'remote.ts'), `
      import { defineRemote } from ${JSON.stringify(packageEntry)}
      import { reserve } from './workflows/inventory.js'
      export default defineRemote({ 'inventory.reserve': { workflow: reserve, inputSchema: true, outputSchema: true } })
    `)
    const result = await createRemoteAfterBundleHook()({
      workingDir: root,
      artifacts: [
        { kind: 'steps', path: join(root, 'steps.mjs') },
        { kind: 'workflows', path: join(root, 'workflows.mjs') },
        { kind: 'manifest', path: workflowManifestPath },
      ],
    })
    assert.equal(result!.manifest.endpoints[0].name, 'inventory.reserve')
    await assert.rejects(createRemoteAfterBundleHook()({ workingDir: root, artifacts: [] }), /0 manifest artifacts/)
  })

  it('writes hook artifacts to the application root when the SDK manifest is elsewhere', async () => {
    const { root, workflowManifestPath } = await fixture()
    const packageEntry = new URL('../src/handler.ts', import.meta.url).href
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'workflows'), { recursive: true }))
    await writeFile(join(root, 'workflows/inventory.ts'), 'export async function reserve (input: unknown) { return input }')
    const manifest = JSON.parse(await readFile(workflowManifestPath, 'utf8'))
    manifest.workflows['node_modules/inventory-copy.ts'] = {
      reserve: { workflowId: 'workflow//workflows/inventory//reserve' }
    }
    const buildManifestPath = join(root, 'dist/workflow/manifest.json')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'dist/workflow'), { recursive: true }))
    await writeFile(buildManifestPath, JSON.stringify(manifest))
    await writeFile(join(root, 'remote.ts'), `
      import { defineRemote } from ${JSON.stringify(packageEntry)}
      import { reserve } from './workflows/inventory.js'
      export default defineRemote({ 'inventory.reserve': { workflow: reserve, inputSchema: true, outputSchema: true } })
    `)

    const result = await createRemoteAfterBundleHook()({
      workingDir: root,
      artifacts: [
        { kind: 'steps', path: join(root, 'dist/workflow/steps.mjs') },
        { kind: 'workflows', path: join(root, 'dist/workflow/workflows.mjs') },
        { kind: 'manifest', path: buildManifestPath },
      ],
    })

    assert.equal(result!.remoteManifestPath, join(root, '.well-known/workflow/v1/remote-manifest.json'))
    assert.equal(result!.privateHandlersPath, join(root, '.well-known/workflow/v1/remote-handlers.json'))
  })

  it('reloads the complete remote.ts dependency graph on every watch rebuild', async () => {
    const { root, workflowManifestPath } = await fixture()
    const packageEntry = new URL('../src/handler.ts', import.meta.url).href
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'workflows'), { recursive: true }))
    await writeFile(join(root, 'workflows/inventory.ts'), 'export async function reserve (input) { return input }')
    await writeFile(join(root, 'schemas.ts'), 'export const inventoryInput = true')
    await writeFile(join(root, 'remote.ts'), `
      import { defineRemote } from ${JSON.stringify(packageEntry)}
      import { inventoryInput } from './schemas.js'
      import { reserve } from './workflows/inventory.js'
      export default defineRemote({
        'inventory.reserve': { workflow: reserve, inputSchema: inventoryInput, outputSchema: true }
      })
    `)

    const first = await buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath })
    await writeFile(join(root, 'schemas.ts'), 'export const inventoryInput = false')
    const second = await buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath })

    assert.equal(first!.manifest.endpoints[0].inputSchema, true)
    assert.equal(second!.manifest.endpoints[0].inputSchema, false)
    assert.notEqual(first!.manifest.manifestHash, second!.manifest.manifestHash)
  })

  it('serializes concurrent artifact generations without temporary-file collisions', async () => {
    const { root, manifestDir, workflowManifestPath } = await fixture()
    const reserve = Object.assign(async function reserve (_input: unknown) {}, {
      workflowId: 'workflow//workflows/inventory//reserve'
    })
    const charge = Object.assign(async function charge (_input: unknown) {}, {
      workflowId: 'workflow//workflows/payments//charge'
    })
    const events: string[] = []
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>(resolve => { releaseFirst = resolve })
    function trackedSource (
      name: string,
      definitions: DefinedRemoteHandlers,
      gate?: Promise<void>
    ): RemoteDefinitionSource {
      return {
        async read () {
          events.push(`${name}:start`)
          if (name === 'first') markFirstStarted()
          await gate
          events.push(`${name}:end`)
          return definitions
        }
      }
    }
    const firstDefinitions = defineRemote({ reserve: { workflow: reserve, inputSchema: true, outputSchema: true } })
    const secondDefinitions = defineRemote({ charge: { workflow: charge, inputSchema: false, outputSchema: false } })

    const firstBuild = buildRemoteHandlerArtifacts({
      rootDir: root,
      workflowManifestPath,
      definitionSource: trackedSource('first', firstDefinitions, firstCanFinish),
    })
    await firstStarted
    const secondBuild = buildRemoteHandlerArtifacts({
      rootDir: root,
      workflowManifestPath,
      definitionSource: trackedSource('second', secondDefinitions),
    })
    assert.deepEqual(events, ['first:start'])
    releaseFirst()
    await Promise.all([firstBuild, secondBuild])

    const publicManifest = JSON.parse(await readFile(join(manifestDir, 'remote-manifest.json'), 'utf8'))
    const privateManifest = JSON.parse(await readFile(join(manifestDir, 'remote-handlers.json'), 'utf8'))
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end'])
    assert.equal(publicManifest.manifestHash, privateManifest.manifestHash)
    assert.deepEqual(publicManifest.endpoints.map((endpoint: { name: string }) => endpoint.name), ['charge'])
    assert.deepEqual(Object.keys(privateManifest.handlers), ['charge'])
    assert.deepEqual((await readdir(manifestDir)).filter(file => file.endsWith('.tmp')), [])
  })

  it('rejects duplicate endpoints and ambiguous source paths before emitting artifacts', async () => {
    const { root, workflowManifestPath } = await fixture()
    const packageEntry = new URL('../src/handler.ts', import.meta.url).href
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'workflows'), { recursive: true }))
    await writeFile(join(root, 'workflows/inventory.ts'), 'export async function reserve (input) { return input }')
    await writeFile(join(root, 'remote.ts'), `
      import { defineRemote } from ${JSON.stringify(packageEntry)}
      import { reserve } from './workflows/inventory.ts'
      export default defineRemote({
        'inventory.reserve': { workflow: reserve, inputSchema: true, outputSchema: true },
        'inventory.reserve': { workflow: reserve, inputSchema: true, outputSchema: true }
      })
    `)
    await assert.rejects(buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath }), /Duplicate remote endpoint/)

    await writeFile(join(root, 'remote.ts'), `
      import { defineRemote } from ${JSON.stringify(packageEntry)}
      import { reserve } from './workflows/inventory.ts'
      export default defineRemote({ 'inventory.reserve': { workflow: reserve, inputSchema: true, outputSchema: true } })
    `)
    const manifest = JSON.parse(await readFile(workflowManifestPath, 'utf8'))
    manifest.workflows['./workflows/inventory.js'] = {
      reserve: { workflowId: 'workflow//duplicate-path//reserve' }
    }
    await writeFile(workflowManifestPath, JSON.stringify(manifest))
    await assert.rejects(buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath }), /matches 2/)
  })

  it('fails a build whose remote.ts does not default export defineRemote()', async () => {
    const { root, workflowManifestPath } = await fixture()
    await writeFile(join(root, 'remote.ts'), 'export default {}')
    await assert.rejects(buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath }), /must default export defineRemote/)
  })

  it('rejects endpoint definitions that cannot be statically resolved', async () => {
    const { root, workflowManifestPath } = await fixture()
    const packageEntry = new URL('../src/handler.ts', import.meta.url).href
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'workflows'), { recursive: true }))
    await writeFile(join(root, 'workflows/inventory.ts'), 'export async function reserve (input) { return input }')
    await writeFile(join(root, 'remote.ts'), `
      import { defineRemote } from ${JSON.stringify(packageEntry)}
      import { reserve } from './workflows/inventory.ts'
      const endpoint = 'payments.charge'
      export default defineRemote({
        [endpoint]: { workflow: reserve, inputSchema: true, outputSchema: true }
      })
    `)
    await assert.rejects(buildRemoteHandlerArtifacts({ rootDir: root, workflowManifestPath }), /endpoint names must be static strings/)
  })
})
