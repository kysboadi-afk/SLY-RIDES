// api/maintenance-alerts.js
// Fleet maintenance alert cron — driver notifications + escalation system.
//
// GET  /api/maintenance-alerts  — Vercel cron trigger (no auth required from Vercel)
// POST /api/maintenance-alerts  — Manual trigger; requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// Applies ONLY to Bouncie-tracked vehicles (bouncie_device_id IS NOT NULL).
// Only sends alerts when the vehicle has an ACTIVE booking (status = "active_rental").
//
// Flow per vehicle × service type (oil | brakes | tires):
//   ≥80%  (warn):     Send driver SMS warning — once per booking per service type
//   ≥100% (urgent):   Send driver SMS urgent   — once per booking per service type
//   ≥100% + 48 h after urgent, no service recorded → escalate:
//     • Driver SMS final notice
//     • Owner SMS  → OWNER_PHONE (env var, default +18445114059)
//     • Owner email → OWNER_EMAIL (env var, default slyservices@supports-info.com)
//     • booking.maintenance_status = "non_compliant" persisted to bookings.json
//     • vehicle.data.service_required = true persisted to Supabase
//
// Deduplication: uses booking.smsSentAt[key] (ISO timestamp) — same pattern as
// scheduled-reminders.js. Keys: maint_<type>_warn | maint_<type>_urgent | maint_<type>_escalate

import nodemailer from "nodemailer";
import { getSupabaseAdmin } from "./_supabase.js";
import { sendSms } from "./_textmagic.js";
import { loadBookings, saveBookings, normalizePhone, isNetworkError } from "./_bookings.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { laHour, isoDateInLA } from "./_time.js";
import { getRentalState } from "./_rental-state.js";
import { getSmsPriority } from "./_sms-priority.js";
import { maybeSkipScheduledAutomation } from "./_runtime-environment.js";
import {
  computeSmsScoreWithBreakdown,
  computeEffectiveThreshold,
  isSuppressedByProximity,
  fetchRecentSmsLogs,
  buildSmsContext,
  selectTopCandidate,
} from "./_sms-scoring.js";
import {
  render,
  MAINTENANCE_AVAILABILITY_REQUEST,
  MAINTENANCE_AVAILABILITY_URGENT,
} from "./_sms-templates.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const OWNER_PHONE = process.env.OWNER_PHONE || "+18445114059";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";


// Daily mileage threshold per driver — alerts owner when exceeded within 24 h.
// Configurable via DRIVER_MILEAGE_THRESHOLD_DAILY env var (default: 200 miles/day).
const DRIVER_MILEAGE_THRESHOLD_DAILY = Math.max(
  1,
  Number(process.env.DRIVER_MILEAGE_THRESHOLD_DAILY) || 200
);

// HIGH_DAILY_MILEAGE alert deduplication via sms_logs.
// Max 2 alerts per booking, with a 60-minute cooldown between them.
const TEMPLATE_KEY_HIGH_MILEAGE   = "HIGH_DAILY_MILEAGE";
const MAX_HIGH_MILEAGE_ALERTS     = 2;
const HIGH_MILEAGE_COOLDOWN_MS    = 60 * 60 * 1000; // 60 minutes

// Hard minimum cooldown for service alerts (warn + urgent).
// Even if the score-based gate passes, never send the same service-alert
// template more than once within this window.  This is a last-resort guard
// against the scoring proximity bonus overcoming the spam penalty when a
// rental is near its return time.
const MAINTENANCE_HARD_COOLDOWN_MIN = 24 * 60; // 24 hours in minutes

// Service definitions — intervals match lib/ai/mileage.js
const SERVICES = [
  {
    type:     "oil",
    col:      "last_oil_change_mileage",
    interval: 3000,
    label:    "oil change",
    warnPct:  0.8,
  },
  {
    type:     "brakes",
    col:      "last_brake_check_mileage",
    interval: 10000,
    label:    "brake inspection",
    warnPct:  0.8,
  },
  {
    type:     "tires",
    col:      "last_tire_change_mileage",
    interval: 20000,
    label:    "tire replacement",
    warnPct:  0.8,
  },
];

