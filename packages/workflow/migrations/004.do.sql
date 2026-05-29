-- workflow SDK v5.0.0-beta.7 introduced dehydrateStepError/hydrateStepError:
-- step_failed/step_retrying/run_failed events now carry eventData.error as a
-- Uint8Array (devalue + format-prefix + optional encryption). Storing it as
-- JSONB lossily reshapes the bytes, so hydrateStepError fails with
-- "Failed to hydrate step error: Invalid input".
--
-- Switch the error columns to BYTEA so the bytes round-trip faithfully. Any
-- legacy {message,stack} JSON in these columns is dropped (acceptable on the
-- 0.x beta track; historic runs do not need their error payloads preserved).

ALTER TABLE workflow_steps ALTER COLUMN error TYPE BYTEA USING NULL;
ALTER TABLE workflow_runs  ALTER COLUMN error TYPE BYTEA USING NULL;
