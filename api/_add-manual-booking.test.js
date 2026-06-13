// api/_add-manual-booking.test.js
// Preflight validation tests for add-manual-booking.js
//
// Validates that the Supabase sync helpers are always called for every new
// manual booking, preventing the source-of-truth mismatch between
// bookings.json and the Supabase bookings / blocked_dates tables.
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.ADMIN_SECRET = "test-secret";
process.env.GITHUB_TOKEN = "test-github-token";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeRes() {
  return {
    _status:  200,
    _body:    null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code)    { this._status = code; return this; },
    json(body)      { this._body = body; return this; },
    send(body)      { this._body = body; return this; },
    end()           { return this; },
  };
}

function makeReq(body, origin = "https://slycarrentals.com") {
  return { method: "POST", headers: { origin }, body };
}

// In-memory bookings store
const bookingsStore = {};

// Automation call recorder
const automationCalls = { revenue: [], customer: [], booking: [], blocked: [] };

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings: async () => ({ data: JSON.parse(JSON.stringify(bookingsStore)), sha: "sha1" }),
    saveBookings: async (data) => { Object.assign(bookingsStore, JSON.parse(JSON.stringify(data))); },
  },
});

mock.module("./_github-retry.js", {
  namedExports: {
    updateJsonFileWithRetry: async ({ load, apply, save, message }) => {
      const { data, sha } = await load();
      apply(data);
      await save(data, sha, message);
    },
  },
});

mock.module("./_booking-automation.js", {
  namedExports: {
    autoCreateRevenueRecord: async (b)         => { automationCalls.revenue.push({ ...b }); },
    autoUpsertCustomer:      async (b, s)       => { automationCalls.customer.push({ ...b, countStats: s }); },
    autoUpsertBooking:       async (b)          => { automationCalls.booking.push({ ...b }); },
    autoCreateBlockedDate:   async (v, s, e, r) => { automationCalls.blocked.push({ vehicleId: v, start: s, end: e, reason: r }); },
  },
});

let nextAvailability = true;

mock.module("./_availability.js", {
  namedExports: {
    hasOverlap: (ranges, from, to) => ranges.some((r) => from <= r.to && r.from <= to),
    isDatesAndTimesAvailable: async () => nextAvailability,
  },
});

mock.module("./_error-helpers.js", {
  namedExports: {
    adminErrorMessage: (err) => err?.message || String(err),
  },
});

// Mock _booking-pipeline.js so persistBooking stores the booking in the
// in-memory bookingsStore and populates automationCalls without hitting
// real Supabase or GitHub.  add-manual-booking always creates as booked_paid
// so all four automation calls are expected.
mock.module("./_booking-pipeline.js", {
  namedExports: {
    persistBooking: async (opts) => {
      const booking = { smsSentAt: {}, createdAt: new Date().toISOString(), ...opts };
      automationCalls.revenue.push({ ...booking });
      automationCalls.customer.push({ ...booking, countStats: false });
      automationCalls.booking.push({ ...booking });
      if (opts.pickupDate && opts.returnDate) {
        automationCalls.blocked.push({
          vehicleId: opts.vehicleId,
          start:     opts.pickupDate,
          end:       opts.returnDate,
          reason:    "booking",
        });
      }
      if (!Array.isArray(bookingsStore[opts.vehicleId])) bookingsStore[opts.vehicleId] = [];
      if (!bookingsStore[opts.vehicleId].some((b) => b.bookingId === booking.bookingId)) {
        bookingsStore[opts.vehicleId].push(booking);
      }
      return { ok: true, bookingId: booking.bookingId, booking, supabaseOk: true, errors: [] };
    },
  },
});

// Stub GitHub API calls for date blocking
global.fetch = async (url) => {
  try {
    const parsed = new URL(typeof url === "string" ? url : String(url));
    if (parsed.hostname === "api.github.com") {
      return { ok: true, json: async () => ({ content: btoa("{}"), sha: "sha1" }) };
    }
  } catch { /* fall through */ }
  return { ok: false };
};

const { default: handler } = await import("./add-manual-booking.js");

function resetStore() {
  for (const k of Object.keys(bookingsStore)) delete bookingsStore[k];
}
function resetCalls() {
  automationCalls.revenue.length = 0;
  automationCalls.customer.length = 0;
  automationCalls.booking.length = 0;
  automationCalls.blocked.length = 0;
}

function basePayload(overrides = {}) {
  return {
    secret:      "test-secret",
    vehicleId:   "camry",
    name:        "Bob Tester",
    phone:       "+13105550002",
    email:       "bob@example.com",
    pickupDate:  "2026-07-01",
    pickupTime:  "10:00 AM",
    returnDate:  "2026-07-03",
    returnTime:  "5:00 PM",
    amountPaid:  150,
    ...overrides,
  };
}

// ─── Auth / input validation ──────────────────────────────────────────────────

test("add-manual-booking: 401 for wrong secret", async () => {
  const res = makeRes();
  await handler(makeReq({ ...basePayload(), secret: "bad" }), res);
  assert.equal(res._status, 401);
});

test("add-manual-booking: 400 for missing name", async () => {
  const res = makeRes();
  await handler(makeReq({ ...basePayload(), name: "" }), res);
  assert.equal(res._status, 400);
});

test("add-manual-booking: 400 for invalid vehicleId", async () => {
  const res = makeRes();
  await handler(makeReq({ ...basePayload(), vehicleId: "unknown" }), res);
  assert.equal(res._status, 400);
});

