// api/_scheduled-reminders.test.js
// Unit tests for processAutoCompletions — the scheduled-reminders function
// that automatically transitions active_rental bookings to completed_rental
// once they are past their scheduled return time by AUTO_COMPLETE_HOURS (4h).
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment ─────────────────────────────────────────────────────────────
process.env.GITHUB_TOKEN       = "test-github-token";
process.env.GITHUB_REPO        = "kysboadi-afk/SLY-RIDES";

// ─── Mock state ──────────────────────────────────────────────────────────────
const updatedBookings = [];  // records calls to updateBooking
const customerCalls   = [];  // records calls to autoUpsertCustomer
const bookingCalls    = [];  // records calls to autoUpsertBooking
const retryApplies    = [];  // records apply callbacks from updateJsonFileWithRetry
const smsCalls        = [];  // records outbound SMS calls

// ─── Mocks ───────────────────────────────────────────────────────────────────

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings:   async () => ({ data: {}, sha: "sha1" }),
    saveBookings:   async () => {},
    normalizePhone: (phone) => {
      if (!phone) return phone;
      if (/^\+\d{7,15}$/.test(phone)) return phone;
      const digits = phone.replace(/\D/g, "");
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
      return phone;
    },
    updateBooking:  async (vehicleId, id, updates) => {
      updatedBookings.push({ vehicleId, id, updates });
      return true;
    },
  },
});

mock.module("./_booking-automation.js", {
  namedExports: {
    autoUpsertCustomer:          async (b, countStats) => { customerCalls.push({ ...b, countStats }); },
    autoUpsertBooking:           async (b)             => { bookingCalls.push({ ...b }); },
    autoCreateRevenueRecord:     async () => {},
    autoCreateBlockedDate:       async () => {},
    autoActivateIfPickupArrived: async () => false,
  },
});

mock.module("./_github-retry.js", {
  namedExports: {
    updateJsonFileWithRetry: async ({ load, apply, save, message }) => {
      const { data, sha } = await load();
      apply(data);
      retryApplies.push({ message });
      await save(data, sha, message);
    },
  },
});

// Mock everything else that scheduled-reminders.js imports
mock.module("./_textmagic.js", {
  namedExports: {
    sendSms: async (phone, body) => {
      smsCalls.push({ phone, body });
    },
  },
});
mock.module("./_contacts.js", {
  namedExports: { upsertContact: async () => {} },
});
mock.module("./_pricing.js", {
  namedExports: {
    LATE_FEE_BASE: 25,
  },
});

mock.module("./_settings.js", {
  namedExports: { loadBooleanSetting: async () => true },
});

mock.module("./_sms-templates.js", {
  namedExports: {
    render: (t) => t,
    DEFAULT_LOCATION:                "Los Angeles, CA",
    UNPAID_REMINDER_24H:             "",
    UNPAID_REMINDER_2H:              "",
    UNPAID_REMINDER_FINAL:           "",
    PICKUP_REMINDER_24H:             "",
    BOOKING_ONBOARDING:              "",
    EXTENSION_EDUCATION:             "",
    PAYMENT_EDUCATION:               "",
    RETURN_REMINDER_24H:             "",
    RETURN_EXPECTATIONS:             "",
    ACTIVE_RENTAL_1H_BEFORE_END:     "",
    ACTIVE_RENTAL_MID:               "",
    LATE_GRACE_STARTED:              "",
    LATE_ESCALATION:                 "",
    PAYMENT_FAILED_BALANCE:          "",
    LATE_WARNING_30MIN:              "",
    LATE_AT_RETURN_TIME:             "",
    LATE_GRACE_EXPIRED:              "",
    LATE_FEE_APPLIED:                "",
    POST_RENTAL_THANK_YOU:           "",
    RETENTION_DAY_7:                 "",
    BOOKING_CONFIRMED:               "",
    EXTEND_UNAVAILABLE:              "",
    EXTEND_LIMITED:                  "",
    EXTEND_CONFIRMED:                "",
    BALANCE_DUE_REMINDER:            "",
    BALANCE_OVERDUE:                 "",
    BALANCE_OVERDUE_30:              "",
    BALANCE_OVERDUE_60:              "",
  },
});

// Stub the stripe-webhook pipeline functions that scheduled-reminders now imports
// for its auto-repair path.  Tests in this file only exercise processAutoCompletions
// which never calls these functions, so plain no-ops are sufficient.
mock.module("./stripe-webhook.js", {
  namedExports: {
    saveWebhookBookingRecord:      async () => {},
    blockBookedDates:              async () => {},
    markVehicleUnavailable:        async () => {},
    sendWebhookNotificationEmails: async () => {},
    mapVehicleId:                  (meta = {}) => meta.vehicle_id || "camry",
  },
});

// Stub Supabase so sms_logs queries are no-ops in tests.
// testSbClient defaults to null → isSmsLogged returns false → smsSentAt gates behaviour.
// Individual tests may set testSbClient to a mock object to exercise the live
// status-check path in processActiveRentals' late-fee block.
let testSbClient = null;
mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => testSbClient,
  },
});

