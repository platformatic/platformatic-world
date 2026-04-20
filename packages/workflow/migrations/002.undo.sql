-- Forward-only: refuses to run if any CBOR rows exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workflow_queue_messages WHERE payload_encoding = 'cbor') THEN
    RAISE EXCEPTION 'Cannot downgrade: workflow_queue_messages has cbor rows. Drain queue first.';
  END IF;
END $$;

ALTER TABLE workflow_queue_messages DROP CONSTRAINT payload_xor;
ALTER TABLE workflow_queue_messages DROP COLUMN payload_encoding;
ALTER TABLE workflow_queue_messages DROP COLUMN payload_bytes;
ALTER TABLE workflow_queue_messages ALTER COLUMN payload SET NOT NULL;
