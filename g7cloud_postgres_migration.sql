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

CREATE TABLE IF NOT EXISTS merchant_thoughts_state (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);
