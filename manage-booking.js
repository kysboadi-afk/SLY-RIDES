// manage-booking.js
// Client-side logic for the renter self-service portal (/manage-booking.html).
//
// Flow:
//   1. Parse ?t=<token> from URL → skip verify state if present.
//   2. Verify state: customer enters phone/email/booking-ID → POST action:"verify" → get token.
//   3. Dashboard load: POST action:"get", token → populate all dashboard sections.
//   4. Pay balance: POST action:"create_balance_payment_intent" → mount Stripe Payment Element.
//   5. Modify booking: preview / apply_change / initiate_paid_change (unchanged logic).

(function () {
  "use strict";

  const API_BASE  = "/api/manage-booking";
  const VEHICLES_API = "/api/v2-vehicles?scope=cars";
  const VEHICLE_MEDIA_API = "/api/v2-vehicles";
  const PAYMENT_SUCCESS_RELOAD_DELAY_MS = 2200;
  const VEHICLE_IMAGE_PLACEHOLDER = "/images/logo.jpg";

  // ── Parse token from URL ────────────────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  const DEMO_MODE = params.has("demo");
  const DEMO_BOOKING_ID = params.get("b") || "bk-demo-001";
  let activeToken = params.get("t") || "";
  if (DEMO_MODE && !activeToken) activeToken = `demo-${DEMO_BOOKING_ID}`;

  const DEMO_VEHICLE_LIST = [
    { vehicle_id: "camry", vehicle_name: "Camry 2019", daily_price: 69, weekly_price: 429, cover_image: "/images/car2.jpg", gallery_images: ["/images/car2.jpg"] },
    { vehicle_id: "civic", vehicle_name: "Honda Civic 2020", daily_price: 72, weekly_price: 449, cover_image: "", gallery_images: [] },
    { vehicle_id: "rav4", vehicle_name: "Toyota RAV4 2021", daily_price: 95, weekly_price: 589, cover_image: "", gallery_images: [] },
  ];

  const DEMO_BOOKINGS = Object.assign(Object.create(null), {
    "bk-demo-001": {
      bookingId: "bk-demo-001",
      booking_ref: "bk-demo-001",
      name: "Jordan Miles",
      email: "jordan.demo+001@example.test",
      phone: "(555) 010-1001",
      vehicleId: "camry",
      pickupDate: new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10),
      returnDate: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
      pickupTime: "10:00 AM",
      returnTime: "5:00 PM",
      status: "overdue",
      paymentStatus: "partial",
      paymentMethod: "stripe",
      totalPrice: 649,
      total_paid: 420,
      amountPaid: 420,
      balanceDue: 229,
      overdueAmount: 85,
      lateFeeAmount: 85,
      lateFeeStatus: "pending",
      extensionCount: 2,
      extensionRiskOverride: "review",
      paymentPlan: { id: "plan-demo-001", status: "past_due", installments: 4, interval_days: 14, remaining_balance: 229, overdue_amount: 85, next_due_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), isOverdue: true },
      lockChanges: false,
      canModify: true,
    },
    "bk-demo-004": {
      bookingId: "bk-demo-004",
      booking_ref: "bk-demo-004",
      name: "Taylor Brooks",
      email: "taylor.demo+004@example.test",
      phone: "(555) 010-1004",
      vehicleId: "camry",
      pickupDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
      returnDate: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10),
      pickupTime: "2:00 PM",
      returnTime: "2:00 PM",
      status: "reserved_unpaid",
      paymentStatus: "unpaid",
      paymentMethod: "stripe",
      totalPrice: 699,
      total_paid: 0,
      amountPaid: 0,
      balanceDue: 699,
      overdueAmount: 0,
      lateFeeAmount: 0,
      lateFeeStatus: "none",
      extensionCount: 0,
      extensionRiskOverride: "clear",
      paymentPlan: { id: "plan-demo-002", status: "active", installments: 3, interval_days: 14, remaining_balance: 699, overdue_amount: 0, next_due_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), isOverdue: false },
      lockChanges: false,
      canModify: true,
    },
  });

  const DEMO_LEDGER = Object.assign(Object.create(null), {
    "bk-demo-001": {
      summary: { booking_id: "bk-demo-001", total_charges: 734, total_paid: 420, total_waived: 0, remaining_balance: 314, overdue_amount: 85 },
      transactions: [
        { id: "tx-demo-001", created_at: new Date(Date.now() - 9 * 86400000).toISOString(), transaction_type: "payment", direction: "credit", amount: 220, source: "demo_stripe", source_id: "pi_demo_001a", stripe_payment_intent_id: "pi_demo_001a", note: "Reservation payment" },
        { id: "tx-demo-002", created_at: new Date(Date.now() - 7 * 86400000).toISOString(), transaction_type: "extension", direction: "debit", amount: 99, source: "demo_admin", source_id: "ext_demo_001", note: "Extension charge" },
        { id: "tx-demo-003", created_at: new Date(Date.now() - 4 * 86400000).toISOString(), transaction_type: "payment", direction: "credit", amount: 200, source: "demo_card", source_id: "pi_demo_001b", stripe_payment_intent_id: "pi_demo_001b", note: "Balance payment" },
        { id: "tx-demo-004", created_at: new Date(Date.now() - 1 * 86400000).toISOString(), transaction_type: "late_fee", direction: "debit", amount: 85, source: "demo_policy", source_id: "late_demo_001", note: "Auto late fee assessment" },
      ],
    },
    "bk-demo-004": {
      summary: { booking_id: "bk-demo-004", total_charges: 699, total_paid: 0, total_waived: 0, remaining_balance: 699, overdue_amount: 0 },
      transactions: [
        { id: "tx-demo-005", created_at: new Date().toISOString(), transaction_type: "booking", direction: "debit", amount: 699, source: "demo_system", source_id: "book_demo_004", note: "Reserved unpaid booking" },
      ],
    },
  });

  const DEMO_PAYMENT_METHODS = [
    { id: "stripe",  label: "💳 Card / Stripe",  badge: "Card (Stripe)" },
    { id: "apple",   label: "🍎 Apple Pay",       badge: "Apple Pay" },
    { id: "cashapp", label: "💚 Cash App",         badge: "Cash App" },
    { id: "zelle",   label: "💜 Zelle",            badge: "Zelle" },
    { id: "venmo",   label: "🔵 Venmo",            badge: "Venmo" },
    { id: "cash",    label: "💵 Cash / Manual",    badge: "Cash / Manual" },
  ];

  function cloneDemo(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function resolveDemoBookingIdFromToken(token) {
    const value = String(token || "").trim();
    if (!value) return DEMO_BOOKING_ID;
    if (value.startsWith("demo-")) return value.slice(5) || DEMO_BOOKING_ID;
    return value;
  }

  function findDemoBooking(ref) {
    const id = String(ref || "").trim() || DEMO_BOOKING_ID;
    if (Object.prototype.hasOwnProperty.call(DEMO_BOOKINGS, id)) return DEMO_BOOKINGS[id];
    return DEMO_BOOKINGS[DEMO_BOOKING_ID];
  }

  async function installManageBookingDemoFetchInterceptor() {
    if (!DEMO_MODE || window.__manageBookingDemoFetchPatched || typeof window.fetch !== "function") return;
    window.__manageBookingDemoFetchPatched = true;
    const nativeFetch = window.fetch.bind(window);

    window.fetch = async function demoFetch(input, init = undefined) {
      const requestUrl = typeof input === "string" ? input : (input && input.url) ? input.url : "";
      if (!requestUrl) return nativeFetch(input, init);

      let parsed;
      try {
        parsed = new URL(requestUrl, window.location.origin);
      } catch (_err) {
        return nativeFetch(input, init);
      }

      const path = parsed.pathname || "";
      if (!path.startsWith("/api/")) return nativeFetch(input, init);

      let body = {};
      if (init && typeof init.body === "string" && init.body.trim()) {
        try { body = JSON.parse(init.body); } catch (_err) { body = {}; }
      }

      let payload = { ok: true, _demo: true };
      let status = 200;

      if (path.endsWith("/api/v2-vehicles")) {
        payload = parsed.search.includes("scope=cars") ? { vehicles: cloneDemo(DEMO_VEHICLE_LIST) } : { vehicles: cloneDemo(DEMO_VEHICLE_LIST) };
      } else if (path.endsWith("/api/renter-ledger-summary")) {
        const bookingId = String(body.booking_id || resolveDemoBookingIdFromToken(activeToken)).trim();
        payload = cloneDemo(DEMO_LEDGER[bookingId] || { summary: {}, transactions: [] });
      } else if (path.endsWith("/api/manage-booking")) {
        const action = String(body.action || "").trim();
        if (action === "verify") {
          const bookingId = String(body.identifier || "").trim() || DEMO_BOOKING_ID;
          payload = { token: `demo-${bookingId}` };
        } else if (action === "get") {
          const bookingId = resolveDemoBookingIdFromToken(body.token || activeToken);
          payload = cloneDemo(findDemoBooking(bookingId));
        } else if (action === "get_agreement_url") {
          payload = { url: "/images/logo.jpg" };
        } else if (action === "check_availability") {
          const bookingId = resolveDemoBookingIdFromToken(body.token || activeToken);
          const booking = findDemoBooking(bookingId);
          const newTotal = Number(booking.totalPrice || 0) + 49;
          const paid = Number(booking.total_paid || 0);
          payload = { available: true, reason: null, newTotal, newBalanceDue: Math.max(0, newTotal - paid), changeFeeRequired: false, changeFee: 0 };
        } else if (action === "apply_change") {
          const bookingId = resolveDemoBookingIdFromToken(body.token || activeToken);
          const booking = findDemoBooking(bookingId);
          if (booking) {
            booking.pickupDate = body.newPickupDate || booking.pickupDate;
            booking.returnDate = body.newReturnDate || booking.returnDate;
            if (body.newPickupTime) booking.pickupTime = body.newPickupTime;
            if (body.newReturnTime) booking.returnTime = body.newReturnTime;
            if (body.newVehicleId) booking.vehicleId = body.newVehicleId;
          }
          payload = { ok: true, booking: cloneDemo(booking) };
        } else if (action === "initiate_paid_change" || action === "create_balance_payment_intent") {
          payload = { error: "Demo sandbox: live Stripe payment intents are disabled." };
          status = 400;
        } else {
          payload = { ok: true, _demo: true };
        }
      }

      return new Response(JSON.stringify(payload || {}), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  // ── Demo payment picker (demo-mode only) ────────────────────────────────────
  function showDemoPaymentPicker({ amount, containerEl, onSuccess }) {
    if (!containerEl) return;
    const existing = containerEl.querySelector(".demo-pay-picker");
    if (existing) existing.remove();
    const fmtAmt = fmt(amount);
    const picker = document.createElement("div");
    picker.className = "demo-pay-picker";
    picker.innerHTML = `
      <p class="demo-pay-heading">⚡ Demo — Choose a simulated payment method</p>
      <div class="demo-pay-methods" role="group" aria-label="Select payment method">
        ${DEMO_PAYMENT_METHODS.map(m => `
          <label class="demo-pay-method">
            <input type="radio" name="demo-pay-method" value="${escapeHtml(m.id)}">
            <span class="demo-pay-label">${escapeHtml(m.label)}</span>
          </label>`).join("")}
      </div>
      <button class="btn-primary demo-pay-confirm-btn" type="button" disabled>
        Confirm Demo Payment — ${escapeHtml(fmtAmt)}
      </button>
      <p class="demo-pay-note">🔒 Demo sandbox only — no real charge occurs.</p>
    `;
    containerEl.appendChild(picker);
    containerEl.style.display = "block";

    const radios = picker.querySelectorAll('input[name="demo-pay-method"]');
    const confirmBtn = picker.querySelector(".demo-pay-confirm-btn");
    radios.forEach(r => r.addEventListener("change", () => {
      if (confirmBtn) confirmBtn.disabled = false;
    }));

    if (confirmBtn) {
      confirmBtn.addEventListener("click", async () => {
        const chosen = picker.querySelector('input[name="demo-pay-method"]:checked');
        if (!chosen) return;
        const method = DEMO_PAYMENT_METHODS.find(m => m.id === chosen.value) || DEMO_PAYMENT_METHODS[0];
        confirmBtn.disabled = true;
        confirmBtn.textContent = "Processing…";
        await new Promise(res => setTimeout(res, 900));
        const bookingId = resolveDemoBookingIdFromToken(activeToken);
        const ledger = DEMO_LEDGER[bookingId];
        if (ledger) {
          const txId = `tx-demo-sim-${Date.now()}`;
          ledger.transactions.push({
            id: txId,
            created_at: new Date().toISOString(),
            transaction_type: "payment",
            direction: "credit",
            amount,
            source: `demo_${method.id}`,
            source_id: txId,
            note: `Demo payment via ${method.badge}`,
          });
          ledger.summary.total_paid = Number(ledger.summary.total_paid || 0) + amount;
          ledger.summary.remaining_balance = Math.max(0, Number(ledger.summary.remaining_balance || 0) - amount);
          ledger.summary.overdue_amount = Math.max(0, Number(ledger.summary.overdue_amount || 0) - amount);
        }
        const b = findDemoBooking(bookingId);
        if (b) {
          b.total_paid = Number(b.total_paid || 0) + amount;
          b.amountPaid = b.total_paid;
          b.balanceDue = Math.max(0, Number(b.balanceDue || 0) - amount);
          if (b.balanceDue <= 0) {
            b.paymentStatus = "paid";
            if (b.status === "overdue") b.status = "returned";
          }
          if (b.paymentPlan) {
            b.paymentPlan.remaining_balance = Math.max(0, Number(b.paymentPlan.remaining_balance || 0) - amount);
            if (b.paymentPlan.remaining_balance <= 0) b.paymentPlan.status = "completed";
          }
        }
        picker.remove();
        onSuccess(method);
      });
    }
  }

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const $verifyState      = document.getElementById("verify-state");
  const $verifyIdentifier = document.getElementById("verify-identifier");
  const $verifyMsg        = document.getElementById("verify-msg");
  const $btnVerify        = document.getElementById("btn-verify");
  const $loading          = document.getElementById("loading-state");
  const $error            = document.getElementById("error-state");
  const $errorMsg         = document.getElementById("error-msg");
  const $main             = document.getElementById("main-content");
  const $lockNotice       = document.getElementById("lock-notice");
  const $editSection      = document.getElementById("edit-section");
  const $pricePreview     = document.getElementById("price-preview");
  const $previewTotal     = document.getElementById("preview-total");
  const $previewBal       = document.getElementById("preview-balance");
  const $feeNotice        = document.getElementById("fee-notice");
  const $actionMsg        = document.getElementById("action-msg");
  const $btnApply         = document.getElementById("btn-apply");
  const $btnPreview       = document.getElementById("btn-preview");
  const $paidSection      = document.getElementById("paid-change-section");
  const $changeFeeAmt     = document.getElementById("change-fee-amount");
  const $btnPayFee        = document.getElementById("btn-pay-fee");
  const $stripeEl         = document.getElementById("stripe-element");
  const $stripeErr        = document.getElementById("stripe-error");
  const $dppTierRow       = document.getElementById("dpp-tier-row");
  const $newProtection    = document.getElementById("new-protection");
  const $newVehicle       = document.getElementById("new-vehicle");
  const $payBalSection    = document.getElementById("pay-balance-section");
  const $btnInitBalance   = document.getElementById("btn-init-balance");
  const $btnOpenPartial   = document.getElementById("btn-open-partial");
  const $btnViewPlan      = document.getElementById("btn-view-plan");
  const $btnDownloadLatestReceipt = document.getElementById("btn-download-latest-receipt");
  const $balanceWrap      = document.getElementById("balance-payment-wrap");
  const $balanceExpressWrap = document.getElementById("balance-express-wrap");
  const $balanceExpressEl = document.getElementById("balance-express-checkout");
  const $balanceStripeEl  = document.getElementById("balance-stripe-element");
  const $balanceError     = document.getElementById("balance-error");
  const $btnConfirmBal    = document.getElementById("btn-confirm-balance");
  const $btnRetry         = document.getElementById("btn-retry-verify");
  const $docAgreementLink = document.getElementById("doc-agreement-link");
  const $docAgreementUnavailable = document.getElementById("doc-agreement-unavailable");
  const $docLatestReceipt = document.getElementById("doc-latest-receipt");
  const $docLatestReceiptUnavailable = document.getElementById("doc-latest-receipt-unavailable");
  const $openRenterChatbot = document.getElementById("open-renter-chatbot");
  const $activityList     = document.getElementById("activity-list");
  const $activityEmpty    = document.getElementById("activity-empty");
  // Partial payment DOM refs
  const $partialSection   = document.getElementById("partial-payment-section");
  const $partialAmtInput  = document.getElementById("partial-amount-input");
  const $partialMaxBtn    = document.getElementById("partial-max-btn");
  const $partialPreview   = document.getElementById("partial-amount-preview");
  const $btnInitPartial   = document.getElementById("btn-init-partial");
  const $partialExpressWrap = document.getElementById("partial-express-wrap");
  const $partialExpressEl = document.getElementById("partial-express-checkout");
  const $partialStripeEl  = document.getElementById("partial-stripe-element");
  const $partialError     = document.getElementById("partial-error");
  const $btnConfirmPartial = document.getElementById("btn-confirm-partial");

  // ── Booking state ───────────────────────────────────────────────────────────
  let booking          = null;
  let previewData      = null;
  let vehicleOptions   = [];
  let stripeInstance   = null;
  let stripeElements   = null;
  let stripeCardEl     = null;
  let balanceStripe    = null;
  let balanceElements  = null;
  let balancePayEl     = null;
  let balanceExpressCheckoutEl = null;
  let partialStripe    = null;
  let partialElements  = null;
  let partialPayEl     = null;
  let partialExpressCheckoutEl = null;
  let currentBalance   = 0;
  let ledgerSummary    = null;
  let ledgerTransactions = [];
  let latestReceiptTransaction = null;
  let agreementPdfUrl  = null;
  let vehicleMediaById = {};

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function fmt(n) {
    return typeof n === "number" ? `$${n.toFixed(2)}` : "–";
  }

  function formatDate(d) {
    if (!d) return "–";
    const [y, m, day] = d.split("-");
    if (!y || !m || !day) return d;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(m,10)-1]} ${parseInt(day,10)}, ${y}`;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function setHtml(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = value;
  }

  function setDisplay(id, visible, displayValue = "") {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? displayValue : "none";
  }

  function resolveStripeLocale() {
    if (window.slyI18n && typeof window.slyI18n.getLang === "function") {
      const lang = String(window.slyI18n.getLang() || "").trim();
      if (lang) return lang;
    }
    return "en";
  }

  function unmountStripeElement(element) {
    if (!element) return;
    try { element.unmount(); } catch (_err) { /* ignore */ }
  }

  function hideStripeExpress(wrapperEl, containerEl) {
    if (wrapperEl) wrapperEl.style.display = "none";
    if (containerEl) containerEl.innerHTML = "";
  }

  function mountExpressCheckoutElement({ stripe, elements, wrapperEl, containerEl, errorEl }) {
    if (!stripe || !elements || !containerEl) return null;
    let expressEl = null;
    try {
      expressEl = elements.create("expressCheckout", {
        wallets: {
          applePay: "auto",
          googlePay: "auto",
          cashApp: "auto",
        },
      });
    } catch (err) {
      console.warn("[manage-booking] express checkout unavailable:", err?.message || err);
      hideStripeExpress(wrapperEl, containerEl);
      return null;
    }

    expressEl.on("ready", (event) => {
      const methods = event?.availablePaymentMethods || null;
      const hasWalletMethod = !!(methods && Object.keys(methods).some((key) => !!methods[key]));
      if (wrapperEl) wrapperEl.style.display = hasWalletMethod ? "block" : "none";
    });

    expressEl.on("confirm", async () => {
      if (errorEl) errorEl.style.display = "none";
      try {
        const result = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: window.location.href },
          redirect: "if_required",
        });
        if (result.error) {
          if (errorEl) { errorEl.textContent = result.error.message || "Payment failed. Please try again."; errorEl.style.display = "block"; }
          return;
        }
        if (result.paymentIntent?.status === "succeeded") {
          setActionMsg("✅ Payment received. Updating your booking…", "success", document.getElementById("action-msg-finance"));
          setTimeout(() => window.location.reload(), PAYMENT_SUCCESS_RELOAD_DELAY_MS);
        }
      } catch (err) {
        if (errorEl) { errorEl.textContent = "Payment failed. Please try again."; errorEl.style.display = "block"; }
        console.error("[manage-booking] express checkout confirm error:", err);
      }
    });

    if (wrapperEl) wrapperEl.style.display = "none";
    containerEl.innerHTML = "";
    expressEl.mount(containerEl);
    return expressEl;
  }

  function normalizeVehicleImageUrl(value) {
    if (!value || typeof value !== "string") return "";
    const url = String(value).trim();
    if (!url) return "";
    if (/^https?:\/\//i.test(url) || url.startsWith("/")) return url;
    return "/" + url.replace(/^(\.\.\/)+/, "");
  }

  function toVehicleMediaLookup(vehicles) {
    const lookup = {};
    (Array.isArray(vehicles) ? vehicles : []).forEach((v) => {
      const id = String(v?.vehicle_id || v?.id || "").trim();
      if (!id) return;
      const cover = normalizeVehicleImageUrl(v?.cover_image);
      const gallery = Array.isArray(v?.gallery_images)
        ? v.gallery_images.map(normalizeVehicleImageUrl).filter(Boolean)
        : [];
      lookup[id] = { cover, gallery };
    });
    return lookup;
  }

  function resolveVehicleImageForBooking(bookingVehicleId) {
    const key = String(bookingVehicleId || "").trim();
    if (!key) return "";
    const media = vehicleMediaById[key];
    if (!media) return "";
    return media.cover || (Array.isArray(media.gallery) ? media.gallery[0] : "") || "";
  }

  function formatDateTime(dateValue, timeValue) {
    if (!dateValue) return "–";
    const base = formatDate(dateValue);
    return timeValue ? `${base} at ${timeValue}` : base;
  }

  function formatPlanDate(value) {
    if (!value) return "–";
    const dateOnly = String(value).slice(0, 10);
    return formatDate(dateOnly);
  }

  function normalizeStatusKey(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, "_");
  }

  function normalizeVehicleLookupKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function resolveVehicleRouteId(value, options = {}) {
    const allowRaw = options.allowRaw !== false;
    const raw = String(value || "").trim();
    if (!raw) return "";
    const exact = vehicleOptions.find((v) => String(v.id || "").trim() === raw);
    if (exact?.id) return String(exact.id).trim();
    const lowered = raw.toLowerCase();
    const ci = vehicleOptions.find((v) => String(v.id || "").trim().toLowerCase() === lowered);
    if (ci?.id) return String(ci.id).trim();
    const lookup = normalizeVehicleLookupKey(raw);
    const byId = vehicleOptions.find((v) => normalizeVehicleLookupKey(v.id) === lookup);
    if (byId?.id) return String(byId.id).trim();
    const byName = vehicleOptions.find((v) => normalizeVehicleLookupKey(v.name) === lookup);
    if (byName?.id) return String(byName.id).trim();
    return allowRaw ? raw : "";
  }

  function buildExtensionHref(b) {
    const resolvedById = resolveVehicleRouteId(b?.vehicleId || "", { allowRaw: false });
    const resolvedByName = resolveVehicleRouteId(b?.vehicleName || "", { allowRaw: false });
    const resolvedVehicleId = resolvedById || resolvedByName || resolveVehicleRouteId(b?.vehicleId || b?.vehicleName || "");
    const token = String(activeToken || params.get("t") || "").trim();
    const query = new URLSearchParams();
    if (resolvedVehicleId) query.set("vehicle", resolvedVehicleId);
    query.set("extend", "1");
    if (token) query.set("t", token);
    return `car.html?${query.toString()}`;
  }
  function hasUsableLedgerSummary(summary) {
    if (!summary || typeof summary !== "object") return false;
    const txCount = Number(summary.transaction_count || 0);
    const remaining = Number(summary.remaining_balance);
    const totalPaid = Number(summary.total_paid);
    const totalCharges = Number(summary.total_charges);
    return txCount > 0
      || (Number.isFinite(remaining) && remaining > 0)
      || (Number.isFinite(totalPaid) && totalPaid > 0)
      || (Number.isFinite(totalCharges) && totalCharges > 0);
  }

  function toMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function logContractTransition(eventName, fields, level) {
    const logger = level === "warn" ? console.warn : console.info;
    logger("[manage-booking][contract-transition]", {
      event: eventName,
      ...(fields || {}),
    });
  }

  function deriveDisplayedFinancials(b, summary, statusKey) {
    const total = Number(b.totalPrice || 0) || (Number(b.depositPaid || 0) + Number(b.balanceDue || 0)) || 0;
    const dbPaid = Math.max(0, toMoney(b.depositPaid));
    const dbBalance = Math.max(0, toMoney(b.balanceDue));
    const ledgerSummaryUsable = hasUsableLedgerSummary(summary);
    const ledgerPaid = ledgerSummaryUsable ? Math.max(0, toMoney(summary?.total_paid)) : 0;
    const ledgerBalance = ledgerSummaryUsable ? toMoney(summary?.remaining_balance) : NaN;
    const ledgerCharges = ledgerSummaryUsable ? Math.max(0, toMoney(summary?.total_charges)) : 0;
    const paid = Math.max(dbPaid, ledgerPaid);
    const isReservationStage = [
      "pending",
      "pending_checkout",
      "pending_verification",
      "approved",
      "reserved",
      "reserved_unpaid",
      "booked_paid",
      "identity_pending",
      "identity_verified",
      "agreement_pending",
      "agreement_signed",
      "pending_manual_payment",
      "ready_for_pickup",
    ].includes(statusKey);

    let balance = dbBalance;
    let sourceKey = "database_remaining_balance";
    let fallbackPathUsed = "";
    if (ledgerSummaryUsable) {
      if (Number.isFinite(ledgerBalance) && ledgerBalance > 0) {
        balance = ledgerBalance;
        sourceKey = "ledger_remaining_balance";
      } else if (ledgerCharges > 0 || dbBalance <= 0) {
        balance = Math.max(0, ledgerBalance || 0);
        sourceKey = "ledger_zero_balance";
      } else if (isReservationStage && total > 0 && paid < total) {
        balance = Math.max(0, toMoney(total - paid));
        sourceKey = "reservation_total_minus_paid";
        fallbackPathUsed = "reservation_total_minus_paid";
      } else if (isReservationStage && total > 0 && paid >= total) {
        balance = 0;
        sourceKey = "reservation_paid_in_full";
      }
    }

    const paidPct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : (balance === 0 ? 100 : 0);
    return {
      total,
      paid,
      balance,
      paidPct,
      sourceKey,
      fallbackPathUsed,
      ledgerSummaryUsable,
    };
  }

  function derivePaymentLifecycleState({ booking, statusKey, total, paid, balance }) {
    const paymentStatusKey = normalizeStatusKey(booking?.paymentStatus);
    const categoryKey = normalizeStatusKey(booking?.category);
    const paymentPlanStatus = normalizeStatusKey(booking?.paymentPlan?.status);
    const isManualPickupByStatus = ["agreement_signed", "pending_manual_payment", "ready_for_pickup"].includes(statusKey);
    const isActiveRental = ["active", "active_rental", "extended"].includes(statusKey);
    const hasOutstandingBalance = balance > 0;
    const hasPaymentPlan = !!booking?.paymentPlan && ["active", "defaulted", "past_due", "overdue"].includes(paymentPlanStatus);
    const isOverdue = statusKey === "overdue" || (!!booking?.paymentPlan?.isOverdue && hasOutstandingBalance);
    const hasPartialIndicator = ["partial", "deposit", "deposit_paid", "partially_paid"].includes(paymentStatusKey);
    const hasFullIndicator = ["paid", "paid_in_full", "full", "completed", "succeeded"].includes(paymentStatusKey);
    const hasPositivePaid = paid > 0;
    const isFullyPaidByBalance = balance <= 0;
    const isManualPickup = isManualPickupByStatus;
    const isReservationStage = [
      "pending",
      "pending_checkout",
      "pending_verification",
      "approved",
      "reserved",
      "reserved_unpaid",
      "booked_paid",
      "identity_pending",
      "identity_verified",
      "agreement_pending",
      "agreement_signed",
      "pending_manual_payment",
      "ready_for_pickup",
    ].includes(statusKey) || isManualPickup;

    let lifecycleState = booking?.paymentLifecycleState || "reservation_pending";

    if (isOverdue) lifecycleState = "overdue";
    else if (hasPaymentPlan && hasOutstandingBalance) lifecycleState = "payment_plan_active";
    else if (isActiveRental) lifecycleState = "active_rental";
    else if (isManualPickup && !isFullyPaidByBalance && hasPositivePaid) lifecycleState = "deposit_paid";
    else if (isManualPickup && !isFullyPaidByBalance) lifecycleState = "pickup_due";
    else if (isReservationStage) {
      if (hasOutstandingBalance && hasPositivePaid) lifecycleState = "deposit_paid";
      else if (hasOutstandingBalance) lifecycleState = "reservation_pending";
      else if (hasFullIndicator || (!hasPartialIndicator && total > 0 && paid >= total)) lifecycleState = "completed";
      else if (hasPartialIndicator || hasPositivePaid) lifecycleState = "deposit_paid";
      else lifecycleState = "reservation_pending";
    } else if (isFullyPaidByBalance) lifecycleState = "completed";
    else if (hasPositivePaid) lifecycleState = "deposit_paid";
    else lifecycleState = "reservation_pending";

    return {
      lifecycleState,
      hasOutstandingBalance,
      isManualPickup,
      isOverdue,
      isActiveRental,
      hasPaymentPlan,
      isReservationStage,
      isPaidInFull: lifecycleState === "completed",
      canPayRemainingOnline: hasOutstandingBalance && !isManualPickup && lifecycleState !== "completed",
    };
  }

  function derivePaymentUiState({ booking, statusKey, total, paid, balance }) {
    const normalizedTotal = Math.max(0, toMoney(total));
    const normalizedBalance = Math.max(0, toMoney(balance));
    const normalizedPaid = Math.max(0, toMoney(paid));
    const lifecycle = derivePaymentLifecycleState({
      booking,
      statusKey,
      total: normalizedTotal,
      paid: normalizedPaid,
      balance: normalizedBalance,
    });

    let stateKey = lifecycle.lifecycleState;
    if (!["reservation_pending", "deposit_paid", "pickup_due", "active_rental", "payment_plan_active", "overdue", "completed"].includes(stateKey)) {
      stateKey = "reservation_pending";
    }

    const STATE_COPY = {
      completed: {
        paymentBadgeLabel: "Paid in full",
        paymentBadgeClass: "badge-confirmed",
        paymentChipLabel: "Paid in full",
        balanceNote: "No balance remains on this booking.",
        progressPaidLabel: `${fmt(normalizedPaid)} paid`,
        progressPctLabel: "100% complete",
        bannerText: "",
      },
      deposit_paid: {
        paymentBadgeLabel: lifecycle.isManualPickup ? "Deposit Paid / Balance Due at Pickup" : "Deposit Paid",
        paymentBadgeClass: "badge-pending",
        paymentChipLabel: lifecycle.isManualPickup
          ? "Reservation Deposit Paid ✅ • Remaining Balance Due at Pickup"
          : `Deposit Paid ✅ • ${fmt(normalizedBalance)} remaining`,
        balanceNote: lifecycle.isManualPickup
          ? "Reservation deposit paid. Remaining balance is due at pickup."
          : "Deposit recorded. Remaining balance is still due on this booking.",
        progressPaidLabel: "Reservation Deposit Paid ✅",
        progressPctLabel: lifecycle.isManualPickup ? "Remaining balance due at pickup" : `${fmt(normalizedBalance)} remaining`,
        bannerText: lifecycle.isManualPickup
          ? "Your reservation deposit has been received. Remaining balance is collected at pickup."
          : "Your reservation deposit has been received. Remaining balance is still due on this booking.",
      },
      payment_plan_active: {
        paymentBadgeLabel: "Payment Plan Active",
        paymentBadgeClass: "badge-pending",
        paymentChipLabel: `Installment payment recorded • ${fmt(normalizedBalance)} due`,
        balanceNote: "Installment payment recorded. Continue following your payment plan schedule.",
        progressPaidLabel: `${fmt(normalizedPaid)} paid`,
        progressPctLabel: `${fmt(normalizedBalance)} remaining`,
        bannerText: "A partial payment has been received. Remaining balance is still due.",
      },
      pickup_due: {
        paymentBadgeLabel: "Balance Due at Pickup",
        paymentBadgeClass: "badge-review",
        paymentChipLabel: "Payment due at pickup",
        balanceNote: "Payment for this booking is collected in person at pickup.",
        progressPaidLabel: normalizedPaid > 0 ? `${fmt(normalizedPaid)} paid` : "$0 paid",
        progressPctLabel: "Payment due at pickup",
        bannerText: "Remaining balance is collected at pickup.",
      },
      reservation_pending: {
        paymentBadgeLabel: "Reservation Pending Payment",
        paymentBadgeClass: "badge-pending",
        paymentChipLabel: `${fmt(normalizedBalance)} still due`,
        balanceNote: "Use the payment actions below to pay the remaining balance.",
        progressPaidLabel: `${fmt(normalizedPaid)} paid`,
        progressPctLabel: `${normalizedTotal > 0 ? Math.min(100, Math.round((normalizedPaid / normalizedTotal) * 100)) : 0}% complete`,
        bannerText: "Remaining balance is still due on this booking.",
      },
      active_rental: {
        paymentBadgeLabel: "Active Rental",
        paymentBadgeClass: "badge-active-rental",
        paymentChipLabel: normalizedBalance > 0 ? `${fmt(normalizedBalance)} currently due` : "No current balance due",
        balanceNote: normalizedBalance > 0
          ? "This rental is active. Use payment actions below to keep your account current."
          : "This rental is active and currently has no outstanding balance.",
        progressPaidLabel: `${fmt(normalizedPaid)} paid`,
        progressPctLabel: normalizedBalance > 0 ? `${fmt(normalizedBalance)} remaining` : "Current balance clear",
        bannerText: normalizedBalance > 0 ? "A balance is due while this rental is active." : "",
      },
      overdue: {
        paymentBadgeLabel: "Overdue Balance",
        paymentBadgeClass: "badge-overdue",
        paymentChipLabel: `${fmt(normalizedBalance)} overdue`,
        balanceNote: "This booking is overdue. Make a payment now and contact support immediately.",
        progressPaidLabel: `${fmt(normalizedPaid)} paid`,
        progressPctLabel: `${fmt(normalizedBalance)} overdue`,
        bannerText: "Your account is overdue. Please pay now and contact support.",
      },
    };

    const copy = STATE_COPY[stateKey] || STATE_COPY.reservation_pending;

    return {
      stateKey,
      lifecycleState: lifecycle.lifecycleState,
      isPaidInFull: lifecycle.isPaidInFull,
      hasPartialPayment: normalizedBalance > 0 && normalizedPaid > 0,
      isManualPickupFlow: lifecycle.isManualPickup,
      canPayRemainingOnline: lifecycle.canPayRemainingOnline,
      paymentBadgeLabel: copy.paymentBadgeLabel,
      paymentBadgeClass: copy.paymentBadgeClass,
      paymentChipLabel: copy.paymentChipLabel,
      balanceNote: copy.balanceNote,
      progressPaidLabel: copy.progressPaidLabel,
      progressPctLabel: copy.progressPctLabel,
      bannerText: copy.bannerText,
    };
  }

  function paymentStatusBadgeHtml(state) {
    return `<span class="status-badge ${escapeHtml(state.paymentBadgeClass)}">${escapeHtml(state.paymentBadgeLabel)}</span>`;
  }

  function observeContractTransition(b, financialSnapshot, paymentState, statusKey) {
    const bookingId = b?.bookingId || b?.booking_ref || "";
    const observability = b?.contractTransitionObservability || null;
    logContractTransition("legacy_derivation_surface_used", {
      booking_id: bookingId,
      surface: "manage_booking_dashboard",
      lifecycle_source: "client_legacy_derivation",
      financial_source: financialSnapshot.sourceKey,
      status: statusKey,
    });
    if (financialSnapshot.fallbackPathUsed) {
      logContractTransition("fallback_path_used", {
        booking_id: bookingId,
        surface: "manage_booking_dashboard",
        path: financialSnapshot.fallbackPathUsed,
      });
    }
    if (Array.isArray(observability?.fallbackPaths)) {
      observability.fallbackPaths.forEach((pathInfo) => {
        logContractTransition("fallback_path_used", {
          booking_id: bookingId,
          surface: "manage_booking_api",
          ...(pathInfo || {}),
        });
      });
    }
    if (Array.isArray(observability?.surfacesUsingLegacyDerivations)) {
      observability.surfacesUsingLegacyDerivations.forEach((surface) => {
        logContractTransition("legacy_derivation_surface_used", {
          booking_id: bookingId,
          surface,
        });
      });
    }

    const canonicalFinancials = observability?.canonicalFinancialSnapshot;
    if (canonicalFinancials) {
      const financialDiffs = {};
      const comparable = {
        total: financialSnapshot.total,
        paid: financialSnapshot.paid,
        balance: financialSnapshot.balance,
      };
      Object.entries(comparable).forEach(([key, legacyValue]) => {
        const canonicalValue = toMoney(canonicalFinancials[key]);
        if (Math.abs(toMoney(legacyValue) - canonicalValue) > 0.01) {
          financialDiffs[key] = {
            canonical: canonicalValue,
            legacy: toMoney(legacyValue),
          };
        }
      });
      if (Object.keys(financialDiffs).length > 0) {
        logContractTransition("financial_snapshot_mismatch", {
          booking_id: bookingId,
          canonical: canonicalFinancials,
          legacy: comparable,
          diffs: financialDiffs,
        }, "warn");
      }
    }

    const canonicalLifecycle = String(observability?.canonicalLifecycleState || b?.paymentLifecycleState || "").trim().toLowerCase();
    const legacyLifecycle = String(paymentState.lifecycleState || "").trim().toLowerCase();
    const lifecycleFlagsMismatch = typeof b?.canPayRemainingOnline === "boolean"
      && b.canPayRemainingOnline !== !!paymentState.canPayRemainingOnline;
    if ((canonicalLifecycle && canonicalLifecycle !== legacyLifecycle) || lifecycleFlagsMismatch) {
      logContractTransition("lifecycle_state_mismatch", {
        booking_id: bookingId,
        canonical: {
          lifecycleState: canonicalLifecycle || "",
          canPayRemainingOnline: !!b?.canPayRemainingOnline,
        },
        legacy: {
          lifecycleState: legacyLifecycle || "",
          canPayRemainingOnline: !!paymentState.canPayRemainingOnline,
        },
      }, "warn");
    }
  }

  function buildBalanceLink(b) {
    if (b?.balancePaymentLink) return b.balancePaymentLink;
    const params = new URLSearchParams();
    if (b?.vehicleId) params.set("v", b.vehicleId);
    if (b?.pickupDate) params.set("p", b.pickupDate);
    if (b?.returnDate) params.set("r", b.returnDate);
    if (b?.customerEmail) params.set("e", b.customerEmail);
    if (b?.bookingId) params.set("b", b.bookingId);
    return params.toString() ? `${window.location.origin}/balance.html?${params.toString()}` : "";
  }

  function isOverdueDate(value) {
    const dateKey = String(value || "").slice(0, 10);
    if (!dateKey) return false;
    const today = new Date();
    const nowKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return dateKey < nowKey;
  }

  function transactionTitle(tx) {
    const type = String(tx?.transaction_type || "").replace(/_/g, " ");
    const normalized = type.toLowerCase();
    if (normalized === "payment") return "Payment received";
    if (normalized === "extension") return "Extension charge";
    if (normalized === "late fee") return "Late fee";
    if (normalized === "waiver") return "Waiver applied";
    if (normalized === "refund") return "Refund posted";
    return type ? type.replace(/\b\w/g, (c) => c.toUpperCase()) : "Account activity";
  }

  function transactionMeta(tx) {
    const created = tx?.created_at ? new Date(tx.created_at) : null;
    const createdLabel = created && Number.isFinite(created.getTime())
      ? created.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : "Date unavailable";
    const notes = String(tx?.notes || "").trim();
    return notes ? `${createdLabel} • ${notes}` : createdLabel;
  }

  function findLatestReceiptTransaction(transactions) {
    return (transactions || []).find((tx) => {
      return tx && tx.transaction_type === "payment" && tx.direction === "credit";
    }) || null;
  }

  function downloadReceiptForTransaction(tx) {
    if (!booking || !tx) return;
    const paidAt = tx.created_at ? new Date(tx.created_at).toLocaleString() : "Date unavailable";
    const amount = fmt(Number(tx.amount || 0));
    const receiptRef = tx.stripe_payment_intent_id || tx.source_id || tx.id || booking.bookingId || "payment";
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>SLY Receipt</title>
<style>
body{font-family:Arial,sans-serif;padding:32px;color:#111} .wrap{max-width:720px;margin:0 auto}
h1{margin:0 0 8px} .meta{color:#555;margin-bottom:24px}
table{width:100%;border-collapse:collapse;margin-top:18px} td{border:1px solid #ddd;padding:10px;vertical-align:top}
.amount{font-size:28px;font-weight:700;color:#1b5e20;margin:20px 0}
</style></head><body><div class="wrap">
<h1>Payment Receipt</h1>
<div class="meta">Sly Car Rentals • (844) 511-4059</div>
<div class="amount">${escapeHtml(amount)}</div>
<table>
  <tr><td><strong>Booking ID</strong></td><td>${escapeHtml(booking.bookingId || "—")}</td></tr>
  <tr><td><strong>Renter</strong></td><td>${escapeHtml(booking.customerName || "—")}</td></tr>
  <tr><td><strong>Vehicle</strong></td><td>${escapeHtml(booking.vehicleName || booking.vehicleId || "—")}</td></tr>
  <tr><td><strong>Payment Date</strong></td><td>${escapeHtml(paidAt)}</td></tr>
  <tr><td><strong>Payment Reference</strong></td><td>${escapeHtml(receiptRef)}</td></tr>
  <tr><td><strong>Description</strong></td><td>${escapeHtml(transactionTitle(tx))}</td></tr>
</table>
</div></body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sly-receipt-${booking.bookingId || "payment"}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function showSection(which) {
    [$verifyState, $loading, $error, $main].forEach((el) => {
      if (el) el.style.display = "none";
    });
    if (which) which.style.display = "block";
  }

  function showError(msg) {
    if ($errorMsg) $errorMsg.textContent = msg || "An unexpected error occurred.";
    showSection($error);
  }

  function setActionMsg(msg, type, target) {
    const el = target || $actionMsg;
    if (!el) return;
    el.innerHTML = msg
      ? `<div class="${type === "success" ? "success-msg" : "error-msg"}">${escapeHtml(msg)}</div>`
      : "";
  }

  function setVerifyMsg(msg, type) {
    if (!$verifyMsg) return;
    $verifyMsg.innerHTML = msg
      ? `<div class="${type === "success" ? "success-msg" : "error-msg"}">${escapeHtml(msg)}</div>`
      : "";
  }

  // ── Status badge mapping ────────────────────────────────────────────────────
  const STATUS_MAP = {
    inquiry_received:     { label: "Inquiry Received",     cls: "badge-pending" },
    identity_pending:     { label: "Identity Pending",     cls: "badge-review" },
    identity_verified:    { label: "Identity Verified",    cls: "badge-review" },
    agreement_pending:    { label: "Agreement Pending",    cls: "badge-pending" },
    agreement_signed:     { label: "Agreement Signed",     cls: "badge-confirmed" },
    pending_manual_payment: { label: "Pay at Pickup",      cls: "badge-review" },
    ready_for_pickup:     { label: "Ready for Pickup",     cls: "badge-confirmed" },
    reserved:             { label: "Upcoming",         cls: "badge-upcoming" },
    reserved_unpaid:      { label: "Pending Payment",  cls: "badge-pending" },
    pending:              { label: "Pending Review",   cls: "badge-pending" },
    pending_verification: { label: "Under Review",     cls: "badge-review" },
    approved:             { label: "Confirmed",        cls: "badge-confirmed" },
    active:               { label: "Active Rental",    cls: "badge-active-rental" },
    active_rental:        { label: "Active Rental",    cls: "badge-active-rental" },
    overdue:              { label: "Overdue",          cls: "badge-overdue" },
    extended:             { label: "Extended",         cls: "badge-extended" },
    booked_paid:          { label: "Confirmed",        cls: "badge-confirmed" },
    partial:              { label: "Partial Payment",  cls: "badge-pending" },
  };

  function statusBadgeHtml(rawStatus) {
    const key = (rawStatus || "").toLowerCase().replace(/\s+/g, "_");
    const { label, cls } = STATUS_MAP[key] || { label: rawStatus || "–", cls: "badge-default" };
    return `<span class="status-badge ${cls}">${escapeHtml(label)}</span>`;
  }

  // ── Vehicle options ─────────────────────────────────────────────────────────
  async function loadVehicleOptions() {
    if (vehicleOptions.length > 0) return vehicleOptions;
    try {
      const resp = await fetch(VEHICLES_API, { cache: "no-store", headers: { Accept: "application/json" } });
      const data = await resp.json();
      vehicleOptions = Array.isArray(data)
        ? data
            .filter((v) => v && (v.id || v.vehicle_id) && (v.name || v.vehicle_name))
            .map((v) => ({ id: v.id || v.vehicle_id, name: v.name || v.vehicle_name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];
    } catch (err) {
      console.error("manage-booking: vehicle options load error:", err);
      vehicleOptions = [];
    }
    return vehicleOptions;
  }

  async function loadVehicleMedia() {
    if (Object.keys(vehicleMediaById).length > 0) return vehicleMediaById;
    try {
      const resp = await fetch(VEHICLE_MEDIA_API, { cache: "no-store", headers: { Accept: "application/json" } });
      const data = await resp.json();
      vehicleMediaById = toVehicleMediaLookup(data);
    } catch (err) {
      console.error("manage-booking: vehicle media load error:", err);
      vehicleMediaById = {};
    }
    return vehicleMediaById;
  }

  function renderVehicleOptions($select, selectedId) {
    if (!$select) return;
    const opts = ['<option value="">-- Select vehicle --</option>'].concat(
      vehicleOptions.map(
        (v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`
      )
    );
    $select.innerHTML = opts.join("");
    if (selectedId) $select.value = selectedId;
  }

  // ── Populate dashboard ──────────────────────────────────────────────────────
  function populateDashboard(b) {
    const firstName = (b.customerName || "").split(" ")[0];
    const greeting  = firstName ? `Hi, ${escapeHtml(firstName)}!` : "Your Rental Dashboard";
    const statusKey = normalizeStatusKey(b.status);
    const financialSnapshot = deriveDisplayedFinancials(b, ledgerSummary, statusKey);
    const { total, paid, balance, ledgerSummaryUsable } = financialSnapshot;
    const lateFeeStatus = String(b.lateFeeStatus || "").trim().toLowerCase();
    const lateFeeRaw = Number(b.lateFeeAmount || 0);
    const lateFee = (lateFeeStatus === "assessed" || lateFeeStatus === "pending_collection") && lateFeeRaw > 0
      ? lateFeeRaw
      : 0;
    const displayTotal = total + lateFee;
    const paidPct   = displayTotal > 0 ? Math.min(100, Math.round((paid / displayTotal) * 100)) : (balance === 0 ? 100 : 0);
    const paymentState = derivePaymentUiState({ booking: b, statusKey, total: displayTotal, paid, balance });
    observeContractTransition(b, financialSnapshot, paymentState, statusKey);
    const plan      = b.paymentPlan || null;
    const overdueAmount = plan?.isOverdue
      ? Number(plan.nextInstallmentAmount || 0)
      : (statusKey === "overdue" ? balance : 0);
    const nextDueText = plan?.nextDueDate ? formatPlanDate(plan.nextDueDate) : (statusKey === "overdue" ? "Past due" : "Not scheduled");
    const progressText = plan
      ? `${plan.paidInstallments || 0}/${plan.totalInstallments || plan.installments || 0}`
      : `${paidPct}%`;

    setText("dash-greeting", greeting);
    setText("dash-subtitle", "Manage payments, view recent activity, and use renter self-service tools without leaving your booking.");
    setText("s-booking-id", b.bookingId || "–");
    setHtml("s-status", `${statusBadgeHtml(b.status)} ${paymentStatusBadgeHtml(paymentState)}`);
    setText("vehicle-status-tag", statusKey === "overdue" ? "Action needed" : "Current booking details");
    setText("hero-payment-chip", paymentState.paymentChipLabel);
    setText("hero-plan-chip", plan ? `Plan: ${plan.status || "active"}` : "No active payment plan");

    const vehicleLabel = [b.vehicleYear, b.vehicleName].filter(Boolean).join(" ");
    setText("s-vehicle", vehicleLabel || "–");
    const imgEl = document.getElementById("vehicle-img");
    if (imgEl) {
      const src = resolveVehicleImageForBooking(b.vehicleId) || VEHICLE_IMAGE_PLACEHOLDER;
      imgEl.removeAttribute("src");
      imgEl.style.display = "";
      imgEl.src = src;
      imgEl.alt = vehicleLabel || "Vehicle image coming soon";
      imgEl.onerror = () => {
        imgEl.onerror = null;
        imgEl.src = VEHICLE_IMAGE_PLACEHOLDER;
      };
    }
    setText("s-pickup", formatDateTime(b.pickupDate, b.pickupTime));
    setText("s-return", formatDateTime(b.returnDate, b.returnTime));

    const dppRow = document.getElementById("dpp-row");
    const dppVal = document.getElementById("s-protection");
    if (b.hasProtectionPlan && dppRow && dppVal) {
      const tierNames = { basic: "Basic", standard: "Standard", premium: "Premium" };
      dppVal.textContent = `${tierNames[b.protectionPlanTier] || ""} Protection Plan`.trim();
      dppRow.style.display = "";
    } else if (dppRow) {
      dppRow.style.display = "none";
    }

    setText("s-total", fmt(total));
    const lateFeeRow = document.getElementById("late-fee-row");
    if (lateFeeRow) lateFeeRow.style.display = lateFee > 0 ? "" : "none";
    setText("s-late-fee", lateFee > 0 ? fmt(lateFee) : "–");
    setText("s-deposit", fmt(paid));
    setText("s-balance", fmt(balance));
    setText("stat-total", fmt(displayTotal));
    setText("stat-paid", fmt(paid));
    setText("stat-balance", fmt(balance));
    setText("stat-overdue", fmt(overdueAmount));
    setText("stat-next-due", nextDueText);
    setText("stat-plan-progress", progressText);
    const activeRenterUnder75Pct = ledgerSummaryUsable
      && ["active", "active_rental"].includes(statusKey)
      && total > 0
      && balance > 0
      && (paid / total) < 0.75;
    const activeRenter75PctDisplayNote = activeRenterUnder75Pct
      ? `Active rental notice: At least 75% of your total rental balance must be paid before an extension can be approved. You have paid ${Math.round((paid / total) * 100)}% (${fmt(paid)} of ${fmt(total)}). If your extension request does not go through yet, keep paying your balance until this threshold is met.`
      : "";
    const activeRenter75PctSecureNote = activeRenterUnder75Pct
      ? "Active renter reminder: extensions unlock after at least 75% of the total balance is paid."
      : "";

    setText("stat-paid-note", paid > 0 ? `${fmt(paid)} recorded across deposit and later payments.` : "No posted payments yet.");
    setText("stat-balance-note", activeRenter75PctDisplayNote || paymentState.balanceNote || (balance > 0 ? "Use the payment actions below to pay the remaining balance." : "No balance remains on this booking."));
    setText("stat-overdue-note", overdueAmount > 0 ? "Past-due amount requires attention." : "No overdue amount is currently flagged.");
    setText("stat-next-due-note", plan?.nextDueDate ? "Based on your active payment plan." : "No payment-plan due date is currently scheduled.");
    setText("stat-plan-progress-note", plan ? "Installment completion using the active plan." : "If a plan is created later, progress will appear here.");

    const balRow = document.getElementById("balance-row");
    if (balRow) balRow.className = balance > 0 ? "fin-row fin-balance" : "fin-row fin-zero";
    setText("progress-paid-label", paymentState.progressPaidLabel || `${fmt(paid)} paid`);
    setText("progress-pct-label", paymentState.progressPctLabel || `${paidPct}% complete`);
    const fillEl = document.getElementById("payment-progress-fill");
    if (fillEl) fillEl.style.width = `${paidPct}%`;

    const canPayBalance = paymentState.canPayRemainingOnline && balance > 0;
    currentBalance = balance;
    if (canPayBalance && $payBalSection) {
      $payBalSection.style.display = "block";
      if ($btnInitBalance) $btnInitBalance.textContent = `Pay Remaining Balance (${fmt(balance)})`;
      // Partial payments are only available to repeat renters (3rd booking or later)
      const isRepeatRenter = Number(b.renterBookingCount || 0) >= 3;
      if ($btnOpenPartial) $btnOpenPartial.style.display = isRepeatRenter ? "" : "none";
    } else if ($payBalSection) {
      $payBalSection.style.display = "none";
    }

    const secureNoteEl = $payBalSection ? $payBalSection.querySelector(".secure-note") : null;
    if (secureNoteEl) {
      secureNoteEl.textContent = DEMO_MODE
        ? "⚡ Demo mode — simulated payment methods shown."
        : activeRenter75PctSecureNote
          ? `🔒 Payments secured by Stripe. ${activeRenter75PctSecureNote}`
          : "🔒 Payments secured by Stripe.";
    }

    const pifEl = document.getElementById("paid-in-full-notice");
    if (pifEl) pifEl.style.display = paymentState.isPaidInFull ? "block" : "none";
    const depositBannerEl = document.getElementById("payment-balance-banner");
    if (depositBannerEl) {
      if (balance > 0) {
        depositBannerEl.textContent = activeRenter75PctDisplayNote || paymentState.bannerText || "Remaining balance is still due on this booking.";
        depositBannerEl.style.display = "block";
      } else {
        depositBannerEl.style.display = "none";
      }
    }

    renderPaymentPlanSummary(b, balance);
    renderLedgerSummary(b, total, paid, balance, overdueAmount);

    const extensionEligible = ["active", "active_rental", "overdue", "extended"].includes(statusKey);
    const extensionHref = buildExtensionHref(b);
    // Account-state-aware extension section: derive messaging from financial state fields.
    const extLateFeeStatus = lateFeeStatus;
    const extLateFeeAmount = lateFee;
    const extRiskOverride = String(b.extensionRiskOverride || "").trim().toLowerCase();
    const extPlanStatus = String(plan?.status || "").trim().toLowerCase();
    const extIsOverdue = statusKey === "overdue";
    const extIsPlanDelinquent = !!(plan && (plan.isOverdue || extPlanStatus === "defaulted" || extPlanStatus === "past_due"));
    const extHasActiveLateF = (extLateFeeStatus === "assessed" || extLateFeeStatus === "pending_collection") && extLateFeeAmount > 0;
    const extIsBlocked = extRiskOverride === "block";
    const extHasAnyOverdueBalance = overdueAmount > 0;
    const extUnder75PctPaid = ledgerSummaryUsable && total > 0 && (paid / total) < 0.75;
    // Block repeat extensions when any balance remains: once extended at least once,
    // the full remaining balance must be cleared before another extension is allowed.
    const extPriorExtensionWithBalance = ((b.changeCount || b.extensionCount || 0) >= 1) && balance > 0;

    let extCtaText = "⏱️ Open Extension Flow";
    let extCtaHref = extensionHref;
    let extPillText = "Eligible to review extension options";
    let extCtaNote = "Open the extension flow to select a new return date and pay online.";

    if (extIsBlocked) {
      extPillText = "Extension temporarily blocked";
      extCtaText = "📞 Contact Support";
      extCtaHref = "tel:+18445114059";
      extCtaNote = "Extension approval has been paused for this account. Contact support at (844) 511-4059 to resolve.";
    } else if (!extensionEligible) {
      extPillText = "Extension requires support";
      extCtaText = "📞 Contact Support About Extensions";
      extCtaHref = "tel:+18445114059";
      extCtaNote = "Call support to review extension options for this booking status.";
    } else if (extPlanStatus === "defaulted") {
      extPillText = "⚠️ Payment plan defaulted — manual review required";
      extCtaNote = "Extension request requires manual approval. Your payment plan has been flagged. Call (844) 511-4059.";
    } else if (extHasAnyOverdueBalance) {
      extPillText = "⚠️ Overdue balance — must be paid before extension";
      extCtaText = "💳 Pay Overdue Balance";
      extCtaHref = "#pay-balance-section";
      extCtaNote = extHasActiveLateF
        ? `Overdue balance of ${fmt(overdueAmount)} and late fees ($${extLateFeeAmount.toFixed(2)}) must be paid in full before an extension can be approved.`
        : `Overdue balance of ${fmt(overdueAmount)} must be paid in full before an extension can be approved.`;
    } else if (extIsPlanDelinquent) {
      extPillText = "⚠️ Payment plan past due — review needed";
      extCtaNote = "Partial balance payment may be required before extension. Your payment plan has a past-due installment.";
    } else if (extPriorExtensionWithBalance) {
      extPillText = "⚠️ Balance must be paid in full before next extension";
      extCtaText = "💳 Pay Remaining Balance";
      extCtaHref = "#pay-balance-section";
      extCtaNote = `You have already extended this rental and still have a remaining balance of ${fmt(balance)}. The full remaining balance must be paid before another extension can be approved.`;
    } else if (extUnder75PctPaid) {
      const pctPaid = Math.round((paid / total) * 100);
      extPillText = `⚠️ Less than 75% paid — pay balance before extension`;
      extCtaText = "💳 Pay Balance First";
      extCtaHref = "#pay-balance-section";
      extCtaNote = `At least 75% of your total rental balance must be paid before an extension can be requested. You have paid ${pctPaid}% (${fmt(paid)} of ${fmt(total)}). Please pay more of your balance first.`;
    } else if (extHasActiveLateF) {
      extPillText = "ℹ️ Late fee pending ($" + extLateFeeAmount.toFixed(2) + ")";
      extCtaNote = "Late fee of $" + extLateFeeAmount.toFixed(2) + " will be included in your extension payment at checkout.";
    }

    const extensionCta = document.getElementById("extension-cta");
    if (extensionCta) {
      extensionCta.href = extCtaHref;
      extensionCta.textContent = extCtaText;
    }
    setText("extension-status-pill", extPillText);
    setText("extension-balance", fmt(balance));
    setText("extension-overdue", fmt(overdueAmount));
    setText("extension-balance-note", balance > 0 ? "Current balance remains due before or alongside any extension arrangements." : "Your existing booking balance is currently clear.");
    setText("extension-overdue-note", overdueAmount > 0 ? "An overdue amount is currently flagged on your account." : "No overdue extension-related amount is flagged.");
    setText("extension-paid-pct-note", total > 0 ? `${Math.round((paid / total) * 100)}% of total balance paid (${fmt(paid)} of ${fmt(total)}). First extension requires at least 75% paid; any further extension requires the full balance cleared.` : "Extension requires all overdue balances cleared. Any subsequent extension also requires the full remaining balance to be paid.");
    setText("extension-cta-note", extCtaNote);

    const editableStatuses = ["reserved", "reserved_unpaid", "pending"];
    const isLocked = !editableStatuses.includes(statusKey);
    if (isLocked) {
      if ($lockNotice) {
        $lockNotice.style.display = "block";
        if (statusKey === "approved" || statusKey === "active" || statusKey === "active_rental" || statusKey === "booked_paid") {
          $lockNotice.innerHTML = "✅ Your booking is confirmed. Dates and vehicle cannot be changed online. Please call <a href=\"tel:+18445114059\">(844) 511-4059</a> if you need assistance.";
        } else if (statusKey === "overdue") {
          $lockNotice.innerHTML = "⚠️ Your rental is overdue. Please return the vehicle and contact us immediately at <a href=\"tel:+18445114059\">(844) 511-4059</a>.";
        } else if (statusKey === "pending_verification") {
          $lockNotice.innerHTML = "⏳ Your booking is under review. Please call <a href=\"tel:+18445114059\">(844) 511-4059</a> if you need to make changes.";
        } else {
          $lockNotice.innerHTML = "ℹ️ Your booking is locked. Please call <a href=\"tel:+18445114059\">(844) 511-4059</a> for assistance.";
        }
      }
      if ($editSection) $editSection.style.display = "none";
    } else {
      if ($lockNotice) $lockNotice.style.display = "none";
      if ($editSection) $editSection.style.display = "";
      renderVehicleOptions($newVehicle, b.vehicleId || "");
      const pickupEl = document.getElementById("new-pickup");
      const returnEl = document.getElementById("new-return");
      if (pickupEl && b.pickupDate) pickupEl.value = b.pickupDate;
      if (returnEl && b.returnDate) returnEl.value = b.returnDate;
      const pickupTimeEl = document.getElementById("new-pickup-time");
      const returnTimeEl = document.getElementById("new-return-time");
      if (b.pickupTime && pickupTimeEl && [...pickupTimeEl.options].some((o) => o.value === b.pickupTime)) pickupTimeEl.value = b.pickupTime;
      if (b.returnTime && returnTimeEl && [...returnTimeEl.options].some((o) => o.value === b.returnTime)) returnTimeEl.value = b.returnTime;
      if ($newProtection) {
        $newProtection.checked = !!b.hasProtectionPlan;
        if ($dppTierRow) $dppTierRow.style.display = b.hasProtectionPlan ? "block" : "none";
        const ownInsEl = document.getElementById("own-insurance-note");
        if (ownInsEl) ownInsEl.style.display = b.hasProtectionPlan ? "none" : "block";
      }
      if (b.protectionPlanTier) {
        const tierEl = document.getElementById("new-protection-tier");
        if (tierEl && [...tierEl.options].some((o) => o.value === b.protectionPlanTier)) tierEl.value = b.protectionPlanTier;
      }
    }

    if ($docAgreementLink && $docAgreementUnavailable) {
      if (agreementPdfUrl) {
        $docAgreementLink.href = agreementPdfUrl;
        $docAgreementLink.style.display = "";
        $docAgreementUnavailable.style.display = "none";
      } else {
        $docAgreementLink.style.display = "none";
        $docAgreementUnavailable.style.display = "";
      }
    }

    if ($btnDownloadLatestReceipt) {
      const canDownload = !!latestReceiptTransaction;
      $btnDownloadLatestReceipt.setAttribute("aria-disabled", canDownload ? "false" : "true");
    }
    if ($docLatestReceipt && $docLatestReceiptUnavailable) {
      $docLatestReceipt.style.display = latestReceiptTransaction ? "" : "none";
      $docLatestReceiptUnavailable.style.display = latestReceiptTransaction ? "none" : "";
    }
  }

  function renderPaymentPlanSummary(b, balance) {
    const plan = b.paymentPlan || null;
    setText("plan-status-badge", plan ? String(plan.status || "Active").replace(/^./, (c) => c.toUpperCase()) : "No active plan");
    if (!plan) {
      setDisplay("plan-empty-state", true);
      setDisplay("plan-content", false);
      return;
    }

    setDisplay("plan-empty-state", false);
    setDisplay("plan-content", true);

    const totalInstallments = Number(plan.totalInstallments || plan.installments || 0);
    const paidInstallments = Number(plan.paidInstallments || 0);
    const percent = totalInstallments > 0 ? Math.round((paidInstallments / totalInstallments) * 100) : 0;
    const planBanner = document.getElementById("plan-banner");
    const overduePill = document.getElementById("plan-overdue-pill");
    if (planBanner) planBanner.className = `plan-banner${plan.isOverdue ? " is-overdue" : ""}`;
    if (overduePill) overduePill.textContent = plan.isOverdue ? `Overdue by ${plan.overdueDays || 0} day(s)` : "On track";

    setText("plan-progress-text", `${paidInstallments} of ${totalInstallments} installments paid`);
    setText("plan-banner-note", plan.isOverdue
      ? "A payment appears overdue. Please pay today or call support if you need help."
      : "Your next payment information is current and visible below.");
    const planFill = document.getElementById("plan-progress-fill");
    if (planFill) planFill.style.width = `${percent}%`;
    setText("plan-progress-left", `${paidInstallments} paid`);
    setText("plan-progress-right", `${percent}% complete`);
    setText("plan-next-due", formatPlanDate(plan.nextDueDate));
    setText("plan-next-due-note", plan.nextDueDate
      ? (isOverdueDate(plan.nextDueDate) ? "This due date is already past due." : "Upcoming scheduled due date.")
      : "No upcoming due date is currently scheduled.");
    setText("plan-next-amount", plan.nextInstallmentAmount ? fmt(Number(plan.nextInstallmentAmount)) : "–");
    setText("plan-next-amount-note", plan.nextInstallmentNumber
      ? `Installment ${plan.nextInstallmentNumber} is next in your schedule.`
      : "No unpaid installment remains on this plan.");
    setText("plan-remaining-balance", fmt(balance));
    setText("plan-remaining-note", "Remaining balance still visible in renter payment flow.");
    setText("plan-history-summary", `${paidInstallments}/${totalInstallments}`);
    setText("plan-history-note", plan.isOverdue ? "Plan has an overdue installment." : "Plan history is currently on track.");
  }

  function renderLedgerSummary(b, total, paid, balance, overdueAmount) {
    const transactions = Array.isArray(ledgerTransactions) ? ledgerTransactions.slice(0, 6) : [];
    latestReceiptTransaction = findLatestReceiptTransaction(ledgerTransactions);
    const paymentCount = (ledgerTransactions || []).filter((tx) => tx.transaction_type === "payment" && tx.direction === "credit").length;
    const noticeCount = (ledgerTransactions || []).filter((tx) => ["late_fee", "refund", "extension"].includes(tx.transaction_type)).length
      + (overdueAmount > 0 ? 1 : 0);

    setText("history-payment-count", String(paymentCount));
    setText("history-payment-note", paymentCount > 0 ? `${paymentCount} posted payment${paymentCount === 1 ? "" : "s"} on file.` : "No posted renter payments yet.");
    setText("history-notice-count", String(noticeCount));
    setText("history-notice-note", noticeCount > 0 ? "Review recent account activity below." : "You’re all caught up right now.");
    setText("activity-summary-pill", transactions.length > 0 ? `${transactions.length} recent entries` : "Recent activity");

    if (!$activityList || !$activityEmpty) return;
    if (!transactions.length) {
      $activityList.innerHTML = "";
      $activityEmpty.style.display = "block";
      return;
    }

    $activityEmpty.style.display = "none";
    $activityList.innerHTML = transactions.map((tx) => {
      const amount = Number(tx.amount || 0);
      const amountCls = tx.direction === "credit" ? "history-item-amount is-credit" : "history-item-amount is-debit";
      const amountPrefix = tx.direction === "credit" ? "-" : "+";
      return `<div class="history-item">
        <div class="history-item-main">
          <div class="history-item-title">${escapeHtml(transactionTitle(tx))}</div>
          <div class="history-item-meta">${escapeHtml(transactionMeta(tx))}</div>
        </div>
        <div class="${amountCls}">${escapeHtml(amountPrefix + fmt(amount))}</div>
      </div>`;
    }).join("");

    if ($btnDownloadLatestReceipt) {
      const canDownload = !!latestReceiptTransaction;
      $btnDownloadLatestReceipt.setAttribute("aria-disabled", canDownload ? "false" : "true");
      $btnDownloadLatestReceipt.disabled = !canDownload;
    }
    if ($docLatestReceipt) {
      $docLatestReceipt.style.display = latestReceiptTransaction ? "" : "none";
    }
    if ($docLatestReceiptUnavailable) {
      $docLatestReceiptUnavailable.style.display = latestReceiptTransaction ? "none" : "";
    }
  }

  async function loadSupplementalData() {
    if (!booking?.bookingId) return;

    ledgerSummary = null;
    ledgerTransactions = [];
    agreementPdfUrl = null;
    latestReceiptTransaction = null;

    const ledgerPromise = fetch("/api/renter-ledger-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking_id: booking.bookingId }),
    })
      .then(async (resp) => {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.error) return null;
        return data;
      })
      .catch(() => null);

    const agreementPromise = fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_agreement_url", token: activeToken }),
    })
      .then(async (resp) => {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.error) return null;
        return data;
      })
      .catch(() => null);

    const [ledgerData, agreementData] = await Promise.all([ledgerPromise, agreementPromise]);
    if (ledgerData?.summary) {
      ledgerSummary = ledgerData.summary;
      ledgerTransactions = Array.isArray(ledgerData.transactions) ? ledgerData.transactions : [];
    }
    if (agreementData?.url) {
      agreementPdfUrl = agreementData.url;
    }
  }

  // ── Step 2: Load booking ────────────────────────────────────────────────────
  async function loadBooking() {
    if (!activeToken) {
      showSection($verifyState);
      return;
    }

    const payload = { action: "get", token: activeToken };
    console.log("[manage-booking] Step 2 — get payload:", payload);

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const data = await resp.json();
      console.log("[manage-booking] Step 2 — response (status " + resp.status + "):", data);

      if (!resp.ok || data.error) {
        if (resp.status === 401) {
          activeToken = "";
          showSection($verifyState);
          setVerifyMsg("Your session has expired. Please verify your booking again.", "error");
          return;
        }
        showError(data.error || "Could not load booking.");
        return;
      }

      booking = data;
      await loadSupplementalData();
      populateDashboard(booking);
      showSection($main);
    } catch (err) {
      showError("Network error — please try again or call (844) 511-4059.");
      console.error("[manage-booking] load error:", err);
    }
  }

  // ── Step 1: Verify identity ─────────────────────────────────────────────────
  async function verifyBooking() {
    const identifier = ($verifyIdentifier ? $verifyIdentifier.value : "").trim();
    if (!identifier) {
      setVerifyMsg("Enter the phone, email, or booking ID used on your booking.", "error");
      return;
    }

    if ($btnVerify) { $btnVerify.disabled = true; $btnVerify.textContent = "Verifying…"; }
    setVerifyMsg("", null);

    const payload = { action: "verify", identifier };
    console.log("[manage-booking] Step 1 — verify payload:", payload);

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const data = await resp.json();
      console.log("[manage-booking] Step 1 — verify response (status " + resp.status + "):", data);

      if (!resp.ok) {
        setVerifyMsg(data.error || "Verification failed. Please check your information and try again.", "error");
        return;
      }
      if (!data.token) {
        setVerifyMsg("Verification failed. Please try again.", "error");
        return;
      }

      activeToken = data.token;
      setVerifyMsg("Verified! Loading your booking…", "success");
      showSection($loading);
      await loadBooking();
    } catch (err) {
      setVerifyMsg("Network error. Please try again.", "error");
      console.error("[manage-booking] Step 1 — verify error:", err);
    } finally {
      if ($btnVerify) { $btnVerify.disabled = false; $btnVerify.textContent = "Access My Booking"; }
    }
  }

  // ── DPP tier toggle ─────────────────────────────────────────────────────────
  if ($newProtection) {
    $newProtection.addEventListener("change", () => {
      if ($dppTierRow) $dppTierRow.style.display = $newProtection.checked ? "block" : "none";
      const ownInsEl = document.getElementById("own-insurance-note");
      if (ownInsEl) ownInsEl.style.display = $newProtection.checked ? "none" : "block";
      if ($pricePreview) $pricePreview.style.display = "none";
      if ($btnApply)    $btnApply.style.display     = "none";
      if ($paidSection) $paidSection.style.display  = "none";
    });
  }

  // ── Preview pricing ─────────────────────────────────────────────────────────
  if ($btnPreview) {
    $btnPreview.addEventListener("click", async () => {
      const newPickup   = document.getElementById("new-pickup")?.value;
      const newReturn   = document.getElementById("new-return")?.value;
      const newPickupT  = document.getElementById("new-pickup-time")?.value;
      const newReturnT  = document.getElementById("new-return-time")?.value;
      const hasDpp      = !!$newProtection?.checked;
      const dppTier     = hasDpp ? document.getElementById("new-protection-tier")?.value : null;
      const newVehicleId = ($newVehicle?.value || "").trim() || undefined;

      if (!newPickup || !newReturn) {
        setActionMsg("Please select both pickup and return dates.", "error");
        return;
      }
      if (newReturn < newPickup) {
        setActionMsg("Return date must be on or after pickup date.", "error");
        return;
      }

      $btnPreview.disabled    = true;
      $btnPreview.textContent = "Checking…";
      setActionMsg("", null);

      try {
        const resp = await fetch(API_BASE, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action:                "check_availability",
            token:                 activeToken,
            newPickupDate:         newPickup,
            newReturnDate:         newReturn,
            newPickupTime:         newPickupT || undefined,
            newReturnTime:         newReturnT || undefined,
            newVehicleId,
            newProtectionPlan:     hasDpp,
            newProtectionPlanTier: dppTier,
          }),
        });
        const data = await resp.json();

        if (!resp.ok) {
          setActionMsg(data.error || "Could not check availability.", "error");
          return;
        }
        if (!data.available) {
          setActionMsg(data.reason || "These dates are not available.", "error");
          if ($pricePreview) $pricePreview.style.display = "none";
          if ($btnApply)     $btnApply.style.display     = "none";
          if ($paidSection)  $paidSection.style.display  = "none";
          return;
        }

        previewData = data;
        if ($previewTotal) $previewTotal.textContent = fmt(data.newTotal);
        if ($previewBal)   $previewBal.textContent   = fmt(data.newBalanceDue);
        if ($pricePreview) $pricePreview.style.display = "block";

        if (data.changeFeeRequired) {
          if ($feeNotice) { $feeNotice.textContent = `A $${data.changeFee} change fee is required.`; $feeNotice.style.display = "block"; }
          if ($btnApply)   $btnApply.style.display  = "none";
          if ($changeFeeAmt) $changeFeeAmt.textContent = `$${data.changeFee}`;
          if ($paidSection) $paidSection.style.display = "block";
          await mountStripeElement(activeToken);
        } else {
          if ($feeNotice)   $feeNotice.style.display   = "none";
          if ($btnApply)    $btnApply.style.display     = "block";
          if ($paidSection) $paidSection.style.display  = "none";
        }
        setActionMsg("", null);
      } catch (err) {
        setActionMsg("Network error. Please try again.", "error");
        console.error("[manage-booking] preview error:", err);
      } finally {
        if ($btnPreview) { $btnPreview.disabled = false; $btnPreview.textContent = "Preview Pricing"; }
      }
    });
  }

  // ── Apply free change ───────────────────────────────────────────────────────
  if ($btnApply) {
    $btnApply.addEventListener("click", async () => {
      const newPickup   = document.getElementById("new-pickup")?.value;
      const newReturn   = document.getElementById("new-return")?.value;
      const newPickupT  = document.getElementById("new-pickup-time")?.value;
      const newReturnT  = document.getElementById("new-return-time")?.value;
      const hasDpp      = !!$newProtection?.checked;
      const dppTier     = hasDpp ? document.getElementById("new-protection-tier")?.value : null;
      const newVehicleId = ($newVehicle?.value || "").trim() || undefined;

      $btnApply.disabled    = true;
      $btnApply.textContent = "Applying…";
      setActionMsg("", null);

      try {
        const resp = await fetch(API_BASE, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action:                "apply_change",
            token:                 activeToken,
            newPickupDate:         newPickup,
            newReturnDate:         newReturn,
            newPickupTime:         newPickupT || undefined,
            newReturnTime:         newReturnT || undefined,
            newVehicleId,
            newProtectionPlan:     hasDpp,
            newProtectionPlanTier: dppTier,
          }),
        });
        const data = await resp.json();

        if (!resp.ok) {
          setActionMsg(data.error || "Failed to apply change.", "error");
          return;
        }
        setActionMsg("✅ Booking updated! Reloading…", "success");
        setTimeout(() => window.location.reload(), 1800);
      } catch (err) {
        setActionMsg("Network error. Please try again.", "error");
        console.error("[manage-booking] apply error:", err);
      } finally {
        if ($btnApply) { $btnApply.disabled = false; $btnApply.textContent = "Apply Change (Free)"; }
      }
    });
  }

  // ── Mount Stripe card element for change fee ────────────────────────────────
  async function mountStripeElement(token) {
    if (stripeInstance) return;
    const newPickup   = document.getElementById("new-pickup")?.value;
    const newReturn   = document.getElementById("new-return")?.value;
    const newPickupT  = document.getElementById("new-pickup-time")?.value;
    const newReturnT  = document.getElementById("new-return-time")?.value;
    const hasDpp      = !!$newProtection?.checked;
    const dppTier     = hasDpp ? document.getElementById("new-protection-tier")?.value : null;
    const newVehicleId = ($newVehicle?.value || "").trim() || undefined;

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action:                "initiate_paid_change",
          token,
          newPickupDate:         newPickup,
          newReturnDate:         newReturn,
          newPickupTime:         newPickupT || undefined,
          newReturnTime:         newReturnT || undefined,
          newVehicleId,
          newProtectionPlan:     hasDpp,
          newProtectionPlanTier: dppTier,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.clientSecret) {
        if ($stripeErr) { $stripeErr.textContent = data.error || "Could not initialize payment."; $stripeErr.style.display = "block"; }
        return;
      }
      if (typeof Stripe === "undefined") { // eslint-disable-line no-undef
        if ($stripeErr) { $stripeErr.textContent = "Payment library failed to load. Please refresh."; $stripeErr.style.display = "block"; }
        return;
      }
      stripeInstance = Stripe(data.publishableKey); // eslint-disable-line no-undef
      stripeElements = stripeInstance.elements();
      stripeCardEl   = stripeElements.create("card");
      if ($stripeEl) stripeCardEl.mount($stripeEl);
      stripeCardEl.on("change", (e) => {
        if ($stripeErr) { $stripeErr.style.display = e.error ? "block" : "none"; if (e.error) $stripeErr.textContent = e.error.message; }
      });
      if ($btnPayFee) $btnPayFee.dataset.clientSecret = data.clientSecret;
    } catch (err) {
      if ($stripeErr) { $stripeErr.textContent = "Network error. Please try again."; $stripeErr.style.display = "block"; }
      console.error("[manage-booking] Stripe mount error:", err);
    }
  }

  // ── Pay change fee ──────────────────────────────────────────────────────────
  if ($btnPayFee) {
    $btnPayFee.addEventListener("click", async () => {
      if (!stripeInstance || !stripeCardEl) {
        if ($stripeErr) { $stripeErr.textContent = "Payment not initialized. Please refresh."; $stripeErr.style.display = "block"; }
        return;
      }
      const clientSecret = $btnPayFee.dataset.clientSecret;
      if (!clientSecret) {
        if ($stripeErr) { $stripeErr.textContent = "Missing payment session. Please refresh."; $stripeErr.style.display = "block"; }
        return;
      }
      $btnPayFee.disabled    = true;
      $btnPayFee.textContent = "Processing…";
      if ($stripeErr) $stripeErr.style.display = "none";

      try {
        const result = await stripeInstance.confirmCardPayment(clientSecret, {
          payment_method: { card: stripeCardEl },
        });
        if (result.error) {
          if ($stripeErr) { $stripeErr.textContent = result.error.message; $stripeErr.style.display = "block"; }
        } else if (result.paymentIntent?.status === "succeeded") {
          setActionMsg("✅ Change fee paid! Your booking is being updated. Reloading…", "success");
          setTimeout(() => window.location.reload(), 2500);
        }
      } catch (err) {
        if ($stripeErr) { $stripeErr.textContent = "Payment error. Please try again."; $stripeErr.style.display = "block"; }
        console.error("[manage-booking] pay fee error:", err);
      } finally {
        if ($btnPayFee) { $btnPayFee.disabled = false; $btnPayFee.textContent = "Pay Change Fee & Apply"; }
      }
    });
  }

  // ── Pay remaining balance ───────────────────────────────────────────────────
  if ($btnInitBalance) {
    $btnInitBalance.addEventListener("click", async () => {
      // Close partial payment section if open
      if ($partialSection) $partialSection.style.display = "none";

      // Demo mode: show simulated payment method picker instead of Stripe
      if (DEMO_MODE) {
        showDemoPaymentPicker({
          amount: currentBalance || Number(booking?.balanceDue || 0),
          containerEl: $balanceWrap,
          onSuccess(method) {
            setActionMsg(`✅ Demo payment via ${method.badge} confirmed. Refreshing balance…`, "success", document.getElementById("action-msg-finance"));
            setTimeout(() => loadBooking(), 1800);
          },
        });
        return;
      }

      $btnInitBalance.disabled    = true;
      $btnInitBalance.textContent = "Loading Payment…";
      if ($balanceError) $balanceError.style.display = "none";

      try {
        const resp = await fetch(API_BASE, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ action: "create_balance_payment_intent", token: activeToken }),
        });
        const data = await resp.json();

        if (!resp.ok || !data.clientSecret) {
          if ($balanceError) { $balanceError.textContent = data.error || "Could not initialize balance payment."; $balanceError.style.display = "block"; }
          return;
        }
        if (typeof Stripe === "undefined") { // eslint-disable-line no-undef
          if ($balanceError) { $balanceError.textContent = "Payment library failed to load. Please refresh."; $balanceError.style.display = "block"; }
          return;
        }
        unmountStripeElement(balancePayEl);
        unmountStripeElement(balanceExpressCheckoutEl);
        hideStripeExpress($balanceExpressWrap, $balanceExpressEl);
        balanceStripe   = Stripe(data.publishableKey); // eslint-disable-line no-undef
        balanceElements = balanceStripe.elements({ clientSecret: data.clientSecret, locale: resolveStripeLocale() });
        balanceExpressCheckoutEl = mountExpressCheckoutElement({
          stripe: balanceStripe,
          elements: balanceElements,
          wrapperEl: $balanceExpressWrap,
          containerEl: $balanceExpressEl,
          errorEl: $balanceError,
        });
        balancePayEl    = balanceElements.create("payment", {
          fields: { billingDetails: { name: "never" } },
        });
        if ($balanceStripeEl) { $balanceStripeEl.innerHTML = ""; balancePayEl.mount($balanceStripeEl); }
        if ($balanceWrap) $balanceWrap.style.display = "block";
        const balAmt = Number(data.balanceAmount || booking?.balanceDue || 0);
        if ($btnConfirmBal) $btnConfirmBal.textContent = `Pay ${fmt(balAmt)}`;
      } catch (err) {
        if ($balanceError) { $balanceError.textContent = "Network error. Please try again."; $balanceError.style.display = "block"; }
        console.error("[manage-booking] balance init error:", err);
      } finally {
        if ($btnInitBalance) {
          $btnInitBalance.disabled    = false;
          $btnInitBalance.textContent = `Pay Remaining Balance (${fmt(currentBalance || Number(booking?.balanceDue || 0))})`;
        }
      }
    });
  }

  if ($btnConfirmBal) {
    $btnConfirmBal.addEventListener("click", async () => {
      if (!balanceStripe || !balanceElements) return;
      $btnConfirmBal.disabled    = true;
      $btnConfirmBal.textContent = "Processing…";
      if ($balanceError) $balanceError.style.display = "none";

      try {
        const result = await balanceStripe.confirmPayment({
          elements: balanceElements,
          confirmParams: { return_url: window.location.href },
          redirect: "if_required",
        });
        if (result.error) {
          if ($balanceError) { $balanceError.textContent = result.error.message || "Payment failed. Please try again."; $balanceError.style.display = "block"; }
          return;
        }
        if (result.paymentIntent?.status === "succeeded") {
          setActionMsg("✅ Payment received. Updating your booking…", "success", document.getElementById("action-msg-finance"));
          setTimeout(() => window.location.reload(), PAYMENT_SUCCESS_RELOAD_DELAY_MS);
        }
      } catch (err) {
        if ($balanceError) { $balanceError.textContent = "Payment failed. Please try again."; $balanceError.style.display = "block"; }
        console.error("[manage-booking] balance pay error:", err);
      } finally {
        if ($btnConfirmBal) { $btnConfirmBal.disabled = false; $btnConfirmBal.textContent = "Confirm Payment"; }
      }
    });
  }

  // ── Open/close partial payment section ──────────────────────────────────────
  if ($btnOpenPartial) {
    $btnOpenPartial.addEventListener("click", () => {
      if (!$partialSection) return;
      const isVisible = $partialSection.style.display !== "none";
      if (isVisible) {
        $partialSection.style.display = "none";
        return;
      }
      // Close the full balance panel if open
      if ($balanceWrap) $balanceWrap.style.display = "none";

      // Seed the amount input with the current balance
      const maxAmt = currentBalance || Number(booking?.balanceDue || 0);
      if ($partialAmtInput) {
        $partialAmtInput.max   = maxAmt.toFixed(2);
        $partialAmtInput.value = maxAmt.toFixed(2);
      }
      updatePartialPreview();

      // Reset Stripe section
      if ($partialStripeEl) $partialStripeEl.style.display = "none";
      hideStripeExpress($partialExpressWrap, $partialExpressEl);
      if ($btnConfirmPartial) $btnConfirmPartial.style.display = "none";
      if ($partialError) $partialError.style.display = "none";
      if ($btnInitPartial) { $btnInitPartial.disabled = false; $btnInitPartial.textContent = "Initialize Payment"; }

      $partialSection.style.display = "block";
    });
  }

  function updatePartialPreview() {
    if (!$partialPreview || !$partialAmtInput) return;
    const maxAmt = currentBalance || Number(booking?.balanceDue || 0);
    const val = Math.round(parseFloat($partialAmtInput.value) * 100) / 100;
    if (!Number.isFinite(val) || val <= 0) {
      $partialPreview.textContent = "";
      return;
    }
    if (val > maxAmt) {
      $partialPreview.innerHTML = `<span style="color:#c62828">Amount exceeds remaining balance (${fmt(maxAmt)})</span>`;
      return;
    }
    const remaining = Math.max(0, Math.round((maxAmt - val) * 100) / 100);
    $partialPreview.innerHTML = remaining > 0
      ? `After payment: <strong style="color:#b45309">${fmt(remaining)} still due</strong>`
      : `<span style="color:#2e7d32">✓ Pays balance in full</span>`;
  }

  if ($partialAmtInput) {
    $partialAmtInput.addEventListener("input", updatePartialPreview);
  }

  if ($partialMaxBtn) {
    $partialMaxBtn.addEventListener("click", () => {
      if (!$partialAmtInput) return;
      const maxAmt = currentBalance || Number(booking?.balanceDue || 0);
      $partialAmtInput.value = maxAmt.toFixed(2);
      updatePartialPreview();
    });
  }

  // ── Initialize partial payment ───────────────────────────────────────────────
  if ($btnInitPartial) {
    $btnInitPartial.addEventListener("click", async () => {
      if ($partialError) $partialError.style.display = "none";
      const maxAmt = currentBalance || Number(booking?.balanceDue || 0);
      const requestedAmt = Math.round(parseFloat($partialAmtInput?.value || "0") * 100) / 100;

      if (!Number.isFinite(requestedAmt) || requestedAmt <= 0) {
        if ($partialError) { $partialError.textContent = "Enter a valid payment amount."; $partialError.style.display = "block"; }
        return;
      }
      if (requestedAmt > maxAmt) {
        if ($partialError) { $partialError.textContent = `Amount exceeds remaining balance (${fmt(maxAmt)}).`; $partialError.style.display = "block"; }
        return;
      }

      // Demo mode: show simulated payment method picker instead of Stripe
      if (DEMO_MODE) {
        showDemoPaymentPicker({
          amount: requestedAmt,
          containerEl: $partialSection,
          onSuccess(method) {
            if ($partialAmtInput) $partialAmtInput.disabled = false;
            if ($partialMaxBtn) $partialMaxBtn.disabled = false;
            setActionMsg(`✅ Demo payment via ${method.badge} confirmed. Refreshing balance…`, "success", document.getElementById("action-msg-finance"));
            setTimeout(() => loadBooking(), 1800);
          },
        });
        return;
      }

      $btnInitPartial.disabled    = true;
      $btnInitPartial.textContent = "Preparing Payment…";

      // Unmount any previous partial Stripe element
      if (partialPayEl) { try { partialPayEl.unmount(); } catch (_e) { /* ok */ } partialPayEl = null; }
      unmountStripeElement(partialExpressCheckoutEl);
      partialStripe = null; partialElements = null;
      hideStripeExpress($partialExpressWrap, $partialExpressEl);
      if ($partialStripeEl) $partialStripeEl.innerHTML = "";

      try {
        const isFullBalance = Math.round(requestedAmt * 100) === Math.round(maxAmt * 100);
        const body = { action: "create_balance_payment_intent", token: activeToken };
        if (!isFullBalance) body.payment_amount = requestedAmt;

        const resp = await fetch(API_BASE, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });
        const data = await resp.json();

        if (!resp.ok || !data.clientSecret) {
          if ($partialError) { $partialError.textContent = data.error || "Could not initialize payment."; $partialError.style.display = "block"; }
          return;
        }
        if (typeof Stripe === "undefined") { // eslint-disable-line no-undef
          if ($partialError) { $partialError.textContent = "Payment library failed to load. Please refresh."; $partialError.style.display = "block"; }
          return;
        }

        partialStripe   = Stripe(data.publishableKey); // eslint-disable-line no-undef
        partialElements = partialStripe.elements({ clientSecret: data.clientSecret, locale: resolveStripeLocale() });
        partialExpressCheckoutEl = mountExpressCheckoutElement({
          stripe: partialStripe,
          elements: partialElements,
          wrapperEl: $partialExpressWrap,
          containerEl: $partialExpressEl,
          errorEl: $partialError,
        });
        partialPayEl    = partialElements.create("payment", {
          fields: { billingDetails: { name: "never" } },
        });
        if ($partialStripeEl) {
          $partialStripeEl.style.display = "block";
          partialPayEl.mount($partialStripeEl);
        }
        const payAmt = Number(data.paymentAmount || requestedAmt);
        if ($btnConfirmPartial) {
          $btnConfirmPartial.textContent = `Pay ${fmt(payAmt)}`;
          $btnConfirmPartial.style.display = "";
          $btnConfirmPartial.disabled = false;
        }
        // Disable amount inputs while payment is initialized
        if ($partialAmtInput) $partialAmtInput.disabled = true;
        if ($partialMaxBtn) $partialMaxBtn.disabled = true;
      } catch (err) {
        if ($partialError) { $partialError.textContent = "Network error. Please try again."; $partialError.style.display = "block"; }
        console.error("[manage-booking] partial init error:", err);
      } finally {
        if ($btnInitPartial) { $btnInitPartial.disabled = false; $btnInitPartial.textContent = "Initialize Payment"; }
      }
    });
  }

  // ── Confirm partial payment ──────────────────────────────────────────────────
  if ($btnConfirmPartial) {
    $btnConfirmPartial.addEventListener("click", async () => {
      if (!partialStripe || !partialElements) return;
      $btnConfirmPartial.disabled    = true;
      $btnConfirmPartial.textContent = "Processing…";
      if ($partialError) $partialError.style.display = "none";

      try {
        const result = await partialStripe.confirmPayment({
          elements: partialElements,
          confirmParams: { return_url: window.location.href },
          redirect: "if_required",
        });
        if (result.error) {
          if ($partialError) { $partialError.textContent = result.error.message || "Payment failed. Please try again."; $partialError.style.display = "block"; }
          return;
        }
        if (result.paymentIntent?.status === "succeeded") {
          setActionMsg("✅ Payment received. Updating your booking…", "success", document.getElementById("action-msg-finance"));
          setTimeout(() => window.location.reload(), PAYMENT_SUCCESS_RELOAD_DELAY_MS);
        }
      } catch (err) {
        if ($partialError) { $partialError.textContent = "Payment failed. Please try again."; $partialError.style.display = "block"; }
        console.error("[manage-booking] partial pay error:", err);
      } finally {
        if ($btnConfirmPartial) { $btnConfirmPartial.disabled = false; $btnConfirmPartial.textContent = "Confirm Payment"; }
      }
    });
  }

  if ($btnViewPlan) {
    $btnViewPlan.addEventListener("click", () => {
      const planCard = document.getElementById("payment-plan-card");
      if (planCard) planCard.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  if ($openRenterChatbot) {
    $openRenterChatbot.addEventListener("click", () => {
      const toggle = document.getElementById("chat-toggle");
      if (toggle) {
        toggle.click();
        return;
      }
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    });
  }

  function handleReceiptDownload() {
    if (!latestReceiptTransaction) return;
    downloadReceiptForTransaction(latestReceiptTransaction);
  }

  if ($btnDownloadLatestReceipt) {
    $btnDownloadLatestReceipt.addEventListener("click", handleReceiptDownload);
  }
  if ($docLatestReceipt) {
    $docLatestReceipt.addEventListener("click", handleReceiptDownload);
  }

  // ── Retry button in error state ─────────────────────────────────────────────
  if ($btnRetry) {
    $btnRetry.addEventListener("click", () => {
      showSection($verifyState);
    });
  }

  // ── Verify button ───────────────────────────────────────────────────────────
  if ($btnVerify) {
    $btnVerify.addEventListener("click", verifyBooking);
  }
  if ($verifyIdentifier) {
    $verifyIdentifier.addEventListener("keydown", (e) => {
      if (e.key === "Enter") verifyBooking();
    });
  }

  if (DEMO_MODE) installManageBookingDemoFetchInterceptor();

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  (async function bootstrap() {
    await Promise.all([loadVehicleOptions(), loadVehicleMedia()]);
    if (activeToken) {
      showSection($loading);
      await loadBooking();
      return;
    }
    showSection($verifyState);
  })();
})();
