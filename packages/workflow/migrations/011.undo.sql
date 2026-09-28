ALTER TABLE workflow_remote_operations
  DROP CONSTRAINT workflow_remote_operations_application_icc_fkey,
  DROP CONSTRAINT workflow_remote_operations_output_schema_check,
  DROP CONSTRAINT workflow_remote_operations_schema_hash_check,
  DROP COLUMN output_schema,
  DROP COLUMN schema_hash,
  DROP COLUMN icc_application_id;

ALTER TABLE workflow_applications
  DROP CONSTRAINT workflow_applications_id_icc_application_id_key,
  DROP CONSTRAINT workflow_applications_icc_application_id_key,
  DROP COLUMN icc_application_id;
