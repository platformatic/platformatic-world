-- CBOR queue transport: add payload_bytes (BYTEA) + payload_encoding columns
-- so messages can be stored in their wire encoding (json or cbor).

ALTER TABLE workflow_queue_messages
  ALTER COLUMN payload DROP NOT NULL,
  ADD COLUMN payload_bytes BYTEA,
  ADD COLUMN payload_encoding TEXT NOT NULL DEFAULT 'json'
    CHECK (payload_encoding IN ('json', 'cbor'));

ALTER TABLE workflow_queue_messages
  ADD CONSTRAINT payload_xor
    CHECK ((payload IS NOT NULL)::int + (payload_bytes IS NOT NULL)::int = 1);
