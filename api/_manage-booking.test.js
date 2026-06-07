import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let supabaseClient = null;
let stripeCreateCalls = [];

mock.module("stripe", {
  defaultExport: class FakeStripe {
    paymentIntents = {
      create: async (params) => {
        stripeCreateCalls.push(params);
        return { client_secret: "cs_test_manage_booking" };
      },
    };
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => supabaseClient,
  },
});

mock.module("./_manage-booking-token.js", {
  namedExports: {
    createManageToken: () => "mock-token",
    verifyManageToken: () => "bk-fallback-001",
  },
});

mock.module("./_vehicles.js", {
  namedExports: {
    getVehicleById: async () => ({ id: "camry", vehicleId: "camry", name: "Camry 2012" }),
    loadVehicles: async () => [],
    saveVehicles: async () => {},
  },
});

const { default: handler, isMissingColumnCompatError } = await import("./manage-booking.js");
const { deriveBookingPaymentLifecycle } = await import("./_booking-payment-lifecycle.js");

function makeReq(body, origin = "https://slycarrentals.com") {
  return { method: "POST", headers: { origin }, body };
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(key, value) { this._headers[key] = value; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function makeQueryResult(data, error = null) {
  return { data, error };
}

beforeEach(() => {
  supabaseClient = null;
  stripeCreateCalls = [];
});

test("manage-booking get falls back to legacy booking columns when newer columns are missing", async () => {
  const bookingRow = {
    id: 1,
    booking_ref: "bk-fallback-001",
    vehicle_id: "camry",
    pickup_date: "2026-05-20",
    return_date: "2026-05-24",
    pickup_time: "10:00 AM",
    return_time: "10:00 AM",
    status: "reserved",
    payment_status: "partial",
    total_price: 275,
    deposit_paid: 100,
    remaining_balance: 175,
    change_count: 0,
    customer_name: "Test Renter",
    customer_email: "test@example.com",
    customer_phone: "3105550100",
    created_at: "2026-05-15T00:00:00.000Z",
  };

  const selects = [];
  supabaseClient = {
    from(table) {
      if (table === "payment_plans") {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          order() { return this; },
          limit() { return Promise.resolve(makeQueryResult([])); },
        };
      }
      if (table === "customers") {
        return {
          select() { return this; },
          ilike() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() { return Promise.resolve(makeQueryResult([])); },
        };
      }
      assert.equal(table, "bookings");
      const ctx = { selectValue: "", isCountQuery: false };
      const chain = {
        select(value) {
          ctx.selectValue = value;
          selects.push(value);
          return this;
        },
        eq(column, value) {
          ctx.eqColumn = column;
          ctx.eqValue = value;
          return this;
        },
        ilike() { ctx.isCountQuery = true; return this; },
        not() { return this; },
        then(resolve) {
          // count query resolves directly (no maybeSingle)
          resolve({ count: 1, data: null, error: null });
        },
        async maybeSingle() {
          assert.equal(ctx.eqColumn, "booking_ref");
          assert.equal(ctx.eqValue, "bk-fallback-001");
          if (ctx.selectValue.includes("pending_change")) {
            return makeQueryResult(null, {
              code: "PGRST204",
              message: "Could not find the 'pending_change' column of 'bookings' in the schema cache",
            });
          }
          return makeQueryResult(bookingRow);
        },
      };
      return chain;
    },
  };

  const res = makeRes();
  await handler(makeReq({ action: "get", token: "valid-token" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.bookingId, "bk-fallback-001");
  assert.equal(res._body.vehicleName, "Camry 2012");
  assert.equal(res._body.hasProtectionPlan, false);
  assert.equal(res._body.protectionPlanTier, null);
  assert.equal(res._body.paymentPlan, null);
  assert.equal(res._body.paymentLifecycleState, "deposit_paid");
  assert.equal(res._body.canPayRemainingOnline, true);
  assert.equal(res._body.customerTier, "standard");
  assert.equal(res._body.isVipClient, false);
  assert.equal(res._body.isReservationStage, true);
  assert.deepEqual(res._body.contractTransitionObservability.canonicalFinancialSnapshot, {
    total: 275,
    paid: 100,
    balance: 175,
  });
  assert.equal(res._body.contractTransitionObservability.canonicalLifecycleState, "deposit_paid");
  assert.deepEqual(res._body.contractTransitionObservability.fallbackPaths, [
    {
      path: "supabase_compat_columns",
      source: "bookings_select",
    },
  ]);
  assert.deepEqual(res._body.contractTransitionObservability.surfacesUsingLegacyDerivations, [
    "manage_booking_dashboard",
  ]);
  assert.deepEqual(selects.length, 3);
});

test("manage-booking get normalizes display-name vehicle IDs to canonical IDs", async () => {
  const bookingRow = {
    id: 2,
    booking_ref: "bk-fallback-001",
    vehicle_id: "Camry 2013 SE",
    pickup_date: "2026-05-20",
    return_date: "2026-05-24",
    pickup_time: "10:00 AM",
    return_time: "10:00 AM",
    status: "active_rental",
    payment_status: "partial",
    total_price: 275,
    deposit_paid: 100,
    remaining_balance: 175,
    change_count: 0,
    customer_name: "Test Renter",
    customer_email: "test@example.com",
    customer_phone: "3105550100",
    created_at: "2026-05-15T00:00:00.000Z",
  };

  supabaseClient = {
    from(table) {
      if (table === "payment_plans") {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          order() { return this; },
          limit() { return Promise.resolve(makeQueryResult([])); },
        };
      }
      if (table === "customers") {
        return {
          select() { return this; },
          ilike() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() { return Promise.resolve(makeQueryResult([])); },
        };
      }
      assert.equal(table, "bookings");
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          return makeQueryResult(bookingRow);
        },
      };
    },
  };

  const res = makeRes();
  await handler(makeReq({ action: "get", token: "valid-token" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.vehicleId, "camry2013");
});

test("manage-booking compatibility matcher detects schema-cache missing column errors", () => {
  const err = {
    code: "PGRST204",
    message: "Could not find the 'has_protection_plan' column of 'bookings' in the schema cache",
  };
  assert.equal(isMissingColumnCompatError(err, "has_protection_plan"), true);
  assert.equal(isMissingColumnCompatError(err, "protection_plan_tier"), false);
});

test("manage-booking compatibility matcher checks message, details, and hint fields", () => {
  const err = {
    code: "PGRST204",
    message: "Could not find the 'bookings' relation in the schema cache",
    details: "Could not find the 'protection_plan_tier' column of 'bookings' in the schema cache",
    hint: null,
  };
  assert.equal(isMissingColumnCompatError(err, "protection_plan_tier"), true);
});

test("manage-booking get suppresses dismissed late fee amount from renter payload", async () => {
  const bookingRow = {
    id: 3,
    booking_ref: "bk-fallback-001",
    vehicle_id: "camry",
    pickup_date: "2026-05-20",
    return_date: "2026-05-24",
    pickup_time: "10:00 AM",
    return_time: "10:00 AM",
    status: "overdue",
    payment_status: "partial",
    total_price: 275,
    deposit_paid: 100,
    remaining_balance: 175,
    change_count: 0,
    customer_name: "Test Renter",
    customer_email: "test@example.com",
    customer_phone: "3105550100",
    created_at: "2026-05-15T00:00:00.000Z",
    late_fee_status: "dismissed",
    late_fee_amount: 75,
  };

  supabaseClient = {
    from(table) {
      if (table === "payment_plans") {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          order() { return this; },
          limit() { return Promise.resolve(makeQueryResult([])); },
        };
      }
      assert.equal(table, "bookings");
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          return makeQueryResult(bookingRow);
        },
      };
    },
  };

  const res = makeRes();
  await handler(makeReq({ action: "get", token: "valid-token" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.lateFeeStatus, "dismissed");
  assert.equal(res._body.lateFeeAmount, null);
});

test("manage-booking get_agreement_url returns a signed URL when agreement PDF exists", async () => {
  supabaseClient = {
    from(table) {
      assert.equal(table, "pending_booking_docs");
      return {
        select() { return this; },
        eq(column, value) {
          assert.equal(column, "booking_id");
          assert.equal(value, "bk-fallback-001");
          return this;
        },
        async maybeSingle() {
          return makeQueryResult({ agreement_pdf_url: "bk-fallback-001/rental-agreement.pdf" });
        },
      };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "rental-agreements");
        return {
          async createSignedUrl(path, expiresIn) {
            assert.equal(path, "bk-fallback-001/rental-agreement.pdf");
            assert.equal(expiresIn, 3600);
            return { data: { signedUrl: "https://files.example/agreement.pdf" }, error: null };
          },
        };
      },
    },
  };

  const res = makeRes();
  await handler(makeReq({ action: "get_agreement_url", token: "valid-token" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.url, "https://files.example/agreement.pdf");
  assert.equal(res._body.path, "bk-fallback-001/rental-agreement.pdf");
});

test("payment lifecycle: reservation with deposit paid stays deposit_paid until balance is cleared", () => {
  const state = deriveBookingPaymentLifecycle({
    status: "reserved",
    paymentStatus: "partial",
    category: "rideshare",
    totalAmount: 300,
    amountPaid: 50,
    remainingBalance: 250,
    paymentPlan: null,
  });
  assert.equal(state.lifecycleState, "deposit_paid");
  assert.equal(state.isPaidInFull, false);
  assert.equal(state.hasOutstandingBalance, true);
  assert.equal(state.canPayRemainingOnline, true);
});

test("payment lifecycle: full payment only transitions to completed when remaining balance is zero", () => {
  const state = deriveBookingPaymentLifecycle({
    status: "reserved",
    paymentStatus: "paid",
    category: "rideshare",
    totalAmount: 300,
    amountPaid: 300,
    remainingBalance: 0,
    paymentPlan: null,
  });
  assert.equal(state.lifecycleState, "completed");
  assert.equal(state.isPaidInFull, true);
  assert.equal(state.hasOutstandingBalance, false);
});

test("payment lifecycle: active rental is isolated from reservation lifecycle", () => {
  const state = deriveBookingPaymentLifecycle({
    status: "active_rental",
    paymentStatus: "partial",
    category: "rideshare",
    totalAmount: 450,
    amountPaid: 200,
    remainingBalance: 250,
    paymentPlan: null,
  });
  assert.equal(state.lifecycleState, "active_rental");
  assert.equal(state.canPayRemainingOnline, true);
});

test("payment lifecycle: payment plan with outstanding balance maps to payment_plan_active", () => {
  const state = deriveBookingPaymentLifecycle({
    status: "active_rental",
    paymentStatus: "partial",
    category: "rideshare",
    totalAmount: 700,
    amountPaid: 250,
    remainingBalance: 450,
    paymentPlan: { status: "active", isOverdue: false },
  });
  assert.equal(state.lifecycleState, "payment_plan_active");
  assert.equal(state.hasPaymentPlan, true);
});

test("payment lifecycle: overdue state takes precedence over other active states", () => {
  const state = deriveBookingPaymentLifecycle({
    status: "overdue",
    paymentStatus: "partial",
    category: "rideshare",
    totalAmount: 400,
    amountPaid: 150,
    remainingBalance: 250,
    paymentPlan: { status: "active", isOverdue: true },
  });
  assert.equal(state.lifecycleState, "overdue");
  assert.equal(state.isOverdue, true);
});

test("payment lifecycle: reserved_unpaid with deposit paid keeps online balance payment available", () => {
  const state = deriveBookingPaymentLifecycle({
    status: "reserved_unpaid",
    paymentStatus: "partial",
    category: "car",
    totalAmount: 350,
    amountPaid: 50,
    remainingBalance: 300,
    paymentPlan: null,
  });
  assert.equal(state.lifecycleState, "deposit_paid");
  assert.equal(state.isManualPickup, false);
  assert.equal(state.canPayRemainingOnline, true);
  assert.equal(state.isPaidInFull, false);
  assert.equal(state.hasOutstandingBalance, true);
});

test("payment lifecycle: reserved_unpaid with no partial payment stays reservation_pending and allows online payment", () => {
  const state = deriveBookingPaymentLifecycle({
    status: "reserved_unpaid",
    paymentStatus: "unpaid",
    category: "car",
    totalAmount: 350,
    amountPaid: 0,
    remainingBalance: 350,
    paymentPlan: null,
  });
  assert.equal(state.lifecycleState, "reservation_pending");
  assert.equal(state.isManualPickup, false);
  assert.equal(state.canPayRemainingOnline, true);
});


test("create_balance_payment_intent keeps automatic payment methods for remaining balance payments", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_manage_booking";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_manage_booking";

  const bookingRow = {
    booking_ref: "bk-fallback-001",
    vehicle_id: "camry",
    category: "car",
    status: "reserved",
    total_price: 400,
    deposit_paid: 100,
    remaining_balance: 300,
    customer_name: "Wallet Ready",
    customer_email: "wallet@example.com",
    customer_phone: "+13105550001",
    pickup_date: "2026-08-01",
    return_date: "2026-08-05",
  };

  supabaseClient = {
    from(table) {
      if (table === "customers") {
        return {
          select() { return this; },
          ilike() { return this; },
          order() { return this; },
          limit() {
            return Promise.resolve(makeQueryResult([
              {
                email: "partial@example.com",
                total_profit: 900,
                total_bookings: 4,
                risk_flag: "low",
                flagged: false,
                banned: false,
                no_show_count: 0,
              },
            ]));
          },
        };
      }
      assert.equal(table, "bookings");
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          return makeQueryResult(bookingRow);
        },
      };
    },
  };

  const res = makeRes();
  await handler(makeReq({ action: "create_balance_payment_intent", token: "valid-token" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.balanceAmount, 300);
  assert.equal(res._body.paymentAmount, 300);
  assert.equal(stripeCreateCalls.length, 1);
  assert.equal(stripeCreateCalls[0].automatic_payment_methods?.enabled, true);
  assert.equal(stripeCreateCalls[0].metadata.payment_type, "rental_balance");
});

