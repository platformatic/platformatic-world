-- Phase 5: Quotas table for per-app limits
CREATE TABLE workflow_app_quotas (
  application_id  INTEGER NOT NULL PRIMARY KEY REFERENCES workflow_applications(id),
  max_runs        INTEGER NOT NULL DEFAULT 10000,
  max_events_per_run INTEGER NOT NULL DEFAULT 10000,
  max_queue_per_minute INTEGER NOT NULL DEFAULT 1000,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
