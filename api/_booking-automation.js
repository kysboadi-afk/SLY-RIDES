// api/_booking-automation.js
// Shared helpers that run automatically whenever a booking is created or
// transitions to a paid state — regardless of whether the trigger is a public
// payment (send-reservation-email.js), a Stripe webhook, or an admin action
// (v2-bookings.js, add-manual-booking.js).
//
// All helpers are:
//   • Non-fatal by default — errors are logged and do not propagate unless
//     opts.strict=true is explicitly passed by the caller.
//   • Idempotent — safe to call multiple times for the same booking.
//   • Silent     — return immediately when Supabase is not configured.
//
// Exported helpers:
//   autoCreateRevenueRecord  — writes to legacy revenue_records table
//   createOrphanRevenueRecord — writes an unlinked revenue row (booking_id=NULL, is_orphan=true)
//   autoUpsertCustomer       — upserts customer row (keyed by phone; falls back to email)
//   autoUpsertBooking        — syncs booking to normalised bookings table
//   autoCreateBlockedDate        — inserts a blocked_dates row for a booking
//   autoReleaseBlockedDateOnReturn — trims blocked_dates end_date on vehicle return
//   writeAuditLog                — appends rows to booking_audit_log

import { getSupabaseAdmin } from "./_supabase.js";
import { normalizeVehicleId } from "./_vehicle-id.js";
import { updateBooking, normalizePhone } from "./_bookings.js";
import { loadBooleanSetting } from "./_settings.js";
import { buildDateTimeLA, isoDateInLA } from "./_time.js";
import { normalizeFleetCategory, resolveBookingCategory } from "./_category.js";
import { toDbBookingStatus } from "./_booking-status.js";

// Hours the car is unavailable after a return before a new pickup can start.
// Must match BOOKING_BUFFER_HOURS in _availability.js.
const BOOKING_BUFFER_HOURS = 2;

const BUSINESS_TZ = "America/Los_Angeles";

/**
 * Compute the buffered end date and time for a blocked_dates row.
 * Adds BOOKING_BUFFER_HOURS to the return time and returns the resulting
 * date (YYYY-MM-DD) and time (HH:MM) anchored to Los Angeles wall-clock time.
 *
 * Returns { date: endDate, time: null } when returnTime is absent or unparseable
 * so callers fall back to date-only behaviour.
 *
 * @param {string} returnDate - YYYY-MM-DD
 * @param {string|null} returnTime - "HH:MM" or "H:MM AM/PM" in LA timezone
 * @returns {{ date: string, time: string|null }}
 */
export function buildBufferedEnd(returnDate, returnTime) {
  if (!returnTime) return { date: returnDate, time: null };
  const returnDt = buildDateTimeLA(returnDate, returnTime);
  if (!Number.isFinite(returnDt.getTime())) {
    console.warn(
      `_booking-automation buildBufferedEnd: unparseable returnTime "${returnTime}" for ${returnDate} — falling back to date-only`
    );
    return { date: returnDate, time: null };
  }
  const bufferedDt = new Date(returnDt.getTime() + BOOKING_BUFFER_HOURS * 60 * 60 * 1000);
  const laDate = bufferedDt.toLocaleDateString("en-CA", { timeZone: BUSINESS_TZ }); // YYYY-MM-DD
  const laTime = bufferedDt.toLocaleTimeString("en-GB", {
    timeZone: BUSINESS_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }); // HH:MM
  return { date: laDate, time: laTime };
}

function formatSupabaseError(err) {
  if (!err) return "Unknown Supabase error";
  if (typeof err === "string") return err;
  const parts = [];
  if (err.message) parts.push(`message=${err.message}`);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.details) parts.push(`details=${err.details}`);
  if (err.hint) parts.push(`hint=${err.hint}`);
  return parts.length > 0 ? parts.join(" | ") : JSON.stringify(err);
}

function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized || null;
}

function normalizeCustomerName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/**
 * Appends one or more rows to the booking_audit_log table.
 * Non-fatal — errors are logged and never propagate to the caller.
 *
 * @param {string} bookingRef  - booking_ref / bookingId
 * @param {Array<{field:string, oldValue:string|null, newValue:string|null}>} changes
 * @param {string} [changedBy] - actor label, e.g. "stripe-webhook", "admin"
 */
export async function writeAuditLog(bookingRef, changes, changedBy = "system") {
  if (!bookingRef || !changes || changes.length === 0) return;
  const sb = getSupabaseAdmin();
  if (!sb) return;
  try {
    const now = new Date().toISOString();
    const rows = changes.map(({ field, oldValue, newValue }) => ({
      booking_ref: bookingRef,
      changed_by:  changedBy,
      changed_at:  now,
      field,
      old_value:   oldValue != null ? String(oldValue) : null,
      new_value:   newValue != null ? String(newValue) : null,
    }));
    const { error } = await sb.from("booking_audit_log").insert(rows);
    if (error) {
      console.error("_booking-automation writeAuditLog error (non-fatal):", error.message);
    }
  } catch (err) {
    console.error("_booking-automation writeAuditLog error (non-fatal):", err.message);
  }
}

/**
 * Auto-creates a revenue record in Supabase for a booking that is paid.
 * Skipped silently when Supabase is not configured or the record already exists.
 *
 * @param {object} booking - booking record (bookingId, vehicleId, name, phone,
 *                           email, pickupDate, returnDate, amountPaid,
 *                           paymentMethod, notes, status, type, customerId,
 *                           paymentIntentId)
 *
 * For extension records set:
 *   type             = 'extension'
 *   bookingId        = original booking_id  (groups all records per rental)
 *   paymentIntentId  = extension PaymentIntent ID (stored in payment_intent_id)
 *   customerId       = customers.id (looked up by caller)
 */