test("create_balance_payment_intent marks partial payments as partial_balance while keeping wallet-ready auto methods", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_manage_booking";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_manage_booking";

  const bookingRow = {
    booking_ref: "bk-fallback-001",
    vehicle_id: "camry",
    category: "car",
    status: "active_rental",
    total_price: 450,
    deposit_paid: 150,
    remaining_balance: 300,
    customer_name: "Partial Wallet",
    customer_email: "partial@example.com",
    customer_phone: "+13105550002",
    pickup_date: "2026-08-10",
    return_date: "2026-08-15",
  };

  supabaseClient = {
    from(table) {
      assert.equal(table, "bookings");
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          return makeQueryResult(bookingRow);
        },
      };
    },
  };

  const res = makeRes();
  await handler(makeReq({
    action: "create_balance_payment_intent",
    token: "valid-token",
    payment_amount: 125,
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.paymentAmount, 125);
  assert.equal(res._body.isPartialPayment, true);
  assert.equal(stripeCreateCalls.length, 1);
  assert.equal(stripeCreateCalls[0].automatic_payment_methods?.enabled, true);
  assert.equal(stripeCreateCalls[0].metadata.payment_type, "partial_balance");
});

test("create_balance_payment_intent blocks partial payments for non-VIP clients", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_manage_booking";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_manage_booking";

  const bookingRow = {
    booking_ref: "bk-fallback-001",
    vehicle_id: "camry",
    category: "car",
    status: "active_rental",
    total_price: 450,
    deposit_paid: 150,
    remaining_balance: 300,
    customer_name: "Standard Client",
    customer_email: "standard@example.com",
    customer_phone: "+13105550009",
    pickup_date: "2026-08-10",
    return_date: "2026-08-15",
  };

  supabaseClient = {
    from(table) {
      if (table === "customers") {
        return {
          select() { return this; },
          ilike() { return this; },
          order() { return this; },
          limit() {
            return Promise.resolve(makeQueryResult([
              {
                email: "standard@example.com",
                total_profit: 200,
                total_bookings: 5,
                risk_flag: "low",
                flagged: false,
                banned: false,
                no_show_count: 0,
              },
            ]));
          },
        };
      }
      assert.equal(table, "bookings");
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          return makeQueryResult(bookingRow);
        },
      };
    },
  };

  const res = makeRes();
  await handler(makeReq({
    action: "create_balance_payment_intent",
    token: "valid-token",
    payment_amount: 125,
  }), res);

  assert.equal(res._status, 403);
  assert.equal(res._body.error, "Partial balance payments are only available to VIP clients.");
  assert.equal(stripeCreateCalls.length, 0);
});