let testRentalStateResolver = null;
let rentalStateCallCount = 0;
mock.module("./_rental-state.js", {
  namedExports: {
    getRentalState: async (_sb, bookingRef) => {
      rentalStateCallCount += 1;
      if (typeof testRentalStateResolver === "function") {
        return testRentalStateResolver({ bookingRef, call: rentalStateCallCount });
      }
      return {
        endDate: "",
        returnTime: "10:00",
        end_datetime: new Date(NaN),
        minutesToReturn: null,
        isActive: false,
      };
    },
  },
});

// GitHub API stubs (for booked-dates and fleet-status reads/writes)
global.fetch = async (url, opts) => {
  try {
    const parsed = new URL(typeof url === "string" ? url : String(url));
    if (parsed.hostname === "api.github.com") {
      // Track PUT calls so tests can assert on fleet-status writes
      if (opts && opts.method === "PUT") {
        retryApplies; // already tracked via updateJsonFileWithRetry mock
      }
      return {
        ok: true,
        json: async () => ({
          content: Buffer.from(JSON.stringify({})).toString("base64"),
          sha: "sha1",
        }),
        text: async () => "",
      };
    }
  } catch { /* not a valid URL — fall through */ }
  return { ok: false, text: async () => "not found" };
};

const {
  processAutoCompletions,
  processActiveRentals,
  processPaidBookings,
  processOnboardingCatchup,
  loadBookingsFromSupabase,
  processCompleted,
} = await import("./scheduled-reminders.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function reset() {
  updatedBookings.length = 0;
  customerCalls.length   = 0;
  bookingCalls.length    = 0;
  retryApplies.length    = 0;
  smsCalls.length        = 0;
  testSbClient           = null;  // restore null Supabase between tests
  testRentalStateResolver = null;
  rentalStateCallCount = 0;
}

/** Returns a Date that is `hoursAgo` hours before `now`. */
function hoursAgo(now, hoursAgo) {
  return new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
}

/** Formats a Date as YYYY-MM-DD. */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Formats a Date as "H:MM AM/PM". */
function fmtTime(d) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function makeBooking(overrides = {}) {
  return {
    bookingId:  "bk-test-001",
    vehicleId:  "camry",
    name:       "Test Renter",
    phone:      "+13105550001",
    email:      "test@example.com",
    status:     "active_rental",
    pickupDate: "2026-03-20",
    pickupTime: "10:00 AM",
    returnDate: "2026-03-22",
    returnTime: "10:00 AM",
    amountPaid: 150,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

test("processAutoCompletions: does not touch bookings whose return time has not passed", async () => {
  reset();
  const now = new Date("2026-03-22T09:00:00-07:00"); // before 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "No booking should be auto-completed");
});

test("processAutoCompletions: does not touch bookings that are only 1 hour overdue", async () => {
  reset();
  const now = new Date("2026-03-22T11:00:00-07:00"); // 1h past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "Not yet 4 hours overdue — should not auto-complete");
});

test("processAutoCompletions: does not touch bookings that are 23.9 hours overdue", async () => {
  reset();
  const now = new Date("2026-03-23T09:54:00-07:00"); // 23h54m past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "23.9 hours overdue — still below 24h threshold");
});

test("processAutoCompletions: skips auto-complete when extension payment is pending", async () => {
  reset();
  const now = new Date("2026-03-23T11:05:00-07:00"); // 25h past return
  const allBookings = {
    camry: [makeBooking({
      extendPending: true,
      extensionPendingPayment: {
        status: "pending",
        requestedReturnDate: "2026-03-24",
      },
      extensionRequestStatus: "pending_payment",
    })],
  };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "Pending extension-payment holds must prevent auto-complete");
  assert.equal(customerCalls.length, 0, "No completion side effects while extension payment is pending");
  assert.equal(bookingCalls.length, 0, "No completion sync while extension payment is pending");
});

test("processAutoCompletions: respects 24-hour return times with seconds", async () => {
  reset();
  const now = new Date("2026-03-22T04:30:00-07:00"); // before 10:00:00 return
  const allBookings = { camry: [makeBooking({ returnTime: "10:00:00" })] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "HH:MM:SS return times must not default to midnight");
});

test("processAutoCompletions: auto-completes booking that is 24+ hours past return time", async () => {
  reset();
  const now = new Date("2026-03-23T10:05:00-07:00"); // 24h5m past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 1, "Booking should be auto-completed");
  const update = updatedBookings[0];
  assert.equal(update.vehicleId, "camry");
  assert.equal(update.id, "bk-test-001");
  assert.equal(update.updates.status, "completed_rental");
  assert.ok(update.updates.completedAt, "completedAt must be set");
  assert.ok(update.updates.updatedAt, "updatedAt must be set");
});

test("processAutoCompletions: sets completedAt to now.toISOString()", async () => {
  reset();
  const now = new Date("2026-03-23T11:00:00-07:00"); // 25h past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings[0].updates.completedAt, now.toISOString());
});

test("processAutoCompletions: calls autoUpsertCustomer with countStats=true", async () => {
  reset();
  const now = new Date("2026-03-23T10:05:00-07:00"); // 24h5m past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(customerCalls.length, 1);
  assert.equal(customerCalls[0].countStats, true, "countStats must be true to increment totals");
});

test("processAutoCompletions: calls autoUpsertBooking", async () => {
  reset();
  const now = new Date("2026-03-23T10:05:00-07:00"); // 24h5m past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(bookingCalls.length, 1);
  assert.equal(bookingCalls[0].status, "completed_rental");
});

test("processAutoCompletions: skips already-completed bookings", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ status: "completed_rental", completedAt: "2026-03-22T12:00:00.000Z" })],
  };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "Already completed bookings must be skipped");
});

