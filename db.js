const { Pool } = require("pg");

// G7Cloud PostgreSQL requires SSL. ssl: false was previously hardcoded,
// which blocked the SSL handshake and caused all pool.query() calls to
// fail with an empty error message (pg's SSL negotiation failure).
// When DATABASE_URL is set (production / G7Cloud), enable SSL with
// rejectUnauthorized: false to accept managed cloud TLS certificates.
// When DATABASE_URL is absent (local dev without a DB), keep ssl: false.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

module.exports = pool;