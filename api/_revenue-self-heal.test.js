import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.ADMIN_SECRET = "test-admin-secret";

const revenueRows = [];
const bookingsByRef = {};
const persistCalls = [];
// Phase 2 state: paid non-cancelled bookings and captured inserts
const paidBookings = [];
const insertedRevenue = [];
const stripePiFixtures = new Map();
const stripeChargeFixtures = new Map();

mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    paymentIntents = {
      retrieve: async (id) => {
        if (stripePiFixtures.has(id)) return stripePiFixtures.get(id);
        return {
          id,
          amount_received: 35000,
          latest_charge: {
            id: `ch_${id}`,
            balance_transaction: {
              id: `txn_${id}`,
              fee: 1200,
              net: 33800,
            },
          },
        };
      },
    };
    charges = {
      retrieve: async (id) => {
        if (stripeChargeFixtures.has(id)) return stripeChargeFixtures.get(id);
        return {
          id,
          balance_transaction: {
            id: `txn_${id}`,
            fee: 1200,
            net: 33800,
          },
        };
      },
    };
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from: (table) => {
        let updatePayload = null;
        let filterCol = null;
        let filterVal = null;
        let filter2Col = null;
        let filter2Val = null;
        let isInitialQuery = false; // set by .or() → the initial revenue_records list query
        let isBookingsPhase2 = false; // set by .gt() → the paid bookings fetch
        return {
          select() { return this; },
          or() {
            // .or() is only called on the initial "fetch all needing repair" query
            isInitialQuery = true;
            return this;
          },
          gt() {
            // .gt() is called on the Phase 2 paid bookings query
            isBookingsPhase2 = true;
            return this;
          },
          not() { return this; },
          then(resolve, reject) {
            if (table === "revenue_records" && isInitialQuery) {
              // Simulate the filtered query: stripe_fee IS NULL OR payment_intent_id IS NULL
              const data = revenueRows.filter(
                (r) => r.stripe_fee == null || !r.payment_intent_id
              );
              return Promise.resolve({ data, error: null }).then(resolve, reject);
            }
            if (table === "bookings" && isBookingsPhase2) {
              return Promise.resolve({ data: paidBookings, error: null }).then(resolve, reject);
            }
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          },
          eq(col, val) {
            // Handle update + eq("id", ...) pattern → resolves directly as a Promise
            if (updatePayload && table === "revenue_records" && col === "id") {
              const idx = revenueRows.findIndex((r) => r.id === val);
              if (idx !== -1) revenueRows[idx] = { ...revenueRows[idx], ...updatePayload };
              return Promise.resolve({ error: null });
            }
            // Track up to two filter columns for compound lookups
            if (!filterCol) { filterCol = col; filterVal = val; }
            else { filter2Col = col; filter2Val = val; }
            return this;
          },
          update(payload) {
            updatePayload = payload;
            return this;
          },
          insert(payload) {
            if (table === "revenue_records") {
              const newId = `rr_inserted_${revenueRows.length}`;
              revenueRows.push({ id: newId, type: "rental", ...payload });
              insertedRevenue.push({ ...payload });
              return Promise.resolve({ error: null });
            }
            return Promise.resolve({ error: null });
          },
          maybeSingle() {
            // Bookings lookup by booking_ref (Phase 1)
            if (table === "bookings" && filterCol === "booking_ref") {
              return Promise.resolve({ data: bookingsByRef[filterVal] || null, error: null });
            }
            // Revenue lookup by id (Phase 1 verify step)
            if (table === "revenue_records" && filterCol === "id") {
              const row = revenueRows.find((r) => r.id === filterVal) || null;
              return Promise.resolve({ data: row, error: null });
            }
            // Phase 2: Revenue lookup by booking_id + type
            if (table === "revenue_records" && filterCol === "booking_id" && filter2Col === "type") {
              const row = revenueRows.find(
                (r) => r.booking_id === filterVal && r.type === filter2Val
              ) || null;
              return Promise.resolve({ data: row, error: null });
            }
            // Phase 2: Revenue lookup by payment_intent_id (dedup check)
            if (table === "revenue_records" && filterCol === "payment_intent_id") {
              const row = revenueRows.find((r) => r.payment_intent_id === filterVal) || null;
              return Promise.resolve({ data: row, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    }),
  },
});

mock.module("./_booking-pipeline.js", {
  namedExports: {
    persistBooking: async (payload) => {
      persistCalls.push(payload);
      bookingsByRef[payload.bookingId] = {
        id: `rebuilt_${payload.bookingId}`,
        payment_intent_id: payload.paymentIntentId || null,
      };
      return { ok: true, bookingId: payload.bookingId, booking: payload, supabaseOk: true, errors: [] };
    },
  },
});

const { default: handler } = await import("./revenue-self-heal.js");

function makeRes() {
  return {
    _status: 200,
    _body: null,
    setHeader() {},
    status(code) { this._status = code; return this; },
    json(payload) { this._body = payload; return this; },
    send(payload) { this._body = payload; return this; },
    end() { return this; },
  };
}

test("revenue-self-heal repairs incomplete revenue row", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;
  stripePiFixtures.clear();
  stripeChargeFixtures.clear();
  revenueRows.push({
    id: "rr_1",
    booking_id: "bk-1",
    payment_intent_id: "pi_1",
    stripe_fee: null,
    refund_amount: 0,
    type: "rental",
  });
  bookingsByRef["bk-1"] = { id: "b_1", payment_intent_id: "pi_1" };

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.failed, 0);
  assert.equal(res._body.repaired, 1);
  assert.equal(persistCalls.length, 0);
  assert.equal(revenueRows[0].stripe_fee, 12);
  assert.equal(revenueRows[0].payment_intent_id, "pi_1");
});

