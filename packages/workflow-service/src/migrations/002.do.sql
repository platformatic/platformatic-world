-- Add status column to workflow_hooks for tracking hook lifecycle
ALTER TABLE workflow_hooks ADD COLUMN status VARCHAR NOT NULL DEFAULT 'pending';
ALTER TABLE workflow_hooks ADD COLUMN received_at TIMESTAMPTZ;
ALTER TABLE workflow_hooks ADD COLUMN disposed_at TIMESTAMPTZ;

CREATE INDEX idx_wh_status ON workflow_hooks (application_id, status);
