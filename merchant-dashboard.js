/* =============================================================
   Little Oddities Curiosities — Merchant Dashboard
   merchant-dashboard.js

   Completely separate from script.js — no shared state.
   Modules:
     AUTH        — login, token storage, expiry, logout
     FULFILMENT  — localStorage-backed order status tracking
     DATA        — fetch orders from Netlify Function
     FORMAT      — price and date helpers
     RENDER      — order cards, stats text
     FILTER      — search and status filtering
     EXPORT      — CSV download
     UI          — tabs, loading/error states, login/dashboard toggle
     INIT        — wires everything together on DOMContentLoaded

   Fulfilment statuses are stored in localStorage.
   They persist across browser sessions on the same device.
   ============================================================= */

"use strict";

/* ============================================================
   Constants
   ============================================================ */

const AUTH_TOKEN_KEY   = "lo_merchant_token";
const FULFILMENT_KEY   = "lo_fulfilment_statuses";
const LOGIN_URL        = "/.netlify/functions/dashboard-login";
const ORDERS_URL       = "/.netlify/functions/get-orders";

/** Configuration for each fulfilment status */
const STATUS_CONFIG = {
  new:       { label: "New Order",  emoji: "🔵", color: "var(--status-new)"       },
  preparing: { label: "Preparing",  emoji: "🟡", color: "var(--status-preparing)" },
  packed:    { label: "Packed",     emoji: "🟠", color: "var(--status-packed)"     },
  posted:    { label: "Posted",     emoji: "🟣", color: "var(--status-posted)"     },
  completed: { label: "Completed",  emoji: "🟢", color: "var(--status-completed)"  }
};

/** Ordered progression of fulfilment states */
const STATUS_FLOW = ["new", "preparing", "packed", "posted", "completed"];

/** What the advance button says at each stage (null = no button shown) */
const STATUS_BUTTON_LABELS = {
  new:       "Prepare",
  preparing: "Mark Packed",
  packed:    "Mark Posted",
  posted:    "Complete",
  completed: null
};

/* ============================================================
   Module: Auth
   ============================================================ */

function getToken() {
  return sessionStorage.getItem(AUTH_TOKEN_KEY);
}

function saveToken(token) {
  sessionStorage.setItem(AUTH_TOKEN_KEY, token);
}

function clearToken() {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
}

/** Client-side expiry check — server always validates independently */
function isTokenExpired(token) {
  if (!token) return true;
  try {
    const dotIndex = token.lastIndexOf(".");
    if (dotIndex === -1) return true;
    const timestamp = parseInt(token.substring(0, dotIndex), 10);
    if (isNaN(timestamp)) return true;
    return (Date.now() - timestamp) >= 8 * 60 * 60 * 1000; /* 8 hours */
  } catch {
    return true;
  }
}

/** POST to dashboard-login function and return the auth token */
async function login(password) {
  const response = await fetch(LOGIN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ password })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Login failed.");
  return data.token;
}

/* ============================================================
   Module: Fulfilment Status (localStorage)
   ============================================================ */

function getFulfilmentStatuses() {
  try {
    return JSON.parse(localStorage.getItem(FULFILMENT_KEY)) || {};
  } catch {
    return {};
  }
}

function getFulfilmentStatus(orderId) {
  return getFulfilmentStatuses()[orderId] || "new";
}

function setFulfilmentStatus(orderId, status) {
  const statuses  = getFulfilmentStatuses();
  statuses[orderId] = status;
  localStorage.setItem(FULFILMENT_KEY, JSON.stringify(statuses));
}

/** Move an order to the next status in the flow */
function advanceFulfilmentStatus(orderId) {
  const current = getFulfilmentStatus(orderId);
  const idx     = STATUS_FLOW.indexOf(current);
  if (idx < STATUS_FLOW.length - 1) {
    const next = STATUS_FLOW[idx + 1];
    setFulfilmentStatus(orderId, next);
    return next;
  }
  return current;
}

/* ============================================================
   Module: Data
   ============================================================ */

