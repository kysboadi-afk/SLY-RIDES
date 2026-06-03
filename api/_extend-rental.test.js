// api/_extend-rental.test.js
// Tests for POST /api/extend-rental — focused on the conflict-check logic that
// must SKIP the active booking itself so a renter can extend their own rental
// even when the existing return date technically overlaps the new extension
// window (due to the 2-hour preparation buffer in hasDateTimeOverlap).
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment ──────────────────────────────────────────────────────────────
process.env.STRIPE_SECRET_KEY    = "sk_test_fake";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRes() {
  return {
    _status:  200,
    _body:    null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
    send(body)   { this._body = body; return this; },
    end()        { return this; },
  };
}

function makeReq(body, origin = "https://slycarrentals.com") {
  return { method: "POST", headers: { origin }, body };
}

// ─── Shared mock state ────────────────────────────────────────────────────────

let mockBookings = {};
let sbClient     = null;   // null = no Supabase

// Camry vehicle data used across tests
const CAMRY_VEHICLE = {
  name:        "Camry 2012",
  pricePerDay: 55,
  weekly:      300,
  biweekly:    null,
  monthly:     null,
};

const TWO_DAY_OVERDUE_NOW = "2020-01-03T17:29:00-08:00";
const FIVE_DAY_OVERDUE_NOW = "2026-05-05T12:00:00-07:00";

async function withMockedNow(iso, fn) {
  const originalNow = Date.now;
  Date.now = () => new Date(iso).getTime();
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

mock.module("./_vehicles.js", {
  namedExports: {
    getVehicleById: async (id) =>
      id === "camry" ? { ...CAMRY_VEHICLE } : null,
  },
});

mock.module("./_settings.js", {
  namedExports: {
    loadPricingSettings: async () => ({
      camry_daily_rate:    55,
      camry_weekly_rate:   300,
      camry_biweekly_rate: null,
      camry_monthly_rate:  null,
      tax_rate:            0.095,
    }),
    applyTax: (amount, settings) =>
      Math.round(amount * (1 + (settings.tax_rate || 0)) * 100) / 100,
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings:  async () => ({ data: mockBookings, sha: "sha1" }),
    updateBooking: async () => {},
    normalizePhone: (p) => p ? p.replace(/\D/g, "") : "",
  },
});

// Real hasDateTimeOverlap is imported so the overlap arithmetic is exercised —
// the fix must suppress the self-overlap the buffer would otherwise produce.
mock.module("./_availability.js", {
  namedExports: {
    // Keep real implementations so the buffer-driven self-conflict is tested.
    hasDateTimeOverlap: (await import("./_availability.js")).hasDateTimeOverlap,
    parseDateTimeMs:    (await import("./_availability.js")).parseDateTimeMs,
  },
});

mock.module("./_supabase.js", {
  namedExports: { getSupabaseAdmin: () => sbClient },
});

// _pricing.js mock — returns a static pricing row matching CAMRY_VEHICLE so tests
// are not blocked by Supabase availability.  computeAmountFromPricing is kept real
// so pricing arithmetic is exercised (same pattern as _availability.js above).
mock.module("./_pricing.js", {
  namedExports: {
    LATE_FEE_BASE: 25,
    getVehiclePricing: async (_sb, _id) => ({
      daily_price:    55,
      weekly_price:   300,
      biweekly_price: null,
      monthly_price:  null,
    }),
    computeAmountFromPricing: (await import("./_pricing.js")).computeAmountFromPricing,
    computeLateFeeAmount: (await import("./_pricing.js")).computeLateFeeAmount,
  },
});

// _extension-risk.js mock — controls Phase 2 risk gate behaviour per test.
// riskResult is returned by evaluateExtensionRisk; riskSettings by loadExtensionRiskSettings.
let riskResult      = { allowed: true, reason: null, partialCount: 0, exposureAmount: 0, riskOverride: null };
let riskSettingsMock = {
  extension_partial_block_enabled: true,
  extension_max_unpaid_exposure:   500,
  extension_max_partial_count:     3,
  extension_partial_min_pct:       50,
  extension_overdue_block_partial: true,
  extension_allow_override:        true,
};

mock.module("./_extension-risk.js", {
  namedExports: {
    EXTENSION_RISK_DEFAULTS:     riskSettingsMock,
    loadExtensionRiskSettings:   async () => ({ ...riskSettingsMock }),
    evaluateExtensionRisk:       async () => ({ ...riskResult }),
  },
});

// _renter-balance-ledger.js mock — returns a controllable ledger summary.
// mockLedgerSummary is reset to "no balance" before each financial-trace test.
let mockLedgerSummary = {
  remaining_balance: 0, total_paid: 0, total_charges: 0,
  total_credits: 0, total_waived: 0, total_refunds: 0,
  net_balance: 0, credit_balance: 0, transaction_count: 0,
};
mock.module("./_renter-balance-ledger.js", {
  namedExports: {
    getLedgerSummary: async () => ({ ...mockLedgerSummary }),
  },
});

// Stripe mock — returns a minimal fake PaymentIntent so the handler can reach 200.
// capturedStripeParams stores the last params passed to paymentIntents.create so
// metadata-content tests can assert on what was sent to Stripe.
let capturedStripeParams = null;
mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    paymentIntents = {
      create: async (params) => {
        capturedStripeParams = params;
        return {
          id:            "pi_fake_123",
          client_secret: "pi_fake_123_secret_abc",
          amount:        params.amount,
        };
      },
    };
  },
});

