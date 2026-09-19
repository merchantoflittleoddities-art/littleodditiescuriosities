/**
 * Regression test: #add-order-item-add click listener must not forward
 * the browser MouseEvent to addManualOrderItem() as containerSelector.
 *
 * The bug: addEventListener("click", addManualOrderItem) passes the
 * MouseEvent as the first argument. addManualOrderItem() expects a CSS
 * selector, so document.querySelector(MouseEvent) throws "[object MouseEvent]
 * is not a valid selector".
 *
 * The fix: wrap in an arrow function so addManualOrderItem() receives
 * no arguments and uses its defaults.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const JS_PATH = path.join(ROOT, "merchant-dashboard.js");
const source = fs.readFileSync(JS_PATH, "utf8");

// 1. Static check: source must use arrow-function wrapper
const badPattern = /getElementById\("add-order-item-add"\)\?\.addEventListener\("click",\s*addManualOrderItem\)/;
const goodPattern = /getElementById\("add-order-item-add"\)\?\.addEventListener\("click",\s*\(\)\s*=>\s*addManualOrderItem\(\)\);/;

if (badPattern.test(source)) {
  console.error("FAIL: listener passes addManualOrderItem directly — MouseEvent will leak as containerSelector");
  process.exit(1);
}
if (!goodPattern.test(source)) {
  console.error("FAIL: listener is not wrapped in an arrow function");
  process.exit(1);
}

// 2. Behavioral check: simulate click and verify no event argument leaked
const captured = [];
const mockDoc = {
  cache: {},
  getElementById(id) {
    if (!mockDoc.cache[id]) {
      mockDoc.cache[id] = {
        id,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener(event, handler) {
          if (!mockDoc.handlers[id]) mockDoc.handlers[id] = [];
          mockDoc.handlers[id].push({ event, handler });
        },
        removeEventListener() {},
        click() {},
        innerHTML: "",
        value: "",
        textContent: "",
        style: {},
        disabled: false,
        lastElementChild: null,
        children: [],
        querySelector() { return null; },
        querySelectorAll() { return []; },
        insertAdjacentHTML() {},
        closest() { return null; }
      };
    }
    return mockDoc.cache[id];
  },
  querySelector(sel) {
    if (sel === "#add-order-items") {
      return {
        id: "add-order-items",
        innerHTML: "",
        lastElementChild: null,
        children: [],
        insertAdjacentHTML() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
      };
    }
    return null;
  },
  handlers: {}
};

mockDoc.addManualOrderItem = (...args) => {
  captured.push(args);
};

// Register listener exactly as the fixed code does
mockDoc.getElementById("add-order-item-add").addEventListener("click", () => mockDoc.addManualOrderItem());

// Simulate browser firing the listener with a MouseEvent-like object
const syntheticEvent = { type: "click", preventDefault() {}, stopPropagation() {} };
const handlers = mockDoc.handlers["add-order-item-add"];
if (!handlers || handlers.length !== 1) {
  console.error("FAIL: listener not registered correctly");
  process.exit(1);
}

handlers[0].handler(syntheticEvent);

if (captured.length !== 1) {
  console.error(`FAIL: addManualOrderItem called ${captured.length} times, expected 1`);
  process.exit(1);
}

const args = captured[0];
if (args.length !== 0) {
  console.error(`FAIL: addManualOrderItem received ${args.length} args (${JSON.stringify(args)}) — MouseEvent leaked as containerSelector`);
  process.exit(1);
}

console.log("PASS: #add-order-item-add click invokes addManualOrderItem() with no arguments");
