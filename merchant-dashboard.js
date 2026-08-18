/* =============================================================
   Little Oddities Curiosities — Merchant Dashboard
   merchant-dashboard.js

   Completely separate from script.js — no shared state.
   Modules:
     AUTH        — login, token storage, expiry, logout
     FULFILMENT  — Blobs-backed order status tracking (via
                   get-order-status.js / update-order-status.js),
                   cached in memory for synchronous rendering
     DATA        — fetch orders from Netlify Function
     FORMAT      — price and date helpers
     RENDER      — order cards, stats text
     FILTER      — search and status filtering
     EXPORT      — CSV download
     UI          — tabs, loading/error states, login/dashboard toggle
     INIT        — wires everything together on DOMContentLoaded

   Fulfilment statuses live in the shared "order-status" Blobs store
   so that customer-facing Merchant's Messages can read them too.
   ============================================================= */

"use strict";

/* ============================================================
   Constants
   ============================================================ */

const AUTH_TOKEN_KEY      = "lo_merchant_token";
// G7Cloud runs the Node server, not Netlify Functions. Keep every Merchant
// Dashboard request on the server's explicit API surface.
const LOGIN_URL               = "/api/dashboard-login";
const ORDERS_URL              = "/api/get-orders";
const GET_ORDER_STATUS_URL    = "/api/get-order-status";
const UPDATE_ORDER_STATUS_URL = "/api/update-order-status";

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
  if (!response.ok) {
    let message = String(data.error || "Login failed.");
    message = message.replace(
      "Please set DASHBOARD_PASSWORD and DASHBOARD_SECRET in your Netlify environment variables.",
      "Please set dashboard credentials in the G7Cloud runtime environment."
    );
    message = message.replace(
      "Please set DASHBOARD_PASSWORD and DASHBOARD_SECRET in the G7Cloud runtime environment.",
      "Please set dashboard credentials in the G7Cloud runtime environment."
    );
    throw new Error(message);
  }
  return data.token;
}

/* ============================================================
   Module: Fulfilment Status (Netlify Blobs, in-memory cache)
   ============================================================ */

/** In-memory cache of { [orderId]: status } — populated by fetchFulfilmentStatuses() */
let fulfilmentCache = {};

/** Fetch all order statuses from Blobs and populate the in-memory cache */
async function fetchFulfilmentStatuses() {
  const token = getToken();
  try {
    const response = await fetch(GET_ORDER_STATUS_URL, {
      headers: { "Authorization": `Bearer ${token}` }
    });

    if (response.status === 401) {
      clearToken();
      showLogin();
      return;
    }
    if (!response.ok) return;

    const { statuses } = await response.json();
    fulfilmentCache = {};
    Object.entries(statuses || {}).forEach(([orderId, record]) => {
      fulfilmentCache[orderId] = record.status;
    });
  } catch (error) {
    console.error("Order status load error:", error.message);
  }
}

function getFulfilmentStatuses() {
  return fulfilmentCache;
}

function getFulfilmentStatus(orderId) {
  return fulfilmentCache[orderId] || "new";
}

/** Update the in-memory cache immediately, then persist to Blobs in the background */
function setFulfilmentStatus(orderId, status) {
  fulfilmentCache[orderId] = status;

  const token = getToken();
  fetch(UPDATE_ORDER_STATUS_URL, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ orderId, status })
  }).then((response) => {
    if (response.status === 401) {
      clearToken();
      showLogin();
      return;
    }
    if (!response.ok) {
      return response.json().catch(() => ({})).then((data) => {
        showToast(data.error || "Order status could not be saved.");
      });
    }
  }).catch((error) => {
    console.error("Order status save error:", error.message);
    showToast("Order status could not be saved.");
  });
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

  const { orders, hasMore, nextCursor } = await response.json();
  return {
    orders:     Array.isArray(orders) ? orders : [],
    hasMore:    !!hasMore,
    nextCursor: hasMore ? nextCursor : null
  };
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

/** Build a single spreadsheet-style register row for an order */
function buildLedgerRow(order) {
  const status      = getFulfilmentStatus(order.id);
  const config      = STATUS_CONFIG[status] || STATUS_CONFIG.new;
  const nextLabel   = STATUS_BUTTON_LABELS[status];
  const itemsCount  = order.items.reduce((n, i) => n + (Number(i.quantity) || 1), 0);

  /* Item names already carry "(Size: …)" from Stripe's line-item description,
     so no backend change is needed — surface them beneath the count for quick
     scanning in the register. */
  const itemsSummary = order.items.length
    ? order.items.map((i) =>
        `${escapeHtml(i.name)} ×${Number(i.quantity) || 1}`
    ).join("<br>")
    : "";

  const statusCell = `<span class="ledger-status-badge" style="color:${config.color}">${config.emoji} ${config.label}</span>`;

  const advanceBtn = nextLabel
    ? `<button class="btn-status btn-status-sm" data-action="advance" data-order-id="${order.id}">${nextLabel}</button>`
    : `<span class="ledger-done">✦ Done</span>`;

  return `
    <tr data-order-id="${order.id}">
      <td data-label="Order"><span class="order-badge">#${order.shortId}</span></td>
      <td data-label="Date">${formatDateShort(order.created)}</td>
      <td data-label="Customer">${escapeHtml(order.customerName)}</td>
      <td data-label="Treasures" class="ledger-col-treasures">${itemsCount}${itemsSummary ? `<div class="ledger-treasures-detail">${itemsSummary}</div>` : ""}</td>
      <td data-label="Total" class="ledger-col-total">${formatPrice(order.amountTotal, order.currency)}</td>
      <td data-label="Status" class="ledger-col-status">${statusCell}</td>
      <td data-label="Actions" class="ledger-col-actions">
        <button class="btn-secondary btn-status-sm" data-action="view" data-order-id="${order.id}">View</button>
        ${advanceBtn}
      </td>
    </tr>`;
}