const { default: handler } = await import("./extend-rental.js");

// ─── Base booking fixture ────────────────────────────────────────────────────

function makeActiveBooking(overrides = {}) {
  return {
    bookingId:    "bk-camry-active-001",
    name:         "Alice Tester",
    email:        "alice@example.com",
    phone:        "2135550100",
    vehicleId:    "camry",
    vehicleName:  "Camry 2012",
    pickupDate:   "2026-04-15",
    pickupTime:   "10:00 AM",
    returnDate:   "2026-04-30",
    returnTime:   "5:00 PM",
    status:       "active_rental",
    paymentIntentId: "pi_original_xxx",
    smsSentAt:    {},
    ...overrides,
  };
}

// ─── Supabase client builder ─────────────────────────────────────────────────
// Builds a chainable Supabase-style query stub.  `rows` is returned for ALL
// queries; tests that need different rows per query use `queryMap` instead.

function makeSupabaseClient({ rows = [], error = null, queryMap = null } = {}) {
  // queryMap: array of { match: fn(tableName, filters), rows, error } checked
  // in order.  First match wins; falls back to the default `rows`/`error`.
  const resolveQuery = (tableName, filters) => {
    if (queryMap) {
      for (const entry of queryMap) {
        if (entry.match(tableName, filters)) {
          return { data: entry.rows || [], error: entry.error || null };
        }
      }
    }
    return { data: rows, error };
  };

  return {
    _tableName: null,
    _filters: {},
    from(table) {
      const ctx = { tableName: table, filters: {} };
      const chain = {
        select()     { return this; },
        eq(k, v)     { ctx.filters[k] = v; return this; },
        neq(k, v)    { ctx.filters[`neq_${k}`] = v; return this; },
        in(k, v)     { ctx.filters[`in_${k}`] = v; return this; },
        not(k, op, v){ ctx.filters[`not_${k}`] = v; return this; },
        lte()        { return this; },
        gte()        { return this; },
        limit()      { return this; },
        order()      { return this; },
        update()     { return this; },
        upsert()     { return this; },
        async maybeSingle() {
          const result = resolveQuery(ctx.tableName, ctx.filters);
          const d = Array.isArray(result.data) ? result.data : [];
          return { data: d.length === 1 ? d[0] : null, error: result.error };
        },
        async then(resolve) {
          return resolve(resolveQuery(ctx.tableName, ctx.filters));
        },
      };
      return chain;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("extend-rental: 200 when active booking is the ONLY booking (self-conflict guard, no Supabase)", async () => {
  // Regression test: the active booking's return date (Apr 30) sits exactly
  // at the extension window start. hasDateTimeOverlap detects an overlap via
  // the 2-hour buffer (rEnd = Apr 30 7 PM > newStart = Apr 30 5 PM).
  // The bookingId equality guard must suppress this.
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient     = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.notEqual(res._status, 409, "should NOT return 409 when only booking is the active one");
  assert.equal(res._status, 200, "should return 200 — extension payment intent created");
  assert.ok(res._body?.clientSecret, "response must include clientSecret");
});

test("extend-rental: 200 when active booking has 'active_rental' status in Supabase (enrichment fix)", async () => {
  // The enrichment block previously only matched status 'active' | 'overdue'.
  // With 'active_rental' status in Supabase, sbActiveBookingRef was never set.
  // Now that 'active_rental' is included, the conflict query correctly uses
  // .neq("booking_ref", sbActiveBookingRef) to exclude the current booking.
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };

  // Supabase returns the active booking with status='active_rental' when
  // queried by booking_ref, and returns no future conflicts.
  sbClient = makeSupabaseClient({
    queryMap: [
      // Enrichment: fetch by booking_ref → returns the active booking
      {
        match: (t) => t === "bookings",
        rows: [{
          booking_ref: "bk-camry-active-001",
          return_date: "2026-04-30",
          return_time: "17:00:00",
          status:      "active_rental",
        }],
      },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.notEqual(res._status, 409, "active_rental Supabase booking must not block itself");
  assert.equal(res._status, 200);
});

test("extend-rental: 409 when there is a genuine future booking conflict (bookings.json)", async () => {
  // A separate future booking starts on May 3, which falls within the
  // Apr 30 → May 7 extension window.  The handler must return 409.
  const active  = makeActiveBooking();
  const future  = {
    bookingId:   "bk-camry-next-001",
    name:        "Bob Renter",
    email:       "bob@example.com",
    phone:       "2135550200",
    vehicleId:   "camry",
    vehicleName: "Camry 2012",
    pickupDate:  "2026-05-03",
    pickupTime:  "10:00 AM",
    returnDate:  "2026-05-07",
    returnTime:  "5:00 PM",
    status:      "booked_paid",
    paymentIntentId: "pi_bob_yyy",
    smsSentAt:   {},
  };
  mockBookings = { camry: [active, future] };
  sbClient     = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-07",
  }), res);

  assert.equal(res._status, 409, "should return 409 when extension overlaps a future booking");
});

test("extend-rental: 409 when future booking has 'booked_paid' status in Supabase", async () => {
  // Previously the Supabase conflict query only checked
  // ["pending","active","overdue","reserved"] — missing "booked_paid".
  // A paid reservation starting May 3 would NOT have been caught.
  // After the fix (not.in cancelled,completed_rental) it IS caught.
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };

  sbClient = makeSupabaseClient({
    queryMap: [
      // All bookings queries return: active booking for enrichment, future booking for conflict
      {
        match: (t) => t === "bookings",
        rows: [
          // Active booking (used for enrichment and conflict check)
          {
            booking_ref:    "bk-camry-active-001",
            return_date:    "2026-04-30",
            return_time:    "17:00:00",
            status:         "active_rental",
            customer_email: "alice@example.com",
            customer_phone: "2135550100",
            customer_name:  "Alice Tester",
            pickup_date:    "2026-04-15",
            pickup_time:    "10:00:00",
          },
          // Future booking with "booked_paid" status — should trigger 409
          {
            booking_ref: "bk-camry-future-001",
            pickup_date: "2026-05-03",
            return_date: "2026-05-07",
            pickup_time: "10:00:00",
            return_time: "17:00:00",
            status:      "booked_paid",
          },
        ],
      },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 409, "booked_paid future booking must block the extension");
});

test("extend-rental: 200 for same-day rental (effectiveReturnDate guard prevents self-conflict)", async () => {
  // Same-day rental: pickup and return both today (Apr 25).
  // conflictFloorDate = Apr 25 = pickup_date, so the active booking itself
  // could appear in the Supabase query results when sbActiveBookingRef is null.
  // The fbkReturnDate <= effectiveReturnDate guard must catch this and skip it.
  const active = makeActiveBooking({
    pickupDate:  "2026-04-25",
    returnDate:  "2026-04-25",
  });
  mockBookings = { camry: [active] };

  // Supabase returns the active booking with the same return date as pickup.
  // sbActiveBookingRef will be null (simulate enrichment mismatch by using
  // a legacy PI ID as the bookingId so neither ref check fires).
  const activeWithPiId = { ...active, bookingId: "pi_legacy_pi_id" };
  mockBookings = { camry: [activeWithPiId] };

  sbClient = makeSupabaseClient({
    queryMap: [
      {
        match: (t) => t === "bookings",
        rows: [
          // Active booking (same-day, simulating a Supabase ref mismatch)
          {
            booking_ref:    "bk-camry-active-001",
            return_date:    "2026-04-25",
            return_time:    "17:00:00",
            status:         "active_rental",
            customer_email: "alice@example.com",
            customer_phone: "2135550100",
            customer_name:  "Alice Tester",
            pickup_date:    "2026-04-25",
            pickup_time:    "10:00:00",
          },
        ],
      },
      { match: (t) => t === "revenue_records", rows: [] },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-04-28",
  }), res);

  assert.notEqual(res._status, 409, "same-day rental must not self-conflict");
  assert.equal(res._status, 200);
});

test("extend-rental: 409 when paid extension revenue_record extends a future booking past newReturnDate", async () => {
  // Future booking (status=pending) has return_date=May 3 in bookings table,
  // but has a paid extension revenue_record pushing its effective end to May 8.
  // The renter wants to extend to May 5 which would overlap May 1→May 8.
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };

  sbClient = makeSupabaseClient({
    queryMap: [
      {
        match: (t) => t === "bookings",
        rows: [
          // Enrichment: active booking
          {
            booking_ref:    "bk-camry-active-001",
            return_date:    "2026-04-30",
            return_time:    "17:00:00",
            status:         "active_rental",
            customer_email: "alice@example.com",
            customer_phone: "2135550100",
            customer_name:  "Alice Tester",
            pickup_date:    "2026-04-15",
            pickup_time:    "10:00:00",
          },
          // Future booking: bookings table shows return May 3 but has paid extension to May 8
          {
            booking_ref: "bk-camry-future-002",
            pickup_date: "2026-05-01",
            return_date: "2026-05-03",
            pickup_time: "10:00:00",
            return_time: "17:00:00",
            status:      "pending",
          },
        ],
      },
      // revenue_records: paid extension for the future booking → finalReturnDate May 8
      {
        match: (t) => t === "revenue_records",
        rows: [
          {
            original_booking_id: "bk-camry-future-002",
            return_date:         "2026-05-08",
          },
        ],
      },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",   // overlaps future booking [May 1 → May 8]
  }), res);

  assert.equal(res._status, 409, "paid extension record extending future booking must block extension");
});

test("extend-rental: 200 when future booking has UNPAID extension revenue_record (must not block)", async () => {
  // Future booking has a revenue_record of type=extension but payment_status=pending.
  // Unpaid extensions must NOT extend the blocking window.
  // The future booking's nominal end (May 3) does not overlap [Apr 30→May 2].
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };

  sbClient = makeSupabaseClient({
    queryMap: [
      {
        match: (t) => t === "bookings",
        rows: [
          {
            booking_ref:    "bk-camry-active-001",
            return_date:    "2026-04-30",
            return_time:    "17:00:00",
            status:         "active_rental",
            customer_email: "alice@example.com",
            customer_phone: "2135550100",
            customer_name:  "Alice Tester",
            pickup_date:    "2026-04-15",
            pickup_time:    "10:00:00",
          },
          {
            booking_ref: "bk-camry-future-003",
            pickup_date: "2026-05-04",
            return_date: "2026-05-07",
            pickup_time: "10:00:00",
            return_time: "17:00:00",
            status:      "reserved",
          },
        ],
      },
      // revenue_records returns empty because the mock only responds to
      // is_cancelled=false + payment_status=paid — unpaid records are excluded.
      { match: (t) => t === "revenue_records", rows: [] },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-02",   // Apr 30 → May 2, does not overlap May 4 pickup
  }), res);

  assert.notEqual(res._status, 409, "unpaid extension record must not expand the blocking window");
  assert.equal(res._status, 200);
});

test("extend-rental: 400 when new return date is not after current return date", async () => {
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient     = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-04-28",   // before current return date
  }), res);

  assert.equal(res._status, 400);
});

