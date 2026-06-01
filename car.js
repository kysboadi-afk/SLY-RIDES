// ----- API Base URL -----
// When served from the canonical Vercel domains (slycarrentals.com or
// www.slycarrentals.com) the API functions live on the same host, so use
// root-relative paths (empty base) to avoid any cross-subdomain CORS round-trip.
// For GitHub Pages (www.slytrans.com / slytrans.com) the full Vercel URL is
// required because the API functions are not available on that host.
const API_BASE = (
  window.location.hostname === "slycarrentals.com" ||
  window.location.hostname === "www.slycarrentals.com"
) ? "" : "https://slycarrentals.com";
// Timezone helpers are provided by la-date.js (loaded before this script).
const SlyLA = window.SlyLA;
const VEHICLE_IMAGE_PLACEHOLDER = "/images/logo.jpg";

// Fallback deposit amount used only if neither the vehicle record nor the
// system settings supply a booking_deposit value (prevents a broken button
// if both async fetches are unexpectedly slow).
const FALLBACK_BOOKING_DEPOSIT = 50;
// Los Angeles combined sales tax rate — must mirror LA_TAX_RATE in api/_pricing.js.
// Use getTaxRate() in calculations so the admin-configurable value is always used.
const LA_TAX_RATE = 0.1025;
function getTaxRate() { return window._dynamicTaxRate || LA_TAX_RATE; }

// ----- Car Data -----
// Vehicle data is loaded dynamically from /api/v2-vehicles so adding a new
// vehicle in the admin panel automatically makes it bookable — no code change
// needed.  buildCarDataFromAPI() below maps the API response into this object.
const cars = {};

// ----- Insurance / Protection Plan -----
// Economy car protection plan tiers (flat daily rates — must mirror api/_pricing.js).
const PROTECTION_PLAN_BASIC    = 15;   // Basic: $15/day
const PROTECTION_PLAN_STANDARD = 30;   // Standard: $30/day (default)
const PROTECTION_PLAN_PREMIUM  = 50;   // Premium: $50/day

const pageParams = new URLSearchParams(window.location.search);
const IS_EXTENSION_FLOW = /^(true|1)$/i.test(pageParams.get("extend") || "");
const ADMIN_OVERRIDE = /^(true|1)$/i.test(pageParams.get("admin_override") || "");
const TEST_MODE = /^(true|1)$/i.test(pageParams.get("test_mode") || "");
const IS_TEST_MODE_OVERRIDE = ADMIN_OVERRIDE && TEST_MODE;
const MAX_DOC_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per document
const MAX_TOTAL_DOC_FILE_BYTES = 18 * 1024 * 1024; // 18 MB total for front/back/insurance
const CANCEL_PENDING_BOOKING_ENDPOINT = API_BASE + "/api/cancel-pending-booking";

// ----- Helpers -----
function getVehicleFromURL() {
  return pageParams.get("vehicle");
}

const extensionTraceContext = {
  booking_id: "",
  vehicle_id_raw: String(getVehicleFromURL() || "").trim(),
  vehicle_id_normalized: "",
  booking_status: "unknown",
  overdue_state: "unknown",
  payment_plan_state: "unknown",
  extension_eligibility_state: "unknown",
  inventory_match_result: "not_attempted",
  redirect_reason: "",
};
const LEGACY_VEHICLE_LOOKUP_ALIASES = {
  camry2012: "camry",
};

function normalizeStatusState(value, fallback) {
  const state = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
  return state || (fallback || "unknown");
}

function canonicalVehicleLookupKey(value) {
  const lookup = normalizeVehicleLookupKey(value);
  return LEGACY_VEHICLE_LOOKUP_ALIASES[lookup] || lookup;
}

function deriveExtensionTraceStates(booking) {
  const statusKey = normalizeStatusState(booking?.status, "unknown");
  const paymentPlanStatus = normalizeStatusState(booking?.paymentPlan?.status, "none");
  const isOverdue = statusKey === "overdue" || !!booking?.isOverdueStage || !!booking?.paymentPlan?.isOverdue;
  const isExtensionEligible = ["active", "active_rental", "overdue", "extended"].includes(statusKey);
  return {
    booking_status: statusKey,
    overdue_state: isOverdue ? "overdue" : "not_overdue",
    payment_plan_state: paymentPlanStatus,
    extension_eligibility_state: isExtensionEligible ? "eligible" : "restricted",
  };
}

function logExtensionTrace(eventName, fields) {
  if (!IS_EXTENSION_FLOW) return;
  console.info("[car.js][extension-trace]", {
    event: eventName,
    ...extensionTraceContext,
    ...(fields || {}),
  });
}

// Derive the account-state-based extension approval state from a booking context.
// Returns { state, banners, ctaLabel, ctaEnabled } — a pure function suitable for tests.
function deriveExtensionApprovalState(booking) {
  if (!booking || typeof booking !== "object") {
    return { state: "unknown", banners: [], ctaLabel: "⏱️ Extend Rental", ctaEnabled: true };
  }
  const lifecycleState = String(booking.paymentLifecycleState || "").trim().toLowerCase();
  const statusKey = String(booking.status || "").trim().toLowerCase();
  const isOverdue = statusKey === "overdue";
  const paymentPlan = booking.paymentPlan || null;
  const planStatus = String(paymentPlan?.status || "").trim().toLowerCase();
  const isPlanDelinquent = !!(paymentPlan && (paymentPlan.isOverdue || planStatus === "defaulted" || planStatus === "past_due"));
  const lateFeeStatus = String(booking.lateFeeStatus || "").trim().toLowerCase();
  const lateFeeAmount = Number(booking.lateFeeAmount || 0);
  const hasActiveLateF = (lateFeeStatus === "assessed" || lateFeeStatus === "pending_collection") && lateFeeAmount > 0;
  const riskOverride = String(booking.extensionRiskOverride || "").trim().toLowerCase();
  const balanceDue = Number(booking.balanceDue || 0);

  if (riskOverride === "block") {
    return {
      state: "blocked",
      banners: ["⛔ Extension approval has been temporarily paused for this account. Please contact support at (844) 511-4059 to resolve before requesting an extension."],
      ctaLabel: "Extension Blocked — Contact Support",
      ctaEnabled: false,
    };
  }
  if (riskOverride === "allow") {
    return { state: "auto_approved", banners: [], ctaLabel: "⏱️ Extend Rental", ctaEnabled: true };
  }
  if (planStatus === "defaulted") {
    return {
      state: "manual_review",
      banners: [
        "⚠️ Your payment plan has been flagged for review.",
        "Extension request requires manual approval from our team. Please call (844) 511-4059.",
      ],
      ctaLabel: "⏱️ Submit Extension Request",
      ctaEnabled: true,
    };
  }
  if (isOverdue) {
    var msgs = ["⚠️ Your account currently has an overdue balance."];
    if (hasActiveLateF) msgs.push("Late fees ($" + lateFeeAmount.toFixed(2) + ") have been applied to your account.");
    msgs.push("Outstanding balance must be resolved before extension approval. Any applicable late fees will be collected at checkout.");
    return {
      state: "overdue_pay_first",
      banners: msgs,
      ctaLabel: "⏱️ Extend Rental (Overdue Balance)",
      ctaEnabled: true,
    };
  }
  if (isPlanDelinquent) {
    return {
      state: "manual_review",
      banners: [
        "⚠️ Your payment plan has a past-due installment.",
        "Partial balance payment may be required before extension.",
      ],
      ctaLabel: "⏱️ Submit Extension Request",
      ctaEnabled: true,
    };
  }
  if (hasActiveLateF) {
    return {
      state: "late_fee_pending",
      banners: [
        "ℹ️ Late fees ($" + lateFeeAmount.toFixed(2) + ") have been applied to your account.",
        "These fees will be included in your extension payment at checkout.",
      ],
      ctaLabel: "⏱️ Extend Rental",
      ctaEnabled: true,
    };
  }
  if (balanceDue > 0 && lifecycleState === "payment_plan_active") {
    return {
      state: "partial_balance_required",
      banners: [
        "ℹ️ A partial balance ($" + balanceDue.toFixed(2) + ") remains on your account.",
        "Partial balance payment may be required before or alongside your extension.",
      ],
      ctaLabel: "⏱️ Extend Rental",
      ctaEnabled: true,
    };
  }
  return { state: "auto_approved", banners: [], ctaLabel: "⏱️ Extend Rental", ctaEnabled: true };
}

// Apply the extension account state to the DOM: render banners, update CTA,
// and pre-fill contact fields from the booking context.
function applyExtensionAccountState(bookingCtx) {
  if (!IS_EXTENSION_FLOW || !isValidExtensionBookingContext(bookingCtx)) return;
  var approvalState = deriveExtensionApprovalState(bookingCtx);

  // Render account-state banners
  var bannerEl = document.getElementById("extAccountStateBanner");
  if (bannerEl) {
    if (approvalState.banners.length > 0) {
      bannerEl.innerHTML = approvalState.banners
        .map(function(msg) { return "<div class=\"ext-account-banner-item\">" + msg + "</div>"; })
        .join("");
      bannerEl.style.display = "";
    } else {
      bannerEl.innerHTML = "";
      bannerEl.style.display = "none";
    }
  }

  // Adjust submit button label and blocked state
  var extSubmitBtn = document.getElementById("extSubmitBtn");
  if (extSubmitBtn) {
    if (approvalState.ctaLabel) extSubmitBtn.textContent = approvalState.ctaLabel;
    if (!approvalState.ctaEnabled) extSubmitBtn.disabled = true;
  }

  // Pre-fill contact info from booking context so overdue renters don't have to re-enter
  var extEmailEl = document.getElementById("extEmail");
  if (extEmailEl && !extEmailEl.value && bookingCtx.customerEmail) {
    extEmailEl.value = bookingCtx.customerEmail;
    extEmailEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
  var extPhoneEl = document.getElementById("extPhone");
  if (extPhoneEl && !extPhoneEl.value && bookingCtx.customerPhone) {
    extPhoneEl.value = bookingCtx.customerPhone;
    extPhoneEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  logExtensionTrace("extension_approval_state_applied", {
    extension_approval_state: approvalState.state,
    has_account_banners: approvalState.banners.length > 0,
  });
}


async function loadExtensionBookingContext() {
  if (!IS_EXTENSION_FLOW) return null;
  const token = String(pageParams.get("t") || "").trim();
  if (!token) {
    logExtensionTrace("booking_context_missing_token", {
      redirect_reason: "missing_extension_token",
    });
    return null;
  }

  try {
    const resp = await fetch(API_BASE + "/api/manage-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", token }),
    });
    if (!resp.ok) {
      let payload = null;
      try { payload = await resp.json(); } catch (_) {}
      logExtensionTrace("booking_context_load_failed", {
        redirect_reason: "manage_booking_context_error",
        booking_context_http_status: resp.status,
        booking_context_error: payload?.error || null,
      });
      return null;
    }
    const booking = await resp.json();
    extensionTraceContext.booking_id = String(booking?.bookingId || "").trim();
    const traceStates = deriveExtensionTraceStates(booking);
    extensionTraceContext.booking_status = traceStates.booking_status;
    extensionTraceContext.overdue_state = traceStates.overdue_state;
    extensionTraceContext.payment_plan_state = traceStates.payment_plan_state;
    extensionTraceContext.extension_eligibility_state = traceStates.extension_eligibility_state;
    logExtensionTrace("booking_context_loaded", {});
    return booking;
  } catch (err) {
    logExtensionTrace("booking_context_load_exception", {
      redirect_reason: "manage_booking_context_exception",
      booking_context_error: err && err.message ? err.message : String(err),
    });
    return null;
  }
}

function normalizeVehicleLookupKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isRemovedSlingshotVehicle(v) {
  const vehicleId = String(v?.vehicle_id || v?.id || "").toLowerCase();
  const vehicleName = String(v?.vehicle_name || v?.name || "").toLowerCase();
  return vehicleId.includes("slingshot") || vehicleName.includes("slingshot");
}

function resolveVehicleFromInventory(vehicles, requestedVehicleRef) {
  const requestedRaw = String(requestedVehicleRef || "").trim();
  if (!requestedRaw || !Array.isArray(vehicles)) return null;
  const requestedCanonicalLookup = canonicalVehicleLookupKey(requestedRaw);
  const candidates = vehicles.filter((v) => Boolean(v) && !isRemovedSlingshotVehicle(v));

  const exact = candidates.find((v) => String(v.vehicle_id || v.id || "").trim() === requestedRaw);
  if (exact) return { vehicle: exact, vehicleId: String(exact.vehicle_id || exact.id || "").trim() };

  const ci = candidates.find((v) => String(v.vehicle_id || v.id || "").trim().toLowerCase() === requestedRaw.toLowerCase());
  if (ci) return { vehicle: ci, vehicleId: String(ci.vehicle_id || ci.id || "").trim() };

  const byId = candidates.find((v) => {
    const idLookup = canonicalVehicleLookupKey(v.vehicle_id || v.id || "");
    return idLookup === requestedCanonicalLookup;
  });
  if (byId) return { vehicle: byId, vehicleId: String(byId.vehicle_id || byId.id || "").trim() };

  const byName = candidates.find((v) => {
    const nameLookup = canonicalVehicleLookupKey(v.vehicle_name || v.name || "");
    return nameLookup === requestedCanonicalLookup;
  });
  if (byName) return { vehicle: byName, vehicleId: String(byName.vehicle_id || byName.id || "").trim() };

  return null;
}

function getVehicleLookupRecoveryUrl(isExtensionFlow) {
  if (isExtensionFlow) {
    const token = String(pageParams.get("t") || "").trim();
    if (token) return `manage-booking.html?t=${encodeURIComponent(token)}`;
    return "manage-booking.html";
  }
  return "cars.html";
}

function handleVehicleLookupFailure(reason, details) {
  const isExtensionFlow = IS_EXTENSION_FLOW;
  const message = isExtensionFlow
    ? "We couldn’t load your vehicle for extension right now. Redirecting you back to Manage Booking."
    : "We couldn’t find that vehicle. Redirecting you to available vehicles.";
  if (isExtensionFlow) {
    extensionTraceContext.redirect_reason = String(reason || "unknown");
    logExtensionTrace("vehicle_lookup_failed", {
      redirect_reason: extensionTraceContext.redirect_reason,
      inventory_match_result: extensionTraceContext.inventory_match_result || "not_found",
    });
  }
  console.error("[car.js] Vehicle lookup failed:", {
    reason,
    requestedVehicle: String(getVehicleFromURL() || ""),
    isExtensionFlow,
    ...details,
  });
  showPayError(message);
  const redirectTarget = getVehicleLookupRecoveryUrl(isExtensionFlow);
  setTimeout(() => {
    window.location.href = redirectTarget;
  }, 1500);
}

// i18n helper — translates a key using lang.js if available, else returns fallback.
function _t(key, fallback) {
  return (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t(key) : (fallback || key);
}

function normalizeVehicleImageUrl(value) {
  if (!value || typeof value !== "string") return "";
  var url = String(value).trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url) || url.startsWith("/")) return url;
  return "/" + url.replace(/^(\.\.\/)+/, "");
}

function buildVehicleScopedImageList(v, expectedVehicleId) {
  if (!v || String(v.vehicle_id || "") !== String(expectedVehicleId || "")) return [];
  var images = [];
  var pushIfSafe = function(url) {
    var normalized = normalizeVehicleImageUrl(url);
    if (normalized && images.indexOf(normalized) === -1) images.push(normalized);
  };
  pushIfSafe(v.cover_image);
  if (Array.isArray(v.gallery_images)) {
    v.gallery_images.forEach(pushIfSafe);
  }
  return images;
}

// Format helper — replaces {placeholder} tokens in a translated string.
function _fmt(key, vars, fallback) {
  let s = _t(key, fallback || key);
  if (vars) {
    Object.keys(vars).forEach(function(k) {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
    });
  }
  return s;
}

