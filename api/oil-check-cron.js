// api/oil-check-cron.js
// Vercel cron — Oil Check Compliance trigger and escalation system.
//
// GET  /api/oil-check-cron  — Vercel cron trigger (no auth required from Vercel)
// POST /api/oil-check-cron  — Manual trigger; requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// Run schedule (vercel.json):  0 17 * * *  (10 AM PDT / 9 AM PST — within 8 AM–7 PM LA window)
//
// Logic per active booking:
//   1. Look up the vehicle's vehicle_state for current mileage and last check info.
//   2. Compute days_since_check and miles_since_check.
//   3. Trigger if: rental_duration >= 3 days AND (days_since_check >= 5 OR miles_since_check >= 500)
//   4. Anti-spam: max 1 SMS per booking per 24 h.
//   5. Escalation:
//        oil_check_missed_count = 0 + no reply after 24 h → send 24h reminder, set missed_count = 1
//        oil_check_missed_count = 1 + no reply after 24 h → send 48h final notice, set missed_count = 2
//        oil_check_missed_count >= 2 → stop messaging
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY

import { sendSms } from "./_textmagic.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { laHour, isoDateInLA } from "./_time.js";
import { getRentalState } from "./_rental-state.js";
import { getSmsPriority } from "./_sms-priority.js";
import { isSchemaError } from "./_error-helpers.js";
import { maybeSkipScheduledAutomation } from "./_runtime-environment.js";
import { loadNumericSetting } from "./_settings.js";
import { MAINTENANCE_DEFAULTS } from "./_system-settings-defaults.js";
import {
  computeSmsScoreWithBreakdown,
  computeEffectiveThreshold,
  isSuppressedByProximity,
  fetchRecentSmsLogs,
  buildSmsContext,
} from "./_sms-scoring.js";

// ── SMS copy ──────────────────────────────────────────────────────────────────

// TextMagic does not relay MMS media in inbound webhooks, so the outbound
// messages must not instruct customers to send a photo — the webhook will
// accept keyword-only replies and store oil_check_photo_url = null.
const MSG_OIL_CHECK_REQUEST =
  "SLY RENTALS: Oil check required.\n\n" +
  "Park on level ground. Pull the engine dipstick, wipe it, reinsert, then check the oil level.\n\n" +
  "Reply:\n\n" +
  "FULL (near top line)\n" +
  "MID (between lines)\n" +
  "LOW (below safe line)";

// Merged message — sent when the oil-check trigger fires AND the vehicle is
// also due for its configured oil-change mileage interval. Combines both requests into a
// single SMS so the renter receives only one message.
const MSG_OIL_CHECK_MERGED =
  "Quick vehicle check required.\n\n" +
  "Please check oil level (dipstick) and note vehicle condition.\n\n" +
  "Reply FULL, MID, or LOW.";

const MSG_OIL_CHECK_REMINDER =
  "Reminder: Oil check still required.\n\n" +
  "Reply FULL, MID, or LOW.\n\n" +
  "This is required to keep your rental active.";

const MSG_OIL_CHECK_FINAL =
  "Final notice: Oil check not confirmed.\n\n" +
  "Reply FULL, MID, or LOW now to avoid interruption.";

// Messages for mileage-based triggers (avg miles/day thresholds).
const MSG_OIL_CHECK_RISK =
  "SLY RENTALS: High daily mileage detected on your rental.\n\n" +
  "Please check the oil level — pull the dipstick, wipe, reinsert, then check.\n\n" +
  "Reply FULL, MID, or LOW.";

const MSG_MAINTENANCE_REQUIRED =
  "SLY RENTALS: Maintenance required due to high vehicle usage.\n\n" +
  "Please check the oil immediately (reply FULL, MID, or LOW) and contact us for next steps.";

// ── Thresholds ────────────────────────────────────────────────────────────────

