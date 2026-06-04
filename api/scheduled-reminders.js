// api/scheduled-reminders.js
// Vercel cron serverless function — reads bookings from Supabase (primary) and
// sends automated SMS reminders based on booking status and timing.
//
// This endpoint is called by Vercel Cron on a frequent schedule (every 5 min).
// It is also callable manually from an admin panel via POST with an
// Authorization: Bearer <CRON_SECRET> header.
//
// Reminder types fired per booking status:
//
//  reserved_unpaid  → UNPAID_REMINDER_2H, UNPAID_REMINDER_FINAL
//  booked_paid      → PICKUP_REMINDER_24H
//                     + auto-activated → active_rental once pickup time arrives
//  active_rental    → RETURN_REMINDER_24H (24 h before return),
//                     ACTIVE_RENTAL_MID (6–10 h before return),
//                     ACTIVE_RENTAL_1H_BEFORE_END (1 h before return),
//                     LATE_WARNING_30MIN (30 min before return),
//                     LATE_AT_RETURN_TIME, LATE_GRACE_EXPIRED, LATE_FEE_APPLIED
//                     + auto-completed → completed_rental after AUTO_COMPLETE_HOURS
//  completed_rental → POST_RENTAL_THANK_YOU, RETENTION_DAY_7
//
// Extension awareness:
//   Return-time-based SMS (late_warning_30min, late_at_return, late_grace_expired,
//   late_fee_pending) are deduplicated via the Supabase sms_logs table keyed on
//   (booking_id, template_key, return_date_at_send).  When a rental is extended
//   the booking's return_date changes, so the old sms_logs rows no longer match
//   and the messages fire correctly for the new return date.
//
// Required environment variables:
//   TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY
//   GITHUB_TOKEN, GITHUB_REPO
//   CRON_SECRET  — shared secret to authenticate manual trigger calls
//   STRIPE_SECRET_KEY  — for auto-charging late fees
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — for sms_logs deduplication
//
// Vercel cron configuration is in vercel.json.

import nodemailer from "nodemailer";
import { sendSms } from "./_textmagic.js";
import {
  render,
  DEFAULT_LOCATION,
  UNPAID_REMINDER_2H,
  UNPAID_REMINDER_FINAL,
  PICKUP_REMINDER_24H,
  BOOKING_ONBOARDING,
  EXTENSION_EDUCATION,
  PAYMENT_EDUCATION,
  RETURN_REMINDER_24H,
  RETURN_EXPECTATIONS,
  ACTIVE_RENTAL_MID,
  ACTIVE_RENTAL_1H_BEFORE_END,
  LATE_GRACE_STARTED,
  LATE_ESCALATION,
  PAYMENT_FAILED_BALANCE,
  LATE_WARNING_30MIN,
  LATE_AT_RETURN_TIME,
  LATE_GRACE_EXPIRED,
  LATE_FEE_APPLIED,
  POST_RENTAL_THANK_YOU,
  RETENTION_DAY_7,
  BALANCE_DUE_REMINDER,
  BALANCE_OVERDUE,
  BALANCE_OVERDUE_30,
  BALANCE_OVERDUE_60,
} from "./_sms-templates.js";
import { loadBookings, saveBookings, normalizePhone, updateBooking } from "./_bookings.js";
import { upsertContact } from "./_contacts.js";
import { LATE_FEE_BASE } from "./_pricing.js";
import { autoUpsertBooking, autoUpsertCustomer, autoCreateRevenueRecord } from "./_booking-automation.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { buildLateFeeUrls } from "./_late-fee-token.js";
import { loadBooleanSetting } from "./_settings.js";
import { DEFAULT_RETURN_TIME, formatTime12h, laHour, isoDateInLA } from "./_time.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { toAppBookingStatus, toDbBookingStatus } from "./_booking-status.js";
import { getRentalState } from "./_rental-state.js";
import { getSmsPriority } from "./_sms-priority.js";
import {
  computeSmsScoreWithBreakdown,
  computeEffectiveThreshold,
  isSuppressedByProximity,
  fetchRecentSmsLogs,
  buildSmsContext,
} from "./_sms-scoring.js";
import { shouldSendBalanceCollectionReminder } from "./_sms-lifecycle.js";
import Stripe from "stripe";
import {
  saveWebhookBookingRecord,
  blockBookedDates,
  markVehicleUnavailable,
  sendWebhookNotificationEmails,
  mapVehicleId,
} from "./stripe-webhook.js";
import { buildRenterPortalLinks } from "./_sms-links.js";
import { maybeSkipScheduledAutomation } from "./_runtime-environment.js";

// ─── Late-fee amounts ──────────────────────────────────────────────────────────
// Global rule for all cars: fixed $25 late fee after grace/reset windows.
const SHORT_LATE_FEE = LATE_FEE_BASE; // applied after 30-minute grace period (fixed)

// Hard cap on any single late-fee assessment.  Prevents runaway fees caused by
// stale bookings.json entries that remain as "active_rental" for days/weeks.
// Consistent with MAX_CHARGE_WARN_USD in approve-late-fee.js.
const MAX_LATE_FEE_USD = 500;

// Preparation buffer added to the return time before the vehicle is available
// for the next pickup.  Must match BOOKING_BUFFER_HOURS in _booking-automation.js
// and _availability.js.
const BOOKING_BUFFER_HOURS = 2;

// Maximum hours-overdue window in which a late fee may be triggered.
// If hoursOverdue exceeds this threshold the booking was never auto-completed
// (stale status, cron outage, etc.).  The system now uses fixed late fees
// ($25 at +30 min, and $25 at +3 h) rather than hourly amounts, so this guard
// prevents escalation SMS alerts from firing on long-stale bookings that
// should have already been marked completed by the AUTO_COMPLETE_HOURS path.
const MAX_FEE_OVERDUE_HOURS = 8;

// ─── Auto-completion threshold ────────────────────────────────────────────────
// Active rentals that are still open this many hours past the scheduled return
// time are automatically transitioned to "completed_rental".  This frees up
// the vehicle for new bookings without requiring manual admin intervention.
// Spec section 2: auto-clean fires at now > return_date + 24 h.
const AUTO_COMPLETE_HOURS = 24;

const OWNER_PHONE = process.env.OWNER_PHONE || "+18445114059";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
const FLEET_STATUS_PATH  = "fleet-status.json";
const TRIGGER_WINDOW_MS  = 15 * 60 * 1000;
const MS_PER_HOUR        = 60 * 60 * 1000;
// grace_end  = return_time + 30 minutes
const GRACE_OFFSET_MS    = 30 * 60 * 1000;
// reset_time = return_time + 3 hours (escalation to higher late fee)
const LATE_FEE_OFFSET_MS = 3 * MS_PER_HOUR;

// Boundaries (in minutes) for the end-of-rental warning SMS window.
// Cron runs every 5 min so a 15-min window ensures the message fires exactly once.
// Window is (WARNING_BEFORE_END_LOWER_MIN, WARNING_BEFORE_END_UPPER_MIN]:
//   minutesUntilReturn > 15 && minutesUntilReturn <= 30  →  fires once per return event
const WARNING_BEFORE_END_UPPER_MIN = 30; // inclusive upper bound: fires when ≤ 30 min remain
const WARNING_BEFORE_END_LOWER_MIN = 15; // exclusive lower bound: does not fire when ≤ 15 min remain

// Boundaries (in minutes) for the 1-hour-before-return extension invitation window.
// Fires once in the 45–60 min window ("about 1 hour"), well clear of the 15–30 min
// return-obligation warning so renters never receive both in the same cron tick.
const EXT_REMINDER_UPPER_MIN = 60; // inclusive upper bound: fires when ≤ 60 min remain
const EXT_REMINDER_LOWER_MIN = 45; // exclusive lower bound: does not fire when ≤ 45 min remain

// Boundaries (in minutes) for the same-day return reminder window.
// Fires once in the 420–480 min window (7–8 h before return), bridging the
// gap between the 24h reminder and the 1h extension invite.  The 60-min
// window mirrors other reminder bands and gives cron ~6 attempts (10-min cadence)
// while keeping dedup as a safety net rather than the primary guard.
const SAME_DAY_REMINDER_UPPER_MIN = 480; // inclusive upper bound: fires when ≤ 480 min (8 h) remain
const SAME_DAY_REMINDER_LOWER_MIN = 420; // exclusive lower bound: does not fire when ≤ 420 min (7 h) remain

// Boundaries (in minutes) for the 24-hour-before-return reminder window.
// Fires once in the 1,380–1,440 min window (23–24 h before return).
// Cron runs every 5 min, so a 60-min window guarantees the message fires exactly
// once even if a cron tick is delayed or skipped.
const RETURN_REMINDER_24H_UPPER_MIN = 1440; // inclusive upper bound: fires when ≤ 1440 min (24 h) remain
const RETURN_REMINDER_24H_LOWER_MIN = 1380; // exclusive lower bound: does not fire when ≤ 1380 min (23 h) remain

// RepairMode window bounds — used when processActiveRentals is called with
// { repairMode: true } to catch up on SMS that were missed due to cron gaps.
// Windows are intentionally wider than the regular bands; sms_logs dedup
// prevents re-sends even if the window overlaps an already-fired message.
const REPAIR_LATE_WARN_UPPER_MIN   =   60; // late_warning_30min: up to 60 min before return
const REPAIR_LATE_WARN_LOWER_MIN   =  -30; // …or up to 30 min past return (just missed the window)
const REPAIR_EXT_1H_UPPER_MIN      =  120; // active_rental_1h_before_end: any time return is within 2 h
const REPAIR_RETURN_24H_LOWER_MIN  =  120; // return_reminder_24h: fire if return is still > 2 h away

// SMS send-window boundaries — messages are only delivered between these hours
// in America/Los_Angeles (PDT) time to avoid waking renters outside business hours.
const SMS_WINDOW_START_HOUR = 5;  // 5:00 AM LA (PDT)
const SMS_WINDOW_END_HOUR   = 22; // 10:00 PM LA (PDT, exclusive)
const ONBOARDING_CATCHUP_WINDOW_HOURS = 24;
const ONBOARDING_CATCHUP_EXTENSION_MIN_DELAY_MIN = 30;
const ONBOARDING_CATCHUP_STATUSES = new Set(["active_rental", "active", "overdue"]);
const PENDING_EXTENSION_HOLD_STATUSES = new Set([
  "pending",
  "processing",
  "requires_payment_method",
  "requires_action",
  "requires_confirmation",
]);

function hasPendingExtensionHold(booking = {}) {
  if (booking.extendPending === true) return true;
  if (booking.extensionPaymentPending === true) return true;
  if (String(booking.extensionRequestStatus || "").toLowerCase() === "pending_payment") return true;
  const ext = booking.extensionPendingPayment;
  if (!ext || typeof ext !== "object") return false;
  const extStatus = String(ext.status || "").toLowerCase();
  return PENDING_EXTENSION_HOLD_STATUSES.has(extStatus);
}

// Sentinel date used in sms_logs for SMS that are not tied to a specific
// return date (pickup reminders, unpaid reminders, etc.).  Using a fixed
// non-null value lets the UNIQUE constraint (booking_id, template_key,
// return_date_at_send) work correctly for those messages too.
const SMS_LOGS_SENTINEL_DATE = "1970-01-01";

// ─── Supabase sms_logs helpers ────────────────────────────────────────────────
// These helpers provide extension-aware SMS deduplication.  Every return-time
// SMS is recorded with the booking's current return_date so that if the booking
// is extended the old log rows no longer match the new return_date, allowing the
// correct messages to fire for the new schedule.
//
// Both functions are non-fatal: if Supabase is unavailable the caller falls
// back to the bookings.json smsSentAt flags.

/**
 * Returns true when an SMS with this key has already been sent for the given
 * return_date (or for any date when returnDateStr is falsy/sentinel).
 * @param {string} bookingId      - booking_ref (bk-...)
 * @param {string} templateKey    - e.g. 'late_at_return'
 * @param {string} [returnDateStr] - YYYY-MM-DD return_date; omit for non-return-time messages
 * @returns {Promise<boolean>}
 */
async function isSmsLogged(bookingId, templateKey, returnDateStr) {
  const sb = getSupabaseAdmin();
  if (!sb || !bookingId) return false;
  try {
    const date = returnDateStr || SMS_LOGS_SENTINEL_DATE;
    const { data, error } = await sb
      .from("sms_logs")
      .select("id")
      .eq("booking_id", bookingId)
      .eq("template_key", templateKey)
      .eq("return_date_at_send", date)
      .maybeSingle();
    if (error) {
      console.warn("scheduled-reminders: sms_logs read error (non-fatal):", error.message);
      return false;
    }
    return !!data;
  } catch (err) {
    console.warn("scheduled-reminders: sms_logs check failed (non-fatal):", err.message);
    return false;
  }
}

/**
 * Persist a sent-SMS record to the sms_logs table.
 * Uses upsert so duplicate calls are idempotent.
 * Always stores `{ priority }` in metadata so the cross-cron cooldown gate
 * can compare priorities of messages from different cron jobs.
 *
 * Retries up to MAX_SMS_LOG_RETRIES times with an exponential back-off so
 * that transient Supabase errors do not leave the dedup table empty (which
 * would allow the next cron tick to re-send the same message).
 *
 * @param {string} bookingId
 * @param {string} templateKey
 * @param {string} [returnDateStr] - YYYY-MM-DD; omit for non-return-time messages
 * @param {object} [metadata]      - optional JSON payload (e.g. link validation result)
 */
const MAX_SMS_LOG_RETRIES  = 3;
const SMS_LOG_RETRY_BASE_MS = 300; // 300 ms → 600 ms → 1200 ms

async function logSmsToSupabase(bookingId, templateKey, returnDateStr, metadata) {
  const sb = getSupabaseAdmin();
  if (!sb || !bookingId) return;
  const date = returnDateStr || SMS_LOGS_SENTINEL_DATE;
  const row = {
    booking_id:          bookingId,
    template_key:        templateKey,
    return_date_at_send: date,
    // Always include priority so cross-cron cooldown queries are accurate.
    metadata: {
      priority: getSmsPriority(templateKey),
      ...(metadata && typeof metadata === "object" ? metadata : {}),
    },
  };
  for (let attempt = 1; attempt <= MAX_SMS_LOG_RETRIES; attempt++) {
    try {
      const { error } = await sb
        .from("sms_logs")
        .upsert(row, { onConflict: "booking_id,template_key,return_date_at_send" });
      if (!error) return; // success
      console.warn(
        `scheduled-reminders: sms_logs write error (attempt ${attempt}/${MAX_SMS_LOG_RETRIES}):`,
        error.message
      );
    } catch (err) {
      console.warn(
        `scheduled-reminders: sms_logs write failed (attempt ${attempt}/${MAX_SMS_LOG_RETRIES}):`,
        err.message
      );
    }
    if (attempt < MAX_SMS_LOG_RETRIES) {
      await new Promise((r) => setTimeout(r, SMS_LOG_RETRY_BASE_MS * attempt));
    }
  }
  console.error(
    `scheduled-reminders: sms_logs write FAILED after ${MAX_SMS_LOG_RETRIES} attempts ` +
    `for ${bookingId}/${templateKey}/${date} — dedup record is missing, duplicate risk elevated`
  );
}

// ─── SMS delivery visibility log ──────────────────────────────────────────────
// Writes a single row to sms_delivery_logs for every SMS attempt, capturing
// the outcome (sent / failed / skipped).  This is a separate table from the
// dedup sms_logs table — it does NOT affect deduplication logic.
// Non-fatal: a write failure is logged but never re-thrown.

/**
 * Append one row to sms_delivery_logs.
 * @param {object} ctx
 * @param {string|null} ctx.booking_ref
 * @param {string|null} ctx.vehicle_id
 * @param {string|null} ctx.renter_phone
 * @param {string|null} ctx.message_type
 * @param {string|null} ctx.message_body
 * @param {string}      ctx.status        - 'sent' | 'failed' | 'skipped'
 * @param {string|null} [ctx.error]
 * @param {string|null} [ctx.provider_id] - TextMagic session id (sent rows only)
 */
async function logSmsDelivery({ booking_ref, vehicle_id, renter_phone, message_type, message_body, status, error, provider_id }) {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  try {
    const { error: dbErr } = await sb.from("sms_delivery_logs").insert({
      booking_ref:  booking_ref  || null,
      vehicle_id:   vehicle_id   || null,
      renter_phone: renter_phone || null,
      message_type: message_type || null,
      message_body: message_body || null,
      status,
      error:        error        || null,
      provider_id:  provider_id  || null,
    });
    if (dbErr) {
      console.warn("scheduled-reminders: sms_delivery_logs write error (non-fatal):", dbErr.message);
    }
  } catch (err) {
    console.warn("scheduled-reminders: sms_delivery_logs write failed (non-fatal):", err.message);
  }
}

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function loadBookedDates() {
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers: ghHeaders() });
  if (!getResp.ok) {
    if (getResp.status === 404) return { data: {}, sha: null };
    return { data: {}, sha: null };
  }
  const fileData = await getResp.json();
  let data = {};
  try {
    data = JSON.parse(Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (typeof data !== "object" || Array.isArray(data)) data = {};
  } catch { data = {}; }
  return { data, sha: fileData.sha };
}

async function saveBookedDates(_data, _sha, _message) {
  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  console.log("scheduled-reminders: saveBookedDates() called but writes are disabled (Phase 4)");
}

