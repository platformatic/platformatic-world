import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setupTest, teardownTest } from './helper.ts'
import type { TestContext } from './helper.ts'

describe('events', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  it('should create a run via run_created event', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: {
          deploymentId: 'v1.0.0',
          workflowName: 'test-workflow',
          input: { foo: 'bar' },
        },
      },
    })

    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.ok(body.event)
    assert.ok(body.run)
    assert.equal(body.event.eventType, 'run_created')
    assert.equal(body.run.status, 'pending')
    assert.equal(body.run.workflowName, 'test-workflow')
    assert.equal(body.run.deploymentId, 'v1.0.0')
    assert.deepEqual(body.run.attributes, {})
    assert.ok(body.run.runId)
  })

  it('should be idempotent on duplicate run_created for the same runId', async () => {
    // The SDK retries the trigger endpoint on transient errors. A second
    // POST for the same runId must return 200 (with the existing run state),
    // not 500 from the workflow_runs unique constraint, and must not append
    // a duplicate run_created event to the log.
    const runId = `wrun_idempotent_${randomBytes(8).toString('hex')}`
    const payload = {
      eventType: 'run_created',
      specVersion: 2,
      eventData: {
        deploymentId: 'v1.0.0',
        workflowName: 'idempotent-test',
        input: { n: 1 },
      },
    }

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload,
    })
    assert.equal(first.statusCode, 200)
    const firstBody = JSON.parse(first.body)
    assert.equal(firstBody.run.runId, runId)

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload,
    })
    assert.equal(second.statusCode, 200)
    const secondBody = JSON.parse(second.body)
    assert.equal(secondBody.run.runId, runId)

    // Exactly one run_created event in the log, no duplicates.
    const eventsRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    assert.equal(eventsRes.statusCode, 200)
    const events = JSON.parse(eventsRes.body)
    const runCreatedEvents = events.data.filter((e: any) => e.eventType === 'run_created')
    assert.equal(runCreatedEvents.length, 1, 'expected exactly one run_created event')
  })

  it('should handle full run lifecycle', async () => {
    // Create run
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: {
          deploymentId: 'v1.0.0',
          workflowName: 'lifecycle-test',
          input: { data: 'test' },
        },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId

    // Start run
    const startRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: { eventType: 'run_started', specVersion: 2 },
    })
    assert.equal(JSON.parse(startRes.body).run.status, 'running')

    // Create step
    const stepRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_created',
        correlationId: 'step-1',
        specVersion: 2,
        eventData: {
          stepName: 'fetchData',
          input: { url: 'https://example.com' },
        },
      },
    })
    assert.ok(JSON.parse(stepRes.body).step)
    assert.equal(JSON.parse(stepRes.body).step.status, 'pending')

    // Start step
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_started',
        correlationId: 'step-1',
        specVersion: 2,
        eventData: { attempt: 1 },
      },
    })

    // Complete step
    const completeStepRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'step_completed',
        correlationId: 'step-1',
        specVersion: 2,
        eventData: { result: { data: 'fetched' } },
      },
    })
    assert.equal(JSON.parse(completeStepRes.body).step.status, 'completed')

    // Complete run
    const completeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_completed',
        specVersion: 2,
        eventData: { output: { result: 'success' } },
      },
    })
    assert.equal(JSON.parse(completeRes.body).run.status, 'completed')

    // List events
    const eventsRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    })
    const events = JSON.parse(eventsRes.body)
    assert.equal(events.data.length, 6) // run_created, run_started, step_created, step_started, step_completed, run_completed
  })

  it('should persist initial attributes and atomically apply attr_set events', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      payload: {
        eventType: 'run_created',
        specVersion: 4,
        eventData: {
          deploymentId: 'v4',
          workflowName: 'attributes-test',
          input: {},
          attributes: { keep: 'yes', remove: 'old' }
        }
      }
    })
    assert.equal(create.statusCode, 200)
    const runId = JSON.parse(create.body).run.runId
    const update = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events?resolveData=none`,
      payload: {
        eventType: 'attr_set',
        correlationId: 'attrs-1',
        specVersion: 4,
        eventData: {
          changes: [{ key: 'added', value: 'new' }, { key: 'remove', value: null }],
          writer: { type: 'workflow' }
        }
      }
    })
    assert.equal(update.statusCode, 200)
    const updated = JSON.parse(update.body)
    assert.deepEqual(updated.run.attributes, { keep: 'yes', added: 'new' })
    assert.equal(updated.event.eventData.writer.type, 'workflow')
    assert.equal(updated.event.eventData.changes[0].key, 'added')

    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      payload: {
        eventType: 'attr_set',
        correlationId: 'attrs-1',
        specVersion: 4,
        eventData: {
          changes: [{ key: 'added', value: 'different' }],
          writer: { type: 'workflow' }
        }
      }
    })
    assert.equal(duplicate.statusCode, 200)
    assert.deepEqual(JSON.parse(duplicate.body).run.attributes, { keep: 'yes', added: 'new' })
  })

  it('should validate attributes and reject terminal-run writes', async () => {
    const invalid = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      payload: {
        eventType: 'run_created',
        specVersion: 4,
        eventData: { deploymentId: 'v4', workflowName: 'invalid-attributes', input: {}, attributes: { $reserved: 'no' } }
      }
    })
    assert.equal(invalid.statusCode, 400)

    const allowed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      payload: {
        eventType: 'run_created',
        specVersion: 4,
        eventData: {
          deploymentId: 'v4',
          workflowName: 'allowed-attributes',
          input: {},
          attributes: { $system: 'yes' },
          allowReservedAttributes: true
        }
      }
    })
    assert.equal(allowed.statusCode, 200)
    const runId = JSON.parse(allowed.body).run.runId
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      payload: { eventType: 'run_completed', specVersion: 4, eventData: { output: {} } }
    })
    const terminal = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      payload: {
        eventType: 'attr_set',
        specVersion: 4,
        eventData: { changes: [{ key: 'late', value: 'no' }], writer: { type: 'step', stepId: 's1', attempt: 1 } }
      }
    })
    assert.equal(terminal.statusCode, 400)
  })

  it('should restore initial attributes during resilient run_started', async () => {
    const runId = `wrun_resilient_attrs_${randomBytes(8).toString('hex')}`
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      payload: {
        eventType: 'run_started',
        specVersion: 4,
        eventData: {
          deploymentId: 'v4',
          workflowName: 'resilient-attributes',
          input: {},
          attributes: { restored: 'yes' }
        }
      }
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.body).run.attributes, { restored: 'yes' })

    const events = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`
    })
    assert.equal(events.statusCode, 200)
    assert.deepEqual(JSON.parse(events.body).data.map((event: any) => event.eventType), ['run_created', 'run_started'])
  })

  it('should reject attributes for spec 3 runs', async () => {
    const invalidCreate = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      payload: {
        eventType: 'run_created',
        specVersion: 3,
        eventData: {
          deploymentId: 'v3',
          workflowName: 'spec-3-attributes',
          input: {},
          attributes: { unsupported: 'true' }
        }
      }
    })
    assert.equal(invalidCreate.statusCode, 400)

    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      payload: {
        eventType: 'run_created',
        specVersion: 3,
        eventData: { deploymentId: 'v3', workflowName: 'spec-3-run', input: {} }
      }
    })
    assert.equal(create.statusCode, 200)
    const runId = JSON.parse(create.body).run.runId
    const update = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      payload: {
        eventType: 'attr_set',
        specVersion: 4,
        eventData: {
          changes: [{ key: 'unsupported', value: 'true' }],
          writer: { type: 'workflow' }
        }
      }
    })
    assert.equal(update.statusCode, 400)
  })

  it('should reject invalid attr_set batches', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      payload: {
        eventType: 'run_created',
        specVersion: 4,
        eventData: { deploymentId: 'v4', workflowName: 'attribute-validation', input: {} }
      }
    })
    const runId = JSON.parse(create.body).run.runId
    const invalidChanges = [
      [{ key: 'duplicate', value: 'one' }, { key: 'duplicate', value: 'two' }],
      [{ key: 'wrong-value', value: 1 }],
      [{ key: 'x'.repeat(257), value: 'too-long' }],
      [{ key: 'large', value: 'x'.repeat(257) }],
      Array.from({ length: 65 }, (_, index) => ({ key: `key-${index}`, value: 'value' }))
    ]

    for (const changes of invalidChanges) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
        payload: {
          eventType: 'attr_set',
          specVersion: 4,
          eventData: { changes, writer: { type: 'workflow' } }
        }
      })
      assert.equal(response.statusCode, 400)
    }
  })

  it('should handle hook_created with token conflict', async () => {
    // workflow_hooks has a partial unique index on token WHERE status='pending'
    // that is global across apps — a hard-coded token would collide with
    // leftovers from a crashed prior run (teardown only runs on success).
    const token = `conflict-token-${randomBytes(8).toString('hex')}`

    // Create a run first
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'hook-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId

    // Create hook
    const hookRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        specVersion: 2,
        eventData: { token },
      },
    })
    assert.ok(JSON.parse(hookRes.body).hook)

    // Create another hook with same token → should get hook_conflict
    const conflictRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'hook_created',
        correlationId: 'hook-2',
        specVersion: 2,
        eventData: { token },
      },
    })
    const conflict = JSON.parse(conflictRes.body)
    assert.equal(conflict.event.eventType, 'hook_conflict')
  })

  it('should handle wait lifecycle', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'wait-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId

    // Create wait
    const waitRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'wait_created',
        correlationId: 'wait-1',
        specVersion: 2,
        eventData: { resumeAt: new Date(Date.now() + 60_000).toISOString() },
      },
    })
    const wait = JSON.parse(waitRes.body)
    assert.ok(wait.wait)
    assert.equal(wait.wait.status, 'waiting')

    // Complete wait
    const completeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'wait_completed',
        correlationId: 'wait-1',
        specVersion: 2,
      },
    })
    const completed = JSON.parse(completeRes.body)
    assert.equal(completed.wait.status, 'completed')
  })

  it('paginates run events in both directions without dropping the cursor', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'pagination-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId
    const run = await ctx.app.pg.query('SELECT application_id FROM workflow_runs WHERE id = $1', [runId])
    await ctx.app.pg.query(
      `INSERT INTO workflow_events (run_id, application_id, event_type)
       SELECT $1, $2, 'pagination_event' FROM generate_series(1, 4)
       RETURNING id`,
      [runId, run.rows[0].application_id]
    )
    const allEvents = await ctx.app.pg.query('SELECT id FROM workflow_events WHERE run_id = $1 ORDER BY id ASC', [runId])
    const ids = allEvents.rows.map(row => String(row.id))
    const baseUrl = `/api/v1/apps/${ctx.appId}/runs/${runId}/events`
    const headers = { authorization: `Bearer ${ctx.apiKey}` }

    const first = JSON.parse((await ctx.app.inject({ method: 'GET', url: `${baseUrl}?limit=3`, headers })).body)
    assert.deepEqual(first.data.map((event: any) => event.eventId), ids.slice(0, 3))
    assert.equal(first.cursor, ids[2])
    assert.equal(first.hasMore, true)

    const final = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}?limit=3&cursor=${first.cursor}`,
      headers,
    })).body)
    assert.deepEqual(final.data.map((event: any) => event.eventId), ids.slice(3))
    assert.equal(final.cursor, ids.at(-1))
    assert.equal(final.hasMore, false)

    const empty = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}?cursor=${final.cursor}`,
      headers,
    })).body)
    assert.deepEqual(empty.data, [])
    assert.equal(empty.cursor, final.cursor)

    const later = await ctx.app.pg.query(
      `INSERT INTO workflow_events (run_id, application_id, event_type)
       VALUES ($1, $2, 'later_event') RETURNING id`,
      [runId, run.rows[0].application_id]
    )
    const incremental = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}?cursor=${final.cursor}`,
      headers,
    })).body)
    assert.deepEqual(incremental.data.map((event: any) => event.eventId), [String(later.rows[0].id)])
    assert.equal(incremental.cursor, String(later.rows[0].id))

    const desc = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}?limit=2&sortOrder=desc`,
      headers,
    })).body)
    assert.deepEqual(desc.data.map((event: any) => event.eventId), [String(later.rows[0].id), ids.at(-1)])
    assert.equal(desc.cursor, ids.at(-1))

    const descNext = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}?limit=2&sortOrder=desc&cursor=${desc.cursor}`,
      headers,
    })).body)
    assert.deepEqual(descNext.data.map((event: any) => event.eventId), ids.slice(-3, -1).reverse())
  })

  it('paginates correlation events in both directions and preserves empty-page cursors', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: {
        eventType: 'run_created',
        specVersion: 2,
        eventData: { deploymentId: 'v1.0.0', workflowName: 'correlation-pagination-test', input: {} },
      },
    })
    const runId = JSON.parse(createRes.body).run.runId
    const run = await ctx.app.pg.query('SELECT application_id FROM workflow_runs WHERE id = $1', [runId])
    const correlationId = `pagination-${randomBytes(8).toString('hex')}`
    const inserted = await ctx.app.pg.query(
      `INSERT INTO workflow_events (run_id, application_id, event_type, correlation_id)
       SELECT $1, $2, 'correlation_event', $3 FROM generate_series(1, 4)
       RETURNING id`,
      [runId, run.rows[0].application_id, correlationId]
    )
    const ids = inserted.rows.map(row => String(row.id))
    const baseUrl = `/api/v1/apps/${ctx.appId}/events/by-correlation?correlationId=${correlationId}`
    const headers = { authorization: `Bearer ${ctx.apiKey}` }

    const first = JSON.parse((await ctx.app.inject({ method: 'GET', url: `${baseUrl}&limit=2`, headers })).body)
    assert.deepEqual(first.data.map((event: any) => event.eventId), ids.slice(0, 2))
    assert.equal(first.cursor, ids[1])
    assert.equal(first.hasMore, true)

    const final = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}&limit=2&cursor=${first.cursor}`,
      headers,
    })).body)
    assert.deepEqual(final.data.map((event: any) => event.eventId), ids.slice(2))
    assert.equal(final.cursor, ids.at(-1))
    assert.equal(final.hasMore, false)

    const empty = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}&cursor=${final.cursor}`,
      headers,
    })).body)
    assert.deepEqual(empty.data, [])
    assert.equal(empty.cursor, final.cursor)

    const desc = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}&limit=2&sortOrder=desc`,
      headers,
    })).body)
    assert.deepEqual(desc.data.map((event: any) => event.eventId), ids.slice(-2).reverse())
    assert.equal(desc.cursor, ids.at(-2))

    const descFinal = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `${baseUrl}&limit=2&sortOrder=desc&cursor=${desc.cursor}`,
      headers,
    })).body)
    assert.deepEqual(descFinal.data.map((event: any) => event.eventId), ids.slice(0, 2).reverse())
    assert.equal(descFinal.cursor, ids[0])
    assert.equal(descFinal.hasMore, false)
  })
})