test("create_balance_payment_intent allows overdue rentals to pay remaining balance", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_manage_booking";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_manage_booking";

  const bookingRow = {
    booking_ref: "bk-fallback-001",
    vehicle_id: "camry",
    category: "car",
    status: "overdue",
    total_price: 520,
    deposit_paid: 220,
    remaining_balance: 300,
    customer_name: "Overdue Renter",
    customer_email: "overdue@example.com",
    customer_phone: "+13105550003",
    pickup_date: "2026-08-10",
    return_date: "2026-08-15",
  };

  supabaseClient = {
    from(table) {
      assert.equal(table, "bookings");
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          return makeQueryResult(bookingRow);
        },
      };
    },
  };

  const res = makeRes();
  await handler(makeReq({ action: "create_balance_payment_intent", token: "valid-token" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.paymentAmount, 300);
  assert.equal(stripeCreateCalls.length, 1);
  assert.equal(stripeCreateCalls[0].metadata.payment_type, "rental_balance");
});

test("apply_change omits protection-plan columns when booking read used legacy select fallback", async () => {
  const bookingRow = {
    id: 9,
    booking_ref: "bk-fallback-001",
    vehicle_id: "camry",
    pickup_date: "2026-05-20",
    return_date: "2026-05-24",
    pickup_time: "10:00 AM",
    return_time: "10:00 AM",
    status: "reserved",
    payment_status: "partial",
    total_price: 275,
    deposit_paid: 100,
    remaining_balance: 175,
    change_count: 0,
    customer_name: "Test Renter",
    customer_email: "test@example.com",
    customer_phone: "3105550100",
    created_at: "2026-05-15T00:00:00.000Z",
  };

  const bookingUpdates = [];
  supabaseClient = {
    from(table) {
      if (table === "payment_plans") {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          order() { return this; },
          limit() { return Promise.resolve(makeQueryResult([])); },
        };
      }
      if (table === "vehicle_pricing") {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() {
            return Promise.resolve(makeQueryResult([
              { daily_price: 55, weekly_price: 350, biweekly_price: 650, monthly_price: 1300 },
            ]));
          },
        };
      }
      if (table === "blocked_dates") {
        const ctx = { mode: "select", eqCount: 0 };
        return {
          select() {
            ctx.mode = "select";
            ctx.eqCount = 0;
            return this;
          },
          update() {
            ctx.mode = "update";
            return this;
          },
          eq() {
            if (ctx.mode === "update") return Promise.resolve(makeQueryResult(null));
            ctx.eqCount += 1;
            if (ctx.eqCount >= 3) return Promise.resolve(makeQueryResult([]));
            return this;
          },
        };
      }
      assert.equal(table, "bookings");
      const ctx = { mode: "select", selectValue: "" };
      return {
        select(value) {
          ctx.mode = "select";
          ctx.selectValue = value;
          return this;
        },
        update(payload) {
          ctx.mode = "update";
          ctx.payload = payload;
          return this;
        },
        eq(column, value) {
          assert.equal(column, "booking_ref");
          assert.equal(value, "bk-fallback-001");
          if (ctx.mode === "update") {
            bookingUpdates.push(ctx.payload);
            return Promise.resolve(makeQueryResult(null));
          }
          return this;
        },
        async maybeSingle() {
          if (ctx.selectValue.includes("pending_change")) {
            return makeQueryResult(null, {
              code: "PGRST204",
              message: "Could not find the 'has_protection_plan' column of 'bookings' in the schema cache",
            });
          }
          return makeQueryResult(bookingRow);
        },
      };
    },
  };

  const res = makeRes();
  await handler(makeReq({
    action: "apply_change",
    token: "valid-token",
    newPickupDate: "2026-05-21",
    newReturnDate: "2026-05-25",
    newVehicleId: "camry",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(bookingUpdates.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(bookingUpdates[0], "has_protection_plan"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(bookingUpdates[0], "protection_plan_tier"), false);
});
