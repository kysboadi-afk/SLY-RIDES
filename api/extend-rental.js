// api/extend-rental.js
// Vercel serverless function — creates a Stripe PaymentIntent for a web-initiated
// rental extension.  Called from car.html when the current renter wants to
// extend their rental via the "Extend Rental" form.
//
// POST /api/extend-rental
// Body: { vehicleId, email, phone, newReturnDate }
//
// Returns: { clientSecret, publishableKey, extensionAmount, extensionLabel,
//            newReturnDate, newReturnTime, vehicleName, renterName }
//
// Required environment variables:
//   STRIPE_SECRET_KEY
//   STRIPE_PUBLISHABLE_KEY
//   GITHUB_TOKEN   (to read/write bookings.json)
//   GITHUB_REPO    (defaults to kysboadi-afk/SLY-RIDES)

import Stripe from "stripe";
import { getVehicleById } from "./_vehicles.js";
import { getVehiclePricing, computeAmountFromPricing, computeLateFeeAmount } from "./_pricing.js";
import { loadPricingSettings, applyTax } from "./_settings.js";
import { loadBookings, updateBooking, normalizePhone } from "./_bookings.js";
import { hasDateTimeOverlap, parseDateTimeMs } from "./_availability.js";
import { normalizeClockTime, DEFAULT_RETURN_TIME, formatTime12h, buildDateTimeLA, isoDateInLA } from "./_time.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { computeFinalReturnDate } from "./_final-return-date.js";
import { loadExtensionRiskSettings, evaluateExtensionRisk } from "./_extension-risk.js";
import { getLedgerSummary } from "./_renter-balance-ledger.js";
import {
  appendBookingTimelineEvent,
  normalizeExtensionNotes,
  normalizeExtensionReason,
  upsertExtensionLifecycleRecord,
} from "./_extension-lifecycle.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const EXTENSION_BALANCE_BLOCK_THRESHOLD = 150;
const EXTENSION_MIN_PAID_PCT = 0.95;

