/* =============================================================
   Little Oddities Curiosities — Netlify Function
   customer-register.js

   Creates a new Traveller account ("Become a Recognised Traveller").

   Public registration can only ever create Traveller accounts —
   `role` is always hardcoded here and never read from the request
   body. Merchant accounts are only created by promoting an existing
   Traveller via promote-merchant.js.

   POST body: { name, email, password }
   Response:  { token, customer: { id, name, email, role } }
   ============================================================= */

const crypto = require("crypto");
const { connectLambda } = require("@netlify/blobs");
const {
  hashPassword,
  createToken,
  customersStore,
  customerEmailsStore,
  normaliseEmail
} = require("./_customer-lib");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  connectLambda(event);

  let name, email, password;
  try {
    ({ name, email, password } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  name = String(name || "").trim();
  const key = normaliseEmail(email);

  if (!name || !key || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: "Traveller name, email address, and Traveller password are all required." }) };
  }
  if (String(password).length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: "Traveller password must be at least 8 characters." }) };
  }

  const emails = customerEmailsStore();
  const existingId = await emails.get(key, { type: "text" });
  if (existingId) {
    return { statusCode: 409, body: JSON.stringify({ error: "A Traveller is already known by that email address." }) };
  }

  const { salt, hash } = hashPassword(password);
  const customer = {
    id: crypto.randomUUID(),
    name,
    email: key,
    passwordHash: hash,
    salt,
    role: "traveller",
    notificationPrefs: { orderUpdates: true },
    createdAt: new Date().toISOString()
  };

  await customersStore().set(customer.id, JSON.stringify(customer));
  await emails.set(key, customer.id);

  const token = createToken(customer.id);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      customer: { id: customer.id, name: customer.name, email: customer.email, role: customer.role }
    })
  };
};
