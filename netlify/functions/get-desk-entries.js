/* =============================================================
   Little Oddities Curiosities — Netlify Function
   get-desk-entries.js

   Public endpoint — no authentication required.
   Returns the current Merchant's Journal / From the Merchant's Desk data.

   Stored in Netlify Blobs under store "desk-entries", key "data".
   Falls back to data/desk-entries.json if Blobs is empty.
   ============================================================= */

const { connectLambda, getStore } = require("@netlify/blobs");
const fs   = require("fs");
const path = require("path");

exports.handler = async function (event) {
  try {
    connectLambda(event);

    const store = getStore("desk-entries");
    const raw   = await store.get("data", { type: "text" });

    let deskData = null;
    if (raw) {
      try {
        deskData = JSON.parse(raw);
      } catch (e) {
        console.error("Failed to parse Blobs desk-entries data:", e);
      }
    }

    if (!deskData) {
      const filePath = path.join(__dirname, "../../data/desk-entries.json");
      if (fs.existsSync(filePath)) {
        deskData = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } else {
        deskData = { title: "🕯️ From the Merchant's Desk", subtitle: "", closingNote: "", settings: { homepageLimit: 3 }, entries: [] };
      }
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type":                "application/json",
        "Cache-Control":               "no-store",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(deskData)
    };

  } catch (error) {
    console.error("get-desk-entries error:", error.message);
    try {
      const filePath = path.join(__dirname, "../../data/desk-entries.json");
      const fallback = fs.readFileSync(filePath, "utf8");
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: fallback
      };
    } catch {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Could not read desk entries data." })
      };
    }
  }
};