/** Fetch orders from the Netlify Function, return normalised array */
async function fetchOrders() {
  const token = getToken();
  const response = await fetch(ORDERS_URL, {
    headers: { "Authorization": `Bearer ${token}` }
  });

  /* If 401, the session has expired — redirect to login */
  if (response.status === 401) {
    clearToken();
    showLogin();
    throw new Error("Your session has expired. Please log in again.");
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "The ledger could not be consulted.");
  }

  const { orders } = await response.json();
  return Array.isArray(orders) ? orders : [];
}

/* ============================================================
   Module: Formatting
   ============================================================ */

function formatPrice(amount, currency = "GBP") {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      currencyDisplay: "symbol"
    }).format(amount);
  } catch {
    return `£${Number(amount || 0).toFixed(2)}`;
  }
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric"
  });
}

function formatDateShort(timestamp) {
  return new Date(timestamp).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric"
  });
}

/* ============================================================
   Module: Rendering
   ============================================================ */

/** Build the HTML string for a single order card */
function buildOrderCard(order) {
  const status     = getFulfilmentStatus(order.id);
  const config     = STATUS_CONFIG[status] || STATUS_CONFIG.new;
  const nextLabel  = STATUS_BUTTON_LABELS[status];

  const itemsHtml = order.items.length
    ? order.items.map((item) =>
        `<span class="order-item">✦ ${escapeHtml(item.name)} ×${item.quantity}</span>`
      ).join("")
    : `<span class="order-item" style="color:var(--text-muted)">No items recorded</span>`;

  const addressRow = order.shippingAddress
    ? `<div class="order-detail-row">
         <span class="detail-label">Ships to</span>
         <span>${escapeHtml(order.shippingAddress)}</span>
       </div>`
    : "";

  const shippingRow = order.shippingMethod
    ? `<div class="order-detail-row">
         <span class="detail-label">Journey</span>
         <span>${escapeHtml(order.shippingMethod)}${order.shippingAmount ? ` · ${formatPrice(order.shippingAmount, order.currency)}` : ""}</span>
       </div>`
    : "";

  const advanceBtn = nextLabel
    ? `<button class="btn-status"
               data-action="advance"
               data-order-id="${order.id}">${nextLabel}</button>`
    : `<span style="font-size:0.8rem;color:var(--text-muted);font-style:italic;">Order complete ✦</span>`;

  const newBadge = status === "new"
    ? `<span style="font-size:0.7rem;color:var(--status-new);font-weight:bold;letter-spacing:0.05em;">NEW</span>`
    : "";

  return `
    <article class="order-card${status === "new" ? " order-card--new" : ""}"
             data-order-id="${order.id}">

      <div class="order-card-header">
        <div class="order-card-title">
          <span class="order-status-dot" style="background:${config.color}"></span>
          <span class="order-badge">#${order.shortId}</span>
          ${newBadge}
          <span class="order-date">${formatDateShort(order.created)}</span>
        </div>
        <span class="order-status-label" style="color:${config.color}">
          ${config.emoji} ${config.label}
        </span>
      </div>

      <div class="order-card-body">
        <div class="order-detail-row">
          <span class="detail-label">Traveller</span>
          <span>${escapeHtml(order.customerName)}</span>
        </div>
        <div class="order-detail-row">
          <span class="detail-label">Email</span>
          <span>${escapeHtml(order.customerEmail)}</span>
        </div>
        ${addressRow}
        ${shippingRow}
        <div class="order-detail-row">
          <span class="detail-label">Treasures</span>
          <div class="order-items">${itemsHtml}</div>
        </div>
        <div class="order-detail-row">
          <span class="detail-label">Payment</span>
          <span class="order-total">${formatPrice(order.amountTotal, order.currency)}</span>
        </div>
        <div class="order-detail-row order-id-row">
          <span class="detail-label">Ref</span>
          <span class="order-id-text">${order.id}</span>
        </div>
      </div>

      <div class="order-card-actions">
        ${advanceBtn}
      </div>
    </article>
  `;
}

/**
 * Render an array of orders as cards into a container.
 * Pass an empty array to show the empty state.
 */
