CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  checkout_session_id TEXT,
  payment_intent_id TEXT,
  customer_email TEXT,
  processed_at BIGINT NOT NULL,
  order_items JSONB NOT NULL
);
