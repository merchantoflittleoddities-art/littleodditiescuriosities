const http = require("http");
const fs = require("fs");
const path = require("path");
const pool = require("./db");
const crypto = require("crypto");
const {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  getBearerToken,
  normaliseEmail
} = require("./netlify/functions/_customer-lib");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

const PRIVATE_API_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Pragma": "no-cache",
  "Expires": "0",
  "Vary": "Authorization"
};

function sendPrivateApiJson(res, statusCode, payload) {
  sendJson(res, statusCode, payload, PRIVATE_API_NO_STORE_HEADERS);
}

async function readRequestBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

function isDuplicateEmailError(error) {
  return error?.code === "23505" && (
    error?.constraint === "customers_email_key" ||
    String(error?.detail || "").includes("(email)=(")
  );
}

function isProfileWriteStateError(error) {
  return error?.code === "40001" || error?.code === "40P01";
}

const RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const FORGOT_PASSWORD_INTERNAL_ERROR = "Something went wrong. Please try again.";
const RESET_PASSWORD_INTERNAL_ERROR = "Reset failed.";

function getTokenIssuedAtMs(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;

  const issuedAtMs = parseInt(parts[1], 10);
  return Number.isFinite(issuedAtMs) ? issuedAtMs : null;
}

function toProfileCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role || "traveller",
    notificationPrefs: row.notification_prefs || { orderUpdates: true }
  };
}

