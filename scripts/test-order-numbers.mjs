/**
 * Integration tests for the unified LO-### order-number system.
 *
 * Runs against an in-process embedded PostgreSQL (PGlite + its wire-
 * protocol socket server) so the REAL server.js code paths (webhook,
 * manual-order endpoint, status system) are exercised unmodified.
 * Nothing here touches production, charges Stripe, or creates fake
 * customer data in any real database.
 *
 * Usage: node scripts/test-order-numbers.mjs
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PG_PORT = 54391;
const HTTP_PORT = 4590;
const WEBHOOK_SECRET = "whsec_test_order_numbers";

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
    fs.readFileSync(path.join(ROOT, "g7cloud_postgres_orders_migration.sql"), "utf8")
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
    STRIPE_SECRET_KEY: "sk_test_order_numbers_fixture",
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
  /* ── Login ── */
  const login = await apiPost("/api/dashboard-login", { password: "test-password" });
  check("dashboard login works (existing flow intact)", login.status === 200 && login.json?.token, `status=${login.status}`);
  const token = login.json?.token;

  /* ── 1. The two existing IRL orders, entered as LO-001 / LO-002 ── */
  const irl1 = await apiPost("/api/create-order", {
    clientRequestId: "irl-order-1",
    legacyOrderNumber: 1,
    items: [{ name: "IRL order item (details entered by merchant)", quantity: 1, unitAmount: 5 }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("legacy IRL order #1 stored as LO-001", irl1.json?.orderNumber === "LO-001", JSON.stringify(irl1.json));

  const irl2 = await apiPost("/api/create-order", {
    clientRequestId: "irl-order-2",
    legacyOrderNumber: 2,
    items: [{ name: "IRL order item 2 (details entered by merchant)", quantity: 1, unitAmount: 7.5 }],
    paymentMethod: "card",
    shippingMethod: "Local pickup"
  }, token);
  check("legacy IRL order #2 stored as LO-002", irl2.json?.orderNumber === "LO-002", JSON.stringify(irl2.json));

  /* Sequence understands 001/002 are allocated → next must be LO-003. */
  const irl3 = await apiPost("/api/create-order", {
    clientRequestId: "irl-order-3",
    items: [{ name: "First normal IRL order", quantity: 1, unitAmount: 3 }],
    paymentMethod: "cash",
    shippingMethod: "Local pickup"
  }, token);
  check("next allocated number after legacy import is LO-003", irl3.json?.orderNumber === "LO-003", JSON.stringify(irl3.json));

  /* ── 2. Concurrent allocation: two allocations fired at the same time.
     Uses two independent pg clients issuing INSERT ... nextval(...) —
     the embedded single-backend harness cannot host two interleaved
     multi-statement transactions, so the raw allocator (the piece the
     race actually hits) is exercised directly. */
  const pgModule = await import("pg");
  const PgPool = pgModule.default?.Pool || pgModule.Pool;
  const racePool = new PgPool({
    connectionString: `postgres://postgres@127.0.0.1:${PG_PORT}/test`,
    max: 2
  });
  const raceInsert = () => racePool.query(
    `INSERT INTO orders (order_number, source, items, payment_status, created_at, updated_at)
     VALUES (nextval('lo_order_number_seq'), 'irl', '[]'::jsonb, 'paid', 0, 0)
     RETURNING order_number`
  );
  /* Pre-establish both sockets sequentially: the embedded harness races
     on simultaneous handshakes, but parallel queries on established
     connections still exercise the concurrent allocator. */
  const warmA = await racePool.connect(); warmA.release();
  const warmB = await racePool.connect(); warmB.release();
  const [r1, r2] = await Promise.all([raceInsert(), raceInsert()]);
  await racePool.end();
  const raceNumbers = [r1.rows[0].order_number, r2.rows[0].order_number];
  check("concurrent allocations receive distinct numbers",
    new Set(raceNumbers).size === 2,
    raceNumbers.map((n) => formatOrderNumber(n)).join(", "));

  /* Concurrent full orders through the real HTTP endpoint too. */
  const [c1, c2] = await Promise.all([
    apiPost("/api/create-order", {
      clientRequestId: "concurrent-http-a",
      items: [{ name: "Concurrent order A", quantity: 1, unitAmount: 1 }],
      paymentMethod: "cash", shippingMethod: "Local pickup"
    }, token),
    apiPost("/api/create-order", {
      clientRequestId: "concurrent-http-b",
      items: [{ name: "Concurrent order B", quantity: 1, unitAmount: 1 }],
      paymentMethod: "cash", shippingMethod: "Local pickup"
    }, token)
  ]);
  const concurrentNumbers = [c1.json?.orderNumber, c2.json?.orderNumber].filter(Boolean);
  check("concurrent endpoint orders receive distinct numbers",
    concurrentNumbers.length === 2 && new Set(concurrentNumbers).size === 2,
    concurrentNumbers.join(", "));

  /* ── 3. Manual-order idempotency: retry must not double-allocate/decrement ── */
  const stockBefore = (await db.query(`SELECT inventory FROM inventory_state WHERE id='all'`)).rows[0].inventory["p2"].stock;
  const retry = await apiPost("/api/create-order", {
    clientRequestId: "irl-order-3",
    items: [{ name: "First normal IRL order", quantity: 1, unitAmount: 3 }],
    paymentMethod: "cash", shippingMethod: "Local pickup"
  }, token);
  const stockAfter = (await db.query(`SELECT inventory FROM inventory_state WHERE id='all'`)).rows[0].inventory["p2"].stock;
  const manualCount = (await db.query(`SELECT COUNT(*) AS n FROM orders WHERE client_request_id='irl-order-3'`)).rows[0].n;
  check("duplicate manual submission is deduplicated (same order returned)",
    retry.json?.existing === true && retry.json?.orderNumber === "LO-003" && Number(manualCount) === 1 && stockAfter === stockBefore,
    `stock ${stockBefore}→${stockAfter}`);

  /* ── 4. Online Stripe order via the existing webhook (real signed event) ── */
  const ev1 = checkoutCompletedEvent("evt_test_001", "cs_test_001", "pi_test_001", [{ id: "p1", qty: 2 }]);
  const whFirst = await postWebhook(ev1.payload, ev1.signature);
  const whReplay = await postWebhook(ev1.payload, ev1.signature);

  const onlineRows = (await db.query(
    `SELECT * FROM orders WHERE stripe_checkout_session_id='cs_test_001'`
  )).rows;
  const whStock = (await db.query(`SELECT inventory FROM inventory_state WHERE id='all'`)).rows[0].inventory["p1"].stock;

  check("webhook creates exactly one local order with an LO-### number",
    onlineRows.length === 1 && /^LO-\d{3,}$/.test(formatOrderNumber(onlineRows[0].order_number)),
    onlineRows[0] ? formatOrderNumber(onlineRows[0].order_number) : "no order");
  check("webhook is idempotent on redelivery (same event)",
    whFirst.status === 200 && whReplay.status === 200 && whReplay.text.includes("already processed"),
    `${whFirst.status} → ${whReplay.text}`);
  check("inventory decremented exactly once by the webhook", Number(whStock) === 48, `p1 stock=${whStock}`);
  check("online order retains Stripe session + payment intent ids",
    onlineRows[0].stripe_checkout_session_id === "cs_test_001" && onlineRows[0].stripe_payment_intent_id === "pi_test_001",
    `${onlineRows[0].stripe_checkout_session_id}, ${onlineRows[0].stripe_payment_intent_id}`);

  /* ── 5. A second online order continues the SAME sequence ── */
  const ev2 = checkoutCompletedEvent("evt_test_002", "cs_test_002", "pi_test_002", [{ id: "p1", qty: 1 }]);
  await postWebhook(ev2.payload, ev2.signature);
  const rows = (await db.query(`SELECT order_number FROM orders ORDER BY order_number`)).rows;
  const numbers = rows.map((r) => formatOrderNumber(r.order_number));

  check("manual and online orders share ONE sequence", JSON.stringify(numbers) === JSON.stringify(
    ["LO-001", "LO-002", "LO-003", "LO-004", "LO-005", "LO-006", "LO-007", "LO-008", "LO-009"]
  ), numbers.join(", "));

  check("every stored order number is unique",
    new Set(rows.map((r) => r.order_number)).size === rows.length,
    `${rows.length} orders`);

  /* ── 6. Sequence continues beyond 999 ── */
  await db.query(`SELECT setval('lo_order_number_seq', 998, true)`);
  const ev3 = checkoutCompletedEvent("evt_test_003", "cs_test_003", "pi_test_003", [{ id: "p1", qty: 1 }]);
  await postWebhook(ev3.payload, ev3.signature);
  const ev4 = checkoutCompletedEvent("evt_test_004", "cs_test_004", "pi_test_004", [{ id: "p1", qty: 1 }]);
  await postWebhook(ev4.payload, ev4.signature);
  const beyond = (await db.query(
    `SELECT order_number FROM orders WHERE stripe_checkout_session_id IN ('cs_test_003','cs_test_004') ORDER BY order_number`
  )).rows.map((r) => formatOrderNumber(r.order_number));
  check("zero-padding holds at 3+ digits and sequence passes 999",
    beyond[0] === "LO-999" && beyond[1] === "LO-1000",
    beyond.join(", "));

  /* ── 7. Existing fulfilment status system still works ── */
  const manualOrderId = irl3.json?.orderId;
  const advance = await apiPost("/api/update-order-status", { orderId: manualOrderId, status: "packed" }, token);
  const statuses = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/get-order-status`, {
    headers: { "Authorization": `Bearer ${token}` }
  }).then((r) => r.json());
  check("order status management works for manual orders (local id keying)",
    advance.status === 200 && statuses?.statuses?.[manualOrderId]?.status === "packed",
    statuses?.statuses?.[manualOrderId]?.status);

  check("webhook event idempotency ledger records each Stripe event exactly once",
    Number((await db.query(`SELECT COUNT(*) AS n FROM stripe_webhook_events`)).rows[0].n) === 4,
    "4 events");
} finally {
  server.kill();
  await pgServer.stop();
  await db.close();
}

const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────");
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("FAILED:");
  failed.forEach((f) => console.log(` - ${f.name}`));
  process.exit(1);
}

