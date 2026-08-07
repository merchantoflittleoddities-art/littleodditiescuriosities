/* =============================================================
   Little Oddities Curiosities — Netlify Function
   promote-merchant.js

   One-time, owner-only setup tool: promotes an already-registered
   Traveller account to the Merchant role. Not called from any page
   in the site — the site owner runs this once (e.g. via curl) after
   registering their own Traveller account normally.

   Required Netlify environment variable:
     MERCHANT_SETUP_KEY — any long random string, known only to the
                          site owner

   POST body: { email, setupKey }
   Response:  { ok: true, customer: { id, name, email, role } }
   ============================================================= */

const crypto = require("crypto");
const { connectLambda } = require("@netlify/blobs");
const {
  customersStore,
  customerEmailsStore,
  normaliseEmail
} = require("./_customer-lib");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  connectLambda(event);

  let email, setupKey;
  try {
    ({ email, setupKey } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  const correctKey = process.env.MERCHANT_SETUP_KEY;
  if (!correctKey) {
    console.error("promote-merchant: MERCHANT_SETUP_KEY not set.");
    return { statusCode: 500, body: JSON.stringify({ error: "Merchant setup is not yet configured." }) };
  }

  let keyMatch = false;
  try {
    const inputBuf   = Buffer.from(String(setupKey || ""));
    const correctBuf = Buffer.from(String(correctKey));
    if (inputBuf.length === correctBuf.length) {
      keyMatch = crypto.timingSafeEqual(inputBuf, correctBuf);
    }
  } catch {
    keyMatch = false;
  }

  if (!keyMatch) {
    return { statusCode: 401, body: JSON.stringify({ error: "Incorrect setup key." }) };
  }

  const key = normaliseEmail(email);
  if (!key) {
    return { statusCode: 400, body: JSON.stringify({ error: "A valid email address is required." }) };
  }

  const customerId = await customerEmailsStore().get(key, { type: "text" });
  const store = customersStore();
  const customer = customerId ? await store.get(customerId, { type: "json" }) : null;

  if (!customer) {
    return { statusCode: 404, body: JSON.stringify({ error: "No Traveller account is known by that email address." }) };
  }

  customer.role = "merchant";
  await store.set(customer.id, JSON.stringify(customer));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok: true,
      customer: { id: customer.id, name: customer.name, email: customer.email, role: customer.role }
    })
  };
};