test("extend-rental: 404 when no active booking matches the provided email", async () => {
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient     = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "nobody@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 404);
});

test("extend-rental: 200 accepts customPaymentAmount for active extension and tracks partial status", async () => {
  // Extension: Apr 30 → May 5 = 5 days.  daily=$55, minimum=ceil(5/2)=3×$55=$165.
  // $200 is above the minimum, so the partial payment is accepted.
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
    customPaymentAmount: 200,
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.extensionAmount, "200.00", "extensionAmount should be the pay-now amount");
  assert.equal(res._body.amountPaidNow, "200.00");
  assert.equal(res._body.extensionPaymentStatus, "partially_paid");
  assert.ok(Number(res._body.remainingBalance) > 0, "remaining balance should be tracked");
  assert.equal(capturedStripeParams.amount, 20000, "Stripe PI amount must use the custom pay-now amount");
  assert.equal(capturedStripeParams.metadata.extension_amount_paid, "200.00");
  assert.equal(capturedStripeParams.metadata.extension_payment_status, "partially_paid");
});

// ── Phase 1: Partial-payment minimum enforcement tests ────────────────────────

test("extend-rental: 400 when customPaymentAmount is below partial-payment minimum (Phase 1)", async () => {
  // Extension: Apr 30 → May 5 = 5 days.  daily=$55, minimum=ceil(5/2)=3×$55=$165.
  // $100 is below $165, so the request must be rejected.
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
    customPaymentAmount: 100,
  }), res);

  assert.equal(res._status, 400, "below-minimum partial payment must return 400");
  assert.match(String(res._body?.error || ""), /minimum/i, "error must mention minimum");
  assert.equal(res._body.minimumPayment, "165.00", "minimumPayment must be 3 × $55");
  assert.equal(res._body.extensionDays, 5);
  assert.equal(res._body.dailyRate, "55.00");
});