// Show an inline error near the pay buttons (replaces alert() which Chrome can suppress).
function showPayError(msg) {
  const el = document.getElementById("payError");
  if (!el) { console.error("Payment error:", msg); return; }
  el.textContent = msg;
  el.style.display = "block";
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function clearPayError() {
  const el = document.getElementById("payError");
  if (el) { el.textContent = ""; el.style.display = "none"; }
}

async function storeBookingDocsOrThrow(payload) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(API_BASE + "/api/store-booking-docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data && data.ok === true && data.stored === true) {
        return;
      }
      const err = new Error((data && data.error) || `Document upload failed (HTTP ${res.status}).`);
      err.status = res.status;
      err.responsePayload = data;
      throw err;
    } catch (err) {
      console.warn("storeBookingDocsOrThrow attempt failed:", {
        attempt,
        maxAttempts,
        bookingId: payload && payload.bookingId,
        error: err && err.message ? err.message : String(err),
        status: err && err.status ? err.status : null,
        responsePayload: err && err.responsePayload ? err.responsePayload : null,
        userAgent: navigator.userAgent,
      });
      if (attempt >= maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Only validation-size failures block checkout immediately.
 * Other failures remain recoverable via the success-page/IndexedDB fallback.
 */
function shouldBlockPaymentForDocFailure(error) {
  const status = error && typeof error.status === "number" ? error.status : 0;
  return status === 400 || status === 413;
}

function reportNonBlockingDocFailure(error) {
  console.warn("Proceeding without pre-payment document persistence; success-page fallback will be used.", {
    error: error && error.message ? error.message : String(error),
    status: error && error.status ? error.status : null,
  });
}

async function encodeUploadFile(file, label) {
  if (!file) {
    return { base64: null, fileName: null, mimeType: null };
  }
  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return {
      base64,
      fileName: file.name,
      mimeType: file.type || "",
    };
  } catch (err) {
    console.error(label + " encoding error:", {
      error: err && err.message ? err.message : String(err),
      fileName: file.name,
      mimeType: file.type || "",
      fileSize: file.size,
      userAgent: navigator.userAgent,
    });
    throw err;
  }
}

function _formatDocSizeMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function validateDocUploadSelection(file, otherSelectedBytes) {
  if (!file) return null;
  if (file.size > MAX_DOC_FILE_BYTES) {
    return `File "${file.name}" is too large (${_formatDocSizeMB(file.size)} MB). Maximum per file is ${_formatDocSizeMB(MAX_DOC_FILE_BYTES)} MB.`;
  }
  const combinedBytes = (otherSelectedBytes || 0) + file.size;
  if (combinedBytes > MAX_TOTAL_DOC_FILE_BYTES) {
    return `Combined document size is too large (${_formatDocSizeMB(combinedBytes)} MB). Maximum allowed is ${_formatDocSizeMB(MAX_TOTAL_DOC_FILE_BYTES)} MB across uploaded documents.`;
  }
  return null;
}

// ----- Dynamic Pricing -----
// Fetches live prices from the admin System Settings (Supabase) so that any
// rate change in the admin panel is immediately reflected on the booking page.
// Runs asynchronously after page load — falls back to the carData values
// already loaded from the API if public-pricing is unreachable or returns an error.
(function loadDynamicPricing() {
  fetch(API_BASE + "/api/public-pricing")
    .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
    .then(function(pricing) {
      // ── Economy cars ──────────────────────────────────────────────────────
      var ecDaily   = (pricing.economy && pricing.economy.daily)   ? Number(pricing.economy.daily)   : 0;
      var ecWeekly  = (pricing.economy && pricing.economy.weekly)  ? Number(pricing.economy.weekly)  : 0;
      var ecBiWeek  = (pricing.economy && pricing.economy.biweekly)? Number(pricing.economy.biweekly): 0;
      var ecMonthly = (pricing.economy && pricing.economy.monthly) ? Number(pricing.economy.monthly) : 0;

      // Apply economy-wide pricing to all vehicles currently in `cars`.
      // All vehicles are loaded from the API; the economy-wide rates from
      // system_settings override any per-vehicle defaults set by buildCarDataFromAPI.
      Object.keys(cars).forEach(function(vid) {
        if (!cars[vid]) return;
        if (ecDaily   > 0) cars[vid].pricePerDay = ecDaily;
        if (ecWeekly  > 0) cars[vid].weekly      = ecWeekly;
        if (ecBiWeek  > 0) cars[vid].biweekly    = ecBiWeek;
        if (ecMonthly > 0) cars[vid].monthly     = ecMonthly;
      });

      // ── Booking deposit ───────────────────────────────────────────────────
      // Apply the system-wide booking_deposit to any vehicle that doesn't have
      // a per-vehicle deposit configured (v.booking_deposit from v2-vehicles).
      var ecDeposit = (pricing.economy && pricing.economy.booking_deposit) ? Number(pricing.economy.booking_deposit) : 0;
      Object.keys(cars).forEach(function(vid) {
        if (!cars[vid] || cars[vid].booking_deposit != null) return; // don't overwrite per-vehicle value
        if (ecDeposit > 0) cars[vid].booking_deposit = ecDeposit;
      });
      // Re-render the deposit button in case the vehicle data loaded first and
      // booking_deposit was null at initCarPage() time.
      updateDepositButton();

      // ── Tax rate ─────────────────────────────────────────────────────────
      // (already set as a module-level const; we update the global so
      //  any later calculation that references LA_TAX_RATE by closure reads
      //  the updated value — functions that captured it directly are re-called
      //  naturally through user interaction.)
      if (pricing.tax_rate) {
        window._dynamicTaxRate = Number(pricing.tax_rate);
      }

      // Refresh the displayed price for the current vehicle
      if (carData) {
        var priceEl = document.getElementById("carPrice");
        if (priceEl) {
          priceEl.textContent = carData.weekly
            ? "$" + carData.pricePerDay + " / " + _t("fleet.unitDay","day") + " \u2022 " + _t("fleet.priceFrom","from") + " $" + carData.weekly + " / " + _t("fleet.unitWeek","week")
            : "$" + carData.pricePerDay + " / " + _t("fleet.unitDay","day");
        }
      }
    })
    .catch(function(err) {
      // Non-fatal — hard-coded values remain in effect
      console.warn("car.js: could not load dynamic pricing, using defaults:", err.message);
    });
}());

let vehicleId = String(getVehicleFromURL() || "").trim();
// carData is populated asynchronously after fetching from the API for all vehicles.
let carData = null;
let extensionBookingContext = null;

// Builds a cars-compatible data object from a v2-vehicles API response entry.
// All vehicles — existing and newly added — load through this path.
function buildCarDataFromAPI(v) {
  var scopedImages = buildVehicleScopedImageList(v, vehicleId);
  return {
    name:          v.vehicle_name || v.vehicle_id,
    subtitle:      v.subtitle     || "",
    // Prefer per-vehicle pricing stored in the data blob (set at creation time),
    // then fall through to sensible economy defaults.
    pricePerDay:   v.daily_price    || 55,
    weekly:        v.weekly_price   || 350,
    biweekly:      v.biweekly_price || 650,
    monthly:       v.monthly_price  || 1300,
    minRentalDays: 1,
    // Per-vehicle booking deposit (e.g. $50 reserve-now option). null means the
    // deposit button is hidden. loadDynamicPricing() fills this from the system-wide
    // setting when no per-vehicle value is present.
    booking_deposit: Number(v.booking_deposit) > 0 ? Number(v.booking_deposit) : null,
    images:        scopedImages.length ? scopedImages : [VEHICLE_IMAGE_PLACEHOLDER],
    make:          v.make          || "",
    model:         v.model         || v.vehicle_name || vehicleId,
    year:          v.vehicle_year  || null,
    vin:           v.vin           || "",
    color:         v.color         || "",
    earnings_tagline: v.earnings_tagline || "",
    earnings_title:   v.earnings_title   || "",
    earnings_row1:    v.earnings_row1    || "",
    earnings_cta:     v.earnings_cta     || "",
    category:         "car",
  };
}

// Shows or hides the "Reserve with Deposit" button and the deposit notice based on
// whether the loaded vehicle supports a booking deposit. Called from both
// initCarPage() (after vehicle data loads) and loadDynamicPricing() (after system
// settings load) so the button appears correctly regardless of fetch order.
function updateDepositButton() {
  if (!carData) return;
  const reserveBtnEl   = document.getElementById("reserveBtn");
  const depositNotice  = document.getElementById("camryDepositNotice");
  const depositAmt = carData.booking_deposit != null ? carData.booking_deposit : FALLBACK_BOOKING_DEPOSIT;
  if (reserveBtnEl) {
    reserveBtnEl.textContent = "\uD83D\uDD12 Reserve with $" + depositAmt + " Deposit";
    reserveBtnEl.style.display = "";
  }
  if (depositNotice) depositNotice.style.display = "";
}

// Initializes all DOM content that depends on carData.  Called from the .then()
// callback once vehicle data has been loaded from the API.
function initCarPage() {
  document.getElementById("carName").textContent = carData.name;
  document.getElementById("carSubtitle").textContent =
    (carData.subtitleKey && window.slyI18n) ? window.slyI18n.t(carData.subtitleKey) : carData.subtitle;
  document.getElementById("carPrice").textContent = carData.weekly
    ? `$${carData.pricePerDay} / ${_t("fleet.unitDay","day")} \u2022 ${_t("fleet.priceFrom","from")} $${carData.weekly} / ${_t("fleet.unitWeek","week")}`
    : `$${carData.pricePerDay} / ${_t("fleet.unitDay","day")}`;

  const nav = document.querySelector(".site-nav");
  if (nav) {
    nav.innerHTML =
      '<a href="index.html" data-i18n="nav.homeLink">Home</a>' +
      '<a href="cars.html">Browse Cars</a>' +
      '<a href="manage-booking.html">Manage Booking</a>';
  }
  const logoLink = document.querySelector(".logo-link");
  if (logoLink) logoLink.href = "index.html";
  const backBtnEl = document.getElementById("backBtn");
  if (backBtnEl) backBtnEl.onclick = null;
  const earningsBlock = document.getElementById("earningsBlock");
  if (earningsBlock) earningsBlock.style.display = "";

  if (IS_TEST_MODE_OVERRIDE) {
    const bookingSection = document.querySelector(".booking");
    if (bookingSection) {
      const testModeBanner = document.createElement("div");
      testModeBanner.id = "testModeBanner";
      testModeBanner.textContent = "TEST MODE \u2013 availability override active";
      testModeBanner.style.cssText = "background:#fff3cd;color:#7a4f01;border:1px solid #ffe69c;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-weight:700;";
      bookingSection.insertBefore(testModeBanner, bookingSection.firstChild);
    }
  }

  // Load images into the slider
  sliderContainer.innerHTML = "";
  sliderDots.innerHTML = "";
  carData.images.forEach((imgSrc, idx) => {
    const img = document.createElement("img");
    img.src = imgSrc;
    img.onerror = function() {
      img.onerror = null;
      img.src = VEHICLE_IMAGE_PLACEHOLDER;
    };
    img.classList.add("slide");
    if (idx === 0) img.classList.add("active");
    sliderContainer.appendChild(img);

    const dot = document.createElement("span");
    dot.classList.add("dot");
    if (idx === 0) dot.classList.add("active");
    dot.addEventListener("click", () => goToSlide(idx));
    sliderDots.appendChild(dot);
  });

  // Show or hide the "Reserve with Deposit" option based on this vehicle's config.
  // loadDynamicPricing() may also call updateDepositButton() once system settings load.
  updateDepositButton();

  // Update the earnings block with this vehicle's data and install the translation
  // hook so language switches keep it correct — only for cars.
  updateEarningsBlock();
  installEarningsTranslationHook();
}

// Average weekly rideshare earnings range used in the earnings example block.
const EARNINGS_EXAMPLE_LOW  = 1200;
const EARNINGS_EXAMPLE_HIGH = 1600;

// Updates the earnings block on the booking page with per-vehicle text and
// computed prices.  Per-vehicle values (earnings_tagline, earnings_title,
// earnings_row1, earnings_cta) take priority over lang.js defaults.
function updateEarningsBlock() {
  if (!carData) return;
  const weekly = carData.weekly;

  const taglineEl = document.querySelector("[data-i18n='booking.earningsTagline']");
  if (taglineEl && carData.earnings_tagline) {
    taglineEl.textContent = carData.earnings_tagline;
    taglineEl.removeAttribute("data-i18n");
  }
  const titleEl = document.querySelector("[data-i18n='booking.earningsTitle']");
  if (titleEl && carData.earnings_title) {
    titleEl.textContent = carData.earnings_title;
    titleEl.removeAttribute("data-i18n");
  }
  const row1El = document.querySelector("[data-i18n='booking.earningsRow1']");
  if (row1El && carData.earnings_row1) {
    row1El.textContent = carData.earnings_row1;
    row1El.removeAttribute("data-i18n");
  }
  const ctaEl = document.querySelector("[data-i18n-html='booking.earningsCtaHtml']");
  if (ctaEl && carData.earnings_cta) {
    ctaEl.textContent = carData.earnings_cta;
    ctaEl.removeAttribute("data-i18n-html");
  }

  if (!weekly) return;
  const takeHomeLow  = EARNINGS_EXAMPLE_LOW  - weekly;
  const takeHomeHigh = EARNINGS_EXAMPLE_HIGH - weekly;
  const row2 = document.getElementById("earningsRow2");
  const row3 = document.getElementById("earningsRow3");
  if (row2) {
    const tmpl2 = _t("booking.earningsRow2Html",
      `Weekly rental: <span class="earnings-yellow">$${weekly}</span>`);
    row2.innerHTML = tmpl2.replace(/\$[\d,]+/, `$${weekly}`);
  }
  if (row3) {
    const tmpl3 = _t("booking.earningsRow3Html",
      `<span class="earnings-green">Estimated take-home:</span> $${takeHomeLow} \u2013 $${takeHomeHigh}`);
    row3.innerHTML = tmpl3.replace(/\$[\d,]+\s*[\u2013\-]\s*\$[\d,]+/,
      `$${takeHomeLow} \u2013 $${takeHomeHigh}`);
  }
}

// Wrap slyI18n.applyTranslations once so the earnings block is refreshed on every
// language switch.
let _earningsHookInstalled = false;
function installEarningsTranslationHook() {
  if (_earningsHookInstalled) return;
  if (!window.slyI18n || !window.slyI18n.applyTranslations) return;
  const _origApply = window.slyI18n.applyTranslations;
  window.slyI18n.applyTranslations = function() {
    _origApply.call(window.slyI18n);
    updateEarningsBlock();
  };
  _earningsHookInstalled = true;
}

const sliderContainer = document.getElementById("sliderContainer");
const sliderDots = document.getElementById("sliderDots");
let currentSlide = 0;

function showSlide(index) {
  const slides = sliderContainer.querySelectorAll(".slide");
  const dots = sliderDots.querySelectorAll(".dot");
  slides.forEach((s,i)=>s.classList.toggle("active", i===index));
  dots.forEach((d,i)=>d.classList.toggle("active", i===index));
  currentSlide = index;
}

function nextSlide() { showSlide((currentSlide+1)%carData.images.length); }
function prevSlide() { showSlide((currentSlide-1+carData.images.length)%carData.images.length); }
document.getElementById("nextSlide").addEventListener("click", nextSlide);
document.getElementById("prevSlide").addEventListener("click", prevSlide);
function goToSlide(idx){ showSlide(idx); }

function dedupeVehicleRefs(values) {
  const seen = new Set();
  const refs = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const raw = String(value || "").trim();
    if (!raw) return;
    const key = raw.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(raw);
  });
  return refs;
}

function isValidExtensionBookingContext(booking) {
  if (!booking || typeof booking !== "object") return false;
  const bookingId = String(booking.bookingId || "").trim();
  const bookingVehicleId = String(booking.vehicleId || "").trim();
  const bookingVehicleName = String(booking.vehicleName || "").trim();
  return !!bookingId && (!!bookingVehicleId || !!bookingVehicleName);
}

function buildVehicleCandidatesForLookup(requestedVehicleId, booking) {
  const requested = String(requestedVehicleId || "").trim();
  const bookingCandidates = dedupeVehicleRefs([
    booking?.vehicleId,
    booking?.vehicleName,
  ]);
  if (!IS_EXTENSION_FLOW || bookingCandidates.length === 0) {
    return dedupeVehicleRefs([requested]);
  }

  if (!requested) return bookingCandidates;

  const requestedKey = canonicalVehicleLookupKey(requested);
  const matchesBookingVehicle = bookingCandidates.some((candidate) => {
    return canonicalVehicleLookupKey(candidate) === requestedKey;
  });

  if (!matchesBookingVehicle) {
    logExtensionTrace("vehicle_scope_enforced", {
      requested_vehicle_ignored: requested,
      booking_vehicle_scope: bookingCandidates,
    });
    return bookingCandidates;
  }
  return dedupeVehicleRefs([requested, ...bookingCandidates]);
}

function buildFallbackExtensionCarData(booking, resolvedVehicleId) {
  const displayName = String(booking?.vehicleName || resolvedVehicleId || "Your vehicle").trim();
  return {
    name: displayName,
    subtitle: "",
    pricePerDay: 55,
    weekly: 350,
    biweekly: 650,
    monthly: 1300,
    minRentalDays: 1,
    booking_deposit: null,
    images: [VEHICLE_IMAGE_PLACEHOLDER],
    make: String(booking?.vehicleMake || "").trim(),
    model: String(booking?.vehicleModel || displayName || resolvedVehicleId || "").trim(),
    year: booking?.vehicleYear || null,
    vin: "",
    color: String(booking?.vehicleColor || "").trim(),
    earnings_tagline: "",
    earnings_title: "",
    earnings_row1: "",
    earnings_cta: "",
    category: "car",
  };
}

