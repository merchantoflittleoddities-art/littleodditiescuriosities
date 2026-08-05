/* =============================================================
   Little Oddities Curiosities — Netlify Function
   dashboard-login.js

   Checks the merchant's password against the DASHBOARD_PASSWORD
   environment variable and returns a signed, time-limited auth token.

   Required Netlify environment variables:
     DASHBOARD_PASSWORD — the merchant's chosen password
     DASHBOARD_SECRET   — any long random string used to sign tokens
                          (generate one at: https://generate-secret.vercel.app/64)

   Token format:
     <unix_timestamp_ms>.<sha256_hmac_hex>
   Token lifetime: 8 hours
   ============================================================= */

const crypto = require("crypto");

exports.handler = async function (event) {

  /* Only accept POST */
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed." })
    };
  }

  /* Parse the body */
  let password;
  try {
    ({ password } = JSON.parse(event.body || "{}"));
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid request." })
    };
  }

  const correctPassword = process.env.DASHBOARD_PASSWORD;
  const secret          = process.env.DASHBOARD_SECRET;

  /* Guard: environment variables must be configured */
  if (!correctPassword || !secret) {
    console.error("dashboard-login: DASHBOARD_PASSWORD or DASHBOARD_SECRET not set.");
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Dashboard is not yet configured. Please set DASHBOARD_PASSWORD and DASHBOARD_SECRET in your Netlify environment variables."
      })
    };
  }

  /* Constant-time string comparison to prevent timing attacks */
  let passwordMatch = false;
  try {
    const inputBuf    = Buffer.from(String(password      || ""));
    const correctBuf  = Buffer.from(String(correctPassword));
    if (inputBuf.length === correctBuf.length) {
      passwordMatch = crypto.timingSafeEqual(inputBuf, correctBuf);
    }
  } catch {
    passwordMatch = false;
  }

  if (!passwordMatch) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Incorrect key. The ledger remains closed." })
    };
  }

  /* Build a signed token: timestamp.hmac */
  const timestamp = Date.now().toString();
  const hmac      = crypto
    .createHmac("sha256", secret)
    .update(timestamp)
    .digest("hex");

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: `${timestamp}.${hmac}` })
  };
};