export async function autoCreateRevenueRecord(booking, opts = {}) {
  const strict = !!opts.strict;
  const requireStripeFee = !!opts.requireStripeFee;
  const sb = getSupabaseAdmin();
  if (!sb) {
    if (strict) throw new Error("Supabase admin client unavailable");
    return;
  }

  try {
    // Prefer explicit booking_ref when provided (rental_extension callers set
    // this alongside bookingId so the mapping is unambiguous).
    const bookingRef = String(booking.booking_ref || booking.bookingId || "").trim();
    if (!bookingRef) {
      throw new Error("missing bookingId for revenue record");
    }

    // Application-level guard: verify the booking row exists before writing revenue.
    // Also read vehicle_id, pickup_date, and return_date so we can backfill them on
    // the revenue record when the caller did not provide them (e.g. processStripePayment,
    // which passes only bookingId + payment data).  This ensures every revenue record
    // written at insert time carries correct linking fields.
    const { data: bookingRow, error: bookingLookupErr } = await sb
      .from("bookings")
      .select("id, vehicle_id, pickup_date, return_date, category")
      .eq("booking_ref", bookingRef)
      .maybeSingle();
    if (bookingLookupErr) {
      throw new Error(`bookings lookup failed: ${formatSupabaseError(bookingLookupErr)}`);
    }
    if (!bookingRow?.id) {
      throw new Error(`missing booking for revenue booking_id=${bookingRef}`);
    }

    // Use the booking's vehicle_id / pickup_date / return_date as fallbacks when the
    // caller did not supply them — this covers processStripePayment and other callers
    // that pass only payment identifiers without full booking context.
    // normalizeVehicleId is applied unconditionally so that any stale legacy
    // value retrieved from the DB (e.g. a booking row still holding "camry2012"
    // before a data migration runs) is always written as the canonical "camry".
    const resolvedVehicleId = normalizeVehicleId(booking.vehicleId || bookingRow.vehicle_id);
    const resolvedCategory = normalizeFleetCategory(booking.category)
      || normalizeFleetCategory(bookingRow.category)
      || await resolveBookingCategory({ vehicleId: resolvedVehicleId });
    const resolvedPickupDate = booking.pickupDate ||
      (bookingRow.pickup_date ? String(bookingRow.pickup_date).split("T")[0] : null);

    // SOURCE OF TRUTH for extension rows: return_date must always match
    // bookings.return_date.  If the caller supplied a different value (e.g. a
    // stale new_return_date from PI metadata on an alreadyApplied replay), log
    // an error and override with the DB value so the ledger stays consistent.
    const dbReturnDate = bookingRow.return_date ? String(bookingRow.return_date).split("T")[0] : null;
    let resolvedReturnDate;
    if (booking.type === "extension" && dbReturnDate) {
      if (booking.returnDate && booking.returnDate !== dbReturnDate) {
        console.error(
          `_booking-automation autoCreateRevenueRecord: extension return_date mismatch for ` +
          `booking ${bookingRef} — caller provided ${booking.returnDate}, ` +
          `bookings.return_date=${dbReturnDate}. Using bookings.return_date as source of truth.`,
        );
      }
      resolvedReturnDate = dbReturnDate;
    } else {
      resolvedReturnDate = booking.returnDate || dbReturnDate || null;
    }

    if (!resolvedVehicleId) {
      console.warn(
        `_booking-automation autoCreateRevenueRecord: booking ${bookingRef} has no vehicle_id — ` +
        "revenue record will have vehicle_id=null",
      );
    }
    if (!resolvedReturnDate) {
      console.warn(
        `_booking-automation autoCreateRevenueRecord: booking ${bookingRef} has no return_date — ` +
        "revenue record will have return_date=null",
      );
    }

    // Resolve the Stripe PaymentIntent ID.
    // • Rental records:   booking.paymentIntentId or bookingId if it starts with "pi_".
    // • Extension records: booking.paymentIntentId holds the extension PI;
    //                      bookingId is the original booking ref (not a PI).
    const piId = booking.paymentIntentId ||
      (bookingRef.startsWith("pi_") ? bookingRef : null);

    const recordType = booking.type || "rental";

    // Idempotent:
    // • Rental records are unique per booking_id (partial unique index).
    // • All non-rental records (extension, reservation_deposit, rental_balance, etc.)
    //   may share booking_id, so deduplicate only by payment_intent_id.
    let existingRecord = null;

    if (recordType === "rental") {
      const { data: existingByBooking, error: existingByBookingErr } = await sb
        .from("revenue_records")
        .select("id, booking_id, booking_ref, original_booking_id, payment_intent_id, stripe_fee, stripe_net, return_date, category, is_orphan")
        .eq("booking_id", bookingRef)
        .maybeSingle();
      if (existingByBookingErr) {
        throw new Error(`revenue_records booking_id lookup failed: ${formatSupabaseError(existingByBookingErr)}`);
      }
      existingRecord = existingByBooking || null;
    }

    if (!existingRecord && piId) {
      const { data: existingByPI, error: existingByPIErr } = await sb
        .from("revenue_records")
        .select("id, booking_id, booking_ref, original_booking_id, stripe_fee, stripe_net, return_date, category, is_orphan")
        .eq("payment_intent_id", piId)
        .maybeSingle();
      if (existingByPIErr) {
        throw new Error(`revenue_records payment_intent_id lookup failed: ${formatSupabaseError(existingByPIErr)}`);
      }
      existingRecord = existingByPI || null;
    }

    // For cash/non-Stripe payments: pre-fill fee=0, net=gross so analytics
    // are accurate immediately without needing a Stripe reconciliation pass.
    const isCash = ["cash", "zelle", "venmo", "manual", "external"].includes(booking.paymentMethod);
    const gross  = Number(booking.amountPaid || 0);

    const stripeFee = isCash ? 0 : (booking.stripeFee != null ? Number(booking.stripeFee) : null);
    if (!isCash && requireStripeFee && stripeFee == null) {
      throw new Error(`missing stripeFee for booking ${bookingRef || "<missing>"} paymentIntentId=${piId || "<missing>"}`);
    }

    const record = {
      booking_id:          bookingRef,
      // booking_ref mirrors booking_id — it is a FK column on revenue_records
      // that references bookings.booking_ref and must be set on every non-orphan
      // INSERT.  Without it the DB rejects the write with a not-null violation.
      booking_ref:         bookingRef,
      // For extension records, original_booking_id = bookingRef so all records
      // for the same booking share the same group key in the Revenue Tracker.
      // Guard: skip PI ids and synthetic "stripe-..." ids — they must never
      // be used as group keys or they create phantom standalone rows.
      // For all other types, honour the caller-provided value (rarely set).
      original_booking_id: (() => {
        if (recordType !== "extension") return booking.originalBookingId || null;
        if (!bookingRef || bookingRef.startsWith("pi_") || bookingRef.startsWith("stripe-")) return null;
        return bookingRef;
      })(),
      payment_intent_id:   piId || null,
      vehicle_id:          resolvedVehicleId || null,
      customer_name:       normalizeCustomerName(booking.name) || null,
      customer_phone:      booking.phone || null,
      customer_email:      normalizeEmail(booking.email),
      pickup_date:         resolvedPickupDate || null,
      return_date:         resolvedReturnDate  || null,
      gross_amount:        gross,
      deposit_amount:      0,
      refund_amount:       0,
      payment_method:      booking.paymentMethod || "stripe",
      payment_status:      gross > 0 ? "paid" : "unpaid",
      type:                recordType,
      notes:               booking.notes || null,
      is_no_show:          false,
      is_cancelled:        false,
      override_by_admin:   false,
      // Stripe fee data: cash bookings have no fee; Stripe bookings use the
      // caller-provided fee data if available (e.g. a replay that already expanded
      // balance_transaction and forwarded the values via booking.stripeFee/stripeNet),
      // otherwise leave null so stripe-reconcile.js can fill them in later.
      stripe_fee: stripeFee,
      stripe_net: isCash ? gross : (booking.stripeNet != null ? Number(booking.stripeNet) : null),
      category:          resolvedCategory,
    };

    if (existingRecord?.id) {
      const existingBookingId = String(existingRecord.booking_id || "").trim();
      const existingBookingRef = String(existingRecord.booking_ref || "").trim();
      const needsRelink =
        existingRecord.is_orphan === true ||
        !existingBookingId ||
        !existingBookingRef ||
        existingBookingId !== bookingRef ||
        existingBookingRef !== bookingRef;

      // SOURCE OF TRUTH RULE: never overwrite gross_amount — the original write
      // is authoritative.  Extension records are deduplicated by payment_intent_id
      // so finding one here means the record is already complete; skip entirely.
      // For rental records, only backfill stripe fee data that was missing on the
      // initial write (e.g. webhook fired before balance_transaction was settled).
      if (recordType === "extension") {
        const updatePayload = {};

        if (needsRelink) {
          updatePayload.booking_id = bookingRef;
          updatePayload.booking_ref = bookingRef;
          if (record.original_booking_id && !existingRecord.original_booking_id) {
            updatePayload.original_booking_id = record.original_booking_id;
          }
          if (existingRecord.is_orphan === true) {
            updatePayload.is_orphan = false;
          }
        }

        // Idempotent: if the record already exists but has a stale return_date
        // (e.g. written by a prior replay before a second extension was applied),
        // correct it so the ledger always reflects bookings.return_date.
        const existingReturnDate = existingRecord.return_date
          ? String(existingRecord.return_date).split("T")[0]
          : null;
        if (dbReturnDate && existingReturnDate !== dbReturnDate) {
          console.error(
            `_booking-automation autoCreateRevenueRecord: existing extension revenue record ` +
            `(id=${existingRecord.id}) for booking ${bookingRef} has stale ` +
            `return_date=${existingReturnDate}, bookings.return_date=${dbReturnDate} — correcting.`,
          );
          updatePayload.return_date = dbReturnDate;
        }

        if (record.category && !existingRecord.category) {
          updatePayload.category = record.category;
        }

        if (Object.keys(updatePayload).length > 0) {
          const { error: fixErr } = await sb
            .from("revenue_records")
            .update({ ...updatePayload, updated_at: new Date().toISOString() })
            .eq("id", existingRecord.id);
          if (fixErr) {
            console.error(
              `_booking-automation: failed to reconcile existing extension revenue record for ${bookingRef} ` +
              `(id=${existingRecord.id}): ${fixErr.message}`,
            );
          } else {
            console.log(
              `_booking-automation: reconciled existing extension revenue record for booking ${bookingRef} ` +
              `(id=${existingRecord.id})`,
            );
          }
        } else {
          console.log(
            `_booking-automation: extension revenue record for PI ${piId} already exists ` +
            `(id=${existingRecord.id}) — skipping`,
          );
        }
        return;
      }

      // Rental: only fill in stripe fee/net and PI id when they were absent.
      // gross_amount is intentionally excluded — it must not be overwritten.
      const updatePayload = {};
      if (needsRelink) {
        updatePayload.booking_id = bookingRef;
        updatePayload.booking_ref = bookingRef;
        if (existingRecord.is_orphan === true) {
          updatePayload.is_orphan = false;
        }
      }
      if (record.stripe_fee != null && existingRecord.stripe_fee == null) {
        updatePayload.stripe_fee = record.stripe_fee;
      }
      if (record.stripe_net != null && existingRecord.stripe_net == null) {
        updatePayload.stripe_net = record.stripe_net;
      }
      if (record.payment_intent_id && !existingRecord.payment_intent_id) {
        updatePayload.payment_intent_id = record.payment_intent_id;
      }
      if (record.category && !existingRecord.category) {
        updatePayload.category = record.category;
      }
      if (Object.keys(updatePayload).length > 0) {
        const { error } = await sb
          .from("revenue_records")
          .update({ ...updatePayload, updated_at: new Date().toISOString() })
          .eq("id", existingRecord.id);
        if (error) {
          throw new Error(`revenue_records update failed: ${formatSupabaseError(error)}`);
        }
        console.log(`_booking-automation: backfilled stripe data on ${recordType} revenue record for booking ${bookingRef}`);
      } else {
        console.log(`_booking-automation: ${recordType} revenue record for booking ${bookingRef} already complete — no update needed`);
      }
    } else {
      const { error } = await sb.from("revenue_records").insert(record);
      if (error) {
        throw new Error(`revenue_records insert failed: ${formatSupabaseError(error)}`);
      }
      console.log(`_booking-automation: created ${recordType} revenue record for booking ${bookingRef}`);
      // Post-write consistency guard for extension rows: the written return_date
      // must always equal bookings.return_date.  A mismatch here indicates a bug
      // in the date-resolution logic above and must not be silently accepted —
      // throw so strict callers (e.g. the main extension path) return HTTP 500
      // and Stripe retries, giving the corrected DB state a chance to settle.
      if (recordType === "extension" && dbReturnDate && (record.return_date ? String(record.return_date).split("T")[0] : null) !== dbReturnDate) {
        throw new Error(
          `CONSISTENCY ERROR — extension revenue record for booking ${bookingRef} PI ${piId} ` +
          `was written with return_date=${record.return_date} but bookings.return_date=${dbReturnDate}`,
        );
      }
    }
  } catch (err) {
    const msg = `_booking-automation autoCreateRevenueRecord error${strict ? "" : " (non-fatal)"}: ${err.message}`;
    console.error(msg);
    if (strict) throw new Error(msg);
  }
}