function applyResolvedVehicleRoute(resolvedVehicleId, source) {
  if (!resolvedVehicleId) return;
  const priorVehicleId = String(vehicleId || "").trim();
  if (!priorVehicleId || priorVehicleId !== resolvedVehicleId) {
    const next = new URL(window.location.href);
    next.searchParams.set("vehicle", resolvedVehicleId);
    window.history.replaceState({}, "", `${next.pathname}${next.search}${next.hash}`);
    if (priorVehicleId && priorVehicleId !== resolvedVehicleId) {
      console.warn("[car.js] normalized vehicle route:", { requested: priorVehicleId, resolved: resolvedVehicleId, source });
    }
    vehicleId = resolvedVehicleId;
  }
  extensionTraceContext.vehicle_id_normalized = resolvedVehicleId;
}

async function initializeVehicleContext() {
  extensionBookingContext = await loadExtensionBookingContext();
  const hasValidExtensionBookingContext = isValidExtensionBookingContext(extensionBookingContext);
  const vehicleCandidates = buildVehicleCandidatesForLookup(
    vehicleId,
    hasValidExtensionBookingContext ? extensionBookingContext : null
  );
  try {
    if (vehicleCandidates.length === 0) {
      handleVehicleLookupFailure("missing_vehicle_query_param");
      return;
    }

    logExtensionTrace("inventory_lookup_started", {
      vehicle_candidates: vehicleCandidates,
    });

    const response = await fetch(API_BASE + "/api/v2-vehicles", { cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const vehicles = await response.json();

    let resolved = null;
    let matchedCandidate = "";
    for (const candidate of vehicleCandidates) {
      const match = resolveVehicleFromInventory(vehicles, candidate);
      if (match && match.vehicle) {
        resolved = match;
        matchedCandidate = candidate;
        break;
      }
    }

    if (resolved && resolved.vehicle) {
      const resolvedVehicleId = String(resolved.vehicleId || "").trim();
      if (!resolvedVehicleId) throw new Error("resolved_vehicle_id_missing");
      applyResolvedVehicleRoute(resolvedVehicleId, "inventory_match");
      extensionTraceContext.inventory_match_result = "matched_inventory";
      logExtensionTrace("inventory_lookup_succeeded", {
        inventory_match_result: extensionTraceContext.inventory_match_result,
        matched_candidate: matchedCandidate || null,
      });
      carData = cars[vehicleId] = buildCarDataFromAPI(resolved.vehicle);
      sliderContainer.innerHTML = "";
      initCarPage();
      if (IS_EXTENSION_FLOW) applyExtensionAccountState(extensionBookingContext);
      return;
    }

    const fallbackVehicleId = String(
      extensionBookingContext?.vehicleId || extensionBookingContext?.vehicleName || vehicleCandidates[0] || ""
    ).trim();

    if (IS_EXTENSION_FLOW && hasValidExtensionBookingContext && fallbackVehicleId) {
      applyResolvedVehicleRoute(fallbackVehicleId, "booking_context_fallback");
      extensionTraceContext.inventory_match_result = "booking_context_fallback";
      logExtensionTrace("inventory_lookup_fallback_applied", {
        inventory_match_result: extensionTraceContext.inventory_match_result,
      });
      carData = cars[vehicleId] = buildFallbackExtensionCarData(extensionBookingContext, vehicleId);
      sliderContainer.innerHTML = "";
      initCarPage();
      applyExtensionAccountState(extensionBookingContext);
      return;
    }

    throw new Error("not found");
  } catch (err) {
    const fallbackVehicleId = String(
      extensionBookingContext?.vehicleId || extensionBookingContext?.vehicleName || vehicleCandidates[0] || ""
    ).trim();
    if (IS_EXTENSION_FLOW && hasValidExtensionBookingContext && fallbackVehicleId) {
      applyResolvedVehicleRoute(fallbackVehicleId, "booking_context_fallback_after_inventory_error");
      extensionTraceContext.inventory_match_result = "booking_context_fallback_inventory_unavailable";
      logExtensionTrace("inventory_lookup_fallback_after_error", {
        inventory_match_result: extensionTraceContext.inventory_match_result,
        inventory_error: err && err.message ? err.message : String(err),
      });
      carData = cars[vehicleId] = buildFallbackExtensionCarData(extensionBookingContext, vehicleId);
      sliderContainer.innerHTML = "";
      initCarPage();
      applyExtensionAccountState(extensionBookingContext);
      return;
    }
    extensionTraceContext.inventory_match_result = "not_found";
    handleVehicleLookupFailure("inventory_lookup_failed", {
      error: err && err.message ? err.message : String(err),
    });
  }
}

// Initialize page: fetch vehicle data from the API for all vehicles.
sliderContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:220px;color:#888;font-size:15px;">Loading vehicle\u2026</div>';
initializeVehicleContext();

// ----- Back Button -----
document.getElementById("backBtn").addEventListener("click", ()=>{
  window.location.href = "cars.html";
});

// ----- Booking Form Automation -----
const pickup = document.getElementById("pickup");
const pickupTime = document.getElementById("pickupTime");
const returnDate = document.getElementById("return");
const returnTime = document.getElementById("returnTime");
const agreeCheckbox = document.getElementById("agree");
const smsConsentCheck = document.getElementById("smsConsentCheck");
const idUpload = document.getElementById("idUpload");
const idBackUpload = document.getElementById("idBackUpload");
const insuranceUpload = document.getElementById("insuranceUpload");
const totalEl = document.getElementById("total");
const stripeBtn = document.getElementById("stripePay");

let uploadedFile = null;
let uploadedFileBack = null;
let uploadedInsurance = null;
let currentDayCount = 1;
let currentSubtotal = 0;
let agreementSignature = ""; // typed signature from the inline agreement panel
let insuranceCoverageChoice = null; // 'yes' | 'no' | null
// Payment mode for the current payment attempt: 'deposit' | 'full'.
// Set by reserveBtn before delegating to stripeBtn; reset after each attempt.
let _pendingPaymentMode = null;
let pendingBookingId = null;
let paymentFormSubmitted = false;
// Economy car protection plan tier selected on the booking page: basic | standard | premium
// Defaults to "standard" (pre-populated from Apply Now / Waitlist preference).
let selectedProtectionTier = "standard";

async function updatePendingBookingLifecycle(targetStatus, reason, options = {}) {
  if (!pendingBookingId) return;
  const bookingIdToCancel = pendingBookingId;
  const useBeacon = !!options.useBeacon;
  const source = options.source || "car_booking";
  const shouldClearLocal = !options.preservePendingBookingId;
  const body = JSON.stringify({ bookingId: bookingIdToCancel, targetStatus, reason, source });
  if (useBeacon && navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    const queued = navigator.sendBeacon(CANCEL_PENDING_BOOKING_ENDPOINT, blob);
    if (queued) {
      if (shouldClearLocal) pendingBookingId = null;
      return true;
    }
    console.warn("cancel-pending-booking sendBeacon failed to queue; falling back to fetch");
  }
  try {
    const res = await fetch(CANCEL_PENDING_BOOKING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    if (shouldClearLocal) pendingBookingId = null;
    return true;
  } catch (err) {
    console.warn("cancel-pending-booking fetch error:", err);
    return false;
  }
}

window.addEventListener("pagehide", function () {
  if (pendingBookingId && !paymentFormSubmitted) {
    updatePendingBookingLifecycle("abandoned_checkout", "pagehide_before_payment", { useBeacon: true, source: "pagehide" });
  }
});


// ----- Name Field Validation & Auto-correction -----

// Capitalize the first letter after each word boundary (spaces, hyphens, apostrophes)
function toTitleCase(str) {
  return str.replace(/(?:^|[\s'\-])([a-zA-ZÀ-ÖØ-öø-ÿ])/g, function (m) {
    return m.toUpperCase();
  });
}

// Remove any character that is not a letter, space, hyphen, apostrophe, or period.
function sanitizeNameInput(val) {
  return val.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ\s'\-.]/g, '');
}

// Name must contain at least a first and last name (two words)
function isValidName(val) {
  return val.trim().split(/\s+/).filter(Boolean).length >= 2;
}

(function setupNameField() {
  const nameField = document.getElementById('name');
  const nameError = document.getElementById('nameError');

  nameField.addEventListener('input', function () {
    const cleaned = sanitizeNameInput(this.value);
    if (cleaned !== this.value) { this.value = cleaned; }
    // Hide the error while the user is still typing
    if (nameError) { nameError.style.display = 'none'; }
    updatePayBtn();
  });

  nameField.addEventListener('blur', function () {
    if (this.value.trim()) {
      this.value = toTitleCase(this.value.trim().replace(/\s+/g, ' '));
    }
    // Show validation error if the name is present but incomplete
    if (nameError) {
      const val = this.value.trim();
      if (val && !isValidName(val)) {
        nameError.textContent = window.slyI18n ? window.slyI18n.t("booking.nameError") : 'Please enter at least a first and last name.';
        nameError.style.display = '';
      } else {
        nameError.style.display = 'none';
      }
    }
    updatePayBtn();
  });
}());

// ----- Pre-fill from Apply Now application (localStorage) or Waitlist (sessionStorage) -----
// When an applicant submits the "Apply Now" form their name, phone, email, insurance choice,
// and protection plan preference are stored in localStorage under "slyApplicant".
// Waitlist entries store the same fields in sessionStorage under "slyWaitlistEntry".
// If that data exists we pre-fill the booking-form fields so the renter doesn't have to
// re-enter information they already provided. Waitlist data takes precedence over Apply data.
(function prefillFromApplication() {
  function applyPrefillData(data) {
    const nameField  = document.getElementById("name");
    const emailField = document.getElementById("email");
    const phoneField = document.getElementById("phone");
    if (data.name  && nameField  && !nameField.value)  { nameField.value  = data.name;  updatePayBtn(); }
    if (data.email && emailField && !emailField.value) { emailField.value = data.email; updatePayBtn(); }
    if (data.phone && phoneField && !phoneField.value) { phoneField.value = data.phone; updatePayBtn(); }

    // Pre-select protection plan tier (default to standard if not stored)
    const pref = data.protectionPlanPref || data.protectionPlan;
    if (pref === "basic" || pref === "standard" || pref === "premium") {
      selectedProtectionTier = pref;
    }
    // Pre-select insurance radio and show/hide appropriate sections
    const hasInsurance = data.hasInsurance;
    if (hasInsurance === "yes") {
      insuranceCoverageChoice = "yes";
      const hasInsRadio = document.getElementById("hasInsurance");
      const insSection  = document.getElementById("insuranceUploadSection");
      if (hasInsRadio) hasInsRadio.checked = true;
      if (insSection)  insSection.style.display = "";
      document.getElementById("protectionPlanSection").style.display = "none";
    } else if (hasInsurance === "no") {
      insuranceCoverageChoice = "no";
      const noInsRadio     = document.getElementById("noInsurance");
      const protSection    = document.getElementById("protectionPlanSection");
      const insSection     = document.getElementById("insuranceUploadSection");
      if (noInsRadio)   noInsRadio.checked = true;
      if (insSection)   insSection.style.display = "none";
      if (protSection)  protSection.style.display = "";
      _syncProtectionTierRadio(selectedProtectionTier);
    }
    updatePayBtn();
  }

  (async function loadPrefillAsync() {
    try {
      // Prefer the more-recent waitlist entry (sessionStorage) over the apply entry (localStorage).
      let data = null;
      const wlRaw = sessionStorage.getItem("slyWaitlistEntry");
      if (wlRaw) {
        const wl = JSON.parse(wlRaw);
        // Only use waitlist data if it matches the vehicle being booked
        if (!wl.vehicleId || wl.vehicleId === vehicleId) {
          data = wl;
        }
      }
      if (!data) {
        const applyRaw = localStorage.getItem("slyApplicant");
        if (applyRaw) data = JSON.parse(applyRaw);
      }
      if (!data) return;

      const applicationId = (typeof data.applicationId === "string" && data.applicationId.trim())
        ? data.applicationId.trim()
        : "";
      if (!applicationId) {
        applyPrefillData(data);
        return;
      }

      try {
        const resp = await fetch(API_BASE + "/api/get-renter-application?applicationId=" + encodeURIComponent(applicationId));
        const result = await resp.json().catch(function () { return {}; });
        if (resp.ok && result && result.success) {
          applyPrefillData({
            ...data,
            name: result.name || data.name,
            phone: result.phone || data.phone,
            email: result.email || data.email,
            hasInsurance: result.hasInsurance || data.hasInsurance,
            protectionPlanPref: result.protectionPlanPref || data.protectionPlanPref,
            decision: result.decision || data.decision,
          });
          return;
        }
      } catch (_) {
        // Non-fatal fallback to local cached apply payload.
      }

      applyPrefillData(data);
    } catch (_) { /* storage may be blocked in private mode */ }
  }());
}());

// Also sanitize the signature input so it only accepts valid name characters
(function setupSignatureField() {
  const sigInput = document.getElementById('signatureInput');
  if (!sigInput) return;
  sigInput.addEventListener('input', function () {
    const cleaned = sanitizeNameInput(this.value);
    if (cleaned !== this.value) { this.value = cleaned; }
  });
}());

// ----- File Upload Handling -----
function resetFileInfo() {
  const fileInfoEl = document.getElementById("fileInfo");
  if (!fileInfoEl) return;
  fileInfoEl.querySelector(".file-name").textContent = window.slyI18n ? window.slyI18n.t("booking.fileNotSelected") : "No file selected";
  fileInfoEl.querySelector(".file-size").textContent = "";
  fileInfoEl.classList.remove("has-file");
}

function resetBackFileInfo() {
  const el = document.getElementById("fileInfoBack");
  if (!el) return;
  el.querySelector(".file-name").textContent = window.slyI18n ? window.slyI18n.t("booking.fileNotSelected") : "No file selected";
  el.querySelector(".file-size").textContent = "";
  el.classList.remove("has-file");
}

function resetInsuranceFileInfo() {
  const el = document.getElementById("insuranceFileInfo");
  el.querySelector(".file-name").textContent = window.slyI18n ? window.slyI18n.t("booking.fileNotSelected") : "No file selected";
  el.querySelector(".file-size").textContent = "";
  el.classList.remove("has-file");
}

function clearInsuranceFile() {
  if (insuranceUpload) insuranceUpload.value = "";
  uploadedInsurance = null;
  resetInsuranceFileInfo();
}

// ----- Insurance Coverage Radio Buttons -----
document.getElementById("hasInsurance").addEventListener("change", function() {
  if (!this.checked) return;
  insuranceCoverageChoice = "yes";
  document.getElementById("insuranceUploadSection").style.display = "";
  document.getElementById("protectionPlanSection").style.display = "none";
  // Clear any protection-plan file state if previously "no"
  updateTotal();
  updatePayBtn();
});

document.getElementById("noInsurance").addEventListener("change", function() {
  if (!this.checked) return;
  insuranceCoverageChoice = "no";
  document.getElementById("insuranceUploadSection").style.display = "none";
  document.getElementById("protectionPlanSection").style.display = "";
  // Ensure the pre-selected tier radio is checked in the UI
  _syncProtectionTierRadio(selectedProtectionTier);
  // Clear the uploaded insurance file since it's no longer needed
  clearInsuranceFile();
  updateTotal();
  updatePayBtn();
});


// ----- Economy Car: Protection Plan Tier Selection -----
// Syncs the tier radio buttons in #protectionPlanSection to the given tier value.
function _syncProtectionTierRadio(tier) {
  const radio = document.querySelector('input[name="bookingProtectionPlan"][value="' + tier + '"]');
  if (radio) radio.checked = true;
}

// Attach change handlers to the tier radios.
(function setupProtectionTierListeners() {
  document.querySelectorAll('input[name="bookingProtectionPlan"]').forEach(function(radio) {
    radio.addEventListener("change", function() {
      if (!this.checked) return;
      selectedProtectionTier = this.value;
      updateTotal();
      updatePayBtn();
    });
  });
}());

if (idUpload) idUpload.addEventListener("change", function(e) {
  const file = e.target.files[0];

  if (!file) {
    uploadedFile = null;
    resetFileInfo();
    updatePayBtn();
    return;
  }

  // Validate file type — accept any image format (covers HEIC/HEIF from iPhone,
  // WebP, JPEG, PNG, BMP, etc.) plus PDF. Also fall back to extension check when
  // the browser reports an empty MIME type (some mobile browsers).
  const allowedExts = /\.(jpe?g|jpg|png|pdf|heic|heif|webp|bmp|gif|tiff?|avif)$/i;
  const isValidType = file.type.startsWith('image/') || file.type === 'application/pdf'
    || (file.type === '' && allowedExts.test(file.name));
  if (!isValidType) {
    alert(window.slyI18n.t("booking.alertIdType"));
    e.target.value = '';
    uploadedFile = null;
    resetFileInfo();
    updatePayBtn();
    return;
  }

  const idOtherBytes = (uploadedFileBack?.size || 0) + (uploadedInsurance?.size || 0);
  const idSizeErr = validateDocUploadSelection(file, idOtherBytes);
  if (idSizeErr) {
    alert(idSizeErr);
    e.target.value = "";
    uploadedFile = null;
    resetFileInfo();
    updatePayBtn();
    return;
  }

  uploadedFile = file;
  const fileInfoEl = document.getElementById("fileInfo");
  fileInfoEl.querySelector(".file-name").textContent = file.name;
  fileInfoEl.querySelector(".file-size").textContent = `(${(file.size / 1024).toFixed(1)} KB)`;
  fileInfoEl.classList.add("has-file");
  updatePayBtn();
});

if (idBackUpload) idBackUpload.addEventListener("change", function(e) {
  const file = e.target.files[0];

  if (!file) {
    uploadedFileBack = null;
    resetBackFileInfo();
    updatePayBtn();
    return;
  }

  const allowedExts = /\.(jpe?g|jpg|png|pdf|heic|heif|webp|bmp|gif|tiff?|avif)$/i;
  const isValidBackType = file.type.startsWith('image/') || file.type === 'application/pdf'
    || (file.type === '' && allowedExts.test(file.name));
  if (!isValidBackType) {
    alert(window.slyI18n.t("booking.alertIdType"));
    e.target.value = '';
    uploadedFileBack = null;
    resetBackFileInfo();
    updatePayBtn();
    return;
  }

  const idBackOtherBytes = (uploadedFile?.size || 0) + (uploadedInsurance?.size || 0);
  const idBackSizeErr = validateDocUploadSelection(file, idBackOtherBytes);
  if (idBackSizeErr) {
    alert(idBackSizeErr);
    e.target.value = "";
    uploadedFileBack = null;
    resetBackFileInfo();
    updatePayBtn();
    return;
  }

  uploadedFileBack = file;
  const backInfoEl = document.getElementById("fileInfoBack");
  backInfoEl.querySelector(".file-name").textContent = file.name;
  backInfoEl.querySelector(".file-size").textContent = `(${(file.size / 1024).toFixed(1)} KB)`;
  backInfoEl.classList.add("has-file");
  updatePayBtn();
});

if (insuranceUpload) insuranceUpload.addEventListener("change", function(e) {
  const file = e.target.files[0];

  if (!file) {
    uploadedInsurance = null;
    resetInsuranceFileInfo();
    updatePayBtn();
    return;
  }

  const rejectInsuranceUpload = function(message) {
    alert(message);
    e.target.value = "";
    uploadedInsurance = null;
    resetInsuranceFileInfo();
    updatePayBtn();
  };

  const allowedExts = /\.(jpe?g|jpg|png|pdf|heic|heif|webp|bmp|gif|tiff?|avif)$/i;
  const isValidInsType = file.type.startsWith('image/') || file.type === 'application/pdf'
    || (file.type === '' && allowedExts.test(file.name));
  if (!isValidInsType) {
    rejectInsuranceUpload(window.slyI18n.t("booking.alertInsuranceType"));
    return;
  }

  const insuranceOtherBytes = (uploadedFile?.size || 0) + (uploadedFileBack?.size || 0);
  const insuranceSizeErr = validateDocUploadSelection(file, insuranceOtherBytes);
  if (insuranceSizeErr) {
    rejectInsuranceUpload(insuranceSizeErr);
    return;
  }

  uploadedInsurance = file;
  const el = document.getElementById("insuranceFileInfo");
  el.querySelector(".file-name").textContent = file.name;
  el.querySelector(".file-size").textContent = `(${(file.size / 1024).toFixed(1)} KB)`;
  el.classList.add("has-file");
  updatePayBtn();
});


// Block past dates — only allow today or future dates
const todayStr = SlyLA.todayISO();
pickup.setAttribute("min", todayStr);
returnDate.setAttribute("min", todayStr);

agreeCheckbox.addEventListener("change", updatePayBtn);
if (smsConsentCheck) smsConsentCheck.addEventListener("change", updatePayBtn);
document.getElementById("name").addEventListener("input", updatePayBtn);
document.getElementById("email").addEventListener("input", updatePayBtn);
document.getElementById("phone").addEventListener("input", updatePayBtn);

// ----- Inline Rental Agreement / Signing -----
// Opens the inline agreement panel pre-filled with the current booking details.
// No external service is used — the customer reads the terms and types their
// full name as an electronic signature.  The typed name is stored in
// agreementSignature and included in the owner confirmation email.
document.getElementById("signAgreementBtn").addEventListener("click", function () {
  const renterName = document.getElementById("name").value.trim();
  const pickupVal  = document.getElementById("pickup").value;
  const returnVal  = document.getElementById("return").value;
  // Hoist lang to function scope so it is available throughout the handler
  // (e.g. for the payment terms section below) regardless of element presence.
  const lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";

  // Populate the agreement intro paragraph with live booking details
  const intro = document.getElementById("agreementIntro");
  if (intro) {
    const namePart   = renterName  ? `<strong>${renterName}</strong>` : "<strong>[Renter]</strong>";
    const carPart    = `<strong>${carData.name}</strong>`;
    const pickPart   = pickupVal  ? `<strong>${SlyLA.formatLocalDateTime(pickupVal, pickupTime.value)}</strong>`  : "<strong>[pickup date]</strong>";
    const retPart    = returnVal  ? `<strong>${SlyLA.formatLocalDateTime(returnVal, returnTime.value)}</strong>`  : "<strong>[return date]</strong>";
    if (lang === "es") {
      intro.innerHTML = `Este Contrato de Alquiler es celebrado entre Sly Car Rentals ("Empresa") y ${namePart} ("Arrendatario") para el alquiler de ${carPart} desde ${pickPart} hasta ${retPart}.`;
    } else {
      intro.innerHTML = `This Rental Agreement is entered into between Sly Car Rentals ("Company") and ${namePart} ("Renter") for the rental of a ${carPart} from ${pickPart} to ${retPart}.`;
    }
  }

  // Populate vehicle details section
  const elMake  = document.getElementById("agreementVehicleMake");
  const elModel = document.getElementById("agreementVehicleModel");
  const elYear  = document.getElementById("agreementVehicleYear");
  const elVin   = document.getElementById("agreementVehicleVin");
  const elColor = document.getElementById("agreementVehicleColor");
  const colorRow = document.getElementById("agreementColorRow");
  if (elMake)  elMake.textContent  = carData.make  || "";
  if (elModel) elModel.textContent = carData.model || "";
  if (elYear)  elYear.textContent  = carData.year  || "";
  if (elVin)   elVin.textContent   = carData.vin   || "";
  if (elColor) elColor.textContent = carData.color || "";
  if (colorRow) colorRow.style.display = carData.color ? "" : "none";

  // Update the Security Deposit section.
  // Camry vehicles have no security deposit — the entire section is hidden.
  const depositHeadingEl  = document.getElementById("agreementDepositHeading");
  const depositIntroEl    = document.getElementById("agreementDepositIntro");
  const depositInsEl      = document.getElementById("agreementDepositInsurance");
  const depositDppEl      = document.getElementById("agreementDepositDpp");
  const depositNeitherEl  = document.getElementById("agreementDepositNeither");
  const lateFeeGenericEl  = document.getElementById("lateFeeGeneric");
  // For Camry (economy): no security deposit — hide the entire deposit section.
  if (depositHeadingEl) depositHeadingEl.style.display = "none";
  if (depositIntroEl)   depositIntroEl.style.display   = "none";
  if (depositInsEl)     depositInsEl.style.display     = "none";
  if (depositDppEl)     depositDppEl.style.display     = "none";
  if (depositNeitherEl) depositNeitherEl.style.display = "none";
  // Show generic late fee
  if (lateFeeGenericEl) lateFeeGenericEl.style.display = "";

  // Populate the protection choice summary and update the
  // tier-specific liability cap text in the Insurance & Liability section.
    const protChoiceEl = document.getElementById("agreementProtectionChoice");
    const dppReducesEl = document.getElementById("agreementDppReduces");
    const withPlanEl   = document.getElementById("agreementWithPlanBody");
    // Compute tier info once so it can be reused in both the choice summary
    // and the liability-cap paragraphs below.
    const tierName = selectedProtectionTier === "basic" ? "Basic"
      : selectedProtectionTier === "premium" ? "Premium"
      : "Standard";
    const tierRate = selectedProtectionTier === "basic" ? PROTECTION_PLAN_BASIC
      : selectedProtectionTier === "premium" ? PROTECTION_PLAN_PREMIUM
      : PROTECTION_PLAN_STANDARD;
    const tierCap = selectedProtectionTier === "basic" ? "$2,500"
      : selectedProtectionTier === "premium" ? "$500"
      : "$1,000";
    // Build the all-tiers summary from the same source as the per-tier selection,
    // so the values stay in sync if tier rates/caps are ever updated.
    const allTiersCapsText = `Basic: $2,500 \u2022 Standard: $1,000 \u2022 Premium: $500`;
    if (protChoiceEl) {
      if (insuranceCoverageChoice === "yes") {
        protChoiceEl.innerHTML = "<strong>Your protection choice:</strong> You have provided your own personal auto insurance. Proof of insurance is required at pickup.";
        protChoiceEl.style.display = "";
      } else if (insuranceCoverageChoice === "no") {
        protChoiceEl.innerHTML = `<strong>Your protection choice:</strong> <strong>${tierName} Damage Protection Plan</strong> ($${tierRate}/day) — limits your damage liability to <strong>${tierCap} per incident</strong>.`;
        protChoiceEl.style.display = "";
      } else {
        protChoiceEl.style.display = "none";
      }
    }
    // Update the "reduces" and "with plan" paragraphs to show the correct
    // tier-specific liability cap.
    if (insuranceCoverageChoice === "no") {
      if (dppReducesEl) {
        dppReducesEl.removeAttribute("data-i18n-html");
        dppReducesEl.innerHTML = `This plan reduces the renter\u2019s financial responsibility for covered vehicle damage. Liability cap depends on plan selected (${allTiersCapsText} per incident). Your selected plan (<strong>${tierName}</strong>) limits your liability to <strong>${tierCap} per incident</strong>.`;
      }
      if (withPlanEl) {
        withPlanEl.removeAttribute("data-i18n-html");
        withPlanEl.innerHTML = `<strong>With Protection Plan:</strong> Renter\u2019s maximum liability for covered vehicle damage is limited to <strong>${tierCap} per incident</strong> under the selected plan. Any damage costs exceeding this cap are covered by the plan, provided all terms of this agreement are followed.`;
      }
    } else {
      // Restore generic tier-info text (in case the user switched from "no" to "yes" insurance).
      if (dppReducesEl && !dppReducesEl.hasAttribute("data-i18n-html")) {
        dppReducesEl.setAttribute("data-i18n-html", "agreement.dppReduces");
      }
      if (withPlanEl && !withPlanEl.hasAttribute("data-i18n-html")) {
        withPlanEl.setAttribute("data-i18n-html", "agreement.withPlanBody");
      }
    }

  // Update Payment Terms body to accurately describe when/how payment is collected.
  // Removing data-i18n prevents applyTranslations() from overwriting the corrected text.
  const paymentTermsBodyEl = document.getElementById("agreementPaymentTermsBody");
  if (paymentTermsBodyEl) {
    paymentTermsBodyEl.removeAttribute("data-i18n");
    var depositAmt = "$" + ((carData && carData.booking_deposit != null) ? carData.booking_deposit : FALLBACK_BOOKING_DEPOSIT);
    // Full payment online, OR per-vehicle deposit amount if renter chose "Reserve Now"
    paymentTermsBodyEl.textContent = lang === "es"
      ? "El pago completo del alquiler se cobra en l\u00EDnea al momento de la reserva. Si el arrendatario elige 'Reservar con dep\u00F3sito', solo se cobran " + depositAmt + " ahora y el saldo restante vence al momento de la recogida. Los pagos atrasados acumulan intereses del 1.5% mensual. Cargo por cheque devuelto (NSF): $35."
      : "Full rental payment is charged online at the time of booking. If the renter chose \u2018Reserve with Deposit\u2019, only " + depositAmt + " is charged now and the remaining balance is due at pickup. Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.";
  }

  // Pre-fill the signature field with the renter's name if already typed
  const sigInput = document.getElementById("signatureInput");
  if (sigInput && renterName && !sigInput.value) {
    sigInput.value = renterName;
    // Programmatic value assignment doesn't fire the 'input' event, so
    // manually sync the confirm button's disabled state to avoid the renter
    // having to delete and retype their name just to enable the button.
    document.getElementById("confirmSignBtn").disabled = false;
  }

  document.getElementById("rentalAgreementBox").style.display = "";
  if (window.slyI18n && typeof window.slyI18n.applyTranslations === "function") {
    window.slyI18n.applyTranslations();
  }
  this.style.display = "none";
  document.getElementById("signAgreementStatus").style.display = "none";
});

// Enable the confirm button only when the signature field has text
document.getElementById("signatureInput").addEventListener("input", function () {
  document.getElementById("confirmSignBtn").disabled = this.value.trim() === "";
  const sigError = document.getElementById("signatureError");
  if (sigError) { sigError.style.display = "none"; sigError.textContent = ""; }
});

// Confirm & Sign
document.getElementById("confirmSignBtn").addEventListener("click", function () {
  const sig = document.getElementById("signatureInput").value.trim();
  if (!sig) return;

  // Ensure the typed signature matches the Full Name entered in the booking form
  const renterName = document.getElementById("name").value.trim();
  const sigError = document.getElementById("signatureError");
  if (renterName && sig.toLowerCase() !== renterName.toLowerCase()) {
    if (sigError) {
      sigError.textContent = window.slyI18n ? window.slyI18n.t("booking.sigError") : "Signature must match the full name entered in the booking form.";
      sigError.style.display = "";
    }
    return;
  }

  agreementSignature = sig;

  document.getElementById("rentalAgreementBox").style.display = "none";
  document.getElementById("signAgreementBtn").style.display  = "";

  const btn    = document.getElementById("signAgreementBtn");
  const status = document.getElementById("signAgreementStatus");
  btn.classList.add("signed");
  btn.textContent = window.slyI18n ? window.slyI18n.t("booking.signedBtn") : "✅ Rental Agreement Signed";

  status.style.display = "";
  status.style.color   = "#4caf50";
  const signedByTpl = window.slyI18n ? window.slyI18n.t("booking.signedByNote") : "Signed by {name}. Check the box below to confirm.";
  status.textContent   = signedByTpl.replace("{name}", sig);

  const checkbox = document.getElementById("agree");
  checkbox.disabled = false;
  updatePayBtn();
});

// Cancel — close the panel and restore the button
document.getElementById("cancelSignBtn").addEventListener("click", function () {
  document.getElementById("rentalAgreementBox").style.display = "none";
  document.getElementById("signAgreementBtn").style.display  = "";
});

let returnPicker = null;

// Fixed time slots available for booking (displayed as options in the pickup time select).
const TIME_SLOTS = ["08:00 AM", "10:00 AM", "12:00 PM", "02:00 PM", "04:00 PM", "06:00 PM"];
// Minimum buffer (hours) between a car's return and the next available pickup slot.
const PICKUP_BUFFER_HOURS = 2;

// Module-level cache of booked ranges used by updatePickupTimeSlots().
// Populated (and refreshed) each time initDatePickers() fetches from the API.
let bookedRangesCache = [];

// Parse any supported time string ("HH:MM" or "h:MM AM/PM") combined with a
// YYYY-MM-DD date into a Unix-millisecond timestamp.  Returns NaN on failure.
function parseAnyTimeToMs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return NaN;
  const ampm = String(timeStr).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  const h24  = String(timeStr).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  let h, m;
  if (ampm) {
    h = parseInt(ampm[1], 10);
    m = parseInt(ampm[2], 10);
    const p = ampm[3].toUpperCase();
    if (p === "PM" && h !== 12) h += 12;
    if (p === "AM" && h === 12) h = 0;
  } else if (h24) {
    h = parseInt(h24[1], 10);
    m = parseInt(h24[2], 10);
  } else {
    return NaN;
  }
  // Use multi-argument constructor so there is no ISO-string UTC interpretation.
  return new Date(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)), h, m).getTime();
}

// Convert a "h:MM AM/PM" time slot string to "HH:MM" for native <input type="time">.
function timeSlotToHH(slot) {
  const m = String(slot).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return "";
  let h = parseInt(m[1], 10);
  const mins = m[2];
  const p = m[3].toUpperCase();
  if (p === "PM" && h !== 12) h += 12;
  if (p === "AM" && h === 12) h = 0;
  return String(h).padStart(2, "0") + ":" + mins;
}

// Returns true when the given slot on dateStr is blocked by an existing booking
// (i.e. the car hasn't been returned + buffered yet when this slot starts).
function isSlotBlocked(dateStr, slot, ranges) {
  const slotMs = parseAnyTimeToMs(dateStr, slot);
  if (isNaN(slotMs)) return false;
  for (const r of ranges) {
    if (r.to !== dateStr) continue; // only bookings returning on this date matter
    if (!r.toTime) {
      // Legacy entry without a return time: conservatively block the whole day.
      return true;
    }
    const returnMs = parseAnyTimeToMs(r.to, r.toTime);
    if (isNaN(returnMs)) continue;
    if (returnMs + PICKUP_BUFFER_HOURS * 3600000 > slotMs) return true;
  }
  return false;
}

// Populate the #pickupTime <select> with TIME_SLOTS, disabling any slot that
// falls within PICKUP_BUFFER_HOURS of an existing booking's return on that date.
// Option values are HH:MM (24-hour) for consistent backend transport; labels
// remain AM/PM for display.  Auto-selects the first available slot and syncs returnTime.
function updatePickupTimeSlots(selectedDate) {
  pickupTime.innerHTML = '<option value="">\u2014 Select a pickup time \u2014</option>';
  const noTimesMsg = document.getElementById("noTimesMsg");
  if (!selectedDate) {
    if (noTimesMsg) noTimesMsg.style.display = "none";
    updatePayBtn();
    return;
  }

  TIME_SLOTS.forEach(function(slot) {
    const opt = document.createElement("option");
    // Store the value as HH:MM (24-hour) so the backend always receives a
    // consistent format regardless of AM/PM display label.
    opt.value = timeSlotToHH(slot);
    opt.textContent = slot; // AM/PM label for the user

    if (IS_TEST_MODE_OVERRIDE) {
      opt.disabled = false;
    } else {
      opt.disabled = isSlotBlocked(selectedDate, slot, bookedRangesCache);
    }

    pickupTime.appendChild(opt);
  });

  // Auto-select the first non-disabled slot, or show "no times" warning.
  const firstAvail = pickupTime.querySelector("option:not([disabled]):not([value=''])");
  if (firstAvail) {
    firstAvail.selected = true;
    // Value is already HH:MM — assign directly without conversion.
    returnTime.value = firstAvail.value;
    if (noTimesMsg) noTimesMsg.style.display = "none";
  } else {
    returnTime.value = "";
    if (noTimesMsg) noTimesMsg.style.display = "";
  }

  updateTotal();
  updatePayBtn();
}

// Flag set to true inside initDatePickers() once Flatpickr takes over.
// Flatpickr already fires native change events after its own onChange, so
// the native listeners below must skip when Flatpickr is active to avoid
// calling updateTotal() twice on every selection.
// pickupTime is now a <select> and is handled by its own dedicated listener below.
let flatpickrActive = false;
[pickup, returnDate, returnTime].forEach(function(inp) {
  inp.addEventListener("change", function() {
    if (flatpickrActive) return; // Flatpickr's own onChange handles this
    updateTotal();
  });
});

// Dedicated change listener for the pickupTime <select>.
// Values are already HH:MM so returnTime is assigned directly.
pickupTime.addEventListener("change", function() {
  const slot = this.value; // HH:MM
  returnTime.value = slot || "";
  updateTotal();
  updatePayBtn();
});

  // ----- Date Pickers (Flatpickr) -----
async function initDatePickers() {
  if (typeof flatpickr === "undefined") return; // fallback to native inputs

  let bookedRanges = [];
  try {
    // Fetch from the Vercel API endpoint instead of the GitHub Pages static file.
    // GitHub Pages CDN caches files for several minutes after a commit, so the
    // static file often shows stale (empty) data even after a booking is saved.
    // The /api/booked-dates endpoint reads directly from the GitHub Contents API
    // with Cache-Control: no-store, so new bookings appear immediately.
    const resp = await fetch(`${API_BASE}/api/booked-dates`);
    if (resp.ok) {
      const data = await resp.json();
      bookedRanges = data[vehicleId] || [];
      bookedRangesCache = bookedRanges;
    }
  } catch (e) { console.error("Failed to load booked dates:", e); }

  // Pre-compile range boundaries to millisecond timestamps once so the
  // disable callback never allocates new Date objects per calendar cell.
  // End date is exclusive: the return date is not blocked in the calendar.
  const compiledRanges = bookedRanges.map(function(r) {
    return {
      from: new Date(r.from + "T00:00:00").getTime(),
      to:   new Date(r.to   + "T00:00:00").getTime()
    };
  });

  function isBooked(date) {
    if (IS_TEST_MODE_OVERRIDE) return false;
    const t = date.getTime();
    return compiledRanges.some(function(r) { return t >= r.from && t < r.to; });
  }

  const pickupPicker = flatpickr(pickup, {
    minDate: "today",
    disable: [isBooked],
    onChange: function(selectedDates) {
      if (selectedDates[0]) {
        if (carData.minRentalDays > 1) {
          const minReturn = new Date(selectedDates[0]);
          minReturn.setDate(minReturn.getDate() + carData.minRentalDays);
          if (returnPicker) returnPicker.set("minDate", minReturn);
        } else {
          if (returnPicker) returnPicker.set("minDate", selectedDates[0]);
        }
      }
      // Populate/refresh time slots for the newly selected pickup date.
      let dateStr = "";
      if (selectedDates[0]) {
        dateStr = window.SlyLA
          ? window.SlyLA.isoDateInLA(selectedDates[0])
          : selectedDates[0].toISOString().slice(0, 10);
      }
      updatePickupTimeSlots(dateStr);
    }
  });

  returnPicker = flatpickr(returnDate, {
    minDate: "today",
    disable: [isBooked],
    onChange: function() {
      updateTotal();
    }
  });

  // pickupTime is now a <select> — no Flatpickr needed.
  // returnTime mirrors pickupTime and is set programmatically; no Flatpickr needed.

  // Flatpickr is now fully active; native change listeners will defer to it.
  flatpickrActive = true;
}

initDatePickers();

// ----- Fleet Status Check -----
// Fetch the vehicle's availability from the fleet-status API.  If the vehicle
// is unavailable (active booking exists), replace the booking form with the
// Extend Rental section.
// Fails open on any API error so transient outages do not lock out the form.

// When ?extend=1 is present the user came from the "Extend Rental" button on
// cars.html — show the extend section immediately without waiting for fleet-status.
if (/^(true|1)$/i.test(pageParams.get("extend") || "")) {
  showVehicleUnavailable(null, null);
}

(async function checkFleetStatus() {
  if (IS_TEST_MODE_OVERRIDE) return;
  try {
    const fleetResp = await fetch(`${API_BASE}/api/fleet-status`);
    if (!fleetResp.ok) return;
    const status = await fleetResp.json();

    const entry = status[vehicleId];
    const isUnavailable = !!(entry && entry.available === false);

    if (isUnavailable) {
      const idsToCheck = [vehicleId]; // single vehicle for Camry

      let availableAt = null;
      let nextAvailableDisplay = null;
      for (const id of idsToCheck) {
        const entry = status[id];
        if (entry && entry.available === false) {
          if (entry.available_at) {
            if (!availableAt || entry.available_at < availableAt) {
              availableAt = entry.available_at;
              nextAvailableDisplay = entry.next_available_display || null;
            }
          } else if (!nextAvailableDisplay && entry.next_available_display) {
            // Date-only block (no end_time): capture display string for date-only unavailability.
            nextAvailableDisplay = entry.next_available_display;
          }
        }
      }

      showVehicleUnavailable(availableAt, nextAvailableDisplay);
    }
  } catch (err) {
    console.warn("Could not check fleet status:", err);
  }
})();

function showVehicleUnavailable(nextAvailableISO, nextAvailableDisplay) {
  const bookingSection = document.querySelector(".booking");
  if (!bookingSection) return;

  if (nextAvailableISO) {
    // Set minimum new return date in the extend form to the current return date
    // (i.e. the date the vehicle becomes available) so the customer cannot pick
    // a date before the active rental ends.
    const extReturn = document.getElementById("extNewReturn");
    if (extReturn) {
      let minDate = SlyLA.todayISO();
      const d2 = new Date(nextAvailableISO);
      if (Number.isFinite(d2.getTime())) {
        // Compare LA-timezone date strings to avoid timezone/DST edge cases.
        const returnDateISO = SlyLA.isoDateInLA(d2);
        if (returnDateISO > minDate) minDate = returnDateISO;
      }
      extReturn.setAttribute("min", minDate);
    }
  }

  // ── Hide the regular booking form elements ────────────────────────────
  // Hide the heading and all regular form inputs/sections.  The extend rental
  // section is shown below instead so there are no duplicate "reserve" CTAs.
  const bookingHeading = bookingSection.querySelector("h2");
  if (bookingHeading) bookingHeading.style.display = "none";

  const regularIds = [
    "paymentRetryBanner",
    "pickup", "pickupTime", "returnDateSection",
    "name", "email", "phone",
    "nameError",
    "idSection", "idUpload", "idBackUpload", "fileInfo", "fileInfoBack",
    "insuranceSection",
    "hasInsurance", "noInsurance",
    "insuranceUploadSection", "protectionPlanSection",
    "signAgreementBtn", "signAgreementStatus", "rentalAgreementBox",
    "camryDepositNotice",
    "priceBreakdown", "subtotal", "taxLine", "taxNote",
    "payHint", "reserveBtn", "stripePay",
    "payment-express-wrap", "payment-form",
    "smsConsent",
  ];
  regularIds.forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  // Also hide labels and blocks that only have for= attributes, using a broader selector
  bookingSection.querySelectorAll(
    'label[for="pickup"], label[for="pickupTime"], label[for="return"], label[for="returnTime"], ' +
    'label[for="name"], label[for="email"], label[for="phone"], label[for="idUpload"], label[for="idBackUpload"], ' +
    'label[for="insuranceUpload"], ' +
    '.sms-consent, .total, .pay-hint, .insurance-question, .insurance-options, ' +
    '.id-section, .insurance-upload-section, .protection-plan-section, ' +
    '#insuranceCoverage, .insurance-label'
  ).forEach(function(el) { el.style.display = "none"; });

  // Disable all remaining interactive elements so they cannot be submitted
  bookingSection.querySelectorAll("input, button, select, textarea").forEach(function(el) {
    if (!el.closest("#extendRentalSection")) el.disabled = true;
  });

  // ── Show the Extend Rental section ────────────────────────────────────
  const extendSection = document.getElementById("extendRentalSection");
  if (extendSection) {
    extendSection.style.display = "";
    // Fallback: ensure min is set to at least today if not already set above.
    const extReturn = document.getElementById("extNewReturn");
    if (extReturn && !extReturn.getAttribute("min")) {
      extReturn.setAttribute("min", SlyLA.todayISO());
    }
    // Update subtitle to show when the car is next available, if known.
    const subtitle = extendSection.querySelector(".waitlist-subtitle");
    if (subtitle) {
      if (nextAvailableDisplay) {
        subtitle.textContent = `This vehicle is currently rented \u2014 available again: ${nextAvailableDisplay}. If you are the current renter, enter your contact info below to extend your rental period.`;
      } else {
        subtitle.textContent = "This vehicle is currently rented. If you are the current renter, enter your contact info below to extend your rental period.";
      }
    }
    // Initialize the extend rental form interactions
    initExtendRentalForm();
  }
}

// ----- Extend Rental Form -----
// Manages the "Extend Rental" form that is shown when the vehicle is currently
// rented.  The current renter enters their email/phone and new return date,
// then pays the extension charge via Stripe.
function initExtendRentalForm() {
  var extEmail      = document.getElementById("extEmail");
  var extPhone      = document.getElementById("extPhone");
  var extNewReturn  = document.getElementById("extNewReturn");
  var extCustomAmount = document.getElementById("extCustomAmount");
  var extSubmitBtn  = document.getElementById("extSubmitBtn");
  var extPayHint    = document.getElementById("extPayHint");
  var extPriceDisplay = document.getElementById("extPriceDisplay");
  var extPriceAmount  = document.getElementById("extPriceAmount");
  var extPartialHint  = document.getElementById("extPartialHint");

  // Set today as the minimum new return date
  var todayISO = SlyLA.todayISO();
  if (extNewReturn && !extNewReturn.getAttribute("min")) {
    extNewReturn.setAttribute("min", todayISO);
  }

  // Shared state updated by updatePriceEstimate() and read by updateExtBtn().
  var extPriceData = { days: 0, dailyRate: 55, fullCost: 0, minPayment: 0 };

  function isValidEmailFmt(val) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
  }

  // Compute and display a client-side extension price estimate.
  // The server will recompute the authoritative amount; this is just a preview.
  function updatePriceEstimate() {
    if (!extNewReturn || !extNewReturn.value) {
      if (extPriceDisplay) extPriceDisplay.style.display = "none";
      if (extPartialHint) extPartialHint.style.display = "none";
      return;
    }

    var today = SlyLA.todayISO();
    var newReturn = extNewReturn.value;
    if (newReturn <= today) {
      if (extPriceDisplay) extPriceDisplay.style.display = "none";
      if (extPartialHint) extPartialHint.style.display = "none";
      return;
    }

    if (!carData) {
      if (extPriceDisplay) extPriceDisplay.style.display = "none";
      if (extPartialHint) extPartialHint.style.display = "none";
      return;
    }

    // Base date for computing extra days: use the current booking's return date
    // (stored as the min attribute on the date input) so the estimate matches
    // what the server charges.  Falls back to today if min is not set or is in
    // the past (e.g. overdue rentals).
    var minDate = extNewReturn.getAttribute("min") || today;
    var baseDate = minDate > today ? minDate : today;

    // Use the same tiered pricing as the main booking flow
    var extraDays = Math.max(1, Math.ceil((new Date(newReturn) - new Date(baseDate)) / (1000 * 3600 * 24)));
    var daily   = carData.pricePerDay  || 55;
    var weekly  = carData.weekly       || 350;
    var biweek  = carData.biweekly     || 650;
    var monthly = carData.monthly      || 1300;

    var cost2 = 0;
    var rem   = extraDays;
    if (rem >= 30) { cost2 += Math.floor(rem / 30) * monthly;  rem = rem % 30; }
    if (rem >= 14) { cost2 += Math.floor(rem / 14) * biweek;   rem = rem % 14; }
    if (rem >= 7)  { cost2 += Math.floor(rem / 7)  * weekly;   rem = rem % 7;  }
    cost2 += rem * daily;

    // Phase 1: compute minimum partial payment (half of extension at daily rate).
    var minDays = Math.ceil(extraDays / 2);
    var minPayment = minDays * daily;

    // Store for use in updateExtBtn().
    extPriceData = { days: extraDays, dailyRate: daily, fullCost: cost2, minPayment: minPayment };

    if (extPriceAmount) extPriceAmount.textContent = cost2.toFixed(0);
    if (extCustomAmount) {
      extCustomAmount.setAttribute("max", cost2.toFixed(2));
    }

    // Show minimum partial payment hint.
    if (extPartialHint) {
      extPartialHint.textContent = "Partial payment minimum: $" + minPayment.toFixed(0) +
        " (" + minDays + " of " + extraDays + " day" + (extraDays !== 1 ? "s" : "") +
        " × $" + daily + "/day)";
      extPartialHint.style.color = "#aaa";
      extPartialHint.style.display = "";
    }

    if (extPriceDisplay) extPriceDisplay.style.display = "";

    // If the booking context indicates active late fees or overdue state, surface
    // a disclaimer so the renter sees it BEFORE clicking "Extend Rental".
    // The server computes the authoritative final amount (including late fees);
    // the estimate above does not include them.
    var extFeeDisclaimer = document.getElementById("extLateFeeDisclaimer");
    if (extFeeDisclaimer && extensionBookingContext) {
      var ctxLateFeeStatus = String(extensionBookingContext.lateFeeStatus || "").trim().toLowerCase();
      var ctxLateFeeAmt = Number(extensionBookingContext.lateFeeAmount || 0);
      var ctxIsOverdue = !!extensionBookingContext.isOverdueStage;
      if ((ctxLateFeeStatus === "assessed" || ctxLateFeeStatus === "pending_collection") && ctxLateFeeAmt > 0) {
        extFeeDisclaimer.textContent = "Note: $" + ctxLateFeeAmt.toFixed(2) + " late fee will be added at checkout.";
        extFeeDisclaimer.style.display = "";
      } else if (ctxIsOverdue) {
        extFeeDisclaimer.textContent = "Note: Late fees may apply. Final amount confirmed at checkout.";
        extFeeDisclaimer.style.display = "";
      } else {
        extFeeDisclaimer.style.display = "none";
      }
    }
  }

  function updateExtBtn() {
    var emailOk  = extEmail && isValidEmailFmt(extEmail.value.trim());
    var phoneOk  = extPhone && extPhone.value.trim().length >= 7;
    var dateOk   = extNewReturn && extNewReturn.value;
    var customAmountRaw = extCustomAmount ? extCustomAmount.value.trim() : "";
    var customAmount = customAmountRaw ? Number(customAmountRaw) : null;

    // Phase 1: validate partial payment minimum when an amount is entered.
    var customAmountOk = true;
    if (customAmountRaw) {
      if (!Number.isFinite(customAmount) || customAmount <= 0) {
        customAmountOk = false;
      } else if (extPriceData.days > 0 && customAmount < extPriceData.fullCost) {
        // Partial payment — check minimum requirement.
        if (customAmount < extPriceData.minPayment) {
          customAmountOk = false;
          if (extPartialHint) {
            extPartialHint.textContent = "Partial extensions require payment covering at least half of the requested extension days. Minimum: $" +
              extPriceData.minPayment.toFixed(0) + " (" + Math.ceil(extPriceData.days / 2) + " day" +
              (Math.ceil(extPriceData.days / 2) !== 1 ? "s" : "") + " × $" + extPriceData.dailyRate + "/day).";
            extPartialHint.style.color = "#f87171";
            extPartialHint.style.display = "";
          }
        } else if (extPartialHint) {
          // Amount is valid — restore informational hint color.
          var minDays2 = Math.ceil(extPriceData.days / 2);
          extPartialHint.textContent = "Partial payment minimum: $" + extPriceData.minPayment.toFixed(0) +
            " (" + minDays2 + " of " + extPriceData.days + " day" + (extPriceData.days !== 1 ? "s" : "") +
            " × $" + extPriceData.dailyRate + "/day)";
          extPartialHint.style.color = "#aaa";
        }
      }
    }

    var contactOk = emailOk || phoneOk;
    var ready    = contactOk && dateOk && customAmountOk;
    if (extSubmitBtn) extSubmitBtn.disabled = !ready;
    if (extPayHint) extPayHint.style.display = ready ? "none" : "";
  }

  [extEmail, extPhone, extCustomAmount].forEach(function(el) {
    if (el) el.addEventListener("input", updateExtBtn);
  });

  if (extNewReturn) {
    extNewReturn.addEventListener("change", function() {
      updatePriceEstimate();
      updateExtBtn();
    });
  }
  updateExtBtn();

  if (extSubmitBtn) {
    extSubmitBtn.addEventListener("click", launchExtendRentalPayment);
  }
}

