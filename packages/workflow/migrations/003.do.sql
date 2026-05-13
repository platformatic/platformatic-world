-- Dedupe non-repeatable correlated events at the index level. The
-- SELECT-then-INSERT path in plugins/events.ts can race under concurrent
-- dispatch retries; duplicate wait_/hook_ completion events cause
-- "Unconsumed event in event log" on SDK replay.

CREATE UNIQUE INDEX idx_we_unique_correlated
  ON workflow_events (run_id, event_type, correlation_id)
  WHERE event_type IN (
    'wait_created',
    'wait_completed',
    'hook_received',
    'hook_disposed'
  ) AND correlation_id IS NOT NULL;
