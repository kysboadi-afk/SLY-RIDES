// api/system-health-fix-sms.js
// Repairs missed SMS for active/overdue rentals by re-running the exact same
// processActiveRentals logic used by scheduled-reminders.js, but in repairMode
// (time-window guards are relaxed; sms_logs dedup is the sole gate).
//
// Called by the System Health "Fix Now" button for the smsDeliveryHealth check.
//
// ── Auth ───────────────────────────────────────────────────────────────────────
//   Admin POST: { secret: ADMIN_SECRET }
//   Cron POST:  Authorization: Bearer CRON_SECRET
//
// ── Response ───────────────────────────────────────────────────────────────────
// {
//   ok:        true,
//   processed: number,   — bookings evaluated
//   sent:      number,   — SMS successfully sent
//   skipped:   number,   — already covered (sms_logs hit)
//   message:   string,
// }

import { getSupabaseAdmin }                     from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import {
  processActiveRentals,
  loadBookingsFromSupabase,
} from "./scheduled-reminders.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ── Authentication ─────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || "";
  const cronSecret = process.env.CRON_SECRET;
  const isCronAuth = cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronAuth) {
    if (!isAdminConfigured()) {
      return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
    }
    const { secret } = req.body || {};
    if (!isAdminAuthorized(secret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // ── Dependencies check ─────────────────────────────────────────────────────
  const sb = getSupabaseAdmin();
  if (!sb) {
    console.error("[system-health-fix-sms] Supabase client not created — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
    return res.status(500).json({ error: "Supabase not configured." });
  }
  console.log("[system-health-fix-sms] Supabase client created — testing connectivity...");

  // Quick connectivity probe so any DB-level error is surfaced in the response
  // (not just buried in Vercel function logs) for easier admin diagnostics.
  const { error: probeErr } = await sb.from("bookings").select("booking_ref").limit(1);
  if (probeErr) {
    console.error("[system-health-fix-sms] Supabase connectivity probe failed:", probeErr.message, probeErr.code || "");
    return res.status(500).json({ error: `Supabase connectivity error: ${probeErr.message}` });
  }
  console.log("[system-health-fix-sms] Supabase connection OK");

  // All system-health notifications are disabled.
  return res.status(200).json({
    ok:        true,
    skipped:   true,
    processed: 0,
    sent:      0,
    message:   "System health notifications are disabled — no SMS sent.",
  });

  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) {
    return res.status(200).json({
      ok:        true,
      skipped:   true,
      processed: 0,
      sent:      0,
      message:   "TextMagic not configured — no SMS sent.",
    });
  }

  // ── Load bookings from Supabase (same source as scheduled-reminders) ───────
  // No fallback to bookings.json — this fix endpoint requires live Supabase data.
  const allBookings = await loadBookingsFromSupabase(sb);
  if (allBookings === null) {
    console.error("[system-health-fix-sms] loadBookingsFromSupabase returned null — see Vercel logs for query details");
    return res.status(500).json({ error: "Database query error while loading bookings. This may be a permissions issue or a missing column — check Vercel function logs (tagged [system-health-fix-sms]) for the specific error." });
  }

  const totalBookings = Object.values(allBookings).flat().length;
  console.log(`[system-health-fix-sms] Loaded ${totalBookings} booking(s) from Supabase`);

  // Count only active/overdue bookings (the set processActiveRentals will touch)
  const processed = Object.values(allBookings)
    .flat()
    .filter((b) => b.status === "active_rental" || b.status === "active" || b.status === "overdue")
    .length;

  // ── Run repair pass ────────────────────────────────────────────────────────
  // repairMode: true — relaxes narrow time-window guards so any missed critical
  // SMS is sent immediately.  sms_logs dedup (DB UNIQUE constraint) prevents
  // duplicates.  criticalOnly: false — all eligible template types are checked.
  const sentMarks = [];
  await processActiveRentals(allBookings, new Date(), sentMarks, false, { repairMode: true });

  const smsSent = sentMarks.filter((m) => !m.key.startsWith("_")).length;

  console.log(
    `[system-health-fix-sms] repairMode complete: processed=${processed} sent=${smsSent}`
  );

  return res.status(200).json({
    ok:        true,
    processed,
    sent:      smsSent,
    skipped:   processed - smsSent,
    message:   smsSent > 0
      ? `Sent ${smsSent} missing SMS across ${processed} active rental${processed !== 1 ? "s" : ""}.`
      : `No missing SMS found across ${processed} active rental${processed !== 1 ? "s" : ""}.`,
  });
}
