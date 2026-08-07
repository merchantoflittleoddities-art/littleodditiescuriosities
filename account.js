/* =============================================================
   Little Oddities Curiosities — account.js
   Traveller's Keepings client logic.

   Loaded (alongside script.js) only on:
     register.html, signin.html, forgot-password.html,
     reset-password.html, account.html

   Uses the shared session helpers defined in script.js:
     getCustomerToken(), getCustomerInfo(), saveCustomerSession(),
     clearCustomerSession(), updateAccountNavLink()
   ============================================================= */

"use strict";

const REGISTER_URL        = "/.netlify/functions/customer-register";
const LOGIN_URL            = "/.netlify/functions/customer-login";
const FORGOT_PASSWORD_URL  = "/.netlify/functions/customer-forgot-password";
const RESET_PASSWORD_URL   = "/.netlify/functions/customer-reset-password";
const PROFILE_URL          = "/.netlify/functions/customer-profile";
const ADDRESSES_URL        = "/.netlify/functions/customer-addresses";
const WISHLIST_URL         = "/.netlify/functions/customer-wishlist";
const CUSTOMER_ORDERS_URL  = "/.netlify/functions/customer-orders";

/* ── Small helpers ───────────────────────────────────────────── */

function showFieldError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
}

function hideFieldError(el) {
  if (!el) return;
  el.classList.add("hidden");
  el.textContent = "";
}

async function authFetch(url, options = {}) {
  const token = getCustomerToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    clearCustomerSession();
    window.location.href = "signin.html";
    throw new Error("Please sign in again.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
  return data;
}

/* ── register.html ───────────────────────────────────────────── */

function initRegisterForm() {
  const form = document.getElementById("register-form");
  if (!form) return;

  const errorEl = document.getElementById("register-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideFieldError(errorEl);

    const name     = document.getElementById("register-name").value;
    const email    = document.getElementById("register-email").value;
    const password = document.getElementById("register-password").value;
    const remember = document.getElementById("register-remember").checked;

    try {
      const response = await fetch(REGISTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Registration failed.");

      saveCustomerSession(data.token, data.customer, remember);
      window.location.href = "account.html";
    } catch (error) {
      showFieldError(errorEl, error.message);
    }
  });
}

/* ── signin.html ─────────────────────────────────────────────── */

function initSigninForm() {
  const form = document.getElementById("signin-form");
  if (!form) return;

  const errorEl = document.getElementById("signin-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideFieldError(errorEl);

    const email    = document.getElementById("signin-email").value;
    const password = document.getElementById("signin-password").value;
    const remember = document.getElementById("signin-remember").checked;

    try {
      const response = await fetch(LOGIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Sign in failed.");

      saveCustomerSession(data.token, data.customer, remember);
      window.location.href = "account.html";
    } catch (error) {
      showFieldError(errorEl, error.message);
    }
  });
}

/* ── forgot-password.html ────────────────────────────────────── */

function initForgotPasswordForm() {
  const form = document.getElementById("forgot-form");
  if (!form) return;

  const errorEl = document.getElementById("forgot-error");
  const noteEl  = document.getElementById("forgot-note");
  const linkEl  = document.getElementById("forgot-reset-link");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideFieldError(errorEl);
    noteEl.classList.add("hidden");

    const email = document.getElementById("forgot-email").value;

    try {
      const response = await fetch(FORGOT_PASSWORD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");

      if (data.resetUrl) {
        linkEl.href = data.resetUrl;
        noteEl.classList.remove("hidden");
      } else {
        noteEl.classList.remove("hidden");
        linkEl.parentElement.textContent = "If a Traveller is known by that email address, a note has been left for them.";
      }
    } catch (error) {
      showFieldError(errorEl, error.message);
    }
  });
}

/* ── reset-password.html ─────────────────────────────────────── */