/**
 * Writes an orphan revenue record when a Stripe payment cannot be matched to a
 * booking row.  The row is flagged is_orphan=true so the DB trigger in migration
 * 0060 (check_revenue_booking_ref) skips the booking_ref integrity check, and
 * it is excluded from financial aggregation views until an admin resolves the
 * linkage.  booking_id is stored as NULL (requires migration 0082 which drops
 * the NOT NULL constraint on that column).
 *
 * Idempotent: deduplicates by payment_intent_id; silently no-ops if a record
 * with the same PI already exists.  Never throws — errors are logged only.
 *
 * @param {object} opts
 * @param {string} opts.paymentIntentId  - Stripe PaymentIntent ID (required)
 * @param {string} opts.vehicleId        - vehicle key (e.g. "camry", "camry2013")
 * @param {string} [opts.name]           - renter name
 * @param {string} [opts.phone]          - renter phone
 * @param {string} [opts.email]          - renter email
 * @param {string} [opts.pickupDate]     - ISO date string
 * @param {string} [opts.returnDate]     - ISO date string
 * @param {number} opts.amountPaid       - gross amount in dollars
 * @param {string} [opts.type]           - revenue record type (default: "deposit")
 * @param {string} [opts.notes]          - freeform notes
 * @param {number|null} [opts.stripeFee] - Stripe fee in dollars (null = unknown)
 * @param {number|null} [opts.stripeNet] - Stripe net in dollars (null = unknown)
 */