/**
 * Remove a specific date range from booked-dates.json (non-fatal).
 * @param {string} vehicleId
 * @param {string} from - YYYY-MM-DD
 * @param {string} to   - YYYY-MM-DD
 */
async function removeFromBookedDates(vehicleId, from, to) {
  if (!process.env.GITHUB_TOKEN || !vehicleId || !from || !to) return;
  try {
    await updateJsonFileWithRetry({
      load:    loadBookedDates,
      apply:   (data) => {
        if (!Array.isArray(data[vehicleId])) return;
        data[vehicleId] = data[vehicleId].filter((r) => !(r.from === from && r.to === to));
      },
      save:    saveBookedDates,
      message: `Auto-complete: unblock ${vehicleId} ${from}→${to}`,
    });
  } catch (err) {
    console.error("scheduled-reminders: removeFromBookedDates failed (non-fatal):", err.message);
  }
}

async function loadFleetStatus() {
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers: ghHeaders() });
  if (!getResp.ok) {
    if (getResp.status === 404) return { data: {}, sha: null };
    return { data: {}, sha: null };
  }
  const fileData = await getResp.json();
  let data = {};
  try {
    data = JSON.parse(Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (typeof data !== "object" || Array.isArray(data)) data = {};
  } catch { data = {}; }
  return { data, sha: fileData.sha };
}

async function saveFleetStatus(data, sha, message) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content, branch: GITHUB_DATA_BRANCH };
  if (sha) body.sha = sha;
  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT fleet-status.json failed: ${resp.status} ${text}`);
  }
}

/**
 * Previously wrote `available: true` to fleet-status.json on GitHub.
 * Availability is now derived automatically from the Supabase bookings table
 * by fleet-status.js — when a booking's status changes to `completed_rental`
 * it leaves the ACTIVE_BOOKING_STATUSES set, and the vehicle is automatically
 * shown as available again.  No manual flag write is needed.
 * @param {string} vehicleId
 */
async function markVehicleAvailable(vehicleId) {
  // No-op: availability is derived from bookings, not a manual flag.
  if (vehicleId) {
    console.log(`scheduled-reminders: markVehicleAvailable(${vehicleId}) — skipped, availability is now bookings-driven`);
  }
}

const BUSINESS_TZ = "America/Los_Angeles";

/**
 * Format a Date as a human-readable Los Angeles wall-clock string.
 * Used in debug logs so that timestamp comparisons are easy to reason about.
 * e.g. "5/1/2026, 3:00:00 PM PDT"
 * @param {Date} date
 * @returns {string}
 */
function toLAString(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return String(date);
  return date.toLocaleString("en-US", {
    timeZone:     BUSINESS_TZ,
    timeZoneName: "short",
    year:         "numeric",
    month:        "numeric",
    day:          "numeric",
    hour:         "numeric",
    minute:       "2-digit",
    second:       "2-digit",
    hour12:       true,
  });
}

function normalizeTimeForLAIso(time) {
  if (!time) return "00:00:00";
  const t = String(time).trim();
  const ampmMatch = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const mins = parseInt(ampmMatch[2], 10);
    const secs = parseInt(ampmMatch[3] || "0", 10);
    const period = ampmMatch[4].toUpperCase();
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  const h24Match = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (h24Match) {
    return `${String(parseInt(h24Match[1], 10)).padStart(2, "0")}:${String(parseInt(h24Match[2], 10)).padStart(2, "0")}:${String(parseInt(h24Match[3] || "0", 10)).padStart(2, "0")}`;
  }
  return "00:00:00";
}

/**
 * Centralized LA datetime builder for booking date+time fields.
 * Returns an absolute Date for the provided Los Angeles wall-clock datetime.
 * @param {string} date - YYYY-MM-DD
 * @param {string} time - booking time (12h/24h)
 * @returns {Date}
 */
function buildDateTimeLA(date, time) {
  if (!date) return new Date(NaN);
  const datePart = String(date instanceof Date ? date.toISOString() : date).trim().split("T")[0];
  const timePart = normalizeTimeForLAIso(time);
  const approxUtc = new Date(`${datePart}T${timePart}Z`);
  let tzOffset = "-08:00"; // PST fallback when Intl offset extraction is unavailable
  try {
    const tzPart = new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TZ,
      timeZoneName: "longOffset",
    }).formatToParts(approxUtc).find((p) => p.type === "timeZoneName")?.value || "";
    const match = tzPart.match(/GMT([+-]\d{1,2}:\d{2})/);
    if (match) tzOffset = match[1];
  } catch {
    // Keep fallback offset.
  }
  return new Date(`${datePart}T${timePart}${tzOffset}`);
}

function parseBookingDateTimeLA(date, time) {
  return buildDateTimeLA(date, time);
}

/**
 * Format a date object into a human-readable date string ("March 28").
 * Always formats in LA timezone so displayed dates are consistent regardless
 * of the server's system timezone.
 */
function formatDate(d) {
  if (!d || isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { timeZone: BUSINESS_TZ, month: "long", day: "numeric" });
}

/**
 * Format a date object into a human-readable time string ("3:00 PM").
 * Always formats in LA timezone so displayed times match LA wall-clock time.
 */
function formatTime(d) {
  if (!d || isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", minute: "2-digit", hour12: true });
}

/**
 * Safely send an SMS, catching errors so one failure doesn't abort the whole job.
 * When logCtx is supplied, every attempt (sent / failed / skipped) is recorded
 * in sms_delivery_logs for visibility.  Existing callers that omit logCtx are
 * unaffected.
 * @param {string}      phone
 * @param {string}      body
 * @param {object|null} [logCtx]             - optional delivery log context
 * @param {string|null} [logCtx.booking_ref] - booking_ref (bk-...)
 * @param {string|null} [logCtx.vehicle_id]
 * @param {string|null} [logCtx.message_type] - template key
 * @returns {Promise<boolean>} true on success
 */
async function safeSend(phone, body, logCtx = null) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    console.log("[SMS SKIPPED — NO PHONE]", logCtx?.booking_ref || "(no ref)");
    if (logCtx) {
      await logSmsDelivery({
        booking_ref:  logCtx.booking_ref  || null,
        vehicle_id:   logCtx.vehicle_id   || null,
        renter_phone: null,
        message_type: logCtx.message_type || null,
        message_body: body,
        status:       "skipped",
        error:        "[SMS SKIPPED — NO PHONE]",
      });
    }
    console.log("[SMS_EVENT_TRACE]", JSON.stringify({
      ts: new Date().toISOString(),
      booking_id: logCtx?.booking_ref || null,
      template_key: logCtx?.message_type || null,
      trigger_source: "scheduled_reminders",
      payment_state: logCtx?.payment_state || null,
      delivery_status: "skipped",
      provider_id: null,
      error: "missing_phone",
    }));
    return false;
  }
  try {
    const tmResult = await sendSms(normalized, body);
    const providerId = tmResult && tmResult.id != null ? String(tmResult.id) : null;
    if (logCtx) {
      await logSmsDelivery({
        booking_ref:  logCtx.booking_ref  || null,
        vehicle_id:   logCtx.vehicle_id   || null,
        renter_phone: normalized,
        message_type: logCtx.message_type || null,
        message_body: body,
        status:       "sent",
        provider_id:  providerId,
      });
    }
    console.log("[SMS_EVENT_TRACE]", JSON.stringify({
      ts: new Date().toISOString(),
      booking_id: logCtx?.booking_ref || null,
      template_key: logCtx?.message_type || null,
      trigger_source: "scheduled_reminders",
      payment_state: logCtx?.payment_state || null,
      delivery_status: "sent",
      provider_id: providerId,
      error: null,
    }));
    return true;
  } catch (err) {
    console.error(`scheduled-reminders: SMS send failed to ${normalized}:`, err.message);
    if (logCtx) {
      await logSmsDelivery({
        booking_ref:  logCtx.booking_ref  || null,
        vehicle_id:   logCtx.vehicle_id   || null,
        renter_phone: normalized,
        message_type: logCtx.message_type || null,
        message_body: body,
        status:       "failed",
        error:        err.message,
      });
    }
    console.log("[SMS_EVENT_TRACE]", JSON.stringify({
      ts: new Date().toISOString(),
      booking_id: logCtx?.booking_ref || null,
      template_key: logCtx?.message_type || null,
      trigger_source: "scheduled_reminders",
      payment_state: logCtx?.payment_state || null,
      delivery_status: "failed",
      provider_id: null,
      error: err.message || String(err),
    }));
    return false;
  }
}

/**
 * Check if a reminder has already been sent for this booking.
 */
function alreadySent(booking, key) {
  return !!(booking.smsSentAt && booking.smsSentAt[key]);
}

function alreadySentAny(booking, keys) {
  return keys.some((key) => alreadySent(booking, key));
}

function buildVehicleExtendLink(booking) {
  const bookingId = booking?.bookingId || booking?.paymentIntentId || "";
  const vehicleId = booking?.vehicleId || booking?.vehicle_id || "";
  const manageToken = booking?.manageToken || booking?.manage_token || "";
  return buildRenterPortalLinks({ bookingId, manageToken, vehicleId }).extendLink;
}

function buildManagePortalLink(booking) {
  const bookingId = booking?.bookingId || booking?.paymentIntentId || "";
  const vehicleId = booking?.vehicleId || booking?.vehicle_id || "";
  const manageToken = booking?.manageToken || booking?.manage_token || "";
  return buildRenterPortalLinks({ bookingId, manageToken, vehicleId }).manageLink;
}

function getBookingPaymentLinkWithFallback(booking) {
  return booking?.paymentLink || booking?.balancePaymentLink || buildVehicleExtendLink(booking);
}

/**
 * Build template variables for a booking.
 */
function vars(booking) {
  const pickupDt = parseBookingDateTimeLA(booking.pickupDate, booking.pickupTime);
  const returnDt = parseBookingDateTimeLA(booking.returnDate, booking.returnTime);
  const bufferedReturnDt = new Date(returnDt.getTime() + BOOKING_BUFFER_HOURS * 60 * 60 * 1000);
  return {
    customer_name: booking.name || "Customer",
    booking_id:    booking.bookingId || booking.paymentIntentId || "",
    vehicle:       booking.vehicleName || booking.vehicleId,
    pickup_date:   booking.pickupDate ? formatDate(pickupDt) : booking.pickupDate || "",
    pickup_time:   booking.pickupTime ? (formatTime(pickupDt) || formatTime12h(booking.pickupTime)) : "",
    return_time:   booking.returnTime ? (formatTime(returnDt) || formatTime12h(booking.returnTime)) : "",
    buffered_time: booking.returnTime ? (formatTime(bufferedReturnDt) || "") : "",
    return_date:   booking.returnDate ? formatDate(returnDt) : booking.returnDate || "",
    location:      booking.location || DEFAULT_LOCATION,
    payment_link:  getBookingPaymentLinkWithFallback(booking),
    extend_link:   buildVehicleExtendLink(booking),
  };
}

/**
 * Request admin approval before charging a late fee.
 *
 * Sends the owner:
 *   1. An email with Approve / Decline buttons (HTML links).
 *   2. An SMS with a short Approve link (if TEXTMAGIC is configured).
 *
 * The customer is notified that a late fee has been assessed (same
 * LATE_FEE_APPLIED SMS that was sent before) so they are aware.
 * The actual Stripe charge only happens when the admin clicks Approve.
 *
 * @param {object} booking
 * @param {number} feeAmount  — USD
 * @returns {Promise<boolean>} true if at least one notification was sent
 */
async function requestLateFeeApproval(booking, feeAmount) {
  const bookingId  = booking.bookingId || booking.paymentIntentId;
  const renterName = booking.name || "Customer";
  const vehicle    = booking.vehicleName || booking.vehicleId || "";

  let sent = false;

  // Build HMAC-signed approve / adjust / decline URLs (24 h expiry)
  const { approveUrl, declineUrl, adjustUrl } = buildLateFeeUrls(bookingId, feeAmount);

  // ── Email to owner ──────────────────────────────────────────────────────
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && OWNER_EMAIL) {
    try {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_PORT === "465",
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      const escStr = (s) => String(s || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      await transporter.sendMail({
        from:    `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
        to:      OWNER_EMAIL,
        subject: `[Action Required] Late Fee $${feeAmount} — ${renterName} (${vehicle})`,
        html: `
          <h2>⏰ Late Return — Approval Required</h2>
          <p><strong>${escStr(renterName)}</strong> is overdue on their <strong>${escStr(vehicle)}</strong> rental.</p>
          <table style="border-collapse:collapse;width:100%;margin:16px 0">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(bookingId)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Customer</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(renterName)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(vehicle)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Late Fee</strong></td><td style="padding:8px;border:1px solid #ddd;color:#e53935"><strong>$${escStr(String(feeAmount))}</strong></td></tr>
          </table>
          <p style="margin-top:24px">
            <a href="${escStr(approveUrl)}" style="display:inline-block;padding:12px 24px;background:#4caf50;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;margin-right:12px">
              ✅ Approve &amp; Charge $${escStr(String(feeAmount))}
            </a>
            <a href="${escStr(adjustUrl)}" style="display:inline-block;padding:12px 24px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;margin-right:12px">
              ✏️ Adjust Amount
            </a>
            <a href="${escStr(declineUrl)}" style="display:inline-block;padding:12px 24px;background:#888;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">
              ❌ Decline — Do Not Charge
            </a>
          </p>
          <p style="color:#888;font-size:12px;margin-top:16px">These links expire in 24 hours. You can also charge manually from the <a href="https://admin.slycarrentals.com/admin-v2/">Admin Panel</a>.</p>
          <p><strong>Sly Car Rentals LLC 🚗</strong></p>
        `,
        text: [
          `Late Return — Approval Required`,
          ``,
          `${renterName} is overdue on their ${vehicle} rental.`,
          `Booking ID : ${bookingId}`,
          `Late Fee   : $${feeAmount}`,
          ``,
          `APPROVE & charge: ${approveUrl}`,
          `ADJUST amount:    ${adjustUrl}`,
          `DECLINE (no charge): ${declineUrl}`,
          ``,
          `Links expire in 24 hours. Or charge manually from https://admin.slycarrentals.com/admin-v2/`,
        ].join("\n"),
      });
      sent = true;
    } catch (err) {
      console.warn("scheduled-reminders: owner late-fee approval email failed:", err.message);
    }
  }

  // ── SMS to owner (short approve link) ──────────────────────────────────
  if (process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY && OWNER_PHONE) {
    try {
      const smsText =
        `[Sly Car Rentals] Late fee alert: ${renterName} (${vehicle}) is overdue.\n` +
        `Approve $${feeAmount} charge: ${approveUrl}\n` +
        `Adjust amount: ${adjustUrl}\n` +
        `Decline (no charge): ${declineUrl}`;
      await sendSms(OWNER_PHONE, smsText);
      sent = true;
    } catch (err) {
      console.warn("scheduled-reminders: owner late-fee approval SMS failed:", err.message);
    }
  }

  return sent;
}

/**
 * Process all reserved_unpaid bookings — send payment reminders.
 */
async function processUnpaid(allBookings, now, sentMarks) {
  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "reserved_unpaid") continue;
      if (!booking.phone) {
        console.log(`[SMS SKIPPED — NO PHONE] ${booking.bookingId || booking.paymentIntentId || "?"}: status=${booking.status} vehicle=${vehicleId}`);
        continue;
      }

      // Use LA-timezone datetime so SMS fires at the correct wall-clock time in LA
      const pickupDt = parseBookingDateTimeLA(booking.pickupDate, booking.pickupTime);
      if (isNaN(pickupDt.getTime())) continue;

      const minutesUntilPickup = (pickupDt - now) / 60000;
      const id = booking.bookingId || booking.paymentIntentId;
      const v = vars(booking);

      console.log("[SMS_TRIGGER]", {
        booking_ref: id, vehicleId, status: "reserved_unpaid",
        pickup_datetime: pickupDt.toISOString(), minutesUntilPickup: Math.round(minutesUntilPickup),
      });

      // 2-hour reminder (window: 2h–90min)
      if (minutesUntilPickup <= 120 && minutesUntilPickup > 90 && !alreadySent(booking, "unpaid_2h") &&
          !(await isSmsLogged(id, "unpaid_2h"))) {
        const sent = await safeSend(booking.phone, render(UNPAID_REMINDER_2H, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "unpaid_2h" });
        if (sent) {
          sentMarks.push({ vehicleId, id, key: "unpaid_2h" });
          await logSmsToSupabase(id, "unpaid_2h");
        }
      } else if (minutesUntilPickup <= 120 && minutesUntilPickup > 90) {
        console.log(`[SMS_SKIP] ${id} unpaid_2h: already sent`);
      }

      // Final reminder (window: 30–15 min)
      if (minutesUntilPickup <= 30 && minutesUntilPickup > 15 && !alreadySent(booking, "unpaid_final") &&
          !(await isSmsLogged(id, "unpaid_final"))) {
        const sent = await safeSend(booking.phone, render(UNPAID_REMINDER_FINAL, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "unpaid_final" });
        if (sent) {
          sentMarks.push({ vehicleId, id, key: "unpaid_final" });
          await logSmsToSupabase(id, "unpaid_final");
        }
      } else if (minutesUntilPickup <= 30 && minutesUntilPickup > 15) {
        console.log(`[SMS_SKIP] ${id} unpaid_final: already sent`);
      }
    }
  }
}

