/* =============================================================
   Little Oddities Curiosities — Netlify Function
   customer-reset-password.js

   Consumes a reset token from customer-forgot-password.js and sets
   a new Traveller password.

   POST body: { token, password }
   Response:  { token: <new session token>, customer: { id, name, email } }
   ============================================================= */

const { connectLambda } = require("@netlify/blobs");
const {
  hashPassword,
  createToken,
  updateCustomerRecordWithRetry,
  resetTokensStore,
  hashSha256Hex,
  makeResetTokenKeyFromHash,
  checkAndBumpResetThrottle
} = require("./_customer-lib");

const CONSUME_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const CONSUME_THROTTLE_BLOCK_MS = 15 * 60 * 1000;
const CONSUME_THROTTLE_IP_MAX = 25;
const CONSUME_THROTTLE_GLOBAL_MAX = 2500;

function invalidTokenResponse() {
  return { statusCode: 400, body: JSON.stringify({ error: "That reset link has expired or is no longer valid. Please request a new one." }) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  connectLambda(event);

  const throttle = await checkAndBumpResetThrottle(event, {
    scope: "consume",
    ipMax: CONSUME_THROTTLE_IP_MAX,
    globalMax: CONSUME_THROTTLE_GLOBAL_MAX,
    windowMs: CONSUME_THROTTLE_WINDOW_MS,
    blockMs: CONSUME_THROTTLE_BLOCK_MS
  });
  if (!throttle.ok) {
    return { statusCode: 429, body: JSON.stringify({ error: "Too many reset attempts. Please try again later." }) };
  }

  let token, password;
  try {
    ({ token, password } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  if (!token || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: "A reset token and new Traveller password are required." }) };
  }
  if (String(password).length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: "Traveller password must be at least 8 characters." }) };
  }

  const resetStore = resetTokensStore();
  const tokenHash = hashSha256Hex(token);
  const tokenKey = makeResetTokenKeyFromHash(tokenHash);

  let record;
  try {
    record = await resetStore.get(tokenKey, { type: "json" });
  } catch (error) {
    console.error("customer-reset-password: failed to read reset token:", error.message);
    return { statusCode: 503, body: JSON.stringify({ error: "Password reset is temporarily unavailable. Please try again." }) };
  }

  const expiresMs = Number(record?.expiresMs);
  if (!record || record.version !== 2 || !Number.isFinite(expiresMs) || Date.now() > expiresMs) {
    return invalidTokenResponse();
  }

  let updateResult;
  const now = Date.now();
  try {
    updateResult = await updateCustomerRecordWithRetry(record.customerId, (customer) => {
      const currentResetNonce = Number(customer.passwordResetNonce) || 0;
      const recordNonce = Number(record.resetNonce);

      if (!Number.isFinite(recordNonce) || recordNonce !== currentResetNonce) {
        const staleToken = new Error("Reset token nonce no longer matches active customer reset nonce.");
        staleToken.code = "RESET_TOKEN_STALE";
        throw staleToken;
      }

      const { salt, hash } = hashPassword(password);
      customer.passwordHash = hash;
      customer.salt = salt;

      const existingCutoff = Number(customer.tokenRevokedAfterMs);
      const tokenRevokedAfterMs = Number.isFinite(existingCutoff)
        ? Math.max(existingCutoff, now)
        : now;

      customer.tokenRevokedAfterMs = tokenRevokedAfterMs;
      customer.passwordResetNonce = currentResetNonce + 1;
      return customer;
    });
  } catch (error) {
    if (error.code === "RESET_TOKEN_STALE") {
      return invalidTokenResponse();
    }
    if (error.code === "CUSTOMER_WRITE_CONFLICT") {
      return { statusCode: 503, body: JSON.stringify({ error: "Your password could not be reset right now. Please try again." }) };
    }
    throw error;
  }

  if (!updateResult.ok && updateResult.notFound) {
    return { statusCode: 404, body: JSON.stringify({ error: "That Traveller could no longer be found." }) };
  }

  const customer = updateResult.customer;
  const cutoff = Number(customer.tokenRevokedAfterMs) || 0;

  try {
    await resetStore.delete(tokenKey);
  } catch (error) {
    console.error("customer-reset-password: failed to delete consumed token:", error.message);
  }

  while (Date.now() <= cutoff) {
    /* Ensure post-reset token timestamp is strictly later than revocation cutoff. */
  }

  const sessionToken = createToken(customer.id);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: sessionToken,
      customer: { id: customer.id, name: customer.name, email: customer.email }
    })
  };
};
