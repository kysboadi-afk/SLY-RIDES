// api/v2-system-health.js
// SLYTRANS Fleet Control v2 — System Health endpoint.
//
// Performs real-time integrity checks across Supabase to surface drift
// between payments, bookings, revenue records, and agreement documents.
//
// ── Modes ──────────────────────────────────────────────────────────────────
// 1. Manual run (admin panel / POST):
//    POST /api/v2-system-health
//    Body: { "secret": "<ADMIN_SECRET>", "action": "run" }
//
// 2. Per-check "Fix Now" (admin panel / POST):
//    POST /api/v2-system-health
//    Body: { "secret": "<ADMIN_SECRET>", "action": "fix_<checkKey>" }
//    Supported: fix_paymentBookingRevenue, fix_orphanRevenue,
//               fix_staleReservations, fix_stripePaymentNoBooking,
//               fix_renterIdDocuments
//    Note: fix_smsDeliveryHealth is handled by POST /api/system-health-fix-sms
//    Note: fix_availabilitySyncHealth is handled by POST /api/system-health-fix-availability
//
// 3. Scheduled cron (Vercel Cron / GET or Bearer-authenticated POST):
//    GET /api/v2-system-health
//    Headers: { "Authorization": "Bearer <CRON_SECRET>" }
//    Runs all checks, auto-repairs error-level findings, and sends
//    owner email + SMS when overallStatus === "error"
//    (deduplicated to once per hour via system_settings).
//
// ── Response shape (run mode) ───────────────────────────────────────────────
// {
//   checks: {
//     paymentBookingRevenue:   HealthCheck,
//     missingAgreements:       HealthCheck,
//     activeRentalCount:       HealthCheck,
//     orphanRevenue:           HealthCheck,
//     staleReservations:       HealthCheck,
//     stripePaymentNoBooking:  HealthCheck,
//     extensionReturnDateSync: HealthCheck,
//     smsDeliveryHealth:       HealthCheck,
//     availabilitySyncHealth:  HealthCheck,
//     ticketChargeHealth:      HealthCheck,
//     renterIdDocuments:       HealthCheck,
//   },
//   overallStatus: "ok" | "warning" | "error",
//   checkedAt: ISO-8601 string,
// }
//
// HealthCheck shape:
// {
//   status:   "ok" | "warning" | "error",
//   label:    string,
//   summary:  string,
//   detail:   string | null,
//   fixable:  boolean,
//   items:    Array<{ id: string, info: string }>,
//   count:    number,
// }

import Stripe from "stripe";
import nodemailer from "nodemailer";
import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { autoCreateRevenueRecord, buildBufferedEnd } from "./_booking-automation.js";
import { normalizeVehicleId }                        from "./_vehicle-id.js";
import { runAvailabilitySyncFix }                   from "./system-health-fix-availability.js";
import { buildDateTimeLA, DEFAULT_RETURN_TIME, isoDateInLA } from "./_time.js";
import { maybeSkipScheduledAutomation } from "./_runtime-environment.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const VALID_SCOPES = new Set(["car", "cars"]);
const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
const OWNER_PHONE = process.env.OWNER_PHONE || "+18445114059";

// Stale reservation threshold
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;  // 24 hours
const SIXTY_DAYS_MS      = 60 * 24 * 60 * 60 * 1000;

// Dedup: only fire one alert per this many milliseconds.
const ALERT_COOLDOWN_MS  = 60 * 60 * 1000; // 1 hour
const ALERT_COOLDOWN_KEY = "health_alert_last_sent_at";

// ── Small helpers ──────────────────────────────────────────────────────────

/** Build a HealthCheck result object. */
function check(label, status, summary, items = [], detail = null, fixable = false) {
  return { label, status, summary, detail, fixable, items, count: items.length };
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeScope(scope) {
  const normalized = String(scope || "").trim().toLowerCase();
  return VALID_SCOPES.has(normalized) ? normalized : null;
}


// ── Individual checks ──────────────────────────────────────────────────────

// Check 1 — Payment → Booking → Revenue consistency
async function checkPaymentBookingRevenue(sb) {
  try {
    // Fetch bookings that represent received payments using two complementary
    // filters so that legacy rows with NULL/partial payment_status are also caught:
    //   • payment_status = 'paid'   — normal path (Stripe + manual with correct sync)
    //   • deposit_paid > 0          — money was collected regardless of status column
    //     combined with a meaningful status — catches legacy rows written before the
    //     payment_status column was reliably populated.
    const [byStatusResult, byDepositResult] = await Promise.all([
      sb.from("bookings")
        .select("booking_ref, status, total_price, deposit_paid, payment_status, created_at, payment_intent_id")
        .eq("payment_status", "paid")
        .not("status", "in", '("cancelled","cancelled_rental")')
        .limit(500),
      sb.from("bookings")
        .select("booking_ref, status, total_price, deposit_paid, payment_status, created_at, payment_intent_id")
        .gt("deposit_paid", 0)
        .not("status", "in", '("cancelled","cancelled_rental")')
        .in("status", ["booked_paid", "active_rental", "completed_rental", "completed", "active", "overdue"])
        .limit(500),
    ]);

    if (byStatusResult.error) {
      console.error("[v2-system-health] paymentBookingRevenue query error:", byStatusResult.error.message);
      return check("Payment → Booking → Revenue", "error", "Could not query bookings: " + byStatusResult.error.message);
    }

    // Merge both result sets, deduplicating by booking_ref.
    const seen = new Set();
    const paidBookings = [];
    for (const b of [...(byStatusResult.data || []), ...(byDepositResult.data || [])]) {
      if (b.booking_ref && !seen.has(b.booking_ref)) {
        seen.add(b.booking_ref);
        paidBookings.push(b);
      }
    }

    const refs = paidBookings.map((b) => b.booking_ref).filter(Boolean);
    if (refs.length === 0) {
      return check("Payment → Booking → Revenue", "ok", "No paid bookings found to check.");
    }

    const { data: revRows, error: rErr } = await sb
      .from("revenue_records")
      .select("booking_id")
      .in("booking_id", refs);

    if (rErr) {
      console.error("[v2-system-health] paymentBookingRevenue revenue query error:", rErr.message);
      return check("Payment → Booking → Revenue", "error", "Could not query revenue_records: " + rErr.message);
    }

    const revenueRefs = new Set((revRows || []).map((r) => r.booking_id));

    // Secondary check: also consider bookings covered by a revenue record linked
    // via payment_intent_id (e.g. orphan records created by stripe-reconcile with
    // a "stripe-pi_xxx" booking_id before the real booking_ref was known).
    const piIds = paidBookings.map((b) => b.payment_intent_id).filter(Boolean);
    let coveredByPI = new Set();
    if (piIds.length > 0) {
      const { data: revByPI, error: piErr } = await sb
        .from("revenue_records")
        .select("payment_intent_id")
        .in("payment_intent_id", piIds);
      if (!piErr) {
        coveredByPI = new Set((revByPI || []).map((r) => r.payment_intent_id).filter(Boolean));
      }
    }

    // Tertiary check: also consider bookings covered by a revenue record linked
    // via original_booking_id (e.g. manual extension fees recorded via
    // "Record Extension Fee" produce records with booking_id="ext-..." and
    // original_booking_id=<booking_ref>).
    const { data: revByOrigRef, error: origRefErr } = await sb
      .from("revenue_records")
      .select("original_booking_id")
      .in("original_booking_id", refs);
    if (!origRefErr) {
      for (const r of revByOrigRef || []) {
        if (r.original_booking_id) revenueRefs.add(r.original_booking_id);
      }
    }

    const missingRevenue = paidBookings.filter(
      (b) =>
        b.booking_ref &&
        !revenueRefs.has(b.booking_ref) &&
        !(b.payment_intent_id && coveredByPI.has(b.payment_intent_id)),
    );

    if (missingRevenue.length === 0) {
      return check(
        "Payment → Booking → Revenue",
        "ok",
        `All ${refs.length} paid booking${refs.length !== 1 ? "s" : ""} have a revenue record.`,
      );
    }

    const items = missingRevenue.map((b) => ({
      id: b.booking_ref,
      info: `status=${b.status} total=$${b.total_price} created=${(b.created_at || "").slice(0, 10)}`,
    }));
    console.error(
      `[v2-system-health] ${missingRevenue.length} paid bookings without revenue records:`,
      missingRevenue.map((b) => b.booking_ref),
    );
    return check(
      "Payment → Booking → Revenue",
      "error",
      `${missingRevenue.length} paid booking${missingRevenue.length !== 1 ? "s" : ""} missing a revenue record.`,
      items,
      "Click 'Fix Now' to create the missing revenue records, or use Revenue → ⚡ Sync from Stripe.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] paymentBookingRevenue exception:", err);
    return check("Payment → Booking → Revenue", "error", "Unexpected error: " + err.message);
  }
}

// Check 2 — Missing agreement PDFs
async function checkMissingAgreements(sb) {
  try {
    const { data: missingDocs, error: dErr } = await sb
      .from("pending_booking_docs")
      .select("booking_id, email_sent, created_at")
      .is("agreement_pdf_url", null)
      .limit(100);

    if (dErr) {
      console.error("[v2-system-health] missingAgreements query error:", dErr.message);
      return check("Missing Agreement PDFs", "error", "Could not query pending_booking_docs: " + dErr.message);
    }

    let rows = missingDocs || [];
    if (rows.length === 0) {
      return check("Missing Agreement PDFs", "ok", "All booking documents have agreement PDFs stored.");
    }

    // Exclude rows for bookings that were never successfully paid (cancelled, failed,
    // or still pending) — a missing PDF is only actionable for paid/active bookings.
    // Note: pending_booking_docs.booking_id stores the booking reference string
    // (e.g. "bk-abc123") which matches bookings.booking_ref in the bookings table.
    const bookingIds = rows.map((r) => r.booking_id).filter(Boolean);
    if (bookingIds.length > 0) {
      const { data: paidRows } = await sb
        .from("bookings")
        .select("booking_ref")
        .in("booking_ref", bookingIds)
        .in("status", ["booked_paid", "active_rental", "active", "completed", "completed_rental", "approved"]);
      const paidSet = new Set((paidRows || []).map((b) => b.booking_ref));
      rows = rows.filter((r) => paidSet.has(r.booking_id));
    }

    if (rows.length === 0) {
      return check("Missing Agreement PDFs", "ok", "All booking documents have agreement PDFs stored.");
    }

    const items = rows.map((r) => ({
      id: r.booking_id,
      info: `email_sent=${r.email_sent} created=${(r.created_at || "").slice(0, 10)}`,
    }));
    console.error(
      `[v2-system-health] ${rows.length} bookings missing agreement_pdf_url:`,
      rows.map((r) => r.booking_id),
    );
    return check(
      "Missing Agreement PDFs",
      "warning",
      `${rows.length} booking document${rows.length !== 1 ? "s" : ""} without an agreement PDF.`,
      items,
      "Use the Bookings tab → Resend Confirmation to regenerate and store the PDF for each booking.",
      false,
    );
  } catch (err) {
    console.error("[v2-system-health] missingAgreements exception:", err);
    return check("Missing Agreement PDFs", "error", "Unexpected error: " + err.message);
  }
}

// Check 3 — Active rental count vs. date-based count
async function checkActiveRentalCount(sb) {
  try {
    const today = isoDateInLA();

    const [activeStatusRes, dateBasedRes] = await Promise.all([
      sb
        .from("bookings")
        .select("booking_ref, pickup_date, return_date, vehicle_id, status", { count: "exact" })
        .in("status", ["active", "active_rental"])
        .limit(200),
      sb
        .from("bookings")
        .select("booking_ref, pickup_date, return_date, vehicle_id, status", { count: "exact" })
        .lte("pickup_date", today)
        .gte("return_date", today)
        .in("payment_status", ["paid", "partial"])
        .not("status", "in", '("completed","completed_rental","cancelled","cancelled_rental")')
        .limit(200),
    ]);

    if (activeStatusRes.error || dateBasedRes.error) {
      const msg = (activeStatusRes.error || dateBasedRes.error).message;
      console.error("[v2-system-health] activeRentalCount query error:", msg);
      return check("Active Rental Count", "error", "Could not query active rentals: " + msg);
    }

    const byStatus   = activeStatusRes.count ?? (activeStatusRes.data || []).length;
    const statusRefs = new Set((activeStatusRes.data || []).map((b) => b.booking_ref));
    const dateRefs   = new Set((dateBasedRes.data   || []).map((b) => b.booking_ref));

    const notMarkedActive        = (dateBasedRes.data   || []).filter((b) => !statusRefs.has(b.booking_ref));
    // Only flag bookings whose return date has already passed — bookings with a future
    // pickup/return that were pre-set to "active" should not be treated as mismatches.
    const markedActivePastReturn = (activeStatusRes.data || []).filter(
      (b) => !dateRefs.has(b.booking_ref) && b.return_date < today,
    );
    const drift = notMarkedActive.length + markedActivePastReturn.length;

    if (drift === 0) {
      return check(
        "Active Rental Count",
        "ok",
        `${byStatus} active rental${byStatus !== 1 ? "s" : ""} — status matches date range.`,
      );
    }

    const items = [
      ...notMarkedActive.map((b) => ({
        id: b.booking_ref,
        info: `in date range but status=${b.status} (${b.pickup_date} → ${b.return_date})`,
      })),
      ...markedActivePastReturn.map((b) => ({
        id: b.booking_ref,
        info: `status=active but return_date=${b.return_date} is in the past (today=${today})`,
      })),
    ];
    console.error(
      `[v2-system-health] active rental mismatch: ${notMarkedActive.length} unmarked, ${markedActivePastReturn.length} past return`,
    );
    return check(
      "Active Rental Count",
      "warning",
      `${drift} active-status mismatch${drift !== 1 ? "es" : ""} detected.`,
      items,
      "Review bookings and update status via the Bookings tab.",
      false,
    );
  } catch (err) {
    console.error("[v2-system-health] activeRentalCount exception:", err);
    return check("Active Rental Count", "error", "Unexpected error: " + err.message);
  }
}

// Check 4 — Orphan revenue records
async function checkOrphanRevenue(sb) {
  try {
    const { data: orphanRows, error: oErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id, vehicle_id, gross_amount, created_at, type")
      .eq("is_orphan", false)
      .eq("sync_excluded", false)
      .in("type", ["rental", "extension"])
      .limit(500);

    if (oErr) {
      console.error("[v2-system-health] orphanRevenue query error:", oErr.message);
      return check("Orphan Revenue Records", "error", "Could not query revenue_records: " + oErr.message);
    }

    const rows      = orphanRows || [];
    const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter(Boolean))];

    if (bookingIds.length === 0) {
      return check("Orphan Revenue Records", "ok", "No revenue records to check.");
    }

    const { data: bookingRows, error: bErr } = await sb
      .from("bookings")
      .select("booking_ref")
      .in("booking_ref", bookingIds);

    if (bErr) {
      console.error("[v2-system-health] orphanRevenue bookings lookup error:", bErr.message);
      return check("Orphan Revenue Records", "error", "Could not verify booking refs: " + bErr.message);
    }

    const validRefs = new Set((bookingRows || []).map((b) => b.booking_ref));

    // Secondary cross-reference by payment_intent_id: a record whose booking_id no
    // longer exists but whose payment_intent_id matches a booking is re-linkable —
    // do not flag it as a true orphan.
    const candidatePIIds = [
      ...new Set(
        rows
          .filter((r) => r.booking_id && !validRefs.has(r.booking_id) && r.payment_intent_id)
          .map((r) => r.payment_intent_id),
      ),
    ];
    let piLinkedRefs = new Set();
    if (candidatePIIds.length > 0) {
      const { data: bookingsByPI } = await sb
        .from("bookings")
        .select("payment_intent_id")
        .in("payment_intent_id", candidatePIIds);
      for (const b of bookingsByPI || []) {
        if (b.payment_intent_id) piLinkedRefs.add(b.payment_intent_id);
      }
    }

    const trueOrphans = rows.filter(
      (r) =>
        r.booking_id &&
        !validRefs.has(r.booking_id) &&
        !(r.payment_intent_id && piLinkedRefs.has(r.payment_intent_id)),
    );

    if (trueOrphans.length === 0) {
      return check(
        "Orphan Revenue Records",
        "ok",
        `All ${rows.length} revenue record${rows.length !== 1 ? "s" : ""} reference valid bookings.`,
      );
    }

    const items = trueOrphans.map((r) => ({
      id: r.booking_id,
      info: `revenue_id=${r.id.slice(0, 8)} vehicle=${r.vehicle_id} gross=$${r.gross_amount} created=${(r.created_at || "").slice(0, 10)}`,
    }));
    console.error(
      `[v2-system-health] ${trueOrphans.length} orphan revenue records:`,
      trueOrphans.map((r) => r.booking_id),
    );
    return check(
      "Orphan Revenue Records",
      "warning",
      `${trueOrphans.length} revenue record${trueOrphans.length !== 1 ? "s" : ""} reference non-existent bookings.`,
      items,
      "Click 'Fix Now' to flag these as orphans, or use Revenue → 🧹 Fix Unknown.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] orphanRevenue exception:", err);
    return check("Orphan Revenue Records", "error", "Unexpected error: " + err.message);
  }
}