test("revenue-self-heal repairs manual payment_intent without Stripe lookup", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;
  stripePiFixtures.clear();
  stripeChargeFixtures.clear();
  revenueRows.push({
    id: "rr_manual_1",
    booking_id: "bk-manual-1",
    payment_intent_id: "manual_6e6449ec422b",
    stripe_fee: null,
    gross_amount: 127.45,
    refund_amount: 0,
    type: "rental",
  });
  bookingsByRef["bk-manual-1"] = { id: "b_manual_1", payment_intent_id: "manual_6e6449ec422b" };

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.failed, 0);
  assert.equal(res._body.repaired, 1);
  assert.equal(revenueRows[0].stripe_fee, 0);
  assert.equal(revenueRows[0].gross_amount, 127.45);
  assert.equal(persistCalls.length, 0);
});

test("revenue-self-heal falls back to charge lookup when PI latest_charge bt is missing", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;
  stripePiFixtures.clear();
  stripeChargeFixtures.clear();
  revenueRows.push({
    id: "rr_pi_fallback_1",
    booking_id: "bk-pi-fallback-1",
    payment_intent_id: "pi_bt_missing_1",
    stripe_fee: null,
    gross_amount: 49.99,
    refund_amount: 0,
    type: "rental",
  });
  bookingsByRef["bk-pi-fallback-1"] = { id: "b_pi_fallback_1", payment_intent_id: "pi_bt_missing_1" };
  stripePiFixtures.set("pi_bt_missing_1", {
    id: "pi_bt_missing_1",
    amount_received: 4999,
    latest_charge: { id: "ch_bt_missing_1", balance_transaction: null },
    metadata: {},
  });
  stripeChargeFixtures.set("ch_bt_missing_1", {
    id: "ch_bt_missing_1",
    balance_transaction: { id: "txn_bt_missing_1", fee: 333, net: 4666 },
  });

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.failed, 0);
  assert.equal(res._body.repaired, 1);
  assert.equal(revenueRows[0].stripe_fee, 3.33);
  assert.equal(revenueRows[0].gross_amount, 49.99);
});

test("revenue-self-heal reconstructs missing booking from revenue + Stripe data", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;
  stripePiFixtures.clear();
  stripeChargeFixtures.clear();
  revenueRows.push({
    id: "rr_missing_booking",
    booking_id: "bk-missing",
    payment_intent_id: "pi_missing",
    stripe_fee: null,
    refund_amount: 0,
    gross_amount: 350,
    vehicle_id: "camry",
    pickup_date: "2026-04-01",
    return_date: "2026-04-05",
    customer_name: "Rosa Ortuno",
    customer_phone: "+15551234567",
    customer_email: "rosa@example.com",
    type: "rental",
  });
  delete bookingsByRef["bk-missing"];

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.failed, 0);
  assert.equal(res._body.repaired, 1);
  assert.equal(persistCalls.length, 1);
  assert.equal(bookingsByRef["bk-missing"]?.id, "rebuilt_bk-missing");
});

// ── Phase 2: Backfill bookings without any revenue record ─────────────────────

test("revenue-self-heal Phase 2: creates missing revenue record for cash booking", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;
  paidBookings.push({
    id: "b_cash_1",
    booking_ref: "bk-cash-1",
    vehicle_id: "camry",
    pickup_date: "2026-05-01",
    return_date: "2026-05-03",
    deposit_paid: 300,
    payment_method: "cash",
    payment_intent_id: null,
    customer_name: "Alice Cash",
    customer_phone: "+13105550101",
    customer_email: null,
  });

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.backfilled, 1);
  assert.equal(res._body.backfill_failed, 0);
  assert.equal(insertedRevenue.length, 1);
  assert.equal(insertedRevenue[0].booking_id, "bk-cash-1");
  assert.equal(insertedRevenue[0].type, "rental");
  assert.equal(insertedRevenue[0].stripe_fee, 0,   "cash booking must have stripe_fee=0");
  assert.equal(insertedRevenue[0].stripe_net, 300, "cash booking must have stripe_net=gross");
  assert.equal(insertedRevenue[0].gross_amount, 300);
  assert.equal(insertedRevenue[0].vehicle_id, "camry");
});

