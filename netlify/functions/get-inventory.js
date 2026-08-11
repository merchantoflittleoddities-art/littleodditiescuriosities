/* =============================================================
   Little Oddities Curiosities — Netlify Function
   get-inventory.js

   Public endpoint — no authentication required.
   Returns current inventory for all products so the
   customer-facing site and Merchant Dashboard can show stock states.

   Uses PostgreSQL (db.js) in G7Cloud, with fallback to catalogue.json
   if the database is temporarily unreachable.
   ============================================================= */

const path = require("path");
const fs = require("fs");
const pool = require("../../db");

function defaultInventoryEntry(productId) {
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

function getFallbackInventory() {
  const fallbackInventory = {};
  try {
    const cataloguePath = path.resolve(__dirname, "../../data/catalogue.json");
    if (fs.existsSync(cataloguePath)) {
      const data = JSON.parse(fs.readFileSync(cataloguePath, "utf-8"));
      const products = Array.isArray(data) ? data : (data.products || []);
      products.forEach((product) => {
        if (product && product.id) {
          fallbackInventory[product.id] = defaultInventoryEntry(product.id);
        }
      });
    }
  } catch (err) {
    console.error("get-inventory fallback catalogue error:", err);
  }
  return fallbackInventory;
}

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  };

  try {
    const result = await pool.query(
      `SELECT inventory
      FROM inventory_state
      WHERE id = 'all'
      LIMIT 1`
    );

    const inventory = normalizeInventoryDocument(result.rows[0]?.inventory || {});

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ inventory })
    };
  } catch (error) {
    console.error("get-inventory db error:", error);

    const fallbackInventory = getFallbackInventory();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ inventory: fallbackInventory })
    };
  }
};
