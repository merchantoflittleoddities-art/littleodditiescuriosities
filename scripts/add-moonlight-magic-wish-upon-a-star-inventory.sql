/* =============================================================
   Little Oddities Curiosities — inventory registration for the
   two new products: moonlight-magic and wish-upon-a-star.

   Run this against the G7Cloud PostgreSQL database (same
   credentials/environment as the other g7cloud_postgres_*.sql
   scripts — do NOT hard-code credentials anywhere).

   Safe to run multiple times: it only inserts a default entry
   for each product if that product does not already have one.
   Existing inventory entries and quantities are untouched.

   Entry shape mirrors defaultInventoryEntry() in
   netlify/functions/get-inventory.js and server.js.
   ============================================================= */

UPDATE inventory_state
SET inventory = jsonb_set(
  inventory,
  '{moonlight-magic}',
  jsonb_build_object(
    'productId', 'moonlight-magic',
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
  AND NOT inventory ? 'moonlight-magic';

UPDATE inventory_state
SET inventory = jsonb_set(
  inventory,
  '{wish-upon-a-star}',
  jsonb_build_object(
    'productId', 'wish-upon-a-star',
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
  AND NOT inventory ? 'wish-upon-a-star';

/* Verification */
SELECT inventory ? 'moonlight-magic'   AS has_moonlight_magic,
       inventory ? 'wish-upon-a-star'  AS has_wish_upon_a_star
FROM inventory_state
WHERE id = 'all';
