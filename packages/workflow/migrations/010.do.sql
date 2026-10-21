-- A handled queue message is now 'acked', a terminal state. Up to 0.14.2
-- the poller left it in 'delivered', and a reclaim timer read that as an
-- executor that died mid-step: any run still running after the visibility
-- timeout (an eve session between turns, a long sleep) had its last message
-- redelivered every interval and was failed once the attempts ran out. The
-- reclaim is gone and nothing sets 'delivered' any more, so every row in it
-- was handled and only needs the new name.
UPDATE workflow_queue_messages SET status = 'acked' WHERE status = 'delivered';
