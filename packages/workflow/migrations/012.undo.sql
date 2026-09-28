DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workflow_remote_operations
    WHERE status NOT IN ('staged', 'pending')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'cannot downgrade while terminal or started remote operations exist',
      HINT = 'drain or remove remote operations before reverting migration 012';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM workflow_hooks
    WHERE status = 'pending'
    GROUP BY token
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'cannot downgrade while applications share active hook tokens',
      HINT = 'receive or dispose duplicate active hook tokens before reverting migration 012';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workflow_queue_messages
    WHERE idempotency_key IS NOT NULL
    GROUP BY idempotency_key
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'cannot downgrade while applications share queue idempotency keys',
      HINT = 'drain or remove duplicate idempotency keys before reverting migration 012';
  END IF;
END
$$;

DROP INDEX idx_wro_undelivered_outcome;

DROP INDEX idx_wro_deadline;
CREATE INDEX idx_wro_deadline
  ON workflow_remote_operations (deadline_at, operation_key)
  WHERE status = 'pending';

ALTER TABLE workflow_queue_messages
  DROP CONSTRAINT workflow_queue_messages_application_id_idempotency_key_key,
  ADD CONSTRAINT workflow_queue_messages_idempotency_key_key UNIQUE (idempotency_key);

DROP INDEX idx_wh_token_active;
CREATE UNIQUE INDEX idx_wh_token_active
  ON workflow_hooks (token)
  WHERE status = 'pending';

ALTER TABLE workflow_remote_operations
  DROP CONSTRAINT workflow_remote_operations_delivery_check,
  DROP CONSTRAINT workflow_remote_operations_terminal_outcome_check,
  DROP CONSTRAINT workflow_remote_operations_lifecycle_check,
  DROP CONSTRAINT workflow_remote_operations_status_check,
  DROP COLUMN outcome_delivered_at,
  DROP COLUMN completed_at,
  DROP COLUMN outcome,
  DROP COLUMN handler_run_id,
  ADD CONSTRAINT workflow_remote_operations_status_check
    CHECK (status IN ('staged', 'pending')),
  ADD CONSTRAINT workflow_remote_operations_check1
    CHECK (
      (status = 'staged' AND scheduled_at IS NULL)
      OR (status = 'pending' AND scheduled_at IS NOT NULL)
    );
