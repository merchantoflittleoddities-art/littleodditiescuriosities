const http = require("http");
const fs = require("fs");
const path = require("path");
const pool = require("./db");
const crypto = require("crypto");
let stripeClient = null;
const {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  getBearerToken,
  normaliseEmail
} = require("./netlify/functions/_customer-lib");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

function getStripeClient() {
  const key = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) {
    return null;
  }

  if (!stripeClient) {
    stripeClient = require("stripe")(key);
  }

  return stripeClient;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

const PRIVATE_API_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate, s-maxage=0",
  "CDN-Cache-Control": "no-store",
  "Surrogate-Control": "no-store",
  "Pragma": "no-cache",
  "Expires": "0",
  "Vary": "Authorization, Cookie"
};

// The merchant dashboard contains authenticated UI state and must not remain
// stale behind the platform's long-lived static-asset cache after a deploy.
const MERCHANT_DASHBOARD_NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
  "CDN-Cache-Control": "no-store",
  "Surrogate-Control": "no-store",
  "Pragma": "no-cache",
  "Expires": "0"
};

const LOGOUT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const STRIPE_WEBHOOK_MAX_CONFLICT_RETRIES = 5;
const STRIPE_WEBHOOK_BASE_RETRY_DELAY_MS = 25;
const STRIPE_WEBHOOK_JITTER_RETRY_DELAY_MS = 30;

function sendPrivateApiJson(res, statusCode, payload) {
  sendJson(res, statusCode, payload, PRIVATE_API_NO_STORE_HEADERS);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextWebhookRetryDelay(attempt) {
  const exponential = STRIPE_WEBHOOK_BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * STRIPE_WEBHOOK_JITTER_RETRY_DELAY_MS);
  return exponential + jitter;
}

async function readRequestBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

function isDuplicateEmailError(error) {
  return error?.code === "23505" && (
    error?.constraint === "customers_email_key" ||
    String(error?.detail || "").includes("(email)=(")
  );
}

function isProfileWriteStateError(error) {
  return error?.code === "40001" || error?.code === "40P01";
}

const RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const FORGOT_PASSWORD_INTERNAL_ERROR = "Something went wrong. Please try again.";
const RESET_PASSWORD_INTERNAL_ERROR = "Reset failed.";

const DASHBOARD_TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;
const ORDER_STATUS_VALUES = ["new", "preparing", "packed", "posted", "completed"];
const ORDER_STATUS_COPY = {
  new: "The Merchant has received your request.",
  preparing: "The Merchant is busy crafting your oddities.",
  packed: "Relics Awaiting Delivery.",
  posted: "Roaming the Land.",
  completed: "Your curiosities have reached their keeper."
};

const FREE_SHIPPING_THRESHOLD_PENCE = 3000;
const MAX_QUANTITY_PER_ITEM = 99;
const MAX_TOTAL_QUANTITY = 99;
const SHIPPING_OPTIONS = {
  "royal-courier": {
    id: "royal-courier",
    name: "Royal Courier",
    pricePence: 299
  },
  "royal-courier-tracked": {
    id: "royal-courier-tracked",
    name: "Royal Courier Tracked",
    pricePence: 399
  },
  "free-journey": {
    id: "free-journey",
    name: "Free Journey",
    pricePence: 0
  }
};

const DATA_ROOT = path.join(__dirname, "data");

function readJsonFile(fileName, fallback) {
  try {
    const filePath = path.join(DATA_ROOT, fileName);
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function asArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.products)) return value.products;
  if (value && Array.isArray(value.tiers)) return value.tiers;
  return fallback;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeOrigin(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry ? String(entry[1] || "") : "";
}

function getAllowedRedirectOrigins() {
  const sources = [
    process.env.CHECKOUT_ALLOWED_ORIGINS,
    process.env.CUSTOM_DOMAIN_URL,
    process.env.URL
  ];

  return [...new Set(
    sources
      .filter(Boolean)
      .flatMap((value) => String(value).split(","))
      .map((value) => normalizeOrigin(value))
      .filter(Boolean)
  )];
}

function getRedirectOrigin(req) {
  const allowedOrigins = getAllowedRedirectOrigins();
  const requestOrigin = normalizeOrigin(getHeader(req.headers, "origin"))
    || normalizeOrigin(getHeader(req.headers, "referer"));

  if (!allowedOrigins.length) {
    if (requestOrigin) {
      return requestOrigin;
    }

    const host = getHeader(req.headers, "x-forwarded-host") || getHeader(req.headers, "host");
    const proto = getHeader(req.headers, "x-forwarded-proto") || "https";
    return host ? normalizeOrigin(`${proto}://${host}`) : null;
  }

  if (!requestOrigin) {
    return allowedOrigins[0];
  }

  if (!allowedOrigins.includes(requestOrigin)) {
    return null;
  }

  return requestOrigin;
}

function buildLookupMaps(items, keyFields) {
  return items.reduce((maps, item) => {
    keyFields.forEach((field) => {
      const key = item && item[field] ? String(item[field]).trim() : "";
      if (key && !maps.has(key)) {
        maps.set(key, item);
      }
    });
    return maps;
  }, new Map());
}

function getProductPrice(product, tierById, tierByName) {
  const tierKey = product && product.tier ? String(product.tier).trim() : "";
  const tierMeta = tierById.get(tierKey) || tierByName.get(tierKey);
  const tierPrice = tierMeta ? toFiniteNumber(tierMeta.price) : null;
  if (tierPrice !== null) return tierPrice;

  const productPrice = product ? toFiniteNumber(product.price) : null;
  return productPrice;
}

function normalizeRequestedItems(lineItems) {
  const requestedItems = [];
  const quantitiesByProductId = new Map();
  let totalQuantity = 0;

  for (const item of lineItems) {
    const productId = item && typeof item.productId === "string"
      ? item.productId.trim()
      : item && typeof item.id === "string"
        ? item.id.trim()
        : "";

    if (!productId) {
      return { error: "Each cart item must include a valid product ID." };
    }

    const quantity = Number(item && item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { error: "Each cart item must use a positive whole-number quantity." };
    }

    if (quantity > MAX_QUANTITY_PER_ITEM) {
      return { error: `Quantity for a single item cannot exceed ${MAX_QUANTITY_PER_ITEM}.` };
    }

    totalQuantity += quantity;
    if (totalQuantity > MAX_TOTAL_QUANTITY) {
      return { error: `The cart cannot contain more than ${MAX_TOTAL_QUANTITY} items in total.` };
    }

    const nextQuantity = (quantitiesByProductId.get(productId) || 0) + quantity;
    if (nextQuantity > MAX_QUANTITY_PER_ITEM) {
      return { error: `Quantity for a single item cannot exceed ${MAX_QUANTITY_PER_ITEM}.` };
    }

    quantitiesByProductId.set(productId, nextQuantity);
  }

  quantitiesByProductId.forEach((quantity, productId) => {
    requestedItems.push({ productId, quantity });
  });

  return { items: requestedItems };
}

const catalogueData = readJsonFile("catalogue.json", { products: [] });
const tiersData = readJsonFile("tiers.json", { tiers: [] });
const products = asArray(catalogueData, []);
const tiers = asArray(tiersData, []);
const productsById = buildLookupMaps(products, ["id"]);
const tiersById = buildLookupMaps(tiers, ["id"]);
const tiersByName = buildLookupMaps(tiers, ["name"]);

function getDashboardBearerToken(req) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"] || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
}

function getRuntimeEnvValue(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "";
}

function getDashboardPassword() {
  return getRuntimeEnvValue([
    "DASHBOARD_PASSWORD",
    "MERCHANT_DASHBOARD_PASSWORD",
    "G7CLOUD_DASHBOARD_PASSWORD",
    "DASHBOARD_KEY",
    "MERCHANT_KEY",
    "G7CLOUD_MERCHANT_KEY",
    "MERCHANT_SETUP_KEY"
  ]);
}

