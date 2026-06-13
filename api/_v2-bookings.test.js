// api/_v2-bookings.test.js
// End-to-end lifecycle tests for POST /api/v2-bookings.
//
// Validates:
//  1. Payment flow — deposit_paid / remaining_balance / payment_status computed correctly
//  2. Full booking lifecycle: create → approve (reserved) → activate (rented) → complete (available)
//  3. Double-booking prevention with datetime-aware conflict detection
//  4. Back-to-back same-day bookings are allowed
//  5. Cancelled bookings release the slot so new bookings are accepted
//  6. Creating a booking triggers: customer upsert, revenue record, blocked dates, Supabase sync
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.ADMIN_SECRET          = "test-admin-secret";
process.env.GITHUB_TOKEN          = "test-github-token";
process.env.TEXTMAGIC_USERNAME    = "test-tm-user";
process.env.TEXTMAGIC_API_KEY     = "test-tm-key";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

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

function makeReq(body, origin = "https://slycarrentals.com", extraHeaders = {}) {
  return { method: "POST", headers: { origin, ...extraHeaders }, body };
}

// ─── Shared mutable state ─────────────────────────────────────────────────────

// bookings.json in-memory store keyed by vehicleId
const bookingsStore = {};
// Automation call recorder
const automationCalls = { revenue: [], customer: [], booking: [], blocked: [], blockedSync: [], releaseBlocked: [] };
// SMS calls
const smsCalls = [];
const smsMockState = { shouldThrow: false, errorMessage: "TextMagic send failed" };
const paymentPlanProgressMockState = {
  value: {
    has_active_plan: false,
    remaining_balance: 0,
    overdue_amount: 0,
    next_due_date: null,
    remaining_installments: 0,
  },
};
const schemaErrorMockState = { forceFalse: false };
const sentEmails = [];
const emailMockState = { shouldThrow: false, errorMessage: "SMTP send failed" };
// Supabase mock — not used by these tests (automation is mocked out)
const supabaseMockState = { client: null };

// ─── Module mocks (must be declared before any import of the module) ──────────

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => supabaseMockState.client,
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings:    async () => ({ data: JSON.parse(JSON.stringify(bookingsStore)), sha: "sha1" }),
    saveBookings:    async (data) => { Object.assign(bookingsStore, JSON.parse(JSON.stringify(data))); },
    appendBooking:   async () => {},
    normalizePhone:  (p) => p,
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
    autoCreateRevenueRecord:        async (b) => { automationCalls.revenue.push({ ...b }); },
    autoUpsertCustomer:             async (b, s) => { automationCalls.customer.push({ ...b, countStats: s }); },
    autoUpsertBooking:              async (b) => { automationCalls.booking.push({ ...b }); },
    autoCreateBlockedDate:          async (vid, s, e, r) => { automationCalls.blocked.push({ vehicleId: vid, start: s, end: e, reason: r }); },
    extendBlockedDateForBooking:    async (vid, ref, d, t) => { automationCalls.blockedSync.push({ vehicleId: vid, bookingRef: ref, returnDate: d, returnTime: t }); },
    autoReleaseBlockedDateOnReturn: async (vid, ref) => { automationCalls.releaseBlocked.push({ vehicleId: vid, bookingRef: ref }); },
    writeAuditLog:                  async () => {},
    parseTime12h:            (t) => {
      if (!t) return null;
      const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
      if (!m) return null;
      let h = parseInt(m[1], 10);
      const mn = parseInt(m[2], 10);
      const s2 = m[3] ? parseInt(m[3], 10) : 0;
      const ap = (m[4] || "").toUpperCase();
      if (ap === "PM" && h !== 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
      return `${String(h).padStart(2,"0")}:${String(mn).padStart(2,"0")}:${String(s2).padStart(2,"0")}`;
    },
  },
});

// v2-bookings.js also calls blockBookedDates internally which hits GitHub —
// mock the availability check functions too
mock.module("./_availability.js", {
  namedExports: {
    hasOverlap:           (ranges, from, to) => ranges.some((r) => from <= r.to && r.from <= to),
    hasDateTimeOverlap:   (ranges, fd, td, ft, tt) => {
      // Use the real datetime logic for accurate conflict testing
      function parseDt(date, time) {
        if (!date) return NaN;
        const base = new Date(date + "T00:00:00");
        if (time) {
          const ampm = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
          if (ampm) {
            let h = parseInt(ampm[1], 10);
            const m = parseInt(ampm[2], 10);
            const p = ampm[3].toUpperCase();
            if (p === "PM" && h !== 12) h += 12;
            if (p === "AM" && h === 12) h = 0;
            base.setHours(h, m, 0, 0);
          }
        }
        return base.getTime();
      }
      const newStart = parseDt(fd, ft);
      const newEnd   = ft ? parseDt(td, tt) : (() => { const d = new Date(parseDt(td)); d.setDate(d.getDate() + 1); return d.getTime(); })();
      return ranges.some((r) => {
        const rStart = parseDt(r.from, r.fromTime);
        const rEnd   = r.toTime ? parseDt(r.to, r.toTime) : (() => { const d = new Date(parseDt(r.to)); d.setDate(d.getDate() + 1); return d.getTime(); })();
        return rStart < newEnd && rEnd > newStart;
      });
    },
    isDatesAvailable:     async () => true,
    isVehicleAvailable:   async () => true,
    fetchBookedDates:     async () => ({}),
    fetchFleetStatus:     async () => ({}),
    parseDateTimeMs:      (d) => new Date(d + "T00:00:00").getTime(),
  },
});

mock.module("./_textmagic.js", {
  namedExports: {
    sendSms: async (phone, body) => {
      smsCalls.push({ phone, body });
      if (smsMockState.shouldThrow) {
        throw new Error(smsMockState.errorMessage);
      }
      return { id: `tm-${smsCalls.length}` };
    },
  },
});

mock.module("./_payment-plan-reconcile.js", {
  namedExports: {
    computePaymentPlanProgress: async () => ({ ...paymentPlanProgressMockState.value }),
  },
});

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({
      sendMail: async (payload) => {
        sentEmails.push({ ...payload });
        if (emailMockState.shouldThrow) {
          throw new Error(emailMockState.errorMessage);
        }
      },
    }),
  },
});

mock.module("./_sms-templates.js", {
  namedExports: {
    render:           (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] || ""),
    DEFAULT_LOCATION: "Los Angeles, CA",
    BOOKING_CONFIRMED: "Your {vehicle} is confirmed, {customer_name}.",
    BOOKING_ONBOARDING: "Welcome to SLY RIDES, {customer_name}.",
    UNPAID_REMINDER_24H: "",
    UNPAID_REMINDER_2H:  "",
    UNPAID_REMINDER_FINAL: "",
    PICKUP_REMINDER_24H: "",
    PICKUP_REMINDER_2H: "",
    PICKUP_REMINDER_30MIN: "",
    ACTIVE_RENTAL_MID: "",
    ACTIVE_RENTAL_1H_BEFORE_END: "",
    ACTIVE_RENTAL_15MIN_BEFORE_END: "",
    LATE_WARNING_30MIN: "",
    LATE_AT_RETURN_TIME: "",
    LATE_GRACE_EXPIRED: "",
    LATE_FEE_APPLIED: "",
    POST_RENTAL_THANK_YOU: "",
    RETENTION_DAY_1: "",
    RETENTION_DAY_3: "",
    RETENTION_DAY_7: "",
    RETENTION_DAY_14: "",
    RETENTION_DAY_30: "",
  },
});

mock.module("./_error-helpers.js", {
  namedExports: {
    adminErrorMessage: (err) => err?.message || String(err),
    isSchemaError:     (err) => {
      if (schemaErrorMockState.forceFalse) return false;
      const code = err?.code ? String(err.code) : "";
      const msg = err?.message ? String(err.message) : "";
      return (
        code === "42P01" || code === "42703" ||
        code === "PGRST204" || code === "PGRST200" ||
        /relation .* does not exist/i.test(msg) ||
        /table .* (was )?not found/i.test(msg) ||
        /column .* does not exist/i.test(msg) ||
        /Could not find the .* in the schema cache/i.test(msg) ||
        /42P01|42703/.test(msg)
      );
    },
  },
});

