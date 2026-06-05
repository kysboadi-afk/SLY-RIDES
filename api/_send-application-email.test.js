// Tests for api/send-application-email.js
// Validates that driver applications are emailed to the owner with the
// license as an attachment, pre-approval logic, SMS dispatch, and
// XSS/oversized payload guards.
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── SMTP env vars ────────────────────────────────────────────────────────────
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "test@test.invalid";
process.env.SMTP_PASS = "test-password";
process.env.OWNER_EMAIL = "owner@test.invalid";
process.env.OTP_SECRET = "test-secret-for-identity-resume-tokens";

// ─── TextMagic env vars ───────────────────────────────────────────────────────
process.env.TEXTMAGIC_USERNAME = "testuser";
process.env.TEXTMAGIC_API_KEY  = "test-api-key-00000000000000000000000";

// ─── Renter applications mock ─────────────────────────────────────────────────
// Mock the DB layer so persistedApplicationId = "test-app-uuid" in all tests.
// This also enables verification link assertions in email/SMS.
mock.module("./_renter-applications.js", {
  namedExports: {
    insertRenterApplication: mock.fn(async () => ({
      ok: true,
      data: {
        id: "test-app-uuid",
        name: "Jane Driver",
        application_status: "submitted",
        identity_status: "not_started",
        precheck_decision: null,
      },
    })),
    patchRenterApplicationById: mock.fn(async () => ({ ok: false })),
  },
});

// ─── Nodemailer mock ──────────────────────────────────────────────────────────
const sentMails = [];
const mockSendMail = mock.fn(async (opts) => { sentMails.push(opts); });

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({ sendMail: mockSendMail }),
  },
});

// ─── TextMagic mock ───────────────────────────────────────────────────────────
const sentMessages = [];
const mockSendSms = mock.fn(async (to, text) => { sentMessages.push({ to, text }); return {}; });

mock.module("./_textmagic.js", {
  namedExports: { sendSms: mockSendSms },
});

const { default: handler } = await import("./send-application-email.js");

const TEST_PHONE = "3105550199";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeRes() {
  const res = {
    _headers: {},
    _status: 200,
    _body: undefined,
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    end() { return this; },
    send(text) { this._body = text; return this; },
    json(obj) { this._body = obj; return this; },
  };
  return res;
}

function makeReq(method, body = {}, origin = "https://slycarrentals.com") {
  return { method, headers: { origin }, body };
}

const VALID_BODY = {
  name: "Jane Driver",
  phone: TEST_PHONE,
  age: 25,
  experience: "3–5 years",
  apps: ["DoorDash", "Uber Eats"],
  agreeTerms: true,
  agreeSmsConsent: true,
  agreeBackgroundCheck: true,
  licenseFileName: "license.jpg",
  licenseMimeType: "image/jpeg",
  licenseBase64: Buffer.from("fake-image-data").toString("base64"),
};

const VALID_BODY_WITH_EMAIL = {
  ...VALID_BODY,
  email: "jane@example.com",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

test("OPTIONS preflight returns 200", async () => {
  const res = makeRes();
  await handler(makeReq("OPTIONS"), res);
  assert.equal(res._status, 200);
});

test("non-POST returns 405", async () => {
  const res = makeRes();
  await handler(makeReq("GET"), res);
  assert.equal(res._status, 405);
});

test("sets CORS header for allowed origin", async () => {
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY, "https://slycarrentals.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://slycarrentals.com");
});

test("does not set CORS header for unknown origin", async () => {
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY, "https://evil.example.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

test("returns 400 when required fields are missing", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { name: "Jane" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 400 when required consents are not all accepted", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, agreeBackgroundCheck: false }), res);
  assert.equal(res._status, 400);
  assert.ok(String(res._body.error || "").includes("required consents"));
});

test("returns 200 even when SMTP credentials are missing", async () => {
  sentMails.length = 0;
  const original = {
    host: process.env.SMTP_HOST,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  };
  try {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const res = makeRes();
    await handler(makeReq("POST", VALID_BODY), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(sentMails.length, 0);
  } finally {
    process.env.SMTP_HOST = original.host;
    process.env.SMTP_USER = original.user;
    process.env.SMTP_PASS = original.pass;
  }
});

test("returns 200 and sends email for valid application", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(sentMails.length, 1);
});

test("sends email to OWNER_EMAIL", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMails[0].to, "owner@test.invalid");
});

