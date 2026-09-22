/**
 * Regression tests for the five new bracelet catalogue entries:
 *   starlit-spores, poison, petal-and-potion,
 *   rose-and-ritual, woodlands-wonderland.
 *
 * Verifies that:
 *   1. catalogue.json stays valid and every entry keeps the schema
 *      fields the site and Merchant Dashboard rely on.
 *   2. The five new product IDs are unique, slug-style and do not
 *      collide with existing products.
 *   3. Tier assignments follow the launch rules (three tiered, two
 *      deliberately untiered with no invented price).
 *   4. Materials explicitly name the required cord, beads, charms
 *      and spacers for each product (including the single red bead
 *      on Poison and the 8 identical mushroom charms).
 *   5. Rose & Ritual carries no charm and no spacer beads.
 *   6. Image folders exist for all five products and contain NO
 *      placeholder/fake image files.
 *   7. The Merchant Dashboard catalogue pathway (fetchProductCatalogue)
 *      surfaces all five products, including for manual IRL orders,
 *      and every existing collection value is a known collection.
 *   8. Untiered products resolve sanely through the dashboard/server
 *      price pathway (no tier price -> falls back to product price;
 *      absent here, they are simply excluded from online checkout).
 *
 * Usage: node scripts/test-new-bracelet-catalogue.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOGUE_PATH = path.join(ROOT, "data", "catalogue.json");
const TIERS_PATH = path.join(ROOT, "data", "tiers.json");
const COLLECTIONS_PATH = path.join(ROOT, "data", "collections.json");
const IMAGE_ROOT = path.join(ROOT, "assets", "images", "products");

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "✅ PASS" : "❌ FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

/* ── Load the data files (also proves they parse as JSON) ──── */

const catalogue = JSON.parse(fs.readFileSync(CATALOGUE_PATH, "utf8"));
const tiersData = JSON.parse(fs.readFileSync(TIERS_PATH, "utf8"));
const collectionsData = JSON.parse(fs.readFileSync(COLLECTIONS_PATH, "utf8"));

const products = catalogue.products;
const tierNames = tiersData.tiers.map((t) => t.name);
const collectionNames = collectionsData.collections.map((c) => c.name);

check("catalogue.json parses with a products array", Array.isArray(products));
check("tiers.json parses with a tiers array", Array.isArray(tiersData.tiers));
check("collections.json parses with a collections array", Array.isArray(collectionsData.collections));

/* ── 1. The five new products exist with the exact names ───── */

const NEW_PRODUCTS = [
  { id: "starlit-spores",         name: "Starlit Spores" },
  { id: "poison",                 name: "Poison" },
  { id: "petal-and-potion",       name: "Petal & Potion" },
  { id: "rose-and-ritual",        name: "Rose & Ritual" },
  { id: "woodlands-wonderland",   name: "Woodlands Wonderland" }
];

for (const expected of NEW_PRODUCTS) {
  const product = products.find((p) => p.id === expected.id);
  check(`product exists: ${expected.id}`, Boolean(product));
  if (product) {
    check(`name is exact for ${expected.id}`, product.name === expected.name, product.name);
  }
}

/* ── 2. Unique, stable, URL-safe IDs across the whole catalogue ── */

const allIds = products.map((p) => p.id);
const uniqueIds = new Set(allIds);
check("all catalogue product IDs are unique", uniqueIds.size === allIds.length,
  `${allIds.length} products, ${uniqueIds.size} unique`);
check("all catalogue product IDs are lowercase kebab-slug (URL/filesystem safe)",
  allIds.every((id) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)),
  allIds.filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)).join(", ") || "all match");

/* ── 3. Schema completeness on every new product ───────────── */