const ACTIVE_RENTER_STATUSES = new Set(["active_rental", "active", "overdue"]);
const COMPLETED_RENTER_STATUSES = new Set(["completed_rental", "completed"]);

function normalizeRenterContactInfo(booking) {
  return {
    phone: normalizePhone(booking?.phone || ""),
    email: String(booking?.email || "").trim().toLowerCase(),
  };
}

function isoDateAtTimezone(date, tz = BUSINESS_TZ) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  if (tz === BUSINESS_TZ) return isoDateInLA(date);
  return date.toLocaleDateString("en-CA", { timeZone: tz });
}

function hourAtTimezone(date, tz = BUSINESS_TZ) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return NaN;
  return parseInt(
    date.toLocaleString("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    }),
    10
  );
}

function dateDiffDaysIso(a, b) {
  if (!a || !b) return NaN;
  const aDate = new Date(`${a}T00:00:00Z`);
  const bDate = new Date(`${b}T00:00:00Z`);
  if (isNaN(aDate.getTime()) || isNaN(bDate.getTime())) return NaN;
  return Math.floor((bDate.getTime() - aDate.getTime()) / (24 * 60 * 60 * 1000));
}

async function hasRecentSmsWithin(sb, bookingId, minutes) {
  if (!sb || !bookingId || !Number.isFinite(minutes) || minutes <= 0) return false;
  const recentRows = await fetchRecentSmsLogs(sb, bookingId);
  if (!Array.isArray(recentRows) || recentRows.length === 0) return false;
  const latestMs = Math.max(
    ...recentRows
      .map((r) => new Date(r.sent_at).getTime())
      .filter((ms) => Number.isFinite(ms))
  );
  if (!Number.isFinite(latestMs)) return false;
  return (Date.now() - latestMs) < minutes * 60 * 1000;
}

function getOnboardingAnchorDate(booking) {
  const raw = booking?.smsSentAt?.booking_confirmed || booking?.createdAt || null;
  if (!raw) return null;
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

function shouldProcessOnboardingCatchup(booking, now) {
  if (!booking || !ONBOARDING_CATCHUP_STATUSES.has(booking.status)) return false;
  const id = booking.bookingId || booking.paymentIntentId;
  if (!id || !booking.phone) return false;
  const anchor = getOnboardingAnchorDate(booking);
  if (!anchor) return false;
  const ageHours = (now.getTime() - anchor.getTime()) / MS_PER_HOUR;
  if (!Number.isFinite(ageHours) || ageHours < 0) return false;
  if (ageHours > ONBOARDING_CATCHUP_WINDOW_HOURS) return false;
  return true;
}

/**
 * Process all booked_paid bookings — send pre-pickup reminders.
 */
export async function processPaidBookings(allBookings, now, sentMarks) {
  const sb = getSupabaseAdmin();
  const activeRenterPhones = new Set();
  const activeRenterEmails = new Set();

  for (const bookings of Object.values(allBookings)) {
    for (const booking of bookings) {
      if (!ACTIVE_RENTER_STATUSES.has(booking.status)) continue;
      const { phone: normalizedPhone, email: normalizedEmail } = normalizeRenterContactInfo(booking);
      if (normalizedPhone) activeRenterPhones.add(normalizedPhone);
      if (normalizedEmail) activeRenterEmails.add(normalizedEmail);
    }
  }

  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "booked_paid") continue;
      if (!booking.phone) {
        console.log(`[SMS SKIPPED — NO PHONE] ${booking.bookingId || booking.paymentIntentId || "?"}: status=${booking.status} vehicle=${vehicleId}`);
        continue;
      }

      const { phone: normalizedPhone, email: normalizedEmail } = normalizeRenterContactInfo(booking);
      if ((normalizedPhone && activeRenterPhones.has(normalizedPhone)) ||
          (normalizedEmail && activeRenterEmails.has(normalizedEmail))) {
        console.log(`[SMS_SKIP] ${booking.bookingId || booking.paymentIntentId || "?"} pickup_24h: renter already active`);
        continue;
      }

      // Use LA-timezone datetime so SMS fires at the correct wall-clock time in LA
      const pickupDt = parseBookingDateTimeLA(booking.pickupDate, booking.pickupTime);
      if (isNaN(pickupDt.getTime())) continue;

      const minutesUntilPickup = (pickupDt - now) / 60000;
      const id = booking.bookingId || booking.paymentIntentId;
      const v = vars(booking);

      console.log("[SMS_TRIGGER]", {
        booking_ref: id, vehicleId, status: "booked_paid",
        pickup_datetime: pickupDt.toISOString(), minutesUntilPickup: Math.round(minutesUntilPickup),
      });

      // 24-hour reminder (window: 24h–23h)
      if (minutesUntilPickup <= 24 * 60 && minutesUntilPickup > 23 * 60 && !alreadySent(booking, "pickup_24h") &&
          !(await isSmsLogged(id, "pickup_24h"))) {
        const sent = await safeSend(booking.phone, render(PICKUP_REMINDER_24H, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "pickup_24h" });
        if (sent) {
          sentMarks.push({ vehicleId, id, key: "pickup_24h" });
          await logSmsToSupabase(id, "pickup_24h");
        }
      } else if (minutesUntilPickup <= 24 * 60 && minutesUntilPickup > 23 * 60) {
        console.log(`[SMS_SKIP] ${id} pickup_24h: already sent`);
      }

      // Booking onboarding (near-immediate catch-up path if webhook missed it)
      // Suppress for same-day rentals to avoid onboarding on near-complete trips.
      if (
        booking.smsSentAt?.booking_confirmed &&
        booking.pickupDate !== booking.returnDate &&
        !alreadySent(booking, "booking_onboarding") &&
        !(await isSmsLogged(id, "booking_onboarding"))
      ) {
        const sent = await safeSend(booking.phone, render(BOOKING_ONBOARDING, {
          ...v,
          manage_link: buildManagePortalLink(booking),
          payment_link: getBookingPaymentLinkWithFallback(booking),
        }), { booking_ref: id, vehicle_id: vehicleId, message_type: "booking_onboarding" });
        if (sent) {
          sentMarks.push({ vehicleId, id, key: "booking_onboarding" });
          await logSmsToSupabase(id, "booking_onboarding");
        }
      }

      // Extension education starts ~30 minutes after confirmation.
      // Suppress if the renter already has one or more extensions.
      if (booking.smsSentAt?.booking_confirmed) {
        const confirmedAt = new Date(booking.smsSentAt.booking_confirmed);
        const minsSinceConfirmed = (now.getTime() - confirmedAt.getTime()) / 60000;
        if (
          Number.isFinite(minsSinceConfirmed) &&
          minsSinceConfirmed >= 30 &&
          // Keep delivery resilient to delayed cron ticks/outages while still
          // targeting an initial send around the 30-minute mark.
          minsSinceConfirmed < 12 * 60 &&
          (booking.extensionCount || 0) <= 0 &&
          !alreadySent(booking, "extension_education") &&
          !(await isSmsLogged(id, "extension_education"))
        ) {
          // Anti-burst guard (20 min): extension education is low urgency and
          // should not stack immediately after another transactional SMS.
          if (!(await hasRecentSmsWithin(sb, id, 20))) {
            const sent = await safeSend(booking.phone, render(EXTENSION_EDUCATION, v), {
              booking_ref: id,
              vehicle_id: vehicleId,
              message_type: "extension_education",
            });
            if (sent) {
              sentMarks.push({ vehicleId, id, key: "extension_education" });
              await logSmsToSupabase(id, "extension_education");
            }
          }
        }
      }

      // Payment education next morning after booking confirmation.
      // Suppress for prepaid rentals (no remaining balance).
      if (booking.smsSentAt?.booking_confirmed) {
        const confirmedAt = new Date(booking.smsSentAt.booking_confirmed);
        const confirmedIsoLA = isoDateAtTimezone(confirmedAt);
        const nowIsoLA = isoDateAtTimezone(now);
        const currentLaHour = hourAtTimezone(now);
        const isNextMorning = dateDiffDaysIso(confirmedIsoLA, nowIsoLA) === 1 && currentLaHour >= 8 && currentLaHour < 12;
        const isPrepaidRental = Number(booking.remainingBalance || 0) <= 0;
        if (
          isNextMorning &&
          !isPrepaidRental &&
          !alreadySent(booking, "payment_education") &&
          !(await isSmsLogged(id, "payment_education"))
        ) {
          // Anti-burst guard (30 min): this message is informational and should
          // wait for a quiet period after overnight operational messaging.
          if (!(await hasRecentSmsWithin(sb, id, 30))) {
            const sent = await safeSend(booking.phone, render(PAYMENT_EDUCATION, {
              ...v,
              payment_link: getBookingPaymentLinkWithFallback(booking),
            }), {
              booking_ref: id,
              vehicle_id: vehicleId,
              message_type: "payment_education",
            });
            if (sent) {
              sentMarks.push({ vehicleId, id, key: "payment_education" });
              await logSmsToSupabase(id, "payment_education");
            }
          }
        }
      }
    }
  }
}

/**
 * Catch-up onboarding lifecycle for recently-confirmed active rentals.
 * Purpose: ensure renters already in-progress benefit from onboarding flows
 * without waiting for future bookings.
 */
export async function processOnboardingCatchup(allBookings, now, sentMarks) {
  const sb = getSupabaseAdmin();
  const currentLaHour = hourAtTimezone(now);

  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (!shouldProcessOnboardingCatchup(booking, now)) continue;

      const id = booking.bookingId || booking.paymentIntentId;
      const v = vars(booking);
      const anchor = getOnboardingAnchorDate(booking);
      const minsSinceAnchor = (now.getTime() - anchor.getTime()) / 60000;
      const returnDt = parseBookingDateTimeLA(booking.returnDate, booking.returnTime);
      const rentalStillInProgress = !isNaN(returnDt.getTime()) && now.getTime() < returnDt.getTime();
      const sameDayRental = booking.pickupDate && booking.returnDate && booking.pickupDate === booking.returnDate;

      if (
        !sameDayRental &&
        !alreadySent(booking, "booking_onboarding") &&
        !(await isSmsLogged(id, "booking_onboarding"))
      ) {
        const sent = await safeSend(booking.phone, render(BOOKING_ONBOARDING, {
          ...v,
          manage_link: buildManagePortalLink(booking),
          payment_link: getBookingPaymentLinkWithFallback(booking),
        }), { booking_ref: id, vehicle_id: vehicleId, message_type: "booking_onboarding" });
        if (sent) {
          sentMarks.push({ vehicleId, id, key: "booking_onboarding" });
          await logSmsToSupabase(id, "booking_onboarding");
        }
      }

      if (
        rentalStillInProgress &&
        Number.isFinite(minsSinceAnchor) &&
        minsSinceAnchor >= ONBOARDING_CATCHUP_EXTENSION_MIN_DELAY_MIN &&
        (booking.extensionCount || 0) <= 0 &&
        !alreadySent(booking, "extension_education") &&
        !(await isSmsLogged(id, "extension_education"))
      ) {
        if (!(await hasRecentSmsWithin(sb, id, 20))) {
          const sent = await safeSend(booking.phone, render(EXTENSION_EDUCATION, v), {
            booking_ref: id,
            vehicle_id: vehicleId,
            message_type: "extension_education",
          });
          if (sent) {
            sentMarks.push({ vehicleId, id, key: "extension_education" });
            await logSmsToSupabase(id, "extension_education");
          }
        }
      }

      const anchorIsoLA = isoDateAtTimezone(anchor);
      const nowIsoLA = isoDateAtTimezone(now);
      const isDayAfterConfirm = dateDiffDaysIso(anchorIsoLA, nowIsoLA) === 1;
      const isPrepaidRental = Number(booking.remainingBalance || 0) <= 0;
      if (
        rentalStillInProgress &&
        isDayAfterConfirm &&
        currentLaHour >= 6 &&
        currentLaHour < 20 &&
        !isPrepaidRental &&
        !alreadySent(booking, "payment_education") &&
        !(await isSmsLogged(id, "payment_education"))
      ) {
        if (!(await hasRecentSmsWithin(sb, id, 30))) {
          const sent = await safeSend(booking.phone, render(PAYMENT_EDUCATION, {
            ...v,
            payment_link: getBookingPaymentLinkWithFallback(booking),
          }), {
            booking_ref: id,
            vehicle_id: vehicleId,
            message_type: "payment_education",
          });
          if (sent) {
            sentMarks.push({ vehicleId, id, key: "payment_education" });
            await logSmsToSupabase(id, "payment_education");
          }
        }
      }
    }
  }
}

function logSmsTrigger(bookingRef, returnDatetime, currentTime, triggerType) {
  console.log("[SMS_TRIGGER]", {
    booking_ref: bookingRef || "",
    return_datetime: returnDatetime || "",
    current_time: currentTime || "",
    trigger_type: triggerType || "",
  });
}

/**
 * Process all active_rental bookings — end reminder, return-time messages, and late fees.
 *
 * SMS flow per booking (ordered by priority, highest first):
 *
 *   P1 — CRITICAL (always deliver, bypass cross-cron cooldown):
 *     • +2 h overdue           → LATE_FEE_APPLIED + owner approval request
 *     • +1 h overdue           → LATE_GRACE_EXPIRED
 *
 *   P2 — IMPORTANT (time-critical narrow windows, bypass cross-cron cooldown):
 *     • At return time         → LATE_AT_RETURN_TIME
 *     • 30 min before return   → LATE_WARNING_30MIN
 *
 *   P3 — STANDARD (cross-cron cooldown applies):
 *     • ~1 h before return     → ACTIVE_RENTAL_1H_BEFORE_END (extension invitation)
 *
 * Priority ordering:
 *   Triggers are evaluated from highest to lowest priority.  The `sentThisBooking`
 *   flag ensures at most ONE SMS fires per booking per cron tick — if a higher-
 *   priority trigger fires, all lower-priority triggers are skipped.
 *
 *   Time-critical keys (P1-P2) bypass the global cross-cron cooldown because
 *   their trigger windows (≤15 min) are shorter than any cooldown period and they
 *   carry their own smsSentAt + sms_logs deduplication.  The P3 extension invite
 *   goes through checkSmsCooldown so it is suppressed if maintenance-alerts or
 *   oil-check-cron already contacted the renter recently.
 *
 * Extension awareness:
 *   Every return-time SMS is logged to the Supabase sms_logs table with
 *   return_date_at_send = booking.returnDate.  When a rental is extended the
 *   return_date changes, so the old log rows no longer match and the messages
 *   fire correctly for the new schedule.  The legacy smsSentAt flags in
 *   bookings.json are still written for backwards compatibility.
 *
 * Anti-spam:
 *   phonesContactedThisRun tracks every phone number that received any SMS
 *   during this invocation.  If the same phone number appears on a second
 *   active booking (e.g. overlapping rentals) it is silently skipped so that
 *   no renter ever receives more than one message per cron tick.
 */
