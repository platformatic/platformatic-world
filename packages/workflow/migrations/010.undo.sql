UPDATE workflow_queue_messages SET status = 'delivered' WHERE status = 'acked';