async function launchExtendRentalPayment() {
  var extEmail      = document.getElementById("extEmail").value.trim();
  var extPhone      = (document.getElementById("extPhone") || {}).value || "";
  var newReturnDate = document.getElementById("extNewReturn").value;
  var extCustomAmountEl = document.getElementById("extCustomAmount");
  var customAmountRaw = extCustomAmountEl ? extCustomAmountEl.value.trim() : "";
  var customPaymentAmount = customAmountRaw ? Number(customAmountRaw) : null;
  if (customAmountRaw && (!Number.isFinite(customPaymentAmount) || customPaymentAmount <= 0)) {
    alert("Enter a valid custom payment amount.");
    return;
  }

  var submitBtn = document.getElementById("extSubmitBtn");
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = _t("booking.loadingPayment", "Loading payment…"); }

  try {
    var resp = await fetch(API_BASE + "/api/extend-rental", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vehicleId,
        email:         extEmail,
        phone:         extPhone.trim(),
        newReturnDate,
        ...(customPaymentAmount != null ? { customPaymentAmount } : {}),
      }),
    });
    var data = await resp.json();
    if (!resp.ok) {
      // Phase 1: surface the minimum-payment error with a clear message.
      var errMsg = data.error || "Server error";
      if (data.minimumPayment) {
        var partialHintEl = document.getElementById("extPartialHint");
        if (partialHintEl) {
          partialHintEl.textContent = errMsg;
          partialHintEl.style.color = "#f87171";
          partialHintEl.style.display = "";
        }
      }
      throw new Error(errMsg);
    }

    var {
      clientSecret,
      publishableKey,
      extensionAmount,
      extensionTotal,
      amountPaidNow,
      remainingBalance,
      extensionPaymentStatus,
      extensionLabel,
      lateFeeIncluded,
      deferredLateFee,
      newReturnDate: confirmedDate,
      newReturnTime: confirmedTime,
      vehicleName,
      renterName,
      extensionFinancialTrace,
    } = data;
    if (!clientSecret || !publishableKey) throw new Error("Invalid server response");

    // Log the structured financial trace from the server for auditability.
    if (extensionFinancialTrace && IS_EXTENSION_FLOW) {
      logExtensionTrace("extension_financial_trace_received", extensionFinancialTrace);
    }
    var payNowAmount = amountPaidNow || extensionAmount;
    var fullExtensionTotal = extensionTotal || extensionAmount;
    var remainingAfterPayment = remainingBalance || "0.00";

    var stripe   = Stripe(publishableKey);
    var elements = stripe.elements({
      clientSecret,
      locale: (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en",
      ...(extEmail ? { defaultValues: { billingDetails: { email: extEmail } } } : {}),
    });
    var successUrl = window.location.origin + "/success.html?ext=1&vehicle=" + encodeURIComponent(vehicleId);

    var paymentElement = elements.create("payment");

    // Show the Stripe payment form; hide the sign-up form
    var extForm = document.getElementById("extendRentalForm");
    if (extForm) extForm.style.display = "none";
    var extPayForm = document.getElementById("extPaymentForm");
    if (extPayForm) extPayForm.style.display = "";

    // Populate the summary box
    var summaryEl = document.getElementById("ext-rental-summary");
    if (summaryEl) {
      var displayReturn = SlyLA.formatLocalDateTime(confirmedDate, confirmedTime);
      var lateFeeHtml = "";
      if (lateFeeIncluded && Number(lateFeeIncluded) > 0) {
        lateFeeHtml += "Late return fee: $" + Number(lateFeeIncluded).toFixed(2) + "<br>";
      }
      if (deferredLateFee && Number(deferredLateFee) > 0) {
        lateFeeHtml += "Previously deferred late fee: $" + Number(deferredLateFee).toFixed(2) + "<br>";
      }
      summaryEl.innerHTML =
        "<strong>⏱️ Rental Extension</strong><br>" +
        (vehicleName ? "Vehicle: " + vehicleName + "<br>" : "") +
        (renterName  ? "Renter: "  + renterName  + "<br>" : "") +
        "Extension: " + extensionLabel + "<br>" +
        lateFeeHtml +
        "<strong>New Return: " + displayReturn + "</strong><br>" +
        "<strong style='color:#ffb400'>Extension Total: $" + fullExtensionTotal + "</strong><br>" +
        "<strong style='color:#ffb400'>Paying Now: $" + payNowAmount + "</strong>" +
        (Number(remainingAfterPayment) > 0
          ? ("<br><strong style='color:#f59e0b'>Remaining Balance: $" + remainingAfterPayment + " (" + (extensionPaymentStatus || "partially_paid") + ")</strong>")
          : "");
    }

    // Update the pay button label
    var extPayAmount = document.getElementById("extPayAmount");
    if (extPayAmount) extPayAmount.textContent = payNowAmount;

    var submitPayBtn = document.getElementById("ext-submit-payment");
    var cancelPayBtn = document.getElementById("ext-cancel-payment");
    var msgEl        = document.getElementById("ext-payment-message");
    var extExpressWrap = document.getElementById("ext-express-wrap");
    var extExpressContainer = document.getElementById("ext-express-checkout");
    var extExpressEl = null;
    if (extExpressWrap) extExpressWrap.style.display = "none";
    if (extExpressContainer) extExpressContainer.innerHTML = "";
    try {
      extExpressEl = elements.create("expressCheckout", {
        wallets: {
          applePay: "auto",
          googlePay: "auto",
          cashApp: "auto",
        },
      });
      extExpressEl.on("ready", function(event) {
        var methods = event && event.availablePaymentMethods ? event.availablePaymentMethods : null;
        var hasWalletMethod = !!(methods && Object.keys(methods).some(function(key) { return !!methods[key]; }));
        if (extExpressWrap) extExpressWrap.style.display = hasWalletMethod ? "block" : "none";
      });
      extExpressEl.on("confirm", async function() {
        if (msgEl) msgEl.textContent = "";
        try {
          var result = await stripe.confirmPayment({
            elements,
            confirmParams: {
              return_url: successUrl,
              ...(extEmail ? { receipt_email: extEmail } : {}),
            },
            redirect: "if_required",
          });
          if (result.error) {
            if (msgEl) msgEl.textContent = result.error.message || "Payment failed. Please try again.";
            return;
          }
          if (result.paymentIntent && result.paymentIntent.status === "succeeded") {
            window.location.href = successUrl;
          }
        } catch (err) {
          if (msgEl) msgEl.textContent = "Payment failed. Please try again.";
          console.error("[car.js] extension express checkout confirm error:", err);
        }
      });
      extExpressEl.mount("#ext-express-checkout");
    } catch (err) {
      console.warn("[car.js] extension express checkout unavailable:", err && err.message ? err.message : err);
      if (extExpressWrap) extExpressWrap.style.display = "none";
    }

    paymentElement.mount("#ext-payment-element");

    var submitting = false;

    var handleExtSubmit = async function() {
      if (submitting) return;
      submitting = true;
      submitPayBtn.disabled    = true;
      submitPayBtn.innerHTML   = _t("booking.processingPayment", "Processing…");
      if (msgEl) msgEl.textContent = "";

      var result = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: successUrl,
          ...(extEmail ? { receipt_email: extEmail } : {}),
        },
      });

      if (result.error) {
        if (msgEl) msgEl.textContent = result.error.message;
        submitPayBtn.disabled  = false;
        submitPayBtn.innerHTML = "Pay $" + payNowAmount + " Now 🔒";
        submitting = false;
      }
      // On success Stripe redirects — no cleanup needed here
    };
    submitPayBtn.addEventListener("click", handleExtSubmit);

    var handleExtCancel = function() {
      submitting = false;
      submitPayBtn.removeEventListener("click", handleExtSubmit);
      cancelPayBtn.removeEventListener("click", handleExtCancel);
      if (extExpressEl) {
        try { extExpressEl.unmount(); } catch (_err) {}
      }
      if (extExpressContainer) extExpressContainer.innerHTML = "";
      if (extExpressWrap) extExpressWrap.style.display = "none";
      paymentElement.unmount();
      if (msgEl) msgEl.textContent = "";
      if (extPayForm) extPayForm.style.display = "none";
      if (extForm) extForm.style.display = "";
      // Re-enable the extend button
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "⏱️ Extend Rental";
      }
    };
    cancelPayBtn.addEventListener("click", handleExtCancel);

  } catch (err) {
    console.error("Extend rental payment error:", err);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "⏱️ Extend Rental";
    }
    alert(err.message || _t("booking.loadError", "Could not launch payment. Please try again."));
  }
}


