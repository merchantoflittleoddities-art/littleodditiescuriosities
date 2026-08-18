/* =============================================================
   Little Oddities Curiosities — script.js
   Single source of behaviour for every page.
   Reads product, collection, tier, settings and FAQ data
   from JSON files so no values need to be hardcoded in HTML.
   ============================================================= */

// ── Data paths ──────────────────────────────────────────────
const CART_KEY             = "littleOdditiesCabinet";
const CUSTOMER_TOKEN_KEY   = "lo_customer_token";
const CUSTOMER_INFO_KEY    = "lo_customer_info";
const SETTINGS_PATH        = "./data/settings.json";
const PRODUCTS_PATH        = "./data/catalogue.json";
const COLLECTIONS_PATH     = "./data/collections.json";
const TIERS_PATH           = "./data/tiers.json";
const MERCHANTS_GUIDE_PATH = "./data/merchants-guide.json";
const DESK_ENTRIES_PATH    = "./data/desk-entries.json";
const FEATURED_TREASURE_PATH = "./data/featured-treasure.json";
const INVENTORY_URL        = "/api/get-inventory";
const WISHLIST_URL         = "/api/customer-wishlist";
const IMAGE_ROOT           = "assets/images/products";
const FREE_SHIPPING_THRESHOLD = 30;
const SHIPPING_OPTIONS = {
  "royal-courier": {
    id: "royal-courier",
    name: "Royal Courier",
    price: 2.99,
    eta: "Estimated delivery: 2–4 working days"
  },
  "royal-courier-tracked": {
    id: "royal-courier-tracked",
    name: "Royal Courier Tracked",
    price: 3.99,
    eta: "Estimated delivery: 1–2 working days"
  },
  "free-journey": {
    id: "free-journey",
    name: "Free Journey",
    price: 0,
    eta: "Automatically applied when your treasure subtotal reaches £30.00."
  }
};

// ── Default fallback data ────────────────────────────────────
const DEFAULT_PRODUCTS       = [];
const DEFAULT_COLLECTIONS    = [];
const DEFAULT_TIERS          = [];
const DEFAULT_MERCHANT_GUIDE = {
  title: "The Merchant's Guide",
  subtitle: "Every traveller has a few questions before beginning their journey. Here you'll find answers to some of the most common curiosities.",
  merchantGuide: []
};
const DEFAULT_DESK_ENTRIES = {
  title: "🕯️ From the Merchant's Desk",
  subtitle: "Notes, letters and half-finished thoughts left upon the desk between journeys.",
  closingNote: "",
  settings: { homepageLimit: 3 },
  entries: []
};
const DEFAULT_FEATURED_TREASURE = {
  title: "✨ Featured Treasure",
  intro: "",
  closingNote: "",
  settings: { showWhenOutOfStock: true },
  features: []
};
const DEFAULT_SETTINGS = {
  shop: {
    name: "Little Oddities Curiosities",
    tagline: "Tiny treasures & curious creations",
    currency: "GBP",
    currencySymbol: "£",
    language: "en-GB"
  },
  socials: {
    instagram: "https://instagram.com/little.oddities_curiosities",
    instagramHandle: "@little.oddities_curiosities"
  },
  contact: {
    email: "",
    contactPageTitle: "Send Word to the Merchant",
    submitButton: "Send to the Merchant"
  },
  shipping: {
    shipsTo: ["United Kingdom"],
    processingTime: "1–3 working days",
    shippingMessage: "Currently shipping within the United Kingdom only."
  },
  website: {
    merchantRecommendation: true,
    showReviews: false,
    showWishlist: false,
    maintenanceMode: false
  },
  branding: {
    logo: "assets/images/logo/logo.png",
    favicon: "assets/images/logo/favicon.png",
    altText: "Little Oddities Curiosities logo"
  }
};


// ============================================================
// Utilities
// ============================================================

/** Formats a numeric amount using the shop currency from settings.json */
function formatPrice(amount) {
  const settings = window.SETTINGS || DEFAULT_SETTINGS;
  const symbol   = settings.shop?.currencySymbol || "£";
  const currency = settings.shop?.currency       || "GBP";
  const locale   = settings.shop?.language       || "en-GB";
  const numeric  = Number(amount || 0);
  if (typeof Intl !== "undefined") {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        currencyDisplay: "symbol"
      }).format(numeric);
    } catch (e) {
      return `${symbol}${numeric.toFixed(2)}`;
    }
  }
  return `${symbol}${numeric.toFixed(2)}`;
}

/** Returns a single URL query-string parameter value */
function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/** Looks up tier metadata from the global tiers cache */
function getTierMeta(tierName) {
  if (!window.ALL_TIERS || !Array.isArray(window.ALL_TIERS)) return null;
  return window.ALL_TIERS.find(
    (tier) => tier.name === tierName || tier.id === tierName
  ) || null;
}

/**
 * Returns the resolved price for a product.
 * Prefers the tier price from tiers.json; falls back to the product's own price field.
 */
function getProductPrice(product) {
  const tierMeta = getTierMeta(product.tier);
  return (tierMeta && tierMeta.price) || product.price || 0;
}

/** Returns the globally cached products array */
function getAllProducts() {
  return window.ALL_PRODUCTS || DEFAULT_PRODUCTS;
}

/** Returns a decorative icon for a tier by name */
function getTierIcon(name) {
  switch (name) {
    case "Miniature Relics":    return "🪶";
    case "Tiny Treasures":      return "✨";
    case "Little Miracles":     return "🍄";
    case "Forgotten Treasures": return "🗝️";
    case "Hidden Artifacts":    return "🌲";
    case "Ancient Artifacts":   return "👑";
    default:                    return "✦";
  }
}


// ============================================================
// Cart — storage & mutation
// ============================================================

function getCartKey() {
  const customer = getCustomerInfo();
  return customer ? `littleOdditiesCabinet:${customer.id}` : CART_KEY;
}

function getCart() {
  const stored = window.localStorage.getItem(getCartKey());
  if (!stored) return [];
  try { return JSON.parse(stored); } catch (e) { return []; }
}

function saveCart(cart) {
  window.localStorage.setItem(getCartKey(), JSON.stringify(cart));
  renderCartCount();
}

function clearCart() {
  const key = getCartKey();
  window.localStorage.removeItem(key);
  renderCartCount();
}

function normalizeCartSize(size) {
  return (typeof size === "string" && size.trim()) ? size.trim() : "";
}

function cartItemMatches(entry, id, size) {
  return !!entry && entry.id === id && normalizeCartSize(entry.size) === normalizeCartSize(size);
}

function sizeSlug(size) {
  const slug = normalizeCartSize(size).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return slug || "nosize";
}

function addToCart(id, quantity = 1, size) {
  const availabilityState = getProductAvailabilityState(id);
  if (availabilityState !== "available") {
    const blockedMessage = availabilityState === "unverified"
      ? "This treasure cannot be added while availability is being verified."
      : "This treasure is currently unavailable.";
    showToast(blockedMessage);
    return;
  }

  const cart = getCart();
  const item = cart.find((entry) => cartItemMatches(entry, id, size));
  if (item) {
    item.quantity += quantity;
  } else {
    const next = { id, quantity };
    const normSize = normalizeCartSize(size);
    if (normSize) next.size = normSize;
    cart.push(next);
  }
  saveCart(cart);
  showToast("Added treasure to your Curiosity Cabinet.");
}

function removeFromCart(id, size) {
  saveCart(getCart().filter((entry) => !cartItemMatches(entry, id, size)));
  renderCabinet();
}

function setCartQuantity(id, quantity, size) {
  const cart = getCart();
  const item = cart.find((entry) => cartItemMatches(entry, id, size));
  if (!item) return;
  item.quantity = Math.max(1, Number(quantity) || 1);
  saveCart(cart);
  renderCabinet();
}

/** Calculates the cart grand total using tier-aware prices */
function getCartTotal(cart = getCart(), products = getAllProducts()) {
  return cart.reduce((total, entry) => {
    const product = products.find((item) => item.id === entry.id);
    return product ? total + getProductPrice(product) * entry.quantity : total;
  }, 0);
}

function isFreeShippingEligible(subtotal) {
  return subtotal >= FREE_SHIPPING_THRESHOLD;
}

function getFreeShippingShortfall(subtotal) {
  return Math.max(0, FREE_SHIPPING_THRESHOLD - subtotal);
}

function getAvailableShippingOptions(subtotal) {
  if (isFreeShippingEligible(subtotal)) {
    return [SHIPPING_OPTIONS["free-journey"]];
  }
  return [
    SHIPPING_OPTIONS["royal-courier"],
    SHIPPING_OPTIONS["royal-courier-tracked"]
  ];
}

function getSelectedShippingId() {
  const selected = document.querySelector("input[name='shipping-method']:checked");
  return selected ? selected.value : "";
}

function resolveShippingOption(subtotal, selectedShippingId) {
  const availableOptions = getAvailableShippingOptions(subtotal);
  if (isFreeShippingEligible(subtotal)) {
    return SHIPPING_OPTIONS["free-journey"];
  }
  return availableOptions.find((option) => option.id === selectedShippingId) || null;
}

function getCheckoutTotals(cart = getCart(), products = getAllProducts(), selectedShippingId = "") {
  const subtotal       = getCartTotal(cart, products);
  const shippingOption = resolveShippingOption(subtotal, selectedShippingId);
  const shippingCost   = shippingOption ? shippingOption.price : 0;
  return {
    subtotal,
    shippingOption,
    shippingCost,
    total: subtotal + shippingCost
  };
}

/** Updates every .cart-count badge on the page */
function renderCartCount() {
  const count = getCart().reduce((sum, item) => sum + item.quantity, 0);
  document.querySelectorAll(".cart-count").forEach((el) => {
    el.textContent = count;
  });
}


// ============================================================
// Data loaders — each fetches a JSON file and caches globally
// ============================================================

