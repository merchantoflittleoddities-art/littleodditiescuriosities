-- ============================================================
-- Little Oddities: soft-delete (archive) for Manual (IRL) orders
-- ============================================================
-- Safe to re-run (idempotent). Apply once on the G7Cloud
-- PostgreSQL production database via the existing console flow.
--
-- Design notes:
-- - Soft delete only: the orders row is retained with deleted_at set,
--   so its LO-### number can never be re-issued (the shared sequence
--   only moves forward, and the legacy-import sync uses MAX(order_
--   number) which still sees retained rows), order_status_records are
--   preserved, and inventory is never touched by deletion.
-- - No backfill is required: NULL means "not deleted".
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS deleted_at BIGINT;

CREATE INDEX IF NOT EXISTS orders_deleted_at_idx ON orders (deleted_at);
