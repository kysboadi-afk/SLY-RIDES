// cars.js — Dynamic fleet page
// Fetches active vehicles from /api/v2-vehicles and live pricing from
// /api/public-pricing, then renders car cards so the admin can add,
// remove, or update vehicles in the admin portal without touching code.

const API_BASE = (
  window.location.hostname === "slycarrentals.com" ||
  window.location.hostname === "www.slycarrentals.com"
) ? "" : "https://slycarrentals.com";
// Timezone helpers are provided by la-date.js (loaded before this script).
const SlyLA = window.SlyLA;
const VEHICLE_IMAGE_PLACEHOLDER = "/images/logo.jpg";

// Mark the session as car context so shared pages (manage-booking, contact)
// can apply car branding when the user navigates there from this page.
try { sessionStorage.setItem('slyCategory', 'car'); } catch (_) {}

// ─── Fleet-status API contract ────────────────────────────────────────────────
// Canonical fields returned per vehicle by api/fleet-status.js.
// If this list drifts from the actual API response, loadFleetStatus() will
// log a console.error immediately so the mismatch is caught during development.
const FLEET_STATUS_EXPECTED_KEYS = ["available", "rental_status", "available_at", "next_available_display"];

function validateFleetStatusShape(fleetStatus) {
  const entries = Object.values(fleetStatus);
  if (!entries.length) return;
  const first = entries[0];
  const missing = FLEET_STATUS_EXPECTED_KEYS.filter(k => !(k in first));
  if (missing.length) {
    console.error(
      "[fleet-status] API response is missing expected fields:", missing,
      "— verify api/fleet-status.js response shape matches FLEET_STATUS_EXPECTED_KEYS in cars.js"
    );
  }
}

// ─── i18n helper ─────────────────────────────────────────────────────────────
function t(key, fallback) {
  try {
    return (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t(key) : (fallback || key);
  } catch (_) { return fallback || key; }
}

// ─── Safe HTML escaping ───────────────────────────────────────────────────────
function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtMoney(n) {
  if (n == null || n === "") return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return "$" + num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function normalizeVehicleImageUrl(value) {
  if (!value || typeof value !== "string") return "";
  const url = String(value).trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url) || url.startsWith("/")) return url;
  return "/" + url.replace(/^(\.\.\/)+/, "");
}

function isRemovedSlingshotVehicle(v) {
  const vehicleId = String(v?.vehicle_id || v?.id || "").toLowerCase();
  const vehicleName = String(v?.vehicle_name || v?.name || "").toLowerCase();
  return vehicleId.includes("slingshot") || vehicleName.includes("slingshot");
}

// ─── Card builders ────────────────────────────────────────────────────────────

function buildEconomyCard(v, pricing) {
  const vid      = esc(v.vehicle_id);
  const name     = esc(v.vehicle_name || v.vehicle_id);
  const resolvedImage = normalizeVehicleImageUrl(v.cover_image) || VEHICLE_IMAGE_PLACEHOLDER;
  const img      = esc(resolvedImage);
  const subtitle = esc(v.subtitle || t("fleet.sedan5seater", "Sedan • 5 Seater"));
  const scarcity = v.scarcity_text ? `<p class="scarcity-notice">${esc(v.scarcity_text)}</p>` : "";

  // Per-vehicle pricing takes priority over global economy pricing so that
  // vehicles with custom rates (e.g. fusion2017) display correctly.
  // Falls back to the global economy rate, then hard-coded defaults.
  const daily    = fmtMoney(v.daily_price    ?? v.pricePerDay  ?? pricing?.economy?.daily    ?? 55);
  const weekly   = fmtMoney(v.weekly_price   ?? v.weekly       ?? pricing?.economy?.weekly   ?? 350);
  const biweekly = fmtMoney(v.biweekly_price ?? v.biweekly     ?? pricing?.economy?.biweekly ?? 650);
  const monthly  = fmtMoney(v.monthly_price  ?? v.monthly      ?? pricing?.economy?.monthly  ?? 1300);

  return `<div class="car-card" data-category="economy" data-vehicle="${vid}">
    <img src="${img}" alt="${name}" loading="lazy" data-vehicle-image-id="${vid}">
    <div class="car-info">
      <span class="status-badge available" id="status-badge-${vid}" data-i18n="fleet.available">● ${t("fleet.available", "Available")}</span>
      <h3>${name}</h3>
      <p class="car-subtitle" data-i18n="fleet.sedan5seater">${subtitle}</p>
      <div class="rideshare-badges">
        <span class="rideshare-badge" data-i18n="fleet.rideshareReadyBadge">${t("fleet.rideshareReadyBadge", "🚗 Approved for Rideshare &amp; Delivery")}</span>
      </div>
      <p class="car-platform-copy">Gig Platform Approved</p>
      <p class="price-list-label" data-i18n="fleet.rentalPlans">${t("fleet.rentalPlans", "Rental Plans")}</p>
      <div class="car-price-highlight">
        <span class="car-price-main">${weekly}</span>
        <span class="car-price-unit">/ <span data-i18n="fleet.unitWeek">${t("fleet.unitWeek", "week")}</span></span>
      </div>
      <p class="car-plan-note">${daily}/<span data-i18n="fleet.unitDay">${t("fleet.unitDay", "day")}</span> • ${biweekly}/<span data-i18n="fleet.unitBiweek">${t("fleet.unitBiweek", "2 weeks")}</span> • ${monthly}/<span data-i18n="fleet.unitMonth">${t("fleet.unitMonth", "month")}</span></p>
      <ul class="car-feature-list">
        <li>✔ Unlimited Miles</li>
        <li>✔ Insurance Included</li>
        <li>✔ Flexible Rentals</li>
      </ul>
      ${scarcity}
      <a href="car.html?vehicle=${vid}" class="select-link" id="select-link-${vid}">
        <button class="select-btn" id="select-btn-${vid}" data-i18n="fleet.bookNow">${t("fleet.bookNow", "Book Now")}</button>
      </a>
    </div>
  </div>`;
}


