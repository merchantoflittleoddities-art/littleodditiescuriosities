/* =============================================================
   Little Oddities Curiosities — Netlify Function
   get-featured-treasure.js

   Public endpoint — no authentication required.
   Returns the current Featured Treasure configuration and features list.

   Stored in Netlify Blobs under store "featured-treasure", key "data".
   Falls back to data/featured-treasure.json if Blobs is empty.
   ============================================================= */

const { connectLambda, getStore } = require("@netlify/blobs");
const fs   = require("fs");
const path = require("path");

exports.handler = async function (event) {
  try {
    connectLambda(event);

    const store = getStore("featured-treasure");
    const raw   = await store.get("data", { type: "text" });

    let featuredData = null;
    if (raw) {
      try {
        featuredData = JSON.parse(raw);
      } catch (e) {
        console.error("Failed to parse Blobs featured-treasure data:", e);
      }
    }

    /* Fallback to local JSON if not in Blobs */
    if (!featuredData) {
      const filePath = path.join(__dirname, "../../data/featured-treasure.json");
      if (fs.existsSync(filePath)) {
        featuredData = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } else {
        featuredData = { title: "✨ Featured Treasure", intro: "", closingNote: "", settings: { showWhenOutOfStock: true }, features: [] };
      }
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type":                "application/json",
        "Cache-Control":               "no-store",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(featuredData)
    };

  } catch (error) {
    console.error("get-featured-treasure error:", error.message);
    /* Fallback to file on error */
    try {
      const filePath = path.join(__dirname, "../../data/featured-treasure.json");
      const fallback = fs.readFileSync(filePath, "utf8");
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: fallback
      };
    } catch {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Could not read Featured Treasure data." })
      };
    }
  }
};
