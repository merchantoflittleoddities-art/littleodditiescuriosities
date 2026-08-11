const { Pool } = require("pg");

// G7Cloud PostgreSQL requires TLS. The runtime supplies the database either as
// a single DATABASE_URL or as the conventional separate PG* variables
// (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD/PGSSLMODE=require).
//
// Previous versions keyed SSL off DATABASE_URL alone. When the platform
// provides the separate PG* variables (no DATABASE_URL), ssl was forced to
// false, which overrode PGSSLMODE=require and made every pool.query() fail at
// the TLS handshake with an empty error message - the exact signature seen in
// production (get-inventory fell back to the catalogue, while update-inventory
// and get-order-status surfaced 500). Enable TLS (rejectUnauthorized: false)
// whenever any PostgreSQL source is configured, and only fall back to non-TLS
// for local development where no database is configured at all.
const dbConfigured = [
  process.env.DATABASE_URL,
  process.env.PGHOST,
  process.env.PGPORT,
  process.env.PGDATABASE,
  process.env.PGUSER,
  process.env.PGPASSWORD,
  process.env.PGSSLMODE
].some((value) => value !== undefined && value !== null && String(value).trim() !== "");

const ssl = dbConfigured ? { rejectUnauthorized: false } : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl
});

module.exports = pool;