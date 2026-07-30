import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createPlatformaticWorld } from '../src/index.ts'

// Hermetic: a stub service that always 404s the hook lookups, so the error
// contract can be asserted without PostgreSQL or a running workflow service.
describe('hooks not-found error naming', () => {
  let server: Server
  let world: ReturnType<typeof createPlatformaticWorld>

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        statusCode: 404,
        error: `Hook ${req.url} not found`,
        message: `Hook ${req.url} not found`,
      }))
    })
    server.listen(0)
    await once(server, 'listening')
    const { port } = server.address() as { port: number }

    world = createPlatformaticWorld({
      serviceUrl: `http://127.0.0.1:${port}`,
      appId: 'default',
      deploymentVersion: 'v1.0.0',
    })
  })

  after(async () => {
    if (world) await world.close()
    server.close()
    await once(server, 'close')
  })

  it('names a getByToken 404 so HookNotFoundError.is() matches', async () => {
    const token = 'eve:eve:7caf22f2-f714-4493-8329-f5cd68a7f52e'
    const err: any = await world.hooks.getByToken(token).then(
      () => null,
      (e: unknown) => e
    )

    assert.ok(err, 'expected getByToken to reject')
    // HookNotFoundError.is() is a structural check on this exact name.
    assert.equal(err.name, 'HookNotFoundError')
    assert.equal(err.token, token)
    assert.equal(err.statusCode, 404)
  })

  it('names a hooks.get 404 the same way', async () => {
    const err: any = await world.hooks.get('hook_123').then(
      () => null,
      (e: unknown) => e
    )

    assert.ok(err, 'expected get to reject')
    assert.equal(err.name, 'HookNotFoundError')
    assert.equal(err.hookId, 'hook_123')
    assert.equal(err.statusCode, 404)
  })
})