test("email subject contains lifecycle pending wording", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.ok(
    sentMails[0].subject.includes("Identity Verification Pending"),
    `Expected subject to include lifecycle wording, got: ${sentMails[0].subject}`
  );
});

test("email html contains all application fields including age and apps", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  const html = sentMails[0].html;
  assert.ok(html.includes("Jane Driver"));
  assert.ok(html.includes("3105550199"));
  assert.ok(html.includes("25"));
  assert.ok(html.includes("3\u20135 years"));
  assert.ok(html.includes("DoorDash"));
  assert.ok(html.includes("license.jpg"));
});

test("attaches license file when base64 data is provided", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMails[0].attachments.length, 1);
  assert.equal(sentMails[0].attachments[0].filename, "license.jpg");
  assert.equal(sentMails[0].attachments[0].contentType, "image/jpeg");
});

test("infers attachment MIME type from filename when mobile browsers omit it", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", {
    ...VALID_BODY,
    licenseFileName: "license.HEIC",
    licenseMimeType: "",
  }), res);
  assert.equal(res._status, 200);
  assert.equal(sentMails[0].attachments[0].filename, "license.HEIC");
  assert.equal(sentMails[0].attachments[0].contentType, "image/heic");
});

test("sends without attachment when license fields are omitted", async () => {
  sentMails.length = 0;
  const res = makeRes();
  const body = {
    name: "Jane Driver",
    phone: TEST_PHONE,
    age: 25,
    experience: "3–5 years",
    agreeTerms: true,
    agreeSmsConsent: true,
    agreeBackgroundCheck: true,
  };
  await handler(makeReq("POST", body), res);
  assert.equal(res._status, 200);
  assert.equal(sentMails[0].attachments.length, 0);
});

test("html-escapes special characters to prevent XSS", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", {
    name: "<script>alert(1)</script>",
    phone: TEST_PHONE,
    age: 25,
    experience: "<img src=x onerror=alert(1)>",
    agreeTerms: true,
    agreeSmsConsent: true,
    agreeBackgroundCheck: true,
  }), res);
  assert.equal(res._status, 200);
  const html = sentMails[0].html;
  // Tags must be escaped — no raw < or > in user-supplied values
  assert.ok(!html.includes("<script>"), "raw <script> tag must not appear");
  assert.ok(html.includes("&lt;script&gt;"), "escaped &lt;script&gt; must appear");
  assert.ok(!html.includes("<img"), "raw <img> tag must not appear");
  assert.ok(html.includes("&lt;img"), "escaped &lt;img must appear");
});

test("rejects oversized license base64 payload", async () => {
  const res = makeRes();
  const bigB64 = "A".repeat(15_000_000);
  await handler(makeReq("POST", { ...VALID_BODY, licenseBase64: bigB64 }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

// ─── Pre-approval decision tests ─────────────────────────────────────────────

test("decision is 'approved' for qualified applicant", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(res._body.decision, "approved");
});

test("decision is 'declined' when age is under 21", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, age: 19 }), res);
  assert.equal(res._body.decision, "declined");
});

test("decision is 'declined' when experience is less than 3 months", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, experience: "Less than 3 months" }), res);
  assert.equal(res._body.decision, "declined");
});

test("decision is 'review' when license is missing", async () => {
  sentMails.length = 0;
  const res = makeRes();
  const body = {
    name: "Jane Driver",
    phone: TEST_PHONE,
    age: 25,
    experience: "3–5 years",
    agreeTerms: true,
    agreeSmsConsent: true,
    agreeBackgroundCheck: true,
  };
  await handler(makeReq("POST", body), res);
  assert.equal(res._body.decision, "review");
});