function buildCardHTML(v, pricing) {
  return buildEconomyCard(v, pricing);
}

// ─── Loading / empty states ───────────────────────────────────────────────────
function showLoadingState(grid) {
  grid.innerHTML = `<div class="fleet-loading">
    <span class="fleet-loading-spinner" aria-hidden="true"></span>
    <span>${t("fleet.loading", "Loading vehicles…")}</span>
  </div>`;
}

function renderFleetEmptyState(grid, vehicles, fleetStatus) {
  const preferredVehicleOptions = [
    `<option value="">Any available vehicle</option>`,
    ...(Array.isArray(vehicles) ? vehicles : [])
      .filter((v) => String(v.status || "active") === "active" && String(v.category || "").toLowerCase() === "car" && !isRemovedSlingshotVehicle(v))
      .map((v) => `<option value="${esc(v.vehicle_id)}">${esc(v.vehicle_name || v.vehicle_id)}</option>`),
  ].join("");
  grid.innerHTML = `<div class="fleet-empty-state">
    <article class="fleet-empty-card" aria-live="polite">
      <p class="fleet-empty-eyebrow">Premium Fleet Update</p>
      <h3>🚘 All Vehicles Currently Reserved</h3>
      <p class="fleet-empty-subtext">Our rideshare fleet is currently fully booked. Vehicles become available frequently as rentals end or new inventory is added.</p>
      <ul class="fleet-empty-points">
        <li>Most vehicles stay rented 2–6 weeks</li>
        <li>Reserve early for best availability</li>
        <li>New inventory added regularly</li>
      </ul>
      <div class="fleet-empty-actions">
        <a href="#fleetWaitlistForm" class="fleet-empty-btn fleet-empty-btn-primary">Join Waitlist</a>
        <button type="button" class="fleet-empty-btn fleet-empty-btn-secondary" id="priorityNotificationBtn">Get Priority Notification</button>
        <a href="tel:+18445114059" class="fleet-empty-btn fleet-empty-btn-call">Call Now</a>
      </div>
      <form id="fleetWaitlistForm" class="fleet-waitlist-form" novalidate>
        <h4>Join the Priority Waitlist</h4>
        <div class="fleet-waitlist-grid">
          <label>Name<input type="text" name="name" autocomplete="name" required></label>
          <label>Phone<input type="tel" name="phone" autocomplete="tel" required></label>
          <label>Email<input type="email" name="email" autocomplete="email" required></label>
          <label>Preferred vehicle
            <select name="preferredVehicle">${preferredVehicleOptions}</select>
          </label>
          <label>Weekly budget<input type="text" name="weeklyBudget" placeholder="$350 - $500" maxlength="80"></label>
          <label class="fleet-waitlist-honeypot">Company
            <input type="text" name="company" tabindex="-1" autocomplete="off">
          </label>
        </div>
        <button type="submit" class="fleet-empty-btn fleet-empty-btn-primary">Submit Waitlist Request</button>
        <p id="fleetWaitlistStatus" class="fleet-waitlist-status" aria-live="polite"></p>
      </form>
    </article>
  </div>`;

  const priorityBtn = document.getElementById("priorityNotificationBtn");
  const form = document.getElementById("fleetWaitlistForm");
  const statusEl = document.getElementById("fleetWaitlistStatus");
  if (priorityBtn && form) {
    priorityBtn.addEventListener("click", () => {
      form.scrollIntoView({ behavior: "smooth", block: "center" });
      const firstInput = form.querySelector("input[name='name']");
      firstInput?.focus();
    });
  }

  if (!form || !statusEl) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    statusEl.textContent = "";

    const submitBtn = form.querySelector("button[type='submit']");
    const formData = new FormData(form);
    const payload = {
      name: String(formData.get("name") || "").trim(),
      phone: String(formData.get("phone") || "").trim(),
      email: String(formData.get("email") || "").trim(),
      preferredVehicle: String(formData.get("preferredVehicle") || "").trim(),
      weeklyBudget: String(formData.get("weeklyBudget") || "").trim(),
      honeypot: String(formData.get("company") || "").trim(),
      sourcePage: "cars-empty-state",
    };

    if (!payload.name || !payload.phone || !payload.email) {
      statusEl.textContent = "Please complete name, phone, and email.";
      statusEl.className = "fleet-waitlist-status error";
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
      const response = await fetch(API_BASE + "/api/fleet-waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Could not submit waitlist request.");
      }

      form.reset();
      statusEl.textContent = "Thanks — your waitlist request was received. We’ll contact you as soon as inventory opens.";
      statusEl.className = "fleet-waitlist-status success";
    } catch (err) {
      statusEl.textContent = err?.message || "Could not submit waitlist request. Please call (844) 511-4059.";
      statusEl.className = "fleet-waitlist-status error";
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// ─── Filter + search controls ───────────────────────────────────────────────
let activeFleetFilter = "all";
let activeFleetSearch = "";

function applyVisibleFilters() {
  const cards = Array.from(document.querySelectorAll("#car-grid .car-card"));
  let visible = 0;

  cards.forEach(card => {
    const inFilter = activeFleetFilter === "all" || card.dataset.category === activeFleetFilter;
    const haystack = (card.textContent || "").toLowerCase();
    const inSearch = !activeFleetSearch || haystack.includes(activeFleetSearch);
    const show = inFilter && inSearch;
    card.style.display = show ? "" : "none";
    if (show) visible += 1;
  });

  const countEl = document.getElementById("fleetVisibleCount");
  if (countEl) {
    countEl.textContent = visible ? `${visible} vehicle${visible === 1 ? "" : "s"} shown` : "No matching vehicles";
  }
}

function setupFilters() {
  document.querySelectorAll(".sidebar-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sidebar-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeFleetFilter = btn.dataset.filter || "all";
      applyVisibleFilters();
    });
  });

  const searchEl = document.getElementById("fleetSearch");
  if (searchEl) {
    searchEl.addEventListener("input", () => {
      activeFleetSearch = (searchEl.value || "").trim().toLowerCase();
      applyVisibleFilters();
    });
  }

  applyVisibleFilters();
}

