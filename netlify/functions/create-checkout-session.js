/* =============================================================
   Little Oddities Curiosities — Netlify Function
   create-checkout-session.js

   Receives a cart request from the browser, resolves all pricing
   from trusted server-side data, creates a Stripe Checkout Session,
   and returns the hosted payment URL.

   Environment variable required (set in Netlify dashboard):
     STRIPE_SECRET_KEY  — your Stripe live secret key (sk_live_...)

   The browser sends purchase intent only:
     {
       lineItems: [{ productId, quantity }],
       shippingMethod: "royal-courier" | "royal-courier-tracked" | "free-journey"
     }

   productId and quantity are stored in session metadata so the
   stripe-webhook function can automatically decrement inventory on payment.

   Stripe requires unit_amount in the smallest currency unit (pence for GBP),
   so all prices are resolved and converted server-side.
   ============================================================= */

const fs = require("fs");
const path = require("path");
let stripeClient = null;

function getStripeClient() {
  const key = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) return null;
  if (!stripeClient) stripeClient = require("stripe")(key);
  return stripeClient;
}

const FREE_SHIPPING_THRESHOLD_PENCE = 3000;
const MAX_QUANTITY_PER_ITEM = 99;
const MAX_TOTAL_QUANTITY = 99;

const SHIPPING_OPTIONS = {
  "royal-courier": {
    id: "royal-courier",
    name: "Royal Courier",
    pricePence: 299
  },
  "royal-courier-tracked": {
    id: "royal-courier-tracked",
    name: "Royal Courier Tracked",
    pricePence: 399
  },
  "free-journey": {
    id: "free-journey",
    name: "Free Journey",
    pricePence: 0
  }
};

const DATA_ROOT = path.join(__dirname, "..", "..", "data");

function readJsonFile(fileName, fallback) {
  try {
    const filePath = path.join(DATA_ROOT, fileName);
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function asArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.products)) return value.products;
  if (value && Array.isArray(value.tiers)) return value.tiers;
  return fallback;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeOrigin(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry ? String(entry[1] || "") : "";
}

function getAllowedRedirectOrigins() {
  const sources = [
    process.env.CHECKOUT_ALLOWED_ORIGINS,
    process.env.CUSTOM_DOMAIN_URL,
    process.env.URL
  ];

  return [...new Set(
    sources
      .filter(Boolean)
      .flatMap((value) => String(value).split(","))
      .map((value) => normalizeOrigin(value))
      .filter(Boolean)
  )];
}

function getRedirectOrigin(event) {
  const allowedOrigins = getAllowedRedirectOrigins();
  if (!allowedOrigins.length) {
    return null;
  }

  const requestOrigin = normalizeOrigin(getHeader(event.headers, "origin"))
    || normalizeOrigin(getHeader(event.headers, "referer"));

  if (!requestOrigin) {
    return allowedOrigins[0];
  }

  if (!allowedOrigins.includes(requestOrigin)) {
    return null;
  }

  return requestOrigin;
}

function buildLookupMaps(items, keyFields) {
  return items.reduce((maps, item) => {
    keyFields.forEach((field) => {
      const key = item && item[field] ? String(item[field]).trim() : "";
      if (key && !maps.has(key)) {
        maps.set(key, item);
      }
    });
    return maps;
  }, new Map());
}

function getProductPrice(product, tierById, tierByName) {
  const tierKey = product && product.tier ? String(product.tier).trim() : "";
  const tierMeta = tierById.get(tierKey) || tierByName.get(tierKey);
  const tierPrice = tierMeta ? toFiniteNumber(tierMeta.price) : null;
  if (tierPrice !== null) return tierPrice;

  const productPrice = product ? toFiniteNumber(product.price) : null;
  return productPrice;
}

function normalizeRequestedItems(lineItems) {
  const requestedItems = [];
  const quantitiesByProductId = new Map();
  let totalQuantity = 0;

  for (const item of lineItems) {
    const productId = item && typeof item.productId === "string"
      ? item.productId.trim()
      : item && typeof item.id === "string"
        ? item.id.trim()
        : "";

    if (!productId) {
      return { error: "Each cart item must include a valid product ID." };
    }

    const quantity = Number(item && item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { error: "Each cart item must use a positive whole-number quantity." };
    }

    if (quantity > MAX_QUANTITY_PER_ITEM) {
      return { error: `Quantity for a single item cannot exceed ${MAX_QUANTITY_PER_ITEM}.` };
    }

    totalQuantity += quantity;
    if (totalQuantity > MAX_TOTAL_QUANTITY) {
      return { error: `The cart cannot contain more than ${MAX_TOTAL_QUANTITY} items in total.` };
    }

    const nextQuantity = (quantitiesByProductId.get(productId) || 0) + quantity;
    if (nextQuantity > MAX_QUANTITY_PER_ITEM) {
      return { error: `Quantity for a single item cannot exceed ${MAX_QUANTITY_PER_ITEM}.` };
    }

    quantitiesByProductId.set(productId, nextQuantity);
  }

  quantitiesByProductId.forEach((quantity, productId) => {
    requestedItems.push({ productId, quantity });
  });

  return { items: requestedItems };
}