function renderOrderCards(orders, container) {
  if (!container) return;

  if (!orders.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-emblem">🗝️</div>
        <h3>No treasures claimed yet.</h3>
        <p>Orders completed through the Merchant's Counter will appear here.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = orders.map(buildOrderCard).join("");
}

/** Update the stats elements in both the Home and Tallies tabs */
function renderStats(stats) {
  setText("stat-today",   stats.today);
  setText("stat-month",   stats.month);
  setText("stat-revenue", formatPrice(stats.revenue));
  setText("stat-avg",     stats.total ? formatPrice(stats.avg) : "—");

  setText("detail-total",     stats.total);
  setText("detail-today",     stats.today);
  setText("detail-week",      stats.week);
  setText("detail-month",     stats.month);
  setText("detail-revenue",   formatPrice(stats.revenue));
  setText("detail-avg",       stats.total ? formatPrice(stats.avg) : "—");
  setText("detail-highest",   stats.total ? formatPrice(stats.highest) : "—");
  setText("detail-lowest",    stats.total ? formatPrice(stats.lowest) : "—");
  setText("detail-new",       stats.statusCounts.new);
  setText("detail-preparing", stats.statusCounts.preparing);
  setText("detail-packed",    stats.statusCounts.packed);
  setText("detail-posted",    stats.statusCounts.posted);
  setText("detail-completed", stats.statusCounts.completed);
}

/* ============================================================
   Module: Statistics
   ============================================================ */

function computeStats(orders) {
  const now        = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const weekStart  = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).getTime();

  const total   = orders.length;
  const today   = orders.filter((o) => o.created >= todayStart).length;
  const month   = orders.filter((o) => o.created >= monthStart).length;
  const week    = orders.filter((o) => o.created >= weekStart).length;
  const revenue = orders.reduce((sum, o) => sum + o.amountTotal, 0);
  const avg     = total ? revenue / total : 0;
  const highest = total ? Math.max(...orders.map((o) => o.amountTotal)) : 0;
  const lowest  = total ? Math.min(...orders.map((o) => o.amountTotal)) : 0;

  /* Count orders by current fulfilment status */
  const statusCounts = { new: 0, preparing: 0, packed: 0, posted: 0, completed: 0 };
  orders.forEach((o) => {
    const s = getFulfilmentStatus(o.id);
    if (s in statusCounts) statusCounts[s]++;
  });

  return { total, today, week, month, revenue, avg, highest, lowest, statusCounts };
}

/* ============================================================
   Module: Search & Filter
   ============================================================ */

function filterOrders(orders, query, statusFilter) {
  const q = query.trim().toLowerCase();

  return orders.filter((order) => {
    const matchesQuery = !q
      || order.customerName.toLowerCase().includes(q)
      || order.customerEmail.toLowerCase().includes(q)
      || order.id.toLowerCase().includes(q)
      || order.shortId.toLowerCase().includes(q)
      || (order.paymentIntentId && order.paymentIntentId.toLowerCase().includes(q));

    const matchesStatus = !statusFilter || getFulfilmentStatus(order.id) === statusFilter;

    return matchesQuery && matchesStatus;
  });
}

/* ============================================================
   Module: CSV Export
   ============================================================ */

