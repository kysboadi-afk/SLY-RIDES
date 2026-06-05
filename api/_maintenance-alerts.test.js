import { test } from "node:test";
import assert from "node:assert/strict";

import { wasServiceAlertSent } from "./maintenance-alerts.js";

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