/** Render the order register rows into the ledger <tbody> */
function renderLedgerRows(orders, tbody) {
  if (!tbody) return;

  if (!orders.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="ledger-empty">No treasures match the current incantations.</td>
      </tr>`;
    return;
  }

  tbody.innerHTML = orders.map(buildLedgerRow).join("");
}

/* ── Ledger filter + sort + date helpers ─────────────────────── */

function getDateRangeFilter() {
  const mode = (document.getElementById("date-filter")?.value || "all");

  if (mode === "today") {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return { from: start.getTime(), to: Infinity };
  }
  if (mode === "week") {
    const start = new Date();
    start.setDate(start.getDate() - 7); start.setHours(0, 0, 0, 0);
    return { from: start.getTime(), to: Infinity };
  }
  if (mode === "month") {
    const start = new Date();
    start.setDate(start.getDate() - 30);
    start.setHours(0, 0, 0, 0);
    return { from: start.getTime(), to: Infinity };
  }
  if (mode === "custom") {
    const fromVal = document.getElementById("date-from")?.value;
    const toVal   = document.getElementById("date-to")?.value;
    if (!fromVal && !toVal) return null;

    let from = -Infinity;
    let to   = Infinity;
    if (fromVal) {
      const d = new Date(fromVal + "T00:00:00");
      if (!isNaN(d.getTime())) from = d.getTime();
    }
    if (toVal) {
      const d = new Date(toVal + "T23:59:59");
      if (!isNaN(d.getTime())) to = d.getTime();
    }
    return { from, to };
  }
  return null;
}

function inDateRange(created, range) {
  if (!range) return true;
  return created >= range.from && created <= range.to;
}

function sortOrders(list, sort) {
  const copy = [...list];
  switch (sort) {
    case "oldest":  return copy.sort((a, b) => a.created - b.created);
    case "highest": return copy.sort((a, b) => b.amountTotal - a.amountTotal);
    case "lowest":  return copy.sort((a, b) => a.amountTotal - b.amountTotal);
    case "newest":
    default:        return copy.sort((a, b) => b.created - a.created);
  }
}

/** Apply every active filter + sort to the master order list */
function applyLedgerFilters() {
  const query  = (document.getElementById("search-input")?.value || "").trim().toLowerCase();
  const status = document.getElementById("status-filter")?.value || "";
  const sort   = document.getElementById("sort-filter")?.value || "newest";
  const range  = getDateRangeFilter();

  const filtered = allOrders.filter((order) => {
    const matchesQuery = !query
      || order.customerName.toLowerCase().includes(query)
      || order.customerEmail.toLowerCase().includes(query)
      || order.id.toLowerCase().includes(query)
      || order.shortId.toLowerCase().includes(query)
      || (order.paymentIntentId && order.paymentIntentId.toLowerCase().includes(query));

    const matchesStatus = !status || getFulfilmentStatus(order.id) === status;
    const matchesDate   = inDateRange(order.created, range);

    return matchesQuery && matchesStatus && matchesDate;
  });

  return sortOrders(filtered, sort);
}

function buildLedgerHint() {
  const parts = [];
  const status = document.getElementById("status-filter")?.value || "";
  const sort   = document.getElementById("sort-filter")?.value || "newest";
  const date   = document.getElementById("date-filter")?.value || "all";
  const query  = (document.getElementById("search-input")?.value || "").trim();

  if (query)  parts.push(`Search “${query}”`);
  if (status) parts.push(`Status: ${STATUS_CONFIG[status]?.label || status}`);
  if (date && date !== "all") {
    const labels = { today: "Today", week: "Last 7 days", month: "Last 30 days", custom: "Custom range" };
    parts.push(`Date: ${labels[date] || date}`);
  }
  const sortLabels = {
    newest:  "Newest → Oldest",
    oldest:  "Oldest → Newest",
    highest: "Highest total first",
    lowest:  "Lowest total first"
  };
  parts.push(`Sort: ${sortLabels[sort] || sort}`);

  return parts.length ? `Filtering — ${parts.join(" · ")}` : "";
}

function updateLoadOlderButton() {
  const btn  = document.getElementById("load-older");
  const hint = document.getElementById("load-older-hint");
  if (!btn) return;

  if (ledgerHasMore) {
    btn.disabled   = false;
    btn.textContent = "📜 Load older orders";
    if (hint) hint.textContent = "";
  } else {
    btn.disabled   = true;
    btn.textContent = "📜 All orders loaded";
    if (hint) hint.textContent = ledgerCursor ? "Every page of the ledger has been consulted." : "";
  }
}

/** Render the register with all active filters/sorts, update counts + controls */
function renderLedger() {
  const list = applyLedgerFilters();
  renderLedgerRows(list, document.getElementById("orders-list"));

  const total = allOrders.length;
  setText("orders-count",
    `${list.length} of ${total} treasure${total === 1 ? "" : "s"} shown`);
  setText("ledger-hint", buildLedgerHint());
  updateLoadOlderButton();
}

/** Re-render every view that depends on order data (table, home recent, stats) */
function refreshOrderViews() {
  renderStats(computeStats(allOrders));
  renderOrderCards(allOrders.slice(0, 6), document.getElementById("recent-orders"));
  renderLedger();
}

/** Open the order-detail modal, reusing the full order card for the body */
function openOrderDetail(order) {
  const modal = document.getElementById("modal-order-detail");
  const body  = document.getElementById("modal-order-body");
  if (!modal || !body) return;
  body.innerHTML = buildOrderCard(order);
  modal.classList.remove("hidden");
}

/** Cursor pagination — append the next server page without losing existing orders */
async function loadOlderOrders() {
  if (ledgerLoading || !ledgerHasMore) return;
  ledgerLoading = true;

  const btn = document.getElementById("load-older");
  if (btn) { btn.disabled = true; btn.textContent = "📜 Consulting older pages…"; }

  try {
    const token = getToken();
    const url   = ledgerCursor
      ? `${ORDERS_URL}?starting_after=${encodeURIComponent(ledgerCursor)}`
      : ORDERS_URL;

    const response = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });

    if (response.status === 401) { clearToken(); showLogin(); return; }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "The older pages could not be consulted.");
    }

    const data     = await response.json();
    const incoming = Array.isArray(data.orders) ? data.orders : [];

    const seen = new Set(allOrders.map((o) => o.id));
    incoming.forEach((o) => {
      if (!seen.has(o.id)) { seen.add(o.id); allOrders.push(o); }
    });

    allOrders.sort((a, b) => b.created - a.created);

    ledgerHasMore = !!data.hasMore;
    ledgerCursor  = data.hasMore ? (data.nextCursor || null) : null;

    refreshOrderViews();
  } catch (error) {
    showToast(error.message || "Could not load older orders.");
  } finally {
    ledgerLoading = false;
    updateLoadOlderButton();
  }
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

const INVENTORY_URL        = "/api/get-inventory";
const UPDATE_INVENTORY_URL = "/api/update-inventory";

/** Cached inventory object { [productId]: entry } */
let allInventory = {};
/** Cached products array from catalogue.json */
let allProducts  = [];

const AVAILABLE_STOREFRONT_MESSAGES = {
  available: "Available",
  workshop:  "The Merchant has this in the workshop.",
  shelves:   "The Merchant has this upon the shelves.",
  remaining: "Only {stock} remain upon the shelves.",
  request:   "The Merchant can make this upon a traveller's request."
};

const UNAVAILABLE_STOREFRONT_MESSAGES = {
  roaming:   "Roaming the Land.",
  returning: "Returning Before Long.",
  bespoke:   "Available to Order."
};

async function fetchInventory() {
  const urlsToTry = [
    `${INVENTORY_URL}?cb=${Date.now()}`
  ];

  let response = null;
  for (const url of urlsToTry) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        response = res;
        break;
      }
    } catch {
      // Continue to next endpoint
    }
  }

  if (!response || !response.ok) throw new Error("Supplies could not be loaded.");
  const { inventory } = await response.json();
  if (typeof inventory !== "object" || inventory === null || Array.isArray(inventory)) {
    throw new Error("Supplies response was malformed.");
  }
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

/** Resolve stock status for a single product — calculated strictly from Availability, Stock, and Low Stock threshold */
function resolveStockStatus(productId) {
  const inv = allInventory[productId];
  if (!inv)                          return "unlimited";
  if (inv.available === false)       return "off";
  if (inv.stock === null)            return "unlimited";
  if (inv.stock === 0)               return "out";
  if (inv.stock <= (inv.lowStockThreshold ?? 3)) return "low";
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

  tbody.innerHTML = filtered.map((product) => {
    const inv     = inventory[product.id] || {};
    const stock   = inv.stock ?? null;
    const status  = resolveStockStatus(product.id);
    const badge   = stockBadgeHtml(status, stock);
    const avail   = inv.available !== false;

    const availMsgKey = inv.availableStorefrontMessage || inv.availableMessage || (inv.storefrontMessage in AVAILABLE_STOREFRONT_MESSAGES ? inv.storefrontMessage : "shelves");
    const unavailMsgKey = inv.unavailableStorefrontMessage || inv.unavailableMessage || inv.outOfStockMessage || (inv.storefrontMessage in UNAVAILABLE_STOREFRONT_MESSAGES ? inv.storefrontMessage : "roaming");

    const hasImage = Array.isArray(product.images) && product.images.length;
    const imgHtml  = hasImage
      ? `<img class="inv-product-img" src="assets/images/products/${product.id}/${product.images[0]}" alt="${escapeHtml(product.name)}" onerror="this.style.display='none'">`
      : `<div class="inv-product-img-placeholder">${escapeHtml(product.icon || "✦")}</div>`;

    /* Separate Available messages options */
    const availableMsgOptions = Object.entries(AVAILABLE_STOREFRONT_MESSAGES)
      .map(([k, label]) => `<option value="${k}"${k === availMsgKey ? " selected" : ""}>${label.replace("{stock}", stock !== null ? stock : "∞")}</option>`)
      .join("");

    /* Separate Unavailable messages options */
    const unavailableMsgOptions = Object.entries(UNAVAILABLE_STOREFRONT_MESSAGES)
      .map(([k, label]) => `<option value="${k}"${k === unavailMsgKey ? " selected" : ""}>${label}</option>`)
      .join("");

    return `
      <tr data-product-id="${product.id}">
        <td data-label="Treasure">
          <div class="inv-product-cell">
            ${imgHtml}
            <div>
              <div class="inv-product-name">${escapeHtml(product.name)}</div>
              <div class="inv-product-collection">${escapeHtml(product.collection)}</div>
            </div>
          </div>
        </td>
        <td data-label="Status">${badge}</td>
        <td data-label="Stock">
          <input class="stock-input"
                 type="number" min="0" value="${stock === null ? "" : stock}"
                 placeholder="∞"
                 data-action="setStock"
                 data-product-id="${product.id}"
                 title="Set exact stock (leave blank for unlimited)">
        </td>
        <td data-label="Adjust">
          <div class="stock-controls">
            <button class="btn-stock-adj" data-action="adjustStock" data-product-id="${product.id}" data-value="-1" title="Remove 1">−</button>
            <button class="btn-stock-adj" data-action="adjustStock" data-product-id="${product.id}" data-value="1"  title="Add 1">+</button>
            <button class="btn-stock-adj" data-action="adjustStock" data-product-id="${product.id}" data-value="10" title="Add 10" style="width:auto;padding:0 8px;font-size:0.78rem;">+10</button>
          </div>
        </td>
        <td data-label="Low Stock At">
          <input class="stock-input"
                 type="number" min="0" value="${inv.lowStockThreshold ?? 3}"
                 data-action="setThreshold"
                 data-product-id="${product.id}"
                 title="Show low stock warning when stock falls to this number">
        </td>
        <td data-label="Availability">
          <!-- SECTION 1: Availability -->
          <div class="avail-btn-group" data-selected-avail="${avail ? "true" : "false"}">
            <button type="button" class="btn-toggle-avail ${avail ? "active" : ""}" data-avail-toggle="true" data-product-id="${product.id}">Available</button>
            <button type="button" class="btn-toggle-avail ${!avail ? "active" : ""}" data-avail-toggle="false" data-product-id="${product.id}">Unavailable</button>
          </div>
          <button type="button" class="btn-secondary btn-save-action" data-action="saveAvailability" data-product-id="${product.id}">Save Availability</button>
        </td>
        <td data-label="Storefront Message">
          <!-- SECTION 2: Storefront Message -->
          <div class="msg-category-group">
            <div class="msg-category">
              <label class="msg-label">AVAILABLE Messages</label>
              <select class="message-select msg-select-avail" data-product-id="${product.id}">
                ${availableMsgOptions}
              </select>
            </div>
            <div class="msg-category">
              <label class="msg-label">UNAVAILABLE Messages</label>
              <select class="message-select msg-select-unavail" data-product-id="${product.id}">
                ${unavailableMsgOptions}
              </select>
            </div>
            <button type="button" class="btn-secondary btn-save-action" data-action="saveMessage" data-product-id="${product.id}">Save Storefront Message</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  renderInventoryStats(products, inventory);
}

function exportInventoryCSV(products, inventory) {
  const headers = [
    "Treasure", "Collection", "Stock", "Status", "Low Stock Threshold",
    "Available Message", "Unavailable Message", "Available", "Last Updated"
  ];

  const rows = products.map((p) => {
    const inv = inventory[p.id] || {};
    const status = resolveStockStatus(p.id);
    const availMsgKey = inv.availableStorefrontMessage || inv.availableMessage || (inv.storefrontMessage in AVAILABLE_STOREFRONT_MESSAGES ? inv.storefrontMessage : "shelves");
    const unavailMsgKey = inv.unavailableStorefrontMessage || inv.unavailableMessage || inv.outOfStockMessage || (inv.storefrontMessage in UNAVAILABLE_STOREFRONT_MESSAGES ? inv.storefrontMessage : "roaming");

    const availLabel = AVAILABLE_STOREFRONT_MESSAGES[availMsgKey] || "The Merchant has this upon the shelves.";
    const unavailLabel = UNAVAILABLE_STOREFRONT_MESSAGES[unavailMsgKey] || "Roaming the Land.";

    return [
      p.name,
      p.collection,
      inv.stock === null || inv.stock === undefined ? "Unlimited" : inv.stock,
      status,
      inv.lowStockThreshold ?? 3,
      availLabel,
      unavailLabel,
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
  const countEl = document.getElementById("inv-count");
  const tbody = document.getElementById("inventory-tbody");

  try {
    await Promise.all([
      fetchInventory(),
      allProducts.length ? Promise.resolve(allProducts) : fetchProductCatalogue()
    ]);
    renderInventoryTable(allProducts, allInventory);
    renderInventoryStats(allProducts, allInventory);
  } catch (error) {
    console.error("Inventory load error:", error.message);
    if (countEl) {
      countEl.textContent = "Inventory could not be verified right now.";
    }
    if (tbody) {
      tbody.innerHTML = `
        <tr><td colspan="7" style="text-align:center;padding:3rem;color:var(--text-muted);font-style:italic;">
          Inventory could not be verified right now. Please try again shortly.
        </td></tr>`;
    }
    showToast(error.message || "Supplies could not be loaded.");
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

  /* Availability toggle button click (visual change before save) */
  document.getElementById("inventory-table")?.addEventListener("click", (event) => {
    const toggleBtn = event.target.closest("[data-avail-toggle]");
    if (!toggleBtn) return;
    const group = toggleBtn.closest(".avail-btn-group");
    if (!group) return;
    const isAvail = toggleBtn.dataset.availToggle;
    group.dataset.selectedAvail = isAvail;
    group.querySelectorAll("[data-avail-toggle]").forEach((b) => {
      b.classList.toggle("active", b.dataset.availToggle === isAvail);
    });
  });

  /* Delegated: stock input changes (setStock, setThreshold) */
  document.getElementById("inventory-table")?.addEventListener("change", async (event) => {
    const input = event.target.closest("[data-action]");
    if (!input) return;
    const { action, productId } = input.dataset;
    if (action !== "setStock" && action !== "setThreshold") return;

    const rawValue = input.value.trim();
    const value    = rawValue === "" ? null : Math.max(0, parseInt(rawValue, 10) || 0);

    try {
      await postInventoryUpdate(action, productId, value);
    } catch (error) {
      showToast(error.message);
    }
  });

  /* Delegated: adjust stock, save availability, and save storefront message */
  document.getElementById("inventory-table")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn || btn.tagName === "INPUT" || btn.tagName === "SELECT") return;

    const { action, productId } = btn.dataset;

    if (action === "adjustStock") {
      const value = parseInt(btn.dataset.value, 10) || 0;
      try {
        await postInventoryUpdate("adjustStock", productId, value);
      } catch (error) { showToast(error.message); }
      return;
    }

    if (action === "saveAvailability") {
      const row = btn.closest("tr");
      const group = row?.querySelector(".avail-btn-group");
      const selectedVal = group?.dataset.selectedAvail === "true";
      try {
        await postInventoryUpdate("setAvailable", productId, selectedVal);
        showToast("Availability saved.");
      } catch (error) { showToast(error.message); }
      return;
    }

    if (action === "saveMessage") {
      const row = btn.closest("tr");
      const availSelect = row?.querySelector(".msg-select-avail");
      const unavailSelect = row?.querySelector(".msg-select-unavail");

      const availableStorefrontMessage = availSelect?.value || "shelves";
      const unavailableStorefrontMessage = unavailSelect?.value || "roaming";

      try {
        await postInventoryUpdate("setMessage", productId, {
          availableStorefrontMessage,
          unavailableStorefrontMessage
        });
        showToast("Storefront Message saved.");
      } catch (error) { showToast(error.message); }
      return;
    }
  });
}

/* ============================================================
   Module: UI helpers
   ============================================================ */

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

/* ============================================================
   Module: Featured Treasure Management
   ============================================================ */

const GET_FEATURED_URL    = "/api/get-featured-treasure";
const UPDATE_FEATURED_URL = "/api/update-featured-treasure";

let featuredData = null;

async function fetchFeaturedData() {
  try {
    const res = await fetch(GET_FEATURED_URL, { cache: "no-store" });
    if (!res.ok) throw new Error();
    featuredData = await res.json();
  } catch {
    const res = await fetch("./data/featured-treasure.json", { cache: "no-store" });
    featuredData = await res.json();
  }
  if (!featuredData) featuredData = {};
  if (!featuredData.settings) featuredData.settings = {};
  if (!Array.isArray(featuredData.features)) featuredData.features = [];
  return featuredData;
}

async function saveFeaturedData(payload) {
  /* Enforce: only one published feature at any time */
  if (Array.isArray(payload.features)) {
    let publishedFound = false;
    payload.features.forEach((f) => {
      if (f.status === "published") {
        if (!publishedFound) {
          publishedFound = true;
        } else {
          f.status = "draft";
        }
      }
    });
  }

  const token = getToken();
  const res = await fetch(UPDATE_FEATURED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (res.status === 401) { clearToken(); showLogin(); throw new Error("Your session has expired."); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to save Featured Treasure.");
  }

  const data = await res.json();
  featuredData = data.data || payload;
  return featuredData;
}

async function loadAndRenderFeatured() {
  if (!allProducts.length) {
    await fetchProductCatalogue().catch(() => {});
  }
  await fetchFeaturedData();

  const titleInput   = document.getElementById("featured-title-input");
  const introInput   = document.getElementById("featured-intro-input");
  const closingInput = document.getElementById("featured-closing-input");
  const stockToggle  = document.getElementById("featured-stock-toggle");

  if (titleInput)   titleInput.value   = featuredData.title || "";
  if (introInput)   introInput.value   = featuredData.intro || "";
  if (closingInput) closingInput.value = featuredData.closingNote || "";
  if (stockToggle)  stockToggle.checked = Boolean(featuredData.settings?.showWhenOutOfStock);

  populateProductSelect();
  renderFeaturedList();
}

function populateProductSelect() {
  const select = document.getElementById("feat-product-select");
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = `<option value="">Select a product from the collection...</option>` +
    allProducts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.collection)})</option>`).join("");
  if (currentVal) select.value = currentVal;
}

function renderFeaturedList() {
  const container = document.getElementById("featured-list");
  if (!container) return;

  if (!featuredData || !featuredData.features || !featuredData.features.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-emblem">✨</div>
        <h3>No Featured Treasures set.</h3>
        <p>Click "Set New Featured Treasure" above to select a curiosity for the high shelf.</p>
      </div>`;
    return;
  }

  container.innerHTML = featuredData.features.map((feature) => {
    const product = allProducts.find((p) => p.id === feature.productId);
    const prodName = product ? product.name : feature.productId;

    let statusBadge = "";
    if (feature.status === "published") {
      statusBadge = `<span class="stock-badge stock-badge--in">🟢 Published</span>`;
    } else if (feature.status === "scheduled") {
      statusBadge = `<span class="stock-badge stock-badge--low">🟣 Scheduled</span>`;
    } else {
      statusBadge = `<span class="stock-badge stock-badge--off">🟡 Draft</span>`;
    }

    const pinnedBadge = feature.pinned
      ? `<span class="stock-badge stock-badge--low" style="margin-left:0.5rem;">📌 Pinned</span>`
      : "";

    const seasonalText = feature.seasonal ? ` · Seasonal: ${escapeHtml(feature.seasonal)}` : "";
    const eyebrowText  = feature.eyebrow ? escapeHtml(feature.eyebrow) : "Set aside by the Merchant";

    const notesText = Array.isArray(feature.merchantNote)
      ? feature.merchantNote.join("\n\n")
      : (feature.merchantNote || "");

    const snippet = notesText ? `<p style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;font-style:italic;">"${escapeHtml(notesText.slice(0, 140))}${notesText.length > 140 ? "..." : ""}"</p>` : "";

    const publishAtText = feature.publishAt ? `Publish: ${new Date(feature.publishAt).toLocaleString("en-GB")}` : "";
    const expiresAtText = feature.expiresAt ? `Expires: ${new Date(feature.expiresAt).toLocaleString("en-GB")}` : "";
    const datesInfo = (publishAtText || expiresAtText)
      ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.3rem;">${publishAtText} ${publishAtText && expiresAtText ? "· " : ""}${expiresAtText}</div>`
      : "";

    const publishBtn = feature.status === "published"
      ? `<button class="btn-status" data-feat-action="draft" data-feat-id="${feature.id}">Save Draft</button>`
      : `<button class="btn-status" data-feat-action="publish" data-feat-id="${feature.id}">Publish Immediately</button>`;

    return `
      <article class="order-card" data-feat-id="${feature.id}">
        <div class="order-card-header">
          <div class="order-card-title">
            <span class="order-badge">✨ ${escapeHtml(prodName)}</span>
            ${pinnedBadge}
          </div>
          <div>${statusBadge}</div>
        </div>
        <div class="order-card-body">
          <div style="font-size:0.8rem;color:var(--text-gold);text-transform:uppercase;letter-spacing:0.05em;">
            ${eyebrowText}${seasonalText}
          </div>
          ${snippet}
          ${datesInfo}
        </div>
        <div class="order-card-actions">
          <button class="btn-status" data-feat-action="edit" data-feat-id="${feature.id}">Edit</button>
          ${publishBtn}
          <button class="btn-ghost" data-feat-action="delete" data-feat-id="${feature.id}" style="color:#ff6b6b;margin-left:auto;">Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

function openFeaturedModal(feature = null) {
  populateProductSelect();
  const modal = document.getElementById("modal-featured");
  const title = document.getElementById("modal-featured-title");

  if (!modal) return;

  document.getElementById("feat-id").value = feature ? feature.id : "";
  document.getElementById("feat-product-select").value = feature ? feature.productId : "";
  document.getElementById("feat-eyebrow").value = feature?.eyebrow || "Set aside by the Merchant";
  document.getElementById("feat-seasonal").value = feature?.seasonal || "";
  document.getElementById("feat-cta").value = feature?.ctaLabel || "View This Treasure";
  document.getElementById("feat-signoff").value = feature?.signoff || "— The Merchant";
  document.getElementById("feat-alt").value = feature?.imageAlt || "";

  const notes = Array.isArray(feature?.merchantNote)
    ? feature.merchantNote.join("\n\n")
    : (feature?.merchantNote || "");
  document.getElementById("feat-note").value = notes;

  document.getElementById("feat-status").value = feature?.status || "published";
  document.getElementById("feat-publish-at").value = feature?.publishAt ? new Date(feature.publishAt).toISOString().slice(0, 16) : "";
  document.getElementById("feat-expires-at").value = feature?.expiresAt ? new Date(feature.expiresAt).toISOString().slice(0, 16) : "";
  document.getElementById("feat-pinned").checked = Boolean(feature?.pinned);

  if (title) title.textContent = feature ? "✨ Edit Featured Treasure" : "✨ Set New Featured Treasure";
  modal.classList.remove("hidden");
}

function closeFeaturedModal() {
  document.getElementById("modal-featured")?.classList.add("hidden");
}


/* ============================================================
   Module: Merchant's Journal Management
   ============================================================ */

const GET_DESK_URL    = "/api/get-desk-entries";
const UPDATE_DESK_URL = "/api/update-desk-entries";

let deskData = null;

async function fetchDeskData() {
  try {
    const res = await fetch(GET_DESK_URL, { cache: "no-store" });
    if (!res.ok) throw new Error();
    deskData = await res.json();
  } catch {
    const res = await fetch("./data/desk-entries.json", { cache: "no-store" });
    deskData = await res.json();
  }
  if (!deskData) deskData = {};
  if (!deskData.settings) deskData.settings = {};
  if (!Array.isArray(deskData.entries)) deskData.entries = [];
  return deskData;
}

async function saveDeskData(payload) {
  const token = getToken();
  const res = await fetch(UPDATE_DESK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (res.status === 401) { clearToken(); showLogin(); throw new Error("Your session has expired."); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to save Journal entries.");
  }

  const data = await res.json();
  deskData = data.data || payload;
  return deskData;
}

async function loadAndRenderJournal() {
  await fetchDeskData();

  const titleInput    = document.getElementById("journal-title-input");
  const subtitleInput = document.getElementById("journal-subtitle-input");
  const closingInput  = document.getElementById("journal-closing-input");
  const limitInput    = document.getElementById("journal-limit-input");

  if (titleInput)    titleInput.value    = deskData.title || "";
  if (subtitleInput) subtitleInput.value = deskData.subtitle || "";
  if (closingInput)  closingInput.value  = deskData.closingNote || "";
  if (limitInput)    limitInput.value    = deskData.settings?.homepageLimit || 3;

  renderJournalList();
}

function renderJournalList() {
  const container = document.getElementById("journal-list");
  if (!container) return;

  const searchQuery  = (document.getElementById("journal-search-input")?.value || "").trim().toLowerCase();
  const statusFilter = document.getElementById("journal-status-filter")?.value || "";

  /* Display Merchant's Journal entries newest first by default */
  const entries = [...(deskData.entries || [])].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const timeA = Date.parse(a.date || a.publishAt || 0) || 0;
    const timeB = Date.parse(b.date || b.publishAt || 0) || 0;
    return timeB - timeA;
  });

  const filtered = entries.filter((entry) => {
    const matchStatus = !statusFilter || (entry.status || "published") === statusFilter;
    const bodyStr = Array.isArray(entry.body) ? entry.body.join(" ") : String(entry.body || "");
    const matchQuery = !searchQuery ||
      (entry.title || "").toLowerCase().includes(searchQuery) ||
      (entry.dateLabel || "").toLowerCase().includes(searchQuery) ||
      bodyStr.toLowerCase().includes(searchQuery);
    return matchStatus && matchQuery;
  });

  setText("journal-count", `${filtered.length} entry${filtered.length === 1 ? "" : "ies"} in the archive`);

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-emblem">📖</div>
        <h3>No entries found in the archive.</h3>
        <p>Click "Write New Entry" above to add a letter or note to the desk.</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map((entry) => {
    let statusBadge = "";
    const st = entry.status || "published";
    if (st === "published") {
      statusBadge = `<span class="stock-badge stock-badge--in">🟢 Published</span>`;
    } else if (st === "scheduled") {
      statusBadge = `<span class="stock-badge stock-badge--low">🟣 Scheduled</span>`;
    } else {
      statusBadge = `<span class="stock-badge stock-badge--off">🟡 Draft</span>`;
    }

    const pinnedBadge = entry.pinned
      ? `<span class="stock-badge stock-badge--low" style="margin-left:0.5rem;">📌 Pinned</span>`
      : "";

    const dateDisplay = entry.dateLabel || entry.date || (entry.publishAt ? new Date(entry.publishAt).toLocaleDateString("en-GB") : "Undated");
    const bodyStr = Array.isArray(entry.body) ? entry.body.join("\n\n") : String(entry.body || "");
    const snippet = bodyStr ? `<p style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;font-style:italic;">"${escapeHtml(bodyStr.slice(0, 150))}${bodyStr.length > 150 ? "..." : ""}"</p>` : "";

    return `
      <article class="order-card" data-journal-id="${entry.id}">
        <div class="order-card-header">
          <div class="order-card-title">
            <span class="order-badge">${escapeHtml(entry.title)}</span>
            ${pinnedBadge}
          </div>
          <div>${statusBadge}</div>
        </div>
        <div class="order-card-body">
          <div style="font-size:0.8rem;color:var(--text-gold);">
            🕯️ ${escapeHtml(dateDisplay)}
          </div>
          ${snippet}
          ${entry.signoff ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.3rem;">${escapeHtml(entry.signoff)}</div>` : ""}
        </div>
        <div class="order-card-actions">
          <button class="btn-status" data-journal-action="edit" data-journal-id="${entry.id}">Edit</button>
          <button class="btn-ghost" data-journal-action="delete" data-journal-id="${entry.id}" style="color:#ff6b6b;margin-left:auto;">Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

function openJournalModal(entry = null) {
  const modal = document.getElementById("modal-journal");
  const title = document.getElementById("modal-journal-title");

  if (!modal) return;

  const todayStr = new Date().toISOString().slice(0, 10);

  document.getElementById("journal-id").value = entry ? entry.id : "";
  document.getElementById("journal-title").value = entry?.title || "";
  document.getElementById("journal-date").value = entry?.date || todayStr;
  document.getElementById("journal-date-label").value = entry?.dateLabel || "";

  const bodyStr = Array.isArray(entry?.body) ? entry.body.join("\n\n") : (entry?.body || "");
  document.getElementById("journal-body").value = bodyStr;

  document.getElementById("journal-signoff").value = entry?.signoff || "— The Merchant";
  document.getElementById("journal-status").value = entry?.status || "published";
  document.getElementById("journal-publish-at").value = entry?.publishAt ? new Date(entry.publishAt).toISOString().slice(0, 16) : "";
  document.getElementById("journal-expires-at").value = entry?.expiresAt ? new Date(entry.expiresAt).toISOString().slice(0, 16) : "";
  document.getElementById("journal-pinned").checked = Boolean(entry?.pinned);

  if (title) title.textContent = entry ? "📖 Edit Journal Entry" : "📖 Write New Journal Entry";
  modal.classList.remove("hidden");
}

function closeJournalModal() {
  document.getElementById("modal-journal")?.classList.add("hidden");
}

function initThoughtsUI() {
  /* Search Thoughts */
  document.getElementById("thoughts-search-input")?.addEventListener("input", renderThoughtsList);

  /* Open thoughts editor modal */
  document.getElementById("thoughts-add-btn")?.addEventListener("click", () => openThoughtsModal());
  document.getElementById("modal-thoughts-close")?.addEventListener("click", closeThoughtsModal);
  document.getElementById("thoughts-cancel-btn")?.addEventListener("click", closeThoughtsModal);

  /* Close modal on backdrop click */
  document.getElementById("modal-thoughts")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("modal-thoughts")) closeThoughtsModal();
  });

  /* Thoughts editor form submission */
  document.getElementById("thoughts-editor-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!thoughtsData) await fetchThoughtsData();

    const id        = document.getElementById("thoughts-entry-id").value;
    const title     = document.getElementById("thoughts-title").value.trim() || null;
    const date      = document.getElementById("thoughts-date").value;
    const time      = document.getElementById("thoughts-time").value;
    const author    = document.getElementById("thoughts-author").value.trim() || "Alby";
    const bodyText  = document.getElementById("thoughts-body").value.trim();
    const pinned    = document.getElementById("thoughts-pinned").checked;

    if (!date || !time || !bodyText) {
      showToast("Please complete the required fields: date, time and body.");
      return;
    }

    const body = bodyText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

    let existing = thoughtsData.entries.find((entry) => entry.id === id);
    if (existing) {
      existing.title = title;
      existing.date = date;
      existing.time = time;
      existing.author = author;
      existing.body = body;
      existing.pinned = pinned;
    } else {
      const newId = `th-${Date.now()}`;
      const newEntry = {
        id: newId,
        title,
        date,
        time,
        author,
        body,
        pinned,
        createdAt: new Date().toISOString()
      };
      thoughtsData.entries.unshift(newEntry);
    }

    try {
      await saveThoughtsData(thoughtsData);
      renderThoughtsList();
      closeThoughtsModal();
      showToast("Thought saved.");
    } catch (err) {
      showToast(err.message);
    }
  });

  /* Delete thought button (in-modal) */
  document.getElementById("thoughts-delete-btn")?.addEventListener("click", async () => {
    const id = document.getElementById("thoughts-entry-id").value;
    if (!id) return;
    if (window.confirm("Are you sure you want to permanently delete this thought?")) {
      thoughtsData.entries = thoughtsData.entries.filter((item) => item.id !== id);
      try {
        await saveThoughtsData(thoughtsData);
        renderThoughtsList();
        closeThoughtsModal();
        showToast("Thought permanently deleted.");
      } catch (err) { showToast(err.message); }
    }
  });

  /* Delegated actions on Thoughts list */
  document.getElementById("thoughts-list")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-thoughts-action]");
    if (!btn) return;

    const action = btn.dataset.thoughtsAction;
    const id     = btn.dataset.thoughtsId;
    const entry  = thoughtsData?.entries?.find((item) => item.id === id);
    if (!entry) return;

    if (action === "edit") {
      openThoughtsModal(entry);
    } else if (action === "delete") {
      if (window.confirm("Are you sure you want to permanently delete this thought?")) {
        thoughtsData.entries = thoughtsData.entries.filter((item) => item.id !== id);
        try {
          await saveThoughtsData(thoughtsData);
          renderThoughtsList();
          showToast("Thought permanently deleted.");
        } catch (err) { showToast(err.message); }
      }
    }
  });
}