test("processAutoCompletions: skips cancelled bookings", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00-07:00");
  const allBookings = { camry: [makeBooking({ status: "cancelled_rental" })] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0);
});

test("processAutoCompletions: removes booking from booked-dates.json", async () => {
  reset();
  const now = new Date("2026-03-23T10:05:00-07:00"); // 24h5m past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  const unblockCall = retryApplies.find((c) => c.message && c.message.includes("unblock"));
  assert.ok(unblockCall, "booked-dates.json unblock must be attempted");
});

test("processAutoCompletions: no-ops when GITHUB_TOKEN is absent", async () => {
  reset();
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;

  const now = new Date("2026-03-22T15:00:00-07:00");
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  process.env.GITHUB_TOKEN = saved;
  assert.equal(updatedBookings.length, 0, "Without GITHUB_TOKEN, nothing should be updated");
});

test("processAutoCompletions: availability is now bookings-driven — no fleet-status.json write needed", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00-07:00"); // 5h past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  // The booking status update to "completed_rental" is the availability signal —
  // fleet-status.json is no longer written.  markVehicleAvailable is a no-op.
  const restoreCall = retryApplies.find((c) => c.message && c.message.includes("mark") && c.message.includes("available"));
  assert.equal(restoreCall, undefined, "fleet-status.json must NOT be written — availability is now bookings-driven");
});

test("processAutoCompletions: does NOT restore fleet-status when another active_rental remains", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00-07:00");
  const allBookings = {
    camry: [
      makeBooking({ bookingId: "bk-001", returnDate: "2026-03-22", returnTime: "10:00 AM" }),
      makeBooking({ bookingId: "bk-002", status: "active_rental" }), // still active
    ],
  };

  await processAutoCompletions(allBookings, now);

  const restoreCall = retryApplies.find((c) => c.message && c.message.includes("mark") && c.message.includes("available"));
  assert.equal(restoreCall, undefined, "Must NOT write fleet-status.json — availability is now bookings-driven");
});

test("processAutoCompletions: fleet-status not written even when completing the only active_rental", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00-07:00");
  // One active_rental overdue, one completed_rental (already done)
  const allBookings = {
    camry: [
      makeBooking({ bookingId: "bk-current", status: "active_rental" }),
      makeBooking({ bookingId: "bk-old",     status: "completed_rental" }),
    ],
  };

  await processAutoCompletions(allBookings, now);

  // fleet-status.json is not involved — the booking status change drives availability
  const restoreCall = retryApplies.find((c) => c.message && c.message.includes("mark") && c.message.includes("available"));
  assert.equal(restoreCall, undefined, "fleet-status.json must NOT be written — availability is now bookings-driven");
});

test("processAutoCompletions: fleet-status not written independently per vehicle (no-op)", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00-07:00");
  const allBookings = {
    camry:     [makeBooking({ bookingId: "bk-camry",     vehicleId: "camry" })],
    camry2013: [makeBooking({ bookingId: "bk-c2013",     vehicleId: "camry2013" })],
  };

  await processAutoCompletions(allBookings, now);

  // Both completions drive availability via the bookings table, not fleet-status.json
  const restoreCalls = retryApplies.filter((c) => c.message && c.message.includes("mark") && c.message.includes("available"));
  assert.equal(restoreCalls.length, 0, "fleet-status.json must NOT be written for any vehicle");
});

test("processPaidBookings: sends pickup reminder when renter is not already active", async () => {
  reset();
  const now = new Date("2026-03-21T10:30:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      status: "booked_paid",
      pickupDate: "2026-03-22",
      pickupTime: "10:00 AM",
    })],
  };
  const sentMarks = [];

  await processPaidBookings(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "pickup_24h"), true);
  assert.equal(smsCalls.length, 1);
});

test("processPaidBookings: skips pickup reminder when renter already has an active rental", async () => {
  reset();
  const now = new Date("2026-03-21T10:30:00-07:00");
  const allBookings = {
    camry: [
      makeBooking({
        bookingId: "bk-booked",
        status: "booked_paid",
        pickupDate: "2026-03-22",
        pickupTime: "10:00 AM",
      }),
      makeBooking({
        bookingId: "bk-active",
        status: "active_rental",
        pickupDate: "2026-03-20",
        returnDate: "2026-03-23",
      }),
    ],
  };
  const sentMarks = [];

  await processPaidBookings(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "pickup_24h"), false);
  assert.equal(smsCalls.length, 0);
});

