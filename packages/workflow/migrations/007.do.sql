ALTER TABLE workflow_runs
  ADD COLUMN attributes JSONB NOT NULL DEFAULT '{}'::jsonb;
