ALTER TABLE workflow_remote_operations
  DROP CONSTRAINT workflow_remote_operations_status_check,
  DROP CONSTRAINT workflow_remote_operations_check1,
  ADD COLUMN handler_run_id VARCHAR,
  ADD COLUMN outcome JSONB,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN outcome_delivered_at TIMESTAMPTZ,
  ADD CONSTRAINT workflow_remote_operations_status_check
    CHECK (status IN ('staged', 'pending', 'started', 'completed', 'failed', 'cancelled', 'dead_letter')),
  ADD CONSTRAINT workflow_remote_operations_lifecycle_check
    CHECK (
      (status = 'staged' AND scheduled_at IS NULL)
      OR (status IN ('pending', 'started') AND scheduled_at IS NOT NULL)
      OR status IN ('completed', 'failed', 'cancelled', 'dead_letter')
    ),
  ADD CONSTRAINT workflow_remote_operations_terminal_outcome_check
    CHECK (
      (status IN ('completed', 'failed', 'cancelled', 'dead_letter') AND outcome IS NOT NULL AND completed_at IS NOT NULL)
      OR
      (status IN ('staged', 'pending', 'started') AND outcome IS NULL AND completed_at IS NULL)
    ),
  ADD CONSTRAINT workflow_remote_operations_delivery_check
    CHECK (outcome_delivered_at IS NULL OR status IN ('completed', 'failed', 'cancelled', 'dead_letter'));

-- Hooks and queue idempotency are tenant-local. The original indexes predate
-- multi-tenant operation delivery and would make an otherwise valid key in one
-- application conflict with the same key in another application.
DROP INDEX idx_wh_token_active;
CREATE UNIQUE INDEX idx_wh_token_active
  ON workflow_hooks (application_id, token)
  WHERE status = 'pending';

ALTER TABLE workflow_queue_messages
  DROP CONSTRAINT workflow_queue_messages_idempotency_key_key,
  ADD CONSTRAINT workflow_queue_messages_application_id_idempotency_key_key
    UNIQUE (application_id, idempotency_key);

-- Expiry covers every non-terminal state, not only pending operations.
DROP INDEX idx_wro_deadline;
CREATE INDEX idx_wro_deadline
  ON workflow_remote_operations (deadline_at, operation_key, application_id)
  WHERE status IN ('staged', 'pending', 'started');

CREATE INDEX idx_wro_undelivered_outcome
  ON workflow_remote_operations (completed_at, operation_key)
  WHERE outcome_delivered_at IS NULL
    AND status IN ('completed', 'failed', 'cancelled', 'dead_letter');
