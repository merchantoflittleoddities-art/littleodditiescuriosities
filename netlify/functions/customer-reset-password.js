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
  customersStore,
  resetTokensStore
} = require("./_customer-lib");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  connectLambda(event);

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
  const record = await resetStore.get(token, { type: "json" });

  if (!record || Date.now() > record.expires) {
    return { statusCode: 400, body: JSON.stringify({ error: "That reset link has expired or is no longer valid. Please request a new one." }) };
  }

  const customersDb = customersStore();
  const customer = await customersDb.get(record.customerId, { type: "json" });
  if (!customer) {
    return { statusCode: 404, body: JSON.stringify({ error: "That Traveller could no longer be found." }) };
  }

  const { salt, hash } = hashPassword(password);
  customer.passwordHash = hash;
  customer.salt = salt;
  await customersDb.set(customer.id, JSON.stringify(customer));
  await resetStore.delete(token);

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
