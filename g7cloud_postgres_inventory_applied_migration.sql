-- ============================================================
-- Little Oddities: inventory_applied tracking
-- ============================================================
-- Safe to re-run (idempotent). Apply once on the G7Cloud
-- PostgreSQL production database via the existing console flow.
--
-- Design notes:
-- - `order_inventory_tracking` records the quantity actually deducted
--   from stock (`inventory_applied`) per order + product, alongside
--   the ordered quantity (`ordered_quantity`).
-- - This allows edits and deletes to restore exactly what was taken,
--   even when stock was clamped at zero at creation time.
-- - No backfill is performed: historical orders simply have no rows
--   here, and the code treats missing rows as zero applied so no
--   stock is guessed or mutated for pre-tracking orders.
-- ============================================================

CREATE TABLE IF NOT EXISTS order_inventory_tracking (
  order_id           UUID NOT NULL,
  product_id         TEXT NOT NULL,
  ordered_quantity   INTEGER NOT NULL DEFAULT 0,
  inventory_applied  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, product_id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS order_inventory_tracking_product_id_idx
  ON order_inventory_tracking (product_id);
