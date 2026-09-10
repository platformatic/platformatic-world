ALTER TABLE workflow_queue_messages DROP COLUMN IF EXISTS published_to;
ALTER TABLE workflow_queue_messages DROP COLUMN IF EXISTS acked_at;
DROP INDEX IF EXISTS idx_wqm_unpublished;
ALTER TABLE workflow_queue_messages DROP COLUMN IF EXISTS published_at;