// ─── Fleet status & availability badges ──────────────────────────────────────
// Keyed by vehicleId so applyFleetStatus can restore the original i18n key.
const originalBtnI18nKey = {};

function captureButtonKeys() {
  document.querySelectorAll("#car-grid .car-card").forEach(card => {
    const vid = card.dataset.vehicle;
    if (!vid) return;
    const btn = document.getElementById("select-btn-" + vid);
    if (btn) originalBtnI18nKey[vid] = btn.getAttribute("data-i18n") || "fleet.bookNow";
  });
}

function applyFleetStatus(fleetStatus) {
  const i18n = window.slyI18n || { t: k => k };

  document.querySelectorAll("#car-grid .car-card").forEach(card => {
    const vid = card.dataset.vehicle;
    if (!vid) return;

    const badge = document.getElementById("status-badge-" + vid);
    const btn   = document.getElementById("select-btn-" + vid);
    const link  = document.getElementById("select-link-" + vid);
    if (!badge || !btn || !link) return;

    const status    = fleetStatus[vid];
    const available = status ? status.available !== false : true;

    card.querySelector(".available-today-badge")?.remove();
    card.querySelector(".next-available-badge")?.remove();

    if (available) {
      const i18nKey = originalBtnI18nKey[vid] || "fleet.bookNow";
      badge.setAttribute("data-i18n", "fleet.available");
      badge.textContent = i18n.t("fleet.available");
      badge.className   = "status-badge available";

      btn.setAttribute("data-i18n", i18nKey);
      btn.textContent = i18n.t(i18nKey);
      btn.disabled = false;
      btn.style.display = "";
      btn.classList.remove("btn-booked");
      link.style.pointerEvents = "";
      link.href = `car.html?vehicle=${encodeURIComponent(vid)}`;

      const todayBadge = document.createElement("span");
      todayBadge.className = "available-today-badge";
      todayBadge.setAttribute("data-i18n", "fleet.availableToday");
      todayBadge.textContent = i18n.t("fleet.availableToday");
      badge.insertAdjacentElement("afterend", todayBadge);
    } else {
      const isReserved = status && status.rental_status === "reserved";
      const badgeKey = isReserved ? "fleet.pendingPickup" : "fleet.currentlyBooked";
      badge.setAttribute("data-i18n", badgeKey);
      badge.textContent = i18n.t(badgeKey);
      badge.className   = "status-badge unavailable booked";

      // Prefer available_at (timestamp with time) when available;
      // fall back to the date-only next_available_display string.
      const nextAvailDisplay = status
        ? (SlyLA.formatTimestamp(status.available_at) || status.next_available_display || null)
        : null;
      if (nextAvailDisplay) {
        const nextBadge = document.createElement("span");
        nextBadge.className = "next-available-badge";
        const tpl = i18n.t("fleet.nextAvailable") || "Next Available: {date}";
        nextBadge.textContent = tpl.replace("{date}", nextAvailDisplay);
        badge.insertAdjacentElement("afterend", nextBadge);

        const noteEl = document.createElement("span");
        noteEl.className = "next-available-note";
        noteEl.setAttribute("data-i18n", "fleet.nextAvailableNote");
        noteEl.textContent = i18n.t("fleet.nextAvailableNote") ||
          "This is the earliest pickup time — includes a 2-hour preparation window after the vehicle is returned.";
        nextBadge.insertAdjacentElement("afterend", noteEl);
      }

      if (isReserved) {
        btn.setAttribute("data-i18n", "fleet.completeBooking");
        btn.textContent = i18n.t("fleet.completeBooking") || "✅ Complete Booking";
        link.href = "manage-booking.html";
      } else {
        btn.setAttribute("data-i18n", "fleet.extendRental");
        btn.textContent = i18n.t("fleet.extendRental") || "⏱️ Extend Rental";
        link.href = `car.html?vehicle=${encodeURIComponent(vid)}&extend=1`;
      }
      btn.disabled = false;
      btn.style.display = "";
      btn.classList.add("btn-booked");
      link.style.pointerEvents = "";
    }
  });
}

