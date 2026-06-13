// api/add-manual-booking.js
// Vercel serverless function — creates a manual booking record for a cash or
// offline reservation and blocks the corresponding dates on the calendar.
// Admin-protected: requires ADMIN_SECRET.
//
// Use this when a customer pays in cash or books over the phone so that the
// booking appears in the profit dashboard and the calendar shows the dates
// as unavailable.
//
// POST /api/add-manual-booking
// Body: {
//   "secret":     "<ADMIN_SECRET>",
//   "vehicleId":  "camry" | "camry2013",
//   "name":       "Customer Full Name",
//   "phone":      "2135551234",        (optional)
//   "email":      "customer@email.com",(optional)
//   "pickupDate": "YYYY-MM-DD",
//   "pickupTime": "10:00 AM",          (required)
//   "returnDate": "YYYY-MM-DD",
//   "returnTime": "5:00 PM",           (required)
//   "amountPaid": 350,                 (optional, dollars)
//   "notes":      "Cash payment",      (optional)
// }

import crypto from "crypto";
import { hasOverlap, isDatesAndTimesAvailable } from "./_availability.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { persistBooking } from "./_booking-pipeline.js";
import { normalizeClockTime } from "./_time.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { getActiveVehicleIds } from "./_pricing.js";

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
const ALLOWED_ORIGINS   = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const VEHICLE_NAMES     = {
  camry:      "Camry 2012",
  camry2013:  "Camry 2013 SE",
};

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function derivePaymentStatus(amountPaid, totalPrice) {
  const paid = roundMoney(amountPaid || 0);
  const total = roundMoney(totalPrice || 0);
  if (paid <= 0) return "unpaid";
  if (total > 0 && paid < total) return "partial";
  return "paid";
}

/**
 * Block the date range in booked-dates.json so the calendar shows the
 * vehicle as unavailable for those dates.  Retries on 409 conflict.
 */
async function blockBookedDates(_vehicleId, _from, _to) {
  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  console.log("add-manual-booking: blockBookedDates() called but writes are disabled (Phase 4)");
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }
  const {
    secret, vehicleId, name, phone, email,
    pickupDate, pickupTime, returnDate, returnTime,
    amountPaid, totalPrice, paymentStatus, notes,
  } = req.body || {};

  // Authentication
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Validation
  if (!vehicleId || !(await getActiveVehicleIds(getSupabaseAdmin())).includes(vehicleId)) {
    return res.status(400).json({ error: "Invalid or missing vehicleId" });
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Customer name is required" });
  }
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!pickupDate || !ISO_DATE.test(pickupDate)) {
    return res.status(400).json({ error: "pickupDate must be in YYYY-MM-DD format" });
  }
  if (!returnDate || !ISO_DATE.test(returnDate)) {
    return res.status(400).json({ error: "returnDate must be in YYYY-MM-DD format" });
  }
  if (pickupDate > returnDate) {
    return res.status(400).json({ error: "pickupDate must not be after returnDate" });
  }
  const trimmedPickupTime = typeof pickupTime === "string" ? pickupTime.trim() : "";
  if (!normalizeClockTime(trimmedPickupTime)) {
    return res.status(400).json({ error: "pickupTime is required and must be a valid time" });
  }
  const trimmedReturnTime = typeof returnTime === "string" ? returnTime.trim() : "";
  if (!normalizeClockTime(trimmedReturnTime)) {
    return res.status(400).json({ error: "returnTime is required and must be a valid time" });
  }

  // Availability check — reject if the requested dates/times are already booked
  const available = await isDatesAndTimesAvailable(vehicleId, pickupDate, returnDate, trimmedPickupTime, trimmedReturnTime);
  if (!available) {
    return res.status(409).json({ error: "conflict" });
  }

  try {
    // 1. Block the dates in booked-dates.json first so the calendar reflects the
    //    reservation before the booking record is persisted.
    await blockBookedDates(vehicleId, pickupDate, returnDate);

    const now = new Date().toISOString();

    const resolvedAmountPaid = typeof amountPaid === "number" && amountPaid > 0
      ? roundMoney(amountPaid)
      : 0;
    const resolvedTotalPrice = typeof totalPrice === "number" && totalPrice > 0
      ? roundMoney(totalPrice)
      : resolvedAmountPaid;
    const resolvedPaymentStatus = typeof paymentStatus === "string" && paymentStatus.trim()
      ? paymentStatus.trim().toLowerCase()
      : derivePaymentStatus(resolvedAmountPaid, resolvedTotalPrice);

    // 2. Persist booking through the unified pipeline (Supabase + bookings.json).
    //    Manual (cash) bookings are created directly as active_rental so they
    //    participate in the SMS automation, mileage tracking, and extension flows
    //    identically to Stripe bookings that have been activated by the admin.
    const { booking } = await persistBooking({
      bookingId:       crypto.randomBytes(8).toString("hex"),
      vehicleId,
      vehicleName:     VEHICLE_NAMES[vehicleId],
      name:            name.trim(),
      phone:           typeof phone === "string" ? phone.trim() : "",
      email:           typeof email === "string" ? email.trim() : "",
      pickupDate,
      pickupTime:      trimmedPickupTime,
      returnDate,
      returnTime:      trimmedReturnTime,
      location:        "",
      status:          "active_rental",
      activatedAt:     now,
      paymentStatus:   resolvedPaymentStatus,
      paymentIntentId: "manual_" + crypto.randomBytes(6).toString("hex"),
      amountPaid:      resolvedAmountPaid,
      totalPrice:      resolvedTotalPrice,
      notes:           typeof notes === "string" ? notes.trim().slice(0, 500) : "",
      paymentMethod:   "cash",
      source:          "admin_manual",
    });

    // 3. Capture start odometer (non-fatal) so oil-check-cron and mileage
    //    analytics can compute avg miles/day from the moment of pickup.
    //    Mirrors the same logic in v2-bookings.js when status → active_rental.
    try {
      const sb = getSupabaseAdmin();
      if (sb && booking.vehicleId) {
        // Only insert when no placeholder trips row exists for this booking yet
        // (guards against double-inserts on idempotent re-calls).
        const { data: existingTrip } = await sb
          .from("trips")
          .select("id")
          .eq("booking_id", booking.bookingId)
          .is("end_mileage", null)
          .limit(1)
          .maybeSingle();

        if (!existingTrip) {
          const { data: vRow } = await sb
            .from("vehicles")
            .select("mileage")
            .eq("vehicle_id", booking.vehicleId)
            .maybeSingle();

          const startOdo = vRow?.mileage != null ? Number(vRow.mileage) : null;

          const { error: tripErr } = await sb.from("trips").insert({
            vehicle_id:    booking.vehicleId,
            booking_id:    booking.bookingId,
            start_mileage: startOdo,
            end_mileage:   null,
            distance:      null,
            driver_name:   booking.name  || null,
            driver_phone:  booking.phone || null,
          });
          if (tripErr) {
            console.warn("add-manual-booking: start mileage trips insert failed (non-fatal):", tripErr.message);
          } else {
            console.log(`add-manual-booking: captured start odometer ${startOdo ?? "n/a"} mi for booking ${booking.bookingId}`);
          }
        }
      }
    } catch (tripCatchErr) {
      console.error("add-manual-booking: start mileage capture failed (non-fatal):", tripCatchErr.message);
    }

    return res.status(200).json({ success: true, booking });
  } catch (err) {
    console.error("add-manual-booking error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
