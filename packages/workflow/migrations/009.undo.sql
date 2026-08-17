DROP TRIGGER IF EXISTS trg_assign_event_slot ON workflow_events;
DROP FUNCTION IF EXISTS assign_event_slot ();
DROP INDEX IF EXISTS idx_we_run_slot;
ALTER TABLE workflow_events DROP COLUMN IF EXISTS slot;