const REQUIRED_FIELDS = ["id", "name", "collection", "description", "lore", "materials", "images", "available"];
for (const { id } of NEW_PRODUCTS) {
  const product = products.find((p) => p.id === id);
  if (!product) continue;
  const missing = REQUIRED_FIELDS.filter((field) => !(field in product));
  check(`${id} carries every required catalogue field`, missing.length === 0, missing.join(", ") || "all present");
  check(`${id} has a non-empty description`, typeof product.description === "string" && product.description.trim().length > 0);
  check(`${id} has a non-empty lore (story behind the treasure)`, typeof product.lore === "string" && product.lore.trim().length > 0);
  check(`${id} materials is a non-empty array of strings`,
    Array.isArray(product.materials) && product.materials.length > 0 && product.materials.every((m) => typeof m === "string"));
  check(`${id} is available`, product.available === true);
  check(`${id} declares no image files yet (real photography to follow, no placeholders)`,
    Array.isArray(product.images) && product.images.length === 0);
}

/* ── 4. Tier assignment rules ──────────────────────────────── */

const starlit = products.find((p) => p.id === "starlit-spores");
const poison = products.find((p) => p.id === "poison");
const petal = products.find((p) => p.id === "petal-and-potion");
const rose = products.find((p) => p.id === "rose-and-ritual");
const woodlands = products.find((p) => p.id === "woodlands-wonderland");

check("Starlit Spores is tiered Hidden Artifacts", starlit?.tier === "Hidden Artifacts", starlit?.tier);
check("Starlit Spores price is 6.5 (Hidden Artifacts tier price)", starlit?.price === 6.5, String(starlit?.price));
check("Starlit Spores packaging is Special Packaging (Hidden Artifacts)", starlit?.packaging === "Special Packaging", starlit?.packaging);

check("Poison is tiered Forgotten Treasures", poison?.tier === "Forgotten Treasures", poison?.tier);
check("Poison price is 5.5 (Forgotten Treasures tier price)", poison?.price === 5.5, String(poison?.price));

check("Petal & Potion is tiered Forgotten Treasures", petal?.tier === "Forgotten Treasures", petal?.tier);
check("Petal & Potion price is 5.5 (Forgotten Treasures tier price)", petal?.price === 5.5, String(petal?.price));

check("Rose & Ritual has NO tier assignment yet", !("tier" in rose) || rose.tier == null || rose.tier === "",
  JSON.stringify(rose?.tier));
check("Rose & Ritual has NO invented price", !("price" in rose) || rose.price == null, JSON.stringify(rose?.price));

check("Woodlands Wonderland has NO tier assignment yet", !("tier" in woodlands) || woodlands.tier == null || woodlands.tier === "",
  JSON.stringify(woodlands?.tier));
check("Woodlands Wonderland has NO invented price", !("price" in woodlands) || woodlands.price == null, JSON.stringify(woodlands?.price));

check("every tier referenced by any product is a defined tier in tiers.json",
  products.filter((p) => p.tier).every((p) => tierNames.includes(p.tier)),
  products.filter((p) => p.tier && !tierNames.includes(p.tier)).map((p) => `${p.id}→${p.tier}`).join(", ") || "all valid");

/* ── 5. Materials content requirements ─────────────────────── */

function materialsInclude(product, substring) {
  if (!product || !Array.isArray(product.materials)) return false;
  return product.materials.some((m) => m.toLowerCase().includes(substring.toLowerCase()));
}

/* Starlit Spores */
check("Starlit Spores materials include nylon cord", materialsInclude(starlit, "nylon cord"));
check("Starlit Spores materials include medium purple beads", materialsInclude(starlit, "medium purple beads"));
check("Starlit Spores materials include peachy/pink beads", materialsInclude(starlit, "peachy/pink beads"));
check("Starlit Spores materials include pink star charm", materialsInclude(starlit, "pink star charm"));
check("Starlit Spores materials include green mushroom charm", materialsInclude(starlit, "green mushroom charm"));
check("Starlit Spores materials include spacer beads", materialsInclude(starlit, "spacer beads"));

/* Poison — single red bead must be represented without claiming red beads overall */
check("Poison materials include nylon cord", materialsInclude(poison, "nylon cord"));
check("Poison materials include pink beads", materialsInclude(poison, "pink beads"));
check("Poison materials include white beads", materialsInclude(poison, "white beads"));
check("Poison materials include the single red bead", materialsInclude(poison, "single red bead"));
check("Poison does NOT claim a general 'red beads' primary colour", !materialsInclude(poison, "red beads"));
check("Poison materials include red melting heart charm", materialsInclude(poison, "red melting heart charm"));
check("Poison materials include spacer beads", materialsInclude(poison, "spacer beads"));

