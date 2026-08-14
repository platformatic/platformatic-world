ALTER TABLE workflow_queue_handlers
  ADD COLUMN service_scoped BOOLEAN NOT NULL DEFAULT FALSE;
