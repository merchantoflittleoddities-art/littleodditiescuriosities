/**
 * Integration tests for Manual (IRL) order DATE selection, EDIT and
 * SOFT DELETE.
 *
 * Runs against an in-process embedded PostgreSQL (PGlite + its wire-
 * protocol socket server) so the REAL server.js code paths are exercised
 * unmodified. Nothing here touches production, charges Stripe, or
 * creates fake data in any real database.
 *
 * Usage: node scripts/test-order-edit-delete.mjs
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PG_PORT = 54392;
const HTTP_PORT = 4591;
const WEBHOOK_SECRET = "whsec_test_order_edit_delete";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "✅ PASS" : "❌ FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

function formatOrderNumber(n) {
  return `LO-${String(n).padStart(3, "0")}`;
}

/* ── SQL fixture ──────────────────────────────────────────────── */

const INVENTORY_SEED = JSON.stringify({
  "p1": { productId: "p1", stock: 50, available: true },
  "p2": { productId: "p2", stock: 1, available: true },
  "p3": { productId: "p3", stock: null, available: true }
});

function buildSchemaStatements() {
  const raw = [
    `CREATE TABLE IF NOT EXISTS inventory_state (
      id TEXT PRIMARY KEY,
      inventory JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS order_status_records (
      order_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    fs.readFileSync(path.join(ROOT, "stripe_webhook_events.sql"), "utf8"),
    fs.readFileSync(path.join(ROOT, "g7cloud_postgres_orders_migration.sql"), "utf8"),
    fs.readFileSync(path.join(ROOT, "g7cloud_postgres_soft_delete_migration.sql"), "utf8"),
    fs.readFileSync(path.join(ROOT, "g7cloud_postgres_inventory_applied_migration.sql"), "utf8")
  ].join("\n;\n");

  return raw
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ── HTTP helpers ─────────────────────────────────────────────── */

async function apiPost(pathname, body, token) {
  const response = await fetch(`http://127.0.0.1:${HTTP_PORT}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: response.status, json, text };
}

async function postWebhook(payload, signature) {
  const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/stripe-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: payload
  });
  return { status: response.status, text: await response.text() };
}

function signStripeEvent(payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function checkoutCompletedEvent(eventId, sessionId, paymentIntentId, items) {
  const event = {
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_intent: paymentIntentId,
        currency: "gbp",
        amount_total: 1000,
        customer_details: { name: "Test Traveller", email: "test@example.com" },
        metadata: {
          orderItems: JSON.stringify(items),
          shippingLabel: "Royal Courier",
          shippingAmount: "2.99",
          subtotal: "7.01",
          total: "10.00"
        }
      }
    }
  };
  const payload = JSON.stringify(event);
  return { payload, signature: signStripeEvent(payload) };
}

/* ── Main ─────────────────────────────────────────────────────── */

const db = new PGlite();
console.log("Applying schema to embedded PostgreSQL…");
for (const statement of buildSchemaStatements()) {
  await db.exec(statement);
}
await db.query(`INSERT INTO inventory_state (id, inventory) VALUES ($1, $2::jsonb)`, ["all", INVENTORY_SEED]);

const pgServer = new PGLiteSocketServer({ db, port: PG_PORT, host: "127.0.0.1", maxConnections: 8 });
await pgServer.start();
console.log(`Embedded PostgreSQL wire server on 127.0.0.1:${PG_PORT}`);