// Check 5 — Stale / stuck reservations
async function checkStaleReservations(sb) {
  try {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

    const { data: staleRows, error: sErr } = await sb
      .from("bookings")
      .select("booking_ref, status, payment_status, created_at, vehicle_id")
      .in("payment_status", ["unpaid"])
      .in("status", ["pending", "reserved"])
      .lt("created_at", cutoff)
      .limit(100);

    if (sErr) {
      console.error("[v2-system-health] staleReservations query error:", sErr.message);
      return check("Stale Reservations", "error", "Could not query stale reservations: " + sErr.message);
    }

    const rows = staleRows || [];
    if (rows.length === 0) {
      return check("Stale Reservations", "ok", "No stale unpaid reservations older than 24 hours.");
    }

    const items = rows.map((r) => ({
      id: r.booking_ref,
      info: `status=${r.status} vehicle=${r.vehicle_id} created=${(r.created_at || "").slice(0, 10)}`,
    }));
    console.error(
      `[v2-system-health] ${rows.length} stale unpaid reservations:`,
      rows.map((r) => r.booking_ref),
    );
    return check(
      "Stale Reservations",
      "warning",
      `${rows.length} unpaid reservation${rows.length !== 1 ? "s" : ""} older than 24 hours (possible failed webhook).`,
      items,
      "Click 'Fix Now' to cancel these automatically, or review them in the Bookings tab.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] staleReservations exception:", err);
    return check("Stale Reservations", "error", "Unexpected error: " + err.message);
  }
}