test("processPaidBookings: skips pickup reminder when phone matches after normalization", async () => {
  reset();
  const now = new Date("2026-03-21T10:30:00-07:00");
  const allBookings = {
    camry: [
      makeBooking({
        bookingId: "bk-booked-phone",
        status: "booked_paid",
        pickupDate: "2026-03-22",
        pickupTime: "10:00 AM",
        phone: "(310) 555-0001",
        email: "new@example.com",
      }),
      makeBooking({
        bookingId: "bk-active-phone",
        status: "active_rental",
        phone: "+13105550001",
        email: "other@example.com",
      }),
    ],
  };
  const sentMarks = [];

  await processPaidBookings(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "pickup_24h"), false);
  assert.equal(smsCalls.length, 0);
});

test("processPaidBookings: skips pickup reminder when email matches an active renter but phone differs", async () => {
  reset();
  const now = new Date("2026-03-21T10:30:00-07:00");
  const allBookings = {
    camry: [
      makeBooking({
        bookingId: "bk-booked-email",
        status: "booked_paid",
        pickupDate: "2026-03-22",
        pickupTime: "10:00 AM",
        phone: "+13105550099",
        email: "Anthony@example.com",
      }),
      makeBooking({
        bookingId: "bk-active-email",
        status: "active_rental",
        phone: "+13105550001",
        email: " anthony@example.com ",
      }),
    ],
  };
  const sentMarks = [];

  await processPaidBookings(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "pickup_24h"), false);
  assert.equal(smsCalls.length, 0);
});

test("processPaidBookings: skips pickup reminder when renter already has an overdue rental on another vehicle", async () => {
  reset();
  const now = new Date("2026-03-21T10:30:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      bookingId: "bk-booked-overdue",
      status: "booked_paid",
      pickupDate: "2026-03-22",
      pickupTime: "10:00 AM",
      phone: "(310) 555-0001",
      email: "anthony@example.com",
    })],
    camry2013: [makeBooking({
      bookingId: "bk-overdue",
      vehicleId: "camry2013",
      status: "overdue",
      returnDate: "2026-03-20",
      phone: "+13105550001",
      email: "anthony@example.com",
    })],
  };
  const sentMarks = [];

  await processPaidBookings(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "pickup_24h"), false);
  assert.equal(smsCalls.length, 0);
});

test("processOnboardingCatchup: sends onboarding and extension education for recent active booking", async () => {
  reset();
  const now = new Date("2026-03-21T10:30:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      bookingId: "bk-catchup-1",
      status: "active_rental",
      pickupDate: "2026-03-21",
      returnDate: "2026-03-24",
      remainingBalance: 125,
      smsSentAt: { booking_confirmed: "2026-03-21T09:40:00-07:00" },
      createdAt: "2026-03-21T09:40:00-07:00",
    })],
  };
  const sentMarks = [];

  await processOnboardingCatchup(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "booking_onboarding"), true);
  assert.equal(sentMarks.some((m) => m.key === "extension_education"), true);
  assert.equal(sentMarks.some((m) => m.key === "payment_education"), false);
  assert.equal(smsCalls.length, 2);
});

test("processOnboardingCatchup: sends payment education day-after for non-prepaid booking", async () => {
  reset();
  const now = new Date("2026-03-22T07:30:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      bookingId: "bk-catchup-2",
      status: "active_rental",
      pickupDate: "2026-03-21",
      returnDate: "2026-03-25",
      remainingBalance: 90,
      smsSentAt: {
        booking_confirmed: "2026-03-21T08:00:00-07:00",
        booking_onboarding: "2026-03-21T08:05:00-07:00",
        extension_education: "2026-03-21T08:45:00-07:00",
      },
      createdAt: "2026-03-21T08:00:00-07:00",
    })],
  };
  const sentMarks = [];

  await processOnboardingCatchup(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "payment_education"), true);
  assert.equal(smsCalls.length, 1);
});

