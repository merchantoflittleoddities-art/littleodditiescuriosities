/* =============================================================
   Little Oddities Curiosities — Netlify Function
   update-order-status.js

   Merchant-only endpoint — requires a valid dashboard auth token
   (the same token issued by dashboard-login.js). Sets the
   fulfilment status for one order, replacing the dashboard's old
   localStorage-only FULFILMENT_KEY so customers can see it too.

   Request body: { orderId: string, status: "new"|"preparing"|"packed"|"posted"|"completed" }
   Response:     { ok: true, status: { status, updatedAt } }
   ============================================================= */

const { connectLambda, getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const VALID_STATUSES = ["new", "preparing", "packed", "posted", "completed"];

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
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!verifyToken(token)) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorised." }) };
  }

  let orderId, status;
  try {
    ({ orderId, status } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  if (!orderId || !VALID_STATUSES.includes(status)) {
    return { statusCode: 400, body: JSON.stringify({ error: "A valid orderId and status are required." }) };
  }

  try {
    connectLambda(event);
    const store = getStore("order-status");

    const record = { status, updatedAt: Date.now() };
    await store.set(orderId, JSON.stringify(record));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, status: record })
    };

  } catch (error) {
    console.error("update-order-status error:", error.message);
    return { statusCode: 500, body: JSON.stringify({ error: "Order status could not be updated." }) };
  }
};
