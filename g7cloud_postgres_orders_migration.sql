-- ============================================================
-- Little Oddities: unified order numbers + local orders table
-- ============================================================
-- Safe to re-run (idempotent). Apply once on the G7Cloud
-- PostgreSQL production database via the existing console flow.
--
-- Design notes:
-- - `lo_order_number_seq` is the single atomic allocator shared by
--   BOTH online (Stripe webhook) and manual (IRL) orders. Do NOT
--   allocate numbers with MAX()+1 or COUNT()+1 anywhere.
-- - `orders.order_number` stores the raw numeric value; the display
--   reference is formatted in the app as LO-<number padded to at
--   least 3 digits> (LO-099, LO-100, ..., LO-1000, LO-1001, ...).
-- - Historical fulfilment status records keep referencing Stripe
--   Checkout Session IDs; manual orders use their local order UUID
--   as order_status_records.order_id. order_status_records.order_id
--   is TEXT and needs no schema change.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS lo_order_number_seq START 1;

CREATE TABLE IF NOT EXISTS orders (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number               BIGINT NOT NULL,
  source                     TEXT NOT NULL DEFAULT 'online'
                             CHECK (source IN ('online', 'irl')),
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id   TEXT,
  client_request_id          TEXT,
  customer_name              TEXT,
  customer_email             TEXT,
  shipping_address           TEXT,
  shipping_method            TEXT,
  shipping_amount            NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_method             TEXT NOT NULL DEFAULT 'card'
                             CHECK (payment_method IN ('card', 'cash', 'other')),
  payment_status             TEXT NOT NULL DEFAULT 'paid',
  items                      JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal                   NUMERIC(10,2) NOT NULL DEFAULT 0,
  total                      NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency                   TEXT NOT NULL DEFAULT 'GBP',
  notes                      TEXT,
  created_at                 BIGINT NOT NULL,
  updated_at                 BIGINT NOT NULL
);

-- Enforce uniqueness at the database level (not only in JavaScript).
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_order_number_key;
ALTER TABLE orders
  ADD CONSTRAINT orders_order_number_key UNIQUE (order_number);

-- One local order per Stripe Checkout Session: the webhook stays
-- idempotent across Stripe redeliveries even before the event-id
-- guard is consulted.
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_stripe_checkout_session_id_key;
ALTER TABLE orders
  ADD CONSTRAINT orders_stripe_checkout_session_id_key UNIQUE (stripe_checkout_session_id);

-- Manual-order double-submit / retry idempotency.
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_client_request_id_key;
ALTER TABLE orders
  ADD CONSTRAINT orders_client_request_id_key UNIQUE (client_request_id);

CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);
CREATE INDEX IF NOT EXISTS orders_customer_email_idx ON orders (customer_email);
