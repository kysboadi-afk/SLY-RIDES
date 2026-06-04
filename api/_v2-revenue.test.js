// api/_v2-revenue.test.js
// Tests for POST /api/v2-revenue.
//
// Validates:
//  1. list action: returns empty array when no records exist anywhere
//  2. list action: derives records from bookings.json when Supabase and GitHub are both empty
//  3. list action: returns Supabase records when available (non-empty)
//  4. list action: falls back to GitHub records (revenue-records.json) when Supabase is absent
//  5. create action: inserts to GitHub fallback when Supabase absent
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.ADMIN_SECRET = "test-admin-secret";
process.env.GITHUB_TOKEN = "test-github-token";

// ─── Shared mutable state ─────────────────────────────────────────────────────

// Simulated GitHub revenue-records.json content
let ghRecords = [];
let ghSha     = null;

// Simulated bookings.json
let bookingsStore = {};

// Supabase mock state
let supabaseRecords = null; // null = "not configured"; [] = "configured but empty"; [...] = "has data"

// ─── Module mocks ─────────────────────────────────────────────────────────────

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => {
      if (supabaseRecords === null) return null;

      // Build a fluent query object that supports all chaining methods used in
      // v2-revenue.js (select → order → eq → gte → lte → limit) and resolves
      // to { data, error } when awaited.
      function makeQuery() {
        const q = {
          _data:  supabaseRecords,
          _error: null,
          // All chainable methods return the same query object
          select()  { return this; },
          order()   { return this; },
          eq()      { return this; },
          in()      { return this; },
          gte()     { return this; },
          lte()     { return this; },
          limit(n)  { this._data = (this._data || []).slice(0, n); return this; },
          single()  { this._data = (this._data || [])[0] || null; return this; },
          maybeSingle() { this._data = (this._data || [])[0] || null; return this; },
          // Make it thenable so `await q` works
          then(onFulfilled) {
            return Promise.resolve({ data: this._data, error: this._error }).then(onFulfilled);
          },
          catch(onRejected) {
            return Promise.resolve({ data: this._data, error: this._error }).catch(onRejected);
          },
        };
        return q;
      }

      return {
        from: (table) => ({
          select:  (...args) => makeQuery().select(...args),
          insert:  async (_row) => ({ data: [{ id: "sb-id-1" }], error: null }),
          upsert:  async (_rows, _opts) => ({ error: null }),
          delete:  () => ({
            eq: async (col, val) => {
              if (table === "revenue_records" && col === "id" && Array.isArray(supabaseRecords)) {
                supabaseRecords = supabaseRecords.filter((r) => r.id !== val);
              }
              return { error: null };
            },
          }),
          update:  (_u) => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: "sb-id-1" }, error: null }) }) }) }),
        }),
      };
    },
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings: async () => ({ data: JSON.parse(JSON.stringify(bookingsStore)), sha: "sha1" }),
    saveBookings: async (data) => { Object.assign(bookingsStore, JSON.parse(JSON.stringify(data))); },
  },
});