// Mock _booking-pipeline.js so persistBooking stores the booking in the
// in-memory bookingsStore and populates automationCalls without hitting
// real Supabase or GitHub.  Mirrors booking pipeline behavior:
// revenue + customer only for paid bookings; blocked_dates only for paid bookings.
mock.module("./_booking-pipeline.js", {
  namedExports: {
    persistBooking: async (opts) => {
      const booking = { smsSentAt: {}, createdAt: new Date().toISOString(), ...opts };
      if (booking.status === "booked_paid") {
        automationCalls.revenue.push({ ...booking });
        automationCalls.customer.push({ ...booking, countStats: false });
      }
      automationCalls.booking.push({ ...booking });
      // Only paid/active bookings create blocked_dates entries.
      if (opts.pickupDate && opts.returnDate && booking.status === "booked_paid") {
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

// Stub out GitHub-based booked-dates blocking (v2-bookings.js internal blockBookedDates)
// by making fetch a no-op for GitHub Content API calls
global.fetch = async (url, opts) => {
  try {
    const parsed = new URL(typeof url === "string" ? url : String(url));
    if (parsed.hostname === "api.github.com") {
      return { ok: true, json: async () => ({ content: btoa("{}"), sha: "sha1" }) };
    }
  } catch { /* not a valid URL — fall through */ }
  return { ok: false };
};

const { default: handler } = await import("./v2-bookings.js");
const { createAdminSessionToken } = await import("./_admin-auth.js");

// ─── Reset helpers ─────────────────────────────────────────────────────────────

function createSmsLogSupabaseMock() {
  const smsLogs = [];
  return {
    smsLogs,
    from(table) {
      if (table !== "sms_logs") {
        throw new Error(`Unexpected table: ${table}`);
      }
      const filters = {};
      return {
        select() { return this; },
        eq(column, value) {
          filters[column] = value;
          return this;
        },
        async maybeSingle() {
          const row = smsLogs.find((item) =>
            item.booking_id === filters.booking_id &&
            item.template_key === filters.template_key &&
            item.return_date_at_send === filters.return_date_at_send
          );
          return { data: row || null, error: null };
        },
        async upsert(row) {
          const exists = smsLogs.some((item) =>
            item.booking_id === row.booking_id &&
            item.template_key === row.template_key &&
            item.return_date_at_send === row.return_date_at_send
          );
          if (!exists) smsLogs.push({ ...row, id: smsLogs.length + 1 });
          return { error: null };
        },
      };
    },
  };
}

function resetStore() {
  for (const k of Object.keys(bookingsStore)) delete bookingsStore[k];
}

function resetCalls() {
  automationCalls.revenue.length = 0;
  automationCalls.customer.length = 0;
  automationCalls.booking.length = 0;
  automationCalls.blocked.length = 0;
  automationCalls.blockedSync.length = 0;
  automationCalls.releaseBlocked.length = 0;
  smsCalls.length = 0;
  sentEmails.length = 0;
  smsMockState.shouldThrow = false;
  smsMockState.errorMessage = "TextMagic send failed";
  emailMockState.shouldThrow = false;
  emailMockState.errorMessage = "SMTP send failed";
  paymentPlanProgressMockState.value = {
    has_active_plan: false,
    remaining_balance: 0,
    overdue_amount: 0,
    next_due_date: null,
    remaining_installments: 0,
  };
  schemaErrorMockState.forceFalse = false;
  supabaseMockState.client = null;
}

function createSendPaymentLinkSupabaseMock({ bookings = [] } = {}) {
  const rows = bookings.map((r) => ({ ...r }));
  const smsLogs = [];
  const smsDeliveryLogs = [];

  return {
    rows,
    smsLogs,
    smsDeliveryLogs,
    from(table) {
      if (table === "bookings") {
        const filters = [];
        let orderBy = null;
        let orderAsc = true;
        let limitCount = null;
        let updatePayload = null;
        return {
          select() { return this; },
          update(payload) { updatePayload = payload; return this; },
          eq(column, value) {
            filters.push((row) => row[column] === value);
            return this;
          },
          order(column, opts = {}) {
            orderBy = column;
            orderAsc = opts.ascending !== false;
            return this;
          },
          limit(value) {
            limitCount = Number(value);
            return this;
          },
          async maybeSingle() {
            let found = rows.filter((row) => filters.every((fn) => fn(row)));
            if (orderBy) {
              found = found.slice().sort((a, b) => {
                const av = a?.[orderBy];
                const bv = b?.[orderBy];
                if (av === bv) return 0;
                return orderAsc ? (av > bv ? 1 : -1) : (av > bv ? -1 : 1);
              });
            }
            if (Number.isFinite(limitCount) && limitCount >= 0) {
              found = found.slice(0, limitCount);
            }
            return { data: found[0] || null, error: null };
          },
          // Resolve update chains (.update().eq()) as a thenable
          then(resolve) {
            if (updatePayload) {
              const matched = rows.filter((row) => filters.every((fn) => fn(row)));
              matched.forEach((row) => Object.assign(row, updatePayload));
            }
            resolve({ error: null });
          },
        };
      }

      if (table === "sms_logs") {
        const filters = {};
        return {
          select() { return this; },
          eq(column, value) {
            filters[column] = value;
            return this;
          },
          async maybeSingle() {
            const existing = smsLogs.find((item) =>
              item.booking_id === filters.booking_id &&
              item.template_key === filters.template_key &&
              item.return_date_at_send === filters.return_date_at_send
            );
            return { data: existing || null, error: null };
          },
          async upsert(row) {
            const exists = smsLogs.some((item) =>
              item.booking_id === row.booking_id &&
              item.template_key === row.template_key &&
              item.return_date_at_send === row.return_date_at_send
            );
            if (!exists) smsLogs.push({ ...row, id: smsLogs.length + 1 });
            return { error: null };
          },
        };
      }

      if (table === "sms_delivery_logs") {
        return {
          async insert(row) {
            smsDeliveryLogs.push({ ...row, id: smsDeliveryLogs.length + 1 });
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

function createIssueFreeDaySupabaseMock({ booking } = {}) {
  const bookingRows = [{ ...booking }];
  const revenueRows = [];
  const rangeRows = [{ booking_ref: booking.booking_ref, vehicle_id: booking.vehicle_id, end_date: booking.return_date }];
  const smsLogs = [];
  const smsDeliveryLogs = [];

  return {
    bookingRows,
    revenueRows,
    rangeRows,
    smsLogs,
    smsDeliveryLogs,
    from(table) {
      if (table === "bookings") {
        const filters = [];
        let updatePayload = null;
        return {
          select() { return this; },
          update(payload) { updatePayload = payload || {}; return this; },
          eq(column, value) {
            filters.push((row) => row[column] === value);
            return this;
          },
          async maybeSingle() {
            const row = bookingRows.find((item) => filters.every((fn) => fn(item)));
            return { data: row ? { ...row } : null, error: null };
          },
          then(resolve) {
            if (updatePayload) {
              bookingRows
                .filter((item) => filters.every((fn) => fn(item)))
                .forEach((item) => Object.assign(item, updatePayload));
            }
            resolve({ error: null });
          },
        };
      }

      if (table === "vehicle_blocking_ranges") {
        const filters = [];
        let updatePayload = null;
        return {
          update(payload) { updatePayload = payload || {}; return this; },
          eq(column, value) {
            filters.push((row) => row[column] === value);
            return this;
          },
          then(resolve) {
            if (updatePayload) {
              rangeRows
                .filter((item) => filters.every((fn) => fn(item)))
                .forEach((item) => Object.assign(item, updatePayload));
            }
            resolve({ error: null });
          },
        };
      }

      if (table === "revenue_records") {
        const filters = [];
        let limitCount = null;
        return {
          select() { return this; },
          eq(column, value) {
            filters.push((row) => row[column] === value);
            return this;
          },
          limit(value) {
            limitCount = Number(value);
            return this;
          },
          async maybeSingle() {
            let rows = revenueRows.filter((item) => filters.every((fn) => fn(item)));
            if (Number.isFinite(limitCount) && limitCount >= 0) rows = rows.slice(0, limitCount);
            return { data: rows[0] ? { ...rows[0] } : null, error: null };
          },
          async insert(payload) {
            const row = { id: revenueRows.length + 1, ...payload };
            revenueRows.push(row);
            return { error: null };
          },
        };
      }

      if (table === "sms_logs") {
        const filters = {};
        return {
          select() { return this; },
          eq(column, value) {
            filters[column] = value;
            return this;
          },
          async maybeSingle() {
            const row = smsLogs.find((item) =>
              item.booking_id === filters.booking_id &&
              item.template_key === filters.template_key &&
              item.return_date_at_send === filters.return_date_at_send
            );
            return { data: row || null, error: null };
          },
          async upsert(row) {
            const exists = smsLogs.some((item) =>
              item.booking_id === row.booking_id &&
              item.template_key === row.template_key &&
              item.return_date_at_send === row.return_date_at_send
            );
            if (!exists) smsLogs.push({ ...row, id: smsLogs.length + 1 });
            return { error: null };
          },
        };
      }

      if (table === "sms_delivery_logs") {
        return {
          async insert(row) {
            smsDeliveryLogs.push({ ...row, id: smsDeliveryLogs.length + 1 });
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

function createResendConfirmationSupabaseMock({ bookings = [], pendingDocs = [] } = {}) {
  const bookingRows = bookings.map((row) => ({ ...row }));
  const pendingRows = pendingDocs.map((row) => ({ ...row }));

  return {
    storage: {
      from(bucket) {
        if (bucket !== "rental-agreements") {
          throw new Error(`Unexpected storage bucket: ${bucket}`);
        }
        return {
          async download(path) {
            return { data: new Blob([`pdf:${path}`], { type: "application/pdf" }), error: null };
          },
          async upload() {
            return { error: null };
          },
        };
      },
    },
    from(table) {
      if (table === "bookings") {
        const filters = [];
        return {
          select() { return this; },
          eq(column, value) {
            filters.push((row) => row[column] === value);
            return this;
          },
          async maybeSingle() {
            const match = bookingRows.find((row) => filters.every((fn) => fn(row)));
            return { data: match || null, error: null };
          },
        };
      }

      if (table === "pending_booking_docs") {
        const filters = [];
        return {
          select() { return this; },
          eq(column, value) {
            filters.push((row) => row[column] === value);
            return this;
          },
          async maybeSingle() {
            const match = pendingRows.find((row) => filters.every((fn) => fn(row)));
            return { data: match || null, error: null };
          },
          async upsert(row) {
            const idx = pendingRows.findIndex((item) => item.booking_id === row.booking_id);
            if (idx >= 0) pendingRows[idx] = { ...pendingRows[idx], ...row };
            else pendingRows.push({ ...row });
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

// ─── Minimal create payload ───────────────────────────────────────────────────

function createPayload(overrides = {}) {
  return {
    secret:      "test-admin-secret",
    action:      "create",
    vehicleId:   "camry",
    name:        "Alice Smith",
    phone:       "+13105550001",
    email:       "alice@example.com",
    pickupDate:  "2026-06-01",
    pickupTime:  "10:00 AM",
    returnDate:  "2026-06-03",
    returnTime:  "10:00 AM",
    amountPaid:  0,
    totalPrice:  150,
    paymentMethod: "cash",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. AUTH
// ═══════════════════════════════════════════════════════════════════════════════

test("returns 401 for wrong secret", async () => {
  const res = makeRes();
  await handler(makeReq({ secret: "bad", action: "create" }), res);
  assert.equal(res._status, 401);
});

test("accepts Authorization bearer token when body secret is omitted", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  const body = createPayload();
  delete body.secret;
  await handler(
    makeReq(
      body,
      "https://slycarrentals.com",
      { authorization: "Bearer test-admin-secret" }
    ),
    res
  );
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
});

test("accepts signed admin session token in body secret", async () => {
  resetStore(); resetCalls();
  const sessionToken = createAdminSessionToken({ role: "admin", sub: "test-admin" });
  assert.ok(sessionToken);
  const res = makeRes();
  const body = createPayload({ secret: sessionToken });
  await handler(makeReq(body), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
});

test("returns 405 for GET requests", async () => {
  const req = { method: "GET", headers: { origin: "https://slycarrentals.com" }, body: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CREATE — input validation
// ═══════════════════════════════════════════════════════════════════════════════

test("create: 400 on missing vehicleId", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ ...createPayload(), vehicleId: "" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("vehicleId"));
});

test("create: 400 on invalid vehicleId", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ ...createPayload(), vehicleId: "unknown_car" }), res);
  assert.equal(res._status, 400);
});

test("create: 400 on missing name", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ ...createPayload(), name: "" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("name"));
});

test("create: 400 on bad pickupDate format", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ ...createPayload(), pickupDate: "06/01/2026" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("pickupDate"));
});

test("create: 400 when returnDate before pickupDate", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ ...createPayload(), pickupDate: "2026-06-05", returnDate: "2026-06-01" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("returnDate"));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CREATE — payment status
// ═══════════════════════════════════════════════════════════════════════════════

test("create: amountPaid=0 → status reserved_unpaid", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 150 })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.status, "reserved_unpaid");
});

test("create: amountPaid>0 → status booked_paid", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.status, "booked_paid");
});

test("create: totalPrice stored on booking record", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 50, totalPrice: 200 })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.totalPrice, 200);
  assert.equal(res._body.booking.amountPaid, 50);
});

test("create: totalPrice defaults to amountPaid when not provided", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 75, totalPrice: undefined })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.totalPrice, 75);
});

test("create: succeeds without GITHUB_TOKEN configured", async () => {
  resetStore(); resetCalls();
  const prevToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const res = makeRes();
    await handler(makeReq(createPayload({ amountPaid: 150 })), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.booking.status, "booked_paid");
  } finally {
    process.env.GITHUB_TOKEN = prevToken;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CREATE — automation side effects
// ═══════════════════════════════════════════════════════════════════════════════

test("create: paid booking triggers revenue record", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150 })), res);
  assert.ok(automationCalls.revenue.length > 0, "autoCreateRevenueRecord was called");
  assert.equal(automationCalls.revenue[0].vehicleId, "camry");
});

test("create: paid booking triggers customer upsert", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150 })), res);
  assert.ok(automationCalls.customer.length > 0, "autoUpsertCustomer was called");
  assert.equal(automationCalls.customer[0].phone, "+13105550001");
});

