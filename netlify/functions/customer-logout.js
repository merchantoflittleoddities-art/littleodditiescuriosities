const { connectLambda } = require("@netlify/blobs");
const {
  authenticate,
  updateCustomerRecordWithRetry
} = require("./_customer-lib");

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...cors() },
    body: JSON.stringify(payload)
  };
}

function error(statusCode, message) {
  return json(statusCode, { error: message });
}

exports.handler = async function (event) {
  connectLambda(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors() };
  }

  if (event.httpMethod !== "POST") {
    return error(405, "Method not allowed.");
  }

  const auth = await authenticate(event);
  if (!auth.ok) {
    return auth.statusCode === 503
      ? error(503, "Authentication state could not be verified. Please try again.")
      : error(401, "Please sign in again.");
  }

  const now = Date.now();
  const customerId = auth.customerId;

  try {
    const update = await updateCustomerRecordWithRetry(customerId, (customer) => {
      const existing = Number(customer.tokenRevokedAfterMs);
      const tokenRevokedAfterMs = Number.isFinite(existing)
        ? Math.max(existing, now)
        : now;

      return {
        ...customer,
        tokenRevokedAfterMs
      };
    });

    if (!update.ok && update.notFound) {
      return error(401, "Please sign in again.");
    }
  } catch (err) {
    console.error("customer-logout: failed to persist token revocation:", err.message);
    return error(503, "Could not persist logout state. Please try again.");
  }

  return json(200, { ok: true });
};