test("revenue-self-heal Phase 2: creates missing revenue record for Stripe booking", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;
  paidBookings.push({
    id: "b_stripe_1",
    booking_ref: "bk-stripe-1",
    vehicle_id: "camry2013",
    pickup_date: "2026-06-01",
    return_date: "2026-06-07",
    deposit_paid: 350,
    payment_method: "stripe",
    payment_intent_id: "pi_stripe_abc",
    customer_name: "Bob Stripe",
    customer_phone: "+13105550202",
    customer_email: "bob@example.com",
  });

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.backfilled, 1);
  assert.equal(res._body.backfill_failed, 0);
  assert.equal(insertedRevenue.length, 1);
  assert.equal(insertedRevenue[0].booking_id, "bk-stripe-1");
  assert.equal(insertedRevenue[0].payment_intent_id, "pi_stripe_abc");
  assert.equal(insertedRevenue[0].stripe_fee, null, "Stripe booking must have stripe_fee=null (to be filled by reconcile)");
  assert.equal(insertedRevenue[0].gross_amount, 350);
});

test("revenue-self-heal Phase 2: skips booking that already has a revenue record", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;
  // Booking already has a revenue record
  revenueRows.push({
    id: "rr_existing",
    booking_id: "bk-exists",
    payment_intent_id: "pi_exists",
    stripe_fee: 10,
    type: "rental",
  });
  paidBookings.push({
    id: "b_exists_1",
    booking_ref: "bk-exists",
    vehicle_id: "camry",
    pickup_date: "2026-07-01",
    return_date: "2026-07-02",
    deposit_paid: 55,
    payment_method: "stripe",
    payment_intent_id: "pi_exists",
    customer_name: "Carol Exists",
    customer_phone: null,
    customer_email: null,
  });

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.backfilled, 0, "should not create duplicate revenue record");
  assert.equal(insertedRevenue.length, 0);
});

test("revenue-self-heal Phase 2: skips booking covered by payment_intent_id match", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;
  // An orphan or differently-keyed record covers the same payment_intent_id
  revenueRows.push({
    id: "rr_orphan",
    booking_id: null,
    payment_intent_id: "pi_shared",
    stripe_fee: 12,
    type: "rental",
  });
  paidBookings.push({
    id: "b_shared_1",
    booking_ref: "bk-different-ref",
    vehicle_id: "camry",
    pickup_date: "2026-08-01",
    return_date: "2026-08-02",
    deposit_paid: 55,
    payment_method: "stripe",
    payment_intent_id: "pi_shared",
    customer_name: "Dave Shared",
    customer_phone: null,
    customer_email: null,
  });

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.backfilled, 0, "should not create record when PI already covered");
  assert.equal(insertedRevenue.length, 0);
});

test("revenue-self-heal Phase 2: skips booking without booking_ref", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;
  paidBookings.push({
    id: "b_no_ref",
    booking_ref: null,
    vehicle_id: "camry",
    pickup_date: "2026-09-01",
    return_date: "2026-09-02",
    deposit_paid: 55,
    payment_method: "cash",
    payment_intent_id: null,
    customer_name: "Eve No Ref",
    customer_phone: null,
    customer_email: null,
  });

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.backfilled, 0, "booking without booking_ref must be skipped");
  assert.equal(insertedRevenue.length, 0);
});

test("revenue-self-heal Phase 2: backfills multiple missing bookings in one pass", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;
  paidBookings.push(
    {
      id: "b_m1",
      booking_ref: "bk-m1",
      vehicle_id: "camry",
      pickup_date: "2026-10-01",
      return_date: "2026-10-03",
      deposit_paid: 110,
      payment_method: "cash",
      payment_intent_id: null,
      customer_name: null,
      customer_phone: null,
      customer_email: null,
    },
    {
      id: "b_m2",
      booking_ref: "bk-m2",
      vehicle_id: "camry2013",
      pickup_date: "2026-10-05",
      return_date: "2026-10-08",
      deposit_paid: 165,
      payment_method: "zelle",
      payment_intent_id: null,
      customer_name: null,
      customer_phone: null,
      customer_email: null,
    }
  );

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.backfilled, 2);
  assert.equal(res._body.backfill_failed, 0);
  assert.equal(insertedRevenue.length, 2);
  assert.equal(insertedRevenue[0].stripe_fee, 0);
  assert.equal(insertedRevenue[1].stripe_fee, 0);
  assert.ok(res._body.ok);
});

test("revenue-self-heal Phase 2: response includes backfill stats alongside Phase 1 stats", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  paidBookings.length = 0;
  insertedRevenue.length = 0;

  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: { secret: "test-admin-secret" } }, res);

  assert.equal(res._status, 200);
  assert.ok("backfilled" in res._body, "response must include backfilled count");
  assert.ok("backfill_failed" in res._body, "response must include backfill_failed count");
  assert.ok("backfill_failures" in res._body, "response must include backfill_failures array");
  assert.ok(Array.isArray(res._body.backfill_failures));
});
