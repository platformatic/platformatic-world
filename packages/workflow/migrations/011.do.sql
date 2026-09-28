ALTER TABLE workflow_applications
  ADD COLUMN icc_application_id UUID,
  ADD CONSTRAINT workflow_applications_icc_application_id_key UNIQUE (icc_application_id),
  ADD CONSTRAINT workflow_applications_id_icc_application_id_key UNIQUE (id, icc_application_id);

ALTER TABLE workflow_remote_operations
  ADD COLUMN icc_application_id UUID,
  ADD COLUMN schema_hash VARCHAR(64),
  ADD COLUMN output_schema JSONB;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM workflow_remote_operations
    WHERE icc_application_id IS NULL OR schema_hash IS NULL OR output_schema IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'cannot migrate WLD1-only remote operation rows without pinned schemas',
      HINT = 'complete or remove existing remote operations before applying migration 011';
  END IF;
END
$$;

ALTER TABLE workflow_remote_operations
  ALTER COLUMN icc_application_id SET NOT NULL,
  ALTER COLUMN schema_hash SET NOT NULL,
  ALTER COLUMN output_schema SET NOT NULL,
  ADD CONSTRAINT workflow_remote_operations_application_icc_fkey
    FOREIGN KEY (application_id, icc_application_id)
    REFERENCES workflow_applications (id, icc_application_id),
  ADD CONSTRAINT workflow_remote_operations_schema_hash_check
    CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT workflow_remote_operations_output_schema_check
    CHECK (jsonb_typeof(output_schema) IN ('object', 'boolean'));
