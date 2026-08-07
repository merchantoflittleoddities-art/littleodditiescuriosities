/* =============================================================
   Little Oddities Curiosities — Netlify Function
   customer-forgot-password.js

   "Lost your Traveller's code?" — generates a one-hour reset token.

   No email provider is configured anywhere in this repo, so the
   reset link is returned directly in the response and shown to the
   traveller on-screen in an in-world "a note arrives" card. To wire
   up a real provider later (e.g. Resend), send the link to
   `email` instead of returning it, guarded by an env var such as
   RESET_EMAIL_PROVIDER_API_KEY.

   POST body: { email }
   Response:  { resetUrl } — present only if the email matches an account.
               Always 200 regardless, so the endpoint can't be used to
               probe which addresses have accounts.
   ============================================================= */

const crypto = require("crypto");
const { connectLambda } = require("@netlify/blobs");
const {
  customerEmailsStore,
  resetTokensStore,
  normaliseEmail
} = require("./_customer-lib");

const RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000; /* 1 hour */

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  connectLambda(event);

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

  const customerId = await customerEmailsStore().get(key, { type: "text" });

  if (!customerId) {
    /* Same response whether or not the account exists, to avoid leaking which emails are registered */
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) };
  }

  const resetToken = crypto.randomBytes(32).toString("hex");
  await resetTokensStore().set(resetToken, JSON.stringify({
    customerId,
    expires: Date.now() + RESET_TOKEN_LIFETIME_MS
  }));

  const siteUrl = process.env.URL || "";
  const resetUrl = `${siteUrl}/reset-password.html?token=${resetToken}`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resetUrl })
  };
};