function getDashboardSecret() {
  return getRuntimeEnvValue([
    "DASHBOARD_SECRET",
    "MERCHANT_DASHBOARD_SECRET",
    "G7CLOUD_DASHBOARD_SECRET",
    "DASHBOARD_SIGNING_SECRET",
    "MERCHANT_DASHBOARD_SIGNING_SECRET",
    "G7CLOUD_DASHBOARD_SIGNING_SECRET",
    "DASHBOARD_PASSWORD",
    "MERCHANT_DASHBOARD_PASSWORD",
    "G7CLOUD_DASHBOARD_PASSWORD",
    "MERCHANT_SETUP_KEY"
  ]);
}

function verifyDashboardToken(token) {
  const secret = getDashboardSecret();
  if (!token || !secret) return false;

  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const providedHmac = token.substring(dotIndex + 1);
  const expectedHmac = crypto.createHmac("sha256", secret).update(timestamp).digest("hex");

  try {
    const a = Buffer.from(providedHmac, "hex");
    const b = Buffer.from(expectedHmac, "hex");
    if (a.length !== 32 || b.length !== 32) return false;
    if (!crypto.timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }

  const age = Date.now() - parseInt(timestamp, 10);
  return age >= 0 && age < DASHBOARD_TOKEN_LIFETIME_MS;
}

function defaultInventoryEntry(productId) {
  return {
    productId,
    stock: null,
    lowStockThreshold: 3,
    available: true,
    availableStorefrontMessage: "shelves",
    unavailableStorefrontMessage: "roaming",
    lastUpdated: Date.now()
  };
}

function parseStoredJsonObject(value, fallback) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fallback;
  }

  return value;
}

function normalizeInventoryEntry(productId, entry) {
  const source = parseStoredJsonObject(entry, {});
  const normalized = {
    ...defaultInventoryEntry(productId),
    ...source,
    productId: source.productId || productId,
    lowStockThreshold: Math.max(0, Number(source.lowStockThreshold ?? 3) || 0),
    available: source.available !== false,
    lastUpdated: Number.isFinite(Number(source.lastUpdated)) ? Number(source.lastUpdated) : Date.now()
  };

  if (source.stock === null) {
    normalized.stock = null;
  } else {
    const stock = Number(source.stock);
    normalized.stock = Number.isFinite(stock) ? Math.max(0, stock) : null;
  }

  normalized.availableStorefrontMessage = String(
    source.availableStorefrontMessage ||
    source.availableMessage ||
    "shelves"
  );

  normalized.unavailableStorefrontMessage = String(
    source.unavailableStorefrontMessage ||
    source.unavailableMessage ||
    source.outOfStockMessage ||
    "roaming"
  );

  normalized.outOfStockMessage = normalized.unavailableStorefrontMessage;

  delete normalized.storefrontMessage;
  delete normalized.availableMessage;
  delete normalized.unavailableMessage;

  return normalized;
}

function normalizeInventoryDocument(value) {
  const source = parseStoredJsonObject(value, {});
  const normalized = {};

  Object.entries(source).forEach(([productId, entry]) => {
    normalized[productId] = normalizeInventoryEntry(productId, entry);
  });

  return normalized;
}

function getTokenIssuedAtMs(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;

  const issuedAtMs = parseInt(parts[1], 10);
  return Number.isFinite(issuedAtMs) ? issuedAtMs : null;
}

function toProfileCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role || "traveller",
    notificationPrefs: row.notification_prefs || { orderUpdates: true }
  };
}