// Check 6 — Stripe PaymentIntent exists but no booking
// Detects is_orphan=true revenue records with payment_intent_id set —
// these are Stripe-confirmed payments for which no booking was ever created.
// Records whose booking_id already matches a bookings row are ignored — those
// are legacy false-positive orphan flags left over from a previous bug and do
// not represent a real data gap.
async function checkStripePaymentNoBooking(sb) {
  try {
    const cutoff60d = new Date(Date.now() - SIXTY_DAYS_MS).toISOString();

    const { data: orphanPIRows, error: oErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id, vehicle_id, gross_amount, customer_name, created_at")
      .eq("is_orphan", true)
      .not("payment_intent_id", "is", null)
      .gte("created_at", cutoff60d)
      .limit(100);

    if (oErr) {
      console.error("[v2-system-health] stripePaymentNoBooking query error:", oErr.message);
      return check(
        "Stripe Payment → No Booking",
        "error",
        "Could not query revenue_records: " + oErr.message,
      );
    }

    const allRows = orphanPIRows || [];
    if (allRows.length === 0) {
      return check(
        "Stripe Payment → No Booking",
        "ok",
        "No unlinked Stripe payments in the last 60 days.",
      );
    }

    // Cross-reference booking_id against bookings.booking_ref.
    // Records whose booking_id matches a real booking are legacy false-positive
    // orphan flags — they must not be surfaced as errors.
    const candidateBookingIds = [...new Set(allRows.map((r) => r.booking_id).filter(Boolean))];
    let existingRefs = new Set();
    if (candidateBookingIds.length > 0) {
      const { data: bookingRows, error: bErr } = await sb
        .from("bookings")
        .select("booking_ref")
        .in("booking_ref", candidateBookingIds);
      if (!bErr) {
        existingRefs = new Set((bookingRows || []).map((b) => b.booking_ref));
      }
    }

    // Secondary cross-reference by payment_intent_id.
    // Revenue records that have a synthetic "stripe-pi_xxx" booking_id (or NULL)
    // are not truly orphaned when a booking stores the same payment_intent_id.
    const candidatePIIds = [...new Set(allRows.map((r) => r.payment_intent_id).filter(Boolean))];
    let bookingsLinkedByPI = new Set();
    if (candidatePIIds.length > 0) {
      const { data: bookingsByPI, error: piErr } = await sb
        .from("bookings")
        .select("payment_intent_id")
        .in("payment_intent_id", candidatePIIds);
      if (!piErr) {
        for (const b of bookingsByPI || []) {
          if (b.payment_intent_id) bookingsLinkedByPI.add(b.payment_intent_id);
        }
      }
    }

    // Only surface rows where neither booking_id nor payment_intent_id links to a real booking.
    const rows = allRows.filter(
      (r) =>
        (!r.booking_id || !existingRefs.has(r.booking_id)) &&
        !(r.payment_intent_id && bookingsLinkedByPI.has(r.payment_intent_id)),
    );
    const legacyFalsePositives = allRows.length - rows.length;

    if (legacyFalsePositives > 0) {
      console.log(
        `[v2-system-health] stripePaymentNoBooking: ${legacyFalsePositives} record(s) skipped — ` +
        "is_orphan=true but booking exists (by booking_ref or payment_intent_id); use Fix Now to clear.",
      );
    }

    if (rows.length === 0) {
      return check(
        "Stripe Payment → No Booking",
        "ok",
        legacyFalsePositives > 0
          ? `No truly unlinked Stripe payments. ${legacyFalsePositives} legacy orphan flag(s) cleared by Fix Now.`
          : "No unlinked Stripe payments in the last 60 days.",
      );
    }

    const items = rows.map((r) => ({
      id: r.payment_intent_id || r.booking_id,
      info: [
        r.customer_name ? `customer=${r.customer_name}` : null,
        r.vehicle_id    ? `vehicle=${r.vehicle_id}`     : null,
        `gross=$${r.gross_amount}`,
        `created=${(r.created_at || "").slice(0, 10)}`,
      ].filter(Boolean).join(" "),
    }));
    console.error(
      `[v2-system-health] ${rows.length} orphan Stripe payments (no booking):`,
      rows.map((r) => r.payment_intent_id || r.booking_id),
    );
    return check(
      "Stripe Payment → No Booking",
      "error",
      `${rows.length} Stripe payment${rows.length !== 1 ? "s" : ""} with no booking record.`,
      items,
      "Click 'Fix Now' to queue these for booking reconstruction via revenue-self-heal, or use Revenue → ⚡ Sync from Stripe.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] stripePaymentNoBooking exception:", err);
    return check("Stripe Payment → No Booking", "error", "Unexpected error: " + err.message);
  }
}

// Check 7 — Extension payment recorded but booking return_date not updated
// Detects cases where a renter paid for a rental extension (Stripe PI succeeded,
// type='extension' revenue record created) but the booking's return_date in the
// bookings table still shows the original date.  This happens when the
// autoUpsertBooking sync step inside stripe-webhook.js fails non-fatally —
// money was collected but the calendar date wasn't moved.
async function checkExtensionReturnDateSync(sb) {
  try {
    // Fetch all paid, non-cancelled extension revenue records.
    const { data: extRows, error: extErr } = await sb
      .from("revenue_records")
      .select("booking_id, return_date, gross_amount, vehicle_id")
      .eq("type", "extension")
      .eq("payment_status", "paid")
      .eq("is_cancelled", false)
      .not("return_date", "is", null)
      .not("booking_id", "is", null)
      // 500 is deliberately generous for this fleet size.  If the limit is ever
      // reached the check will still flag any mismatches it does find — it will
      // not silently pass.
      .limit(500);

    if (extErr) {
      console.error("[v2-system-health] extensionReturnDateSync query error:", extErr.message);
      return check("Extension Return Date Sync", "error", "Could not query extension records: " + extErr.message);
    }

    const rows = extRows || [];
    if (rows.length === 0) {
      return check("Extension Return Date Sync", "ok", "No paid extension records to check.");
    }

    // Find the latest (max) extension return_date per booking.
    const maxExtReturn = {};
    for (const r of rows) {
      const cur = maxExtReturn[r.booking_id];
      if (!cur || r.return_date > cur.return_date) {
        maxExtReturn[r.booking_id] = { return_date: r.return_date, vehicle_id: r.vehicle_id };
      }
    }

    const bookingIds = Object.keys(maxExtReturn);
    if (bookingIds.length === 0) {
      return check("Extension Return Date Sync", "ok", "No extension records with return dates.");
    }

    // Fetch the current return_date for those bookings.
    const { data: bookingRows, error: bErr } = await sb
      .from("bookings")
      .select("booking_ref, return_date, status")
      .in("booking_ref", bookingIds);

    if (bErr) {
      console.error("[v2-system-health] extensionReturnDateSync bookings query error:", bErr.message);
      return check("Extension Return Date Sync", "error", "Could not query bookings: " + bErr.message);
    }

    const bookingByRef = {};
    for (const b of bookingRows || []) {
      bookingByRef[b.booking_ref] = b;
    }

    // Flag bookings where the booking's return_date < the latest paid extension's
    // return_date (extension was paid but booking date wasn't moved forward).
    // Skip completed/cancelled bookings — stale dates there are expected.
    const SKIP_STATUSES = new Set(["completed", "completed_rental", "cancelled", "cancelled_rental"]);
    const mismatches = [];

    for (const [bookingId, ext] of Object.entries(maxExtReturn)) {
      const booking = bookingByRef[bookingId];
      if (!booking || SKIP_STATUSES.has(booking.status)) continue;
      if (booking.return_date && booking.return_date < ext.return_date) {
        mismatches.push({
          id:   bookingId,
          info: `booking return_date=${booking.return_date} but extension paid through ${ext.return_date} (vehicle=${ext.vehicle_id || "?"})`,
        });
      }
    }

    if (mismatches.length === 0) {
      return check(
        "Extension Return Date Sync",
        "ok",
        `All ${bookingIds.length} extended booking${bookingIds.length !== 1 ? "s" : ""} have correct return dates.`,
      );
    }

    console.error(
      `[v2-system-health] ${mismatches.length} extension return date mismatch(es):`,
      mismatches.map((m) => m.id),
    );
    return check(
      "Extension Return Date Sync",
      "error",
      `${mismatches.length} booking${mismatches.length !== 1 ? "s" : ""} with extension paid but return date not updated.`,
      mismatches,
      "The renter paid to extend their rental but the booking return date was not moved forward. Manually update the return date in the Bookings tab.",
      false,
    );
  } catch (err) {
    console.error("[v2-system-health] extensionReturnDateSync exception:", err);
    return check("Extension Return Date Sync", "error", "Unexpected error: " + err.message);
  }
}

// ── Check 8: SMS Delivery Health ────────────────────────────────────────────
// Detects active/overdue rentals that are missing required SMS communication:
//   • Active rentals with zero sms_logs entries (silent bookings)
//   • Overdue/recently-past-return bookings missing critical return-window SMS
//   • Active bookings with no phone number (cannot receive SMS)
//
// Critical window offsets relative to return_datetime:
//   late_warning_30min fires at [-30 min, -15 min]
//   late_at_return     fires at [+0 min,  +15 min]
//   late_grace_expired fires at [+60 min, +75 min]
//
// A booking is only evaluated for missed critical SMS once ALL three windows
// have closed, i.e. now > return_datetime + 75 min.  This prevents false
// positives for same-day bookings whose return time is still in the future
// (e.g. at 4 AM a booking returning at 11 PM would previously be flagged
// because return_date == today even though the windows haven't opened yet).
//
// If sms_delivery_logs shows a "skipped" entry for a critical key, it is
// classified as [SKIPPED: OUTSIDE WINDOW] (warning) rather than [MISSED
// CRITICAL] (error), because the skip was intentional (e.g. no phone number
// at send time or other business-rule suppression).
async function checkSmsDeliveryHealth(sb) {
  try {
    const now       = new Date(); // UTC; compared against returnDt which is also a UTC Date (LA offset baked in by buildDateTimeLA)
    // Look back 48 h for recently-past-return bookings that may have missed critical SMS.
    const cutoff48h = isoDateInLA(new Date(Date.now() - 48 * 60 * 60 * 1000));
    const ACTIVE_STATUSES = ["active_rental", "active", "overdue"];

    // The three critical keys checked for post-return coverage.
    const CRITICAL_KEYS = ["late_warning_30min", "late_at_return", "late_grace_expired"];

    // All three critical windows close 75 minutes after return_datetime.
    // We wait this long before declaring a missing key as "missed".
    const LAST_WINDOW_CLOSE_MS = 75 * 60 * 1000;

    const { data: activeRows, error: activeErr } = await sb
      .from("bookings")
      .select("booking_ref, status, customer_phone, renter_phone, customer_name, return_date, return_time, vehicle_id")
      .in("status", ACTIVE_STATUSES)
      .limit(200);

    if (activeErr) {
      console.error("[v2-system-health] smsDeliveryHealth query error:", activeErr.message);
      return check("SMS Delivery Health", "error", "Could not query bookings: " + activeErr.message);
    }

    const rows = activeRows || [];
    if (rows.length === 0) {
      return check("SMS Delivery Health", "ok", "No active or overdue rentals to check.");
    }

    const refs = rows.map((r) => r.booking_ref).filter(Boolean);

    // Fetch all sms_logs rows for these bookings in one query.
    const { data: smsRows, error: smsErr } = await sb
      .from("sms_logs")
      .select("booking_id, template_key, return_date_at_send")
      .in("booking_id", refs);

    if (smsErr) {
      console.error("[v2-system-health] smsDeliveryHealth sms_logs query error:", smsErr.message);
      return check("SMS Delivery Health", "error", "Could not query sms_logs: " + smsErr.message);
    }

    // Fetch sms_delivery_logs 'skipped' entries to distinguish intentional skips
    // (e.g. outside the SMS send window, no phone at send time) from genuine
    // misses.  Non-fatal: a query error leaves skippedDelivery empty so the
    // check degrades gracefully to the previous "missed" classification.
    const skippedDelivery = new Set(); // "booking_ref|message_type" pairs
    try {
      const { data: deliveryRows, error: deliveryErr } = await sb
        .from("sms_delivery_logs")
        .select("booking_ref, message_type")
        .in("booking_ref", refs)
        .in("message_type", CRITICAL_KEYS)
        .eq("status", "skipped");
      if (deliveryErr) {
        console.warn("[v2-system-health] smsDeliveryHealth sms_delivery_logs query error (non-fatal):", deliveryErr.message);
      }
      for (const log of deliveryRows || []) {
        if (log.booking_ref && log.message_type) {
          skippedDelivery.add(`${log.booking_ref}|${log.message_type}`);
        }
      }
    } catch (deliveryErr) {
      console.warn("[v2-system-health] smsDeliveryHealth sms_delivery_logs query failed (non-fatal):", deliveryErr.message);
    }

    // Build a set of "template_key|return_date_at_send" tuples per booking.
    const smsByBooking = {};
    for (const log of smsRows || []) {
      if (!smsByBooking[log.booking_id]) smsByBooking[log.booking_id] = new Set();
      smsByBooking[log.booking_id].add(`${log.template_key}|${log.return_date_at_send}`);
    }

    const missingPhone         = [];
    const noSmsContact         = [];
    const missedCritical       = [];
    const skippedOutsideWindow = [];

    for (const b of rows) {
      const ref = b.booking_ref;
      if (!ref) continue;

      // Sub-check A: booking missing a phone number.
      // renter_phone is the canonical SMS field (migration 0101); fall back to
      // customer_phone for rows written before that migration.
      if (!b.renter_phone && !b.customer_phone) {
        missingPhone.push({
          id:   ref,
          info: `status=${b.status} vehicle=${b.vehicle_id || "?"} return=${b.return_date || "?"}`,
        });
        continue; // cannot send SMS without a phone number
      }

      const logs = smsByBooking[ref] || new Set();

      // Compute return datetime and whether all SMS windows have closed.
      // The last critical window (late_grace_expired) closes at return_datetime
      // + 75 min.  We must not evaluate SMS coverage before that point to avoid
      // false positives for active bookings whose return time is still in the
      // future (e.g. a check running at 4 AM for an 11 PM return).
      const returnDate = b.return_date ? String(b.return_date).split("T")[0] : null;
      const returnTime = b.return_time
        ? String(b.return_time).substring(0, 5)
        : DEFAULT_RETURN_TIME;
      const returnDt = returnDate ? buildDateTimeLA(returnDate, returnTime) : new Date(NaN);
      const allWindowsClosed = !isNaN(returnDt.getTime()) &&
        now.getTime() > returnDt.getTime() + LAST_WINDOW_CLOSE_MS;

      // Sub-check B: active rental with zero SMS contact — only flag after all
      // windows have closed.  Before that point the system simply hasn't had a
      // chance to send anything yet, so silence is expected.
      if (logs.size === 0 && allWindowsClosed) {
        noSmsContact.push({
          id:   ref,
          info: `status=${b.status} vehicle=${b.vehicle_id || "?"} return=${returnDate || "?"}`,
        });
      }

      // Sub-check C: overdue / recently-past-return without critical return-window SMS.
      if (returnDate && returnDate >= cutoff48h && allWindowsClosed) {
        const missing = CRITICAL_KEYS.filter((k) => !logs.has(`${k}|${returnDate}`));
        if (missing.length > 0) {
          // Split: keys with a sms_delivery_logs 'skipped' entry are classified
          // as skipped_outside_window (expected behaviour, not an error).
          // Keys with no evidence of a send attempt are genuinely missed.
          const windowSkipped  = missing.filter((k) =>  skippedDelivery.has(`${ref}|${k}`));
          const actuallyMissed = missing.filter((k) => !skippedDelivery.has(`${ref}|${k}`));

          if (windowSkipped.length > 0) {
            skippedOutsideWindow.push({
              id:   ref,
              info: `status=${b.status} return=${returnDate} skipped=[${windowSkipped.join(",")}] vehicle=${b.vehicle_id || "?"}`,
            });
          }
          if (actuallyMissed.length > 0) {
            missedCritical.push({
              id:   ref,
              info: `status=${b.status} return=${returnDate} missed=[${actuallyMissed.join(",")}] vehicle=${b.vehicle_id || "?"}`,
            });
          }
        }
      }
    }

    const totalIssues = missingPhone.length + noSmsContact.length +
      missedCritical.length + skippedOutsideWindow.length;
    if (totalIssues === 0) {
      return check(
        "SMS Delivery Health",
        "ok",
        `All ${rows.length} active rental${rows.length !== 1 ? "s" : ""} have SMS coverage.`,
      );
    }

    const allItems = [
      ...missedCritical.map((i)       => ({ id: i.id, info: `[MISSED CRITICAL] ${i.info}` })),
      ...skippedOutsideWindow.map((i) => ({ id: i.id, info: `[SKIPPED: OUTSIDE WINDOW] ${i.info}` })),
      ...noSmsContact.map((i)         => ({ id: i.id, info: `[NO SMS] ${i.info}` })),
      ...missingPhone.map((i)         => ({ id: i.id, info: `[NO PHONE] ${i.info}` })),
    ];

    const parts = [];
    if (missedCritical.length > 0)
      parts.push(`${missedCritical.length} booking${missedCritical.length !== 1 ? "s" : ""} missed critical return-window SMS`);
    if (skippedOutsideWindow.length > 0)
      parts.push(`${skippedOutsideWindow.length} booking${skippedOutsideWindow.length !== 1 ? "s" : ""} skipped outside the send window`);
    if (noSmsContact.length > 0)
      parts.push(`${noSmsContact.length} active rental${noSmsContact.length !== 1 ? "s" : ""} with no SMS contact`);
    if (missingPhone.length > 0)
      parts.push(`${missingPhone.length} booking${missingPhone.length !== 1 ? "s" : ""} without a phone number`);

    console.log(
      `[v2-system-health] smsDeliveryHealth: missedCritical=${missedCritical.length}` +
      ` skippedOutsideWindow=${skippedOutsideWindow.length}` +
      ` noSmsContact=${noSmsContact.length} missingPhone=${missingPhone.length}`
    );

    // Status is "error" only for genuine misses.
    // skipped_outside_window entries are "warning" — expected behaviour due to
    // business rules (send window, no phone at time of send, etc.).
    const overallStatus = missedCritical.length > 0
      ? "error"
      : "warning";

    return check(
      "SMS Delivery Health",
      overallStatus,
      parts.join("; ") + ".",
      allItems,
      "Click 'Fix Now' to send any missing critical SMS. Bookings without a phone number require manual intervention.",
      missedCritical.length > 0 || noSmsContact.length > 0, // fixable: missed critical SMS or rentals with no SMS history
    );
  } catch (err) {
    console.error("[v2-system-health] smsDeliveryHealth exception:", err);
    return check("SMS Delivery Health", "error", "Unexpected error: " + err.message);
  }
}

// ── Check 9: Availability Sync Health ─────────────────────────────────────
// Detects active/overdue bookings that are missing a blocked_dates row, or
// whose existing blocked_dates row has an end that is earlier than the
// booking's return_date+return_time+buffer — meaning the vehicle may
// incorrectly appear as available while it is actively rented.
// All statuses that represent a vehicle being held for a renter — must match
// ACTIVE_BOOKING_STATUSES in fleet-status.js and ACTIVE_STATUSES in
// system-health-fix-availability.js.
const AVAILABILITY_SYNC_ACTIVE = [
  "pending", "booked_paid", "approved", "active",
  "reserved", "reserved_unpaid", "pending_verification",
  "active_rental", "overdue",
];
async function checkAvailabilitySync(sb) {
  try {
    const { data: activeRows, error: activeErr } = await sb
      .from("bookings")
      .select("booking_ref, vehicle_id, status, pickup_date, return_date, return_time")
      .in("status", AVAILABILITY_SYNC_ACTIVE)
      .limit(200);

    if (activeErr) {
      console.error("[v2-system-health] availabilitySyncHealth query error:", activeErr.message);
      return check("Availability Sync Health", "error", "Could not query bookings: " + activeErr.message);
    }

    const rows = activeRows || [];
    if (rows.length === 0) {
      return check("Availability Sync Health", "ok", "No active or overdue rentals to check.");
    }

    const vehicleIds = [...new Set(rows.map((r) => normalizeVehicleId(r.vehicle_id)).filter(Boolean))];

    // Fetch all blocked_dates rows for the vehicles that have active bookings.
    // We do NOT use booking_ref because that column may not exist in all deployments.
    const { data: blockRows, error: blockErr } = await sb
      .from("blocked_dates")
      .select("vehicle_id, end_date, end_time")
      .in("vehicle_id", vehicleIds)
      .eq("reason", "booking");

    if (blockErr) {
      console.error("[v2-system-health] availabilitySyncHealth blocked_dates query error:", blockErr.message);
      return check("Availability Sync Health", "error", "Could not query blocked_dates: " + blockErr.message);
    }

    // Index by vehicle_id — use the row with the latest end_date (or end_time) per vehicle.
    const blockByVehicle = {};
    for (const b of blockRows || []) {
      const vid = b.vehicle_id;
      if (!vid) continue;
      const cur = blockByVehicle[vid];
      if (!cur) {
        blockByVehicle[vid] = b;
        continue;
      }
      // Keep the later end: compare end_date first, then end_time.
      const newIsLater =
        b.end_date > cur.end_date ||
        (b.end_date === cur.end_date &&
          (b.end_time || "00:00") > (cur.end_time || "00:00"));
      if (newIsLater) blockByVehicle[vid] = b;
    }

    const missingBlocks = [];
    const staleBlocks   = [];

    for (const booking of rows) {
      const vehicleId = normalizeVehicleId(booking.vehicle_id);
      if (!vehicleId) continue;

      const block = blockByVehicle[vehicleId];

      if (!block) {
        // No blocked_dates row at all.
        missingBlocks.push({
          id:   vehicleId,
          info: `status=${booking.status} vehicle=${vehicleId} return=${booking.return_date || "?"}`,
        });
        continue;
      }

      // Check whether the stored end is earlier than return+buffer.
      if (!booking.return_date) continue; // cannot validate without a return date

      const { date: correctEndDate, time: correctEndTime } = buildBufferedEnd(
        booking.return_date,
        booking.return_time || null,
      );

      const storedEnd     = String(block.end_date || "").split("T")[0];
      const storedEndTime = block.end_time ? String(block.end_time).substring(0, 5) : null;

      const isStale = (() => {
        if (!storedEnd) return true;
        if (storedEnd < correctEndDate) return true;
        if (storedEnd > correctEndDate) return false;
        // Same date — compare times only when both are available.
        if (storedEndTime && correctEndTime) return storedEndTime < correctEndTime;
        return false;
      })();

      if (isStale) {
        staleBlocks.push({
          id:   vehicleId,
          info: `status=${booking.status} vehicle=${vehicleId} ` +
                `stored_end=${storedEnd}${storedEndTime ? ` ${storedEndTime}` : ""} ` +
                `expected_end=${correctEndDate}${correctEndTime ? ` ${correctEndTime}` : ""}`,
        });
      }
    }

    const totalIssues = missingBlocks.length + staleBlocks.length;
    if (totalIssues === 0) {
      return check(
        "Availability Sync Health",
        "ok",
        `All ${rows.length} active rental${rows.length !== 1 ? "s" : ""} have correct blocked_dates entries.`,
      );
    }

    const allItems = [
      ...missingBlocks.map((i) => ({ id: i.id, info: `[MISSING BLOCK] ${i.info}` })),
      ...staleBlocks.map((i)   => ({ id: i.id, info: `[STALE BLOCK] ${i.info}` })),
    ];

    const parts = [];
    if (missingBlocks.length > 0)
      parts.push(`${missingBlocks.length} vehicle${missingBlocks.length !== 1 ? "s" : ""} missing blocks`);
    if (staleBlocks.length > 0)
      parts.push(`${staleBlocks.length} vehicle${staleBlocks.length !== 1 ? "s" : ""} with stale/incorrect blocks`);

    console.error(
      `[v2-system-health] availabilitySyncHealth: missing=${missingBlocks.length} stale=${staleBlocks.length}`
    );

    return check(
      "Availability Sync Health",
      "error",
      parts.join("; ") + ".",
      allItems,
      "Click 'Fix Now' to rebuild missing or incorrect blocked_dates rows from active bookings.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] availabilitySyncHealth exception:", err);
    return check("Availability Sync Health", "error", "Unexpected error: " + err.message);
  }
}

// Check 10 — Ticket charge failures
// Surfaces violation tickets whose Stripe charge has failed.
//   • warning: one or more tickets have failed charges with retries remaining
//   • error:   one or more tickets have exhausted all retry attempts (>= MAX_RETRIES)
//   • ok:      no failed charge attempts on record
const TICKET_MAX_RETRIES = 3; // must match MAX_RETRIES in ticket-charge.js
async function checkTicketChargeHealth(sb) {
  try {
    const { data: failedRows, error: fErr } = await sb
      .from("tickets")
      .select("id, ticket_number, booking_ref, amount, charge_retry_count")
      .eq("charge_status", "failed")
      .limit(100);

    if (fErr) {
      // Gracefully handle deployments where the tickets table does not yet exist.
      // Matches both the Postgres "undefined_table" error (42P01 / "does not exist")
      // and the PostgREST schema-cache miss ("schema cache") that occurs when the
      // table was created but the cache hasn't refreshed yet.
      const msg = fErr.message || "";
      if (
        fErr.code === "42P01" ||
        msg.includes("does not exist") ||
        msg.includes("schema cache") ||
        fErr.code === "PGRST106"
      ) {
        return check("Ticket Charge Health", "ok", "No ticket charge failures.");
      }
      console.error("[v2-system-health] ticketChargeHealth query error:", fErr.message);
      return check("Ticket Charge Health", "error", "Could not query tickets: " + fErr.message);
    }

    const failed = failedRows || [];
    if (failed.length === 0) {
      return check("Ticket Charge Health", "ok", "No ticket charge failures.");
    }

    const exhausted = failed.filter((t) => (t.charge_retry_count || 0) >= TICKET_MAX_RETRIES);
    const retryable = failed.filter((t) => (t.charge_retry_count || 0) < TICKET_MAX_RETRIES);

    const items = failed.map((t) => ({
      id:   t.ticket_number || t.id,
      info: `booking=${t.booking_ref || "—"} amount=$${Number(t.amount || 0).toFixed(2)} retries=${t.charge_retry_count || 0}` +
            ((t.charge_retry_count || 0) >= TICKET_MAX_RETRIES ? " [MAX RETRIES EXHAUSTED]" : ""),
    }));

    const parts = [];
    if (exhausted.length > 0)
      parts.push(`${exhausted.length} ticket${exhausted.length !== 1 ? "s" : ""} exhausted max retries`);
    if (retryable.length > 0)
      parts.push(`${retryable.length} ticket${retryable.length !== 1 ? "s" : ""} with failed charge`);

    const overallStatus = exhausted.length > 0 ? "error" : "warning";
    return check(
      "Ticket Charge Health",
      overallStatus,
      parts.join("; ") + ".",
      items,
      "Open the Tickets page to review failed charges and retry them manually.",
    );
  } catch (err) {
    console.error("[v2-system-health] ticketChargeHealth exception:", err);
    return check("Ticket Charge Health", "error", "Unexpected error: " + err.message);
  }
}

// Check 11 — Renter document coverage missing
// Surfaces paid/active bookings where required renter verification artifacts are
// missing based on the booking flow:
//   • Car flow: valid if either (front+back ID pair) OR (insurance-only doc)
//               OR Stripe Identity session is present.
//
// Only bookings with statuses where manual action is still possible are checked.
// Completed/cancelled bookings are excluded.  Bookings older than 90 days are
// also excluded to keep the list actionable.
//
// Status: warning — missing IDs are a compliance risk but not a financial error.
// Fixable: false  — IDs must be collected from the renter manually.
//
// Linked with the previous task that ensures:
//   • Owner attachment priority = ID front → ID back → agreement → insurance
//   • email_sent is only marked when required docs were actually attached
async function checkRenterIdDocuments(sb, scope = null) {
  try {
    // Paid/active statuses where manual ID collection is still possible.
    const PAID_ACTIVE_STATUSES = [
      "booked_paid", "active_rental", "active", "approved",
      "reserved", "reserved_unpaid", "pending_verification",
    ];

    // Limit to bookings created in the last 90 days so the list stays actionable.
    const cutoff90Days = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const { data: paidBookings, error: bErr } = await sb
      .from("bookings")
      .select("id, booking_ref, status, vehicle_id, pickup_date, customer_name, category, identity_session_id")
      .in("status", PAID_ACTIVE_STATUSES)
      .gte("created_at", cutoff90Days)
      .limit(300);

    if (bErr) {
      console.error("[v2-system-health] renterIdDocuments query error:", bErr.message);
      return check("Renter Verification Coverage", "error", "Could not query bookings: " + bErr.message);
    }

    const normalizedScope = normalizeScope(scope);
    const bookings = (paidBookings || []).filter((b) => {
      if (!normalizedScope) return true;
      return normalizedScope === "car" || normalizedScope === "cars";
    });
    if (bookings.length === 0) {
      return check("Renter Verification Coverage", "ok", "No active/upcoming bookings to check.");
    }

    const refs = bookings.map((b) => b.booking_ref).filter(Boolean);

    // Fetch pending_booking_docs for these bookings.
    const { data: docsRows, error: dErr } = await sb
      .from("pending_booking_docs")
      .select(
        "booking_id, id_base64, id_back_base64, id_filename, id_back_filename, " +
        "insurance_base64, insurance_filename, insurance_coverage_choice"
      )
      .in("booking_id", refs);

    if (dErr) {
      console.error("[v2-system-health] renterIdDocuments docs query error:", dErr.message);
      return check("Renter Verification Coverage", "error", "Could not query pending_booking_docs: " + dErr.message);
    }

    const normalizeBookingKey = (value) => (value == null ? "" : String(value).trim());

    const bookingDocKeys = [
      ...new Set(
        bookings
          .map((b) => b.id)
          .map(normalizeBookingKey)
          .filter(Boolean),
      ),
    ];

    const { data: bookingDocRows, error: bdErr } = bookingDocKeys.length
      ? await sb
          .from("booking_documents")
          .select("booking_id, type")
          .in("type", ["id_copy", "insurance"])
          .in("booking_id", bookingDocKeys)
      : { data: [], error: null };

    if (bdErr) {
      console.error("[v2-system-health] renterIdDocuments booking_documents query error:", bdErr.message);
      return check("Renter Verification Coverage", "error", "Could not query booking_documents: " + bdErr.message);
    }

    // Index docs by normalized booking_id.
    const docsByBooking = new Map();
    for (const d of docsRows || []) {
      const key = normalizeBookingKey(d?.booking_id);
      if (!key) continue;
      docsByBooking.set(key, d);
    }

    const idCopyCountByBooking = new Map();
    const insuranceDocCountByBooking = new Map();
    for (const d of bookingDocRows || []) {
      const key = normalizeBookingKey(d?.booking_id);
      if (!key) continue;
      const type = String(d?.type || "").trim().toLowerCase();
      if (type === "id_copy") {
        idCopyCountByBooking.set(key, (idCopyCountByBooking.get(key) || 0) + 1);
      } else if (type === "insurance") {
        insuranceDocCountByBooking.set(key, (insuranceDocCountByBooking.get(key) || 0) + 1);
      }
    }

    // Aggregate per booking: which IDs are missing?
    const affectedMap = new Map(); // booking_ref → { info, missing[] }

    for (const b of bookings) {
      const ref = b.booking_ref;
      if (!ref) continue;

      const bookingRefKey = normalizeBookingKey(b.booking_ref);
      const bookingIdKey = normalizeBookingKey(b.id);
      const doc = docsByBooking.get(bookingRefKey) || null;
      const idCopyCount = idCopyCountByBooking.get(bookingIdKey) || 0;
      const insuranceDocCount = insuranceDocCountByBooking.get(bookingIdKey) || 0;
      const hasPendingFront = !!doc?.id_base64 || !!doc?.id_filename;
      const hasPendingBack = !!doc?.id_back_base64 || !!doc?.id_back_filename;
      const hasPendingPair = hasPendingFront && hasPendingBack;
      const hasBookingDocPair = idCopyCount >= 2;
      const hasPendingInsurance = !!doc?.insurance_base64 || !!doc?.insurance_filename;
      const hasBookingDocInsurance = insuranceDocCount >= 1;
      const hasInsuranceCoverageChoice = String(doc?.insurance_coverage_choice || "").toLowerCase() === "yes";
      const hasInsuranceOnlyCoverage = hasInsuranceCoverageChoice && (hasPendingInsurance || hasBookingDocInsurance);
      const hasIdentitySession = !!String(b.identity_session_id || "").trim();
      const renterDisplay = b.customer_name || "?";
      const baseInfo = `status=${b.status} vehicle=${b.vehicle_id || "?"} pickup=${b.pickup_date || "?"} name=${renterDisplay}`;

      const missing = [];
      const hasValidCoverage = hasPendingPair || hasBookingDocPair || hasInsuranceOnlyCoverage || hasIdentitySession;
      if (!hasValidCoverage) {
        if (idCopyCount > 0) {
          missing.push(`${idCopyCount} of 2 required ID copies uploaded`);
        } else if (!doc) {
          missing.push("ID front + ID back or insurance document");
        } else if (hasPendingFront !== hasPendingBack) {
          if (!hasPendingFront) missing.push("ID front");
          if (!hasPendingBack) missing.push("ID back");
        } else if (hasInsuranceCoverageChoice && !hasPendingInsurance && !hasBookingDocInsurance) {
          missing.push("insurance document");
        } else {
          missing.push("ID front + ID back or insurance document");
        }
      } else if (hasPendingFront !== hasPendingBack) {
        // If ID uploads were attempted, enforce front/back pairing as data integrity.
        if (!hasPendingFront) missing.push("ID front");
        if (!hasPendingBack) missing.push("ID back");
      }

      if (missing.length > 0) {
        affectedMap.set(ref, { info: baseInfo, missing });
      }
    }

    if (affectedMap.size === 0) {
      return check(
        "Renter Verification Coverage",
        "ok",
        `All ${bookings.length} active/upcoming booking${bookings.length !== 1 ? "s" : ""} have required renter verification artifacts on file.`,
      );
    }

    const allItems = [...affectedMap.entries()].map(([ref, { info, missing }]) => ({
      id:   ref,
      info: `[MISSING: ${missing.join(", ")}] ${info}`,
    }));

    const totalAffected = affectedMap.size;
    console.error(
      `[v2-system-health] renterIdDocuments: ${totalAffected} booking(s) missing renter verification artifacts:`,
      [...affectedMap.keys()],
    );

    return check(
      "Renter Verification Coverage",
      "warning",
      `${totalAffected} booking${totalAffected !== 1 ? "s" : ""} missing renter verification artifacts.`,
      allItems,
      "Bookings require either front+back ID documents, an insurance-only submission, or a Stripe Identity verification session. For flagged bookings, collect or verify the missing artifact before pickup.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] renterIdDocuments exception:", err);
    return check("Renter Verification Coverage", "error", "Unexpected error: " + err.message);
  }
}

async function runAllChecks(sb, scope = null) {
  const checks    = {};
  const checkedAt = new Date().toISOString();

  await Promise.all([
    checkPaymentBookingRevenue(sb)    .then((r) => { checks.paymentBookingRevenue    = r; }),
    checkMissingAgreements(sb)        .then((r) => { checks.missingAgreements        = r; }),
    checkActiveRentalCount(sb)        .then((r) => { checks.activeRentalCount        = r; }),
    checkOrphanRevenue(sb)            .then((r) => { checks.orphanRevenue            = r; }),
    checkStaleReservations(sb)        .then((r) => { checks.staleReservations        = r; }),
    checkStripePaymentNoBooking(sb)   .then((r) => { checks.stripePaymentNoBooking   = r; }),
    checkExtensionReturnDateSync(sb)  .then((r) => { checks.extensionReturnDateSync  = r; }),
    checkSmsDeliveryHealth(sb)        .then((r) => { checks.smsDeliveryHealth        = r; }),
    checkAvailabilitySync(sb)         .then((r) => { checks.availabilitySyncHealth   = r; }),
    checkTicketChargeHealth(sb)       .then((r) => { checks.ticketChargeHealth        = r; }),
    checkRenterIdDocuments(sb, scope) .then((r) => { checks.renterIdDocuments         = r; }),
  ]);

  const statuses = Object.values(checks).map((c) => c.status);
  const overallStatus = statuses.includes("error")
    ? "error"
    : statuses.includes("warning")
    ? "warning"
    : "ok";

  return { checks, overallStatus, checkedAt };
}

// ── Fix actions ────────────────────────────────────────────────────────────

// Fix 1: create missing revenue records for paid bookings
async function fixPaymentBookingRevenue(sb) {
  // Use the same two-query strategy as checkPaymentBookingRevenue so that legacy
  // rows with NULL/partial payment_status are also repaired by Fix Now.
  const [byStatusResult, byDepositResult] = await Promise.all([
    sb.from("bookings")
      .select(
        "booking_ref, status, total_price, deposit_paid, payment_status, " +
        "payment_intent_id, payment_method, vehicle_id, pickup_date, return_date",
      )
      .eq("payment_status", "paid")
      .not("status", "in", '("cancelled","cancelled_rental")')
      .limit(500),
    sb.from("bookings")
      .select(
        "booking_ref, status, total_price, deposit_paid, payment_status, " +
        "payment_intent_id, payment_method, vehicle_id, pickup_date, return_date",
      )
      .gt("deposit_paid", 0)
      .not("status", "in", '("cancelled","cancelled_rental")')
      .in("status", ["booked_paid", "active_rental", "completed_rental", "completed", "active", "overdue"])
      .limit(500),
  ]);
  if (byStatusResult.error) throw new Error("Could not query bookings: " + byStatusResult.error.message);

  // Merge and deduplicate by booking_ref
  const seen = new Set();
  const paidBookings = [];
  for (const b of [...(byStatusResult.data || []), ...(byDepositResult.data || [])]) {
    if (b.booking_ref && !seen.has(b.booking_ref)) {
      seen.add(b.booking_ref);
      paidBookings.push(b);
    }
  }

  const refs = paidBookings.map((b) => b.booking_ref).filter(Boolean);
  if (refs.length === 0) return { fixed: 0, message: "No paid bookings found." };

  const { data: revRows, error: rErr } = await sb
    .from("revenue_records")
    .select("booking_id")
    .in("booking_id", refs);
  if (rErr) throw new Error("Could not query revenue_records: " + rErr.message);

  const revenueRefs = new Set((revRows || []).map((r) => r.booking_id));

  // Also check by payment_intent_id to detect revenue records (e.g. orphan records
  // created by stripe-reconcile with a "stripe-pi_xxx" booking_id) that already
  // cover the payment — these bookings are considered handled and excluded from the
  // missing list so Fix Now does not attempt a duplicate insert.
  const piIds = paidBookings.map((b) => b.payment_intent_id).filter(Boolean);
  let coveredByPI = new Set(); // payment_intent_ids already linked in revenue_records
  if (piIds.length > 0) {
    const { data: revByPI, error: piErr } = await sb
      .from("revenue_records")
      .select("payment_intent_id")
      .in("payment_intent_id", piIds);
    if (!piErr) {
      coveredByPI = new Set((revByPI || []).map((r) => r.payment_intent_id).filter(Boolean));
    }
  }

  // Also check via original_booking_id for manual extension fee records
  // (booking_id="ext-..." records where original_booking_id=<booking_ref>).
  const { data: revByOrigRef, error: origRefErr } = await sb
    .from("revenue_records")
    .select("original_booking_id")
    .in("original_booking_id", refs);
  if (!origRefErr) {
    for (const r of revByOrigRef || []) {
      if (r.original_booking_id) revenueRefs.add(r.original_booking_id);
    }
  }

  const missing = paidBookings.filter(
    (b) =>
      b.booking_ref &&
      !revenueRefs.has(b.booking_ref) &&
      !(b.payment_intent_id && coveredByPI.has(b.payment_intent_id)),
  );
  if (missing.length === 0) return { fixed: 0, message: "No missing revenue records found." };

  let fixed   = 0;
  let skipped = 0;
  const failures = [];

  for (const b of missing) {
    try {
      // Per-row idempotency guard — re-check immediately before inserting so
      // concurrent invocations (cron + manual) cannot create duplicate records.
      // This is a second check on top of the bulk revenueRefs filter above.
      const { data: existing, error: existErr } = await sb
        .from("revenue_records")
        .select("id")
        .eq("booking_id", b.booking_ref)
        .maybeSingle();
      if (existErr) {
        throw new Error(`pre-insert check failed for ${b.booking_ref}: ${existErr.message}`);
      }
      if (existing?.id) {
        // A record appeared between the bulk query and this insert — skip it.
        skipped++;
        console.log(`[v2-system-health] fix_revenue: skipped ${b.booking_ref} (record already exists)`);
        continue;
      }

      await autoCreateRevenueRecord({
        bookingId:       b.booking_ref,
        vehicleId:       b.vehicle_id,
        // Use deposit_paid as the actual collected amount (gross_amount in revenue_records).
        // Fall back to total_price only when deposit_paid is absent (e.g. very old rows).
        amountPaid:      Number(b.deposit_paid || b.total_price || 0),
        // totalPrice tracks the full rental cost for metadata; prefers total_price over
        // deposit_paid because partial deposits don't represent the full booking value.
        totalPrice:      Number(b.total_price || b.deposit_paid || 0),
        paymentIntentId: b.payment_intent_id || null,
        paymentMethod:   b.payment_method || "stripe",
        pickupDate:      b.pickup_date || null,
        returnDate:      b.return_date || null,
      }, { strict: false });
      fixed++;
      console.log(`[v2-system-health] fix_revenue: created revenue record for ${b.booking_ref}`);
    } catch (err) {
      failures.push({ id: b.booking_ref, error: err.message });
      console.error(`[v2-system-health] fix_revenue: failed for ${b.booking_ref}:`, err.message);
    }
  }

  return {
    fixed,
    failed: failures.length,
    failures,
    message: `Created ${fixed} revenue record${fixed !== 1 ? "s" : ""}${failures.length ? `, ${failures.length} failed` : ""}.`,
  };
}

// Fix 4: resolve orphan revenue records.
//
// Two-pass strategy reflecting the current data model:
//   Pass A — Un-orphan legacy false positives:
//     Clear is_orphan=true on any rental/extension records whose booking_id
//     already matches a real booking_ref.  These were incorrectly flagged by
//     old code that queried the non-existent bookings.booking_id column.
//   Pass B — Re-link or flag broken records:
//     For is_orphan=false records whose booking_id has no matching booking_ref:
//       • If a matching booking is found via payment_intent_id → update booking_id
//         to the correct booking_ref (re-link rather than orphan-flag).
//       • Otherwise → set is_orphan=true (genuine missing-booking situation).
async function fixOrphanRevenue(sb) {
  // ── Pass A: un-orphan stale false-positive records ─────────────────────────
  let unorphaned = 0;
  const { data: flaggedRows, error: fErr } = await sb
    .from("revenue_records")
    .select("id, booking_id")
    .eq("is_orphan", true)
    .eq("sync_excluded", false)
    .in("type", ["rental", "extension"])
    .not("booking_id", "is", null)
    .limit(500);
  if (fErr) throw new Error("Could not query is_orphan=true records: " + fErr.message);

  if (flaggedRows && flaggedRows.length > 0) {
    const flaggedIds = [...new Set(flaggedRows.map((r) => r.booking_id))];
    const { data: validFlagged, error: vErr } = await sb
      .from("bookings")
      .select("booking_ref")
      .in("booking_ref", flaggedIds);
    if (vErr) throw new Error("Could not verify flagged booking refs: " + vErr.message);

    const validFlaggedRefs = new Set((validFlagged || []).map((b) => b.booking_ref));
    const toUnorphan = flaggedRows.filter((r) => validFlaggedRefs.has(r.booking_id));
    if (toUnorphan.length > 0) {
      const { error: unorphanErr } = await sb
        .from("revenue_records")
        .update({ is_orphan: false })
        .in("id", toUnorphan.map((r) => r.id));
      if (unorphanErr) throw new Error("Could not clear stale orphan flags: " + unorphanErr.message);
      unorphaned = toUnorphan.length;
      console.log(`[v2-system-health] fix_orphans: cleared is_orphan on ${unorphaned} record(s) with valid booking_id`);
    }
  }

  // ── Pass B: re-link or flag records with no matching booking ───────────────
  const { data: orphanRows, error: oErr } = await sb
    .from("revenue_records")
    .select("id, booking_id, payment_intent_id")
    .eq("is_orphan", false)
    .eq("sync_excluded", false)
    .in("type", ["rental", "extension"])
    .limit(500);
  if (oErr) throw new Error("Could not query revenue_records: " + oErr.message);

  const rows       = orphanRows || [];
  const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter(Boolean))];
  if (bookingIds.length === 0) {
    const msg = unorphaned > 0
      ? `Cleared ${unorphaned} stale orphan flag${unorphaned !== 1 ? "s" : ""}. No new orphans found.`
      : "Nothing to fix.";
    return { fixed: 0, unorphaned, message: msg };
  }

  const { data: bookingRows, error: bErr } = await sb
    .from("bookings")
    .select("booking_ref")
    .in("booking_ref", bookingIds);
  if (bErr) throw new Error("Could not verify booking refs: " + bErr.message);

  const validRefs      = new Set((bookingRows || []).map((b) => b.booking_ref));
  const unlinkedRows   = rows.filter((r) => r.booking_id && !validRefs.has(r.booking_id));

  if (unlinkedRows.length === 0) {
    const msg = unorphaned > 0
      ? `Cleared ${unorphaned} stale orphan flag${unorphaned !== 1 ? "s" : ""}. No true orphans found.`
      : "No true orphans found.";
    return { fixed: 0, unorphaned, message: msg };
  }

  // For unlinked records that carry a payment_intent_id, try to find the booking
  // via bookings.payment_intent_id before flagging them as orphans.
  const piIds = [...new Set(unlinkedRows.map((r) => r.payment_intent_id).filter(Boolean))];
  const piToBookingRef = new Map(); // payment_intent_id → booking_ref
  if (piIds.length > 0) {
    const { data: bookingsByPI } = await sb
      .from("bookings")
      .select("booking_ref, payment_intent_id")
      .in("payment_intent_id", piIds);
    for (const b of bookingsByPI || []) {
      if (b.payment_intent_id && b.booking_ref) piToBookingRef.set(b.payment_intent_id, b.booking_ref);
    }
  }

  let relinked   = 0;
  const trueOrphans = [];

  for (const row of unlinkedRows) {
    const correctRef = row.payment_intent_id ? piToBookingRef.get(row.payment_intent_id) : null;
    if (correctRef) {
      // A booking with this PI exists — update booking_id to the correct booking_ref
      // (re-link) rather than flagging as orphan.
      const { error: relinkErr } = await sb
        .from("revenue_records")
        .update({ booking_id: correctRef })
        .eq("id", row.id);
      if (relinkErr) {
        console.error(`[v2-system-health] fix_orphans: relink failed for ${row.id}:`, relinkErr.message);
        trueOrphans.push(row); // fall through to orphan-flag on relink failure
      } else {
        relinked++;
        console.log(`[v2-system-health] fix_orphans: relinked revenue ${row.id} → booking_ref=${correctRef}`);
      }
    } else {
      trueOrphans.push(row);
    }
  }

  let fixed = 0;
  if (trueOrphans.length > 0) {
    const ids = trueOrphans.map((r) => r.id);
    const { error: updateErr } = await sb
      .from("revenue_records")
      .update({ is_orphan: true })
      .in("id", ids);
    if (updateErr) throw new Error("Could not flag orphans: " + updateErr.message);
    fixed = trueOrphans.length;
    console.log(`[v2-system-health] fix_orphans: flagged ${fixed} records as is_orphan=true`);
  }

  const parts = [];
  if (fixed > 0)      parts.push(`Flagged ${fixed} true orphan${fixed !== 1 ? "s" : ""}`);
  if (relinked > 0)   parts.push(`Relinked ${relinked} record${relinked !== 1 ? "s" : ""} via payment_intent_id`);
  if (unorphaned > 0) parts.push(`Cleared ${unorphaned} stale flag${unorphaned !== 1 ? "s" : ""}`);
  return {
    fixed,
    relinked,
    unorphaned,
    message: parts.join("; ") + ".",
  };
}