export async function processActiveRentals(allBookings, now, sentMarks, criticalOnly = false, options = {}) {
  const sb = getSupabaseAdmin();
  const { repairMode = false } = options;
  // Per-run dedup: max 1 SMS per phone number per cron invocation.
  const phonesContactedThisRun = new Set();
  const activeRentals = Object.values(allBookings)
    .flat()
    .filter((b) => ACTIVE_RENTER_STATUSES.has(String(b?.status || "").trim()));
  console.log("active rentals:", activeRentals.length);
  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (!ACTIVE_RENTER_STATUSES.has(String(booking?.status || "").trim())) continue;
      if (!booking.phone) {
        console.log(`[SMS SKIPPED — NO PHONE] ${booking.bookingId || booking.paymentIntentId || "?"}: status=${booking.status} vehicle=${vehicleId}`);
        continue;
      }

      // Per-run anti-spam: skip if we already sent to this phone this run.
      if (phonesContactedThisRun.has(booking.phone)) {
        const skipId = booking.bookingId || booking.paymentIntentId;
        console.log(`[SMS_SKIP] ${skipId}: phone ${booking.phone} already contacted this run`);
        continue;
      }

      // Compute the final return date/time from vehicle_blocking_ranges — the
      // single source of truth for the per-segment blocking timeline.  This
      // automatically incorporates paid extensions without separate joins.
      // Falls back to the booking's own returnDate/returnTime when Supabase is
      // unavailable (e.g. null client in test environments).
      const id = booking.bookingId || booking.paymentIntentId;
      let {
        endDate:         finalDate,
        returnTime:      resolvedFinalTime,
        end_datetime:    returnDt,
        minutesToReturn: rsMinutesToReturn,
        isActive:        rsIsActive,
      } = await getRentalState(sb, id);

      console.log("[RENTAL_STATE]", {
        booking_ref:        id,
        status:             booking.status,
        rs_endDate:         finalDate,
        rs_returnTime:      resolvedFinalTime,
        rs_end_datetime:    isNaN(returnDt.getTime()) ? "NaN" : toLAString(returnDt),
        rs_minutesToReturn: rsMinutesToReturn,
        rs_isActive:        rsIsActive,
      });

      if (isNaN(returnDt.getTime())) {
        const fbDate = booking.returnDate || "";
        const fbTime = booking.returnTime || DEFAULT_RETURN_TIME;
        returnDt = buildDateTimeLA(fbDate, fbTime);
        finalDate = fbDate;
        resolvedFinalTime = fbTime;
        console.log("[RENTAL_STATE_FALLBACK]", {
          booking_ref:     id,
          reason:          "getRentalState returned NaN end_datetime — using booking.returnDate/returnTime",
          fb_returnDate:   fbDate,
          fb_returnTime:   fbTime,
          fb_end_datetime: isNaN(returnDt.getTime()) ? "NaN" : toLAString(returnDt),
        });
      }
      if (isNaN(returnDt.getTime())) continue;

      const v = vars(booking);
      const minutesUntilReturn = (returnDt - now) / 60000;
      const daysSincePickup = booking.pickupDate
        ? (now.getTime() - new Date(booking.pickupDate).getTime()) / 86_400_000
        : undefined;
      const minsOverdue = -minutesUntilReturn; // positive = overdue
      const graceAt   = new Date(returnDt.getTime() + GRACE_OFFSET_MS);
      const lateFeeAt = new Date(returnDt.getTime() + LATE_FEE_OFFSET_MS);
      const nowIso    = now.toISOString();
      const returnIso = returnDt.toISOString();

      console.log("[SMS_ACTIVE]", {
        booking_ref:       id,
        status:            booking.status,
        vehicleId,
        return_date_raw:   booking.returnDate,
        return_time_raw:   booking.returnTime || null,
        return_la:         toLAString(returnDt),
        mins_until_return: Math.round(minutesUntilReturn),
        sent: {
          active_rental_1h_before_end: alreadySent(booking, "active_rental_1h_before_end"),
          late_warning_30min: alreadySent(booking, "late_warning_30min"),
          late_at_return:     alreadySent(booking, "late_at_return"),
          late_grace_expired: alreadySent(booking, "late_grace_expired"),
          late_fee_pending:   alreadySent(booking, "late_fee_pending"),
        },
      });
      console.log("minutesToReturn:", minutesUntilReturn);

      if (process.env.DEBUG_TIMEZONE) {
        console.log("[TZ_DEBUG][ACTIVE_RENTAL]", {
          timezone:          BUSINESS_TZ,
          now_la:            toLAString(now),
          return_raw:        `${booking.returnDate} ${booking.returnTime || ""}`,
          return_final:      `${finalDate} ${resolvedFinalTime}`,
          return_la:         toLAString(returnDt),
          mins_until_return: Math.round(minutesUntilReturn),
        });
      }

      // returnDateStr is stored in sms_logs so old triggers are invalidated when
      // the booking is extended to a new return_date.
      const returnDateStr = finalDate;

      // Track sentMarks count before processing this booking so we can detect
      // whether any SMS was sent and mark the phone as contacted.
      const marksBeforeBooking = sentMarks.length;

      // Final just-in-time guard: re-check the live return schedule before any
      // return-time SMS send so admin edits made moments earlier are respected.
      const isScheduleStillCurrent = async (templateKey) => {
        if (!sb) return true;
        try {
          const latestState = await getRentalState(sb, id);
          if (isNaN(latestState.end_datetime?.getTime?.())) return true;
          const latestDate = String(latestState.endDate || "").trim();
          const latestTime = String(latestState.returnTime || "").trim();
          const expectedDate = String(finalDate || "").trim();
          const expectedTime = String(resolvedFinalTime || "").trim();
          if (
            latestDate !== expectedDate ||
            (latestTime && expectedTime && latestTime !== expectedTime)
          ) {
            console.log(
              `[SMS_SKIP] ${id} ${templateKey}: schedule changed during run ` +
              `(expected ${expectedDate} ${expectedTime || ""}, latest ${latestDate} ${latestTime || ""})`
            );
            return false;
          }
        } catch (scheduleErr) {
          console.warn(
            `[SMS_GUARD] ${id} ${templateKey}: live schedule check failed (non-fatal):`,
            scheduleErr.message
          );
        }
        return true;
      };

      // `sentThisBooking` is set to true the moment any SMS fires for this
      // booking.  All lower-priority trigger blocks check it first so that at
      // most ONE message is sent per booking per cron tick.  Triggers are
      // evaluated in priority order: P1 (CRITICAL) → P4 (MARKETING).
      let sentThisBooking = false;

      // In repairMode, narrow per-cron-tick windows are relaxed so missed SMS
      // can be recovered immediately.  sms_logs dedup remains the primary guard.
      // Each variable holds the boolean window result for the corresponding trigger.
      const wndLateGrace    = repairMode
        ? (now >= graceAt   && now < lateFeeAt)
        : (now >= graceAt   && now < new Date(graceAt.getTime()  + TRIGGER_WINDOW_MS));
      const wndLateAtReturn = repairMode
        ? (now >= returnDt  && now < graceAt)
        : (now >= returnDt  && now < new Date(returnDt.getTime() + TRIGGER_WINDOW_MS));
      const wndLateWarn30   = repairMode
        ? (minutesUntilReturn <= REPAIR_LATE_WARN_UPPER_MIN && minutesUntilReturn > REPAIR_LATE_WARN_LOWER_MIN)
        : (minutesUntilReturn <= WARNING_BEFORE_END_UPPER_MIN && minutesUntilReturn > WARNING_BEFORE_END_LOWER_MIN);
      const wndExt1h        = repairMode
        ? (minutesUntilReturn <= REPAIR_EXT_1H_UPPER_MIN && minutesUntilReturn > 0)
        : (minutesUntilReturn <= EXT_REMINDER_UPPER_MIN && minutesUntilReturn > EXT_REMINDER_LOWER_MIN);
      const wndReturn24h    = repairMode
        ? (minutesUntilReturn > REPAIR_RETURN_24H_LOWER_MIN && minutesUntilReturn <= RETURN_REMINDER_24H_UPPER_MIN)
        : (minutesUntilReturn <= RETURN_REMINDER_24H_UPPER_MIN && minutesUntilReturn > RETURN_REMINDER_24H_LOWER_MIN);

      // ── P1: Late escalation at return_datetime + 3 h (reset_time) ────────────
      // Informs the renter that the escalated late fee now applies.
      // No admin approval, no hourly calculation, no separate charge.
      // The late fee is included in the extension total when the renter extends.
      // Evaluated FIRST so that if a stale booking is overdue on both the grace
      // and late-fee windows simultaneously, the more critical message fires.
      // The late_fee_pending key is scoped to the current return_date via
      // isSmsLogged so that a new alert can fire after an extension.
      if (
        !sentThisBooking &&
        now >= lateFeeAt &&
        !alreadySent(booking, "late_fee_applied") &&
        !alreadySent(booking, "late_fee_pending") &&
        !booking.lateFeeApplied &&
        booking.lateFeeStatus !== "dismissed" &&
        !(await isSmsLogged(id, "late_fee_pending", returnDateStr))
      ) {
        const hoursOverdue = minsOverdue / 60;

        // Guard: maximum overdue window
        // The escalation alert may only fire within MAX_FEE_OVERDUE_HOURS of the
        // scheduled return.  Beyond that threshold the booking should already
        // have been auto-completed (AUTO_COMPLETE_HOURS = 24 h).  A booking
        // that is still "active_rental" after 8+ hours has a stale status
        // (cron outage, Supabase write failure, etc.) and must NOT generate
        // an alert.
        if (hoursOverdue > MAX_FEE_OVERDUE_HOURS) {
          console.warn(
            `[LATE_ESCALATION] SKIPPED booking ${id}: ` +
            `${hoursOverdue.toFixed(1)}h overdue exceeds MAX_FEE_OVERDUE_HOURS ` +
            `(${MAX_FEE_OVERDUE_HOURS}h). Booking has stale active_rental status — ` +
            `auto-complete should have closed this at ${AUTO_COMPLETE_HOURS}h. ` +
            `No escalation alert will be sent.`
          );
        } else {
          // Verify the booking is STILL active_rental in Supabase before
          // firing any alert.  A booking completed in Supabase but not yet
          // flushed from bookings.json would otherwise send alerts to past renters.
          let bookingStillActive = true;
          if (sb) {
            try {
              const { data: sbStatusRow } = await sb
                .from("bookings")
                .select("status")
                .eq("booking_ref", id)
                .maybeSingle();
              if (sbStatusRow && !["active_rental", "active", "overdue"].includes(sbStatusRow.status)) {
                console.warn(
                  `[LATE_ESCALATION] SKIPPED booking ${id}: Supabase status is ` +
                  `"${sbStatusRow.status}" (expected active_rental). ` +
                  `This booking is no longer active; no alert will be sent.`
                );
                bookingStillActive = false;
              }
            } catch (statusCheckErr) {
              console.warn(
                `[LATE_ESCALATION] Supabase status check failed (non-fatal, proceeding): ` +
                statusCheckErr.message
              );
            }
          }

          if (bookingStillActive) {
            if (!(await isScheduleStillCurrent("late_fee_pending"))) continue;
            const vehicleEscalatedLateFee = SHORT_LATE_FEE;
            logSmsTrigger(id, returnIso, nowIso, "late_escalation");
            console.log("[LATE_ESCALATION]", {
              booking_id:    id,
              vehicle_id:    vehicleId,
              hours_overdue: hoursOverdue.toFixed(1),
              late_fee:      vehicleEscalatedLateFee,
            });

            // Notify customer that the late fee ($25) now applies.
            // The fee will be included in the total when they extend.
            // message_type is "late_escalation" for delivery logging; dedup key is
            // "late_fee_pending" for backward compatibility with existing sms_logs rows.
            const smsSent = await safeSend(booking.phone, render(LATE_ESCALATION, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "late_escalation" });

            // Always mark as attempted to prevent infinite retries.
            sentThisBooking = true;
            sentMarks.push({ vehicleId, id, key: "late_fee_pending" });
            sentMarks.push({ vehicleId, id, key: "_late_fee_amount", value: vehicleEscalatedLateFee });
            await logSmsToSupabase(id, "late_fee_pending", returnDateStr);
          }
        }
      }

      // ── P1: Grace started at return_datetime + 30 min ────────────────────────
      // Informs the renter that the $25 grace-period fee now applies.
      // Uses a 15-min trigger window around grace_end.
      if (
        !sentThisBooking &&
        wndLateGrace &&
        booking.lateFeeStatus !== "dismissed" &&
        !alreadySent(booking, "late_grace_expired") &&
        !(await isSmsLogged(id, "late_grace_expired", returnDateStr))
      ) {
        if (!(await isScheduleStillCurrent("late_grace_expired"))) continue;
        logSmsTrigger(id, returnIso, nowIso, "grace_started");
        // message_type is "late_grace_started" for delivery logging; dedup key is
        // "late_grace_expired" for backward compatibility with existing sms_logs rows.
        const sent = await safeSend(booking.phone, render(LATE_GRACE_STARTED, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "late_grace_started" });
        if (sent) {
          sentThisBooking = true;
          sentMarks.push({ vehicleId, id, key: "late_grace_expired" });
          await logSmsToSupabase(id, "late_grace_expired", returnDateStr);
        }
      } else if (wndLateGrace) {
        console.log(`[SMS_SKIP] ${id} late_grace_expired: already sent (dedup)`);
      }

      // ── P2: At return time (0–15 min window) ──────────────────────────────────
      if (
        !sentThisBooking &&
        wndLateAtReturn &&
        !alreadySent(booking, "late_at_return") &&
        !(await isSmsLogged(id, "late_at_return", returnDateStr))
      ) {
        if (!(await isScheduleStillCurrent("late_at_return"))) continue;
        logSmsTrigger(id, returnIso, nowIso, "ended");
        const sent = await safeSend(booking.phone, render(LATE_AT_RETURN_TIME, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "late_at_return" });
        if (sent) {
          sentThisBooking = true;
          sentMarks.push({ vehicleId, id, key: "late_at_return" });
          await logSmsToSupabase(id, "late_at_return", returnDateStr);
        }
      } else if (wndLateAtReturn) {
        console.log(`[SMS_SKIP] ${id} late_at_return: already sent (dedup)`);
      }

      // ── P2: 30 min before return ───────────────────────────────────────────────
      // Single consolidated end-of-rental reminder (replaces TextMagic automations
      // that were sending separate 1h, 30min, and 15min messages).
      if (
        !sentThisBooking &&
        wndLateWarn30 &&
        !alreadySent(booking, "late_warning_30min") &&
        !(await isSmsLogged(id, "late_warning_30min", returnDateStr))
      ) {
        if (!(await isScheduleStillCurrent("late_warning_30min"))) continue;
        logSmsTrigger(id, returnIso, nowIso, "warning_30min");
        const sent = await safeSend(booking.phone, render(LATE_WARNING_30MIN, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "late_warning_30min" });
        if (sent) {
          sentThisBooking = true;
          sentMarks.push({ vehicleId, id, key: "late_warning_30min" });
          await logSmsToSupabase(id, "late_warning_30min", returnDateStr);
        }
      } else if (wndLateWarn30) {
        console.log(`[SMS_SKIP] ${id} late_warning_30min: already sent (dedup)`);
      }

      // ── P3: ~1 hour before return — extension invitation ──────────────────────
      // Fires once in the 45–60 min window (well clear of the 15–30 min return-
      // obligation window below) so renters never receive both in the same tick.
      // Cross-cron cooldown applies: if maintenance-alerts or oil-check-cron
      // already contacted this renter recently, this low-urgency invite is skipped.
      if (
        !sentThisBooking &&
        wndExt1h &&
        !alreadySent(booking, "active_rental_1h_before_end") &&
        !(await isSmsLogged(id, "active_rental_1h_before_end", returnDateStr))
      ) {
        const recentRows = await fetchRecentSmsLogs(sb, id);
        const scoringCtx = buildSmsContext(
          "active_rental_1h_before_end",
          recentRows,
          { minutesToReturn: minutesUntilReturn, daysSincePickup }
        );
        if (isSuppressedByProximity("active_rental_1h_before_end", scoringCtx)) {
          console.log(`[SMS_SKIP] ${id} active_rental_1h_before_end: proximity suppressed (${Math.round(minutesUntilReturn)} min to return)`);
        } else {
          const { score, breakdown } = computeSmsScoreWithBreakdown("active_rental_1h_before_end", scoringCtx);
          const effectiveThreshold   = computeEffectiveThreshold(scoringCtx);
          console.log(
            `[SMS_SCORE] ${id} active_rental_1h_before_end:` +
            ` score=${score} threshold=${effectiveThreshold}` +
            ` breakdown=${JSON.stringify(breakdown)}`
          );
          if (score <= effectiveThreshold) {
            console.log(`[SMS_SKIP] ${id} active_rental_1h_before_end: score ${score} ≤ ${effectiveThreshold}`);
          } else {
            if (!(await isScheduleStillCurrent("active_rental_1h_before_end"))) continue;
            logSmsTrigger(id, returnIso, nowIso, "ext_reminder_1h");
            const sent = await safeSend(booking.phone, render(ACTIVE_RENTAL_1H_BEFORE_END, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "active_rental_1h_before_end" });
            if (sent) {
              sentThisBooking = true;
              sentMarks.push({ vehicleId, id, key: "active_rental_1h_before_end" });
              await logSmsToSupabase(id, "active_rental_1h_before_end", returnDateStr, { score, breakdown });
            }
          }
        }
      } else if (wndExt1h) {
        console.log(`[SMS_SKIP] ${id} active_rental_1h_before_end: already sent (dedup)`);
      }

      // ── P3: ~7–8 hours before return — same-day reminder ────────────────────
      // Fires once in the 420–480 min window (7–8 h before return), bridging
      // the gap between the 24h return reminder and the 1h extension invite.
      // Uses the same scoring / cooldown path as the other P3 reminders.
      // Skipped in criticalOnly mode (outside SMS send window).
      // Skipped in repairMode (non-critical; not needed for missed-SMS recovery).
      if (
        !criticalOnly &&
        !repairMode &&
        !sentThisBooking &&
        minutesUntilReturn <= SAME_DAY_REMINDER_UPPER_MIN && minutesUntilReturn > SAME_DAY_REMINDER_LOWER_MIN &&
        !alreadySent(booking, "active_rental_mid") &&
        !(await isSmsLogged(id, "active_rental_mid", returnDateStr))
      ) {
        const recentRows = await fetchRecentSmsLogs(sb, id);
        const scoringCtx = buildSmsContext(
          "active_rental_mid",
          recentRows,
          { minutesToReturn: minutesUntilReturn, daysSincePickup }
        );
        const { score, breakdown } = computeSmsScoreWithBreakdown("active_rental_mid", scoringCtx);
        const effectiveThreshold   = computeEffectiveThreshold(scoringCtx);
        console.log(
          `[SMS_SCORE] ${id} active_rental_mid:` +
          ` score=${score} threshold=${effectiveThreshold}` +
          ` breakdown=${JSON.stringify(breakdown)}`
        );
        if (score <= effectiveThreshold) {
          console.log(`[SMS_SKIP] ${id} active_rental_mid: score ${score} ≤ ${effectiveThreshold}`);
        } else {
          if (!(await isScheduleStillCurrent("active_rental_mid"))) continue;
          logSmsTrigger(id, returnIso, nowIso, "same_day_reminder");
          const sent = await safeSend(booking.phone, render(ACTIVE_RENTAL_MID, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "active_rental_mid" });
          if (sent) {
            sentThisBooking = true;
            sentMarks.push({ vehicleId, id, key: "active_rental_mid" });
            await logSmsToSupabase(id, "active_rental_mid", returnDateStr, { score, breakdown });
          }
        }
      } else if (minutesUntilReturn <= SAME_DAY_REMINDER_UPPER_MIN && minutesUntilReturn > SAME_DAY_REMINDER_LOWER_MIN) {
        console.log(`[SMS_SKIP] ${id} active_rental_mid: already sent (dedup)`);
      }

      // ── P3: ~24 hours before return — return reminder ─────────────────────────
      // Fires once in the 1,380–1,440 min window (23 h–24 h before return).
      // Uses the same scoring / cooldown path as the 1h extension invite so that
      // cross-cron spam protection applies.  sms_logs dedup prevents a second
      // send if the cron fires multiple times during the 60-min window.
      // Skipped in criticalOnly mode (outside SMS send window).
      if (
        !criticalOnly &&
        !sentThisBooking &&
        wndReturn24h &&
        !alreadySent(booking, "return_expectations") &&
        !(await isSmsLogged(id, "return_expectations", returnDateStr))
      ) {
        const recentRows = await fetchRecentSmsLogs(sb, id);
        const scoringCtx = buildSmsContext(
          "return_expectations",
          recentRows,
          { minutesToReturn: minutesUntilReturn, daysSincePickup }
        );
        const { score, breakdown } = computeSmsScoreWithBreakdown("return_expectations", scoringCtx);
        const effectiveThreshold   = computeEffectiveThreshold(scoringCtx);
        console.log(
          `[SMS_SCORE] ${id} return_expectations:` +
          ` score=${score} threshold=${effectiveThreshold}` +
          ` breakdown=${JSON.stringify(breakdown)}`
        );
        if (score <= effectiveThreshold) {
          console.log(`[SMS_SKIP] ${id} return_expectations: score ${score} ≤ ${effectiveThreshold}`);
        } else {
          if (!(await isScheduleStillCurrent("return_expectations"))) continue;
          logSmsTrigger(id, returnIso, nowIso, "return_expectations");
          const sent = await safeSend(booking.phone, render(RETURN_EXPECTATIONS, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "return_expectations" });
          if (sent) {
            sentThisBooking = true;
            sentMarks.push({ vehicleId, id, key: "return_expectations" });
            await logSmsToSupabase(id, "return_expectations", returnDateStr, { score, breakdown });
          }
        }
      } else if (wndReturn24h) {
        console.log(`[SMS_SKIP] ${id} return_expectations: already sent (dedup)`);
      }

      // Per-run dedup: if any SMS was sent for this booking, mark the phone so
      // a second active booking on the same number is skipped this run.
      if (sentMarks.length > marksBeforeBooking) {
        phonesContactedThisRun.add(booking.phone);
      }
    }
  }
}