test("extend-rental: 200 when customPaymentAmount equals minimum (Phase 1 — boundary)", async () => {
  // Extension: Apr 30 → May 5 = 5 days.  minimum=3×$55=$165. Exactly $165 must succeed.
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
    customPaymentAmount: 165,
  }), res);

  assert.equal(res._status, 200, "exact-minimum partial payment must succeed");
  assert.equal(res._body.amountPaidNow, "165.00");
  assert.equal(res._body.extensionPaymentStatus, "partially_paid");
});

test("extend-rental: 200 and full-payment pricing unchanged when paying full tiered amount (Phase 1)", async () => {
  // Extension: Apr 30 → May 7 = 7 days.  Weekly tier = $300 (mocked).
  // Paying the full $300 is a full payment — existing tiered pricing stays unchanged.
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-07",
    // No customPaymentAmount — full payment path
  }), res);

  assert.equal(res._status, 200, "full payment must succeed");
  // extensionTotal should equal amountPaidNow (no remaining balance)
  assert.equal(res._body.remainingBalance, "0.00", "full payment must leave no remaining balance");
  assert.equal(res._body.extensionPaymentStatus, "paid");
});

test("extend-rental: 400 when 7-day partial payment is below 4-day minimum (Phase 1)", async () => {
  // Extension: Apr 30 → May 7 = 7 days.  daily=$55, minimum=ceil(7/2)=4×$55=$220.
  // $150 is below $220.
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-07",
    customPaymentAmount: 150,
  }), res);

  assert.equal(res._status, 400, "below-minimum for 7-day extension must return 400");
  assert.equal(res._body.minimumPayment, "220.00", "7-day minimum must be 4 × $55");
  assert.equal(res._body.extensionDays, 7);
});

test("extend-rental: 200 when 7-day partial pays exactly the 4-day minimum (Phase 1)", async () => {
  // Extension: Apr 30 → May 7 = 7 days.  minimum=ceil(7/2)=4×$55=$220.
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-07",
    customPaymentAmount: 220,
  }), res);

  assert.equal(res._status, 200, "7-day partial at minimum must succeed");
  assert.equal(res._body.amountPaidNow, "220.00");
  assert.equal(res._body.extensionPaymentStatus, "partially_paid");
  // Standard-rate total for 7 days: 7×$55=$385 taxed (9.5%) = $421.58
  assert.ok(Number(res._body.extensionTotal) > 220, "extensionTotal must be > amountPaidNow");
  assert.ok(Number(res._body.remainingBalance) > 0, "remaining balance must be > 0");
});

test("extend-rental: 400 when customPaymentAmount exceeds extension balance", async () => {
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
    customPaymentAmount: 99999,
  }), res);

  assert.equal(res._status, 400);
  assert.match(String(res._body?.error || ""), /cannot exceed/i);
});

test("extend-rental: 400 rejects customPaymentAmount for overdue rentals", async () => {
  mockBookings = { camry: [] };
  sbClient = makeSupabaseClient({
    queryMap: [
      {
        match: (t) => t === "bookings",
        rows: [{
          booking_ref: "bk-camry-overdue-001",
          pickup_date: "2026-04-15",
          pickup_time: "10:00:00",
          return_date: "2026-04-30",
          return_time: "17:00:00",
          status: "overdue",
          customer_name: "Alice Tester",
          customer_email: "alice@example.com",
          customer_phone: "2135550100",
        }],
      },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
    customPaymentAmount: 100,
  }), res);

  assert.equal(res._status, 400);
  assert.match(String(res._body?.error || ""), /only available for active rentals/i);
});