// Deduplication key helpers (stored in booking.smsSentAt)
const keyWarn   = (type) => `maint_${type}_warn`;
const keyUrgent = (type) => `maint_${type}_urgent`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function alreadySent(booking, key) {
  return !!(booking.smsSentAt && booking.smsSentAt[key]);
}

async function safeSendSms(phone, body) {
  try {
    const normalized = normalizePhone(phone);
    if (!normalized) return false;
    await sendSms(normalized, body);
    return true;
  } catch (err) {
    console.warn(`maintenance-alerts: SMS to ${phone} failed:`, err.message);
    return false;
  }
}

/**
 * Log a sent service-alert SMS to sms_logs so other crons can see it via
 * the cross-cron cooldown check.  Uses the sentinel return date (1970-01-01)
 * for service alerts since they are not tied to a specific return date.
 * Non-fatal: errors are only logged.
 * @param {object} extraMetadata - optional additional fields (e.g. { score })
 */
async function logServiceAlertToSupabase(sb, bookingId, templateKey, extraMetadata = {}) {
  if (!sb || !bookingId) return;
  try {
    const { error } = await sb
      .from("sms_logs")
      .upsert(
        {
          booking_id:          bookingId,
          template_key:        templateKey,
          return_date_at_send: "1970-01-01",
          sent_at:             new Date().toISOString(),
          metadata:            { priority: getSmsPriority(templateKey), ...extraMetadata },
        },
        { onConflict: "booking_id,template_key,return_date_at_send" }
      );
    if (error) {
      console.warn("maintenance-alerts: sms_logs write failed (non-fatal):", error.message);
    }
  } catch (err) {
    console.warn("maintenance-alerts: sms_logs write failed (non-fatal):", err.message);
  }
}

async function sendOwnerAlertEmail(subject, html) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("maintenance-alerts: SMTP not configured — owner email skipped");
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from:    process.env.SMTP_USER,
      to:      OWNER_EMAIL,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.warn("maintenance-alerts: owner email failed:", err.message);
    return false;
  }
}

/**
 * Check whether a HIGH_DAILY_MILEAGE alert is allowed for this booking.
 * Returns { allowed: boolean, sentCount: number }.
 * Enforces:
 *   1. Hard cap: at most MAX_HIGH_MILEAGE_ALERTS total per booking.
 *   2. Cooldown: at least HIGH_MILEAGE_COOLDOWN_MS between consecutive alerts.
 * Fails open (allows the send) if Supabase is unavailable.
 */
async function checkHighMileageQuota(sb, bookingId) {
  if (!sb || !bookingId) return { allowed: true, sentCount: 0 };
  try {
    const { count, error: countErr } = await sb
      .from("sms_logs")
      .select("*", { count: "exact", head: true })
      .eq("booking_id", bookingId)
      .eq("template_key", TEMPLATE_KEY_HIGH_MILEAGE);

    if (countErr) {
      console.warn("maintenance-alerts: sms_logs count check failed (non-fatal):", countErr.message);
      return { allowed: true, sentCount: 0 };
    }

    const sentCount = count || 0;
    if (sentCount >= MAX_HIGH_MILEAGE_ALERTS) {
      return { allowed: false, sentCount };
    }

    // Cooldown: ensure at least 60 min since last alert
    const { data, error: latestErr } = await sb
      .from("sms_logs")
      .select("sent_at")
      .eq("booking_id", bookingId)
      .eq("template_key", TEMPLATE_KEY_HIGH_MILEAGE)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestErr) {
      console.warn("maintenance-alerts: sms_logs cooldown check failed (non-fatal):", latestErr.message);
      return { allowed: true, sentCount };
    }

    if (data) {
      const diffMs = Date.now() - new Date(data.sent_at).getTime();
      if (diffMs < HIGH_MILEAGE_COOLDOWN_MS) {
        return { allowed: false, sentCount };
      }
    }

    return { allowed: true, sentCount };
  } catch (err) {
    console.warn("maintenance-alerts: high-mileage quota check failed (non-fatal):", err.message);
    return { allowed: true, sentCount: 0 };
  }
}