async function loadFleetStatus() {
  try {
    const fleetRes = await fetch(API_BASE + "/api/fleet-status");
    const fleetStatus = fleetRes.ok ? await fleetRes.json() : {};
    validateFleetStatusShape(fleetStatus);
    return fleetStatus;
  } catch (err) {
    console.warn("Could not load fleet status:", err);
    return {};
  }
}

// ─── Fleet loader ─────────────────────────────────────────────────────────────
async function loadFleet() {
  const grid = document.getElementById("car-grid");
  if (!grid) return;

  // Only show loading spinner if no static cards are already present
  const hasStaticCards = grid.querySelector(".car-card");
  if (!hasStaticCards) showLoadingState(grid);

  let vehicles = [];
  let pricing  = null;
  let fleetStatus = {};

  try {
    const [vRes, pRes, fleetRes] = await Promise.all([
      fetch(API_BASE + "/api/v2-vehicles?scope=car", { cache: "no-store", headers: { Accept: "application/json" } }),
      fetch(API_BASE + "/api/public-pricing"),
      fetch(API_BASE + "/api/fleet-status"),
    ]);
    if (vRes.ok) vehicles = await vRes.json();
    if (pRes.ok) pricing  = await pRes.json();
    if (fleetRes.ok) fleetStatus = await fleetRes.json();
    validateFleetStatusShape(fleetStatus);
  } catch (err) {
    console.warn("Could not load fleet data:", err);
  }

  const activeAndAvailable = (Array.isArray(vehicles) ? vehicles : []).filter(v => {
    if (v.status && v.status !== "active") return false;
    if (isRemovedSlingshotVehicle(v)) return false;
    const cat = (v.category || "").toLowerCase();
    if (cat !== "car") {
      if (!cat) console.error("[cars.js] Vehicle skipped — missing category:", v.vehicle_id);
      return false;
    }
    const status = fleetStatus[v.vehicle_id];
    return !!status && status.available === true;
  });

  if (!activeAndAvailable.length) {
    renderFleetEmptyState(grid, vehicles, fleetStatus);
    return;
  }

  grid.innerHTML = activeAndAvailable.map(v => buildCardHTML(v, pricing)).join("");
  Array.from(grid.querySelectorAll("img[data-vehicle-image-id]")).forEach((imgEl) => {
    imgEl.addEventListener("error", () => {
      imgEl.onerror = null;
      imgEl.src = VEHICLE_IMAGE_PLACEHOLDER;
    });
  });
  captureButtonKeys();
  applyFleetStatus(fleetStatus);
  applyVisibleFilters();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
setupFilters();
loadFleet();