function exportCSV(orders) {
  const headers = [
    "Order Ref", "Date", "Traveller Name", "Email", "Shipping Address",
    "Shipping Method", "Shipping Amount (£)", "Treasures", "Total Paid (£)", "Currency", "Payment Status",
    "Fulfilment Status", "Stripe Session ID", "Payment Intent ID"
  ];

  const rows = orders.map((order) => {
    const itemsText    = order.items.map((i) => `${i.name} x${i.quantity}`).join(" | ");
    const status       = getFulfilmentStatus(order.id);
    const statusLabel  = STATUS_CONFIG[status]?.label || status;

    return [
      order.shortId,
      formatDate(order.created),
      order.customerName,
      order.customerEmail,
      order.shippingAddress || "",
      order.shippingMethod || "",
      order.shippingAmount ? order.shippingAmount.toFixed(2) : "0.00",
      itemsText,
      order.amountTotal.toFixed(2),
      order.currency,
      order.paymentStatus,
      statusLabel,
      order.id,
      order.paymentIntentId || ""
    ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",");
  });

  const csv  = [headers.join(","), ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }); /* BOM for Excel */
  const url  = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href     = url;
  link.download = `little-oddities-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/* ============================================================
   Module: Inventory
   ============================================================ */

const INVENTORY_URL        = "/.netlify/functions/get-inventory";
const UPDATE_INVENTORY_URL = "/.netlify/functions/update-inventory";

/** Cached inventory object { [productId]: entry } */
let allInventory = {};
/** Cached products array from catalogue.json */
let allProducts  = [];

const INV_OUT_OF_STOCK_LABELS = {
  roaming:   "🕯️ Roaming the land...",
  returning: "🌙 Returning before long...",
  bespoke:   "✦ Available to order..."
};

async function fetchInventory() {
  const response = await fetch(INVENTORY_URL, { cache: "no-store" });
  if (!response.ok) throw new Error("Supplies could not be loaded.");
  const { inventory } = await response.json();
  allInventory = inventory || {};
  return allInventory;
}

async function fetchProductCatalogue() {
  const response = await fetch("./data/catalogue.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Catalogue could not be loaded.");
  const data = await response.json();
  allProducts = Array.isArray(data) ? data : (data.products || []);
  return allProducts;
}

/**
 * Posts an inventory update to the Netlify Function.
 * On success, refreshes the inventory display.
 */
async function postInventoryUpdate(action, productId, value) {
  const token = getToken();
  const response = await fetch(UPDATE_INVENTORY_URL, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ action, productId, value })
  });

  if (response.status === 401) { clearToken(); showLogin(); return; }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Update failed.");
  }

  const { inventory } = await response.json();
  allInventory = inventory || {};
  renderInventoryTable(allProducts, allInventory);
  renderInventoryStats(allProducts, allInventory);
}

/** Resolve stock status for a single product */
function resolveStockStatus(productId) {
  const inv = allInventory[productId];
  if (!inv)                          return "unlimited";
  if (inv.available === false)       return "off";
  if (inv.stock === null)            return "unlimited";
  if (inv.stock === 0)               return "out";
  if (inv.stock <= (inv.lowStockThreshold || 3)) return "low";
  return "in";
}

function stockBadgeHtml(status, stock) {
  const labels = {
    unlimited: `<span class="stock-badge stock-badge--in">♾ Unlimited</span>`,
    in:        `<span class="stock-badge stock-badge--in">🟢 In Stock (${stock})</span>`,
    low:       `<span class="stock-badge stock-badge--low">🟡 Low Stock (${stock})</span>`,
    out:       `<span class="stock-badge stock-badge--out">🔴 Out of Stock</span>`,
    off:       `<span class="stock-badge stock-badge--off">⚫ Unavailable</span>`
  };
  return labels[status] || labels.unlimited;
}

function renderInventoryStats(products, inventory) {
  let inStock = 0, lowStock = 0, outStock = 0, totalUnits = 0;

  products.forEach((p) => {
    const status = resolveStockStatus(p.id);
    const inv    = inventory[p.id];
    if (status === "in")        inStock++;
    if (status === "low")     { inStock++; lowStock++; }
    if (status === "out" || status === "off") outStock++;
    if (inv && inv.stock !== null) totalUnits += inv.stock;
  });

  setText("inv-stat-total",   products.length);
  setText("inv-stat-instock", inStock);
  setText("inv-stat-low",     lowStock);
  setText("inv-stat-out",     outStock);
  setText("inv-stat-units",   totalUnits);
}

function renderInventoryTable(products, inventory, query = "", statusFilter = "") {
  const tbody = document.getElementById("inventory-tbody");
  if (!tbody) return;

  const q = query.trim().toLowerCase();

  const filtered = products.filter((p) => {
    const matchQuery  = !q || p.name.toLowerCase().includes(q) || p.collection.toLowerCase().includes(q);
    const status      = resolveStockStatus(p.id);
    const matchStatus = !statusFilter || status === statusFilter;
    return matchQuery && matchStatus;
  });

  setText("inv-count",
    `${filtered.length} treasure${filtered.length === 1 ? "" : "s"} found`);

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr><td colspan="7" style="text-align:center;padding:3rem;color:var(--text-muted);font-style:italic;">
        No treasures match your search.
      </td></tr>`;
    return;
  }

  /* Build the per-product message map before writing innerHTML so we can
     reliably restore each select's value afterwards.  Browsers do not always
     honour the `selected` attribute on <option> elements that are created
     through innerHTML — they may carry over the last user-interaction value
     from the previous render, making every product appear to share the same
     Out of Stock Message.  Setting select.value explicitly after the DOM is
     written is the authoritative fix. */
  const productMsgKeys = {};
  filtered.forEach((p) => {
    const inv = inventory[p.id] || {};
    productMsgKeys[p.id] = inv.outOfStockMessage || "roaming";
  });

  tbody.innerHTML = filtered.map((product) => {
    const inv     = inventory[product.id] || {};
    const stock   = inv.stock ?? null;
    const status  = resolveStockStatus(product.id);
    const badge   = stockBadgeHtml(status, stock);
    const msgKey  = inv.outOfStockMessage || "roaming";
    const avail   = inv.available !== false;

    const hasImage = Array.isArray(product.images) && product.images.length;
    const imgHtml  = hasImage
      ? `<img class="inv-product-img" src="assets/images/products/${product.id}/${product.images[0]}" alt="${escapeHtml(product.name)}" onerror="this.style.display='none'">`
      : `<div class="inv-product-img-placeholder">${escapeHtml(product.icon || "✦")}</div>`;

    /* Build message selector */
    const msgOptions = Object.entries(INV_OUT_OF_STOCK_LABELS)
      .map(([k, v]) => `<option value="${k}"${k === msgKey ? " selected" : ""}>${v}</option>`)
      .join("");

    return `
      <tr data-product-id="${product.id}">
        <td>
          <div class="inv-product-cell">
            ${imgHtml}
            <div>
              <div class="inv-product-name">${escapeHtml(product.name)}</div>
              <div class="inv-product-collection">${escapeHtml(product.collection)}</div>
            </div>
          </div>
        </td>
        <td>${badge}</td>
        <td>
          <input class="stock-input"
                 type="number" min="0" value="${stock === null ? "" : stock}"
                 placeholder="∞"
                 data-action="setStock"
                 data-product-id="${product.id}"
                 title="Set exact stock (leave blank for unlimited)">
        </td>
        <td>
          <div class="stock-controls">
            <button class="btn-stock-adj" data-action="adjustStock" data-product-id="${product.id}" data-value="-1" title="Remove 1">−</button>
            <button class="btn-stock-adj" data-action="adjustStock" data-product-id="${product.id}" data-value="1"  title="Add 1">+</button>
            <button class="btn-stock-adj" data-action="adjustStock" data-product-id="${product.id}" data-value="10" title="Add 10" style="width:auto;padding:0 8px;font-size:0.78rem;">+10</button>
          </div>
        </td>
        <td>
          <input class="stock-input"
                 type="number" min="0" value="${inv.lowStockThreshold ?? 3}"
                 data-action="setThreshold"
                 data-product-id="${product.id}"
                 title="Show low stock warning when stock falls to this number">
        </td>
        <td>
          <select class="message-select"
                  data-action="setMessage"
                  data-product-id="${product.id}">
            ${msgOptions}
          </select>
        </td>
        <td>
          ${avail
            ? `<button class="btn-secondary" style="font-size:0.8rem;padding:0.4rem 0.8rem;"
                       data-action="setAvailable" data-product-id="${product.id}" data-value="false">
                 Mark Unavailable
               </button>`
            : `<button class="btn-secondary" style="font-size:0.8rem;padding:0.4rem 0.8rem;color:var(--status-completed);border-color:var(--status-completed);"
                       data-action="setAvailable" data-product-id="${product.id}" data-value="true">
                 Restore
               </button>`}
        </td>
      </tr>
    `;
  }).join("");

  const rows = tbody.querySelectorAll("tr[data-product-id]");
  filtered.forEach((product, i) => {
    const row = rows[i];
    if (!row) return;
    const productId = product.id;

    row.setAttribute("data-product-id", productId);
    row.querySelectorAll("[data-action]").forEach((el) => {
      el.dataset.productId = productId;
    });

    const messageSelect = row.querySelector("select[data-action='setMessage']");
    if (messageSelect) {
      messageSelect.value = productMsgKeys[productId] || "roaming";
    }
  });

  renderInventoryStats(products, inventory);
}