async function authenticateProfileRequest(req) {
  const token = getBearerToken({ headers: req.headers || {} });
  const customerId = verifyToken(token);

  if (!customerId) {
    return { ok: false, statusCode: 401 };
  }

  const tokenIssuedAtMs = getTokenIssuedAtMs(token);
  if (!Number.isFinite(tokenIssuedAtMs)) {
    return { ok: false, statusCode: 401 };
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, role, notification_prefs, token_revoked_after_ms
      FROM customers
      WHERE id = $1
      LIMIT 1`,
      [customerId]
    );

    const customer = result.rows[0] || null;
    if (!customer) {
      return { ok: false, statusCode: 401 };
    }

    const cutoff = Number(customer.token_revoked_after_ms);
    if (Number.isFinite(cutoff) && cutoff > 0 && tokenIssuedAtMs <= cutoff) {
      return { ok: false, statusCode: 401 };
    }

    return { ok: true, customerId, tokenIssuedAtMs, customer };
  } catch (error) {
    console.error("customer-profile: failed to load customer during authentication:", error);
    return { ok: false, statusCode: 503 };
  }
}

async function loadCustomerWishlistProductIds(customerId) {
  const result = await pool.query(
    `SELECT product_id
    FROM customer_wishlist
    WHERE customer_id = $1
    ORDER BY created_at ASC, product_id ASC`,
    [customerId]
  );

  return result.rows.map((row) => row.product_id);
}

async function handleCustomerProfile(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendPrivateApiJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const auth = await authenticateProfileRequest(req);
  if (!auth.ok) {
    if (auth.statusCode === 503) {
      sendPrivateApiJson(res, 503, {
        error: "Authentication state could not be verified. Please try again."
      });
      return;
    }

    sendPrivateApiJson(res, 401, { error: "Please sign in again." });
    return;
  }

  if (req.method === "GET") {
    sendPrivateApiJson(res, 200, { customer: toProfileCustomer(auth.customer) });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const { name, email, password, notificationPrefs } = body;

  let nextName = null;
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) {
      sendPrivateApiJson(res, 400, { error: "Traveller Name cannot be empty." });
      return;
    }
    nextName = trimmed;
  }

  let nextEmail = null;
  if (email !== undefined) {
    nextEmail = normaliseEmail(email);
    if (!nextEmail) {
      sendPrivateApiJson(res, 400, { error: "Please provide a valid email address." });
      return;
    }
  }

  let nextHash = null;
  let nextSalt = null;
  if (password !== undefined) {
    if (String(password).length < 8) {
      sendPrivateApiJson(res, 400, { error: "Traveller password must be at least 8 characters." });
      return;
    }

    const passwordUpdate = hashPassword(password);
    nextHash = passwordUpdate.hash;
    nextSalt = passwordUpdate.salt;
  }

  let notificationPrefsPatch = null;
  if (notificationPrefs !== undefined && typeof notificationPrefs === "object") {
    notificationPrefsPatch = { ...(notificationPrefs || {}) };
  }

  const shouldMergeNotificationPrefs = notificationPrefsPatch !== null;

  try {
    const update = await pool.query(
      `UPDATE customers
      SET
        name = COALESCE($2, name),
        email = COALESCE($3, email),
        password_hash = COALESCE($4, password_hash),
        salt = COALESCE($5, salt),
        notification_prefs = CASE
          WHEN $6::boolean
            THEN COALESCE(notification_prefs, '{}'::jsonb) || $7::jsonb
          ELSE notification_prefs
        END
      WHERE id = $1
      RETURNING id, name, email, role, notification_prefs`,
      [
        auth.customerId,
        nextName,
        nextEmail,
        nextHash,
        nextSalt,
        shouldMergeNotificationPrefs,
        JSON.stringify(notificationPrefsPatch || {})
      ]
    );

    const updatedCustomer = update.rows[0] || null;
    if (!updatedCustomer) {
      sendPrivateApiJson(res, 401, { error: "Please sign in again." });
      return;
    }

    sendPrivateApiJson(res, 200, { customer: toProfileCustomer(updatedCustomer) });
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      sendPrivateApiJson(res, 409, {
        error: "Another Traveller already uses that email address."
      });
      return;
    }

    if (isProfileWriteStateError(error)) {
      sendPrivateApiJson(res, 503, {
        error: "Your Preferences could not be saved right now. Please try again."
      });
      return;
    }

    console.error("customer-profile: failed to update customer:", error);
    sendPrivateApiJson(res, 500, {
      error: "Something went wrong. Please try again."
    });
  }
}

async function handleCustomerWishlist(req, res) {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
    sendPrivateApiJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const auth = await authenticateProfileRequest(req);
  if (!auth.ok) {
    if (auth.statusCode === 503) {
      sendPrivateApiJson(res, 503, {
        error: "Authentication state could not be verified. Please try again."
      });
      return;
    }

    sendPrivateApiJson(res, 401, { error: "Please sign in again." });
    return;
  }

  if (req.method === "GET") {
    const productIds = await loadCustomerWishlistProductIds(auth.customerId);
    sendPrivateApiJson(res, 200, { productIds });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendPrivateApiJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const { productId } = body;
  if (!productId) {
    sendPrivateApiJson(res, 400, { error: "A productId is required." });
    return;
  }

  if (req.method === "POST") {
    await pool.query(
      `INSERT INTO customer_wishlist (customer_id, product_id)
      VALUES ($1, $2)
      ON CONFLICT (customer_id, product_id) DO NOTHING`,
      [auth.customerId, productId]
    );
  } else {
    await pool.query(
      `DELETE FROM customer_wishlist
      WHERE customer_id = $1 AND product_id = $2`,
      [auth.customerId, productId]
    );
  }

  const productIds = await loadCustomerWishlistProductIds(auth.customerId);
  sendPrivateApiJson(res, 200, { productIds });
}

async function handleCustomerForgotPassword(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let email;
  try {
    ({ email } = JSON.parse(bodyText));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const key = normaliseEmail(email);
  if (!key) {
    sendJson(res, 400, { error: "An email address is required." });
    return;
  }

  const customerResult = await pool.query(
    `SELECT id
    FROM customers
    WHERE email = $1
    LIMIT 1`,
    [key]
  );

  const customer = customerResult.rows[0] || null;
  if (!customer) {
    sendJson(res, 200, {});
    return;
  }

  const resetToken = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO customer_reset_tokens (token, customer_id, expires_at)
    VALUES ($1, $2, $3)`,
    [
      resetToken,
      customer.id,
      new Date(Date.now() + RESET_TOKEN_LIFETIME_MS).toISOString()
    ]
  );

  const siteUrl = process.env.URL || "";
  const resetUrl = `${siteUrl}/reset-password.html?token=${resetToken}`;

  sendJson(res, 200, { resetUrl });
}