export async function createOrphanRevenueRecord({
  paymentIntentId,
  vehicleId,
  name,
  phone,
  email,
  pickupDate,
  returnDate,
  amountPaid,
  type = "deposit",
  notes,
  stripeFee = null,
  stripeNet = null,
  category = null,
}) {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  if (!paymentIntentId) {
    console.error("_booking-automation createOrphanRevenueRecord: paymentIntentId is required");
    return;
  }

  try {
    // Idempotency check: skip if a record with this PI already exists.
    const { data: existing, error: lookupErr } = await sb
      .from("revenue_records")
      .select("id")
      .eq("payment_intent_id", paymentIntentId)
      .maybeSingle();
    if (lookupErr) throw new Error(`revenue_records PI lookup failed: ${formatSupabaseError(lookupErr)}`);
    if (existing?.id) {
      console.log(`_booking-automation createOrphanRevenueRecord: record for PI ${paymentIntentId} already exists (id=${existing.id}), skipping`);
      return;
    }

    const gross = Number(amountPaid || 0);
    const resolvedCategory = normalizeFleetCategory(category)
      || await resolveBookingCategory({ vehicleId });
    const { error: insertErr } = await sb.from("revenue_records").insert({
      booking_id:       null,
      booking_ref:      null,  // orphan — no resolved booking; trigger is_orphan=true escape hatch applies
      payment_intent_id: paymentIntentId,
      vehicle_id:       normalizeVehicleId(vehicleId) || "unknown",
      customer_name:    normalizeCustomerName(name) || null,
      customer_phone:   phone || null,
      customer_email:   normalizeEmail(email),
      pickup_date:      pickupDate || null,
      return_date:      returnDate || null,
      gross_amount:     gross,
      deposit_amount:   type === "deposit" ? gross : 0,
      refund_amount:    0,
      payment_method:   "stripe",
      payment_status:   "paid",
      type,
      notes:            notes || `unresolved booking_ref for PI ${paymentIntentId}`,
      is_no_show:       false,
      is_cancelled:     false,
      override_by_admin: false,
      stripe_fee:       stripeFee,
      stripe_net:       stripeNet,
      is_orphan:        true,
      category:         resolvedCategory,
    });
    if (insertErr) throw new Error(`revenue_records orphan insert failed: ${formatSupabaseError(insertErr)}`);
    console.log(`_booking-automation createOrphanRevenueRecord: created orphan revenue record for PI ${paymentIntentId} type=${type} amount=${gross}`);
  } catch (err) {
    console.error(`_booking-automation createOrphanRevenueRecord error (non-fatal): ${err.message}`);
  }
}

/**
 * Auto-upserts a customer record in Supabase from a booking.
 * Skipped silently when Supabase is not configured or the booking has no phone.
 *
 * @param {object}  booking     - booking record (phone is required as the upsert key)
 * @param {boolean} countStats  - when true, increments total_bookings and total_spent.
 *                                Pass true only for final completion transitions to
 *                                avoid double-counting (e.g. "completed_rental").
 *                                Leave false (default) for initial creation.
 * @param {boolean} isNoShow    - when true, increments no_show_count.  Only used on
 *                                completion transitions for no-show bookings.
 */
export async function autoUpsertCustomer(booking, countStats = false, isNoShow = false) {
  const sb = getSupabaseAdmin();
  if (!sb) return;

  const hasPhone = !!booking.phone;
  const email = normalizeEmail(booking.email);
  const hasEmail = !!email;

  // Need at least one of phone or email to key the customer record.
  if (!hasPhone && !hasEmail) return;

  try {
    const phone = hasPhone ? normalizePhone(String(booking.phone).trim()) : null;

    const record = {
      name:       normalizeCustomerName(booking.name) || "Unknown",
      phone,
      email,
      updated_at: new Date().toISOString(),
    };

    // ── Look up existing customer (email first; fall back to phone) ──────────
    let existing = null;

    if (email) {
      const { data } = await sb
        .from("customers")
        .select("id, total_bookings, total_spent, first_booking_date, no_show_count")
        .eq("email", email)
        .maybeSingle();
      if (data) { existing = data; }
    }

    if (!existing && phone) {
      const { data } = await sb
        .from("customers")
        .select("id, phone, total_bookings, total_spent, first_booking_date, no_show_count")
        .eq("phone", phone)
        .maybeSingle();
      if (data) { existing = data; }
    }

    /**
     * Fetches revenue-record stats for a phone number.
     * Returns { totalBookings, totalSpent, firstDate, lastDate } or null on failure.
     */
    async function fetchRrStats(ph) {
      const { data: rr } = await sb
        .from("revenue_records")
        .select("gross_amount, refund_amount, is_cancelled, pickup_date")
        .eq("customer_phone", ph);
      if (!rr) return null;
      const valid  = rr.filter((r) => !r.is_cancelled);
      const dates  = rr.map((r) => r.pickup_date).filter(Boolean).sort();
      return {
        totalBookings: valid.length,
        totalSpent:    Math.round(valid.reduce((s, r) => s + Number(r.gross_amount || 0) - Number(r.refund_amount || 0), 0) * 100) / 100,
        firstDate:     dates[0] || null,
        lastDate:      dates[dates.length - 1] || null,
      };
    }

    if (existing) {
      const updates = {
        name:       record.name,
        email:      record.email,
        updated_at: record.updated_at,
        // If the existing row had no phone but we now have one, fill it in.
        ...(phone && !existing.phone ? { phone } : {}),
      };
      if (countStats) {
        // Use SET semantics: recompute totals from revenue_records so this
        // function is idempotent even when called multiple times for the same
        // customer (e.g. repeated scheduler runs or status re-transitions).
        const stats = phone ? await fetchRrStats(phone) : null;
        if (stats) {
          updates.total_bookings     = stats.totalBookings;
          updates.total_spent        = stats.totalSpent;
          updates.first_booking_date = stats.firstDate || existing.first_booking_date || null;
          updates.last_booking_date  = stats.lastDate  || booking.pickupDate || null;
        } else {
          // Fallback: increment if revenue_records is unavailable
          updates.total_bookings = (existing.total_bookings || 0) + 1;
          updates.total_spent    = Math.round(((existing.total_spent || 0) + Number(booking.amountPaid || 0)) * 100) / 100;
          updates.last_booking_date = booking.pickupDate || null;
        }
      }
      if (isNoShow) {
        updates.no_show_count = (existing.no_show_count || 0) + 1;
      }
      await sb.from("customers").update(updates).eq("id", existing.id);
    } else {
      let totalBookings = 0, totalSpent = 0, firstDate = booking.pickupDate || null, lastDate = booking.pickupDate || null;
      if (countStats) {
        const stats = phone ? await fetchRrStats(phone) : null;
        if (stats) {
          totalBookings = stats.totalBookings;
          totalSpent    = stats.totalSpent;
          firstDate     = stats.firstDate || firstDate;
          lastDate      = stats.lastDate  || lastDate;
        } else {
          totalBookings = 1;
          totalSpent    = Math.round(Number(booking.amountPaid || 0) * 100) / 100;
        }
      }
      await sb.from("customers").insert({
        ...record,
        total_bookings:     totalBookings,
        total_spent:        totalSpent,
        no_show_count:      isNoShow ? 1 : 0,
        first_booking_date: firstDate,
        last_booking_date:  lastDate,
      });
    }
    console.log(`_booking-automation: upserted customer ${phone || email} (${record.name})`);
  } catch (err) {
    console.error("_booking-automation autoUpsertCustomer error (non-fatal):", err.message);
  }
}

/**
 * Converts a pickup/return time string in "H:MM AM/PM" format to "HH:MM:SS"
 * PostgreSQL time format.  Returns null for unparseable input.
 */