mock.module("./_error-helpers.js", {
  namedExports: {
    adminErrorMessage: (e) => (e && e.message) ? e.message : String(e),
    isSchemaError:     () => false,
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

// GitHub revenue-records.json mock — simulates the file read/write
mock.module("node:crypto", {
  defaultExport: {
    randomBytes: (n) => ({ toString: () => "deadbeef".slice(0, n * 2) }),
    randomUUID:  () => "00000000-0000-0000-0000-000000000001",
  },
  namedExports: {
    default: {
      randomBytes: (n) => ({ toString: () => "deadbeef".slice(0, n * 2) }),
      randomUUID:  () => "00000000-0000-0000-0000-000000000001",
    },
  },
});

// We override the GitHub fetch by patching global.fetch before each test.
function setupGitHubFetch() {
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("revenue-records.json")) {
      if (opts && opts.method === "PUT") {
        const body = JSON.parse(opts.body || "{}");
        const decoded = Buffer.from(body.content, "base64").toString("utf-8");
        ghRecords = JSON.parse(decoded);
        ghSha = "sha-updated";
        return { ok: true, json: async () => ({}) };
      }
      // GET
      if (!ghSha) {
        return { ok: false, status: 404, text: async () => "Not Found" };
      }
      const content = Buffer.from(JSON.stringify(ghRecords)).toString("base64");
      return { ok: true, json: async () => ({ content, sha: ghSha }) };
    }
    return { ok: false, status: 500, text: async () => "Unexpected fetch" };
  };
}

function makeRes() {
  return {
    _status:  200,
    _body:    null,
    setHeader() {},
    status(c) { this._status = c; return this; },
    json(b)   { this._body = b;  return this; },
    send(b)   { this._body = b;  return this; },
    end()     { return this; },
  };
}

function makeReq(body) {
  return { method: "POST", headers: { origin: "https://slycarrentals.com" }, body };
}

function resetState() {
  ghRecords      = [];
  ghSha          = null;
  bookingsStore  = {};
  supabaseRecords = null;
  setupGitHubFetch();
}

// ─── Import handler (must come after mocks) ───────────────────────────────────
const { default: handler } = await import("./v2-revenue.js");

// ═══════════════════════════════════════════════════════════════════════════════
// 1. LIST — empty everywhere
// ═══════════════════════════════════════════════════════════════════════════════
test("list: returns empty array when Supabase not configured and no GitHub file", async () => {
  resetState();
  // supabaseRecords = null → Supabase not configured
  // ghSha = null → 404 on GitHub → empty []
  // bookingsStore = {} → no bookings
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.records, []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. LIST — returns empty records when both Supabase and GitHub are empty
// ═══════════════════════════════════════════════════════════════════════════════
test("list: returns empty records when Supabase+GitHub both empty (no bookings.json fallback)", async () => {
  resetState();
  // Supabase not configured, GitHub 404 → empty

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.records.length, 0, "should return empty records when no data in Supabase or GitHub");
});

test("list: returns empty records when Supabase is empty and GitHub is empty", async () => {
  resetState();
  supabaseRecords = []; // configured but empty
  ghRecords = [];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.records, []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. LIST — Supabase empty, GitHub has records
// ═══════════════════════════════════════════════════════════════════════════════
test("list: returns GitHub records when Supabase is empty but GitHub file exists", async () => {
  resetState();
  supabaseRecords = []; // configured but empty
  ghSha     = "sha-existing";
  ghRecords = [
    { id: "gh-1", booking_id: "bk-gh", vehicle_id: "camry", gross_amount: 50, payment_status: "paid", created_at: "2026-03-01T00:00:00.000Z" },
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.records.length, 1);
  assert.equal(res._body.records[0].id, "gh-1");
});

test("list: defaults to showing paid and partial records", async () => {
  resetState();
  supabaseRecords = null; // force GitHub fallback filtering path
  ghSha = "sha-existing";
  ghRecords = [
    { id: "gh-paid-1", booking_id: "bk-gh-1", vehicle_id: "camry", gross_amount: 100, payment_status: "paid", created_at: "2026-03-01T00:00:00.000Z" },
    { id: "gh-partial-1", booking_id: "bk-gh-3", vehicle_id: "camry", gross_amount: 60, payment_status: "partial", created_at: "2026-03-03T00:00:00.000Z" },
    { id: "gh-unpaid-1", booking_id: "bk-gh-2", vehicle_id: "camry", gross_amount: 80, payment_status: "unpaid", created_at: "2026-03-02T00:00:00.000Z" },
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.deepEqual((res._body.records || []).map((r) => r.id), ["gh-partial-1", "gh-paid-1"]);
});

test("list_by_booking: includes partial records and excludes unpaid records", async () => {
  resetState();
  supabaseRecords = null; // force GitHub fallback grouping path
  ghSha = "sha-existing";
  ghRecords = [
    { id: "gh-paid-base", booking_id: "bk-group-1", vehicle_id: "camry", gross_amount: 100, payment_status: "paid", pickup_date: "2026-05-01", return_date: "2026-05-03", created_at: "2026-05-01T00:00:00.000Z" },
    { id: "gh-partial-base", booking_id: "bk-group-3", vehicle_id: "camry", gross_amount: 40, payment_status: "partial", pickup_date: "2026-05-04", return_date: "2026-05-06", created_at: "2026-05-04T00:00:00.000Z" },
    { id: "gh-unpaid-base", booking_id: "bk-group-2", vehicle_id: "camry", gross_amount: 120, payment_status: "unpaid", pickup_date: "2026-05-05", return_date: "2026-05-07", created_at: "2026-05-05T00:00:00.000Z" },
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list_by_booking" }), res);
  assert.equal(res._status, 200);
  assert.deepEqual((res._body.groups || []).map((g) => g.booking_id), ["bk-group-3", "bk-group-1"]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CREATE — GitHub fallback when Supabase not configured
// ═══════════════════════════════════════════════════════════════════════════════
test("create: saves to GitHub when Supabase not configured", async () => {
  resetState();
  // supabaseRecords = null → Supabase not configured
  ghSha     = "sha-existing";
  ghRecords = [];

  const res = makeRes();
  await handler(makeReq({
    secret:         "test-admin-secret",
    action:         "create",
    vehicle_id:     "camry",
    gross_amount:   75,
    customer_name:  "Test User",
    payment_method: "cash",
    payment_status: "paid",
  }), res);
  assert.equal(res._status, 201);
  assert.ok(res._body.record, "should return the created record");
  assert.equal(res._body.record.vehicle_id, "camry");
  assert.equal(ghRecords.length, 1, "record should be saved to GitHub");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. SYNC — deprecated (Supabase is the only source of truth)
// ═══════════════════════════════════════════════════════════════════════════════
test("delete: removes record from Supabase list results", async () => {
  resetState();
  supabaseRecords = [
    { id: "sb-del-1", booking_id: "bk-del-1", vehicle_id: "camry", gross_amount: 50, payment_status: "paid" },
  ];

  const delRes = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "delete", id: "sb-del-1" }), delRes);
  assert.equal(delRes._status, 200);
  assert.equal(delRes._body.success, true);

  const listRes = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), listRes);
  assert.equal(listRes._status, 200);
  assert.equal(listRes._body.records.length, 0, "deleted Supabase record should not remain in list");
});

test("delete: removes record from GitHub fallback list results", async () => {
  resetState();
  supabaseRecords = null; // force GitHub fallback
  ghSha = "sha-existing";
  ghRecords = [
    { id: "gh-del-1", booking_id: "bk-gh-1", vehicle_id: "camry", gross_amount: 50, payment_status: "paid", created_at: "2026-03-01T00:00:00.000Z" },
  ];

  const delRes = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "delete", id: "gh-del-1" }), delRes);
  assert.equal(delRes._status, 200);
  assert.equal(delRes._body.success, true);
  assert.equal(ghRecords.length, 0, "deleted GitHub record should be removed from storage");

  const listRes = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), listRes);
  assert.equal(listRes._status, 200);
  assert.equal(listRes._body.records.length, 0, "deleted GitHub record should not remain in list");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. RECORD EXTENSION FEE
// ═══════════════════════════════════════════════════════════════════════════════
test("record_extension_fee: 400 when required fields are missing", async () => {
  resetState();
  ghSha = "sha-existing";

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "record_extension_fee", vehicle_id: "camry", amount: 181.91 }), res);
  assert.equal(res._status, 400, "should reject missing original_booking_id");
});