function exportInventoryCSV(products, inventory) {
  const headers = [
    "Treasure", "Collection", "Stock", "Status", "Low Stock Threshold",
    "Out of Stock Message", "Available", "Last Updated"
  ];

  const rows = products.map((p) => {
    const inv    = inventory[p.id] || {};
    const status = resolveStockStatus(p.id);
    return [
      p.name,
      p.collection,
      inv.stock === null || inv.stock === undefined ? "Unlimited" : inv.stock,
      status,
      inv.lowStockThreshold ?? 3,
      inv.outOfStockMessage || "roaming",
      inv.available !== false ? "Yes" : "No",
      inv.lastUpdated ? new Date(inv.lastUpdated).toLocaleDateString("en-GB") : "Never"
    ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",");
  });

  const csv  = [headers.join(","), ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href     = url;
  link.download = `little-oddities-supplies-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function loadAndRenderInventory() {
  try {
    await Promise.all([
      fetchInventory(),
      allProducts.length ? Promise.resolve(allProducts) : fetchProductCatalogue()
    ]);
    renderInventoryTable(allProducts, allInventory);
    renderInventoryStats(allProducts, allInventory);
  } catch (error) {
    console.error("Inventory load error:", error.message);
  }
}

function initInventoryUI() {
  const searchInput  = document.getElementById("inv-search-input");
  const statusFilter = document.getElementById("inv-status-filter");

  /* Search and filter */
  function applyInvFilter() {
    renderInventoryTable(
      allProducts, allInventory,
      searchInput?.value || "",
      statusFilter?.value || ""
    );
  }

  searchInput?.addEventListener("input", applyInvFilter);
  statusFilter?.addEventListener("change", applyInvFilter);

  /* Export */
  document.getElementById("inv-export-csv")?.addEventListener("click", () => {
    exportInventoryCSV(allProducts, allInventory);
  });

  /* Bulk restock */
  document.getElementById("inv-bulk-restock")?.addEventListener("click", async () => {
    const amount = Number(window.prompt("Add how many units to every tracked treasure?", "10"));
    if (!amount || isNaN(amount)) return;
    try {
      await postInventoryUpdate("bulkRestock", null, amount);
      showToast(`Added ${amount} to every treasure's stock.`);
    } catch (error) {
      showToast(error.message);
    }
  });

  /* Delegated: stock input changes (setStock, setThreshold) */
  document.getElementById("inventory-table")?.addEventListener("change", async (event) => {
    const input = event.target.closest("[data-action]");
    if (!input) return;
    const { action, productId } = input.dataset;
    if (action !== "setStock" && action !== "setThreshold" && action !== "setMessage") return;

    const rawValue = input.value.trim();
    const value    = action === "setMessage"
      ? rawValue
      : rawValue === ""
      ? null
      : Math.max(0, parseInt(rawValue, 10) || 0);

    try {
      await postInventoryUpdate(action, productId, value);
    } catch (error) {
      showToast(error.message);
    }
  });

  /* Delegated: adjust buttons and availability toggles */
  document.getElementById("inventory-table")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn || btn.tagName === "INPUT" || btn.tagName === "SELECT") return;

    const { action, productId } = btn.dataset;
    let value = btn.dataset.value;

    if (action === "adjustStock") {
      value = parseInt(value, 10) || 0;
    } else if (action === "setAvailable") {
      value = value === "true";
    } else {
      return;
    }

    try {
      await postInventoryUpdate(action, productId, value);
    } catch (error) {
      showToast(error.message);
    }
  });
}

