// api/revenue-self-heal.js
// Self-healing endpoint for revenue_records integrity.
//
// Dual purpose:
//   1. Repair incomplete Stripe fee / payment_intent_id data by expanding the
//      balance_transaction on the associated Stripe PaymentIntent.
//   2. Reconstruct missing booking rows (orphan revenue records) from the
//      revenue row's stored fields + Stripe PaymentIntent metadata, then
//      re-verify the revenue record is fully linked.
//
// Both repairs are idempotent — safe to call repeatedly.
import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";
import { persistBooking } from "./_booking-pipeline.js";
import { maybeSkipScheduledAutomation } from "./_runtime-environment.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

function formatSupabaseError(err) {
  if (!err) return "unknown Supabase error";
  if (typeof err === "string") return err;
  const parts = [];
  if (err.message) parts.push(`message=${err.message}`);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.details) parts.push(`details=${err.details}`);
  if (err.hint) parts.push(`hint=${err.hint}`);
  return parts.length > 0 ? parts.join(" | ") : JSON.stringify(err);
}

function roundCurrency(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function isStripePaymentIntentId(paymentIntentId) {
  return typeof paymentIntentId === "string" && /^pi_/i.test(paymentIntentId.trim());
}

async function resolveStripeFinancials(stripe, paymentIntentId, { fallbackGrossAmount = 0 } = {}) {
  if (!isStripePaymentIntentId(paymentIntentId)) {
    return {
      grossAmount: roundCurrency(fallbackGrossAmount),
      stripeFee: 0,
      paymentIntent: null,
    };
  }

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge.balance_transaction"],
  });

  let charge = pi?.latest_charge || null;
  if (typeof charge === "string" && charge) {
    charge = await stripe.charges.retrieve(charge, { expand: ["balance_transaction"] });
  } else if (charge && typeof charge === "object" && charge.id && (!charge.balance_transaction || typeof charge.balance_transaction === "string")) {
    charge = await stripe.charges.retrieve(charge.id, { expand: ["balance_transaction"] });
  }

  const bt = charge && typeof charge === "object"
    ? charge.balance_transaction
    : null;
  if (!bt || typeof bt !== "object") {
    throw new Error(`missing latest_charge.balance_transaction for PI ${paymentIntentId}`);
  }
  const grossAmount = Number(pi.amount_received || pi.amount || 0) / 100;
  const stripeFee = bt.fee != null ? Number(bt.fee) / 100 : null;
  if (!Number.isFinite(stripeFee)) {
    throw new Error(`invalid stripe fee for PI ${paymentIntentId}`);
  }
  return {
    grossAmount: roundCurrency(grossAmount),
    stripeFee: roundCurrency(stripeFee),
    paymentIntent: { ...pi, latest_charge: charge || pi?.latest_charge || null },
  };
}

function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

function normalizePhone(phone) {
  if (typeof phone !== "string") return "";
  return phone.trim();
}

function resolveBookingStatus(paymentType) {
  return (paymentType === "reservation_deposit")
    ? "reserved_unpaid"
    : "booked_paid";
}