test("returns 400 when terms are not agreed", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, agreeTerms: false }), res);
  assert.equal(res._status, 400);
  assert.ok(String(res._body.error || "").includes("required consents"));
});

test("owner email subject reflects submitted lifecycle instead of decision label", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.ok(
    sentMails[0].subject.toLowerCase().includes("identity verification pending"),
    `Expected subject to reflect lifecycle stage, got: ${sentMails[0].subject}`
  );
  assert.ok(!sentMails[0].subject.toLowerCase().includes("approved"));
});

// ─── SMS dispatch tests ───────────────────────────────────────────────────────

test("submit SMS asks applicant to complete identity verification", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMessages.length, 1);
  assert.ok(
    sentMessages[0].text.includes("complete identity verification"),
    `Expected lifecycle SMS body, got: ${sentMessages[0].text}`
  );
});

test("submit SMS stays lifecycle-based even when precheck decision is declined", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, age: 18 }), res);
  assert.equal(sentMessages.length, 1);
  assert.ok(
    sentMessages[0].text.includes("complete identity verification"),
    `Expected lifecycle SMS body, got: ${sentMessages[0].text}`
  );
  assert.ok(!sentMessages[0].text.includes("does not meet our current rental requirements"));
});

test("submit SMS no longer claims application is already under review", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  const body = {
    name: "Jane Driver",
    phone: TEST_PHONE,
    age: 25,
    experience: "3–5 years",
    agreeTerms: true,
    agreeSmsConsent: true,
    agreeBackgroundCheck: true,
  };
  await handler(makeReq("POST", body), res);
  assert.equal(sentMessages.length, 1);
  assert.ok(
    sentMessages[0].text.includes("complete identity verification"),
    `Expected lifecycle SMS body, got: ${sentMessages[0].text}`
  );
});

test("SMS is sent to applicant phone number", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMessages[0].to, "+13105550199");
});

test("SMS contains first name in lifecycle messaging", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, age: 18 }), res);
  assert.ok(
    sentMessages[0].text.includes("Jane"),
    `Expected first name in SMS, got: ${sentMessages[0].text}`
  );
});

// ─── Applicant lifecycle email tests ─────────────────────────────────────────

test("sends applicant email when email is provided", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.equal(res._status, 200);
  assert.equal(sentMails.length, 2, "Expected 2 emails: owner + applicant");
});

test("does not send applicant email when email is omitted", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMails.length, 1, "Expected only 1 email (owner) when no applicant email");
});

test("does not send applicant email for invalid email address", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, email: "not-an-email" }), res);
  assert.equal(sentMails.length, 1, "Expected only owner email for invalid applicant email");
});

test("applicant email is sent to applicant address", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.equal(sentMails[1].to, "jane@example.com");
});

test("owner email is still sent when applicant email is provided", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.equal(sentMails[0].to, "owner@test.invalid");
});

test("applicant submit email subject requests identity verification", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.equal(res._body.decision, "approved");
  assert.ok(
    sentMails[1].subject.toLowerCase().includes("identity verification"),
    `Expected lifecycle subject, got: ${sentMails[1].subject}`
  );
  assert.ok(!sentMails[1].subject.toLowerCase().includes("approved"));
});

test("applicant submit email subject stays lifecycle-based for review precheck", async () => {
  sentMails.length = 0;
  const res = makeRes();
  const body = { ...VALID_BODY_WITH_EMAIL, licenseBase64: undefined, licenseFileName: undefined, licenseMimeType: undefined };
  await handler(makeReq("POST", body), res);
  assert.equal(res._body.decision, "review");
  assert.ok(
    sentMails[1].subject.toLowerCase().includes("identity verification"),
    `Expected lifecycle subject, got: ${sentMails[1].subject}`
  );
});