/**
 * Record a sent HIGH_DAILY_MILEAGE alert in sms_logs.
 * Stores the actual calendar date the alert was sent so logs are meaningful
 * and easy to analyse.  The sms_logs_dedup unique constraint is excluded for
 * this template key (see migration 0077), so multiple rows per booking are
 * allowed; the max-2 cap is enforced by checkHighMileageQuota before each send.
 * Non-fatal: errors are logged but not propagated.
 */
async function logHighMileageAlert(sb, bookingId) {
  if (!sb || !bookingId) return;
  try {
    const today = isoDateInLA(); // YYYY-MM-DD
    const { error } = await sb.from("sms_logs").insert({
      booking_id:          bookingId,
      template_key:        TEMPLATE_KEY_HIGH_MILEAGE,
      return_date_at_send: today,
    });
    // 23505 = unique_violation: a duplicate same-day entry is acceptable because
    // the SMS was already sent and checkHighMileageQuota enforces the hard cap.
    if (error && error.code !== "23505") {
      console.warn("maintenance-alerts: sms_logs insert for HIGH_DAILY_MILEAGE failed (non-fatal):", error.message);
    }
  } catch (err) {
    console.warn("maintenance-alerts: sms_logs insert for HIGH_DAILY_MILEAGE failed (non-fatal):", err.message);
  }
}

// ── LA time window ────────────────────────────────────────────────────────────

const WINDOW_START_HOUR = 8;  // 8:00 AM LA
const WINDOW_END_HOUR   = 19; // 7:00 PM LA (exclusive)

