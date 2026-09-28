-- Durable remote-step operation records.
--
-- A caller stages an operation before its dispatch step returns. The matching
-- step_completed event promotes the row to pending in the same transaction as
-- the step result and event. Consumers must only consider pending rows.
CREATE TABLE workflow_remote_operations (
  application_id       INTEGER NOT NULL REFERENCES workflow_applications(id),
  operation_key        VARCHAR(1024) NOT NULL CHECK (operation_key <> ''),
  caller_run_id        VARCHAR NOT NULL REFERENCES workflow_runs(id),
  dispatch_step_id     VARCHAR NOT NULL CHECK (dispatch_step_id <> ''),
  ordinal              VARCHAR NOT NULL CHECK (ordinal <> ''),
  endpoint             VARCHAR(1024) NOT NULL CHECK (endpoint <> ''),
  epoch                BIGINT NOT NULL CHECK (epoch >= 0),
  payload              JSONB NOT NULL,
  payload_size_bytes   INTEGER NOT NULL
    CHECK (payload_size_bytes >= 0 AND payload_size_bytes <= 262144),
  budget_remaining_ms  INTEGER NOT NULL CHECK (budget_remaining_ms >= 1000),
  deadline_at          TIMESTAMPTZ NOT NULL,
  status               VARCHAR NOT NULL DEFAULT 'staged'
    CHECK (status IN ('staged', 'pending')),
  claim_attempts       INTEGER NOT NULL DEFAULT 0 CHECK (claim_attempts >= 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_at         TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (application_id, operation_key),
  UNIQUE (application_id, caller_run_id, dispatch_step_id, ordinal),
  CHECK (deadline_at >= created_at),
  CHECK (
    (status = 'staged' AND scheduled_at IS NULL) OR
    (status = 'pending' AND scheduled_at IS NOT NULL)
  )
);

CREATE INDEX idx_wro_dispatchable
  ON workflow_remote_operations (application_id, endpoint, scheduled_at, operation_key)
  WHERE status = 'pending';

CREATE INDEX idx_wro_deadline
  ON workflow_remote_operations (deadline_at, operation_key)
  WHERE status = 'pending';