function initResetPasswordForm() {
  const form = document.getElementById("reset-form");
  if (!form) return;

  const errorEl = document.getElementById("reset-error");
  const token = new URLSearchParams(window.location.search).get("token");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideFieldError(errorEl);

    if (!token) {
      showFieldError(errorEl, "This reset link is missing its token. Please request a new one.");
      return;
    }

    const password = document.getElementById("reset-password-input").value;

    try {
      const response = await fetch(RESET_PASSWORD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Reset failed.");

      saveCustomerSession(data.token, data.customer, true);
      window.location.href = "account.html";
    } catch (error) {
      showFieldError(errorEl, error.message);
    }
  });
}

/* ── account.html: shell / tabs ──────────────────────────────── */

const STATUS_EMOJI = {
  new: "🔵", preparing: "🟡", packed: "🟠", posted: "🟣", completed: "🟢"
};

function escapeHtmlLocal(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function activateAccountTab(tabName) {
  document.querySelectorAll(".account-nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.accountTab === tabName);
  });
  document.querySelectorAll(".account-tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `account-tab-${tabName}`);
  });
}

async function initAccountHub() {
  const loadingState   = document.getElementById("account-loading-state");
  const signedOutState = document.getElementById("account-signed-out-state");
  const hub            = document.getElementById("account-hub");
  if (!hub) return; /* Not on account.html */

  function showSignedOut() {
    loadingState.classList.add("hidden");
    signedOutState.classList.remove("hidden");
  }

  try {
    const token = getCustomerToken();
    if (!token) {
      showSignedOut();
      return;
    }

    const profile = await authFetch(PROFILE_URL);

    loadingState.classList.add("hidden");
    hub.classList.remove("hidden");
    document.getElementById("account-traveller-name").textContent = profile.customer.name;

    document.getElementById("account-logout-button")?.addEventListener("click", () => {
      clearCustomerSession();
      window.location.href = "index.html";
    });

    document.querySelectorAll(".account-nav-item").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.accountTab;
        activateAccountTab(tab);
        if (tab === "satchel") loadSatchel();
        if (tab === "map") loadMap();
        if (tab === "messages") loadMessages();
        if (tab === "preferences") fillPreferencesForm(profile.customer);
      });
    });

    fillPreferencesForm(profile.customer);
    initPreferencesForm();
    initMapForm();
    loadSatchel();
  } catch (error) {
    showSignedOut();
  }
}

/* ── Traveller's Satchel (Wishlist) ──────────────────────────── */

async function loadSatchel() {
  const container = document.getElementById("satchel-list");
  if (!container) return;
  container.innerHTML = `<p class="muted">Gathering your Satchel...</p>`;

  try {
    const { productIds } = await authFetch(WISHLIST_URL);

    if (!productIds.length) {
      container.innerHTML = `<p class="muted">Your Satchel is empty. Treasures you save while browsing will rest here.</p>`;
      return;
    }

    const products = window.ALL_PRODUCTS || [];
    const items = productIds
      .map((id) => products.find((p) => p.id === id))
      .filter(Boolean);

    if (!items.length) {
      container.innerHTML = `<p class="muted">Your Satchel is empty. Treasures you save while browsing will rest here.</p>`;
      return;
    }

    container.innerHTML = items.map((product) => `
      <article class="card satchel-card" data-product-id="${product.id}">
        <h4>${escapeHtmlLocal(product.name)}</h4>
        <p class="muted">${escapeHtmlLocal(product.collection || "")}</p>
        <p>${typeof formatPrice === "function" ? formatPrice(product.price) : `£${Number(product.price).toFixed(2)}`}</p>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <button class="button button-primary satchel-move-btn" data-product-id="${product.id}" type="button">Move to Basket</button>
          <button class="button button-secondary satchel-remove-btn" data-product-id="${product.id}" type="button">Remove</button>
        </div>
      </article>
    `).join("");

    container.querySelectorAll(".satchel-move-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const productId = btn.dataset.productId;
        if (typeof addToCart === "function") {
          addToCart(productId, 1);
        }
        await authFetch(WISHLIST_URL, { method: "DELETE", body: JSON.stringify({ productId }) });
        loadSatchel();
      });
    });

    container.querySelectorAll(".satchel-remove-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const productId = btn.dataset.productId;
        await authFetch(WISHLIST_URL, { method: "DELETE", body: JSON.stringify({ productId }) });
        loadSatchel();
      });
    });

  } catch (error) {
    container.innerHTML = `<p class="muted">${escapeHtmlLocal(error.message)}</p>`;
  }
}