// ----- Payment Retry Pre-fill -----
// Converts a Base64 string (stored in IndexedDB) back into a Blob.
function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    bytes[i] = byteChars.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

// Restores all form fields, insurance choice, signature, and uploaded files
// from a previous payment attempt that ended in failure.  Called on every
// pageshow so it works for both fresh page loads and bfcache restores.
function restoreFailedBooking() {
  try {
    const stored = sessionStorage.getItem("slyRidesBooking");
    if (!stored) return;
    const data = JSON.parse(stored);
    if (!data.paymentFailed) return;

    // Helper: set a date/time input respecting Flatpickr when active.
    // For native <input type="time"> fallback, converts "h:i K" (e.g. "2:30 PM")
    // to "HH:MM" which is the format the native input requires.
    // For <select> elements (pickupTime), just sets the value directly.
    function fpSet(input, value) {
      if (!value || !input) return;
      if (input.tagName === "SELECT") {
        input.value = value;
        return;
      }
      if (flatpickrActive && input._flatpickr) {
        input._flatpickr.setDate(value, true);
      } else {
        // Normalize Flatpickr "h:i K" time format → "HH:MM" for native time inputs
        const ampm = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        if (ampm) {
          let h = parseInt(ampm[1], 10);
          const mins = ampm[2];
          const period = ampm[3].toUpperCase();
          if (period === "PM" && h !== 12) h += 12;
          if (period === "AM" && h === 12) h = 0;
          input.value = String(h).padStart(2, "0") + ":" + mins;
        } else {
          input.value = value;
        }
      }
    }

    // Restore personal details
    const nameField  = document.getElementById("name");
    const emailField = document.getElementById("email");
    const phoneField = document.getElementById("phone");
    if (data.name  && nameField)  nameField.value  = data.name;
    if (data.email && emailField) emailField.value = data.email;
    if (data.phone && phoneField) phoneField.value = data.phone;

    // Restore dates / times
    fpSet(pickup, data.pickup);
    // Populate time slots for the restored pickup date before restoring the selected time.
    if (data.pickup) updatePickupTimeSlots(data.pickup.slice(0, 10));
    fpSet(pickupTime, data.pickupTime);
    // Sync returnTime to match restored pickupTime
    // pickupTime.value is HH:MM; if legacy stored value is AM/PM, convert it.
    if (data.pickupTime) returnTime.value = timeSlotToHH(data.pickupTime) || data.pickupTime;
    fpSet(returnDate, data.returnDate);

    // Restore insurance / protection-plan choice.
    // insuranceCoverageChoice is saved explicitly in the failed-payment entry
    // since v2 of this feature.  The legacy fallback (from protectionPlan /
    // insuranceFileName) handles entries persisted by an earlier release.
    const choice = data.insuranceCoverageChoice ||
      (data.protectionPlan === true ? "no" : (data.insuranceFileName ? "yes" : null));
    if (choice) {
      insuranceCoverageChoice = choice;
      const hasInsuranceRadio   = document.getElementById("hasInsurance");
      const noInsuranceRadio    = document.getElementById("noInsurance");
      const insuranceSection    = document.getElementById("insuranceUploadSection");
      const protectionSection   = document.getElementById("protectionPlanSection");
      if (choice === "yes") {
        if (hasInsuranceRadio) hasInsuranceRadio.checked = true;
        if (insuranceSection)  insuranceSection.style.display  = "";
        if (protectionSection) protectionSection.style.display = "none";
      } else {
        if (noInsuranceRadio)  noInsuranceRadio.checked  = true;
        if (insuranceSection)  insuranceSection.style.display  = "none";
        // Restore the protection plan tier
        if (data.protectionPlanTier) {
          selectedProtectionTier = data.protectionPlanTier;
        }
        if (protectionSection) protectionSection.style.display = "";
        _syncProtectionTierRadio(selectedProtectionTier);
      }
    }

    // Restore signed-agreement state
    if (data.signature) {
      agreementSignature = data.signature;
      const signBtn    = document.getElementById("signAgreementBtn");
      const signStatus = document.getElementById("signAgreementStatus");
      if (signBtn) {
        signBtn.classList.add("signed");
        signBtn.textContent = window.slyI18n ? window.slyI18n.t("booking.signedBtn") : "✅ Rental Agreement Signed";
        signBtn.style.display = "";
      }
      if (signStatus) {
        signStatus.style.display = "";
        signStatus.style.color   = "#4caf50";
        const tpl = window.slyI18n ? window.slyI18n.t("booking.signedByNote") : "Signed by {name}. Check the box below to confirm.";
        signStatus.textContent   = tpl.replace("{name}", data.signature);
      }
      agreeCheckbox.disabled = false;
      agreeCheckbox.checked  = true;
    }

    // Show the retry banner so the renter knows the form was pre-filled
    const retryBanner = document.getElementById("paymentRetryBanner");
    if (retryBanner) retryBanner.style.display = "";

    updateTotal();
    // Defer updatePayBtn until after the async IndexedDB file restoration
    // finishes so it only runs once with a complete picture of the form state.

    // Restore uploaded files from IndexedDB (async, finishes with updatePayBtn)
    try {
      const idbReq = indexedDB.open("slyRidesDB", 1);
      idbReq.onupgradeneeded = function(e) { e.target.result.createObjectStore("files"); };
      idbReq.onsuccess = function(e) {
        const db = e.target.result;
        try {
          const tx  = db.transaction("files", "readonly");
          const req = tx.objectStore("files").get("pendingId");
          req.onsuccess = function(ev) {
            const fileData = ev.target.result;
            db.close();
            if (!fileData) { updatePayBtn(); return; }

            if (fileData.idBase64 && fileData.idFileName && fileData.idMimeType) {
              const blob = base64ToBlob(fileData.idBase64, fileData.idMimeType);
              uploadedFile = new File([blob], fileData.idFileName, { type: fileData.idMimeType });
              const fileInfoEl = document.getElementById("fileInfo");
              if (fileInfoEl) {
                fileInfoEl.querySelector(".file-name").textContent = fileData.idFileName;
                fileInfoEl.querySelector(".file-size").textContent = `(${(blob.size / 1024).toFixed(1)} KB)`;
                fileInfoEl.classList.add("has-file");
              }
            }

            if (fileData.idBackBase64 && fileData.idBackFileName && fileData.idBackMimeType) {
              const blob = base64ToBlob(fileData.idBackBase64, fileData.idBackMimeType);
              uploadedFileBack = new File([blob], fileData.idBackFileName, { type: fileData.idBackMimeType });
              const backInfoEl = document.getElementById("fileInfoBack");
              if (backInfoEl) {
                backInfoEl.querySelector(".file-name").textContent = fileData.idBackFileName;
                backInfoEl.querySelector(".file-size").textContent = `(${(blob.size / 1024).toFixed(1)} KB)`;
                backInfoEl.classList.add("has-file");
              }
            }

            if (choice === "yes" && fileData.insuranceBase64 && fileData.insuranceFileName && fileData.insuranceMimeType) {
              const blob = base64ToBlob(fileData.insuranceBase64, fileData.insuranceMimeType);
              uploadedInsurance = new File([blob], fileData.insuranceFileName, { type: fileData.insuranceMimeType });
              const insEl = document.getElementById("insuranceFileInfo");
              if (insEl) {
                insEl.querySelector(".file-name").textContent = fileData.insuranceFileName;
                insEl.querySelector(".file-size").textContent = `(${(blob.size / 1024).toFixed(1)} KB)`;
                insEl.classList.add("has-file");
              }
            }

            updatePayBtn();
          };
          req.onerror = function() { db.close(); updatePayBtn(); };
        } catch (idbErr) { console.warn("restoreFailedBooking: IDB transaction error:", idbErr); db.close(); updatePayBtn(); }
      };
      idbReq.onerror = function() { console.warn("restoreFailedBooking: IDB open error"); updatePayBtn(); };
    } catch (idbErr) { console.warn("restoreFailedBooking: IDB unavailable:", idbErr); updatePayBtn(); }
  } catch (err) { console.warn("restoreFailedBooking: could not restore booking data:", err); }
}

