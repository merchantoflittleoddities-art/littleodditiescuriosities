/* =============================================================
   Little Oddities Curiosities — Netlify Function
   update-inventory.js

   Merchant-only endpoint — requires a valid dashboard auth token.
   Reads and writes inventory to PostgreSQL (inventory_state table).
   ============================================================= */

const crypto = require("crypto");
const pool = require("../../db");

function verifyToken(token) {
  const secret = process.env.G7CLOUD_DASHBOARD_SECRET || process.env.DASHBOARD_SECRET;
  if (!token || !secret) return false;

  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return false;

  const timestamp    = token.substring(0, dotIndex);
  const providedHmac = token.substring(dotIndex + 1);
  const expectedHmac = crypto.createHmac("sha256", secret).update(timestamp).digest("hex");

  try {
    const a = Buffer.from(providedHmac, "hex");
    const b = Buffer.from(expectedHmac, "hex");
    if (a.length !== 32 || b.length !== 32) return false;
    if (!crypto.timingSafeEqual(a, b)) return false;
  } catch { return false; }

  const age = Date.now() - parseInt(timestamp, 10);
  return age >= 0 && age < 8 * 60 * 60 * 1000;
}

function defaultEntry(productId) {
  return {
    productId,
    stock: null,
    lowStockThreshold: 3,
    available: true,
    availableStorefrontMessage: "shelves",
    unavailableStorefrontMessage: "roaming",
    outOfStockMessage: "roaming",
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
    ...defaultEntry(productId),
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

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!verifyToken(token)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorised." }) };
  }

  let action, productId, value;
  try {
    ({ action, productId, value } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  if (!action) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "action is required." }) };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT inventory
      FROM inventory_state
      WHERE id = 'all'
      FOR UPDATE`
    );

    const inventory = normalizeInventoryDocument(locked.rows[0]?.inventory || {});

    if (action === "bulkRestock") {
      const amount = Math.max(0, Number(value) || 0);
      Object.keys(inventory).forEach((id) => {
        const entry = inventory[id];
        entry.stock = entry.stock === null ? amount : Math.max(0, entry.stock + amount);
        entry.lastUpdated = Date.now();
      });
    } else {
      if (!productId) {
        await client.query("ROLLBACK");
        client.release();
        return { statusCode: 400, headers, body: JSON.stringify({ error: "productId is required." }) };
      }

      if (!inventory[productId]) {
        inventory[productId] = defaultEntry(productId);
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
          await client.query("ROLLBACK");
          client.release();
          return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
      }

      entry.lastUpdated = Date.now();
    }

    await client.query(
      `INSERT INTO inventory_state (id, inventory)
      VALUES ('all', $1::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET inventory = EXCLUDED.inventory`,
      [JSON.stringify(inventory)]
    );

    await client.query("COMMIT");
    client.release();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, inventory })
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    client.release();
    console.error("update-inventory error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "The Merchant's Supplies could not be updated." })
    };
  }
};
