/* =============================================================
   Little Oddities Curiosities â€” inventory registration for the
   five new products: starlit-spores, poison, petal-and-potion,
   rose-and-ritual and woodlands-wonderland.

   Run this against the G7Cloud PostgreSQL database (same
   credentials/environment as the other g7cloud_postgres_*.sql
   scripts â€” do NOT hard-code credentials anywhere).

   Safe to run multiple times: it only inserts a default entry
   for each product if that product does not already have one.
   Existing inventory entries and quantities are untouched.

   Entry shape mirrors defaultInventoryEntry() in
   netlify/functions/get-inventory.js and server.js.
   ============================================================= */

UPDATE inventory_state
SET inventory = jsonb_set(
  inventory,
  '{starlit-spores}',
  jsonb_build_object(
    'productId', 'starlit-spores',
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
  AND NOT inventory ? 'starlit-spores';

UPDATE inventory_state
SET inventory = jsonb_set(
  inventory,
  '{poison}',
  jsonb_build_object(
    'productId', 'poison',
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
  AND NOT inventory ? 'poison';

UPDATE inventory_state
SET inventory = jsonb_set(
  inventory,
  '{petal-and-potion}',
  jsonb_build_object(
    'productId', 'petal-and-potion',
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
  AND NOT inventory ? 'petal-and-potion';

UPDATE inventory_state
SET inventory = jsonb_set(
  inventory,
  '{rose-and-ritual}',
  jsonb_build_object(
    'productId', 'rose-and-ritual',
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
  AND NOT inventory ? 'rose-and-ritual';

UPDATE inventory_state
SET inventory = jsonb_set(
  inventory,
  '{woodlands-wonderland}',
  jsonb_build_object(
    'productId', 'woodlands-wonderland',
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
  AND NOT inventory ? 'woodlands-wonderland';

/* Verification */
SELECT inventory ? 'starlit-spores'         AS has_starlit_spores,
       inventory ? 'poison'                 AS has_poison,
       inventory ? 'petal-and-potion'       AS has_petal_and_potion,
       inventory ? 'rose-and-ritual'        AS has_rose_and_ritual,
       inventory ? 'woodlands-wonderland'   AS has_woodlands_wonderland
FROM inventory_state
WHERE id = 'all';