// When the browser restores this page from bfcache (e.g. user hits "back"
// after the Stripe redirect), all field values and UI state from the previous
// renter's session would still be visible.  Resetting here ensures each new
// visitor starts with a completely blank form.
window.addEventListener("pageshow", function(e) {
  if (e.persisted) {
  document.getElementById("name").value = "";
  document.getElementById("email").value = "";
  document.getElementById("phone").value = "";
  pickup.value = "";
  returnDate.value = "";
  pickupTime.innerHTML = '<option value="">\u2014 Select a pickup time \u2014</option>';
  pickupTime.value = "";
  returnTime.value = "";
  if (idUpload) idUpload.value = "";
  uploadedFile = null;
  resetFileInfo();
  if (idBackUpload) idBackUpload.value = "";
  uploadedFileBack = null;
  resetBackFileInfo();
  clearInsuranceFile();
  // Reset insurance coverage radio buttons
  const hasInsuranceRadio = document.getElementById("hasInsurance");
  const noInsuranceRadio = document.getElementById("noInsurance");
  if (hasInsuranceRadio) hasInsuranceRadio.checked = false;
  if (noInsuranceRadio) noInsuranceRadio.checked = false;
  insuranceCoverageChoice = null;
  const insuranceUploadSection = document.getElementById("insuranceUploadSection");
  const protectionPlanSection = document.getElementById("protectionPlanSection");
  if (insuranceUploadSection) insuranceUploadSection.style.display = "none";
  if (protectionPlanSection) protectionPlanSection.style.display = "none";
  const signBtn = document.getElementById("signAgreementBtn");
  signBtn.classList.remove("signed");
  signBtn.textContent = window.slyI18n ? window.slyI18n.t("booking.signAgreementBtn") : "✍ Review & Sign Rental Agreement";
  signBtn.style.display = "";
  const agreementBox = document.getElementById("rentalAgreementBox");
  if (agreementBox) agreementBox.style.display = "none";
  const sigInput = document.getElementById("signatureInput");
  if (sigInput) sigInput.value = "";
  const confirmBtn = document.getElementById("confirmSignBtn");
  if (confirmBtn) confirmBtn.disabled = true;
  agreementSignature = "";
  const status = document.getElementById("signAgreementStatus");
  status.style.display = "none";
  status.textContent = "";
  agreeCheckbox.disabled = true;
  agreeCheckbox.checked = false;
  if (smsConsentCheck) { smsConsentCheck.disabled = false; smsConsentCheck.checked = false; }
  const paymentForm = document.getElementById("payment-form");
  paymentForm.style.display = "none";
  const paymentExpressWrap = document.getElementById("payment-express-wrap");
  if (paymentExpressWrap) paymentExpressWrap.style.display = "none";
  const paymentExpressContainer = document.getElementById("payment-express-checkout");
  if (paymentExpressContainer) paymentExpressContainer.innerHTML = "";
  document.getElementById("payment-message").textContent = "";
  stripeBtn.style.display = "";
  stripeBtn.textContent = window.slyI18n.t("booking.payNow");
  const _reserveBtnReset = document.getElementById("reserveBtn");
  if (_reserveBtnReset) {
    _reserveBtnReset.style.display = "";
    _reserveBtnReset.disabled = true;
  }
  _pendingPaymentMode = null;
  totalEl.textContent = "0";
  document.getElementById("subtotal").textContent = "0";
  document.getElementById("taxLine").style.display = "none";
  const taxNoteReset = document.getElementById("taxNote");
  if (taxNoteReset) taxNoteReset.style.display = "";
  currentSubtotal = 0;
  document.getElementById("priceBreakdown").style.display = "none";
  updatePayBtn();
  // Re-initialize Flatpickr so the calendar shows fresh state (no lingering
  // selected dates from the previous session) and fetches the latest booked
  // ranges from the API.
  initDatePickers();
  }
  // After any page restoration (bfcache or fresh load), check whether a
  // previous payment attempt failed and pre-fill the form if so.
  restoreFailedBooking();
});

