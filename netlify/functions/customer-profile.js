/* =============================================================
   Little Oddities Curiosities — Netlify Function
   customer-profile.js

   Traveller's Preferences — view/update name, email, password,
   and notification preferences.

   GET  → { customer: { id, name, email, role, notificationPrefs } }
   POST body: { name?, email?, password?, notificationPrefs? }
        → { customer: { id, name, email, role, notificationPrefs } }
   Requires: Authorization: Bearer <token>

   `role` is read-only here — it is never accepted from the request
   body. Merchant accounts are only created via promote-merchant.js.
   ============================================================= */

const { connectLambda } = require("@netlify/blobs");
const {
  hashPassword,
  authenticate,
  updateCustomerRecordWithRetry,
  customerEmailsStore,
  normaliseEmail
} = require("./_customer-lib");

function publicShape(customer) {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    role: customer.role || "traveller",
    notificationPrefs: customer.notificationPrefs || { orderUpdates: true }
  };
}

exports.handler = async function (event) {
  connectLambda(event);

  const auth = await authenticate(event);
  if (!auth.ok) {
    return {
      statusCode: auth.statusCode,
      body: JSON.stringify({
        error: auth.statusCode === 503
          ? "Authentication state could not be verified. Please try again."
          : "Please sign in again."
      })
    };
  }

  const customer = auth.customer;

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
  }

  const nextEmail = email !== undefined ? normaliseEmail(email) : undefined;
  if (email !== undefined && !nextEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please provide a valid email address." }) };
  }

  if (password !== undefined && String(password).length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: "Traveller password must be at least 8 characters." }) };
  }

  const emails = customerEmailsStore();
  let updateResult;

  try {
    updateResult = await updateCustomerRecordWithRetry(customer.id, async (currentCustomer) => {
      if (name !== undefined) {
        currentCustomer.name = String(name).trim();
      }

      if (nextEmail !== undefined && nextEmail !== currentCustomer.email) {
        const existingId = await emails.get(nextEmail, { type: "text" });
        if (existingId && existingId !== currentCustomer.id) {
          const conflict = new Error("Another Traveller already uses that email address.");
          conflict.code = "EMAIL_TAKEN";
          throw conflict;
        }
        currentCustomer.email = nextEmail;
      }

      if (password !== undefined) {
        const { salt, hash } = hashPassword(password);
        currentCustomer.passwordHash = hash;
        currentCustomer.salt = salt;
      }

      if (notificationPrefs !== undefined && typeof notificationPrefs === "object") {
        currentCustomer.notificationPrefs = {
          ...currentCustomer.notificationPrefs,
          ...notificationPrefs
        };
      }

      return currentCustomer;
    });
  } catch (error) {
    if (error.code === "EMAIL_TAKEN") {
      return { statusCode: 409, body: JSON.stringify({ error: "Another Traveller already uses that email address." }) };
    }
    if (error.code === "CUSTOMER_WRITE_CONFLICT") {
      return { statusCode: 503, body: JSON.stringify({ error: "Your Preferences could not be saved right now. Please try again." }) };
    }
    throw error;
  }

  if (!updateResult.ok && updateResult.notFound) {
    return { statusCode: 404, body: JSON.stringify({ error: "That Traveller could no longer be found." }) };
  }

  const updatedCustomer = updateResult.customer;
  const previousCustomer = updateResult.previous;

  if (previousCustomer.email !== updatedCustomer.email) {
    await emails.delete(previousCustomer.email);
    await emails.set(updatedCustomer.email, updatedCustomer.id);
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer: publicShape(updatedCustomer) })
  };
};
