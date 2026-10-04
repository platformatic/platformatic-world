import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from '../src/lib/storage.ts'

describe('events.createBatch client', () => {
  it('serializes nested event data and restores batch results', async () => {
    const input = new Uint8Array([1, 2, 3, 4])
    let request: any
    const client = {
      async post (path: string, body: any, query: any) {
        request = { path, body, query }
        return {
          results: [{
            status: 200,
            event: {
              eventId: 'evnt_00000000000000000000000001',
              eventType: 'step_created',
              createdAt: '2026-01-02T03:04:05.000Z',
              eventData: { input: Buffer.from(input).toString('base64') }
            },
            step: {
              stepId: 'step-1',
              createdAt: '2026-01-02T03:04:05.000Z',
              updatedAt: '2026-01-02T03:04:06.000Z',
              input: Buffer.from(input).toString('base64')
            },
            wait: {
              waitId: 'wait-1',
              resumeAt: '2026-01-02T03:05:05.000Z'
            }
          }]
        }
      }
    }
    const storage = createStorage(client as any)

    const result = await storage.events.createBatch('run-1', [{
      occurredAt: new Date('2026-01-02T03:04:05.000Z'),
      event: {
        eventType: 'step_created',
        correlationId: 'step-1',
        eventData: { stepName: 'first', input }
      }
    }], { resolveData: 'all', eventCount: 4 })

    assert.equal(request.path, '/runs/run-1/events/batch')
    assert.deepEqual(request.query, { resolveData: 'all', eventCount: '4' })
    assert.equal(request.body.events[0].event.eventData.input, 'AQIDBA==')
    assert.ok(request.body.events[0].occurredAt instanceof Date)

    const item = result.results[0]
    assert.ok(item.event.createdAt instanceof Date)
    assert.deepEqual(item.event.eventData.input, input)
    assert.ok(item.step.createdAt instanceof Date)
    assert.ok(item.step.updatedAt instanceof Date)
    assert.deepEqual(item.step.input, input)
    assert.ok(item.wait.resumeAt instanceof Date)
  })

  it('rejects an empty batch before making a request', async () => {
    let called = false
    const storage = createStorage({
      async post () {
        called = true
      }
    } as any)

    await assert.rejects(
      storage.events.createBatch('run-1', []),
      (err: any) => err.name === 'WorkflowWorldError' && err.statusCode === 400
    )
    assert.equal(called, false)
  })
})
