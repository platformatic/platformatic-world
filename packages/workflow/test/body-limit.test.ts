import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'
import { getBodyLimit, DEFAULT_BODY_LIMIT_BYTES } from '../lib/body-limit.ts'

describe('getBodyLimit', () => {
  afterEach(() => {
    delete process.env.WF_BODY_LIMIT_BYTES
  })

  it('defaults to 20 MB', () => {
    assert.equal(DEFAULT_BODY_LIMIT_BYTES, 20 * 1024 * 1024)
    assert.equal(getBodyLimit(), DEFAULT_BODY_LIMIT_BYTES)
  })

  it('reads WF_BODY_LIMIT_BYTES', () => {
    process.env.WF_BODY_LIMIT_BYTES = '52428800'
    assert.equal(getBodyLimit(), 52428800)
  })

  it('falls back to the default for invalid values', () => {
    for (const value of ['', 'abc', '0', '-1', '1.5']) {
      process.env.WF_BODY_LIMIT_BYTES = value
      assert.equal(getBodyLimit(), DEFAULT_BODY_LIMIT_BYTES, `value ${JSON.stringify(value)}`)
    }
  })
})

describe('WF_BODY_LIMIT_BYTES applies to events and streams', () => {
  const limit = 2 * 1024 * 1024
  let ctx: TestContext
  let runId: string

  before(async () => {
    process.env.WF_BODY_LIMIT_BYTES = String(limit)
    ctx = await setupTest()

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1', workflowName: 'body-limit-test', input: {} },
      },
    })
    runId = JSON.parse(createRes.body).run.runId
  })

  after(async () => {
    delete process.env.WF_BODY_LIMIT_BYTES
    await teardownTest(ctx)
  })

  function writeStream (size: number) {
    return ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/streams/stream-limit-${size}-${Date.now()}`,
      headers: { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify('a'.repeat(size)),
    })
  }

  it('accepts a stream write under the limit', async () => {
    assert.equal((await writeStream(limit / 2)).statusCode, 204)
  })

  it('rejects a stream write over the limit', async () => {
    assert.equal((await writeStream(limit + 1024)).statusCode, 413)
  })

  it('rejects event writes over the same limit', async () => {
    const payload = JSON.stringify({ eventType: 'run_started', specVersion: 2, eventData: { pad: 'a'.repeat(limit + 1024) } })
    for (const path of ['events', 'events/batch']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/apps/${ctx.appId}/runs/${runId}/${path}`,
        headers: { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
        payload,
      })
      assert.equal(res.statusCode, 413, path)
    }
  })
})