async function authenticateProfileRequest(req) {
  const token = getBearerToken({ headers: req.headers || {} });
  const customerId = verifyToken(token);

  if (!customerId) {
    return { ok: false, statusCode: 401 };
  }

  const tokenIssuedAtMs = getTokenIssuedAtMs(token);
  if (!Number.isFinite(tokenIssuedAtMs)) {
    return { ok: false, statusCode: 401 };
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, role, notification_prefs, token_revoked_after_ms
      FROM customers
      WHERE id = $1
      LIMIT 1`,
      [customerId]
    );

    const customer = result.rows[0] || null;
    if (!customer) {
      return { ok: false, statusCode: 401 };
    }

    const cutoff = Number(customer.token_revoked_after_ms);
    if (Number.isFinite(cutoff) && cutoff > 0 && tokenIssuedAtMs <= cutoff) {
      return { ok: false, statusCode: 401 };
    }

    return { ok: true, customerId, tokenIssuedAtMs, customer };
  } catch (error) {
    console.error("customer-profile: failed to load customer during authentication:", error);
    return { ok: false, statusCode: 503 };
  }
}

async function loadCustomerWishlistProductIds(customerId) {
  const result = await pool.query(
    `SELECT product_id
    FROM customer_wishlist
    WHERE customer_id = $1
    ORDER BY created_at ASC, product_id ASC`,
    [customerId]
  );

  return result.rows.map((row) => row.product_id);
}

async function handleCustomerProfile(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendPrivateApiJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const auth = await authenticateProfileRequest(req);
  if (!auth.ok) {
    if (auth.statusCode === 503) {
      sendPrivateApiJson(res, 503, {
        error: "Authentication state could not be verified. Please try again."
      });
      return;
    }

    sendPrivateApiJson(res, 401, { error: "Please sign in again." });
    return;
  }

  if (req.method === "GET") {
    sendPrivateApiJson(res, 200, { customer: toProfileCustomer(auth.customer) });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const { name, email, password, notificationPrefs } = body;

  let nextName = null;
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) {
      sendPrivateApiJson(res, 400, { error: "Traveller Name cannot be empty." });
      return;
    }
    nextName = trimmed;
  }

  let nextEmail = null;
  if (email !== undefined) {
    nextEmail = normaliseEmail(email);
    if (!nextEmail) {
      sendPrivateApiJson(res, 400, { error: "Please provide a valid email address." });
      return;
    }
  }

  let nextHash = null;
  let nextSalt = null;
  if (password !== undefined) {
    if (String(password).length < 8) {
      sendPrivateApiJson(res, 400, { error: "Traveller password must be at least 8 characters." });
      return;
    }

    const passwordUpdate = hashPassword(password);
    nextHash = passwordUpdate.hash;
    nextSalt = passwordUpdate.salt;
  }

  let notificationPrefsPatch = null;
  if (notificationPrefs !== undefined && typeof notificationPrefs === "object") {
    notificationPrefsPatch = { ...(notificationPrefs || {}) };
  }

  const shouldMergeNotificationPrefs = notificationPrefsPatch !== null;

  try {
    const update = await pool.query(
      `UPDATE customers
      SET
        name = COALESCE($2, name),
        email = COALESCE($3, email),
        password_hash = COALESCE($4, password_hash),
        salt = COALESCE($5, salt),
        notification_prefs = CASE
          WHEN $6::boolean
            THEN COALESCE(notification_prefs, '{}'::jsonb) || $7::jsonb
          ELSE notification_prefs
        END
      WHERE id = $1
      RETURNING id, name, email, role, notification_prefs`,
      [
        auth.customerId,
        nextName,
        nextEmail,
        nextHash,
        nextSalt,
        shouldMergeNotificationPrefs,
        JSON.stringify(notificationPrefsPatch || {})
      ]
    );

    const updatedCustomer = update.rows[0] || null;
    if (!updatedCustomer) {
      sendPrivateApiJson(res, 404, { error: "That Traveller could no longer be found." });
      return;
    }

    sendPrivateApiJson(res, 200, { customer: toProfileCustomer(updatedCustomer) });
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      sendPrivateApiJson(res, 409, {
        error: "Another Traveller already uses that email address."
      });
      return;
    }

    if (isProfileWriteStateError(error)) {
      sendPrivateApiJson(res, 503, {
        error: "Your Preferences could not be saved right now. Please try again."
      });
      return;
    }

    console.error("customer-profile: failed to update customer:", error);
    sendPrivateApiJson(res, 500, {
      error: "Something went wrong. Please try again."
    });
  }
}

async function handleCustomerWishlist(req, res) {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
    sendPrivateApiJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const auth = await authenticateProfileRequest(req);
  if (!auth.ok) {
    if (auth.statusCode === 503) {
      sendPrivateApiJson(res, 503, {
        error: "Authentication state could not be verified. Please try again."
      });
      return;
    }

    sendPrivateApiJson(res, 401, { error: "Please sign in again." });
    return;
  }

  if (req.method === "GET") {
    const productIds = await loadCustomerWishlistProductIds(auth.customerId);
    sendPrivateApiJson(res, 200, { productIds });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const { productId } = body;
  if (!productId) {
    sendPrivateApiJson(res, 400, { error: "A productId is required." });
    return;
  }

  if (req.method === "POST") {
    await pool.query(
      `INSERT INTO customer_wishlist (customer_id, product_id)
      VALUES ($1, $2)
      ON CONFLICT (customer_id, product_id) DO NOTHING`,
      [auth.customerId, productId]
    );
  } else {
    await pool.query(
      `DELETE FROM customer_wishlist
      WHERE customer_id = $1 AND product_id = $2`,
      [auth.customerId, productId]
    );
  }

  const productIds = await loadCustomerWishlistProductIds(auth.customerId);
  sendPrivateApiJson(res, 200, { productIds });
}

async function handleCustomerLogout(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, LOGOUT_CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." }, {
      ...PRIVATE_API_NO_STORE_HEADERS,
      ...LOGOUT_CORS_HEADERS
    });
    return;
  }

  const auth = await authenticateProfileRequest(req);
  if (!auth.ok) {
    if (auth.statusCode === 503) {
      sendJson(res, 503, {
        error: "Authentication state could not be verified. Please try again."
      }, {
        ...PRIVATE_API_NO_STORE_HEADERS,
        ...LOGOUT_CORS_HEADERS
      });
      return;
    }

    sendJson(res, 401, { error: "Please sign in again." }, {
      ...PRIVATE_API_NO_STORE_HEADERS,
      ...LOGOUT_CORS_HEADERS
    });
    return;
  }

  const now = Date.now();

  try {
    const update = await pool.query(
      `UPDATE customers
      SET token_revoked_after_ms = GREATEST(COALESCE(token_revoked_after_ms, 0), $2)
      WHERE id = $1
      RETURNING id`,
      [auth.customerId, now]
    );

    if (!update.rows[0]) {
      sendJson(res, 401, { error: "Please sign in again." }, {
        ...PRIVATE_API_NO_STORE_HEADERS,
        ...LOGOUT_CORS_HEADERS
      });
      return;
    }

    sendJson(res, 200, { ok: true }, {
      ...PRIVATE_API_NO_STORE_HEADERS,
      ...LOGOUT_CORS_HEADERS
    });
  } catch (error) {
    console.error("customer-logout: failed to persist token revocation:", error);
    sendJson(res, 503, {
      error: "Could not persist logout state. Please try again."
    }, {
      ...PRIVATE_API_NO_STORE_HEADERS,
      ...LOGOUT_CORS_HEADERS
    });
  }
}

/* ──────────────────────────────────────────────────────────────────
   customer-delete-account
   Allows an authenticated Traveller to permanently delete their own
   account and all associated personal data (GDPR right to erasure).

   Customer identity is derived from the signed Bearer token only —
   the request body is never trusted for identity.  Merchant accounts
   are explicitly refused (403).
   ────────────────────────────────────────────────────────────────── */
async function handleCustomerDeleteAccount(req, res) {
  if (req.method !== "POST") {
    sendPrivateApiJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const auth = await authenticateProfileRequest(req);
  if (!auth.ok) {
    if (auth.statusCode === 503) {
      sendPrivateApiJson(res, 503, {
        error: "Authentication state could not be verified. Please try again."
      });
      return;
    }

    sendPrivateApiJson(res, 401, { error: "Please sign in again." });
    return;
  }

  const customer = auth.customer;
  const customerId = auth.customerId;

  // Prevent Merchant account deletion through the Traveller flow
  if (customer.role === "merchant") {
    sendPrivateApiJson(res, 403, {
      error: "Merchant accounts cannot be deleted through this endpoint."
    });
    return;
  }

  // Require deliberate confirmation from the request body
  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request." });
    return;
  }

  let body;
  try {
    body = JSON.parse(bodyText || "{}");
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request body." });
    return;
  }

  if (body.confirm !== true) {
    sendPrivateApiJson(res, 400, {
      error: "Account deletion must be confirmed."
    });
    return;
  }

  // Delete all customer-linked data inside a transaction so partial
  // failure rolls back cleanly.  The customer record itself is deleted
  // last — once it is gone, authenticateProfileRequest() returns 401,
  // which invalidates every existing session token.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Disposable customer data
    await client.query(
      `DELETE FROM customer_reset_tokens WHERE customer_id = $1`,
      [customerId]
    );
    await client.query(
      `DELETE FROM customer_addresses_state WHERE customer_id = $1`,
      [customerId]
    );
    await client.query(
      `DELETE FROM customer_wishlist WHERE customer_id = $1`,
      [customerId]
    );

    // The customer record — critical step that invalidates all sessions
    await client.query(
      `DELETE FROM customers WHERE id = $1`,
      [customerId]
    );

    await client.query("COMMIT");

    sendPrivateApiJson(res, 200, { ok: true });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors so the original failure is reported.
    }
    console.error("customer-delete-account: failed to delete account:", error);
    sendPrivateApiJson(res, 500, {
      error: "Could not delete account right now. Please try again."
    });
  } finally {
    client.release();
  }
}

async function handleDashboardLogin(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request." });
    return;
  }

  let password;
  try {
    ({ password } = JSON.parse(bodyText || "{}"));
  } catch {
    sendJson(res, 400, { error: "Invalid request." });
    return;
  }

  const correctPassword = getDashboardPassword();
  const secret = getDashboardSecret();

  if (!correctPassword || !secret) {
    console.error("dashboard-login: dashboard credentials are not configured in the runtime environment.");
    sendJson(res, 500, {
      error: "Dashboard is not yet configured. Please set dashboard credentials in the runtime environment."
    });
    return;
  }

  let passwordMatch = false;
  try {
    const inputBuf = Buffer.from(String(password || ""));
    const correctBuf = Buffer.from(String(correctPassword));
    if (inputBuf.length === correctBuf.length) {
      passwordMatch = crypto.timingSafeEqual(inputBuf, correctBuf);
    }
  } catch {
    passwordMatch = false;
  }

  if (!passwordMatch) {
    sendJson(res, 401, { error: "Incorrect key. The ledger remains closed." });
    return;
  }

  const timestamp = Date.now().toString();
  const hmac = crypto.createHmac("sha256", secret).update(timestamp).digest("hex");

  sendJson(res, 200, { token: `${timestamp}.${hmac}` });
}

async function loadInventoryDocument(client = pool) {
  const result = await client.query(
    `SELECT inventory
    FROM inventory_state
    WHERE id = 'all'
    LIMIT 1`
  );

  return normalizeInventoryDocument(result.rows[0]?.inventory || {});
}

async function handleGetInventory(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const inventory = await loadInventoryDocument(pool);

    sendJson(res, 200, { inventory }, {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
  } catch (error) {
    // Log the full error — not just error.message, which is "" for SSL
    // connection failures and gives no diagnostic information.
    console.error("get-inventory error:", error);

    // Graceful fallback: derive a default inventory from the in-memory
    // catalogue so the customer-facing site remains usable when the DB is
    // temporarily unreachable.  All products appear available with no
    // stock limit, which is the safe default the original Netlify Blobs
    // version also used when no inventory had been saved yet.
    // This mirrors the fallback pattern in handleGetFeaturedTreasure /
    // handleGetDeskEntries.
    try {
      const fallbackInventory = {};
      products.forEach((product) => {
        if (product && product.id) {
          fallbackInventory[product.id] = defaultInventoryEntry(product.id);
        }
      });
      sendJson(res, 200, { inventory: fallbackInventory }, {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });
    } catch (fallbackError) {
      console.error("get-inventory fallback error:", fallbackError);
      sendJson(res, 503, {
        error: "Inventory could not be verified. Please try again shortly."
      }, {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });
    }
  }
}

async function handleUpdateInventory(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const token = getDashboardBearerToken(req);
  if (!verifyDashboardToken(token)) {
    sendJson(res, 401, { error: "Unauthorised." });
    return;
  }

  let action;
  let productId;
  let value;
  try {
    ({ action, productId, value } = JSON.parse(await readRequestBody(req) || "{}"));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  if (!action) {
    sendJson(res, 400, { error: "action is required." });
    return;
  }

  try {
    // Read the current inventory directly through the pool. This mirrors the
    // proven-working GET path (pool.query) rather than a dedicated client with
    // a manual transaction (pool.connect + BEGIN/FOR UPDATE/COMMIT), which
    // fails on the G7Cloud managed PostgreSQL connection pooler while
    // pool.query() succeeds.
    const current = await pool.query(
      `SELECT inventory
      FROM inventory_state
      WHERE id = 'all'
      LIMIT 1`
    );

    const inventory = normalizeInventoryDocument(current.rows[0]?.inventory || {});

    if (action === "bulkRestock") {
      const amount = Math.max(0, Number(value) || 0);
      Object.keys(inventory).forEach((id) => {
        const entry = inventory[id];
        entry.stock = entry.stock === null ? amount : Math.max(0, entry.stock + amount);
        entry.lastUpdated = Date.now();
      });
    } else {
      if (!productId) {
        sendJson(res, 400, { error: "productId is required." });
        return;
      }

      if (!inventory[productId]) {
        inventory[productId] = defaultInventoryEntry(productId);
      }

      const entry = inventory[productId];
      switch (action) {
        case "setStock":
          entry.stock = value === null ? null : Math.max(0, Number(value) || 0);
          break;
        case "adjustStock":
          if (entry.stock === null) {
            entry.stock = Math.max(0, Number(value) || 0);
          } else {
            entry.stock = Math.max(0, entry.stock + (Number(value) || 0));
          }
          break;
        case "setThreshold":
          entry.lowStockThreshold = Math.max(0, Number(value) || 0);
          break;
        case "setAvailable":
          entry.available = Boolean(value);
          break;
        case "setMessage":
          if (typeof value === "object" && value !== null) {
            if (value.availableStorefrontMessage) {
              entry.availableStorefrontMessage = String(value.availableStorefrontMessage);
            }
            if (value.unavailableStorefrontMessage) {
              entry.unavailableStorefrontMessage = String(value.unavailableStorefrontMessage);
            }
          } else {
            entry.availableStorefrontMessage = String(value || "shelves");
          }
          delete entry.storefrontMessage;
          delete entry.outOfStockMessage;
          delete entry.availableMessage;
          delete entry.unavailableMessage;
          break;
        default:
          sendJson(res, 400, { error: `Unknown action: ${action}` });
          return;
      }

      entry.lastUpdated = Date.now();
    }

    // Persist the full updated inventory document with a single UPSERT through
    // the pool. This is the same pattern used successfully by
    // handleUpdateFeaturedTreasure / handleUpdateDeskEntries and genuinely
    // writes the change to PostgreSQL.
    await pool.query(
      `INSERT INTO inventory_state (id, inventory)
      VALUES ('all', $1::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET inventory = EXCLUDED.inventory`,
      [JSON.stringify(inventory)]
    );

    sendJson(res, 200, { ok: true, inventory });
  } catch (error) {
    // Log the full error object — not just error.message, which is "" for
    // SSL/connection failures and gives no diagnostic information (same
    // approach as handleGetInventory).
    console.error("update-inventory error:", error);
    sendJson(res, 500, { error: "The Merchant's Supplies could not be updated." });
  }
}

async function handleGetOrderStatus(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const token = getDashboardBearerToken(req);
  if (!verifyDashboardToken(token)) {
    sendJson(res, 401, { error: "Unauthorised." });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT order_id, status, updated_at
      FROM order_status_records`
    );

    const statuses = {};
    result.rows.forEach((row) => {
      statuses[row.order_id] = {
        status: row.status,
        updatedAt: Number(row.updated_at)
      };
    });

    sendPrivateApiJson(res, 200, { statuses });
  } catch (error) {
    console.error("get-order-status error:", error.message);
    sendPrivateApiJson(res, 500, { error: "Order status could not be retrieved." });
  }
}

