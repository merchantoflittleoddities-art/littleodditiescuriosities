/**
 * Integration tests for inventory_applied tracking.
 *
 * Runs against an in-process embedded PostgreSQL (PGlite + its wire-
 * protocol socket server) so the REAL server.js code paths are exercised
 * unmodified. Nothing here touches production, charges Stripe, or
 * creates fake data in any real database.
 *
 * Usage: node scripts/test-inventory-applied.mjs
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PG_PORT = 54393;
const HTTP_PORT = 4592;
const WEBHOOK_SECRET = "whsec_test_inventory_applied";

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
  "p1": { productId: "p1", stock: 10, available: true },
  "p2": { productId: "p2", stock: 2, available: true },
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

/* ── Tracking assertions ──────────────────────────────────────── */

async function trackingForOrder(productId) {
  const rows = (await db.query(
    `SELECT ordered_quantity, inventory_applied FROM order_inventory_tracking WHERE product_id = $1 ORDER BY order_id`,
    [productId]
  )).rows;
  return rows;
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
    STRIPE_SECRET_KEY: "sk_test_inventory_applied_fixture",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    DASHBOARD_PASSWORD: "test-password",
    DASHBOARD_SECRET: "test-signing-secret"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`[server:err] ${d}`));

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
  server.stdout.on("data", (d) => {
    if (String(d).includes("running on port")) { clearTimeout(timer); resolve(); }
  });
});