function initCmsUI() {
  /* Featured settings form */
  document.getElementById("featured-settings-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!featuredData) await fetchFeaturedData();
    featuredData.title = document.getElementById("featured-title-input")?.value || "✨ Featured Treasure";
    featuredData.intro = document.getElementById("featured-intro-input")?.value || "";
    featuredData.closingNote = document.getElementById("featured-closing-input")?.value || "";
    if (!featuredData.settings) featuredData.settings = {};
    featuredData.settings.showWhenOutOfStock = Boolean(document.getElementById("featured-stock-toggle")?.checked);

    try {
      await saveFeaturedData(featuredData);
      showToast("Featured Treasure section settings saved.");
    } catch (err) {
      showToast(err.message);
    }
  });

  /* Open featured editor modal */
  document.getElementById("feat-add-btn")?.addEventListener("click", () => openFeaturedModal());
  document.getElementById("modal-featured-close")?.addEventListener("click", closeFeaturedModal);
  document.getElementById("feat-cancel-btn")?.addEventListener("click", closeFeaturedModal);

  /* Featured editor form submission */
  document.getElementById("featured-editor-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!featuredData) await fetchFeaturedData();

    const id          = document.getElementById("feat-id").value;
    const productId   = document.getElementById("feat-product-select").value;
    const eyebrow     = document.getElementById("feat-eyebrow").value.trim() || "Set aside by the Merchant";
    const seasonal    = document.getElementById("feat-seasonal").value.trim() || null;
    const ctaLabel    = document.getElementById("feat-cta").value.trim() || "View This Treasure";
    const signoff     = document.getElementById("feat-signoff").value.trim() || "— The Merchant";
    const imageAlt    = document.getElementById("feat-alt").value.trim() || "";
    const noteText    = document.getElementById("feat-note").value.trim();
    const status      = document.getElementById("feat-status").value;
    const publishAtVal = document.getElementById("feat-publish-at").value;
    const expiresAtVal = document.getElementById("feat-expires-at").value;
    const pinned      = document.getElementById("feat-pinned").checked;

    if (!productId) {
      showToast("Please select a product.");
      return;
    }

    const merchantNote = noteText ? noteText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) : [];
    const publishAt = publishAtVal ? new Date(publishAtVal).toISOString() : null;
    const expiresAt = expiresAtVal ? new Date(expiresAtVal).toISOString() : null;

    /* Enforce: if status is published, all other features become draft */
    if (status === "published") {
      featuredData.features.forEach((f) => f.status = "draft");
    }

    let existing = featuredData.features.find((f) => f.id === id);
    if (existing) {
      existing.productId = productId;
      existing.eyebrow = eyebrow;
      existing.seasonal = seasonal;
      existing.ctaLabel = ctaLabel;
      existing.signoff = signoff;
      existing.imageAlt = imageAlt;
      existing.merchantNote = merchantNote;
      existing.status = status;
      existing.publishAt = publishAt;
      existing.expiresAt = expiresAt;
      existing.pinned = pinned;
    } else {
      const newId = `feat-${Date.now()}`;
      const newFeature = {
        id: newId,
        productId,
        eyebrow,
        seasonal,
        ctaLabel,
        signoff,
        imageAlt,
        merchantNote,
        status,
        publishAt,
        expiresAt,
        pinned,
        displayOrder: featuredData.features.length + 1
      };
      featuredData.features.unshift(newFeature);
    }

    try {
      await saveFeaturedData(featuredData);
      renderFeaturedList();
      closeFeaturedModal();
      showToast("Featured Treasure saved.");
    } catch (err) {
      showToast(err.message);
    }
  });

  /* Delegated actions on Featured Treasure list */
  document.getElementById("featured-list")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-feat-action]");
    if (!btn) return;

    const action = btn.dataset.featAction;
    const id     = btn.dataset.featId;
    const feature = featuredData?.features?.find((f) => f.id === id);
    if (!feature) return;

    if (action === "edit") {
      openFeaturedModal(feature);
    } else if (action === "publish") {
      featuredData.features.forEach((f) => f.status = "draft");
      feature.status = "published";
      try {
        await saveFeaturedData(featuredData);
        renderFeaturedList();
        showToast("Treasure published immediately.");
      } catch (err) { showToast(err.message); }
    } else if (action === "draft") {
      feature.status = "draft";
      try {
        await saveFeaturedData(featuredData);
        renderFeaturedList();
        showToast("Treasure status set to Draft.");
      } catch (err) { showToast(err.message); }
    } else if (action === "delete") {
      if (window.confirm("Are you sure you want to remove this Featured Treasure?")) {
        featuredData.features = featuredData.features.filter((f) => f.id !== id);
        try {
          await saveFeaturedData(featuredData);
          renderFeaturedList();
          showToast("Featured Treasure removed.");
        } catch (err) { showToast(err.message); }
      }
    }
  });

  /* Journal settings form */
  document.getElementById("journal-settings-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!deskData) await fetchDeskData();
    deskData.title = document.getElementById("journal-title-input")?.value || "🕯️ From the Merchant's Desk";
    deskData.subtitle = document.getElementById("journal-subtitle-input")?.value || "";
    deskData.closingNote = document.getElementById("journal-closing-input")?.value || "";
    if (!deskData.settings) deskData.settings = {};
    deskData.settings.homepageLimit = parseInt(document.getElementById("journal-limit-input")?.value || "3", 10);

    try {
      await saveDeskData(deskData);
      showToast("Journal header settings saved.");
    } catch (err) {
      showToast(err.message);
    }
  });

  /* Search & Filter Journal */
  document.getElementById("journal-search-input")?.addEventListener("input", renderJournalList);
  document.getElementById("journal-status-filter")?.addEventListener("change", renderJournalList);

  /* Open journal editor modal */
  document.getElementById("journal-add-btn")?.addEventListener("click", () => openJournalModal());
  document.getElementById("modal-journal-close")?.addEventListener("click", closeJournalModal);
  document.getElementById("journal-cancel-btn")?.addEventListener("click", closeJournalModal);

  /* Journal editor form submission */
  document.getElementById("journal-editor-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!deskData) await fetchDeskData();

    const id           = document.getElementById("journal-id").value;
    const title        = document.getElementById("journal-title").value.trim();
    const date         = document.getElementById("journal-date").value;
    const dateLabel    = document.getElementById("journal-date-label").value.trim() || null;
    const bodyText     = document.getElementById("journal-body").value.trim();
    const signoff      = document.getElementById("journal-signoff").value.trim() || "— The Merchant";
    const status       = document.getElementById("journal-status").value;
    const publishAtVal = document.getElementById("journal-publish-at").value;
    const expiresAtVal = document.getElementById("journal-expires-at").value;
    const pinned       = document.getElementById("journal-pinned").checked;

    if (!title || !date || !bodyText) {
      showToast("Please complete the required fields.");
      return;
    }

    const body = bodyText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const publishAt = publishAtVal ? new Date(publishAtVal).toISOString() : null;
    const expiresAt = expiresAtVal ? new Date(expiresAtVal).toISOString() : null;

    let existing = deskData.entries.find((entry) => entry.id === id);
    if (existing) {
      existing.title = title;
      existing.date = date;
      existing.dateLabel = dateLabel;
      existing.body = body;
      existing.signoff = signoff;
      existing.status = status;
      existing.publishAt = publishAt;
      existing.expiresAt = expiresAt;
      existing.pinned = pinned;
    } else {
      const newId = `entry-${Date.now()}`;
      const newEntry = {
        id: newId,
        title,
        date,
        dateLabel,
        body,
        signoff,
        status,
        publishAt,
        expiresAt,
        pinned,
        displayOrder: deskData.entries.length + 1
      };
      deskData.entries.unshift(newEntry);
    }

    try {
      await saveDeskData(deskData);
      renderJournalList();
      closeJournalModal();
      showToast("Journal entry saved.");
    } catch (err) {
      showToast(err.message);
    }
  });

  /* Delegated actions on Journal list */
  document.getElementById("journal-list")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-journal-action]");
    if (!btn) return;

    const action = btn.dataset.journalAction;
    const id     = btn.dataset.journalId;
    const entry  = deskData?.entries?.find((item) => item.id === id);
    if (!entry) return;

    if (action === "edit") {
      openJournalModal(entry);
    } else if (action === "delete") {
      /* Deleting a journal entry MUST require confirmation before permanent removal */
      if (window.confirm("Are you sure you want to permanently delete this entry from the Merchant's Journal?")) {
        deskData.entries = deskData.entries.filter((item) => item.id !== id);
        try {
          await saveDeskData(deskData);
          renderJournalList();
          showToast("Journal entry permanently deleted.");
        } catch (err) { showToast(err.message); }
      }
    }
    });
}

