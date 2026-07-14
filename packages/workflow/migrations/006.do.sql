ALTER TABLE workflow_queue_messages
  ADD COLUMN last_failure JSONB,
  ADD COLUMN dead_at TIMESTAMPTZ,
  ADD COLUMN failure_finalized_at TIMESTAMPTZ,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
