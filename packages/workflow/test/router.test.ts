import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { routeMessage } from '../queue/router.ts'
import type pg from 'pg'

describe('queue router', () => {
  it('deduplicates the selected endpoint URLs before random selection', async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('workflow_deployment_versions')) return { rows: [] }
        return {
          rows: [
            {
              workflow_url: 'http://service-a/flow',
              step_url: 'http://service-a/step',
              webhook_url: 'http://service-a/webhook'
            },
            {
              workflow_url: 'http://service-a/flow',
              step_url: 'http://service-a/step',
              webhook_url: 'http://service-a/webhook'
            },
            {
              workflow_url: 'http://service-a/flow',
              step_url: 'http://service-a/step',
              webhook_url: 'http://service-a/webhook'
            },
            {
              workflow_url: 'http://service-b/flow',
              step_url: 'http://service-b/step',
              webhook_url: 'http://service-b/webhook'
            }
          ]
        }
      }
    } as unknown as pg.Pool
    const random = Math.random
    Math.random = () => 0.75

    try {
      const route = await routeMessage(pool, 1, 'v1', '__wkf_workflow_test')
      assert.deepEqual(route, { url: 'http://service-b/flow' })
    } finally {
      Math.random = random
    }
  })

  it('selects the endpoint matching the queue type', async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('workflow_deployment_versions')) return { rows: [] }
        return {
          rows: [{
            workflow_url: 'http://service/flow',
            step_url: 'http://service/step',
            webhook_url: 'http://service/webhook'
          }]
        }
      }
    } as unknown as pg.Pool

    assert.deepEqual(await routeMessage(pool, 1, 'v1', '__wkf_step_test'), { url: 'http://service/step' })
    assert.deepEqual(await routeMessage(pool, 1, 'v1', '__wkf_workflow_test'), { url: 'http://service/flow' })
    assert.deepEqual(await routeMessage(pool, 1, 'v1', '__tenant1_wkf_step_test'), { url: 'http://service/step' })
    assert.deepEqual(await routeMessage(pool, 1, 'v1', '__tenant1_wkf_workflow_test'), { url: 'http://service/flow' })
    assert.deepEqual(await routeMessage(pool, 1, 'v1', '__Tenant_wkf_step_test'), { url: 'http://service/webhook' })
    assert.deepEqual(await routeMessage(pool, 1, 'v1', '__tenant-name_wkf_workflow_test'), { url: 'http://service/webhook' })
    assert.deepEqual(await routeMessage(pool, 1, 'v1', 'webhook'), { url: 'http://service/webhook' })
  })
})
