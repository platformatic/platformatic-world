-- Supports tenant-scoped keyset scans used to reannounce operations after a
-- Watt or ICC restart. Deadline filtering remains dynamic and cannot be part
-- of this partial-index predicate.
CREATE INDEX idx_wro_active_feed
  ON workflow_remote_operations (application_id, operation_key COLLATE "C")
  WHERE status IN ('pending', 'started');