// ── Main Handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Auth: GET is implicitly trusted by Vercel cron; POST requires Bearer token.
  if (req.method === "POST") {
    const auth  = req.headers.authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (
      !token ||
      (token !== process.env.ADMIN_SECRET && token !== process.env.CRON_SECRET)
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  } else if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed");
  }

  if (maybeSkipScheduledAutomation(req, res, { endpoint: "maintenance-alerts" })) return;

  // Enforce 8 AM – 7 PM LA send window for cron-triggered runs.
  // Manual POST bypasses the window to allow out-of-hours testing.
  if (req.method === "GET") {
    const hour = laHour();
    if (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR) {
      return res.status(200).json({
        skipped: true,
        reason:  `Outside send window (${WINDOW_START_HOUR}:00–${WINDOW_END_HOUR}:00 LA). Current LA hour: ${hour}.`,
      });
    }
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase is not configured" });
  }

  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) {
    return res.status(200).json({ skipped: true, reason: "TextMagic not configured — set TEXTMAGIC_USERNAME and TEXTMAGIC_API_KEY" });
  }

  const startedAt = Date.now();

  try {
    // ── 1. Load tracked vehicles with per-service mileage ───────────────────
    const { data: vehicleRows, error: vehiclesErr } = await sb
      .from("vehicles")
      .select("vehicle_id, mileage, bouncie_device_id, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
      .not("bouncie_device_id", "is", null);

    if (vehiclesErr) throw new Error(`Supabase vehicles fetch failed: ${vehiclesErr.message}`);

    const trackedVehicles = (vehicleRows || []).filter((r) => {
      const type = r.data?.type || r.data?.vehicle_type || "";
      return true;
    });

    if (trackedVehicles.length === 0) {
      return res.status(200).json({
        ran_at:      new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        alerts_sent: 0,
        detail:      "No Bouncie-tracked vehicles found",
      });
    }

    // ── 2. Load active bookings; build vehicle → active booking map ─────────
    // Primary: Supabase (status = 'active'). Fallback: bookings.json — only on
    // network error. If Supabase returns an empty set that is a valid result and
    // must NOT trigger a JSON fallback.
    const trackedIds = trackedVehicles.map((v) => v.vehicle_id);
    const activeBookingByVehicle = {};
    let usedSupabase = false;
    try {
      const { data: activeRows, error: activeErr } = await sb
        .from("bookings")
        .select("booking_ref, vehicle_id, return_date, return_time, oil_check_required, oil_status, oil_check_last_request, customers ( name, phone )")
        .in("status", ["active", "active_rental"])
        .in("vehicle_id", trackedIds);
      if (activeErr) {
        // Schema errors (e.g. missing column — Postgres code 42703) must not
        // crash the endpoint.  Log the error and proceed with an empty booking
        // map so downstream vehicle processing is safely skipped.
        if (activeErr.code === "42703") {
          console.error("maintenance-alerts: bookings schema error — missing column. Proceeding with empty active bookings. Run migration 0098 to add the missing columns.", activeErr.message);
        } else {
          throw activeErr; // other query errors → propagate, do NOT fallback
        }
      } else {
        // Only mark Supabase as used when the query actually succeeded.
        usedSupabase = true;
      }
      for (const r of (activeRows || [])) {
        activeBookingByVehicle[r.vehicle_id] = {
          bookingId:           r.booking_ref || null,
          vehicleId:           r.vehicle_id,
          vehicleName:         r.vehicle_id,  // filled from trackedVehicles below
          name:                r.customers?.name  || "",
          phone:               r.customers?.phone || "",
          returnDate:          r.return_date  || null,
          returnTime:          r.return_time  || null,
          smsSentAt:           {},  // overlaid from bookings.json below
          oilCheckRequired:    r.oil_check_required    || false,
          oilStatus:           r.oil_status            || null,
          oilCheckLastRequest: r.oil_check_last_request || null,
        };
      }
    } catch (err) {
      if (isNetworkError(err)) {
        console.error("[FALLBACK] Supabase unreachable in maintenance-alerts, using bookings.json for active bookings:", err.message);
        // Fall back to full JSON read
        const { data: allBookingsRaw } = await loadBookings();
        for (const [vid, bookings] of Object.entries(allBookingsRaw || {})) {
          const active = Array.isArray(bookings)
            ? bookings.find((b) => b.status === "active_rental")
            : null;
          if (active) activeBookingByVehicle[vid] = active;
        }
      } else if (err.code === "42703") {
        // Schema error in a non-Supabase path — log and proceed with empty bookings.
        console.error("maintenance-alerts: schema error — missing column. Run migration 0098 to add the missing columns.", err.message);
      } else {
        throw err; // non-network Supabase error → propagate
      }
    }

    // When Supabase was used, overlay smsSentAt from bookings.json for
    // deduplication (smsSentAt is written to JSON and not yet stored in Supabase).
    if (usedSupabase && Object.keys(activeBookingByVehicle).length > 0) {
      try {
        const { data: jsonData } = await loadBookings();
        for (const [vid, bookingObj] of Object.entries(activeBookingByVehicle)) {
          const jsonBookings = jsonData[vid];
          if (!Array.isArray(jsonBookings)) continue;
          const jsonActive = jsonBookings.find(
            (b) => b.status === "active_rental" &&
              (!bookingObj.bookingId || b.bookingId === bookingObj.bookingId || b.paymentIntentId === bookingObj.bookingId)
          );
          if (jsonActive?.smsSentAt) {
            activeBookingByVehicle[vid].smsSentAt = jsonActive.smsSentAt;
          }
          // Also backfill vehicleName from JSON when available
          if (jsonActive?.vehicleName && !activeBookingByVehicle[vid].vehicleName) {
            activeBookingByVehicle[vid].vehicleName = jsonActive.vehicleName;
          }
        }
      } catch (jsonErr) {
        console.warn("maintenance-alerts: could not load smsSentAt from bookings.json (non-fatal):", jsonErr.message);
      }
    }

    // ── 3. Process each vehicle ──────────────────────────────────────────────
    const sentMarks      = [];   // { vehicleId, id, key } — dedup marks
    const bookingUpdates = [];   // { vehicleId, id, patch } — maintenance_status
    let   alertsSent     = 0;

    for (const row of trackedVehicles) {
      const vid     = row.vehicle_id;
      const miles   = Number(row.mileage) || 0;
      const name    = row.data?.vehicle_name || vid;
      const booking = activeBookingByVehicle[vid];

      if (!booking) {
        console.log(`maintenance-alerts: SKIP vehicle ${vid}: no active rental`);
        continue; // No active rental — no driver to notify
      }

      // ── SMS priority suppression ───────────────────────────────────────────
      // HIGH: oil_status = 'low' → owner is aware and handling it; suppress all
      //   renter-facing mileage maintenance messages until oil issue is resolved.
      if (booking.oilStatus === "low") {
        console.log(`maintenance-alerts: SKIP vehicle ${vid} booking ${booking.bookingId || vid}: oil_status=low, suppressing maintenance alerts`);
        continue;
      }

      // MEDIUM: oil_check_required = true → an oil-check request is pending a
      //   renter reply. Do not layer additional maintenance messages on top.
      if (booking.oilCheckRequired) {
        console.log(`maintenance-alerts: SKIP vehicle ${vid} booking ${booking.bookingId || vid}: oil_check_required=true, pending renter reply`);
        continue;
      }

      // Cooldown: if oil-check-cron sent a system message within the last 24 h,
      //   wait to avoid back-to-back messages from different automation systems.
      if (
        booking.oilCheckLastRequest &&
        Date.now() - new Date(booking.oilCheckLastRequest).getTime() < 86_400_000
      ) {
        console.log(`maintenance-alerts: SKIP vehicle ${vid} booking ${booking.bookingId || vid}: oil-check-cron cooldown active (last=${booking.oilCheckLastRequest})`);
        continue;
      }
      // ── End suppression ────────────────────────────────────────────────────

      const bookingId = booking.bookingId || booking.paymentIntentId;
      const phone     = booking.phone;

      // ── Compute time-proximity context ────────────────────────────────────
      const { end_datetime: returnDt, minutesToReturn: rawMinutesToReturn } =
        await getRentalState(sb, bookingId);
      const minutesToReturn = rawMinutesToReturn !== null ? rawMinutesToReturn : undefined;
      console.log("minutesToReturn:", minutesToReturn, {
        booking_ref: bookingId,
        return_date: booking.returnDate,
        return_time: booking.returnTime,
      });

      // ── Collect all eligible service alert candidates ──────────────────────
      // Multiple services (oil, brakes, tires) may be due at the same time.
      // Each candidate is scored independently; the highest-scoring one above
      // SCORE_THRESHOLD is sent — replacing the previous fixed-priority sort.
      const candidates = [];

      // Supabase-backed dedup: fetch all service-alert sms_logs rows for this
      // booking (no time limit) so we can guard against repeat sends even when
      // the bookings.json smsSentAt write failed (e.g. GITHUB_TOKEN absent).
      const supabaseAlreadySentKeys = new Set();
      if (sb && bookingId) {
        try {
          const allServiceKeys = SERVICES.flatMap((s) => [keyWarn(s.type), keyUrgent(s.type)]);
          const { data: flagRows, error: flagErr } = await sb
            .from("sms_logs")
            .select("template_key")
            .eq("booking_id",          bookingId)
            .eq("return_date_at_send", "1970-01-01")
            .in("template_key",        allServiceKeys);
          if (!flagErr && flagRows) {
            for (const r of flagRows) supabaseAlreadySentKeys.add(r.template_key);
          } else if (flagErr) {
            console.warn(`maintenance-alerts: sms_logs dedup prefetch failed for ${bookingId} (non-fatal):`, flagErr.message);
          }
        } catch (flagErr) {
          console.warn(`maintenance-alerts: sms_logs dedup prefetch failed for ${bookingId} (non-fatal):`, flagErr.message);
        }
      }

      for (const svc of SERVICES) {
        // Resolve last-service mileage for this specific service type
        const lastMi  = row[svc.col] != null
          ? Number(row[svc.col])
          : Number(row.data?.last_service_mileage) || 0;
        const since   = Math.max(0, miles - lastMi);
        const pct     = since / svc.interval;

        if (pct < svc.warnPct) continue; // Below warning threshold

        const kWarn   = keyWarn(svc.type);
        const kUrgent = keyUrgent(svc.type);

        if (pct >= 1.0) {
          // Overdue (100%+) — high priority
          if (!alreadySent(booking, kUrgent) && !supabaseAlreadySentKeys.has(kUrgent)) {
            candidates.push({
              key:      kUrgent,
              template: MAINTENANCE_AVAILABILITY_URGENT,
            });
          } else {
            console.log(`maintenance-alerts: SKIP vehicle ${vid} booking ${bookingId}: ${svc.type} urgent already sent`);
          }
        } else {
          // Due soon (80%–100%) — standard priority
          if (!alreadySent(booking, kWarn) && !supabaseAlreadySentKeys.has(kWarn)) {
            candidates.push({
              key:      kWarn,
              template: MAINTENANCE_AVAILABILITY_REQUEST,
            });
          } else {
            console.log(`maintenance-alerts: SKIP vehicle ${vid} booking ${bookingId}: ${svc.type} warn already sent`);
          }
        }
      }

      if (candidates.length === 0) continue;

      // ── Score each candidate and select the top one ────────────────────────
      // Fetch sms_logs once per booking; buildSmsContext is a pure function.
      const recentRows = await fetchRecentSmsLogs(sb, bookingId);
      const baseCtx    = { minutesToReturn };

      const scoredCandidates = candidates.map((c) => {
        const ctx                  = buildSmsContext(c.key, recentRows, baseCtx);
        const { score, breakdown } = computeSmsScoreWithBreakdown(c.key, ctx);
        return { ...c, score, breakdown, ctx };
      });

      const effectiveThreshold = computeEffectiveThreshold(baseCtx);
      const winner = selectTopCandidate(scoredCandidates, effectiveThreshold);

      if (!winner) {
        const topScore = scoredCandidates.reduce((m, c) => Math.max(m, c.score), -Infinity);
        console.log(
          `maintenance-alerts: SKIP vehicle ${vid} booking ${bookingId}: ` +
          `no candidate above score threshold=${effectiveThreshold} (top score: ${isFinite(topScore) ? topScore.toFixed(1) : topScore})`
        );
        continue;
      }

      // Proximity suppression: no maintenance messages near return time
      if (isSuppressedByProximity(winner.key, winner.ctx)) {
        console.log(
          `maintenance-alerts: SKIP vehicle ${vid} booking ${bookingId}: ` +
          `proximity suppressed (${minutesToReturn !== undefined ? Math.round(minutesToReturn) : "?"} min to return)`
        );
        continue;
      }

      // Hard cooldown: block if the same template was sent within the last
      // MAINTENANCE_HARD_COOLDOWN_MIN minutes, regardless of score.  This
      // prevents the scoring proximity bonus from overcoming the spam penalty
      // when a rental is near its return time, which would otherwise allow the
      // same message to fire on every cron cycle.
      if (
        winner.ctx.sameTemplateRecentMinutes !== undefined &&
        winner.ctx.sameTemplateRecentMinutes < MAINTENANCE_HARD_COOLDOWN_MIN
      ) {
        console.log(
          `maintenance-alerts: SKIP vehicle ${vid} booking ${bookingId}: ` +
          `hard cooldown active for ${winner.key} ` +
          `(sent ${Math.round(winner.ctx.sameTemplateRecentMinutes)} min ago, ` +
          `min=${MAINTENANCE_HARD_COOLDOWN_MIN})`
        );
        continue;
      }

      console.log(
        `maintenance-alerts: SCORE vehicle ${vid} booking ${bookingId}: ` +
        `winner=${winner.key} score=${winner.score} threshold=${effectiveThreshold} ` +
        `breakdown=${JSON.stringify(winner.breakdown)} ` +
        `(${scoredCandidates.length} candidate(s) evaluated)`
      );

      const customerName = booking.name || "there";
      const sent = await safeSendSms(phone,
        render(winner.template, { customer_name: customerName })
      );
      if (sent) {
        sentMarks.push({ vehicleId: vid, id: bookingId, key: winner.key });
        alertsSent++;
        // Log to sms_logs with score so other crons and dashboards see this send.
        await logServiceAlertToSupabase(sb, bookingId, winner.key, { score: winner.score, breakdown: winner.breakdown });
      }
      if (scoredCandidates.length > 1) {
        const suppressed = scoredCandidates
          .filter((c) => c.key !== winner.key)
          .map((c) => `${c.key}(${c.score})`)
          .join(", ");
        console.log(
          `maintenance-alerts: SCORE SUPPRESSED ${scoredCandidates.length - 1} lower-scoring ` +
          `candidate(s) for booking ${bookingId}: [${suppressed}]`
        );
      }
    }

    // ── 4. Per-driver daily mileage excess alerts ────────────────────────────
    // Sum GPS trip_log distances from the last 24 h for each vehicle that has
    // an active booking.  When a driver's daily total exceeds
    // DRIVER_MILEAGE_THRESHOLD_DAILY, the fleet owner is alerted by SMS.
    //
    // Deduplication key: "driver_mileage_alert" stored in booking.smsSentAt.
    // One alert is sent per booking per 24-hour window (cleared on a new day).
    try {
      const since24h = new Date(Date.now() - 86400_000).toISOString();
      const activeVehicleIds = Object.keys(activeBookingByVehicle);

      if (activeVehicleIds.length > 0) {
        const { data: recentTrips } = await sb
          .from("trip_log")
          .select("vehicle_id, trip_distance, trip_at")
          .in("vehicle_id", activeVehicleIds)
          .gte("trip_at", since24h);

        // Aggregate miles per vehicle over last 24 h
        const milesBy = {};
        for (const row of recentTrips || []) {
          milesBy[row.vehicle_id] = (milesBy[row.vehicle_id] || 0) + (Number(row.trip_distance) || 0);
        }

        for (const [vid, dailyMiles] of Object.entries(milesBy)) {
          if (dailyMiles < DRIVER_MILEAGE_THRESHOLD_DAILY) continue;

          const booking     = activeBookingByVehicle[vid];
          const bookingId   = booking.bookingId || booking.paymentIntentId;
          const driverName  = booking.name  || "Unknown driver";
          const driverPhone = booking.phone || "N/A";
          const vehicleName = trackedVehicles.find((v) => v.vehicle_id === vid)?.data?.vehicle_name || vid;

          // Dedup: enforce max-2 cap and 60-min cooldown via sms_logs.
          // Falls back to the 24h smsSentAt flag when Supabase is unavailable.
          const alertKey   = "driver_mileage_alert";
          const { allowed } = await checkHighMileageQuota(sb, bookingId);
          if (!allowed) continue;

          // Secondary fallback: legacy 24h smsSentAt guard (for when Supabase is down)
          const lastSentAt = booking.smsSentAt?.[alertKey];
          if (lastSentAt && (Date.now() - new Date(lastSentAt).getTime()) < 86400_000) continue;

          const msg =
            `⚠️ High mileage alert: ${driverName} drove ${Math.round(dailyMiles)} mi in 24h ` +
            `on ${vehicleName} (threshold: ${DRIVER_MILEAGE_THRESHOLD_DAILY} mi/day). ` +
            `Booking: ${bookingId}. Driver phone: ${driverPhone}.`;

          const smsSent = await safeSendSms(OWNER_PHONE, msg);
          await sendOwnerAlertEmail(
            `⚠️ High Daily Mileage — ${driverName} / ${vehicleName}`,
            `<p>⚠️ A driver has exceeded the daily mileage threshold.</p>
<p><strong>Driver:</strong> ${driverName}</p>
<p><strong>Driver phone:</strong> ${driverPhone}</p>
<p><strong>Vehicle:</strong> ${vehicleName}</p>
<p><strong>Miles driven (last 24 h):</strong> ${Math.round(dailyMiles).toLocaleString()} mi</p>
<p><strong>Threshold:</strong> ${DRIVER_MILEAGE_THRESHOLD_DAILY.toLocaleString()} mi/day</p>
<p><strong>Booking ID:</strong> ${bookingId}</p>
<p>Please review driver behavior and vehicle condition.</p>`
          );

          if (smsSent) {
            // Log to sms_logs so the max-2 cap is enforced on the next cron run
            await logHighMileageAlert(sb, bookingId);
            sentMarks.push({ vehicleId: vid, id: bookingId, key: alertKey });
            alertsSent++;
          }
        }
      }
    } catch (driverAlertErr) {
      console.warn("maintenance-alerts: driver daily mileage check failed (non-fatal):", driverAlertErr.message);
    }

    // ── 5. Persist dedup marks + booking patches atomically ─────────────────
    if (sentMarks.length > 0 || bookingUpdates.length > 0) {
      if (!process.env.GITHUB_TOKEN) {
        // Without GITHUB_TOKEN the smsSentAt flags are never written to
        // bookings.json.  The Supabase sms_logs-based dedup (supabaseAlreadySentKeys
        // pre-flight + hard cooldown) serves as the fallback in this case, but
        // log a clear warning so the misconfiguration is visible in cron logs.
        console.warn(
          "maintenance-alerts: GITHUB_TOKEN is not set — " +
          `smsSentAt dedup marks for ${sentMarks.length} alert(s) will NOT be persisted to bookings.json. ` +
          "Supabase sms_logs dedup is active as fallback. Set GITHUB_TOKEN to enable full dedup."
        );
      } else {
        try {
          await updateJsonFileWithRetry({
            load:  loadBookings,
            apply: (data) => {
              // Apply dedup sentAt marks
              for (const { vehicleId, id, key } of sentMarks) {
                const bookings = data[vehicleId];
                if (!Array.isArray(bookings)) continue;
                const idx = bookings.findIndex(
                  (b) => b.bookingId === id || b.paymentIntentId === id
                );
                if (idx === -1) {
                  console.warn(`maintenance-alerts: booking ID ${id} not found in bookings.json for vehicle ${vehicleId} — smsSentAt[${key}] not written`);
                  continue;
                }
                if (!bookings[idx].smsSentAt) bookings[idx].smsSentAt = {};
                bookings[idx].smsSentAt[key] = new Date().toISOString();
              }
              // Apply booking status patches
              for (const { vehicleId, id, patch } of bookingUpdates) {
                const bookings = data[vehicleId];
                if (!Array.isArray(bookings)) continue;
                const idx = bookings.findIndex(
                  (b) => b.bookingId === id || b.paymentIntentId === id
                );
                if (idx === -1) continue;
                Object.assign(bookings[idx], patch);
              }
            },
            save:    saveBookings,
            message: `maintenance-alerts: ${sentMarks.length} alert marks, ${bookingUpdates.length} booking patches`,
          });
        } catch (err) {
          console.error("maintenance-alerts: failed to persist marks:", err.message);
        }
      }
    }

    return res.status(200).json({
      ran_at:           new Date().toISOString(),
      duration_ms:      Date.now() - startedAt,
      vehicles_checked: trackedVehicles.length,
      active_bookings:  Object.keys(activeBookingByVehicle).length,
      alerts_sent:      alertsSent,
    });
  } catch (err) {
    console.error("maintenance-alerts error:", err);
    // Always return 200 so the cron runner does not treat this as a platform
    // failure.  The error detail is preserved in the response body and in logs.
    return res.status(200).json({
      ran_at:      new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      alerts_sent: 0,
      error:       adminErrorMessage(err),
    });
  }
}
