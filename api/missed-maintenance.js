// api/missed-maintenance.js
// Missed maintenance appointment detector — cron endpoint.
//
// GET  /api/missed-maintenance  — Vercel cron trigger (no auth required from Vercel)
// POST /api/missed-maintenance  — Manual trigger; requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// Runs every hour.  For each maintenance_appointment with:
//   status = 'scheduled'  AND  scheduled_at < now()
//
// → Checks maintenance_history for a completion recorded after the appointment
//   was created (same vehicle + service type).
//
// If no completion found → appointment is MISSED:
//   1. Updates appointment status to "missed", records missed_at timestamp.
//   2. Sends driver SMS: "You missed your scheduled maintenance. Please reschedule immediately."
//      (includes a new scheduling link)
//   3. Sends owner SMS + email notification.
//   4. Counts total missed appointments for the same booking.
//      If count > 1:
//        • Updates customers.risk_flag to "high" (by driver phone lookup).
//        • Marks booking maintenance_status = "non_compliant".
//
// Deduplication for SMS:  booking.smsSentAt["maint_<type>_missed"]
//
// Required environment variables:
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   GITHUB_TOKEN — to persist smsSentAt dedup marks to bookings.json
// Optional:
//   TEXTMAGIC_USERNAME + TEXTMAGIC_API_KEY
//   SMTP_HOST/PORT/USER/PASS
//   OWNER_PHONE  — default +18445114059
//   OWNER_EMAIL  — default slyservices@supports-info.com
//   ADMIN_SECRET / CRON_SECRET — for manual POST trigger
//   VERCEL_URL   — used to build scheduling links

import nodemailer from "nodemailer";
import { getSupabaseAdmin } from "./_supabase.js";
import { sendSms } from "./_textmagic.js";
import { loadBookings, saveBookings, normalizePhone, isNetworkError } from "./_bookings.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { maybeSkipScheduledAutomation } from "./_runtime-environment.js";

const OWNER_PHONE = process.env.OWNER_PHONE || "+18445114059";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

const SITE_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://slycarrentals.com";

const SERVICE_LABELS = {
  oil:    "oil change",
  brakes: "brake inspection",
  tires:  "tire replacement",
};

function normalizeBookingIdentity(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function resolveBookingIdentity(row = {}) {
  return (
    normalizeBookingIdentity(row.bookingId) ||
    normalizeBookingIdentity(row.booking_ref) ||
    normalizeBookingIdentity(row.paymentIntentId) ||
    normalizeBookingIdentity(row.payment_intent_id) ||
    normalizeBookingIdentity(row.id)
  );
}

function bookingMatchesIdentity(booking, bookingId) {
  const normalized = normalizeBookingIdentity(bookingId);
  if (!normalized || !booking) return false;
  return [
    booking.bookingId,
    booking.booking_ref,
    booking.paymentIntentId,
    booking.payment_intent_id,
    booking.id,
  ].some((candidate) => normalizeBookingIdentity(candidate) === normalized);
}

function scheduleUrl(vehicleId, serviceType) {
  return `${SITE_BASE}/maintenance-schedule.html?vehicleId=${encodeURIComponent(vehicleId)}&serviceType=${encodeURIComponent(serviceType)}`;
}

function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone:     "America/Los_Angeles",
      weekday:      "short",
      month:        "short",
      day:          "numeric",
      year:         "numeric",
      hour:         "numeric",
      minute:       "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

// ── Notification helpers ──────────────────────────────────────────────────────

async function safeSendSms(phone, text) {
  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) return false;
  try {
    const normalized = normalizePhone(phone);
    if (!normalized) return false;
    await sendSms(normalized, text);
    return true;
  } catch (err) {
    console.warn("missed-maintenance: SMS failed:", err.message);
    return false;
  }
}