async function loadProducts() {
  try {
    const response = await fetch(PRODUCTS_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error("Product list could not be loaded.");
    const data = await response.json();
    const products = Array.isArray(data)
      ? data
      : Array.isArray(data?.products) ? data.products : [];
    if (!products.length) throw new Error("Product list is empty.");
    window.ALL_PRODUCTS = products;
    return products;
  } catch (e) {
    window.ALL_PRODUCTS = DEFAULT_PRODUCTS;
    return DEFAULT_PRODUCTS;
  }
}

async function loadCollections() {
  try {
    const response = await fetch(COLLECTIONS_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error("Collections could not be loaded.");
    const data = await response.json();
    const collections = Array.isArray(data)
      ? data
      : Array.isArray(data?.collections) ? data.collections : [];
    const normalized = collections.slice().sort(
      (a, b) => (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0)
    );
    window.ALL_COLLECTIONS = normalized;
    return normalized;
  } catch (e) {
    window.ALL_COLLECTIONS = DEFAULT_COLLECTIONS;
    return DEFAULT_COLLECTIONS;
  }
}

async function loadTiers() {
  try {
    const response = await fetch(TIERS_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error("Tiers could not be loaded.");
    const data = await response.json();
    const tiers = Array.isArray(data)
      ? data
      : Array.isArray(data?.tiers) ? data.tiers : [];
    const normalized = tiers.slice().sort(
      (a, b) => (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0)
    );
    window.ALL_TIERS = normalized;
    return normalized;
  } catch (e) {
    window.ALL_TIERS = DEFAULT_TIERS;
    return DEFAULT_TIERS;
  }
}

async function loadMerchantGuide() {
  try {
    const response = await fetch(MERCHANTS_GUIDE_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error("Merchant's Guide could not be loaded.");
    const data = await response.json();
    const normalized = (typeof data === "object" && data !== null)
      ? data
      : DEFAULT_MERCHANT_GUIDE;
    normalized.merchantGuide = Array.isArray(normalized.merchantGuide)
      ? normalized.merchantGuide.slice().sort(
          (a, b) => (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0)
        )
      : [];
    window.ALL_MERCHANT_GUIDE = normalized;
    return normalized;
  } catch (e) {
    window.ALL_MERCHANT_GUIDE = DEFAULT_MERCHANT_GUIDE;
    return DEFAULT_MERCHANT_GUIDE;
  }
}

/**
 * 🕯️ From the Merchant's Desk
 * Loads the Merchant's desk entries. Entries the Merchant has not published,
 * or has scheduled for a later date, are left out here — so a future Merchant
 * Dashboard only ever has to write the data, never touch the front end.
 */
async function loadDeskEntries() {
  try {
    const response = await fetch(DESK_ENTRIES_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error("The Merchant's desk could not be reached.");
    const data = await response.json();
    const source = (typeof data === "object" && data !== null) ? data : {};
    const entries = Array.isArray(source.entries)
      ? source.entries
      : Array.isArray(source) ? source : [];

    const normalized = {
      ...DEFAULT_DESK_ENTRIES,
      ...source,
      settings: { ...DEFAULT_DESK_ENTRIES.settings, ...(source.settings || {}) },
      entries: entries.filter(isDeskEntryVisible).sort(compareDeskEntries)
    };

    window.ALL_DESK_ENTRIES = normalized;
    return normalized;
  } catch (e) {
    window.ALL_DESK_ENTRIES = DEFAULT_DESK_ENTRIES;
    return DEFAULT_DESK_ENTRIES;
  }
}

/** An entry appears once it is published and its moment has arrived. */
function isDeskEntryVisible(entry) {
  if (!entry || typeof entry !== "object") return false;

  const status = String(entry.status || "published").toLowerCase();
  if (status === "draft" || status === "hidden" || status === "archived") return false;

  const scheduledFor = entry.publishAt ? Date.parse(entry.publishAt) : NaN;
  if (!Number.isNaN(scheduledFor) && scheduledFor > Date.now()) return false;
  if (status === "scheduled" && Number.isNaN(scheduledFor)) return false;

  return true;
}

/** Pinned pages rest on top; the rest fall newest-first. */
function compareDeskEntries(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;

  const dateA = Date.parse(a.date || a.publishAt || "");
  const dateB = Date.parse(b.date || b.publishAt || "");
  if (!Number.isNaN(dateA) && !Number.isNaN(dateB) && dateA !== dateB) return dateB - dateA;

  return (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0);
}

/**
 * ✨ Featured Treasure
 * Loads the curiosity the Merchant has set aside. Exactly like the desk,
 * treasures that are still drafts, still scheduled, or whose moment has
 * passed are filtered out here — so a future Merchant Dashboard only ever
 * has to write this data file, never touch the homepage.
 */
async function loadFeaturedTreasure() {
  try {
    const response = await fetch(FEATURED_TREASURE_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error("The Merchant's chosen treasure could not be reached.");
    const data = await response.json();
    const source = (typeof data === "object" && data !== null) ? data : {};
    const features = Array.isArray(source.features)
      ? source.features
      : Array.isArray(source) ? source : [];

    const normalized = {
      ...DEFAULT_FEATURED_TREASURE,
      ...source,
      settings: { ...DEFAULT_FEATURED_TREASURE.settings, ...(source.settings || {}) },
      features: features.filter(isFeaturedTreasureVisible).sort(compareFeaturedTreasures)
    };

    window.FEATURED_TREASURE = normalized;
    return normalized;
  } catch (e) {
    window.FEATURED_TREASURE = DEFAULT_FEATURED_TREASURE;
    return DEFAULT_FEATURED_TREASURE;
  }
}

/**
 * A treasure is on display once it is published, its moment has arrived,
 * and that moment has not yet passed.
 */
function isFeaturedTreasureVisible(feature) {
  if (!feature || typeof feature !== "object") return false;

  const status = String(feature.status || "published").toLowerCase();
  if (status === "draft" || status === "hidden" || status === "archived") return false;

  const startsAt = feature.publishAt ? Date.parse(feature.publishAt) : NaN;
  if (!Number.isNaN(startsAt) && startsAt > Date.now()) return false;
  if (status === "scheduled" && Number.isNaN(startsAt)) return false;

  const endsAt = feature.expiresAt ? Date.parse(feature.expiresAt) : NaN;
  if (!Number.isNaN(endsAt) && endsAt <= Date.now()) return false;

  return true;
}

/**
 * A pinned treasure — a seasonal choice, say — always takes the place of honour.
 * Otherwise the most recently chosen treasure wins, then display order.
 */
function compareFeaturedTreasures(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;

  const dateA = Date.parse(a.publishAt || a.date || "");
  const dateB = Date.parse(b.publishAt || b.date || "");
  if (!Number.isNaN(dateA) && !Number.isNaN(dateB) && dateA !== dateB) return dateB - dateA;

  return (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0);
}

/**
 * Joins the Merchant's choice to the treasure itself.
 * The catalogue stays the single source of truth for name, price and imagery;
 * the featured data carries only the Merchant's own words about it.
 * Returns null when nothing has been chosen, or the chosen treasure has left the cabinet.
 */
function resolveFeaturedTreasure() {
  const featured = window.FEATURED_TREASURE || DEFAULT_FEATURED_TREASURE;
  const feature  = (featured.features || [])[0];
  if (!feature) return null;

  const product = getAllProducts().find((item) => item.id === feature.productId);
  if (!product) return null;

  if (featured.settings?.showWhenOutOfStock === false && !isProductAvailable(product.id)) return null;

  return { featured, feature, product };
}

async function loadSettings() {
  try {
    const response = await fetch(SETTINGS_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error("Settings could not be loaded.");
    const data = await response.json();
    const normalized = (typeof data === "object" && data !== null)
      ? data
      : DEFAULT_SETTINGS;
    window.SETTINGS = {
      ...DEFAULT_SETTINGS,
      ...normalized,
      shop:     { ...DEFAULT_SETTINGS.shop,     ...(normalized.shop     || {}) },
      socials:  { ...DEFAULT_SETTINGS.socials,  ...(normalized.socials  || {}) },
      contact:  { ...DEFAULT_SETTINGS.contact,  ...(normalized.contact  || {}) },
      shipping: { ...DEFAULT_SETTINGS.shipping, ...(normalized.shipping || {}) },
      website:  { ...DEFAULT_SETTINGS.website,  ...(normalized.website  || {}) },
      branding: { ...DEFAULT_SETTINGS.branding, ...(normalized.branding || {}) }
    };
    return window.SETTINGS;
  } catch (e) {
    window.SETTINGS = DEFAULT_SETTINGS;
    return DEFAULT_SETTINGS;
  }
}

/**
 * Fetches live inventory from the Netlify Function.
 * On failure, marks inventory as unverified so purchasing fails closed.
 * window.ALL_INVENTORY shape: { [productId]: { stock, lowStockThreshold, available, outOfStockMessage } }
 */
async function loadInventory() {
  try {
    const response = await fetch(`${INVENTORY_URL}?cb=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Inventory could not be loaded.");
    const payload = await response.json();
    const inventory = payload?.inventory;

    if (typeof inventory !== "object" || inventory === null || Array.isArray(inventory)) {
      throw new Error("Inventory response was malformed.");
    }

    window.ALL_INVENTORY = inventory;
    window.INVENTORY_VERIFIED = true;
    window.INVENTORY_ERROR = null;
    return window.ALL_INVENTORY;
  } catch (e) {
    window.ALL_INVENTORY = {};
    window.INVENTORY_VERIFIED = false;
    window.INVENTORY_ERROR = e?.message || "Inventory could not be verified.";
    return {};
  }
}

function isInventoryVerified() {
  return window.INVENTORY_VERIFIED === true;
}

/**
 * Returns the inventory entry for a product, or null if not tracked.
 * When null, the product is treated as always available (unlimited stock).
 */
function getInventoryItem(productId) {
  return (window.ALL_INVENTORY && window.ALL_INVENTORY[productId]) || null;
}

/**
 * Distinguishes inventory verification failure from true out-of-stock states.
 */
function getProductAvailabilityState(productId) {
  if (!isInventoryVerified()) return "unverified";

  const inv = getInventoryItem(productId);
  if (!inv) return "available";             /* not tracked -> available */
  if (inv.available === false) return "out"; /* manually disabled */
  if (inv.stock === null) return "available";/* unlimited */

  return Number(inv.stock) > 0 ? "available" : "out";
}

/**
 * Returns true if a product is purchasable based on its inventory entry.
 * Products with no inventory entry are considered always available.
 */
function isProductAvailable(productId) {
  return getProductAvailabilityState(productId) === "available";
}

/**
 * Returns true if a product is low on stock (but still purchasable).
 */
function isProductLowStock(productId) {
  if (!isInventoryVerified()) return false;
  const inv = getInventoryItem(productId);
  if (!inv || inv.stock === null || inv.available === false) return false;
  const stock = Number(inv.stock);
  if (!Number.isFinite(stock)) return false;
  return stock > 0 && stock <= (inv.lowStockThreshold || 3);
}

/** Storefront Message registry and resolvers */
const AVAILABLE_STOREFRONT_MESSAGES = {
  available: (stock) => "Available",
  workshop:  (stock) => "The Merchant has this in the workshop.",
  shelves:   (stock) => "The Merchant has this upon the shelves.",
  remaining: (stock) => (stock !== null && stock !== undefined)
    ? `Only ${stock} remain upon the shelves.`
    : "Only a few remain upon the shelves.",
  request:   (stock) => "The Merchant can make this upon a traveller's request."
};

const UNAVAILABLE_STOREFRONT_MESSAGES = {
  roaming:   (stock) => "Roaming the Land.",
  returning: (stock) => "Returning Before Long.",
  bespoke:   (stock) => "Available to Order."
};

/** Returns the resolved storefront message for a product */
function getStorefrontMessage(productId) {
  const availabilityState = getProductAvailabilityState(productId);
  const inv = getInventoryItem(productId);

  if (availabilityState === "unverified") {
    return "Availability could not be verified right now. Please try again shortly.";
  }

  if (availabilityState === "available") {
    const key = inv?.availableStorefrontMessage || inv?.availableMessage || (inv?.storefrontMessage in AVAILABLE_STOREFRONT_MESSAGES ? inv?.storefrontMessage : "shelves");
    const msgFn = AVAILABLE_STOREFRONT_MESSAGES[key] || AVAILABLE_STOREFRONT_MESSAGES.shelves;
    return msgFn(inv?.stock);
  } else {
    const key = inv?.unavailableStorefrontMessage || inv?.unavailableMessage || inv?.outOfStockMessage || (inv?.storefrontMessage in UNAVAILABLE_STOREFRONT_MESSAGES ? inv?.storefrontMessage : "roaming");
    const msgFn = UNAVAILABLE_STOREFRONT_MESSAGES[key] || UNAVAILABLE_STOREFRONT_MESSAGES.roaming;
    return msgFn(inv?.stock);
  }
}


// ============================================================
// Global settings & branding rendering
// ============================================================

function updateFavicon(iconPath) {
  if (!iconPath) return;
  let favicon = document.querySelector('link[rel="icon"]');
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.rel  = "icon";
    favicon.type = "image/png";
    document.head.appendChild(favicon);
  }
  favicon.href = iconPath;
}

/** Injects the logo image (or placeholder) into every .site-logo container */
function renderBranding() {
  const settings = window.SETTINGS || DEFAULT_SETTINGS;
  const branding = settings.branding || DEFAULT_SETTINGS.branding;
  const logoPath = branding.logo;
  const altText  = branding.altText || `${settings.shop.name} logo`;

  document.querySelectorAll(".site-logo").forEach((container) => {
    let image = container.querySelector(".site-logo-image");
    const placeholder = container.querySelector(".site-logo-placeholder");

    if (!image) {
      image = document.createElement("img");
      image.className = "site-logo-image";
      container.appendChild(image);
    }

    image.src      = logoPath;
    image.alt      = altText;
    image.decoding = "async";

    image.onload = () => {
      container.classList.add("logo-loaded");
      image.style.display = "block";
      if (placeholder) placeholder.style.display = "none";
    };
    image.onerror = () => {
      container.classList.remove("logo-loaded");
      image.style.display = "none";
      if (placeholder) placeholder.style.display = "grid";
    };

    if (placeholder) placeholder.textContent = "✦";
  });

  updateFavicon(branding.favicon);
}

/** Applies every setting from settings.json to matching elements across all pages */
function renderGlobalSettings() {
  const settings = window.SETTINGS || DEFAULT_SETTINGS;
  const { name: shopName, tagline: shopTagline } = settings.shop;
  const { instagram, instagramHandle }           = settings.socials;
  const { contactPageTitle, submitButton }       = settings.contact;
  const { shippingMessage, processingTime, shipsTo } = settings.shipping;
  const shipsToList = Array.isArray(shipsTo) ? shipsTo : DEFAULT_SETTINGS.shipping.shipsTo;

  document.querySelectorAll(".site-brand-name").forEach((el) => { el.textContent = shopName; });
  document.querySelectorAll(".site-tagline").forEach((el)    => { el.textContent = shopTagline; });
  document.querySelectorAll(".site-copyright").forEach((el)  => { el.textContent = `© ${shopName}`; });

  document.querySelectorAll(".social-instagram-link").forEach((el) => {
    el.href        = instagram;
    el.textContent = instagramHandle;
  });

  document.querySelectorAll(".contact-page-title").forEach((el) => { el.textContent = contactPageTitle; });
  document.querySelectorAll(".contact-submit-button").forEach((btn) => {
    if (btn.tagName === "INPUT") { btn.value = submitButton; } else { btn.textContent = submitButton; }
  });

  document.querySelectorAll(".shipping-message").forEach((el) => { el.textContent = shippingMessage; });
  document.querySelectorAll(".shipping-details").forEach((el) => {
    el.textContent = `${processingTime}. Ships to: ${shipsToList.join(", ")}.`;
  });

  renderBranding();

  if (settings.shop?.language) document.documentElement.lang = settings.shop.language;

  if (document.title) {
    const friendly = document.title.replace(/\s*\|\s*.*$/, "") || document.body.dataset.page || "";
    document.title = `${friendly} | ${shopName}`;
  }
}


// ============================================================
// Product gallery (product detail page)
// ============================================================

function loadProductGallery(product) {
  const gallery = document.querySelector(".product-gallery");
  if (!gallery) return;

  const imageFiles = Array.isArray(product.images) && product.images.length
    ? product.images : [];
  const folder      = `${IMAGE_ROOT}/${product.id}`;
  const placeholder = `<div class="image-placeholder">A photograph of this treasure will appear soon.</div>`;

  gallery.innerHTML = placeholder;
  if (!imageFiles.length) return;

  const loaded = [];
  let processed = 0;

  function finishGallery() {
    gallery.innerHTML = loaded.length
      ? loaded.map((src) => `<div class="gallery-item"><img src="${src}" alt="${product.name}"></div>`).join("")
      : placeholder;
  }

  imageFiles.forEach((file) => {
    const imageUrl = `${folder}/${file}`;
    const img = new Image();
    img.onload  = () => { loaded.push(imageUrl); processed++; if (processed === imageFiles.length) finishGallery(); };
    img.onerror = () => { processed++;            if (processed === imageFiles.length) finishGallery(); };
    img.src = imageUrl;
  });
}


// ============================================================
// Product cards
// ============================================================

/** Builds the HTML string for a single product card */
function buildProductCard(product) {
  const hasImage     = Array.isArray(product.images) && product.images.length;
  const imageSrc     = hasImage ? `${IMAGE_ROOT}/${product.id}/${product.images[0]}` : null;
  const description  = product.description || "Bracelet details will be added soon.";
  const displayPrice = formatPrice(getProductPrice(product));

  const availabilityState = getProductAvailabilityState(product.id);
  const available = availabilityState === "available";
  const unverified = availabilityState === "unverified";
  const message   = getStorefrontMessage(product.id);

  const addButton = available
    ? `<button class="button button-secondary" type="button" data-add-to-cart="${product.id}">Add to Cabinet</button>`
    : `<button class="button button-secondary" type="button" disabled style="opacity:0.55;cursor:not-allowed;">${unverified ? "Availability Unverified" : "Currently Unavailable"}</button>`;

  const stockStateClass = available ? "stock-notice--available" : (unverified ? "stock-notice--unknown" : "stock-notice--out");
  const stockNotice = `<p class="stock-notice ${stockStateClass}">${escapeHtml(message)}</p>`;

  const settings = window.SETTINGS || DEFAULT_SETTINGS;
  const satchelButton = settings.website?.showWishlist
    ? `<button class="button button-secondary" type="button" data-satchel="${product.id}" data-saved="false">🤍 Save to Satchel</button>`
    : "";

  return `
    <article class="card product-card">
      <div class="product-image">
        ${hasImage
          ? `<img src="${imageSrc}" alt="${product.name}"
               onload="this.parentElement.querySelector('.image-placeholder-card')?.style.display='none';"
               onerror="this.style.display='none';">`
          : ""}
        <div class="image-placeholder-card">A photograph of this treasure will appear soon.</div>
      </div>
      <div class="product-icon">${product.icon || "✦"}</div>
      <div class="product-copy">
        <h3>${product.name}</h3>
        <p>${description}</p>
        <div class="product-meta">
          <span class="muted">${product.tier}</span>
          <span>${product.collection}</span>
          <span>${displayPrice}</span>
        </div>
        ${stockNotice}
      </div>
      <div class="product-actions">
        <a class="button button-primary" href="product.html?id=${encodeURIComponent(product.id)}">View Treasure</a>
        ${addButton}
        ${satchelButton}
      </div>
    </article>
  `;
}

function attachAddToCartHandlers(root = document) {
  root.querySelectorAll("[data-add-to-cart]").forEach((button) => {
    button.addEventListener("click", () => addToCart(button.dataset.addToCart));
  });
}

/** Fetches the signed-in Traveller's saved productIds (Satchel), or [] if signed out */
async function fetchWishlistIds() {
  const token = getCustomerToken();
  if (!token) return [];
  try {
    const response = await fetch(WISHLIST_URL, { headers: { "Authorization": `Bearer ${token}` } });
    if (!response.ok) return [];
    const data = await response.json();
    return data.productIds || [];
  } catch (e) {
    return [];
  }
}

async function toggleSatchel(productId, button) {
  if (!getCustomerToken()) {
    showToast("Sign in as a Recognised Traveller to use your Satchel.");
    return;
  }
  const isSaved = button.dataset.saved === "true";
  try {
    const response = await fetch(WISHLIST_URL, {
      method: isSaved ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${getCustomerToken()}` },
      body: JSON.stringify({ productId })
    });
    if (!response.ok) throw new Error("Satchel request failed.");
    button.dataset.saved = isSaved ? "false" : "true";
    button.textContent = isSaved ? "🤍 Save to Satchel" : "💜 In Satchel";
    showToast(isSaved ? "Removed from your Satchel." : "Saved to your Satchel.");
  } catch (e) {
    showToast("Your Satchel could not be updated.");
  }
}

function attachSatchelHandlers(root = document) {
  root.querySelectorAll("[data-satchel]").forEach((button) => {
    button.addEventListener("click", () => toggleSatchel(button.dataset.satchel, button));
  });
}

/** Marks any [data-satchel] buttons under root that are already in the signed-in Traveller's Satchel */
async function markSavedSatchelButtons(root = document) {
  const ids = await fetchWishlistIds();
  if (!ids.length) return;
  root.querySelectorAll("[data-satchel]").forEach((button) => {
    if (ids.includes(button.dataset.satchel)) {
      button.dataset.saved = "true";
      button.textContent = "💜 In Satchel";
    }
  });
}

function renderProductsGrid(products, selector) {
  const grid = document.querySelector(selector);
  if (!grid) return;
  grid.innerHTML = products.map(buildProductCard).join("");
  attachAddToCartHandlers(grid);
  attachSatchelHandlers(grid);
  markSavedSatchelButtons(grid);
}


// ============================================================
// Cart rows — shared by cabinet and checkout
// ============================================================

/**
 * Builds the HTML for a single editable cart row.
 * Used by renderCabinet(); the checkout page uses a read-only layout.
 */
function buildCartRow(entry, product) {
  const itemPrice = getProductPrice(product);
  const entrySize = normalizeCartSize(entry.size);
  const sizeLine = entrySize ? `<p class="muted">Size: ${escapeHtml(entrySize)}</p>` : "";
  const rowSlug = sizeSlug(entrySize);
  const rowId = `${product.id}-${rowSlug}`;
  const sizeAttr = escapeHtml(entrySize);
  return `
    <div class="cart-row">
      <div>
        <h3>${product.name}</h3>
        <p>${product.collection}</p>
        ${sizeLine}
        <p class="muted">${product.description || "Bracelet details will be added soon."}</p>
      </div>
      <div class="cart-quantity">
        <label for="qty-${rowId}">Qty</label>
        <input id="qty-${rowId}" type="number" min="1" value="${entry.quantity}" data-quantity="${product.id}" data-size="${sizeAttr}">
      </div>
      <div class="cart-price">${formatPrice(itemPrice * entry.quantity)}</div>
      <div>
        <button class="button button-secondary" type="button" data-remove="${product.id}" data-size="${sizeAttr}">Remove</button>
      </div>
    </div>
  `;
}

/** Wires quantity-change and remove-item listeners on cart rows inside a container */
function attachCartRowHandlers(container) {
  container.querySelectorAll("[data-quantity]").forEach((input) => {
    input.addEventListener("change", () => setCartQuantity(input.dataset.quantity, input.value, input.dataset.size));
  });
  container.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => removeFromCart(button.dataset.remove, button.dataset.size));
  });
}


// ============================================================
// Helpful Pages search
// Lets the shop search return informational pages alongside
// treasures. Purely additive — product results are untouched.
// ============================================================

/** Informational pages the search can surface, with the words travellers use to look for them */
const HELPFUL_PAGES = [
  {
    icon: "🕯️",
    title: "Merchant's Guide",
    url: "merchants-guide.html",
    blurb: "Answers on shipping, returns, refunds, bracelet sizes and caring for your treasure.",
    keywords: [
      "merchant", "merchants guide", "merchant's guide", "guide", "help", "helpful", "faq",
      "faqs", "question", "questions", "answers", "support", "advice", "info", "information",
      "return", "returns", "refund", "refunds", "exchange", "exchanges", "cancel", "problem",
      "shipping", "delivery", "postage", "courier", "dispatch", "tracking", "tracked", "parcel",
      "arrive", "arrival", "how long", "lost", "damaged", "size", "sizes", "sizing",
      "bracelet size", "bracelet sizes", "measure", "measurement", "fit", "care", "cleaning",
      "policy", "policies", "terms", "handmade", "materials", "payment", "orders"
    ]
  },
  {
    icon: "↩️",
    title: "The Merchant's Returns & Refunds",
    url: "returns.html",
    blurb: "What to do about changed minds, returns, refunds, damaged or faulty treasures and lost deliveries.",
    keywords: [
      "return", "returns", "returning", "refund", "refunds", "exchange", "exchanges", "cancel",
      "cancellation", "change of mind", "changed my mind", "worn", "diminished value",
      "faulty", "damaged", "broken", "defective", "wrong item", "incorrect", "lost", "parcel",
      "delivery", "money back", "policy", "policies", "terms", "right to cancel", "statutory rights",
      "returns and refunds", "returns & refunds", "returns policy"
    ]
  },
  {
    icon: "📜",
    title: "Merchant's Terms of Service",
    url: "terms.html",
    blurb: "The rules that govern your use of the shop, from placing orders to payments and delivery.",
    keywords: [
      "terms", "terms of service", "tos", "conditions", "terms and conditions", "service",
      "rules", "policies", "policy", "agreement", "legal", "user agreement", "merchant",
      "merchant terms", "order", "orders", "pricing", "payment", "delivery", "account",
      "cancellation", "cancellations", "intellectual property", "copyright"
    ]
  },
  {
    icon: "🕵️",
    title: "Traveller's Privacy",
    url: "privacy.html",
    blurb: "How the Merchant collects, uses, and protects your personal information.",
    keywords: [
      "privacy", "privacy policy", "data", "gdpr", "personal data", "personal information",
      "information", "your data", "my data", "data protection", "cookie", "cookies",
      "tracking", "analytics", "storage", "localstorage", "sessionstorage", "session",
      "account", "register", "sign in", "signin", "login", "password", "email", "address",
      "addresses", "shipping", "order", "orders", "payment", "stripe", "formspree",
      "contact", "satchel", "wishlist", "rights", "retention", "delete account",
      "data controller", "third party", "third-party", "resend", "google fonts"
    ]
  },
  {
    icon: "🚚",
    title: "Shipping & Delivery",
    url: "shipping.html",
    blurb: "Where treasures travel, how shipping costs and free delivery work, and delivery estimates.",
    keywords: [
      "shipping", "delivery", "deliver", "dispatch", "postage", "courier", "royal mail",
      "royal courier", "tracked", "tracking", "free shipping", "free delivery", "free journey",
      "shipping cost", "shipping costs", "shipping price", "how long", "arrival", "arrive",
      "estimated", "eta", "uk", "united kingdom", "international", "overseas",
      "shipping method", "shipping options", "delivery estimate", "lost", "damaged", "delayed"
    ]
  },
  {
    icon: "🍪",
    title: "Cookie Information",
    url: "cookies.html",
    blurb: "What storage technologies this shop uses — and importantly, what it does not.",
    keywords: [
      "cookie", "cookies", "cookie policy", "cookies policy", "localstorage", "sessionstorage",
      "local storage", "session storage", "browser storage", "storage", "technologies",
      "tracking", "analytics", "no cookies", "no tracking", "no analytics", "third-party",
      "third party", "stripe", "formspree", "cart", "session", "token"
    ]
  },
  {
    icon: "💌",
    title: "Send Word to the Merchant",
    url: "contact.html",
    blurb: "Send a letter to the Merchant with any question, request or curious idea.",
    keywords: [
      "contact", "contact us", "send word", "word", "letter", "write", "email", "e-mail",
      "mail", "message", "messages", "get in touch", "touch", "reach", "reach out", "ask",
      "enquiry", "enquiries", "inquiry", "question", "support", "help", "custom", "commission",
      "bespoke", "request", "complaint", "instagram", "social", "talk", "speak", "reply"
    ]
  },
  {
    icon: "🗄️",
    title: "Curiosity Cabinet",
    url: "cabinet.html",
    blurb: "The treasures you have gathered so far, ready for their journey home.",
    keywords: [
      "cabinet", "curiosity cabinet", "curiosity", "curiosities", "inventory", "archive",
      "archives", "collection", "gathered", "basket", "bag", "cart", "trolley", "saved",
      "my items", "my treasures", "purchase", "buy", "checkout", "pay", "order", "total"
    ]
  },
  {
    icon: "📦",
    title: "Collections",
    url: "collections.html",
    blurb: "Every themed range — haunted love, enchanted forest, forgotten treasures and more.",
    keywords: [
      "collections", "collection", "range", "ranges", "theme", "themes", "themed", "series",
      "sets", "categories", "category", "browse", "explore", "haunted", "haunted love",
      "enchanted", "enchanted forest", "forest", "forgotten", "forgotten treasures",
      "little miracles", "miracles"
    ]
  },
  {
    icon: "ℹ️",
    title: "About",
    url: "about.html",
    blurb: "Meet the Merchant and hear the story behind Little Oddities Curiosities.",
    keywords: [
      "about", "about us", "story", "our story", "history", "who", "who are you", "meet",
      "meet the merchant", "business", "brand", "shop", "maker", "creator", "artist",
      "handmade", "craft", "workshop", "values", "mission", "behind the scenes"
    ]
  },
  {
    icon: "⭐",
    title: "Traveller Reviews",
    url: "reviews.html",
    blurb: "Words from fellow travellers who have welcomed a treasure into their story.",
    keywords: [
      "review", "reviews", "traveller reviews", "feedback", "rating", "ratings", "stars",
      "star", "testimonial", "testimonials", "comments", "opinions", "experiences",
      "recommend", "recommendations", "trust", "happy customers", "customers"
    ]
  },
  {
    icon: "🛍",
    title: "Shop the Cabinet",
    url: "shop.html",
    blurb: "Every handmade treasure in one place, filterable by collection and tier.",
    keywords: [
      "shop", "store", "browse", "all products", "products", "treasures", "treasure",
      "catalogue", "catalog", "search", "buy", "stock", "available", "new", "bracelet",
      "bracelets", "jewellery", "jewelry", "gift", "gifts"
    ]
  },
  {
    icon: "✦",
    title: "Treasure Tiers",
    url: "tiers.html",
    blurb: "The tiers of wonder, and what each level of treasure includes.",
    keywords: [
      "tier", "tiers", "treasure tiers", "price", "prices", "pricing", "cost", "costs",
      "how much", "budget", "cheap", "expensive", "levels", "level", "value", "packages"
    ]
  },
  {
    icon: "🏰",
    title: "Home",
    url: "index.html",
    blurb: "Return to the front of the shop and start the journey again.",
    keywords: ["home", "homepage", "front page", "start", "main page", "beginning", "welcome"]
  }
];

/** Very common words that should never drive a page match on their own */
const HELPFUL_PAGE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "my", "me", "i", "is", "it", "in", "on",
  "at", "be", "do", "does", "did", "can", "you", "your", "with", "any", "some", "please",
  "what", "when", "where", "which", "who", "why", "how", "get", "got", "are", "was", "have"
]);

