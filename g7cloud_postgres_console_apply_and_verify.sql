CREATE TABLE IF NOT EXISTS inventory_state (
  id TEXT PRIMARY KEY,
  inventory JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS order_status_records (
  order_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_addresses_state (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  addresses JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS featured_treasure_state (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS desk_entries_state (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);

SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'inventory_state',
    'order_status_records',
    'customer_addresses_state',
    'featured_treasure_state',
    'desk_entries_state'
  )
ORDER BY table_name, ordinal_position;

SELECT tc.table_name, tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
 AND tc.table_name = kcu.table_name
WHERE tc.table_schema = 'public'
  AND tc.table_name IN (
    'inventory_state',
    'order_status_records',
    'customer_addresses_state',
    'featured_treasure_state',
    'desk_entries_state'
  )
ORDER BY tc.table_name, tc.constraint_type, kcu.ordinal_position;

SELECT tc.table_name, tc.constraint_name, kcu.column_name,
       ccu.table_name AS foreign_table_name,
       ccu.column_name AS foreign_column_name,
       rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
 AND tc.table_name = kcu.table_name
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
 AND tc.table_schema = ccu.table_schema
JOIN information_schema.referential_constraints rc
  ON tc.constraint_name = rc.constraint_name
 AND tc.table_schema = rc.constraint_schema
WHERE tc.table_schema = 'public'
  AND tc.table_name IN (
    'inventory_state',
    'order_status_records',
    'customer_addresses_state',
    'featured_treasure_state',
    'desk_entries_state'
  )
  AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.table_name, tc.constraint_name;

SELECT 'inventory_state' AS table_name, COUNT(1)::bigint AS row_count FROM inventory_state
UNION ALL
SELECT 'order_status_records', COUNT(1)::bigint FROM order_status_records
UNION ALL
SELECT 'customer_addresses_state', COUNT(1)::bigint FROM customer_addresses_state
UNION ALL
SELECT 'featured_treasure_state', COUNT(1)::bigint FROM featured_treasure_state
UNION ALL
SELECT 'desk_entries_state', COUNT(1)::bigint FROM desk_entries_state;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'customers'
  AND column_name = 'id';