// Fix 5: cancel stale unpaid reservations older than 24 hours
async function fixStaleReservations(sb) {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const { data: staleRows, error: sErr } = await sb
    .from("bookings")
    .select("booking_ref, status")
    .in("payment_status", ["unpaid"])
    .in("status", ["pending", "reserved"])
    .lt("created_at", cutoff)
    .limit(100);
  if (sErr) throw new Error("Could not query stale reservations: " + sErr.message);

  const rows = staleRows || [];
  if (rows.length === 0) return { fixed: 0, message: "No stale reservations found." };

  const refs = rows.map((r) => r.booking_ref).filter(Boolean);
  const { error: updateErr } = await sb
    .from("bookings")
    .update({ status: "cancelled_rental" })
    .in("booking_ref", refs);
  if (updateErr) throw new Error("Could not cancel reservations: " + updateErr.message);

  console.log(`[v2-system-health] fix_stale: cancelled ${rows.length} stale reservations:`, refs);
  return {
    fixed: rows.length,
    message: `Cancelled ${rows.length} stale reservation${rows.length !== 1 ? "s" : ""}.`,
  };
}

// Fix 6: queue orphan-PI revenue records for booking reconstruction.
//
// Safety guards — reconstruction is ONLY queued when ALL of the following hold:
//   1. Stripe PaymentIntent status === "succeeded"
//   2. pi.metadata.booking_id is present
//   3. No booking with that booking_ref already exists in the DB
//
// Special case: when the booking already exists (guard 3 fails), the revenue
// record is a legacy false-positive orphan — is_orphan is cleared so it re-
// appears in financial reports and the health panel stops showing it as an error.
//
// If metadata is incomplete (guard 2 fails) → flag only, do NOT auto-repair.
// Idempotent: a booking that already exists is cleared but never reconstructed.
async function fixStripePaymentNoBooking(sb) {
  const cutoff60d = new Date(Date.now() - SIXTY_DAYS_MS).toISOString();

  const { data: rows, error: oErr } = await sb
    .from("revenue_records")
    .select("id, payment_intent_id, booking_id")
    .eq("is_orphan", true)
    .not("payment_intent_id", "is", null)
    .gte("created_at", cutoff60d)
    .limit(100);
  if (oErr) throw new Error("Could not query orphan revenue records: " + oErr.message);

  if (!rows || rows.length === 0) return { fixed: 0, message: "No unlinked Stripe payments found." };

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let queued             = 0;
  let unorphaned         = 0;
  let skippedNotSucceeded = 0;
  let skippedIncomplete  = 0;
  const failures         = [];

  for (const row of rows) {
    const piId = row.payment_intent_id;
    try {
      // Guard 1: PaymentIntent must have status "succeeded"
      let pi;
      try {
        pi = await stripe.paymentIntents.retrieve(piId);
      } catch (stripeErr) {
        failures.push({ id: piId, error: `Stripe retrieve failed: ${stripeErr.message}` });
        console.error(`[v2-system-health] fix_pi_no_booking: Stripe error for ${piId}:`, stripeErr.message);
        continue;
      }
      if (pi.status !== "succeeded") {
        skippedNotSucceeded++;
        console.log(`[v2-system-health] fix_pi_no_booking: skipped ${piId} (status=${pi.status})`);
        continue;
      }

      // Guard 2: metadata.booking_id must be present; fallback to PI-based booking lookup.
      // When Stripe metadata lacks booking_id (e.g. very old PIs or non-standard flows),
      // try to find the booking by matching payment_intent_id in the bookings table.
      let bookingRef = pi.metadata?.booking_id || null;
      if (!bookingRef) {
        const { data: bookingByPI, error: piLookupErr } = await sb
          .from("bookings")
          .select("booking_ref")
          .eq("payment_intent_id", piId)
          .maybeSingle();
        if (!piLookupErr && bookingByPI?.booking_ref) {
          bookingRef = bookingByPI.booking_ref;
          console.log(
            `[v2-system-health] fix_pi_no_booking: resolved booking_ref=${bookingRef} via payment_intent_id for ${piId}`,
          );
        }
      }
      if (!bookingRef) {
        skippedIncomplete++;
        console.warn(
          `[v2-system-health] fix_pi_no_booking: skipped ${piId} — metadata.booking_id missing and no booking found by PI`,
        );
        continue;
      }

      // Guard 3: check whether booking already exists in the bookings table.
      const { data: existing, error: bErr } = await sb
        .from("bookings")
        .select("booking_ref")
        .eq("booking_ref", bookingRef)
        .maybeSingle();
      if (bErr) {
        failures.push({ id: piId, error: `bookings lookup failed: ${bErr.message}` });
        console.error(`[v2-system-health] fix_pi_no_booking: bookings lookup error for ${piId}:`, bErr.message);
        continue;
      }

      if (existing?.booking_ref) {
        // Booking exists — this is a legacy false-positive orphan flag.  Clear it
        // so the revenue record re-appears in financial reports and the health
        // panel no longer surfaces it as an unlinked payment.
        // Also fix booking_id when it was absent or a synthetic "stripe-<pi>" placeholder
        // so that the revenue record is properly linked to the canonical booking_ref.
        const updateFields = { is_orphan: false };
        if (!row.booking_id || row.booking_id.startsWith("stripe-")) {
          updateFields.booking_id = existing.booking_ref;
        }
        const { error: clearErr } = await sb
          .from("revenue_records")
          .update(updateFields)
          .eq("id", row.id);
        if (clearErr) {
          failures.push({ id: piId, error: `is_orphan clear failed: ${clearErr.message}` });
          console.error(`[v2-system-health] fix_pi_no_booking: clear error for ${piId}:`, clearErr.message);
        } else {
          unorphaned++;
          console.log(
            `[v2-system-health] fix_pi_no_booking: cleared stale orphan flag for ${piId} (booking ${bookingRef} exists)`,
          );
        }
        continue;
      }

      // Booking does not exist — update the booking_id to the resolved ref (fixes any
      // synthetic "stripe-pi_xxx" key) and queue the revenue row for reconstruction by
      // revenue-self-heal.  The row is kept is_orphan=true so the DB trigger allows the
      // booking_id update even though the booking doesn't exist yet.  Revenue-self-heal
      // will reconstruct the booking and then clear is_orphan=false.
      const queueFields = {};
      if (!row.booking_id || row.booking_id.startsWith("stripe-")) {
        queueFields.booking_id = bookingRef;
      }
      if (Object.keys(queueFields).length > 0) {
        const { error: prepErr } = await sb
          .from("revenue_records")
          .update(queueFields)
          .eq("id", row.id);
        if (prepErr) {
          failures.push({ id: piId, error: `revenue_records booking_id update failed: ${prepErr.message}` });
          console.error(`[v2-system-health] fix_pi_no_booking: prep error for ${piId}:`, prepErr.message);
          continue;
        }
      }

      queued++;
      console.log(
        `[v2-system-health] fix_pi_no_booking: queued ${piId} (booking_ref=${bookingRef}) for reconstruction`,
      );
    } catch (err) {
      failures.push({ id: piId, error: err.message });
      console.error(`[v2-system-health] fix_pi_no_booking: unexpected error for ${piId}:`, err.message);
    }
  }

  const parts = [];
  if (queued > 0)              parts.push(`${queued} queued for reconstruction`);
  if (unorphaned > 0)          parts.push(`${unorphaned} stale orphan flag${unorphaned !== 1 ? "s" : ""} cleared`);
  if (skippedIncomplete > 0)   parts.push(`${skippedIncomplete} flagged (incomplete metadata)`);
  if (skippedNotSucceeded > 0) parts.push(`${skippedNotSucceeded} not yet succeeded`);
  if (failures.length > 0)     parts.push(`${failures.length} failed`);

  return {
    fixed:               queued,
    unorphaned,
    skippedIncomplete,
    skippedNotSucceeded,
    failed:              failures.length,
    failures,
    message: parts.length ? parts.join(", ") + "." : "No eligible payments to reconstruct.",
  };
}