/**
 * Process completed_rental bookings — post-rental and retention SMS.
 */
export async function processCompleted(allBookings, now, sentMarks) {
  // Anti-spam: retention SMS fires in the first 4 hours after the target day
  // so that a transient Supabase outage can at most produce 48 duplicate sends
  // (at 5-min cron intervals) instead of 288 (the old 24-hour window).
  const RETENTION_WINDOW_HOURS = 4;

  const retentionSchedule = [
    { days: 7,  key: "retention_7d",  template: RETENTION_DAY_7 },
  ];

  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (!COMPLETED_RENTER_STATUSES.has(String(booking?.status || "").trim())) continue;
      if (!booking.phone || !booking.completedAt) continue;

      const id = booking.bookingId || booking.paymentIntentId;
      const v = vars(booking);
      const completedAt = new Date(booking.completedAt);
      const hoursSinceComplete = (now - completedAt) / 3600000;

      // Thank-you immediately on completion (within 30 minutes).
      // Anti-spam: 30-min window (6 cron ticks) is sufficient since processAutoCompletions
      // and processCompleted run in the same cron tick; the 0.5h cap prevents up to
      // 12 sends under a Supabase outage (vs. the old 60-min / 12-tick window).
      if (hoursSinceComplete < 0.5 && !alreadySent(booking, "post_thank_you") &&
          !(await isSmsLogged(id, "post_thank_you"))) {
        const sent = await safeSend(booking.phone, render(POST_RENTAL_THANK_YOU, v), { booking_ref: id, vehicle_id: vehicleId, message_type: "post_thank_you" });
        if (sent) {
          sentMarks.push({ vehicleId, id, key: "post_thank_you" });
          await logSmsToSupabase(id, "post_thank_you");
          // Promote to past_customer in TextMagic contact database
          if (booking.phone) {
            try {
              await upsertContact(normalizePhone(booking.phone), booking.name || "", {
                addTags:    ["past_customer"],
                removeTags: ["booked"],
              });
            } catch (contactErr) {
              console.error("scheduled-reminders: TextMagic contact update failed:", contactErr);
            }
          }
        }
      }

      // Retention sequence
      for (const item of retentionSchedule) {
        const targetHours = item.days * 24;
        if (
          hoursSinceComplete >= targetHours &&
          hoursSinceComplete < targetHours + RETENTION_WINDOW_HOURS &&
          !alreadySent(booking, item.key) &&
          !(await isSmsLogged(id, item.key))
        ) {
          const sent = await safeSend(booking.phone, render(item.template, v), { booking_ref: id, vehicle_id: vehicleId, message_type: item.key });
          if (sent) {
            sentMarks.push({ vehicleId, id, key: item.key });
            await logSmsToSupabase(id, item.key);
          }
        }
      }
    }
  }
}

/**
 * Persist all reminder sent-marks back to bookings.json.
 * Uses updateJsonFileWithRetry so stale-SHA conflicts are retried automatically.
 */
async function persistSentMarks(_sentMarks) {
  // Phase 4: bookings.json writes disabled — sent marks are tracked in sms_logs (Supabase).
}

/**
 * Load active and recently-completed bookings from Supabase (primary source).
 *
 * Returns data in the same allBookings format used by all process* functions
 * ({ [vehicleId]: booking[] }).  smsSentAt for once-per-booking SMS types is
 * pre-populated from sms_logs sentinel rows so alreadySent() continues to work.
 *
 * Returns null on query error so the caller can fall back to bookings.json.
 * Returns an empty object {} when Supabase has no relevant bookings.
 *
 * @param {object} sb - Supabase admin client
 * @returns {Promise<object|null>}
 */
export async function loadBookingsFromSupabase(sb) {
  try {
    // SELECT_COLS includes renter_phone (added in migration 0101/0104),
    // balance_due (added in migration 0115), and balance_due_set_at (added in
    // migration 0120).
    // SELECT_COLS_FALLBACK is used if the primary query fails with PostgreSQL
    // error 42703 (undefined column) — e.g. when renter_phone, balance_due, or
    // balance_due_set_at haven't been added to the live DB yet.  It intentionally
    // omits those newer columns so the query always succeeds against an older
    // schema.  balanceDueSetAt falls back to updatedAt/createdAt in the mapping
    // below, so omitting it here is safe.
    const SELECT_COLS =
      "booking_ref, vehicle_id, customer_name, customer_email, customer_phone, renter_phone, " +
      "pickup_date, return_date, pickup_time, return_time, status, " +
      "payment_intent_id, completed_at, extension_count, remaining_balance, " +
      "late_fee_status, late_fee_amount, balance_due, balance_due_set_at, balance_payment_link, " +
      "extend_pending, extension_pending_payment, updated_at, created_at";

    const SELECT_COLS_FALLBACK =
      "booking_ref, vehicle_id, customer_name, customer_email, customer_phone, " +
      "pickup_date, return_date, pickup_time, return_time, status, " +
      "payment_intent_id, completed_at, extension_count, remaining_balance, " +
      "late_fee_status, late_fee_amount, updated_at, created_at";

    const ACTIVE_STATUSES = [
      // Modern app-layer values
      "booked_paid", "active_rental", "overdue",
      // Legacy values that the availability system treats as "vehicle occupied"
      "active",           // pre-migration-0064 equivalent of active_rental
      "approved",         // pre-migration-0066 equivalent of booked_paid
      // Reservation-deposit flow (migration 0066)
      "reserved",
      "pending_verification",
    ];

    // Recently completed = last 9 days (covers 7-day retention window + 4h window + buffer)
    const cutoffDate = new Date(Date.now() - 9 * 24 * 3_600_000).toISOString();

    let [{ data: activeRows, error: activeErr }, { data: completedRows, error: completedErr }] =
      await Promise.all([
        sb
          .from("bookings")
          .select(SELECT_COLS)
          .in("status", ACTIVE_STATUSES)
          .order("created_at", { ascending: false }),
        sb
          .from("bookings")
          .select(SELECT_COLS)
          .in("status", ["completed", "completed_rental"])
          .gte("completed_at", cutoffDate)
          .order("completed_at", { ascending: false }),
      ]);

    // If the query failed due to a newer column not existing yet (PostgreSQL
    // error 42703 — undefined column), retry with the minimal fallback column
    // list which omits renter_phone (0101/0104), balance_due (0115), and
    // balance_due_set_at (0120).  Running those migrations is the permanent fix.
    if (activeErr && activeErr.code === "42703") {
      console.warn(
        "scheduled-reminders loadBookingsFromSupabase: column missing (" +
        activeErr.message + ") — retrying with fallback columns " +
        "(run pending migrations 0101/0104/0115/0120 to fix permanently)"
      );
      [{ data: activeRows, error: activeErr }, { data: completedRows, error: completedErr }] =
        await Promise.all([
          sb
            .from("bookings")
            .select(SELECT_COLS_FALLBACK)
            .in("status", ACTIVE_STATUSES)
            .order("created_at", { ascending: false }),
          sb
            .from("bookings")
            .select(SELECT_COLS_FALLBACK)
            .in("status", ["completed", "completed_rental"])
            .gte("completed_at", cutoffDate)
            .order("completed_at", { ascending: false }),
        ]);
    }

    if (activeErr) {
      console.error("scheduled-reminders loadBookingsFromSupabase: active query failed:", activeErr.message);
      return null;
    }
    if (completedErr) {
      console.warn("scheduled-reminders loadBookingsFromSupabase: completed query failed (non-fatal):", completedErr.message);
    }

    const allRows = [...(activeRows || []), ...(completedRows || [])];
    if (allRows.length === 0) {
      console.log("scheduled-reminders: no active bookings in Supabase");
      return {};
    }

    // Group by vehicle_id
    const allBookings = {};
    for (const row of allRows) {
      const vehicleId = row.vehicle_id || "unknown";
      if (!allBookings[vehicleId]) allBookings[vehicleId] = [];
      allBookings[vehicleId].push({
        bookingId:      row.booking_ref         || "",
        paymentIntentId: row.payment_intent_id  || "",
        vehicleId,
        vehicleName:    vehicleId,
        name:           row.customer_name       || "",
        email:          row.customer_email      || "",
        // renter_phone is the canonical SMS field; fall back to customer_phone
        // for rows written before migration 0101.
        phone:          row.renter_phone        || row.customer_phone || "",
        pickupDate:     row.pickup_date  ? String(row.pickup_date).split("T")[0]  : "",
        pickupTime:     row.pickup_time  ? String(row.pickup_time).substring(0, 5) : "",
        returnDate:     row.return_date  ? String(row.return_date).split("T")[0]  : "",
        returnTime:     row.return_time  ? String(row.return_time).substring(0, 5) : "",
        status:         toAppBookingStatus(row.status),
        completedAt:    row.completed_at || null,
        updatedAt:      row.updated_at   || row.created_at || null,
        extensionCount: row.extension_count || 0,
        remainingBalance: Number(row.remaining_balance || 0),
        lateFeeApplied: row.late_fee_status === "approved" ? (row.late_fee_amount || undefined) : undefined,
        lateFeeStatus:  row.late_fee_status || null,
        balanceDue:     Number(row.balance_due || 0),
        balanceDueSetAt: row.balance_due_set_at || null,
        extendPending:  !!row.extend_pending,
        extensionPendingPayment:
          row.extension_pending_payment && typeof row.extension_pending_payment === "object"
            ? row.extension_pending_payment
            : null,
        paymentLink:    row.balance_payment_link || buildVehicleExtendLink({ vehicleId }),
        smsSentAt:      {},   // populated below from sms_logs
        createdAt:      row.created_at || null,
      });
    }

    // Pre-populate smsSentAt from sms_logs so alreadySent() works as a robust
    // first-line guard, reducing dependence on the per-tick isSmsLogged() queries.
    //
    // Two categories of rows are included:
    //   1. Sentinel rows (return_date_at_send = SMS_LOGS_SENTINEL_DATE) — once-per-
    //      booking messages (pickup_24h, post_thank_you, etc.) that are not scoped to
    //      a return date.
    //   2. Current-return-date rows (return_date_at_send = booking.returnDate) — return-
    //      time messages (late_warning_30min, late_at_return, etc.) for the booking's
    //      CURRENT return date.  Old-return-date rows (from before an extension) are
    //      intentionally excluded: when a rental is extended the return_date changes, so
    //      those rows no longer match and the messages correctly re-fire for the new date.
    //
    // This means that even if a later isSmsLogged() read fails (non-fatal), alreadySent()
    // catches return-time messages that were already sent in a previous cron tick.
    const bookingRefs = allRows.map((r) => r.booking_ref).filter((ref) => ref && ref.trim());
    if (bookingRefs.length > 0) {
      // Build bookingRef → current returnDate for extension-aware row filtering.
      const returnDateByRef = {};
      for (const bookings of Object.values(allBookings)) {
        for (const booking of bookings) {
          if (booking.bookingId) returnDateByRef[booking.bookingId] = booking.returnDate || "";
        }
      }

      try {
        // Fetch all sms_logs rows for these booking refs written in the last 30 days.
        // 30 days covers the longest retention window (7-day retention SMS) plus buffer.
        const smsLogsCutoffDate = new Date(Date.now() - 30 * 24 * MS_PER_HOUR).toISOString();
        const { data: smsRows, error: smsErr } = await sb
          .from("sms_logs")
          .select("booking_id, template_key, sent_at, return_date_at_send")
          .in("booking_id", bookingRefs)
          .gte("sent_at", smsLogsCutoffDate);
        if (smsErr) {
          console.warn("scheduled-reminders loadBookingsFromSupabase: sms_logs lookup failed (non-fatal):", smsErr.message);
        } else {
          const smsByRef = {};
          for (const log of smsRows || []) {
            const currentReturnDate = returnDateByRef[log.booking_id] || "";
            // Include only sentinel rows OR rows matching the booking's current return date.
            // Old-return-date rows (pre-extension) are excluded to preserve extension-awareness.
            const isSentinel    = log.return_date_at_send === SMS_LOGS_SENTINEL_DATE;
            const isCurrentDate = log.return_date_at_send === currentReturnDate && currentReturnDate !== "";
            if (!isSentinel && !isCurrentDate) continue;

            if (!smsByRef[log.booking_id]) smsByRef[log.booking_id] = {};
            const existing = smsByRef[log.booking_id][log.template_key];
            if (!existing || new Date(log.sent_at) > new Date(existing)) {
              smsByRef[log.booking_id][log.template_key] = log.sent_at;
            }
          }
          for (const bookings of Object.values(allBookings)) {
            for (const booking of bookings) {
              if (smsByRef[booking.bookingId]) {
                booking.smsSentAt = smsByRef[booking.bookingId];
              }
            }
          }
        }
      } catch (smsLookupErr) {
        console.warn("scheduled-reminders loadBookingsFromSupabase: sms_logs lookup failed (non-fatal):", smsLookupErr.message);
      }
    }

    console.log(`scheduled-reminders: loaded ${allRows.length} booking(s) from Supabase`);
    return allBookings;
  } catch (err) {
    console.error("scheduled-reminders loadBookingsFromSupabase: unexpected error:", err.message);
    return null;
  }
}

/**
 * Transitions status from "booked_paid" → "active_rental" in bookings.json
 * and syncs to Supabase.  Non-fatal: errors are logged and never propagate.
 *
 * @param {object} allBookings - current bookings data snapshot
 * @param {Date}   now
 */
export async function processAutoActivations(allBookings, now) {
  // Respect the admin toggle — skip the entire cycle when disabled.
  // Note: GITHUB_TOKEN is only needed for the bookings.json write; the
  // Supabase update and in-memory state update proceed regardless.
  const enabled = await loadBooleanSetting("auto_activate_on_pickup", true);
  if (!enabled) {
    console.log("scheduled-reminders: auto_activate_on_pickup is disabled — skipping auto-activations");
    return;
  }

  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "booked_paid") continue;

      // Use LA-timezone pickup datetime so auto-activation fires at the correct
      // wall-clock time in Los Angeles, not at the UTC equivalent.
      const pickupDt = parseBookingDateTimeLA(booking.pickupDate, booking.pickupTime);
      if (isNaN(pickupDt.getTime())) continue;

      if (process.env.DEBUG_TIMEZONE) {
        console.log("[TZ_DEBUG][AUTO_ACTIVATE]", {
          timezone:        BUSINESS_TZ,
          now_la:          toLAString(now),
          pickup_raw:      `${booking.pickupDate} ${booking.pickupTime || ""}`,
          pickup_la:       toLAString(pickupDt),
        });
      }

      // Only activate once pickup time has arrived (or passed)
      if (now < pickupDt) continue;

      const id          = booking.bookingId || booking.paymentIntentId;
      const activatedAt = now.toISOString();

      console.log(
        `scheduled-reminders: auto-activating ${vehicleId} booking ${id} ` +
        `(pickup was ${booking.pickupDate} ${booking.pickupTime || ""})`
      );

      // Update in-memory state immediately so processActiveRentals sees the
      // correct active_rental status in the same cron run.
      booking.status      = "active_rental";
      booking.activatedAt = activatedAt;
      booking.updatedAt   = activatedAt;

      try {
        // Sync to Supabase (does not require GITHUB_TOKEN).
        await autoUpsertBooking(booking);

        // Persist to bookings.json (requires GITHUB_TOKEN; skipped when absent).
        if (process.env.GITHUB_TOKEN) {
          await updateBooking(vehicleId, id, {
            status:      "active_rental",
            activatedAt,
            updatedAt:   activatedAt,
          });
        }
      } catch (err) {
        console.error(
          `scheduled-reminders: auto-activation failed for ${vehicleId}/${id} (non-fatal):`,
          err.message
        );
      }
    }
  }
}