const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  env: {
    ...process.env,
    PORT: String(HTTP_PORT),
    DATABASE_URL: `postgres://postgres@127.0.0.1:${PG_PORT}/test`,
    STRIPE_SECRET_KEY: "sk_test_order_edit_delete_fixture",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    DASHBOARD_PASSWORD: "test-password",
    DASHBOARD_SECRET: "test-signing-secret"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[server:err] ${d}`));

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
  server.stdout.on("data", (d) => {
    if (String(d).includes("running on port")) { clearTimeout(timer); resolve(); }
  });
});

try {
  const login = await apiPost("/api/dashboard-login", { password: "test-password" });
  check("dashboard login works (existing flow intact)", login.status === 200 && login.json?.token, `status=${login.status}`);
  const token = login.json?.token;

  async function stockOf(productId) {
    const rows = (await db.query(`SELECT inventory FROM inventory_state WHERE id='all'`)).rows;
    return rows[0]?.inventory?.[productId]?.stock ?? null;
  }
  async function seqLastValue() {
    return Number((await db.query(`SELECT last_value FROM lo_order_number_seq`)).rows[0].last_value);
  }

  /* ── 1. DATE: manual order with a selectable historical date ── */
  const historicalMs = Date.UTC(2026, 8, 1, 12, 0, 0); /* 2026-09-01 @ noon UTC */
  const irl1 = await apiPost("/api/create-order", {
    clientRequestId: "edit-test-irl-1",
    orderDate: "2026-09-01",
    items: [{ name: "Sealed trinket", quantity: 2, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("IRL order with historical date created as LO-001",
    irl1.status === 200 && irl1.json?.orderNumber === "LO-001", JSON.stringify(irl1.json));
  const irl1Id = irl1.json?.orderId;

  const row1 = (await db.query(`SELECT created_at, updated_at FROM orders WHERE id=$1`, [irl1Id])).rows[0];
  check("selected calendar date stored exactly as noon-UTC BIGINT ms (no timezone day shift)",
    Number(row1.created_at) === historicalMs,
    `stored=${row1.created_at} expected=${historicalMs}`);
  check("updated_at remains the real creation time while created_at is back-dated",
    Math.abs(Number(row1.updated_at) - Date.now()) < 60000, String(row1.updated_at));
  check("inventory decremented once at creation for tracked product (p1: 50 → 48)",
    (await stockOf("p1")) === 48, `p1 stock=${await stockOf("p1")}`);

  /* ── 2. DATE: default is today when no date is sent ── */
  const before2 = Date.now();
  const irl2 = await apiPost("/api/create-order", {
    clientRequestId: "edit-test-irl-2",
    items: [{ name: "Custom engraved keepsake", quantity: 1, unitAmount: 5 }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  const row2 = (await db.query(`SELECT created_at FROM orders WHERE id=$1`, [irl2.json?.orderId])).rows[0];
  check("IRL order without a date defaults to today (LO-002)",
    irl2.json?.orderNumber === "LO-002" && Number(row2.created_at) >= before2 - 1000 && Number(row2.created_at) <= Date.now() + 1000,
    `created_at=${row2.created_at}`);
  check("custom (no productId) item does not touch inventory",
    (await stockOf("p1")) === 48 && (await stockOf("p2")) === 1);

  /* ── 3. DATE: invalid dates rejected ── */
  const badDate = await apiPost("/api/create-order", {
    clientRequestId: "edit-test-bad-date",
    orderDate: "2026-02-31",
    items: [{ name: "X", quantity: 1, unitAmount: 1 }],
    paymentMethod: "cash"
  }, token);
  check("impossible calendar date (2026-02-31) rejected with 400", badDate.status === 400, `status=${badDate.status}`);
  const badFormat = await apiPost("/api/create-order", {
    clientRequestId: "edit-test-bad-format",
    orderDate: "01/09/2026",
    items: [{ name: "X", quantity: 1, unitAmount: 1 }],
    paymentMethod: "cash"
  }, token);
  check("non-ISO date format rejected with 400", badFormat.status === 400, `status=${badFormat.status}`);

  /* ── 4. EDIT: date + customer + quantities, preserving LO-### ── */
  const seqBeforeEdit = await seqLastValue();
  const editedMs = Date.UTC(2026, 2, 15, 12, 0, 0); /* 2026-03-15 @ noon UTC */
  const edit1 = await apiPost("/api/update-order", {
    orderId: irl1Id,
    orderDate: "2026-03-15",
    customerName: "Margaret",
    customerEmail: "margaret@example.com",
    shippingAddress: "12 Hollow Lane",
    shippingMethod: "Royal Courier",
    shippingAmount: 1.5,
    paymentMethod: "card",
    notes: "Wrapped as a gift",
    items: [{ name: "Sealed trinket", quantity: 5, unitAmount: 3, productId: "p1" }]
  }, token);
  check("edit succeeds and preserves the existing LO-### number",
    edit1.status === 200 && edit1.json?.orderNumber === "LO-001", JSON.stringify(edit1.json));

  const row1b = (await db.query(
    `SELECT created_at, customer_name, customer_email, shipping_address, shipping_method, shipping_amount, payment_method, notes, subtotal, total, order_number
    FROM orders WHERE id=$1`, [irl1Id])).rows[0];
  check("edited date stored exactly (2026-03-15 noon UTC, no day shift)", Number(row1b.created_at) === editedMs, String(row1b.created_at));
  check("edited customer/address/shipping/payment/notes persisted",
    row1b.customer_name === "Margaret" && row1b.customer_email === "margaret@example.com" &&
    row1b.shipping_address === "12 Hollow Lane" && row1b.shipping_method === "Royal Courier" &&
    Number(row1b.shipping_amount) === 1.5 && row1b.payment_method === "card" && row1b.notes === "Wrapped as a gift");
  check("server recomputed subtotal/total from items (not client totals)",
    Number(row1b.subtotal) === 15 && Number(row1b.total) === 16.5, `subtotal=${row1b.subtotal} total=${row1b.total}`);
  check("editing does not consume a new sequence value",
    (await seqLastValue()) === seqBeforeEdit, `before=${seqBeforeEdit} after=${await seqLastValue()}`);
  check("quantity increase decrements only the DIFFERENCE (p1: 48 → 45)",
    (await stockOf("p1")) === 45, `p1 stock=${await stockOf("p1")}`);

  /* ── 5. EDIT: retry safety (no double-decrement, no new number) ── */
  const retryEdit = await apiPost("/api/update-order", {
    orderId: irl1Id,
    orderDate: "2026-03-15",
    items: [{ name: "Sealed trinket", quantity: 5, unitAmount: 3, productId: "p1" }],
    paymentMethod: "card"
  }, token);
  check("identical edit retry succeeds without double-decrementing stock (p1 stays 45)",
    retryEdit.status === 200 && (await stockOf("p1")) === 45, `p1 stock=${await stockOf("p1")}`);

  /* ── 6. EDIT: add item / remove item ── */
  const add2 = await apiPost("/api/update-order", {
    orderId: irl1Id,
    items: [
      { name: "Sealed trinket", quantity: 5, unitAmount: 3, productId: "p1" },
      { name: "Second charm", quantity: 1, unitAmount: 2, productId: "p2" }
    ],
    paymentMethod: "card"
  }, token);
  check("adding an item decrements only the new product (p2: 1 → 0, p1 unchanged at 45)",
    add2.status === 200 && (await stockOf("p2")) === 0 && (await stockOf("p1")) === 45,
    `p1=${await stockOf("p1")} p2=${await stockOf("p2")}`);

  const remove2 = await apiPost("/api/update-order", {
    orderId: irl1Id,
    items: [{ name: "Sealed trinket", quantity: 5, unitAmount: 3, productId: "p1" }],
    paymentMethod: "card"
  }, token);
  check("removing an item restores only that product (p2: 0 → 1, p1 unchanged at 45)",
    remove2.status === 200 && (await stockOf("p2")) === 1 && (await stockOf("p1")) === 45,
    `p1=${await stockOf("p1")} p2=${await stockOf("p2")}`);

  /* ── 7. EDIT: shortage clamped at zero, warning surfaced ── */
  const clampEdit = await apiPost("/api/update-order", {
    orderId: irl1Id,
    items: [
      { name: "Sealed trinket", quantity: 5, unitAmount: 3, productId: "p1" },
      { name: "Second charm", quantity: 3, unitAmount: 2, productId: "p2" }
    ],
    paymentMethod: "card"
  }, token);
  check("increase beyond available stock clamps at zero and surfaces a stock warning (p2 stays 0, never negative)",
    clampEdit.status === 200 && Array.isArray(clampEdit.json?.stockWarnings) && clampEdit.json.stockWarnings.length === 1 &&
    (await stockOf("p2")) === 0,
    `warnings=${JSON.stringify(clampEdit.json?.stockWarnings)} p2=${await stockOf("p2")}`);

  /* ── 8. EDIT: status records untouched, untracked product inventory-neutral ── */
  const statusBefore = (await db.query(`SELECT status FROM order_status_records WHERE order_id=$1`, [irl1Id])).rows[0]?.status;
  const neutral = await apiPost("/api/update-order", {
    orderId: irl1Id,
    items: [{ name: "Custom engraved keepsake", quantity: 2, unitAmount: 5 }],
    paymentMethod: "cash"
  }, token);
  const statusAfter = (await db.query(`SELECT status FROM order_status_records WHERE order_id=$1`, [irl1Id])).rows[0]?.status;
  check("editing does not modify order_status_records (status stays whatever it was)",
    neutral.status === 200 && statusBefore === statusAfter, `${statusBefore} → ${statusAfter}`);
  check("items without productId are inventory-neutral during edits (removing tracked items restores actual applied: p1 45 → 50, p2 0 → 1)",
    (await stockOf("p1")) === 50 && (await stockOf("p2")) === 1,
    `p1=${await stockOf("p1")} p2=${await stockOf("p2")}`);

  /* Restore order 1 items back to p1×5 for later checks (p1 50 → 45) */
  await apiPost("/api/update-order", {
    orderId: irl1Id,
    items: [{ name: "Sealed trinket", quantity: 5, unitAmount: 3, productId: "p1" }],
    paymentMethod: "card"
  }, token);

  /* ── 9. EDIT/DELETE: validation and auth guards ── */
  check("edit without a dashboard token is rejected (401)",
    (await apiPost("/api/update-order", { orderId: irl1Id, items: [] })).status === 401);
  check("delete without a dashboard token is rejected (401)",
    (await apiPost("/api/delete-order", { orderId: irl1Id })).status === 401);
  check("edit of a nonexistent order id returns 404",
    (await apiPost("/api/update-order", { orderId: crypto.randomUUID(), items: [{ name: "X", quantity: 1, unitAmount: 1 }] }, token)).status === 404);
  check("edit with invalid items returns 400",
    (await apiPost("/api/update-order", { orderId: irl1Id, items: [{ name: "X", quantity: 0, unitAmount: 1 }] }, token)).status === 400);

  /* ── 10. DELETE: soft delete of an IRL order ── */
  const del1 = await apiPost("/api/delete-order", { orderId: irl2.json?.orderId }, token);
  check("IRL order delete succeeds (soft delete)",
    del1.status === 200 && del1.json?.ok === true && del1.json?.orderNumber === "LO-002", JSON.stringify(del1.json));
  const row2b = (await db.query(`SELECT deleted_at, order_number FROM orders WHERE id=$1`, [irl2.json?.orderId])).rows[0];
  check("deleted order row is retained with deleted_at set (not hard-deleted)",
    row2b && row2b.deleted_at !== null && Number(row2b.order_number) === 2, `deleted_at=${row2b?.deleted_at}`);
  const statusRow2 = (await db.query(`SELECT COUNT(*) AS n FROM order_status_records WHERE order_id=$1`, [irl2.json?.orderId])).rows[0];
  check("deleted order keeps its order_status_records", Number(statusRow2.n) === 1);

  const delRetry = await apiPost("/api/delete-order", { orderId: irl2.json?.orderId }, token);
  check("deleting an already-deleted order is a safe no-op (retry-safe)",
    delRetry.status === 200 && delRetry.json?.alreadyDeleted === true);
  check("deletion of an order with no tracked inventory leaves stock untouched (p1 still 50, p2 still 1)",
    (await stockOf("p1")) === 50 && (await stockOf("p2")) === 1,
    `p1=${await stockOf("p1")} p2=${await stockOf("p2")}`);
  check("editing a deleted order is rejected (404)",
    (await apiPost("/api/update-order", { orderId: irl2.json?.orderId, items: [{ name: "X", quantity: 1, unitAmount: 1 }] }, token)).status === 404);

  /* ── 11. ORDER NUMBERS: no reuse after delete, sequence keeps moving ── */
  const irl3 = await apiPost("/api/create-order", {
    clientRequestId: "edit-test-irl-3",
    items: [{ name: "Post-delete order", quantity: 1, unitAmount: 4 }],
    paymentMethod: "cash"
  }, token);
  check("a deleted LO-### number is never reused (next order is LO-003, not LO-002)",
    irl3.json?.orderNumber === "LO-003", JSON.stringify(irl3.json));

  /* ── 12. ONLINE orders: created via webhook, immutable via new endpoints ── */
  const onlineEvent = checkoutCompletedEvent(
    "evt_edit_delete_1", "cs_edit_delete_1", "pi_edit_delete_1",
    [{ name: "Online charm (Miniature Sprout)", quantity: 1, unitAmount: 7.01 }]
  );
  const webhookResult = await postWebhook(onlineEvent.payload, onlineEvent.signature);
  check("Stripe webhook still creates online orders unchanged",
    webhookResult.status === 200, webhookResult.text.slice(0, 120));
  const onlineRow = (await db.query(
    `SELECT id, order_number FROM orders WHERE source='online' AND stripe_checkout_session_id='cs_edit_delete_1'`)).rows[0];
  check("online order shares the same LO-### sequence (LO-004)",
    onlineRow && Number(onlineRow.order_number) === 4, `order_number=${onlineRow?.order_number}`);
  const seqAfterWebhook = await seqLastValue();
  check("online creation consumes the shared sequence (last_value=4)", seqAfterWebhook === 4, String(seqAfterWebhook));

  const editOnline = await apiPost("/api/update-order", {
    orderId: onlineRow.id,
    items: [{ name: "Hacked", quantity: 1, unitAmount: 1 }]
  }, token);
  check("editing an ONLINE (Stripe) order through update-order is rejected server-side",
    editOnline.status === 400, `status=${editOnline.status}`);
  const deleteOnline = await apiPost("/api/delete-order", { orderId: onlineRow.id }, token);
  check("deleting an ONLINE (Stripe) order through delete-order is rejected server-side",
    deleteOnline.status === 400, `status=${deleteOnline.status}`);
  const onlineAfter = (await db.query(`SELECT order_number, deleted_at FROM orders WHERE id=$1`, [onlineRow.id])).rows[0];
  check("rejected online edit/delete left the online order untouched",
    onlineAfter && Number(onlineAfter.order_number) === 4 && onlineAfter.deleted_at === null);

  /* ── 13. Deleted orders excluded from normal views, retained in DB ── */
  const visibleOrders = (await db.query(
    `SELECT order_number FROM orders WHERE deleted_at IS NULL ORDER BY order_number`)).rows.map((r) => Number(r.order_number));
  check("deleted orders are excluded from the normal order views (LO-002 absent, others present)",
    JSON.stringify(visibleOrders) === JSON.stringify([1, 3, 4]), JSON.stringify(visibleOrders));
  const totalRows = (await db.query(`SELECT COUNT(*) AS n FROM orders`)).rows[0];
  check("deleted order still exists in the database (4 rows total)",
    Number(totalRows.n) === 4, String(totalRows.n));

  /* ── 14. Fulfilment status system still works for IRL orders ── */
  const advance = await apiPost("/api/update-order-status", { orderId: irl1Id, status: "completed" }, token);
  const statusResponse = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/get-order-status`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  const statuses = await statusResponse.json();
  check("existing fulfilment status flow still works (order 1 → completed)",
    advance.status === 200 && statuses?.statuses?.[irl1Id]?.status === "completed",
    statuses?.statuses?.[irl1Id]?.status);
  const finalRow = (await db.query(`SELECT status FROM order_status_records WHERE order_id=$1`, [irl1Id])).rows[0];
  check("completed status survives later edits", finalRow.status === "completed");
} finally {
  server.kill();
  await pgServer.stop();
  await db.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:");
  failed.forEach((f) => console.log(` - ${f.name} (${f.detail})`));
  process.exit(1);
}




