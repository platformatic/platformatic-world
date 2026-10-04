import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createStreamer } from '../src/lib/streamer.ts'
import { createEncryption } from '../src/lib/encryption.ts'

function fakeClient (respond: (path: string) => any = () => undefined) {
  const calls: any[] = []
  return {
    calls,
    async put (path: string, body: any, headers?: Record<string, string>) {
      calls.push({ method: 'put', path, body, headers })
    },
    async get (path: string, query?: any) {
      calls.push({ method: 'get', path, query })
      return respond(path)
    },
    async getStream (path: string, query?: any) {
      calls.push({ method: 'getStream', path, query })
      return Readable.from([Buffer.from('ab'), Buffer.from('cd')])
    }
  }
}

async function readAll (stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

describe('streamer v5 shape', () => {
  it('write base64-encodes the chunk', async () => {
    const client = fakeClient()
    const { streams } = createStreamer(client as any)

    await streams.write('run-1', 'out', 'hello')

    assert.equal(client.calls[0].path, '/runs/run-1/streams/out')
    assert.deepEqual(client.calls[0].body, { data: Buffer.from('hello').toString('base64') })
  })

  it('writeMulti tags string and binary chunks', async () => {
    const client = fakeClient()
    const { streams } = createStreamer(client as any)

    await streams.writeMulti('run-1', 'out', ['text', new Uint8Array([1, 2])])

    assert.deepEqual(client.calls[0].body, [
      { data: 'text', type: 'string' },
      { data: 'AQI=', type: 'binary' }
    ])
    assert.deepEqual(client.calls[0].headers, { 'x-stream-multi': 'true' })
  })

  it('close marks the stream done', async () => {
    const client = fakeClient()
    const { streams } = createStreamer(client as any)

    await streams.close('run-1', 'out')

    assert.deepEqual(client.calls[0].headers, { 'x-stream-done': 'true' })
  })

  it('get copies chunks into standalone buffers', async () => {
    const client = fakeClient()
    const { streams } = createStreamer(client as any)

    const chunks = await readAll(await streams.get('run-1', 'out', 3))

    assert.equal(client.calls[0].path, '/streams/out')
    assert.deepEqual(client.calls[0].query, { stream: 'true', startIndex: '3' })
    assert.equal(Buffer.concat(chunks).toString(), 'abcd')
    for (const chunk of chunks) {
      assert.equal(chunk.constructor, Uint8Array)
    }
  })

  it('list, getChunks and getInfo hit their routes', async () => {
    const client = fakeClient((path) => {
      if (path.endsWith('/chunks')) return { data: [{ index: 0, data: 'AQI=' }], cursor: null }
      if (path.endsWith('/info')) return { tailIndex: 0, done: true }
      return ['out']
    })
    const { streams } = createStreamer(client as any)

    assert.deepEqual(await streams.list('run-1'), ['out'])
    const page = await streams.getChunks('run-1', 'out', { limit: 5, cursor: 'c1' })
    await streams.getChunks('run-1', 'out')
    assert.deepEqual(await streams.getInfo('run-1', 'out'), { tailIndex: 0, done: true })

    assert.equal(client.calls[0].path, '/runs/run-1/streams')
    assert.deepEqual(client.calls[1].query, { limit: '5', cursor: 'c1' })
    assert.deepEqual(client.calls[2].query, {})
    assert.equal(client.calls[3].path, '/runs/run-1/streams/out/info')
    assert.deepEqual(page.data, [{ index: 0, data: Buffer.from([1, 2]) }])
    assert.equal(page.cursor, null)
  })
})

describe('streamer v4 shape', () => {
  it('flat methods take the name first', async () => {
    const client = fakeClient((path) => path.endsWith('/chunks') ? { data: [] } : { done: false })
    const streamer = createStreamer(client as any)

    await streamer.writeToStream('out', 'run-1', new Uint8Array([1]))
    await streamer.writeToStreamMulti('out', 'run-1', ['a'])
    await streamer.closeStream('out', 'run-1')
    await readAll(await streamer.readFromStream('out'))
    await streamer.listStreamsByRunId('run-1')
    await streamer.getStreamChunks('out', 'run-1')
    await streamer.getStreamInfo('out', 'run-1')

    const paths: string[] = []
    for (const call of client.calls) paths.push(call.path)
    assert.deepEqual(paths, [
      '/runs/run-1/streams/out',
      '/runs/run-1/streams/out',
      '/runs/run-1/streams/out',
      '/streams/out',
      '/runs/run-1/streams',
      '/runs/run-1/streams/out/chunks',
      '/runs/run-1/streams/out/info'
    ])
    assert.deepEqual(client.calls[3].query, { stream: 'true' })
  })
})

describe('encryption', () => {
  it('decodes the key for a run id or a run object', async () => {
    const client = fakeClient(() => ({ key: 'AQIDBA==' }))
    const getKey = createEncryption(client as any)

    assert.deepEqual(await getKey('run-1'), new Uint8Array([1, 2, 3, 4]))
    assert.deepEqual(await getKey({ runId: 'run-2' }), new Uint8Array([1, 2, 3, 4]))
    assert.deepEqual(client.calls[0].query, { runId: 'run-1' })
    assert.deepEqual(client.calls[1].query, { runId: 'run-2' })
  })

  it('returns undefined without a run id or a key', async () => {
    const results: any[] = [{}, undefined]
    const client = fakeClient(() => results.shift())
    const getKey = createEncryption(client as any)

    assert.equal(await getKey(undefined), undefined)
    assert.equal(await getKey({}), undefined)
    assert.equal(client.calls.length, 0)
    assert.equal(await getKey('run-1'), undefined)
    assert.equal(await getKey('run-1'), undefined)
  })
})
