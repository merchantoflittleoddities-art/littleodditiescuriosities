/* =============================================================
   Little Oddities Curiosities — Netlify Function
   update-inventory.js

   Merchant-only endpoint — requires a valid dashboard auth token
   (the same token issued by dashboard-login.js).

   Reads and writes inventory to Netlify Blobs under "inventory/all".

   Request body:
   {
     action:    "setStock" | "adjustStock" | "setThreshold" |
                "setAvailable" | "setMessage" | "bulkRestock",
     productId: string,    // not needed for bulkRestock
     value:     number | boolean | string
   }

   For bulkRestock:
   {
     action: "bulkRestock",
     value:  number   // amount to add to every product's stock
   }
   ============================================================= */

const { connectLambda, getStore } = require("@netlify/blobs");
const crypto       = require("crypto");

/* ── Token verification (same logic as get-orders.js) ────── */
function verifyToken(token) {
  const secret = process.env.DASHBOARD_SECRET;
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

/* ── Default entry for a product not yet in inventory ─────── */
function defaultEntry(productId) {
  return {
    productId,
    stock:             null,   /* null = unmanaged / unlimited */
    lowStockThreshold: 3,
    available:         true,
    storefrontMessage: "shelves",
    lastUpdated:       Date.now()
  };
}

/* ── Handler ─────────────────────────────────────────────── */
exports.handler = async function (event) {

  /* Only accept POST */
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  /* Verify auth token */
  const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!verifyToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorised." }) };
  }

  /* Parse request */
  let action, productId, value;
  try {
    ({ action, productId, value } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  if (!action) {
    return { statusCode: 400, body: JSON.stringify({ error: "action is required." }) };
  }

  try {
    /* V1 (Lambda-compat) functions must hand the request event to the
       Blobs client so it can pick up the site's blob credentials. */
    connectLambda(event);

    const store     = getStore("inventory");
    const raw       = await store.get("all", { type: "text" });
    const inventory = raw ? JSON.parse(raw) : {};

    if (action === "bulkRestock") {
      /* Add value to every tracked product; set stock to value for untracked ones */
      const amount = Math.max(0, Number(value) || 0);
      Object.keys(inventory).forEach((id) => {
        const entry = inventory[id];
        entry.stock       = entry.stock === null ? amount : Math.max(0, entry.stock + amount);
        entry.lastUpdated = Date.now();
      });

    } else {
      /* All other actions operate on a single product */
      if (!productId) {
        return { statusCode: 400, body: JSON.stringify({ error: "productId is required." }) };
      }

      /* Ensure the entry exists */
      if (!inventory[productId]) {
        inventory[productId] = defaultEntry(productId);
      }

      const entry = inventory[productId];

      switch (action) {

        case "setStock":
          entry.stock = value === null ? null : Math.max(0, Number(value) || 0);
          break;

        case "adjustStock":
          /* Adjust by a signed delta; null stock becomes the delta itself */
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
          entry.storefrontMessage = String(value || "shelves");
          delete entry.outOfStockMessage;
          break;

        default:
          return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
      }

      entry.lastUpdated = Date.now();
    }

    await store.set("all", JSON.stringify(inventory));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, inventory })
    };

  } catch (error) {
    console.error("update-inventory error:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "The Merchant's Supplies could not be updated." })
    };
  }
};