const MS_PER_DAY                    = 86_400_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Elapsed hours between two ISO timestamps.
 * @param {string} earlier
 * @param {string} later  defaults to now
 */
function hoursSince(earlier, later = new Date().toISOString()) {
  return (new Date(later) - new Date(earlier)) / 3_600_000;
}

function resolveOilChangeIntervalMiles(raw) {
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return MAINTENANCE_DEFAULTS.maintenance_oil_interval_miles;
  return parsed;
}

/**
 * Log a sent oil-check SMS to sms_logs so other crons (scheduled-reminders,
 * maintenance-alerts) can see it via the cross-cron cooldown check.
 *
 * opts.sentinelDate = true  → upsert with return_date_at_send='1970-01-01'.
 *   Use this for once-per-booking alert types (OIL_CHECK_RISK,
 *   MAINTENANCE_REQUIRED) so the DB-level unique constraint prevents duplicate
 *   rows across cron runs.
 *
 * opts.sentinelDate = false (default) → insert with today's real calendar date.
 *   Use this for compliance escalation keys (OIL_CHECK_REQUEST,
 *   OIL_CHECK_REMINDER, OIL_CHECK_FINAL) where multiple rows per booking are
 *   expected and auditable.
 *
 * Non-fatal: errors are only logged.
 * @param {object} extraMetadata - optional additional fields (e.g. { score })
 * @param {{ sentinelDate?: boolean }} opts
 */
async function logOilCheckToSupabase(sb, bookingRef, templateKey, extraMetadata = {}, opts = {}) {
  if (!sb || !bookingRef) return { inserted: true };
  try {
    const returnDateAtSend = opts.sentinelDate
      ? "1970-01-01"
      : isoDateInLA(); // YYYY-MM-DD
    const row = {
      booking_id:          bookingRef,
      template_key:        templateKey,
      return_date_at_send: returnDateAtSend,
      metadata:            { priority: getSmsPriority(templateKey), ...extraMetadata },
    };
    if (opts.sentinelDate) {
      // ignoreDuplicates: true → DB does nothing on conflict and returns no rows.
      // Returning { inserted: false } lets the caller treat a conflict as a
      // successful no-op (already sent) rather than re-sending.
      const { data, error } = await sb
        .from("sms_logs")
        .upsert(row, { onConflict: "booking_id,template_key,return_date_at_send", ignoreDuplicates: true })
        .select("id");
      if (error) {
        console.warn("oil-check-cron: sms_logs write failed (non-fatal):", error.message);
        return { inserted: true }; // fail open
      }
      return { inserted: !!(data && data.length > 0) };
    } else {
      const { error } = await sb.from("sms_logs").insert(row);
      if (error) {
        console.warn("oil-check-cron: sms_logs write failed (non-fatal):", error.message);
      }
      return { inserted: true };
    }
  } catch (err) {
    console.warn("oil-check-cron: sms_logs write failed (non-fatal):", err.message);
    return { inserted: true }; // fail open
  }
}

/**
 * Returns true if a mileage-based alert (OIL_CHECK_RISK or MAINTENANCE_REQUIRED)
 * has already been sent for this booking.  These alerts use the sentinel
 * return_date_at_send='1970-01-01' so they fire at most once per booking
 * regardless of how many cron runs occur.
 *
 * Fails open: if the DB query errors, returns false so the caller can proceed
 * with its own scoring/spam guards rather than silently suppressing the send.
 *
 * @param {object} sb          - Supabase admin client
 * @param {string} bookingRef  - booking_ref (bk-...)
 * @param {string} templateKey - 'OIL_CHECK_RISK' | 'MAINTENANCE_REQUIRED'
 * @returns {Promise<boolean>}
 */
