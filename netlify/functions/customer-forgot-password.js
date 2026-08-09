/* =============================================================
   Little Oddities Curiosities — Netlify Function
   customer-forgot-password.js

   "Lost your Traveller's code?" — issues a one-hour reset token and
   delivers the link via Resend without exposing reset credentials in
   API responses.

   POST body: { email }
   Response:  { message } — always generic to avoid account enumeration.
   ============================================================= */

const crypto = require("crypto");
const { Resend } = require("resend");
const { connectLambda } = require("@netlify/blobs");
const {
  customerEmailsStore,
  resetTokensStore,
  normaliseEmail,
  hashSha256Hex,
  makeResetTokenKeyFromHash,
  checkAndBumpResetThrottle,
  updateCustomerRecordWithRetry
} = require("./_customer-lib");

const RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000; /* 1 hour */
const FORGOT_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_THROTTLE_BLOCK_MS = 15 * 60 * 1000;
const FORGOT_THROTTLE_IP_MAX = 8;
const FORGOT_THROTTLE_GLOBAL_MAX = 1500;
const RESEND_FROM = "no-reply@mail.littleodditiescuriosities.co.uk";
const GENERIC_SUCCESS = {
  message: "If an account exists for that email, you will receive a password reset link shortly."
};

function successResponse() {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(GENERIC_SUCCESS)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  connectLambda(event);

  const throttle = await checkAndBumpResetThrottle(event, {
    scope: "forgot",
    ipMax: FORGOT_THROTTLE_IP_MAX,
    globalMax: FORGOT_THROTTLE_GLOBAL_MAX,
    windowMs: FORGOT_THROTTLE_WINDOW_MS,
    blockMs: FORGOT_THROTTLE_BLOCK_MS
  });
  if (!throttle.ok) {
    return successResponse();
  }

  let email;
  try {
    ({ email } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  const key = normaliseEmail(email);
  if (!key) {
    return { statusCode: 400, body: JSON.stringify({ error: "An email address is required." }) };
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.error("customer-forgot-password: RESEND_API_KEY is not configured.");
    return { statusCode: 503, body: JSON.stringify({ error: "Password reset is temporarily unavailable. Please try again later." }) };
  }

  let customerId;
  try {
    customerId = await customerEmailsStore().get(key, { type: "text" });
  } catch (error) {
    console.error("customer-forgot-password: email lookup failed:", error.message);
    return successResponse();
  }

  if (!customerId) {
    return successResponse();
  }

  const now = Date.now();
  let update;
  try {
    update = await updateCustomerRecordWithRetry(customerId, (customer) => {
      const currentNonce = Number(customer.passwordResetNonce) || 0;
      customer.passwordResetNonce = currentNonce + 1;
      customer.passwordResetRequestedAtMs = now;
      return customer;
    });
  } catch (error) {
    console.error("customer-forgot-password: could not update customer reset nonce:", error.message);
    return successResponse();
  }

  if (!update.ok || !update.customer) {
    return successResponse();
  }

  const resetNonce = Number(update.customer.passwordResetNonce) || 0;
  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetTokenHash = hashSha256Hex(resetToken);
  const resetTokenKey = makeResetTokenKeyFromHash(resetTokenHash);
  const resetRecord = {
    version: 2,
    customerId,
    resetNonce,
    issuedAtMs: now,
    expiresMs: now + RESET_TOKEN_LIFETIME_MS
  };

  try {
    await resetTokensStore().setJSON(resetTokenKey, resetRecord);
  } catch (error) {
    console.error("customer-forgot-password: failed to store reset token:", error.message);
    return successResponse();
  }

  const siteUrl = process.env.URL || "";
  const resetUrl = `${siteUrl}/reset-password.html?token=${resetToken}`;

  const resend = new Resend(resendApiKey);
  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: key,
      subject: "Reset your Little Oddities Curiosities password",
      text: [
        "A request was made to reset your Little Oddities Curiosities password.",
        "",
        `Use this link within 1 hour: ${resetUrl}`,
        "",
        "If you did not request this, you can ignore this email."
      ].join("\n")
    });
  } catch (error) {
    try {
      await resetTokensStore().delete(resetTokenKey);
    } catch (cleanupError) {
      console.error("customer-forgot-password: failed to clean up reset token after email failure:", cleanupError.message);
      return { statusCode: 503, body: JSON.stringify({ error: "Password reset is temporarily unavailable. Please try again later." }) };
    }
    console.error("customer-forgot-password: Resend delivery failed:", error.message);
  }

  return successResponse();
};
