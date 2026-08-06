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

    const store     = getStore("inventory");
    const raw       = await store.get("all", { type: "text" });
    const inventory = raw ? JSON.parse(raw) : {};

    orderItems.forEach(({ id, qty }) => {
      if (!id || !qty) return;

      /* If this product isn't being tracked yet, do nothing */
      const entry = inventory[id];
      if (!entry || entry.stock === null) return;

      /* Decrement, but never below zero */
      entry.stock       = Math.max(0, entry.stock - qty);
      entry.lastUpdated = Date.now();

      console.log(`stripe-webhook: decremented ${id} by ${qty} → stock now ${entry.stock}`);
    });

    await store.set("all", JSON.stringify(inventory));

    return { statusCode: 200, body: "Stock updated." };

  } catch (error) {
    console.error("stripe-webhook: failed to update inventory:", error.message);
    /* Return 200 so Stripe does not retry — log the error for investigation */
    return { statusCode: 200, body: "Stock update failed — check function logs." };
  }
};