async function hasMileageAlertBeenSent(sb, bookingRef, templateKey) {
  if (!sb || !bookingRef) return false;
  try {
    const { data, error } = await sb
      .from("sms_logs")
      .select("id")
      .eq("booking_id", bookingRef)
      .eq("template_key", templateKey)
      .eq("return_date_at_send", "1970-01-01")
      .maybeSingle();
    if (error) {
      console.warn("oil-check-cron: sms_logs dedup check failed (non-fatal):", error.message);
      return false;
    }
    return !!data;
  } catch (err) {
    console.warn("oil-check-cron: sms_logs dedup check failed (non-fatal):", err.message);
    return false;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Manual POST requires ADMIN_SECRET or CRON_SECRET
  if (req.method === "POST") {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (
      !token ||
      (token !== process.env.ADMIN_SECRET && token !== process.env.CRON_SECRET)
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (maybeSkipScheduledAutomation(req, res, { endpoint: "oil-check-cron" })) return;

  const [
    minRentalDays,
    daysSinceCheckThreshold,
    milesSinceCheckThreshold,
    cooldownHours,
    windowStartHour,
    windowEndHour,
    escalateAfterHours,
    avgMilesOilRiskThreshold,
    avgMilesMaintReqThreshold,
  ] = await Promise.all([
    loadNumericSetting("oil_check_min_rental_days", MAINTENANCE_DEFAULTS.oil_check_min_rental_days),
    loadNumericSetting("oil_check_days_since_check", MAINTENANCE_DEFAULTS.oil_check_days_since_check),
    loadNumericSetting("oil_check_miles_interval", MAINTENANCE_DEFAULTS.oil_check_miles_interval),
    loadNumericSetting("oil_check_cooldown_hours", MAINTENANCE_DEFAULTS.oil_check_cooldown_hours),
    loadNumericSetting("oil_check_window_start_hour", MAINTENANCE_DEFAULTS.oil_check_window_start_hour),
    loadNumericSetting("oil_check_window_end_hour", MAINTENANCE_DEFAULTS.oil_check_window_end_hour),
    loadNumericSetting("oil_check_escalation_delay_hours", MAINTENANCE_DEFAULTS.oil_check_escalation_delay_hours),
    loadNumericSetting("oil_check_avg_miles_risk_threshold", MAINTENANCE_DEFAULTS.oil_check_avg_miles_risk_threshold),
    loadNumericSetting("oil_check_avg_miles_maintenance_required_threshold", MAINTENANCE_DEFAULTS.oil_check_avg_miles_maintenance_required_threshold),
  ]);

  // Enforce 8 AM – 7 PM LA send window for cron-triggered runs.
  // Manual POST bypasses the window to allow out-of-hours testing.
  if (req.method === "GET") {
    const hour = laHour();
    if (hour < windowStartHour || hour >= windowEndHour) {
      return res.status(200).json({
        skipped: true,
        reason:  `Outside send window (${windowStartHour}:00–${windowEndHour}:00 LA). Current LA hour: ${hour}.`,
      });
    }
  }

  const startedAt = Date.now();

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(200).json({
      skipped:     true,
      reason:      "Supabase not configured",
      duration_ms: Date.now() - startedAt,
    });
  }

  // ── Load all active bookings ───────────────────────────────────────────────
  const { data: bookings, error: bookingsErr } = await sb
    .from("bookings")
    .select(
      "id, booking_ref, vehicle_id, customer_phone, " +
      "pickup_date, return_date, return_time, " +
      "last_oil_check_at, oil_check_required, oil_check_last_request, oil_check_missed_count"
    )
    .in("status", ["active", "active_rental"])
    .not("customer_phone", "is", null);

  if (bookingsErr) {
    console.error("oil-check-cron: bookings query failed:", bookingsErr.message);
    return res.status(200).json({
      skipped:     true,
      reason:      bookingsErr.message,
      duration_ms: Date.now() - startedAt,
    });
  }

  if (!bookings || bookings.length === 0) {
    return res.status(200).json({
      triggered:   0,
      escalated:   0,
      skipped:     false,
      duration_ms: Date.now() - startedAt,
    });
  }

  // ── Load vehicle_state for all relevant vehicles ──────────────────────────
  const vehicleIds = [...new Set(bookings.map((b) => b.vehicle_id).filter(Boolean))];

  const { data: vStates, error: vsErr } = await sb
    .from("vehicle_state")
    .select("vehicle_id, last_oil_check_at, last_oil_check_mileage, current_mileage")
    .in("vehicle_id", vehicleIds);

  const missingVehicleStateSchema = !!vsErr && isSchemaError(vsErr);
  if (vsErr) {
    if (!missingVehicleStateSchema) {
      console.error("oil-check-cron: vehicle_state query failed:", vsErr.message);
      return res.status(200).json({
        skipped:     true,
        reason:      vsErr.message,
        duration_ms: Date.now() - startedAt,
      });
    }
    console.warn("oil-check-cron: vehicle_state unavailable, falling back to bookings.last_oil_check_at and vehicles.mileage");
  }

  const stateByVehicle = {};
  for (const vs of vStates || []) {
    stateByVehicle[vs.vehicle_id] = vs;
  }

  // ── Load vehicle service-mileage data (for merged-message detection) ───────
  // Used to determine whether a vehicle-specific oil-change mileage interval is due at the time
  // of the oil-check trigger so that both requests can be merged into one SMS.
  const { data: vehicleRows } = await sb
    .from("vehicles")
    .select("vehicle_id, mileage, last_oil_change_mileage, data")
    .in("vehicle_id", vehicleIds);

  const vehicleByVehicle = {};
  for (const v of vehicleRows || []) {
    vehicleByVehicle[v.vehicle_id] = v;
    if (missingVehicleStateSchema && !stateByVehicle[v.vehicle_id]) {
      stateByVehicle[v.vehicle_id] = {
        vehicle_id: v.vehicle_id,
        current_mileage: v.mileage ?? null,
        last_oil_check_at: null,
        last_oil_check_mileage: null,
      };
    }
  }

  // ── Load start_mileage for open trips (mileage-based trigger) ────────────
  // Each active booking may have an open trips row (end_mileage IS NULL) that
  // records the odometer reading at rental activation.  Combined with the live
  // current_mileage from vehicle_state this gives us avgMilesPerDay.
  const bookingRefs = bookings.map((b) => b.booking_ref).filter(Boolean);
  const { data: activeTrips } = await sb
    .from("trips")
    .select("booking_id, start_mileage")
    .in("booking_id", bookingRefs)
    .is("end_mileage", null);

  const startMileageByRef = {};
  for (const t of activeTrips || []) {
    if (t.booking_id && t.start_mileage != null) {
      startMileageByRef[t.booking_id] = Number(t.start_mileage);
    }
  }

  // ── Dedup: track phones contacted this run (max 1 SMS per phone per 24 h) ─
  const phonesContactedThisRun = new Set();

  const results = {
    triggered:  0,
    escalated:  0,
    skipped_spam:    0,
    skipped_window:  0,
    skipped_no_trigger: 0,
    errors:     [],
  };

  for (const booking of bookings) {
    const {
      id:                     bookingId,
      booking_ref:            bookingRef,
      vehicle_id:             vehicleId,
      customer_phone:         phone,
      pickup_date:            pickupDate,
      return_date:            returnDate,
      return_time:            returnTime,
      last_oil_check_at:      bookingLastOilCheckAt,
      oil_check_required:     oilCheckRequired,
      oil_check_last_request: lastRequest,
      oil_check_missed_count: missedCount,
    } = booking;

    if (!phone || !vehicleId) {
      console.log(`oil-check-cron: SKIP ${bookingRef || bookingId}: missing phone or vehicleId (phone=${!!phone}, vehicleId=${!!vehicleId})`);
      continue;
    }

    // ── Anti-spam: skip if already contacted this run ──────────────────────
    if (phonesContactedThisRun.has(phone)) {
      results.skipped_spam++;
      console.log(`oil-check-cron: SKIP ${bookingRef || bookingId}: already contacted this run`);
      continue;
    }

    // ── Anti-spam: skip if last message was < 24 h ago ────────────────────
    if (lastRequest && hoursSince(lastRequest) < cooldownHours) {
      results.skipped_spam++;
      const hrsSince = hoursSince(lastRequest);
      console.log(`oil-check-cron: SKIP ${bookingRef || bookingId}: cooldown active (last request ${hrsSince.toFixed(1)}h ago, cooldown=${cooldownHours}h)`);
      continue;
    }

    // ── Compute rental duration ────────────────────────────────────────────
    const rentalDays = pickupDate && returnDate
      ? Math.round((new Date(returnDate) - new Date(pickupDate)) / 86_400_000)
      : 0;

    // ── Compute time proximity for scoring ────────────────────────────────
    const { end_datetime: returnDt, minutesToReturn: rawMinutesToReturn } =
      await getRentalState(sb, bookingRef);
    const minutesToReturn = rawMinutesToReturn !== null ? rawMinutesToReturn : undefined;

    if (rentalDays < minRentalDays) {
      results.skipped_no_trigger++;
      console.log(`oil-check-cron: SKIP ${bookingRef || bookingId}: rental_days=${rentalDays} < min_rental_days=${minRentalDays}`);
      continue;
    }

    const vs = stateByVehicle[vehicleId];

    // ── Escalation path (oil_check_required = true, no reply received) ────
    if (oilCheckRequired) {
      if (missedCount >= 2) {
        // Already sent final notice — stop messaging
        results.skipped_no_trigger++;
        console.log(`oil-check-cron: SKIP ${bookingRef || bookingId}: escalation ceiling reached (missed_count=${missedCount})`);
        continue;
      }

      // Check if enough time has passed since the last request to escalate
      if (!lastRequest || hoursSince(lastRequest) < escalateAfterHours) {
        results.skipped_spam++;
        console.log(`oil-check-cron: SKIP ${bookingRef || bookingId}: escalation window not elapsed (last=${lastRequest || "never"}, need ${escalateAfterHours}h)`);
        continue;
      }

      const escalateMsg = missedCount === 0
        ? MSG_OIL_CHECK_REMINDER
        : MSG_OIL_CHECK_FINAL;
      const escalateKey = missedCount === 0 ? "OIL_CHECK_REMINDER" : "OIL_CHECK_FINAL";

      // Score-based gate: escalation messages are P2 (IMPORTANT).
      // Compute score with real-time context before sending.
      const escalateRecentRows = await fetchRecentSmsLogs(sb, bookingRef);
      const escalateCtx = buildSmsContext(escalateKey, escalateRecentRows, { minutesToReturn });
      if (isSuppressedByProximity(escalateKey, escalateCtx)) {
        results.skipped_spam++;
        console.log(`oil-check-cron: SKIP ${bookingRef || bookingId}: proximity suppressed for escalation (${minutesToReturn !== undefined ? Math.round(minutesToReturn) : "?"}min to return)`);
        continue;
      }
      const { score: escalateScore, breakdown: escalateBreakdown } = computeSmsScoreWithBreakdown(escalateKey, escalateCtx);
      const escalateThreshold = computeEffectiveThreshold(escalateCtx);
      console.log(`oil-check-cron: SCORE escalation ${bookingRef || bookingId}: key=${escalateKey} score=${escalateScore} threshold=${escalateThreshold} breakdown=${JSON.stringify(escalateBreakdown)}`);
      if (escalateScore <= escalateThreshold) {
        results.skipped_spam++;
        console.log(`oil-check-cron: SKIP ${bookingRef || bookingId}: escalation score ${escalateScore} ≤ ${escalateThreshold}`);
        continue;
      }

      try {
        await sendSms(phone, escalateMsg);
        phonesContactedThisRun.add(phone);

        const newMissedCount = missedCount + 1;
        const nowTs = new Date().toISOString();
        await sb
          .from("bookings")
          .update({
            oil_check_last_request:  nowTs,
            oil_check_missed_count:  newMissedCount,
            updated_at:              nowTs,
          })
          .eq("id", bookingId);

        // Log to sms_logs so other crons can see this send via cross-cron cooldown.
        await logOilCheckToSupabase(sb, bookingRef, escalateKey, { score: escalateScore, breakdown: escalateBreakdown });

        results.escalated++;
        console.log(`oil-check-cron: escalated booking ${bookingRef || bookingId} (missed=${newMissedCount})`);
      } catch (err) {
        results.errors.push(`${bookingRef || bookingId}: ${err.message}`);
        console.error("oil-check-cron: escalation SMS failed:", err.message);
      }
      continue;
    }

    // ── Initial trigger path ──────────────────────────────────────────────
    // Compute days and miles since last oil check (from vehicle_state)
    const lastCheckAt      = vs?.last_oil_check_at      || bookingLastOilCheckAt || null;
    const lastCheckMileage = vs?.last_oil_check_mileage  ?? null;
    const currentMileage   = vs?.current_mileage         ?? null;

    const daysSinceCheck = lastCheckAt
      ? hoursSince(lastCheckAt) / 24
      : Infinity; // never checked — treat as overdue

    const milesSinceCheck = (currentMileage !== null && lastCheckMileage !== null)
      ? currentMileage - lastCheckMileage
      : Infinity; // no mileage data — treat as overdue

    const triggerByDays  = daysSinceCheck  >= daysSinceCheckThreshold;
    const triggerByMiles = milesSinceCheck >= milesSinceCheckThreshold;

    if (!triggerByDays && !triggerByMiles) {
      results.skipped_no_trigger++;
      const daysDisplay  = daysSinceCheck  === Infinity ? "N/A" : daysSinceCheck.toFixed(1);
      const milesDisplay = milesSinceCheck === Infinity ? "N/A" : milesSinceCheck.toFixed(0);
      console.log(
        `oil-check-cron: SKIP ${bookingRef || bookingId}: threshold not met ` +
        `(days_since=${daysDisplay}/${daysSinceCheckThreshold}, miles_since=${milesDisplay}/${milesSinceCheckThreshold})`
      );
      continue;
    }

    // Determine whether to send the merged message.
    // If the vehicle is also due for a 3000-mile oil change service, combine
    // both requests into a single SMS to avoid sending two separate messages.
    const vData          = vehicleByVehicle[vehicleId];
    const vehicleMileage = vData?.mileage != null ? Number(vData.mileage) : null;
    const lastOilChangeMi = vData?.last_oil_change_mileage != null
      ? Number(vData.last_oil_change_mileage)
      : null;
    const oilChangeIntervalMiles = resolveOilChangeIntervalMiles(vData?.data?.maintenance_mileage_alert_miles);
    const milesSinceOilChange = vehicleMileage != null && lastOilChangeMi != null
      ? vehicleMileage - lastOilChangeMi
      : null;
    const mileageMaintenanceDue = milesSinceOilChange != null && milesSinceOilChange >= oilChangeIntervalMiles;

    const msgToSend   = mileageMaintenanceDue ? MSG_OIL_CHECK_MERGED : MSG_OIL_CHECK_REQUEST;
    const triggerKey  = mileageMaintenanceDue ? "OIL_CHECK_MERGED"   : "OIL_CHECK_REQUEST";

    // Score-based gate: use real-time context to decide whether to send.
    const triggerRecentRows = await fetchRecentSmsLogs(sb, bookingRef);
    const triggerCtx = buildSmsContext(triggerKey, triggerRecentRows, { minutesToReturn });
    if (isSuppressedByProximity(triggerKey, triggerCtx)) {
      results.skipped_spam++;
      console.log(`oil-check-cron: SKIP ${bookingRef || bookingId}: proximity suppressed for trigger (${minutesToReturn !== undefined ? Math.round(minutesToReturn) : "?"}min to return)`);
      continue;
    }
    const { score: triggerScore, breakdown: triggerBreakdown } = computeSmsScoreWithBreakdown(triggerKey, triggerCtx);
    const triggerThreshold = computeEffectiveThreshold(triggerCtx);
    console.log(`oil-check-cron: SCORE trigger ${bookingRef || bookingId}: key=${triggerKey} score=${triggerScore} threshold=${triggerThreshold} breakdown=${JSON.stringify(triggerBreakdown)}`);
    if (triggerScore <= triggerThreshold) {
      results.skipped_spam++;
      console.log(`oil-check-cron: SKIP ${bookingRef || bookingId}: trigger score ${triggerScore} ≤ ${triggerThreshold}`);
      continue;
    }

    // Send initial oil check request
    try {
      await sendSms(phone, msgToSend);
      phonesContactedThisRun.add(phone);

      const nowTs = new Date().toISOString();
      await sb
        .from("bookings")
        .update({
          oil_check_required:     true,
          oil_check_last_request: nowTs,
          updated_at:             nowTs,
        })
        .eq("id", bookingId);

      // Log to sms_logs so other crons can see this send via cross-cron cooldown.
      await logOilCheckToSupabase(sb, bookingRef, triggerKey, { score: triggerScore, breakdown: triggerBreakdown });

      results.triggered++;
      console.log(
        `oil-check-cron: triggered booking ${bookingRef || bookingId} ` +
        `(days_since=${daysSinceCheck.toFixed(1)}, miles_since=${milesSinceCheck === Infinity ? "N/A" : milesSinceCheck.toFixed(0)}, merged=${mileageMaintenanceDue})`
      );
    } catch (err) {
      results.errors.push(`${bookingRef || bookingId}: ${err.message}`);
      console.error("oil-check-cron: trigger SMS failed:", err.message);
    }
  }

  // ── Mileage-based triggers ────────────────────────────────────────────────
  // Independently scan each active rental for high avg miles/day.
  // These fire regardless of the oil-check compliance state above.
  // Hard dedup: hasMileageAlertBeenSent() guards each key to once per booking.
  const nowMs = Date.now();
  for (const booking of bookings) {
    const {
      id:             bookingId,
      booking_ref:    bookingRef,
      vehicle_id:     vehicleId,
      customer_phone: phone,
      pickup_date:    pickupDate,
    } = booking;

    if (!phone || !vehicleId || !pickupDate) continue;

    // In-run dedup: skip if this phone was already contacted in this cron run.
    if (phonesContactedThisRun.has(phone)) {
      console.log(`oil-check-cron (mileage): SKIP ${bookingRef || bookingId}: already contacted this run`);
      continue;
    }

    const startMileage   = startMileageByRef[bookingRef];
    const vs             = stateByVehicle[vehicleId];
    const currentMileage = vs?.current_mileage ?? null;

    if (startMileage == null || currentMileage == null) {
      console.log(`oil-check-cron (mileage): SKIP ${bookingRef || bookingId}: missing start_mileage or current_mileage`);
      continue;
    }

    const daysSincePickup = Math.max(1, (nowMs - new Date(pickupDate).getTime()) / MS_PER_DAY);
    // Apply the same 10-mile Bouncie sync tolerance buffer used in v2-mileage.js.
    const milesDriven     = Math.max(0, Number(currentMileage) - startMileage - 10);
    const avgMilesPerDay  = milesDriven / daysSincePickup;

    let templateKey, msgToSend;
    if (avgMilesPerDay >= avgMilesMaintReqThreshold) {
      templateKey = "MAINTENANCE_REQUIRED";
      msgToSend   = MSG_MAINTENANCE_REQUIRED;
    } else if (avgMilesPerDay >= avgMilesOilRiskThreshold) {
      templateKey = "OIL_CHECK_RISK";
      msgToSend   = MSG_OIL_CHECK_RISK;
    } else {
      results.skipped_no_trigger++;
      console.log(`oil-check-cron (mileage): SKIP ${bookingRef || bookingId}: avg=${avgMilesPerDay.toFixed(1)} mi/day below thresholds`);
      continue;
    }

    // Hard dedup: each mileage alert type fires at most once per booking,
    // across all cron runs and across extensions (same booking_ref throughout).
    if (await hasMileageAlertBeenSent(sb, bookingRef, templateKey)) {
      results.skipped_no_trigger++;
      console.log(`oil-check-cron (mileage): SKIP ${bookingRef || bookingId}: ${templateKey} already sent for this booking`);
      continue;
    }

    // Compute time-proximity context for scoring.
    const { minutesToReturn: rawMinutesToReturnMileage } = await getRentalState(sb, bookingRef);
    const mileageMinutesToReturn = rawMinutesToReturnMileage !== null ? rawMinutesToReturnMileage : undefined;

    const mileageRecentRows = await fetchRecentSmsLogs(sb, bookingRef);
    const mileageCtx = buildSmsContext(templateKey, mileageRecentRows, { minutesToReturn: mileageMinutesToReturn });

    if (isSuppressedByProximity(templateKey, mileageCtx)) {
      results.skipped_spam++;
      console.log(`oil-check-cron (mileage): SKIP ${bookingRef || bookingId}: proximity suppressed (${mileageMinutesToReturn !== undefined ? Math.round(mileageMinutesToReturn) : "?"}min to return)`);
      continue;
    }

    const { score: mileageScore, breakdown: mileageBreakdown } = computeSmsScoreWithBreakdown(templateKey, mileageCtx);
    const mileageThreshold = computeEffectiveThreshold(mileageCtx);
    console.log(`oil-check-cron (mileage): SCORE ${bookingRef || bookingId}: key=${templateKey} avg=${avgMilesPerDay.toFixed(1)} score=${mileageScore} threshold=${mileageThreshold} breakdown=${JSON.stringify(mileageBreakdown)}`);

    if (mileageScore <= mileageThreshold) {
      results.skipped_spam++;
      console.log(`oil-check-cron (mileage): SKIP ${bookingRef || bookingId}: score ${mileageScore} ≤ ${mileageThreshold}`);
      continue;
    }

    // Claim the send slot atomically before sending.  ignoreDuplicates:true means
    // the DB does nothing on conflict and returns no rows → inserted=false.
    // This makes the DB constraint the final authority under concurrency: only
    // the run that wins the INSERT proceeds to send; the other treats it as a
    // no-op (already sent) without re-sending.
    const { inserted } = await logOilCheckToSupabase(sb, bookingRef, templateKey, {
      score:             mileageScore,
      breakdown:         mileageBreakdown,
      avg_miles_per_day: Math.round(avgMilesPerDay),
    }, { sentinelDate: true });

    if (!inserted) {
      results.skipped_no_trigger++;
      console.log(`oil-check-cron (mileage): SKIP ${bookingRef || bookingId}: ${templateKey} already claimed by concurrent run`);
      continue;
    }

    try {
      await sendSms(phone, msgToSend);
      phonesContactedThisRun.add(phone);
      results.triggered++;
      console.log(`oil-check-cron (mileage): triggered booking ${bookingRef || bookingId} (key=${templateKey}, avg=${avgMilesPerDay.toFixed(1)} mi/day)`);
    } catch (err) {
      results.errors.push(`${bookingRef || bookingId}: ${err.message}`);
      console.error("oil-check-cron: mileage SMS failed:", err.message);
    }
  }

  return res.status(200).json({
    ...results,
    duration_ms: Date.now() - startedAt,
  });
}