/** Escapes text before it is placed inside generated markup */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Lowercases and strips punctuation so "Merchant's Guide?" and "merchants guide" match */
function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Scores a single word against one keyword; allows light stemming so "refunds" finds "refund" */
function scoreWordAgainstKeyword(word, keyword) {
  if (word === keyword) return 6;
  if (word.length < 4) return 0;
  if (keyword.split(" ").includes(word)) return 5;
  if (keyword.startsWith(word) || word.startsWith(keyword)) return 4;
  if (keyword.includes(word)) return 2;
  return 0;
}

/**
 * Ranks the informational pages against a free-text query.
 * Matches whole phrases, individual words, page titles, blurbs and — for the
 * Merchant's Guide — the questions already loaded from merchants-guide.json.
 * Returns the best matches, highest score first.
 */
function searchHelpfulPages(query, limit = 4) {
  const phrase = normalizeSearchText(query);
  if (phrase.length < 2) return [];

  const words = phrase
    .split(" ")
    .filter((word) => word.length > 1 && !HELPFUL_PAGE_STOPWORDS.has(word));
  const searchTerms = words.length ? words : [phrase];

  const guideEntries = window.ALL_MERCHANT_GUIDE?.merchantGuide || [];

  return HELPFUL_PAGES
    .map((page) => {
      const normalizedTitle = normalizeSearchText(page.title);
      const normalizedBlurb = normalizeSearchText(page.blurb);
      const keywords        = page.keywords.map(normalizeSearchText);

      let score = 0;
      let matchedQuestion = "";

      // Whole-phrase matches are the strongest signal
      if (normalizedTitle === phrase || keywords.includes(phrase)) score += 14;
      else if (normalizedTitle.includes(phrase)) score += 10;
      else if (phrase.length >= 3 && keywords.some((k) => k.includes(phrase))) score += 8;

      // Then each meaningful word from the query
      searchTerms.forEach((word) => {
        if (normalizedTitle.split(" ").includes(word)) score += 5;
        else if (word.length >= 4 && normalizedTitle.includes(word)) score += 3;

        const keywordScore = keywords.reduce(
          (best, keyword) => Math.max(best, scoreWordAgainstKeyword(word, keyword)),
          0
        );
        score += keywordScore;

        if (!keywordScore && word.length >= 4 && normalizedBlurb.includes(word)) score += 2;
      });

      // The Merchant's Guide also answers to its own FAQ questions
      if (page.url === "merchants-guide.html" && guideEntries.length) {
        guideEntries.forEach((entry) => {
          const question = normalizeSearchText(entry.question);
          const hit = searchTerms.some((word) => word.length >= 4 && question.includes(word));
          if (!hit) return;
          score += 4;
          if (!matchedQuestion) matchedQuestion = entry.question;
        });
      }

      return { ...page, score, matchedQuestion };
    })
    .filter((page) => page.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/** Renders the Helpful Pages results for the current search term */
function renderHelpfulPages(query) {
  const container = document.querySelector("#helpful-pages-results");
  if (!container) return;

  const trimmed = String(query || "").trim();

  if (!trimmed) {
    container.innerHTML =
      `<p class="muted">Search for topics like shipping, contact, merchant, forest, or haunted.</p>`;
    return;
  }

  const matches = searchHelpfulPages(trimmed);

  if (!matches.length) {
    container.innerHTML = `
      <p class="muted">The Merchant found no guidance for “${escapeHtml(trimmed)}”.
      Try <em>shipping</em>, <em>returns</em>, <em>contact</em> or <em>reviews</em>.</p>
    `;
    return;
  }

  container.innerHTML = `
    <p class="results-text helpful-pages-summary">
      Showing <strong>${matches.length}</strong> ${matches.length === 1 ? "page" : "pages"}
      for “${escapeHtml(trimmed)}”.
    </p>
    <ul class="helpful-pages-list">
      ${matches.map((page) => `
        <li>
          <a class="helpful-page-link" href="${page.url}">
            <span class="helpful-page-icon" aria-hidden="true">${page.icon}</span>
            <span class="helpful-page-copy">
              <span class="helpful-page-title">${escapeHtml(page.title)}</span>
              <span class="helpful-page-blurb">${escapeHtml(page.blurb)}</span>
              ${page.matchedQuestion
                ? `<span class="helpful-page-hint">Answers: ${escapeHtml(page.matchedQuestion)}</span>`
                : ""}
            </span>
            <span class="helpful-page-arrow" aria-hidden="true">→</span>
          </a>
        </li>
      `).join("")}
    </ul>
  `;
}


// ============================================================
// ✨ Featured Treasure
// ============================================================

/**
 * Places the Merchant's chosen curiosity in its position of honour.
 * The markup produced here matches the fallback markup in index.html,
 * so the choice can change without the layout or the styles changing with it.
 */
function renderFeaturedTreasure() {
  const section = document.querySelector("#featured-treasure");
  if (!section) return;

  const chosen = resolveFeaturedTreasure();

  // The Merchant has set nothing aside — take the shelf down rather than
  // leave an empty frame where a treasure should be.
  if (!chosen) {
    section.hidden = true;
    return;
  }

  const { featured, feature, product } = chosen;
  const stage = section.querySelector(".featured-treasure-stage");
  if (stage) stage.innerHTML = buildFeaturedTreasure(feature, product);

  const heading = section.querySelector(".featured-treasure-heading");
  if (heading && featured.title) heading.textContent = featured.title;

  const intro = section.querySelector(".featured-treasure-intro");
  if (intro) {
    intro.textContent = featured.intro || "";
    intro.hidden = !featured.intro;
  }

  const closing = section.querySelector(".featured-treasure-closing");
  if (closing) {
    closing.textContent = featured.closingNote || "";
    closing.hidden = !featured.closingNote;
  }

  observeFeaturedTreasure(section);
}

function buildFeaturedTreasure(feature, product) {
  const hasImage  = Array.isArray(product.images) && product.images.length;
  const imageSrc  = hasImage ? `${IMAGE_ROOT}/${product.id}/${product.images[0]}` : "";
  const imageAlt  = feature.imageAlt || `${product.name} — a handmade curiosity from Little Oddities Curiosities.`;
  const eyebrow   = feature.eyebrow || "Set aside by the Merchant";
  const ctaLabel  = feature.ctaLabel || "View This Treasure";
  const seasonal  = String(feature.seasonal || "").trim();

  const noteParagraphs = Array.isArray(feature.merchantNote)
    ? feature.merchantNote
    : String(feature.merchantNote || "").split(/\n{2,}/);

  const note = noteParagraphs
    .filter((paragraph) => String(paragraph).trim())
    .map((paragraph) => `<p>${escapeHtml(String(paragraph).trim())}</p>`)
    .join("");

  const signoff = String(feature.signoff || "").trim();

  const availabilityState = getProductAvailabilityState(product.id);
  const available = availabilityState === "available";
  const unverified = availabilityState === "unverified";
  const message   = getStorefrontMessage(product.id);
  const stockStateClass = available ? "stock-notice--available" : (unverified ? "stock-notice--unknown" : "stock-notice--out");
  const stockNotice = `<p class="stock-notice ${stockStateClass}">${escapeHtml(message)}</p>`;

  return `
    <article class="featured-treasure">
      <span class="featured-treasure-sparkle featured-treasure-sparkle--start" aria-hidden="true">✦</span>
      <span class="featured-treasure-sparkle featured-treasure-sparkle--end" aria-hidden="true">✦</span>

      <div class="featured-treasure-frame">
        ${hasImage
          ? `<img class="featured-treasure-image" src="${escapeHtml(imageSrc)}" alt="${escapeHtml(imageAlt)}" loading="lazy" decoding="async"
               onload="this.parentElement.querySelector('.featured-treasure-placeholder')?.style.setProperty('display','none');"
               onerror="this.style.display='none';">`
          : ""}
        <p class="featured-treasure-placeholder">A photograph of this treasure will appear soon.</p>
      </div>

      <div class="featured-treasure-copy">
        <p class="featured-treasure-eyebrow">
          ${escapeHtml(eyebrow)}${seasonal ? ` <span class="featured-treasure-season">· ${escapeHtml(seasonal)}</span>` : ""}
        </p>
        <h3 class="featured-treasure-name">${escapeHtml(product.name)}</h3>
        <p class="featured-treasure-description">${escapeHtml(product.description || "Details of this treasure will follow shortly.")}</p>

        <p class="featured-treasure-meta">
          <span class="muted">${escapeHtml(product.tier || "")}</span>
          <span>${escapeHtml(product.collection || "")}</span>
        </p>

        <p class="featured-treasure-price">
          <span class="featured-treasure-price-label">Price</span>
          ${escapeHtml(formatPrice(getProductPrice(product)))}
        </p>
        ${stockNotice}

        ${note ? `<div class="featured-treasure-note">${note}</div>` : ""}
        ${signoff ? `<p class="featured-treasure-signoff">${escapeHtml(signoff).replace(/\n/g, "<br>")}</p>` : ""}

        <div class="featured-treasure-actions">
          <a class="button button-primary" href="product.html?id=${encodeURIComponent(product.id)}">
            ${escapeHtml(ctaLabel)}
          </a>
        </div>
      </div>
    </article>
  `;
}

/** The treasure settles gently into view as the traveller reaches it. */
function observeFeaturedTreasure(section) {
  const treasure = section.querySelector(".featured-treasure");
  if (!treasure) return;

  if (typeof IntersectionObserver !== "function") {
    treasure.classList.add("is-visible");
    return;
  }

  section.classList.add("reveal-ready");

  const observer = new IntersectionObserver((records, self) => {
    records.forEach((record) => {
      if (!record.isIntersecting) return;
      record.target.classList.add("is-visible");
      self.unobserve(record.target);
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });

  observer.observe(treasure);
}


// ============================================================
// 🕯️ From the Merchant's Desk
// ============================================================

/**
 * Rewrites the desk with whatever the Merchant has left there.
 * The markup produced here matches the fallback markup in index.html,
 * so entries can be swapped for dashboard-authored content without
 * touching the layout or the styles.
 */
function renderDeskEntries() {
  const deskArea = document.querySelector(".desk-entries");
  if (!deskArea) return;

  const desk    = window.ALL_DESK_ENTRIES || DEFAULT_DESK_ENTRIES;
  const limit   = Number(desk.settings?.homepageLimit) || 3;
  const entries = Array.isArray(desk.entries) ? desk.entries.slice(0, limit) : [];

  // Nothing to show yet — leave the page exactly as the markup found it.
  if (entries.length) {
    deskArea.innerHTML = entries.map(buildDeskEntry).join("");

    const heading = document.querySelector(".desk-heading");
    if (heading && desk.title) heading.textContent = desk.title;

    const subtitle = document.querySelector(".desk-subtitle");
    if (subtitle && desk.subtitle) subtitle.textContent = desk.subtitle;

    const closing = document.querySelector(".desk-closing");
    if (closing) {
      closing.textContent = desk.closingNote || "";
      closing.hidden = !desk.closingNote;
    }
  }

  observeDeskEntries(deskArea);
}

function buildDeskEntry(entry) {
  const paragraphs = Array.isArray(entry.body)
    ? entry.body
    : String(entry.body || "").split(/\n{2,}/);

  const body = paragraphs
    .filter((p) => String(p).trim())
    .map((p) => `<p>${escapeHtml(String(p).trim())}</p>`)
    .join("");

  const signoff = String(entry.signoff || "").trim();

  return `
    <article class="desk-entry${entry.pinned ? " desk-entry--pinned" : ""}">
      <span class="desk-pin" aria-hidden="true"></span>
      <header class="desk-entry-header">
        ${entry.pinned ? `<span class="desk-entry-pinned-note">Left on top of the pile</span>` : ""}
        <p class="desk-entry-date">${escapeHtml(formatDeskDate(entry))}</p>
        <h3 class="desk-entry-title">${escapeHtml(entry.title || "")}</h3>
      </header>
      <div class="desk-entry-body">${body}</div>
      ${signoff ? `<p class="desk-entry-signoff">${escapeHtml(signoff).replace(/\n/g, "<br>")}</p>` : ""}
    </article>
  `;
}

/** A poetic label if the Merchant left one, otherwise a plain date. */
function formatDeskDate(entry) {
  if (entry.dateLabel) return String(entry.dateLabel);

  const stamp = Date.parse(entry.date || entry.publishAt || "");
  if (Number.isNaN(stamp)) return "";

  return new Date(stamp).toLocaleDateString(
    window.SETTINGS?.shop?.language || "en-GB",
    { day: "numeric", month: "long", year: "numeric" }
  );
}

/** Each page fades gently into view as the traveller scrolls past. */
function observeDeskEntries(deskArea) {
  const pages = Array.from(deskArea.querySelectorAll(".desk-entry"));
  if (!pages.length) return;

  if (typeof IntersectionObserver !== "function") {
    pages.forEach((page) => page.classList.add("is-visible"));
    return;
  }

  deskArea.classList.add("reveal-ready");

  const observer = new IntersectionObserver((records, self) => {
    records.forEach((record) => {
      if (!record.isIntersecting) return;
      record.target.classList.add("is-visible");
      self.unobserve(record.target);
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });

  pages.forEach((page) => observer.observe(page));
}


// ============================================================
// Page renderers
// ============================================================

function renderHomePage(products) {
  // Collections preview strip
  const collectionsArea = document.querySelector(".collection-preview-grid");
  if (collectionsArea && window.ALL_COLLECTIONS?.length) {
    collectionsArea.innerHTML = window.ALL_COLLECTIONS
      .map((c) => `
        <article class="card collection-card" style="border-top:4px solid ${c.colourTheme || "#ccc"}">
          <div class="collection-icon">${c.icon || "✦"}</div>
          <h3>${c.name}</h3>
          <p>${c.shortDescription || ""}</p>
          <a class="button button-primary" href="collections.html?collection=${encodeURIComponent(c.name)}">Explore</a>
        </article>
      `)
      .join("");
  }

  // Tier preview strip
  const tierPreviewArea = document.querySelector(".tier-preview-grid");
  if (tierPreviewArea && window.ALL_TIERS?.length) {
    tierPreviewArea.innerHTML = window.ALL_TIERS
      .map((tier) => `
        <article class="card tier-card">
          <div class="tier-icon">${getTierIcon(tier.name)}</div>
          <h3>${tier.name}</h3>
          <p>${formatPrice(tier.price)} · ${tier.includes?.[0] || "Discover the right level of wonder."}</p>
          <a class="button button-primary" href="tiers.html?tier=${encodeURIComponent(tier.name)}">Discover</a>
        </article>
      `)
      .join("");
  }

  // The curiosity the Merchant has set aside
  renderFeaturedTreasure();

  // Notes left upon the Merchant's desk
  renderDeskEntries();

  // Featured products
  const featuredArea = document.querySelector(".featured-grid");
  if (!featuredArea) return;
  featuredArea.innerHTML = products.slice(0, 3).map(buildProductCard).join("");
  attachAddToCartHandlers(featuredArea);
  attachSatchelHandlers(featuredArea);
  markSavedSatchelButtons(featuredArea);
}

function renderShopPage(products) {
  const collectionFilter = document.querySelector("#collection-filter");
  const tierFilter       = document.querySelector("#tier-filter");
  const searchInput      = document.querySelector("#product-search");

  const allCollections = window.ALL_COLLECTIONS?.length
    ? window.ALL_COLLECTIONS.map((c) => c.name).sort()
    : Array.from(new Set(products.map((p) => p.collection))).sort();

  const allTiers = window.ALL_TIERS?.length
    ? window.ALL_TIERS.map((t) => t.name)
    : Array.from(new Set(products.map((p) => p.tier))).sort();

  if (collectionFilter) {
    allCollections.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      collectionFilter.appendChild(opt);
    });
  }

  if (tierFilter) {
    allTiers.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      tierFilter.appendChild(opt);
    });
  }

  function filterProducts() {
    const collectionValue = collectionFilter?.value || "";
    const tierValue       = tierFilter?.value       || "";
    const searchValue     = searchInput?.value.trim().toLowerCase() || "";

    const filtered = products.filter((p) => {
      const matchesCollection = !collectionValue || p.collection === collectionValue;
      const matchesTier       = !tierValue       || p.tier === tierValue;
      const matchesSearch     = !searchValue     ||
        p.name.toLowerCase().includes(searchValue) ||
        p.description?.toLowerCase().includes(searchValue) ||
        p.collection.toLowerCase().includes(searchValue);
      return matchesCollection && matchesTier && matchesSearch;
    });

    shopFilteredProducts = filtered;
    renderProductsGrid(filtered, ".product-grid");
    const counter = document.querySelector("#shop-results-count");
    if (counter) counter.textContent = filtered.length;

    /* Informational pages matching the same search term */
    renderHelpfulPages(searchValue);
  }

  if (collectionFilter) collectionFilter.addEventListener("change", filterProducts);
  if (tierFilter)       tierFilter.addEventListener("change", filterProducts);
  if (searchInput)      searchInput.addEventListener("input", filterProducts);

  filterProducts();
}

function renderCollectionsPage(products) {
  const selectedCollection = getQueryParam("collection");
  const listContainer      = document.querySelector(".collections-grid");
  const collectionIntro    = document.querySelector(".collections-intro");
  const productArea        = document.querySelector(".collection-products");

  const collections = window.ALL_COLLECTIONS?.length ? window.ALL_COLLECTIONS : [
    { name: "Haunted Love",        description: "Love stories that linger beyond time.", icon: "🖤" },
    { name: "Enchanted Forest",    description: "Woodland magic hidden beneath ancient trees.", icon: "🍄" },
    { name: "Forgotten Treasures", description: "Relics and ancient mysteries waiting to be uncovered.", icon: "🗝️" },
    { name: "Little Miracles",     description: "Small reminders that hope can bloom in unexpected places.", icon: "✨" }
  ];

  if (collections[0]?.displayOrder !== undefined) {
    collections.sort((a, b) => (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0));
  }

  if (!selectedCollection) {
    if (!listContainer) return;
    listContainer.innerHTML = collections
      .map((col) => {
        const count = products.filter((p) => p.collection === col.name).length;
        return `
          <article class="card collection-card">
            <div class="collection-icon">${col.icon}</div>
            <h3>${col.name}</h3>
            <p>${col.shortDescription || col.description || ""}</p>
            <p class="collection-count">${count} treasures awaiting discovery</p>
            <a class="button button-primary" href="collections.html?collection=${encodeURIComponent(col.name)}">Explore</a>
          </article>
        `;
      })
      .join("");
    return;
  }

  const collectionMeta = collections.find(
    (c) => c.name === selectedCollection || c.id === selectedCollection
  ) || { icon: "✦", fullDescription: selectedCollection };

  if (collectionIntro) {
    collectionIntro.innerHTML = `
      <div class="card collection-banner" style="display:flex;gap:20px;align-items:center;">
        <div class="collection-icon" style="font-size:2rem;">${collectionMeta.icon}</div>
        <div>
          <h2>${collectionMeta.name || selectedCollection}</h2>
          <p class="muted">${collectionMeta.fullDescription || collectionMeta.shortDescription || selectedCollection}</p>
        </div>
      </div>
    `;
  }

  const filtered = products.filter((p) => p.collection === selectedCollection);
  if (!productArea) return;

  if (!filtered.length) {
    productArea.innerHTML = `
      <div class="callout">
        <h3>The Merchant is still uncovering treasures for this collection...</h3>
      </div>
    `;
    return;
  }

  productArea.innerHTML = `
    <div class="collection-actions">
      <a class="button button-secondary" href="collections.html">Browse all collections</a>
      <span>${filtered.length} treasures in ${selectedCollection}</span>
    </div>
    <div class="product-grid">${filtered.map(buildProductCard).join("")}</div>
  `;
  attachAddToCartHandlers(productArea);
  attachSatchelHandlers(productArea);
  markSavedSatchelButtons(productArea);
}

function renderTiersPage(products) {
  const selectedTier  = getQueryParam("tier");
  const listContainer = document.querySelector(".tiers-grid");
  const tierIntro     = document.querySelector(".tiers-intro");
  const productArea   = document.querySelector(".tier-products");
  const tiers         = window.ALL_TIERS?.length ? window.ALL_TIERS : [];

  if (!selectedTier) {
    if (!tierIntro || !listContainer) return;
    tierIntro.innerHTML = `<h2>✦ Treasure Tiers ✦</h2><p>Choose the tier that matches your mood and discover the right level of wonder.</p><p class="collection-context-link">🌙 Curious about our collections?</p><p>Discover the story-driven themes that bring our treasures together. <a href="collections.html">Explore Collections →</a></p>`;

    listContainer.innerHTML = tiers
      .map((tier) => {
        const examples = tier.exampleBracelets?.length
          ? tier.exampleBracelets.map((name) => {
              const product = products.find((p) => p.name === name);
              return product
                ? `<li><a href="product.html?id=${encodeURIComponent(product.id)}">${product.name}</a></li>`
                : `<li>${name}</li>`;
            }).join("")
          : "";
        const exampleHtml = examples ? `<ul>${examples}</ul>` : "<p>None yet</p>";

        return `
          <article class="card tier-card">
            <div style="display:flex;gap:18px;align-items:center;margin-bottom:12px;">
              <div class="tier-icon" style="font-size:1.6rem;">${getTierIcon(tier.name)}</div>
              <div>
                <h3>${tier.name}</h3>
                <p class="muted">Price: ${formatPrice(tier.price)}</p>
              </div>
            </div>
            <h4>What's included</h4>
            <ul>${tier.includes.map((i) => `<li>${i}</li>`).join("")}</ul>
            <h4>Example Bracelet</h4>
            ${exampleHtml}
            ${tier.packaging ? `<h4>Packaging</h4><p class="muted">${tier.packaging}</p>` : ""}
          </article>
        `;
      })
      .join("");
    return;
  }

  const selectedMeta = tiers.find((t) => t.name === selectedTier || t.id === selectedTier) || { name: selectedTier };
  if (tierIntro) {
    tierIntro.innerHTML = `<h2>${selectedMeta.name}</h2><p>Goods gathered from the ${selectedMeta.name} tier.</p>`;
  }

  const filtered = products.filter((p) => p.tier === selectedTier);
  if (!productArea) return;

  if (!filtered.length) {
    productArea.innerHTML = `<p class="callout">No treasures found in ${selectedTier}. Please explore other tiers or return to the tiers list.</p>`;
    return;
  }

  productArea.innerHTML = `
    <div class="collection-actions">
      <a class="button button-secondary" href="tiers.html">Browse all treasure tiers</a>
      <span>${filtered.length} treasures in ${selectedTier}</span>
    </div>
    <div class="product-grid">${filtered.map(buildProductCard).join("")}</div>
  `;
  attachAddToCartHandlers(productArea);
  attachSatchelHandlers(productArea);
  markSavedSatchelButtons(productArea);
}

function renderProductPage(products) {
  const id         = getQueryParam("id");
  const product    = products.find((item) => item.id === id);
  const detailArea = document.querySelector(".product-detail");
  if (!detailArea) return;

  if (!product) {
    detailArea.innerHTML = `<div class="callout">Treasure not found. <a href="shop.html">Return to the shop</a>.</div>`;
    return;
  }

  const tierMeta      = getTierMeta(product.tier);
  const displayPrice  = formatPrice(getProductPrice(product));
  const packagingText = tierMeta?.packaging || product.packaging || "Standard Handmade Packaging";
  const availabilityState = getProductAvailabilityState(product.id);
  const available     = availabilityState === "available";
  const unverified    = availabilityState === "unverified";
  const message       = getStorefrontMessage(product.id);

  const stockStateClass = available ? "stock-notice--available" : (unverified ? "stock-notice--unknown" : "stock-notice--out");
  const stockNotice = `<p class="stock-notice ${stockStateClass}">${escapeHtml(message)}</p>`;

  const addCabinetButton = available
    ? `<button class="button button-primary" type="button" id="add-to-cabinet">Add to Curiosity Cabinet</button>`
    : `<button class="button button-primary" type="button" disabled style="opacity:0.55;cursor:not-allowed;">${unverified ? "Availability Unverified" : "Currently Unavailable"}</button>`;

  const availabilityLabel = available
    ? "Available"
    : (unverified ? "Availability temporarily unavailable" : "Currently unavailable");

  const sizeNames = [
    "Miniature Sprout",
    "Vines",
    "Mushrooms",
    "Forest Floor",
    "Wicked Branches"
  ];

  const sizeSelector = `
    <div class="size-selector">
      <label for="bracelet-size">Bracelet Size</label>
      <select id="bracelet-size" name="bracelet-size">
        <option value="" disabled selected>Please choose a size</option>
        ${sizeNames.map((s) => `<option value="${s}">${s}</option>`).join("")}
      </select>
      <p class="size-selector-hint muted">A sizing guide is coming soon.</p>
    </div>
  `;

  const settings = window.SETTINGS || DEFAULT_SETTINGS;
  const satchelButton = settings.website?.showWishlist
    ? `<button class="button button-secondary" type="button" data-satchel="${product.id}" data-saved="false">🤍 Save to Satchel</button>`
    : "";

  detailArea.innerHTML = `
    <article class="card product-detail-card">
      <div class="product-detail-primary">
        <div class="product-detail-main">
          <div class="product-gallery"></div>
          <div>
            <p class="eyebrow">${product.collection}</p>
            <h2>${product.name}</h2>
            <p class="price-detail">${displayPrice}</p>
            <p>${product.description || "Description will be added soon."}</p>
            ${stockNotice}
            <p class="availability">${availabilityLabel}</p>
          </div>
        </div>
        <div class="product-detail-meta">
          <h3>✦ The Story Behind This Treasure ✦</h3>
          <p>${product.lore}</p>
          <h3>Description</h3>
          <p>${product.description}</p>
          <h3>Materials</h3>
          <ul>${product.materials.map((m) => `<li>${m}</li>`).join("")}</ul>
          <h3>Packaging</h3>
          <p>${packagingText}</p>
          ${sizeSelector}
          <div class="detail-actions">
            ${addCabinetButton}
            <a class="button button-secondary" href="cabinet.html">View Cabinet</a>
            ${satchelButton}
          </div>
        </div>
      </div>
    </article>
  `;

  loadProductGallery(product);

  if (available) {
    const addButton = document.querySelector("#add-to-cabinet");
    if (addButton) {
      addButton.addEventListener("click", () => {
        const sizeSelect = document.querySelector("#bracelet-size");
        const selectedSize = sizeSelect ? sizeSelect.value : "";
        addToCart(product.id, 1, selectedSize);
      });
    }
  }

  attachSatchelHandlers(detailArea);
  markSavedSatchelButtons(detailArea);
}

/**
 * Renders the Curiosity Cabinet page.
 * Reads products from the global cache so removeFromCart/setCartQuantity
 * can call this without needing to pass a products argument.
 */
function renderCabinet() {
  const container    = document.querySelector(".cart-items");
  const totalElement = document.querySelector("#cart-total");
  if (!container) return;

  const cart     = getCart();
  const products = getAllProducts();

  if (!cart.length) {
    container.innerHTML = `
      <div class="callout">
        <h3>Your Curiosity Cabinet is empty.</h3>
        <p>Fill it with handmade treasures from the shop.</p>
        <a class="button button-primary" href="shop.html">Browse Treasures</a>
      </div>
    `;
    if (totalElement) totalElement.textContent = formatPrice(0);
    return;
  }

  container.innerHTML = cart
    .map((entry) => {
      const product = products.find((item) => item.id === entry.id);
      return product ? buildCartRow(entry, product) : "";
    })
    .join("");

  if (totalElement) totalElement.textContent = formatPrice(getCartTotal(cart, products));

  attachCartRowHandlers(container);
}

/**
 * Renders the checkout page with a read-only order summary and a Stripe button.
 * The page must have data-page="checkout" on <body>.
 */
function renderCheckoutPage() {
  const summaryContainer = document.querySelector(".checkout-summary");
  const shippingContainer = document.querySelector("#checkout-shipping-options");
  const subtotalElement  = document.querySelector("#checkout-subtotal");
  const shippingElement  = document.querySelector("#checkout-shipping-cost");
  const totalElement     = document.querySelector("#checkout-total");
  const checkoutButton   = document.querySelector("#checkout-button");
  if (!summaryContainer) return;

  const cart     = getCart();
  const products = getAllProducts();

  if (!cart.length) {
    summaryContainer.innerHTML = `
      <div class="callout">
        <h3>Your Curiosity Cabinet is empty.</h3>
        <p>There is nothing to check out. <a href="shop.html">Return to the shop</a>.</p>
      </div>
    `;
    if (checkoutButton) checkoutButton.disabled = true;
    if (shippingContainer) {
      shippingContainer.innerHTML = "";
    }
    if (subtotalElement) subtotalElement.textContent = formatPrice(0);
    if (shippingElement) shippingElement.textContent = formatPrice(0);
    if (totalElement) totalElement.textContent = formatPrice(0);
    return;
  }

  // Read-only order summary — no quantity editing on the checkout page
  summaryContainer.innerHTML = cart
    .map((entry) => {
      const product = products.find((item) => item.id === entry.id);
      if (!product) return "";
      const itemPrice = getProductPrice(product);
      return `
        <div class="checkout-row">
          <div class="checkout-row-name">
            <strong>${product.name}</strong>
            <span class="muted">${product.collection}</span>
          </div>
          <div class="checkout-row-qty">× ${entry.quantity}</div>
          <div class="checkout-row-price">${formatPrice(itemPrice * entry.quantity)}</div>
        </div>
      `;
    })
    .join("");

  const subtotal = getCartTotal(cart, products);
  const shippingOptions = getAvailableShippingOptions(subtotal);

  if (shippingContainer) {
    const optionsHtml = shippingOptions.map((option) => {
      const checked = option.id === "free-journey" ? " checked" : "";
      const helperText = option.id === "free-journey"
        ? `<p class="muted">${option.eta}</p>`
        : `<p class="muted">${option.eta}</p>`;
      return `
        <label class="form-group" style="display:block;margin-bottom:12px;cursor:pointer;">
          <input type="radio" name="shipping-method" value="${option.id}"${checked} style="margin-right:10px;">
          <strong>${option.name}</strong>
          <span class="muted" style="margin-left:8px;">${formatPrice(option.price)}</span>
          ${helperText}
        </label>
      `;
    }).join("");

    const freeShippingShortfall = getFreeShippingShortfall(subtotal);
    const freeNote = isFreeShippingEligible(subtotal)
      ? `<p class="muted" style="margin-top:8px;">✨ Congratulations! The Merchant has granted your treasures a Free Journey.</p>`
      : freeShippingShortfall <= 5
      ? `<p class="muted" style="margin-top:8px;">🕯️ Only ${formatPrice(freeShippingShortfall)} more stands between your treasures and a Free Journey.</p>`
      : `<p class="muted" style="margin-top:8px;">🍄 Gather ${formatPrice(freeShippingShortfall)} more in curious treasures to earn a Free Journey.</p>`;

    shippingContainer.innerHTML = `${optionsHtml}${freeNote}`;
  }

  function syncCheckoutTotals() {
    const totals = getCheckoutTotals(cart, products, getSelectedShippingId());
    if (subtotalElement) subtotalElement.textContent = formatPrice(totals.subtotal);
    if (shippingElement) shippingElement.textContent = formatPrice(totals.shippingCost);
    if (totalElement) totalElement.textContent = formatPrice(totals.total);
    if (checkoutButton) checkoutButton.disabled = !totals.shippingOption || !isInventoryVerified();
  }

  document.querySelectorAll("input[name='shipping-method']").forEach((input) => {
    input.addEventListener("change", syncCheckoutTotals);
  });

  syncCheckoutTotals();

  if (!isInventoryVerified() && shippingContainer) {
    shippingContainer.insertAdjacentHTML(
      "beforeend",
      `<p class="muted" style="margin-top:8px;">Availability could not be verified right now. Checkout is temporarily unavailable.</p>`
    );
  }

  if (checkoutButton) {
    checkoutButton.addEventListener("click", () => initiateStripeCheckout(cart, products));
  }
}

/**
 * Posts the cart to the Netlify Function and redirects to Stripe Checkout.
 *
 * The function receives purchase intent only (productId + quantity),
 * resolves pricing server-side, creates a Stripe Checkout Session,
 * and returns a hosted payment URL.
 */
async function initiateStripeCheckout(cart, products) {
  const button = document.querySelector("#checkout-button");
  const selectedShippingId = getSelectedShippingId();
  const totals = getCheckoutTotals(cart, products, selectedShippingId);

  if (!isInventoryVerified()) {
    showToast("Availability could not be verified. Please try again shortly.");
    if (button) {
      button.disabled = true;
      button.textContent = "🕯️ Proceed to Secure Payment";
    }
    return;
  }

  // Disable the button and show a loading message while the request is in flight
  if (button) {
    button.disabled    = true;
    button.textContent = "🕯️ Preparing your treasures...";
  }

  // Guard: products must be loaded from the JSON catalogue
  if (!products || !products.length) {
    console.error("Stripe checkout: product catalogue not loaded yet.");
    showToast("Still loading your treasures — please try again in a moment.");
    if (button) { button.disabled = false; button.textContent = "🕯️ Proceed to Secure Payment"; }
    return;
  }

  if (!totals.shippingOption) {
    showToast("Please choose how the Merchant should send your treasure.");
    if (button) { button.disabled = false; button.textContent = "🕯️ Proceed to Secure Payment"; }
    return;
  }

  // Build purchase-intent line items only; pricing is resolved server-side
  const lineItems = cart
    .map((entry) => {
      const product = products.find((p) => p.id === entry.id);
      if (!product) return null;
      const size = normalizeCartSize(entry.size);
      return {
        productId: product.id,
        quantity:  entry.quantity,
        size:      size || undefined
      };
    })
    .filter(Boolean);

  if (!lineItems.length) {
    showToast("Your Curiosity Cabinet appears to be empty.");
    if (button) { button.disabled = false; button.textContent = "🕯️ Proceed to Secure Payment"; }
    return;
  }

  try {
    const response = await fetch("/api/create-checkout-session", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lineItems,
        shippingMethod: totals.shippingOption.id
      })
    });

    // Log status so any error is visible in the browser console
    console.log("Checkout session response status:", response.status);

    if (!response.ok) {
      const text = await response.text();
      console.error("Checkout session error body:", text);
      let message = "The Merchant's counter is temporarily unavailable.";
      try { message = JSON.parse(text).error || message; } catch (e) { /* plain text error */ }
      throw new Error(message);
    }

    const { url } = await response.json();
    window.location.href = url;

  } catch (error) {
    console.error("Stripe checkout error:", error.message);
    showToast(error.message || "Something went wrong. Please try again in a moment.");
    if (button) {
      button.disabled    = false;
      button.textContent = "🕯️ Proceed to Secure Payment";
    }
  }
}


