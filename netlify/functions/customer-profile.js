/* =============================================================
   Little Oddities Curiosities — Netlify Function
   customer-profile.js

   Traveller's Preferences — view/update name, email, password,
   and notification preferences.

   GET  → { customer: { id, name, email, notificationPrefs } }
   POST body: { name?, email?, password?, notificationPrefs? }
        → { customer: { id, name, email, notificationPrefs } }
   Requires: Authorization: Bearer <token>
   ============================================================= */

const { connectLambda } = require("@netlify/blobs");
const {
  hashPassword,
  authenticate,
  customersStore,
  customerEmailsStore,
  normaliseEmail
} = require("./_customer-lib");

function publicShape(customer) {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    notificationPrefs: customer.notificationPrefs || { orderUpdates: true }
  };
}

exports.handler = async function (event) {
  connectLambda(event);

  const customerId = authenticate(event);
  if (!customerId) {
    return { statusCode: 401, body: JSON.stringify({ error: "Please sign in again." }) };
  }

  const store = customersStore();
  const customer = await store.get(customerId, { type: "json" });
  if (!customer) {
    return { statusCode: 404, body: JSON.stringify({ error: "That Traveller could no longer be found." }) };
  }

  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer: publicShape(customer) })
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  const { name, email, password, notificationPrefs } = body;

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) {
      return { statusCode: 400, body: JSON.stringify({ error: "Traveller Name cannot be empty." }) };
    }
    customer.name = trimmed;
  }

  if (email !== undefined) {
    const newKey = normaliseEmail(email);
    if (!newKey) {
      return { statusCode: 400, body: JSON.stringify({ error: "Please provide a valid email address." }) };
    }
    if (newKey !== customer.email) {
      const emails = customerEmailsStore();
      const existingId = await emails.get(newKey, { type: "text" });
      if (existingId && existingId !== customer.id) {
        return { statusCode: 409, body: JSON.stringify({ error: "Another Traveller already uses that email address." }) };
      }
      await emails.delete(customer.email);
      await emails.set(newKey, customer.id);
      customer.email = newKey;
    }
  }

  if (password !== undefined) {
    if (String(password).length < 8) {
      return { statusCode: 400, body: JSON.stringify({ error: "Traveller password must be at least 8 characters." }) };
    }
    const { salt, hash } = hashPassword(password);
    customer.passwordHash = hash;
    customer.salt = salt;
  }

  if (notificationPrefs !== undefined && typeof notificationPrefs === "object") {
    customer.notificationPrefs = {
      ...customer.notificationPrefs,
      ...notificationPrefs
    };
  }

  await store.set(customer.id, JSON.stringify(customer));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer: publicShape(customer) })
  };
};
