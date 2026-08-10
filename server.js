const http = require("http");
const fs = require("fs");
const path = require("path");
const pool = require("./db");
const crypto = require("crypto");
const {
  hashPassword,
  createToken,
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
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