describe('slot identity (spec 6)', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  const headers = () => ({ authorization: `Bearer ${ctx.apiKey}` })
  // Mirror slotToEventId in the events plugin: evnt_ + zero-padded 1-based slot.
  const slotId = (n: number) => 'evnt_' + String(n).padStart(26, '0')

  async function createRun (specVersion: number, workflowName: string): Promise<any> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: headers(),
      payload: {
        eventType: 'run_created',
        specVersion,
        eventData: { deploymentId: 'v1', workflowName, input: {} },
      },
    })
    assert.equal(res.statusCode, 200)
    return JSON.parse(res.body)
  }

  function attrSet (runId: string, specVersion: number, correlationId: string, query = '') {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events${query}`,
      headers: headers(),
      payload: {
        eventType: 'attr_set',
        correlationId,
        specVersion,
        eventData: { changes: [{ key: correlationId, value: 'v' }], writer: { type: 'workflow' } },
      },
    })
  }

  it('allocates dense, 1-based slot event ids for a spec-6 run', async () => {
    const created = await createRun(6, 'dense-slot-test')
    const runId = created.run.runId
    assert.equal(created.event.eventId, slotId(1))

    assert.equal(JSON.parse((await attrSet(runId, 6, 'a')).body).event.eventId, slotId(2))
    assert.equal(JSON.parse((await attrSet(runId, 6, 'b')).body).event.eventId, slotId(3))

    const list = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events?sortOrder=asc`,
      headers: headers(),
    })).body)
    assert.deepEqual(list.data.map((e: any) => e.eventId), [slotId(1), slotId(2), slotId(3)])
  })

  it('keeps legacy serial event ids for runs below spec 6', async () => {
    const created = await createRun(5, 'legacy-id-test')
    assert.match(created.event.eventId, /^[0-9]+$/)
    assert.ok(!created.event.eventId.startsWith('evnt_'))

    const next = JSON.parse((await attrSet(created.run.runId, 5, 'a')).body)
    assert.match(next.event.eventId, /^[0-9]+$/)
  })

  it('keeps slots dense under concurrent inserts into one run', async () => {
    const runId = (await createRun(6, 'concurrent-slot-test')).run.runId
    const n = 10
    // step_created takes no run-level lock, so slot allocation here rides purely
    // on the trigger's per-run serialization.
    const results = await Promise.all(Array.from({ length: n }, (_, i) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
        headers: headers(),
        payload: {
          eventType: 'step_created',
          correlationId: `c${i}`,
          specVersion: 6,
          eventData: { stepName: `step-${i}`, input: {} },
        },
      })
    ))
    for (const r of results) assert.equal(r.statusCode, 200)

    const slots = (await ctx.app.pg.query(
      'SELECT slot FROM workflow_events WHERE run_id = $1 ORDER BY slot ASC',
      [runId]
    )).rows.map((r: any) => r.slot)
    // run_created (1) + n step_created — dense 1..n+1, no gaps, no duplicates.
    assert.deepEqual(slots, Array.from({ length: n + 1 }, (_, i) => i + 1))

    // The API list must return them in slot order, not id order: the SERIAL id
    // is assigned before the trigger allocates the slot, so a lower id can carry
    // a higher slot under concurrency. Ordering by id would surface them jumbled.
    const list = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events?sortOrder=asc&limit=100`,
      headers: headers(),
    })).body)
    assert.deepEqual(
      list.data.map((e: any) => e.eventId),
      Array.from({ length: n + 1 }, (_, i) => slotId(i + 1))
    )
  })

  it('reports events skipped past a stale eventCount (bump-and-report)', async () => {
    const runId = (await createRun(6, 'bump-report-test')).run.runId // slot 1
    await attrSet(runId, 6, 'a') // slot 2
    await attrSet(runId, 6, 'b') // slot 3

    // Writer's snapshot claims 1 loaded event (expects slot 2) but the log is
    // already at slot 3. This create lands at slot 4 and reports slots 2-3.
    const res = JSON.parse((await attrSet(runId, 6, 'c', '?eventCount=1')).body)
    assert.equal(res.event.eventId, slotId(4))
    assert.deepEqual(res.events.map((e: any) => e.eventId), [slotId(2), slotId(3)])
    assert.equal(res.cursor, slotId(3))
    assert.equal(res.hasMore, false)
  })

  it('omits the report when eventCount matches the log head', async () => {
    const runId = (await createRun(6, 'no-bump-test')).run.runId // slot 1
    // Holds 1 event, expects slot 2, lands exactly on slot 2 — nothing skipped.
    const res = JSON.parse((await attrSet(runId, 6, 'a', '?eventCount=1')).body)
    assert.equal(res.event.eventId, slotId(2))
    assert.equal(res.events, undefined)
    assert.equal(res.cursor, undefined)
    assert.equal(res.hasMore, undefined)
  })

  it('rejects a malformed or negative eventCount and accepts 0', async () => {
    const runId = (await createRun(6, 'eventcount-validation-test')).run.runId
    for (const bad of ['1junk', '-1', 'abc']) {
      const res = await attrSet(runId, 6, `x-${bad}`, `?eventCount=${encodeURIComponent(bad)}`)
      assert.equal(res.statusCode, 400)
    }
    // 0 is a valid empty snapshot.
    assert.equal((await attrSet(runId, 6, 'zero', '?eventCount=0')).statusCode, 200)
  })

  it('paginates a spec-6 run ascending and descending by slot', async () => {
    const runId = (await createRun(6, 'slot-pagination-test')).run.runId // slot 1
    for (const c of ['a', 'b', 'c', 'd']) await attrSet(runId, 6, c) // slots 2..5
    const all = [1, 2, 3, 4, 5].map(slotId)
    const baseUrl = `/api/v1/apps/${ctx.appId}/runs/${runId}/events`

    const asc1 = JSON.parse((await ctx.app.inject({ method: 'GET', url: `${baseUrl}?limit=2&sortOrder=asc`, headers: headers() })).body)
    assert.deepEqual(asc1.data.map((e: any) => e.eventId), all.slice(0, 2))
    assert.equal(asc1.cursor, slotId(2))
    assert.equal(asc1.hasMore, true)

    const asc2 = JSON.parse((await ctx.app.inject({ method: 'GET', url: `${baseUrl}?limit=2&sortOrder=asc&cursor=${asc1.cursor}`, headers: headers() })).body)
    assert.deepEqual(asc2.data.map((e: any) => e.eventId), all.slice(2, 4))

    const desc1 = JSON.parse((await ctx.app.inject({ method: 'GET', url: `${baseUrl}?limit=2&sortOrder=desc`, headers: headers() })).body)
    assert.deepEqual(desc1.data.map((e: any) => e.eventId), all.slice(-2).reverse())
    assert.equal(desc1.cursor, slotId(4))
  })

  it('paginates correlation events across runs by global id, not run-local slot', async () => {
    // The same correlation id in two spec-6 runs: each event lands on the same
    // low slot (2), so a slot-local cursor would drop the second run's event.
    const corr = `shared-${randomBytes(6).toString('hex')}`
    const run1 = (await createRun(6, 'corr-multi-run-1')).run.runId
    const e1 = JSON.parse((await attrSet(run1, 6, corr)).body)
    const run2 = (await createRun(6, 'corr-multi-run-2')).run.runId
    const e2 = JSON.parse((await attrSet(run2, 6, corr)).body)
    assert.equal(e1.event.eventId, slotId(2))
    assert.equal(e2.event.eventId, slotId(2))

    const baseUrl = `/api/v1/apps/${ctx.appId}/events/by-correlation?correlationId=${corr}`
    const page1 = JSON.parse((await ctx.app.inject({ method: 'GET', url: `${baseUrl}&limit=1`, headers: headers() })).body)
    assert.equal(page1.data.length, 1)
    assert.equal(page1.hasMore, true)

    const page2 = JSON.parse((await ctx.app.inject({ method: 'GET', url: `${baseUrl}&limit=1&cursor=${page1.cursor}`, headers: headers() })).body)
    assert.equal(page2.data.length, 1)
    assert.equal(page2.hasMore, false)

    // Both runs' events surfaced across the pages — a run-local slot cursor
    // would have filtered the second run's slot-2 event out entirely.
    assert.deepEqual(
      [page1.data[0].runId, page2.data[0].runId].sort(),
      [run1, run2].sort()
    )
  })
})

describe('sealed log (spec 7)', () => {
  let ctx: TestContext

  before(async () => {
    ctx = await setupTest()
  })

  after(async () => {
    await teardownTest(ctx)
  })

  const headers = () => ({ authorization: `Bearer ${ctx.apiKey}` })
  const slotId = (n: number) => 'evnt_' + String(n).padStart(26, '0')

  async function createRun (specVersion: number, workflowName: string): Promise<any> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/null/events`,
      headers: headers(),
      payload: {
        eventType: 'run_created',
        specVersion,
        eventData: { deploymentId: 'v1', workflowName, input: {} },
      },
    })
    assert.equal(res.statusCode, 200)
    return JSON.parse(res.body)
  }

  it('allocates slot event ids for spec-7 runs', async () => {
    const created = await createRun(7, 'sealed-log-slot-test')
    assert.equal(created.event.eventId, slotId(1))
    assert.equal(created.run.specVersion, 7)

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${created.run.runId}/events`,
      headers: headers(),
      payload: {
        eventType: 'attr_set',
        correlationId: 'a',
        specVersion: 7,
        eventData: { changes: [{ key: 'k', value: 'v' }], writer: { type: 'workflow' } },
      },
    })
    assert.equal(JSON.parse(second.body).event.eventId, slotId(2))
  })

  it('reads back a noop event without choking on the unknown type', async () => {
    // Simulate a noop written by another backend.
    const created = await createRun(7, 'noop-read-test')
    const runId = created.run.runId
    const appRow = await ctx.app.pg.query('SELECT application_id FROM workflow_runs WHERE id = $1', [runId])
    await ctx.app.pg.query(
      `INSERT INTO workflow_events (run_id, application_id, event_type, event_data, spec_version)
       VALUES ($1, $2, 'noop', $3, 7)`,
      [runId, appRow.rows[0].application_id, Buffer.from(JSON.stringify({ sealed: true }))]
    )

    const list = JSON.parse((await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events?sortOrder=asc`,
      headers: headers(),
    })).body)
    assert.deepEqual(list.data.map((e: any) => e.eventType), ['run_created', 'noop'])
    assert.deepEqual(list.data.map((e: any) => e.eventId), [slotId(1), slotId(2)])
    assert.deepEqual(list.data[1].eventData, { sealed: true })
  })

  it('rejects a client-created noop (backend-only event type)', async () => {
    const runId = (await createRun(7, 'noop-not-user-creatable')).run.runId
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/apps/${ctx.appId}/runs/${runId}/events`,
      headers: headers(),
      payload: { eventType: 'noop', specVersion: 7, eventData: { sealed: true } },
    })
    assert.equal(res.statusCode, 400)
  })
})
