/* =============================================================
   Little Oddities Curiosities — Netlify Function
   get-order-status.js

   Merchant-only endpoint — requires a valid dashboard auth token
   (the same token issued by dashboard-login.js). Returns the full
   order-status map so the Merchant's Ledger can render fulfilment
   status without relying on the merchant's own browser storage.

   Response: { statuses: { [stripeSessionId]: { status, updatedAt } } }
   ============================================================= */

const { connectLambda, getStore } = require("@netlify/blobs");
const crypto = require("crypto");

/* ── Token verification (same logic as get-orders.js / update-inventory.js) ── */
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

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!verifyToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorised." }) };
  }

  try {
    connectLambda(event);
    const store = getStore("order-status");

    const { blobs } = await store.list();
    const statuses = {};
    await Promise.all(blobs.map(async ({ key }) => {
      const record = await store.get(key, { type: "json" });
      if (record) statuses[key] = record;
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statuses })
    };

  } catch (error) {
    console.error("get-order-status error:", error.message);
    return { statusCode: 500, body: JSON.stringify({ error: "Order status could not be retrieved." }) };
  }
};