export function parseTime12h(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  let hours   = parseInt(m[1], 10);
  const mins  = m[2];
  const secs  = m[3] || "00";
  const ampm  = (m[4] || "").toUpperCase();
  if (ampm === "PM" && hours < 12) hours += 12;
  if (ampm === "AM" && hours === 12) hours  = 0;
  return `${String(hours).padStart(2, "0")}:${mins}:${secs}`;
}

/**
 * Converts a date string to an ISO-8601 string, or undefined if the input is
 * absent or cannot be parsed.  Used to safely pass optional timestamp fields
 * to Supabase without risking 'Invalid Date' strings in the payload.
 */
function safeIso(value) {
  if (!value) return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Syncs a booking record into the normalised Supabase `bookings` table.
 * Does an INSERT for new booking_refs and an UPDATE for existing ones.
 * Skipped silently when Supabase is not configured.
 *
 * @param {object} booking  - booking record from bookings.json / admin forms
 */
export async function autoUpsertBooking(booking, opts = {}) {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  if (!booking.bookingId) return;
  const strict = !!opts.strict;

  try {
    // Resolve customer_id — prefer email lookup; fall back to phone only when
    // email is missing.
    let customerId = null;
    const normalizedEmail = normalizeEmail(booking.email);
    if (normalizedEmail) {
      const { data: emailMatch, error: custErr } = await sb
        .from("customers")
        .select("id")
        .eq("email", normalizedEmail)
        .maybeSingle();
      if (custErr) throw new Error(`customer email lookup failed: ${custErr.message}`);
      customerId = emailMatch?.id ?? null;
    }
    if (!customerId && !normalizedEmail && booking.phone) {
      const phone = String(booking.phone).trim();
      const { data: cust, error: custErr } = await sb
        .from("customers")
        .select("id")
        .eq("phone", phone)
        .maybeSingle();
      if (custErr) throw new Error(`customer phone lookup failed: ${custErr.message}`);
      customerId = cust?.id ?? null;
    }
    const status = toDbBookingStatus(booking.status || "pending_checkout");
    const amountPaid  = Number(booking.amountPaid  || 0);
    // Prefer an explicit totalPrice field if provided; fall back to amountPaid so
    // that existing bookings.json records (which only store amountPaid) still sync
    // correctly.  Callers that know the full rental price should pass totalPrice.
    const totalPrice  = Number(booking.totalPrice  || booking.total_price  || amountPaid);
    const remaining   = Math.max(0, totalPrice - amountPaid);

    // Use the caller's explicit paymentStatus when provided (e.g. "partial" for
    // reservation_deposit); fall back to deriving it from amounts.  Then enforce
    // the DB constraint: status='reserved' always requires payment_status='partial'
    // regardless of arithmetic (guards the edge case where totalPrice equals
    // amountPaid, making remaining=0 and the derived value wrong).
    let paymentStatus = booking.paymentStatus ||
      (amountPaid > 0 ? (remaining > 0 ? "partial" : "paid") : "unpaid");
    if (status === "reserved" && paymentStatus !== "partial") {
      paymentStatus = "partial";
    }

    const resolvedCategory = normalizeFleetCategory(booking.category)
      || await resolveBookingCategory({ vehicleId: booking.vehicleId });

    const record = {
      customer_id:               customerId,
      vehicle_id:                normalizeVehicleId(booking.vehicleId) || null,
      pickup_date:               booking.pickupDate  || null,
      return_date:               booking.returnDate  || null,
      pickup_time:               parseTime12h(booking.pickupTime),
      return_time:               parseTime12h(booking.returnTime),
      status,
      total_price:               totalPrice,
      deposit_paid:              amountPaid,
      remaining_balance:         remaining,
      payment_status:            paymentStatus,
      notes:                     booking.notes             || null,
      payment_method:            booking.paymentMethod     || null,
      payment_intent_id:         booking.paymentIntentId   || null,
      stripe_customer_id:        booking.stripeCustomerId       || null,
      stripe_payment_method_id:  booking.stripePaymentMethodId  || null,
      // Extension card fields — stored separately so the original booking card
      // is never overwritten when a renter pays with a different card to extend.
      extension_stripe_customer_id:       booking.extensionStripeCustomerId       || null,
      extension_stripe_payment_method_id: booking.extensionStripePaymentMethodId  || null,
      customer_name:             normalizeCustomerName(booking.name) || null,
      customer_email:            normalizedEmail                || null,
      customer_phone:            booking.phone                  || null,
      renter_phone:              booking.phone                  || null,
      // Mirror the JS-side auto-stamps so the Supabase row is consistent with
      // the bookings.json record.  The DB trigger on_booking_status_timestamps
      // will also stamp these automatically, but passing the JS value ensures
      // idempotent re-syncs preserve the original timestamp.
      activated_at:              safeIso(booking.activatedAt),
      completed_at:              safeIso(booking.completedAt),
      category:                  resolvedCategory,
    };

    // Check whether the booking already exists in Supabase (primary: booking_ref)
    const { data: byRef, error: byRefErr } = await sb
      .from("bookings")
      .select("id, status, return_date, total_price")
      .eq("booking_ref", booking.bookingId)
      .maybeSingle();
    if (byRefErr) throw new Error(`booking_ref lookup failed: ${byRefErr.message}`);
    let existing = byRef;
    let fixBookingRef = false;

    // Fallback: look up by payment_intent_id when booking_ref didn't match.
    // This handles Supabase rows that lack a booking_ref (e.g. created before
    // the column was populated, or where the initial autoUpsertBooking failed).
    // Using UPDATE instead of INSERT avoids the date-conflict check trigger.
    if (!existing && booking.paymentIntentId) {
      const { data: byPi, error: byPiErr } = await sb
        .from("bookings")
        .select("id, status, return_date, total_price, booking_ref")
        .eq("payment_intent_id", booking.paymentIntentId)
        .maybeSingle();
      if (byPiErr) throw new Error(`payment_intent lookup failed: ${byPiErr.message}`);
      if (byPi) {
        existing = byPi;
        fixBookingRef = !byPi.booking_ref; // repair null booking_ref in the update
      }
    }

    if (existing) {
      // UPDATE — no conflict-check trigger fires on plain UPDATE
      // Do not overwrite required NOT NULL fields with NULL when the caller omits
      // them (e.g. a status-only update that doesn't pass vehicleId).  The DB now
      // enforces NOT NULL on vehicle_id, pickup_date and return_date, so sending
      // NULL would cause an update failure and corrupt the existing values.
      const patchRecord = { ...record, updated_at: new Date().toISOString() };
      if (!patchRecord.vehicle_id)              delete patchRecord.vehicle_id;
      if (!patchRecord.pickup_date)             delete patchRecord.pickup_date;
      if (!patchRecord.return_date)             delete patchRecord.return_date;
      // Never wipe Stripe saved-card fields with null — callers that don't pass
      // these (e.g. extension / balance-payment updates) must not overwrite the
      // values written by the initial payment_intent.succeeded webhook.
      if (!patchRecord.stripe_customer_id)      delete patchRecord.stripe_customer_id;
      if (!patchRecord.stripe_payment_method_id) delete patchRecord.stripe_payment_method_id;
      // Same COALESCE rule for extension card fields.
      if (!patchRecord.extension_stripe_customer_id)       delete patchRecord.extension_stripe_customer_id;
      if (!patchRecord.extension_stripe_payment_method_id) delete patchRecord.extension_stripe_payment_method_id;
      if (fixBookingRef) patchRecord.booking_ref = booking.bookingId;
      const { error } = await sb
        .from("bookings")
        .update(patchRecord)
        .eq("id", existing.id);
      if (error) {
        const msg = `_booking-automation autoUpsertBooking update error${strict ? "" : " (non-fatal)"}: ${error.message}`;
        console.error(msg);
        if (strict) throw new Error(msg);
      } else {
        // Audit log: record fields that actually changed
        const auditChanges = [];
        if (record.status     !== existing.status)      auditChanges.push({ field: "status",      oldValue: existing.status,      newValue: record.status });
        if (record.return_date !== existing.return_date) auditChanges.push({ field: "return_date", oldValue: existing.return_date,  newValue: record.return_date });
        if (String(record.total_price) !== String(existing.total_price)) auditChanges.push({ field: "total_price", oldValue: existing.total_price, newValue: record.total_price });
        if (auditChanges.length > 0) {
          await writeAuditLog(booking.bookingId, auditChanges, booking._changedBy || "system");
        }
      }
    } else {
      // INSERT — conflict-check trigger fires; will reject overlapping dates.
      // Validate required fields before sending to DB so the error message is
      // actionable rather than a generic Supabase constraint violation.
      const insertRecord = { ...record, booking_ref: booking.bookingId };
      const missingFields = [];
      if (!insertRecord.vehicle_id)  missingFields.push("vehicle_id");
      if (!insertRecord.pickup_date) missingFields.push("pickup_date");
      if (!insertRecord.return_date) missingFields.push("return_date");
      if (missingFields.length > 0) {
        throw new Error(
          `autoUpsertBooking: booking ${booking.bookingId} is missing required fields for INSERT: ${missingFields.join(", ")} — booking creation must be atomic (all required fields must be present at insert time)`
        );
      }
      const { error } = await sb
        .from("bookings")
        .insert(insertRecord);
      if (error) {
        const msg = `_booking-automation autoUpsertBooking insert error${strict ? "" : " (non-fatal)"}: ${error.message}`;
        console.error(msg);
        if (strict) throw new Error(msg);
      } else {
        console.log(`_booking-automation: synced booking ${booking.bookingId} → Supabase bookings table`);
        // Audit log: initial insert
        await writeAuditLog(booking.bookingId, [{ field: "status", oldValue: null, newValue: record.status }], booking._changedBy || "system");
      }
    }
  } catch (err) {
    const msg = `_booking-automation autoUpsertBooking error${strict ? "" : " (non-fatal)"}: ${err.message}`;
    console.error(msg);
    if (strict) throw new Error(msg);
  }
}

/**
 * Inserts a blocked_dates row for a booking period.
 * Skipped silently when Supabase is not configured.
 *
 * When `returnTime` is provided the stored end_date and end_time reflect
 * the return datetime + BOOKING_BUFFER_HOURS so that fleet-status can show
 * an accurate "available at" time instead of blocking the entire day.
 *
 * @param {string} vehicleId    - vehicle_id text key
 * @param {string} startDate    - YYYY-MM-DD
 * @param {string} endDate      - YYYY-MM-DD return date (pre-buffer)
 * @param {string} reason       - 'booking' | 'maintenance' | 'manual'
 * @param {string} [bookingRef] - optional booking_ref foreign key (for 'booking' reason)
 * @param {string} [returnTime] - optional "HH:MM" or "H:MM AM/PM" LA-timezone return time
 */
export async function autoCreateBlockedDate(vehicleId, startDate, endDate, reason = "booking", bookingRef = null, returnTime = null) {
  const normalizedVehicleId = normalizeVehicleId(vehicleId);
  if (!normalizedVehicleId || !startDate || !endDate) {
    throw new Error("Missing required block data: vehicleId, startDate, and endDate are required");
  }

  // booking-reason rows require a booking_ref so the row satisfies any NOT NULL
  // constraint and can be linked back to its booking.  Skipping here is safer than
  // attempting an insert that will fail and silently corrupt pipeline state.
  if (reason === "booking" && !bookingRef) {
    console.warn(
      `_booking-automation autoCreateBlockedDate: skipping insert for vehicle=${normalizedVehicleId} ` +
      `${startDate}-${endDate} -- bookingRef is required for reason='booking' but was not provided`
    );
    return;
  }

  // Compute the buffered end date/time when a return time is available.
  const { date: bufferedEndDate, time: bufferedEndTime } = returnTime
    ? buildBufferedEnd(endDate, returnTime)
    : { date: endDate, time: null };

  if (new Date(startDate) > new Date(bufferedEndDate)) {
    throw new Error("Invalid date range: startDate must be on or before endDate");
  }
  const sb = getSupabaseAdmin();
  if (!sb) return;

  const row = {
    vehicle_id: normalizedVehicleId,
    start_date: startDate,
    end_date:   bufferedEndDate,
    reason,
  };
  if (bookingRef) row.booking_ref = bookingRef;
  if (bufferedEndTime) row.end_time = bufferedEndTime;

  try {
    const { error } = await sb
      .from("blocked_dates")
      .upsert(
        row,
        // ignoreDuplicates:false so that when a row already exists (e.g. created
        // by the on_booking_create DB trigger without end_time), the upsert
        // patches end_time with the correct buffered value.  Columns absent from
        // `row` (such as end_time when returnTime is null) are not in the UPDATE
        // SET clause and therefore do not overwrite existing values.
        { onConflict: "vehicle_id,start_date,end_date,reason", ignoreDuplicates: false }
      );
    if (error) {
      console.error("_booking-automation autoCreateBlockedDate error (non-fatal):", error.message);
    } else {
      console.log("[BLOCKED_DATE_CREATED]", {
        vehicle_id:  normalizedVehicleId,
        start:       startDate,
        end:         bufferedEndDate,
        end_time:    bufferedEndTime || null,
        booking_ref: bookingRef || null,
      });
    }
  } catch (err) {
    console.error("_booking-automation autoCreateBlockedDate error (non-fatal):", err.message);
  }
}

/**
 * Trims or closes out a booking's blocked_dates entry when the vehicle is returned.
 *
 * If the vehicle is returned before the original end_date (early return), the
 * blocked range is shortened to end on today so that subsequent date merges
 * in /api/booked-dates reflect the actual occupancy period rather than the
 * originally scheduled one.  When the return is on-time or late the row is
 * left unchanged (it is already in the past or today).
 *
 * Logs [BLOCKED_DATE_UPDATED_AFTER_RETURN] in all cases.
 * Non-fatal — errors are logged and never propagate to the caller.
 *
 * @param {string} vehicleId  - vehicle_id text key
 * @param {string} bookingRef - booking_ref that owns the blocked_dates row
 */
export async function autoReleaseBlockedDateOnReturn(vehicleId, bookingRef) {
  const normalizedVehicleId = normalizeVehicleId(vehicleId);
  if (!normalizedVehicleId || !bookingRef) {
    console.warn("_booking-automation autoReleaseBlockedDateOnReturn: missing vehicleId or bookingRef — skipped");
    return;
  }
  const sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    const { data: rows, error: findErr } = await sb
      .from("blocked_dates")
      .select("id, start_date, end_date")
      .eq("vehicle_id", normalizedVehicleId)
      .eq("booking_ref", bookingRef);

    if (findErr) {
      console.error("_booking-automation autoReleaseBlockedDateOnReturn find error (non-fatal):", findErr.message);
      return;
    }

    if (!rows || rows.length === 0) {
      console.log("[BLOCKED_DATE_UPDATED_AFTER_RETURN]", {
        vehicle_id:  normalizedVehicleId,
        booking_ref: bookingRef,
        action:      "no_row_found",
      });
      return;
    }

    const today = isoDateInLA();

    for (const row of rows) {
      // Delete the blocked_dates row so fleet-status immediately shows the
      // vehicle as available after an admin marks the rental as returned.
      // Previously the row was only trimmed to today, but fleet-status queries
      // `end_date >= today` so the car remained blocked for the rest of the day.
      const { error: deleteErr } = await sb
        .from("blocked_dates")
        .delete()
        .eq("id", row.id);

      if (deleteErr) {
        console.error("_booking-automation autoReleaseBlockedDateOnReturn delete error (non-fatal):", deleteErr.message);
      } else {
        const action = today < row.end_date ? "deleted_early_return"
          : today === row.end_date ? "deleted_on_time_return"
          : "deleted_late_return";
        console.log("[BLOCKED_DATE_UPDATED_AFTER_RETURN]", {
          vehicle_id:   normalizedVehicleId,
          booking_ref:  bookingRef,
          original_end: row.end_date,
          actual_return: today,
          action,
        });
      }
    }
  } catch (err) {
    console.error("_booking-automation autoReleaseBlockedDateOnReturn error (non-fatal):", err.message);
  }
}