test("processOnboardingCatchup: suppresses prepaid, ended, and stale-window bookings", async () => {
  reset();
  const now = new Date("2026-03-22T10:00:00-07:00");
  const allBookings = {
    camry: [
      makeBooking({
        bookingId: "bk-catchup-prepaid",
        status: "active_rental",
        pickupDate: "2026-03-21",
        returnDate: "2026-03-25",
        remainingBalance: 0,
        smsSentAt: { booking_confirmed: "2026-03-21T08:00:00-07:00" },
        createdAt: "2026-03-21T08:00:00-07:00",
      }),
      makeBooking({
        bookingId: "bk-catchup-ended",
        status: "overdue",
        pickupDate: "2026-03-20",
        returnDate: "2026-03-21",
        returnTime: "8:00 AM",
        remainingBalance: 120,
        smsSentAt: { booking_confirmed: "2026-03-21T07:00:00-07:00" },
        createdAt: "2026-03-21T07:00:00-07:00",
      }),
      makeBooking({
        bookingId: "bk-catchup-stale",
        status: "active_rental",
        pickupDate: "2026-03-20",
        returnDate: "2026-03-25",
        remainingBalance: 120,
        smsSentAt: { booking_confirmed: "2026-03-20T06:00:00-07:00" },
        createdAt: "2026-03-20T06:00:00-07:00",
      }),
    ],
  };
  const sentMarks = [];

  await processOnboardingCatchup(allBookings, now, sentMarks);

  // Prepaid booking can still receive onboarding/extension catch-up, but not payment education.
  assert.equal(sentMarks.some((m) => m.id === "bk-catchup-prepaid" && m.key === "payment_education"), false);
  // Ended/overdue at/after return time should not get extension/payment education.
  assert.equal(sentMarks.some((m) => m.id === "bk-catchup-ended" && m.key === "extension_education"), false);
  assert.equal(sentMarks.some((m) => m.id === "bk-catchup-ended" && m.key === "payment_education"), false);
  // Stale beyond catch-up window should not be processed.
  assert.equal(sentMarks.some((m) => m.id === "bk-catchup-stale"), false);
});

test("processActiveRentals: sends ended at return_datetime", async () => {
  reset();
  const now = new Date("2026-06-15T08:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_at_return"), true, "ended should be sent at 08:00 for 08:00 return");
});

test("processActiveRentals: sends grace at return_datetime +30min", async () => {
  reset();
  // 8:00 AM return — cron fires at 8:30 AM (exactly at grace_end)
  const now = new Date("2026-06-15T08:30:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_grace_expired"), true, "grace should be sent at 08:30 for 08:00 return (grace_end = +30 min)");
});

test("processActiveRentals: sends late fee escalation at return_datetime +3h", async () => {
  reset();
  // 8:00 AM return — cron fires at 11:00 AM (exactly at reset_time = +3h)
  const now = new Date("2026-06-15T11:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_fee_pending"), true, "escalation flow should start at 11:00 for 08:00 return (reset_time = +3h)");
});

test("processActiveRentals: sends 30-min warning before return", async () => {
  reset();
  // 8:00 AM return — cron fires at 7:40 AM (20 min before, inside 15–30 min window)
  const now = new Date("2026-06-15T07:40:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_warning_30min"), true,
    "30-min warning should fire when minutesUntilReturn is between 15 and 30");
});

test("processActiveRentals: skips stale return SMS when schedule changes mid-run", async () => {
  reset();
  const now = new Date("2026-06-15T07:40:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  testSbClient = makeSbWithStatus("active_rental");
  testRentalStateResolver = ({ call }) => {
    if (call === 1) {
      return {
        endDate: "2026-06-15",
        returnTime: "08:00",
        end_datetime: new Date("2026-06-15T08:00:00-07:00"),
        minutesToReturn: 20,
        isActive: true,
      };
    }
    return {
      endDate: "2026-06-16",
      returnTime: "08:00",
      end_datetime: new Date("2026-06-16T08:00:00-07:00"),
      minutesToReturn: 1460,
      isActive: true,
    };
  };

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "late_warning_30min"),
    false,
    "stale 30-min return warning should be skipped after admin date change"
  );
  assert.equal(smsCalls.length, 0, "no stale return-time SMS should be sent");
});

test("processActiveRentals: does NOT send 30-min warning outside window", async () => {
  reset();
  // 8:00 AM return — cron fires at 7:00 AM (60 min before, outside 15–30 min window)
  const now = new Date("2026-06-15T07:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_warning_30min"), false,
    "30-min warning must NOT fire 60 min before return");
});

test("processActiveRentals: does NOT send 30-min warning when already sent (smsSentAt flag)", async () => {
  reset();
  const now = new Date("2026-06-15T07:40:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      returnDate: "2026-06-15",
      returnTime: "8:00 AM",
      smsSentAt:  { late_warning_30min: "2026-06-15T07:35:00.000Z" },
    })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_warning_30min"), false,
    "30-min warning must not be resent when smsSentAt flag is already set");
});

test("processActiveRentals: does not send mid-rental EXTEND invitation", async () => {
  reset();
  // Simulate cron running 6 hours before return — old active_mid trigger point
  const now = new Date("2026-06-15T02:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "active_mid"), false,
    "mid-rental EXTEND SMS must no longer be sent (removed to reduce noise)");
  assert.equal(smsCalls.length, 0, "No SMS should be sent 6 hours before return");
});

test("processActiveRentals: skips cancelled rentals even when return time window matches", async () => {
  reset();
  const now = new Date("2026-06-15T07:40:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      status: "cancelled_rental",
      returnDate: "2026-06-15",
      returnTime: "8:00 AM",
    })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.length, 0, "cancelled rentals must not emit active-rental reminder marks");
  assert.equal(smsCalls.length, 0, "cancelled rentals must not send SMS reminders");
});