async function ensureBookingForRevenueRow(sb, stripe, row) {
  const bookingRef = row.booking_id || "";
  if (!bookingRef) throw new Error(`missing booking_id for revenue row ${row.id}`);

  // Caller has already verified the booking is missing; skip the redundant re-lookup
  // and proceed straight to reconstruction.

  const paymentIntentId = row.payment_intent_id || null;
  if (!paymentIntentId) {
    throw new Error(`missing payment_intent_id for missing booking_id=${bookingRef}`);
  }

  const stripeBacked = isStripePaymentIntentId(paymentIntentId);
  const stripeFields = await resolveStripeFinancials(stripe, paymentIntentId, {
    fallbackGrossAmount: Number(row.gross_amount || 0),
  });
  const pi = stripeFields.paymentIntent;
  const meta = pi?.metadata || {};
  const amountPaid = stripeFields.grossAmount || Number(row.gross_amount || 0);
  const fullRentalAmount = Number.parseFloat(meta.full_rental_amount || "");
  const totalPrice = Number.isFinite(fullRentalAmount) && fullRentalAmount > 0
    ? Math.round(fullRentalAmount * 100) / 100
    : Math.max(amountPaid, Number(row.gross_amount || 0));

  const persistResult = await persistBooking({
    bookingId: bookingRef,
    name: meta.renter_name || row.customer_name || "Unknown",
    phone: normalizePhone(meta.renter_phone || row.customer_phone || ""),
    email: normalizeEmail(meta.email || row.customer_email || ""),
    vehicleId: meta.vehicle_id || row.vehicle_id || null,
    vehicleName: meta.vehicle_name || meta.vehicle_id || row.vehicle_id || "unknown",
    pickupDate: meta.pickup_date || row.pickup_date || null,
    pickupTime: meta.pickup_time || "",
    returnDate: meta.return_date || row.return_date || null,
    returnTime: meta.return_time || "",
    status: resolveBookingStatus(meta.payment_type || ""),
    amountPaid,
    totalPrice,
    paymentIntentId,
    paymentMethod: stripeBacked ? "stripe" : "manual",
    source: "revenue_self_heal",
    strictPersistence: true,
    stripeCustomerId: pi?.customer || null,
    stripePaymentMethodId: pi?.payment_method || null,
    stripeFee: stripeFields.stripeFee,
    requireStripeFee: stripeBacked,
    ...(meta.protection_plan_tier ? { protectionPlanTier: meta.protection_plan_tier } : {}),
  });

  if (!persistResult?.ok) {
    throw new Error(`booking reconstruction failed for booking_id=${bookingRef}`);
  }

  const { data: rebuiltBooking, error: rebuiltLookupErr } = await sb
    .from("bookings")
    .select("id, payment_intent_id")
    .eq("booking_ref", bookingRef)
    .maybeSingle();
  if (rebuiltLookupErr) {
    throw new Error(`booking verify failed: ${formatSupabaseError(rebuiltLookupErr)}`);
  }
  if (!rebuiltBooking?.id) {
    throw new Error(`booking still missing after reconstruction for booking_id=${bookingRef}`);
  }

  return rebuiltBooking;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Auth: GET is called by Vercel cron (no secret needed); POST is a manual admin
  // trigger and requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>.
  if (req.method === "POST") {
    const auth = req.headers.authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    const adminSecret = process.env.ADMIN_SECRET || "";
    const cronSecret = process.env.CRON_SECRET || "";
    if (!adminSecret && !cronSecret) {
      return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
    }
    if (!token || ((!adminSecret || token !== adminSecret) && (!cronSecret || token !== cronSecret))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (maybeSkipScheduledAutomation(req, res, { endpoint: "revenue-self-heal" })) return;

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: "STRIPE_SECRET_KEY is not configured." });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: "Supabase is not configured." });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

  let scanned = 0;
  let repaired = 0;
  let failed = 0;
  const failures = [];
  let backfilled = 0;
  let backfillFailed = 0;
  const backfillFailures = [];
  let relinked = 0;
  let relinkFailed = 0;
  const relinkFailures = [];

  try {
    // Fetch rows that need attention:
    //   • Stripe-incomplete: stripe_fee IS NULL or payment_intent_id IS NULL
    //     (need to pull fee data from the Stripe API).
    //   • Booking-unlinked: is_orphan = false but no matching bookings row
    //     (pre-migration 0060 legacy gap; migration pre-flight covers this on
    //     first run, but self-heal acts as an ongoing safety net).
    // Only target non-orphan, non-excluded rows to avoid touching rows that are
    // already flagged as having no real booking.
    const { data: rows, error: queryErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id, stripe_fee, refund_amount, gross_amount, customer_name, customer_phone, customer_email, vehicle_id, pickup_date, return_date")
      .eq("is_orphan", false)
      .eq("sync_excluded", false)
      .or("stripe_fee.is.null,payment_intent_id.is.null");

    if (queryErr) {
      console.error("revenue-self-heal: query error:", formatSupabaseError(queryErr));
      return res.status(500).json({ error: "Failed to query incomplete revenue rows" });
    }

    for (const row of rows || []) {
      const payloadContext = {
        revenue_id: row.id,
        booking_id: row.booking_id,
        payment_intent_id: row.payment_intent_id || null,
      };

      try {
        if (!row.booking_id) {
          scanned += 1;
          throw new Error(`missing booking_id for revenue row ${row.id}`);
        }

        const { data: bookingByRef, error: bookingLookupErr } = await sb
          .from("bookings")
          .select("id, payment_intent_id")
          .eq("booking_ref", row.booking_id)
          .maybeSingle();
        if (bookingLookupErr) {
          throw new Error(`booking lookup failed: ${formatSupabaseError(bookingLookupErr)}`);
        }

        const bookingMissing = !bookingByRef?.id;
        const revenueIncomplete = row.stripe_fee == null || !row.payment_intent_id;
        if (!bookingMissing && !revenueIncomplete) continue;

        scanned += 1;
        const booking = bookingMissing
          ? await ensureBookingForRevenueRow(sb, stripe, row)
          : bookingByRef;

        const paymentIntentId = row.payment_intent_id || booking.payment_intent_id || null;
        if (!paymentIntentId) {
          throw new Error(`missing payment_intent_id for booking_id=${row.booking_id}`);
        }

        const stripeFields = await resolveStripeFinancials(stripe, paymentIntentId, {
          fallbackGrossAmount: Number(row.gross_amount || 0),
        });
        const updatePayload = {
          gross_amount: stripeFields.grossAmount,
          stripe_fee: stripeFields.stripeFee,
          payment_intent_id: paymentIntentId,
          refund_amount: Number(row.refund_amount || 0),
          updated_at: new Date().toISOString(),
        };

        const { error: updateErr } = await sb
          .from("revenue_records")
          .update(updatePayload)
          .eq("id", row.id);
        if (updateErr) {
          throw new Error(`revenue repair update failed: ${formatSupabaseError(updateErr)}`);
        }

        const { data: verified, error: verifyErr } = await sb
          .from("revenue_records")
          .select("stripe_fee, payment_intent_id")
          .eq("id", row.id)
          .maybeSingle();
        if (verifyErr) {
          throw new Error(`revenue verify failed: ${formatSupabaseError(verifyErr)}`);
        }
        if (!verified || verified.stripe_fee == null || !verified.payment_intent_id) {
          throw new Error(`revenue record incomplete after repair for booking_id=${row.booking_id}`);
        }

        repaired += 1;
      } catch (err) {
        failed += 1;
        console.error("revenue-self-heal: repair failure", {
          error: err?.message || String(err),
          ...payloadContext,
        });
        failures.push({
          ...payloadContext,
          error: err?.message || String(err),
        });
      }
    }

    // ── Phase 2: Backfill bookings without any revenue record ─────────────────
    // Finds every paid non-cancelled booking that has no revenue_records row
    // with type='rental' and creates one from booking data.  This catches gaps
    // left by non-fatal autoCreateRevenueRecord failures in the write pipeline
    // (add-manual-booking.js, v2-bookings.js status transitions, stripe-webhook).
    //
    // Cash/manual bookings get stripe_fee=0 immediately so analytics are correct.
    // Stripe bookings get stripe_fee=null — stripe-reconcile.js fills that in.
    // Cash payment methods that have no Stripe fee — must match the CASE
    // expression in migrations 0089 and 0108 and autoCreateRevenueRecord
    // in _booking-automation.js.
    const CASH_METHODS = new Set(["cash", "zelle", "venmo", "manual", "external"]);

    const { data: paidBookings, error: paidBookingsErr } = await sb
      .from("bookings")
      .select("id, booking_ref, vehicle_id, pickup_date, return_date, deposit_paid, payment_method, payment_intent_id, customer_name, customer_phone, customer_email")
      .gt("deposit_paid", 0)
      .not("status", "in", "(cancelled,cancelled_rental)");

    if (paidBookingsErr) {
      console.error("revenue-self-heal Phase 2: bookings query error:", formatSupabaseError(paidBookingsErr));
    } else {
      for (const bk of paidBookings || []) {
        if (!bk.booking_ref) continue;

        try {
          // Check for an existing rental revenue record keyed by booking_ref.
          const { data: existingByRef, error: refLookupErr } = await sb
            .from("revenue_records")
            .select("id")
            .eq("booking_id", bk.booking_ref)
            .eq("type", "rental")
            .maybeSingle();
          if (refLookupErr) {
            throw new Error(`revenue_records booking_id lookup failed: ${formatSupabaseError(refLookupErr)}`);
          }
          if (existingByRef?.id) continue;

          // Also check by payment_intent_id — covers cases where an orphan or
          // differently-keyed row already accounts for this payment.
          if (bk.payment_intent_id) {
            const { data: existingByPi, error: piLookupErr } = await sb
              .from("revenue_records")
              .select("id")
              .eq("payment_intent_id", bk.payment_intent_id)
              .maybeSingle();
            if (piLookupErr) {
              throw new Error(`revenue_records payment_intent_id lookup failed: ${formatSupabaseError(piLookupErr)}`);
            }
            if (existingByPi?.id) continue;
          }

          // Insert the missing revenue record.
          const isCash = CASH_METHODS.has(String(bk.payment_method || "").toLowerCase());
          const gross = Number(bk.deposit_paid || 0);
          const revRow = {
            booking_id:        bk.booking_ref,
            booking_ref:       bk.booking_ref,
            payment_intent_id: bk.payment_intent_id || null,
            vehicle_id:        bk.vehicle_id        || null,
            customer_name:     bk.customer_name     || null,
            customer_phone:    bk.customer_phone    || null,
            customer_email:    bk.customer_email    || null,
            pickup_date:       bk.pickup_date       || null,
            return_date:       bk.return_date       || null,
            gross_amount:      gross,
            deposit_amount:    0,
            refund_amount:     0,
            payment_method:    bk.payment_method    || "stripe",
            payment_status:    "paid",
            type:              "rental",
            is_no_show:        false,
            is_cancelled:      false,
            override_by_admin: false,
            stripe_fee:        isCash ? 0    : null,
            stripe_net:        isCash ? gross : null,
          };

          const { error: insertErr } = await sb.from("revenue_records").insert(revRow);
          if (insertErr) {
            throw new Error(`revenue_records insert failed: ${formatSupabaseError(insertErr)}`);
          }

          backfilled += 1;
          console.log("revenue-self-heal Phase 2: created missing revenue record for booking", bk.booking_ref, {
            vehicle_id:     bk.vehicle_id,
            payment_method: bk.payment_method,
            gross_amount:   gross,
          });
        } catch (err) {
          backfillFailed += 1;
          console.error("revenue-self-heal Phase 2: backfill failed", {
            booking_ref: bk.booking_ref,
            error: err?.message || String(err),
          });
          backfillFailures.push({
            booking_ref: bk.booking_ref,
            error: err?.message || String(err),
          });
        }
      }
    }

    // ── Phase 3: Relink is_orphan=true rows that can be matched to a booking ──
    // The last-resort createOrphanRevenueRecord path in the webhook pipeline sets
    // is_orphan=true when no booking row can be resolved at event time.  Once the
    // booking is persisted (e.g. by the self-heal booking-reconstruction above or
    // by normal booking creation), those revenue rows can be reunited with their
    // booking by matching booking_ref or payment_intent_id.  Clearing is_orphan
    // causes them to appear in revenue_records_effective and revenue_reporting_base,
    // which fixes fleet booking counts and per-vehicle revenue totals.
    const { data: orphanRows, error: orphanQueryErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id, vehicle_id")
      .eq("is_orphan", true)
      .eq("payment_status", "paid")
      .eq("sync_excluded", false);

    if (orphanQueryErr) {
      console.error("revenue-self-heal Phase 3: orphan query error:", formatSupabaseError(orphanQueryErr));
    } else {
      for (const row of orphanRows || []) {
        try {
          let matchedRef = null;

          // Try matching by booking_ref first (most precise).
          if (row.booking_id) {
            const { data: byRef } = await sb
              .from("bookings")
              .select("id, booking_ref")
              .eq("booking_ref", row.booking_id)
              .maybeSingle();
            if (byRef?.id) matchedRef = byRef.booking_ref;
          }

          // Fall back to payment_intent_id match.
          if (!matchedRef && row.payment_intent_id) {
            const { data: byPi } = await sb
              .from("bookings")
              .select("id, booking_ref")
              .eq("payment_intent_id", row.payment_intent_id)
              .maybeSingle();
            if (byPi?.id) matchedRef = byPi.booking_ref;
          }

          if (!matchedRef) continue; // No resolvable booking — leave as orphan.

          const relinkPatch = {
            is_orphan: false,
            updated_at: new Date().toISOString(),
            ...((!row.booking_id && matchedRef) ? { booking_id: matchedRef } : {}),
          };
          const { error: relinkErr } = await sb
            .from("revenue_records")
            .update(relinkPatch)
            .eq("id", row.id);
          if (relinkErr) {
            throw new Error(`relink update failed: ${formatSupabaseError(relinkErr)}`);
          }

          relinked += 1;
          console.log("revenue-self-heal Phase 3: relinked orphan revenue record", {
            revenue_id: row.id,
            booking_ref: matchedRef,
            vehicle_id: row.vehicle_id,
          });
        } catch (err) {
          relinkFailed += 1;
          console.error("revenue-self-heal Phase 3: relink failed", {
            revenue_id: row.id,
            error: err?.message || String(err),
          });
          relinkFailures.push({ revenue_id: row.id, error: err?.message || String(err) });
        }
      }
    }

    return res.status(200).json({
      ok: failed === 0 && backfillFailed === 0 && relinkFailed === 0,
      scanned,
      repaired,
      failed,
      failures,
      backfilled,
      backfill_failed: backfillFailed,
      backfill_failures: backfillFailures,
      relinked,
      relink_failed: relinkFailed,
      relink_failures: relinkFailures,
    });
  } catch (err) {
    console.error("revenue-self-heal: fatal error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Unknown self-heal failure",
      scanned,
      repaired,
      failed,
      failures,
      backfilled,
      backfill_failed: backfillFailed,
      backfill_failures: backfillFailures,
      relinked,
      relink_failed: relinkFailed,
      relink_failures: relinkFailures,
    });
  }
}