/* Petal & Potion */
check("Petal & Potion materials include nylon cord", materialsInclude(petal, "nylon cord"));
check("Petal & Potion materials include green beads", materialsInclude(petal, "green beads"));
check("Petal & Potion materials include pink beads", materialsInclude(petal, "pink beads"));
check("Petal & Potion materials include the large hollow heart charm (half pink, half wood-coloured)",
  materialsInclude(petal, "large hollow heart charm (half pink, half wood-coloured)"));
check("Petal & Potion materials include spacer beads", materialsInclude(petal, "spacer beads"));

/* Rose & Ritual — no charm, no spacers */
check("Rose & Ritual materials include nylon cord", materialsInclude(rose, "nylon cord"));
check("Rose & Ritual materials include red beads", materialsInclude(rose, "red beads"));
check("Rose & Ritual materials include pink beads", materialsInclude(rose, "pink beads"));
check("Rose & Ritual materials include black beads", materialsInclude(rose, "black beads"));
check("Rose & Ritual materials contain NO charm entry", !materialsInclude(rose, "charm"));
check("Rose & Ritual materials contain NO spacer beads", !materialsInclude(rose, "spacer"));

/* Woodlands Wonderland — exactly 8 identical mushroom charms */
check("Woodlands Wonderland materials include nylon cord", materialsInclude(woodlands, "nylon cord"));
check("Woodlands Wonderland materials include green beads", materialsInclude(woodlands, "green beads"));
check("Woodlands Wonderland materials include peach/pink beads", materialsInclude(woodlands, "peach/pink beads"));
check("Woodlands Wonderland materials preserve the count: 8 identical mushroom charms",
  materialsInclude(woodlands, "8 identical mushroom charms"));
check("Woodlands Wonderland does not reduce the charms to a bare 'mushroom charm'",
  !materialsInclude(woodlands, "mushroom charm") || materialsInclude(woodlands, "8 identical mushroom charms"));
check("Woodlands Wonderland materials include spacer beads", materialsInclude(woodlands, "spacer beads"));

/* ── 6. Image folders exist and contain no placeholder files ── */

/* The launch brief created these folders without photography. If photo
   files appear in a folder (e.g. supplied by the merchant afterwards),
   they must be genuine photographs — never tiny fabricated/fake files.
   Existing product photography on this site is comfortably above 100 KB
   and real JPEG data, so anything below these bounds is a placeholder. */
const MIN_GENUINE_PHOTO_BYTES = 50 * 1024;
function isGenuineJpeg(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < MIN_GENUINE_PHOTO_BYTES) return false;
    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(2);
    fs.readSync(fd, header, 0, 2, 0);
    fs.closeSync(fd);
    return header[0] === 0xff && header[1] === 0xd8; /* JPEG SOI marker */
  } catch {
    return false;
  }
}

for (const { id } of NEW_PRODUCTS) {
  const folder = path.join(IMAGE_ROOT, id);
  check(`image folder exists: assets/images/products/${id}/`, fs.existsSync(folder) && fs.statSync(folder).isDirectory());
  const files = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  const suspicious = files.filter((file) => !isGenuineJpeg(path.join(folder, file)));
  check(`image folder ${id}/ contains no placeholder/fake image files`,
    suspicious.length === 0,
    files.length ? `${files.length} photo file(s), all genuine JPEGs` : "empty — ready for photography");
}

/* ── 7. Merchant Dashboard catalogue pathway ───────────────── */

/* Mirrors fetchProductCatalogue() in merchant-dashboard.js:
   `allProducts = Array.isArray(data) ? data : (data.products || [])` */
const dashboardAllProducts = Array.isArray(catalogue) ? catalogue : (catalogue.products || []);
for (const { id } of NEW_PRODUCTS) {
  check(`Merchant Dashboard catalogue pathway surfaces ${id}`, dashboardAllProducts.some((p) => p.id === id));
}

/* Mirrors manualOrderItemRowHtml(): one <option> per catalogue product,
   with data-price from the product price and the name as the label. */
