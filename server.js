const http = require("http");
const fs = require("fs");
const path = require("path");
const pool = require("./db");

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

const server = http.createServer((req, res) => {

  if (req.url === "/db-test") {
    pool.query("SELECT NOW() AS current_time")
      .then((result) => {
        res.writeHead(200, {
          "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
          ok: true,
          databaseTime: result.rows[0].current_time
        }));
      })
      .catch((error) => {
        console.error("Database test failed:", error);

        res.writeHead(500, {
          "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
          ok: false,
          error: error.message
        }));
      });

    return;
  }

  let requestPath = decodeURIComponent(req.url.split("?")[0]);
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