/* ── Traveller's Map (Addresses) ─────────────────────────────── */

function renderMapList(addresses) {
  const container = document.getElementById("map-list");
  if (!container) return;

  if (!addresses.length) {
    container.innerHTML = `<p class="muted">You have not yet marked any Landmarks on your Map.</p>`;
    return;
  }

  container.innerHTML = addresses.map((addr) => `
    <article class="card map-card" data-address-id="${addr.id}">
      <h4>${escapeHtmlLocal(addr.label)} ${addr.isDefault ? "✦" : ""}</h4>
      <p>${escapeHtmlLocal(addr.line1)}</p>
      ${addr.line2 ? `<p>${escapeHtmlLocal(addr.line2)}</p>` : ""}
      <p>${escapeHtmlLocal(addr.city)}${addr.region ? `, ${escapeHtmlLocal(addr.region)}` : ""}</p>
      <p>${escapeHtmlLocal(addr.postcode)}, ${escapeHtmlLocal(addr.country)}</p>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.75rem;">
        <button class="button button-secondary map-edit-btn" data-address-id="${addr.id}" type="button">Edit</button>
        <button class="button button-secondary map-delete-btn" data-address-id="${addr.id}" type="button">Delete</button>
      </div>
    </article>
  `).join("");

  container.querySelectorAll(".map-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const addr = addresses.find((a) => a.id === btn.dataset.addressId);
      if (addr) openMapForm(addr);
    });
  });

  container.querySelectorAll(".map-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await authFetch(ADDRESSES_URL, { method: "DELETE", body: JSON.stringify({ id: btn.dataset.addressId }) });
      loadMap();
    });
  });
}

async function loadMap() {
  const container = document.getElementById("map-list");
  if (!container) return;
  container.innerHTML = `<p class="muted">Consulting your Map...</p>`;

  try {
    const { addresses } = await authFetch(ADDRESSES_URL);
    renderMapList(addresses);
  } catch (error) {
    container.innerHTML = `<p class="muted">${escapeHtmlLocal(error.message)}</p>`;
  }
}

function openMapForm(address = null) {
  const card  = document.getElementById("map-form-card");
  const title = document.getElementById("map-form-title");
  if (!card) return;

  document.getElementById("map-id").value      = address?.id || "";
  document.getElementById("map-label").value   = address?.label || "";
  document.getElementById("map-line1").value   = address?.line1 || "";
  document.getElementById("map-line2").value   = address?.line2 || "";
  document.getElementById("map-city").value    = address?.city || "";
  document.getElementById("map-region").value  = address?.region || "";
  document.getElementById("map-postcode").value = address?.postcode || "";
  document.getElementById("map-country").value = address?.country || "";
  document.getElementById("map-default").checked = Boolean(address?.isDefault);

  title.textContent = address ? "Edit Landmark" : "Add a Landmark";
  card.classList.remove("hidden");
}

function closeMapForm() {
  document.getElementById("map-form-card")?.classList.add("hidden");
}