async function sendOwnerAlertEmail(subject, html) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
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
    console.warn("missed-maintenance: owner email failed:", err.message);
    return false;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
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

  if (maybeSkipScheduledAutomation(req, res, { endpoint: "missed-maintenance" })) return;

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase is not configured" });
  }

  const startedAt = Date.now();

  try {
    // ── 1. Find overdue scheduled appointments ───────────────────────────────
    const now = new Date().toISOString();
    const { data: overdueAppts, error: apptErr } = await sb
      .from("maintenance_appointments")
      .select("id, vehicle_id, booking_id, service_type, scheduled_at, created_at")
      .eq("status", "scheduled")
      .lt("scheduled_at", now);

    if (apptErr) throw new Error(`maintenance_appointments fetch failed: ${apptErr.message}`);

    if (!overdueAppts || overdueAppts.length === 0) {
      return res.status(200).json({
        ran_at:         now,
        duration_ms:    Date.now() - startedAt,
        checked:        0,
        missed_found:   0,
        notifications:  0,
        escalations:    0,
        detail:         "No overdue scheduled appointments",
      });
    }

    // ── 2. Load active bookings for dedup + driver info ──────────────────────
    // Primary: Supabase (status = 'active'). Fallback: bookings.json — only on
    // network error. Empty Supabase results are valid (no active bookings).
    const overdueVehicleIds = [...new Set(overdueAppts.map((a) => a.vehicle_id))];
    const activeBookingByVehicle = {};
    let usedSupabase = false;
    try {
      const { data: activeRows, error: activeErr } = await sb
        .from("bookings")
        .select("id, booking_ref, payment_intent_id, vehicle_id, customers ( name, phone )")
        .in("status", ["active", "active_rental"])
        .in("vehicle_id", overdueVehicleIds);
      if (activeErr) throw activeErr;
      usedSupabase = true;
      for (const r of (activeRows || [])) {
        activeBookingByVehicle[r.vehicle_id] = {
          bookingId:   resolveBookingIdentity(r),
          bookingRef:  normalizeBookingIdentity(r.booking_ref),
          paymentIntentId: normalizeBookingIdentity(r.payment_intent_id),
          id:          normalizeBookingIdentity(r.id),
          vehicleId:   r.vehicle_id,
          vehicleName: r.vehicle_id, // overlaid from JSON below when available
          name:        r.customers?.name  || "",
          phone:       r.customers?.phone || "",
          smsSentAt:   {},            // overlaid from JSON below for deduplication
        };
      }
    } catch (err) {
      if (isNetworkError(err)) {
        console.error("[FALLBACK] Supabase unreachable in missed-maintenance, using bookings.json:", err.message);
        const { data: allBookingsRaw } = await loadBookings();
        for (const [vid, bookings] of Object.entries(allBookingsRaw || {})) {
          const active = Array.isArray(bookings)
            ? bookings.find((b) => b.status === "active_rental")
            : null;
          if (active) activeBookingByVehicle[vid] = active;
        }
      } else {
        throw err; // non-network Supabase error → propagate
      }
    }

    // When Supabase was used, overlay smsSentAt + vehicleName from bookings.json
    // for deduplication (smsSentAt is written to JSON and not yet in Supabase).
    if (usedSupabase && Object.keys(activeBookingByVehicle).length > 0) {
      try {
        const { data: jsonData } = await loadBookings();
        for (const [vid, bookingObj] of Object.entries(activeBookingByVehicle)) {
          const jsonBookings = jsonData[vid];
          if (!Array.isArray(jsonBookings)) continue;
          const bookingIdentity = resolveBookingIdentity(bookingObj);
          const jsonActive = jsonBookings.find(
            (b) => b.status === "active_rental" &&
              (!bookingIdentity || bookingMatchesIdentity(b, bookingIdentity))
          );
          if (jsonActive?.smsSentAt) {
            activeBookingByVehicle[vid].smsSentAt = jsonActive.smsSentAt;
          }
          if (jsonActive?.vehicleName) {
            activeBookingByVehicle[vid].vehicleName = jsonActive.vehicleName;
          }
        }
      } catch (jsonErr) {
        console.warn("missed-maintenance: could not load smsSentAt from bookings.json (non-fatal):", jsonErr.message);
      }
    }

    // ── 3. Evaluate each overdue appointment ─────────────────────────────────
    const sentMarks       = [];  // { vehicleId, id, key }
    const bookingUpdates  = [];  // { vehicleId, id, patch }
    const missedApptIds   = [];  // appointment IDs to mark as missed
    const summaries       = [];
    let notificationsCount = 0;
    let escalationCount    = 0;

    for (const appt of overdueAppts) {
      const { id: apptId, vehicle_id: vid, booking_id: apptBookingId,
              service_type: serviceType, scheduled_at: scheduledAt,
              created_at: createdAt } = appt;

      const serviceLabel = SERVICE_LABELS[serviceType] || serviceType;

      // Check whether service was completed after this appointment was created
      const { data: completions, error: histErr } = await sb
        .from("maintenance_history")
        .select("id")
        .eq("vehicle_id", vid)
        .eq("service_type", serviceType)
        .gte("created_at", createdAt)
        .limit(1);

      if (histErr) {
        console.warn(`missed-maintenance: history check failed for appt ${apptId}:`, histErr.message);
        continue;
      }

      if (completions && completions.length > 0) {
        // Service was completed — mark appointment as completed and move on
        await sb
          .from("maintenance_appointments")
          .update({ status: "completed", updated_at: now })
          .eq("id", apptId)
          .eq("status", "scheduled");
        continue;
      }

      // ── Appointment is missed ────────────────────────────────────────────
      missedApptIds.push(apptId);

      const booking = activeBookingByVehicle[vid];
      const phone        = booking?.phone      || null;
      const driverName   = booking?.name       || "Driver";
      const vehicleName  = booking?.vehicleName || vid;
      const bookingId    = resolveBookingIdentity(booking) || normalizeBookingIdentity(apptBookingId);
      const missedKey    = `maint_${serviceType}_missed`;
      const scheduledDt  = formatDateTime(scheduledAt);
      const reschedUrl   = scheduleUrl(vid, serviceType);

      // Count previously missed appointments for this booking to determine escalation.
      // +1 accounts for the current appointment which has not been marked yet.
      // We only count by bookingId (driver-scoped); without one we cannot reliably
      // attribute previous misses to the same driver and skip escalation.
      let previousMissedCount = 0;
      if (bookingId) {
        const { count, error: countErr } = await sb
          .from("maintenance_appointments")
          .select("id", { count: "exact", head: true })
          .eq("booking_id", bookingId)
          .eq("status", "missed");
        if (!countErr) previousMissedCount = count || 0;
      }

      const totalMissed = previousMissedCount + 1;

      const alreadyNotified = !!(booking?.smsSentAt && booking.smsSentAt[missedKey]);

      if (!alreadyNotified) {
        // Driver SMS
        if (phone) {
          const driverMsg = `⚠️ You missed your scheduled ${serviceLabel} appointment on ${scheduledDt}. Please reschedule immediately: ${reschedUrl}`;
          const driverSent = await safeSendSms(phone, driverMsg);
          if (driverSent) notificationsCount++;
        }

        // Owner SMS
        await safeSendSms(OWNER_PHONE,
          `🚫 ${driverName} missed their ${serviceLabel} appointment for ${vehicleName} (scheduled ${scheduledDt}). Booking: ${bookingId || "N/A"}.`
        );

        // Owner email
        await sendOwnerAlertEmail(
          `🚫 Missed Maintenance Appointment — ${vehicleName}`,
          `<p>A driver missed their scheduled maintenance appointment.</p>
<p><strong>Vehicle:</strong> ${vehicleName}</p>
<p><strong>Service:</strong> ${serviceLabel}</p>
<p><strong>Scheduled for:</strong> ${scheduledDt}</p>
<p><strong>Driver:</strong> ${driverName}</p>
<p><strong>Driver phone:</strong> ${phone || "N/A"}</p>
<p><strong>Booking:</strong> ${bookingId || "N/A"}</p>
${totalMissed > 1 ? `<p>⚠️ <strong>This driver has now missed ${totalMissed} appointments.</strong> Risk flag updated to high.</p>` : ""}
<p>A reschedule reminder has been sent to the driver.</p>
<p><a href="${reschedUrl}" style="display:inline-block;padding:10px 20px;background:#1565c0;color:#fff;border-radius:4px;text-decoration:none">📅 Reschedule link</a></p>`
        );

        if (booking && bookingId) {
          sentMarks.push({ vehicleId: vid, id: bookingId, key: missedKey });
        }
      }

      // ── Escalation: > 1 missed appointment ──────────────────────────────
      if (totalMissed > 1) {
        escalationCount++;

        // Update customer risk_flag to "high" via phone lookup
        if (phone) {
          const normalized = normalizePhone(phone);
          if (normalized) {
            await sb
              .from("customers")
              .update({ risk_flag: "high" })
              .eq("phone", normalized)
              .in("risk_flag", ["low", "medium"]);  // only escalate, never downgrade
          }
        }

        // Flag the booking as non_compliant
        if (booking && bookingId) {
          bookingUpdates.push({
            vehicleId: vid,
            id:        bookingId,
            patch:     { maintenance_status: "non_compliant" },
          });
        }
      } else if (totalMissed === 1) {
        // First miss — escalate risk to "medium" if currently "low" or unset
        if (phone) {
          const normalized = normalizePhone(phone);
          if (normalized) {
            await sb
              .from("customers")
              .update({ risk_flag: "medium" })
              .eq("phone", normalized)
              .or("risk_flag.eq.low,risk_flag.is.null");
          }
        }
      }

      summaries.push({
        apptId,
        vehicleId:   vid,
        serviceType,
        scheduledAt,
        bookingId:   bookingId || null,
        totalMissed,
        escalated:   totalMissed > 1,
      });
    }

    // ── 4. Mark appointments as missed in Supabase ───────────────────────────
    if (missedApptIds.length > 0) {
      const { error: markErr } = await sb
        .from("maintenance_appointments")
        .update({ status: "missed", missed_at: now, updated_at: now })
        .in("id", missedApptIds)
        .eq("status", "scheduled");   // guard against race conditions

      if (markErr) {
        console.error("missed-maintenance: failed to mark appointments as missed:", markErr.message);
      }
    }

    // ── 5. Persist dedup marks + booking patches to bookings.json ────────────
    if ((sentMarks.length > 0 || bookingUpdates.length > 0) && process.env.GITHUB_TOKEN) {
      try {
        await updateJsonFileWithRetry({
          load:  loadBookings,
          apply: (data) => {
            for (const { vehicleId, id, key } of sentMarks) {
              const bookings = data[vehicleId];
              if (!Array.isArray(bookings)) continue;
              const idx = bookings.findIndex(
                (b) => bookingMatchesIdentity(b, id)
              );
              if (idx === -1) continue;
              if (!bookings[idx].smsSentAt) bookings[idx].smsSentAt = {};
              bookings[idx].smsSentAt[key] = now;
            }
            for (const { vehicleId, id, patch } of bookingUpdates) {
              const bookings = data[vehicleId];
              if (!Array.isArray(bookings)) continue;
              const idx = bookings.findIndex(
                (b) => bookingMatchesIdentity(b, id)
              );
              if (idx === -1) continue;
              Object.assign(bookings[idx], patch);
            }
          },
          save:    saveBookings,
          message: `missed-maintenance: ${missedApptIds.length} missed, ${sentMarks.length} marks, ${bookingUpdates.length} patches`,
        });
      } catch (err) {
        console.error("missed-maintenance: failed to persist marks:", err.message);
      }
    }

    return res.status(200).json({
      ran_at:          now,
      duration_ms:     Date.now() - startedAt,
      checked:         overdueAppts.length,
      missed_found:    missedApptIds.length,
      notifications:   notificationsCount,
      escalations:     escalationCount,
      detail:          summaries,
    });
  } catch (err) {
    console.error("missed-maintenance error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
