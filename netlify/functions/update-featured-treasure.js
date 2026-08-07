/* =============================================================
   Little Oddities Curiosities — Netlify Function
   update-featured-treasure.js

   Merchant-only endpoint — requires a valid dashboard auth token.

   Writes full Featured Treasure JSON payload to Netlify Blobs
   (store: "featured-treasure", key: "data").

   Enforces rule: Only one Featured Treasure may be published at any time.
   If a feature is being set to "published", all other features will be set
   to "draft".
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

  /* Enforce: Only one Featured Treasure may be published at any time */
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
    connectLambda(event);

    const store = getStore("featured-treasure");
    await store.set("data", JSON.stringify(payload));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, data: payload })
    };
  } catch (error) {
    console.error("update-featured-treasure error:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Featured Treasure could not be saved." })
    };
  }
};