function initMapForm() {
  document.getElementById("map-add-button")?.addEventListener("click", () => openMapForm());
  document.getElementById("map-cancel-button")?.addEventListener("click", closeMapForm);

  const form = document.getElementById("map-form");
  if (!form) return;
  const errorEl = document.getElementById("map-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideFieldError(errorEl);

    const id = document.getElementById("map-id").value || undefined;
    const address = {
      label:    document.getElementById("map-label").value,
      line1:    document.getElementById("map-line1").value,
      line2:    document.getElementById("map-line2").value,
      city:     document.getElementById("map-city").value,
      region:   document.getElementById("map-region").value,
      postcode: document.getElementById("map-postcode").value,
      country:  document.getElementById("map-country").value,
      isDefault: document.getElementById("map-default").checked
    };

    try {
      await authFetch(ADDRESSES_URL, { method: "POST", body: JSON.stringify({ id, address }) });
      closeMapForm();
      loadMap();
    } catch (error) {
      showFieldError(errorEl, error.message);
    }
  });
}

/* ── Merchant's Messages (Orders) ────────────────────────────── */

async function loadMessages() {
  const container = document.getElementById("messages-list");
  if (!container) return;
  container.innerHTML = `<p class="muted">Listening for word from the Merchant...</p>`;

  try {
    const { messages } = await authFetch(CUSTOMER_ORDERS_URL);

    if (!messages.length) {
      container.innerHTML = `<p class="muted">No word yet. Once you claim a treasure, the Merchant's updates will appear here.</p>`;
      return;
    }

    container.innerHTML = messages.map((msg) => {
      const itemsSummary = msg.items.map((i) => `${escapeHtmlLocal(i.name)} ×${i.quantity}`).join(", ");
      const date = new Date(msg.created).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

      return `
        <article class="card message-card">
          <header class="message-card-header">
            <span class="order-badge">#${msg.shortId}</span>
            <span class="message-date">${date}</span>
          </header>
          <p class="message-items">${itemsSummary}</p>
          <p class="message-status">${STATUS_EMOJI[msg.status] || "🔵"} ${escapeHtmlLocal(msg.statusText)}</p>
        </article>
      `;
    }).join("");

  } catch (error) {
    container.innerHTML = `<p class="muted">${escapeHtmlLocal(error.message)}</p>`;
  }
}

/* ── Traveller's Preferences (Profile) ───────────────────────── */

function fillPreferencesForm(customer) {
  const nameEl  = document.getElementById("preferences-name");
  const emailEl = document.getElementById("preferences-email");
  const notifyEl = document.getElementById("preferences-notifications");
  if (!nameEl) return;

  nameEl.value  = customer.name;
  emailEl.value = customer.email;
  notifyEl.checked = customer.notificationPrefs?.orderUpdates !== false;
}

function initPreferencesForm() {
  const form = document.getElementById("preferences-form");
  if (!form) return;

  const errorEl   = document.getElementById("preferences-error");
  const successEl = document.getElementById("preferences-success");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideFieldError(errorEl);
    successEl.classList.add("hidden");

    const name     = document.getElementById("preferences-name").value;
    const email    = document.getElementById("preferences-email").value;
    const password = document.getElementById("preferences-password").value;
    const orderUpdates = document.getElementById("preferences-notifications").checked;

    const body = { name, email, notificationPrefs: { orderUpdates } };
    if (password) body.password = password;

    try {
      const { customer } = await authFetch(PROFILE_URL, { method: "POST", body: JSON.stringify(body) });

      /* Refresh the stored session's customer info (name/email may have changed) */
      const remember = Boolean(window.localStorage.getItem(CUSTOMER_TOKEN_KEY));
      saveCustomerSession(getCustomerToken(), customer, remember);

      document.getElementById("account-traveller-name").textContent = customer.name;
      document.getElementById("preferences-password").value = "";
      successEl.textContent = "Your Preferences have been saved.";
      successEl.classList.remove("hidden");
      updateAccountNavLink();
    } catch (error) {
      showFieldError(errorEl, error.message);
    }
  });
}

/* ── Entry point ─────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
  initRegisterForm();
  initSigninForm();
  initForgotPasswordForm();
  initResetPasswordForm();
  initAccountHub();
});