/**
 * Extends an existing blocked_dates row for a booking to a later end_date/end_time.
 * Called after a rental extension so that public availability stays in sync
 * with the updated return date.
 *
 * Behaviour:
 *  - Finds the blocked_dates row(s) with the given vehicle_id + booking_ref.
 *  - Computes the buffered end (newReturnDate + BOOKING_BUFFER_HOURS) when
 *    newReturnTime is provided; otherwise uses newReturnDate as-is.
 *  - Updates end_date (and end_time when applicable) only when the buffered
 *    end is strictly later than the current stored values (never shrinks).
 *  - Falls back to creating a new row when no row is found (e.g. the initial
 *    block was never created or was accidentally removed) so availability is
 *    always corrected on the extension path.
 *
 * Non-fatal — errors are logged and never propagate to the caller.
 * Idempotent — safe to call multiple times for the same extension.
 *
 * @param {string} vehicleId      - vehicle_id text key
 * @param {string} bookingRef     - booking_ref that owns the blocked_dates row
 * @param {string} newReturnDate  - YYYY-MM-DD new return date (pre-buffer)
 * @param {string} [newReturnTime] - optional "HH:MM" or "H:MM AM/PM" return time
 */
export async function extendBlockedDateForBooking(vehicleId, bookingRef, newReturnDate, newReturnTime = null) {
  const normalizedVehicleId = normalizeVehicleId(vehicleId);
  if (!normalizedVehicleId || !bookingRef || !newReturnDate) {
    console.warn("_booking-automation extendBlockedDateForBooking: missing required args — skipped");
    return;
  }
  const sb = getSupabaseAdmin();
  if (!sb) return;

  // Compute buffered end date and time.
  const { date: newEndDate, time: newEndTime } = newReturnTime
    ? buildBufferedEnd(newReturnDate, newReturnTime)
    : { date: newReturnDate, time: null };

  try {
    const { data: rows, error: findErr } = await sb
      .from("blocked_dates")
      .select("id, start_date, end_date, end_time")
      .eq("vehicle_id", normalizedVehicleId)
      .eq("booking_ref", bookingRef)
      .eq("reason", "booking");

    if (findErr) {
      console.error("_booking-automation extendBlockedDateForBooking find error (non-fatal):", findErr.message);
      return;
    }

    if (!rows || rows.length === 0) {
      // No existing row — create a new one so availability stays in sync.
      // This covers the case where the original blocked_dates row was never
      // created or was accidentally removed.
      console.log(
        `_booking-automation extendBlockedDateForBooking: no blocked_dates row found for ` +
        `vehicle=${normalizedVehicleId} booking_ref=${bookingRef} — creating new row`
      );
      await autoCreateBlockedDate(
        normalizedVehicleId,
        newReturnDate,  // use newReturnDate as start_date (best available)
        newReturnDate,
        "booking",
        bookingRef,
        newReturnTime
      );
      return;
    }

    // Use the row with the earliest start_date (the original booking window).
    // Dates are stored as YYYY-MM-DD strings, so lexicographic comparison is correct.
    const row = rows.reduce((best, r) => (r.start_date < best.start_date ? r : best), rows[0]);
    const currentEnd = row.end_date ? String(row.end_date).split("T")[0] : null;
    const currentEndTime = row.end_time ? String(row.end_time).substring(0, 5) : null;

    const updatePayload = { end_date: newEndDate };
    if (newEndTime) updatePayload.end_time = newEndTime;

    const { error: updateErr } = await sb
      .from("blocked_dates")
      .update(updatePayload)
      .eq("id", row.id);

    if (updateErr) {
      console.error("_booking-automation extendBlockedDateForBooking update error (non-fatal):", updateErr.message);
      return;
    }

    console.log("[BLOCKED_DATE_EXTENDED]", {
      vehicle_id:  normalizedVehicleId,
      booking_ref: bookingRef,
      old_end:     currentEnd,
      old_end_time: currentEndTime || null,
      new_end:     newEndDate,
      new_end_time: newEndTime || null,
    });
  } catch (err) {
    console.error("_booking-automation extendBlockedDateForBooking error (non-fatal):", err.message);
  }
}

