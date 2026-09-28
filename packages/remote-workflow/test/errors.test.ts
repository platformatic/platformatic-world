import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOperationKey } from '../src/dispatch.ts'
import {
  errorForCode,
  errorForOutcome,
  RemoteCancelledError,
  RemoteFailedError,
  RemoteNotClaimedError,
  RemoteTimedOutError,
  RemoteUnavailableError,
} from '../src/errors.ts'

describe('@platformatic/remote-workflow errors and identity', () => {
  it('derives collision-safe deterministic operation keys from every identity field', () => {
    const first = createOperationKey('run', 'step', 'inventory.reserve', 'ordinal-1')
    assert.equal(first, createOperationKey('run', 'step', 'inventory.reserve', 'ordinal-1'))
    assert.match(first, /^rop_[a-f0-9]{64}$/)
    assert.notEqual(first, createOperationKey('run-2', 'step', 'inventory.reserve', 'ordinal-1'))
    assert.notEqual(first, createOperationKey('run', 'step-2', 'inventory.reserve', 'ordinal-1'))
    assert.notEqual(first, createOperationKey('run', 'step', 'inventory.reserve', 'ordinal-2'))
    assert.notEqual(first, createOperationKey('run', 'step', 'inventory.release', 'ordinal-1'))
    assert.notEqual(
      createOperationKey('a', 'bc', 'd', 'e'),
      createOperationKey('ab', 'c', 'd', 'e')
    )
    assert.equal(
      createOperationKey(
        'wrun_01ABC',
        'step//@platformatic/remote-workflow@0.1.0//dispatchRemoteOperation',
        'inventory.reserve',
        'step_01XYZ'
      ),
      'rop_0ad2fe8cab62f832c0d7ae261628764c2db4cde6b3d169dc52ac6977401e56a5'
    )
  })

  it('maps every frozen protocol error code to a typed caller error', () => {
    for (const code of ['endpoint_unknown', 'endpoint_withdrawn', 'admission_rejected', 'manifest_conflict', 'start_rejected']) {
      assert.ok(errorForCode(code, code) instanceof RemoteUnavailableError)
    }
    for (const code of ['schema_invalid_input', 'schema_invalid_output', 'dead_letter']) {
      assert.ok(errorForCode(code, code) instanceof RemoteFailedError)
    }
    assert.ok(errorForCode('budget_exhausted', 'expired') instanceof RemoteTimedOutError)
  })

  it('unwraps terminal outcome kinds and preserves operation context', () => {
    const common = { error: { code: 'HANDLER_ERROR', message: 'handler failed' }, handlerRunId: 'handler-1' }
    const failed = errorForOutcome('operation-1', { ok: false, kind: 'failed', ...common })
    assert.ok(failed instanceof RemoteFailedError)
    assert.equal(failed.operationKey, 'operation-1')
    assert.equal(failed.handlerRunId, 'handler-1')

    assert.ok(errorForOutcome('op', { ok: false, kind: 'cancelled', ...common }) instanceof RemoteCancelledError)
    assert.ok(errorForOutcome('op', { ok: false, kind: 'not_claimed', ...common }) instanceof RemoteNotClaimedError)
    assert.ok(errorForOutcome('op', { ok: false, kind: 'unavailable', ...common }) instanceof RemoteUnavailableError)
    const detailed = errorForOutcome('op', {
      ok: false,
      kind: 'unavailable',
      detail: { code: 'endpoint_withdrawn', message: 'endpoint was withdrawn' },
    })
    assert.ok(detailed instanceof RemoteUnavailableError)
    assert.equal(detailed.code, 'endpoint_withdrawn')
    assert.ok(errorForOutcome('op', {
      ok: false,
      kind: 'failed',
      error: { code: 'budget_exhausted', message: 'expired' },
    }) instanceof RemoteTimedOutError)
  })
})
