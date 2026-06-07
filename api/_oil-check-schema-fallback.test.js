import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_SECRET = "admin-secret";
process.env.CRON_SECRET = "cron-secret";

const sentSms = [];
const oilState = {
  bookingsRows: [],
  bookingsUpdatePayloads: [],
  vehicleStateRows: [],
  vehicleStateError: null,
  vehicleRows: [],
  tripsRows: [],
};

const bouncieState = {
  trackedVehicles: [],
  vehicleStateUpsertError: null,
  vehicleMileageUpdates: [],
  bouncieVehicles: [],
};

function makeJsonRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(payload) { this._body = payload; return this; },
    send(payload) { this._body = payload; return this; },
  };
}

function makeOilCheckClient() {
  return {
    from(table) {
      if (table === "bookings") {
        return {
          select() { return this; },
          in() { return this; },
          not() { return Promise.resolve({ data: oilState.bookingsRows, error: null }); },
          update(payload) {
            return {
              eq() {
                oilState.bookingsUpdatePayloads.push(payload);
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }

      if (table === "vehicle_state") {
        return {
          select() { return this; },
          in() { return Promise.resolve({ data: oilState.vehicleStateRows, error: oilState.vehicleStateError }); },
        };
      }

      if (table === "vehicles") {
        return {
          select() { return this; },
          in() { return Promise.resolve({ data: oilState.vehicleRows, error: null }); },
        };
      }

      if (table === "trips") {
        return {
          select() { return this; },
          in() { return this; },
          is() { return Promise.resolve({ data: oilState.tripsRows, error: null }); },
        };
      }

      if (table === "sms_logs") {
        return {
          upsert() { return { select() { return Promise.resolve({ data: [{ id: 1 }], error: null }); } }; },
          insert() { return Promise.resolve({ data: null, error: null }); },
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        };
      }

      throw new Error(`Unexpected table in oil-check test: ${table}`);
    },
  };
}

function makeBouncieClient() {
  return {
    from(table) {
      if (table === "vehicles") {
        return {
          select() { return this; },
          or() { return Promise.resolve({ data: bouncieState.trackedVehicles, error: null }); },
          update(payload) {
            return {
              eq(column, value) {
                bouncieState.vehicleMileageUpdates.push({ column, value, payload });
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }

      if (table === "vehicle_state") {
        return {
          upsert() { return Promise.resolve({ data: null, error: bouncieState.vehicleStateUpsertError }); },
        };
      }

      throw new Error(`Unexpected table in bouncie test: ${table}`);
    },
  };
}

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => currentSupabaseClient,
  },
});

mock.module("./_textmagic.js", {
  namedExports: {
    sendSms: async (phone, message) => {
      sentSms.push({ phone, message });
      return true;
    },
  },
});

mock.module("./_time.js", {
  namedExports: {
    laHour: () => 10,
    isoDateInLA: () => "2026-05-18",
  },
});

mock.module("./_rental-state.js", {
  namedExports: {
    getRentalState: async () => ({ end_datetime: null, minutesToReturn: null }),
  },
});

mock.module("./_sms-priority.js", {
  namedExports: {
    getSmsPriority: () => "important",
  },
});

mock.module("./_sms-scoring.js", {
  namedExports: {
    computeSmsScoreWithBreakdown: () => ({ score: 1, breakdown: { test: 1 } }),
    computeEffectiveThreshold: () => 0,
    isSuppressedByProximity: () => false,
    fetchRecentSmsLogs: async () => [],
    buildSmsContext: () => ({}),
  },
});

mock.module("./_error-helpers.js", {
  namedExports: {
    isSchemaError: (err) => {
      const raw = `${err?.code || ""} ${err?.message || ""}`;
      return /schema cache|42P01|PGRST204|relation .* does not exist/i.test(raw);
    },
  },
});

// Return the hard-coded default (500) so tests exercise the cron logic without
// a live Supabase connection.  Individual tests that need a custom value can
// override `settingsState.milesInterval` before calling the handler.
const settingsState = { milesInterval: 500, daysSinceCheck: Number.MAX_SAFE_INTEGER };

mock.module("./_settings.js", {
  namedExports: {
    loadNumericSetting: async (key, defaultVal) => {
      if (key === "oil_check_miles_interval") return settingsState.milesInterval;
      if (key === "oil_check_days_since_check") return settingsState.daysSinceCheck;
      return defaultVal;
    },
  },
});

mock.module("./_bouncie.js", {
  namedExports: {
    getBouncieVehicles: async () => bouncieState.bouncieVehicles,
  },
});

let currentSupabaseClient = null;

const { default: oilCheckHandler } = await import("./oil-check-cron.js");
const { default: bouncieSyncHandler } = await import("./bouncie-sync-cron.js");

beforeEach(() => {
  sentSms.length = 0;
  currentSupabaseClient = null;
  settingsState.milesInterval = 500;
  settingsState.daysSinceCheck = Number.MAX_SAFE_INTEGER;

  oilState.bookingsRows = [];
  oilState.bookingsUpdatePayloads = [];
  oilState.vehicleStateRows = [];
  oilState.vehicleStateError = null;
  oilState.vehicleRows = [];
  oilState.tripsRows = [];

  bouncieState.trackedVehicles = [];
  bouncieState.vehicleStateUpsertError = null;
  bouncieState.vehicleMileageUpdates = [];
  bouncieState.bouncieVehicles = [];
});

test("oil-check-cron falls back to bookings and vehicles mileage when vehicle_state is missing", async () => {
  currentSupabaseClient = makeOilCheckClient();
  oilState.bookingsRows = [{
    id: "booking-1",
    booking_ref: "bk_123",
    vehicle_id: "camry",
    customer_phone: "+15555550123",
    pickup_date: "2026-05-10T00:00:00.000Z",
    return_date: "2026-05-20T00:00:00.000Z",
    return_time: "10:00",
    last_oil_check_at: null,
    oil_check_required: false,
    oil_check_last_request: null,
    oil_check_missed_count: 0,
  }];
  oilState.vehicleStateError = {
    code: "PGRST204",
    message: "Could not find the table 'public.vehicle_state' in the schema cache",
  };
  oilState.vehicleRows = [{
    vehicle_id: "camry",
    mileage: 18250,
    last_oil_change_mileage: 18000,
  }];

  const res = makeJsonRes();
  await oilCheckHandler({ method: "GET", headers: {} }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.triggered, 1);
  assert.equal(sentSms.length, 1);
  assert.match(sentSms[0].message, /Oil check required/i);
  assert.equal(oilState.bookingsUpdatePayloads.length, 1);
  assert.equal(oilState.bookingsUpdatePayloads[0].oil_check_required, true);
});

test("bouncie-sync-cron falls back to vehicles.mileage when vehicle_state is missing", async () => {
  currentSupabaseClient = makeBouncieClient();
  bouncieState.trackedVehicles = [{
    vehicle_id: "camry",
    bouncie_device_id: "imei-1",
    data: {},
  }];
  bouncieState.vehicleStateUpsertError = {
    code: "42P01",
    message: 'relation "vehicle_state" does not exist',
  };
  bouncieState.bouncieVehicles = [{
    imei: "imei-1",
    stats: { odometer: 22222 },
  }];

  const res = makeJsonRes();
  await bouncieSyncHandler({ method: "GET", headers: {} }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.synced_count, 1);
  assert.equal(res._body.fallback_to_vehicle_mileage, true);
  assert.equal(bouncieState.vehicleMileageUpdates.length, 1);
  assert.deepEqual(bouncieState.vehicleMileageUpdates[0], {
    column: "vehicle_id",
    value: "camry",
    payload: { mileage: 22222 },
  });
});

test("oil-check-cron sends an oil-check SMS once mileage since last check reaches 500 miles", async () => {
  currentSupabaseClient = makeOilCheckClient();
  oilState.bookingsRows = [{
    id: "booking-2",
    booking_ref: "bk_500",
    vehicle_id: "camry2013",
    customer_phone: "+15555550124",
    pickup_date: "2026-05-10T00:00:00.000Z",
    return_date: "2026-05-20T00:00:00.000Z",
    return_time: "10:00",
    last_oil_check_at: "2026-05-16T00:00:00.000Z",
    oil_check_required: false,
    oil_check_last_request: null,
    oil_check_missed_count: 0,
  }];
  oilState.vehicleStateRows = [{
    vehicle_id: "camry2013",
    last_oil_check_at: "2026-05-16T00:00:00.000Z",
    last_oil_check_mileage: 10000,
    current_mileage: 10500,
  }];
  oilState.vehicleRows = [{
    vehicle_id: "camry2013",
    mileage: 10500,
    last_oil_change_mileage: 10250,
  }];

  const res = makeJsonRes();
  await oilCheckHandler({ method: "GET", headers: {} }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.triggered, 1);
  assert.equal(sentSms.length, 1);
  assert.equal(oilState.bookingsUpdatePayloads.length, 1);
  assert.equal(oilState.bookingsUpdatePayloads[0].oil_check_required, true);
});

test("oil-check-cron does not send an oil-check SMS before 500 miles since last check", async () => {
  currentSupabaseClient = makeOilCheckClient();
  oilState.bookingsRows = [{
    id: "booking-3",
    booking_ref: "bk_499",
    vehicle_id: "future-car",
    customer_phone: "+15555550125",
    pickup_date: "2026-05-10T00:00:00.000Z",
    return_date: "2026-05-20T00:00:00.000Z",
    return_time: "10:00",
    last_oil_check_at: "2026-05-16T00:00:00.000Z",
    oil_check_required: false,
    oil_check_last_request: null,
    oil_check_missed_count: 0,
  }];
  oilState.vehicleStateRows = [{
    vehicle_id: "future-car",
    last_oil_check_at: "2026-05-16T00:00:00.000Z",
    last_oil_check_mileage: 20000,
    current_mileage: 20499,
  }];
  oilState.vehicleRows = [{
    vehicle_id: "future-car",
    mileage: 20499,
    last_oil_change_mileage: 20250,
  }];

  const res = makeJsonRes();
  await oilCheckHandler({ method: "GET", headers: {} }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.triggered, 0);
  assert.equal(sentSms.length, 0);
  assert.equal(oilState.bookingsUpdatePayloads.length, 0);
});

test("oil-check-cron respects admin-configured interval — e.g. 300 miles triggers earlier", async () => {
  settingsState.milesInterval = 300;
  currentSupabaseClient = makeOilCheckClient();
  oilState.bookingsRows = [{
    id: "booking-4",
    booking_ref: "bk_admin_300",
    vehicle_id: "camry",
    customer_phone: "+15555550126",
    pickup_date: "2026-05-10T00:00:00.000Z",
    return_date: "2026-05-20T00:00:00.000Z",
    return_time: "10:00",
    last_oil_check_at: "2026-05-16T00:00:00.000Z",
    oil_check_required: false,
    oil_check_last_request: null,
    oil_check_missed_count: 0,
  }];
  // 350 miles since last check — would NOT trigger at the default 500-mile
  // threshold but SHOULD trigger when the admin sets it to 300.
  oilState.vehicleStateRows = [{
    vehicle_id: "camry",
    last_oil_check_at: "2026-05-16T00:00:00.000Z",
    last_oil_check_mileage: 30000,
    current_mileage: 30350,
  }];
  oilState.vehicleRows = [{
    vehicle_id: "camry",
    mileage: 30350,
    last_oil_change_mileage: 30250,
  }];

  const res = makeJsonRes();
  await oilCheckHandler({ method: "GET", headers: {} }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.triggered, 1);
  assert.equal(sentSms.length, 1);
});

test("oil-check-cron respects admin-configured interval — 350 miles does NOT trigger at default 500", async () => {
  // settingsState.milesInterval is reset to 500 in beforeEach
  currentSupabaseClient = makeOilCheckClient();
  oilState.bookingsRows = [{
    id: "booking-5",
    booking_ref: "bk_admin_default",
    vehicle_id: "camry",
    customer_phone: "+15555550127",
    pickup_date: "2026-05-10T00:00:00.000Z",
    return_date: "2026-05-20T00:00:00.000Z",
    return_time: "10:00",
    last_oil_check_at: "2026-05-16T00:00:00.000Z",
    oil_check_required: false,
    oil_check_last_request: null,
    oil_check_missed_count: 0,
  }];
  oilState.vehicleStateRows = [{
    vehicle_id: "camry",
    last_oil_check_at: "2026-05-16T00:00:00.000Z",
    last_oil_check_mileage: 30000,
    current_mileage: 30350,
  }];
  oilState.vehicleRows = [{
    vehicle_id: "camry",
    mileage: 30350,
    last_oil_change_mileage: 30250,
  }];

  const res = makeJsonRes();
  await oilCheckHandler({ method: "GET", headers: {} }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.triggered, 0);
  assert.equal(sentSms.length, 0);
});