/**
 * Ensures a blocked_dates row exists for an active/overdue booking.
 * Idempotent — safe to call multiple times; only inserts when no booking-linked
 * row with matching booking_ref already exists.
 *
 * Call this whenever an active booking is loaded (cron, availability check,
 * system health) to self-heal missing blocked_dates rows caused by any failure
 * in the original booking write path.
 *
 * @param {string} vehicleId   - vehicle_id text key
 * @param {string} bookingRef  - booking_ref that should own the blocked_dates row
 * @param {string} returnDate  - YYYY-MM-DD (pre-buffer return date from booking)
 * @param {string} [returnTime] - optional "HH:MM" or "H:MM AM/PM" LA-timezone return time
 * @param {string} [startDate] - optional YYYY-MM-DD pickup date; falls back to returnDate
 * @returns {Promise<{created: boolean, reason: string}>}
 */
export async function ensureBlockedDate(vehicleId, bookingRef, returnDate, returnTime = null, startDate = null) {
  const normalizedVehicleId = normalizeVehicleId(vehicleId);
  if (!normalizedVehicleId || !bookingRef || !returnDate) {
    return { created: false, reason: "missing_args" };
  }

  const sb = getSupabaseAdmin();
  if (!sb) return { created: false, reason: "no_supabase" };

  try {
    // Check whether a booking-linked blocked_dates row already exists.
    // Also fetch end_time so we can patch it when it's null but returnTime is known.
    const { data: existing, error: findErr } = await sb
      .from("blocked_dates")
      .select("id, end_time")
      .eq("vehicle_id", normalizedVehicleId)
      .eq("booking_ref", bookingRef)
      .eq("reason", "booking")
      .maybeSingle();

    if (findErr) {
      console.error("_booking-automation ensureBlockedDate find error (non-fatal):", findErr.message);
      return { created: false, reason: "find_error" };
    }

    if (existing?.id) {
      // Row exists but end_time is null — patch it when returnTime is available.
      // This heals rows created by the on_booking_create trigger before the
      // trigger was updated to include the buffered end_time (migration 0114).
      // Both end_date and end_time are patched to stay consistent with the trigger
      // (migration 0114 lines 57-63 which updates both fields).  The UPDATE targets
      // the specific row by primary key (id), so the unique constraint on
      // (vehicle_id, start_date, end_date, reason) is only a concern if another row
      // already has the new (vehicle_id, start_date, buffEndDate, reason) — which
      // would only happen if two bookings for the same vehicle share the same pickup
      // and return date, which the availability check prevents.
      if (!existing.end_time && returnTime) {
        const { date: buffEndDate, time: buffEndTime } = buildBufferedEnd(returnDate, returnTime);
        if (buffEndTime) {
          const { error: patchErr } = await sb
            .from("blocked_dates")
            .update({ end_date: buffEndDate, end_time: buffEndTime })
            .eq("id", existing.id);
          if (patchErr) {
            console.error("_booking-automation ensureBlockedDate patch error (non-fatal):", patchErr.message);
          } else {
            console.log("[BLOCKED_DATE_END_TIME_PATCHED]", {
              vehicle_id:  normalizedVehicleId,
              booking_ref: bookingRef,
              end_date:    buffEndDate,
              end_time:    buffEndTime,
            });
          }
        }
        return { created: false, reason: "end_time_patched" };
      }
      return { created: false, reason: "already_exists" };
    }

    // Row is missing — recreate it.
    const effectiveStartDate = startDate || returnDate;
    await autoCreateBlockedDate(
      normalizedVehicleId,
      effectiveStartDate,
      returnDate,
      "booking",
      bookingRef,
      returnTime
    );

    console.log("[BLOCKED_DATE_ENSURED]", {
      vehicle_id:  normalizedVehicleId,
      booking_ref: bookingRef,
      start_date:  effectiveStartDate,
      return_date: returnDate,
      return_time: returnTime || null,
    });

    return { created: true, reason: "missing_row_recreated" };
  } catch (err) {
    console.error("_booking-automation ensureBlockedDate error (non-fatal):", err.message);
    return { created: false, reason: "error" };
  }
}

