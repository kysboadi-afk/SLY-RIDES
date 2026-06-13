import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

const scriptPath = path.join(process.cwd(), "manage-booking.js");

function makeJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

async function bootDashboard({ bookingPayload, ledgerPayload, agreementPayload, createIntentPayload, setupWindow, vehiclesPayload }) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="verify-state"></div>
    <input id="verify-identifier" />
    <div id="verify-msg"></div>
    <button id="btn-verify"></button>
    <div id="loading-state"></div>
    <div id="error-state"></div>
    <div id="error-msg"></div>
    <div id="main-content"></div>
    <div id="hero-payment-chip"></div>
    <div id="s-total"></div>
    <div id="s-balance"></div>
    <div id="stat-total"></div>
    <div id="progress-paid-label"></div>
    <div id="progress-pct-label"></div>
    <div id="payment-progress-fill"></div>
    <div id="pay-balance-section" style="display:none"></div>
    <button id="btn-init-balance">Pay Balance</button>
    <button id="btn-open-partial" style="display:none"></button>
    <div id="paid-in-full-notice" style="display:none"></div>
    <div id="stat-balance-note"></div>
    <div id="action-msg-finance"></div>
    <div id="balance-payment-wrap" style="display:none"></div>
    <div id="balance-express-wrap" style="display:none"></div>
    <div id="balance-express-checkout"></div>
    <div id="balance-stripe-element"></div>
    <div id="balance-error" style="display:none"></div>
    <button id="btn-confirm-balance">Confirm Balance</button>
    <div id="partial-payment-section" style="display:none"></div>
    <input id="partial-amount-input" />
    <button id="partial-max-btn">Pay Max</button>
    <div id="partial-amount-preview"></div>
    <button id="btn-init-partial">Init Partial</button>
    <div id="partial-express-wrap" style="display:none"></div>
    <div id="partial-express-checkout"></div>
    <div id="partial-stripe-element" style="display:none"></div>
    <div id="partial-error" style="display:none"></div>
    <button id="btn-confirm-partial" style="display:none">Confirm Partial</button>
    <a id="extension-cta" href="#"></a>
    <div id="extension-status-pill"></div>
    <div id="extension-balance"></div>
    <div id="extension-overdue"></div>
    <div id="extension-balance-note"></div>
    <div id="extension-overdue-note"></div>
    <div id="extension-cta-note"></div>
    <div id="payment-balance-banner"></div>
  </body></html>`, {
    url: "https://slycarrentals.com/manage-booking.html?t=test-token",
    runScripts: "outside-only",
  });

  const { window } = dom;
  window.fetch = async (url, options = {}) => {
    if (String(url).includes("/api/v2-vehicles")) {
      return makeJsonResponse(200, vehiclesPayload || [{ id: "camry", name: "Camry 2012" }]);
    }
    if (String(url).includes("/api/renter-ledger-summary")) {
      return makeJsonResponse(200, ledgerPayload);
    }
    if (String(url).includes("/api/manage-booking")) {
      const body = JSON.parse(options.body || "{}");
      if (body.action === "get") return makeJsonResponse(200, bookingPayload);
      if (body.action === "get_agreement_url") return makeJsonResponse(200, agreementPayload || {});
      if (body.action === "create_balance_payment_intent") {
        if (createIntentPayload) return makeJsonResponse(200, createIntentPayload);
        return makeJsonResponse(400, { error: "missing createIntentPayload" });
      }
      return makeJsonResponse(400, { error: "unexpected action" });
    }
    return makeJsonResponse(404, { error: "unexpected URL" });
  };
  window.scrollTo = () => {};
  if (typeof setupWindow === "function") setupWindow(window);

  const source = await fs.readFile(scriptPath, "utf8");
  window.eval(source);

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  return window.document;
}

function baseBooking(overrides = {}) {
  return {
    bookingId: "bk-ui-001",
    vehicleId: "camry",
    vehicleName: "Camry 2012",
    pickupDate: "2026-06-01",
    returnDate: "2026-06-07",
    pickupTime: "10:00 AM",
    returnTime: "10:00 AM",
    status: "reserved",
    paymentStatus: "partial",
    category: "car",
    totalPrice: 385.88,
    depositPaid: 50,
    balanceDue: 335.88,
    customerName: "Test Renter",
    customerEmail: "test@example.com",
    customerPhone: "3105550100",
    changeCount: 0,
    paymentPlan: null,
    customerTier: "vip",
    isVipClient: true,
    renterBookingCount: 3,
    ...overrides,
  };
}

function getExtensionQuery(document) {
  const href = document.getElementById("extension-cta").href;
  return new URL(href).searchParams;
}

test("deposit-only booking keeps DB remaining balance when ledger is empty", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking(),
    ledgerPayload: {
      summary: {
        total_paid: 0,
        remaining_balance: 0,
        transaction_count: 0,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("s-balance").textContent, "$335.88");
  assert.equal(document.getElementById("progress-paid-label").textContent, "Reservation Deposit Paid ✅");
  assert.equal(document.getElementById("progress-pct-label").textContent, "$335.88 remaining");
  assert.match(document.getElementById("hero-payment-chip").textContent, /\$335\.88.*remaining/);
  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
  assert.equal(document.getElementById("paid-in-full-notice").style.display, "none");
});

test("deposit-only reservation ignores zeroed ledger balance and keeps remaining amount actionable", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking(),
    ledgerPayload: {
      summary: {
        total_paid: 50,
        total_charges: 0,
        remaining_balance: 0,
        transaction_count: 1,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("s-balance").textContent, "$335.88");
  assert.equal(document.getElementById("progress-paid-label").textContent, "Reservation Deposit Paid ✅");
  assert.equal(document.getElementById("progress-pct-label").textContent, "$335.88 remaining");
  assert.equal(document.getElementById("payment-progress-fill").style.width, "13%");
  assert.equal(document.getElementById("btn-init-balance").textContent, "Pay Remaining Balance ($335.88)");
  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
  assert.equal(document.getElementById("btn-open-partial").style.display, "");
  assert.equal(document.getElementById("paid-in-full-notice").style.display, "none");
});

test("non-VIP renters do not see the partial payment button", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({ customerTier: "standard", isVipClient: false, renterBookingCount: 7 }),
    ledgerPayload: {
      summary: {
        total_paid: 50,
        total_charges: 0,
        remaining_balance: 0,
        transaction_count: 1,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
  assert.equal(document.getElementById("btn-open-partial").style.display, "none");
});

test("partial-balance ledger summary updates remaining amount and payment progress", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking(),
    ledgerPayload: {
      summary: {
        total_paid: 200,
        remaining_balance: 185.88,
        transaction_count: 3,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("s-balance").textContent, "$185.88");
  assert.equal(document.getElementById("progress-paid-label").textContent, "Reservation Deposit Paid ✅");
  assert.equal(document.getElementById("progress-pct-label").textContent, "$185.88 remaining");
  assert.match(document.getElementById("hero-payment-chip").textContent, /\$185\.88.*remaining/);
  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
});

test("ledger total charges are reflected in rental total display for manual add-on balances", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      totalPrice: 47.41,
      depositPaid: 0,
      balanceDue: 47.41,
      paymentStatus: "pending",
    }),
    ledgerPayload: {
      summary: {
        total_paid: 0,
        total_charges: 106.64,
        remaining_balance: 106.64,
        transaction_count: 2,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("s-total").textContent, "$106.64");
  assert.equal(document.getElementById("stat-total").textContent, "$106.64");
  assert.equal(document.getElementById("s-balance").textContent, "$106.64");
  assert.equal(document.getElementById("btn-init-balance").textContent, "Pay Remaining Balance ($106.64)");
});

test("reserved_unpaid deposit booking keeps remaining balance online-payable", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "reserved_unpaid",
      paymentStatus: "partial",
    }),
    ledgerPayload: {
      summary: {
        total_paid: 50,
        remaining_balance: 335.88,
        transaction_count: 1,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("hero-payment-chip").textContent, "Deposit Paid ✅ • $335.88 remaining");
  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
  assert.equal(document.getElementById("btn-init-balance").textContent, "Pay Remaining Balance ($335.88)");
  assert.equal(document.getElementById("paid-in-full-notice").style.display, "none");
});

test("reservation partial payment derives remaining amount from total paid when ledger balance is zeroed", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking(),
    ledgerPayload: {
      summary: {
        total_paid: 200,
        total_charges: 0,
        remaining_balance: 0,
        transaction_count: 2,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("s-balance").textContent, "$185.88");
  assert.equal(document.getElementById("progress-paid-label").textContent, "Reservation Deposit Paid ✅");
  assert.equal(document.getElementById("progress-pct-label").textContent, "$185.88 remaining");
  assert.equal(document.getElementById("payment-progress-fill").style.width, "52%");
  assert.match(document.getElementById("hero-payment-chip").textContent, /\$185\.88.*remaining/);
  assert.equal(document.getElementById("btn-init-balance").textContent, "Pay Remaining Balance ($185.88)");
  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
});

test("contract transition observability logs lifecycle and financial mismatches", async () => {
  const warns = [];
  await bootDashboard({
    bookingPayload: baseBooking({
      paymentLifecycleState: "completed",
      canPayRemainingOnline: false,
      contractTransitionObservability: {
        canonicalLifecycleState: "completed",
        canonicalFinancialSnapshot: { total: 385.88, paid: 50, balance: 335.88 },
        fallbackPaths: [],
        surfacesUsingLegacyDerivations: ["manage_booking_dashboard"],
      },
    }),
    ledgerPayload: {
      summary: {
        total_paid: 200,
        total_charges: 0,
        remaining_balance: 0,
        transaction_count: 2,
      },
      transactions: [],
    },
    agreementPayload: {},
    setupWindow(window) {
      window.console = {
        ...console,
        log() {},
        info() {},
        error() {},
        warn(...args) { warns.push(args); },
      };
    },
  });

  const warningEvents = warns
    .filter(([msg]) => msg === "[manage-booking][contract-transition]")
    .map(([, payload]) => payload?.event);
  assert.ok(warningEvents.includes("financial_snapshot_mismatch"));
  assert.ok(warningEvents.includes("lifecycle_state_mismatch"));
});

test("contract transition observability logs fallback usage and legacy derivation surfaces", async () => {
  const infos = [];
  await bootDashboard({
    bookingPayload: baseBooking({
      contractTransitionObservability: {
        canonicalLifecycleState: "deposit_paid",
        canonicalFinancialSnapshot: { total: 385.88, paid: 50, balance: 335.88 },
        fallbackPaths: [{ path: "supabase_compat_columns", source: "bookings_select" }],
        surfacesUsingLegacyDerivations: ["manage_booking_dashboard"],
      },
    }),
    ledgerPayload: {
      summary: {
        total_paid: 200,
        total_charges: 0,
        remaining_balance: 0,
        transaction_count: 2,
      },
      transactions: [],
    },
    agreementPayload: {},
    setupWindow(window) {
      window.console = {
        ...console,
        log() {},
        warn() {},
        error() {},
        info(...args) { infos.push(args); },
      };
    },
  });

  const infoPayloads = infos
    .filter(([msg]) => msg === "[manage-booking][contract-transition]")
    .map(([, payload]) => payload || {});
  assert.ok(infoPayloads.some((payload) => payload.event === "fallback_path_used" && payload.path === "reservation_total_minus_paid"));
  assert.ok(infoPayloads.some((payload) => payload.event === "fallback_path_used" && payload.path === "supabase_compat_columns"));
  assert.ok(infoPayloads.some((payload) => payload.event === "legacy_derivation_surface_used" && payload.surface === "manage_booking_dashboard"));
});

test("full-payment transition shows paid-in-full and hides pay-balance CTA", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "booked_paid",
      paymentStatus: "paid",
      depositPaid: 385.88,
      balanceDue: 0,
    }),
    ledgerPayload: {
      summary: {
        total_paid: 385.88,
        remaining_balance: 0,
        transaction_count: 2,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("hero-payment-chip").textContent, "Paid in full");
  assert.equal(document.getElementById("pay-balance-section").style.display, "none");
  assert.equal(document.getElementById("paid-in-full-notice").style.display, "block");
});

test("active-rental flow still shows actionable balance when DB balance is outstanding", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      totalPrice: 500,
      depositPaid: 200,
      balanceDue: 300,
    }),
    ledgerPayload: {
      summary: {
        total_paid: 0,
        remaining_balance: 0,
        transaction_count: 0,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("s-balance").textContent, "$300.00");
  assert.equal(document.getElementById("hero-payment-chip").textContent, "$300.00 currently due");
  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
});

test("payment init mounts express checkout for balance and partial flows", async () => {
  const createCalls = [];
  const stripeFactory = () => ({
    elements() {
      return {
        create(type) {
          createCalls.push(type);
          const handlers = {};
          return {
            on(eventName, cb) { handlers[eventName] = cb; },
            mount() {
              if (type === "expressCheckout" && typeof handlers.ready === "function") {
                handlers.ready({ availablePaymentMethods: { applePay: true, googlePay: true, cashApp: true } });
              }
            },
            unmount() {},
          };
        },
      };
    },
    async confirmPayment() {
      return { paymentIntent: { status: "requires_payment_method" } };
    },
  });

  const document = await bootDashboard({
    bookingPayload: baseBooking(),
    ledgerPayload: {
      summary: {
        total_paid: 50,
        remaining_balance: 335.88,
        transaction_count: 1,
      },
      transactions: [],
    },
    agreementPayload: {},
    createIntentPayload: {
      clientSecret: "cs_test_123",
      publishableKey: "pk_test_123",
      balanceAmount: 335.88,
      paymentAmount: 335.88,
    },
    setupWindow(window) {
      window.Stripe = stripeFactory;
    },
  });

  document.getElementById("btn-init-balance").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  document.getElementById("btn-open-partial").click();
  document.getElementById("btn-init-partial").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const expressCalls = createCalls.filter((type) => type === "expressCheckout").length;
  assert.ok(expressCalls >= 2, "express checkout should be mounted for both balance and partial payment flows");
  assert.equal(document.getElementById("balance-express-wrap").style.display, "block");
  assert.equal(document.getElementById("partial-express-wrap").style.display, "block");
});

test("balance confirmation includes return_url for redirect-capable payment methods", async () => {
  const confirmCalls = [];
  const stripeFactory = () => ({
    elements() {
      return {
        create() {
          return {
            on() {},
            mount() {},
            unmount() {},
          };
        },
      };
    },
    async confirmPayment(options) {
      confirmCalls.push(options);
      return { paymentIntent: { status: "requires_payment_method" } };
    },
  });

  const document = await bootDashboard({
    bookingPayload: baseBooking(),
    ledgerPayload: {
      summary: {
        total_paid: 50,
        remaining_balance: 335.88,
        transaction_count: 1,
      },
      transactions: [],
    },
    agreementPayload: {},
    createIntentPayload: {
      clientSecret: "cs_test_123",
      publishableKey: "pk_test_123",
      balanceAmount: 335.88,
      paymentAmount: 335.88,
    },
    setupWindow(window) {
      window.Stripe = stripeFactory;
    },
  });

  document.getElementById("btn-init-balance").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  document.getElementById("btn-confirm-balance").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(confirmCalls.length, 1);
  assert.equal(confirmCalls[0]?.redirect, "if_required");
  assert.equal(confirmCalls[0]?.confirmParams?.return_url, "https://slycarrentals.com/manage-booking.html?t=test-token");
});

test("extension CTA stays active for active rental with overdue payment-plan balance and carries token context", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      paymentStatus: "partial",
      totalPrice: 500,
      depositPaid: 200,
      balanceDue: 300,
      paymentPlan: {
        status: "past_due",
        isOverdue: true,
      },
    }),
    ledgerPayload: {
      summary: {
        total_paid: 200,
        remaining_balance: 300,
        transaction_count: 4,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [
      { id: "camry", name: "Camry 2012" },
      { id: "camry2013", name: "Camry 2013 SE" },
    ],
  });

  const extensionCta = document.getElementById("extension-cta");
  const query = getExtensionQuery(document);
  assert.match(extensionCta.textContent, /Open Extension Flow/);
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
  assert.equal(query.get("vehicle"), "camry");
});

test("extension CTA keeps canonical vehicle ID for active rental", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      vehicleId: "camry2013",
      vehicleName: "Camry 2013 SE",
    }),
    ledgerPayload: {
      summary: {
        total_paid: 370,
        remaining_balance: 16,
        transaction_count: 2,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [
      { id: "camry", name: "Camry 2012" },
      { id: "camry2013", name: "Camry 2013 SE" },
    ],
  });

  const query = getExtensionQuery(document);
  assert.equal(query.get("vehicle"), "camry2013");
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
});

test("extension CTA normalizes legacy vehicle ID for active rental", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      vehicleId: "camry2012",
      vehicleName: "Camry 2012",
    }),
    ledgerPayload: {
      summary: {
        total_paid: 370,
        remaining_balance: 16,
        transaction_count: 3,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [
      { id: "camry", name: "Camry 2012" },
      { id: "camry2013", name: "Camry 2013 SE" },
    ],
  });

  const query = getExtensionQuery(document);
  assert.equal(query.get("vehicle"), "camry");
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
});

test("extension CTA remains available for overdue active booking", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "overdue",
      paymentStatus: "partial",
      balanceDue: 420,
      paymentPlan: { status: "active", isOverdue: true },
    }),
    ledgerPayload: {
      summary: {
        total_paid: 120,
        remaining_balance: 420,
        transaction_count: 5,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  const extensionCta = document.getElementById("extension-cta");
  const query = getExtensionQuery(document);
  assert.match(extensionCta.textContent, /Open Extension Flow/);
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
  assert.equal(query.get("vehicle"), "camry");
});

test("extension CTA is blocked for active partial-payment state below 75%", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      paymentStatus: "partial",
      totalPrice: 340,
      depositPaid: 220,
      balanceDue: 120,
    }),
    ledgerPayload: {
      summary: {
        total_paid: 220,
        remaining_balance: 120,
        transaction_count: 3,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  const extensionCta = document.getElementById("extension-cta");
  const pillEl = document.getElementById("extension-status-pill");
  const balanceNoteEl = document.getElementById("stat-balance-note");
  const balanceBannerEl = document.getElementById("payment-balance-banner");
  assert.match(extensionCta.textContent, /Pay Balance First/, "CTA must direct renter to pay balance");
  assert.match(pillEl.textContent, /75%/, "pill must show 75% requirement");
  assert.match(balanceNoteEl.textContent, /75%/, "balance note must display the 75% requirement for active renters");
  assert.match(balanceBannerEl.textContent, /extension request does not go through/i, "payment banner should explain why extension might not go through");
});

test("extension CTA keeps booking vehicle when inventory listing is unavailable/empty", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      vehicleId: "legacy-manual-car-001",
      vehicleName: "Legacy Manual Car",
      totalPrice: 230,
      depositPaid: 130,
      balanceDue: 100,
    }),
    ledgerPayload: {
      summary: {
        total_paid: 220,
        remaining_balance: 10,
        transaction_count: 3,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [],
  });

  const query = getExtensionQuery(document);
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
  assert.equal(query.get("vehicle"), "legacy-manual-car-001");
});

test("extension CTA resolves renamed vehicle ID from booking vehicle name", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      vehicleId: "old-camry-id",
      vehicleName: "Camry 2012",
      totalPrice: 250,
      depositPaid: 130,
      balanceDue: 120,
    }),
    ledgerPayload: {
      summary: {
        total_paid: 240,
        remaining_balance: 10,
        transaction_count: 2,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [
      { id: "camry", name: "Camry 2012" },
    ],
  });

  const query = getExtensionQuery(document);
  assert.equal(query.get("vehicle"), "camry");
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
});


// ─── Extension account-state rendering regression tests ───────────────────────
// These tests verify that the extension section in manage-booking.js renders
// lifecycle-aware messaging consistently across all renter account states.

const EMPTY_LEDGER = { summary: { total_paid: 0, remaining_balance: 0, transaction_count: 0 }, transactions: [] };

test("extension-account-state: overdue renter without late fee shows overdue balance warning", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "overdue",
      paymentStatus: "partial",
      balanceDue: 420,
      paymentLifecycleState: "overdue",
    }),
    ledgerPayload: EMPTY_LEDGER,
    agreementPayload: {},
    vehiclesPayload: [{ vehicle_id: "camry", vehicle_name: "Camry 2012" }],
  });

  const pillEl = document.getElementById("extension-status-pill");
  assert.match(pillEl.textContent, /[Oo]verdue/, "pill should indicate overdue state");

  const ctaNote = document.getElementById("extension-cta-note");
  assert.match(ctaNote.textContent, /[Oo]verdue balance.*must be paid in full/, "note should require overdue balance to be paid");

  const cta = document.getElementById("extension-cta");
  assert.match(cta.textContent, /Pay Overdue Balance/, "CTA must direct renter to pay overdue balance");
});

test("extension-account-state: overdue renter with active late fee shows fee amount in dashboard", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "overdue",
      paymentStatus: "partial",
      balanceDue: 420,
      paymentLifecycleState: "overdue",
      lateFeeStatus: "assessed",
      lateFeeAmount: 75,
    }),
    ledgerPayload: EMPTY_LEDGER,
    agreementPayload: {},
    vehiclesPayload: [{ vehicle_id: "camry", vehicle_name: "Camry 2012" }],
  });

  const ctaNote = document.getElementById("extension-cta-note");
  assert.match(ctaNote.textContent, /\$75\.00/, "note must show late fee dollar amount");
  assert.match(ctaNote.textContent, /late fees/, "note must mention late fees");
});

test("extension-account-state: dismissed late fee is not shown in overdue dashboard messaging", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "overdue",
      paymentStatus: "partial",
      balanceDue: 420,
      paymentLifecycleState: "overdue",
      lateFeeStatus: "dismissed",
      lateFeeAmount: 75,
    }),
    ledgerPayload: EMPTY_LEDGER,
    agreementPayload: {},
    vehiclesPayload: [{ vehicle_id: "camry", vehicle_name: "Camry 2012" }],
  });

  const ctaNote = document.getElementById("extension-cta-note");
  assert.doesNotMatch(ctaNote.textContent, /\$75\.00/, "dismissed late fee must not be shown");
  assert.doesNotMatch(ctaNote.textContent, /late fees/i, "dismissed late fee must not be referenced");

});

test("extension-account-state: payment plan defaulted shows manual review warning", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      paymentStatus: "partial",
      balanceDue: 200,
      paymentPlan: { status: "defaulted", isOverdue: true },
    }),
    ledgerPayload: EMPTY_LEDGER,
    agreementPayload: {},
    vehiclesPayload: [{ vehicle_id: "camry", vehicle_name: "Camry 2012" }],
  });

  const pillEl = document.getElementById("extension-status-pill");
  assert.match(pillEl.textContent, /manual review/, "pill should indicate manual review for defaulted plan");

  const ctaNote = document.getElementById("extension-cta-note");
  assert.match(ctaNote.textContent, /manual approval/, "note should mention manual approval");
});

test("extension-account-state: payment plan past_due shows delinquency warning", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      paymentStatus: "partial",
      balanceDue: 150,
      paymentPlan: { status: "past_due", isOverdue: true },
    }),
    ledgerPayload: EMPTY_LEDGER,
    agreementPayload: {},
    vehiclesPayload: [{ vehicle_id: "camry", vehicle_name: "Camry 2012" }],
  });

  const pillEl = document.getElementById("extension-status-pill");
  assert.match(pillEl.textContent, /past due/, "pill should indicate past due plan");

  const ctaNote = document.getElementById("extension-cta-note");
  assert.match(ctaNote.textContent, /past-due installment/, "note should mention past-due installment");
});

test("extension-account-state: balance above $150 stays eligible when 75% threshold is satisfied", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      paymentStatus: "partial",
      totalPrice: 4000,
      depositPaid: 3000,
      balanceDue: 1000,
      paymentPlan: null,
      extensionRiskOverride: null,
    }),
    ledgerPayload: {
      summary: {
        total_paid: 3000,
        total_charges: 4000,
        remaining_balance: 1000,
        transaction_count: 4,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [{ vehicle_id: "camry", vehicle_name: "Camry 2012" }],
  });

  const cta = document.getElementById("extension-cta");
  const query = getExtensionQuery(document);
  assert.match(cta.textContent, /Open Extension Flow/, "CTA should allow extension flow");
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("vehicle"), "camry");

  const pillEl = document.getElementById("extension-status-pill");
  assert.doesNotMatch(pillEl.textContent, /\$150|pay first/i, "pill should no longer mention the removed balance cap");

  const ctaNote = document.getElementById("extension-cta-note");
  assert.doesNotMatch(ctaNote.textContent, /\$150/i, "note should no longer mention the removed balance cap");
});

test("extension-account-state: extension_risk_override=block routes CTA to support", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      paymentStatus: "partial",
      balanceDue: 100,
      extensionRiskOverride: "block",
    }),
    ledgerPayload: EMPTY_LEDGER,
    agreementPayload: {},
    vehiclesPayload: [{ vehicle_id: "camry", vehicle_name: "Camry 2012" }],
  });

  const cta = document.getElementById("extension-cta");
  assert.equal(cta.href, "tel:+18445114059", "blocked extension CTA must link to support phone");
  assert.match(cta.textContent, /Contact Support/, "blocked CTA text should indicate support");

  const pillEl = document.getElementById("extension-status-pill");
  assert.match(pillEl.textContent, /blocked/, "pill should indicate blocked state");
});

test("extension-account-state: active renter with assessed late fee shows fee in dashboard note", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      paymentStatus: "partial",
      balanceDue: 0,
      lateFeeStatus: "assessed",
      lateFeeAmount: 50,
    }),
    ledgerPayload: EMPTY_LEDGER,
    agreementPayload: {},
    vehiclesPayload: [{ vehicle_id: "camry", vehicle_name: "Camry 2012" }],
  });

  const pillEl = document.getElementById("extension-status-pill");
  assert.match(pillEl.textContent, /\$50\.00/, "pill should show late fee amount");
  assert.match(pillEl.textContent, /[Ll]ate fee/, "pill should mention late fee");

  const ctaNote = document.getElementById("extension-cta-note");
  assert.match(ctaNote.textContent, /\$50\.00/, "note should show late fee dollar amount");
  assert.match(ctaNote.textContent, /extension payment/, "note should mention extension payment");

  const cta = document.getElementById("extension-cta");
  assert.match(cta.textContent, /Open Extension Flow/, "CTA still available for pending late fee");
});

test("extension-account-state: active renter in good standing shows normal extension flow", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      paymentStatus: "paid",
      balanceDue: 0,
      paymentPlan: null,
      lateFeeStatus: null,
      lateFeeAmount: null,
      extensionRiskOverride: null,
    }),
    ledgerPayload: EMPTY_LEDGER,
    agreementPayload: {},
    vehiclesPayload: [{ vehicle_id: "camry", vehicle_name: "Camry 2012" }],
  });

  const pillEl = document.getElementById("extension-status-pill");
  assert.equal(pillEl.textContent, "Eligible to review extension options", "good-standing pill should show eligible");

  const cta = document.getElementById("extension-cta");
  assert.match(cta.textContent, /Open Extension Flow/, "good-standing CTA should open extension flow");
  const query = getExtensionQuery(document);
  assert.equal(query.get("extend"), "1");
});