// Fix 5: re-send current missing-ID issue details to owner contacts on demand.
async function notifyMissingRenterIdDocuments(sb) {
  const idCheck = await checkRenterIdDocuments(sb);
  if (idCheck.status === "error") {
    throw new Error(idCheck.summary);
  }
  if (idCheck.status === "ok" || (idCheck.items || []).length === 0) {
    return {
      notified: 0,
      message: "No missing renter ID documents found.",
    };
  }

  const checkedAt = new Date().toISOString();
  await sendOwnerAlerts({ renterIdDocuments: idCheck }, "warning", checkedAt);

  return {
    notified: idCheck.items.length,
    message: `Sent admin alert for ${idCheck.items.length} booking${idCheck.items.length !== 1 ? "s" : ""} missing renter ID documents.`,
  };
}

// ── Alerting ───────────────────────────────────────────────────────────────

async function shouldSendAlert(sb) {
  try {
    const { data, error } = await sb
      .from("system_settings")
      .select("value")
      .eq("key", ALERT_COOLDOWN_KEY)
      .maybeSingle();
    if (error || !data?.value) return true;
    const lastSent = new Date(data.value).getTime();
    return Date.now() - lastSent > ALERT_COOLDOWN_MS;
  } catch {
    return true;
  }
}

async function recordAlertSent(sb) {
  try {
    await sb
      .from("system_settings")
      .upsert({ key: ALERT_COOLDOWN_KEY, value: new Date().toISOString() }, { onConflict: "key" });
  } catch (err) {
    console.error("[v2-system-health] recordAlertSent error:", err.message);
  }
}

