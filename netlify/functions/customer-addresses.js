/* =============================================================
   Little Oddities Curiosities — Netlify Function
   customer-addresses.js

   Traveller's Map — saved delivery addresses ("Landmarks").

   GET    → { addresses: [...] }
   POST   body: { address: {label, line1, line2, city, region, postcode, country, isDefault} , id? }
          Creates a new Landmark, or updates one if `id` is supplied.
          → { addresses: [...] }
   DELETE body: { id }
          → { addresses: [...] }
   Requires: Authorization: Bearer <token>
   ============================================================= */

const crypto = require("crypto");
const { connectLambda } = require("@netlify/blobs");
const { authenticate, addressesStore } = require("./_customer-lib");

async function loadAddresses(store, customerId) {
  return (await store.get(customerId, { type: "json" })) || [];
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

  const customerId = auth.customerId;

  const store = addressesStore();

  if (event.httpMethod === "GET") {
    const addresses = await loadAddresses(store, customerId);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses }) };
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
    }

    const { id, address } = body;
    if (!address || !address.line1 || !address.city || !address.postcode || !address.country) {
      return { statusCode: 400, body: JSON.stringify({ error: "A Landmark needs at least an address line, city, postcode, and country." }) };
    }

    const addresses = await loadAddresses(store, customerId);

    const record = {
      id: id || crypto.randomUUID(),
      label: String(address.label || "").trim() || "Landmark",
      line1: String(address.line1).trim(),
      line2: String(address.line2 || "").trim(),
      city: String(address.city).trim(),
      region: String(address.region || "").trim(),
      postcode: String(address.postcode).trim(),
      country: String(address.country).trim(),
      isDefault: Boolean(address.isDefault)
    };

    if (record.isDefault) {
      addresses.forEach((a) => { a.isDefault = false; });
    }

    const existingIndex = addresses.findIndex((a) => a.id === record.id);
    if (existingIndex >= 0) {
      addresses[existingIndex] = record;
    } else {
      addresses.push(record);
    }

    await store.set(customerId, JSON.stringify(addresses));
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses }) };
  }

  if (event.httpMethod === "DELETE") {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
    }

    const { id } = body;
    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ error: "A Landmark id is required." }) };
    }

    const addresses = (await loadAddresses(store, customerId)).filter((a) => a.id !== id);
    await store.set(customerId, JSON.stringify(addresses));
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
};