// ============================================================
// Contact page
// ============================================================

async function renderContactPage() {
  const form    = document.querySelector("#contact-form");
  const message = document.querySelector(".contact-message");
  if (!form || !message) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name    = form.querySelector("#contact-name").value.trim();
    const email   = form.querySelector("#contact-email").value.trim();
    const subject = form.querySelector("#contact-subject").value.trim();
    const note    = form.querySelector("#contact-message-text").value.trim();

    if (!name || !email || !subject || !note) {
      message.textContent = "Please fill in all fields before sending your letter.";
      return;
    }

    message.textContent = "🕊️ Delivering your letter to the Merchant...";

    try {
      const response = await fetch(form.action, {
        method:  "POST",
        body:    new FormData(form),
        headers: { Accept: "application/json" }
      });

      if (response.ok) {
        window.location.href = "letter-delivered.html";
      } else {
        console.log("Formspree error:", await response.text());
        message.textContent = "Something went wrong while sending your letter. Please try again.";
      }
    } catch (error) {
      console.error(error);
      message.textContent = "The courier seems to have misplaced your letter. Please try again in a moment.";
    }
  });
}


// ============================================================
// Merchant's Guide page — accordion
// ============================================================

function openFaqCard(card) {
  const answer = card.querySelector(".faq-answer");
  const button = card.querySelector(".faq-question");
  if (!answer || !button) return;
  card.classList.add("open");
  button.setAttribute("aria-expanded", "true");
  answer.setAttribute("aria-hidden", "false");
  answer.style.maxHeight = `${answer.scrollHeight + 24}px`;
}

