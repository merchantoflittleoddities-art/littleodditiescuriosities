/* =============================================================
   Little Oddities Curiosities — Netlify Function
   get-inventory.js

   Public endpoint — no authentication required.
   Returns the current inventory for all products so the
   customer-facing site can show out-of-stock states.

   Inventory is stored as a single JSON object in Netlify Blobs
   under the key "inventory/all".

   Shape of each inventory entry:
   {
     productId:         string,   // matches id in catalogue.json
     stock:             number | null,  // null = unlimited (unmanaged)
     lowStockThreshold: number,   // default 3
     available:         boolean,  // false = manually disabled
     outOfStockMessage: string,   // "roaming" | "returning" | "bespoke"
     lastUpdated:       number    // Unix ms timestamp
   }

   If no inventory has been saved yet, returns an empty object
   so all products appear available by default.
   ============================================================= */

const { getStore } = require("@netlify/blobs");

exports.handler = async function () {
  try {
    const store     = getStore("inventory");
    const raw       = await store.get("all", { type: "text" });
    const inventory = raw ? JSON.parse(raw) : {};

    return {
      statusCode: 200,
      headers: {
        "Content-Type":                "application/json",
        "Cache-Control":               "no-store",           /* always fresh */
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ inventory })
    };

  } catch (error) {
    console.error("get-inventory error:", error.message);
    /* On failure, return empty inventory — products stay available */
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inventory: {} })
    };
  }
};