test("processActiveRentals: skips completed rentals even when return time window matches", async () => {
  reset();
  const now = new Date("2026-06-15T07:40:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      status: "completed_rental",
      returnDate: "2026-06-15",
      returnTime: "8:00 AM",
    })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.length, 0, "completed rentals must not emit active-rental reminder marks");
  assert.equal(smsCalls.length, 0, "completed rentals must not send SMS reminders");
});

test("processActiveRentals: extension awareness — fires return-time SMS for new return_date after extension", async () => {
  reset();
  // Booking was extended: new returnDate is 2026-06-16 (one day later).
  // smsSentAt has late_at_return set from the OLD return date (2026-06-15),
  // but because the key is the same string it would normally block the send.
  // With sms_logs disabled (null Supabase) the smsSentAt flag still blocks —
  // but this test verifies that clearing smsSentAt (simulating a fresh booking
  // after extension) allows the new return-time SMS to fire correctly.
  const now = new Date("2026-06-16T08:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      returnDate: "2026-06-16",
      returnTime: "8:00 AM",
      // smsSentAt does NOT have late_at_return set (extension cleared it)
      smsSentAt:  {},
    })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_at_return"), true,
    "late_at_return should fire for the new return_date after extension");
});

// ─── Late fee critical safeguards ────────────────────────────────────────────

/**
 * Minimal Supabase stub that returns a fixed booking status for .maybeSingle()
 * and empty arrays for all other awaited queries.
 */
function makeSbWithStatus(status) {
  return {
    from() {
      return {
        select()      { return this; },
        eq()          { return this; },
        or()          { return this; },
        order()       { return this; },
        limit()       { return this; },
        update()      { return this; },
        async maybeSingle() { return { data: { status }, error: null }; },
        async then(resolve) { return resolve({ data: [], error: null }); },
      };
    },
  };
}

test("processActiveRentals: does NOT send late fee when booking is more than MAX_FEE_OVERDUE_HOURS past return", async () => {
  reset();
  // Return was 2026-06-15 08:00 AM PDT.  Now = 06-16 08:00 AM (24 h overdue).
  // MAX_FEE_OVERDUE_HOURS = 8, so this must be SKIPPED entirely.
  const now = new Date("2026-06-16T08:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "late_fee_pending"),
    false,
    "late fee must NOT fire when booking is 24 h overdue (stale active_rental)"
  );
  assert.equal(smsCalls.length, 0, "no SMS must be sent for a stale booking");
});

test("processActiveRentals: does NOT send late fee when Supabase says booking is completed_rental", async () => {
  reset();
  // Return was 2026-06-15 08:00 AM.  Now = 06-15 10:05 AM (2 h 5 min overdue).
  // Within the 8-hour window, but Supabase says completed_rental → skip.
  const now = new Date("2026-06-15T10:05:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  testSbClient = makeSbWithStatus("completed_rental");
  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "late_fee_pending"),
    false,
    "late fee must NOT fire when Supabase status is completed_rental"
  );
});

// ─── Extension reminder (1 h before return) ───────────────────────────────────

test("processActiveRentals: sends 1h-before-end extension invitation in 45–60 min window", async () => {
  reset();
  // 8:00 AM return — cron fires at 7:10 AM (50 min before, inside 45–60 min window)
  const now = new Date("2026-06-15T07:10:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "active_rental_1h_before_end"),
    true,
    "extension invitation should fire when ~50 min remain"
  );
  // The 30-min warning must NOT also fire in the same tick
  assert.equal(
    sentMarks.some((m) => m.key === "late_warning_30min"),
    false,
    "30-min warning must not fire simultaneously with 1h reminder"
  );
});

test("processActiveRentals: does NOT send 1h-before-end extension invitation too early", async () => {
  reset();
  // 8:00 AM return — cron fires at 6:30 AM (90 min before, outside 45–60 min window)
  const now = new Date("2026-06-15T06:30:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "active_rental_1h_before_end"),
    false,
    "extension invitation must NOT fire 90 min before return"
  );
});

test("processActiveRentals: does NOT send 1h-before-end when already sent (smsSentAt flag)", async () => {
  reset();
  const now = new Date("2026-06-15T07:10:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      returnDate: "2026-06-15",
      returnTime: "8:00 AM",
      smsSentAt:  { active_rental_1h_before_end: "2026-06-15T07:05:00.000Z" },
    })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "active_rental_1h_before_end"),
    false,
    "extension invitation must not be resent when smsSentAt flag is already set"
  );
});

// ─── Per-renter-per-run dedup ─────────────────────────────────────────────────

