/* =============================================================
   Little Oddities Curiosities — inventory registration for the
   two new products: lunars-lullaby and celestial-flight.

   Run this against the G7Cloud PostgreSQL database (same
   credentials/environment as the other g7cloud_postgres_*.sql
   scripts — do NOT hard-code credentials anywhere).

   Safe to run multiple times: it only inserts a default entry
   for each product if that product does not already have one.
   Existing inventory entries and quantities are untouched.
   Stock is intentionally NULL — actual quantities are entered
   manually through the Merchant Dashboard.

   Entry shape mirrors defaultInventoryEntry() in
   netlify/functions/get-inventory.js and server.js.
   ============================================================= */

UPDATE inventory_state
SET inventory = jsonb_set(
  inventory,
  '{lunars-lullaby}',
  jsonb_build_object(
    'productId', 'lunars-lullaby',
    'stock', NULL,
    'lowStockThreshold', 3,
    'available', true,
    'availableStorefrontMessage', 'shelves',
    'unavailableStorefrontMessage', 'roaming',
    'outOfStockMessage', 'roaming',
    'lastUpdated', (extract(epoch FROM now()) * 1000)::bigint
  ),
  true
)
WHERE id = 'all'
  AND NOT inventory ? 'lunars-lullaby';

UPDATE inventory_state
SET inventory = jsonb_set(
  inventory,
  '{celestial-flight}',
  jsonb_build_object(
    'productId', 'celestial-flight',
    'stock', NULL,
    'lowStockThreshold', 3,
    'available', true,
    'availableStorefrontMessage', 'shelves',
    'unavailableStorefrontMessage', 'roaming',
    'outOfStockMessage', 'roaming',
    'lastUpdated', (extract(epoch FROM now()) * 1000)::bigint
  ),
  true
)
WHERE id = 'all'
  AND NOT inventory ? 'celestial-flight';

/* Verification */
SELECT inventory ? 'lunars-lullaby'   AS has_lunars_lullaby,
       inventory ? 'celestial-flight' AS has_celestial_flight
FROM inventory_state
WHERE id = 'all';