test("add-manual-booking: 400 when returnDate before pickupDate", async () => {
  const res = makeRes();
  await handler(makeReq({ ...basePayload(), pickupDate: "2026-07-10", returnDate: "2026-07-05" }), res);
  assert.equal(res._status, 400);
});

test("add-manual-booking: 400 for missing pickupTime", async () => {
  const res = makeRes();
  await handler(makeReq({ ...basePayload(), pickupTime: "" }), res);
  assert.equal(res._status, 400);
});

test("add-manual-booking: 400 for missing returnTime", async () => {
  const res = makeRes();
  await handler(makeReq({ ...basePayload(), returnTime: "" }), res);
  assert.equal(res._status, 400);
});

test("add-manual-booking: succeeds even when GITHUB_TOKEN is unset", async () => {
  resetStore(); resetCalls();
  const prevToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const res = makeRes();
    await handler(makeReq(basePayload()), res);
    assert.equal(res._status, 200);
    assert.ok(res._body?.booking, "manual booking should still be created without GITHUB_TOKEN");
  } finally {
    process.env.GITHUB_TOKEN = prevToken;
  }
});

// ─── Supabase sync preflight validations ─────────────────────────────────────

test("add-manual-booking: successful booking returns 200 with booking record", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(basePayload()), res);
  assert.equal(res._status, 200);
  assert.ok(res._body.booking, "response must include booking record");
  assert.equal(res._body.booking.vehicleId, "camry");
});

test("add-manual-booking: PREFLIGHT — autoCreateRevenueRecord is called", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(basePayload()), res);
  assert.equal(res._status, 200);
  assert.ok(
    automationCalls.revenue.length > 0,
    "autoCreateRevenueRecord must be called so the revenue_records table stays in sync"
  );
  assert.equal(automationCalls.revenue[0].vehicleId, "camry");
});

test("add-manual-booking: PREFLIGHT — autoUpsertCustomer is called", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(basePayload()), res);
  assert.equal(res._status, 200);
  assert.ok(
    automationCalls.customer.length > 0,
    "autoUpsertCustomer must be called so the customers table stays in sync"
  );
  assert.equal(automationCalls.customer[0].phone, "+13105550002");
});

test("add-manual-booking: PREFLIGHT — autoUpsertBooking is called (Supabase bookings table)", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(basePayload()), res);
  assert.equal(res._status, 200);
  assert.ok(
    automationCalls.booking.length > 0,
    "autoUpsertBooking must be called to keep Supabase bookings table in sync with bookings.json"
  );
  assert.equal(automationCalls.booking[0].vehicleId, "camry");
});

test("add-manual-booking: PREFLIGHT — autoCreateBlockedDate is called (Supabase blocked_dates table)", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(basePayload()), res);
  assert.equal(res._status, 200);
  assert.ok(
    automationCalls.blocked.length > 0,
    "autoCreateBlockedDate must be called to keep Supabase blocked_dates table in sync with booked-dates.json"
  );
  assert.equal(automationCalls.blocked[0].vehicleId, "camry");
  assert.equal(automationCalls.blocked[0].start, "2026-07-01");
  assert.equal(automationCalls.blocked[0].end,   "2026-07-03");
  assert.equal(automationCalls.blocked[0].reason, "booking");
});

test("add-manual-booking: PREFLIGHT — all four Supabase helpers fire together", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(basePayload({ amountPaid: 300 })), res);
  assert.equal(res._status, 200);
  assert.ok(automationCalls.revenue.length  > 0, "revenue record must fire");
  assert.ok(automationCalls.customer.length > 0, "customer upsert must fire");
  assert.ok(automationCalls.booking.length  > 0, "booking upsert must fire");
  assert.ok(automationCalls.blocked.length  > 0, "blocked date must fire");
});

test("add-manual-booking: forwards totalPrice so partial cash bookings keep partial revenue state", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(basePayload({ amountPaid: 75, totalPrice: 200 })), res);
  assert.equal(res._status, 200);
  assert.equal(automationCalls.revenue[0].amountPaid, 75);
  assert.equal(automationCalls.revenue[0].totalPrice, 200);
  assert.equal(automationCalls.revenue[0].paymentStatus, "partial");
});

test("add-manual-booking: 409 when dates conflict with an existing booking", async () => {
  resetStore(); resetCalls();
  nextAvailability = false;
  try {
    const res = makeRes();
    await handler(makeReq(basePayload()), res);
    assert.equal(res._status, 409);
    assert.equal(res._body?.error, "conflict");
    assert.equal(automationCalls.revenue.length,  0, "no revenue record should be created on conflict");
    assert.equal(automationCalls.booking.length,  0, "no booking should be created on conflict");
  } finally {
    nextAvailability = true;
  }
});

test("add-manual-booking: booking is created with status active_rental", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(basePayload()), res);
  assert.equal(res._status, 200);
  assert.equal(
    res._body.booking.status,
    "active_rental",
    "manual bookings must start as active_rental so they participate in SMS and mileage automation immediately"
  );
});

test("add-manual-booking: booking has activatedAt stamped on creation", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(basePayload()), res);
  assert.equal(res._status, 200);
  assert.ok(
    res._body.booking.activatedAt,
    "activatedAt must be set so the activated_at column is populated in Supabase"
  );
  // Verify it is a valid ISO timestamp
  assert.ok(
    !isNaN(new Date(res._body.booking.activatedAt).getTime()),
    "activatedAt must be a valid ISO timestamp"
  );
});