/**
 * Auto-complete active_rental bookings that are past their return time by
 * AUTO_COMPLETE_HOURS hours.  Updates bookings.json status to
 * "completed_rental", removes blocked dates, restores fleet-status.json to
 * available, and syncs to Supabase.
 * Non-fatal: errors are logged and never propagate.
 *
 * @param {object} allBookings - current bookings data snapshot
 * @param {Date}   now
 */
export async function processAutoCompletions(allBookings, now) {
  // Note: GITHUB_TOKEN is only needed for the bookings.json write; the
  // Supabase update and in-memory state update proceed regardless.

  const sb = getSupabaseAdmin();
  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "active_rental" && booking.status !== "active" && booking.status !== "overdue") continue;
      if (hasPendingExtensionHold(booking)) continue;

      // Compute the final return date/time from vehicle_blocking_ranges so
      // auto-completion fires against the renter's true (possibly extended)
      // return schedule — never against a stale base date.
      // Falls back to the booking's own returnDate/returnTime when Supabase is
      // unavailable (e.g. null client in test environments).
      const id = booking.bookingId || booking.paymentIntentId;
      let { endDate: finalDate, returnTime: resolvedFinalTime, end_datetime: returnDt } =
        await getRentalState(sb, id);
      if (isNaN(returnDt.getTime())) {
        const fbDate = booking.returnDate || "";
        const fbTime = booking.returnTime || DEFAULT_RETURN_TIME;
        returnDt = buildDateTimeLA(fbDate, fbTime);
        finalDate = fbDate;
        resolvedFinalTime = fbTime;
      }
      if (isNaN(returnDt.getTime())) continue;

      const minsOverdue = (now - returnDt) / 60000;

      if (process.env.DEBUG_TIMEZONE) {
        console.log("[TZ_DEBUG][AUTO_COMPLETE]", {
          timezone:       BUSINESS_TZ,
          now_la:         toLAString(now),
          return_raw:     `${booking.returnDate} ${booking.returnTime || ""}`,
          return_final:   `${finalDate} ${resolvedFinalTime}`,
          return_la:      toLAString(returnDt),
          mins_overdue:   Math.round(minsOverdue),
        });
      }

      if (minsOverdue < AUTO_COMPLETE_HOURS * 60) continue;

      const completedAt = now.toISOString();

      console.log(
        `scheduled-reminders: auto-completing ${vehicleId} booking ${id} ` +
        `(${Math.round(minsOverdue)} min past return time)`
      );

      // Update in-memory state immediately so downstream logic in this same
      // cron run (e.g. otherActiveRentals check below) uses the correct status.
      booking.status      = "completed_rental";
      booking.completedAt = completedAt;
      booking.updatedAt   = completedAt;

      try {
        // Sync to Supabase (does not require GITHUB_TOKEN).
        await autoUpsertCustomer(booking, true); // countStats=true: increment total_bookings/total_spent
        await autoUpsertBooking(booking);

        // Persist to bookings.json (requires GITHUB_TOKEN; skipped when absent).
        if (process.env.GITHUB_TOKEN) {
          await updateBooking(vehicleId, id, {
            status:      "completed_rental",
            completedAt,
            updatedAt:   completedAt,
          });
        }

        // Free up the dates in booked-dates.json
        await removeFromBookedDates(vehicleId, booking.pickupDate, booking.returnDate);

        // Re-enable the vehicle in fleet-status.json so the website shows it
        // as bookable again — but only if no other active_rental remains for
        // this vehicle (handles the case where a follow-on booking is already
        // active at the same time).
        const otherActiveRentals = (allBookings[vehicleId] || []).filter(
          (b) => (b.bookingId || b.paymentIntentId) !== id && (b.status === "active_rental" || b.status === "overdue")
        );
        if (otherActiveRentals.length === 0) {
          await markVehicleAvailable(vehicleId);
        }

        // Send rental-completed notification emails (non-fatal).
        // Owner receives an alert so they know the rental has ended.
        // Renter receives a thank-you email with return confirmation.
        if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
          try {
            const escStr = (s) => String(s || "")
              .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

            const transporter = nodemailer.createTransport({
              host:   process.env.SMTP_HOST,
              port:   parseInt(process.env.SMTP_PORT || "587"),
              secure: process.env.SMTP_PORT === "465",
              auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
            });

            const completedDate = new Date(completedAt).toLocaleDateString("en-US", {
              timeZone: "America/Los_Angeles",
              weekday: "long", year: "numeric", month: "long", day: "numeric",
            });
            const renterName   = booking.name        || "Valued Customer";
            const vehicleName  = booking.vehicleName || vehicleId;

            // Owner alert
            if (OWNER_EMAIL) {
              await transporter.sendMail({
                from:    `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
                to:      OWNER_EMAIL,
                subject: `[Sly Car Rentals] ✅ Rental Completed — ${escStr(renterName)} (${escStr(vehicleName)})`,
                html: `
                  <h2 style="color:#1a237e">Rental Completed</h2>
                  <p><strong>${escStr(renterName)}</strong>'s rental of the <strong>${escStr(vehicleName)}</strong> has been automatically marked as completed.</p>
                  <table style="border-collapse:collapse;width:100%;margin:16px 0">
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #ddd"><code>${escStr(id)}</code></td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(vehicleName)}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(renterName)}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(booking.phone || "—")}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(booking.pickupDate || "—")}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(booking.returnDate || "—")}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Completed At</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(completedDate)} (LA time)</td></tr>
                    ${booking.extensionCount ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Extensions</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(String(booking.extensionCount))}</td></tr>` : ""}
                  </table>
                  <p style="color:#666;font-size:13px">This email was auto-generated by the Sly Car Rentals scheduler.</p>
                `,
              });
            }

            // Renter thank-you email
            const renterEmail = booking.email;
            if (renterEmail) {
              const firstName = renterName.split(" ")[0];
              await transporter.sendMail({
                from:    `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
                to:      renterEmail,
                subject: "Thank you for renting with Sly Car Rentals!",
                html: `
                  <h2 style="color:#1a237e">Thank You for Renting with Sly Car Rentals!</h2>
                  <p>Hi ${escStr(firstName)},</p>
                  <p>Your rental of the <strong>${escStr(vehicleName)}</strong> has been completed on <strong>${escStr(completedDate)}</strong>.</p>
                  <p>We hope you had a great experience! We'd love to have you back.</p>
                  <table style="border-collapse:collapse;width:100%;margin:16px 0">
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(vehicleName)}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(booking.pickupDate || "—")}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(booking.returnDate || "—")}</td></tr>
                  </table>
                  <p>Ready to book again? Visit <a href="https://slycarrentals.com/cars.html">www.slytrans.com</a>.</p>
                  <p>Questions? Call us at <a href="tel:+18445114059">(844) 511-4059</a> or email <a href="mailto:${escStr(OWNER_EMAIL)}">${escStr(OWNER_EMAIL)}</a>.</p>
                  <p style="color:#666;font-size:13px">Sly Car Rentals LLC · Los Angeles, CA</p>
                `,
              });
            }
          } catch (emailErr) {
            console.error(
              `scheduled-reminders: rental-completed email failed for ${vehicleId}/${id} (non-fatal):`,
              emailErr.message
            );
          }
        }
      } catch (err) {
        console.error(
          `scheduled-reminders: auto-completion failed for ${vehicleId}/${id} (non-fatal):`,
          err.message
        );
        // Revert in-memory state so processActiveRentals still sees this
        // booking as active in the current run (Supabase sync failed, so the
        // external record is still active_rental; don't silently drop it).
        booking.status      = "active_rental";
        booking.completedAt = undefined;
        booking.updatedAt   = undefined;
      }
    }
  }
}


/**
 * Returns true when all new-mismatch PIs have been handled (either auto-repaired
 * or intentionally skipped because they are non-new-booking payment types).
 */
function areAllPaymentsHandled(newMismatches, repairedPIIds, failedPIIds, nonNewBookingTypes) {
  if (failedPIIds.length > 0) return false;
  return newMismatches.every(
    (pi) => repairedPIIds.includes(pi.id) || nonNewBookingTypes.has((pi.metadata || {}).payment_type || "")
  );
}

/**
 * Reconciliation check — runs once per cron tick.
 *
 * Fetches the last 24 h of succeeded Stripe PaymentIntents and compares them
 * against the `revenue_records` table.  Any PaymentIntent that has no matching
 * revenue record (matched by payment_intent_id or booking_id column) is
 * flagged as a mismatch and an alert is sent to the owner via email and SMS.
 *
 * Non-fatal — errors are caught and logged so the rest of the cron job is
 * never blocked by a reconciliation failure.
 */
async function runReconciliation() {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // Fetch PaymentIntents succeeded in the last 24 hours
    const since = Math.floor(Date.now() / 1000) - 86400;
    const piList = await stripe.paymentIntents.list({
      limit:  100,
      created: { gte: since },
    });

    const succeededPIs = piList.data.filter((pi) => pi.status === "succeeded");
    if (succeededPIs.length === 0) return;

    // Fetch matching revenue_records by payment_intent_id
    const piIds = succeededPIs.map((pi) => pi.id);
    const { data: rrRows } = await sb
      .from("revenue_records")
      .select("payment_intent_id, booking_id")
      .in("payment_intent_id", piIds);

    const recordedPIIds = new Set((rrRows || []).map((r) => r.payment_intent_id).filter(Boolean));

    // Also match extension rows that use the PI id as booking_id
    const { data: extRows } = await sb
      .from("revenue_records")
      .select("booking_id")
      .in("booking_id", piIds);

    const recordedAsBookingId = new Set((extRows || []).map((r) => r.booking_id).filter(Boolean));

    // For rental_extension PIs whose revenue record stores the original booking ref
    // (not the PI id) as booking_id, perform an extra lookup by booking_id.
    // This prevents extension payments that were already processed by the webhook
    // from appearing as mismatches (and showing "⚠️ Skipped (manual)" in alerts).
    // Fall back to metadata.original_booking_id for PIs created before extend-rental.js
    // was updated to emit booking_id, preserving backward compatibility.
    const extensionOriginalBookingIds = succeededPIs
      .filter((pi) => (pi.metadata?.payment_type || pi.metadata?.type) === "rental_extension")
      .map((pi) => pi.metadata?.booking_id || pi.metadata?.original_booking_id)
      .filter(Boolean);

    const handledExtensionPIIds = new Set();
    if (extensionOriginalBookingIds.length > 0) {
      const { data: extRevenueRows } = await sb
        .from("revenue_records")
        .select("payment_intent_id, booking_id")
        .in("booking_id", extensionOriginalBookingIds);
      const processedExtPIIds = new Set(
        (extRevenueRows || []).map((r) => r.payment_intent_id).filter(Boolean)
      );
      for (const pi of succeededPIs) {
        if ((pi.metadata?.payment_type || pi.metadata?.type) === "rental_extension" && processedExtPIIds.has(pi.id)) {
          handledExtensionPIIds.add(pi.id);
        }
      }
    }

    const mismatches = succeededPIs.filter(
      (pi) => !recordedPIIds.has(pi.id) && !recordedAsBookingId.has(pi.id) && !handledExtensionPIIds.has(pi.id)
    );

    if (mismatches.length === 0) {
      console.log(`scheduled-reminders reconciliation: all ${succeededPIs.length} PI(s) have matching revenue records ✓`);
      return;
    }

    // ── Deduplication: only alert once per PI ID per 25-hour window ─────────
    // Without this guard the 15-minute cron re-alerts for the same payment up
    // to 96 times before the PI falls out of the 24-hour look-back window.
    const DEDUP_KEY = "reconciliation_alerted_pi_ids";
    let alertedPIs = {}; // { [piId]: ISO timestamp of when first alerted }
    try {
      const { data: configRow } = await sb
        .from("app_config")
        .select("value")
        .eq("key", DEDUP_KEY)
        .maybeSingle();
      if (configRow && configRow.value && typeof configRow.value === "object") {
        alertedPIs = configRow.value;
      }
    } catch (readErr) {
      console.warn("scheduled-reminders reconciliation: failed to read dedup state (non-fatal):", readErr.message);
    }

    // Prune entries older than 25 hours so the map doesn't grow unbounded
    const cutoffMs = Date.now() - 25 * 60 * 60 * 1000;
    for (const [piId, ts] of Object.entries(alertedPIs)) {
      if (new Date(ts).getTime() < cutoffMs) delete alertedPIs[piId];
    }

    const newMismatches = mismatches.filter((pi) => !alertedPIs[pi.id]);
    if (newMismatches.length === 0) {
      console.log(`scheduled-reminders reconciliation: ${mismatches.length} mismatch(es) already alerted — skipping repeat notification`);
      return;
    }

    console.warn(`scheduled-reminders reconciliation: ${newMismatches.length} PI(s) missing from revenue_records`, newMismatches.map((pi) => pi.id));

    // ── Auto-repair: replay full booking pipeline for each unmatched PI ──────
    // Uses the same pipeline as the Stripe webhook (stripe-webhook.js) so every
    // step fires: customer upsert → booking upsert → revenue record → blocked
    // dates → fleet-status update → owner + customer notification emails.
    // All steps are idempotent — safe to call even if a partial record already exists.
    //
    // Payment types that mutate an existing booking (rental_extension,
    // balance_payment) are excluded — they must be reviewed manually if they
    // appear here.
    const NON_NEW_BOOKING_TYPES = new Set([
      "rental_extension",
      "balance_payment",
      "rental_balance",
      "partial_balance",
    ]);

    const repairedPIIds = [];
    const failedPIIds   = [];
    // Maps piId → human-readable error summary for use in the repair email alert.
    const repairErrors  = new Map();

    for (const pi of newMismatches) {
      const piMetaReconcile = pi.metadata || {};
      const paymentType = piMetaReconcile.payment_type || piMetaReconcile.type || "";
      if (NON_NEW_BOOKING_TYPES.has(paymentType)) {
        // rental_extension: the webhook already updated the booking and created the
        // booking_extensions row.  The only thing that may be missing is the revenue
        // record (e.g. the webhook returned 500 after updating the booking but before
        // writing revenue, then Stripe retried past the reconciler window).
        // Recover it directly via autoCreateRevenueRecord — fully idempotent by PI ID.
        if (paymentType === "rental_extension") {
          try {
            const extMeta = pi.metadata || {};
            const extRef  = extMeta.booking_id || extMeta.original_booking_id || "";
            if (!extRef) {
              throw new Error(`missing booking_id in metadata ("${extRef}")`);
            }
            // Confirm / resolve the booking_ref in Supabase before writing revenue.
            // Accept legacy/non-canonical metadata values, but always map to a real
            // bookings.booking_ref so revenue remains linked to a valid booking row.
            const sbExt = getSupabaseAdmin();
            let resolvedExtRef = null;
            if (sbExt) {
              // 1) Direct booking_ref match (works for canonical and legacy refs).
              const { data: refRow } = await sbExt
                .from("bookings")
                .select("booking_ref")
                .eq("booking_ref", extRef)
                .maybeSingle();
              if (refRow?.booking_ref) resolvedExtRef = refRow.booking_ref;

              // 2) Fallback: if metadata accidentally carried a PI ID, resolve via
              // bookings.payment_intent_id.
              if (!resolvedExtRef && extRef.startsWith("pi_")) {
                const { data: byMetaPiRow } = await sbExt
                  .from("bookings")
                  .select("booking_ref")
                  .eq("payment_intent_id", extRef)
                  .maybeSingle();
                if (byMetaPiRow?.booking_ref) resolvedExtRef = byMetaPiRow.booking_ref;
              }

              // 3) Fallback: recover by the current extension PI ID.
              if (!resolvedExtRef && pi.id) {
                const { data: byPiRow } = await sbExt
                  .from("bookings")
                  .select("booking_ref")
                  .eq("payment_intent_id", pi.id)
                  .maybeSingle();
                if (byPiRow?.booking_ref) resolvedExtRef = byPiRow.booking_ref;
              }

              // 4) Fallback: recover from booking_extensions if an extension row
              // already exists for this PI.
              if (!resolvedExtRef && pi.id) {
                const { data: extRow } = await sbExt
                  .from("booking_extensions")
                  .select("booking_id")
                  .eq("payment_intent_id", pi.id)
                  .maybeSingle();
                if (extRow?.booking_id) resolvedExtRef = extRow.booking_id;
              }
            }
            if (!resolvedExtRef) {
              throw new Error(`booking_ref could not be resolved from metadata booking_id "${extRef}" (pi=${pi.id || "unknown"})`);
            }
            // Resolve Stripe fee (non-blocking — reconcile.js backfills if missing).
            let extFeeFields = { stripeFee: null, stripeNet: null };
            try {
              const expandedExtPI = await stripe.paymentIntents.retrieve(pi.id, {
                expand: ["latest_charge.balance_transaction"],
              });
              const extCharge = expandedExtPI?.latest_charge;
              const extBt = extCharge && typeof extCharge === "object" ? extCharge.balance_transaction : null;
              if (extBt && typeof extBt === "object") {
                const extFeeCents = extBt.fee != null ? Number(extBt.fee) : null;
                const extNetCents = extBt.net != null ? Number(extBt.net) : null;
                if (extFeeCents != null && Number.isFinite(extFeeCents)) {
                  extFeeFields = {
                    stripeFee: Math.round(extFeeCents) / 100,
                    stripeNet: extNetCents != null && Number.isFinite(extNetCents) ? Math.round(extNetCents) / 100 : null,
                  };
                }
              }
            } catch (extFeeErr) {
              console.warn(
                `scheduled-reminders reconciliation: extension PI ${pi.id} fee lookup failed (non-fatal — fee will be backfilled):`,
                extFeeErr.message
              );
            }
            await autoCreateRevenueRecord({
              booking_ref:     resolvedExtRef,
              paymentIntentId: pi.id,
              vehicleId:       extMeta.vehicle_id || "",
              name:            extMeta.renter_name  || "",
              phone:           extMeta.renter_phone || "",
              email:           extMeta.renter_email || "",
              // previous_return_date = start of extension window; new_return_date = end.
              // autoCreateRevenueRecord will override returnDate with bookings.return_date
              // (source of truth) so stale metadata values are automatically corrected.
              pickupDate:      extMeta.previous_return_date || "",
              returnDate:      extMeta.new_return_date      || "",
              amountPaid:      Math.round(pi.amount_received || pi.amount || 0) / 100,
              paymentMethod:   "stripe",
              type:            "extension",
              ...extFeeFields,
            }, { strict: false, requireStripeFee: false });

            // Keep bookings.return_date in sync for admin visibility when an
            // extension PI was missed by the primary webhook pipeline.
            const extNewReturnDate = extMeta.new_return_date
              ? String(extMeta.new_return_date).split("T")[0]
              : "";
            if (sbExt && extNewReturnDate) {
              try {
                const { data: currentExtBooking } = await sbExt
                  .from("bookings")
                  .select("return_date")
                  .eq("booking_ref", resolvedExtRef)
                  .maybeSingle();
                const currentExtReturnDate = currentExtBooking?.return_date
                  ? String(currentExtBooking.return_date).split("T")[0]
                  : "";
                if (!currentExtReturnDate || extNewReturnDate > currentExtReturnDate) {
                  await sbExt
                    .from("bookings")
                    .update({
                      return_date: extNewReturnDate,
                      updated_at: new Date().toISOString(),
                    })
                    .eq("booking_ref", resolvedExtRef);
                  console.log(
                    `scheduled-reminders reconciliation: extension booking return_date advanced to ${extNewReturnDate} for ${resolvedExtRef}`
                  );
                }
              } catch (extBookingUpdateErr) {
                console.warn(
                  `scheduled-reminders reconciliation: extension booking return_date update failed (non-fatal) for ${resolvedExtRef}:`,
                  extBookingUpdateErr.message
                );
              }
            }
            repairedPIIds.push(pi.id);
            console.log(`scheduled-reminders reconciliation: extension revenue record recovered for PI ${pi.id} (booking=${resolvedExtRef})`);
          } catch (extRecovErr) {
            failedPIIds.push(pi.id);
            repairErrors.set(pi.id, extRecovErr.message);
            console.error(
              `scheduled-reminders reconciliation: extension revenue recovery FAILED for PI ${pi.id}:`,
              extRecovErr.message
            );
          }
        } else if (
          paymentType === "balance_payment" ||
          paymentType === "rental_balance"  ||
          paymentType === "partial_balance"
        ) {
          // Balance payment: the booking already exists and was updated by the
          // primary webhook handler.  Only the revenue record is missing.
          // Recover it directly via autoCreateRevenueRecord — never touch the
          // booking row so we avoid the Supabase date-conflict trigger.
          try {
            const balMeta = pi.metadata || {};
            const balRef  = balMeta.booking_id || balMeta.original_booking_id || "";
            if (!balRef) {
              throw new Error(`missing booking_id in metadata (pi=${pi.id})`);
            }
            const sbBal = getSupabaseAdmin();
            let resolvedBalRef = balRef;
            if (sbBal) {
              const { data: balRefRow } = await sbBal
                .from("bookings")
                .select("booking_ref")
                .eq("booking_ref", balRef)
                .maybeSingle();
              if (balRefRow?.booking_ref) {
                resolvedBalRef = balRefRow.booking_ref;
              } else if (pi.id) {
                const { data: byPiRow } = await sbBal
                  .from("bookings")
                  .select("booking_ref")
                  .eq("payment_intent_id", pi.id)
                  .maybeSingle();
                if (byPiRow?.booking_ref) resolvedBalRef = byPiRow.booking_ref;
              }
            }
            // Resolve Stripe fee (non-blocking — reconcile.js backfills if missing).
            let balFeeFields = { stripeFee: null, stripeNet: null };
            try {
              const expandedBalPI = await stripe.paymentIntents.retrieve(pi.id, {
                expand: ["latest_charge.balance_transaction"],
              });
              const balCharge = expandedBalPI?.latest_charge;
              const balBt = balCharge && typeof balCharge === "object" ? balCharge.balance_transaction : null;
              if (balBt && typeof balBt === "object") {
                const balFeeCents = balBt.fee != null ? Number(balBt.fee) : null;
                const balNetCents = balBt.net != null ? Number(balBt.net) : null;
                if (balFeeCents != null && Number.isFinite(balFeeCents)) {
                  balFeeFields = {
                    stripeFee: Math.round(balFeeCents) / 100,
                    stripeNet: balNetCents != null && Number.isFinite(balNetCents) ? Math.round(balNetCents) / 100 : null,
                  };
                }
              }
            } catch (balFeeErr) {
              console.warn(
                `scheduled-reminders reconciliation: balance PI ${pi.id} fee lookup failed (non-fatal — fee will be backfilled):`,
                balFeeErr.message
              );
            }
            await autoCreateRevenueRecord({
              bookingId:       resolvedBalRef,
              paymentIntentId: pi.id,
              vehicleId:       balMeta.vehicle_id || "",
              name:            balMeta.renter_name  || "",
              phone:           balMeta.renter_phone || "",
              email:           balMeta.email || "",
              pickupDate:      balMeta.pickup_date  || "",
              returnDate:      balMeta.return_date  || "",
              amountPaid:      Math.round((pi.amount_received || pi.amount || 0)) / 100,
              paymentMethod:   "stripe",
              type:            "rental_balance",
              ...balFeeFields,
            }, { strict: false, requireStripeFee: false });
            repairedPIIds.push(pi.id);
            console.log(`scheduled-reminders reconciliation: balance revenue record recovered for PI ${pi.id} (booking=${resolvedBalRef})`);
          } catch (balRecovErr) {
            failedPIIds.push(pi.id);
            repairErrors.set(pi.id, balRecovErr.message);
            console.error(
              `scheduled-reminders reconciliation: balance revenue recovery FAILED for PI ${pi.id}:`,
              balRecovErr.message
            );
          }
        } else {
          console.warn(
            `scheduled-reminders reconciliation: PI ${pi.id} has payment_type=${paymentType} — skipping auto-repair (manual review needed)`
          );
        }
        continue;
      }

      // Step 0: Resolve stripe fee (non-blocking).
      // Booking is always persisted even when fee resolution fails; stripe_fee
      // will remain null and be backfilled later by stripe-reconcile.js.
      let reconExtraFields = {};
      try {
        const expandedPI = await stripe.paymentIntents.retrieve(pi.id, {
          expand: ["latest_charge.balance_transaction"],
        });
        const charge = expandedPI?.latest_charge;
        const bt = charge && typeof charge === "object" ? charge.balance_transaction : null;
        if (bt && typeof bt === "object") {
          const feeCents = bt.fee != null ? Number(bt.fee) : null;
          const netCents = bt.net != null ? Number(bt.net) : null;
          const stripeFee = feeCents != null ? Math.round(feeCents) / 100 : null;
          const stripeNet = netCents != null ? Math.round(netCents) / 100 : null;
          if (stripeFee != null && Number.isFinite(stripeFee) && stripeFee >= 0) {
            reconExtraFields = { stripeFee, stripeNet: Number.isFinite(stripeNet) ? stripeNet : null };
          }
        }
      } catch (feeErr) {
        console.warn(
          `scheduled-reminders reconciliation: stripe fee resolution failed for PI ${pi.id}` +
          ` (non-fatal — proceeding with fee=null, backfilled by reconcile):`,
          feeErr
        );
      }

      const stepErrors = []; // collect per-step error strings for this PI

      // Step 1: Persist booking + revenue record (idempotent).
      //   saveWebhookBookingRecord uses upsert semantics — if the booking already
      //   exists it updates it; if revenue already exists it backfills missing fee data.
      //   booking_id in revenue_records is always set to the booking_ref (not the UUID id).
      let step1Ok = false;
      try {
        await saveWebhookBookingRecord(pi, reconExtraFields);
        step1Ok = true;
        console.log(`scheduled-reminders reconciliation: step 1 (persist) succeeded for PI ${pi.id} (${paymentType || "full_payment"})`);
      } catch (persistErr) {
        // Build a detailed error string: message + any Supabase-style fields.
        const detail = [
          persistErr.message,
          persistErr.code    ? `code=${persistErr.code}`       : null,
          persistErr.details ? `details=${persistErr.details}` : null,
          persistErr.hint    ? `hint=${persistErr.hint}`       : null,
        ].filter(Boolean).join(" | ");
        stepErrors.push(`persist: ${detail}`);
        // Log the full error object so Vercel captures the stack trace.
        console.error(
          `scheduled-reminders reconciliation: step 1 (persist) FAILED for PI ${pi.id} — ${detail}`,
          persistErr
        );
      }

      // Step 2: Block calendar dates and mark vehicle unavailable.
      //   Runs regardless of step 1 outcome so partial states are always completed.
      //   mapVehicleId derives the canonical ID from PI metadata.
      const meta = pi.metadata || {};
      if (meta.pickup_date && meta.return_date) {
        let reconVehicleId = "";
        try {
          reconVehicleId = mapVehicleId(meta);
        } catch (mapErr) {
          console.warn(
            `scheduled-reminders reconciliation: vehicle_id mapping failed for PI ${pi.id}: ${mapErr.message}` +
            " — skipping blockBookedDates/markVehicleUnavailable"
          );
        }
        if (reconVehicleId) {
          try {
            await blockBookedDates(
              reconVehicleId,
              meta.pickup_date,
              meta.return_date,
              meta.pickup_time  || "",
              meta.return_time  || ""
            );
            await markVehicleUnavailable(reconVehicleId);
          } catch (blockErr) {
            stepErrors.push(`block_dates: ${blockErr.message}`);
            console.error(
              `scheduled-reminders reconciliation: step 2 (block dates) FAILED for PI ${pi.id}:`,
              blockErr
            );
          }
        }
      }

      // Step 3: Send owner + customer notification emails.
      //   Runs regardless of steps 1–2 outcome.
      //   sendWebhookNotificationEmails checks email_sent flag — never double-sends.
      try {
        await sendWebhookNotificationEmails(pi);
      } catch (emailErr) {
        stepErrors.push(`email: ${emailErr.message}`);
        console.error(
          `scheduled-reminders reconciliation: step 3 (notification emails) FAILED for PI ${pi.id}:`,
          emailErr
        );
      }

      if (step1Ok) {
        repairedPIIds.push(pi.id);
        console.log(`scheduled-reminders reconciliation: auto-repaired PI ${pi.id} (${paymentType || "full_payment"})`);
      } else {
        failedPIIds.push(pi.id);
        repairErrors.set(pi.id, stepErrors.join("; "));
        console.error(
          `scheduled-reminders reconciliation: PI ${pi.id} repair FAILED — errors: ${stepErrors.join("; ")}`
        );
      }
    }

    const escStr = (s) => String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const rows = newMismatches.map((pi) => {
      const meta      = pi.metadata || {};
      const repaired  = repairedPIIds.includes(pi.id);
      const failed    = failedPIIds.includes(pi.id);
      const errDetail = failed ? (repairErrors.get(pi.id) || "see server logs") : "";
      const status    = repaired ? "✅ Auto-processed" : (failed ? `❌ Repair failed: ${escStr(errDetail)}` : "⚠️ Skipped (manual)");
      return `<tr>
        <td style="padding:6px;border:1px solid #ddd">${escStr(pi.id)}</td>
        <td style="padding:6px;border:1px solid #ddd">$${(pi.amount / 100).toFixed(2)}</td>
        <td style="padding:6px;border:1px solid #ddd">${escStr(meta.original_booking_id || meta.booking_id || "—")}</td>
        <td style="padding:6px;border:1px solid #ddd">${escStr(meta.payment_type || "—")}</td>
        <td style="padding:6px;border:1px solid #ddd">${new Date(pi.created * 1000).toISOString()}</td>
        <td style="padding:6px;border:1px solid #ddd">${status}</td>
      </tr>`;
    }).join("\n");

    const skippedPIIds = newMismatches
      .filter((pi) => !repairedPIIds.includes(pi.id) && !failedPIIds.includes(pi.id))
      .map((pi) => pi.id);
    // ✅ subject only when every mismatch was actually auto-processed (no failures, no skipped-for-manual-review)
    const allAutoProcessed = failedPIIds.length === 0 && skippedPIIds.length === 0 && repairedPIIds.length > 0;
    const subject = allAutoProcessed
      ? `[Sly Car Rentals] ✅ ${repairedPIIds.length} Payment(s) Auto-Processed`
      : `[Sly Car Rentals] ⚠️ ${newMismatches.length} Payment(s) Detected – ${repairedPIIds.length} Auto-Processed`;

    // Email alert
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && OWNER_EMAIL) {
      try {
        const transporter = nodemailer.createTransport({
          host:   process.env.SMTP_HOST,
          port:   parseInt(process.env.SMTP_PORT || "587"),
          secure: process.env.SMTP_PORT === "465",
          auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({
          from:    `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
          to:      OWNER_EMAIL,
          subject,
          html: `
            <h2>${allAutoProcessed ? "✅ Payments Auto-Processed" : "⚠️ Payment Recovery Summary"}</h2>
            <p>${newMismatches.length} Stripe PaymentIntent(s) were detected without matching revenue records. The system attempted to process each one${repairedPIIds.length > 0 ? " — a separate booking confirmation email has been sent for each successfully processed payment" : ""}.</p>
            <table style="border-collapse:collapse;width:100%;margin:16px 0">
              <thead>
                <tr style="background:#f5f5f5">
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">PaymentIntent ID</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Amount</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Booking ID</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Type</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Created</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Status</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            ${failedPIIds.length > 0
              ? `<p style="color:#d32f2f">⚠️ <strong>${failedPIIds.length} payment(s) could not be auto-processed.</strong> Please review them manually in the <a href="https://dashboard.stripe.com/payments">Stripe Dashboard</a> and the <a href="https://admin.slycarrentals.com/admin-v2/">Admin Panel</a>.</p>`
              : skippedPIIds.length > 0
                ? `<p style="color:#e65100">⚠️ <strong>${skippedPIIds.length} payment(s) require manual review</strong> (type not eligible for auto-processing). Please review them in the <a href="https://dashboard.stripe.com/payments">Stripe Dashboard</a> and the <a href="https://admin.slycarrentals.com/admin-v2/">Admin Panel</a>.</p>`
                : `<p>✅ All detected payments have been processed. Please verify them in the <a href="https://admin.slycarrentals.com/admin-v2/">Admin Panel</a>.</p>`}
            <p><strong>Sly Car Rentals LLC 🚗</strong></p>
          `,
          text: [
            subject,
            "",
            allAutoProcessed
              ? `${repairedPIIds.length} payment(s) were auto-processed successfully.`
              : `${repairedPIIds.length}/${newMismatches.length} payment(s) were auto-processed. ${failedPIIds.length} failed. ${skippedPIIds.length} require manual review.`,
            "",
            ...newMismatches.map((pi) => {
              const repaired = repairedPIIds.includes(pi.id);
              const failed   = failedPIIds.includes(pi.id);
              const st       = repaired ? "[PROCESSED]" : (failed ? "[FAILED]" : "[SKIPPED]");
              const errLine  = failed && repairErrors.get(pi.id) ? `  error: ${repairErrors.get(pi.id)}` : "";
              return `  ${st} ${pi.id}  $${(pi.amount / 100).toFixed(2)}${errLine}`;
            }),
            "",
            "Admin Panel: https://admin.slycarrentals.com/admin-v2/",
          ].join("\n"),
        });
      } catch (emailErr) {
        console.warn("scheduled-reminders reconciliation: alert email failed:", emailErr.message);
      }
    }

    // SMS alert (brief — only when manual intervention is needed)
    const manualPIIds = [...failedPIIds, ...skippedPIIds];
    if (manualPIIds.length > 0 && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY && OWNER_PHONE) {
      try {
        const manualSummary = newMismatches
          .filter((pi) => manualPIIds.includes(pi.id))
          .slice(0, 3)
          .map((pi) => `${pi.id} ($${(pi.amount / 100).toFixed(2)})`)
          .join(", ");
        const smsText = `[Sly Car Rentals] ⚠️ ${manualPIIds.length} payment(s) need manual review: ${manualSummary}${manualPIIds.length > 3 ? ` +${manualPIIds.length - 3} more` : ""}. Check email.`;
        await sendSms(OWNER_PHONE, smsText);
      } catch (smsErr) {
        console.warn("scheduled-reminders reconciliation: alert SMS failed:", smsErr.message);
      }
    }

    // Persist the newly alerted PI IDs so we don't re-alert on the next cron tick
    try {
      const nowIso = new Date().toISOString();
      for (const pi of newMismatches) alertedPIs[pi.id] = nowIso;
      await sb.from("app_config").upsert(
        { key: DEDUP_KEY, value: alertedPIs, updated_at: nowIso },
        { onConflict: "key" }
      );
    } catch (dedupErr) {
      console.warn("scheduled-reminders reconciliation: failed to persist dedup state (non-fatal):", dedupErr.message);
    }
  } catch (err) {
    console.error("scheduled-reminders reconciliation: unexpected error (non-fatal):", err.message);
  }
}