const catalogueData = readJsonFile("catalogue.json", { products: [] });
const tiersData = readJsonFile("tiers.json", { tiers: [] });
const products = asArray(catalogueData, []);
const tiers = asArray(tiersData, []);
const productsById = buildLookupMaps(products, ["id"]);
const tiersById = buildLookupMaps(tiers, ["id"]);
const tiersByName = buildLookupMaps(tiers, ["name"]);

exports.handler = async function (event) {

  /* Only allow POST */
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed." })
    };
  }

  /* Parse the request body */
  let lineItems, shippingMethod;
  try {
    ({ lineItems, shippingMethod } = JSON.parse(event.body));
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

  const normalized = normalizeRequestedItems(lineItems);
  if (normalized.error) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: normalized.error })
    };
  }

  const resolvedItems = [];
  let subtotalPence = 0;

  for (const item of normalized.items) {
    const product = productsById.get(item.productId);
    if (!product) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Unknown product ID: ${item.productId}` })
      };
    }

    const unitPrice = getProductPrice(product, tiersById, tiersByName);
    if (unitPrice === null || unitPrice <= 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Product pricing is unavailable for ${item.productId}.` })
      };
    }

    const unitAmountPence = Math.round(unitPrice * 100);
    subtotalPence += unitAmountPence * item.quantity;

    resolvedItems.push({
      productId: item.productId,
      name: typeof product.name === "string" && product.name.trim() ? product.name.trim() : item.productId,
      quantity: item.quantity,
      unitAmountPence,
      unitPrice
    });
  }

  const subtotal = subtotalPence / 100;

  const shippingOption = subtotalPence >= FREE_SHIPPING_THRESHOLD_PENCE
    ? SHIPPING_OPTIONS["free-journey"]
    : SHIPPING_OPTIONS[shippingMethod];

  if (!shippingOption || (subtotalPence < FREE_SHIPPING_THRESHOLD_PENCE && shippingOption.id === "free-journey")) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Please choose a valid shipping option." })
    };
  }

  const shippingCostPence = shippingOption.pricePence;
  const finalTotalPence = subtotalPence + shippingCostPence;
  const redirectOrigin = getRedirectOrigin(event);

  if (!redirectOrigin) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Checkout redirect origin is not configured." })
    };
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Stripe is not configured. Missing STRIPE_SECRET_KEY." })
    };
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],

      /* Convert each cart item into a Stripe line item using trusted server data. */
      line_items: [
        ...resolvedItems.map((item) => ({
          price_data: {
            currency: "gbp",
            product_data: {
              name: item.name
            },
            unit_amount: item.unitAmountPence
          },
          quantity: item.quantity
        })),
        ...(shippingCostPence > 0
          ? [{
              price_data: {
                currency: "gbp",
                product_data: {
                  name: shippingOption.name
                },
                unit_amount: shippingCostPence
              },
              quantity: 1
            }]
          : [])
      ],

      mode: "payment",
      success_url: `${redirectOrigin}/success.html`,
      cancel_url:  `${redirectOrigin}/checkout.html`,

      /*
       * Embed product IDs and quantities in session metadata so the
       * stripe-webhook function can decrement inventory automatically.
       * Stripe metadata values must be strings — we JSON-encode the array.
       */
      metadata: {
        orderItems: JSON.stringify(
          resolvedItems.map((item) => ({ id: item.productId, qty: item.quantity }))
        ),
        shippingMethod: shippingOption.id,
        shippingLabel: shippingOption.name,
        shippingAmount: (shippingCostPence / 100).toFixed(2),
        subtotal: subtotal.toFixed(2),
        total: (finalTotalPence / 100).toFixed(2)
      }
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url })
    };

  } catch (error) {
    console.error("Stripe error:", error.message);
    if (error && (error.type === "StripeAuthenticationError" || /api key/i.test(String(error.message || "")))) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Stripe authentication failed. Check STRIPE_SECRET_KEY." })
      };
    }

    if (error && error.type === "StripeInvalidRequestError") {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Stripe rejected the checkout request. Please verify payment configuration." })
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Payment session could not be created. Please try again." })
    };
  }
};