test("create: any booking syncs to Supabase bookings table", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0 })), res);
  assert.ok(automationCalls.booking.length > 0, "autoUpsertBooking was called");
});

test("create: unpaid booking does NOT create blocked dates", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0 })), res);
  assert.equal(automationCalls.blocked.length, 0, "autoCreateBlockedDate must NOT fire for unpaid bookings");
});

test("create: paid booking creates blocked dates", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150 })), res);
  assert.ok(automationCalls.blocked.length > 0, "autoCreateBlockedDate was called");
  assert.equal(automationCalls.blocked[0].vehicleId, "camry");
  assert.equal(automationCalls.blocked[0].reason, "booking");
});

test("create: unpaid booking does NOT create revenue record", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0 })), res);
  assert.equal(automationCalls.revenue.length, 0, "autoCreateRevenueRecord should NOT fire for unpaid bookings");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. DOUBLE BOOKING PREVENTION
// ═══════════════════════════════════════════════════════════════════════════════

test("double booking: identical dates on same vehicle → 409", async () => {
  resetStore(); resetCalls();
  // First booking
  await handler(makeReq(createPayload({ amountPaid: 150 })), makeRes());
  // Second booking: exact same dates
  const res2 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150 })), res2);
  assert.equal(res2._status, 409);
  assert.ok(res2._body.error.toLowerCase().includes("conflict"), `Expected conflict error, got: ${res2._body.error}`);
});

test("double booking: overlapping dates on same vehicle → 409", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ pickupDate: "2026-07-01", returnDate: "2026-07-05", amountPaid: 150 })), makeRes());
  // Overlapping: starts before first ends
  const res2 = makeRes();
  await handler(makeReq(createPayload({ pickupDate: "2026-07-03", returnDate: "2026-07-08", amountPaid: 150 })), res2);
  assert.equal(res2._status, 409);
});

test("double booking: non-overlapping dates on same vehicle → 200", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ pickupDate: "2026-08-01", returnDate: "2026-08-03", amountPaid: 150 })), makeRes());
  // Completely separate dates
  const res2 = makeRes();
  await handler(makeReq(createPayload({ pickupDate: "2026-08-10", returnDate: "2026-08-12", amountPaid: 150 })), res2);
  assert.equal(res2._status, 200, `Expected 200 for non-overlapping, got ${res2._status}: ${JSON.stringify(res2._body)}`);
});

test("double booking: different vehicles, same dates → both allowed", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ vehicleId: "camry", amountPaid: 150 })), makeRes());
  const res2 = makeRes();
  await handler(makeReq({ ...createPayload({ amountPaid: 150 }), vehicleId: "camry2013" }), res2);
  assert.equal(res2._status, 200);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CANCELLED BOOKING RELEASES AVAILABILITY
// ═══════════════════════════════════════════════════════════════════════════════