export default async function handler(req, res) {
  // CORS — allow requests from the production frontend only
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("extend-rental: STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("extend-rental: STRIPE_PUBLISHABLE_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }

  const { vehicleId, email, phone, newReturnDate, name, customPaymentAmount, extensionReason, extensionNotes } = req.body || {};

  // ── Input validation ────────────────────────────────────────────────────────
  const vehicleData = vehicleId ? await getVehicleById(vehicleId) : null;
  if (!vehicleData) {
    return res.status(400).json({ error: "Invalid vehicle." });
  }

  const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const trimmedPhone = typeof phone === "string" ? phone.trim() : "";

  if (!trimmedEmail && !trimmedPhone) {
    return res.status(400).json({ error: "Email or phone number is required to verify your rental." });
  }

  if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  if (!newReturnDate || !/^\d{4}-\d{2}-\d{2}$/.test(newReturnDate)) {
    return res.status(400).json({ error: "New return date is required (YYYY-MM-DD)." });
  }

  try {
    // ── Load bookings and find the active rental ────────────────────────────
    const { data: allBookings } = await loadBookings();
    const vehicleBookings = allBookings[vehicleId] || [];

    const normalizedPhone = trimmedPhone ? normalizePhone(trimmedPhone) : null;

    let activeBooking = null;

    for (let i = 0; i < vehicleBookings.length; i++) {
      const b = vehicleBookings[i];
      const isActive = b.status === "active_rental" || b.status === "active";
      if (!isActive) continue;

      const emailMatch = trimmedEmail && b.email &&
        b.email.trim().toLowerCase() === trimmedEmail;
      const phoneMatch = normalizedPhone && b.phone &&
        normalizePhone(b.phone) === normalizedPhone;

      if (emailMatch || phoneMatch) {
        activeBooking = b;
        break;
      }
    }

    // ── Supabase enrichment: get the most-current return date and find
    //    active bookings that may have been activated without updating bookings.json ──
    // The return date in bookings.json can become stale when a rental is extended
    // via admin actions that only update Supabase.  Supabase is the authoritative
    // source for the live return date; bookings.json is the fallback.
    const sb = getSupabaseAdmin();
    let sbReturnDate = null;       // YYYY-MM-DD from Supabase (may be more recent than bookings.json)
    let sbReturnTime = null;       // HH:MM from Supabase
    let sbActiveBookingRef = null; // canonical booking_ref from Supabase (used for conflict-skip)
    let sbWaivedAmount = 0;        // admin-applied late-fee waiver (subtracted from late fee below)
    let sbDeferredLateFee = 0;     // late fee flagged as 'pending_collection' — added to this PI

    if (sb) {
      try {
        if (activeBooking) {
          // Found in bookings.json — fetch fresh return date from Supabase so pricing
          // reflects any admin-applied extensions that updated Supabase but not bookings.json.
          const bookingRef = activeBooking.bookingId || activeBooking.paymentIntentId;
          if (bookingRef) {
            const { data: sbRow } = await sb
              .from("bookings")
              .select("booking_ref, pickup_date, pickup_time, return_date, return_time, status, late_fee_waived_amount, late_fee_status, late_fee_amount")
              .eq("booking_ref", bookingRef)
              .maybeSingle();
            if (sbRow && (sbRow.status === "active" || sbRow.status === "active_rental" || sbRow.status === "overdue")) {
              // Capture the canonical Supabase booking_ref so the conflict-check
              // loop can skip this booking even when activeBooking.bookingId is a
              // legacy Stripe PI ID that does not match booking_ref.
              if (sbRow.booking_ref) {
                sbActiveBookingRef = sbRow.booking_ref;
              }
              const sbDate = sbRow.return_date ? String(sbRow.return_date).split("T")[0] : null;
              // Only use Supabase date when it is strictly later (guards against stale Supabase rows).
              if (sbDate && sbDate > (activeBooking.returnDate || "")) {
                sbReturnDate = sbDate;
              }
              // Supabase stores time as "HH:MM:SS"; normalise to "HH:MM" for parseDateTimeMs.
              if (sbRow.return_time && !activeBooking.returnTime) {
                sbReturnTime = String(sbRow.return_time).substring(0, 5);
              }
              if (sbRow.pickup_date && !activeBooking.pickupDate) {
                activeBooking.pickupDate = String(sbRow.pickup_date).split("T")[0];
              }
              if (sbRow.pickup_time && !activeBooking.pickupTime) {
                activeBooking.pickupTime = formatTime12h(String(sbRow.pickup_time).substring(0, 5));
              }
              // Apply admin-granted late-fee waiver if present.
              if (sbRow.late_fee_waived_amount) {
                sbWaivedAmount = Math.max(0, Number(sbRow.late_fee_waived_amount) || 0);
              }
              // Collect a deferred late fee: if admin flagged the fee as
              // 'pending_collection' (no card at assessment time), add it to
              // this extension PI so the renter pays it on their next payment.
              if (sbRow.late_fee_status === "pending_collection" && sbRow.late_fee_amount) {
                sbDeferredLateFee = Math.max(0, Number(sbRow.late_fee_amount) || 0);
              }
            }
          }
        } else {
          // Not found in bookings.json (booking may have been created or activated via
          // the admin panel without fully syncing to bookings.json).  Try Supabase
          // directly, matching by vehicle_id + email or phone + active status.
          const { data: sbActive } = await sb
            .from("bookings")
            .select("booking_ref, pickup_date, pickup_time, return_date, return_time, status, customer_name, customer_email, customer_phone, late_fee_waived_amount, late_fee_status, late_fee_amount")
            .eq("vehicle_id", vehicleId)
            .in("status", ["active", "active_rental", "overdue"]);

          if (sbActive) {
            for (const row of sbActive) {
              const rowEmail = (row.customer_email || "").trim().toLowerCase();
              const rowPhone = row.customer_phone ? normalizePhone(row.customer_phone) : null;
              const emailMatch = trimmedEmail && rowEmail === trimmedEmail;
              const phoneMatch = normalizedPhone && rowPhone && rowPhone === normalizedPhone;

              if (emailMatch || phoneMatch) {
                // Try to locate this booking in bookings.json by ref so we can
                // write extensionPendingPayment back to it later.
                const sbRef = row.booking_ref;
                const jsonMatch = vehicleBookings.find(
                  (b) => b.bookingId === sbRef || b.paymentIntentId === sbRef
                );
                if (jsonMatch) {
                  activeBooking = jsonMatch;
                } else {
                  // Build a minimal booking object from Supabase data so the rest
                  // of the flow can proceed; the extensionPendingPayment write will
                  // be a no-op since no bookingId will match in bookings.json.
                  // Fields not present in the Supabase query (pickupDate, status,
                  // paymentIntentId) are set to safe empty defaults.
                  activeBooking = {
                    bookingId:        sbRef,
                    paymentIntentId:  "",
                    name:             row.customer_name  || "",
                    email:            row.customer_email || "",
                    phone:            row.customer_phone || "",
                    pickupDate:       row.pickup_date ? String(row.pickup_date).split("T")[0] : "",
                    pickupTime:       row.pickup_time ? formatTime12h(String(row.pickup_time).substring(0, 5)) : "",
                    returnDate:       row.return_date ? String(row.return_date).split("T")[0] : "",
                    returnTime:       row.return_time ? String(row.return_time).substring(0, 5) : "",
                    status:           row.status || "active_rental",
                  };
                }
                sbActiveBookingRef = row.booking_ref || null;
                sbReturnDate = row.return_date ? String(row.return_date).split("T")[0] : null;
                sbReturnTime = row.return_time  ? String(row.return_time).substring(0, 5) : null;
                if (row.late_fee_waived_amount) {
                  sbWaivedAmount = Math.max(0, Number(row.late_fee_waived_amount) || 0);
                }
                if (row.late_fee_status === "pending_collection" && row.late_fee_amount) {
                  sbDeferredLateFee = Math.max(0, Number(row.late_fee_amount) || 0);
                }
                break;
              }
            }
          }
        }
      } catch (sbErr) {
        console.warn("extend-rental: Supabase booking lookup failed (non-fatal):", sbErr.message);
      }
    }

    if (!activeBooking) {
      return res.status(404).json({
        error: "No active rental found for this vehicle with the provided contact info. " +
               "Please check your email or phone number, or call us at (844) 511-4059.",
      });
    }

    // ── Step 1 of financial computation order: query authoritative ledger balance ──
    // Provides the ground-truth remaining balance that factors into the financial
    // trace and overdue-state derivation.  Non-fatal: failures leave ledger values at 0.
    let ledgerBalance = 0;
    let ledgerTotalCharges = 0;
    let ledgerTotalPaid = 0;
    const isBookingOverdue = activeBooking.status === "overdue";
    if (sb) {
      try {
        const ledgerRef = sbActiveBookingRef || activeBooking.bookingId;
        if (ledgerRef) {
          const summary = await getLedgerSummary(sb, { bookingId: ledgerRef });
          const parsed = Number(summary?.remaining_balance);
          if (Number.isFinite(parsed) && parsed > 0) ledgerBalance = parsed;
          const parsedCharges = Number(summary?.total_charges);
          if (Number.isFinite(parsedCharges) && parsedCharges > 0) ledgerTotalCharges = parsedCharges;
          const parsedPaid = Number(summary?.total_paid);
          if (Number.isFinite(parsedPaid) && parsedPaid > 0) ledgerTotalPaid = parsedPaid;
        }
      } catch (ledgerErr) {
        console.warn("extend-rental: ledger query failed (non-fatal):", ledgerErr.message);
      }
    }

    // Block extensions when the booking is overdue — any outstanding overdue balance
    // must be paid in full before an extension is permitted.
    if (isBookingOverdue && ledgerBalance > 0) {
      return res.status(400).json({
        error: `Your account has an overdue balance of $${ledgerBalance.toFixed(2)}. All overdue amounts must be paid in full before an extension can be approved.`,
        overdueBlocked: true,
        ledgerBalance: ledgerBalance.toFixed(2),
      });
    }

    // Block extensions when the remaining balance exceeds the threshold.
    if (!isBookingOverdue && ledgerBalance > EXTENSION_BALANCE_BLOCK_THRESHOLD) {
      return res.status(400).json({
        error: `Your current balance of $${ledgerBalance.toFixed(2)} exceeds the $${EXTENSION_BALANCE_BLOCK_THRESHOLD.toFixed(2)} extension limit. Please pay your balance down to $${EXTENSION_BALANCE_BLOCK_THRESHOLD.toFixed(2)} or less before requesting an extension.`,
        balanceBlocked: true,
        ledgerBalance: ledgerBalance.toFixed(2),
        extensionBalanceThreshold: EXTENSION_BALANCE_BLOCK_THRESHOLD.toFixed(2),
      });
    }

    // Block extensions when less than 95% of total charges have been paid.
    if (ledgerTotalCharges > 0 && ledgerTotalPaid / ledgerTotalCharges < EXTENSION_MIN_PAID_PCT) {
      const pctPaid = Math.round((ledgerTotalPaid / ledgerTotalCharges) * 100);
      return res.status(400).json({
        error: `At least 95% of your total rental balance must be paid before requesting an extension. You have paid ${pctPaid}% ($${ledgerTotalPaid.toFixed(2)} of $${ledgerTotalCharges.toFixed(2)}). Please pay more of your balance before requesting an extension.`,
        under95PctBlocked: true,
        ledgerTotalCharges: ledgerTotalCharges.toFixed(2),
        ledgerTotalPaid: ledgerTotalPaid.toFixed(2),
        pctPaid,
      });
    }

    const isActiveRentalForPartial = activeBooking.status === "active_rental" || activeBooking.status === "active";
    const hasCustomPaymentAmount =
      customPaymentAmount !== undefined &&
      customPaymentAmount !== null &&
      String(customPaymentAmount).trim() !== "";

    let requestedPaymentAmount = null;
    if (hasCustomPaymentAmount) {
      if (!isActiveRentalForPartial) {
        return res.status(400).json({
          error: "Custom extension payments are only available for active rentals.",
        });
      }
      requestedPaymentAmount = Number(customPaymentAmount);
      if (!Number.isFinite(requestedPaymentAmount) || requestedPaymentAmount <= 0) {
        return res.status(400).json({ error: "Custom payment amount must be a positive number." });
      }
    }

    // If sbActiveBookingRef is still null after the enrichment block (e.g. the booking
    // was in bookings.json but its bookingId is a legacy Stripe PI ID that does not match
    // any booking_ref in Supabase), resolve it now via renter contact info.
    // This guarantees the conflict-check loop can always skip the active booking.
    // Also fetches return_date/return_time so effectiveReturnDate reflects the live
    // Supabase value even when the primary lookup failed due to a PI-ID mismatch.
    if (sb && !sbActiveBookingRef) {
      try {
        let refQuery = sb
          .from("bookings")
          .select("booking_ref, return_date, return_time, late_fee_waived_amount, late_fee_status, late_fee_amount")
          .eq("vehicle_id", vehicleId)
          .in("status", ["active", "active_rental", "overdue"]);
        if (trimmedEmail) {
          refQuery = refQuery.eq("customer_email", trimmedEmail);
        } else if (normalizedPhone) {
          refQuery = refQuery.eq("customer_phone", normalizedPhone);
        }
        const { data: refRow } = await refQuery.maybeSingle();
        if (refRow && refRow.booking_ref) {
          sbActiveBookingRef = refRow.booking_ref;
          // Populate sbReturnDate/sbReturnTime if they weren't resolved by the
          // primary lookup — this fixes stale bookings.json return dates for
          // bookings whose bookingId is a legacy Stripe PI ID.
          if (!sbReturnDate && refRow.return_date) {
            sbReturnDate = String(refRow.return_date).split("T")[0];
          }
          if (!sbReturnTime && refRow.return_time) {
            sbReturnTime = String(refRow.return_time).substring(0, 5);
          }
          if (!sbWaivedAmount && refRow.late_fee_waived_amount) {
            sbWaivedAmount = Math.max(0, Number(refRow.late_fee_waived_amount) || 0);
          }
          if (!sbDeferredLateFee && refRow.late_fee_status === "pending_collection" && refRow.late_fee_amount) {
            sbDeferredLateFee = Math.max(0, Number(refRow.late_fee_amount) || 0);
          }
        }
      } catch (refFallbackErr) {
        console.warn("extend-rental: canonical ref fallback lookup failed (non-fatal):", refFallbackErr.message);
      }
    }

    // Effective return date: prefer Supabase when it is more recent.  This corrects
    // stale bookings.json return dates caused by admin-driven extensions.
    let effectiveReturnDate = (sbReturnDate && sbReturnDate > (activeBooking.returnDate || ""))
      ? sbReturnDate
      : (activeBooking.returnDate || "");

    // Keep extension return_time fixed to the booking's existing return_time.
    // Legacy bookings without a return_time are normalized to the system
    // default so every booking has a valid HH:MM return time.
    const existingReturnTime = normalizeClockTime(sbReturnTime || activeBooking.returnTime);
    const resolvedReturnTime = existingReturnTime || DEFAULT_RETURN_TIME;
    const needsReturnTimePersist = !activeBooking.returnTime || activeBooking.returnTime !== resolvedReturnTime;

    // Incorporate paid extensions from revenue_records so the "must be after
    // current return" validation always uses the true finalReturnDate, not just
    // what bookings.return_date says (which can lag behind revenue_records when
    // the Stripe webhook failed to update the bookings row).
    if (sb) {
      const extBookingRef = sbActiveBookingRef || activeBooking.bookingId || activeBooking.paymentIntentId;
      const { date: finalDate } = await computeFinalReturnDate(
        sb, extBookingRef, effectiveReturnDate, resolvedReturnTime
      );
      if (finalDate > effectiveReturnDate) {
        effectiveReturnDate = finalDate;
      }
    }

    // ── Validate new return date is after current return date ───────────────
    const currentReturnMs = parseDateTimeMs(effectiveReturnDate, resolvedReturnTime);
    const newReturnMs     = parseDateTimeMs(newReturnDate, resolvedReturnTime);

    if (isNaN(newReturnMs)) {
      return res.status(400).json({ error: "Invalid new return date/time." });
    }

    if (newReturnMs <= currentReturnMs) {
      return res.status(400).json({
        error: "New return date/time must be after your current return date/time " +
               `(${effectiveReturnDate}${resolvedReturnTime ? " " + resolvedReturnTime : ""}).`,
      });
    }

    // ── Check for conflicts with future bookings ────────────────────────────
    // Use the same overlap helper as the booking flow so extension conflict
    // checks honor the same time parsing and buffer behavior.
    const extensionRange = [{
      from: effectiveReturnDate || newReturnDate,
      to: newReturnDate,
      fromTime: resolvedReturnTime,
      toTime: resolvedReturnTime,
    }];

    for (const b of vehicleBookings) {
      if (b === activeBooking) continue;
      if (b.bookingId === activeBooking.bookingId) continue;
      // Also skip when the JSON entry's ID matches the Supabase canonical ref —
      // covers legacy entries where b.bookingId is a Stripe PI ID and the
      // activeBooking was resolved via Supabase with a bk-... booking_ref.
      if (sbActiveBookingRef && (b.bookingId === sbActiveBookingRef || b.paymentIntentId === sbActiveBookingRef)) continue;
      if (b.status === "cancelled" || b.status === "completed_rental") continue;
      // Safety guard: skip bookings that end on or before the current effective
      // return date — they cannot conflict with the extension window.  Mirrors
      // the identical guard in the Supabase conflict loop below and acts as the
      // last line of defence when ID matching fails to exclude the active booking
      // (e.g. its returnDate equals effectiveReturnDate but lacks a returnTime,
      // causing the date-only midnight boundary to spill into the extension window).
      if (b.returnDate && b.returnDate <= effectiveReturnDate) continue;

      const hasConflict = hasDateTimeOverlap(
        extensionRange,
        b.pickupDate,
        b.returnDate || b.pickupDate,
        b.pickupTime || "",
        b.returnTime || ""
      );
      if (hasConflict) {
        const fmtDate = new Date(b.pickupDate + "T12:00:00Z")
          .toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric" });
        return res.status(409).json({
          error: `The new return date conflicts with another booking starting on ${fmtDate}. ` +
                 "Please choose an earlier return date.",
        });
      }
    }

    // ── Also check Supabase for future booking conflicts ────────────────────
    // bookings.json may not contain all future reservations (e.g. admin-created
    // bookings that are only in Supabase), so run a second conflict pass.
    if (sb) {
      try {
        const activeBookingRef = activeBooking.bookingId || activeBooking.paymentIntentId || "";
        // Floor the pickup_date filter at the effective return date so we catch
        // all bookings that could overlap with the extension window.  Fall back
        // to today if effectiveReturnDate is not set rather than newReturnDate,
        // which is the end of the extension range and would miss earlier pickups.
        const conflictFloorDate = effectiveReturnDate || isoDateInLA();
        // Exclude the current renter's own booking at the query level when the
        // canonical booking_ref is known.  This is the first line of defence;
        // the in-loop skip below is a secondary guard for any edge cases.
        let futureQuery = sb
          .from("bookings")
          .select("booking_ref, pickup_date, return_date, pickup_time, return_time")
          .eq("vehicle_id", vehicleId)
          .not("status", "in", "(cancelled,completed_rental)")
          .gte("pickup_date", conflictFloorDate);
        if (sbActiveBookingRef) {
          futureQuery = futureQuery.neq("booking_ref", sbActiveBookingRef);
        }
        const { data: sbFuture } = await futureQuery;

        // Batch-fetch paid, non-cancelled extension revenue_records for this
        // vehicle so we can compute the true finalReturnDate for each
        // conflicting booking.  This guards against stale return_date values
        // in the bookings table (e.g. extension recorded in revenue_records but
        // not yet reflected in bookings.return_date).
        // Only paid extensions with is_cancelled=false are counted — unpaid or
        // cancelled extensions do NOT extend a booking's blocking window.
        let extensionMaxReturnByRef = {};
        if (sbFuture && sbFuture.length > 0) {
          try {
            const { data: extRecords } = await sb
              .from("revenue_records")
              .select("original_booking_id, return_date")
              .eq("vehicle_id", vehicleId)
              .eq("type", "extension")
              .eq("payment_status", "paid")
              .eq("is_cancelled", false)
              .gte("return_date", conflictFloorDate);
            for (const rec of (extRecords || [])) {
              if (!rec.original_booking_id || !rec.return_date) continue;
              const rd = String(rec.return_date).split("T")[0];
              const key = rec.original_booking_id;
              if (!extensionMaxReturnByRef[key] || rd > extensionMaxReturnByRef[key]) {
                extensionMaxReturnByRef[key] = rd;
              }
            }
          } catch (extErr) {
            console.warn("extend-rental: revenue_records extension lookup failed (non-fatal):", extErr.message);
          }
        }

        for (const fbk of (sbFuture || [])) {
          // Skip the current renter's own booking.  activeBookingRef may be a
          // legacy Stripe PI ID that doesn't match booking_ref, so also compare
          // against sbActiveBookingRef (the canonical bk-... ref from Supabase).
          if (
            fbk.booking_ref === activeBookingRef ||
            (sbActiveBookingRef && fbk.booking_ref === sbActiveBookingRef)
          ) continue;

          const fbkPickupDate = String(fbk.pickup_date || "").split("T")[0];
          // Skip bookings without a pickup date or without a return date.
          if (!fbkPickupDate || !fbk.return_date) continue;

          // Compute finalReturnDate: take the maximum of the booking's own
          // return_date and the latest paid extension return_date from
          // revenue_records.  This ensures a booking that has been genuinely
          // extended (and has a paid revenue_record) is not under-counted as a
          // blocking future booking.
          const bookingReturnDate = String(fbk.return_date).split("T")[0];
          const extReturnDate = extensionMaxReturnByRef[fbk.booking_ref] || null;
          const fbkReturnDate = (extReturnDate && extReturnDate > bookingReturnDate)
            ? extReturnDate
            : bookingReturnDate;

          // Safety guard: skip any booking whose effective end date is on or
          // before our current effective return date — such a booking cannot
          // block the extension window.  This is the final line of defence
          // against self-conflict in edge cases (e.g. same-day rentals) where
          // sbActiveBookingRef was not resolved and the active booking appears
          // in the query results.
          if (fbkReturnDate <= effectiveReturnDate) continue;

          // Supabase stores times as "HH:MM:SS"; take first 5 chars → "HH:MM".
          const fbkPickupTime = fbk.pickup_time ? String(fbk.pickup_time).substring(0, 5) : "";
          const fbkReturnTime = fbk.return_time ? String(fbk.return_time).substring(0, 5) : "";

          const hasConflict = hasDateTimeOverlap(
            extensionRange,
            fbkPickupDate,
            fbkReturnDate,
            fbkPickupTime,
            fbkReturnTime
          );
          if (hasConflict) {
            const fmtDate = new Date(fbkPickupDate + "T12:00:00Z")
              .toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric" });
            return res.status(409).json({
              error: `The new return date conflicts with another booking starting on ${fmtDate}. ` +
                     "Please choose an earlier return date.",
            });
          }
        }
      } catch (sbConflictErr) {
        console.warn("extend-rental: Supabase conflict check failed (non-fatal):", sbConflictErr.message);
      }
    }
    // ── Compute extension price ────────────────────────────────────────────
    const settings = await loadPricingSettings();
    const pricing = await getVehiclePricing(sb, vehicleId);

    let extensionAmount = 0;
    let extensionLabel;
    let lateFeeIncluded = 0;
    let extensionDays = 1;  // hoisted so partial-payment minimum check can use it below

    {
      // Extension days are counted from effectiveReturnDate (the authoritative
      // current return date, preferring Supabase over bookings.json) to
      // newReturnDate — never from today or pickup_date.
      const extraMs   = newReturnMs - currentReturnMs;
      extensionDays   = Math.max(1, Math.ceil(extraMs / (24 * 3600000)));
      const days      = extensionDays;
      extensionLabel  = `+${days} day${days !== 1 ? "s" : ""}`;

      const price = computeAmountFromPricing(pricing, days);

      // ── Time-based late fee ─────────────────────────────────────────────────
      // A late fee starts after the 30-minute grace window and accrues at
      // $25 for each overdue day. Always ONE PaymentIntent; the late fee is
      // folded into the total and remains non-taxed.
      //
      // IMPORTANT: Use buildDateTimeLA so that a stored return_time of "10:00"
      // is interpreted as 10:00 AM Los Angeles time (e.g. 17:00 UTC in PDT),
      // not 10:00 UTC. parseDateTimeMs treats the time as server-local (UTC
      // on Vercel), which shifts the grace window ~7–8 h too early and falsely
      // charges late fees to renters who extend before their return time.
      const currentReturnMsLA = buildDateTimeLA(effectiveReturnDate, resolvedReturnTime).getTime();
      const graceEndMs  = currentReturnMsLA + 30 * 60 * 1000;        // +30 min
      const resetTimeMs = currentReturnMsLA + 3  * 60 * 60 * 1000;   // +3 h
      const nowMs = Date.now();
      if (nowMs > resetTimeMs) {
        lateFeeIncluded = computeLateFeeAmount(effectiveReturnDate, resolvedReturnTime, nowMs);
      } else if (nowMs > graceEndMs) {
        lateFeeIncluded = computeLateFeeAmount(effectiveReturnDate, resolvedReturnTime, nowMs);
      }

      // ── Apply admin-granted waiver ──────────────────────────────────────────
      // If the admin applied a full or partial waiver before the extension,
      // subtract it from the late fee.  The late fee is always floored at 0;
      // the total is floored at base_price (one day's rental) so the renter
      // always pays at least the base extension cost.
      if (sbWaivedAmount > 0 && lateFeeIncluded > 0) {
        const waiver = Math.min(sbWaivedAmount, lateFeeIncluded);
        lateFeeIncluded = Math.max(0, lateFeeIncluded - waiver);
        console.log('[pricing-extension-waiver]', {
          vehicle:        vehicleId,
          waiver_applied: waiver,
          late_fee_after: lateFeeIncluded,
        });
      }

      // ── Collect deferred late fee ──────────────────────────────────────────
      // If the admin flagged a previously-assessed late fee as 'pending_collection'
      // (e.g. no card was on file at the time), collect it now by adding it to
      // this extension total.  The deferred fee is separate from the time-based
      // late fee above and is never waived by sbWaivedAmount (waiver only applies
      // to the new time-based fee).
      const deferredFeeIncluded = sbDeferredLateFee;
      if (deferredFeeIncluded > 0) {
        console.log('[pricing-extension-deferred-fee]', {
          vehicle:        vehicleId,
          deferred_fee:   deferredFeeIncluded,
        });
      }

      console.log('[pricing-extension]', {
        vehicle: vehicleId,
        days,
        pricing,
        price,
        late_fee:       lateFeeIncluded,
        deferred_fee:   deferredFeeIncluded,
        waived_amount:  sbWaivedAmount,
        grace_end_iso:  new Date(graceEndMs).toISOString(),
        reset_time_iso: new Date(resetTimeMs).toISOString(),
      });

      extensionAmount = applyTax(price, settings) + lateFeeIncluded + deferredFeeIncluded;
    }

    const originalExtensionTotal = Math.round(extensionAmount * 100) / 100;

    // ── Phase 1: Partial-payment minimum enforcement (CAR rentals only) ──────
    // For partial payments, the extension value is computed at the standard
    // daily rate (no discounted package pricing). The renter must cover at
    // least half the requested extension days upfront at that daily rate.
    let extensionTotal = originalExtensionTotal;
    if (requestedPaymentAmount !== null && requestedPaymentAmount < originalExtensionTotal) {
      const dailyRate = computeAmountFromPricing(pricing, 1);
      if (dailyRate !== null && dailyRate > 0) {
        // Recalculate extension total at standard daily rate for partial payments.
        const standardRentalCost = Math.round(dailyRate * extensionDays * 100) / 100;
        const standardRateTotal = Math.round(
          (applyTax(standardRentalCost, settings) + lateFeeIncluded + sbDeferredLateFee) * 100
        ) / 100;
        // Partial payments track remaining balance against the standard-rate total.
        extensionTotal = standardRateTotal;

        const minDays = Math.ceil(extensionDays / 2);
        const minimumUpfront = Math.round(minDays * dailyRate * 100) / 100;
        if (requestedPaymentAmount < minimumUpfront) {
          return res.status(400).json({
            error: `Partial extensions require payment covering at least half of the requested extension days. Minimum: $${minimumUpfront.toFixed(2)} (${minDays} day${minDays !== 1 ? "s" : ""} × $${dailyRate.toFixed(2)}/day).`,
            minimumPayment: minimumUpfront.toFixed(2),
            extensionDays: extensionDays,
            dailyRate: dailyRate.toFixed(2),
          });
        }
      }
    }

    const amountPaidNow = requestedPaymentAmount != null
      ? Math.round(requestedPaymentAmount * 100) / 100
      : extensionTotal;
    if (amountPaidNow > extensionTotal) {
      return res.status(400).json({ error: "Custom payment amount cannot exceed the extension balance." });
    }
    const extensionRemainingBalance = Math.round(Math.max(0, extensionTotal - amountPaidNow) * 100) / 100;
    const extensionPaymentStatus = extensionRemainingBalance > 0 ? "partially_paid" : "paid";

    // ── Phase 2: Extension risk gating ───────────────────────────────────────
    // When the renter is making a partial payment, enforce system-wide exposure
    // and count limits.  Full payments always bypass this gate.
    if (extensionRemainingBalance > 0) {
      const riskSettings = await loadExtensionRiskSettings();
      const risk = await evaluateExtensionRisk(
        sb,
        sbActiveBookingRef || activeBooking.bookingId || null,
        extensionRemainingBalance,
        riskSettings
      );
      if (!risk.allowed) {
        return res.status(400).json({
          error:          risk.reason,
          riskBlocked:    true,
          partialCount:   risk.partialCount,
          exposureAmount: risk.exposureAmount.toFixed(2),
        });
      }
    }

    // ── Create Stripe PaymentIntent ─────────────────────────────────────────
    const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);

    const normalizedExtensionReason = normalizeExtensionReason(extensionReason);
    const normalizedExtensionNotes = normalizeExtensionNotes(extensionNotes);
    const pi = await stripe.paymentIntents.create({
      amount:   Math.round(amountPaidNow * 100),
      currency: "usd",
      description: `Rental extension — ${vehicleData.name} — ${extensionLabel} — ${activeBooking.name || ""}`,
      automatic_payment_methods: { enabled: true },
      payment_method_options: {
        card: { request_three_d_secure: "automatic" },
      },
      receipt_email: activeBooking.email || undefined,
      metadata: {
        // "type" is the canonical field read by the webhook and booking_extensions pipeline.
        // "payment_type" is kept for backward compatibility with reconcile / scheduled-reminders.
        type:         "rental_extension",
        payment_type: "rental_extension",
        // Prefer the resolved Supabase booking_ref (sbActiveBookingRef) so the webhook
        // can always locate the booking via .eq("booking_ref", …).  Fall back to the
        // bookings.json bookingId only when it is a real booking_ref (not a legacy Stripe
        // PI ID).  A PI ID must never be used as booking_id because the extension webhook
        // queries bookings by booking_ref — using a PI ID would always fail to find the
        // booking and produce an unresolvable orphan record.
        booking_id:   sbActiveBookingRef ||
          (activeBooking.bookingId && !String(activeBooking.bookingId).startsWith("pi_")
            ? activeBooking.bookingId
            : null) ||
          "",
        vehicle_id:   vehicleId,
        vehicle_name:          vehicleData.name  || "",
        vehicle_vin:           vehicleData.vin   || "",
        renter_name:           activeBooking.name  || (typeof name === "string" ? name.trim() : "") || "",
        renter_email:          activeBooking.email || "",
        renter_phone:          activeBooking.phone || "",
        extension_label:       extensionLabel,
        new_return_date:       newReturnDate,
        new_return_time:       formatTime12h(resolvedReturnTime) || "",
        original_pickup_date:  activeBooking.pickupDate || "",
        original_pickup_time:  activeBooking.pickupTime || "",
        original_return_date:  effectiveReturnDate || "",
        // Return date in effect before this extension — used by the webhook to set
        // the correct pickup_date on the extension revenue record (extension start).
        previous_return_date:  effectiveReturnDate || "",
        // Late fee folded into total — never charged separately.
        late_fee_included:     String(lateFeeIncluded),
        // Amount of late fee waived by admin (0 when no waiver applied).
        late_fee_waived:       String(sbWaivedAmount),
         // Previously-assessed late fee that was deferred because no card was on
         // file; now collected as part of this extension.
         deferred_late_fee:     String(sbDeferredLateFee),
         extension_total_amount:     extensionTotal.toFixed(2),
         extension_amount_paid:      amountPaidNow.toFixed(2),
         extension_remaining_balance: extensionRemainingBalance.toFixed(2),
         extension_payment_status:    extensionPaymentStatus,
         extension_reason:            normalizedExtensionReason,
         extension_notes:             normalizedExtensionNotes,
      },
    });

    // ── Store extensionPendingPayment on the booking ────────────────────────
    // updateBooking() uses updateJsonFileWithRetry internally and handles SHA
    // conflicts gracefully.
    const bookingId = activeBooking.bookingId || activeBooking.paymentIntentId;
    if (bookingId) {
      try {
        const nowIso = new Date().toISOString();
        await updateBooking(vehicleId, bookingId, {
          ...(needsReturnTimePersist ? { returnTime: resolvedReturnTime } : {}),
           extensionPendingPayment: {
             label:               extensionLabel,
             price:               amountPaidNow,
             extensionTotal:      extensionTotal,
             amountPaid:          amountPaidNow,
             remainingBalance:    extensionRemainingBalance,
             paymentStatus:       extensionPaymentStatus,
             lateFeeIncluded,
             deferredLateFee:     sbDeferredLateFee,
             extensionReason:     normalizedExtensionReason || null,
             extensionNotes:      normalizedExtensionNotes || null,
             newReturnDate,
            newReturnTime:       resolvedReturnTime,
            paymentIntentId:     pi.id,
            status:              "pending",
            createdAt:           nowIso,
            updatedAt:           nowIso,
          },
          extensionPaymentPending: true,
          extensionPaymentStatus: "pending",
          extensionPaymentIntentId: pi.id,
          extensionPaymentCreatedAt: nowIso,
          extensionPaymentUpdatedAt: nowIso,
          extensionPaymentResolvedAt: null,
          extensionPaymentFailedAt: null,
          extensionRequestStatus: "pending_payment",
          extensionRequestUpdatedAt: nowIso,
        });

        // Dual-write pending extension state to Supabase so fleet-status and
        // reminder automation can keep the vehicle unavailable until payment
        // resolves or booking is manually returned.
        const bookingRefForPending = sbActiveBookingRef ||
          (activeBooking.bookingId && !String(activeBooking.bookingId).startsWith("pi_")
            ? activeBooking.bookingId
            : null);
        if (sb && bookingRefForPending) {
          const pendingPayload = {
            status:            "pending",
            paymentStatus:     extensionPaymentStatus,
            paymentIntentId:   pi.id,
            requestedReturnDate: newReturnDate,
            requestedReturnTime: resolvedReturnTime,
            amountCents:       Math.round(amountPaidNow * 100),
            extensionTotal:    extensionTotal,
            amountPaid:        amountPaidNow,
            remainingBalance:  extensionRemainingBalance,
            createdAt:         nowIso,
            updatedAt:         nowIso,
          };
          try {
            await sb
              .from("bookings")
              .update({
                extend_pending:            true,
                extension_pending_payment: pendingPayload,
                updated_at:                nowIso,
              })
              .eq("booking_ref", bookingRefForPending);
          } catch (sbPendingErr) {
            console.warn("extend-rental: could not persist pending extension state to Supabase (non-fatal):", sbPendingErr?.message || sbPendingErr);
          }
        }
      } catch (updateErr) {
        // Non-fatal: the webhook can fall back to PI metadata if the booking
        // record was not updated.
        console.warn("extend-rental: could not update extensionPendingPayment (non-fatal):", updateErr.message);
      }

      const resolvedBookingRefForLifecycle = sbActiveBookingRef ||
        (activeBooking.bookingId && !String(activeBooking.bookingId).startsWith("pi_")
          ? activeBooking.bookingId
          : null);
      if (sb && resolvedBookingRefForLifecycle) {
        await upsertExtensionLifecycleRecord({
          sb,
          bookingRef: resolvedBookingRefForLifecycle,
          paymentIntentId: pi.id,
          requestedReturnDate: newReturnDate,
          requestedReturnTime: resolvedReturnTime,
          extensionReason: normalizedExtensionReason,
          extensionNotes: normalizedExtensionNotes,
          paymentStatus: "pending",
          signatureStatus: "pending",
          signatureRequired: false,
          lifecycleStatus: "payment_pending",
        });
        await appendBookingTimelineEvent({
          sb,
          bookingRef: resolvedBookingRefForLifecycle,
          eventType: "extension_request_created",
          eventKey: `${resolvedBookingRefForLifecycle}:extension_request_created:${pi.id}`,
          actor: "renter",
          payload: {
            paymentIntentId: pi.id,
            requestedReturnDate: newReturnDate,
            requestedReturnTime: resolvedReturnTime,
            extensionReason: normalizedExtensionReason || null,
            extensionNotes: normalizedExtensionNotes || null,
            amountPaidNow,
            extensionTotal,
            extensionRemainingBalance,
            extensionPaymentStatus,
          },
        });
      }
    }

    return res.status(200).json({
      clientSecret:      pi.client_secret,
      publishableKey:    process.env.STRIPE_PUBLISHABLE_KEY,
      extensionAmount:   amountPaidNow.toFixed(2),
      extensionTotal:    extensionTotal.toFixed(2),
      amountPaidNow:     amountPaidNow.toFixed(2),
      remainingBalance:  extensionRemainingBalance.toFixed(2),
      extensionPaymentStatus,
      extensionLabel,
      lateFeeIncluded,
      deferredLateFee:   sbDeferredLateFee,
      lateFeeWaived:     sbWaivedAmount,
      newReturnDate,
      newReturnTime:     resolvedReturnTime,
      vehicleName:       vehicleData.name,
      renterName:        activeBooking.name || "",
      extensionFinancialTrace: (() => {
        // Structured financial trace for auditability and frontend logging.
        // Covers the standardized computation order:
        //   ledger → overdue → late fees → plan state → extension fee → eligibility.
        const baseFee = Math.round((originalExtensionTotal - lateFeeIncluded - sbDeferredLateFee) * 100) / 100;
        const trace = {
          booking_id:              sbActiveBookingRef || activeBooking.bookingId || "",
          overdue_amount:          isBookingOverdue ? ledgerBalance : 0,
          late_fee_amount:         lateFeeIncluded,
          deferred_late_fee:       sbDeferredLateFee,
          late_fee_waived:         sbWaivedAmount,
          extension_fee_amount:    Math.max(0, baseFee),
          payment_plan_state:      String(activeBooking.status || "active_rental"),
          ledger_balance:          ledgerBalance,
          computed_extension_total: extensionTotal,
          amount_paid_now:         amountPaidNow,
          remaining_balance_after: extensionRemainingBalance,
          render_source_used:      sb
            ? (ledgerBalance > 0 ? "supabase+ledger" : "supabase")
            : "bookings_json",
        };
        console.info("[extension-financial-trace]", trace);
        return trace;
      })(),
    });
  } catch (err) {
    console.error("extend-rental error:", err);
    return res.status(500).json({ error: "Failed to create extension payment. Please try again or call (844) 511-4059." });
  }
}