test("processActiveRentals: sends only one SMS when two active bookings share the same phone", async () => {
  reset();
  // Both bookings have the same phone and both return at 8:00 AM.
  // The first booking's return-time SMS fires; the second must be skipped.
  const now = new Date("2026-06-15T08:00:00-07:00");
  const allBookings = {
    camry: [
      makeBooking({ bookingId: "bk-001", phone: "+13105550001",
                    returnDate: "2026-06-15", returnTime: "8:00 AM" }),
      makeBooking({ bookingId: "bk-002", phone: "+13105550001",
                    returnDate: "2026-06-15", returnTime: "8:00 AM" }),
    ],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  // Only one late_at_return should be recorded (for the first booking)
  const returnMarks = sentMarks.filter((m) => m.key === "late_at_return");
  assert.equal(returnMarks.length, 1,
    "only one late_at_return SMS must be sent per phone per run");
  assert.equal(smsCalls.length, 1,
    "only one outbound SMS must be sent when two bookings share a phone");
});

// ─── loadBookingsFromSupabase smsSentAt dedup (anti-spam regression tests) ───

/**
 * Build a minimal Supabase stub for loadBookingsFromSupabase.
 * bookingRows  → what bookings.select() returns
 * smsLogRows   → what sms_logs.select() returns
 */
function makeLoadSbClient(bookingRows, smsLogRows = []) {
  return {
    from(table) {
      const self = {
        _filters: {},
        select(cols) { return self; },
        in(col, vals) { self._filters[col] = vals; return self; },
        eq(col, val) { self._filters[col] = val; return self; },
        gte(col, val) { return self; },
        order(col, opts) { return self; },
        limit(n) { return self; },
        schema() { return self; },
        // Terminal — resolve with the appropriate data set
        async then(resolve) {
          if (table === "sms_logs") return resolve({ data: smsLogRows, error: null });
          if (table === "bookings") return resolve({ data: bookingRows, error: null });
          return resolve({ data: [], error: null });
        },
      };
      return self;
    },
  };
}

test("loadBookingsFromSupabase: pre-populates smsSentAt for return-time keys matching current returnDate", async () => {
  reset();

  const bookingRow = {
    booking_ref:       "bk-dedup-001",
    vehicle_id:        "camry",
    customer_name:     "Test Renter",
    customer_email:    "test@example.com",
    customer_phone:    "+13105550001",
    renter_phone:      "+13105550001",
    pickup_date:       "2026-06-14",
    return_date:       "2026-06-15",
    pickup_time:       "10:00",
    return_time:       "08:00",
    status:            "active_rental",
    payment_intent_id: "pi_test",
    completed_at:      null,
    extension_count:   0,
    late_fee_status:   null,
    late_fee_amount:   null,
    balance_due:       0,
    balance_due_set_at: null,
    updated_at:        "2026-06-14T10:00:00Z",
    created_at:        "2026-06-14T09:00:00Z",
  };

  // sms_logs has a late_warning_30min row for the CURRENT return date
  const smsLogRow = {
    booking_id:          "bk-dedup-001",
    template_key:        "late_warning_30min",
    sent_at:             "2026-06-15T14:30:00Z",
    return_date_at_send: "2026-06-15",  // matches current returnDate
  };

  const sbClient = makeLoadSbClient([bookingRow], [smsLogRow]);
  const allBookings = await loadBookingsFromSupabase(sbClient);

  assert.ok(allBookings, "should return allBookings");
  const booking = (allBookings["camry"] || [])[0];
  assert.ok(booking, "booking should be present");
  assert.ok(
    booking.smsSentAt && booking.smsSentAt["late_warning_30min"],
    "smsSentAt should include late_warning_30min for current return date"
  );
});

test("loadBookingsFromSupabase: does NOT pre-populate smsSentAt for old return-date rows (extension-awareness)", async () => {
  reset();

  const bookingRow = {
    booking_ref:       "bk-ext-001",
    vehicle_id:        "camry",
    customer_name:     "Test Renter",
    customer_email:    "test@example.com",
    customer_phone:    "+13105550001",
    renter_phone:      "+13105550001",
    pickup_date:       "2026-06-14",
    return_date:       "2026-06-16",  // extended to June 16
    pickup_time:       "10:00",
    return_time:       "08:00",
    status:            "active_rental",
    payment_intent_id: "pi_test",
    completed_at:      null,
    extension_count:   1,
    late_fee_status:   null,
    late_fee_amount:   null,
    balance_due:       0,
    balance_due_set_at: null,
    updated_at:        "2026-06-15T10:00:00Z",
    created_at:        "2026-06-14T09:00:00Z",
  };

  // sms_logs has a late_at_return row from the OLD return date (2026-06-15)
  const oldDateSmsRow = {
    booking_id:          "bk-ext-001",
    template_key:        "late_at_return",
    sent_at:             "2026-06-15T15:00:00Z",
    return_date_at_send: "2026-06-15",  // OLD return date — should NOT block new-date send
  };

  const sbClient = makeLoadSbClient([bookingRow], [oldDateSmsRow]);
  const allBookings = await loadBookingsFromSupabase(sbClient);

  const booking = (allBookings["camry"] || [])[0];
  assert.ok(booking, "booking should be present");
  assert.ok(
    !booking.smsSentAt || !booking.smsSentAt["late_at_return"],
    "smsSentAt must NOT include late_at_return from the old return date (extension-awareness)"
  );
});


// ─── processCompleted: post_thank_you and retention_7d window tests ───────────

function makeCompletedBooking(overrides = {}) {
  return {
    bookingId:   "bk-completed-001",
    vehicleId:   "camry",
    name:        "Test Renter",
    phone:       "+13105550001",
    email:       "test@example.com",
    status:      "completed_rental",
    pickupDate:  "2026-06-10",
    pickupTime:  "10:00 AM",
    returnDate:  "2026-06-15",
    returnTime:  "10:00 AM",
    completedAt: null,
    amountPaid:  150,
    smsSentAt:   {},
    ...overrides,
  };
}

test("processCompleted: sends post_thank_you within 30 min of completion", async () => {
  reset();
  const now         = new Date("2026-06-15T17:10:00Z");
  const completedAt = new Date("2026-06-15T17:05:00Z"); // 5 min ago
  const allBookings = {
    camry: [makeCompletedBooking({ completedAt: completedAt.toISOString() })],
  };
  const sentMarks = [];

  await processCompleted(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "post_thank_you"),
    true,
    "post_thank_you should fire within 30 min of completion"
  );
});

