/* =============================================================
   Little Oddities Curiosities — Netlify Function
   customer-login.js

   Signs in an existing Traveller ("Rediscover the Cabinet").

   POST body: { email, password }
   Response:  { token, customer: { id, name, email, role } }
   ============================================================= */

const { connectLambda } = require("@netlify/blobs");
const {
  verifyPassword,
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

  let email, password;
  try {
    ({ email, password } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  const key = normaliseEmail(email);
  if (!key || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: "Email address and Traveller password are required." }) };
  }

  const customerId = await customerEmailsStore().get(key, { type: "text" });
  const customer = customerId
    ? await customersStore().get(customerId, { type: "json" })
    : null;

  if (!customer || !verifyPassword(password, customer.salt, customer.passwordHash)) {
    return { statusCode: 401, body: JSON.stringify({ error: "That email address and Traveller password do not match our records." }) };
  }

  const token = createToken(customer.id);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      customer: { id: customer.id, name: customer.name, email: customer.email, role: customer.role || "traveller" }
    })
  };
};
