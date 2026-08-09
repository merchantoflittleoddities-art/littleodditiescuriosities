/* =============================================================
   Little Oddities Curiosities — Netlify Function
   _customer-lib.js

   Shared helpers for customer-account functions:
     - password hashing (scrypt) + verification
     - signed session tokens (same HMAC pattern as dashboard-login.js)
     - Blobs store accessors

   Not itself a Netlify Function (no exports.handler) — required by
   customer-register.js, customer-login.js, customer-profile.js, etc.

   Required Netlify environment variable:
     CUSTOMER_AUTH_SECRET — any long random string used to sign
                            customer session tokens
   ============================================================= */

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; /* 30 days — client decides localStorage vs sessionStorage */

/* ── Passwords ─────────────────────────────────────────────── */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const candidate = crypto.scryptSync(String(password), salt, 64);
    const expected  = Buffer.from(expectedHash, "hex");
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/* ── Session tokens: <customerId>.<timestamp>.<hmac> ────────── */

function createToken(customerId) {
  const secret = process.env.CUSTOMER_AUTH_SECRET;
  const payload = `${customerId}.${Date.now()}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

/** Returns the customerId if the token is valid and unexpired, otherwise null */
function verifyToken(token) {
  const secret = process.env.CUSTOMER_AUTH_SECRET;
  if (!token || !secret) return null;

  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [customerId, timestamp, providedHmac] = parts;

  const payload = `${customerId}.${timestamp}`;
  const expectedHmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  try {
    const a = Buffer.from(providedHmac, "hex");
    const b = Buffer.from(expectedHmac, "hex");
    if (a.length !== 32 || b.length !== 32) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  const age = Date.now() - parseInt(timestamp, 10);
  if (!(age >= 0 && age < TOKEN_LIFETIME_MS)) return null;

  return customerId;
}

function getTokenIssuedAtMs(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const issuedAtMs = parseInt(parts[1], 10);
  return Number.isFinite(issuedAtMs) ? issuedAtMs : null;
}

function cloneCustomerRecord(customer) {
  return JSON.parse(JSON.stringify(customer));
}

function isConditionalWriteConflict(error) {
  return error?.status === 412 || error?.statusCode === 412;
}

/**
 * Safely updates an existing customer record with optimistic concurrency.
 * Reads the latest value + ETag, applies updater, and writes with onlyIfMatch.
 */
async function updateCustomerRecordWithRetry(customerId, updater, options = {}) {
  const maxAttempts = Number.isInteger(options.maxAttempts) ? options.maxAttempts : 5;
  const store = customersStore();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const blob = await store.getWithMetadata(customerId, {
      type: "json",
      consistency: "strong"
    });

    const current = blob?.data || null;
    if (!current) {
      return { ok: false, notFound: true, attempts: attempt };
    }

    const draft = cloneCustomerRecord(current);
    const next = await updater(draft, current, attempt);

    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error("customer-update: updater must return a customer object.");
    }

    const etag = blob?.etag || null;
    const setOptions = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };

    try {
      const write = await store.setJSON(customerId, next, setOptions);
      return {
        ok: true,
        customer: next,
        previous: current,
        attempts: attempt,
        etag: write?.etag || null
      };
    } catch (error) {
      if (isConditionalWriteConflict(error) && attempt < maxAttempts) {
        continue;
      }
      if (isConditionalWriteConflict(error) && attempt >= maxAttempts) {
        const conflictError = new Error("customer-update: conditional write conflicts exceeded retry budget.");
        conflictError.code = "CUSTOMER_WRITE_CONFLICT";
        throw conflictError;
      }
      throw error;
    }
  }

  const conflictError = new Error("customer-update: retry loop exited unexpectedly.");
  conflictError.code = "CUSTOMER_WRITE_CONFLICT";
  throw conflictError;
}

/** Reads the Bearer token from a Netlify Function event's headers */
function getBearerToken(event) {
  const header = event.headers["authorization"] || event.headers["Authorization"] || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Verifies the request's Bearer token and revocation state.
 *
 * Returns:
 *   { ok: true, customerId, customer, tokenIssuedAtMs }
 *   { ok: false, statusCode: 401 } for invalid/expired/revoked tokens
 *   { ok: false, statusCode: 503 } when auth state cannot be verified
 */
async function authenticate(event) {
  const token = getBearerToken(event);
  const customerId = verifyToken(token);

  if (!customerId) {
    return { ok: false, statusCode: 401 };
  }

  const tokenIssuedAtMs = getTokenIssuedAtMs(token);
  if (!Number.isFinite(tokenIssuedAtMs)) {
    return { ok: false, statusCode: 401 };
  }

  let customer;
  try {
    customer = await customersStore().get(customerId, { type: "json" });
  } catch (error) {
    console.error("customer-auth: failed to load customer for authentication:", error.message);
    return { ok: false, statusCode: 503 };
  }

  if (!customer) {
    return { ok: false, statusCode: 401 };
  }

  const cutoff = Number(customer.tokenRevokedAfterMs);
  if (Number.isFinite(cutoff) && cutoff > 0 && tokenIssuedAtMs <= cutoff) {
    return { ok: false, statusCode: 401 };
  }

  return { ok: true, customerId, customer, tokenIssuedAtMs };
}

/* ── Blobs stores ─────────────────────────────────────────── */

/* customers: key = customerId → { id, name, email, passwordHash, salt, notificationPrefs, createdAt } */
function customersStore()      { return getStore("customers"); }
/* customer-emails: key = lowercased email → customerId (uniqueness + login/reset lookup) */
function customerEmailsStore() { return getStore("customer-emails"); }
function addressesStore()      { return getStore("customer-addresses"); }
function wishlistStore()       { return getStore("customer-wishlist"); }
function resetTokensStore()    { return getStore("customer-reset-tokens"); }
function orderStatusStore()    { return getStore("order-status"); }

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  getBearerToken,
  authenticate,
  updateCustomerRecordWithRetry,
  customersStore,
  customerEmailsStore,
  addressesStore,
  wishlistStore,
  resetTokensStore,
  orderStatusStore,
  normaliseEmail
};