async function handleCustomerResetPassword(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let resetToken;
  let password;
  try {
    ({ token: resetToken, password } = JSON.parse(bodyText));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  if (!resetToken || !password) {
    sendJson(res, 400, { error: "A reset token and new Traveller password are required." });
    return;
  }

  if (String(password).length < 8) {
    sendJson(res, 400, { error: "Traveller password must be at least 8 characters." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tokenResult = await client.query(
      `SELECT customer_id, expires_at
      FROM customer_reset_tokens
      WHERE token = $1
      FOR UPDATE`,
      [resetToken]
    );

    const tokenRecord = tokenResult.rows[0] || null;
    if (!tokenRecord || Date.now() > new Date(tokenRecord.expires_at).getTime()) {
      await client.query("ROLLBACK");
      sendJson(res, 400, {
        error: "That reset link has expired or is no longer valid. Please request a new one."
      });
      return;
    }

    const { salt, hash } = hashPassword(password);
    const customerUpdate = await client.query(
      `UPDATE customers
      SET password_hash = $2,
          salt = $3
      WHERE id = $1
      RETURNING id, name, email`,
      [tokenRecord.customer_id, hash, salt]
    );

    const customer = customerUpdate.rows[0] || null;
    if (!customer) {
      await client.query("ROLLBACK");
      sendJson(res, 404, { error: "That Traveller could no longer be found." });
      return;
    }

    await client.query(
      `DELETE FROM customer_reset_tokens
      WHERE token = $1`,
      [resetToken]
    );

    await client.query("COMMIT");

    const sessionToken = createToken(customer.id);
    sendJson(res, 200, {
      token: sessionToken,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email
      }
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors so the original database failure is reported.
    }

    if (isProfileWriteStateError(error)) {
      sendJson(res, 503, {
        error: "Your password could not be reset right now. Please try again."
      });
      return;
    }

    throw error;
  } finally {
    client.release();
  }
}

async function handleCustomerRegister(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let name;
  let email;
  let password;
  try {
    ({ name, email, password } = JSON.parse(bodyText));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  name = String(name || "").trim();
  const key = normaliseEmail(email);

  if (!name || !key || !password) {
    sendJson(res, 400, {
      error: "Traveller name, email address, and Traveller password are all required."
    });
    return;
  }

  if (String(password).length < 8) {
    sendJson(res, 400, { error: "Traveller password must be at least 8 characters." });
    return;
  }

  const { salt, hash } = hashPassword(password);
  const customerId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const role = "traveller";

  try {
    const result = await pool.query(
      `INSERT INTO customers (
        id,
        name,
        email,
        password_hash,
        salt,
        notification_prefs,
        created_at,
        role
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      RETURNING id, name, email, role`,
      [
        customerId,
        name,
        key,
        hash,
        salt,
        JSON.stringify({ orderUpdates: true }),
        createdAt,
        role
      ]
    );

    const customer = result.rows[0];
    const token = createToken(customer.id);

    sendJson(res, 200, {
      token,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        role: customer.role
      }
    });
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      sendJson(res, 409, { error: "A Traveller is already known by that email address." });
      return;
    }

    console.error("customer-register: failed to create customer:", error);
    sendJson(res, 500, { error: "Unable to create Traveller account right now." });
  }
}

async function handleCustomerLogin(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  let email;
  let password;
  try {
    ({ email, password } = JSON.parse(bodyText));
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const key = normaliseEmail(email);
  if (!key || !password) {
    sendJson(res, 400, {
      error: "Email address and Traveller password are required."
    });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, role, password_hash, salt
      FROM customers
      WHERE email = $1
      LIMIT 1`,
      [key]
    );

    const customer = result.rows[0] || null;

    if (!customer || !verifyPassword(password, customer.salt, customer.password_hash)) {
      sendJson(res, 401, {
        error: "That email address and Traveller password do not match our records."
      });
      return;
    }

    const token = createToken(customer.id);
    sendJson(res, 200, {
      token,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        role: customer.role || "traveller"
      }
    });
  } catch (error) {
    console.error("customer-login: failed to authenticate customer:", error);
    sendJson(res, 500, { error: "Unable to sign in right now." });
  }
}

const server = http.createServer((req, res) => {
  let requestPath;
  try {
    requestPath = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }

  if (requestPath === "/.netlify/functions/customer-register") {
    handleCustomerRegister(req, res).catch((error) => {
      console.error("customer-register: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Unable to create Traveller account right now." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (requestPath === "/.netlify/functions/customer-login") {
    handleCustomerLogin(req, res).catch((error) => {
      console.error("customer-login: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Unable to sign in right now." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (requestPath === "/.netlify/functions/customer-profile") {
    handleCustomerProfile(req, res).catch((error) => {
      console.error("customer-profile: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, { error: "Something went wrong. Please try again." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (requestPath === "/.netlify/functions/customer-wishlist") {
    handleCustomerWishlist(req, res).catch((error) => {
      console.error("customer-wishlist: unexpected failure:", error);
      if (!res.headersSent) {
        sendPrivateApiJson(res, 500, { error: "Something went wrong. Please try again." });
      } else {
        res.end();
      }
    });
    return;
  }

  if (requestPath === "/.netlify/functions/customer-forgot-password") {
    handleCustomerForgotPassword(req, res).catch((error) => {
      console.error("customer-forgot-password: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: FORGOT_PASSWORD_INTERNAL_ERROR });
      } else {
        res.end();
      }
    });
    return;
  }

  if (requestPath === "/.netlify/functions/customer-reset-password") {
    handleCustomerResetPassword(req, res).catch((error) => {
      console.error("customer-reset-password: unexpected failure:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: RESET_PASSWORD_INTERNAL_ERROR });
      } else {
        res.end();
      }
    });
    return;
  }

  if (requestPath === "/") {
    requestPath = "/index.html";
  }

  const filePath = path.join(ROOT, requestPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      res.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType =
      MIME_TYPES[extension] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType
    });

    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Little Oddities server running on port ${PORT}`);
});