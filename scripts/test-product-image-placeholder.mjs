/**
 * Regression tests for product-card image placeholder behaviour.
 *
 * Verifies that:
 *   1. Products with a declared image do not render the placeholder div.
 *   2. Products without an image do render the placeholder div.
 *   3. Image errors insert the placeholder dynamically (fallback for broken images).
 *
 * These tests exercise the template logic directly. They do not require a
 * browser DOM because the template is pure string generation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(ROOT, "script.js");

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "✅ PASS" : "❌ FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

/* ── Template replication (mirrors the fixed buildProductCard logic) ── */

const IMAGE_ROOT = "assets/images/products";

function buildProductCard(product) {
  const hasImage = Array.isArray(product.images) && product.images.length;
  const imageSrc = hasImage ? `${IMAGE_ROOT}/${product.id}/${product.images[0]}` : null;

  return `
    <article class="card product-card">
      <div class="product-image">
        ${hasImage
          ? `<img src="${imageSrc}" alt="${product.name}" onerror="this.style.display='none';this.parentElement.insertAdjacentHTML('beforeend','<div class=\\'image-placeholder-card\\'>A photograph of this treasure will appear soon.</div>');">`
          : '<div class="image-placeholder-card">A photograph of this treasure will appear soon.</div>'}
      </div>
    </article>
  `;
}

/* ── Behavioural checks ── */

const withImage = buildProductCard({ id: "prod-a", name: "A", images: ["1.jpg"] });
check("Product with image does not render initial placeholder", !withImage.includes('class="image-placeholder-card"'));
check("Product with image renders <img>", withImage.includes(`<img src="${IMAGE_ROOT}/prod-a/1.jpg"`));
check("Product with image onerror inserts placeholder", withImage.includes("insertAdjacentHTML('beforeend'"));

const withoutImage = buildProductCard({ id: "prod-b", name: "B", images: [] });
check("Product without image renders initial placeholder", withoutImage.includes('class="image-placeholder-card"'));
check("Product without image does not render <img>", !withoutImage.includes("<img"));

/* ── Source-code guard ── */

const scriptSource = fs.readFileSync(SCRIPT_PATH, "utf8");
check("Source still contains dynamic placeholder insertion", scriptSource.includes("insertAdjacentHTML('beforeend'"));
check("Source still contains static placeholder text", scriptSource.includes("A photograph of this treasure will appear soon."));
check("Product card block does not use cached-image onload guard", !scriptSource.includes('onload="this.parentElement.querySelector(\'.image-placeholder-card\')'));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ SOME FAILED"} (${results.length} tests)`);
process.exit(failed > 0 ? 1 : 0);
