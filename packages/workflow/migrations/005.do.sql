LOCK TABLE workflow_stream_chunks IN ACCESS EXCLUSIVE MODE;

WITH ranked_chunks AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY application_id, run_id, stream_name
           ORDER BY chunk_index, id
         )::integer - 1 AS new_chunk_index
  FROM workflow_stream_chunks
  WHERE is_closed = FALSE
)
UPDATE workflow_stream_chunks AS chunks
SET chunk_index = ranked_chunks.new_chunk_index
FROM ranked_chunks
WHERE chunks.id = ranked_chunks.id;

WITH ranked_closes AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY application_id, run_id, stream_name
           ORDER BY id
         ) AS close_number
  FROM workflow_stream_chunks
  WHERE is_closed = TRUE
)
DELETE FROM workflow_stream_chunks AS chunks
USING ranked_closes
WHERE chunks.id = ranked_closes.id
  AND ranked_closes.close_number > 1;

UPDATE workflow_stream_chunks
SET chunk_index = -1
WHERE is_closed = TRUE;

CREATE UNIQUE INDEX idx_wsc_unique_chunk
  ON workflow_stream_chunks (application_id, run_id, stream_name, chunk_index);
