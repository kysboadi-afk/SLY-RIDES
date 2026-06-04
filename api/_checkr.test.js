import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";

process.env.CHECKR_API_KEY = "checkr_test_key";
process.env.CHECKR_WEBHOOK_SECRET = "checkr_webhook_secret";
process.env.CHECKR_PACKAGE = "driver_pro";
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "test@test.invalid";
process.env.SMTP_PASS = "test-password";
process.env.OWNER_EMAIL = "owner@test.invalid";

const calls = {
  fetchById: [],
  fetchByCandidateId: [],
  fetchByReportId: [],
  patchCheckr: [],
  invitationNotifications: [],
  statusNotifications: [],
  fetches: [],
  reminderSms: [],
  reminderSkips: [],
};

let applicationByIdResult;
let applicationByCandidateResult;
let applicationByReportResult;
let patchCheckrResult;
let reminderSbClient;
let reminderQueryResult;
let reminderSmsResult;

mock.module("./_renter-applications.js", {
  namedExports: {
    deriveCheckrPhase: mock.fn((record = {}) => {
      if (record.checkr_report_status) return record.checkr_report_status;
      if (record.checkr_report_id) return "invitation_sent";
      if (record.checkr_candidate_id) return "candidate_created";
      return "not_started";
    }),
    fetchRenterApplicationById: mock.fn(async (...args) => {
      calls.fetchById.push(args);
      return applicationByIdResult;
    }),
    fetchRenterApplicationByCheckrCandidateId: mock.fn(async (...args) => {
      calls.fetchByCandidateId.push(args);
      return applicationByCandidateResult;
    }),
    fetchRenterApplicationByCheckrReportId: mock.fn(async (...args) => {
      calls.fetchByReportId.push(args);
      return applicationByReportResult;
    }),
    patchRenterApplicationCheckrById: mock.fn(async (...args) => {
      calls.patchCheckr.push(args);
      return patchCheckrResult;
    }),
  },
});

mock.module("./_application-notifications.js", {
  namedExports: {
    sendCheckrInvitationNotifications: mock.fn(async (...args) => {
      calls.invitationNotifications.push(args);
    }),
    sendCheckrStatusNotifications: mock.fn(async (...args) => {
      calls.statusNotifications.push(args);
    }),
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: mock.fn(() => reminderSbClient),
  },
});

mock.module("./_sms-dispatcher.js", {
  namedExports: {
    dispatchSms: mock.fn(async (...args) => {
      calls.reminderSms.push(args);
      return reminderSmsResult;
    }),
  },
});

mock.module("./_runtime-environment.js", {
  namedExports: {
    maybeSkipScheduledAutomation: mock.fn((...args) => {
      calls.reminderSkips.push(args);
      return false;
    }),
  },
});

global.fetch = mock.fn(async (url, init = {}) => {
  calls.fetches.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
  if (String(url).endsWith("/candidates")) {
    return {
      ok: true,
      status: 200,
      async json() { return { id: "candidate_123" }; },
    };
  }
  if (String(url).endsWith("/invitations")) {
    return {
      ok: true,
      status: 200,
      async json() { return { id: "invitation_123", invitation_url: "https://checkr.test/invite/123", report_id: "report_123" }; },
    };
  }
  throw new Error(`Unexpected fetch URL: ${url}`);
});

const {
  extractCheckrEventType,
  initiateCheckrScreening,
  mapCheckrReportStatus,
  verifyCheckrWebhookSignature,
} = await import("./_checkr.js");
const { default: checkrWebhookHandler } = await import("./checkr-webhook.js");
const { default: checkrInvitationReminderCronHandler } = await import("./checkr-invitation-reminder-cron.js");

function makeReminderSbClient(result) {
  const chain = {
    select: mock.fn(() => chain),
    in: mock.fn(() => chain),
    not: mock.fn(() => chain),
    is: mock.fn(() => chain),
    lte: mock.fn(() => chain),
    order: mock.fn(() => chain),
    limit: mock.fn(async () => result),
  };
  return {
    from: mock.fn(() => chain),
  };
}

function signPayload(payload) {
  return crypto.createHmac("sha256", process.env.CHECKR_WEBHOOK_SECRET).update(payload).digest("hex");
}

function signPayloadWithSecret(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function makeWebhookReq(payloadObj, { validSignature = true } = {}) {
  const body = Buffer.from(JSON.stringify(payloadObj || {}));
  const req = Readable.from([body]);
  req.method = "POST";
  req.headers = {
    "x-checkr-signature": validSignature ? signPayload(body) : "invalid",
  };
  return req;
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
  };
}

beforeEach(() => {
  calls.fetchById.length = 0;
  calls.fetchByCandidateId.length = 0;
  calls.fetchByReportId.length = 0;
  calls.patchCheckr.length = 0;
  calls.invitationNotifications.length = 0;
  calls.statusNotifications.length = 0;
  calls.fetches.length = 0;
  calls.reminderSms.length = 0;
  calls.reminderSkips.length = 0;
  process.env.CHECKR_WEBHOOK_SECRET = "checkr_webhook_secret";
  delete process.env.CHECKR_WEBHOOK_SIGNING_SECRET;
  delete process.env.CHECKR_SIGNING_SECRET;
  applicationByIdResult = {
    ok: true,
    data: {
      id: "app_1",
      name: "Jane Driver",
      email: "jane@example.com",
      phone: "3105550199",
      identity_status: "verified",
      agree_background_check: true,
      driver_license_number: "D1234567",
      driver_license_state: "CA",
    },
  };
  applicationByCandidateResult = {
    ok: true,
    data: {
      id: "app_1",
      name: "Jane Driver",
      email: "jane@example.com",
      checkr_candidate_id: "candidate_123",
      checkr_report_id: "report_123",
    },
  };
  applicationByReportResult = { ok: false, status: 404, error: "Application not found." };
  patchCheckrResult = { ok: true, data: { id: "app_1", checkr_report_status: "pending" } };
  reminderQueryResult = { data: [], error: null };
  reminderSbClient = null;
  reminderSmsResult = { sent: true };
});

