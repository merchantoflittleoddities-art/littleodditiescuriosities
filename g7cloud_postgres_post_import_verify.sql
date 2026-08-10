SELECT 'customers' AS table_name, COUNT(1)::bigint AS row_count FROM customers
UNION ALL
SELECT 'customer_wishlist', COUNT(1)::bigint FROM customer_wishlist
UNION ALL
SELECT 'customer_reset_tokens', COUNT(1)::bigint FROM customer_reset_tokens
UNION ALL
SELECT 'inventory_state' AS table_name, COUNT(1)::bigint AS row_count FROM inventory_state
UNION ALL
SELECT 'order_status_records', COUNT(1)::bigint FROM order_status_records
UNION ALL
SELECT 'customer_addresses_state', COUNT(1)::bigint FROM customer_addresses_state
UNION ALL
SELECT 'featured_treasure_state', COUNT(1)::bigint FROM featured_treasure_state
UNION ALL
SELECT 'desk_entries_state', COUNT(1)::bigint FROM desk_entries_state;

SELECT id, email, role, created_at, token_revoked_after_ms
FROM customers
ORDER BY created_at ASC
LIMIT 20;

SELECT customer_id, product_id
FROM customer_wishlist
ORDER BY customer_id ASC, product_id ASC
LIMIT 20;

SELECT token, customer_id, expires_at
FROM customer_reset_tokens
ORDER BY expires_at DESC
LIMIT 20;

SELECT id, jsonb_object_keys(inventory) AS product_id
FROM inventory_state
WHERE id = 'all'
LIMIT 20;

SELECT order_id, status, updated_at
FROM order_status_records
ORDER BY updated_at DESC
LIMIT 20;

SELECT customer_id, jsonb_array_length(addresses) AS address_count
FROM customer_addresses_state
ORDER BY customer_id ASC
LIMIT 20;

SELECT id, payload
FROM featured_treasure_state
WHERE id = 'data';

SELECT id, payload
FROM desk_entries_state
WHERE id = 'data';
