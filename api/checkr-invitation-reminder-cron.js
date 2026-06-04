import { getSupabaseAdmin } from "./_supabase.js";
import { dispatchSms } from "./_sms-dispatcher.js";
import { patchRenterApplicationCheckrById } from "./_renter-applications.js";
import { maybeSkipScheduledAutomation } from "./_runtime-environment.js";

const DEFAULT_REMINDER_HOURS = 6;
const BATCH_LIMIT = 50;
const REQUIRED_REMINDER_COLUMNS = [
  "checkr_invitation_url",
  "checkr_invitation_sent_at",
  "checkr_invitation_reminder_sent_at",
];

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function cutoffIso(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function missingReminderColumns(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  if (!msg) return [];
  return REQUIRED_REMINDER_COLUMNS.filter((column) =>
    msg.includes(`column renter_applications.${column} does not exist`) ||
    msg.includes(`column "${column}" does not exist`));
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  if (req.method === "POST") {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token || (token !== process.env.ADMIN_SECRET && token !== process.env.CRON_SECRET)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (maybeSkipScheduledAutomation(req, res, { endpoint: "checkr-invitation-reminder-cron" })) return;

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(200).json({ skipped: true, reason: "supabase_unavailable" });
  }

  const hours = toPositiveInt(process.env.CHECKR_INVITATION_REMINDER_HOURS, DEFAULT_REMINDER_HOURS);
  const olderThanIso = cutoffIso(hours);

  const { data, error } = await sb
    .from("renter_applications")
    .select("id, name, phone, application_status, checkr_report_status, checkr_invitation_url, checkr_invitation_sent_at")
    .in("application_status", ["submitted", "under_review", "needs_info"])
    .in("checkr_report_status", ["invitation_sent", "pending"])
    .not("checkr_invitation_url", "is", null)
    .is("checkr_invitation_reminder_sent_at", null)
    .lte("checkr_invitation_sent_at", olderThanIso)
    .order("checkr_invitation_sent_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    const missingColumns = missingReminderColumns(error);
    if (missingColumns.length) {
      console.warn("checkr-invitation-reminder-cron skipped: schema missing required columns", { missingColumns });
      return res.status(200).json({ skipped: true, reason: "schema_missing_columns", missingColumns });
    }
    console.error("checkr-invitation-reminder-cron query failed:", error.message || error);
    return res.status(200).json({ skipped: true, reason: "query_failed" });
  }

  const candidates = Array.isArray(data) ? data : [];
  let reminded = 0;
  let failed = 0;

  for (const app of candidates) {
    const phone = String(app.phone || "").trim();
    const invitationUrl = String(app.checkr_invitation_url || "").trim();
    if (!phone || !invitationUrl) continue;

    const smsResult = await dispatchSms({
      phone,
      body: [
        "SLY Rides reminder: Your background screening is still pending.",
        "Please complete it now to continue your rental approval:",
        invitationUrl,
        "Questions? Reply here or call (844) 511-4059",
      ].join("\n"),
      templateKey: "checkr_invitation_reminder",
      source: "checkr_invitation_reminder_cron",
      dedupe: false,
      throwOnError: false,
    });

    if (smsResult?.sent) {
      reminded += 1;
      await patchRenterApplicationCheckrById(app.id, {
        checkrInvitationReminderSentAt: new Date().toISOString(),
      }).catch(() => {});
    } else {
      failed += 1;
    }
  }

  const summary = {
    scanned: candidates.length,
    reminded,
    failed,
    reminderHours: hours,
  };
  console.info("checkr-invitation-reminder-cron completed", summary);
  return res.status(200).json(summary);
}