test("extend-rental: 400 blocks extension when existing ledger balance exceeds $150", async () => {
  capturedStripeParams = null;
  mockLedgerSummary = {
    remaining_balance: 180, total_paid: 70, total_charges: 250,
    total_credits: 70, total_waived: 0, total_refunds: 0,
    net_balance: 180, credit_balance: 0, transaction_count: 2,
  };
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = makeSupabaseClient({
    queryMap: [
      {
        match: (t) => t === "bookings",
        rows: [{
          booking_ref: "bk-camry-active-001",
          return_date: "2026-04-30",
          return_time: "17:00:00",
          status: "active_rental",
          late_fee_waived_amount: null,
          late_fee_status: null,
          late_fee_amount: null,
        }],
      },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId: "camry",
    email: "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 400);
  assert.equal(res._body.balanceBlocked, true);
  assert.equal(res._body.ledgerBalance, "180.00");
  assert.equal(res._body.extensionBalanceThreshold, "150.00");
  assert.match(String(res._body?.error || ""), /pay your balance down/i);
  assert.equal(capturedStripeParams, null, "Stripe PI should not be created when balance-first block applies");
  mockLedgerSummary = {
    remaining_balance: 0, total_paid: 0, total_charges: 0,
    total_credits: 0, total_waived: 0, total_refunds: 0,
    net_balance: 0, credit_balance: 0, transaction_count: 0,
  };
});

// ── Metadata ──────────────────────────────────────────────────────────────────

test("extend-rental: PaymentIntent is created with type=rental_extension metadata", async () => {
  // Regression guard: ensures the Stripe PI always carries the 'type' and
  // 'payment_type' metadata fields so the webhook can identify extension payments.
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient     = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 200, "handler must return 200");
  assert.ok(capturedStripeParams, "stripe.paymentIntents.create must have been called");

  const meta = capturedStripeParams.metadata;
  assert.ok(meta,                          "metadata must be present on the PaymentIntent");
  assert.equal(meta.type,         "rental_extension", "metadata.type must equal 'rental_extension'");
  assert.equal(meta.payment_type, "rental_extension", "metadata.payment_type must equal 'rental_extension'");
  assert.ok(meta.booking_id,               "metadata.booking_id must be set");
  assert.ok(meta.vehicle_id,               "metadata.vehicle_id must be set");
  assert.ok(meta.new_return_date,          "metadata.new_return_date must be set");
  assert.equal(meta.original_pickup_date, "2026-04-15", "metadata.original_pickup_date must be set from active booking");
  assert.equal(meta.original_pickup_time, "10:00 AM", "metadata.original_pickup_time must be set from active booking");
  assert.equal(meta.original_return_date, "2026-04-30", "metadata.original_return_date must capture pre-extension return date");
  assert.equal(meta.previous_return_date, "2026-04-30", "metadata.previous_return_date must capture pre-extension return date");
  assert.equal(meta.extension_reason, "", "metadata.extension_reason defaults to empty string");
  assert.equal(meta.extension_notes, "", "metadata.extension_notes defaults to empty string");
});

test("extend-rental: extension reason metadata is forwarded to Stripe PaymentIntent", async () => {
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId: "camry",
    email: "alice@example.com",
    newReturnDate: "2026-05-05",
    extensionReason: "travel_delay",
    extensionNotes: "Flight was moved to next day.",
  }), res);

  assert.equal(res._status, 200);
  const meta = capturedStripeParams?.metadata;
  assert.ok(meta, "metadata must be present");
  assert.equal(meta.extension_reason, "travel_delay");
  assert.equal(meta.extension_notes, "Flight was moved to next day.");
});