function closeFaqCard(card) {
  const answer = card.querySelector(".faq-answer");
  const button = card.querySelector(".faq-question");
  if (!answer || !button) return;
  card.classList.remove("open");
  button.setAttribute("aria-expanded", "false");
  answer.setAttribute("aria-hidden", "true");
  answer.style.maxHeight = "0px";
}

function renderMerchantGuidePage() {
  const guide         = window.ALL_MERCHANT_GUIDE || DEFAULT_MERCHANT_GUIDE;
  const titleEl       = document.querySelector(".merchant-guide-title");
  const subtitleEl    = document.querySelector(".merchant-guide-subtitle");
  const listContainer = document.querySelector(".merchant-guide-list");

  if (titleEl)    titleEl.textContent    = guide.title    || DEFAULT_MERCHANT_GUIDE.title;
  if (subtitleEl) subtitleEl.textContent = guide.subtitle || DEFAULT_MERCHANT_GUIDE.subtitle;
  if (!listContainer) return;

  listContainer.innerHTML = guide.merchantGuide
    .map((item) => `
      <article class="card faq-card" id="faq-${item.id}">
        <button type="button" class="faq-question"
                aria-expanded="false"
                aria-controls="answer-${item.id}"
                data-faq="${item.id}">
          <span>${item.question}</span>
          <span class="faq-icon" aria-hidden="true">+</span>
        </button>
        <div class="faq-answer" id="answer-${item.id}" aria-hidden="true">
          <p>${item.answer}</p>
        </div>
      </article>
    `)
    .join("");

  const faqCards = listContainer.querySelectorAll(".faq-card");
  listContainer.querySelectorAll(".faq-question").forEach((button) => {
    button.addEventListener("click", () => {
      const card   = button.closest(".faq-card");
      if (!card) return;
      const isOpen = card.classList.contains("open");
      faqCards.forEach(closeFaqCard);
      if (!isOpen) openFaqCard(card);
    });
  });
}