/* ============================================================
   Module: UI helpers
   ============================================================ */

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/** Escape user-supplied strings inserted into innerHTML */
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("dashboard").classList.add("hidden");
}

function showDashboard() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");
}

function showLoading() {
  document.getElementById("loading-state").classList.remove("hidden");
  document.getElementById("error-state").classList.add("hidden");
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
}

function hideLoading() {
  document.getElementById("loading-state").classList.add("hidden");
}

function showError(message) {
  document.getElementById("loading-state").classList.add("hidden");
  const errorState = document.getElementById("error-state");
  const errorMsg   = document.getElementById("error-message");
  errorState.classList.remove("hidden");
  if (errorMsg) errorMsg.textContent = message;
}

function activateTab(tabName) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `tab-${tabName}`);
  });
}

/* ============================================================
   State
   ============================================================ */

/** All orders fetched from Stripe — module-level so all renderers share them */
let allOrders = [];

/* ============================================================
   Main: render everything once orders are loaded
   ============================================================ */

function renderDashboard(orders) {
  allOrders = [...orders].sort((a, b) => b.created - a.created);

  /* Home tab date */
  setText("home-date", new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }));

  /* Stats */
  renderStats(computeStats(allOrders));

  /* Recent orders — newest 6 on the home tab */
  renderOrderCards(allOrders.slice(0, 6), document.getElementById("recent-orders"));

  /* Full ledger */
  renderOrderCards(allOrders, document.getElementById("orders-list"));

  /* Order count label */
  setText("orders-count",
    `${allOrders.length} treasure${allOrders.length === 1 ? "" : "s"} in the ledger`);
}

