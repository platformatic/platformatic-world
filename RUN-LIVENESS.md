# Run Liveness: Orphan Detection vs Delivery Visibility

Status: proposal. Nothing here is implemented.

The workflow service fails healthy runs. This proposes deleting orphan detection and replacing it with a delivery visibility timeout, which targets the failure it was actually guarding against.

## 1. Symptom

An eve chat session produces two runs. The child `turnWorkflow` completes in ~400ms with the correct answer. The parent `workflowEntry` sits idle and then fails, roughly sixteen minutes later, with:

```
QueueDeliveryError
Run orphaned: no activity for 15 minutes
ORPHANED
```

Nothing went wrong. The parent is waiting for the user's next message.

## 2. What the code does today

`packages/workflow/queue/poller.ts` runs `checkOrphans` on a timer (`ORPHAN_CHECK_INTERVAL = 60_000`, line 8) and fails every run matching:

```sql
SELECT id, application_id, deployment_id FROM workflow_runs
WHERE status = 'running'
  AND updated_at < NOW() - INTERVAL '15 minutes'
  AND id NOT IN (
    SELECT DISTINCT run_id FROM workflow_queue_messages
    WHERE status IN ('pending', 'deferred', 'failed')
  )
LIMIT 10
```

Three properties matter. The only evidence of life is an undelivered queue message. The threshold is a SQL literal with no configuration knob (only the sweep cadence is a named constant). And nothing consults hooks, waits, or child runs.

## 3. Why it misfires

A run parked on a hook has no undelivered queue message, because the message that parked it was delivered successfully. Its `updated_at` stops moving, because waiting is not activity. So it matches all three conditions while being perfectly healthy.

Observed on run `wrun_01KXZVBSCNFQBSCS5VX40H0220`: three hooks (`turn-control`, `auth`, and an eve session hook) and every queue message in state `delivered`. The live event stream for that session ends on `session.waiting` with `wait: next-user-message`, which is the parent doing exactly what it is designed to do.

This is not specific to eve. `workflow-demo` ships a `longRunning` workflow whose stated purpose is to wait indefinitely on a hook. Under this sweep it is killed after fifteen minutes.

## 4. What it is actually guarding

Once a message reaches `delivered` (`poller.ts:584-590`), nothing ever reclaims it. There is no visibility timeout, no lock expiry, and no reaper for delivered-but-unacknowledged messages; the retry machinery only touches `pending`, `deferred`, and `failed`. So when an executor dies mid-step, the message stays `delivered` forever and the run stays `running` forever.

Orphan detection is the only backstop for that, which explains its shape: "running, stale, and no queue message outstanding" is a rough proxy for "nobody is coming back for this". The proxy is wrong because it cannot distinguish a dead executor from a run that is legitimately idle.

## 5. What the workflow model expects

Vercel's reference implementation, `@workflow/world-local`, contains no orphan detection: no stale-run sweep, no lease, no heartbeat. Durability is the point of the model. A run may sleep for days or wait indefinitely on a hook, and the World is not expected to police that.

The `@workflow/world` interface likewise describes runs in terms of reaching a terminal state, and defines no suspended or waiting run status for a World to key off.

So this sweep is not implementing an SDK requirement. It is a local safety net that contradicts the execution model it is protecting.

## 6. Proposal

Delete orphan detection. Add a visibility timeout on delivery instead.

A message that has been `delivered` for longer than the timeout, and whose run is not in a terminal state, returns to `pending` and is redelivered, subject to the existing `attempts` ceiling. No schema change is required: `workflow_queue_messages` already carries `delivered_at` and `attempts`.

This is strictly better than reaping runs:

- It targets the thing that is actually broken. The run is fine; the message is stuck.
- It is self-correcting. Redelivery resumes the run rather than failing it, so a transient executor loss becomes a retry rather than a lost session.
- It cannot misfire on an idle run, because an idle run has no delivered-and-unacknowledged message. The correctness argument does not depend on recognising hooks, waits, or child runs.
- It needs no new run state, so nothing client-visible changes.

The timeout should be configurable, and should exceed the longest expected single step rather than the longest expected run. Those are different quantities, which is the conflation at the heart of the current bug.

## 7. Alternatives considered

**Teach the sweep about hooks, waits, and child runs.** Fixes the false failures but trades them for leaked runs: a run waiting on a hook that is never resumed would never be reaped. It also grows a list of "things that count as alive" that must be extended whenever a new blocking primitive appears, and it leaves the real gap (unreclaimed delivered messages) unaddressed.

**Introduce a suspended run status.** Conceptually cleaner, and the schema hints at it, since `workflow_waits` already defaults to `status = 'waiting'` while `workflow_runs` only holds `pending`, `running`, `completed`, `failed`, `cancelled`, and `expired`. The blocker is that the World cannot reliably tell suspended from working: a workflow may create a hook and continue executing other steps. The party that knows is the runtime, so this would require a contract change with the SDK rather than a change inside the World. Worth revisiting if the SDK ever reports it, but it is not available today.

**Renewable execution lease.** A lease presumes something is executing that can renew it. An idle session between turns has no executor, so nobody renews and the lease expires for exactly the same wrong reason. Leases solve crashed-executor detection, which the visibility timeout already covers more directly.

## 8. Risks and open questions

Removing the sweep means a run whose executor dies and whose message somehow never redelivers stays `running` indefinitely. The visibility timeout closes the ordinary case; a long-stop maximum run age could be added later if an unbounded run proves to be a real operational problem rather than a theoretical one.

Operationally, immortal runs are already bounded elsewhere: ICC's `PLT_SKEW_WORKFLOW_MAX_ALIVE_MS` (900000 in the desk development profile) caps how long a draining version stays alive, so a stuck run cannot pin a deployment version forever. The World sweep is a second, blunter bound on the same concern.

Removal is low-risk on the consumer side: `ORPHANED` appears in exactly one place, the line that emits it, and nothing in the World or in ICC keys off it.

Choosing the default visibility timeout needs a number for the longest legitimate single step, including slow model calls. That is the one input this document does not have.