// ============================================================
// Toast notification
// ============================================================

function showToast(text) {
  let toast = document.querySelector(".toast-notice");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast-notice";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("visible");
  window.clearTimeout(window.toastTimeout);
  window.toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 2500);
}


// ============================================================
// Traveller session — shared by every page's header link and
// by account.js on the Traveller's Keepings pages
// ============================================================

/** Reads the customer token, checking sessionStorage first (this tab),
 *  then localStorage ("Remember this Traveller" persists across visits). */
function getCustomerToken() {
  return window.sessionStorage.getItem(CUSTOMER_TOKEN_KEY) || window.localStorage.getItem(CUSTOMER_TOKEN_KEY);
}

function getCustomerInfo() {
  const raw = window.sessionStorage.getItem(CUSTOMER_INFO_KEY) || window.localStorage.getItem(CUSTOMER_INFO_KEY);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Stores the session token + customer info; remember=true persists across browser restarts */
function saveCustomerSession(token, customer, remember) {
  const selectedStore = remember ? window.localStorage : window.sessionStorage;
  const otherStore = remember ? window.sessionStorage : window.localStorage;

  // Make the freshly authenticated session authoritative. getCustomerToken()
  // reads sessionStorage BEFORE localStorage, so a stale token from an earlier
  // account (e.g. a previous Izuku login left in sessionStorage) could win over
  // the new session written to the other store. Clear BOTH stores before
  // writing so no leftover token/info can overwrite the new session.
  selectedStore.removeItem(CUSTOMER_TOKEN_KEY);
  selectedStore.removeItem(CUSTOMER_INFO_KEY);
  otherStore.removeItem(CUSTOMER_TOKEN_KEY);
  otherStore.removeItem(CUSTOMER_INFO_KEY);
  selectedStore.setItem(CUSTOMER_TOKEN_KEY, token);
  selectedStore.setItem(CUSTOMER_INFO_KEY, JSON.stringify(customer));
}

function clearCustomerSession() {
  window.localStorage.removeItem(CUSTOMER_TOKEN_KEY);
  window.localStorage.removeItem(CUSTOMER_INFO_KEY);
  window.sessionStorage.removeItem(CUSTOMER_TOKEN_KEY);
  window.sessionStorage.removeItem(CUSTOMER_INFO_KEY);
}

/** Updates every page's "Traveller's Keepings" nav link to show the traveller's name when signed in,
 *  and reveals the "✨ Merchant's Ledger" nav link only for Merchant accounts */
function updateAccountNavLink() {
  const customer = getCustomerToken() ? getCustomerInfo() : null;
  document.querySelectorAll(".account-nav-link").forEach((link) => {
    link.textContent = customer ? `Traveller's Keepings (${customer.name})` : "Traveller's Keepings";
  });
  document.querySelectorAll(".merchant-nav-link").forEach((link) => {
    link.classList.toggle("hidden", customer?.role !== "merchant");
  });
}

// ============================================================
// Navigation helpers
// ============================================================

function highlightCurrentPage() {
  const path = window.location.pathname.split("/").pop();
  document.querySelectorAll(".nav-links a").forEach((link) => {
    if (link.getAttribute("href") === path) link.classList.add("active");
  });
}


// ============================================================
// Storefront inventory freshness
// Periodic refresh + refresh on visibility, without a page reload.
// ============================================================

const INVENTORY_REFRESH_MS = 60 * 1000;
const INVENTORY_PAGES = new Set(["home", "shop", "collections", "tiers", "product", "cabinet", "checkout"]);

let inventoryRefreshing = false;
let inventoryRefreshTimer = null;
let shopFilteredProducts = [];

/**
 * Re-renders only the inventory-dependent UI for the currently visible page.
 * Uses the existing renderers so no duplicate rendering logic is introduced.
 */
function refreshInventoryUI(pageId) {
  const products = getAllProducts();

  switch (pageId) {
    case "home":         refreshHomeInventory();        break;
    case "shop":         rerenderShopGrid();               break;
    case "collections":  renderCollectionsPage(products);  break;
    case "tiers":        renderTiersPage(products);        break;
    case "product":      renderProductPage(products);      break;
    case "cabinet":      renderCabinet();                  break;
    case "checkout":     refreshCheckoutAvailability();    break;
    default: break;
  }
}

/**
 * Fetches fresh inventory and refreshes only the current page's
 * inventory-dependent UI.
 *  - Uses the existing loadInventory() (already cache-busted + no-store).
 *  - Keeps the last known-good snapshot if the refresh fails.
 *  - Never fires two overlapping requests.
 *  - Never performs a full page reload.
 */
async function refreshInventory() {
  const pageId = document.body.dataset.page;
  if (!INVENTORY_PAGES.has(pageId)) return;   // no inventory UI on this page
  if (document.hidden) return;                 // nothing to refresh while hidden
  if (inventoryRefreshing) return;             // prevent overlapping requests

  inventoryRefreshing = true;
  const previousSnapshot = window.ALL_INVENTORY;
  const previousVerified  = window.INVENTORY_VERIFIED === true;

  try {
    await loadInventory();

    // loadInventory() marks a failed load with INVENTORY_VERIFIED = false.
    // If that happened, restore the last-known-good snapshot instead of
    // replacing a working storefront with an "unverified" state.
    if (window.INVENTORY_VERIFIED !== true) {
      window.ALL_INVENTORY = previousSnapshot;
      window.INVENTORY_VERIFIED = previousVerified;
      window.INVENTORY_ERROR = "Inventory refresh failed; showing the last known availability.";
      return;
    }

    refreshInventoryUI(pageId);
  } finally {
    inventoryRefreshing = false;
  }
}

/**
 * Starts the single periodic refresh timer and the single
 * visibilitychange listener. Called once at startup.
 */
function startInventoryRefresh() {
  if (inventoryRefreshTimer) return; // ensure exactly one timer + one listener

  inventoryRefreshTimer = setInterval(refreshInventory, INVENTORY_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshInventory();
  });
}

