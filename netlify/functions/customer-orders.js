/* =============================================================
   Little Oddities Curiosities — Netlify Function
   customer-orders.js

   Merchant's Messages — a signed-in Traveller's own orders, with
   status merged in from the (Blobs-backed) order-status store and
   mapped to in-world copy, plus the treasures/order summary for
   each so travellers know which update belongs to which purchase.

   GET → { messages: [{ id, shortId, created, items, amountTotal,
                          currency, status, statusText }] }
   Requires: Authorization: Bearer <token>
   ============================================================= */

const { connectLambda } = require("@netlify/blobs");
const { authenticate, orderStatusStore } = require("./_customer-lib");
let stripeClient = null;

function getStripeClient() {
  const key = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) return null;
  if (!stripeClient) stripeClient = require("stripe")(key);
  return stripeClient;
}

const STATUS_COPY = {
  new:       "The Merchant has received your request.",
  preparing: "The Merchant is busy crafting your oddities.",
  packed:    "Relics Awaiting Delivery.",
  posted:    "Roaming the Land.",
  completed: "Your curiosities have reached their keeper."
};

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

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

  const stripe = getStripeClient();
  if (!stripe) {
    return { statusCode: 500, body: JSON.stringify({ error: "Stripe is not configured. Missing STRIPE_SECRET_KEY." }) };
  }

  try {
    const sessions = await stripe.checkout.sessions.list({
      limit: 100,
      expand: ["data.line_items"]
    });

    const statusStore = orderStatusStore();

    const ownOrders = sessions.data.filter(
      (s) => s.payment_status === "paid" &&
             (s.customer_details?.email || "").trim().toLowerCase() === customer.email
    );

    const messages = await Promise.all(ownOrders.map(async (s) => {
      const items = (s.line_items?.data || []).map((item) => ({
        name:        item.description || "Treasure",
        quantity:    item.quantity    || 1,
        unitAmount:  parseFloat(((item.amount_total / 100) / (item.quantity || 1)).toFixed(2)),
        totalAmount: parseFloat((item.amount_total / 100).toFixed(2))
      }));

      const statusRecord = await statusStore.get(s.id, { type: "json" });
      const status = statusRecord?.status || "new";

      return {
        id:          s.id,
        shortId:     s.id.slice(-8).toUpperCase(),
        created:     s.created * 1000,
        items,
        amountTotal: parseFloat((s.amount_total / 100).toFixed(2)),
        currency:    (s.currency || "gbp").toUpperCase(),
        status,
        statusText:  STATUS_COPY[status] || STATUS_COPY.new
      };
    }));

    messages.sort((a, b) => b.created - a.created);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages })
    };

  } catch (error) {
    console.error("customer-orders Stripe error:", error.message);
    return { statusCode: 500, body: JSON.stringify({ error: "Your Merchant's Messages could not be gathered. Please try again." }) };
  }
};
