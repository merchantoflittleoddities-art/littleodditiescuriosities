/* =============================================================
   Little Oddities Curiosities — Netlify Function
   stripe-webhook.js

   Listens for Stripe webhook events and automatically reduces
   stock when a checkout session is completed.

   Required Netlify environment variable:
     STRIPE_WEBHOOK_SECRET — from Stripe Dashboard → Webhooks
                             (starts with whsec_...)

   Setup in Stripe Dashboard:
     1. Go to Developers → Webhooks → Add endpoint
     2. Endpoint URL: https://yourdomain.com/.netlify/functions/stripe-webhook
     3. Events to listen for: checkout.session.completed
     4. Copy the signing secret → set as STRIPE_WEBHOOK_SECRET in Netlify

   Order items are read from session.metadata.orderItems
   which is set by create-checkout-session.js.
   Each entry is: { id: <productId>, qty: <quantity> }
   ============================================================= */

const stripe      = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { connectLambda, getStore } = require("@netlify/blobs");

const INVENTORY_KEY = "all";
const MAX_CONFLICT_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 25;
const JITTER_RETRY_DELAY_MS = 30;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextRetryDelay(attempt) {
  const exponential = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * JITTER_RETRY_DELAY_MS);
  return exponential + jitter;
}

exports.handler = async function (event) {

  /* Webhooks must be POST */
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed." };
  }

  const signature = event.headers["stripe-signature"];
  const secret    = process.env.STRIPE_WEBHOOK_SECRET;

  /* Without the webhook secret, we cannot safely verify the event */
  if (!secret) {
    console.error("stripe-webhook: STRIPE_WEBHOOK_SECRET not set. Skipping.");
    return { statusCode: 200, body: "Webhook secret not configured." };
  }

  /* Verify the Stripe signature */
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      signature,
      secret
    );
  } catch (error) {
    console.error("stripe-webhook: signature verification failed:", error.message);
    return { statusCode: 400, body: `Webhook signature error: ${error.message}` };
  }

  /* Only process completed checkout sessions */
  if (stripeEvent.type !== "checkout.session.completed") {
    return { statusCode: 200, body: "Event acknowledged." };
  }

  const session = stripeEvent.data.object;

  /* Read the order items we embedded in session metadata */
  let orderItems = [];
  try {
    orderItems = JSON.parse(session.metadata?.orderItems || "[]");
  } catch {
    console.warn("stripe-webhook: could not parse orderItems from session metadata.");
    return { statusCode: 200, body: "No orderItems in metadata." };
  }

  if (!orderItems.length) {
    return { statusCode: 200, body: "No items to process." };
  }

  /* Decrement stock in Netlify Blobs */
  try {
    /* V1 (Lambda-compat) functions must hand the request event to the
       Blobs client so it can pick up the site's blob credentials. */
    connectLambda(event);

    const store = getStore("inventory");
    const paymentRef = {
      stripeEventId: stripeEvent.id,
      stripeEventType: stripeEvent.type,
      checkoutSessionId: session.id || null,
      paymentIntentId: session.payment_intent || null,
      customerEmail: session.customer_details?.email || session.customer_email || null,
      orderItems
    };

    for (let attempt = 1; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
      const blob = await store.getWithMetadata(INVENTORY_KEY, {
        type: "text",
        consistency: "strong"
      });

      const etag = blob?.etag || null;
      const rawInventory = blob?.data;
      const inventory = rawInventory ? JSON.parse(rawInventory) : {};

      if (typeof inventory !== "object" || inventory === null || Array.isArray(inventory)) {
        throw new Error("Inventory blob is malformed.");
      }

      const shortages = [];
      for (const { id, qty } of orderItems) {
        const item = inventory[id];
        if (!item || item.stock === null) continue;

        const stock = Number(item.stock);
        if (!Number.isFinite(stock) || item.available === false || stock < qty) {
          shortages.push({
            productId: id,
            requestedQty: qty,
            availableStock: Number.isFinite(stock) ? stock : null,
            availableFlag: item.available
          });
        }
      }

      if (shortages.length) {
        console.error("stripe-webhook: manual intervention required - insufficient stock after payment", {
          ...paymentRef,
          shortages
        });
        return {
          statusCode: 200,
          body: "Insufficient stock after payment; manual intervention required."
        };
      }

      const updatedInventory = JSON.parse(JSON.stringify(inventory));
      const now = Date.now();

      for (const { id, qty } of orderItems) {
        const item = updatedInventory[id];
        if (!item || item.stock === null) continue;

        item.stock = Number(item.stock) - qty;
        item.lastUpdated = now;
      }

      const setOptions = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const write = await store.set(INVENTORY_KEY, JSON.stringify(updatedInventory), setOptions);

      if (write?.modified) {
        console.log("stripe-webhook: stock updated after payment", {
          ...paymentRef,
          conflictRetries: attempt - 1,
          newInventoryEtag: write.etag || null
        });
        return { statusCode: 200, body: "Stock updated." };
      }

      if (attempt < MAX_CONFLICT_RETRIES) {
        await delay(nextRetryDelay(attempt));
      }
    }

    console.error("stripe-webhook: inventory update conflicted too many times; retry required", {
      stripeEventId: stripeEvent.id,
      checkoutSessionId: session.id || null,
      paymentIntentId: session.payment_intent || null,
      orderItems,
      maxRetries: MAX_CONFLICT_RETRIES
    });

    return {
      statusCode: 503,
      body: "Inventory update conflict; please retry webhook delivery."
    };

  } catch (error) {
    console.error("stripe-webhook: failed to update inventory:", error.message);
    return { statusCode: 500, body: "Inventory update failed. Please retry webhook delivery." };
  }
};
