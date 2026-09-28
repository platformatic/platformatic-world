CREATE TABLE workflow_remote_handler_runs (
  application_id  INTEGER NOT NULL REFERENCES workflow_applications(id),
  operation_key   VARCHAR(1024) NOT NULL,
  handler_run_id  VARCHAR NOT NULL,
  deadline_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (application_id, operation_key),
  UNIQUE (handler_run_id)
);

CREATE INDEX idx_remote_handler_runs_deadline
  ON workflow_remote_handler_runs (deadline_at, application_id, operation_key);
