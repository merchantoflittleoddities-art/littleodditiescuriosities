/* =============================================================
   Little Oddities Curiosities — Netlify Function
   customer-wishlist.js

   Traveller's Satchel — saved treasures (wishlist).

   GET    → { productIds: [...] }
   POST   body: { productId } → adds it → { productIds: [...] }
   DELETE body: { productId } → removes it → { productIds: [...] }
   Requires: Authorization: Bearer <token>
   ============================================================= */

const { connectLambda } = require("@netlify/blobs");
const { authenticate, wishlistStore } = require("./_customer-lib");

async function loadWishlist(store, customerId) {
  return (await store.get(customerId, { type: "json" })) || [];
}

exports.handler = async function (event) {
  connectLambda(event);

  const customerId = authenticate(event);
  if (!customerId) {
    return { statusCode: 401, body: JSON.stringify({ error: "Please sign in again." }) };
  }

  const store = wishlistStore();

  if (event.httpMethod === "GET") {
    const productIds = await loadWishlist(store, customerId);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productIds }) };
  }

  if (event.httpMethod === "POST" || event.httpMethod === "DELETE") {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
    }

    const { productId } = body;
    if (!productId) {
      return { statusCode: 400, body: JSON.stringify({ error: "A productId is required." }) };
    }

    let productIds = await loadWishlist(store, customerId);

    if (event.httpMethod === "POST") {
      if (!productIds.includes(productId)) productIds.push(productId);
    } else {
      productIds = productIds.filter((id) => id !== productId);
    }

    await store.set(customerId, JSON.stringify(productIds));
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productIds }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
};