test("mapCheckrReportStatus maps adjudication and lifecycle states", () => {
  assert.equal(mapCheckrReportStatus("pending", null), "pending");
  assert.equal(mapCheckrReportStatus("complete", "clear"), "clear");
  assert.equal(mapCheckrReportStatus("complete", "consider"), "consider");
  assert.equal(mapCheckrReportStatus("suspended", null), "suspended");
  assert.equal(mapCheckrReportStatus("disputed", null), "suspended");
  assert.equal(mapCheckrReportStatus("complete", null), "completed");
});

test("verifyCheckrWebhookSignature validates HMAC", () => {
  const body = Buffer.from(JSON.stringify({ ok: true }));
  const signature = signPayload(body);
  assert.equal(verifyCheckrWebhookSignature(body, { "x-checkr-signature": signature }, process.env.CHECKR_WEBHOOK_SECRET), true);
  assert.equal(verifyCheckrWebhookSignature(body, { "x-checkr-signature": "bad" }, process.env.CHECKR_WEBHOOK_SECRET), false);
});

test("initiateCheckrScreening creates candidate + invitation and persists invitation_sent state", async () => {
  const result = await initiateCheckrScreening("app_1");
  assert.equal(result.ok, true);
  assert.equal(result.candidateId, "candidate_123");
  assert.equal(result.reportId, "report_123");
  assert.equal(calls.patchCheckr.length, 3);
  assert.equal(calls.patchCheckr[0][1].checkrReportStatus, "launch_queued");
  assert.equal(calls.patchCheckr[1][1].checkrReportStatus, "candidate_created");
  assert.equal(calls.patchCheckr[2][1].checkrReportStatus, "invitation_sent");
  assert.equal(calls.invitationNotifications.length, 1);
});

test("initiateCheckrScreening blocks when consent is missing", async () => {
  applicationByIdResult.data.agree_background_check = false;
  const result = await initiateCheckrScreening("app_1");
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
});

test("checkr-webhook updates completed report status and notifies admin", async () => {
  const payload = {
    type: "report.completed",
    data: {
      object: {
        id: "report_123",
        candidate_id: "candidate_123",
        status: "complete",
        adjudication: "consider",
        completed_at: "2026-05-17T20:00:00.000Z",
        motor_vehicle_report: {
          violations: [{ code: "speeding" }],
        },
      },
    },
  };
  const res = makeRes();
  await checkrWebhookHandler(makeWebhookReq(payload), res);
  assert.equal(res._status, 200);
  assert.equal(calls.patchCheckr.length, 1);
  assert.equal(calls.patchCheckr[0][1].checkrReportStatus, "consider");
  assert.equal(calls.statusNotifications.length, 1);
});

test("checkr-webhook rejects invalid signatures", async () => {
  const res = makeRes();
  await checkrWebhookHandler(makeWebhookReq({ type: "candidate.created" }, { validSignature: false }), res);
  assert.equal(res._status, 400);
});

test("checkr-webhook accepts configured fallback signing secret env var", async () => {
  delete process.env.CHECKR_WEBHOOK_SECRET;
  process.env.CHECKR_WEBHOOK_SIGNING_SECRET = "fallback_secret";
  const payload = {
    type: "candidate.created",
    data: { object: { id: "candidate_123" } },
  };
  const body = Buffer.from(JSON.stringify(payload));
  const req = Readable.from([body]);
  req.method = "POST";
  req.headers = {
    "x-checkr-signature": signPayloadWithSecret(body, process.env.CHECKR_WEBHOOK_SIGNING_SECRET),
  };

  const res = makeRes();
  await checkrWebhookHandler(req, res);
  assert.equal(res._status, 200);
});

test("checkr-webhook handles pre-parsed req.body payload object", async () => {
  const payload = {
    type: "report.completed",
    data: {
      object: {
        id: "report_123",
        candidate_id: "candidate_123",
        status: "complete",
        adjudication: "clear",
      },
    },
  };
  const serialized = JSON.stringify(payload);
  const req = {
    method: "POST",
    headers: {
      "x-checkr-signature": signPayload(Buffer.from(serialized)),
    },
    body: payload,
  };
  const res = makeRes();
  await checkrWebhookHandler(req, res);
  assert.equal(res._status, 200);
  assert.equal(calls.patchCheckr.length, 1);
});

test("extractCheckrEventType supports nested data.event_type payload shape", () => {
  assert.equal(
    extractCheckrEventType({
      data: {
        event_type: "report.completed",
        object: { id: "report_123", candidate_id: "candidate_123", status: "complete" },
      },
    }),
    "report.completed",
  );
});

test("checkr-invitation-reminder-cron skips cleanly when required schema columns are missing", async () => {
  reminderQueryResult = {
    data: null,
    error: { message: "column renter_applications.checkr_invitation_url does not exist" },
  };
  reminderSbClient = makeReminderSbClient(reminderQueryResult);
  const req = { method: "GET", headers: {} };
  const res = makeRes();
  await checkrInvitationReminderCronHandler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body?.skipped, true);
  assert.equal(res._body?.reason, "schema_missing_columns");
  assert.deepEqual(res._body?.missingColumns, ["checkr_invitation_url"]);
  assert.equal(calls.reminderSms.length, 0);
});