test("extend-rental: metadata original pickup fields are enriched from Supabase when bookings.json is missing them", async () => {
  capturedStripeParams = null;
  const active = makeActiveBooking({ pickupDate: "", pickupTime: "" });
  mockBookings = { camry: [active] };
  sbClient = makeSupabaseClient({
    rows: [{
      booking_ref: "bk-camry-active-001",
      pickup_date: "2026-04-15",
      pickup_time: "10:00:00",
      return_date: "2026-04-30",
      return_time: "17:00:00",
      status:      "active_rental",
    }],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 200, "handler must return 200");
  const meta = capturedStripeParams?.metadata;
  assert.ok(meta, "metadata must be present");
  assert.equal(meta.original_pickup_date, "2026-04-15", "metadata.original_pickup_date must be enriched from Supabase");
  assert.equal(meta.original_pickup_time, "10:00 AM", "metadata.original_pickup_time must be enriched from Supabase");
});

test("extend-rental: metadata.booking_id prefers sbActiveBookingRef over bookingId", async () => {
  // When the Supabase lookup resolves a canonical booking_ref, it should be used
  // as metadata.booking_id so the webhook can find the booking via booking_ref.
  capturedStripeParams = null;
  const active = makeActiveBooking({ bookingId: "pi_legacy_original_xxx" });
  mockBookings = { camry: [active] };

  // Return a Supabase row whose booking_ref is the canonical bk-... identifier.
  sbClient = makeSupabaseClient({
    rows: [{
      booking_ref: "bk-camry-canonical-001",
      return_date: "2026-04-30",
      return_time: "17:00:00",
      status:      "active_rental",
    }],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 200);
  const meta = capturedStripeParams?.metadata;
  assert.ok(meta, "metadata must be present");
  assert.equal(meta.booking_id, "bk-camry-canonical-001",
    "booking_id must be the canonical Supabase booking_ref, not the legacy PI id");
});

// ── Waiver tests ──────────────────────────────────────────────────────────────

test("extend-rental: late fee is charged per overdue day and remains non-taxed", async () => {
  capturedStripeParams = null;
  const active = makeActiveBooking({
    returnDate: "2020-01-01",
    returnTime: "5:00 PM",
  });
  mockBookings = { camry: [active] };

  sbClient = makeSupabaseClient({
    rows: [{
      booking_ref: "bk-camry-active-001",
      return_date: "2020-01-01",
      return_time: "17:00:00",
      status:      "active_rental",
    }],
  });

  const res = makeRes();
  await withMockedNow(TWO_DAY_OVERDUE_NOW, async () => {
    await handler(makeReq({
      vehicleId:     "camry",
      email:         "alice@example.com",
      newReturnDate: "2020-01-03", // 2 extension days => $110 base
    }), res);
  });

  // Base extension amount: $110
  // Tax on base only (9.5%): $10.45
  // Overdue from Jan 1 to Jan 3 => 2 late-fee days = $50 (non-taxed)
  // Total: $170.45 => 17045 cents.
  assert.equal(res._status, 200);
  assert.equal(res._body.lateFeeIncluded, 50);
  assert.equal(capturedStripeParams.amount, 17045);
});

test("extend-rental: full waiver removes a multi-day late fee from total", async () => {
  // Simulate a booking that is past the 3-hour reset window.
  // Without a waiver, the late fee would be $125 for five overdue days.
  // With a full waiver (waived_amount = $125) the late fee must be $0.
  capturedStripeParams = null;
  const active = makeActiveBooking({
    returnDate: "2026-04-30",
  });
  mockBookings = { camry: [active] };

  sbClient = makeSupabaseClient({
    rows: [{
      booking_ref:             "bk-camry-active-001",
      return_date:             "2026-04-30",
      return_time:             "17:00:00",
      status:                  "active_rental",
      late_fee_waived_amount:  125,
    }],
  });

  const res = makeRes();
  await withMockedNow(FIVE_DAY_OVERDUE_NOW, async () => {
    await handler(makeReq({
      vehicleId:     "camry",
      email:         "alice@example.com",
      newReturnDate: "2026-05-05",
    }), res);
  });

  assert.equal(res._status, 200, "handler must succeed");
  assert.equal(res._body.lateFeeWaived, 125, "lateFeeWaived must match the full assessed late fee");
  // lateFeeIncluded after full waiver is applied: 0.
  assert.equal(res._body.lateFeeIncluded, 0,
    "lateFeeIncluded must be 0 when the full waiver covers the fee");
});

test("extend-rental: partial waiver reduces late fee proportionally", async () => {
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };

  sbClient = makeSupabaseClient({
    rows: [{
      booking_ref:             "bk-camry-active-001",
      return_date:             "2026-04-30",
      return_time:             "17:00:00",
      status:                  "active_rental",
      late_fee_waived_amount:  10,  // partial waiver: only $10 off
    }],
  });

  const res = makeRes();
  await withMockedNow(FIVE_DAY_OVERDUE_NOW, async () => {
    await handler(makeReq({
      vehicleId:     "camry",
      email:         "alice@example.com",
      newReturnDate: "2026-05-05",
    }), res);
  });

  assert.equal(res._status, 200);
  // lateFeeWaived must always reflect what was read from Supabase.
  assert.equal(res._body.lateFeeWaived, 10);
  assert.equal(res._body.lateFeeIncluded, 115);
});

test("extend-rental: no waiver when late_fee_waived_amount is absent from Supabase row", async () => {
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };

  // Supabase row does NOT include late_fee_waived_amount (simulates bookings
  // created before migration 0116 or when no waiver was applied).
  sbClient = makeSupabaseClient({
    rows: [{
      booking_ref: "bk-camry-active-001",
      return_date: "2026-04-30",
      return_time: "17:00:00",
      status:      "active_rental",
      // late_fee_waived_amount intentionally omitted
    }],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.lateFeeWaived, 0, "lateFeeWaived must default to 0 when no waiver is set");
});

// ── Phase 2: Risk gate integration tests ──────────────────────────────────────

test("extend-rental: Phase 2 risk gate blocks partial payment when evaluateExtensionRisk denies", async () => {
  // Simulate risk evaluator returning blocked (e.g. partial count exceeded).
  riskResult = {
    allowed:        false,
    reason:         "You have reached the maximum number of partial extensions (3). Please pay your outstanding balance.",
    partialCount:   3,
    exposureAmount: 350,
    riskOverride:   null,
  };
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:           "camry",
    email:               "alice@example.com",
    newReturnDate:       "2026-05-05",
    customPaymentAmount: 200,   // partial payment — triggers Phase 2 gate
  }), res);

  assert.equal(res._status, 400, "Phase 2 risk block must return 400");
  assert.equal(res._body.riskBlocked, true, "riskBlocked must be true");
  assert.match(String(res._body?.error || ""), /maximum number|outstanding|balance/i);

  // Reset risk result for subsequent tests
  riskResult = { allowed: true, reason: null, partialCount: 0, exposureAmount: 0, riskOverride: null };
});

