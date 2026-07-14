ALTER TABLE workflow_queue_messages
  DROP COLUMN updated_at,
  DROP COLUMN terminalized_at,
  DROP COLUMN dead_at,
  DROP COLUMN last_failure;