async function loadAndRender() {
  showLoading();
  try {
    const orders = await fetchOrders();
    hideLoading();
    renderDashboard(orders);
    activateTab("home");
  } catch (error) {
    showError(error.message);
  }
}

/* ============================================================
   Init: wire up all event listeners
   ============================================================ */

function initLogin() {
  const form    = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");
  const button  = document.getElementById("login-button");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.getElementById("login-password")?.value || "";

    button.disabled    = true;
    button.textContent = "Consulting the ledger...";
    errorEl.classList.add("hidden");
    errorEl.textContent = "";

    try {
      const token = await login(password);
      saveToken(token);
      showDashboard();
      initDashboardUI(); /* Wire dashboard listeners now that it's visible */
      loadAndRender();
    } catch (error) {
      errorEl.textContent = error.message || "Incorrect key. The ledger remains closed.";
      errorEl.classList.remove("hidden");
      button.disabled    = false;
      button.textContent = "Open the Ledger";
    }
  });
}

/** Wire all dashboard interactions — called once after login or if already authenticated */
function initDashboardUI() {

  /* Tab navigation */
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      activateTab(tab);
      /* Load inventory data when the Supplies tab is first opened */
      if (tab === "supplies" && !allProducts.length) {
        loadAndRenderInventory();
      }
    });
  });

  /* Inventory module */
  initInventoryUI();

  /* Search & filter (ledger tab) */
  const searchInput    = document.getElementById("search-input");
  const statusFilter   = document.getElementById("status-filter");
  const ordersContainer = document.getElementById("orders-list");

  function applyFilter() {
    const query   = searchInput?.value  || "";
    const status  = statusFilter?.value || "";
    const filtered = filterOrders(allOrders, query, status);

    setText("orders-count",
      `${filtered.length} treasure${filtered.length === 1 ? "" : "s"} found`);

    renderOrderCards(filtered, ordersContainer);
  }

  searchInput?.addEventListener("input", applyFilter);
  statusFilter?.addEventListener("change", applyFilter);

  /* Single delegated listener for fulfilment advance buttons */
  document.querySelector(".dashboard-main")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='advance']");
    if (!button) return;

    const orderId = button.dataset.orderId;
    advanceFulfilmentStatus(orderId);

    /* Re-render every card showing this order (home tab + ledger tab may both show it) */
    const order = allOrders.find((o) => o.id === orderId);
    if (!order) return;

    document.querySelectorAll(`.order-card[data-order-id="${orderId}"]`).forEach((card) => {
      const temp = document.createElement("div");
      temp.innerHTML = buildOrderCard(order).trim();
      card.replaceWith(temp.firstElementChild);
    });

    /* Refresh stat counts */
    renderStats(computeStats(allOrders));
  });

  /* CSV export */
  document.getElementById("export-csv")?.addEventListener("click", () => {
    exportCSV(allOrders);
  });

  /* Logout */
  document.getElementById("logout-button")?.addEventListener("click", () => {
    clearToken();
    allOrders = [];
    showLogin();
  });

  /* Manual refresh */
  document.getElementById("refresh-button")?.addEventListener("click", () => {
    loadAndRender();
  });

  /* Retry after error */
  document.getElementById("retry-button")?.addEventListener("click", () => {
    loadAndRender();
  });
}

/* ============================================================
   Entry point
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  const token = getToken();

  /* Always wire up the login form */
  initLogin();

  if (!token || isTokenExpired(token)) {
    /* Not logged in — show login screen */
    clearToken();
    showLogin();
    return;
  }

  /* Already authenticated — go straight to dashboard */
  showDashboard();
  initDashboardUI();
  loadAndRender();
});
