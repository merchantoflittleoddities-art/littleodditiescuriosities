/* =============================================================
   Little Oddities Curiosities — Netlify Function
   get-orders.js

   Verifies the merchant's auth token, then fetches all paid
   Stripe Checkout Sessions (with expanded line items) and
   returns normalised order data for the Merchant's Ledger.

   Required Netlify environment variables:
     STRIPE_SECRET_KEY — Stripe live secret key (already configured)
     DASHBOARD_SECRET  — same value used in dashboard-login.js

   Token is sent as:  Authorization: Bearer <token>
   ============================================================= */

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const crypto = require("crypto");

/* ── Token verification ───────────────────────────────────── */

/** Returns true if the Bearer token is valid and less than 8 hours old */
function verifyToken(token) {
  const secret = process.env.DASHBOARD_SECRET;
  if (!token || !secret) return false;

  /* Token format: <timestamp_ms>.<sha256_hmac_hex> */
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const providedHmac = token.substring(dotIndex + 1);

  /* Compute expected HMAC */
  const expectedHmac = crypto
    .createHmac("sha256", secret)
    .update(timestamp)
    .digest("hex");

  /* Timing-safe comparison — both values must be exactly 64 hex chars (SHA-256) */
  try {
    const a = Buffer.from(providedHmac, "hex");
    const b = Buffer.from(expectedHmac, "hex");
    if (a.length !== 32 || b.length !== 32) return false; /* 32 bytes = 64 hex chars */
    if (!crypto.timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }

  /* Check token age */
  const age = Date.now() - parseInt(timestamp, 10);
  return age >= 0 && age < 8 * 60 * 60 * 1000; /* 8 hours */
}

/* ── Handler ─────────────────────────────────────────────── */

exports.handler = async function (event) {

  /* Only accept GET */
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed." })
    };
  }

  /* Verify auth token */
  const authHeader = (event.headers["authorization"] || event.headers["Authorization"] || "");
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!verifyToken(token)) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorised. Please log in again." })
    };
  }

  /* Guard: Stripe must be configured */
  if (!process.env.STRIPE_SECRET_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Stripe is not configured." })
    };
  }

  try {
    /*
     * Fetch the 100 most recent checkout sessions.
     * Expand line_items so we get purchased products in one request.
     * For shops with >100 orders, add pagination using `starting_after`.
     */
    const sessions = await stripe.checkout.sessions.list({
      limit: 100,
      expand: ["data.line_items"]
    });

    /* Normalise each paid session into a clean order object */
    const orders = sessions.data
      .filter((s) => s.payment_status === "paid")
      .map((s) => {
        /* Line items — description holds the product name we set in create-checkout-session.js */
        const items = (s.line_items?.data || []).map((item) => ({
          name:        item.description || "Treasure",
          quantity:    item.quantity    || 1,
          unitAmount:  parseFloat(((item.amount_total / 100) / (item.quantity || 1)).toFixed(2)),
          totalAmount: parseFloat((item.amount_total / 100).toFixed(2))
        }));

        /* Shipping address — try shipping_details first, then customer_details */
        const addr = s.shipping_details?.address || s.customer_details?.address || null;
        const shippingAddress = addr
          ? [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country]
              .filter(Boolean)
              .join(", ")
          : null;

        return {
          id:               s.id,
          shortId:          s.id.slice(-8).toUpperCase(),
          paymentIntentId:  s.payment_intent || null,
          customerName:     s.customer_details?.name  || "Unknown Traveller",
          customerEmail:    s.customer_details?.email || "Unknown",
          shippingAddress,
          shippingMethod:   s.metadata?.shippingLabel || null,
          shippingAmount:   parseFloat(s.metadata?.shippingAmount || "0"),
          items,
          amountTotal:      parseFloat((s.amount_total / 100).toFixed(2)),
          currency:         (s.currency || "gbp").toUpperCase(),
          paymentStatus:    s.payment_status,
          created:          s.created * 1000 /* Unix seconds → ms for JS Date */
        };
      });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orders })
    };

  } catch (error) {
    console.error("get-orders Stripe error:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "The ledger could not be consulted. Please try again." })
    };
  }
};
