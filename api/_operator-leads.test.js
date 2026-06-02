import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let currentClient = null;
let nextSendMailError = null;
let sentNotifications = [];
let insertCalls = [];
let auditRows = [];
let duplicateLead = null;
let leadCounter = 0;
let forcedInsertError = null;

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({
      sendMail: async (payload) => {
        sentNotifications.push(payload);
        if (nextSendMailError) throw nextSendMailError;
        return { accepted: [payload?.to] };
      },
    }),
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => currentClient,
  },
});

const { default: handler } = await import("./operator-leads.js");

function makeRes() {
  return {
    _headers: {},
    _status: 200,
    _body: undefined,
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    end() { return this; },
    json(obj) { this._body = obj; return this; },
    send(obj) { this._body = obj; return this; },
  };
}

function makeReq(method, body = {}, origin = "https://sly-rides-staging.vercel.app") {
  return {
    method,
    headers: {
      origin,
      "user-agent": "FleetControlTest/1.0",
    },
    body,
  };
}

function validBody(overrides = {}) {
  return {
    name: "Jordan Fleet",
    email: "Jordan@example.com",
    phone: "3105550101",
    fleetSize: "4-10 vehicles",
    priority: "Booking and renter workflow control",
    message: "Need a walkthrough for our Uber rental operation.",
    honeypot: "",
    source: "fleet_control_early_access",
    ...overrides,
  };
}

function createSupabaseClient() {
  const leads = [];
  return {
    from(table) {
      if (table === "operator_leads") {
        return {
          select() {
            return {
              eq() { return this; },
              gte() { return this; },
              order() { return this; },
              limit() { return this; },
              async maybeSingle() {
                return { data: duplicateLead, error: null };
              },
            };
          },
          insert(payload) {
            insertCalls.push({ table, payload });
            const row = {
              id: `lead-${++leadCounter}`,
              status: "new_lead",
              created_at: "2026-05-30T08:30:00.000Z",
              notification_attempt_count: 0,
              ...payload,
            };
            leads.push(row);
            return {
              select() {
                return {
                  async single() {
                    if (forcedInsertError) {
                      return { data: null, error: forcedInsertError };
                    }
                    return { data: row, error: null };
                  },
                };
              },
            };
          },
          update(patch) {
            return {
              eq(_field, id) {
                const row = leads.find((item) => item.id === id) || duplicateLead;
                if (row) Object.assign(row, patch);
                return {
                  select() {
                    return {
                      async maybeSingle() {
                        return { data: row || null, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "operator_lead_audit_logs") {
        return {
          async insert(payload) {
            auditRows.push(payload);
            return { data: payload, error: null };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    async rpc(_name, _args) {
      return { data: null, error: null };
    },
  };
}

beforeEach(() => {
  insertCalls = [];
  auditRows = [];
  duplicateLead = null;
  sentNotifications = [];
  nextSendMailError = null;
  leadCounter = 0;
  forcedInsertError = null;
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "notify@example.test";
  process.env.SMTP_PASS = "secret";
  process.env.FLEET_CONTROL_LEAD_NOTIFY_EMAIL = "ops@example.test";
  currentClient = createSupabaseClient();
});

test("OPTIONS returns 200", async () => {
  const res = makeRes();
  await handler(makeReq("OPTIONS"), res);
  assert.equal(res._status, 200);
});

test("sets CORS header for vercel staging origin", async () => {
  const res = makeRes();
  await handler(makeReq("POST", validBody(), "https://sly-rides-staging.vercel.app"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://sly-rides-staging.vercel.app");
});

test("returns 405 for non-POST requests", async () => {
  const res = makeRes();
  await handler(makeReq("GET"), res);
  assert.equal(res._status, 405);
});

test("returns 400 when required fields are missing", async () => {
  const res = makeRes();
  await handler(makeReq("POST", validBody({ priority: "" })), res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /Missing required fields/);
});

test("returns 503 when Supabase is unavailable", async () => {
  currentClient = null;
  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);
  assert.equal(res._status, 503);
  assert.match(res._body.error, /Supabase is not configured/);
});

test("stores operator lead, dispatches notification, and returns status metadata", async () => {
  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.leadId, "lead-1");
  assert.equal(res._body.notification.status, "sent");
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].table, "operator_leads");
  assert.equal(insertCalls[0].payload.first_name, "Jordan");
  assert.equal(insertCalls[0].payload.last_name, "Fleet");
  assert.equal(insertCalls[0].payload.email, "jordan@example.com");
  assert.equal(insertCalls[0].payload.fleet_size, "4-10 vehicles");
  assert.equal(insertCalls[0].payload.source, "fleet_control_early_access");
  assert.match(insertCalls[0].payload.notes, /priority=Booking and renter workflow control/);
  assert.match(insertCalls[0].payload.notes, /message=Need a walkthrough for our Uber rental operation\./);
  assert.match(insertCalls[0].payload.notes, /fleet_size_label=4-10 vehicles/);
  assert.equal(sentNotifications.length, 1);
  assert.equal(auditRows.length >= 2, true);
});

test("persists failed notification outcome when dispatch fails", async () => {
  nextSendMailError = new Error("SMTP rejected message");
  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.notification.status, "failed");
  assert.match(res._body.notification.errorReason, /SMTP rejected message/);
});

test("returns insert error details when lead persistence fails", async () => {
  forcedInsertError = {
    message: 'column "submission_hash" of relation "operator_leads" does not exist',
    code: "42703",
    hint: "Run migrations 0183+",
  };
  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);

  assert.equal(res._status, 500);
  assert.deepEqual(res._body, {
    error: "Failed to store operator lead",
    details: 'column "submission_hash" of relation "operator_leads" does not exist',
    code: "42703",
    hint: "Run migrations 0183+",
  });
});

test("duplicate retry does not send duplicate notifications after sent", async () => {
  duplicateLead = {
    id: "lead-existing",
    status: "new_lead",
    created_at: "2026-05-30T08:30:00.000Z",
    funnel_stage: "notification_sent",
    notification_status: "sent",
    notification_channel: "email",
    notification_sent_at: "2026-05-30T08:35:00.000Z",
    notification_error_reason: null,
    notification_attempt_count: 1,
    onboarding_progress: {},
  };

  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.duplicate, true);
  assert.equal(res._body.leadId, "lead-existing");
  assert.equal(sentNotifications.length, 0);
  assert.equal(insertCalls.length, 0);
});

test("duplicate failed notification is retried without creating a new lead", async () => {
  duplicateLead = {
    id: "lead-existing",
    status: "new_lead",
    created_at: "2026-05-30T08:30:00.000Z",
    funnel_stage: "lead_submitted",
    notification_status: "failed",
    notification_channel: "email",
    notification_sent_at: null,
    notification_error_reason: "SMTP timeout",
    notification_attempt_count: 1,
    onboarding_progress: {},
  };

  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.duplicate, true);
  assert.equal(res._body.retried, true);
  assert.equal(res._body.leadId, "lead-existing");
  assert.equal(sentNotifications.length, 1);
  assert.equal(insertCalls.length, 0);
});