/* ============================================================
   Module: Merchant's Thoughts Management
   ============================================================ */

const GET_THOUGHTS_URL    = "/api/get-merchant-thoughts";
const UPDATE_THOUGHTS_URL = "/api/update-merchant-thoughts";

let thoughtsData = null;

async function fetchThoughtsData() {
  try {
    const res = await fetch(GET_THOUGHTS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error();
    thoughtsData = await res.json();
  } catch {
    const res = await fetch("./data/merchant-thoughts.json", { cache: "no-store" });
    thoughtsData = await res.json();
  }
  if (!thoughtsData) thoughtsData = {};
  if (!thoughtsData.settings) thoughtsData.settings = {};
  if (!Array.isArray(thoughtsData.entries)) thoughtsData.entries = [];
  return thoughtsData;
}

async function saveThoughtsData(payload) {
  const token = getToken();
  const res = await fetch(UPDATE_THOUGHTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (res.status === 401) { clearToken(); showLogin(); throw new Error("Your session has expired."); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to save Merchant's thoughts.");
  }

  const data = await res.json();
  thoughtsData = data.data || payload;
  return thoughtsData;
}

async function loadAndRenderThoughts() {
  await fetchThoughtsData();
  renderThoughtsList();
}

function thoughtsSortKey(entry) {
  const d = entry?.date || "";
  const t = entry?.time || "00:00";
  return Date.parse(`${d}T${t}`) || 0;
}

function renderThoughtsList() {
  const container = document.getElementById("thoughts-list");
  if (!container) return;

  const searchQuery = (document.getElementById("thoughts-search-input")?.value || "").trim().toLowerCase();

  const entries = [...(thoughtsData.entries || [])].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const timeA = thoughtsSortKey(a);
    const timeB = thoughtsSortKey(b);
    return timeB - timeA;
  });

  const filtered = entries.filter((entry) => {
    const bodyStr = Array.isArray(entry.body) ? entry.body.join(" ") : String(entry.body || "");
    return !searchQuery ||
           (entry.title || "").toLowerCase().includes(searchQuery) ||
           (entry.author || "").toLowerCase().includes(searchQuery) ||
           bodyStr.toLowerCase().includes(searchQuery);
  });

  setText("thoughts-count", `${filtered.length} thought${filtered.length === 1 ? "" : "s"} in the timeline`);

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-emblem">💭</div>
        <h3>No thoughts found in the timeline.</h3>
        <p>Click "Jot a Thought" above to add a note to the Merchant's private records.</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map((entry) => {
    const pinnedBadge = entry.pinned
      ? `<span class="stock-badge stock-badge--low" style="margin-left:0.5rem;">📌 Pinned</span>`
      : "";

    const dateDisplay = entry.date;
    const timeDisplay = entry.time || "";
    const datetimeStr = entry.date ? `${entry.date}${timeDisplay ? " · " + timeDisplay : ""}` : "Undated";
    const authorStr = entry.author ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.2rem;">— ${escapeHtml(entry.author)}</div>` : "";
    const bodyHtml = Array.isArray(entry.body) && entry.body.length
      ? entry.body.map((p) => `<p style="font-size:0.85rem;color:var(--text-muted);margin-top:0.5rem;font-style:italic;line-height:1.4;">${escapeHtml(p)}</p>`).join("")
      : "";

    return `
      <article class="order-card ${entry.pinned ? "order-card--pinned" : ""}" data-thoughts-id="${entry.id}">
        <div class="order-card-header">
          <div class="order-card-title">
            ${entry.title ? `<span class="order-badge">${escapeHtml(entry.title)}</span>` : `<span class="order-badge" style="opacity:0.5;font-style:italic;color:var(--text-muted);">Untitled</span>`}
            ${pinnedBadge}
          </div>
        </div>
        <div class="order-card-body">
          <div style="font-size:0.8rem;color:var(--text-gold);">
            🕯️ ${escapeHtml(datetimeStr)}
          </div>
          ${authorStr}
          ${bodyHtml}
        </div>
        <div class="order-card-actions">
          <button class="btn-status" data-thoughts-action="edit" data-thoughts-id="${entry.id}">Edit</button>
          <button class="btn-ghost" data-thoughts-action="delete" data-thoughts-id="${entry.id}" style="color:#ff6b6b;margin-left:auto;">Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

function openThoughtsModal(entry = null) {
  const modal = document.getElementById("modal-thoughts");
  const title = document.getElementById("modal-thoughts-title");

  if (!modal) return;

  const todayStr = new Date().toLocaleDateString("en-CA");

  document.getElementById("thoughts-entry-id").value = entry ? entry.id : "";
  document.getElementById("thoughts-title").value = entry?.title || "";
  document.getElementById("thoughts-date").value = entry?.date || todayStr;
  document.getElementById("thoughts-time").value = entry?.time || "";
  document.getElementById("thoughts-author").value = entry?.author || "Alby";
  const bodyStr = Array.isArray(entry?.body) ? entry.body.join("\n\n") : (entry?.body || "");
  document.getElementById("thoughts-body").value = bodyStr;
  document.getElementById("thoughts-pinned").checked = Boolean(entry?.pinned);

  const deleteBtn = document.getElementById("thoughts-delete-btn");
  if (deleteBtn) deleteBtn.style.display = entry ? "inline-block" : "none";

  const createdAtInput = document.getElementById("thoughts-created-at");
  if (createdAtInput) createdAtInput.value = entry?.createdAt || "";

  if (title) title.textContent = entry ? "💭 Edit Thought" : "💭 Jot a New Thought";
  modal.classList.remove("hidden");
}

function closeThoughtsModal() {
  document.getElementById("modal-thoughts")?.classList.add("hidden");
}

/* ============================================================
   State
   ============================================================ */

/** All orders fetched from Stripe — module-level so all renderers share them */
let allOrders = [];

/** Cursor pagination state for the Merchant's Ledger */
let ledgerCursor  = null;
let ledgerHasMore = false;
let ledgerLoading = false;

/* ============================================================
   Main: render everything once orders are loaded
   ============================================================ */

function renderDashboard(orders) {
  allOrders = [...orders].sort((a, b) => b.created - a.created);

  /* Reset pagination cursor for a fresh initial load */
  ledgerCursor  = null;
  ledgerHasMore = false;

  /* Home tab date */
  setText("home-date", new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }));

  /* Stats */
  renderStats(computeStats(allOrders));

  /* Recent orders — newest 6 on the home tab */
  renderOrderCards(allOrders.slice(0, 6), document.getElementById("recent-orders"));

  /* Full ledger (applies active filters/sorts) */
  renderLedger();
}

async function loadAndRender() {
  showLoading();
  try {
    const [data, statuses] = await Promise.all([fetchOrders(), fetchFulfilmentStatuses()]);
    hideLoading();
    ledgerHasMore = !!data.hasMore;
    ledgerCursor  = data.nextCursor || null;
    renderDashboard(data.orders);
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

/** Mobile navigation burger — adapts the customer-site toggle to this isolated dashboard. */
function initMobileNav() {
  const toggle = document.getElementById("menu-toggle");
  const dashboard = document.getElementById("dashboard");
  if (!toggle || !dashboard) return;

  const setOpen = (open) => {
    dashboard.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    toggle.textContent = open ? "✕" : "☰";
  };

  toggle.addEventListener("click", () => {
    setOpen(!dashboard.classList.contains("nav-open"));
  });

  /* Close the menu after choosing a destination or action. */
  dashboard.querySelectorAll(".nav-item, #refresh-button, #logout-button").forEach((el) => {
    el.addEventListener("click", () => setOpen(false));
  });
}

/** Activate a dashboard tab — highlight the nav item and show its panel */
function activateTab(tabName) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `tab-${tabName}`);
  });
}

/** Wire all dashboard interactions — called once after login or if already authenticated */
function initDashboardUI() {

  /* Tab navigation */
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      activateTab(tab);
      /* Load inventory data when the Supplies tab is opened */
      if (tab === "supplies" && !allProducts.length) {
        loadAndRenderInventory();
      }
      /* Load Featured Treasure data when Featured tab is opened */
      if (tab === "featured") {
        loadAndRenderFeatured();
      }
      /* Load Journal data when Merchant's Journal tab is opened */
      if (tab === "journal") {
        loadAndRenderJournal();
      }
      /* Load Thoughts data when Merchant's Thoughts tab is opened */
      if (tab === "thoughts") {
        loadAndRenderThoughts();
      }
    });
  });

  /* Mobile navigation (burger) */
  initMobileNav();

  /* Inventory module */
  initInventoryUI();

  /* CMS module (Featured Treasure & Merchant's Journal) */
  initCmsUI();

  /* Thoughts module */
  initThoughtsUI();

  /* ── Ledger toolbar: search, filters, sort, date, export, pagination ── */
  const searchInput  = document.getElementById("search-input");
  const statusFilter = document.getElementById("status-filter");
  const sortFilter   = document.getElementById("sort-filter");
  const dateFilter   = document.getElementById("date-filter");
  const dateRangeRow = document.getElementById("date-range-row");
  const dateFrom     = document.getElementById("date-from");
  const dateTo       = document.getElementById("date-to");

  function syncDateRangeRow() {
    if (!dateRangeRow) return;
    dateRangeRow.classList.toggle("hidden", (dateFilter?.value || "all") !== "custom");
  }

  /* Re-render the register on every toolbar change */
  const rerenderLedger = () => { syncDateRangeRow(); renderLedger(); };
  searchInput?.addEventListener("input", rerenderLedger);
  statusFilter?.addEventListener("change", rerenderLedger);
  sortFilter?.addEventListener("change", rerenderLedger);
  dateFilter?.addEventListener("change", rerenderLedger);
  dateFrom?.addEventListener("change", renderLedger);
  dateTo?.addEventListener("change", renderLedger);

  /* Clear custom date range */
  document.getElementById("date-range-clear")?.addEventListener("click", () => {
    if (dateFrom) dateFrom.value = "";
    if (dateTo)   dateTo.value   = "";
    if (dateFilter) dateFilter.value = "all";
    rerenderLedger();
  });

  /* Delegated: advance fulfilment + open order detail (rows live in .dashboard-main) */
  document.querySelector(".dashboard-main")?.addEventListener("click", (event) => {
    const viewBtn = event.target.closest("[data-action='view']");
    if (viewBtn) {
      const order = allOrders.find((o) => o.id === viewBtn.dataset.orderId);
      if (order) openOrderDetail(order);
      return;
    }

    const advanceBtn = event.target.closest("[data-action='advance']");
    if (!advanceBtn) return;

    const orderId = advanceBtn.dataset.orderId;
    advanceFulfilmentStatus(orderId);

    /* Keep the open detail modal in sync if it shows this order */
    const modalBody = document.getElementById("modal-order-body");
    const modalOrder = allOrders.find((o) => o.id === orderId);
    if (modalBody && !document.getElementById("modal-order-detail")?.classList.contains("hidden") && modalBody.querySelector(`.order-card[data-order-id="${orderId}"]`)) {
      modalBody.innerHTML = buildOrderCard(modalOrder);
    }

    refreshOrderViews();
  });

  /* Order detail modal controls */
  const orderModal = document.getElementById("modal-order-detail");
  document.getElementById("modal-order-close")?.addEventListener("click", () => orderModal?.classList.add("hidden"));
  document.getElementById("modal-order-close-btn")?.addEventListener("click", () => orderModal?.classList.add("hidden"));
  orderModal?.addEventListener("click", (event) => {
    if (event.target === orderModal) orderModal.classList.add("hidden");
  });
  /* Advance button inside the modal */
  orderModal?.addEventListener("click", (event) => {
    const advanceBtn = event.target.closest("[data-action='advance']");
    if (!advanceBtn) return;
    const orderId = advanceBtn.dataset.orderId;
    advanceFulfilmentStatus(orderId);
    const modalBody = document.getElementById("modal-order-body");
    const modalOrder = allOrders.find((o) => o.id === orderId);
    if (modalBody && modalOrder) modalBody.innerHTML = buildOrderCard(modalOrder);
    refreshOrderViews();
  });

  /* Load older orders (cursor pagination) */
  document.getElementById("load-older")?.addEventListener("click", loadOlderOrders);

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
  initPasswordToggles();

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