try {
  const login = await apiPost("/api/dashboard-login", { password: "test-password" });
  check("dashboard login works", login.status === 200 && login.json?.token, `status=${login.status}`);
  const token = login.json?.token;

  async function stockOf(productId) {
    const rows = (await db.query(`SELECT inventory FROM inventory_state WHERE id='all'`)).rows;
    return rows[0]?.inventory?.[productId]?.stock ?? null;
  }
  async function seqLastValue() {
    return Number((await db.query(`SELECT last_value FROM lo_order_number_seq`)).rows[0].last_value);
  }

  /* ── 1. Stock 10 → order 5 → applied 5 ── */
  const t1 = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-1",
    items: [{ name: "Test item", quantity: 5, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T1: order created", t1.status === 200 && t1.json?.ok === true, JSON.stringify(t1.json));
  check("T1: stock decremented by ordered qty (p1: 10 → 5)", (await stockOf("p1")) === 5, `p1=${await stockOf("p1")}`);
  const t1Tracking = await trackingForOrder("p1");
  check("T1: tracking records ordered=5, applied=5",
    t1Tracking.length === 1 && t1Tracking[0].ordered_quantity === 5 && t1Tracking[0].inventory_applied === 5,
    JSON.stringify(t1Tracking));

  /* ── 2. Stock 2 → order 5 → applied 2 ── */
  const t2 = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-2",
    items: [{ name: "Test item 2", quantity: 5, unitAmount: 3, productId: "p2" }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T2: order created with stock warning", t2.status === 200 && t2.json?.ok === true && Array.isArray(t2.json?.stockWarnings), JSON.stringify(t2.json));
  check("T2: stock clamped at zero (p2: 2 → 0)", (await stockOf("p2")) === 0, `p2=${await stockOf("p2")}`);
  const t2Tracking = await trackingForOrder("p2");
  check("T2: tracking records ordered=5, applied=2",
    t2Tracking.length === 1 && t2Tracking[0].ordered_quantity === 5 && t2Tracking[0].inventory_applied === 2,
    JSON.stringify(t2Tracking));

  /* ── 2b. Duplicate product rows accumulate actual inventory_applied ── */
  // Reset p2 stock so we can test accumulation with actual deductions.
  const p2Reset = (await db.query(`SELECT inventory FROM inventory_state WHERE id='all'`)).rows[0].inventory;
  p2Reset.p2.stock = 5;
  await db.query(`INSERT INTO inventory_state (id, inventory) VALUES ('all', $1::jsonb) ON CONFLICT (id) DO UPDATE SET inventory = EXCLUDED.inventory`, [JSON.stringify(p2Reset)]);
  check("T2b: p2 reset to 5 for duplicate-row test", (await stockOf("p2")) === 5, `p2=${await stockOf("p2")}`);

  const t2b = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-2b",
    items: [
      { name: "Dup A", quantity: 3, unitAmount: 3, productId: "p2" },
      { name: "Dup B", quantity: 3, unitAmount: 3, productId: "p2" }
    ],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T2b: order with duplicate product rows created", t2b.status === 200 && t2b.json?.ok === true, JSON.stringify(t2b.json));
  check("T2b: stock decremented by total applied (p2: 5 → 0)", (await stockOf("p2")) === 0, `p2=${await stockOf("p2")}`);
  const t2bOrderId = t2b.json?.orderId;
  const t2bTracking = t2bOrderId ? (await db.query(
    `SELECT ordered_quantity, inventory_applied FROM order_inventory_tracking WHERE order_id=$1`,
    [t2bOrderId]
  )).rows : [];
  check("T2b: tracking accumulates applied to 5 (not 3)", t2bTracking.length === 1 && Number(t2bTracking[0].inventory_applied) === 5 && Number(t2bTracking[0].ordered_quantity) === 6,
    JSON.stringify(t2bTracking));

  /* ── 3. Edit clamped order 5 → 1 → correct stock restoration based on applied ── */
  const t2OrderId = t2.json?.orderId;
  const t3 = await apiPost("/api/update-order", {
    orderId: t2OrderId,
    items: [{ name: "Test item 2", quantity: 1, unitAmount: 3, productId: "p2" }],
    paymentMethod: "cash"
  }, token);
  check("T3: edit succeeds", t3.status === 200 && t3.json?.ok === true, JSON.stringify(t3.json));
  check("T3: stock restored by applied delta (p2: 0 → 1, restored 1 not 4)", (await stockOf("p2")) === 1, `p2=${await stockOf("p2")}`);
  const t3TrackingResult = await db.query(
    `SELECT ordered_quantity, inventory_applied FROM order_inventory_tracking WHERE order_id=$1`,
    [t2OrderId]
  );
  const t3Tracking = t3TrackingResult.rows;
  check("T3: tracking updated to ordered=1, applied=1",
    t3Tracking.length === 1 && t3Tracking[0].ordered_quantity === 1 && t3Tracking[0].inventory_applied === 1,
    JSON.stringify(t3Tracking));

  /* ── 4. Edit order from 5 → 7 while stock is 0 → applied remains 2 ── */
  // Restore p2 to 2 so we can create a fresh clamped order for this scenario.
  const p2Reset2 = (await db.query(`SELECT inventory FROM inventory_state WHERE id='all'`)).rows[0].inventory;
  p2Reset2.p2.stock = 2;
  await db.query(`INSERT INTO inventory_state (id, inventory) VALUES ('all', $1::jsonb) ON CONFLICT (id) DO UPDATE SET inventory = EXCLUDED.inventory`, [JSON.stringify(p2Reset2)]);
  check("T4: p2 reset to 2 for fresh clamped order", (await stockOf("p2")) === 2, `p2=${await stockOf("p2")}`);

  const t4Order = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-4",
    items: [{ name: "Clamp edit target", quantity: 5, unitAmount: 3, productId: "p2" }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T4: fresh clamped order created (p2=2→0)", t4Order.status === 200 && t4Order.json?.ok === true && (await stockOf("p2")) === 0, JSON.stringify(t4Order.json));
  const t4OrderId = t4Order.json?.orderId;
  const t4Tracking0Result = await db.query(`SELECT inventory_applied FROM order_inventory_tracking WHERE order_id=$1`, [t4OrderId]);
  const t4Tracking0 = t4Tracking0Result.rows[0];
  check("T4: initial tracking applied=2", t4Tracking0 && Number(t4Tracking0.inventory_applied) === 2, JSON.stringify(t4Tracking0));

  const t4 = await apiPost("/api/update-order", {
    orderId: t4OrderId,
    items: [{ name: "Clamp edit target", quantity: 7, unitAmount: 3, productId: "p2" }],
    paymentMethod: "cash"
  }, token);
  check("T4: edit succeeds with stock warning", t4.status === 200 && t4.json?.ok === true && Array.isArray(t4.json?.stockWarnings) && t4.json.stockWarnings.length === 1, JSON.stringify(t4.json));
  check("T4: stock remains 0 (no further deduction possible)", (await stockOf("p2")) === 0, `p2=${await stockOf("p2")}`);
  const allTrackingAfterEdit = await db.query(`SELECT * FROM order_inventory_tracking`);
  const t4Tracking = allTrackingAfterEdit.rows.find(r => r.order_id === t4OrderId);
  check("T4: tracking applied remains 2 (ordered=7, applied=2)",
    t4Tracking && Number(t4Tracking.ordered_quantity) === 7 && Number(t4Tracking.inventory_applied) === 2,
    JSON.stringify(t4Tracking));

  /* ── 5. Replenish stock, then increase the order → only newly available stock is deducted ── */
  const t1OrderId = t1.json?.orderId;
  // T1 has p1=5, applied=5. Replenish by 10.
  const t5Replenish = await apiPost("/api/update-inventory", {
    action: "adjustStock",
    productId: "p1",
    value: 10
  }, token);
  check("T5: replenish p1 by 10", t5Replenish.status === 200 && t5Replenish.json?.ok === true, JSON.stringify(t5Replenish.json));
  check("T5: p1 stock after replenish = 15", (await stockOf("p1")) === 15, `p1=${await stockOf("p1")}`);

  const t5 = await apiPost("/api/update-order", {
    orderId: t1OrderId,
    items: [{ name: "Test item", quantity: 10, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash"
  }, token);
  check("T5: edit succeeds", t5.status === 200 && t5.json?.ok === true, JSON.stringify(t5.json));
  check("T5: only newly available stock deducted (p1: 15 → 10, deducted 5)", (await stockOf("p1")) === 10, `p1=${await stockOf("p1")}`);
  const t5Tracking = await trackingForOrder("p1");
  check("T5: tracking updated to ordered=10, applied=10",
    t5Tracking.length === 1 && t5Tracking[0].ordered_quantity === 10 && t5Tracking[0].inventory_applied === 10,
    JSON.stringify(t5Tracking));

  /* ── 5b. Replenish-then-no-qty-change edit must not re-deduct stock; qty increase deducts only newly available stock ── */
  // Reset p1 to 5 so we can test the exact scenario: stock 5 → order 5 → stock 0 → replenish +5 → stock 5.
  const p1ResetForT5b = (await db.query(`SELECT inventory FROM inventory_state WHERE id='all'`)).rows[0].inventory;
  p1ResetForT5b.p1.stock = 5;
  await db.query(`INSERT INTO inventory_state (id, inventory) VALUES ('all', $1::jsonb) ON CONFLICT (id) DO UPDATE SET inventory = EXCLUDED.inventory`, [JSON.stringify(p1ResetForT5b)]);
  check("T5b: p1 reset to 5 for replenish-then-edit test", (await stockOf("p1")) === 5, `p1=${await stockOf("p1")}`);

  const t5b = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-5b",
    items: [{ name: "Replenish edit target", quantity: 5, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T5b: order created with stock 5, qty 5", t5b.status === 200 && t5b.json?.ok === true && (await stockOf("p1")) === 0, JSON.stringify(t5b.json));
  const t5bOrderId = t5b.json?.orderId;
  const t5bTracking0 = (await db.query(`SELECT inventory_applied FROM order_inventory_tracking WHERE order_id=$1`, [t5bOrderId])).rows[0];
  check("T5b: initial tracking applied=5", t5bTracking0 && Number(t5bTracking0.inventory_applied) === 5, JSON.stringify(t5bTracking0));

  const t5bReplenish = await apiPost("/api/update-inventory", {
    action: "adjustStock",
    productId: "p1",
    value: 5
  }, token);
  check("T5b: replenish p1 by 5", t5bReplenish.status === 200 && t5bReplenish.json?.ok === true, JSON.stringify(t5bReplenish.json));
  check("T5b: p1 stock after replenish = 5", (await stockOf("p1")) === 5, `p1=${await stockOf("p1")}`);

  // Edit without changing quantities — should NOT re-deduct the replenished stock.
  const t5bNoopEdit = await apiPost("/api/update-order", {
    orderId: t5bOrderId,
    items: [{ name: "Replenish edit target", quantity: 5, unitAmount: 3, productId: "p1" }],
    customerName: "Updated Name",
    notes: "No-op quantity edit",
    paymentMethod: "cash"
  }, token);
  check("T5b: no-qty edit succeeds without re-deducting stock", t5bNoopEdit.status === 200 && t5bNoopEdit.json?.ok === true && (await stockOf("p1")) === 5, `p1=${await stockOf("p1")}`);
  const t5bTrackingAfterNoop = (await db.query(`SELECT inventory_applied FROM order_inventory_tracking WHERE order_id=$1`, [t5bOrderId])).rows[0];
  check("T5b: tracking applied remains 5 after no-qty edit", t5bTrackingAfterNoop && Number(t5bTrackingAfterNoop.inventory_applied) === 5, JSON.stringify(t5bTrackingAfterNoop));

  // Now increase quantity from 5 → 7 — should deduct only the newly available 2.
  const t5bIncrease = await apiPost("/api/update-order", {
    orderId: t5bOrderId,
    items: [{ name: "Replenish edit target", quantity: 7, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash"
  }, token);
  check("T5b: increase edit succeeds", t5bIncrease.status === 200 && t5bIncrease.json?.ok === true, JSON.stringify(t5bIncrease.json));
  check("T5b: only newly available stock deducted (p1: 5 → 3, deducted 2)", (await stockOf("p1")) === 3, `p1=${await stockOf("p1")}`);
  const t5bTrackingAfterIncrease = (await db.query(`SELECT ordered_quantity, inventory_applied FROM order_inventory_tracking WHERE order_id=$1`, [t5bOrderId])).rows[0];
  check("T5b: tracking updated to ordered=7, applied=7",
    t5bTrackingAfterIncrease && Number(t5bTrackingAfterIncrease.ordered_quantity) === 7 && Number(t5bTrackingAfterIncrease.inventory_applied) === 7,
    JSON.stringify(t5bTrackingAfterIncrease));

  /* ── 6. Remove a product from an order → restore the actual applied amount ── */
  const t6Replenish = await apiPost("/api/update-inventory", {
    action: "adjustStock",
    productId: "p2",
    value: 5
  }, token);
  check("T6: replenish p2 by 5", t6Replenish.status === 200 && t6Replenish.json?.ok === true, JSON.stringify(t6Replenish.json));
  check("T6: p2 stock after replenish = 5", (await stockOf("p2")) === 5, `p2=${await stockOf("p2")}`);

  const t6 = await apiPost("/api/update-order", {
    orderId: t1OrderId,
    items: [
      { name: "Test item", quantity: 10, unitAmount: 3, productId: "p1" },
      { name: "Extra item", quantity: 3, unitAmount: 2, productId: "p2" }
    ],
    paymentMethod: "cash"
  }, token);
  check("T6: add p2 succeeds with no warning (p2=5, qty=3)", t6.status === 200 && t6.json?.ok === true, JSON.stringify(t6.json));
  check("T6: p2 stock after add = 2", (await stockOf("p2")) === 2, `p2=${await stockOf("p2")}`);
  const allTrackingAfterT6 = await db.query(`SELECT * FROM order_inventory_tracking`);
  const t6TrackingBefore = allTrackingAfterT6.rows.find(r => r.order_id === t1OrderId && r.product_id === "p2");
  check("T6: p2 tracking inserted for order A", t6TrackingBefore && Number(t6TrackingBefore.inventory_applied) === 3, JSON.stringify(t6TrackingBefore));

  const t6Remove = await apiPost("/api/update-order", {
    orderId: t1OrderId,
    items: [{ name: "Test item", quantity: 10, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash"
  }, token);
  check("T6: remove p2 succeeds", t6Remove.status === 200 && t6Remove.json?.ok === true, JSON.stringify(t6Remove.json));
  check("T6: p2 stock restored by applied amount (2 → 5)", (await stockOf("p2")) === 5, `p2=${await stockOf("p2")}`);
  const t6TrackingAfterResult = await db.query(`SELECT * FROM order_inventory_tracking WHERE order_id=$1`, [t1OrderId]);
  const t6TrackingAfter = t6TrackingAfterResult.rows.find(r => r.product_id === "p2");
  check("T6: p2 tracking row removed after removal", !t6TrackingAfter, JSON.stringify(t6TrackingAfterResult.rows));

  /* ── 7. Delete an IRL order → restore actual applied amount ── */
  // Restore p1 to 10 for a clean delete test
  const p1Reset = (await db.query(`SELECT inventory FROM inventory_state WHERE id='all'`)).rows[0].inventory;
  p1Reset.p1.stock = 10;
  await db.query(`INSERT INTO inventory_state (id, inventory) VALUES ('all', $1::jsonb) ON CONFLICT (id) DO UPDATE SET inventory = EXCLUDED.inventory`, [JSON.stringify(p1Reset)]);
  check("T7: p1 reset to 10 for delete test", (await stockOf("p1")) === 10, `p1=${await stockOf("p1")}`);

  const t7 = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-7",
    items: [
      { name: "Delete test p1", quantity: 3, unitAmount: 3, productId: "p1" },
      { name: "Delete test p3", quantity: 2, unitAmount: 2, productId: "p3" }
    ],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T7: order created for delete test", t7.status === 200 && t7.json?.ok === true, JSON.stringify(t7.json));
  check("T7: p1 stock before delete = 7", (await stockOf("p1")) === 7, `p1=${await stockOf("p1")}`);

  const t7OrderId = t7.json?.orderId;
  const t7TrackingResult = await db.query(`SELECT product_id, inventory_applied FROM order_inventory_tracking WHERE order_id=$1`, [t7OrderId]);
  const t7TrackingBefore = t7TrackingResult.rows;
  check("T7: tracking recorded before delete", t7TrackingBefore.length === 1 && t7TrackingBefore.find(r => r.product_id === "p1")?.inventory_applied === 3, JSON.stringify(t7TrackingBefore));

  const t7Delete = await apiPost("/api/delete-order", { orderId: t7OrderId }, token);
  check("T7: delete succeeds", t7Delete.status === 200 && t7Delete.json?.ok === true && t7Delete.json?.alreadyDeleted === false, JSON.stringify(t7Delete.json));
  check("T7: p1 stock restored (7 → 10)", (await stockOf("p1")) === 10, `p1=${await stockOf("p1")}`);
  const t7TrackingAfterResult = await db.query(`SELECT * FROM order_inventory_tracking WHERE order_id=$1`, [t7OrderId]);
  check("T7: tracking rows removed after delete", t7TrackingAfterResult.rows.length === 0, JSON.stringify(t7TrackingAfterResult.rows));

  /* ── 8. Delete retry → no double restoration ── */
  const t8Retry = await apiPost("/api/delete-order", { orderId: t7OrderId }, token);
  check("T8: retry delete is safe no-op", t8Retry.status === 200 && t8Retry.json?.alreadyDeleted === true, JSON.stringify(t8Retry.json));
  check("T8: p1 stock unchanged after retry (still 10)", (await stockOf("p1")) === 10, `p1=${await stockOf("p1")}`);

  /* ── 9. Manual duplicate submission → no double deduction ── */
  const t9Before = await stockOf("p1");
  const t9 = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-9",
    items: [{ name: "Duplicate test", quantity: 2, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T9: first submission succeeds", t9.status === 200 && t9.json?.ok === true && t9.json?.existing === false, JSON.stringify(t9.json));
  const stockAfterFirst = await stockOf("p1");
  const t9Dup = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-9",
    items: [{ name: "Duplicate test", quantity: 2, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T9: duplicate submission returns existing order", t9Dup.status === 200 && t9Dup.json?.existing === true, JSON.stringify(t9Dup.json));
  check("T9: no double deduction (p1 unchanged)", (await stockOf("p1")) === stockAfterFirst, `p1=${await stockOf("p1")}`);

  /* ── 10. Stripe webhook replay → no double deduction ── */
  const p1BeforeWebhook = await stockOf("p1");
  const webhookEvent = checkoutCompletedEvent(
    "evt_inv_replay_1", "cs_inv_replay_1", "pi_inv_replay_1",
    [{ id: "p1", qty: 2 }]
  );
  const wh1 = await postWebhook(webhookEvent.payload, webhookEvent.signature);
  check("T10: first webhook succeeds", wh1.status === 200, wh1.text.slice(0, 80));
  const p1AfterFirst = await stockOf("p1");
  const wh2 = await postWebhook(webhookEvent.payload, webhookEvent.signature);
  check("T10: replay webhook is no-op", wh2.status === 200, wh2.text.slice(0, 80));
  check("T10: no double deduction from webhook replay", (await stockOf("p1")) === p1AfterFirst, `p1=${await stockOf("p1")}`);

  /* ── 11. Custom/untracked items → no inventory mutation ── */
  const t11BeforeP1 = await stockOf("p1");
  const t11 = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-11",
    items: [{ name: "Custom engraved keepsake", quantity: 2, unitAmount: 5 }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T11: custom item order created", t11.status === 200 && t11.json?.ok === true, JSON.stringify(t11.json));
  check("T11: p1 stock unchanged for custom item", (await stockOf("p1")) === t11BeforeP1, `p1=${await stockOf("p1")}`);
  const t11TrackingResult = await db.query(`SELECT COUNT(*) AS n FROM order_inventory_tracking WHERE product_id='p1' AND order_id=$1`, [t11.json?.orderId]);
  check("T11: no tracking row for custom item", Number(t11TrackingResult.rows[0]?.n ?? 0) === 0, `n=${JSON.stringify(t11TrackingResult.rows)}`);

  /* ── 12. Historical orders without tracking → no guessed restoration ── */
  const t12 = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-12-legacy",
    legacyOrderNumber: 99,
    items: [{ name: "Legacy order item", quantity: 3, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T12: legacy order created with explicit number", t12.status === 200 && t12.json?.orderNumber === "LO-099", JSON.stringify(t12.json));

  // Delete the tracking row to simulate a pre-tracking historical order
  await db.query(`DELETE FROM order_inventory_tracking WHERE order_id=$1`, [t12.json?.orderId]);
  const t12TrackingCheckResult = await db.query(`SELECT COUNT(*) AS n FROM order_inventory_tracking WHERE order_id=$1`, [t12.json?.orderId]);
  check("T12: tracking row removed (pre-tracking simulation)", Number(t12TrackingCheckResult.rows[0]?.n ?? -1) === 0, `n=${JSON.stringify(t12TrackingCheckResult.rows)}`);

  const t12Delete = await apiPost("/api/delete-order", { orderId: t12.json?.orderId }, token);
  check("T12: delete succeeds for pre-tracking order", t12Delete.status === 200 && t12Delete.json?.ok === true, JSON.stringify(t12Delete.json));
  check("T12: p1 stock unchanged after delete (no guessed restoration)", (await stockOf("p1")) === 3, `p1=${await stockOf("p1")}`);

  /* ── 13. Editing an untracked historical order does not guess or mutate inventory ── */
  const t13 = await apiPost("/api/create-order", {
    clientRequestId: "inv-test-13-legacy",
    legacyOrderNumber: 100,
    items: [{ name: "Legacy untracked item", quantity: 3, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("T13: legacy order created for untracked edit test", t13.status === 200 && t13.json?.orderNumber === "LO-100", JSON.stringify(t13.json));

  // Remove tracking to simulate a pre-tracking historical order
  await db.query(`DELETE FROM order_inventory_tracking WHERE order_id=$1`, [t13.json?.orderId]);
  const t13Before = await stockOf("p1");
  const t13Edit = await apiPost("/api/update-order", {
    orderId: t13.json?.orderId,
    items: [{ name: "Legacy untracked item edited", quantity: 1, unitAmount: 3, productId: "p1" }],
    paymentMethod: "cash"
  }, token);
  check("T13: edit of untracked historical order succeeds without mutating inventory",
    t13Edit.status === 200 && t13Edit.json?.ok === true && (await stockOf("p1")) === t13Before,
    `status=${t13Edit.status} p1=${await stockOf("p1")}`);
  const t13TrackingResult = await db.query(`SELECT COUNT(*) AS n FROM order_inventory_tracking WHERE order_id=$1`, [t13.json?.orderId]);
  check("T13: no tracking rows created for historical untracked order", Number(t13TrackingResult.rows[0]?.n ?? -1) === 0, `n=${JSON.stringify(t13TrackingResult.rows)}`);

  /* ── Final summary ── */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:");
    failed.forEach((f) => console.log(` - ${f.name} (${f.detail})`));
    process.exitCode = 1;
  }
} finally {
  server.kill();
  await pgServer.stop();
  await db.close();
}