/**
 * Process bookings with outstanding balance_due — send payment-failed reminders.
 *
 * Retry schedule (based on hours since balance_due was first set):
 *   +1 h   → first reminder
 *   +12 h  → second reminder
 *   +24 h  → third reminder
 *   +48 h  → final reminder
 *
 * The base time is balance_due_set_at (migration 0120) — a timestamp that is
 * pinned to the moment balance_due first went positive and is NOT updated on
 * subsequent row changes.  This prevents past/completed renters from receiving
 * reminders when their booking is touched for unrelated reasons.  For rows
 * written before migration 0120, updated_at is used as a fallback.
 *
 * After 72 hours (last retry window closed) no further reminders are sent
 * regardless of booking status.  Each retry fires once and is deduplicated via
 * sms_logs.  The template key encodes the retry index so all four reminders
 * can fire for the same booking.
 */
// ─── Phase 4: Ledger-based balance due / overdue reminders ────────────────────
// Queries renter_balance_ledger for bookings with due_date entries and positive
// net balance, then fires appropriately aged SMS reminders.
// Deduplicated via sms_logs using (booking_id, template_key, return_date_at_send).
// Configurable via system_settings: balance_reminder_enabled, etc.
// Non-fatal: errors are logged but do not interrupt the cron job.
async function processLedgerBalanceReminders(now, sentMarks) {
  const sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    // Check feature flag.
    const enabled = await loadBooleanSetting("balance_reminder_enabled", false);
    if (!enabled) return;

    // Find ledger entries with a due_date and positive net balance.
    const cutoff = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ahead
    const { data: dueRows, error: dueErr } = await sb
      .from("renter_balance_ledger")
      .select("booking_id, due_date, amount, direction")
      .not("due_date", "is", null)
      .lte("due_date", cutoff)
      .order("due_date", { ascending: true })
      .limit(500);
    if (dueErr) {
      console.warn("[processLedgerBalanceReminders] due-date query failed (non-fatal):", dueErr.message);
      return;
    }
    if (!dueRows || dueRows.length === 0) return;

    // Unique booking IDs with any upcoming/past due date.
    const bookingIds = [...new Set(dueRows.map((r) => r.booking_id))];

    // Fetch booking metadata for phone numbers.
    const { data: bookingRows, error: bErr } = await sb
      .from("bookings")
      .select("booking_ref, customer_name, customer_phone, balance_due")
      .in("booking_ref", bookingIds);
    if (bErr) {
      console.warn("[processLedgerBalanceReminders] bookings query failed (non-fatal):", bErr.message);
      return;
    }

    // Fetch ledger summary for net balance check.
    const { data: summaryRows, error: sumErr } = await sb
      .from("renter_balance_ledger_summary")
      .select("booking_id, net_balance")
      .in("booking_id", bookingIds);
    if (sumErr) {
      console.warn("[processLedgerBalanceReminders] summary query failed (non-fatal):", sumErr.message);
      return;
    }

    const summaryMap = {};
    for (const s of summaryRows || []) summaryMap[s.booking_id] = Number(s.net_balance || 0);

    for (const bk of bookingRows || []) {
      const phone = normalizePhone(bk.customer_phone);
      if (!phone) continue;

      const netBalance = summaryMap[bk.booking_ref] || 0;
      if (netBalance <= 0) continue;

      // Find earliest due_date for this booking.
      const bookingDueDates = dueRows
        .filter((r) => r.booking_id === bk.booking_ref && r.due_date)
        .map((r) => r.due_date)
        .sort();
      if (bookingDueDates.length === 0) continue;

      const earliestDue = new Date(bookingDueDates[0]);
      const daysDiff = Math.floor((now.getTime() - earliestDue.getTime()) / (24 * 60 * 60 * 1000));
      const dueDateStr = earliestDue.toISOString().slice(0, 10);
      const balanceStr = netBalance.toFixed(2);
      const links = buildRenterPortalLinks({ bookingId: bk.booking_ref });
      const paymentLink = links.primaryLink;

      const v = {
        customer_name: bk.customer_name || "Valued Customer",
        balance_amount: balanceStr,
        due_date: dueDateStr,
        payment_link: paymentLink,
      };

      // 3 days before due → BALANCE_DUE_REMINDER
      if (daysDiff >= -3 && daysDiff < 0) {
        const key = "balance_due_reminder";
        if (!(await isSmsLogged(bk.booking_ref, key, dueDateStr))) {
          const sent = await safeSend(phone, render(BALANCE_DUE_REMINDER, v), { booking_ref: bk.booking_ref, message_type: key });
          if (sent) {
            sentMarks.push({ vehicleId: "balance", id: bk.booking_ref, key });
            await logSmsToSupabase(bk.booking_ref, key, dueDateStr);
          }
        }
        continue;
      }

      // Day 0 overdue
      if (daysDiff >= 0 && daysDiff < 2) {
        const key = "balance_overdue";
        if (!(await isSmsLogged(bk.booking_ref, key, dueDateStr))) {
          const sent = await safeSend(phone, render(BALANCE_OVERDUE, v), { booking_ref: bk.booking_ref, message_type: key });
          if (sent) {
            sentMarks.push({ vehicleId: "balance", id: bk.booking_ref, key });
            await logSmsToSupabase(bk.booking_ref, key, dueDateStr);
          }
        }
        continue;
      }

      // 30 days overdue
      if (daysDiff >= 30 && daysDiff < 32) {
        const thirtyEnabled = await loadBooleanSetting("balance_overdue_30_enabled", true);
        if (thirtyEnabled) {
          const key = "balance_overdue_30";
          if (!(await isSmsLogged(bk.booking_ref, key, dueDateStr))) {
            const sent = await safeSend(phone, render(BALANCE_OVERDUE_30, v), { booking_ref: bk.booking_ref, message_type: key });
            if (sent) {
              sentMarks.push({ vehicleId: "balance", id: bk.booking_ref, key });
              await logSmsToSupabase(bk.booking_ref, key, dueDateStr);
            }
          }
        }
        continue;
      }

      // 60 days overdue
      if (daysDiff >= 60 && daysDiff < 62) {
        const sixtyEnabled = await loadBooleanSetting("balance_overdue_60_enabled", true);
        if (sixtyEnabled) {
          const key = "balance_overdue_60";
          if (!(await isSmsLogged(bk.booking_ref, key, dueDateStr))) {
            const sent = await safeSend(phone, render(BALANCE_OVERDUE_60, v), { booking_ref: bk.booking_ref, message_type: key });
            if (sent) {
              sentMarks.push({ vehicleId: "balance", id: bk.booking_ref, key });
              await logSmsToSupabase(bk.booking_ref, key, dueDateStr);
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("[processLedgerBalanceReminders] error (non-fatal):", err.message);
  }
}

async function processBalanceDue(allBookings, now, sentMarks) {
  const RETRY_HOURS = [1, 12, 24, 48];
  // Total hours after which all retry windows have closed.  After this point
  // the booking is considered "past" and no further reminders are sent.
  const MAX_RETRY_HOURS = RETRY_HOURS[RETRY_HOURS.length - 1] + 24; // 72 h

  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (!booking.balanceDue || booking.balanceDue <= 0) continue;
      if (!booking.phone) continue;
      if (!shouldSendBalanceCollectionReminder(booking.status)) continue;

      const id = booking.bookingId || booking.paymentIntentId;
      if (!id) continue;

      // Use balance_due_set_at as the authoritative base time for retry
      // windows.  This timestamp is set once when balance_due first goes
      // positive and is NOT updated on subsequent booking row changes
      // (migration 0120 trigger).  Falling back to updatedAt only when
      // balance_due_set_at is absent (rows written before migration 0120).
      const baseTime = booking.balanceDueSetAt || booking.updatedAt || booking.createdAt;
      if (!baseTime) continue;

      const sinceMs    = now.getTime() - new Date(baseTime).getTime();
      const sinceHours = sinceMs / MS_PER_HOUR;

      // If every retry window has already passed, treat this booking as past
      // and stop sending reminders entirely.  This prevents old unsent
      // messages from firing when a booking row is touched after the retry
      // schedule has expired (e.g. an admin edit on a completed rental).
      if (sinceHours >= MAX_RETRY_HOURS) continue;

      const v = vars(booking);

      for (let i = 0; i < RETRY_HOURS.length; i++) {
        const targetHours = RETRY_HOURS[i];
        const windowHours = i + 1 < RETRY_HOURS.length
          ? RETRY_HOURS[i + 1] - targetHours
          : 24; // last retry: 24-hour window
        const templateKey = `payment_failed_balance_r${i + 1}`;

        if (
          sinceHours >= targetHours &&
          sinceHours < targetHours + windowHours &&
          !(await isSmsLogged(id, templateKey))
        ) {
          const sent = await safeSend(booking.phone, render(PAYMENT_FAILED_BALANCE, v), {
            booking_ref:  id,
            vehicle_id:   vehicleId,
            message_type: templateKey,
            payment_state: booking.status || null,
          });
          if (sent) {
            sentMarks.push({ vehicleId, id, key: templateKey });
            await logSmsToSupabase(id, templateKey);
          }
          break; // only one retry per cron tick per booking
        }
      }
    }
  }
}

/**
 * Expire stale pending checkout bookings created via the Stripe payment flow that were
 * never paid.  This is a safety net for abandoned checkout sessions where the
 * customer loaded the payment form but never entered card details (so no Stripe
 * webhook event ever fires to clean up the pending row).
 *
 * Only targets bookings that:
 *   • status = "pending_checkout" (or legacy "pending")
 *   • payment_intent_id starts with "pi_" (created via Stripe; not manual)
 *   • created_at is older than STALE_PENDING_HOURS hours ago
 *
 * Manual/admin bookings (payment_intent_id = "manual_*") are intentionally
 * excluded so legitimate offline bookings are never auto-cancelled.
 */
const STALE_PENDING_HOURS = 2;

async function cancelStalePendingBookings(sb) {
  if (!sb) return;
  try {
    const cutoff = new Date(Date.now() - STALE_PENDING_HOURS * MS_PER_HOUR).toISOString();
    const { data: staleRows, error: queryErr } = await sb
      .from("bookings")
      .select("booking_ref")
      .in("status", ["pending", "pending_checkout"])
      .like("payment_intent_id", "pi_%")
      .not("booking_ref", "is", null)
      .lt("created_at", cutoff);

    if (queryErr) {
      console.warn("scheduled-reminders cancelStalePendingBookings: query failed (non-fatal):", queryErr.message);
      return;
    }

    if (!staleRows || staleRows.length === 0) return;

    const refs = staleRows.map((r) => r.booking_ref);
    if (refs.length === 0) return;

    const { error: updateErr } = await sb
      .from("bookings")
      .update({ status: toDbBookingStatus("abandoned_checkout"), updated_at: new Date().toISOString() })
      .in("booking_ref", refs)
      .in("status", ["pending", "pending_checkout"]); // re-filter to avoid race-condition overwrites

    if (updateErr) {
      console.warn("scheduled-reminders cancelStalePendingBookings: cancel update failed (non-fatal):", updateErr.message);
    } else {
      console.log("[CHECKOUT_CLEANUP]", {
        reason: "stale_pending_checkout_expired",
        toStatus: "abandoned_checkout",
        source: "scheduled-reminders",
        affectedRows: refs.length,
        bookingRefs: refs,
        releasedTemporaryHold: refs.length > 0,
      });
    }
  } catch (err) {
    console.warn("scheduled-reminders cancelStalePendingBookings: unexpected error (non-fatal):", err.message);
  }
}

export default async function handler(req, res) {
  // Accept GET (Vercel cron) or POST (manual admin trigger)
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Authenticate manual POST requests
  if (req.method === "POST") {
    const authHeader = req.headers.authorization || "";
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (maybeSkipScheduledAutomation(req, res, { endpoint: "scheduled-reminders" })) return;

  let allBookings;

  // Load bookings from Supabase (primary source).  All decisions must be based
  // on fresh Supabase data, not bookings.json.  Falls back to bookings.json only
  // when Supabase is unavailable (e.g. missing credentials, network error).
  const sbClient = getSupabaseAdmin();
  if (sbClient) {
    // DEBUG: confirm which DB project the cron is connected to.
    // Remove after renter_phone column issue is confirmed resolved.
    const { data: _dbg, error: _dbgErr } = await sbClient
      .from("bookings")
      .select("booking_ref, renter_phone")
      .limit(1);
    console.log("DEBUG bookings renter_phone:", {
      supabaseUrl: process.env.SUPABASE_URL,
      errorCode:   _dbgErr?.code,
      errorMsg:    _dbgErr?.message,
      data:        _dbg,
    });
    // Secondary check: query information_schema to confirm the column is
    // actually present in this DB project (works with Supabase service-role).
    const { data: _cols, error: _colsErr } = await sbClient
      .schema("information_schema")
      .from("columns")
      .select("column_name")
      .eq("table_name", "bookings")
      .eq("column_name", "renter_phone")
      .limit(1);
    console.log("DEBUG information_schema renter_phone:", {
      columnFound: Array.isArray(_cols) && _cols.length > 0,
      errorCode:   _colsErr?.code,
      errorMsg:    _colsErr?.message,
    });
    allBookings = await loadBookingsFromSupabase(sbClient);
    if (allBookings === null) {
      console.warn("scheduled-reminders: Supabase load failed — falling back to bookings.json");
      allBookings = undefined;
    }
  }
  if (allBookings === undefined) {
    try {
      const loaded = await loadBookings();
      allBookings = loaded.data;
    } catch (err) {
      console.error("scheduled-reminders: failed to load bookings:", err);
      return res.status(500).json({ error: "Failed to load bookings" });
    }
  }

  const now = new Date();

  // Auto-activate and auto-complete bookings regardless of SMS configuration.
  // These must run on every cron tick so overdue bookings never stay stuck.
  await processAutoActivations(allBookings, now);
  await processAutoCompletions(allBookings, now);

  // Cancel stale pending bookings from abandoned Stripe checkout sessions.
  // Safety net for cases where the customer loaded the payment form but never
  // entered card details (no Stripe webhook fires for abandoned PIs).
  await cancelStalePendingBookings(sbClient);

  // Reconcile Stripe payments against revenue_records (runs every tick, non-fatal).
  await runReconciliation();

  // SMS reminders require TextMagic credentials.
  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) {
    console.warn("scheduled-reminders: TextMagic credentials not set — SMS will not be sent");
    return res.status(200).json({ skipped: true, reason: "TextMagic not configured" });
  }

  // Enforce 8 AM – 7 PM LA send window for cron-triggered runs.
  // Manual POST bypasses the window to allow out-of-hours testing.
  // In criticalOnly mode (outside window), processActiveRentals still runs for
  // all active bookings, but only the time-critical trigger blocks execute:
  //   P1 (late_fee_pending, late_grace_expired) and P2 (late_at_return,
  //   late_warning_30min) always fire because they are NOT gated by criticalOnly.
  //   active_rental_1h_before_end (P3) also fires because it is not gated.
  //   Non-critical P3 blocks (active_rental_mid, return_reminder_24h) are
  //   skipped when criticalOnly=true.
  // processUnpaid, processPaidBookings, and processCompleted are skipped entirely.
  if (req.method === "GET") {
    const hour = laHour();
    if (hour < SMS_WINDOW_START_HOUR || hour >= SMS_WINDOW_END_HOUR) {
      const sentMarks = [];
      await processActiveRentals(allBookings, now, sentMarks, true);
      await persistSentMarks(sentMarks);
      return res.status(200).json({
        ok:             true,
        outsideWindow:  true,
        criticalOnly:   true,
        remindersSent:  sentMarks.filter((m) => !m.key.startsWith("_")).length,
        reason: `Outside SMS send window (${SMS_WINDOW_START_HOUR}:00–${SMS_WINDOW_END_HOUR}:00 LA). Current LA hour: ${hour}. Critical SMS still fired.`,
      });
    }
  }

  const sentMarks = [];

  await Promise.allSettled([
    processUnpaid(allBookings, now, sentMarks),
    processPaidBookings(allBookings, now, sentMarks),
    processOnboardingCatchup(allBookings, now, sentMarks),
    processActiveRentals(allBookings, now, sentMarks),
    processCompleted(allBookings, now, sentMarks),
    processBalanceDue(allBookings, now, sentMarks),
    processLedgerBalanceReminders(now, sentMarks),
  ]);

  await persistSentMarks(sentMarks);

  return res.status(200).json({ ok: true, remindersSent: sentMarks.filter(m => !m.key.startsWith("_")).length });
}
