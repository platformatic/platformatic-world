-- Slot-based event identity (spec version 6).
--
-- Spec-6 runs require event ids to be slot-numbered: `evnt_` + the event's
-- dense, 1-based position in its run's log. The runtime calls requireEventSlot
-- on every event id it loads and fails the run if it cannot read a slot, and it
-- enforces density (no holes) by default (WORKFLOW_SLOT_GAP_CHECK).
--
-- `slot` is nullable: pre-spec-6 rows (and runs still on the older ULID/serial
-- scheme) keep slot = NULL and continue to expose eventId = String(id). Only
-- events created for a spec-6 run get a slot. The partial unique index keeps
-- slots dense-and-unique per run while allowing many NULLs for legacy rows.
ALTER TABLE workflow_events ADD COLUMN slot INTEGER;

CREATE UNIQUE INDEX idx_we_run_slot ON workflow_events (run_id, slot) WHERE slot IS NOT NULL;

-- Allocate the slot in a BEFORE INSERT trigger rather than at each call site.
-- Events are appended from several paths (the events API, the queue poller's
-- orphan/failure handling, admin run actions, deployment draining); a trigger
-- guarantees every one of them stays dense without duplicating the logic. It
-- fires only when the row's run is at spec 6+ and no slot was supplied, so
-- legacy runs and explicit backfills are untouched. The per-run advisory lock
-- (below) serializes allocation so concurrent inserters never read the same
-- MAX(slot); idx_we_run_slot then stands only as a hard invariant that a
-- (run_id, slot) can never be duplicated.
CREATE FUNCTION assign_event_slot () RETURNS TRIGGER AS $$
BEGIN
  IF NEW.slot IS NULL
     AND (SELECT spec_version FROM workflow_runs WHERE id = NEW.run_id) >= 6 THEN
    -- Serialize slot allocation per run. Parallel appends to the same run (e.g.
    -- two waits resuming at once, dispatched concurrently by the poller) would
    -- otherwise read the same MAX(slot) and collide on idx_we_run_slot. This
    -- transaction-scoped advisory lock (keyed on the run id, released at commit)
    -- makes concurrent inserters queue so each sees the previous slot.
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.run_id, 0));
    NEW.slot := COALESCE((SELECT MAX(slot) FROM workflow_events WHERE run_id = NEW.run_id), 0) + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assign_event_slot
  BEFORE INSERT ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION assign_event_slot();
