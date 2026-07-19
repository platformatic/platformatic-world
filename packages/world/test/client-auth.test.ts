import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HttpClient } from '../src/lib/client.ts'

test('sends the rotated service account token, not the one present at construction', async () => {
  const fakeSaDir = join(tmpdir(), `plt-world-client-auth-${process.pid}`)
  mkdirSync(fakeSaDir, { recursive: true })
  writeFileSync(join(fakeSaDir, 'token'), 'token-one')

  const seen: (string | undefined)[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }

  const originalSaPath = process.env.PLT_WORLD_SA_PATH
  process.env.PLT_WORLD_SA_PATH = fakeSaDir

  const client = new HttpClient({ serviceUrl: `http://127.0.0.1:${port}`, appId: 'demo' })

  try {
    await client.get('/runs')

    // The kubelet rotates the token on disk; the client must pick it up.
    writeFileSync(join(fakeSaDir, 'token'), 'token-two')
    await client.get('/runs')

    assert.deepEqual(seen, ['Bearer token-one', 'Bearer token-two'])
  } finally {
    await client.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (originalSaPath) process.env.PLT_WORLD_SA_PATH = originalSaPath
    else delete process.env.PLT_WORLD_SA_PATH
    rmSync(fakeSaDir, { recursive: true, force: true })
  }
})

test('sends no authorization header outside Kubernetes', async () => {
  const emptyDir = join(tmpdir(), `plt-world-client-noauth-${process.pid}`)
  mkdirSync(emptyDir, { recursive: true })

  const seen: (string | undefined)[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }

  const originalSaPath = process.env.PLT_WORLD_SA_PATH
  process.env.PLT_WORLD_SA_PATH = emptyDir

  const client = new HttpClient({ serviceUrl: `http://127.0.0.1:${port}`, appId: 'demo' })

  try {
    await client.get('/runs')
    assert.deepEqual(seen, [undefined])
  } finally {
    await client.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (originalSaPath) process.env.PLT_WORLD_SA_PATH = originalSaPath
    else delete process.env.PLT_WORLD_SA_PATH
    rmSync(emptyDir, { recursive: true, force: true })
  }
})
