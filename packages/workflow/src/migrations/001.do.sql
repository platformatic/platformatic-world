-- Platformatic Workflow Service Schema
-- Single migration: auth + core + queue + encryption + deployment versions

-- ============================================================
-- Auth tables
-- ============================================================

CREATE TABLE workflow_applications (
  id              SERIAL PRIMARY KEY,
  app_id          VARCHAR NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE workflow_app_keys (
  id              SERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES workflow_applications(id),
  key_hash        VARCHAR NOT NULL UNIQUE,
  key_prefix      VARCHAR NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_wak_hash ON workflow_app_keys (key_hash) WHERE revoked_at IS NULL;

CREATE TABLE workflow_app_k8s_bindings (
  id              SERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES workflow_applications(id),
  namespace       VARCHAR NOT NULL,
  service_account VARCHAR NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (namespace, service_account)
);

-- ============================================================
-- Core workflow tables
-- ============================================================

CREATE TABLE workflow_runs (
  id              VARCHAR PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES workflow_applications(id),
  workflow_name   VARCHAR NOT NULL,
  deployment_id   VARCHAR NOT NULL,
  status          VARCHAR NOT NULL DEFAULT 'pending',
  input           BYTEA,
  output          BYTEA,
  error           JSONB,
  execution_context JSONB,
  spec_version    INTEGER,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  expired_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wr_app_status ON workflow_runs (application_id, status);
CREATE INDEX idx_wr_app_deployment ON workflow_runs (application_id, deployment_id);

CREATE TABLE workflow_events (
  id              SERIAL PRIMARY KEY,
  run_id          VARCHAR NOT NULL REFERENCES workflow_runs(id),
  application_id  INTEGER NOT NULL,
  event_type      VARCHAR NOT NULL,
  correlation_id  VARCHAR,
  event_data      BYTEA,
  spec_version    INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_we_run_id ON workflow_events (run_id, id ASC);
CREATE INDEX idx_we_correlation ON workflow_events (application_id, correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE workflow_steps (
  id              VARCHAR PRIMARY KEY,
  run_id          VARCHAR NOT NULL REFERENCES workflow_runs(id),
  application_id  INTEGER NOT NULL,
  correlation_id  VARCHAR NOT NULL,
  step_name       VARCHAR NOT NULL,
  status          VARCHAR NOT NULL DEFAULT 'pending',
  input           BYTEA,
  output          BYTEA,
  error           JSONB,
  attempt         INTEGER NOT NULL DEFAULT 1,
  retry_after     TIMESTAMPTZ,
  spec_version    INTEGER,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ws_run_id ON workflow_steps (run_id);

CREATE TABLE workflow_hooks (
  id              VARCHAR PRIMARY KEY,
  run_id          VARCHAR NOT NULL REFERENCES workflow_runs(id),
  application_id  INTEGER NOT NULL,
  correlation_id  VARCHAR NOT NULL,
  token           VARCHAR NOT NULL,
  owner_id        VARCHAR NOT NULL DEFAULT '',
  project_id      VARCHAR NOT NULL DEFAULT '',
  environment     VARCHAR NOT NULL DEFAULT '',
  metadata        BYTEA,
  status          VARCHAR NOT NULL DEFAULT 'pending',
  is_webhook      BOOLEAN NOT NULL DEFAULT false,
  received_at     TIMESTAMPTZ,
  disposed_at     TIMESTAMPTZ,
  spec_version    INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_wh_token_active ON workflow_hooks (token) WHERE status = 'pending';
CREATE INDEX idx_wh_token ON workflow_hooks (token);
CREATE INDEX idx_wh_run_id ON workflow_hooks (run_id);
CREATE INDEX idx_wh_status ON workflow_hooks (application_id, status);

CREATE TABLE workflow_waits (
  id              VARCHAR PRIMARY KEY,
  run_id          VARCHAR NOT NULL REFERENCES workflow_runs(id),
  application_id  INTEGER NOT NULL,
  correlation_id  VARCHAR NOT NULL,
  status          VARCHAR NOT NULL DEFAULT 'waiting',
  resume_at       TIMESTAMPTZ,
  spec_version    INTEGER,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ww_run_id ON workflow_waits (run_id);

CREATE TABLE workflow_stream_chunks (
  id              SERIAL PRIMARY KEY,
  stream_name     VARCHAR NOT NULL,
  run_id          VARCHAR NOT NULL REFERENCES workflow_runs(id),
  application_id  INTEGER NOT NULL,
  chunk_index     INTEGER NOT NULL,
  data            BYTEA NOT NULL,
  is_closed       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wsc_stream ON workflow_stream_chunks (application_id, stream_name, chunk_index ASC);
CREATE INDEX idx_wsc_run ON workflow_stream_chunks (run_id);

-- ============================================================
-- Queue tables
-- ============================================================

CREATE TABLE workflow_queue_handlers (
  id              SERIAL PRIMARY KEY,
  deployment_version VARCHAR NOT NULL,
  application_id  INTEGER NOT NULL,
  pod_id          VARCHAR NOT NULL,
  workflow_url    VARCHAR NOT NULL,
  step_url        VARCHAR NOT NULL,
  webhook_url     VARCHAR NOT NULL,
  registered_at   TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (application_id, pod_id)
);

CREATE TABLE workflow_queue_messages (
  id              SERIAL PRIMARY KEY,
  idempotency_key VARCHAR,
  queue_name      VARCHAR NOT NULL,
  run_id          VARCHAR NOT NULL,
  deployment_version VARCHAR NOT NULL,
  application_id  INTEGER NOT NULL,
  payload         JSONB NOT NULL,
  status          VARCHAR DEFAULT 'pending',
  attempts        INTEGER DEFAULT 0,
  deliver_at      TIMESTAMPTZ,
  next_retry_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  UNIQUE (idempotency_key)
);

CREATE INDEX idx_wqm_deferred ON workflow_queue_messages (deliver_at)
  WHERE status = 'deferred';
CREATE INDEX idx_wqm_status_retry ON workflow_queue_messages (status, next_retry_at)
  WHERE status = 'failed';
CREATE INDEX idx_wqm_pending ON workflow_queue_messages (created_at)
  WHERE status = 'pending';
CREATE INDEX idx_wqm_run_id ON workflow_queue_messages (run_id);

-- ============================================================
-- Support tables
-- ============================================================

CREATE TABLE workflow_encryption_keys (
  application_id  INTEGER NOT NULL PRIMARY KEY REFERENCES workflow_applications(id),
  secret          BYTEA NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE workflow_deployment_versions (
  id              SERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES workflow_applications(id),
  deployment_version VARCHAR NOT NULL,
  status          VARCHAR NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (application_id, deployment_version)
);

CREATE TABLE workflow_app_quotas (
  application_id  INTEGER NOT NULL PRIMARY KEY REFERENCES workflow_applications(id),
  max_runs        INTEGER NOT NULL DEFAULT 10000,
  max_events_per_run INTEGER NOT NULL DEFAULT 10000,
  max_queue_per_minute INTEGER NOT NULL DEFAULT 1000,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
