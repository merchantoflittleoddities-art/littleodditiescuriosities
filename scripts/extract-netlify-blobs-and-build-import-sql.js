const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { getStore } = require("@netlify/blobs");

const EXPORT_DIR = path.resolve(__dirname, "..", "migration-artifacts");
const EXPORT_JSON_PATH = path.join(EXPORT_DIR, "netlify-blob-export.json");
const EXPORT_SQL_PATH = path.join(EXPORT_DIR, "g7cloud_postgres_import_real_data.sql");

const API_URL = "https://api.netlify.com";

function normalizeRepoUrl(value) {
  return String(value || "")
    .trim()
    .replace(/^git@github.com:/i, "https://github.com/")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function getGitRemoteOriginUrl() {
  try {
    const output = execSync("git remote get-url origin", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    return normalizeRepoUrl(output);
  } catch {
    return "";
  }
}

async function fetchSites(token) {
  const response = await fetch(`${API_URL}/api/v1/sites`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to list Netlify sites: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function resolveSiteID(token) {
  const explicitSiteID = String(process.env.NETLIFY_SITE_ID || "").trim();
  if (explicitSiteID) {
    return explicitSiteID;
  }

  const requestedSiteName = String(process.env.NETLIFY_SITE_NAME || "").trim().toLowerCase();
  const remoteOrigin = getGitRemoteOriginUrl();
  const sites = await fetchSites(token);

  let candidates = sites;

  if (requestedSiteName) {
    candidates = candidates.filter((site) => String(site.name || "").toLowerCase() === requestedSiteName);
  }

  if (candidates.length !== 1 && remoteOrigin) {
    const repoMatched = candidates.filter((site) => {
      const repoUrl = normalizeRepoUrl(site?.build_settings?.repo_url || site?.repo_url || "");
      return repoUrl && repoUrl === remoteOrigin;
    });
    if (repoMatched.length) {
      candidates = repoMatched;
    }
  }

  if (candidates.length === 1 && candidates[0]?.id) {
    return String(candidates[0].id);
  }

  const printable = candidates.slice(0, 20).map((site) => ({ id: site.id, name: site.name, url: site.ssl_url || site.url || null }));
  throw new Error(`Unable to resolve NETLIFY_SITE_ID automatically. Set NETLIFY_SITE_ID or NETLIFY_SITE_NAME. Candidate sites: ${JSON.stringify(printable)}`);
}

async function requireEnv() {
  const token = String(process.env.NETLIFY_PERSONAL_ACCESS_TOKEN || "").trim();
  if (!token) {
    throw new Error("Missing required environment variable: NETLIFY_PERSONAL_ACCESS_TOKEN");
  }

  const siteID = await resolveSiteID(token);

  return {
    siteID,
    token,
    apiURL: API_URL
  };
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function jsonLiteral(value) {
  const json = JSON.stringify(value === undefined ? null : value);
  return `'${json.replace(/'/g, "''")}'::jsonb`;
}

function textLiteral(value) {
  const text = String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

function bigintOrNowLiteral(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && Number.isInteger(numeric) && numeric >= 0) {
    return String(numeric);
  }
  return "(EXTRACT(EPOCH FROM NOW())::bigint * 1000)";
}

async function listAllKeys(store) {
  const keys = [];
  for await (const page of store.list({ paginate: true })) {
    for (const blob of page.blobs || []) {
      keys.push(blob.key);
    }
  }
  return keys;
}

async function exportInventory(context) {
  const store = getStore({ name: "inventory", ...context });
  const raw = await store.get("all", { type: "text" });
  const parsed = raw ? JSON.parse(raw) : null;

  return {
    store: "inventory",
    key: "all",
    found: raw !== null,
    payload: parsed
  };
}

async function exportFeaturedTreasure(context) {
  const store = getStore({ name: "featured-treasure", ...context });
  const raw = await store.get("data", { type: "text" });
  const parsed = raw ? JSON.parse(raw) : null;

  return {
    store: "featured-treasure",
    key: "data",
    found: raw !== null,
    payload: parsed
  };
}

async function exportDeskEntries(context) {
  const store = getStore({ name: "desk-entries", ...context });
  const raw = await store.get("data", { type: "text" });
  const parsed = raw ? JSON.parse(raw) : null;

  return {
    store: "desk-entries",
    key: "data",
    found: raw !== null,
    payload: parsed
  };
}

async function exportOrderStatus(context) {
  const store = getStore({ name: "order-status", ...context });
  const keys = await listAllKeys(store);
  const records = {};

  for (const key of keys) {
    const record = await store.get(key, { type: "json" });
    if (record && typeof record === "object") {
      records[key] = record;
    }
  }

  return {
    store: "order-status",
    keyCount: keys.length,
    keys,
    records
  };
}

async function exportCustomerAddresses(context) {
  const store = getStore({ name: "customer-addresses", ...context });
  const keys = await listAllKeys(store);
  const records = [];

  for (const customerId of keys) {
    const addresses = await store.get(customerId, { type: "json" });
    records.push({
      customer_id: customerId,
      addresses: Array.isArray(addresses) ? addresses : []
    });
  }

  return {
    store: "customer-addresses",
    keyCount: keys.length,
    keys,
    records
  };
}

async function exportCustomers(context) {
  const store = getStore({ name: "customers", ...context });
  const keys = await listAllKeys(store);
  const records = [];

  for (const customerId of keys) {
    const customer = await store.get(customerId, { type: "json" });
    if (customer && typeof customer === "object" && !Array.isArray(customer)) {
      records.push(customer);
    }
  }

  return {
    store: "customers",
    keyCount: keys.length,
    keys,
    records
  };
}

async function exportCustomerEmails(context) {
  const store = getStore({ name: "customer-emails", ...context });
  const keys = await listAllKeys(store);
  const records = [];

  for (const email of keys) {
    const customerId = await store.get(email, { type: "text" });
    records.push({ email, customer_id: customerId || null });
  }

  return {
    store: "customer-emails",
    keyCount: keys.length,
    keys,
    records
  };
}

async function exportWishlist(context) {
  const store = getStore({ name: "customer-wishlist", ...context });
  const keys = await listAllKeys(store);
  const records = [];

  for (const customerId of keys) {
    const productIds = await store.get(customerId, { type: "json" });
    records.push({
      customer_id: customerId,
      product_ids: Array.isArray(productIds) ? productIds : []
    });
  }

  return {
    store: "customer-wishlist",
    keyCount: keys.length,
    keys,
    records
  };
}

async function exportResetTokens(context) {
  const store = getStore({ name: "customer-reset-tokens", ...context });
  const keys = await listAllKeys(store);
  const records = [];

  for (const token of keys) {
    const record = await store.get(token, { type: "json" });
    if (record && typeof record === "object" && !Array.isArray(record)) {
      records.push({ token, ...record });
    }
  }

  return {
    store: "customer-reset-tokens",
    keyCount: keys.length,
    keys,
    records
  };
}

function buildImportSql(exportData) {
  const statements = [];

  statements.push("BEGIN;");

  for (const customer of exportData.customers.records || []) {
    if (!customer || typeof customer.id !== "string" || !customer.id) {
      continue;
    }

    const notificationPrefs = customer.notificationPrefs && typeof customer.notificationPrefs === "object" && !Array.isArray(customer.notificationPrefs)
      ? customer.notificationPrefs
      : { orderUpdates: true };

    const role = typeof customer.role === "string" && customer.role ? customer.role : "traveller";
    const createdAt = customer.createdAt || new Date().toISOString();
    const tokenRevokedAfterMs = Number.isFinite(Number(customer.tokenRevokedAfterMs))
      ? String(Number(customer.tokenRevokedAfterMs))
      : "NULL";

    statements.push(
      `INSERT INTO customers (id, name, email, password_hash, salt, notification_prefs, created_at, role, token_revoked_after_ms) VALUES (${textLiteral(customer.id)}, ${textLiteral(customer.name || "")}, ${textLiteral(customer.email || "")}, ${textLiteral(customer.passwordHash || "")}, ${textLiteral(customer.salt || "")}, ${jsonLiteral(notificationPrefs)}, ${textLiteral(createdAt)}, ${textLiteral(role)}, ${tokenRevokedAfterMs}) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt, notification_prefs = EXCLUDED.notification_prefs, created_at = EXCLUDED.created_at, role = EXCLUDED.role, token_revoked_after_ms = EXCLUDED.token_revoked_after_ms;`
    );
  }

  if (exportData.inventory.found && exportData.inventory.payload && typeof exportData.inventory.payload === "object" && !Array.isArray(exportData.inventory.payload)) {
    statements.push(
      `INSERT INTO inventory_state (id, inventory) VALUES ('all', ${jsonLiteral(exportData.inventory.payload)}) ON CONFLICT (id) DO UPDATE SET inventory = EXCLUDED.inventory;`
    );
  }

  for (const [orderId, record] of Object.entries(exportData.orderStatus.records || {})) {
    const status = record && typeof record.status === "string" ? record.status : "new";
    const updatedAt = record ? record.updatedAt : null;
    statements.push(
      `INSERT INTO order_status_records (order_id, status, updated_at) VALUES (${textLiteral(orderId)}, ${textLiteral(status)}, ${bigintOrNowLiteral(updatedAt)}) ON CONFLICT (order_id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at;`
    );
  }

  for (const row of exportData.customerAddresses.records || []) {
    if (!row || typeof row.customer_id !== "string" || !row.customer_id) {
      continue;
    }

    statements.push(
      `INSERT INTO customer_addresses_state (customer_id, addresses) VALUES (${textLiteral(row.customer_id)}, ${jsonLiteral(Array.isArray(row.addresses) ? row.addresses : [])}) ON CONFLICT (customer_id) DO UPDATE SET addresses = EXCLUDED.addresses;`
    );
  }

  for (const row of exportData.wishlist.records || []) {
    if (!row || typeof row.customer_id !== "string" || !row.customer_id) {
      continue;
    }

    for (const productId of Array.isArray(row.product_ids) ? row.product_ids : []) {
      if (typeof productId !== "string" || !productId) {
        continue;
      }

      statements.push(
        `INSERT INTO customer_wishlist (customer_id, product_id) VALUES (${textLiteral(row.customer_id)}, ${textLiteral(productId)}) ON CONFLICT (customer_id, product_id) DO NOTHING;`
      );
    }
  }

  for (const row of exportData.resetTokens.records || []) {
    if (!row || typeof row.token !== "string" || !row.token || typeof row.customerId !== "string" || !row.customerId) {
      continue;
    }

    const expiresMs = Number(row.expires);
    if (!Number.isFinite(expiresMs) || expiresMs <= 0) {
      continue;
    }

    const expiresAt = new Date(expiresMs).toISOString();
    statements.push(
      `INSERT INTO customer_reset_tokens (token, customer_id, expires_at) VALUES (${textLiteral(row.token)}, ${textLiteral(row.customerId)}, ${textLiteral(expiresAt)}) ON CONFLICT (token) DO UPDATE SET customer_id = EXCLUDED.customer_id, expires_at = EXCLUDED.expires_at;`
    );
  }

  if (exportData.featuredTreasure.found && exportData.featuredTreasure.payload && typeof exportData.featuredTreasure.payload === "object" && !Array.isArray(exportData.featuredTreasure.payload)) {
    statements.push(
      `INSERT INTO featured_treasure_state (id, payload) VALUES ('data', ${jsonLiteral(exportData.featuredTreasure.payload)}) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload;`
    );
  }

  if (exportData.deskEntries.found && exportData.deskEntries.payload && typeof exportData.deskEntries.payload === "object" && !Array.isArray(exportData.deskEntries.payload)) {
    statements.push(
      `INSERT INTO desk_entries_state (id, payload) VALUES ('data', ${jsonLiteral(exportData.deskEntries.payload)}) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload;`
    );
  }

  statements.push("COMMIT;");

  statements.push("SELECT 'customers' AS table_name, COUNT(1)::bigint AS row_count FROM customers UNION ALL SELECT 'customer_wishlist', COUNT(1)::bigint FROM customer_wishlist UNION ALL SELECT 'customer_reset_tokens', COUNT(1)::bigint FROM customer_reset_tokens UNION ALL SELECT 'inventory_state', COUNT(1)::bigint FROM inventory_state UNION ALL SELECT 'order_status_records', COUNT(1)::bigint FROM order_status_records UNION ALL SELECT 'customer_addresses_state', COUNT(1)::bigint FROM customer_addresses_state UNION ALL SELECT 'featured_treasure_state', COUNT(1)::bigint FROM featured_treasure_state UNION ALL SELECT 'desk_entries_state', COUNT(1)::bigint FROM desk_entries_state;");
  statements.push("SELECT id, email, role, created_at, token_revoked_after_ms FROM customers ORDER BY created_at ASC LIMIT 20;");
  statements.push("SELECT customer_id, product_id FROM customer_wishlist ORDER BY customer_id ASC, product_id ASC LIMIT 20;");
  statements.push("SELECT token, customer_id, expires_at FROM customer_reset_tokens ORDER BY expires_at DESC LIMIT 20;");
  statements.push("SELECT id, jsonb_object_keys(inventory) AS product_id FROM inventory_state WHERE id = 'all' LIMIT 10;");
  statements.push("SELECT order_id, status, updated_at FROM order_status_records ORDER BY updated_at DESC LIMIT 10;");
  statements.push("SELECT customer_id, jsonb_array_length(addresses) AS address_count FROM customer_addresses_state ORDER BY customer_id ASC LIMIT 10;");
  statements.push("SELECT id, payload FROM featured_treasure_state WHERE id = 'data';");
  statements.push("SELECT id, payload FROM desk_entries_state WHERE id = 'data';");

  return `${statements.join("\n\n")}\n`;
}

async function main() {
  const context = await requireEnv();
  ensureDirectory(EXPORT_DIR);

  const [
    customers,
    customerEmails,
    wishlist,
    resetTokens,
    inventory,
    orderStatus,
    customerAddresses,
    featuredTreasure,
    deskEntries
  ] = await Promise.all([
    exportCustomers(context),
    exportCustomerEmails(context),
    exportWishlist(context),
    exportResetTokens(context),
    exportInventory(context),
    exportOrderStatus(context),
    exportCustomerAddresses(context),
    exportFeaturedTreasure(context),
    exportDeskEntries(context)
  ]);

  const exportData = {
    extractedAt: new Date().toISOString(),
    siteID: context.siteID,
    customers,
    customerEmails,
    wishlist,
    resetTokens,
    inventory,
    orderStatus,
    customerAddresses,
    featuredTreasure,
    deskEntries
  };

  fs.writeFileSync(EXPORT_JSON_PATH, JSON.stringify(exportData, null, 2));

  const sql = buildImportSql(exportData);
  fs.writeFileSync(EXPORT_SQL_PATH, sql);

  const summary = {
    exportJsonPath: EXPORT_JSON_PATH,
    importSqlPath: EXPORT_SQL_PATH,
    customerRecords: (exportData.customers.records || []).length,
    customerEmailRecords: (exportData.customerEmails.records || []).length,
    wishlistRecords: (exportData.wishlist.records || []).length,
    resetTokenRecords: (exportData.resetTokens.records || []).length,
    orderStatusRecords: Object.keys(exportData.orderStatus.records || {}).length,
    customerAddressRecords: (exportData.customerAddresses.records || []).length,
    hasInventory: Boolean(exportData.inventory.found),
    hasFeaturedTreasure: Boolean(exportData.featuredTreasure.found),
    hasDeskEntries: Boolean(exportData.deskEntries.found)
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});