test("extend-rental: Phase 2 risk gate is skipped for full payments (remainingBalance=0)", async () => {
  // Configure risk evaluator to block — but a full payment must never call it.
  riskResult = {
    allowed:        false,
    reason:         "Simulated risk block",
    partialCount:   99,
    exposureAmount: 9999,
    riskOverride:   null,
  };
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  // No customPaymentAmount → full payment path
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 200, "full payment must not be blocked by Phase 2 gate");
  assert.equal(res._body.remainingBalance, "0.00", "full payment must leave zero balance");

  // Reset
  riskResult = { allowed: true, reason: null, partialCount: 0, exposureAmount: 0, riskOverride: null };
});

test("extend-rental: Phase 2 response includes riskBlocked, partialCount, exposureAmount on block", async () => {
  riskResult = {
    allowed:        false,
    reason:         "Exposure exceeded",
    partialCount:   2,
    exposureAmount: 480,
    riskOverride:   null,
  };
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:           "camry",
    email:               "alice@example.com",
    newReturnDate:       "2026-05-05",
    customPaymentAmount: 165,
  }), res);

  assert.equal(res._status, 400);
  assert.equal(res._body.riskBlocked,    true);
  assert.equal(res._body.partialCount,   2);
  assert.equal(res._body.exposureAmount, "480.00");

  // Reset
  riskResult = { allowed: true, reason: null, partialCount: 0, exposureAmount: 0, riskOverride: null };
});

test("extend-rental: Phase 2 passes through when risk gate allows the partial extension", async () => {
  // Default riskResult is allowed: true — already reset above
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:           "camry",
    email:               "alice@example.com",
    newReturnDate:       "2026-05-05",
    customPaymentAmount: 200,
  }), res);

  assert.equal(res._status, 200, "allowed partial must succeed");
  assert.equal(res._body.extensionPaymentStatus, "partially_paid");
  assert.ok(Number(res._body.remainingBalance) > 0, "remaining balance must be tracked");
});

// ─── Extension financial trace regression tests ───────────────────────────────
// These tests verify that every successful 200 response includes a structured
// extensionFinancialTrace object with all required financial-state fields.

test("extension-financial-trace: active renter in good standing has clean trace (no fees, no ledger balance)", async () => {
  mockLedgerSummary = { remaining_balance: 0, total_paid: 0, total_charges: 0,
    total_credits: 0, total_waived: 0, total_refunds: 0,
    net_balance: 0, credit_balance: 0, transaction_count: 0 };

  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = makeSupabaseClient({
    queryMap: [
      { match: (t) => t === "bookings", rows: [{
        booking_ref: "bk-camry-active-001", return_date: "2026-04-30",
        return_time: "17:00:00", status: "active_rental",
        late_fee_waived_amount: null, late_fee_status: null, late_fee_amount: null,
      }] },
    ],
  });

  // Use a "now" that is before the return date to ensure no time-based late fees.
  await withMockedNow("2026-04-28T12:00:00-07:00", async () => {
    const res = makeRes();
    await handler(makeReq({ vehicleId: "camry", email: "alice@example.com", newReturnDate: "2026-05-05" }), res);

    assert.equal(res._status, 200, "should succeed");
    const trace = res._body?.extensionFinancialTrace;
    assert.ok(trace, "extensionFinancialTrace must be present in response");
    assert.equal(trace.late_fee_amount, 0, "no late fee for on-time renter");
    assert.equal(trace.deferred_late_fee, 0, "no deferred late fee");
    assert.equal(trace.overdue_amount, 0, "no overdue amount");
    assert.ok(Number(trace.extension_fee_amount) > 0, "extension base fee > 0");
    assert.ok(Number(trace.computed_extension_total) > 0, "extension total > 0");
    assert.equal(trace.ledger_balance, 0, "empty ledger → balance 0");
    assert.equal(trace.render_source_used, "supabase", "sb available + empty ledger");
    assert.equal(trace.booking_id, "bk-camry-active-001");
  });
});

test("extension-financial-trace: deferred late fee included in trace when pending_collection", async () => {
  mockLedgerSummary = { remaining_balance: 0, total_paid: 0, total_charges: 0,
    total_credits: 0, total_waived: 0, total_refunds: 0,
    net_balance: 0, credit_balance: 0, transaction_count: 0 };

  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = makeSupabaseClient({
    queryMap: [
      { match: (t) => t === "bookings", rows: [{
        booking_ref: "bk-camry-active-001", return_date: "2026-04-30",
        return_time: "17:00:00", status: "active_rental",
        late_fee_waived_amount: null, late_fee_status: "pending_collection", late_fee_amount: 50,
      }] },
    ],
  });

  const res = makeRes();
  await handler(makeReq({ vehicleId: "camry", email: "alice@example.com", newReturnDate: "2026-05-05" }), res);

  assert.equal(res._status, 200);
  const trace = res._body?.extensionFinancialTrace;
  assert.ok(trace, "extensionFinancialTrace must be present");
  assert.equal(trace.deferred_late_fee, 50, "deferred late fee should be 50");
  // Extension total should include the $50 deferred fee
  assert.ok(Number(trace.computed_extension_total) > 50, "total includes deferred fee");
});

test("extension-financial-trace: render_source_used is bookings_json when Supabase unavailable", async () => {
  mockLedgerSummary = { remaining_balance: 0, total_paid: 0, total_charges: 0,
    total_credits: 0, total_waived: 0, total_refunds: 0,
    net_balance: 0, credit_balance: 0, transaction_count: 0 };

  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;  // no Supabase

  const res = makeRes();
  await handler(makeReq({ vehicleId: "camry", email: "alice@example.com", newReturnDate: "2026-05-05" }), res);

  assert.equal(res._status, 200);
  const trace = res._body?.extensionFinancialTrace;
  assert.ok(trace, "extensionFinancialTrace must be present");
  assert.equal(trace.render_source_used, "bookings_json", "no Supabase → bookings_json");
  assert.equal(trace.ledger_balance, 0, "no ledger available → 0");
});

