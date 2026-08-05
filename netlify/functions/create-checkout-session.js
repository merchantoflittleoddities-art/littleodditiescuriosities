/* =============================================================
   Little Oddities Curiosities — Netlify Function
   create-checkout-session.js

   Receives the cart from the browser, creates a Stripe Checkout
   Session, and returns the hosted payment URL.

   Environment variable required (set in Netlify dashboard):
     STRIPE_SECRET_KEY  — your Stripe live secret key (sk_live_...)

   The browser sends:
     {
       lineItems: [{ productId, name, price, quantity }],  // price is decimal GBP, e.g. 4.50
       shippingMethod: "royal-courier" | "royal-courier-tracked" | "free-journey",
       successUrl: "https://yoursite.com/success.html",
       cancelUrl:  "https://yoursite.com/checkout.html"
     }

   productId is stored in session metadata so the stripe-webhook
   function can automatically decrement inventory on payment.

   Stripe requires unit_amount in the smallest currency unit (pence for GBP),
   so each price is multiplied by 100 and rounded.
   ============================================================= */

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const FREE_SHIPPING_THRESHOLD = 30;
const SHIPPING_OPTIONS = {
  "royal-courier": {
    id: "royal-courier",
    name: "Royal Courier",
    price: 2.99
  },
  "royal-courier-tracked": {
    id: "royal-courier-tracked",
    name: "Royal Courier Tracked",
    price: 3.99
  },
  "free-journey": {
    id: "free-journey",
    name: "Free Journey",
    price: 0
  }
};

exports.handler = async function (event) {

  /* Only allow POST */
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed." })
    };
  }

  /* Parse the request body */
  let lineItems, shippingMethod, successUrl, cancelUrl;
  try {
    ({ lineItems, shippingMethod, successUrl, cancelUrl } = JSON.parse(event.body));
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid request body." })
    };
  }

  /* Validate that line items were sent */
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Cart is empty." })
    };
  }

  const subtotal = lineItems.reduce((sum, item) => {
    return sum + (Number(item.price) || 0) * (Number(item.quantity) || 0);
  }, 0);

  const shippingOption = subtotal >= FREE_SHIPPING_THRESHOLD
    ? SHIPPING_OPTIONS["free-journey"]
    : SHIPPING_OPTIONS[shippingMethod];

  if (!shippingOption) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Please choose a valid shipping option." })
    };
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],

      /* Convert each cart item into a Stripe line item */
      line_items: [
        ...lineItems.map((item) => ({
          price_data: {
            currency: "gbp",
            product_data: {
              name: item.name
            },
            /* Stripe expects pence — multiply decimal pounds by 100 */
            unit_amount: Math.round(item.price * 100)
          },
          quantity: item.quantity
        })),
        ...(shippingOption.price > 0
          ? [{
              price_data: {
                currency: "gbp",
                product_data: {
                  name: shippingOption.name
                },
                unit_amount: Math.round(shippingOption.price * 100)
              },
              quantity: 1
            }]
          : [])
      ],

      mode: "payment",
      success_url: successUrl,
      cancel_url:  cancelUrl,

      /*
       * Embed product IDs and quantities in session metadata so the
       * stripe-webhook function can decrement inventory automatically.
       * Stripe metadata values must be strings — we JSON-encode the array.
       */
      metadata: {
        orderItems: JSON.stringify(
          lineItems
            .filter((item) => item.productId)
            .map((item) => ({ id: item.productId, qty: item.quantity }))
        ),
        shippingMethod: shippingOption.id,
        shippingLabel: shippingOption.name,
        shippingAmount: shippingOption.price.toFixed(2)
      }
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url })
    };

  } catch (error) {
    console.error("Stripe error:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Payment session could not be created. Please try again." })
    };
  }
};