function manualOrderOptionsHtml(allProducts) {
  return allProducts
    .map((p) => `<option value="${p.id}" data-price="${Number(p.price) || 0}">${p.name}${p.price ? ` — £${Number(p.price).toFixed(2)}` : ""}</option>`)
    .join("");
}
const optionsHtml = manualOrderOptionsHtml(dashboardAllProducts);
for (const { id, name } of NEW_PRODUCTS) {
  check(`manual IRL order selector includes ${id}`, optionsHtml.includes(`value="${id}"`));
  check(`manual IRL order selector labels ${id} with its exact name`, optionsHtml.includes(`>${name}`));
}
check("manual IRL order selector shows tier price for Starlit Spores (— £6.50)",
  optionsHtml.includes(`value="starlit-spores" data-price="6.5">Starlit Spores — £6.50`));
check("manual IRL order selector shows tier price for Poison (— £5.50)",
  optionsHtml.includes(`value="poison" data-price="5.5">Poison — £5.50`));
check("manual IRL order selector shows tier price for Petal & Potion (— £5.50)",
  optionsHtml.includes(`value="petal-and-potion" data-price="5.5">Petal & Potion — £5.50`));
check("untiered Rose & Ritual contributes no false price to the selector",
  optionsHtml.includes(`value="rose-and-ritual" data-price="0">Rose & Ritual</option>`));
check("untiered Woodlands Wonderland contributes no false price to the selector",
  optionsHtml.includes(`value="woodlands-wonderland" data-price="0">Woodlands Wonderland</option>`));

/* Dashboard inventory table joins catalogue products to inventory by ID
   (resolveStockStatus falls back to "unlimited" when no entry exists). */
for (const { id } of NEW_PRODUCTS) {
  const product = dashboardAllProducts.find((p) => p.id === id);
  check(`inventory table can render a row for ${id} (name + collection present)`,
    Boolean(product) && typeof product.name === "string" && typeof product.collection === "string");
}

/* Every product collection must match a defined collection so the
   shop/collections filters keep working for the new products. */
for (const { id } of NEW_PRODUCTS) {
  const product = products.find((p) => p.id === id);
  check(`${id} collection "${product?.collection}" is a defined collection`, collectionNames.includes(product?.collection));
}

/* ── 8. Untiered pricing pathway sanity (server/dashboard parity) ── */

/* Mirrors getProductPrice() in server.js and getProductPrice() in
   script.js: a tier price wins; otherwise the product's own price
   applies; otherwise there is no price. */
function serverGetProductPrice(product, tiers) {
  const tierKey = product && product.tier ? String(product.tier).trim() : "";
  const tierMeta = tiers.find((t) => t.id === tierKey || t.name === tierKey);
  const tierPrice = tierMeta ? Number(tierMeta.price) : null;
  if (tierPrice !== null && Number.isFinite(tierPrice)) return tierPrice;
  const productPrice = product ? Number(product.price) : null;
  return Number.isFinite(productPrice) ? productPrice : null;
}

check("server/dashboard price pathway resolves Starlit Spores via its tier (6.5)",
  serverGetProductPrice(starlit, tiersData.tiers) === 6.5);
check("server/dashboard price pathway resolves Poison via its tier (5.5)",
  serverGetProductPrice(poison, tiersData.tiers) === 5.5);
check("server/dashboard price pathway resolves Petal & Potion via its tier (5.5)",
  serverGetProductPrice(petal, tiersData.tiers) === 5.5);
check("Rose & Ritual has no resolvable price yet (kept out of online checkout until tiered)",
  serverGetProductPrice(rose, tiersData.tiers) === null);
check("Woodlands Wonderland has no resolvable price yet (kept out of online checkout until tiered)",
  serverGetProductPrice(woodlands, tiersData.tiers) === null);

/* The dashboard's own fallback (Number(p.price) || 0) must stay 0 for
   untiered products, never NaN/undefined. */
check("untiered products render a £0.00-neutral price attribute in the dashboard",
  [rose, woodlands].every((p) => (Number(p.price) || 0) === 0));

/* ── Result summary ────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ SOME FAILED"} (${results.length} tests)`);
process.exit(failed > 0 ? 1 : 0);