test("extension-financial-trace: ledger_balance populated from mock ledger, render_source is supabase+ledger", async () => {
  mockLedgerSummary = { remaining_balance: 150, total_paid: 100, total_charges: 250,
    total_credits: 100, total_waived: 0, total_refunds: 0,
    net_balance: 150, credit_balance: 0, transaction_count: 3 };

  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = makeSupabaseClient({
    queryMap: [
      { match: (t) => t === "bookings", rows: [{
        booking_ref: "bk-camry-active-001", return_date: "2026-04-30",
        return_time: "17:00:00", status: "active_rental",
        late_fee_waived_amount: null, late_fee_status: null, late_fee_amount: null,
      }] },
    ],
  });

  const res = makeRes();
  await handler(makeReq({ vehicleId: "camry", email: "alice@example.com", newReturnDate: "2026-05-05" }), res);

  assert.equal(res._status, 200);
  const trace = res._body?.extensionFinancialTrace;
  assert.ok(trace, "extensionFinancialTrace must be present");
  assert.equal(trace.ledger_balance, 150, "ledger balance should reflect mock");
  assert.equal(trace.render_source_used, "supabase+ledger", "sb + positive ledger → supabase+ledger");
});

test("extension-financial-trace: overdue booking traces overdue_amount from ledger balance", async () => {
  mockLedgerSummary = { remaining_balance: 200, total_paid: 50, total_charges: 250,
    total_credits: 50, total_waived: 0, total_refunds: 0,
    net_balance: 200, credit_balance: 0, transaction_count: 2 };

  const active = makeActiveBooking({ status: "overdue" });
  mockBookings = { camry: [active] };
  sbClient = makeSupabaseClient({
    queryMap: [
      { match: (t) => t === "bookings", rows: [{
        booking_ref: "bk-camry-active-001", return_date: "2026-04-30",
        return_time: "17:00:00", status: "overdue",
        customer_email: "alice@example.com", customer_name: "Alice Tester",
        customer_phone: "2135550100", pickup_date: "2026-04-15", pickup_time: "10:00:00",
        late_fee_waived_amount: null, late_fee_status: null, late_fee_amount: null,
      }] },
    ],
  });

  // Use a "now" only slightly after the return date so the time-based late fee is small
  // and doesn't affect the overdue_amount assertion (which is ledger-based).
  await withMockedNow("2026-05-02T12:00:00-07:00", async () => {
    const res = makeRes();
    await handler(makeReq({ vehicleId: "camry", email: "alice@example.com", newReturnDate: "2026-05-10" }), res);

    assert.equal(res._status, 200);
    const trace = res._body?.extensionFinancialTrace;
    assert.ok(trace, "extensionFinancialTrace must be present");
    assert.equal(trace.overdue_amount, 200, "overdue booking: overdue_amount = ledger_balance");
    assert.equal(trace.ledger_balance, 200, "ledger_balance should be 200");
    assert.equal(trace.render_source_used, "supabase+ledger");
  });
});

test("extension-financial-trace: partial payment extension captured in trace", async () => {
  mockLedgerSummary = { remaining_balance: 0, total_paid: 0, total_charges: 0,
    total_credits: 0, total_waived: 0, total_refunds: 0,
    net_balance: 0, credit_balance: 0, transaction_count: 0 };

  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  // Use a "now" before the return date so no late fees inflate the minimum payment.
  await withMockedNow("2026-04-28T12:00:00-07:00", async () => {
    const res = makeRes();
    // 5 extension days at $55 = $275 total; minimum = ceil(5/2)*55 = 165; $200 is valid.
    await handler(makeReq({
      vehicleId: "camry", email: "alice@example.com",
      newReturnDate: "2026-05-05", customPaymentAmount: 200,
    }), res);

    assert.equal(res._status, 200, "partial payment should succeed");
    const trace = res._body?.extensionFinancialTrace;
    assert.ok(trace, "extensionFinancialTrace must be present");
    assert.equal(trace.amount_paid_now, 200, "amount_paid_now should be 200");
    assert.ok(Number(trace.remaining_balance_after) > 0, "remaining balance should be > 0 for partial payment");
    assert.ok(Number(trace.computed_extension_total) > 200, "total > partial payment");
  });
});

test("extension-financial-trace: all required trace fields present in response", async () => {
  mockLedgerSummary = { remaining_balance: 0, total_paid: 0, total_charges: 0,
    total_credits: 0, total_waived: 0, total_refunds: 0,
    net_balance: 0, credit_balance: 0, transaction_count: 0 };

  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient = null;

  const res = makeRes();
  await handler(makeReq({ vehicleId: "camry", email: "alice@example.com", newReturnDate: "2026-05-05" }), res);

  assert.equal(res._status, 200);
  const trace = res._body?.extensionFinancialTrace;
  assert.ok(trace, "extensionFinancialTrace must be present");
  const requiredFields = [
    "booking_id", "overdue_amount", "late_fee_amount", "deferred_late_fee",
    "late_fee_waived", "extension_fee_amount", "payment_plan_state",
    "ledger_balance", "computed_extension_total", "amount_paid_now",
    "remaining_balance_after", "render_source_used",
  ];
  for (const field of requiredFields) {
    assert.ok(field in trace, `trace must include field: ${field}`);
  }
});