function updatePayBtn() {
  const nameVal = document.getElementById("name").value.trim();
  const emailVal = document.getElementById("email").value.trim();
  // Insurance readiness:
  //   "yes"  → requires an uploaded file (own insurance)
  //   "no"   → requires a valid tier selection (basic/standard/premium)
  const tierReady = selectedProtectionTier === "basic" || selectedProtectionTier === "standard" || selectedProtectionTier === "premium";
  const insuranceReady = (insuranceCoverageChoice === "yes" && (((insuranceUpload && insuranceUpload.files.length > 0) || uploadedInsurance !== null))) ||
                          (insuranceCoverageChoice === "no" && tierReady);
  const nameValid = isValidName(nameVal);
  const phoneVal = document.getElementById("phone").value.trim();
  // Requires pickup + return date + pickup time.
  // Pickup time is required: it anchors the rental window and
  // is used as the return time (return_time = pickup_time) for overlap prevention.
  const hasTimeWindow = returnDate.value && pickupTime.value && returnTime.value;
  const datesReady = pickup.value && hasTimeWindow;
  const ready = datesReady && agreeCheckbox.checked && (!smsConsentCheck || smsConsentCheck.checked) && insuranceReady && nameValid && emailVal && phoneVal;
  stripeBtn.disabled = !ready;
  const _reserveBtnPayBtn = document.getElementById("reserveBtn");
  if (_reserveBtnPayBtn) _reserveBtnPayBtn.disabled = !ready;
  const hint = document.getElementById("payHint");
  if (hint) hint.style.display = ready ? "none" : "block";
}

function updateTotal() {
  // ----- Daily/weekly vehicles -----
  if (!carData) return; // vehicle data not yet loaded (async init path)
  if(!pickup.value || !returnDate.value) return;
  const minDays = carData.minRentalDays || 1;
  // Use explicit UTC arithmetic to count whole calendar days without any
  // ISO-string UTC-vs-local ambiguity.  Date.UTC() always gives midnight UTC.
  const [puY, puM, puD]   = pickup.value.split("-").map(Number);
  const [retY, retM, retD] = returnDate.value.split("-").map(Number);
  currentDayCount = Math.max(minDays, Math.ceil(
    (Date.UTC(retY, retM - 1, retD) - Date.UTC(puY, puM - 1, puD)) / (1000 * 3600 * 24)
  ));

  // Calculate cost using the best applicable discount tier (greedy: largest period first).
  // "Monthly" is defined as every 30-day block; this is intentional for a rental business
  // where rates are fixed regardless of calendar month lengths.
  let cost = 0;
  let remaining = currentDayCount;
  const lines = [];

  if (carData.monthly && remaining >= 30) {
    const months = Math.floor(remaining / 30);
    const subtotal = months * carData.monthly;
    cost += subtotal;
    remaining = remaining % 30;
    lines.push({ label: months === 1 ? _fmt("booking.fmtMonth1", { price: carData.monthly }, `1 month \u00D7 $${carData.monthly}/mo`) : _fmt("booking.fmtMonthN", { n: months, price: carData.monthly }, `${months} months \u00D7 $${carData.monthly}/mo`), amount: subtotal });
  }
  if (carData.biweekly && remaining >= 14) {
    const twoWeekPeriods = Math.floor(remaining / 14);
    const subtotal = twoWeekPeriods * carData.biweekly;
    cost += subtotal;
    remaining = remaining % 14;
    lines.push({ label: twoWeekPeriods === 1 ? _fmt("booking.fmtTwoWeeks1", { price: carData.biweekly }, `1 2-week period \u00D7 $${carData.biweekly}`) : _fmt("booking.fmtTwoWeeksN", { n: twoWeekPeriods, price: carData.biweekly }, `${twoWeekPeriods} 2-week periods \u00D7 $${carData.biweekly}`), amount: subtotal });
  }
  if (carData.weekly && remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    const subtotal = weeks * carData.weekly;
    cost += subtotal;
    remaining = remaining % 7;
    lines.push({ label: weeks === 1 ? _fmt("booking.fmtWeek1", { price: carData.weekly }, `1 week \u00D7 $${carData.weekly}/wk`) : _fmt("booking.fmtWeekN", { n: weeks, price: carData.weekly }, `${weeks} weeks \u00D7 $${carData.weekly}/wk`), amount: subtotal });
  }
  if (remaining > 0) {
    const subtotal = remaining * carData.pricePerDay;
    cost += subtotal;
    lines.push({ label: remaining === 1 ? _fmt("booking.fmtDay1", { price: carData.pricePerDay }, `1 day \u00D7 $${carData.pricePerDay}/day`) : _fmt("booking.fmtDayN", { n: remaining, price: carData.pricePerDay }, `${remaining} days \u00D7 $${carData.pricePerDay}/day`), amount: subtotal });
  }
  // Security deposit is always charged (never waived)
  if (carData.deposit) {
    lines.push({ label: _t("booking.securityDeposit", "Security deposit"), amount: carData.deposit });
  }
  // Add Damage Protection Plan if the renter has no rental coverage.
  // Economy cars use flat tier rates (basic $15/day · standard $30/day · premium $50/day).
  if (insuranceCoverageChoice === "no") {
    const tierRate = selectedProtectionTier === "basic" ? PROTECTION_PLAN_BASIC
      : selectedProtectionTier === "premium" ? PROTECTION_PLAN_PREMIUM
      : PROTECTION_PLAN_STANDARD;
    const tierName = selectedProtectionTier === "basic" ? "Basic"
      : selectedProtectionTier === "premium" ? "Premium"
      : "Standard";
    const protectionCost = tierRate * currentDayCount;
    const dppLabel = currentDayCount === 1
      ? `${tierName} Protection (1 day \u00D7 $${tierRate}/day)`
      : `${tierName} Protection (${currentDayCount} days \u00D7 $${tierRate}/day)`;
    cost += protectionCost;
    lines.push({ label: dppLabel, amount: protectionCost });
  }

  const rentalSubtotal = cost + (carData.deposit || 0);
  currentSubtotal = rentalSubtotal;

  // Compute LA sales tax (10.25%) on the pre-tax total and include it in the charge.
  const taxAmount = Math.round(rentalSubtotal * getTaxRate() * 100) / 100;
  const afterTaxTotal = Math.round((rentalSubtotal + taxAmount) * 100) / 100;
  lines.push({ label: _fmt("booking.salesTaxFmt", { rate: (getTaxRate() * 100).toFixed(2) }, `Sales tax (${(getTaxRate() * 100).toFixed(2)}%)`), amount: taxAmount.toFixed(2) });

  const rowsEl = document.getElementById("breakdownRows");
  const frag = document.createDocumentFragment();
  lines.forEach(function(l) {
    const row = document.createElement("div");
    row.className = "breakdown-row";
    const labelSpan = document.createElement("span");
    labelSpan.className = "breakdown-label";
    labelSpan.textContent = l.label;
    const valueSpan = document.createElement("span");
    valueSpan.className = "breakdown-value";
    valueSpan.textContent = "$" + l.amount;
    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    frag.appendChild(row);
  });
  rowsEl.innerHTML = "";
  rowsEl.appendChild(frag);
  document.getElementById("priceBreakdown").style.display = "";

  // Update the subtotal / tax / total display rows
  document.getElementById("subtotal").textContent = rentalSubtotal;
  const taxLineEl = document.getElementById("taxLine");
  const taxNoteEl = document.getElementById("taxNote");
  document.getElementById("tax").textContent = taxAmount.toFixed(2);
  taxLineEl.style.display = "";
  if (taxNoteEl) taxNoteEl.style.display = "none";
  totalEl.textContent = afterTaxTotal.toFixed(2);
  stripeBtn.textContent = window.slyI18n.t("booking.payPrefix") + afterTaxTotal.toFixed(2);
  updatePayBtn();
}