test("processCompleted: sends post_thank_you for completed status within 30 min", async () => {
  reset();
  const now         = new Date("2026-06-15T17:10:00Z");
  const completedAt = new Date("2026-06-15T17:05:00Z");
  const allBookings = {
    camry: [makeCompletedBooking({
      status: "completed",
      completedAt: completedAt.toISOString(),
    })],
  };
  const sentMarks = [];

  await processCompleted(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "post_thank_you"),
    true,
    "post_thank_you should fire for completed status within 30 min of completion"
  );
});

test("processCompleted: does NOT send post_thank_you if 31 min have passed (window closed)", async () => {
  reset();
  const now         = new Date("2026-06-15T17:40:00Z");
  const completedAt = new Date("2026-06-15T17:05:00Z"); // 35 min ago — outside 30-min window
  const allBookings = {
    camry: [makeCompletedBooking({ completedAt: completedAt.toISOString() })],
  };
  const sentMarks = [];

  await processCompleted(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "post_thank_you"),
    false,
    "post_thank_you must NOT fire after 30-min window closes"
  );
});

test("processCompleted: does NOT resend post_thank_you when smsSentAt flag is set", async () => {
  reset();
  const now         = new Date("2026-06-15T17:10:00Z");
  const completedAt = new Date("2026-06-15T17:05:00Z");
  const allBookings = {
    camry: [makeCompletedBooking({
      completedAt: completedAt.toISOString(),
      smsSentAt:   { post_thank_you: completedAt.toISOString() },
    })],
  };
  const sentMarks = [];

  await processCompleted(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "post_thank_you"),
    false,
    "post_thank_you must not be resent when smsSentAt flag is set"
  );
});

test("processCompleted: sends retention_7d within 4 hours of 7-day mark", async () => {
  reset();
  // completedAt = 7 days + 1 hour ago → inside 4-hour window
  const now         = new Date("2026-06-22T11:00:00Z");
  const completedAt = new Date("2026-06-15T10:00:00Z"); // exactly 7 days + 1h ago
  const allBookings = {
    camry: [makeCompletedBooking({ completedAt: completedAt.toISOString() })],
  };
  const sentMarks = [];

  await processCompleted(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "retention_7d"),
    true,
    "retention_7d should fire 1h after the 7-day mark (inside 4-hour window)"
  );
});

test("processCompleted: does NOT send retention_7d before 7-day mark", async () => {
  reset();
  // completedAt = 6 days + 23 hours ago → just before the 7-day mark
  const now         = new Date("2026-06-22T09:00:00Z");
  const completedAt = new Date("2026-06-15T10:00:00Z"); // 6d23h ago
  const allBookings = {
    camry: [makeCompletedBooking({ completedAt: completedAt.toISOString() })],
  };
  const sentMarks = [];

  await processCompleted(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "retention_7d"),
    false,
    "retention_7d must NOT fire before 7-day mark"
  );
});

test("processCompleted: does NOT send retention_7d after 4-hour window closes", async () => {
  reset();
  // completedAt = 7 days + 5 hours ago → outside 4-hour window
  const now         = new Date("2026-06-22T15:00:00Z");
  const completedAt = new Date("2026-06-15T10:00:00Z"); // 7d+5h ago
  const allBookings = {
    camry: [makeCompletedBooking({ completedAt: completedAt.toISOString() })],
  };
  const sentMarks = [];

  await processCompleted(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "retention_7d"),
    false,
    "retention_7d must NOT fire after the 4-hour window closes"
  );
});

test("processCompleted: does NOT resend retention_7d when smsSentAt flag is set", async () => {
  reset();
  const now         = new Date("2026-06-22T11:00:00Z");
  const completedAt = new Date("2026-06-15T10:00:00Z"); // 7d+1h ago (inside window)
  const allBookings = {
    camry: [makeCompletedBooking({
      completedAt: completedAt.toISOString(),
      smsSentAt:   { retention_7d: "2026-06-22T10:30:00Z" },
    })],
  };
  const sentMarks = [];

  await processCompleted(allBookings, now, sentMarks);

  assert.equal(
    sentMarks.some((m) => m.key === "retention_7d"),
    false,
    "retention_7d must not be resent when smsSentAt flag is set"
  );
});