async function handleUpdateOrderStatus(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const token = getDashboardBearerToken(req);
  if (!verifyDashboardToken(token)) {
    sendJson(res, 401, { error: "Unauthorised." });
    return;
  }

  let orderId;
  let status;
  try {
    ({ orderId, status } = JSON.parse(await readRequestBody(req) || "{}"));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  if (!orderId || !ORDER_STATUS_VALUES.includes(status)) {
    sendJson(res, 400, { error: "A valid orderId and status are required." });
    return;
  }

  const record = { status, updatedAt: Date.now() };

  try {
    await pool.query(
      `INSERT INTO order_status_records (order_id, status, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (order_id)
      DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [orderId, status, record.updatedAt]
    );

    sendPrivateApiJson(res, 200, { ok: true, status: record });
  } catch (error) {
    console.error("update-order-status error:", error.message);
    sendPrivateApiJson(res, 500, { error: "Order status could not be updated." });
  }
}

async function loadCustomerAddresses(customerId) {
  const result = await pool.query(
    `SELECT addresses
    FROM customer_addresses_state
    WHERE customer_id = $1
    LIMIT 1`,
    [customerId]
  );

  const addresses = result.rows[0]?.addresses || [];
  return Array.isArray(addresses) ? addresses : [];
}

async function writeCustomerAddresses(customerId, addresses) {
  await pool.query(
    `INSERT INTO customer_addresses_state (customer_id, addresses)
    VALUES ($1, $2::jsonb)
    ON CONFLICT (customer_id)
    DO UPDATE SET addresses = EXCLUDED.addresses`,
    [customerId, JSON.stringify(addresses)]
  );
}

async function handleCustomerAddresses(req, res) {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
    sendPrivateApiJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const auth = await authenticateProfileRequest(req);
  if (!auth.ok) {
    if (auth.statusCode === 503) {
      sendPrivateApiJson(res, 503, {
        error: "Authentication state could not be verified. Please try again."
      });
      return;
    }

    sendPrivateApiJson(res, 401, { error: "Please sign in again." });
    return;
  }

  if (req.method === "GET") {
    const addresses = await loadCustomerAddresses(auth.customerId);
    sendPrivateApiJson(res, 200, { addresses });
    return;
  }

  if (req.method === "POST") {
    let body;
    try {
      body = JSON.parse(await readRequestBody(req));
    } catch {
      sendPrivateApiJson(res, 400, { error: "Invalid request body." });
      return;
    }

    const { id, address } = body;
    if (!address || !address.line1 || !address.city || !address.postcode || !address.country) {
      sendPrivateApiJson(res, 400, {
        error: "A Landmark needs at least an address line, city, postcode, and country."
      });
      return;
    }

    const addresses = await loadCustomerAddresses(auth.customerId);
    const record = {
      id: id || crypto.randomUUID(),
      label: String(address.label || "").trim() || "Landmark",
      line1: String(address.line1).trim(),
      line2: String(address.line2 || "").trim(),
      city: String(address.city).trim(),
      region: String(address.region || "").trim(),
      postcode: String(address.postcode).trim(),
      country: String(address.country).trim(),
      isDefault: Boolean(address.isDefault)
    };

    if (record.isDefault) {
      addresses.forEach((a) => {
        a.isDefault = false;
      });
    }

    const existingIndex = addresses.findIndex((a) => a.id === record.id);
    if (existingIndex >= 0) {
      addresses[existingIndex] = record;
    } else {
      addresses.push(record);
    }

    await writeCustomerAddresses(auth.customerId, addresses);
    sendPrivateApiJson(res, 200, { addresses });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readRequestBody(req));
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const { id } = body;
  if (!id) {
    sendPrivateApiJson(res, 400, { error: "A Landmark id is required." });
    return;
  }

  const addresses = (await loadCustomerAddresses(auth.customerId)).filter((a) => a.id !== id);
  await writeCustomerAddresses(auth.customerId, addresses);
  sendPrivateApiJson(res, 200, { addresses });
}

async function handleCreateCheckoutSession(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let lineItems;
  let shippingMethod;
  try {
    ({ lineItems, shippingMethod } = JSON.parse(await readRequestBody(req)));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    sendJson(res, 400, { error: "Cart is empty." });
    return;
  }

  const normalized = normalizeRequestedItems(lineItems);
  if (normalized.error) {
    sendJson(res, 400, { error: normalized.error });
    return;
  }

  const resolvedItems = [];
  let subtotalPence = 0;

  for (const item of normalized.items) {
    const product = productsById.get(item.productId);
    if (!product) {
      sendJson(res, 400, { error: `Unknown product ID: ${item.productId}` });
      return;
    }

    const unitPrice = getProductPrice(product, tiersById, tiersByName);
    if (unitPrice === null || unitPrice <= 0) {
      sendJson(res, 400, { error: `Product pricing is unavailable for ${item.productId}.` });
      return;
    }

    const unitAmountPence = Math.round(unitPrice * 100);
    subtotalPence += unitAmountPence * item.quantity;

    resolvedItems.push({
      productId: item.productId,
      name: typeof product.name === "string" && product.name.trim() ? product.name.trim() : item.productId,
      quantity: item.quantity,
      unitAmountPence,
      unitPrice
    });
  }

  const subtotal = subtotalPence / 100;
  const shippingOption = subtotalPence >= FREE_SHIPPING_THRESHOLD_PENCE
    ? SHIPPING_OPTIONS["free-journey"]
    : SHIPPING_OPTIONS[shippingMethod];

  if (!shippingOption || (subtotalPence < FREE_SHIPPING_THRESHOLD_PENCE && shippingOption.id === "free-journey")) {
    sendJson(res, 400, { error: "Please choose a valid shipping option." });
    return;
  }

  const shippingCostPence = shippingOption.pricePence;
  const finalTotalPence = subtotalPence + shippingCostPence;
  const redirectOrigin = getRedirectOrigin(req);
  if (!redirectOrigin) {
    sendJson(res, 500, { error: "Checkout redirect origin is not configured." });
    return;
  }

  const stripe = getStripeClient();
  if (!stripe) {
    sendJson(res, 500, { error: "Stripe is not configured. Missing STRIPE_SECRET_KEY." });
    return;
  }

  try {
    const inventory = await loadInventoryDocument(pool);
    const stockErrors = [];
    for (const item of resolvedItems) {
      const entry = inventory[item.productId];
      if (!entry) continue;
      if (entry.available === false) {
        stockErrors.push({ productId: item.productId, name: item.name, reason: "unavailable" });
        continue;
      }
      const stock = Number(entry.stock);
      if (Number.isFinite(stock) && stock < item.quantity) {
        stockErrors.push({ productId: item.productId, name: item.name, reason: "insufficient", available: stock });
      }
    }

    if (stockErrors.length) {
      const message = stockErrors
        .map((e) => e.reason === "unavailable" ? `${e.name} is currently unavailable.` : `Only ${e.available} of ${e.name} remain.`)
        .join(" ");
      sendJson(res, 400, { error: message });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        ...resolvedItems.map((item) => ({
          price_data: {
            currency: "gbp",
            product_data: {
              name: item.name
            },
            unit_amount: item.unitAmountPence
          },
          quantity: item.quantity
        })),
        ...(shippingCostPence > 0
          ? [{
              price_data: {
                currency: "gbp",
                product_data: {
                  name: shippingOption.name
                },
                unit_amount: shippingCostPence
              },
              quantity: 1
            }]
          : [])
      ],
      mode: "payment",
      success_url: `${redirectOrigin}/success.html`,
      cancel_url: `${redirectOrigin}/checkout.html`,
      metadata: {
        orderItems: JSON.stringify(resolvedItems.map((item) => ({ id: item.productId, qty: item.quantity }))),
        shippingMethod: shippingOption.id,
        shippingLabel: shippingOption.name,
        shippingAmount: (shippingCostPence / 100).toFixed(2),
        subtotal: subtotal.toFixed(2),
        total: (finalTotalPence / 100).toFixed(2)
      }
    });

    sendJson(res, 200, { url: session.url });
  } catch (error) {
    console.error("Stripe error:", error.message);
    if (error && (error.type === "StripeAuthenticationError" || /api key/i.test(String(error.message || "")))) {
      sendJson(res, 500, { error: "Stripe authentication failed. Check STRIPE_SECRET_KEY." });
      return;
    }

    if (error && error.type === "StripeInvalidRequestError") {
      sendJson(res, 500, { error: "Stripe rejected the checkout request. Please verify payment configuration." });
      return;
    }

    sendJson(res, 500, { error: "Payment session could not be created. Please try again." });
  }
}

async function handleGetOrders(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const token = getDashboardBearerToken(req);
  if (!verifyDashboardToken(token)) {
    sendPrivateApiJson(res, 401, { error: "Unauthorised. Please log in again." });
    return;
  }

  const stripe = getStripeClient();
  if (!stripe) {
    sendPrivateApiJson(res, 500, { error: "Stripe is not configured. Missing STRIPE_SECRET_KEY." });
    return;
  }

  try {
        /* Optional cursor for backward pagination through checkout sessions.
       The cursor is a Stripe resource id (e.g. cs_live_...) returned from a
       previous page. It is validated before ever reaching Stripe. Note the
       cursor advances through *all* checkout sessions — unpaid/incomplete
       sessions are filtered out only after retrieval. */
    let startingAfter = null;
    try {
      startingAfter = new URL(req.url, "http://localhost").searchParams.get("starting_after") || null;
    } catch {
      startingAfter = null;
    }

    if (startingAfter && !/^([A-Za-z0-9_]{1,255})$/.test(startingAfter)) {
      sendPrivateApiJson(res, 400, { error: "Invalid starting_after cursor." });
      return;
    }

    const listParams = {
      limit: 100,
      expand: ["data.line_items"]
    };
    if (startingAfter) {
      listParams.starting_after = startingAfter;
    }

    const sessions = await stripe.checkout.sessions.list(listParams);

    const orders = sessions.data
      .filter((s) => s.payment_status === "paid")
      .map((s) => {
        const items = (s.line_items?.data || []).map((item) => ({
          name: item.description || "Treasure",
          quantity: item.quantity || 1,
          unitAmount: parseFloat(((item.amount_total / 100) / (item.quantity || 1)).toFixed(2)),
          totalAmount: parseFloat((item.amount_total / 100).toFixed(2))
        }));

        const addr = s.shipping_details?.address || s.customer_details?.address || null;
        const shippingAddress = addr
          ? [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country]
              .filter(Boolean)
              .join(", ")
          : null;

        return {
          id: s.id,
          shortId: s.id.slice(-8).toUpperCase(),
          paymentIntentId: s.payment_intent || null,
          customerName: s.customer_details?.name || "Unknown Traveller",
          customerEmail: s.customer_details?.email || "Unknown",
          shippingAddress,
          shippingMethod: s.metadata?.shippingLabel || null,
          shippingAmount: parseFloat(s.metadata?.shippingAmount || "0"),
          items,
          amountTotal: parseFloat((s.amount_total / 100).toFixed(2)),
          currency: (s.currency || "gbp").toUpperCase(),
          paymentStatus: s.payment_status,
          created: s.created * 1000
        };
            });

    /* Cursor-based pagination over checkout sessions. The next cursor is the
       last session id in this page and is returned only when Stripe reports
       that more sessions remain. */
    const lastSessionId = sessions.data.length
      ? sessions.data[sessions.data.length - 1].id
      : null;

    sendPrivateApiJson(res, 200, {
      orders,
      hasMore: !!sessions.has_more,
      nextCursor: (sessions.has_more && lastSessionId) ? lastSessionId : null
    });
  } catch (error) {
    console.error("get-orders Stripe error:", error.message);
    sendPrivateApiJson(res, 500, { error: "The ledger could not be consulted. Please try again." });
  }
}

async function handleCustomerOrders(req, res) {
  if (req.method !== "GET") {
    sendPrivateApiJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const auth = await authenticateProfileRequest(req);
  if (!auth.ok) {
    if (auth.statusCode === 503) {
      sendPrivateApiJson(res, 503, {
        error: "Authentication state could not be verified. Please try again."
      });
      return;
    }

    sendPrivateApiJson(res, 401, { error: "Please sign in again." });
    return;
  }

  const stripe = getStripeClient();
  if (!stripe) {
    sendPrivateApiJson(res, 500, { error: "Stripe is not configured. Missing STRIPE_SECRET_KEY." });
    return;
  }

  try {
    const sessions = await stripe.checkout.sessions.list({
      limit: 100,
      expand: ["data.line_items"]
    });

    const ownOrders = sessions.data.filter(
      (s) => s.payment_status === "paid" &&
             (s.customer_details?.email || "").trim().toLowerCase() === auth.customer.email
    );

    const ids = ownOrders.map((s) => s.id);
    let statusRows = [];
    if (ids.length) {
      const statusResult = await pool.query(
        `SELECT order_id, status, updated_at
        FROM order_status_records
        WHERE order_id = ANY($1::text[])`,
        [ids]
      );
      statusRows = statusResult.rows;
    }

    const statusById = new Map(statusRows.map((row) => [row.order_id, row.status]));

    const messages = ownOrders.map((s) => {
      const items = (s.line_items?.data || []).map((item) => ({
        name: item.description || "Treasure",
        quantity: item.quantity || 1,
        unitAmount: parseFloat(((item.amount_total / 100) / (item.quantity || 1)).toFixed(2)),
        totalAmount: parseFloat((item.amount_total / 100).toFixed(2))
      }));

      const status = statusById.get(s.id) || "new";

      return {
        id: s.id,
        shortId: s.id.slice(-8).toUpperCase(),
        created: s.created * 1000,
        items,
        amountTotal: parseFloat((s.amount_total / 100).toFixed(2)),
        currency: (s.currency || "gbp").toUpperCase(),
        status,
        statusText: ORDER_STATUS_COPY[status] || ORDER_STATUS_COPY.new
      };
    });

    messages.sort((a, b) => b.created - a.created);
    sendPrivateApiJson(res, 200, { messages });
  } catch (error) {
    console.error("customer-orders Stripe error:", error.message);
    sendPrivateApiJson(res, 500, {
      error: "Your Merchant's Messages could not be gathered. Please try again."
    });
  }
}

async function handleGetFeaturedTreasure(req, res) {
  try {
    const result = await pool.query(
      `SELECT payload
      FROM featured_treasure_state
      WHERE id = 'data'
      LIMIT 1`
    );

    let featuredData = result.rows[0]?.payload || null;

    if (!featuredData) {
      const filePath = path.join(__dirname, "data", "featured-treasure.json");
      if (fs.existsSync(filePath)) {
        featuredData = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } else {
        featuredData = {
          title: "✨ Featured Treasure",
          intro: "",
          closingNote: "",
          settings: { showWhenOutOfStock: true },
          features: []
        };
      }
    }

    sendJson(res, 200, featuredData, {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
  } catch (error) {
    console.error("get-featured-treasure error:", error.message);
    try {
      const filePath = path.join(__dirname, "data", "featured-treasure.json");
      const fallback = fs.readFileSync(filePath, "utf8");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(fallback);
    } catch {
      sendJson(res, 500, { error: "Could not read Featured Treasure data." });
    }
  }
}

async function handleUpdateFeaturedTreasure(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const token = getDashboardBearerToken(req);
  if (!verifyDashboardToken(token)) {
    sendPrivateApiJson(res, 401, { error: "Unauthorised." });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readRequestBody(req) || "{}");
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  if (!payload || typeof payload !== "object") {
    sendPrivateApiJson(res, 400, { error: "Payload required." });
    return;
  }

  if (Array.isArray(payload.features)) {
    let publishedFound = false;
    payload.features.forEach((feature) => {
      if (feature.status === "published") {
        if (!publishedFound) {
          publishedFound = true;
        } else {
          feature.status = "draft";
        }
      }
    });
  }

  try {
    await pool.query(
      `INSERT INTO featured_treasure_state (id, payload)
      VALUES ('data', $1::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET payload = EXCLUDED.payload`,
      [JSON.stringify(payload)]
    );

    sendPrivateApiJson(res, 200, { ok: true, data: payload });
  } catch (error) {
    console.error("update-featured-treasure error:", error.message);
    sendPrivateApiJson(res, 500, { error: "Featured Treasure could not be saved." });
  }
}

async function handleGetDeskEntries(req, res) {
  try {
    const result = await pool.query(
      `SELECT payload
      FROM desk_entries_state
      WHERE id = 'data'
      LIMIT 1`
    );

    let deskData = result.rows[0]?.payload || null;
    if (!deskData) {
      const filePath = path.join(__dirname, "data", "desk-entries.json");
      if (fs.existsSync(filePath)) {
        deskData = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } else {
        deskData = {
          title: "🕯️ From the Merchant's Desk",
          subtitle: "",
          closingNote: "",
          settings: { homepageLimit: 3 },
          entries: []
        };
      }
    }

    sendJson(res, 200, deskData, {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
  } catch (error) {
    console.error("get-desk-entries error:", error.message);
    try {
      const filePath = path.join(__dirname, "data", "desk-entries.json");
      const fallback = fs.readFileSync(filePath, "utf8");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(fallback);
    } catch {
      sendJson(res, 500, { error: "Could not read desk entries data." });
    }
  }
}

async function handleUpdateDeskEntries(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const token = getDashboardBearerToken(req);
  if (!verifyDashboardToken(token)) {
    sendPrivateApiJson(res, 401, { error: "Unauthorised." });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readRequestBody(req) || "{}");
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  if (!payload || typeof payload !== "object") {
    sendPrivateApiJson(res, 400, { error: "Payload required." });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO desk_entries_state (id, payload)
      VALUES ('data', $1::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET payload = EXCLUDED.payload`,
      [JSON.stringify(payload)]
    );

    sendPrivateApiJson(res, 200, { ok: true, data: payload });
  } catch (error) {
    console.error("update-desk-entries error:", error.message);
    sendPrivateApiJson(res, 500, { error: "Journal entries could not be saved." });
  }
}

async function handlePromoteMerchant(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let email;
  let setupKey;
  try {
    ({ email, setupKey } = JSON.parse(await readRequestBody(req)));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const correctKey = process.env.MERCHANT_SETUP_KEY;
  if (!correctKey) {
    console.error("promote-merchant: MERCHANT_SETUP_KEY not set.");
    sendJson(res, 500, { error: "Merchant setup is not yet configured." });
    return;
  }

  let keyMatch = false;
  try {
    const inputBuf = Buffer.from(String(setupKey || ""));
    const correctBuf = Buffer.from(String(correctKey));
    if (inputBuf.length === correctBuf.length) {
      keyMatch = crypto.timingSafeEqual(inputBuf, correctBuf);
    }
  } catch {
    keyMatch = false;
  }

  if (!keyMatch) {
    sendJson(res, 401, { error: "Incorrect setup key." });
    return;
  }

  const key = normaliseEmail(email);
  if (!key) {
    sendJson(res, 400, { error: "A valid email address is required." });
    return;
  }

  try {
    const customerResult = await pool.query(
      `SELECT id, name, email, role
      FROM customers
      WHERE email = $1
      LIMIT 1`,
      [key]
    );

    const customer = customerResult.rows[0] || null;
    if (!customer) {
      sendJson(res, 404, { error: "No Traveller account is known by that email address." });
      return;
    }

    const updateResult = await pool.query(
      `UPDATE customers
      SET role = 'merchant'
      WHERE id = $1
      RETURNING id, name, email, role`,
      [customer.id]
    );

    const updated = updateResult.rows[0] || null;
    if (!updated) {
      sendJson(res, 404, { error: "No Traveller account is known by that email address." });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      customer: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role
      }
    });
  } catch (error) {
    if (isProfileWriteStateError(error)) {
      sendJson(res, 503, {
        error: "Merchant promotion could not be completed right now. Please try again."
      });
      return;
    }

    throw error;
  }
}

async function handleStripeWebhook(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed.");
    return;
  }

  const signature = req.headers["stripe-signature"];
  const stripe = getStripeClient();
  if (!stripe) {
    console.error("stripe-webhook: STRIPE_SECRET_KEY not set. Skipping.");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Stripe secret not configured.");
    return;
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error("stripe-webhook: STRIPE_WEBHOOK_SECRET not set. Skipping.");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Webhook secret not configured.");
    return;
  }

  let rawBody;
  try {
    rawBody = await readRequestBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Webhook signature error: request body could not be read.");
    return;
  }

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    console.error("stripe-webhook: signature verification failed:", error.message);
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Webhook signature error: ${error.message}`);
    return;
  }

  if (stripeEvent.type !== "checkout.session.completed") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Event acknowledged.");
    return;
  }

  const session = stripeEvent.data.object;
  let orderItems = [];
  try {
    orderItems = JSON.parse(session.metadata?.orderItems || "[]");
  } catch {
    console.warn("stripe-webhook: could not parse orderItems from session metadata.");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No orderItems in metadata.");
    return;
  }

  if (!orderItems.length) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No items to process.");
    return;
  }

  const paymentRef = {
    stripeEventId: stripeEvent.id,
    stripeEventType: stripeEvent.type,
    checkoutSessionId: session.id || null,
    paymentIntentId: session.payment_intent || null,
    customerEmail: session.customer_details?.email || session.customer_email || null,
    orderItems
  };

  for (let attempt = 1; attempt <= STRIPE_WEBHOOK_MAX_CONFLICT_RETRIES; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Idempotency: record this Stripe event. If it was already processed,
      // the unique constraint prevents duplicate inventory decrements.
      const eventResult = await client.query(
        `INSERT INTO stripe_webhook_events
         (stripe_event_id, checkout_session_id, payment_intent_id, customer_email, processed_at, order_items)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (stripe_event_id) DO NOTHING
         RETURNING stripe_event_id`,
        [
          stripeEvent.id,
          session.id || null,
          session.payment_intent || null,
          session.customer_details?.email || session.customer_email || null,
          Date.now(),
          JSON.stringify(orderItems)
        ]
      );

      if (!eventResult.rows.length) {
        await client.query("COMMIT");
        console.log("stripe-webhook: duplicate event ignored", {
          stripeEventId: stripeEvent.id
        });
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Event already processed.");
        return;
      }

      const locked = await client.query(
        `SELECT inventory
        FROM inventory_state
        WHERE id = 'all'
        FOR UPDATE`
      );

      const inventory = normalizeInventoryDocument(locked.rows[0]?.inventory || {});

      const shortages = [];
      for (const { id, qty } of orderItems) {
        const item = inventory[id];
        if (!item || item.stock === null) continue;

        const stock = Number(item.stock);
        if (!Number.isFinite(stock) || item.available === false || stock < qty) {
          shortages.push({
            productId: id,
            requestedQty: qty,
            availableStock: Number.isFinite(stock) ? stock : null,
            availableFlag: item.available
          });
        }
      }

      if (shortages.length) {
        await client.query("ROLLBACK");
        console.error("stripe-webhook: manual intervention required - insufficient stock after payment", {
          ...paymentRef,
          shortages
        });

        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Insufficient stock after payment; manual intervention required.");
        return;
      }

      const now = Date.now();
      for (const { id, qty } of orderItems) {
        const item = inventory[id];
        if (!item || item.stock === null) continue;
        item.stock = Number(item.stock) - qty;
        item.lastUpdated = now;
      }

      await client.query(
        `INSERT INTO inventory_state (id, inventory)
        VALUES ('all', $1::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET inventory = EXCLUDED.inventory`,
        [JSON.stringify(inventory)]
      );

      await client.query("COMMIT");
      console.log("stripe-webhook: stock updated after payment", {
        ...paymentRef,
        conflictRetries: attempt - 1
      });

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Stock updated.");
      return;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback failures so original error is reported.
      }

      const retryable = error?.code === "40001" || error?.code === "40P01";
      if (retryable && attempt < STRIPE_WEBHOOK_MAX_CONFLICT_RETRIES) {
        await delay(nextWebhookRetryDelay(attempt));
        continue;
      }

      if (retryable && attempt >= STRIPE_WEBHOOK_MAX_CONFLICT_RETRIES) {
        console.error("stripe-webhook: inventory update conflicted too many times; retry required", {
          ...paymentRef,
          maxRetries: STRIPE_WEBHOOK_MAX_CONFLICT_RETRIES
        });
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Inventory update conflict; please retry webhook delivery.");
        return;
      }

      console.error("stripe-webhook: failed to update inventory:", error.message);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Inventory update failed. Please retry webhook delivery.");
      return;
    } finally {
      client.release();
    }
  }
}

async function handleCustomerForgotPassword(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let email;
  try {
    ({ email } = JSON.parse(bodyText));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const key = normaliseEmail(email);
  if (!key) {
    sendJson(res, 400, { error: "An email address is required." });
    return;
  }

  const customerResult = await pool.query(
    `SELECT id
    FROM customers
    WHERE email = $1
    LIMIT 1`,
    [key]
  );

  const customer = customerResult.rows[0] || null;
  if (!customer) {
    sendJson(res, 200, {});
    return;
  }

  const resetToken = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO customer_reset_tokens (token, customer_id, expires_at)
    VALUES ($1, $2, $3)`,
    [
      resetToken,
      customer.id,
      new Date(Date.now() + RESET_TOKEN_LIFETIME_MS).toISOString()
    ]
  );

  const siteUrl = process.env.URL || "";
  const resetUrl = `${siteUrl}/reset-password.html?token=${resetToken}`;

  const resendApiKey = String(process.env.RESEND_API_KEY || "").trim();
  const fromEmail = String(process.env.FROM_EMAIL || "").trim();

  if (resendApiKey && fromEmail) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [email],
          subject: "Reset your Little Oddities Curiosities password",
          html: `
            <p>Hello,</p>
            <p>A request was made to reset the password for your Little Oddities Curiosities account.</p>
            <p>If this was you, set a new password using the link below. The link expires soon and can only be used once.</p>
            <p><a href="${resetUrl}">Reset your Traveller Password</a></p>
            <p>If you did not request this, you can safely ignore this email.</p>
            <p>— The Merchant</p>
          `
        })
      });
    } catch (emailError) {
      console.error("customer-forgot-password: failed to send reset email:", emailError);
    }
  }

  sendJson(res, 200, {});
}