test("record_extension_fee: 400 when amount is zero or negative", async () => {
  resetState();
  ghSha = "sha-existing";

  const res = makeRes();
  await handler(makeReq({
    secret:              "test-admin-secret",
    action:              "record_extension_fee",
    original_booking_id: "d95643b10c87a02f1a510f7466b2bedf",
    vehicle_id:          "camry",
    amount:              -10,
  }), res);
  assert.equal(res._status, 400, "should reject non-positive amount");
});

test("record_extension_fee: saves to GitHub with booking_id = original_booking_id when Supabase not configured", async () => {
  resetState();
  ghSha     = "sha-existing";
  ghRecords = [];
  // supabaseRecords = null → Supabase not configured

  const res = makeRes();
  await handler(makeReq({
    secret:              "test-admin-secret",
    action:              "record_extension_fee",
    original_booking_id: "d95643b10c87a02f1a510f7466b2bedf",
    vehicle_id:          "camry",
    amount:              181.91,
    extension_label:     "+3 days",
    payment_method:      "cash",
  }), res);

  assert.equal(res._status, 201, "should return 201 Created");
  assert.ok(res._body.record, "should return the created record");
  assert.equal(res._body.booking_id, "d95643b10c87a02f1a510f7466b2bedf", "booking_id should equal original_booking_id");
  assert.equal(res._body.record.booking_id, "d95643b10c87a02f1a510f7466b2bedf", "record.booking_id should equal original_booking_id");
  assert.equal(res._body.record.original_booking_id, "d95643b10c87a02f1a510f7466b2bedf", "original_booking_id should match");
  assert.equal(res._body.record.type, "extension", "record type should be 'extension'");
  assert.equal(res._body.record.vehicle_id,     "camry");
  assert.equal(res._body.record.gross_amount,   181.91);
  assert.equal(res._body.record.payment_method, "cash");
  assert.equal(res._body.record.payment_status, "paid");
  assert.ok(res._body.record.notes.includes("d95643b10c87a02f1a510f7466b2bedf"), "notes should reference original booking");
  assert.ok(res._body.record.notes.includes("+3 days"), "notes should include extension label");
  assert.equal(ghRecords.length, 1, "record should be saved to GitHub");
  assert.equal(ghRecords[0].booking_id, "d95643b10c87a02f1a510f7466b2bedf", "GitHub record should use original_booking_id");
  assert.equal(ghRecords[0].type, "extension", "GitHub record should have type=extension");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. LIST BY BOOKING
// ═══════════════════════════════════════════════════════════════════════════════

test("list_by_booking: filters out is_orphan=true rows (GitHub fallback)", async () => {
  resetState();
  ghSha = "sha-existing";
  ghRecords = [
    { id: "r1", booking_id: "bk-001", vehicle_id: "camry", gross_amount: 300, payment_status: "paid",
      type: "rental", is_orphan: false, sync_excluded: false, pickup_date: "2026-04-20", return_date: "2026-04-24" },
    { id: "r2", booking_id: "bk-002", vehicle_id: "camry", gross_amount: 200, payment_status: "paid",
      type: "rental", is_orphan: true,  sync_excluded: false, pickup_date: "2026-04-10", return_date: "2026-04-12" },
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list_by_booking" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.groups.length, 1, "orphan row should be excluded");
  assert.equal(res._body.groups[0].booking_id, "bk-001");
});

test("list_by_booking: filters out sync_excluded=true rows (GitHub fallback)", async () => {
  resetState();
  ghSha = "sha-existing";
  ghRecords = [
    { id: "r1", booking_id: "bk-001", vehicle_id: "camry", gross_amount: 300, payment_status: "paid",
      type: "rental", is_orphan: false, sync_excluded: false, pickup_date: "2026-04-20", return_date: "2026-04-24" },
    { id: "r2", booking_id: "bk-003", vehicle_id: "camry", gross_amount: 50,  payment_status: "paid",
      type: "rental", is_orphan: false, sync_excluded: true,  pickup_date: "2026-04-01", return_date: "2026-04-03" },
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list_by_booking" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.groups.length, 1, "sync_excluded row should be excluded");
  assert.equal(res._body.groups[0].booking_id, "bk-001");
});

test("list_by_booking: includes ALL gross amounts (rental + extension) in sum", async () => {
  resetState();
  ghSha = "sha-existing";
  ghRecords = [
    // Base rental row — counted because every distinct Stripe charge must be included
    { id: "r1", booking_id: "bk-ext-1", vehicle_id: "camry", gross_amount: 200, payment_status: "paid",
      type: "rental", original_booking_id: null, is_orphan: false, sync_excluded: false,
      pickup_date: "2026-04-20", return_date: "2026-04-24" },
    // Extension row — also counted
    { id: "r2", booking_id: "bk-ext-1", vehicle_id: "camry", gross_amount: 120, payment_status: "paid",
      type: "extension", original_booking_id: "bk-ext-1", is_orphan: false, sync_excluded: false,
      pickup_date: "2026-04-24", return_date: "2026-04-27" },
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list_by_booking" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.groups.length, 1, "both rows should collapse into one group");
  const g = res._body.groups[0];
  assert.equal(g.booking_id, "bk-ext-1");
  assert.equal(g.record_count, 2, "both records should be present in group.records");
  assert.equal(g.total_gross, 320, "total_gross should sum rental + extension (200 + 120 = 320)");
});

test("list_by_booking: includes rental gross when no extension rows exist", async () => {
  resetState();
  ghSha = "sha-existing";
  ghRecords = [
    { id: "r1", booking_id: "bk-no-ext", vehicle_id: "camry", gross_amount: 400, payment_status: "paid",
      type: "rental", original_booking_id: null, is_orphan: false, sync_excluded: false,
      pickup_date: "2026-04-01", return_date: "2026-04-07" },
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list_by_booking" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.groups.length, 1);
  assert.equal(res._body.groups[0].total_gross, 400, "rental gross should be counted when no extensions exist");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. KPI — total_revenue_kpi
// ═══════════════════════════════════════════════════════════════════════════════

test("kpi: returns total_revenue = 0 when GitHub file is empty", async () => {
  resetState();
  // supabaseRecords = null → Supabase not configured
  // ghSha = null → 404 → no records
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "kpi" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.total_revenue, 0, "should return 0 when no records exist");
});

test("kpi: sums gross_amount only for canonical-included records from GitHub fallback", async () => {
  resetState();
  ghSha = "sha-existing";
  ghRecords = [
    { id: "r1", booking_id: "bk-1", gross_amount: 300, payment_status: "paid", is_cancelled: false, is_no_show: false, is_orphan: false, sync_excluded: false },
    { id: "r2", booking_id: "bk-2", gross_amount: 150, payment_status: "paid", is_cancelled: false, is_no_show: false, is_orphan: false, sync_excluded: false },
    { id: "r2b", booking_id: "bk-2b", gross_amount: 25, payment_status: "partial", is_cancelled: false, is_no_show: false, is_orphan: false, sync_excluded: false },
    { id: "r3", booking_id: "bk-3", gross_amount: 200, payment_status: "paid", is_cancelled: true,  is_no_show: false, is_orphan: false, sync_excluded: false }, // excluded
    { id: "r4", booking_id: "bk-4", gross_amount: 50,  payment_status: "pending", is_cancelled: false, is_no_show: false, is_orphan: false, sync_excluded: false }, // excluded
    { id: "r5", booking_id: "bk-5", gross_amount: 25,  payment_status: "paid", is_cancelled: false, is_no_show: true,  is_orphan: false, sync_excluded: false }, // excluded
    { id: "r6", booking_id: "bk-6", gross_amount: 10,  payment_status: "paid", is_cancelled: false, is_no_show: false, is_orphan: true,  sync_excluded: false }, // excluded
    { id: "r7", booking_id: "bk-7", gross_amount: 5,   payment_status: "paid", is_cancelled: false, is_no_show: false, is_orphan: false, sync_excluded: true }, // excluded
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "kpi" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.total_revenue, 475, "should sum paid and partial canonical rows (300 + 150 + 25 = 475)");
});

test("kpi: excludes sync_excluded and orphan records under canonical rules", async () => {
  resetState();
  ghSha = "sha-existing";
  ghRecords = [
    { id: "r1", booking_id: "bk-1", gross_amount: 200, payment_status: "paid", is_cancelled: false, is_no_show: false, sync_excluded: false, is_orphan: false },
    { id: "r2", booking_id: "bk-2", gross_amount: 100, payment_status: "paid", is_cancelled: false, is_no_show: false, sync_excluded: true,  is_orphan: false }, // excluded
    { id: "r3", booking_id: "bk-3", gross_amount: 75,  payment_status: "paid", is_cancelled: false, is_no_show: false, sync_excluded: false, is_orphan: true },  // excluded
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "kpi" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.total_revenue, 200, "kpi should exclude non-canonical rows");
});

test("auth: rejects wrong secret with 401", async () => {
  resetState();
  const res = makeRes();
  await handler(makeReq({ secret: "wrong-secret", action: "list" }), res);
  assert.equal(res._status, 401);
});

test("auth: rejects missing secret with 401", async () => {
  resetState();
  const res = makeRes();
  await handler(makeReq({ action: "list" }), res);
  assert.equal(res._status, 401);
});
