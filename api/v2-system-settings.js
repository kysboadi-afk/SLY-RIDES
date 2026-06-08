// api/v2-system-settings.js
// SLYTRANS Fleet Control v2 — System settings management endpoint.
// Admin-controlled key/value configuration. Old booking/payment flows are unaffected.
//
// POST /api/v2-system-settings
// Actions:
//   list    — { secret, action:"list", category? }
//   get     — { secret, action:"get", key }
//   set     — { secret, action:"set", key, value, description?, category? }
//   delete  — { secret, action:"delete", key }
//
// Error contract:
//   • list/get return hardcoded defaults when Supabase is not configured or table missing.
//   • set/delete return 503 when Supabase is unavailable.
//   • When the table exists but is empty, defaults are auto-seeded on first list call.

import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { MAINTENANCE_DEFAULT_SETTINGS } from "./_system-settings-defaults.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

/** Returns the Supabase client or null if not configured. */
function getSupabase() {
  return getSupabaseAdmin();
}

// Hardcoded defaults matching the migration 0003 seed values.
// Used when Supabase is unavailable or the table is empty.
const DEFAULT_SETTINGS = [
  { key: "la_tax_rate",                 value: 0.1025,  description: "Los Angeles combined sales tax rate",             category: "tax" },
  // Economy car rates — Camry 2012 AND Camry 2013 SE share identical rates
  { key: "camry_daily_rate",            value: 55,      description: "Economy car (Camry 2012 & Camry 2013 SE) daily rate — same for both (USD)", category: "pricing" },
  { key: "camry_weekly_rate",           value: 350,     description: "Economy car (Camry 2012 & Camry 2013 SE) weekly rate — same for both (USD)", category: "pricing" },
  { key: "camry_biweekly_rate",         value: 650,     description: "Economy car (Camry 2012 & Camry 2013 SE) bi-weekly rate — same for both (USD)", category: "pricing" },
  { key: "camry_monthly_rate",          value: 1300,    description: "Economy car (Camry 2012 & Camry 2013 SE) monthly rate — same for both (USD)", category: "pricing" },
  // Deposits / booking fees
  { key: "camry_booking_deposit",       value: 50,      description: "Economy car (Camry 2012 & Camry 2013 SE) non-refundable booking deposit — same for both (USD)", category: "pricing" },
  { key: "booking_change_fee",          value: 25,      description: "Fee charged for each booking change after the first free change (USD)", category: "pricing" },
  // Late fees
  { key: "late_fee_short",              value: 25,      description: "Late fee assessed after the 30-minute grace period (USD, fixed)", category: "pricing" },
  { key: "late_fee_extended",           value: 25,      description: "Late fee assessed after the 3-hour late window (USD, fixed for all vehicles)", category: "pricing" },
  { key: "auto_block_dates_on_approve", value: true,    description: "Auto-block vehicle dates when booking approved",  category: "automation" },
  { key: "auto_create_revenue_on_pay",  value: true,    description: "Auto-create revenue record when payment received",category: "automation" },
  { key: "auto_update_customer_stats",  value: true,    description: "Auto-update customer stats on booking events",    category: "automation" },
  { key: "auto_activate_on_pickup",     value: true,    description: "Auto-transition booking to active rental when pickup time arrives (runs on payment and every 15 min)", category: "automation" },
  { key: "notify_sms_on_approve",       value: true,    description: "Send SMS to customer when booking approved",      category: "notification" },
  { key: "notify_email_on_approve",     value: true,    description: "Send email to customer when booking approved",    category: "notification" },
  { key: "overdue_grace_period_hours",  value: 2,       description: "Hours after return time before booking flagged overdue", category: "automation" },
  { key: "violation_admin_fee",         value: 25,      description: "Admin processing fee added to violation ticket charge (USD)", category: "fees" },
  { key: "balance_reminder_enabled",    value: false,   description: "Enable automated balance due/overdue SMS reminders", category: "notification" },
  { key: "balance_overdue_threshold_days", value: 0,    description: "Days past due before the first overdue SMS reminder fires (0 = same day)", category: "notification" },
  { key: "balance_overdue_30_enabled",  value: true,    description: "Send a reminder SMS at 30 days past due", category: "notification" },
  { key: "balance_overdue_60_enabled",  value: true,    description: "Send a reminder SMS at 60 days past due (escalation notice)", category: "notification" },
  // Extension risk gating (Phase 2)
  { key: "extension_partial_block_enabled", value: true,  description: "Enable Phase 2 extension risk gating — blocks partial extensions that exceed exposure or count limits", category: "extension_policy" },
  { key: "extension_max_unpaid_exposure",   value: 500,   description: "Maximum total unpaid balance (USD) from partial extensions allowed per booking before new partials are blocked", category: "extension_policy" },
  { key: "extension_max_partial_count",     value: 3,     description: "Maximum number of partial-payment extensions allowed per booking", category: "extension_policy" },
  { key: "extension_partial_min_pct",       value: 50,    description: "Minimum percentage of extension cost that must be paid upfront for a partial extension (used by Phase 1 minimum enforcement)", category: "extension_policy" },
  { key: "extension_overdue_block_partial", value: true,  description: "Block partial-payment extensions when the booking status is overdue", category: "extension_policy" },
  { key: "extension_allow_override",        value: true,  description: "Allow admin-set extension_risk_override on individual bookings to override the Phase 2 risk gate", category: "extension_policy" },
  // Extension operational automation (Phase 4 foundation)
  { key: "extension_risk_automation_enabled",                value: false, description: "Enable Phase 4 operational extension risk-state automation for car rentals only", category: "extension_automation" },
  { key: "extension_risk_alerts_enabled",                    value: true,  description: "Emit Phase 4 operational alerts for car-rental extension risk signals", category: "extension_automation" },
  { key: "extension_risk_warning_exposure_pct",              value: 80,    description: "Exposure percentage of the unpaid extension limit that should trigger a warning-state recommendation", category: "extension_automation" },
  { key: "extension_risk_warning_partial_count",             value: 2,     description: "Partial-extension count that should trigger a warning-state recommendation", category: "extension_automation" },
  { key: "extension_risk_warning_failed_payment_count",      value: 1,     description: "Failed extension-payment count that should trigger a warning-state recommendation", category: "extension_automation" },
  { key: "extension_risk_restricted_partial_count",          value: 3,     description: "Partial-extension count that should trigger restricted-extension recommendations", category: "extension_automation" },
  { key: "extension_risk_restricted_overdue_count",          value: 2,     description: "Overdue-behavior count that should trigger restricted-extension recommendations", category: "extension_automation" },
  { key: "extension_risk_manual_review_exposure",            value: 500,   description: "Projected unpaid extension exposure (USD) that should recommend manual review", category: "extension_automation" },
  { key: "extension_risk_manual_review_failed_payment_count",value: 2,     description: "Failed extension-payment count that should recommend manual review", category: "extension_automation" },
  { key: "extension_risk_full_payment_required_exposure",    value: 750,   description: "Projected unpaid extension exposure (USD) that should recommend full payment before further extensions", category: "extension_automation" },
  { key: "extension_risk_full_payment_required_overdue_count", value: 3,   description: "Overdue-behavior count that should recommend a full-payment-required state", category: "extension_automation" },
  { key: "extension_risk_abnormal_frequency_count",          value: 4,     description: "Extension frequency threshold that should trigger abnormal-frequency alerts", category: "extension_automation" },
  { key: "extension_risk_override_alert_threshold",          value: 3,     description: "Override-usage threshold that should trigger repeated-override alerts", category: "extension_automation" },
  { key: "extension_risk_excessive_stack_count",             value: 4,     description: "Extension stacking threshold that should recommend restricted-extension handling", category: "extension_automation" },
  ...MAINTENANCE_DEFAULT_SETTINGS,
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!isAdminConfigured())
    return res.status(500).json({ error: "ADMIN_SECRET not configured" });

  const body = req.body || {};
  const { secret, action } = body;
  if (!isAdminAuthorized(secret))
    return res.status(401).json({ error: "Unauthorized" });

  const sb = getSupabase();

  try {
    if (!action || action === "list") {
      // Return hardcoded defaults when Supabase is not configured
      if (!sb) return res.status(200).json({ settings: DEFAULT_SETTINGS });

      try {
        const { data, error } = await sb.from("system_settings").select("*").order("category").order("key");
        if (error) {
          // Table may not exist yet — return defaults so the Settings page is usable
          console.error("v2-system-settings list error:", error.message);
          return res.status(200).json({ settings: DEFAULT_SETTINGS });
        }

        let effectiveSettings = data || [];
        const existingKeys = new Set(effectiveSettings.map((row) => String(row?.key || "")));
        const missingDefaults = DEFAULT_SETTINGS.filter((row) => !existingKeys.has(String(row.key)));

        // Backfill any missing defaults (including first-run empty-table cases) so
        // new system-setting keys become visible without manual SQL migrations.
        if (missingDefaults.length > 0) {
          const seedRecords = missingDefaults.map((s) => ({
            key:         s.key,
            value:       s.value,
            description: s.description,
            category:    s.category,
            updated_at:  new Date().toISOString(),
            updated_by:  "system",
          }));
          const { error: seedErr } = await sb.from("system_settings")
            .upsert(seedRecords, { onConflict: "key", ignoreDuplicates: true });
          if (seedErr) {
            console.error("v2-system-settings seed error (non-fatal):", seedErr.message);
          }
          // Re-fetch (or fall back to in-memory defaults on seed failure)
          const { data: seeded, error: refetchErr } = await sb.from("system_settings")
            .select("*").order("category").order("key");
          if (!refetchErr && seeded) {
            effectiveSettings = seeded;
          } else if (!effectiveSettings.length) {
            effectiveSettings = DEFAULT_SETTINGS;
          }
        }

        if (body.category) {
          effectiveSettings = effectiveSettings.filter((s) => String(s?.category || "") === String(body.category));
        }

        return res.status(200).json({ settings: effectiveSettings });
      } catch (qErr) {
        console.error("v2-system-settings list query error:", qErr);
        return res.status(200).json({ settings: DEFAULT_SETTINGS });
      }
    }

    if (action === "get") {
      if (!body.key) return res.status(400).json({ error: "key is required" });
      if (!sb) {
        const def = DEFAULT_SETTINGS.find((s) => s.key === body.key);
        if (def) return res.status(200).json({ setting: def });
        return res.status(404).json({ error: "Setting not found" });
      }
      const { data, error } = await sb.from("system_settings").select("*").eq("key", body.key).single();
      if (error) throw error;
      return res.status(200).json({ setting: data });
    }

    if (action === "set") {
      const { key, value } = body;
      if (!key || value === undefined || value === null)
        return res.status(400).json({ error: "key and value are required and cannot be empty" });
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot save setting" });
      const record = {
        key:         String(key).trim(),
        value,
        updated_at:  new Date().toISOString(),
        updated_by:  "admin",
      };
      if (body.description) record.description = body.description;
      if (body.category)    record.category    = body.category;

      // Try UPDATE first (for existing rows); if no rows updated, INSERT the new row.
      // This avoids PostgREST upsert compatibility issues with keyword column names.
      const { data: updatedData, error: updateErr } = await sb
        .from("system_settings")
        .update(record)
        .eq("key", record.key)
        .select();

      if (updateErr) {
        // If the table is missing, attempt to auto-seed all defaults so that
        // subsequent saves work without requiring a manual Supabase migration.
        // (The seed only succeeds when the table has just been created and is
        // empty; if the table is truly absent this upsert will also fail and
        // the schema error will be surfaced to the admin.)
        if (isSchemaError(updateErr)) {
          const seedRecords = DEFAULT_SETTINGS.map((s) => ({
            key:         s.key,
            value:       s.value,
            description: s.description,
            category:    s.category,
            updated_at:  new Date().toISOString(),
            updated_by:  "system",
          }));
      await sb.from("system_settings")
            .upsert(seedRecords, { onConflict: "key", ignoreDuplicates: true })
            .select().then(({ error: seedErr }) => {
              if (seedErr) console.error("v2-system-settings auto-seed error:", seedErr.message);
            });

          // Retry the original update after seeding
          const { data: retryData, error: retryErr } = await sb
            .from("system_settings")
            .update(record)
            .eq("key", record.key)
            .select();
          if (retryErr) throw retryErr;

          if (retryData && retryData.length > 0) {
            return res.status(200).json({ setting: retryData[0] });
          }
          // Fall through to INSERT if still no row
          const { data: retryInsert, error: retryInsertErr } = await sb
            .from("system_settings")
            .insert(record)
            .select()
            .single();
          if (retryInsertErr) throw retryInsertErr;
          return res.status(200).json({ setting: retryInsert });
        }
        throw updateErr;
      }

      let finalData;
      if (updatedData && updatedData.length > 0) {
        finalData = updatedData[0];
      } else {
        // Row didn't exist — INSERT it
        const { data: insertedData, error: insertErr } = await sb
          .from("system_settings")
          .insert(record)
          .select()
          .single();
        if (insertErr) throw insertErr;
        finalData = insertedData;
      }

      return res.status(200).json({ setting: finalData });
    }

    if (action === "delete") {
      if (!body.key) return res.status(400).json({ error: "key is required" });
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot delete setting" });
      const { error } = await sb.from("system_settings").delete().eq("key", body.key);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-system-settings error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