test("applicant submit email stays lifecycle-based when precheck is declined", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY_WITH_EMAIL, age: 19 }), res);
  assert.equal(res._body.decision, "declined");
  assert.equal(sentMails.length, 2, "Expected owner + applicant decline emails");
  assert.equal(sentMails[1].to, "jane@example.com");
  assert.ok(
    sentMails[1].html.includes("complete secure identity verification"),
    `Expected lifecycle message in html, got: ${sentMails[1].html}`
  );
  assert.ok(!sentMails[1].html.includes("unable to approve"));
});

test("applicant email html contains applicant first name", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.ok(
    sentMails[1].html.includes("Jane"),
    `Expected first name in applicant email html`
  );
});

test("applicant submit email html does not contain booking-ready messaging", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.equal(res._body.decision, "approved");
  assert.ok(
    sentMails[1].html.includes("identity verification"),
    `Expected lifecycle next-step messaging in email`
  );
  assert.ok(!sentMails[1].html.includes("www.slytrans.com/cars"));
});

// ─── Verification link in email and SMS ───────────────────────────────────────

test("applicant submit email HTML contains verification link CTA when applicationId is available", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.ok(
    sentMails[1].html.includes("thank-you.html"),
    `Expected verification link in applicant email HTML, got: ${sentMails[1].html}`
  );
  assert.ok(
    sentMails[1].html.includes("from=resume"),
    `Expected from=resume in verification link`
  );
  assert.ok(
    sentMails[1].html.includes("token="),
    `Expected HMAC token in verification link`
  );
});

test("applicant submit email plain text contains verification link when applicationId is available", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.ok(
    sentMails[1].text.includes("thank-you.html"),
    `Expected verification URL in applicant email text, got: ${sentMails[1].text}`
  );
});

test("applicant submit SMS contains verification link when applicationId is available", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.ok(
    sentMessages[0].text.includes("thank-you.html"),
    `Expected verification URL in SMS, got: ${sentMessages[0].text}`
  );
  assert.ok(
    sentMessages[0].text.includes("from=resume"),
    `Expected from=resume in SMS link`
  );
  assert.ok(
    sentMessages[0].text.includes("token="),
    `Expected HMAC token in SMS link`
  );
});

test("verification link in applicant email points to the thank-you page and not the cars page", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.ok(sentMails[1].html.includes("slycarrentals.com/thank-you.html"));
  assert.ok(!sentMails[1].html.includes("slycarrentals.com/cars"));
});

// ─── Regression: verification link when applicationId is pre-provided ─────────
//
// When the frontend passes an applicationId from the create-renter-application
// step and the DB patch subsequently fails (e.g. transient Supabase error), the
// original applicationId must NOT be discarded.  The verification link in the
// email/SMS must still be present so the renter can reach identity verification.

test("verification link is included in applicant email even when DB patch fails and applicationId was pre-provided", async () => {
  sentMails.length = 0;
  const res = makeRes();
  // patchRenterApplicationById is mocked to return { ok: false } globally.
  // Supplying an applicationId triggers the patch path; the original ID must be
  // retained so the verification link can be built.
  await handler(makeReq("POST", { ...VALID_BODY_WITH_EMAIL, applicationId: "pre-created-app-uuid" }), res);
  assert.equal(res._status, 200);
  assert.equal(sentMails.length, 2, "Expected owner + applicant emails");
  const html = sentMails[1].html;
  assert.ok(html.includes("thank-you.html"), "Applicant email must contain verification link even after patch failure");
  assert.ok(html.includes("from=resume"),    "Verification link must include from=resume");
  assert.ok(html.includes("token="),         "Verification link must include HMAC token");
});

test("verification link is included in SMS even when DB patch fails and applicationId was pre-provided", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, applicationId: "pre-created-app-uuid" }), res);
  assert.equal(res._status, 200);
  const sms = sentMessages[0].text;
  assert.ok(sms.includes("thank-you.html"), "SMS must contain verification link even after patch failure");
  assert.ok(sms.includes("from=resume"),    "SMS verification link must include from=resume");
  assert.ok(sms.includes("token="),         "SMS verification link must include HMAC token");
});
