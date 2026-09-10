-- Outbox marker for the queue's Postgres-to-broker handoff.
--
-- Postgres stays the source of truth for every queue message, whatever carries
-- the bytes. With the default Postgres transport the row and its publication
-- commit together, so published_at is stamped inline and the outbox is always
-- empty. With a remote transport (Redis, SQS) the two cannot share a
-- transaction: the message row commits first with published_at NULL, and a
-- relay hands it to the broker and stamps published_at afterwards.
--
-- Committing before publishing is what makes the dual write safe. A crash
-- before the publish leaves a row the relay picks up later; a crash between the
-- publish and the stamp republishes, which is harmless because the consumer
-- gate (claimForDispatch) refuses a message that is no longer dispatchable.
--
-- Existing rows are backfilled as published: they predate any remote transport,
-- so they are by definition already where they need to be.
-- No default, deliberately. NULL means "committed, not yet handed to the
-- transport", and the relay runs for every transport including Postgres (where
-- publishing is a no-op and the relay only stamps the column). That way a
-- producer which writes a row directly -- run replay, a background-step
-- continuation, draining -- is picked up automatically instead of being marked
-- published without ever having been sent. Defaulting to NOW() would have made
-- exactly those rows invisible to a remote broker, permanently.
ALTER TABLE workflow_queue_messages ADD COLUMN published_at TIMESTAMPTZ;

-- Which transport received it. published_at alone says a message was handed
-- over, not who to, so switching WF_QUEUE_DRIVER would strand every in-flight
-- row: already marked published, but never actually sent to the new broker.
-- Recording the destination lets the relay notice the mismatch and republish,
-- which makes a driver change self-healing instead of something that needs the
-- queue drained first.
ALTER TABLE workflow_queue_messages ADD COLUMN published_to VARCHAR;

-- Existing rows were carried by the only transport that has ever existed.
UPDATE workflow_queue_messages
  SET published_at = COALESCE(created_at, NOW()), published_to = 'postgres';

-- The relay's query: committed, ready, and not yet handed to the transport that
-- is running now. Partial on status alone, since the published_to comparison is
-- against a runtime value.
CREATE INDEX idx_wqm_unpublished ON workflow_queue_messages (created_at)
  WHERE status = 'pending';

-- Terminal marker for a delivery the consumer completed.
--
-- claimForDispatch moves a message to 'delivered', and reclaimExpired treats a
-- row still sitting there past the visibility timeout as an executor that died
-- mid-step. A successful delivery therefore has to leave that state, or it gets
-- redispatched against a run that is still legitimately running.
ALTER TABLE workflow_queue_messages ADD COLUMN acked_at TIMESTAMPTZ;
