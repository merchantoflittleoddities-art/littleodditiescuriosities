/* =============================================================
   Little Oddities Curiosities — Netlify Function
   update-desk-entries.js

   Merchant-only endpoint — requires a valid dashboard auth token.

   Writes full Merchant's Journal / From the Merchant's Desk payload
   to Netlify Blobs (store: "desk-entries", key: "data").
   ============================================================= */

const { connectLambda, getStore } = require("@netlify/blobs");
const crypto                       = require("crypto");

/* Token verification */
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

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  if (!payload || typeof payload !== "object") {
    return { statusCode: 400, body: JSON.stringify({ error: "Payload required." }) };
  }

  try {
    connectLambda(event);

    const store = getStore("desk-entries");
    await store.set("data", JSON.stringify(payload));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, data: payload })
    };
  } catch (error) {
    console.error("update-desk-entries error:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Journal entries could not be saved." })
    };
  }
};