async function handleCustomerResetPassword(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let resetToken;
  let password;
  try {
    ({ token: resetToken, password } = JSON.parse(bodyText));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  if (!resetToken || !password) {
    sendJson(res, 400, { error: "A reset token and new Traveller password are required." });
    return;
  }

  if (String(password).length < 8) {
    sendJson(res, 400, { error: "Traveller password must be at least 8 characters." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tokenResult = await client.query(
      `SELECT customer_id, expires_at
      FROM customer_reset_tokens
      WHERE token = $1
      FOR UPDATE`,
      [resetToken]
    );

    const tokenRecord = tokenResult.rows[0] || null;
    if (!tokenRecord || Date.now() > new Date(tokenRecord.expires_at).getTime()) {
      await client.query("ROLLBACK");
      sendJson(res, 400, {
        error: "That reset link has expired or is no longer valid. Please request a new one."
      });
      return;
    }

    const { salt, hash } = hashPassword(password);
    const customerUpdate = await client.query(
      `UPDATE customers
      SET password_hash = $2,
          salt = $3
      WHERE id = $1
      RETURNING id, name, email`,
      [tokenRecord.customer_id, hash, salt]
    );

    const customer = customerUpdate.rows[0] || null;
    if (!customer) {
      await client.query("ROLLBACK");
      sendJson(res, 404, { error: "That Traveller could no longer be found." });
      return;
    }

    await client.query(
      `DELETE FROM customer_reset_tokens
      WHERE token = $1`,
      [resetToken]
    );

    await client.query("COMMIT");

    const sessionToken = createToken(customer.id);
    sendJson(res, 200, {
      token: sessionToken,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email
      }
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors so the original database failure is reported.
    }

    if (isProfileWriteStateError(error)) {
      sendJson(res, 503, {
        error: "Your password could not be reset right now. Please try again."
      });
      return;
    }

    throw error;
  } finally {
    client.release();
  }
}

async function handleCustomerRegister(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let name;
  let email;
  let password;
  try {
    ({ name, email, password } = JSON.parse(bodyText));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  name = String(name || "").trim();
  const key = normaliseEmail(email);

  if (!name || !key || !password) {
    sendJson(res, 400, {
      error: "Traveller name, email address, and Traveller password are all required."
    });
    return;
  }

  if (String(password).length < 8) {
    sendJson(res, 400, { error: "Traveller password must be at least 8 characters." });
    return;
  }

  const { salt, hash } = hashPassword(password);
  const customerId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const role = "traveller";

  try {
    const result = await pool.query(
      `INSERT INTO customers (
        id,
        name,
        email,
        password_hash,
        salt,
        notification_prefs,
        created_at,
        role
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      RETURNING id, name, email, role`,
      [
        customerId,
        name,
        key,
        hash,
        salt,
        JSON.stringify({ orderUpdates: true }),
        createdAt,
        role
      ]
    );

    const customer = result.rows[0];
    const token = createToken(customer.id);

    sendJson(res, 200, {
      token,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        role: customer.role
      }
    });
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      sendJson(res, 409, { error: "A Traveller is already known by that email address." });
      return;
    }

    console.error("customer-register: failed to create customer:", error);
    sendJson(res, 500, { error: "Unable to create Traveller account right now." });
  }
}

async function handleCustomerLogin(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let email;
  let password;
  try {
    ({ email, password } = JSON.parse(bodyText));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const key = normaliseEmail(email);
  if (!key || !password) {
    sendJson(res, 400, {
      error: "Email address and Traveller password are required."
    });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, role, password_hash, salt
      FROM customers
      WHERE email = $1
      LIMIT 1`,
      [key]
    );

    const customer = result.rows[0] || null;

    if (!customer || !verifyPassword(password, customer.salt, customer.password_hash)) {
      sendJson(res, 401, {
        error: "That email address and Traveller password do not match our records."
      });
      return;
    }

    const token = createToken(customer.id);
    sendJson(res, 200, {
      token,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        role: customer.role || "traveller"
      }
    });
  } catch (error) {
    console.error("customer-login: failed to authenticate customer:", error);
    sendJson(res, 500, { error: "Unable to sign in right now." });
  }
}

function isFunctionRoute(requestPath, name, extraAliases = []) {
  const norm = requestPath.replace(/\/$/, "");
  if (
    norm === `/.netlify/functions/${name}` ||
    norm === `/.netlify/functions/${name}.js` ||
    norm === `/netlify/functions/${name}` ||
    norm === `/netlify/functions/${name}.js` ||
    norm === `/api/${name}` ||
    norm === `/${name}`
  ) {
    return true;
  }
  return extraAliases.includes(norm);
}

const server = http.createServer((req, res) => {
  let requestPath;
  try {
    requestPath = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }

  if (isFunctionRoute(requestPath, "customer-register")) {
    handleCustomerRegister(req, res).catch((error) => {
      console.error("customer-register: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Unable to create Traveller account right now." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "customer-login")) {
    handleCustomerLogin(req, res).catch((error) => {
      console.error("customer-login: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Unable to sign in right now." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "customer-profile")) {
    handleCustomerProfile(req, res).catch((error) => {
      console.error("customer-profile: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, { error: "Something went wrong. Please try again." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "customer-wishlist")) {
    handleCustomerWishlist(req, res).catch((error) => {
      console.error("customer-wishlist: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, { error: "Something went wrong. Please try again." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "customer-logout")) {
    handleCustomerLogout(req, res).catch((error) => {
      console.error("customer-logout: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 503, {
          error: "Could not persist logout state. Please try again."
        }, {
          ...PRIVATE_API_NO_STORE_HEADERS,
          ...LOGOUT_CORS_HEADERS
        });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "customer-delete-account")) {
    handleCustomerDeleteAccount(req, res).catch((error) => {
      console.error("customer-delete-account: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, {
          error: "Could not delete account right now. Please try again."
        });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "customer-addresses")) {
    handleCustomerAddresses(req, res).catch((error) => {
      console.error("customer-addresses: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, { error: "Something went wrong. Please try again." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "get-inventory", ["/data/inventory.json"])) {
    handleGetInventory(req, res).catch((error) => {
      console.error("get-inventory: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 503, {
          error: "Inventory could not be verified. Please try again shortly."
        }, {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "update-inventory")) {
    handleUpdateInventory(req, res).catch((error) => {
      console.error("update-inventory: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "The Merchant's Supplies could not be updated." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "dashboard-login")) {
    handleDashboardLogin(req, res).catch((error) => {
      console.error("dashboard-login: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "Dashboard is not yet configured. Please set dashboard credentials in the runtime environment."
        });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "get-order-status")) {
    handleGetOrderStatus(req, res).catch((error) => {
      console.error("get-order-status: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, { error: "Order status could not be retrieved." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "update-order-status")) {
    handleUpdateOrderStatus(req, res).catch((error) => {
      console.error("update-order-status: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, { error: "Order status could not be updated." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "get-orders")) {
    handleGetOrders(req, res).catch((error) => {
      console.error("get-orders: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, { error: "The ledger could not be consulted. Please try again." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "customer-orders")) {
    handleCustomerOrders(req, res).catch((error) => {
      console.error("customer-orders: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, {
          error: "Your Merchant's Messages could not be gathered. Please try again."
        });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "create-checkout-session")) {
    handleCreateCheckoutSession(req, res).catch((error) => {
      console.error("create-checkout-session: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Payment session could not be created. Please try again." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "get-featured-treasure", ["/data/featured-treasure.json"])) {
    handleGetFeaturedTreasure(req, res).catch((error) => {
      console.error("get-featured-treasure: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Could not read Featured Treasure data." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "update-featured-treasure")) {
    handleUpdateFeaturedTreasure(req, res).catch((error) => {
      console.error("update-featured-treasure: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, { error: "Featured Treasure could not be saved." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "get-desk-entries", ["/data/desk-entries.json"])) {
    handleGetDeskEntries(req, res).catch((error) => {
      console.error("get-desk-entries: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Could not read desk entries data." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "update-desk-entries")) {
    handleUpdateDeskEntries(req, res).catch((error) => {
      console.error("update-desk-entries: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, { error: "Journal entries could not be saved." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "promote-merchant")) {
    handlePromoteMerchant(req, res).catch((error) => {
      console.error("promote-merchant: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Merchant promotion could not be completed right now. Please try again." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "stripe-webhook")) {
    handleStripeWebhook(req, res).catch((error) => {
      console.error("stripe-webhook: unexpected failure:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Inventory update failed. Please retry webhook delivery.");
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "customer-forgot-password")) {
    handleCustomerForgotPassword(req, res).catch((error) => {
      console.error("customer-forgot-password: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: FORGOT_PASSWORD_INTERNAL_ERROR });
      } else {
        res.end();
      }
    });
    return;
  }

  if (isFunctionRoute(requestPath, "customer-reset-password")) {
    handleCustomerResetPassword(req, res).catch((error) => {
      console.error("customer-reset-password: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: RESET_PASSWORD_INTERNAL_ERROR });
      } else {
        res.end();
      }
    });
    return;
  }

  if (requestPath === "/merchant-dashboard") {
    // A stable, extension-free dashboard URL avoids the stale static-object
    // cache left behind at /merchant-dashboard.html by the previous deploy.
    requestPath = "/merchant-dashboard.html";
  } else if (requestPath === "/") {
    requestPath = "/index.html";
  }

  const filePath = path.join(ROOT, requestPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      res.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType =
      MIME_TYPES[extension] || "application/octet-stream";

    const isMerchantDashboardAsset =
      requestPath === "/merchant-dashboard.html" ||
      requestPath === "/merchant-dashboard.js" ||
      requestPath === "/merchant-dashboard.css";

    res.writeHead(200, {
      "Content-Type": contentType,
      ...(isMerchantDashboardAsset ? MERCHANT_DASHBOARD_NO_STORE_HEADERS : {})
    });

    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Little Oddities server running on port ${PORT}`);
});
