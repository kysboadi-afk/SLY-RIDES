// api/_fleet-status.test.js
// Tests for GET /api/fleet-status.
//
// Availability is now derived ONLY from the Supabase `blocked_dates` table.
// vehicles.rental_status is used only for maintenance mode (not for
// booking-based availability).  fleet-status.json is no longer used.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_REPO = "kysboadi-afk/SLY-RIDES";
process.env.GITHUB_TOKEN = "test-github-token";

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function makeReq() {
  return { method: "GET", headers: { origin: "https://slycarrentals.com" }, query: {}, body: {} };
}

const sbMock = {
  client: null,
  vehiclesRows: [
    { vehicle_id: "camry",      rental_status: "available" },
    { vehicle_id: "camry2013",  rental_status: "available" },
  ],
  vehiclesError: null,
  blockedDateRows: [],
  blockedError: null,
  bookingRows: [],
  bookingError: null,
};

function buildSbClient() {
  return {
    from(table) {
      const chain = {
        select() { return this; },
        eq()     { return this; },
        not()    { return this; },
        gte()    { return this; },
        lte()    { return this; },
        limit()  { return this; },
        order()  { return this; },
        in()     { return this; },
        async then(resolve) {
          if (table === "vehicles") {
            return resolve({ data: sbMock.vehiclesRows, error: sbMock.vehiclesError });
          }
          if (table === "blocked_dates") {
            return resolve({ data: sbMock.blockedDateRows, error: sbMock.blockedError });
          }
          if (table === "bookings") {
            return resolve({ data: sbMock.bookingRows, error: sbMock.bookingError });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => sbMock.client,
  },
});

// fleet-status.json is no longer consulted for availability — any fetch to it
// should never be needed.  Return an empty object to surface regressions.
globalThis.fetch = async () => ({ ok: false, status: 404 });

const { default: handler } = await import("./fleet-status.js");

function resetMock() {
  sbMock.vehiclesRows = [
    { vehicle_id: "camry",      rental_status: "available" },
    { vehicle_id: "camry2013",  rental_status: "available" },
  ];
  sbMock.vehiclesError  = null;
  sbMock.blockedDateRows = [];
  sbMock.blockedError   = null;
  sbMock.bookingRows = [];
  sbMock.bookingError = null;
  sbMock.client = buildSbClient();
}

test("OPTIONS returns 200", async () => {
  const res = makeRes();
  await handler({ method: "OPTIONS", headers: { origin: "https://slycarrentals.com" } }, res);
  assert.equal(res._status, 200);
});

test("non-GET returns 405", async () => {
  resetMock();
  const res = makeRes();
  await handler({ method: "POST", headers: {}, query: {}, body: {} }, res);
  assert.equal(res._status, 405);
});

test("no Supabase: returns hard-coded defaults with all vehicles available", async () => {
  sbMock.client = null;
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);
  // All FALLBACK_VEHICLE_IDS should be available
  for (const vid of ["camry", "camry2013"]) {
    assert.equal(res._body[vid]?.available, true, `${vid} should default to available`);
  }
});

test("Supabase vehicles error: uses fallback IDs, still queries blocked_dates, all available when no active blocks", async () => {
  resetMock();
  sbMock.vehiclesError = { message: "db timeout" };
  sbMock.vehiclesRows  = null;
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);
  // No blocked dates → all vehicles should be available
  for (const vid of ["camry"]) {
    assert.equal(res._body[vid]?.available, true, `${vid} should be available with no active blocks`);
    assert.equal(res._body[vid]?.available_at, null);
  }
});

test("no active blocks: all vehicles available and available_at is null", async () => {
  resetMock();
  sbMock.blockedDateRows = [];
  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  for (const vid of ["camry", "camry2013"]) {
    assert.equal(res._body[vid]?.available, true, `${vid} should be available`);
    assert.equal(res._body[vid]?.available_at, null, `${vid} should have available_at=null`);
  }
});

test("active blocked_dates row makes vehicle unavailable with date-only next_available_display", async () => {
  resetMock();
  sbMock.blockedDateRows = [
    { vehicle_id: "camry", end_date: "2026-06-10" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  // blocked_dates row drives unavailability — regardless of vehicles.rental_status
  assert.equal(res._body.camry?.available, false);
  // no end_time on row → available_at stays null (legacy date-only behaviour)
  assert.equal(res._body.camry?.available_at, null);
  // next_available_display is set to date only (no time component)
  assert.ok(res._body.camry?.next_available_display, "next_available_display should be set");
  assert.ok(!res._body.camry.next_available_display.includes(" at "), "next_available_display must not include time");
  assert.ok(res._body.camry.next_available_display.includes("Jun"), "next_available_display should contain the month");
});

test("booking-generated blocked_dates row is ignored when booking is no longer active", async () => {
  resetMock();
  sbMock.blockedDateRows = [
    { vehicle_id: "camry", booking_ref: "bk-stale", reason: "booking", end_date: "2026-06-10" },
  ];
  sbMock.bookingRows = [];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available, true, "stale booking-linked block should not keep vehicle unavailable");
  assert.equal(res._body.camry?.available_at, null);
});

test("maintenance vehicle is unavailable even with no active blocks", async () => {
  resetMock();
  sbMock.vehiclesRows = [
    { vehicle_id: "camry",      rental_status: "maintenance" },
    { vehicle_id: "camry2013",  rental_status: "available"   },
  ];
  sbMock.blockedDateRows = []; // no blocks

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available, false, "maintenance vehicle should be unavailable");
  assert.equal(res._body.camry?.rental_status, "maintenance");
  assert.equal(res._body.camry?.available_at, null, "no block = no available_at");
  assert.equal(res._body.camry2013?.available, true, "non-maintenance vehicle should still be available");
});

test("logs [AVAILABLE_AT_COMPUTED] with null return_datetime and date-only next_available_display when end_time is absent", async () => {
  resetMock();
  sbMock.blockedDateRows = [
    { vehicle_id: "camry", end_date: "2026-06-10" },
  ];

  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => { captured.push(args); };

  try {
    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(res._status, 200);
    const computedLog = captured.find((args) => args[0] === "[AVAILABLE_AT_COMPUTED]");
    assert.ok(computedLog, "Expected [AVAILABLE_AT_COMPUTED] log entry");
    assert.equal(computedLog[1]?.vehicle_id, "camry");
    // end_time absent — return_datetime is null (legacy date-only behaviour)
    assert.equal(computedLog[1]?.return_datetime, null);
    // next_available_display is date-only
    assert.ok(res._body.camry?.next_available_display, "next_available_display should be set");
    assert.ok(!res._body.camry.next_available_display.includes(" at "), "next_available_display must not include time");
  } finally {
    console.log = originalLog;
  }
});

test("blocked_dates row with end_time makes vehicle unavailable with time-aware display", async () => {
  resetMock();
  sbMock.blockedDateRows = [
    { vehicle_id: "camry", end_date: "2026-06-10", end_time: "17:00" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available, false);
  // available_at should be an ISO string when end_time is present
  assert.ok(res._body.camry?.available_at, "available_at should be set when end_time is present");
  assert.ok(typeof res._body.camry.available_at === "string", "available_at should be a string");
  assert.ok(res._body.camry.available_at.includes("T"), "available_at should be ISO 8601");
  // next_available_display should include time
  assert.ok(res._body.camry?.next_available_display, "next_available_display should be set");
  assert.ok(res._body.camry.next_available_display.includes(" at "), "next_available_display should include time");
  assert.ok(res._body.camry.next_available_display.includes("Jun"), "next_available_display should contain the month");
});

test("expired block (end_date today, end_time in the past) shows vehicle as available", async () => {
  resetMock();
  // Simulate a block that ends today at 00:00 (midnight).  The expiry check is
  // `blockMins <= nowMinutesLA` so when both equal 0 at midnight the block is
  // already considered expired, and it is definitely expired for every minute
  // of the rest of the day.  Using 00:00 avoids the 1-minute race window that
  // 00:01 had when tests ran between 00:00 and 00:00:59 LA time.
  const todayLA = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  sbMock.blockedDateRows = [
    { vehicle_id: "camry", end_date: todayLA, end_time: "00:00" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  // Block has already expired (00:00 is always <= nowMinutesLA for any clock
  // reading) — the vehicle should now be available.
  assert.equal(res._body.camry?.available, true, "camry should be available after block expiry");
  assert.equal(res._body.camry?.available_at, null, "available_at should be null when available");
});

test("latest blocked end_date wins per vehicle", async () => {
  resetMock();
  sbMock.blockedDateRows = [
    { vehicle_id: "camry", end_date: "2026-06-09" },
    { vehicle_id: "camry", end_date: "2026-06-10" },
    { vehicle_id: "camry", end_date: "2026-06-08" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available, false);
  // next_available_display should reflect the latest end_date (Jun 10)
  assert.ok(res._body.camry?.next_available_display?.includes("10"), "display should show day 10");
});

test("latest block wins by end_time when end_dates are equal", async () => {
  resetMock();
  sbMock.blockedDateRows = [
    { vehicle_id: "camry", end_date: "2026-06-10", end_time: "15:00" },
    { vehicle_id: "camry", end_date: "2026-06-10", end_time: "17:00" },
    { vehicle_id: "camry", end_date: "2026-06-10", end_time: "12:00" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available, false);
  // available_at should reflect the latest time (17:00 LA)
  assert.ok(res._body.camry?.available_at, "available_at should be set");
  // The ISO timestamp should represent 17:00 LA time — verify it parses to the same wall-clock hour
  const availAt = new Date(res._body.camry.available_at);
  const hourLA = parseInt(availAt.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false,
  }), 10);
  assert.equal(hourLA, 17, "available_at should be anchored to 17:00 LA time");
  // blocked_dates.end_time stores the buffered availability time (actual return +2h).
  // next_available_display is built from end_time directly, so the highest end_time
  // here (17:00 = 5:00 PM) is what visitors see as the earliest pickup slot.
  assert.ok(res._body.camry?.next_available_display?.includes("5:00 PM"), "should reflect buffered availability 17:00 → 5:00 PM");
});

test("active-booking fallback keeps vehicle unavailable when overdue is within 24h", async () => {
  resetMock();
  const todayLA = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  sbMock.blockedDateRows = []; // force fallback path
  sbMock.bookingRows = [{
    vehicle_id: "camry",
    booking_ref: "bk-active-fallback",
    pickup_date: todayLA,
    return_date: todayLA,
    return_time: "00:00",
    status: "overdue",
    extend_pending: false,
    extension_pending_payment: null,
  }];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available, false, "active-booking fallback should keep overdue rental unavailable");
});

test("active-booking fallback keeps vehicle unavailable when extension payment is pending past 24h", async () => {
  resetMock();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const ymdYesterdayLA = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(yesterday);
  sbMock.blockedDateRows = []; // force fallback path
  sbMock.bookingRows = [{
    vehicle_id: "camry",
    booking_ref: "bk-pending-hold",
    pickup_date: ymdYesterdayLA,
    return_date: ymdYesterdayLA,
    return_time: "00:00",
    status: "overdue",
    extend_pending: true,
    extension_pending_payment: { status: "pending" },
  }];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available, false, "pending extension-payment hold should keep vehicle unavailable");
});