// ----- Pay Now -----
stripeBtn.addEventListener("click", async () => {
  // Resolve payment mode: _pendingPaymentMode is set by reserveBtn before it calls stripeBtn.click().
  if (_pendingPaymentMode === null) {
    _pendingPaymentMode = 'full';
  }
  const paymentMode = _pendingPaymentMode;
  _pendingPaymentMode = null; // consume and reset

  const email = document.getElementById("email").value;
  const nameVal = document.getElementById("name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  clearPayError();
  if (!email) { showPayError(window.slyI18n.t("booking.alertEmail")); return; }
  if (!nameVal) { showPayError(window.slyI18n.t("booking.alertName")); return; }
  if (!phone) { showPayError(window.slyI18n.t("booking.alertPhone")); return; }
  if (!returnDate.value) { showPayError(window.slyI18n.t("booking.alertReturnDate")); return; }
  if (!pickup.value) { showPayError(window.slyI18n.t("booking.alertPickupDate")); return; }
  if (!pickupTime.value) { showPayError(window.slyI18n.t("booking.alertPickupTime")); return; }
  if (!returnTime.value) { showPayError(window.slyI18n.t("booking.alertReturnTime")); return; }
  const isDepositMode = paymentMode === 'deposit';
  // Use per-vehicle booking_deposit (set by loadDynamicPricing from system settings if not
  // in the vehicle record). Fall back to the module-level constant only as a last resort.
  const depositAmount = (carData && carData.booking_deposit != null) ? carData.booking_deposit : FALLBACK_BOOKING_DEPOSIT;
  // totalEl already reflects the correct amount for the selected mode (set by updateTotal).
  const displayPayNow = isDepositMode ? depositAmount.toFixed(2) : totalEl.textContent;
  // For deposit mode, compute the balance the renter still owes at pickup so
  // the confirmation email can display the exact amount (full after-tax total minus deposit).
  if (isDepositMode) {
    const fullAmtFloat = parseFloat(totalEl.textContent);
    if (isFinite(fullAmtFloat) && fullAmtFloat > depositAmount) {
      carData._balanceAtPickup = (fullAmtFloat - depositAmount).toFixed(2);
    }
  }

  // Meta Pixel — track checkout initiation with the amount being charged
  if (typeof fbq === "function") {
    var _pixelCheckoutValue = parseFloat(String(displayPayNow).replace(/[^0-9.]/g, ""));
    fbq("track", "InitiateCheckout", {
      value: isFinite(_pixelCheckoutValue) ? _pixelCheckoutValue : 0,
      currency: "USD",
    });
  }

  if (insuranceCoverageChoice === "yes" && uploadedInsurance) {
    const insuranceSizeErr = validateDocUploadSelection(uploadedInsurance, 0);
    if (insuranceSizeErr) { showPayError(insuranceSizeErr); return; }
  }

  stripeBtn.disabled = true;
  stripeBtn.textContent = window.slyI18n.t("booking.loadingPayment");
  const _reserveBtnLoading = document.getElementById("reserveBtn");
  if (_reserveBtnLoading) _reserveBtnLoading.disabled = true;

  // Pre-encode the insurance file
  let insuranceBase64 = null;
  let insuranceFileName = null;
  let insuranceMimeType = null;
  if (uploadedInsurance) {
    try {
      const encodedInsurance = await encodeUploadFile(uploadedInsurance, "Insurance");
      insuranceBase64 = encodedInsurance.base64;
      insuranceFileName = encodedInsurance.fileName;
      insuranceMimeType = encodedInsurance.mimeType;
    } catch (err) {
      console.error("Insurance encoding error:", err);
    }
  }

  try {
    const res = await fetch(`${API_BASE}/api/create-payment-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vehicleId: vehicleId,
        name: nameVal,
        car: carData.name,
        email: email,
        phone: phone,
        pickup: pickup.value,
        pickupTime: pickupTime.value,
        returnDate: returnDate.value,
        returnTime: returnTime.value,
        protectionPlan: insuranceCoverageChoice === "no",
        // Pass the selected tier so the server uses the correct flat rate.
        ...(insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
        // Pass insurance choice for all vehicles so the server can enforce coverage requirements.
        insuranceCoverageChoice,
        insuranceFileName: insuranceCoverageChoice === "yes" ? (insuranceFileName || null) : null,
        paymentMode,
        adminOverride: ADMIN_OVERRIDE,
        testMode: TEST_MODE,
      })
    });

    const data = await res.json();

    if (!res.ok) {
      // Surface the server's error message so setup issues are visible
      const isDatesError = res.status === 409;
      throw Object.assign(new Error(data.error || "Server error (" + res.status + ")"), { isDatesError });
    }

    const { clientSecret, publishableKey, bookingId } = data;
    pendingBookingId = typeof bookingId === "string" ? bookingId : null;
    if (!clientSecret) {
      throw new Error("No clientSecret returned from server. Check that STRIPE_SECRET_KEY is set in your Vercel environment variables.");
    }
    if (!publishableKey) {
      throw new Error("No publishableKey returned from server. Check that STRIPE_PUBLISHABLE_KEY is set in your Vercel environment variables.");
    }

    // Persist only the publishable key for success.html.
    // Never persist the PaymentIntent client secret in web storage.
    sessionStorage.setItem("slyStripePublishable", publishableKey);

    // Initialize Stripe and mount the Payment Element
    const stripe = Stripe(publishableKey);
    const elements = stripe.elements({
      clientSecret,
      // Pass the user's selected language so the Payment Element (including
      // the Apple Pay sheet and Google Pay button) renders in the right locale.
      locale: (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en",
      defaultValues: {
        billingDetails: {
          name: nameVal,
          email: email,
        },
      },
    });

    // Collect the cardholder name from our booking form (already validated).
    // Hide the duplicate name field inside the Stripe Payment Element so the
    // customer cannot accidentally clear or override it.
    const paymentElement = elements.create("payment", {
      fields: {
        billingDetails: { name: "never" },
      },
    });

    const paymentForm = document.getElementById("payment-form");
    document.getElementById("payAmount").textContent = displayPayNow;
    document.getElementById("submit-payment").textContent = window.slyI18n.t("booking.payPrefix") + displayPayNow;
    paymentForm.style.display = "block";
    stripeBtn.style.display = "none";
    const successUrl = window.location.origin + "/success.html?vehicle=" + encodeURIComponent(vehicleId);
    const payHint = document.getElementById("payHint");
    if (payHint) payHint.style.display = "none";

    const paymentExpressWrapEl = document.getElementById("payment-express-wrap");
    const paymentExpressContainerEl = document.getElementById("payment-express-checkout");
    let paymentExpressEl = null;
    if (paymentExpressWrapEl) paymentExpressWrapEl.style.display = "none";
    if (paymentExpressContainerEl) paymentExpressContainerEl.innerHTML = "";
    try {
      paymentExpressEl = elements.create("expressCheckout", {
        wallets: {
          applePay: "auto",
          googlePay: "auto",
          cashApp: "auto",
        },
      });
      paymentExpressEl.on("ready", function(event) {
        const methods = event && event.availablePaymentMethods ? event.availablePaymentMethods : null;
        const hasWalletMethod = !!(methods && Object.keys(methods).some(function(key) { return !!methods[key]; }));
        if (paymentExpressWrapEl) paymentExpressWrapEl.style.display = hasWalletMethod ? "block" : "none";
      });
      paymentExpressEl.on("confirm", async function() {
        const msgEl = document.getElementById("payment-message");
        if (msgEl) msgEl.textContent = "";
        const bookingPayload = {
          vehicleId,
          bookingId: pendingBookingId || null,
          car: carData.name,
          vehicleMake: carData.make || null,
          vehicleModel: carData.model || null,
          vehicleYear: carData.year || null,
          vehicleVin: carData.vin || null,
          vehicleColor: carData.color || null,
          name: nameVal,
          pickup: pickup.value,
          pickupTime: pickupTime.value,
          returnDate: returnDate.value,
          returnTime: returnTime.value,
          email,
          phone,
          total: displayPayNow,
          fullRentalCost: carData._fullRentalCost || totalEl.textContent,
          balanceAtPickup: carData._balanceAtPickup || null,
          pricePerDay: carData.pricePerDay || null,
          pricePerWeek: carData.weekly || null,
          pricePerBiWeekly: carData.biweekly || null,
          pricePerMonthly: carData.monthly || null,
          deposit: carData.deposit || 0,
          days: currentDayCount,
          insuranceFileName,
          insuranceMimeType,
          insuranceCoverageChoice,
          protectionPlan: insuranceCoverageChoice === "no",
          ...(insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
          signature: agreementSignature || null,
        };
        sessionStorage.setItem("slyRidesBooking", JSON.stringify(bookingPayload));

        if (insuranceBase64 && insuranceFileName) {
          try {
            await new Promise((resolve) => {
              const idbReq = indexedDB.open("slyRidesDB", 1);
              idbReq.onupgradeneeded = e => e.target.result.createObjectStore("files");
              idbReq.onsuccess = e => {
                const db = e.target.result;
                try {
                  const tx = db.transaction("files", "readwrite");
                  tx.objectStore("files").put({ insuranceBase64, insuranceFileName, insuranceMimeType }, "pendingId");
                  tx.oncomplete = () => { db.close(); resolve(); };
                  tx.onerror = () => { db.close(); resolve(); };
                } catch (idbErr) { db.close(); resolve(); }
              };
              idbReq.onerror = () => resolve();
            });
          } catch (idbErr) {
            console.warn("Could not save documents to IndexedDB:", idbErr);
          }
        }

        if (pendingBookingId && insuranceCoverageChoice === "yes" && insuranceBase64 && insuranceFileName) {
          try {
            await storeBookingDocsOrThrow({
              bookingId: pendingBookingId,
              signature: agreementSignature || null,
              insuranceBase64: insuranceBase64 || null,
              insuranceFileName: insuranceFileName || null,
              insuranceMimeType: insuranceMimeType || null,
              insuranceCoverageChoice,
            });
          } catch (docsErr) {
            console.warn("Could not upload booking docs:", docsErr);
            if (shouldBlockPaymentForDocFailure(docsErr)) {
              await updatePendingBookingLifecycle("upload_failed", "blocking_document_upload_failure", { source: "car_express_checkout", preservePendingBookingId: true });
              showPayError("We could not securely save your uploaded documents. Please check your uploads and try again.");
              if (msgEl) msgEl.textContent = "Could not save your uploaded documents. Please try again.";
              return;
            }
            reportNonBlockingDocFailure(docsErr);
          }
        }

        paymentFormSubmitted = true;
        try {
          const result = await stripe.confirmPayment({
            elements,
            confirmParams: {
              return_url: successUrl,
              receipt_email: email,
              payment_method_data: {
                billing_details: {
                  name: nameVal,
                  email: email,
                },
              },
            },
            redirect: "if_required",
          });
          if (result.error) {
            paymentFormSubmitted = false;
            await updatePendingBookingLifecycle("payment_failed", "stripe_confirm_payment_error", { source: "car_express_checkout", preservePendingBookingId: true });
            sessionStorage.setItem("slyRidesBooking", JSON.stringify({
              ...bookingPayload,
              paymentFailed: true,
              insuranceCoverageChoice,
              ...(insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
            }));
            if (msgEl) msgEl.textContent = result.error.message || "Payment failed. Please try again.";
            return;
          }
          if (result.paymentIntent && result.paymentIntent.status === "succeeded") {
            window.location.href = successUrl;
          }
        } catch (err) {
          paymentFormSubmitted = false;
          console.error("[car.js] booking express checkout confirm error:", err);
          if (msgEl) msgEl.textContent = "Payment failed. Please try again.";
        }
      });
      paymentExpressEl.mount("#payment-express-checkout");
    } catch (err) {
      console.warn("[car.js] booking express checkout unavailable:", err && err.message ? err.message : err);
      if (paymentExpressWrapEl) paymentExpressWrapEl.style.display = "none";
    }

    paymentElement.mount("#payment-element");
    paymentForm.scrollIntoView({ behavior: "smooth", block: "start" });

    // Handle cancel — go back to booking form.
    // { once: true } is intentional: each "Pay Now" click registers a fresh cancel
    // listener inside its own closure, so once-per-showing is exactly what we want.
    let paymentSubmitting = false;

    const submitHandler = async () => {
      if (paymentSubmitting) return;
      paymentSubmitting = true;
      const submitBtn = document.getElementById("submit-payment");
      const msgEl = document.getElementById("payment-message");
      submitBtn.disabled = true;
      submitBtn.textContent = window.slyI18n.t("booking.processingPayment");
      msgEl.textContent = "";

      // Store booking data in sessionStorage so success.html can send the
      // confirmation email AFTER the payment redirect completes.
      // (A fire-and-forget fetch here is cancelled by the browser redirect.)
      const bookingPayload = {
        vehicleId,
        bookingId: pendingBookingId || null,
        car: carData.name,
        vehicleMake: carData.make || null,
        vehicleModel: carData.model || null,
        vehicleYear: carData.year || null,
        vehicleVin: carData.vin || null,
        vehicleColor: carData.color || null,
        name: nameVal,
        pickup: pickup.value,
        pickupTime: pickupTime.value,
        returnDate: returnDate.value,
        returnTime: returnTime.value,
        email,
        phone,
        total: displayPayNow,
        fullRentalCost: carData._fullRentalCost || totalEl.textContent,
        balanceAtPickup: carData._balanceAtPickup || null,
        pricePerDay: carData.pricePerDay || null,
        pricePerWeek: carData.weekly || null,
        pricePerBiWeekly: carData.biweekly || null,
        pricePerMonthly: carData.monthly || null,
        deposit: carData.deposit || 0,
        days: currentDayCount,
        insuranceFileName,
        insuranceMimeType,
        insuranceCoverageChoice,
        protectionPlan: insuranceCoverageChoice === "no",
        ...(insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
        signature: agreementSignature || null,
      };
      // Store booking metadata in sessionStorage and large document data in
      // IndexedDB (no size cap) so both survive the Stripe redirect reliably.
      sessionStorage.setItem("slyRidesBooking", JSON.stringify(bookingPayload));

      if (insuranceBase64 && insuranceFileName) {
        const idbReq = indexedDB.open("slyRidesDB", 1);
        idbReq.onupgradeneeded = e => e.target.result.createObjectStore("files");
        idbReq.onsuccess = e => {
          const db = e.target.result;
          try {
            const tx = db.transaction("files", "readwrite");
            tx.objectStore("files").put({ insuranceBase64, insuranceFileName, insuranceMimeType }, "pendingId");
            tx.oncomplete = () => db.close();
            tx.onerror = () => db.close();
          } catch (idbErr) { db.close(); }
        };
        idbReq.onerror = () => {};
      }

      // Upload booking docs server-side so the Stripe webhook can send the
      // owner the full email (agreement PDF + uploaded docs) reliably,
      // even if the customer's browser does not reach success.html.
        if (pendingBookingId && insuranceCoverageChoice === "yes" && insuranceBase64 && insuranceFileName) {
          try {
            await storeBookingDocsOrThrow({
            bookingId: pendingBookingId,
            signature: agreementSignature || null,
            insuranceBase64: insuranceBase64 || null,
            insuranceFileName: insuranceFileName || null,
            insuranceMimeType: insuranceMimeType || null,
              insuranceCoverageChoice,
            });
          } catch (docsErr) {
            console.warn("store-booking-docs upload failed:", docsErr);
            if (shouldBlockPaymentForDocFailure(docsErr)) {
              await updatePendingBookingLifecycle("upload_failed", "blocking_document_upload_failure", { source: "car_payment_element", preservePendingBookingId: true });
              showPayError("We could not securely save your uploaded documents. Please check your uploads and try again.");
              if (msgEl) msgEl.textContent = "Could not save your uploaded documents. Please try again.";
              submitBtn.disabled = false;
              submitBtn.textContent = window.slyI18n.t("booking.payPrefix") + displayPayNow;
              paymentSubmitting = false;
              return;
            }
            reportNonBlockingDocFailure(docsErr);
          }
        }

      paymentFormSubmitted = true;
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: successUrl,
          receipt_email: email,
          payment_method_data: {
            billing_details: {
              name: nameVal,
              email: email,
            },
          },
        },
      });

      if (error) {
        paymentFormSubmitted = false;
        await updatePendingBookingLifecycle("payment_failed", "stripe_confirm_payment_error", { source: "car_payment_element", preservePendingBookingId: true });
        // Keep booking data in sessionStorage with paymentFailed:true so the form
        // can be pre-filled automatically when the renter returns to try again.
        sessionStorage.setItem("slyRidesBooking", JSON.stringify({
          ...bookingPayload,
          paymentFailed: true,
          insuranceCoverageChoice,
          ...(insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
        }));
        msgEl.textContent = error.message;
        submitBtn.disabled = false;
        submitBtn.textContent = window.slyI18n.t("booking.payPrefix") + displayPayNow;
        paymentSubmitting = false;
      }
    };

    document.getElementById("submit-payment").addEventListener("click", submitHandler);

    document.getElementById("cancel-payment").addEventListener("click", () => {
      paymentSubmitting = false; // reset in case cancelled mid-processing
      paymentFormSubmitted = false;
      document.getElementById("submit-payment").removeEventListener("click", submitHandler);
      paymentElement.unmount();
      if (paymentExpressEl) {
        paymentExpressEl.unmount();
        paymentExpressEl = null;
      }
      if (paymentExpressContainerEl) paymentExpressContainerEl.innerHTML = "";
      if (paymentExpressWrapEl) paymentExpressWrapEl.style.display = "none";
      document.getElementById("payment-form").style.display = "none";
      document.getElementById("payment-message").textContent = "";
      stripeBtn.style.display = "";
      stripeBtn.textContent = window.slyI18n.t("booking.payNow");
      const _reserveBtnCancel = document.getElementById("reserveBtn");
      if (_reserveBtnCancel) _reserveBtnCancel.disabled = false;
      _pendingPaymentMode = null;
      updatePendingBookingLifecycle("abandoned_checkout", "cancel_button_before_payment", { source: "cancel_payment_button" });
      updatePayBtn();
    }, { once: true });

  } catch (err) {
    console.error("Stripe error:", err);
    stripeBtn.disabled = false;
    stripeBtn.textContent = window.slyI18n.t("booking.payNow");
    const _reserveBtnErr = document.getElementById("reserveBtn");
    if (_reserveBtnErr) _reserveBtnErr.disabled = false;
    _pendingPaymentMode = null;
    if (err.isDatesError) {
      // Dates were booked by someone else — refresh the calendar and tell the user
      showPayError(err.message);
      initDatePickers(); // reload availability so the calendar reflects the new booking
      return;
    }
    // Always surface the server's error message so the issue is diagnosable.
    // Fall back to the generic i18n string only when no specific message is available.
    const userMessage = (err && err.message)
      ? err.message
      : window.slyI18n.t("booking.loadError");
    showPayError(userMessage);
  }
});

// ----- Camry "Reserve with Deposit" button -----
// Sets deposit payment mode then delegates to the main stripeBtn handler.
(function setupReserveBtn() {
  const reserveBtnEl = document.getElementById("reserveBtn");
  if (!reserveBtnEl) return;
  reserveBtnEl.addEventListener("click", function () {
    _pendingPaymentMode = 'deposit';
    stripeBtn.click();
  });
}());