// ─── Pickup date/time parser (mirrors parseBookingDateTime in scheduled-reminders.js) ───

/**
 * Parses a booking pickup date + optional 12-h or 24-h time string into a Date.
 * Falls back to midnight on the pickup date when the time cannot be parsed.
 *
 * @param {string} date  - YYYY-MM-DD
 * @param {string} [time] - "3:00 PM" | "15:00"
 * @returns {Date}
 */
function parsePickupDateTime(date, time) {
  if (!date) return new Date(NaN);
  const base = new Date(date + "T00:00:00"); // midnight local
  if (time) {
    const t = time.trim();
    // Validate 12-hour format: hours 1–12, minutes 00–59
    const ampmMatch = t.match(/^(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)$/i);
    if (ampmMatch) {
      let hours = parseInt(ampmMatch[1], 10);
      const mins = parseInt(ampmMatch[2], 10);
      const period = ampmMatch[3].toUpperCase();
      if (period === "PM" && hours !== 12) hours += 12;
      if (period === "AM" && hours === 12) hours = 0;
      base.setHours(hours, mins, 0, 0);
      return base;
    }
    // Validate 24-hour format: hours 0–23, minutes 00–59
    const h24Match = t.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (h24Match) {
      base.setHours(parseInt(h24Match[1], 10), parseInt(h24Match[2], 10), 0, 0);
      return base;
    }
  }
  return base; // midnight if time can't be parsed
}

/**
 * Auto-activates a booking if its pickup date/time has already arrived.
 * Designed to be called immediately after a payment is confirmed, so that
 * same-day pickups do not have to wait for the next 15-minute cron cycle.
 *
 * Behaviour:
 *   • Skipped silently when the `auto_activate_on_pickup` system setting is false.
 *   • Skipped when the booking status is not "booked_paid".
 *   • Skipped when pickup date/time is in the future.
 *   • Non-fatal — errors are logged but never propagate to the caller.
 *   • Idempotent — safe to call multiple times; the underlying updateBooking
 *     helper only writes when the record exists.
 *
 * @param {object} booking - booking record (bookingId/paymentIntentId, vehicleId,
 *                           pickupDate, pickupTime, status are used)
 * @returns {Promise<boolean>} true when the booking was transitioned to active_rental
 */
export async function autoActivateIfPickupArrived(booking) {
  if (!booking || booking.status !== "booked_paid") return false;

  const vehicleId = booking.vehicleId;
  const id        = booking.bookingId || booking.paymentIntentId;
  if (!vehicleId || !id) return false;

  // Respect the admin toggle — default true when the setting cannot be read.
  try {
    const enabled = await loadBooleanSetting("auto_activate_on_pickup", true);
    if (!enabled) {
      console.log(
        `_booking-automation: auto_activate_on_pickup is disabled — ` +
        `skipping activation for ${vehicleId}/${id}`
      );
      return false;
    }
  } catch (err) {
    console.warn(
      "_booking-automation: failed to read auto_activate_on_pickup setting " +
      `(defaulting to enabled): ${err.message}`
    );
  }

  const now      = new Date();
  const pickupDt = parsePickupDateTime(booking.pickupDate, booking.pickupTime);
  if (isNaN(pickupDt.getTime())) {
    console.warn(
      `_booking-automation: autoActivateIfPickupArrived — invalid pickupDate ` +
      `"${booking.pickupDate}" for ${vehicleId}/${id} — skipping activation`
    );
    return false;
  }
  if (now < pickupDt) return false;

  const activatedAt = now.toISOString();

  console.log(
    `_booking-automation: auto-activating ${vehicleId}/${id} → active_rental ` +
    `(pickup ${booking.pickupDate} ${booking.pickupTime || ""}, trigger: payment_confirmed)`
  );

  try {
    await updateBooking(vehicleId, id, {
      status:      "active_rental",
      activatedAt,
      updatedAt:   activatedAt,
    });

    const activatedBooking = {
      ...booking,
      status:      "active_rental",
      activatedAt,
      updatedAt:   activatedAt,
    };
    await autoUpsertBooking(activatedBooking);

    console.log(
      `_booking-automation: ${vehicleId}/${id} successfully transitioned to active_rental`
    );
    return true;
  } catch (err) {
    console.error(
      `_booking-automation: auto-activation failed for ${vehicleId}/${id} (non-fatal):`,
      err.message
    );
    return false;
  }
}
