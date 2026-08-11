const { Pool } = require("pg");

// The G7Cloud PostgreSQL server does not support SSL connections: production
// reports "The server does not support SSL connections" on every query.
// A previous version forced an SSL object unconditionally, which the real
// server rejects. Do NOT force SSL here: omit the explicit `ssl` option so the
// pg driver honours the actual connection settings - the `sslmode` query
// parameter on the connection string, or the PGSSLMODE environment variable
// (both default to no SSL when unset). Local development with no database
// configured is unaffected.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

module.exports = pool;