async function sendOwnerAlerts(checks, overallStatus, checkedAt) {
  // Owner SMS and email notifications for system health are disabled.
  return;
  const issueChecks = Object.values(checks).filter((c) => c.status !== "ok");
  if (issueChecks.length === 0) return;

  const formattedTime = new Date(checkedAt).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
  });
  const subject =
    `[SLY RIDES] 🚨 System Health Alert — ${issueChecks.length} issue${issueChecks.length !== 1 ? "s" : ""} detected`;

  // Build SMS text
  const smsText =
    `[SLY RIDES] System Health ${overallStatus.toUpperCase()}: ` +
    issueChecks.map((c) => c.label).join(", ") +
    ` — https://admin.slycarrentals.com/admin-v2/`;

  // Build plain text body
  const plainText = [
    `System Health Alert — ${formattedTime}`,
    "",
    ...issueChecks.map((c) => {
      const icon = c.status === "error" ? "❌" : "⚠️";
      const topItems = (c.items || []).slice(0, 3)
        .map((i) => `  • ${i.id}: ${i.info}`)
        .join("\n");
      return `${icon} ${c.label}\n   ${c.summary}${topItems ? "\n" + topItems : ""}`;
    }),
    "",
    `Open admin panel: https://admin.slycarrentals.com/admin-v2/`,
  ].join("\n");

  // ── Email ──
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && OWNER_EMAIL) {
    try {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_PORT === "465",
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      const htmlRows = issueChecks.map((c) => {
        const icon  = c.status === "error" ? "❌" : "⚠️";
        const color = c.status === "error" ? "#dc2626" : "#d97706";
        const topItems = (c.items || []).slice(0, 5)
          .map(
            (i) =>
              `<li style="font-family:monospace;font-size:12px;margin:2px 0;">` +
              `<strong>${escHtml(i.id)}</strong> — ${escHtml(i.info)}</li>`,
          )
          .join("");
        return (
          `<tr>` +
          `<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;">` +
          `<strong style="color:${color}">${icon} ${escHtml(c.label)}</strong><br>` +
          `<span style="font-size:13px;color:#374151;">${escHtml(c.summary)}</span>` +
          (topItems ? `<ul style="margin:6px 0 0;padding-left:16px;">${topItems}</ul>` : "") +
          `</td></tr>`
        );
      }).join("");

      await transporter.sendMail({
        from:    `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
        to:      OWNER_EMAIL,
        subject,
        html: `<div style="font-family:sans-serif;max-width:640px;margin:0 auto;">
          <h2 style="color:#dc2626;margin-bottom:4px;">🚨 System Health Alert</h2>
          <p style="color:#6b7280;margin-top:0;">Detected at ${escHtml(formattedTime)} (LA time) — ` +
          `${issueChecks.length} issue${issueChecks.length !== 1 ? "s" : ""}</p>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          ${htmlRows}</table>
          <p style="margin-top:16px;">
            <a href="https://admin.slycarrentals.com/admin-v2/"
               style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;` +
               `text-decoration:none;border-radius:6px;font-weight:600;">🩺 Open Admin Panel</a>
          </p>
          <p style="color:#9ca3af;font-size:12px;">
            This alert will not repeat for 1 hour. Alerts only fire when overallStatus is "error".
          </p></div>`,
        text: plainText,
      });
      console.log("[v2-system-health] owner alert email sent to", OWNER_EMAIL);
    } catch (err) {
      console.error("[v2-system-health] owner alert email error:", err.message);
    }
  }

  // ── SMS ──
  if (process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY && OWNER_PHONE) {
    try {
      const { sendSms } = await import("./_textmagic.js");
      await sendSms(OWNER_PHONE, smsText);
      console.log("[v2-system-health] owner alert SMS sent to", OWNER_PHONE);
    } catch (err) {
      console.error("[v2-system-health] owner alert SMS error:", err.message);
    }
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (maybeSkipScheduledAutomation(req, res, { endpoint: "v2-system-health" })) return;

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(500).json({ error: "Supabase not configured." });
  }

  // ── Authentication ─────────────────────────────────────────────────────────
  // Path A (Vercel Cron): GET  — or POST with Authorization: Bearer CRON_SECRET
  // Path B (Admin panel): POST with { secret: ADMIN_SECRET } in body
  const authHeader = req.headers.authorization || "";
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall =
    req.method === "GET" ||
    (cronSecret && authHeader === `Bearer ${cronSecret}`);

  let requestScope = null;

  if (!isCronCall) {
    // Admin-panel POST path
    if (!isAdminConfigured()) {
      return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
    }
    const { secret, action, scope } = req.body || {};
    requestScope = normalizeScope(scope);
    if (!isAdminAuthorized(secret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ── Dispatch fix actions ────────────────────────────────────────────────
    if (action && action.startsWith("fix_")) {
      const checkKey = action.slice(4);
      try {
        let result;
        if      (checkKey === "paymentBookingRevenue")  result = await fixPaymentBookingRevenue(sb);
        else if (checkKey === "orphanRevenue")          result = await fixOrphanRevenue(sb);
        else if (checkKey === "staleReservations")      result = await fixStaleReservations(sb);
        else if (checkKey === "stripePaymentNoBooking") result = await fixStripePaymentNoBooking(sb);
        else if (checkKey === "renterIdDocuments")      result = await notifyMissingRenterIdDocuments(sb);
        else return res.status(400).json({ error: `Unknown fix action: ${action}` });
        return res.status(200).json({ ok: true, action, ...result });
      } catch (err) {
        console.error(`[v2-system-health] fix action ${action} failed:`, err.message);
        return res.status(500).json({ ok: false, action, error: err.message });
      }
    }
  } else if (cronSecret && authHeader && authHeader !== `Bearer ${cronSecret}`) {
    // CRON_SECRET is configured but header doesn't match — reject
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Run all checks ─────────────────────────────────────────────────────────
  const { checks, overallStatus, checkedAt } = await runAllChecks(sb, requestScope);

  // ── Cron mode extras: auto-repair + alert ──────────────────────────────────
  if (isCronCall) {
    const autoRepairResults = {};

    const autoRepairMap = {
      paymentBookingRevenue:  fixPaymentBookingRevenue,
      orphanRevenue:          fixOrphanRevenue,
      staleReservations:      fixStaleReservations,
      stripePaymentNoBooking: fixStripePaymentNoBooking,
      availabilitySyncHealth: runAvailabilitySyncFix,
    };

    // Map each repairable key back to its check function so we can re-run only
    // the affected checks after repairs — this ensures the alert decision is
    // based on post-repair state, not the stale pre-repair snapshot.
    const recheckMap = {
      paymentBookingRevenue:  () => checkPaymentBookingRevenue(sb),
      orphanRevenue:          () => checkOrphanRevenue(sb),
      staleReservations:      () => checkStaleReservations(sb),
      stripePaymentNoBooking: () => checkStripePaymentNoBooking(sb),
      availabilitySyncHealth: () => checkAvailabilitySync(sb),
    };

    const repairedKeys = [];
    for (const [key, fixFn] of Object.entries(autoRepairMap)) {
      if (checks[key]?.status === "error" && checks[key]?.fixable) {
        try {
          autoRepairResults[key] = await fixFn(sb);
          repairedKeys.push(key);
        } catch (err) {
          autoRepairResults[key] = { error: err.message };
          console.error(`[v2-system-health] cron auto-repair ${key} failed:`, err.message);
        }
      }
    }

    // Re-run the checks that had a repair attempt so the alert reflects whether
    // the issue was actually resolved.  Alerts that auto-repair fixed won't fire;
    // only genuinely persistent errors will trigger an owner notification.
    if (repairedKeys.length > 0) {
      await Promise.all(
        repairedKeys.map(async (key) => {
          try {
            checks[key] = await recheckMap[key]();
          } catch (err) {
            console.error(`[v2-system-health] post-repair recheck ${key} failed:`, err.message);
          }
        }),
      );
    }

    // Recompute overallStatus from the (possibly updated) check results.
    const updatedStatuses = Object.values(checks).map((c) => c.status);
    const alertStatus = updatedStatuses.includes("error")
      ? "error"
      : updatedStatuses.includes("warning")
      ? "warning"
      : "ok";

    if (alertStatus === "error") {
      const canAlert = await shouldSendAlert(sb);
      if (canAlert) {
        await sendOwnerAlerts(checks, alertStatus, checkedAt);
        await recordAlertSent(sb);
      }
    }

    return res.status(200).json({ checks, overallStatus: alertStatus, checkedAt, autoRepair: autoRepairResults });
  }

  return res.status(200).json({ checks, overallStatus, checkedAt });
}
