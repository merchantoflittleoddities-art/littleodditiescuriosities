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

/** Reads the Bearer token from a Netlify Function event's headers */
function getBearerToken(event) {
  const header = event.headers["authorization"] || event.headers["Authorization"] || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Verifies the request's Bearer token and returns the customerId, or null */
function authenticate(event) {
  return verifyToken(getBearerToken(event));
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
  customersStore,
  customerEmailsStore,
  addressesStore,
  wishlistStore,
  resetTokensStore,
  orderStatusStore,
  normaliseEmail
};
