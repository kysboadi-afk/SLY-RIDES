import { test } from "node:test";
import assert from "node:assert/strict";

import { wasServiceAlertSent, resolveBookingIdentity, bookingMatchesIdentity } from "./maintenance-alerts.js";

test("wasServiceAlertSent: returns true when booking smsSentAt already has the template key", async () => {
  const sent = await wasServiceAlertSent(
    null,
    { smsSentAt: { maint_oil_warn: "2026-06-05T15:00:00.000Z" } },
    "bk-maint-001",
    "maint_oil_warn"
  );

  assert.equal(sent, true);
});

test("wasServiceAlertSent: returns true when sms_logs already has the service alert", async () => {
  const sb = buildSmsLogLookupClient({
    booking_id:          "bk-maint-002",
    template_key:        "maint_oil_warn",
    return_date_at_send: "1970-01-01",
  });

  const sent = await wasServiceAlertSent(
    sb,
    { smsSentAt: {} },
    "bk-maint-002",
    "maint_oil_warn"
  );

  assert.equal(sent, true);
});

test("wasServiceAlertSent: returns true when the key was prefetched from sms_logs", async () => {
  const sent = await wasServiceAlertSent(
    null,
    { smsSentAt: {} },
    "bk-maint-002",
    "maint_oil_warn",
    new Set(["maint_oil_warn"])
  );

  assert.equal(sent, true);
});

test("wasServiceAlertSent: returns false when neither smsSentAt nor sms_logs has a matching alert", async () => {
  const sb = buildSmsLogLookupClient(null);

  const sent = await wasServiceAlertSent(
    sb,
    { smsSentAt: {} },
    "bk-maint-003",
    "maint_oil_warn"
  );

  assert.equal(sent, false);
});

// ── Regression: active booking with missing booking_ref ────────────────────────

test("resolveBookingIdentity: falls back to payment_intent_id when booking_ref is absent", () => {
  const id = resolveBookingIdentity({ payment_intent_id: "pi_abc123" });
  assert.equal(id, "pi_abc123");
});

test("resolveBookingIdentity: falls back to id when both booking_ref and payment_intent_id are absent", () => {
  const id = resolveBookingIdentity({ id: "row-uuid-001" });
  assert.equal(id, "row-uuid-001");
});

test("resolveBookingIdentity: prefers booking_ref over payment_intent_id when both are present", () => {
  const id = resolveBookingIdentity({ booking_ref: "BK-001", payment_intent_id: "pi_abc123" });
  assert.equal(id, "BK-001");
});

test("resolveBookingIdentity: returns null when all identity fields are absent (booking will be skipped)", () => {
  const id = resolveBookingIdentity({});
  assert.equal(id, null);
});

test("resolveBookingIdentity: returns null for whitespace-only booking_ref with no fallback", () => {
  const id = resolveBookingIdentity({ booking_ref: "   " });
  assert.equal(id, null);
});

test("bookingMatchesIdentity: matches booking via payment_intent_id when booking_ref is absent", () => {
  const booking = { payment_intent_id: "pi_abc123" };
  assert.equal(bookingMatchesIdentity(booking, "pi_abc123"), true);
});

test("bookingMatchesIdentity: matches booking via id when booking_ref and payment_intent_id are absent", () => {
  const booking = { id: "row-uuid-001" };
  assert.equal(bookingMatchesIdentity(booking, "row-uuid-001"), true);
});

test("bookingMatchesIdentity: returns false when bookingId matches no field on the booking", () => {
  const booking = { id: "row-uuid-001", payment_intent_id: "pi_abc123" };
  assert.equal(bookingMatchesIdentity(booking, "BK-NOMATCH"), false);
});


function buildSmsLogLookupClient(row) {
  return {
    from(table) {
      assert.equal(table, "sms_logs");
      const filters = {};
      const chain = {
        select() {
          return chain;
        },
        eq(column, value) {
          filters[column] = value;
          return chain;
        },
        async maybeSingle() {
          if (
            row &&
            row.booking_id === filters.booking_id &&
            row.template_key === filters.template_key &&
            row.return_date_at_send === filters.return_date_at_send
          ) {
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };
}
