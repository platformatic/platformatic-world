import { test } from 'node:test'
import assert from 'node:assert/strict'

// The timeout is read once, when the module loads, so this needs its own
// process with the variable set before the import.
test('WF_DELIVERY_VISIBILITY_TIMEOUT_S overrides the default visibility timeout', async () => {
  process.env.WF_DELIVERY_VISIBILITY_TIMEOUT_S = '42'
  const { reclaimExpiredDeliveries } = await import('../queue/poller.ts')

  const params: any[][] = []
  const client = {
    async query (_sql: string, values: any[]) {
      params.push(values)
      return { rows: [] }
    },
  }
  const log = { warn () {}, error () {}, info () {} }

  assert.equal(await reclaimExpiredDeliveries(client as any, log), 0)
  assert.equal(params[0][0], 42)
  assert.equal(params[1][0], 42)
})