test("cancelled booking: slot is released for new booking on same dates", async () => {
  resetStore(); resetCalls();
  // Create a booking
  const r1 = makeRes();
  await handler(makeReq(createPayload({ pickupDate: "2026-10-01", returnDate: "2026-10-03", amountPaid: 150 })), r1);
  assert.equal(r1._status, 200);
  const bookingId = r1._body.booking.bookingId;

  // Cancel it
  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "cancelled_rental" },
  }), r2);
  assert.equal(r2._status, 200, `Cancel failed: ${JSON.stringify(r2._body)}`);

  // New booking on same dates should be allowed
  const r3 = makeRes();
  await handler(makeReq(createPayload({ pickupDate: "2026-10-01", returnDate: "2026-10-03", amountPaid: 150 })), r3);
  assert.equal(r3._status, 200, `After cancellation, same-date booking should succeed. Got: ${JSON.stringify(r3._body)}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. FULL LIFECYCLE — create → approve → activate → complete
// ═══════════════════════════════════════════════════════════════════════════════

test("lifecycle: create booking (reserved_unpaid)", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 150 })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.status, "reserved_unpaid");
});

test("lifecycle: approve booking (reserved_unpaid → booked_paid) triggers revenue + SMS", async () => {
  resetStore(); resetCalls();
  // Create unpaid
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;

  // Simulate Stripe payment succeeding (the webhook sets payment_status='paid')
  const rPay = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { paymentStatus: "paid" },
  }), rPay);
  assert.equal(rPay._status, 200, `Payment simulation failed: ${JSON.stringify(rPay._body)}`);
  resetCalls();

  // Approve (mark paid) — now allowed because payment_status is 'paid'
  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "booked_paid", amountPaid: 150 },
  }), r2);
  assert.equal(r2._status, 200);
  assert.equal(r2._body.booking.status, "booked_paid");

  // Revenue record created
  assert.ok(automationCalls.revenue.length > 0, "Revenue record must be created on approval");
  // Customer upserted
  assert.ok(automationCalls.customer.length > 0, "Customer must be upserted on approval");
  // Supabase booking synced
  assert.ok(automationCalls.booking.length > 0, "Supabase booking must be synced on approval");
  // Confirmation SMS sent
  assert.ok(smsCalls.length > 0, "Confirmation SMS must be sent on approval");
  assert.ok(smsCalls[0].body.includes("Camry 2012"), `SMS body should include vehicle name. Got: ${smsCalls[0].body}`);
});

test("lifecycle: repeated booked_paid updates do not resend booking confirmation SMS", async () => {
  resetStore(); resetCalls();
  supabaseMockState.client = createSmsLogSupabaseMock();

  const createRes = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 150 })), createRes);
  const created = createRes._body.booking;

  const approveRes = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "update",
    vehicleId: "camry",
    bookingId: created.bookingId,
    updates: { status: "booked_paid", amountPaid: 150 },
  }), approveRes);

  const editRes = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "update",
    vehicleId: "camry",
    bookingId: created.bookingId,
    updates: { status: "booked_paid", notes: "customer called" },
  }), editRes);

  assert.equal(approveRes._status, 200);
  assert.equal(editRes._status, 200);
  const bookingConfirmedSmsCount = smsCalls.filter((s) => String(s.body || "").includes("is confirmed")).length;
  const onboardingSmsCount = smsCalls.filter((s) => String(s.body || "").includes("Welcome to SLY RIDES")).length;
  assert.equal(bookingConfirmedSmsCount, 1, "booking_confirmed SMS must only send once per booking");
  assert.equal(onboardingSmsCount, 1, "booking_onboarding SMS must only send once per booking");
});

test("lifecycle: activate booking (booked_paid → active_rental) syncs to Supabase", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  resetCalls();

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), r2);
  assert.equal(r2._status, 200);
  assert.equal(r2._body.booking.status, "active_rental");
  assert.ok(automationCalls.booking.length > 0, "Supabase booking must be synced on activation");
});

test("lifecycle: complete booking (active_rental → completed_rental) increments customer stats", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;

  // Activate
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), makeRes());
  resetCalls();

  // Complete
  const r3 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "completed_rental" },
  }), r3);
  assert.equal(r3._status, 200);
  assert.equal(r3._body.booking.status, "completed_rental");
  // Customer stats must be incremented exactly once (countStats=true)
  const statsCall = automationCalls.customer.find((c) => c.countStats === true);
  assert.ok(statsCall, "autoUpsertCustomer must be called with countStats=true on completion");
});

test("lifecycle: completing a booking auto-sets completedAt and actualReturnTime", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;

  // Must first activate before completing
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), makeRes());

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "completed_rental" },
  }), r2);
  assert.equal(r2._status, 200);
  assert.ok(r2._body.booking.completedAt, "completedAt must be set automatically on completion");
  assert.ok(r2._body.booking.actualReturnTime, "actualReturnTime must be set automatically on completion");
});

test("lifecycle: activating a booking auto-sets activatedAt", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), r2);
  assert.equal(r2._status, 200);
  assert.ok(r2._body.booking.activatedAt, "activatedAt must be set automatically on activation");
});

test("lifecycle: completing a booking does NOT write to booked-dates.json (Phase 4)", async () => {
  resetStore(); resetCalls();
  // Track GitHub API calls
  const githubPuts = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    try {
      const parsed = new URL(typeof url === "string" ? url : String(url));
      if (parsed.hostname === "api.github.com") {
        if (opts && opts.method === "PUT") githubPuts.push(String(url));
        return { ok: true, json: async () => ({ content: btoa("{}"), sha: "sha1" }) };
      }
    } catch { /* not a valid URL — fall through */ }
    return { ok: false };
  };

  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  githubPuts.length = 0; // clear setup calls

  // Activate first (required by the safety guard)
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), makeRes());
  githubPuts.length = 0; // clear activation calls

  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "completed_rental" },
  }), makeRes());

  global.fetch = origFetch;
  // Phase 4: booked-dates.json writes are disabled
  assert.ok(!githubPuts.some((u) => u.includes("booked-dates")),
    "Phase 4: booked-dates.json must NOT be written when rental completes");
});

test("lifecycle: cancelling a booking does NOT write to booked-dates.json (Phase 4)", async () => {
  resetStore(); resetCalls();
  const githubPuts = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    try {
      const parsed = new URL(typeof url === "string" ? url : String(url));
      if (parsed.hostname === "api.github.com") {
        if (opts && opts.method === "PUT") githubPuts.push(String(url));
        return { ok: true, json: async () => ({ content: btoa("{}"), sha: "sha1" }) };
      }
    } catch { /* not a valid URL — fall through */ }
    return { ok: false };
  };

  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 50, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  githubPuts.length = 0;

  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "cancelled_rental" },
  }), makeRes());

  global.fetch = origFetch;
  // Phase 4: booked-dates.json writes are disabled
  assert.ok(!githubPuts.some((u) => u.includes("booked-dates")),
    "Phase 4: booked-dates.json must NOT be written when rental is cancelled");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. PAYMENT FIELD COMPUTATION (via autoUpsertBooking args)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Safety guard + return flow ──────────────────────────────────────────────

test("returned: completing a non-active booking returns 409", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  // Booking is currently booked_paid — should NOT be completable without activating first

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "completed_rental" },
  }), r2);
  assert.equal(r2._status, 409, `Expected 409 when completing non-active booking, got ${r2._status}: ${JSON.stringify(r2._body)}`);
  assert.ok(r2._body.error.includes("active"), "Error must mention active status requirement");
});

test("returned: completing an active booking calls autoReleaseBlockedDateOnReturn", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;

  // Activate
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), makeRes());
  resetCalls();

  // Complete (Return)
  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "completed_rental" },
  }), r2);
  assert.equal(r2._status, 200, `Expected 200 on return, got ${r2._status}: ${JSON.stringify(r2._body)}`);
  assert.ok(
    automationCalls.releaseBlocked.some((c) => c.vehicleId === "camry" && c.bookingRef === bookingId),
    "autoReleaseBlockedDateOnReturn must be called with vehicleId and bookingId on completion"
  );
});

test("payment: amountPaid=0, totalPrice=200 → Supabase sync has unpaid status", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 200 })), makeRes());
  // autoUpsertBooking should have been called with the booking; confirm it carries totalPrice
  const syncedBooking = automationCalls.booking[0];
  assert.ok(syncedBooking, "autoUpsertBooking must be called");
  assert.equal(syncedBooking.totalPrice, 200, "totalPrice must be forwarded to automation");
  assert.equal(syncedBooking.amountPaid, 0);
});

test("payment: partial payment (amountPaid < totalPrice) stored on booking", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 50, totalPrice: 200 })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.amountPaid, 50);
  assert.equal(res._body.booking.totalPrice, 200);
});

test("payment: update amountPaid syncs updated booking to Supabase", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  resetCalls();

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { amountPaid: 75 },
  }), r2);
  assert.equal(r2._status, 200);
  assert.equal(r2._body.booking.amountPaid, 75);
  assert.ok(automationCalls.booking.length > 0, "autoUpsertBooking must be called when amountPaid is updated");
});

test("payment: update totalPrice alongside amountPaid syncs to Supabase", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0 })), r1);
  const { bookingId } = r1._body.booking;
  resetCalls();

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { totalPrice: 200, amountPaid: 50 },
  }), r2);
  assert.equal(r2._status, 200);
  assert.equal(r2._body.booking.totalPrice, 200);
  assert.equal(r2._body.booking.amountPaid, 50);
  // The synced Supabase record has the updated values
  const synced = automationCalls.booking[0];
  assert.ok(synced, "autoUpsertBooking must be called");
  assert.equal(synced.totalPrice, 200);
  assert.equal(synced.amountPaid, 50);
});

test("payment: manual booking payment updates sync booking totals and revenue state", async () => {
  resetStore(); resetCalls();
  const created = makeRes();
  await handler(makeReq(createPayload({
    amountPaid: 50,
    totalPrice: 200,
    paymentMethod: "cash",
  })), created);
  const { bookingId } = created._body.booking;
  resetCalls();

  const bookingUpdates = [];
  const revenueUpdates = [];
  supabaseMockState.client = {
    from(table) {
      if (table === "bookings") {
        return {
          update(payload) {
            return {
              eq() {
                return {
                  select() {
                    return {
                      async maybeSingle() {
                        bookingUpdates.push(payload);
                        return { data: { id: "sb-booking-1" }, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "revenue_records") {
        return {
          select() {
            return {
              async eq() {
                return { data: [{ id: "rev-1", type: "rental" }], error: null };
              },
            };
          },
          update(payload) {
            return {
              async eq() {
                revenueUpdates.push(payload);
                return { error: null };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  const updated = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "update",
    vehicleId: "camry",
    bookingId,
    updates: { amountPaid: 125, totalPrice: 200 },
  }), updated);

  assert.equal(updated._status, 200);
  assert.equal(updated._body.booking.amountPaid, 125);
  assert.equal(updated._body.booking.paymentStatus, "partial");
  assert.deepEqual(bookingUpdates[0], {
    updated_at: bookingUpdates[0].updated_at,
    deposit_paid: 125,
    total_price: 200,
    remaining_balance: 75,
    payment_status: "partial",
  });
  assert.deepEqual(revenueUpdates[0], {
    gross_amount: 125,
    payment_status: "partial",
    payment_method: "cash",
    updated_at: revenueUpdates[0].updated_at,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. UPDATE — validation
// ═══════════════════════════════════════════════════════════════════════════════

test("update: 404 when booking does not exist", async () => {
  resetStore(); resetCalls();
  // Ensure vehicle entry exists in store
  bookingsStore.camry = [];
  const res = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId: "nonexistent",
    updates:   { status: "booked_paid" },
  }), res);
  assert.equal(res._status, 404);
});

test("update: 400 when updates object is missing", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId: "someId",
  }), res);
  assert.equal(res._status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. LIST
// ═══════════════════════════════════════════════════════════════════════════════

test("list: returns empty array when no bookings", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.ok(Array.isArray(res._body.bookings));
  assert.equal(res._body.bookings.length, 0);
});

test("list: returns created bookings", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ amountPaid: 100 })), makeRes());
  await handler(makeReq({ ...createPayload({ amountPaid: 100 }), vehicleId: "camry2013" }), makeRes());
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.bookings.length, 2);
});

test("list: filters by vehicleId", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ amountPaid: 100 })), makeRes());
  await handler(makeReq({ ...createPayload({ amountPaid: 100 }), vehicleId: "camry2013" }), makeRes());
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list", vehicleId: "camry" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.bookings.length, 1);
  assert.equal(res._body.bookings[0].vehicleId, "camry");
});

test("list: excludes incomplete checkout statuses from fallback bookings.json results", async () => {
  resetStore(); resetCalls();
  bookingsStore.camry = [
    { bookingId: "bk-paid", vehicleId: "camry", status: "booked_paid", amountPaid: 100, createdAt: "2026-05-01T10:00:00.000Z" },
    { bookingId: "bk-pending", vehicleId: "camry", status: "pending_checkout", amountPaid: 0, createdAt: "2026-05-02T10:00:00.000Z" },
    { bookingId: "bk-upload-failed", vehicleId: "camry", status: "upload_failed", amountPaid: 0, createdAt: "2026-05-03T10:00:00.000Z" },
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.bookings.length, 1, "incomplete checkout rows should be hidden from admin list");
  assert.equal(res._body.bookings[0].bookingId, "bk-paid");
});

test("update: returnDate and returnTime are accepted and persisted", async () => {
  resetStore(); resetCalls();
  // Create a booking first
  const createRes = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 300, pickupDate: "2026-04-01", returnDate: "2026-04-07" })), createRes);
  const bookingId = createRes._body.booking.bookingId;
  const smsCountBeforeUpdate = smsCalls.length;

  // Update the return date (simulates admin correcting an extension)
  const updateRes = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "update",
    vehicleId: "camry",
    bookingId,
    updates: { returnDate: "2026-04-10", returnTime: "5:00 PM" },
  }), updateRes);

  assert.equal(updateRes._status, 200, "update should succeed");
  assert.equal(updateRes._body.booking.returnDate, "2026-04-10", "returnDate should be updated");
  assert.equal(updateRes._body.booking.returnTime, "5:00 PM", "returnTime should be updated");
  assert.equal(smsCalls.length, smsCountBeforeUpdate + 1, "date update should send one SMS");
  assert.ok(automationCalls.blockedSync.length > 0, "booking-linked blocked_dates sync should run on return date update");
  assert.equal(automationCalls.blockedSync[0].bookingRef, bookingId);
  assert.equal(automationCalls.blockedSync[0].returnDate, "2026-04-10");
  const updateSms = smsCalls.at(-1);
  assert.match(updateSms.body, /Sly Car Rentals booking update:/);
  assert.match(updateSms.body, /Pickup: 2026-04-01/);
  assert.match(updateSms.body, /Return: 2026-04-10 at 5:00 PM/);
  // autoUpsertBooking should have been called to sync to Supabase
  assert.ok(automationCalls.booking.length > 0, "Supabase booking sync should be triggered");
});

test("issue_free_day: applies complimentary day, syncs blocks, records credit, and sends SMS", async () => {
  resetStore(); resetCalls();
  bookingsStore.camry = [{
    bookingId: "bk-free-day-1",
    paymentIntentId: "pi-free-day-1",
    vehicleId: "camry",
    pickupDate: "2026-06-01",
    returnDate: "2026-06-05",
    returnTime: "10:00 AM",
    totalPrice: 400,
    amountPaid: 200,
    remainingBalance: 200,
    paymentStatus: "partial",
    status: "active_rental",
    notes: "",
    name: "Alice Smith",
    phone: "+13105550001",
    email: "alice@example.com",
  }];

  const sb = createIssueFreeDaySupabaseMock({
    booking: {
      booking_ref: "bk-free-day-1",
      payment_intent_id: "pi-free-day-1",
      vehicle_id: "camry",
      pickup_date: "2026-06-01",
      return_date: "2026-06-05",
      return_time: "10:00:00",
      total_price: 400,
      deposit_paid: 200,
      remaining_balance: 200,
      payment_status: "partial",
      payment_method: "manual",
      notes: "",
      status: "active_rental",
      customer_name: "Alice Smith",
      customer_phone: "+13105550001",
      renter_phone: "+13105550001",
      customer_email: "alice@example.com",
    },
  });
  supabaseMockState.client = sb;

  const res = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "issue_free_day",
    bookingId: "bk-free-day-1",
    vehicleId: "camry",
    days: 1,
    reason: "repair delay",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body?.success, true);
  assert.equal(res._body?.freeDay?.days, 1);
  assert.equal(sb.bookingRows[0].return_date, "2026-06-06", "return date should be extended by one day");
  assert.ok(Number(sb.bookingRows[0].total_price) < 400, "total price should be reduced by free-day credit");
  assert.ok(Number(sb.bookingRows[0].remaining_balance) <= 200, "remaining balance should not increase");
  assert.ok(sb.bookingRows[0].notes.includes("Free Day"), "free-day audit note should be appended");
  assert.equal(sb.rangeRows[0].end_date, "2026-06-06", "vehicle_blocking_ranges end date should be updated");
  assert.ok(automationCalls.blockedSync.some((call) => call.bookingRef === "bk-free-day-1" && call.returnDate === "2026-06-06"));
  assert.ok(sb.revenueRows.some((row) => row.type === "free_day_credit" && Number(row.gross_amount) < 0), "credit revenue row should be written");
  assert.ok(smsCalls.some((msg) => /complimentary full day/i.test(msg.body)), "renter should receive free-day SMS");
  assert.equal(bookingsStore.camry[0].returnDate, "2026-06-06", "bookings.json mirror should be updated");
});

test("list: returns Supabase rows when client is available", async () => {
  resetStore(); resetCalls();
  // Simulate Supabase returning two bookings directly
  const fakeRows = [
    {
      id: "uuid-1", booking_ref: "wh-abc123", vehicle_id: "camry2013",
      pickup_date: "2026-03-29", return_date: "2026-04-01",
      pickup_time: "8:38 PM",   return_time: "8:38 PM",
      status: "booked_paid",    deposit_paid: 231.53, total_price: 231.53,
      remaining_balance: 0,     payment_status: "paid",
      payment_method: "stripe", payment_intent_id: "pi_test123",
      notes: "",                created_at: "2026-03-29T20:38:00.000Z",
      updated_at: null,
      customers: { id: "cu-1", name: "David Agbebaku", phone: "+13463814616", email: "davosama15@gmail.com" },
    },
  ];
  // Build a minimal Supabase-stub that chains eq/in/order and resolves with fakeRows
  const makeChain = (rows) => {
    const chain = {
      select() { return this; },
      eq()     { return this; },
      in()     { return this; },
      is()     { return this; },
      order()  { return Promise.resolve({ data: rows, error: null }); },
    };
    return chain;
  };
  supabaseMockState.client = { from: () => makeChain(fakeRows) };
  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings.length, 1);
    assert.equal(res._body.bookings[0].bookingId, "wh-abc123");
    assert.equal(res._body.bookings[0].name, "David Agbebaku");
    assert.equal(res._body.bookings[0].pickupTime, "8:38 PM");
    assert.equal(res._body.bookings[0]._source, "supabase");
  } finally {
    supabaseMockState.client = null;
  }
});

test("list: derives remaining from total_price - deposit_paid when remaining_balance is stale zero", async () => {
  resetStore(); resetCalls();
  const fakeRows = [
    {
      id: "uuid-rem-1", booking_ref: "bk-rem-1", vehicle_id: "camry",
      pickup_date: "2026-06-01", return_date: "2026-06-08",
      pickup_time: "10:00 AM", return_time: "10:00 AM",
      status: "reserved", total_price: 350, deposit_paid: 50,
      remaining_balance: 0, payment_status: "partial", payment_method: "stripe",
      payment_intent_id: "pi_rem_1", notes: "", created_at: "2026-05-20T10:00:00.000Z",
      updated_at: null,
      customers: { id: "cu-rem-1", name: "Remaining Test", phone: "+15550001110", email: "remaining@example.com" },
    },
  ];
  const makeChain = (rows) => ({
    select() { return this; },
    eq()     { return this; },
    in()     { return this; },
    is()     { return this; },
    order()  { return Promise.resolve({ data: rows, error: null }); },
  });
  supabaseMockState.client = { from: () => makeChain(fakeRows) };
  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings.length, 1);
    assert.equal(res._body.bookings[0].status, "reserved_unpaid");
    assert.equal(res._body.bookings[0].remaining, 300);
  } finally {
    supabaseMockState.client = null;
  }
});

test("list: retries with compatibility select when Supabase schema is missing newer columns", async () => {
  resetStore(); resetCalls();
  const fakeRows = [
    {
      id: "uuid-compat-1", booking_ref: "bk-compat-1", vehicle_id: "camry",
      pickup_date: "2026-05-16", return_date: "2026-05-18",
      pickup_time: "10:00 AM", return_time: "10:00 AM",
      status: "active", total_price: 220, deposit_paid: 220,
      remaining_balance: 0, payment_status: "paid", payment_method: "stripe",
      payment_intent_id: "pi_compat_1",
      notes: "compat row", created_at: "2026-05-16T10:00:00.000Z", updated_at: null,
      customers: { id: "cu-compat-1", name: "Compat Customer", phone: "+15550001111", email: "compat@example.com" },
    },
  ];

  let fullSelectAttempts = 0;
  const makeBookingsChain = () => {
    const chain = {
      _select: "",
      select(clause) { this._select = String(clause || ""); return this; },
      eq() { return this; },
      in() { return this; },
      is() { return this; },
      order() {
        if (this._select.includes("extension_risk_override")) {
          fullSelectAttempts += 1;
          return Promise.resolve({ data: null, error: { code: "42703", message: "column bookings.extension_risk_override does not exist" } });
        }
        return Promise.resolve({ data: fakeRows, error: null });
      },
    };
    return chain;
  };

  const makeRevenueChain = () => ({
    select() { return this; },
    in() { return Promise.resolve({ data: [], error: null }); },
  });

  supabaseMockState.client = {
    from: (table) => {
      if (table === "bookings") return makeBookingsChain();
      if (table === "revenue_records_effective") return makeRevenueChain();
      return makeBookingsChain();
    },
  };

  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(fullSelectAttempts, 1, "full-select query should run once before compatibility retry");
    assert.equal(res._body.bookings.length, 1);
    assert.equal(res._body.bookings[0].bookingId, "bk-compat-1");
    assert.equal(res._body.bookings[0].status, "active_rental");
    assert.equal(res._body.bookings[0]._source, "supabase");
  } finally {
    supabaseMockState.client = null;
  }
});

test("list: aggregates revenue rows per booking for total collected display", async () => {
  resetStore(); resetCalls();
  const fakeRows = [
    {
      id: "uuid-agg-1", booking_ref: "ca8ee28ffb888c41", vehicle_id: "camry2013",
      pickup_date: "2026-04-10", return_date: "2026-04-12",
      pickup_time: "9:00 AM",    return_time: "9:00 AM",
      status: "booked_paid",     deposit_paid: 121.28, total_price: 121.28,
      remaining_balance: 0,      payment_status: "paid",
      payment_method: "stripe",  payment_intent_id: "pi_base",
      notes: "",                 created_at: "2026-04-10T09:00:00.000Z",
      updated_at: null,
      customers: { id: "cu-agg-1", name: "Brandon Bookhart", phone: "+15303285561", email: "brandon.bookhart@gmail.com" },
    },
  ];
  const fakeRevenueRows = [
    {
      booking_id: "ca8ee28ffb888c41",
      gross_amount: 121.28,
      stripe_fee: 4.16,
      stripe_net: 117.12,
      payment_method: "stripe",
      customer_name: "Brandon Bookhart",
      customer_phone: "+15303285561",
      customer_email: "brandon.bookhart@gmail.com",
    },
    {
      booking_id: "ca8ee28ffb888c41",
      gross_amount: 60.64,
      stripe_fee: 2.06,
      stripe_net: 58.58,
      payment_method: "stripe",
      customer_name: "Brandon Bookhart",
      customer_phone: "+15303285561",
      customer_email: "brandon.bookhart@gmail.com",
    },
  ];

  const makeBookingsChain = (rows) => ({
    select() { return this; },
    eq()     { return this; },
    in()     { return this; },
    is()     { return this; },
    order()  { return Promise.resolve({ data: rows, error: null }); },
  });

  const makeRevenueChain = (rows) => ({
    select() { return this; },
    in()     { return this; },
    then(resolve, reject) {
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  });

  supabaseMockState.client = {
    from: (table) => {
      if (table === "bookings") return makeBookingsChain(fakeRows);
      if (table === "revenue_records_effective") return makeRevenueChain(fakeRevenueRows);
      return makeBookingsChain([]);
    },
  };

  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings.length, 1);
    assert.equal(res._body.bookings[0].bookingId, "ca8ee28ffb888c41");
    assert.equal(res._body.bookings[0].amountGross, 181.92);
    assert.equal(res._body.bookings[0].stripeFee, 6.22);
    assert.equal(res._body.bookings[0].amountNet, 175.7);
  } finally {
    supabaseMockState.client = null;
  }
});

test("list: falls back to bookings.json when Supabase errors", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ amountPaid: 100 })), makeRes()); // seed one booking
  // Supabase client that always errors
  const errChain = {
    select() { return this; },
    eq()     { return this; },
    in()     { return this; },
    is()     { return this; },
    order()  { return Promise.resolve({ data: null, error: { message: "DB down" } }); },
  };
  supabaseMockState.client = { from: () => errChain };
  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings.length, 1, "should fall back to bookings.json booking");
  } finally {
    supabaseMockState.client = null;
  }
});

// ── Status mapping tests ──────────────────────────────────────────────────────

test("list: maps Supabase DB status 'approved' → 'booked_paid' in response", async () => {
  resetStore(); resetCalls();
  const fakeRows = [
    {
      id: "uuid-2", booking_ref: "bk-test-001", vehicle_id: "camry",
      pickup_date: "2026-04-01", return_date: "2026-04-03",
      pickup_time: "10:00 AM",  return_time: "10:00 AM",
      status: "approved",        deposit_paid: 100, total_price: 100,
      remaining_balance: 0,      payment_status: "paid",
      payment_method: "stripe",  payment_intent_id: "pi_test",
      notes: "",                 created_at: "2026-04-01T10:00:00.000Z",
      updated_at: null,
      customers: { id: "cu-2", name: "Test User", phone: "+15555550001", email: "test@example.com" },
    },
  ];
  const makeChain = (rows) => {
    const chain = {
      select() { return this; },
      eq()     { return this; },
      in()     { return this; },
      is()     { return this; },
      order()  { return Promise.resolve({ data: rows, error: null }); },
    };
    return chain;
  };
  supabaseMockState.client = { from: () => makeChain(fakeRows) };
  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings.length, 1);
    assert.equal(res._body.bookings[0].status, "booked_paid",
      "Supabase 'approved' status must be mapped to 'booked_paid' for admin UI button compatibility");
  } finally {
    supabaseMockState.client = null;
  }
});

test("list: maps Supabase DB status 'active' → 'active_rental' in response", async () => {
  resetStore(); resetCalls();
  const fakeRows = [
    {
      id: "uuid-3", booking_ref: "bk-test-002", vehicle_id: "camry",
      pickup_date: "2026-04-01", return_date: "2026-04-03",
      pickup_time: "10:00 AM",  return_time: "10:00 AM",
      status: "active",          deposit_paid: 100, total_price: 100,
      remaining_balance: 0,      payment_status: "paid",
      payment_method: "stripe",  payment_intent_id: "pi_test2",
      notes: "",                 created_at: "2026-04-01T10:00:00.000Z",
      updated_at: null,
      customers: { id: "cu-3", name: "Test User 2", phone: "+15555550002", email: "test2@example.com" },
    },
  ];
  const makeChain = (rows) => {
    const chain = {
      select() { return this; },
      eq()     { return this; },
      in()     { return this; },
      is()     { return this; },
      order()  { return Promise.resolve({ data: rows, error: null }); },
    };
    return chain;
  };
  supabaseMockState.client = { from: () => makeChain(fakeRows) };
  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings[0].status, "active_rental",
      "Supabase 'active' status must be mapped to 'active_rental'");
  } finally {
    supabaseMockState.client = null;
  }
});

test("update: Supabase direct update is attempted before bookings.json write", async () => {
  resetStore(); resetCalls();
  // Create a booking first
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 100, totalPrice: 100 })), r1);
  const { bookingId } = r1._body.booking;
  resetCalls();

  // Track whether Supabase update was called
  let sbUpdateCalled = false;
  const makeUpdateChain = () => {
    const chain = {};
    chain.update  = () => { sbUpdateCalled = true; return chain; };
    chain.eq      = () => chain;
    chain.select  = () => chain;
    chain.maybeSingle = () => Promise.resolve({ data: { id: "uuid-sb-1" }, error: null });
    return chain;
  };
  supabaseMockState.client = { from: () => makeUpdateChain() };

  try {
    const r2 = makeRes();
    await handler(makeReq({
      secret: "test-admin-secret", action: "update",
      vehicleId: "camry", bookingId,
      updates: { status: "active_rental" },
    }), r2);
    assert.equal(r2._status, 200, "update should succeed");
    assert.equal(r2._body.booking.status, "active_rental", "booking status must reflect new value");
    assert.ok(sbUpdateCalled, "Supabase direct update should have been called");
  } finally {
    supabaseMockState.client = null;
  }
});

test("delete: removes booking from bookings.json by bookingId", async () => {
  resetStore(); resetCalls();

  const created = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 100, totalPrice: 100 })), created);
  const bookingId = created._body?.booking?.bookingId;
  assert.ok(bookingId, "create should return a bookingId");

  const delRes = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "delete", bookingId }), delRes);
  assert.equal(delRes._status, 200);
  assert.equal(delRes._body?.success, true);

  const listRes = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), listRes);
  assert.equal(listRes._status, 200);
  assert.equal(listRes._body.bookings.length, 0, "deleted booking should not remain in listing");
});

test("delete: returns 400 when bookingId is missing", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "delete" }), res);
  assert.equal(res._status, 400);
  assert.match(res._body?.error || "", /bookingId is required/);
});

test("list: excludes soft-deleted Supabase rows when deleted_at is set", async () => {
  resetStore(); resetCalls();
  const rows = [
    {
      id: "uuid-live-1",
      booking_ref: "bk-live-1",
      vehicle_id: "camry",
      pickup_date: "2026-05-10",
      return_date: "2026-05-12",
      pickup_time: "10:00 AM",
      return_time: "10:00 AM",
      status: "active",
      total_price: 200,
      deposit_paid: 200,
      remaining_balance: 0,
      payment_status: "paid",
      payment_method: "stripe",
      payment_intent_id: "pi-live-1",
      notes: "",
      created_at: "2026-05-10T10:00:00.000Z",
      updated_at: null,
      deleted_at: null,
      customers: { id: "cu-live-1", name: "Live User", phone: "+15550000001", email: "live@example.com" },
    },
    {
      id: "uuid-arch-1",
      booking_ref: "bk-arch-1",
      vehicle_id: "camry",
      pickup_date: "2026-05-01",
      return_date: "2026-05-03",
      pickup_time: "10:00 AM",
      return_time: "10:00 AM",
      status: "completed",
      total_price: 180,
      deposit_paid: 180,
      remaining_balance: 0,
      payment_status: "paid",
      payment_method: "stripe",
      payment_intent_id: "pi-arch-1",
      notes: "",
      created_at: "2026-05-01T10:00:00.000Z",
      updated_at: null,
      deleted_at: "2026-05-04T00:00:00.000Z",
      customers: { id: "cu-arch-1", name: "Archived User", phone: "+15550000002", email: "arch@example.com" },
    },
  ];
  const makeBookingsChain = () => {
    const filters = [];
    const chain = {
      select() { return this; },
      eq(column, value) { filters.push((row) => row[column] === value); return this; },
      in(column, values) { filters.push((row) => values.includes(row[column])); return this; },
      is(column, value) {
        if (value === null) filters.push((row) => row[column] == null);
        return this;
      },
      order() {
        return Promise.resolve({ data: rows.filter((row) => filters.every((fn) => fn(row))), error: null });
      },
    };
    return chain;
  };
  const makeRevenueChain = () => ({ select() { return this; }, in() { return Promise.resolve({ data: [], error: null }); } });
  supabaseMockState.client = {
    from: (table) => {
      if (table === "bookings") return makeBookingsChain();
      if (table === "revenue_records_effective") return makeRevenueChain();
      return makeBookingsChain();
    },
  };
  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings.length, 1);
    assert.equal(res._body.bookings[0].bookingId, "bk-live-1");
  } finally {
    supabaseMockState.client = null;
  }
});

test("delete+restore: soft-delete in Supabase hides booking from list until restored", async () => {
  resetStore(); resetCalls();
  const rows = [
    {
      id: "uuid-soft-1",
      booking_ref: "bk-soft-1",
      payment_intent_id: "pi-soft-1",
      vehicle_id: "camry",
      pickup_date: "2026-05-17",
      return_date: "2026-05-18",
      pickup_time: "10:00 AM",
      return_time: "10:00 AM",
      status: "active",
      total_price: 120,
      deposit_paid: 120,
      remaining_balance: 0,
      payment_status: "paid",
      payment_method: "stripe",
      notes: "",
      created_at: "2026-05-17T10:00:00.000Z",
      updated_at: null,
      deleted_at: null,
      deleted_by: null,
      deleted_reason: null,
      customers: { id: "cu-soft-1", name: "Soft User", phone: "+15550000003", email: "soft@example.com" },
    },
  ];
  const blockedRows = [
    {
      id: 1,
      booking_ref: "bk-soft-1",
      vehicle_id: "camry",
      start_date: "2026-05-17",
      end_date: "2026-05-18",
      reason: "booking",
    },
  ];
  const makeBookingsChain = () => {
    const filters = [];
    const chain = {
      _op: "select",
      _payload: null,
      select() { this._op = "select"; return this; },
      update(payload) { this._op = "update"; this._payload = payload || {}; return this; },
      delete() { this._op = "delete"; return this; },
      eq(column, value) {
        if (this._op === "update") {
          for (const row of rows) {
            if (row[column] === value) Object.assign(row, this._payload);
          }
          return Promise.resolve({ error: null });
        }
        if (this._op === "delete") {
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (rows[i][column] === value) rows.splice(i, 1);
          }
          return Promise.resolve({ error: null });
        }
        filters.push((row) => row[column] === value);
        return this;
      },
      in(column, values) { filters.push((row) => values.includes(row[column])); return this; },
      is(column, value) {
        if (value === null) filters.push((row) => row[column] == null);
        return this;
      },
      maybeSingle() {
        const found = rows.find((row) => filters.every((fn) => fn(row)));
        return Promise.resolve({ data: found || null, error: null });
      },
      order() {
        const data = rows.filter((row) => filters.every((fn) => fn(row)));
        return Promise.resolve({ data, error: null });
      },
    };
    return chain;
  };
  const makeBlockedDatesChain = () => {
    const chain = {
      _op: "select",
      delete() { this._op = "delete"; return this; },
      eq(column, value) {
        if (this._op === "delete") {
          for (let i = blockedRows.length - 1; i >= 0; i -= 1) {
            if (blockedRows[i][column] === value) blockedRows.splice(i, 1);
          }
          return Promise.resolve({ error: null });
        }
        return this;
      },
    };
    return chain;
  };
  const makeRevenueChain = () => ({ select() { return this; }, in() { return Promise.resolve({ data: [], error: null }); } });
  supabaseMockState.client = {
    from: (table) => {
      if (table === "bookings") return makeBookingsChain();
      if (table === "blocked_dates") return makeBlockedDatesChain();
      if (table === "revenue_records_effective") return makeRevenueChain();
      return makeBookingsChain();
    },
  };

  try {
    const listBefore = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), listBefore);
    assert.equal(listBefore._status, 200);
    assert.equal(listBefore._body.bookings.length, 1);

    const delRes = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "delete", bookingId: "bk-soft-1" }), delRes);
    assert.equal(delRes._status, 200);
    assert.equal(delRes._body.mode, "soft_delete");
    assert.equal(blockedRows.length, 0, "soft-delete should clear booking-linked blocked dates");

    const listAfterDelete = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), listAfterDelete);
    assert.equal(listAfterDelete._status, 200);
    assert.equal(listAfterDelete._body.bookings.length, 0);

    const restoreRes = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "restore", bookingId: "bk-soft-1" }), restoreRes);
    assert.equal(restoreRes._status, 200);
    assert.equal(restoreRes._body.success, true);

    const listAfterRestore = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), listAfterRestore);
    assert.equal(listAfterRestore._status, 200);
    assert.equal(listAfterRestore._body.bookings.length, 1);
    assert.equal(listAfterRestore._body.bookings[0].bookingId, "bk-soft-1");
  } finally {
    supabaseMockState.client = null;
  }
});

test("send_payment_link: bookingId path sends deduped SMS with payment-plan context", async () => {
  resetStore(); resetCalls();
  supabaseMockState.client = createSendPaymentLinkSupabaseMock({
    bookings: [{
      booking_ref: "bk-send-001",
      customer_id: "cust-001",
      customer_name: "Alice Smith",
      customer_phone: "+13105550001",
      renter_phone: null,
      customer_email: "alice@example.com",
      vehicle_id: "camry",
      pickup_date: "2026-06-01",
      return_date: "2026-06-05",
      remaining_balance: 170.5,
      payment_intent_id: "pi_balance_001",
      balance_payment_link: "https://slycarrentals.com/balance.html?b=bk-send-001",
      created_at: "2026-05-01T10:00:00.000Z",
    }],
  });
  paymentPlanProgressMockState.value = {
    has_active_plan: true,
    remaining_balance: 120.25,
    overdue_amount: 30,
    next_due_date: "2026-06-07T00:00:00.000Z",
    remaining_installments: 2,
  };

  const res = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "send_payment_link",
    bookingId: "bk-send-001",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body?.success, true);
  assert.equal(res._body?.bookingId, "bk-send-001");
  assert.equal(res._body?.smsSent, true);
  assert.equal(res._body?.smsDedupSkipped, false);
  assert.equal(res._body?.paymentPlan?.hasActivePlan, true);
  assert.equal(res._body?.paymentPlan?.remainingBalance, 120.25);
  assert.equal(res._body?.paymentPlan?.overdueAmount, 30);
  assert.equal(res._body?.paymentPlan?.nextDueDate, "2026-06-07");
  assert.equal(smsCalls.length, 1, "SMS should be sent once");
  assert.match(smsCalls[0].body, /Booking: bk-send-001/);
  assert.match(smsCalls[0].body, /Overdue amount: \$30\.00\./);
  assert.match(smsCalls[0].body, /manage-booking\.html/, "SMS should link to manage-booking dashboard");
  assert.ok(res._body?.manageLink, "response should include manageLink");
  assert.match(String(res._body?.manageLink || ""), /manage-booking\.html\?t=/, "manageLink should contain token");
});

test("send_payment_link: derives current balance when remaining_balance is stale zero", async () => {
  resetStore(); resetCalls();
  supabaseMockState.client = createSendPaymentLinkSupabaseMock({
    bookings: [{
      booking_ref: "bk-stale-remaining-1",
      customer_id: "cust-stale-1",
      customer_name: "Stale Remaining",
      customer_phone: "+13105551111",
      renter_phone: null,
      customer_email: "stale@example.com",
      vehicle_id: "camry",
      pickup_date: "2026-06-01",
      return_date: "2026-06-08",
      total_price: 350,
      deposit_paid: 50,
      remaining_balance: 0,
      payment_intent_id: "pi_stale_1",
      balance_payment_link: "https://slycarrentals.com/balance.html?b=bk-stale-remaining-1",
      created_at: "2026-05-01T10:00:00.000Z",
    }],
  });
  paymentPlanProgressMockState.value = {
    has_active_plan: false,
    remaining_balance: 0,
    overdue_amount: 0,
    next_due_date: null,
    remaining_installments: 0,
  };

  const res = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "send_payment_link",
    bookingId: "bk-stale-remaining-1",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(smsCalls.length, 1);
  assert.match(String(smsCalls[0].body || ""), /Current balance: \$300\.00\./);
});

test("send_payment_link: customerId path resolves latest booking and supports email-only send", async () => {
  resetStore(); resetCalls();
  process.env.SMTP_HOST = "smtp.test.invalid";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "test@test.invalid";
  process.env.SMTP_PASS = "test-password";

  supabaseMockState.client = createSendPaymentLinkSupabaseMock({
    bookings: [
      {
        booking_ref: "bk-customer-older",
        customer_id: "cust-200",
        customer_name: "Bob Rider",
        customer_phone: "+13105550002",
        renter_phone: null,
        customer_email: "bob@example.com",
        vehicle_id: "camry",
        pickup_date: "2026-06-01",
        return_date: "2026-06-05",
        remaining_balance: 80,
        payment_intent_id: "pi_old",
        balance_payment_link: "https://slycarrentals.com/balance.html?b=bk-customer-older",
        created_at: "2026-05-01T09:00:00.000Z",
      },
      {
        booking_ref: "bk-customer-newer",
        customer_id: "cust-200",
        customer_name: "Bob Rider",
        customer_phone: "+13105550002",
        renter_phone: null,
        customer_email: "bob@example.com",
        vehicle_id: "camry2013",
        pickup_date: "2026-06-10",
        return_date: "2026-06-14",
        remaining_balance: 95,
        payment_intent_id: "pi_new",
        balance_payment_link: "https://slycarrentals.com/balance.html?b=bk-customer-newer",
        created_at: "2026-05-10T09:00:00.000Z",
      },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "send_payment_link",
    customerId: "cust-200",
    send_sms: false,
    send_email: true,
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body?.bookingId, "bk-customer-newer", "must resolve latest booking for customer");
  assert.equal(res._body?.smsSent, false);
  assert.equal(res._body?.emailSent, true);
  assert.equal(smsCalls.length, 0, "SMS should be disabled");
  assert.equal(sentEmails.length, 1, "email should be sent");
  assert.equal(sentEmails[0].to, "bob@example.com");
  assert.match(String(sentEmails[0].html || ""), /bk-customer-newer/);
  assert.match(String(sentEmails[0].html || ""), /manage-booking\.html/, "email should link to manage-booking dashboard");
  assert.ok(res._body?.manageLink, "response should include manageLink");
});

test("resend_confirmation: uses latest Supabase booking details when bookings.json is stale", async () => {
  resetStore(); resetCalls();
  process.env.SMTP_HOST = "smtp.test.invalid";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "test@test.invalid";
  process.env.SMTP_PASS = "test-password";
  process.env.OWNER_EMAIL = "owner@test.invalid";

  bookingsStore.camry = [{
    bookingId: "bk-resend-001",
    vehicleId: "camry",
    vehicleName: "Camry 2012",
    name: "Old Name",
    email: "old@example.com",
    phone: "+13105550000",
    pickupDate: "2026-06-01",
    pickupTime: "10:00 AM",
    returnDate: "2026-06-05",
    returnTime: "10:00 AM",
    amountPaid: 150,
    totalPrice: 300,
    status: "booked_paid",
    paymentIntentId: "pi_resend_001",
    notes: "old notes",
  }];

  supabaseMockState.client = createResendConfirmationSupabaseMock({
    bookings: [{
      id: 101,
      booking_ref: "bk-resend-001",
      vehicle_id: "camry",
      pickup_date: "2026-06-01",
      pickup_time: "10:00 AM",
      return_date: "2026-06-10",
      return_time: "12:00 PM",
      total_price: 325,
      deposit_paid: 200,
      status: "booked_paid",
      payment_intent_id: "pi_resend_001",
      payment_status: "paid",
      payment_method: "stripe",
      notes: "updated notes",
      customer_name: "Updated Name",
      customer_phone: "+13105559999",
      customer_email: "updated@example.com",
      renter_phone: "+13105559999",
      customers: { name: "Updated Name", phone: "+13105559999", email: "updated@example.com" },
    }],
    pendingDocs: [{
      booking_id: "bk-resend-001",
      agreement_pdf_url: "bk-resend-001/agreement.pdf",
      email_sent: false,
    }],
  });

  const res = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "resend_confirmation",
    bookingId: "bk-resend-001",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(sentEmails.length, 2, "owner and customer emails should both be sent");
  assert.equal(sentEmails[1].to, "updated@example.com", "customer email should use the updated address");
  const ownerHtml = String(sentEmails[0].html || "");
  const customerHtml = String(sentEmails[1].html || "");
  assert.match(ownerHtml, /2026-06-10/, "owner email should include updated return date");
  assert.match(customerHtml, /2026-06-10/, "customer email should include updated return date");
  assert.doesNotMatch(ownerHtml, /2026-06-05/, "stale return date must not be used");
  assert.doesNotMatch(customerHtml, /old@example\.com/, "stale customer email must not be used in customer content");
});

test("send_payment_link: duplicate sends are deduped by sms_logs key", async () => {
  resetStore(); resetCalls();
  const sb = createSendPaymentLinkSupabaseMock({
    bookings: [{
      booking_ref: "bk-dedup-001",
      customer_id: "cust-dedup-001",
      customer_name: "Dedup User",
      customer_phone: "+13105550003",
      renter_phone: null,
      customer_email: "dedup@example.com",
      vehicle_id: "camry",
      pickup_date: "2026-06-01",
      return_date: "2026-06-05",
      remaining_balance: 60,
      payment_intent_id: "pi_dedup",
      balance_payment_link: "https://slycarrentals.com/balance.html?b=bk-dedup-001",
      created_at: "2026-05-01T09:00:00.000Z",
    }],
  });
  supabaseMockState.client = sb;

  const first = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "send_payment_link",
    bookingId: "bk-dedup-001",
  }), first);
  const second = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "send_payment_link",
    bookingId: "bk-dedup-001",
  }), second);

  assert.equal(first._status, 200);
  assert.equal(second._status, 200);
  assert.equal(first._body?.smsSent, true);
  assert.equal(second._body?.smsSent, false);
  assert.equal(second._body?.smsDedupSkipped, true);
  assert.equal(smsCalls.length, 1, "dedup should prevent second provider send");
  assert.equal(sb.smsLogs.length, 1, "sms_logs should only store one row");
});

test("send_payment_link: force_sms bypasses dedup and resends SMS", async () => {
  resetStore(); resetCalls();
  const sb = createSendPaymentLinkSupabaseMock({
    bookings: [{
      booking_ref: "bk-force-001",
      customer_id: "cust-force-001",
      customer_name: "Force User",
      customer_phone: "+13105550005",
      renter_phone: null,
      customer_email: "force@example.com",
      vehicle_id: "camry",
      pickup_date: "2026-06-01",
      return_date: "2026-06-05",
      remaining_balance: 75,
      payment_intent_id: "pi_force",
      balance_payment_link: "https://slycarrentals.com/balance.html?b=bk-force-001",
      created_at: "2026-05-01T09:00:00.000Z",
    }],
  });
  supabaseMockState.client = sb;

  const first = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "send_payment_link",
    bookingId: "bk-force-001",
  }), first);

  const forced = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "send_payment_link",
    bookingId: "bk-force-001",
    force_sms: true,
  }), forced);

  assert.equal(first._status, 200);
  assert.equal(forced._status, 200);
  assert.equal(first._body?.smsSent, true);
  assert.equal(forced._body?.smsSent, true);
  assert.equal(forced._body?.smsDedupSkipped, false);
  assert.equal(smsCalls.length, 2, "force_sms should bypass dedup and send again");
  assert.equal(sb.smsLogs.length, 1, "dedup key row should remain a single upserted record");
});

test("send_payment_link: SMS failure returns 500 and retry sends successfully", async () => {
  resetStore(); resetCalls();
  const sb = createSendPaymentLinkSupabaseMock({
    bookings: [{
      booking_ref: "bk-retry-001",
      customer_id: "cust-retry-001",
      customer_name: "Retry User",
      customer_phone: "+13105550004",
      renter_phone: null,
      customer_email: "retry@example.com",
      vehicle_id: "camry",
      pickup_date: "2026-06-01",
      return_date: "2026-06-05",
      remaining_balance: 45,
      payment_intent_id: "pi_retry",
      balance_payment_link: "https://slycarrentals.com/balance.html?b=bk-retry-001",
      created_at: "2026-05-01T09:00:00.000Z",
    }],
  });
  supabaseMockState.client = sb;

  smsMockState.shouldThrow = true;
  smsMockState.errorMessage = "simulated sms provider outage";
  const failed = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "send_payment_link",
    bookingId: "bk-retry-001",
  }), failed);
  assert.equal(failed._status, 500);
  assert.match(String(failed._body?.error || ""), /simulated sms provider outage/);
  assert.equal(sb.smsLogs.length, 0, "failed send must not create dedup lock");

  smsMockState.shouldThrow = false;
  const retried = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "send_payment_link",
    bookingId: "bk-retry-001",
  }), retried);
  assert.equal(retried._status, 200);
  assert.equal(retried._body?.smsSent, true);
  assert.equal(sb.smsLogs.length, 1, "successful retry should log dedup row once");
});