/**
 * Re-renders just the shop product grid, reusing the merchant's current
 * filters (stored by renderShopPage). This avoids duplicating the filter
 * <option> elements or their change listeners.
 */
function rerenderShopGrid() {
  renderProductsGrid(shopFilteredProducts, ".product-grid");
  const counter = document.querySelector("#shop-results-count");
  if (counter) counter.textContent = shopFilteredProducts.length;
}

/**
 * Refreshes the homepage's inventory-dependent UI only.
 * Re-renders the featured product card grid and patches the featured
 * treasure's stock notice in place — deliberately NOT re-running the full
 * home renderer, which would create duplicate IntersectionObservers.
 */
function refreshHomeInventory() {
  const products = getAllProducts();
  renderProductsGrid(products.slice(0, 3), ".featured-grid");

  const section = document.querySelector("#featured-treasure");
  if (!section) return;
  const chosen  = resolveFeaturedTreasure();
  const product = chosen && chosen.product;
  if (!product) return;

  const notice = section.querySelector(".stock-notice");
  if (!notice) return;

  const state      = getProductAvailabilityState(product.id);
  const available  = state === "available";
  const unverified = state === "unverified";
  notice.textContent = getStorefrontMessage(product.id);
  notice.className = "stock-notice " +
    (available ? "stock-notice--available" : (unverified ? "stock-notice--unknown" : "stock-notice--out"));
}

/**
 * Keeps the checkout availability note and button in sync after a refresh
 * without re-rendering the whole checkout page (which would re-bind the
 * checkout button and reset the selected shipping method).
 */
function refreshCheckoutAvailability() {
  const button = document.querySelector("#checkout-button");
  if (button) button.disabled = !getSelectedShippingId() || !isInventoryVerified();

  const shipping = document.querySelector("#checkout-shipping-options");
  if (!shipping) return;

  const note = Array.from(shipping.querySelectorAll("p.muted")).find((p) =>
    p.textContent.includes("Availability could not be verified"));

  if (!isInventoryVerified() && !note) {
    const p = document.createElement("p");
    p.className = "muted";
    p.style.marginTop = "8px";
    p.textContent = "Availability could not be verified right now. Checkout is temporarily unavailable.";
    shipping.appendChild(p);
  } else if (isInventoryVerified() && note) {
    note.remove();
  }
}

// ============================================================
// Initialisation — loads all data then routes to the page renderer
// ============================================================

function initPage() {
  const pageId = document.body.dataset.page;

  window.INVENTORY_VERIFIED = false;
  window.INVENTORY_ERROR = "Inventory has not been verified yet.";

  Promise.all([
    loadSettings(),
    loadProducts(),
    loadCollections(),
    loadTiers(),
    loadMerchantGuide(),
    loadDeskEntries(),
    loadFeaturedTreasure(),
    loadInventory()        /* fetch live stock levels before rendering any products */
  ]).then(([settings, products]) => {
    renderGlobalSettings();
    renderCartCount();
    highlightCurrentPage();
    updateAccountNavLink();

    switch (pageId) {
      case "home":           renderHomePage(products);         break;
      case "shop":           renderShopPage(products);         break;
      case "collections":    renderCollectionsPage(products);  break;
      case "tiers":          renderTiersPage(products);        break;
      case "product":        renderProductPage(products);      break;
      case "cabinet":        renderCabinet();                  break;
      case "checkout":       renderCheckoutPage();             break;
      case "contact":        renderContactPage();              break;
      case "merchant-guide": renderMerchantGuidePage();        break;
      default: break;
    }
  });
}

let jeffElement = null;
let jeffIsAnimating = false;

/** Lazily creates the Jeff stage + sprite the first time he is summoned. */
function ensureJeff() {
  if (jeffElement) return jeffElement;

  const stage = document.createElement("div");
  stage.className = "jeff-stage";
  stage.id = "jeffStage";

  const jeff = document.createElement("div");
  jeff.className = "jeff";
  jeff.id = "jeff";

  stage.appendChild(jeff);
  document.body.appendChild(stage);
  jeffElement = jeff;
  return jeffElement;
}

/** Swims Jeff across the viewport when the hidden ✦ trigger is clicked. */
function summonJeff() {
  const jeff = ensureJeff();
  if (jeffIsAnimating) return;
  jeffIsAnimating = true;

  jeff.classList.remove("active", "wiggle");
  void jeff.offsetWidth; // force reflow
  jeff.classList.add("active");

  jeff.addEventListener("animationend", function handler() {
    jeff.removeEventListener("animationend", handler);
    jeffIsAnimating = false;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initPage();

  // Storefront inventory freshness — periodic + on-visibility refresh
  if (INVENTORY_PAGES.has(document.body.dataset.page)) {
    startInventoryRefresh();
  }

  // ── Desktop navigation owner ──────────────────────────────
  const desktopNav = {
    close() {
      const trigger = document.querySelector(".nav-dropdown-trigger");
      const nav = document.querySelector(".nav-links");
      if (!trigger || !nav) return;
      nav.classList.remove("desktop-open");
      trigger.textContent = "▼";
      trigger.setAttribute("aria-expanded", "false");
    }
  };

  function initDesktopNav() {
    const trigger = document.querySelector(".nav-dropdown-trigger");
    const nav = document.querySelector(".nav-links");
    if (!trigger || !nav) return;

    const openDesktop = () => {
      nav.classList.add("desktop-open");
      trigger.textContent = "▲";
      trigger.setAttribute("aria-expanded", "true");
    };

    const closeDesktop = () => desktopNav.close();

    const toggleDesktop = () => {
      if (nav.classList.contains("desktop-open")) closeDesktop();
      else openDesktop();
    };

    trigger.addEventListener("click", toggleDesktop);
    trigger.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleDesktop(); }
    });

    document.addEventListener("click", (e) => {
      if (nav.classList.contains("desktop-open") && !nav.contains(e.target) && !trigger.contains(e.target)) {
        closeDesktop();
      }
    });
  }

  // ── Mobile navigation owner ───────────────────────────────
  const mobileNav = {
    close() {
      const button = document.querySelector(".menu-toggle");
      const nav = document.querySelector(".nav-links");
      if (!button || !nav) return;
      nav.classList.remove("mobile-open");
      button.textContent = "☰";
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", "Open navigation");
    }
  };

  function initMobileNav() {
    const button = document.querySelector(".menu-toggle");
    const nav = document.querySelector(".nav-links");
    if (!button || !nav) return;

    const openMobile = () => {
      nav.classList.add("mobile-open");
      button.textContent = "✕";
      button.setAttribute("aria-expanded", "true");
      button.setAttribute("aria-label", "Close navigation");
    };

    const closeMobile = () => mobileNav.close();

    button.addEventListener("click", () => {
      if (nav.classList.contains("mobile-open")) closeMobile();
      else openMobile();
    });

    nav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", closeMobile);
    });
  }

  // ── Shared Escape handler ─────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const nav = document.querySelector(".nav-links");
    if (!nav) return;
    if (nav.classList.contains("mobile-open")) mobileNav.close();
    if (nav.classList.contains("desktop-open")) desktopNav.close();
  });

  initDesktopNav();
  initMobileNav();

  document.querySelectorAll(".jeff-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      summonJeff();
    });
  });

  function initPasswordToggles(root = document) {
    root.querySelectorAll("[data-password-toggle]").forEach((button) => {
      if (button.dataset.passwordToggleBound) return;
      button.dataset.passwordToggleBound = "true";

      const input = root.querySelector("#" + button.getAttribute("data-password-toggle"));
      if (!input) return;

      button.setAttribute("type", "button");
      button.setAttribute("aria-label", "Show password");

      button.addEventListener("click", () => {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
        button.classList.toggle("password-toggle--visible", !showing);
      });
    });
  }

  initPasswordToggles();
});
