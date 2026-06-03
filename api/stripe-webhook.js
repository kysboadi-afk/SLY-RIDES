// api/stripe-webhook.js
// Vercel serverless function — Stripe webhook handler.
//
// Handles Stripe webhook deliveries for the Vercel-owned production endpoint.
// The primary booking/revenue recovery trigger is payment_intent.succeeded;
// additional branches handle payment_intent.payment_failed,
// payment_intent.canceled, and charge.refunded.
// This is the server-side authoritative fallback for booking/revenue
// automation — it runs even if the user closes the browser before
// success.html completes.
//
// Required environment variables (set in Vercel dashboard):
//   STRIPE_SECRET_KEY      — starts with sk_live_ or sk_test_
//   STRIPE_WEBHOOK_SECRET  — whsec_... from the Stripe dashboard
//     (Stripe CLI for local testing: stripe listen --forward-to localhost:3000/api/stripe-webhook)
//
// Register this endpoint in the Stripe dashboard:
//   Developers → Webhooks → Add endpoint
//   URL: https://sly-rides.vercel.app/api/stripe-webhook
//   Events:
//     - payment_intent.succeeded
//     - payment_intent.payment_failed
//     - payment_intent.canceled
//     - charge.refunded
//
// NOTE: checkout.session.completed is not handled in this file. Recovery and
// production validation should treat payment_intent.succeeded as the canonical
// booking/revenue automation event for this codebase.

import Stripe from "stripe";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { normalizePhone } from "./_bookings.js";
import { sendSms } from "./_textmagic.js";
import { render, BOOKING_CONFIRMED, MANAGE_BOOKING_ACCESS, BOOKING_ONBOARDING, PAYMENT_EDUCATION, RESERVATION_DEPOSIT_CONFIRMED, EXTEND_CONFIRMED_ECONOMY, LATE_FEE_APPLIED, POST_RENTAL_CHARGE } from "./_sms-templates.js";
import { hasOverlap } from "./_availability.js";
import { autoCreateRevenueRecord, createOrphanRevenueRecord, autoUpsertCustomer, autoUpsertBooking, autoCreateBlockedDate, extendBlockedDateForBooking, autoActivateIfPickupArrived, autoReleaseBlockedDateOnReturn, parseTime12h } from "./_booking-automation.js";
import { persistBooking } from "./_booking-pipeline.js";
import { CARS, computeRentalDays } from "./_pricing.js";
import { loadPricingSettings, computeBreakdownLinesFromSettings, computeCarAmountFromVehicleData, computeDppCostFromSettings, applyTax } from "./_settings.js";
import { generateRentalAgreementPdf } from "./_rental-agreement-pdf.js";
import { sendExtensionConfirmationEmails } from "./_extension-email.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { normalizeClockTime, DEFAULT_RETURN_TIME, formatTime12h } from "./_time.js";
import { buildUnifiedConfirmationEmail, buildDocumentNotes } from "./_booking-confirmation-template.js";
import { createManageToken } from "./_manage-booking-token.js";
import { getVehicleById } from "./_vehicles.js";
import { uiVehicleId, normalizeVehicleId } from "./_vehicle-id.js";
import { resolvePickupLocation } from "./_pickup-location.js";
import { sendDedupedSms } from "./_sms-log.js";
import { buildRenterPortalLinks } from "./_sms-links.js";
import { appendCustomerLedgerShadowEntry } from "./_customer-ledger.js";
import { addLedgerPayment, addLedgerRefund } from "./_renter-balance-ledger.js";
import { reconcilePaymentPlanPayment, computePaymentPlanProgress } from "./_payment-plan-reconcile.js";
import { CHECKOUT_PENDING_PREPAY_DB_STATUSES, toDbBookingStatus } from "./_booking-status.js";
import { upsertBookingPrewrite } from "./_booking-prewrite.js";
import { normalizeLifecycleEvent, buildLifecycleTemplateSequence, SMS_LIFECYCLE_EVENT } from "./_sms-lifecycle.js";
import { logWebhookOrgFallback } from "./_org-rollout-observability.js";
import { markBookingAgreementDelivery, upsertBookingAgreement, upsertBookingAgreementSignature } from "./_agreement-automation.js";
import {
  appendBookingTimelineEvent,
  canApplyBookingUpdateFromLifecycle,
  normalizeExtensionNotes,
  normalizeExtensionReason,
  upsertExtensionLifecycleRecord,
} from "./_extension-lifecycle.js";

// Disable Vercel's built-in body parser so we can pass the raw request body
// to stripe.webhooks.constructEvent() for signature verification.
export const config = {
  api: { bodyParser: false },
};

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
const FLEET_STATUS_PATH  = "fleet-status.json";
const MAX_ALERT_SMS_LENGTH = 900;
const MAX_OWNER_EMAIL_ATTACHMENT_BYTES = 12 * 1024 * 1024; // keep under common SMTP limits
const DEFAULT_ATTACHMENT_PRIORITY = 100;
// Pre-parsed default return time used when a booking has no return_time set.
const DEFAULT_RETURN_TIME_PG = parseTime12h(DEFAULT_RETURN_TIME);

/**
 * Read booked-dates.json from GitHub and block the given date range.
 * Mirrors the same logic used by send-reservation-email.js.
 * Time fields (fromTime, toTime) are stored alongside the date range so that
 * time-aware overlap checks (hasDateTimeOverlap) work correctly for same-day
 * back-to-back bookings and same-day return/pickup windows.
 */
async function blockBookedDates(_vehicleId, _from, _to, _fromTime = "", _toTime = "") {
  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  console.log("stripe-webhook: blockBookedDates() called but writes are disabled (Phase 4)");
}

/**
 * Previously wrote `available: false` to fleet-status.json on GitHub.
 * Availability is now derived automatically from the Supabase bookings table
 * by fleet-status.js — the booking record inserted during payment processing
 * is the single source of truth.  No manual flag write is needed.
 */
async function markVehicleUnavailable(vehicleId) {
  // No-op: availability is derived from bookings, not a manual flag.
  if (vehicleId) {
    console.log(`stripe-webhook: markVehicleUnavailable(${vehicleId}) — skipped, availability is now bookings-driven`);
  }
}

const OWNER_EMAIL = process.env.OWNER_EMAIL || process.env.SMTP_USER || "slyservices@supports-info.com";

/**
 * Escape HTML special characters to prevent XSS in email templates.
 */
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function estimateBase64Bytes(base64Value) {
  if (!base64Value || typeof base64Value !== "string") return 0;
  const normalized = base64Value.replace(/\s+/g, "").replace(/^data:.*;base64,/, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : (normalized.endsWith("=") ? 1 : 0);
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function estimateAttachmentBytes(att) {
  if (!att) return 0;
  if (Buffer.isBuffer(att.content)) return att.content.length;
  if (typeof att.content === "string") {
    if (att.encoding === "base64") return estimateBase64Bytes(att.content);
    return Buffer.byteLength(att.content, "utf8");
  }
  return 0;
}

function selectOwnerEmailAttachments(candidates, maxBytes) {
  const ordered = (Array.isArray(candidates) ? candidates : [])
    .map((c, idx) => {
      const p = Number.isFinite(Number(c?.priority)) ? Number(c.priority) : DEFAULT_ATTACHMENT_PRIORITY;
      return { ...c, _idx: idx, _priority: p };
    })
    .sort((a, b) => (a._priority - b._priority) || (a._idx - b._idx));
  const attachments = [];
  const omitted = [];
  let totalBytes = 0;
  for (const c of ordered) {
    const sizeBytes = estimateAttachmentBytes(c.attachment);
    if (totalBytes + sizeBytes > maxBytes) {
      omitted.push(c.label || c.attachment?.filename || "attachment");
      continue;
    }
    totalBytes += sizeBytes;
    attachments.push(c.attachment);
  }
  return { attachments, omitted, totalBytes };
}

function isLikelyAttachmentDeliveryError(err) {
  const responseCode = Number(err?.responseCode);
  if (responseCode === 552 || responseCode === 554) return true;
  const message = String(err?.message || err || "").toLowerCase();
  return /attachment|message too large|size limit|content too large|exceed|mime/.test(message);
}

function hasSucceededPaymentForNotifications(paymentIntent) {
  if (!paymentIntent || typeof paymentIntent !== "object") return false;
  const status = String(paymentIntent.status || "").toLowerCase();
  const receivedCents = Number(paymentIntent.amount_received ?? paymentIntent.amount ?? 0);
  return status === "succeeded" && Number.isFinite(receivedCents) && receivedCents > 0;
}

function buildLifecycleSmsBody(templateKey, ctx = {}) {
  const {
    customerName = "",
    vehicleName = "your vehicle",
    pickupDate = "",
    pickupTime = "",
    returnDate = "",
    returnTime = "",
    bookingType = "",
    bookingId = "",
    vehicleId = "",
    manageLink = "",
    paymentLink = "",
  } = ctx;
  switch (templateKey) {
    case "reservation_deposit_confirmed":
      return render(RESERVATION_DEPOSIT_CONFIRMED, {
        customer_name: sanitizeSmsValue(customerName),
        vehicle: sanitizeSmsValue(vehicleName),
        remaining_balance: Number(ctx.remainingBalance || 0).toFixed(2),
        payment_link: paymentLink,
      });
    case "booking_confirmed":
      return render(BOOKING_CONFIRMED, {
        customer_name: sanitizeSmsValue(customerName),
        vehicle: sanitizeSmsValue(vehicleName),
        pickup_date: pickupDate || "",
        pickup_time: pickupTime || "",
        return_date: returnDate || "",
        return_time_line: returnTime ? ` at ${formatTime12h(returnTime) || returnTime}\n` : "\n",
        location: resolvePickupLocation({
          bookingType,
          vehicleId,
          vehicleName,
        }),
      });
    case "manage_booking_access":
      return render(MANAGE_BOOKING_ACCESS, {
        customer_name: sanitizeSmsValue(customerName),
        booking_id: sanitizeSmsValue(bookingId || ""),
        manage_link: manageLink,
      });
    case "booking_onboarding":
      return render(BOOKING_ONBOARDING, {
        customer_name: sanitizeSmsValue(customerName),
        booking_id: sanitizeSmsValue(bookingId || ""),
        manage_link: manageLink,
      });
    case "payment_education":
      return render(PAYMENT_EDUCATION, {
        payment_link: paymentLink || manageLink,
      });
    default:
      return "";
  }
}

async function sendLifecycleSmsSequence({
  bookingId,
  phone,
  eventType,
  smsContext,
  source,
  paymentState,
}) {
  if (!phone || !bookingId) return;
  const sequence = buildLifecycleTemplateSequence(eventType);
  if (!sequence.length) return;
  for (const templateKey of sequence) {
    const body = buildLifecycleSmsBody(templateKey, smsContext);
    if (!body) continue;
    const sent = await sendDedupedSms({
      bookingId,
      templateKey,
      phone,
      body,
      metadata: {
        source,
        payment_state: paymentState || null,
        lifecycle_event: eventType,
      },
    });
    if (!sent) {
      console.log(`stripe-webhook: lifecycle SMS skipped (dedup) template=${templateKey} booking=${bookingId}`);
    }
  }
}

/**
 * Determines the booking status for a Stripe payment based on payment_type.
 * Deposit-only payment types leave the booking in "reserved_unpaid" since
 * the rental fee is still owed; all other payment types are fully paid.
 *
 * @param {string} paymentType - value of metadata.payment_type
 * @returns {"reserved_unpaid" | "booked_paid"}
 */
function resolveBookingStatus(paymentType) {
  // "reservation_deposit" = deposit-only (balance owed)
  return (paymentType === "reservation_deposit")
    ? "reserved_unpaid"
    : "booked_paid";
}

// A canonical vehicle ID is all-lowercase alphanumeric, starts with a letter,
// and is at least 2 characters long (e.g. "camry", "camry2012", "camry2013",
// "corolla2020").  No spaces, hyphens, or other special characters are allowed.
// This pattern replaces a hardcoded vehicle list so that new vehicles are
// supported automatically without code changes.
const CANONICAL_ID_PATTERN = /^[a-z][a-z0-9]+$/;

/**
 * Map Stripe PaymentIntent metadata to a canonical vehicle_id.
 *
 * Strategy (in priority order):
 *  1. Derive a candidate ID from metadata.vehicle_id by lowercasing and
 *     stripping non-alphanumeric characters.  If the result looks canonical
 *     (matches CANONICAL_ID_PATTERN) it is used as-is.
 *  2. If step 1 fails (vehicle_id absent or non-canonical), derive the ID from
 *     metadata.vehicle_name using generic normalization:
 *       - lowercase
 *       - replace non-alphanumeric chars with spaces
 *       - split into tokens
 *       - remove single-character tokens (strips variant designators such as
 *         normalizes vehicle name tokens)
 *       - join tokens without separator
 *
 * This is fully generic — no hardcoded model names.  New vehicles are handled
 * automatically as long as Stripe metadata carries either a canonical vehicle_id
 * or a human-readable vehicle_name following the pattern "<make> <year/variant>".
 *
 * Stripe checkout sessions should send canonical vehicle_id directly so
 * vehicle_id stays aligned between UI, Stripe metadata, and DB records.
 *
 * @param {object} metadata - PaymentIntent metadata
 * @returns {string} canonical vehicle_id
 * @throws {Error} when no mapping can be derived
 */
export function mapVehicleId(metadata = {}) {
  const rawId   = String(metadata.vehicle_id   || "").trim();
  const rawName = String(metadata.vehicle_name || "").trim();

  // Normalize vehicle_id: lowercase + strip non-alphanumeric characters.
  const normId = rawId.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Derive a candidate ID from vehicle_name using generic normalization:
  //   1. lowercase
  //   2. replace non-alphanumeric chars with spaces
  //   3. split into tokens
  //   4. skip single-letter tokens (removes trailing single letters from vehicle names)
  //   5. stop accumulating after the first numeric token (year/variant number)
  //      so trim-level suffixes like "SE" in "Camry 2013 SE" are dropped
  //   6. join without separator → "camry2012", "camry2013", "corolla2020"
  let nameId = "";
  if (rawName) {
    const allTokens = rawName.toLowerCase().replace(/[^a-z0-9]/g, " ").trim().split(/\s+/);
    const parts = [];
    for (const t of allTokens) {
      if (/^[a-z]$/.test(t)) continue; // skip single-letter tokens (e.g. "r")
      parts.push(t);
      if (/\d/.test(t)) break;         // stop after first numeric token (year)
    }
    if (parts.length > 0) nameId = parts.join("");
  }

  // ── Step 1: vehicle_id passthrough ──────────────────────────────────────────
  if (normId && CANONICAL_ID_PATTERN.test(normId)) {
    console.log("[VEHICLE_MAPPING]", {
      vehicle_name: rawName, vehicle_id_raw: rawId,
      normalized_id: normId, mapped_vehicle_id: normId,
      source: "canonical_passthrough", success: true,
    });
    return normId;
  }

  // ── Step 2: derive from vehicle_name ────────────────────────────────────────
  if (nameId && CANONICAL_ID_PATTERN.test(nameId)) {
    console.log("[VEHICLE_MAPPING]", {
      vehicle_name: rawName, vehicle_id_raw: rawId,
      normalized_name: nameId, mapped_vehicle_id: nameId,
      source: "name_mapping", success: true,
    });
    return nameId;
  }

  // ── Failure ──────────────────────────────────────────────────────────────────
  console.error("[VEHICLE_MAPPING]", {
    vehicle_name: rawName, vehicle_id_raw: rawId,
    normalized_id: normId, normalized_name: nameId,
    mapped_vehicle_id: null, success: false,
  });
  throw new Error(`Unknown vehicle mapping for vehicle_name="${rawName}" vehicle_id="${rawId}"`);
}

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

/**
 * Looks up a customer's UUID in the Supabase customers table by email first,
 * with phone fallback only when email is missing.
 * Returns null if not found or if Supabase is unavailable.
 *
 * @param {string} [phone] - normalised phone number
 * @param {string} [email] - email address
 * @returns {Promise<string|null>} customer UUID or null
 */
async function resolveCustomerIdFromSupabase(phone, email) {
  const sb = getSupabaseAdmin();
  if (!sb) return null;
  try {
    if (email && email.trim()) {
      const normalizedEmail = email.trim().toLowerCase();
      const { data } = await sb.from("customers").select("id").eq("email", normalizedEmail).maybeSingle();
      if (data?.id) return data.id;
    }
    if ((!email || !email.trim()) && phone && phone.trim()) {
      const { data } = await sb.from("customers").select("id").eq("phone", phone.trim()).maybeSingle();
      if (data?.id) return data.id;
    }
  } catch {
    // Non-fatal — extension record will be created without customer_id.
  }
  return null;
}

/**
 * Resolves a raw booking reference from Stripe PI metadata to the canonical
 * booking_ref confirmed to exist in Supabase bookings.
 * Returns the booking_ref when found, or null when not found (with a warning).
 * Falls back to the raw input on Supabase errors so the caller can decide.
 *
 * @param {string|null} rawRef - booking_id / original_booking_id from PI metadata
 * @returns {Promise<string|null>}
 */
async function resolveBookingId(rawRef) {
  if (!rawRef) return null;
  const sb = getSupabaseAdmin();
  if (!sb) return null; // Supabase unavailable — cannot validate
  try {
    const { data } = await sb
      .from("bookings")
      .select("booking_ref")
      .eq("booking_ref", rawRef)
      .maybeSingle();
    if (data?.booking_ref) return data.booking_ref;
    console.warn(`stripe-webhook: resolveBookingId — booking_ref "${rawRef}" not found in Supabase`);
    return null;
  } catch (err) {
    console.warn(`stripe-webhook: resolveBookingId lookup error (non-fatal): ${err.message}`);
    return null; // both lookup errors and not-found are treated as unresolvable for safety
  }
}

/**
 * Resolves a booking_ref by looking up the Supabase bookings table via
 * payment_intent_id.  Used as a fallback when the metadata booking_id is
 * absent or does not match any known booking (e.g. orphan PI created before
 * the booking row was inserted, or a replay where metadata was stripped).
 *
 * create-payment-intent.js links payment_intent_id to the booking row
 * immediately after PI creation, so this lookup is reliable for all PIs
 * created by the normal booking flow.
 *
 * @param {string} paymentIntentId - Stripe PaymentIntent ID (pi_...)
 * @returns {Promise<string|null>}
 */
async function resolveBookingIdByPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return null;
  const sb = getSupabaseAdmin();
  if (!sb) return null;
  try {
    const { data } = await sb
      .from("bookings")
      .select("booking_ref")
      .eq("payment_intent_id", paymentIntentId)
      .maybeSingle();
    if (data?.booking_ref) {
      console.log(`stripe-webhook: resolveBookingIdByPaymentIntent — found booking_ref "${data.booking_ref}" for PI ${paymentIntentId}`);
      return data.booking_ref;
    }
    console.warn(`stripe-webhook: resolveBookingIdByPaymentIntent — no booking found for PI ${paymentIntentId}`);
    return null;
  } catch (err) {
    console.warn(`stripe-webhook: resolveBookingIdByPaymentIntent lookup error (non-fatal): ${err.message}`);
    return null;
  }
}


async function bookingExistsInSupabase(bookingId, paymentIntentId) {
  const sb = getSupabaseAdmin();
  if (!sb) return false;
  if (!bookingId && !paymentIntentId) return false;
  try {
    if (bookingId) {
      const { data, error } = await sb
        .from("bookings")
        .select("id")
        .eq("booking_ref", bookingId)
        .maybeSingle();
      if (error) throw error;
      if (data?.id) return true;
    }
    if (paymentIntentId) {
      const { data, error } = await sb
        .from("bookings")
        .select("id")
        .eq("payment_intent_id", paymentIntentId)
        .maybeSingle();
      if (error) throw error;
      if (data?.id) return true;
    }
  } catch (err) {
    console.error("stripe-webhook: bookingExistsInSupabase lookup error:", formatSupabaseError(err));
  }
  return false;
}

async function revenueRecordCompleteInSupabase(bookingId, paymentIntentId) {
  const sb = getSupabaseAdmin();
  if (!sb) return false;
  if (!bookingId && !paymentIntentId) return false;
  try {
    let row = null;
    if (paymentIntentId) {
      const { data, error } = await sb
        .from("revenue_records")
        .select("id, gross_amount, stripe_fee, payment_intent_id")
        .eq("payment_intent_id", paymentIntentId)
        .maybeSingle();
      if (error) throw error;
      row = data || null;
    }
    if (!row && bookingId) {
      const { data, error } = await sb
        .from("revenue_records")
        .select("id, gross_amount, stripe_fee, payment_intent_id")
        .eq("booking_id", bookingId)
        .maybeSingle();
      if (error) throw error;
      row = data || null;
    }
    if (!row) return false;
    // stripe_fee may be null on initial write when Stripe fee expansion is
    // unavailable; stripe-reconcile backfills it later.
    return row.gross_amount != null &&
      !!row.payment_intent_id;
  } catch (err) {
    console.error("stripe-webhook: revenueRecordCompleteInSupabase lookup error:", formatSupabaseError(err));
    return false;
  }
}

async function resolveStripeFeeFields(stripe, paymentIntent) {
  const piId = paymentIntent?.id;
  if (!piId) throw new Error("missing paymentIntent.id for stripe fee lookup");

  const expanded = await stripe.paymentIntents.retrieve(piId, {
    expand: ["latest_charge.balance_transaction"],
  });
  const charge = expanded?.latest_charge;
  const bt = charge && typeof charge === "object" ? charge.balance_transaction : null;
  if (!bt || typeof bt !== "object") {
    throw new Error(`missing latest_charge.balance_transaction for PI ${piId}`);
  }
  const stripeFee = bt.fee != null ? Number(bt.fee) / 100 : null;
  const stripeNet = bt.net != null ? Number(bt.net) / 100 : null;
  if (!Number.isFinite(stripeFee) || stripeFee < 0) {
    throw new Error(`invalid stripe fee for PI ${piId}`);
  }
  return {
    stripeFee: Math.round(stripeFee * 100) / 100,
    stripeNet: Number.isFinite(stripeNet) ? (Math.round(stripeNet * 100) / 100) : null,
    // billing_details is a top-level field on the Charge object; no additional
    // expansion is needed beyond latest_charge.balance_transaction.
    billingPhone: charge?.billing_details?.phone || null,
  };
}

async function sendBookingPersistenceAlert(paymentIntent, reason, details = {}) {
  const alertLines = [
    "🚨 Stripe webhook booking persistence failure",
    `PaymentIntent: ${paymentIntent?.id || "<missing>"}`,
    `Reason: ${reason || "unknown"}`,
    `Vehicle: ${details.vehicle_id || "<missing>"}`,
    `Booking ID: ${details.booking_id || "<missing>"}`,
    `Pickup: ${details.pickup_date || "<missing>"}`,
    `Return: ${details.return_date || "<missing>"}`,
    `Attempts: ${details.attempts || 0}`,
  ];
  const alertText = alertLines.join("\n");
  console.error(alertText);

  if (process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY && process.env.OWNER_PHONE) {
    try {
      const ownerPhone = String(process.env.OWNER_PHONE || "").trim();
      if (!ownerPhone || !/\d/.test(ownerPhone)) {
        throw new Error("OWNER_PHONE has no digits");
      }
      await sendSms(normalizePhone(ownerPhone), alertText.slice(0, MAX_ALERT_SMS_LENGTH));
    } catch (smsErr) {
      console.error("stripe-webhook: booking persistence SMS alert failed:", smsErr.message);
    }
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    await transporter.sendMail({
      from: `"Sly Car Rentals Alerts" <${process.env.SMTP_USER}>`,
      to: OWNER_EMAIL,
      subject: `🚨 Booking persistence failed for ${paymentIntent?.id || "unknown PI"}`,
      text: alertText,
      html: `<pre style="font-family:monospace;white-space:pre-wrap">${esc(alertText)}</pre>`,
    });
  } catch (mailErr) {
    console.error("stripe-webhook: booking persistence email alert failed:", mailErr.message);
  }
}

/**
 * Save a booking record to bookings.json and Supabase from PaymentIntent metadata,
 * routing through the centralised booking pipeline (persistBooking) so every step
 * fires in the correct order — identical to manual bookings:
 *   customer upsert → booking upsert → revenue record → blocked_dates
 *
 * This is the guaranteed server-side path for every new booking — it fires on
 * every payment_intent.succeeded event, meaning bookings land in the admin
 * portal automatically without requiring the browser to complete success.html.
 * persistBooking() is idempotent: it deduplicates by paymentIntentId so a
 * double-save with the browser-side record is always safe.
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 */
async function saveWebhookBookingRecord(paymentIntent, extraFields = {}) {
  const meta = paymentIntent.metadata || {};
  const {
    booking_id,
    renter_name,
    renter_phone,
    vehicle_name,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    renter_email,
    email,
    payment_type,
    full_rental_amount,
    balance_at_pickup,
    protection_plan_tier,
  } = meta;

  let vehicleId = "";
  try {
    vehicleId = mapVehicleId(meta);
  } catch (mapErr) {
    const reason = `stripe-webhook: saveWebhookBookingRecord vehicle_id mapping failed for PI ${paymentIntent.id}: ${mapErr.message}`;
    await sendBookingPersistenceAlert(paymentIntent, reason, {
      booking_id,
      vehicle_id: meta.vehicle_id || "",
      vehicle_name: vehicle_name || "",
      pickup_date,
      return_date,
      attempts: 0,
    });
    throw new Error(reason);
  }

  if (!vehicleId) {
    throw new Error("Invalid vehicle_id mapping");
  }

  if (!pickup_date || !return_date) {
    const reason =
      `stripe-webhook: saveWebhookBookingRecord metadata missing for PI ${paymentIntent.id}` +
      ` vehicle_id=${vehicleId || "<missing>"} pickup_date=${pickup_date || "<missing>"} return_date=${return_date || "<missing>"}`;
    await sendBookingPersistenceAlert(paymentIntent, reason, {
      booking_id,
      vehicle_id: vehicleId,
      pickup_date,
      return_date,
      attempts: 0,
    });
    throw new Error(reason);
  }

  const amountPaid  = paymentIntent.amount ? Math.round(paymentIntent.amount) / 100 : 0;
  const totalPrice  = full_rental_amount ? Math.round(parseFloat(full_rental_amount) * 100) / 100 : amountPaid;

  // Derive the deposit actually collected: prefer amount_received from Stripe,
  // then fall back to full_rental_amount - balance_at_pickup from metadata.
  const paidFromStripe   = (paymentIntent.amount_received || 0) / 100;
  const paidFromMetadata =
    Number(full_rental_amount || 0) - Number(balance_at_pickup || 0);
  const depositPaidAmount = paidFromStripe > 0 ? paidFromStripe : paidFromMetadata;
  const isReservationDeposit = payment_type === "reservation_deposit";
  const status = isReservationDeposit ? "reserved" : resolveBookingStatus(payment_type);

  // Route through the centralised booking pipeline — same as manual bookings.
  // This ensures the correct order: customer upsert → booking upsert → revenue record → blocked_dates.
  const persistPayload = {
    bookingId:             booking_id || ("wh-" + crypto.randomBytes(8).toString("hex")),
    name:                  renter_name || "",
    phone: normalizePhone(
      renter_phone ||
      meta.renter_phone ||
      paymentIntent.customer_details?.phone ||
      extraFields.billingPhone ||
      ""
    ),
    email: String(
      renter_email ||
      email ||
      meta.email ||
      paymentIntent.customer_details?.email ||
      paymentIntent.receipt_email ||
      ""
    ),
    vehicleId,
    vehicleName:           vehicle_name || vehicleId,
    pickupDate:            pickup_date,
    pickupTime:            pickup_time  || "",
    returnDate:            return_date,
    returnTime:            return_time  || DEFAULT_RETURN_TIME,
    location:              resolvePickupLocation({
      bookingType: meta.booking_type,
      vehicleId,
      vehicleName: vehicle_name || vehicleId,
    }),
    status,
    amountPaid,
    totalPrice,
    paymentIntentId:       paymentIntent.id,
    paymentMethod:         "stripe",
    source:                "stripe_webhook",
    ...(isReservationDeposit ? { type: "reservation_deposit", paymentStatus: "partial" } : {}),
    // Only require a Stripe fee when we actually received fee data from the
    // balance_transaction lookup.  If fee resolution failed (transient Stripe
    // API error) we persist without it and let stripe-reconcile.js backfill.
    requireStripeFee:      extraFields.stripeFee != null,
    strictPersistence:     true,
    stripeCustomerId:      paymentIntent.customer          || null,
    stripePaymentMethodId: paymentIntent.payment_method    || null,
    ...(protection_plan_tier ? { protectionPlanTier: protection_plan_tier } : {}),
    ...extraFields,
  };
  console.log("[BOOKING_DATA]", persistPayload);

  // ── Explicit Supabase pre-write (BEFORE persistBooking) ──────────────────
  // Guarantee the booking row exists in Supabase before the full pipeline
  // runs.  This ensures Supabase is written first even if persistBooking()
  // later encounters a transient error on a subsequent step.
  {
    const sbPre = getSupabaseAdmin();
    if (!sbPre) {
      throw new Error(
        `stripe-webhook: Supabase admin client unavailable — cannot pre-write booking ${persistPayload.bookingId} for PI ${paymentIntent.id}`
      );
    }

    const isDepositPayment =
      paymentIntent.metadata?.payment_type === "reservation_deposit";

    const preWriteRecord = {
      booking_ref:               persistPayload.bookingId,
      vehicle_id:                normalizeVehicleId(vehicleId) || null,
      pickup_date:               pickup_date  || null,
      return_date:               return_date  || null,
      pickup_time:               parseTime12h(pickup_time  || "") || null,
      return_time:               parseTime12h(return_time  || "") || DEFAULT_RETURN_TIME_PG,
      // status='reserved' requires payment_status='partial' (DB constraint).
      // Full payment is immediately confirmed — no manual approval step needed.
      status:                    isDepositPayment ? "reserved" : "booked_paid",
      total_price:               totalPrice,
      deposit_paid:              depositPaidAmount,
      remaining_balance:         Math.max(0, totalPrice - depositPaidAmount),
      payment_status:            isDepositPayment ? "partial" : "paid",
      payment_method:            "stripe",
      category:                  "car",
      payment_intent_id:         paymentIntent.id,
      stripe_customer_id:        persistPayload.stripeCustomerId        || null,
      stripe_payment_method_id:  persistPayload.stripePaymentMethodId   || null,
      customer_name:             persistPayload.name  || null,
      customer_email:            persistPayload.email || null,
      customer_phone:            persistPayload.phone || null,
      renter_phone:              persistPayload.phone || null,
    };

    const { data: preWriteData, error: preWriteError, attemptedRow } = await upsertBookingPrewrite(sbPre, preWriteRecord, {
      select: "booking_ref",
      context: "STRIPE_WEBHOOK_PREWRITE",
    });

    if (preWriteError) {
      throw new Error(
        `stripe-webhook: Supabase pre-write failed for PI ${paymentIntent.id} bookingId=${persistPayload.bookingId}: ${preWriteError.message}`
      );
    }

    if (!preWriteData || preWriteData.length === 0) {
      console.warn(
        `stripe-webhook: Supabase pre-write returned no rows for PI ${paymentIntent.id} bookingId=${persistPayload.bookingId} — row may not have been affected`
      );
    } else {
      console.log(
        `stripe-webhook: Supabase pre-write succeeded for PI ${paymentIntent.id} bookingId=${persistPayload.bookingId}`
      );
      if (attemptedRow && !Object.prototype.hasOwnProperty.call(attemptedRow, "category")) {
        console.warn(`stripe-webhook: booking ${persistPayload.bookingId} saved without category due to legacy schema compatibility mode`);
      }
    }
  }

  let result = null;
  let supabaseExists = false;
  let revenueComplete = false;
  let lastPersistError = null;
  const envAttempts = parseInt(process.env.WEBHOOK_BOOKING_RETRY_ATTEMPTS || "", 10);
  const maxAttempts = Number.isFinite(envAttempts) && envAttempts > 0 ? envAttempts : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await persistBooking(persistPayload);
      lastPersistError = null;
    } catch (err) {
      lastPersistError = err;
      result = {
        ok: false,
        bookingId: persistPayload.bookingId,
        booking: persistPayload,
        errors: [err.message],
      };
    }
    supabaseExists = await bookingExistsInSupabase(persistPayload.bookingId, paymentIntent.id);
    revenueComplete = await revenueRecordCompleteInSupabase(persistPayload.bookingId, paymentIntent.id);

    if (supabaseExists && revenueComplete) {
      if (!result.ok) {
        console.warn(
          `stripe-webhook: PI ${paymentIntent.id} persisted after recovery attempt ${attempt}; initial errors: ${result.errors.join("; ")}`
        );
      } else {
        console.log(`stripe-webhook: booking pipeline succeeded for PI ${paymentIntent.id} (${vehicleId}) bookingId=${persistPayload.bookingId}`);
      }
      console.log("[BOOKING_CREATED]", {
        booking_ref: persistPayload.bookingId,
        payment_intent_id: paymentIntent.id,
        vehicle_id: vehicleId,
        start: pickup_date,
        end: return_date,
      });
      break;
    }

    console.error(
      `stripe-webhook: booking persistence verification failed for PI ${paymentIntent.id} attempt=${attempt} ` +
      `supabaseExists=${supabaseExists} revenueComplete=${revenueComplete} ` +
      `errors=${(result.errors || []).join("; ")}`,
      lastPersistError || ""
    );
  }

  if (!supabaseExists || !revenueComplete) {
    const failureReason =
      `stripe-webhook: booking persistence guarantee failed for PI ${paymentIntent.id} ` +
      `(supabaseExists=${supabaseExists} revenueComplete=${revenueComplete})`;
    await sendBookingPersistenceAlert(paymentIntent, failureReason, {
      booking_id: persistPayload.bookingId,
      vehicle_id: vehicleId,
      pickup_date,
      return_date,
      attempts: maxAttempts,
    });
    throw new Error(`${failureReason}${lastPersistError ? ` lastPersistError=${lastPersistError.message}` : ""}`);
  }

  // If the booking is fully paid and the pickup time has already arrived
  // (e.g. same-day rental), immediately transition to active_rental without
  // waiting for the next 15-minute cron cycle.
  if (result?.booking?.status === "booked_paid") {
    try {
      await autoActivateIfPickupArrived(result.booking);
    } catch (err) {
      console.error("stripe-webhook: autoActivateIfPickupArrived error (non-fatal):", err.message);
    }
  }

  return { bookingId: persistPayload.bookingId };
}

/**
 * Send a server-side fallback notification email to the owner and customer
 * using data extracted from the PaymentIntent metadata.
 *
 * This is the guaranteed backup path that fires even when the customer's
 * browser loses sessionStorage during a 3DS redirect and never calls
 * send-reservation-email.js.
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 */
async function sendWebhookNotificationEmails(paymentIntent) {
  if (!hasSucceededPaymentForNotifications(paymentIntent)) {
    console.warn(
      `stripe-webhook: skipping notification emails for PI ${paymentIntent?.id || "<missing>"} ` +
      `because payment is not in succeeded state`
    );
    return;
  }

  const meta = paymentIntent.metadata || {};
  const diagBookingId = meta.booking_id || paymentIntent.id || "unknown";
  console.log(`stripe-webhook: OWNER EMAIL TRIGGERED for booking_id: ${diagBookingId} pi_id: ${paymentIntent.id}`);
  console.log(`stripe-webhook: SMTP config — host=${process.env.SMTP_HOST || "(not set)"} user=${process.env.SMTP_USER || "(not set)"} pass=${process.env.SMTP_PASS ? "(set)" : "(not set)"}`);
  console.log(`stripe-webhook: OWNER_EMAIL resolves to: ${OWNER_EMAIL}`);

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("stripe-webhook: SMTP not configured — skipping fallback email");
    return;
  }
  const {
    booking_id,
    renter_name,
    renter_phone,
    vehicle_id,
    vehicle_name,
    vehicle_vin: meta_vehicle_vin,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    email,
    payment_type,
    full_rental_amount,
    balance_at_pickup,
    protection_plan_tier,
  } = meta;

  const amountNumber = paymentIntent.amount ? (paymentIntent.amount / 100) : NaN;
  const amountDollars = Number.isFinite(amountNumber) ? amountNumber.toFixed(2) : "N/A";
  const isDepositMode = payment_type === "reservation_deposit";

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // ── Retrieve pre-stored booking docs (signature, ID, insurance) ───────────
  // These are saved by the booking page (car.js → store-booking-docs.js)
  // before the Stripe payment is confirmed so the webhook can send the owner
  // the full email regardless of what happens in the customer's browser.
  //
  // Race-condition guard: the webhook can fire almost immediately after Stripe
  // confirms the payment, potentially before store-booking-docs has finished
  // its Supabase write.  Retry up to 3 times with a short delay so that a
  // Vercel cold-start or a slow DB write does not cause ID/insurance docs to
  // be silently omitted from the owner email.
  let storedDocs = null;
  if (booking_id) {
    const MAX_DOC_ATTEMPTS  = 4;
    const DOC_RETRY_DELAY_MS = 2500;
    for (let attempt = 1; attempt <= MAX_DOC_ATTEMPTS; attempt++) {
      try {
        const sb = getSupabaseAdmin();
        if (!sb) break;
        // Note: the query intentionally omits .eq("email_sent", false) so that a
        // row where email_sent=true can be detected and used for the dedup early-
        // return below.  A single round-trip is cheaper than two separate queries.
        const { data: docsRow } = await sb
          .from("pending_booking_docs")
          .select("*")
          .eq("booking_id", booking_id)
          .maybeSingle();

        if (docsRow?.email_sent === true) {
          // Owner email was already sent (e.g. from a previous webhook attempt on a
          // Stripe retry).  Skip to prevent duplicate owner notifications.
          console.log(`stripe-webhook: owner email already sent for booking_id ${booking_id} — skipping duplicate`);
          return;
        }

        if (docsRow) {
          storedDocs = docsRow;
          break; // row found — proceed with attachments
        }

        // Row not yet present — store-booking-docs may still be writing.
        if (attempt < MAX_DOC_ATTEMPTS) {
          console.log(`stripe-webhook: pending_booking_docs not found (attempt ${attempt}/${MAX_DOC_ATTEMPTS}) for booking_id ${booking_id} — retrying in ${DOC_RETRY_DELAY_MS}ms`);
          await new Promise(r => setTimeout(r, DOC_RETRY_DELAY_MS));
        } else {
          console.warn(`stripe-webhook: pending_booking_docs not found after ${MAX_DOC_ATTEMPTS} attempts for booking_id ${booking_id} — proceeding without stored docs`);
        }
      } catch (docsErr) {
        console.warn(`stripe-webhook: could not retrieve pending_booking_docs (attempt ${attempt}, non-fatal):`, docsErr.message);
        if (attempt < MAX_DOC_ATTEMPTS) {
          await new Promise(r => setTimeout(r, DOC_RETRY_DELAY_MS));
        }
      }
    }
  }

  // ── Build attachments from stored docs ────────────────────────────────────
  const ownerAttachmentCandidates = [];
  let resolvedVehicleMeta = {};
  let agreementPdfFilename = null;

  // Always generate the rental agreement PDF from payment-intent metadata.
  // Signature is included when available (storedDocs); the document is still
  // valid and attachable even when the frontend did not supply a signature.
  try {
    // Always call getVehicleById so Supabase-enriched metadata (VIN, make, etc.)
    // is included even for vehicles that are also in the static CARS list.
    const vehicleInfo = (await getVehicleById(vehicle_id).catch(() => null))
      || (vehicle_id && CARS[vehicle_id])
      || {};
    resolvedVehicleMeta = vehicleInfo;
    const rentalDays  = (pickup_date && return_date) ? computeRentalDays(pickup_date, return_date) : 0;
    const hasProtectionPlan = !!protection_plan_tier;

    const pdfBody = {
      vehicleId:   vehicle_id  || "",
      car:         vehicle_name || vehicleInfo.name || vehicle_id || "",
      vehicleMake:  vehicleInfo.make  || null,
      vehicleModel: vehicleInfo.model || null,
      vehicleYear:  vehicleInfo.year  || null,
      vehicleVin:   vehicleInfo.vin   || meta_vehicle_vin || null,
      vehicleColor: vehicleInfo.color || null,
      name:         renter_name || "",
      email:        email       || "",
      phone:        renter_phone || "",
      pickup:       pickup_date  || "",
      pickupTime:   pickup_time  || "",
      returnDate:   return_date  || "",
      returnTime:   return_time  || "",
      total:        full_rental_amount || amountDollars,
      deposit:      vehicleInfo.deposit || 0,
      days:         rentalDays,
      protectionPlan:     hasProtectionPlan,
      protectionPlanTier: protection_plan_tier || null,
      signature:          storedDocs?.signature || null,
      fullRentalCost:     full_rental_amount || null,
      balanceAtPickup:    balance_at_pickup  || null,
      insuranceCoverageChoice: storedDocs?.insurance_coverage_choice ||
        (hasProtectionPlan ? "no" : "yes"),
    };

    const pdfBuffer = await generateRentalAgreementPdf(pdfBody);
    const safeName  = (renter_name || "renter").replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    const safeDate  = (pickup_date || "booking").replace(/[^0-9-]/g, "");
    const pdfFilename = `rental-agreement-${safeName}-${safeDate}.pdf`;
    agreementPdfFilename = pdfFilename;
    ownerAttachmentCandidates.push({
      label: `Rental agreement (${pdfFilename})`,
      priority: 30,
      attachment: {
        filename:    pdfFilename,
        content:     pdfBuffer,
        contentType: "application/pdf",
      },
    });
    console.log(`stripe-webhook: rental agreement PDF generated for PI ${paymentIntent.id}`);

    // Upload to Supabase Storage and persist the path for future recovery.
    if (booking_id) {
      try {
        const sbPdf = getSupabaseAdmin();
        if (sbPdf) {
          const agreementVersion = 1;
          const storagePath = `bookings/${booking_id}/agreements/v${agreementVersion}/agreement.pdf`;
          const { error: uploadErr } = await sbPdf.storage
            .from("rental-agreements")
            .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });
          if (uploadErr) {
            console.warn("stripe-webhook: PDF storage upload failed (non-fatal):", uploadErr.message);
          } else {
            await sbPdf.from("pending_booking_docs").upsert(
              { booking_id, agreement_pdf_url: storagePath, email_sent: storedDocs?.email_sent ?? false },
              { onConflict: "booking_id" }
            );
            const agreementSnapshot = {
              ...pdfBody,
              booking_ref: booking_id,
              payment_intent_id: paymentIntent.id,
              agreement_generated_at: new Date().toISOString(),
            };
            await upsertBookingAgreement({
              sb: sbPdf,
              bookingRef: booking_id,
              templateKey: "rental_standard",
              agreementType: "rental_initial",
              status: storedDocs?.signature ? "issued" : "issued",
              payloadSnapshot: agreementSnapshot,
              pdfStoragePath: storagePath,
              pdfBuffer,
              createdBy: "api/stripe-webhook",
            });
            if (storedDocs?.signature) {
              await upsertBookingAgreementSignature({
                sb: sbPdf,
                bookingRef: booking_id,
                signatureText: storedDocs.signature,
                signerRole: "renter",
                signerName: renter_name || storedDocs.signature,
                signatureMethod: "typed_name",
                ipAddress: null,
                userAgent: null,
                identitySessionId: meta.identity_session_id || null,
                agreementStatusBeforeSign: "issued",
                transitionAgreementToSigned: true,
                payloadSnapshot: agreementSnapshot,
                createdBy: "api/stripe-webhook",
              });
            }
            console.log(`stripe-webhook: PDF stored at ${storagePath} for booking_id ${booking_id}`);
          }
        }
      } catch (storageErr) {
        console.warn("stripe-webhook: PDF storage/url persist failed (non-fatal):", storageErr.message);
      }
    }
  } catch (pdfErr) {
    console.error("stripe-webhook: PDF generation failed (non-fatal):", pdfErr.message);
  }

  // Attach renter's ID photo if available.
  if (storedDocs && storedDocs.id_base64 && storedDocs.id_filename) {
    try {
      ownerAttachmentCandidates.push({
        label: `ID front (${storedDocs.id_filename})`,
        priority: 10,
        attachment: {
          filename:    storedDocs.id_filename,
          content:     Buffer.from(storedDocs.id_base64, "base64"),
          contentType: storedDocs.id_mimetype || "application/octet-stream",
        },
      });
    } catch (idErr) {
      console.error("stripe-webhook: ID attachment failed (non-fatal):", idErr.message);
    }
  }

  // Attach renter's ID back photo if available.
  if (storedDocs && storedDocs.id_back_base64 && storedDocs.id_back_filename) {
    try {
      ownerAttachmentCandidates.push({
        label: `ID back (${storedDocs.id_back_filename})`,
        priority: 20,
        attachment: {
          filename:    storedDocs.id_back_filename,
          content:     Buffer.from(storedDocs.id_back_base64, "base64"),
          contentType: storedDocs.id_back_mimetype || "application/octet-stream",
        },
      });
    } catch (idBackErr) {
      console.error("stripe-webhook: ID back attachment failed (non-fatal):", idBackErr.message);
    }
  }

  // Attach insurance document if available.
  if (storedDocs && storedDocs.insurance_base64 && storedDocs.insurance_filename) {
    try {
      ownerAttachmentCandidates.push({
        label: `Insurance (${storedDocs.insurance_filename})`,
        priority: 40,
        attachment: {
          filename:    storedDocs.insurance_filename,
          content:     Buffer.from(storedDocs.insurance_base64, "base64"),
          contentType: storedDocs.insurance_mimetype || "application/octet-stream",
        },
      });
    } catch (insErr) {
      console.error("stripe-webhook: insurance attachment failed (non-fatal):", insErr.message);
    }
  }

  const { attachments, omitted: omittedAttachmentNotes } = selectOwnerEmailAttachments(
    ownerAttachmentCandidates,
    MAX_OWNER_EMAIL_ATTACHMENT_BYTES
  );
  const attachedOwnerFiles = new Set(attachments.map((a) => a.filename));
  const idFrontExpected = !!(storedDocs?.id_base64 && storedDocs?.id_filename);
  const idBackExpected = !!(storedDocs?.id_back_base64 && storedDocs?.id_back_filename);
  const idFrontAttached = !!(idFrontExpected && attachedOwnerFiles.has(storedDocs.id_filename));
  const idBackAttached = !!(idBackExpected && attachedOwnerFiles.has(storedDocs.id_back_filename));
  const agreementExpected = !!agreementPdfFilename;
  const agreementAttached = !!(agreementExpected && attachedOwnerFiles.has(agreementPdfFilename));
  const docsCompleteForDedupe = (!idFrontExpected || idFrontAttached) && (!idBackExpected || idBackAttached) && (!agreementExpected || agreementAttached);
  const hasFullDocs = attachments.length > 0;
  console.log(`stripe-webhook: attachments built for booking_id ${booking_id}: count=${attachments.length} files=[${attachments.map(a => a.filename).join(", ") || "none"}]`);
  const insuranceStatusMeta = String(meta.insurance_status || "").toLowerCase();
  const hasProtectionPlan = !!(
    protection_plan_tier ||
    meta.protection_plan === "true" ||
    insuranceStatusMeta === "no_insurance_dpp"
  );

  let breakdownLines = null;
  try {
    const isHourly = !!(vehicle_id && CARS[vehicle_id] && CARS[vehicle_id].hourlyTiers);
    if (!isHourly && vehicle_id && pickup_date && return_date) {
      const pricingSettings = await loadPricingSettings();
      const isKnownEconomy = (vehicle_id === "camry" || vehicle_id === "camry2013");
      const vehicleDataForBreakdown = !isKnownEconomy
        ? await getVehicleById(vehicle_id).catch(() => null)
        : null;
      breakdownLines = computeBreakdownLinesFromSettings(
        vehicle_id,
        pickup_date,
        return_date,
        pricingSettings,
        hasProtectionPlan,
        protection_plan_tier || null,
        vehicleDataForBreakdown
      );
    }
  } catch (err) {
    console.warn("stripe-webhook: pricing breakdown generation failed (non-fatal):", err.message);
  }

  const insuranceStatus = storedDocs?.insurance_coverage_choice === "no"
    ? "No personal insurance provided (Damage Protection Plan or renter liability applies)"
    : (storedDocs?.insurance_coverage_choice === "yes"
        ? (storedDocs?.insurance_filename ? "Own insurance provided (document attached)" : "Own insurance selected (proof not uploaded)")
        : (hasProtectionPlan
            ? `Protection plan selected (${protection_plan_tier || "tier not specified"})`
            : "Not selected / No protection plan"));

  const missingItemNotes = buildDocumentNotes({
    idUploaded:        !!(storedDocs?.id_base64 && storedDocs?.id_back_base64),
    signatureUploaded: !!storedDocs?.signature,
    insuranceUploaded: !!storedDocs?.insurance_base64,
    insuranceExpected: storedDocs?.insurance_coverage_choice === "yes",
  });

  // ── Owner notification ────────────────────────────────────────────────────
  console.log(`stripe-webhook: entering owner email send block — to=${OWNER_EMAIL} booking_id=${booking_id || paymentIntent.id}`);
  const ownerEmail = buildUnifiedConfirmationEmail({
    audience:           "owner",
    bookingId:          booking_id || paymentIntent.id,
    vehicleName:        vehicle_name,
    vehicleId:          vehicle_id,
    vehicleMake:        resolvedVehicleMeta.make || null,
    vehicleModel:       resolvedVehicleMeta.model || null,
    vehicleYear:        resolvedVehicleMeta.year || null,
    vehicleVin:         resolvedVehicleMeta.vin || meta_vehicle_vin || null,
    vehicleColor:       resolvedVehicleMeta.color || null,
    renterName:         renter_name,
    renterEmail:        email,
    renterPhone:        renter_phone,
    pickupDate:         pickup_date,
    pickupTime:         pickup_time,
    returnDate:         return_date,
    returnTime:         return_time,
    amountPaid:         amountNumber,
    totalPrice:         Number(full_rental_amount || amountNumber),
    fullRentalCost:     full_rental_amount || null,
    balanceAtPickup:    balance_at_pickup || null,
    paymentMethodLabel: isDepositMode ? "Website (Stripe) — Reservation deposit" : "Website (Stripe)",
    insuranceStatus,
    pricingBreakdownLines: breakdownLines || [],
    missingItemNotes: [
      ...missingItemNotes,
      ...(omittedAttachmentNotes.length
        ? [
            `Attachments omitted due to email size limit: ${omittedAttachmentNotes.join(", ")}`,
            "Documents remain stored in pending_booking_docs and can be resent from admin.",
          ]
        : []),
      ...(attachments.length ? [`Attachments: ${attachments.map(a => a.filename).join(", ")}`] : []),
    ],
  });

  let ownerEmailSent = false;
  let customerEmailSent = false;
  try {
    await transporter.sendMail({
      from:        `"Sly Car Rentals LLC Bookings" <${process.env.SMTP_USER}>`,
      to:          OWNER_EMAIL,
      ...(email ? { replyTo: email } : {}),
      subject:     ownerEmail.subject,
      attachments: attachments,
      text:        ownerEmail.text,
      html:        ownerEmail.html,
    });
    ownerEmailSent = true;
    console.log(`stripe-webhook: owner email sent for PI ${paymentIntent.id} (hasFullDocs=${hasFullDocs})`);
  } catch (emailErr) {
    console.error("stripe-webhook: owner email failed:", emailErr);
    if (attachments.length > 0 && isLikelyAttachmentDeliveryError(emailErr)) {
      try {
        await transporter.sendMail({
          from:    `"Sly Car Rentals LLC Bookings" <${process.env.SMTP_USER}>`,
          to:      OWNER_EMAIL,
          ...(email ? { replyTo: email } : {}),
          subject: ownerEmail.subject,
          text: [
            ownerEmail.text,
            "",
            "⚠️ Documents could not be attached to this email due to an attachment delivery error.",
            "Booking documents remain stored server-side and can be resent from admin.",
          ].join("\n"),
          html: `
            ${ownerEmail.html}
            <p>⚠️ Documents could not be attached to this email due to an attachment delivery error. Booking documents remain stored server-side and can be resent from admin.</p>
          `,
        });
        ownerEmailSent = true;
        console.warn(`stripe-webhook: owner email sent without attachments for PI ${paymentIntent.id} after attachment delivery failure`);
      } catch (retryErr) {
        console.error("stripe-webhook: owner email retry without attachments failed:", retryErr);
      }
    }
  }

  // ── Mark docs as sent so the browser-side email skips duplicate sends ─────
  // Mark email_sent=true whenever the owner email actually succeeds.
  if (ownerEmailSent && booking_id) {
    try {
      const sb = getSupabaseAdmin();
      if (sb) {
        await sb
          .from("pending_booking_docs")
          .upsert({ booking_id, email_sent: true }, { onConflict: "booking_id" });
      }
    } catch (markErr) {
      console.warn("stripe-webhook: could not mark docs email_sent (non-fatal):", markErr.message);
    }
    if (!docsCompleteForDedupe) {
      console.warn(`stripe-webhook: owner email sent for booking_id ${booking_id} with omitted docs (idFrontExpected=${idFrontExpected} idFrontAttached=${idFrontAttached} idBackExpected=${idBackExpected} idBackAttached=${idBackAttached} agreementExpected=${agreementExpected} agreementAttached=${agreementAttached})`);
    }
  } else if (!ownerEmailSent && booking_id) {
    console.warn(`stripe-webhook: email_sent NOT marked for booking_id ${booking_id} because owner email send failed`);
  }

  // ── Customer confirmation ─────────────────────────────────────────────────
  if (email) {
    const customerEmail = buildUnifiedConfirmationEmail({
      audience:           "customer",
      bookingId:          booking_id || paymentIntent.id,
      vehicleName:        vehicle_name,
      vehicleId:          vehicle_id,
      renterName:         renter_name,
      renterEmail:        email,
      renterPhone:        renter_phone,
      pickupDate:         pickup_date,
      pickupTime:         pickup_time,
      returnDate:         return_date,
      returnTime:         return_time,
      amountPaid:         amountNumber,
      totalPrice:         Number(full_rental_amount || amountNumber),
      fullRentalCost:     full_rental_amount || null,
      balanceAtPickup:    balance_at_pickup || null,
      paymentMethodLabel: isDepositMode ? "Website (Stripe) — Reservation deposit" : "Website (Stripe)",
      insuranceStatus,
      pricingBreakdownLines: breakdownLines || [],
      missingItemNotes,
      firstName: renter_name ? renter_name.split(" ")[0] : "there",
    });
    try {
      await transporter.sendMail({
        from:    `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
        to:      email,
        subject: customerEmail.subject,
        text:    customerEmail.text,
        html:    customerEmail.html,
      });
      console.log(`stripe-webhook: customer email sent to ${email} for PI ${paymentIntent.id}`);
      customerEmailSent = true;
    } catch (custErr) {
      console.error("stripe-webhook: customer email failed:", custErr.message);
    }
  }

  if (booking_id) {
    try {
      const sbDelivery = getSupabaseAdmin();
      if (sbDelivery) {
        await markBookingAgreementDelivery({
          sb: sbDelivery,
          bookingRef: booking_id,
          ownerDeliveryStatus: ownerEmailSent ? "sent" : "failed",
          renterDeliveryStatus: email ? (customerEmailSent ? "sent" : "failed") : "skipped",
          sentAt: ownerEmailSent || customerEmailSent ? new Date().toISOString() : null,
          createdBy: "api/stripe-webhook",
        });
      }
    } catch (deliveryErr) {
      console.warn("stripe-webhook: agreement delivery tracking skipped (non-fatal):", deliveryErr?.message || deliveryErr);
    }
  }
}

/**
 * Unified Stripe payment processing pipeline.
 *
 * Guarantees that every payment_intent.succeeded event produces a revenue
 * record in Supabase, regardless of payment type.  Type-specific booking
 * creation/update logic runs in the type-specific handler branches before this
 * function is called; this function provides the shared revenue recording and
 * logging guarantee for the whole pipeline.
 *
 * Steps:
 *   1. Identify payment type from PaymentIntent metadata.
 *   2. Resolve the canonical booking_id (type-specific; booking updates already
 *      handled by the calling branch — this step only resolves the ID).
 *   3. Retrieve Stripe fee data and write an idempotent revenue record (ALWAYS).
 *   4. SMS notifications are handled by the type-specific callers above.
 *   5. Log outcome.
 *
 * autoCreateRevenueRecord is idempotent on payment_intent_id, so calling this
 * function even when a caller already recorded revenue is safe — the second
 * write is a no-op.
 *
 * @param {Stripe}  stripe              - Stripe SDK instance
 * @param {object}  paymentIntent       - Stripe PaymentIntent object
 * @param {object}  [opts]
 * @param {string}  [opts.bookingId]         - Pre-resolved booking_id (skips internal resolution)
 * @param {number}  [opts.preResolvedGross]  - Gross amount in dollars (skips PI expand when provided)
 * @param {number|null} [opts.preResolvedFee]  - Stripe fee in dollars (skips PI expand when provided)
 * @param {number|null} [opts.preResolvedNet]  - Net amount in dollars (skips PI expand when provided)
 */
async function processStripePayment(stripe, paymentIntent, opts = {}) {
  // Step 1 — Identify type
  const type = paymentIntent.metadata?.payment_type || paymentIntent.metadata?.type || "";
  console.log("[processStripePayment] start", {
    paymentIntentId: paymentIntent.id,
    type:            type || "<untyped>",
  });

  // Step 2 — Resolve booking_id
  // Resolution order (most → least specific):
  //   a. Caller-supplied bookingId (pre-resolved by the payment-type handler)
  //   b. metadata.booking_id / booking_ref / original_booking_id — looked up in bookings table
  //   c. payment_intent_id lookup — create-payment-intent.js links PI to booking row at PI
  //      creation time, so this resolves any case where metadata booking_id is missing
  //   d. saveWebhookBookingRecord auto-create (new-booking types only)
  //   e. Orphan revenue record (last resort — no booking found anywhere)
  let booking_id = opts.bookingId || null;

  if (!booking_id) {
    if (type === "rental_extension") {
      // DO NOT modify booking — already handled by the extension pipeline.
      const ref =
        paymentIntent.metadata?.booking_id ||
        paymentIntent.metadata?.original_booking_id;
      if (ref) booking_id = await resolveBookingId(ref);
    } else {
      // All other rental payment types embed the booking_id in metadata.
      const ref =
        paymentIntent.metadata?.booking_id ||
        paymentIntent.metadata?.booking_ref ||
        paymentIntent.metadata?.original_booking_id;
      if (ref) booking_id = (await resolveBookingId(ref)) || ref;
    }
  }

  // Fallback (c): look up by payment_intent_id.
  // create-payment-intent.js writes payment_intent_id to the booking row
  // immediately after PI creation, so this covers cases where booking_id
  // metadata is missing or stale (e.g. replay, 3DS redirect that lost session).
  if (!booking_id && paymentIntent.id) {
    booking_id = await resolveBookingIdByPaymentIntent(paymentIntent.id);
    if (booking_id) {
      console.log("[processStripePayment] booking_id resolved via payment_intent_id fallback", {
        paymentIntentId: paymentIntent.id,
        booking_id,
      });
    }
  }

  if (!booking_id) {
    // Recovery: for new-booking payment types, attempt to create the booking via
    // the full pipeline before giving up.  This guards against timing windows
    // where processStripePayment fires before the primary persistence path has
    // written the booking row.  saveWebhookBookingRecord / persistBooking are
    // idempotent (deduplicate by paymentIntentId), so this is a safe no-op when
    // the booking already exists.
    const isNewBookingType =
      !type || type === "full_payment" || type === "reservation_deposit";
    if (isNewBookingType) {
      console.warn("[processStripePayment] booking_id not resolved — attempting auto-create via saveWebhookBookingRecord", {
        paymentIntentId: paymentIntent.id,
        type: type || "<untyped>",
      });
      try {
        await saveWebhookBookingRecord(paymentIntent);
        // Retry booking lookup after creation — first by metadata ref, then by PI ID.
        const recRef =
          paymentIntent.metadata?.booking_id ||
          paymentIntent.metadata?.booking_ref ||
          paymentIntent.metadata?.original_booking_id;
        if (recRef) booking_id = (await resolveBookingId(recRef)) || recRef;
        if (!booking_id) booking_id = await resolveBookingIdByPaymentIntent(paymentIntent.id);
      } catch (recErr) {
        console.error("[processStripePayment] auto-create booking failed:", recErr.message, {
          paymentIntentId: paymentIntent.id,
          type: type || "<untyped>",
          vehicle_id: paymentIntent.metadata?.vehicle_id || "<missing>",
          booking_id: paymentIntent.metadata?.booking_id || "<missing>",
        });
      }
    }

    if (!booking_id) {
      // Last-resort fallback: record an orphan revenue row so no payment is ever
      // lost from the ledger.  The orphan can be manually linked to a booking later.
      console.error("[processStripePayment] booking_id not resolved after recovery — recording orphan revenue to preserve payment", {
        paymentIntentId: paymentIntent.id,
        type:            type || "<untyped>",
      });
      try {
        const orphanGross = opts.preResolvedGross ?? ((paymentIntent.amount_received || paymentIntent.amount || 0) / 100);
        let orphanVehicleId = paymentIntent.metadata?.vehicle_id || null;
        try { orphanVehicleId = mapVehicleId(paymentIntent.metadata || {}); } catch (mapErr) {
          console.warn("[processStripePayment] vehicle mapping failed for orphan revenue (using raw metadata value):", {
            rawVehicleId:  paymentIntent.metadata?.vehicle_id || null,
            vehicleName:   paymentIntent.metadata?.vehicle_name || null,
            error:         mapErr.message,
          });
        }
        await createOrphanRevenueRecord({
          paymentIntentId: paymentIntent.id,
          vehicleId:       orphanVehicleId,
          name:            paymentIntent.metadata?.renter_name || null,
          email:           paymentIntent.metadata?.renter_email || paymentIntent.metadata?.email || null,
          pickupDate:      paymentIntent.metadata?.pickup_date || null,
          returnDate:      paymentIntent.metadata?.return_date || null,
          amountPaid:      orphanGross,
          type:            type || "rental",
          notes:           `unresolved booking_ref — PI=${paymentIntent.id} type=${type || "<untyped>"}`,
          stripeFee:       opts.preResolvedFee ?? null,
          stripeNet:       opts.preResolvedNet ?? null,
        });
      } catch (orphanErr) {
        console.error("[processStripePayment] orphan revenue recording failed:", orphanErr.message, {
          paymentIntentId: paymentIntent.id,
        });
      }
      return;
    }
  }

  // Step 3 — ALWAYS record revenue.
  // Use pre-resolved fee data when supplied by the caller (avoids an extra
  // Stripe API round-trip for types that already ran resolveStripeFeeFields).
  // autoCreateRevenueRecord is idempotent on payment_intent_id, so a second
  // call for types that already recorded revenue is a safe no-op.
  let gross    = opts.preResolvedGross ?? ((paymentIntent.amount_received || paymentIntent.amount || 0) / 100);
  let stripeFee = opts.preResolvedFee  ?? null;
  let stripeNet = opts.preResolvedNet  ?? null;

  if (opts.preResolvedGross == null) {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntent.id, {
        expand: ["latest_charge.balance_transaction"],
      });
      const amountCents = pi.amount_received || pi.amount || 0;
      gross = amountCents / 100;
      const bt = pi.latest_charge?.balance_transaction;
      if (bt && typeof bt === "object") {
        stripeFee = bt.fee != null ? Number(bt.fee) / 100 : null;
        stripeNet = bt.net != null ? Number(bt.net) / 100 : null;
      }
    } catch (feeErr) {
      console.warn("[processStripePayment] Stripe fee lookup failed (non-fatal):", feeErr.message);
    }
  }

  // Normalise type: metadata uses "rental_extension" but the revenue_records
  // table convention (and existing callers) use "extension".
  // Similarly normalise balance payment variants to "rental_balance".
  const revenueType =
    type === "rental_extension"                                        ? "extension"      :
    type === "partial_balance" || type === "balance_payment"           ? "rental_balance" :
    (type || "rental");

  logWebhookOrgFallback({ endpoint: "stripe-webhook:processStripePayment", action: "create_revenue_record", table: "revenue_records", bookingRef: booking_id, paymentIntentId: paymentIntent.id });
  try {
    await autoCreateRevenueRecord(
      {
        bookingId:       booking_id,
        paymentIntentId: paymentIntent.id,
        type:            revenueType,
        amountPaid:      gross,
        stripeFee,
        stripeNet,
        paymentMethod:   "stripe",
      },
      { strict: false, requireStripeFee: false }
    );
  } catch (revErr) {
    console.error("[processStripePayment] revenue recording failed:", {
      paymentIntentId: paymentIntent.id,
      booking_id,
      type,
      error: revErr.message,
    });
    throw revErr;
  }

  // Step 4 — SMS notifications are handled by the type-specific callers above.

  // Step 4b — Phase C shadow-mode customer-ledger append (non-blocking).
  await appendStripePaymentToCustomerLedger({
    bookingRef: booking_id,
    paymentIntent,
    amountDollars: gross,
    paymentType: type || null,
  });

  // Step 5 — Logging
  console.log("[processStripePayment] complete", {
    paymentIntentId: paymentIntent.id,
    type:            type || "<untyped>",
    booking_id,
    gross,
    stripe_fee:      stripeFee,
    net_amount:      stripeNet,
  });
}

/**
 * Read the raw request body from a Node.js IncomingMessage stream.
 */
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function logPaymentIntentReceived(event, paymentIntent) {
  const meta = paymentIntent.metadata || {};
  // booking_id = new-booking PI flows; original_booking_id = extension/balance
  // flows that mutate an existing booking. We log whichever identifier is present.
  const bookingRef = meta.booking_id || meta.original_booking_id || "<missing>";
  console.log(
    `stripe-webhook: received payment_intent.succeeded` +
    ` event=${event.id || "unknown_event"}` +
    ` pi=${paymentIntent.id}` +
    ` payment_type=${meta.payment_type || "unspecified"}` +
    ` vehicle_id=${meta.vehicle_id || "<missing>"}` +
    ` pickup_date=${meta.pickup_date || "<missing>"}` +
    ` return_date=${meta.return_date || "<missing>"}` +
    ` booking_id=${bookingRef}`
  );
}

function logWebhookSkip(paymentIntent, reason) {
  const meta = paymentIntent.metadata || {};
  console.log(
    `stripe-webhook: skipped branch for PI ${paymentIntent.id}` +
    ` payment_type=${meta.payment_type || "unspecified"} reason=${reason}`
  );
}

function logWebhookRouting(paymentIntent, reason) {
  const meta = paymentIntent.metadata || {};
  console.log(
    `stripe-webhook: routing PI ${paymentIntent.id}` +
    ` payment_type=${meta.payment_type || "unspecified"} reason=${reason}`
  );
}

function normalizeCurrency(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function sanitizeSmsValue(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function buildVehicleExtendEntryLink(vehicleId) {
  const normalized = String(uiVehicleId(vehicleId || "") || "").trim();
  if (!normalized) return "https://slycarrentals.com/manage-booking.html";
  return `https://slycarrentals.com/car.html?vehicle=${encodeURIComponent(normalized)}&extend=1`;
}

function buildRenterOnboardingLink({ bookingId, vehicleId }) {
  const links = buildRenterPortalLinks({ bookingId, vehicleId });
  return links.primaryLink;
}

async function appendStripePaymentToCustomerLedger({ bookingRef, paymentIntent, amountDollars, paymentType }) {
  logWebhookOrgFallback({ endpoint: "stripe-webhook", action: "append_customer_ledger_payment", table: "customer_ledger", bookingRef, paymentIntentId: paymentIntent?.id });
  try {
    const sb = getSupabaseAdmin();
    if (!sb || !bookingRef || !paymentIntent?.id) return;

    const result = await appendCustomerLedgerShadowEntry(sb, {
      caller: "stripe-webhook:payment_intent.succeeded",
      bookingRef,
      transactionType: (paymentType === "balance_payment" || paymentType === "rental_balance" || paymentType === "partial_balance")
        ? "balance_payment"
        : "stripe_payment",
      direction: "credit",
      amountCents: Math.round(Number(amountDollars || 0) * 100),
      sourceType: "stripe_payment",
      sourceId: paymentIntent.id,
      description: `Stripe payment (${paymentType || "untyped"})`,
      metadata: {
        payment_intent_id: paymentIntent.id,
        payment_type: paymentType || null,
      },
      recordedBy: "stripe_webhook",
      fallbackIdentity: {
        stripeCustomerId: paymentIntent.customer || null,
        email: paymentIntent.metadata?.email || paymentIntent.metadata?.renter_email || null,
        phone: paymentIntent.metadata?.renter_phone || paymentIntent.customer_details?.phone || null,
      },
    });

    if (!result.written && !String(result.reason || "").startsWith("dual_write_disabled:")) {
      console.warn("[customer-ledger] payment append skipped (non-fatal):", {
        payment_intent_id: paymentIntent.id,
        booking_ref: bookingRef,
        reason: result.reason,
      });
    }
  } catch (err) {
    console.warn("[customer-ledger] payment append failed (non-fatal):", err.message);
  }
}

async function appendStripeRefundToCustomerLedger({ bookingRef, charge, amountDollars }) {
  logWebhookOrgFallback({ endpoint: "stripe-webhook", action: "append_customer_ledger_refund", table: "customer_ledger", bookingRef, paymentIntentId: typeof charge?.payment_intent === "string" ? charge.payment_intent : null });
  try {
    const sb = getSupabaseAdmin();
    if (!sb || !bookingRef || !charge?.id) return;

    const result = await appendCustomerLedgerShadowEntry(sb, {
      caller: "stripe-webhook:charge.refunded",
      bookingRef,
      transactionType: "stripe_refund",
      direction: "credit",
      amountCents: Math.round(Number(amountDollars || 0) * 100),
      sourceType: "stripe_refund",
      sourceId: charge.id,
      description: "Stripe charge refund",
      metadata: {
        charge_id: charge.id,
        payment_intent_id: typeof charge.payment_intent === "string" ? charge.payment_intent : null,
        amount_refunded_cents: charge.amount_refunded || 0,
      },
      recordedBy: "stripe_webhook",
      fallbackIdentity: {
        stripeCustomerId: charge.customer || null,
        email: charge.billing_details?.email || null,
        phone: charge.billing_details?.phone || null,
      },
    });

    if (!result.written && !String(result.reason || "").startsWith("dual_write_disabled:")) {
      console.warn("[customer-ledger] refund append skipped (non-fatal):", {
        charge_id: charge.id,
        booking_ref: bookingRef,
        reason: result.reason,
      });
    }
  } catch (err) {
    console.warn("[customer-ledger] refund append failed (non-fatal):", err.message);
  }
}

function buildReservationBalanceLink({ bookingId, paymentIntentId, meta, booking }) {
  const base = "https://slycarrentals.com/balance.html";
  const p = new URLSearchParams();
  const vehicleId = booking?.vehicleId || meta.vehicle_id || "";
  const pickup = booking?.pickupDate || meta.pickup_date || "";
  const returnDate = booking?.returnDate || meta.return_date || "";
  const email = booking?.email || meta.email || "";
  if (vehicleId) p.set("v", vehicleId);
  if (pickup) p.set("p", pickup);
  if (returnDate) p.set("r", returnDate);
  if (email) p.set("e", email);
  const name = booking?.name || meta.renter_name || "";
  if (name) p.set("n", name);
  const phone = booking?.phone || meta.renter_phone || "";
  if (phone) p.set("ph", phone);
  const pickupTime = booking?.pickupTime || meta.pickup_time || "";
  if (pickupTime) p.set("pt", pickupTime);
  const returnTime = booking?.returnTime || meta.return_time || "";
  if (returnTime) p.set("rt", returnTime);
  const vehicleName = booking?.vehicleName || meta.vehicle_name || vehicleId;
  if (vehicleName) p.set("car", vehicleName);
  if (meta.protection_plan_tier) p.set("pp", "1");
  if (bookingId) p.set("b", bookingId);
  if (paymentIntentId) p.set("opi", paymentIntentId);
  return `${base}?${p.toString()}`;
}

async function sendReservationDepositBalanceEmail({
  renterEmail, renterName, vehicleName, pickupDate, returnDate, depositPaid, remainingBalance, bookingId,
}) {
  if (!renterEmail || !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const firstName = (renterName || "").split(" ")[0] || "there";
  await transporter.sendMail({
    from: `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
    to: renterEmail,
    subject: "Your Reservation Deposit Was Received — Complete Remaining Balance",
    html: `
      <h2>✅ Reservation Deposit Received</h2>
      <p>Hi ${esc(firstName)},</p>
      <p>Your booking is reserved. Please complete the remaining balance before pickup.</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        ${bookingId ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #ddd"><code>${esc(bookingId)}</code></td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName || "")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDate || "")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate || "")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Deposit Paid</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(normalizeCurrency(depositPaid).toFixed(2))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Remaining Balance</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(normalizeCurrency(remainingBalance).toFixed(2))}</strong></td></tr>
      </table>
      <p>To view or manage your booking, visit <a href="https://slycarrentals.com/manage-booking.html">Manage Booking</a> and enter your phone number, email, or Booking ID.</p>
    `,
  });
}

async function sendReservationDepositBalanceOwnerEmail({
  renterName, renterEmail, renterPhone, vehicleName, bookingId, depositPaid, remainingBalance,
}) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: `"Sly Car Rentals LLC Bookings" <${process.env.SMTP_USER}>`,
    to: OWNER_EMAIL,
    ...(renterEmail ? { replyTo: renterEmail } : {}),
    subject: `🔒 Reservation Deposit Paid — ${esc(renterName || "Renter")}`,
    html: `
      <h2>🔒 Reservation Deposit Paid</h2>
      <p>A reservation deposit has been received.</p>
      <p><strong>Booking ID:</strong> ${esc(bookingId || "N/A")}<br>
      <strong>Renter:</strong> ${esc(renterName || "N/A")}<br>
      ${renterEmail ? `<strong>Email:</strong> ${esc(renterEmail)}<br>` : ""}
      ${renterPhone ? `<strong>Phone:</strong> ${esc(renterPhone)}<br>` : ""}
      <strong>Vehicle:</strong> ${esc(vehicleName || "N/A")}<br>
      <strong>Deposit Paid:</strong> $${esc(normalizeCurrency(depositPaid).toFixed(2))}<br>
      <strong>Remaining Balance:</strong> $${esc(normalizeCurrency(remainingBalance).toFixed(2))}</p>
      <p>Customer must complete website verification flow (Complete Booking) before paying balance.</p>
    `,
  });
}

async function buildUpdatedRentalAgreementAttachment({
  bookingId,
  paymentIntentId,
  vehicleId,
  vehicleName,
  renterName,
  renterEmail,
  renterPhone,
  pickupDate,
  pickupTime,
  returnDate,
  returnTime,
  totalPrice,
  amountPaid,
}) {
  if (!bookingId) return [];
  try {
    const sb = getSupabaseAdmin();
    if (!sb) return [];
    const { data: docsRow } = await sb
      .from("pending_booking_docs")
      .select("signature, insurance_coverage_choice")
      .eq("booking_id", bookingId)
      .maybeSingle();
    if (!docsRow?.signature) return [];

    const resolvedTotal = normalizeCurrency(totalPrice || amountPaid || 0);
    const rentalDays = pickupDate && returnDate ? computeRentalDays(pickupDate, returnDate) : 0;
    const pdfBuffer = await generateRentalAgreementPdf({
      vehicleId: vehicleId || "",
      car: vehicleName || vehicleId || "",
      name: renterName || "",
      email: renterEmail || "",
      phone: renterPhone || "",
      pickup: pickupDate || "",
      pickupTime: pickupTime || "",
      returnDate: returnDate || "",
      returnTime: returnTime || "",
      total: resolvedTotal.toFixed(2),
      // This document is sent after the balance-completion payment succeeds.
      // At this point the booking is fully paid, so no balance remains.
      deposit: 0,
      days: rentalDays,
      protectionPlan: false,
      protectionPlanTier: null,
      signature: docsRow.signature,
      fullRentalCost: resolvedTotal,
      balanceAtPickup: 0,
      insuranceCoverageChoice: docsRow.insurance_coverage_choice || "yes",
    });

    const safeBookingId = String(bookingId).replace(/[^a-zA-Z0-9_-]/g, "") || "booking";
    return [{
      filename: `updated-rental-agreement-${safeBookingId}.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf",
      cid: paymentIntentId ? `agreement-${paymentIntentId}` : undefined,
    }];
  } catch (err) {
    console.error("stripe-webhook: updated agreement PDF build failed (non-fatal):", err.message);
    return [];
  }
}

async function sendBalancePaidCustomerEmail({
  renterEmail, renterName, renterPhone, bookingId, paymentIntentId, vehicleId,
  vehicleName, pickupDate, pickupTime, returnDate, returnTime, amountPaid, totalPrice,
}) {
  if (!renterEmail || !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const firstName = (renterName || "").split(" ")[0] || "there";
  const agreementAttachment = await buildUpdatedRentalAgreementAttachment({
    bookingId,
    paymentIntentId,
    vehicleId,
    vehicleName,
    renterName,
    renterEmail,
    renterPhone,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
    totalPrice,
    amountPaid,
  });
  const customerMailOpts = {
    from: `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
    to: renterEmail,
    subject: "✅ Payment Received — Your Rental is Fully Booked!",
    attachments: agreementAttachment,
    html: `
      <h2>✅ Payment Received — You're All Set!</h2>
      <p>Hi ${esc(firstName)},</p>
      <p>Your remaining balance has been received. Your rental is fully booked and ready to go. See you at pickup!</p>
      ${agreementAttachment.length ? "<p>📄 Your updated rental agreement is attached for your records.</p>" : ""}
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName || "")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDate || "")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate || "")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Paid</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(normalizeCurrency(amountPaid).toFixed(2))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Total Paid</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(normalizeCurrency(totalPrice).toFixed(2))}</strong></td></tr>
      </table>
      <p>Questions? Call us at <strong>(844) 511-4059</strong> or visit <a href="https://slycarrentals.com">slytrans.com</a>.</p>
    `,
    text: [
      "✅ Payment Received — You're All Set!",
      "",
      `Hi ${firstName},`,
      "Your remaining balance has been received. Your rental is fully booked and ready to go.",
      ...(agreementAttachment.length ? ["Your updated rental agreement PDF is attached."] : []),
      "",
      `Vehicle      : ${vehicleName || ""}`,
      `Pickup Date  : ${pickupDate || ""}`,
      `Return Date  : ${returnDate || ""}`,
      `Balance Paid : $${normalizeCurrency(amountPaid).toFixed(2)}`,
      `Total Paid   : $${normalizeCurrency(totalPrice).toFixed(2)}`,
      "",
      "Questions? Call (844) 511-4059.",
    ].filter(Boolean).join("\n"),
  };
  try {
    await transporter.sendMail(customerMailOpts);
  } catch (customerErr) {
    console.error("stripe-webhook: balance_paid customer email failed:", customerErr.message);
    if (agreementAttachment.length > 0 && isLikelyAttachmentDeliveryError(customerErr)) {
      try {
        await transporter.sendMail({
          ...customerMailOpts,
          attachments: [],
          html: `
            ${customerMailOpts.html}
            <p>⚠️ Your updated rental agreement could not be attached due to an attachment delivery error. Your balance payment is still confirmed.</p>
          `,
          text: [
            customerMailOpts.text,
            "",
            "⚠️ Your updated rental agreement could not be attached due to an attachment delivery error.",
            "Your balance payment is still confirmed.",
          ].join("\n"),
        });
        console.warn("stripe-webhook: balance_paid customer email sent without agreement attachment after attachment delivery failure");
      } catch (retryErr) {
        console.error("stripe-webhook: balance_paid customer retry without attachment failed:", retryErr.message);
        throw retryErr;
      }
    } else {
      throw customerErr;
    }
  }
}

async function sendBalancePaidOwnerEmail({
  renterName, renterEmail, renterPhone, vehicleName, bookingId, pickupDate, returnDate, amountPaid, totalPrice, paymentIntentId,
}) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: `"Sly Car Rentals LLC Bookings" <${process.env.SMTP_USER}>`,
    to: OWNER_EMAIL,
    ...(renterEmail ? { replyTo: renterEmail } : {}),
    subject: `✅ Balance Paid — ${esc(renterName || "Renter")} — ${esc(vehicleName || "")}`,
    html: `
      <h2>✅ Rental Balance Received — Booking Now Active</h2>
      <p>The remaining balance has been paid. This booking is now fully paid and active.</p>
      <p><strong>Booking ID:</strong> ${esc(bookingId || "N/A")}<br>
      <strong>Renter:</strong> ${esc(renterName || "N/A")}<br>
      ${renterEmail ? `<strong>Email:</strong> ${esc(renterEmail)}<br>` : ""}
      ${renterPhone ? `<strong>Phone:</strong> ${esc(renterPhone)}<br>` : ""}
      <strong>Vehicle:</strong> ${esc(vehicleName || "N/A")}<br>
      <strong>Pickup Date:</strong> ${esc(pickupDate || "N/A")}<br>
      <strong>Return Date:</strong> ${esc(returnDate || "N/A")}<br>
      <strong>Balance Paid:</strong> $${esc(normalizeCurrency(amountPaid).toFixed(2))}<br>
      <strong>Total Paid:</strong> $${esc(normalizeCurrency(totalPrice).toFixed(2))}</p>
      ${paymentIntentId ? `<p style="font-size:12px;color:#888">Stripe PI: ${esc(paymentIntentId)}</p>` : ""}
    `,
  });
}

/**
 * Returns true for payment types that represent an initial booking payment
 * (not a post-rental charge like an extension or late fee).
 * Used to decide whether a failed/canceled PaymentIntent should cancel the
 * pending booking or set balance_due for retry collection.
 *
 * @param {string} paymentType - piMeta.payment_type || piMeta.type
 * @returns {boolean}
 */
function isInitialBookingPayment(paymentType) {
  return paymentType === "full_payment" || paymentType === "reservation_deposit";
}

/**
 * Transition a pending checkout booking by booking_ref.
 * Only updates rows that are still in an unpaid pre-payment state so that a
 * successful retry (which sets status to booked_paid/reserved) is never overwritten.
 *
 * @param {object} sb           - Supabase admin client
 * @param {string} bookingRef   - booking_ref value (e.g. "bk-abc123")
 * @param {string} logPrefix    - prefix for log messages (e.g. "[PAYMENT_FAILED]")
 * @param {string} targetStatus - lifecycle state to write (payment_failed, abandoned_checkout, etc.)
 * @param {string} reason       - cleanup reason for structured logs
 */
async function transitionCheckoutBooking(sb, bookingRef, logPrefix, targetStatus, reason) {
  const { data: updatedRows, error: cancelErr } = await sb
    .from("bookings")
    .update({ status: toDbBookingStatus(targetStatus), updated_at: new Date().toISOString() })
    .eq("booking_ref", bookingRef)
    .in("status", Array.from(CHECKOUT_PENDING_PREPAY_DB_STATUSES))
    .neq("payment_status", "paid")
    .select("booking_ref, vehicle_id, status");
  if (cancelErr) {
    console.warn(`${logPrefix} booking cancel update failed (non-fatal):`, cancelErr.message);
  } else {
    console.log("[CHECKOUT_CLEANUP]", {
      bookingRef,
      toStatus: targetStatus,
      reason,
      source: logPrefix,
      affectedRows: (updatedRows || []).length,
      releasedTemporaryHold: (updatedRows || []).length > 0,
    });
  }
}

export default async function handler(req, res) {
  // ── Security note ────────────────────────────────────────────────────────────
  // This endpoint must NOT require an Authorization header.  Stripe sends
  // webhooks without one.  Security is enforced exclusively via the
  // Stripe-Signature header checked by stripe.webhooks.constructEvent() below.
  // Any Authorization / CRON_SECRET / ADMIN_SECRET check here would cause
  // Stripe to receive a 401 and retry indefinitely.
  // ────────────────────────────────────────────────────────────────────────────
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY environment variable is not set");
    return res.status(500).send("Server configuration error");
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET environment variable is not set");
    return res.status(500).send("Server configuration error");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("stripe-webhook: signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    const piMeta = paymentIntent.metadata || {};
    // "payment_type" is the legacy field; "type" is the canonical field added to
    // all new extension PaymentIntents.  Accept either so that PIs created before
    // the migration (payment_type only) and after (both fields) are handled.
    const paymentType = piMeta.payment_type || piMeta.type || "";
    const isTestMode = event.livemode === false;
    logPaymentIntentReceived(event, paymentIntent);
    if (isTestMode) {
      console.log(`stripe-webhook: TEST MODE (livemode=false) → do NOT create bookings or block dates (PI ${paymentIntent.id})`);
      return res.status(200).json({ received: true, testMode: true });
    }

    // Handle rental extension payment confirmations.
    if (paymentType === "rental_extension") {
      console.log("EXTENSION TRIGGERED", paymentType, paymentIntent.metadata?.booking_id || paymentIntent.metadata?.original_booking_id || "<missing>");
      const {
        vehicle_id,
        booking_id:          meta_booking_id,   // canonical booking_ref (primary, set by extend-rental.js)
        original_booking_id,                    // legacy fallback for historical PIs
        renter_name,
        renter_email,
        renter_phone:        meta_renter_phone, // phone embedded in PI metadata by extend-rental.js
        extension_label,
        new_return_date,
        new_return_time,
        previous_return_date,                   // return date before this extension (set by extend-rental.js)
        extension_total_amount,
        extension_amount_paid,
        extension_remaining_balance,
        extension_payment_status,
        extension_reason,
        extension_notes,
      } = paymentIntent.metadata || {};

      // Use canonical booking_id; fall back to original_booking_id for PIs
      // created before extend-rental.js was updated to emit booking_id.
      const bookingRef = meta_booking_id || original_booking_id;

      // booking_id must be present and must NOT be a Stripe PI ID.
      // Accept both canonical bk-... refs (new bookings) and legacy hex refs
      // (old bookings created before the bk- prefix was introduced) — both are
      // valid booking_ref values stored in Supabase and can be resolved by
      // resolveBookingId().  Only Stripe PI IDs (pi_...) are invalid here
      // because a PI ID can never be a booking_ref.
      if (!bookingRef || bookingRef.startsWith("pi_")) {
        console.error(
          `stripe-webhook: rental_extension rejected — booking_id "${bookingRef || "<missing>"}" ` +
          `is not a valid booking reference for PI ${paymentIntent.id}`
        );
        return res.status(200).json({ received: true });
      }

      if (vehicle_id && bookingRef) {
        try {
          if (!new_return_date) {
            console.error(
              `stripe-webhook: rental_extension missing metadata new_return_date for booking ${original_booking_id}`
            );
            return res.status(200).json({ received: true });
          }

          // Resolve booking_ref against Supabase before any processing.
          // Never fall back to the raw bookingRef: an unconfirmed ref would fail
          // the DB trigger on revenue_records and signals a real data issue.
          const resolvedBookingId = await resolveBookingId(bookingRef);
          if (!resolvedBookingId) {
            console.error("[BOOKING_RESOLVE_FAILED]", { bookingRef, paymentIntentId: paymentIntent.id });
            return res.status(200).json({ received: true });
          }

          // DUPLICATE CHECK: every Stripe PaymentIntent maps to exactly one
          // revenue row.  If this PI already has a record (e.g. a prior
          // successful delivery), exit immediately — there is nothing to do.
          try {
            const sbDup = getSupabaseAdmin();
            if (sbDup) {
              const { data: existingRev } = await sbDup
                .from("revenue_records")
                .select("id, is_orphan, booking_id")
                .eq("payment_intent_id", paymentIntent.id)
                .eq("sync_excluded", false)
                .maybeSingle();
              if (existingRev?.id) {
                const existingBookingId = String(existingRev.booking_id || "").trim();
                const shouldRecoverExisting =
                  existingRev.is_orphan === true ||
                  !existingBookingId ||
                  (resolvedBookingId && existingBookingId !== resolvedBookingId);

                if (shouldRecoverExisting) {
                  console.warn(
                    `stripe-webhook: rental_extension PI ${paymentIntent.id} has recoverable existing revenue row ` +
                    `(id=${existingRev.id}, is_orphan=${existingRev.is_orphan}, booking_id=${existingBookingId || "<missing>"}) ` +
                    "— continuing to recovery path"
                  );
                } else {
                  console.log(
                    `stripe-webhook: rental_extension PI ${paymentIntent.id} already in revenue_records ` +
                    `(id=${existingRev.id}) — skipping duplicate`
                  );
                  return res.status(200).json({ received: true });
                }
              }
            }
          } catch (dupCheckErr) {
            console.warn(
              `stripe-webhook: duplicate PI check failed (non-fatal, proceeding): ${dupCheckErr.message}`
            );
          }

          // Fetch booking directly from Supabase — the sole source of truth.
          const sbExtClient = getSupabaseAdmin();
          if (!sbExtClient) {
            console.error("stripe-webhook: rental_extension — Supabase unavailable for booking lookup");
            return res.status(200).json({ received: true });
          }
          const extSelectBase =
            "id, booking_ref, status, return_date, return_time, vehicle_id, customer_name, customer_phone, customer_email, pickup_date, extension_count, deposit_paid, stripe_customer_id, stripe_payment_method_id";
          const extSelectWithOptional = `${extSelectBase}, extension_pending_payment, balance_due`;
          const isMissingOptionalColumnError = (err) => {
            const msg = String(err?.message || "").toLowerCase();
            return msg.includes("column bookings.extension_pending_payment does not exist")
              || msg.includes("column bookings.balance_due does not exist");
          };

          let { data: sbExtRow, error: sbExtRowErr } = await sbExtClient
            .from("bookings")
            .select(extSelectWithOptional)
            .eq("booking_ref", bookingRef)
            .maybeSingle();

          if (sbExtRowErr && isMissingOptionalColumnError(sbExtRowErr)) {
            console.warn(
              `stripe-webhook: rental_extension bookings query missing optional column(s); retrying legacy select for booking ${bookingRef}: ${sbExtRowErr.message}`
            );
            const { data: legacyRow, error: legacyErr } = await sbExtClient
              .from("bookings")
              .select(extSelectBase)
              .eq("booking_ref", bookingRef)
              .maybeSingle();
            sbExtRow = legacyRow
              ? { ...legacyRow, extension_pending_payment: null, balance_due: null }
              : legacyRow;
            sbExtRowErr = legacyErr;
          }
          if (sbExtRowErr || !sbExtRow) {
            console.error(
              `stripe-webhook: rental_extension booking not found in Supabase: ${bookingRef}`,
              sbExtRowErr?.message || ""
            );
            return res.status(200).json({ received: true });
          }

          const sbStatus = sbExtRow.status;
          const isValidStatus = sbStatus === "active_rental" || sbStatus === "active" || sbStatus === "reserved";
          const invalidStatus = isValidStatus ? null : (sbStatus || "<missing>");

          const normalizedCurrentReturnTime = normalizeClockTime(
            sbExtRow.return_time ? String(sbExtRow.return_time).substring(0, 5) : null
          );
          const resolvedReturnTime = normalizedCurrentReturnTime || DEFAULT_RETURN_TIME;
          const sbCurrentReturnDate = sbExtRow.return_date ? String(sbExtRow.return_date).split("T")[0] : null;
          const alreadyApplied = !!(sbCurrentReturnDate && sbCurrentReturnDate >= new_return_date);
          const oldReturnDate = sbCurrentReturnDate || "";
          const extensionAmountDollars = Math.round(paymentIntent.amount || 0) / 100;
          const parsedExtensionTotal = Number(extension_total_amount);
          const parsedExtensionPaid = Number(extension_amount_paid);
          const parsedExtensionRemaining = Number(extension_remaining_balance);
          const extensionTotalAmount = Number.isFinite(parsedExtensionTotal) && parsedExtensionTotal > 0
            ? parsedExtensionTotal
            : extensionAmountDollars;
          const extensionAmountPaid = Number.isFinite(parsedExtensionPaid) && parsedExtensionPaid > 0
            ? parsedExtensionPaid
            : extensionAmountDollars;
          const extensionRemainingBalance = Number.isFinite(parsedExtensionRemaining) && parsedExtensionRemaining >= 0
            ? parsedExtensionRemaining
            : Math.max(0, extensionTotalAmount - extensionAmountPaid);
          const extensionPaymentStatusResolved =
            (typeof extension_payment_status === "string" && extension_payment_status.trim())
              ? extension_payment_status.trim().toLowerCase()
              : (extensionRemainingBalance > 0 ? "partially_paid" : "paid");
          const normalizedExtensionReason = normalizeExtensionReason(extension_reason);
          const normalizedExtensionNotes = normalizeExtensionNotes(extension_notes);
          const extensionLifecyclePaymentStatus = "completed";
          const extensionLifecycleSignatureStatus = "waived";
          const extensionLifecycleSignatureRequired = false;
          const canApplyBookingUpdate = canApplyBookingUpdateFromLifecycle({
            paymentStatus: extensionLifecyclePaymentStatus,
            signatureStatus: extensionLifecycleSignatureStatus,
            signatureRequired: extensionLifecycleSignatureRequired,
          });

          await upsertExtensionLifecycleRecord({
            sb: sbExtClient,
            bookingRef,
            paymentIntentId: paymentIntent.id,
            requestedReturnDate: new_return_date,
            requestedReturnTime: new_return_time || resolvedReturnTime,
            extensionReason: normalizedExtensionReason,
            extensionNotes: normalizedExtensionNotes,
            paymentStatus: extensionLifecyclePaymentStatus,
            signatureStatus: extensionLifecycleSignatureStatus,
            signatureRequired: extensionLifecycleSignatureRequired,
          });
          await appendBookingTimelineEvent({
            sb: sbExtClient,
            bookingRef,
            eventType: "extension_payment_captured",
            eventKey: `${bookingRef}:extension_payment_captured:${paymentIntent.id}`,
            actor: "stripe_webhook",
            payload: {
              paymentIntentId: paymentIntent.id,
              extensionTotalAmount,
              extensionAmountPaid,
              extensionRemainingBalance,
              extensionPaymentStatus: extensionPaymentStatusResolved,
              extensionReason: normalizedExtensionReason || null,
              extensionNotes: normalizedExtensionNotes || null,
            },
          });

          // Build normalized booking snapshot for downstream reuse.
          // Preserve the current DB status so autoUpsertBooking does not
          // default a missing status to "pending" and downgrade active_rental.
          const updatedBooking = {
            bookingId:              sbExtRow.booking_ref,
            vehicleId:              sbExtRow.vehicle_id || vehicle_id,
            status:                 sbExtRow.status,
            name:                   sbExtRow.customer_name || renter_name || "",
            phone:                  sbExtRow.renter_phone || sbExtRow.customer_phone || meta_renter_phone || "",
            email:                  sbExtRow.customer_email || renter_email || "",
            pickupDate:             sbExtRow.pickup_date ? String(sbExtRow.pickup_date).split("T")[0] : "",
            returnDate:             alreadyApplied ? (sbCurrentReturnDate || new_return_date) : new_return_date,
            returnTime:             resolvedReturnTime,
            extensionCount:         (Number(sbExtRow.extension_count) || 0) + (alreadyApplied ? 0 : 1),
            amountPaid:             Math.round(((Number(sbExtRow.deposit_paid) || 0) + extensionAmountDollars) * 100) / 100,
            // Preserve original saved-card references so autoUpsertBooking does not wipe them.
            stripeCustomerId:       sbExtRow.stripe_customer_id      || null,
            stripePaymentMethodId:  sbExtRow.stripe_payment_method_id || null,
            // Save the card used for THIS extension separately so charge-fee can
            // fall back to it when the original booking card is absent/declined.
            extensionStripeCustomerId:      paymentIntent.customer       || sbExtRow.extension_stripe_customer_id      || null,
            extensionStripePaymentMethodId: paymentIntent.payment_method || sbExtRow.extension_stripe_payment_method_id || null,
          };

          if (invalidStatus) {
            console.error(
              `stripe-webhook: rental_extension invalid status for booking ${bookingRef}: ${invalidStatus}`
            );
            return res.status(200).json({ received: true });
          }

          if (alreadyApplied) {
            console.log(
              `stripe-webhook: rental_extension already applied for booking ${bookingRef} return_date=${new_return_date}`
            );
            // Extension date was already updated on a prior delivery.
            // Attempt idempotent revenue record creation in case it was missed —
            // e.g. the first delivery updated the booking but returned 500 before
            // writing the revenue record, so the next Stripe retry lands here.
            // autoCreateRevenueRecord deduplicates on payment_intent_id so this
            // is a no-op when the record already exists.
            try {
              let recoveryFeeFields = { stripeFee: null, stripeNet: null };
              try {
                recoveryFeeFields = await resolveStripeFeeFields(stripe, paymentIntent);
              } catch (feeErr) {
                console.warn(
                  `stripe-webhook: alreadyApplied extension fee lookup failed (non-fatal): ${feeErr.message}`
                );
              }
              const extCustomerId = await resolveCustomerIdFromSupabase(
                updatedBooking.phone || "",
                updatedBooking.email || renter_email || "",
              );
              await autoCreateRevenueRecord({
                booking_ref:     resolvedBookingId,
                bookingId:       resolvedBookingId,
                paymentIntentId: paymentIntent.id,
                vehicleId:       updatedBooking.vehicleId || vehicle_id,
                customerId:      extCustomerId,
                name:            updatedBooking.name || renter_name || "",
                phone:           updatedBooking.phone || "",
                email:           updatedBooking.email || renter_email || "",
                // Use previous_return_date from PI metadata as extension start.
                // Warn when falling back to original pickupDate so unexpected cases
                // are visible in logs and can be investigated.
                pickupDate:      (() => {
                  if (previous_return_date) return previous_return_date;
                  if (updatedBooking.pickupDate) {
                    console.warn(
                      `stripe-webhook: alreadyApplied extension previous_return_date missing — ` +
                      `falling back to pickupDate for booking ${bookingRef}`
                    );
                    return updatedBooking.pickupDate;
                  }
                  return "";
                })(),
                returnDate:      sbCurrentReturnDate || new_return_date || updatedBooking.returnDate || "",
                amountPaid:      Math.round(paymentIntent.amount_received || paymentIntent.amount || 0) / 100,
                paymentMethod:   "stripe",
                type:            "extension",
                ...recoveryFeeFields,
              }, {
                strict:           false,   // non-fatal — booking date is already consistent
                requireStripeFee: false,   // reconcile will fill in fees if missing
              });
              // Also recover the booking_extensions row if it was missed.
              logWebhookOrgFallback({ endpoint: "stripe-webhook", action: "recovery_upsert", table: "booking_extensions", bookingRef: resolvedBookingId, paymentIntentId: paymentIntent.id });
              try {
                const sbBErecov = getSupabaseAdmin();
                if (sbBErecov && resolvedBookingId && new_return_date) {
                  const { data: beRecovData, error: beRecovError } = await sbBErecov
                    .from("booking_extensions")
                    .upsert(
                      {
                        booking_id:        resolvedBookingId,
                        payment_intent_id: paymentIntent.id,
                        amount:            Math.round(paymentIntent.amount_received || paymentIntent.amount || 0) / 100,
                        new_return_date:   new_return_date,
                        new_return_time:   updatedBooking.returnTime || null,
                        extension_reason:  normalizedExtensionReason || null,
                        extension_notes:   normalizedExtensionNotes || null,
                      },
                      { onConflict: "payment_intent_id", ignoreDuplicates: true }
                    );
                  if (beRecovError) {
                    console.error("stripe-webhook: alreadyApplied booking_extensions recovery upsert failed:", beRecovError.message, beRecovError.details || "", { resolvedBookingId, paymentIntentId: paymentIntent.id });
                  } else {
                    console.log("stripe-webhook: alreadyApplied booking_extensions recovery upsert succeeded", { resolvedBookingId, paymentIntentId: paymentIntent.id, rows: beRecovData?.length ?? "(no data)" });
                  }
                } else {
                  console.warn("stripe-webhook: alreadyApplied booking_extensions recovery skipped — missing sbBErecov, resolvedBookingId, or new_return_date", { resolvedBookingId, new_return_date });
                }
              } catch (beRecovErr) {
                console.warn("stripe-webhook: alreadyApplied booking_extensions recovery failed (non-fatal):", beRecovErr.message);
              }
            } catch (recoveryErr) {
              console.warn(
                `stripe-webhook: alreadyApplied extension revenue recovery failed (non-fatal): ${recoveryErr.message}`
              );
            }
            return res.status(200).json({ received: true });
          }

          if (!updatedBooking) {
            console.error(
              `stripe-webhook: rental_extension update did not produce booking snapshot for ${bookingRef}`
            );
            return res.status(200).json({ received: true });
          }

          // Sync updated booking to Supabase.  Fatal: if the return_date update
          // does not reach Supabase, do NOT insert revenue — return 500 so Stripe
          // retries.  On the next delivery the booking will be in alreadyApplied
          // state and revenue recovery will be attempted idempotently.
          try {
            await autoUpsertBooking(updatedBooking, { strict: true });
          } catch (syncErr) {
            console.error("stripe-webhook: Supabase extension booking sync failed — blocking revenue insertion to prevent detached extension:", syncErr.message);
            return res.status(500).json({
              received: false,
              error: `extension booking sync failed for ${paymentIntent.id}`,
            });
          }

          // Clear extension-pending fields in Supabase now that payment succeeded.
          // extension_count and last_extension_at are maintained automatically by
          // the sync_booking_extension_stats trigger on booking_extensions.
          try {
            const sbExt = getSupabaseAdmin();
            if (sbExt && bookingRef) {
              await sbExt
                .from("bookings")
                .update({
                  extend_pending:            false,
                  extension_pending_payment: extensionRemainingBalance > 0 ? (() => {
                    const prior = sbExtRow.extension_pending_payment && typeof sbExtRow.extension_pending_payment === "object"
                      ? sbExtRow.extension_pending_payment
                      : {};
                    const priorHistory = Array.isArray(prior.paymentHistory) ? prior.paymentHistory : [];
                    return {
                      ...prior,
                      extensionTotal: extensionTotalAmount,
                      amountPaid: extensionAmountPaid,
                      remainingBalance: extensionRemainingBalance,
                      paymentStatus: extensionPaymentStatusResolved,
                      paymentHistory: [
                        ...priorHistory,
                        {
                          paymentIntentId: paymentIntent.id,
                          amountPaid: extensionAmountDollars,
                          paidAt: new Date().toISOString(),
                        },
                      ],
                      newReturnDate: new_return_date || updatedBooking.returnDate || "",
                      newReturnTime: updatedBooking.returnTime || "",
                    };
                  })() : null,
                  balance_due:               extensionRemainingBalance > 0
                    ? Math.round(((Number(sbExtRow.balance_due) || 0) + extensionRemainingBalance) * 100) / 100
                    : (Number(sbExtRow.balance_due) || 0),
                  updated_at:                new Date().toISOString(),
                })
                .eq("booking_ref", bookingRef);

              // Auto-dismiss any pending late fee: by paying for an extension the
              // renter has resolved their overdue situation.  Only clears statuses
              // that have not yet been acted on (pending_approval or null) — paid /
              // approved / failed fees are left untouched.
              await sbExt
                .from("bookings")
                .update({
                  late_fee_status:      "dismissed",
                  late_fee_approved_at: new Date().toISOString(),
                  late_fee_approved_by: "auto_extension",
                })
                .eq("booking_ref", bookingRef)
                .or("late_fee_status.eq.pending_approval,late_fee_status.is.null");

              // Mark a deferred late fee as paid: if the fee was flagged as
              // 'pending_collection' (no card at assessment time), the renter
              // has now paid via this extension — transition it to 'paid'.
              await sbExt
                .from("bookings")
                .update({
                  late_fee_status:      "paid",
                  late_fee_approved_at: new Date().toISOString(),
                  late_fee_approved_by: "auto_extension_collection",
                })
                .eq("booking_ref", bookingRef)
                .eq("late_fee_status", "pending_collection");
            }
          } catch (extClrErr) {
            console.error("stripe-webhook: Supabase extension field clear error (non-fatal):", extClrErr.message);
          }

          // Insert a dedicated booking_extensions row for this payment.
          // new_return_time is taken from the booking's existing return_time
          // because the extend flow has no time picker — the renter keeps their
          // original daily schedule.
          // The insert is idempotent via the UNIQUE constraint on payment_intent_id.
          // Fatal: return 500 on failure so Stripe retries and the row is never silently lost.
          logWebhookOrgFallback({ endpoint: "stripe-webhook", action: "upsert", table: "booking_extensions", bookingRef: resolvedBookingId, paymentIntentId: paymentIntent.id });
          try {
            const sbBE = getSupabaseAdmin();
            if (sbBE && resolvedBookingId && new_return_date) {
              const { data: beData, error: beUpsertErr } = await sbBE
                .from("booking_extensions")
                .upsert(
                  {
                    booking_id:                  resolvedBookingId,
                    payment_intent_id:           paymentIntent.id,
                    amount:                      extensionAmountDollars,
                    new_return_date:             new_return_date,
                    new_return_time:             updatedBooking.returnTime || null,
                    extension_reason:            normalizedExtensionReason || null,
                    extension_notes:             normalizedExtensionNotes || null,
                    // Phase 2 risk-gating fields — track partial vs full payments
                    // and remaining balance so evaluateExtensionRisk can cap exposure.
                    payment_type:                extensionRemainingBalance > 0 ? "partial" : "full",
                    extension_total_amount:      extensionTotalAmount,
                    extension_remaining_balance: extensionRemainingBalance,
                  },
                  { onConflict: "payment_intent_id", ignoreDuplicates: true }
                );
              if (beUpsertErr) {
                console.error("stripe-webhook: booking_extensions upsert failed:", beUpsertErr.message, beUpsertErr.details || "", { resolvedBookingId, paymentIntentId: paymentIntent.id });
                throw beUpsertErr;
              } else {
                console.log("stripe-webhook: booking_extensions upsert succeeded", { resolvedBookingId, paymentIntentId: paymentIntent.id, rows: beData?.length ?? "(no data)" });
                await appendBookingTimelineEvent({
                  sb: sbBE,
                  bookingRef: resolvedBookingId,
                  eventType: "extension_applied",
                  eventKey: `${resolvedBookingId}:extension_applied:${paymentIntent.id}`,
                  actor: "stripe_webhook",
                  payload: {
                    paymentIntentId: paymentIntent.id,
                    newReturnDate: new_return_date,
                    newReturnTime: updatedBooking.returnTime || null,
                    extensionReason: normalizedExtensionReason || null,
                    extensionNotes: normalizedExtensionNotes || null,
                    amountPaid: extensionAmountDollars,
                  },
                });
              }
            } else {
              console.warn("stripe-webhook: booking_extensions upsert skipped — missing sbBE, resolvedBookingId, or new_return_date", { resolvedBookingId, new_return_date });
            }
          } catch (beErr) {
            console.error("stripe-webhook: booking_extensions insert error:", beErr.message);
            return res.status(500).json({
              received: false,
              error: `booking_extensions persistence failed for ${paymentIntent.id}`,
            });
          }

          // Create a new extension revenue record (type='extension').
          try {
            const feeFields = await resolveStripeFeeFields(stripe, paymentIntent);
            const extCustomerId = await resolveCustomerIdFromSupabase(
              updatedBooking.phone || "",
              updatedBooking.email || renter_email || "",
            );

            await autoCreateRevenueRecord({
              booking_ref:     resolvedBookingId,
              bookingId:       resolvedBookingId,
              paymentIntentId: paymentIntent.id,
              vehicleId:       updatedBooking.vehicleId || vehicle_id,
              customerId:      extCustomerId,
              name:            updatedBooking.name || renter_name || "",
              phone:           updatedBooking.phone || "",
              email:           updatedBooking.email || renter_email || "",
              // Extension date range: pickup_date = previous return date (extension start),
              // return_date = new return date (extension end).  This lets the admin UI
              // compute "+N days" correctly for each extension row.
              pickupDate:      oldReturnDate || "",
              returnDate:      new_return_date || updatedBooking.returnDate || "",
              amountPaid:      extensionAmountDollars,
              paymentMethod:   "stripe",
              type:            "extension",
              ...feeFields,
            }, {
              strict: true,
              requireStripeFee: true,
            });
            const extensionRevenueComplete = await revenueRecordCompleteInSupabase(
              bookingRef,
              paymentIntent.id
            );
            if (!extensionRevenueComplete) {
              throw new Error(`extension revenue verification failed for PI ${paymentIntent.id}`);
            }
          } catch (revErr) {
            console.error("stripe-webhook: extension revenue record error:", revErr.message);
            return res.status(500).json({
              received: false,
              error: `extension revenue persistence failed for ${paymentIntent.id}`,
            });
          }

          await upsertExtensionLifecycleRecord({
            sb: sbExtClient,
            bookingRef,
            paymentIntentId: paymentIntent.id,
            requestedReturnDate: new_return_date,
            requestedReturnTime: new_return_time || updatedBooking.returnTime || null,
            extensionReason: normalizedExtensionReason,
            extensionNotes: normalizedExtensionNotes,
            paymentStatus: "completed",
            signatureStatus: "waived",
            signatureRequired: false,
            lifecycleStatus: "applied",
          });

          // Update public booked-dates.json availability.
          if (updatedBooking.pickupDate && updatedBooking.returnDate) {
            try {
              await blockBookedDates(
                vehicle_id,
                updatedBooking.pickupDate,
                updatedBooking.returnDate,
                updatedBooking.pickupTime || "",
                updatedBooking.returnTime || updatedBooking.pickupTime || "",
              );
            } catch (bdErr) {
              console.error("stripe-webhook: booked-dates.json extension update failed (non-fatal):", bdErr.message);
            }
          }

          // Update Supabase blocked_dates availability.
          // Extend the existing row's end_date rather than inserting a new overlapping row —
          // the no-overlap DB trigger would reject an INSERT that covers the same range.
          if (vehicle_id && updatedBooking.returnDate) {
            try {
              await extendBlockedDateForBooking(vehicle_id, bookingRef, updatedBooking.returnDate, updatedBooking.returnTime || null);
            } catch (sbBlockErr) {
              console.error("stripe-webhook: Supabase blocked_dates extension update failed (non-fatal):", sbBlockErr.message);
            }
          }

          // Send extension confirmed SMS
          if (updatedBooking.phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
            try {
              await sendDedupedSms({
                bookingId: bookingRef,
                templateKey: "extend_confirmed_economy",
                phone: updatedBooking.phone,
                body: render(EXTEND_CONFIRMED_ECONOMY, {
                  return_time: updatedBooking.returnTime || "",
                  return_date: updatedBooking.returnDate || "",
                }),
                returnDateAtSend: updatedBooking.returnDate || undefined,
              });
            } catch (smsErr) {
              console.error("stripe-webhook: extension confirmed SMS failed:", smsErr.message);
            }
          }

          // Send extension confirmation emails (with updated agreement PDF) to owner and renter.
          try {
            await sendExtensionConfirmationEmails({
              paymentIntent,
              booking: updatedBooking,
              updatedReturnDate: updatedBooking.returnDate || "",
              updatedReturnTime: updatedBooking.returnTime || "",
              extensionLabel: extension_label || "",
              vehicleId: vehicle_id,
              renterEmail: updatedBooking.email || renter_email || "",
              renterName: updatedBooking.name || renter_name || "",
              originalReturnDate: oldReturnDate,
              extensionCount: updatedBooking.extensionCount || 1,
            });
          } catch (emailErr) {
            console.error("stripe-webhook: extension email failed (non-fatal):", emailErr.message);
          }

          console.log("EXTENSION_APPLIED", {
            booking_id: original_booking_id,
            old_return: oldReturnDate,
            new_return: updatedBooking.returnDate,
            payment_intent_id: paymentIntent.id,
          });

          // ── Ledger: record extension payment credit (idempotent on PI ID) ──
          logWebhookOrgFallback({ endpoint: "stripe-webhook", action: "add_ledger_payment", table: "renter_balance_ledger", bookingRef: resolvedBookingId, paymentIntentId: paymentIntent.id });
          try {
            const sbLedger = getSupabaseAdmin();
            if (sbLedger && resolvedBookingId) {
              const ledgerResult = await addLedgerPayment(sbLedger, {
                bookingId:               resolvedBookingId,
                paymentIntentId:         paymentIntent.id,
                amount:                  extensionAmountDollars,
                transaction_type:        "payment",
                notes:                   `Extension payment — ${extension_label || ""} (+${extensionAmountDollars} paid)`,
              });
              console.log("[LEDGER_EXTENSION_PAYMENT]", {
                booking_ref:       resolvedBookingId,
                pi_id:             paymentIntent.id,
                amount:            extensionAmountDollars,
                duplicate:         ledgerResult.duplicate,
              });
            }
          } catch (ledgerErr) {
            console.error("stripe-webhook: extension ledger payment write failed (non-fatal):", ledgerErr.message);
          }
        } catch (err) {
          console.error("stripe-webhook: extension confirmation error:", err);
        }
      } else {
        logWebhookSkip(
          paymentIntent,
          `rental_extension missing required metadata vehicle_id=${vehicle_id || "<missing>"} booking_id=${bookingRef || "<missing>"}`
        );
      }
      // Unified pipeline: revenue guarantee (idempotent — extension handler above
      // already recorded it; this is a safety net for any gap).
      try {
        await processStripePayment(stripe, paymentIntent);
      } catch (pspErr) {
        console.warn("stripe-webhook: rental_extension processStripePayment failed (non-fatal):", pspErr.message);
      }
      return res.status(200).json({ received: true });
    }

    if (paymentType === "reservation_deposit") {
      const meta = paymentIntent.metadata || {};
      const {
        vehicle_id, pickup_date, return_date, pickup_time, return_time,
        renter_name, renter_phone, email, vehicle_name, booking_id,
        full_rental_amount,
      } = meta;
      const bookingRef = booking_id || "";
      // For reservation_deposit the booking is being created for the first
      // time — it has never been written to Supabase yet (create-payment-intent
      // only embeds the ID in PI metadata), so resolveBookingId would always
      // return null (not-found).  Use the booking_id from metadata directly;
      // persistBooking below will INSERT the row into Supabase via the pipeline.
      // Guard: all required booking fields must be present.
      // A reservation_deposit without vehicle_id / dates cannot produce a valid
      // booking row and must never reach the persistence or revenue steps.
      if (!bookingRef || !vehicle_id || !pickup_date || !return_date) {
        console.error("[BOOKING_MISSING_REQUIRED_FIELDS]", {
          bookingRef:  bookingRef  || "<missing>",
          vehicleId:   vehicle_id  || "<missing>",
          pickupDate:  pickup_date || "<missing>",
          returnDate:  return_date || "<missing>",
          paymentIntentId: paymentIntent.id,
        });
        return res.status(500).json({ received: false, error: "reservation_deposit missing required booking fields" });
      }
      const resolvedBookingId = bookingRef;

      const amountPaid = Math.round(Number(paymentIntent.amount_received || paymentIntent.amount || 0)) / 100;
      const totalPrice = normalizeCurrency(full_rental_amount || amountPaid);
      const remainingBalance = Math.max(0, normalizeCurrency(totalPrice - amountPaid));

      // Resolve Stripe fee fields early so billingPhone can be used as a phone
      // fallback below.  This piggybacks on the existing fee lookup; no extra
      // Stripe API call is needed.  Failure is non-fatal: feeFields defaults to
      // { stripeFee: null, stripeNet: null, billingPhone: null }.
      let depositFeeFields = { stripeFee: null, stripeNet: null, billingPhone: null };
      try {
        depositFeeFields = await resolveStripeFeeFields(stripe, paymentIntent);
      } catch (feeErr) {
        console.warn(`stripe-webhook: reservation_deposit early fee lookup failed for PI ${paymentIntent.id} (non-fatal): ${feeErr.message}`);
      }

      const bookingForSync = {
        bookingId: resolvedBookingId,
        vehicleId: vehicle_id || "",
        vehicleName: vehicle_name || vehicle_id || "",
        name: renter_name || "",
        phone: renter_phone ? normalizePhone(renter_phone) : normalizePhone(meta.customer_phone || paymentIntent.customer_details?.phone || depositFeeFields.billingPhone || ""),
        email: email || meta.customer_email || paymentIntent.customer_details?.email || paymentIntent.receipt_email || "",
        pickupDate: pickup_date || "",
        pickupTime: pickup_time || "",
        returnDate: return_date || "",
        returnTime: return_time || DEFAULT_RETURN_TIME,
        paymentIntentId: paymentIntent.id,
        amountPaid,
        totalPrice,
        remainingBalance,
        paymentStatus: "partial",
        status: "reserved",
      };

      if (!bookingForSync.phone && !bookingForSync.email) {
        console.error(
          `[BOOKING_MISSING_CONTACT] booking ${resolvedBookingId} (PI ${paymentIntent.id}) ` +
          `has no phone or email — manage-booking verify will fail for this customer`
        );
      }

      // ── Step 1: Send owner + renter communications FIRST ─────────────────
      // Build the balance link before any DB write so the customer email can
      // include it regardless of whether Supabase persistence succeeds.
      const balanceLink = buildReservationBalanceLink({
        bookingId: resolvedBookingId,
        paymentIntentId: paymentIntent.id,
        meta,
        booking: bookingForSync,
      });

      // ── Full unified owner + customer email (same path as full_payment) ───
      // sendWebhookNotificationEmails sends the complete owner notification
      // including: attachments (signature PDF, ID photo, insurance), pricing
      // breakdown, protection plan details, and all booking fields.  The
      // isDepositMode flag inside the function ensures payment labels read
      // "Reservation deposit" and the remaining balance is shown prominently.
      try {
        await sendWebhookNotificationEmails(paymentIntent);
      } catch (emailErr) {
        console.error("stripe-webhook: reservation_deposit sendWebhookNotificationEmails error:", emailErr.message);
      }

      // Customer balance-link email — deposit-specific: gives the renter the
      // URL to pay the remaining balance.  Sent as a second email on top of
      // the unified confirmation above.
      try {
        await sendReservationDepositBalanceEmail({
          renterEmail: bookingForSync.email,
          renterName: bookingForSync.name,
          vehicleName: bookingForSync.vehicleName,
          pickupDate: bookingForSync.pickupDate,
          returnDate: bookingForSync.returnDate,
          depositPaid: amountPaid,
          remainingBalance,
          bookingId: resolvedBookingId,
        });
      } catch (emailErr) {
        console.error("stripe-webhook: reservation_deposit customer balance email failed:", emailErr.message);
      }

      // Owner SMS
      if (process.env.OWNER_PHONE && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
        try {
          const ownerSmsText = [
            `🔒 Reservation deposit: ${sanitizeSmsValue(bookingForSync.name || "Unknown")}`,
            `Vehicle: ${sanitizeSmsValue(bookingForSync.vehicleName || vehicle_id || "")}`,
            `Dates: ${bookingForSync.pickupDate || ""} → ${bookingForSync.returnDate || ""}`,
            `Deposit: $${amountPaid.toFixed(2)} / Balance: $${remainingBalance.toFixed(2)}`,
            `PI: ${paymentIntent.id}`,
          ].join("\n");
          await sendSms(normalizePhone(process.env.OWNER_PHONE), ownerSmsText.slice(0, MAX_ALERT_SMS_LENGTH));
        } catch (ownerSmsErr) {
          console.error("stripe-webhook: reservation_deposit owner SMS error (non-fatal):", ownerSmsErr.message);
        }
      }

      // Renter SMS — includes balance payment link
      try {
        if (bookingForSync.phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
          const smsBookingId = resolvedBookingId || bookingRef || paymentIntent.id;
          await sendLifecycleSmsSequence({
            bookingId: smsBookingId,
            phone: bookingForSync.phone,
            eventType: SMS_LIFECYCLE_EVENT.RESERVATION_DEPOSIT_PAID,
            smsContext: {
              customerName: bookingForSync.name || "",
              vehicleName: bookingForSync.vehicleName || "your vehicle",
              pickupDate: bookingForSync.pickupDate || "",
              pickupTime: bookingForSync.pickupTime || "",
              returnDate: bookingForSync.returnDate || "",
              returnTime: bookingForSync.returnTime || "",
              bookingId: smsBookingId,
              bookingType: meta.booking_type || "",
              vehicleId: bookingForSync.vehicleId || vehicle_id || "",
              remainingBalance,
              manageLink: buildRenterOnboardingLink({
                bookingId: smsBookingId,
                vehicleId: bookingForSync.vehicleId || vehicle_id || "",
              }),
              paymentLink: balanceLink,
            },
            source: "stripe_webhook:reservation_deposit",
            paymentState: "partial",
          });
        }
      } catch (smsErr) {
        console.error("stripe-webhook: reservation_deposit balance SMS failed:", smsErr.message);
      }

      // ── Step 2+3: Persist booking through unified pipeline ───────────────────
      // Runs AFTER all notifications so DB failures never silence owner/renter alerts.
      // Uses persistBooking() — identical to the full_payment path — which runs:
      //   customer upsert → booking upsert → revenue record → blocked_dates
      // and deduplicates by paymentIntentId so re-runs (Stripe retries) are safe.
      // autoUpsertBooking must NOT be called directly here; going through
      // persistBooking() guarantees the canonical order and customer row creation.
      try {
        await persistBooking({
          bookingId:        resolvedBookingId,
          vehicleId:        bookingForSync.vehicleId,
          vehicleName:      bookingForSync.vehicleName,
          name:             bookingForSync.name,
          phone:            bookingForSync.phone,
          email:            bookingForSync.email,
          pickupDate:       bookingForSync.pickupDate,
          pickupTime:       bookingForSync.pickupTime,
          returnDate:       bookingForSync.returnDate,
          returnTime:       bookingForSync.returnTime,
          amountPaid:       bookingForSync.amountPaid,
          totalPrice:       bookingForSync.totalPrice,
          paymentIntentId:  bookingForSync.paymentIntentId,
          status:           "reserved",
          paymentStatus:    "partial",
          type:             "reservation_deposit",
          paymentMethod:    "stripe",
          source:           "stripe_webhook",
          strictPersistence: true,
          // requireStripeFee: false — Stripe fee fields are resolved separately via
          // depositFeeFields (spread below) and may be null on transient API errors;
          // stripe-reconcile.js backfills any missing fee data later.
          requireStripeFee: false,
          ...depositFeeFields,
        });
      } catch (persistErr) {
        console.error("stripe-webhook: reservation_deposit persistBooking failed:", persistErr.message);
        return res.status(500).json({ received: false, error: `reservation deposit booking persistence failed for ${paymentIntent.id}` });
      }

      // ── Step 3b: Ledger + payment-plan reconciliation ───────────────────────
      // Route reservation deposits through the same authoritative financial
      // lifecycle used by other posted payments.
      logWebhookOrgFallback({ endpoint: "stripe-webhook", action: "reservation_deposit_ledger", table: "renter_balance_ledger", bookingRef: resolvedBookingId, paymentIntentId: paymentIntent.id });
      try {
        const sbLedger = getSupabaseAdmin();
        if (sbLedger && resolvedBookingId) {
          const ledgerResult = await addLedgerPayment(sbLedger, {
            bookingId:       resolvedBookingId,
            paymentIntentId: paymentIntent.id,
            amount:          amountPaid,
            notes:           `Reservation deposit payment ($${amountPaid.toFixed(2)})`,
            metadata: {
              payment_source: "reservation_deposit",
              payment_plan_reconciliation: "pending",
            },
          });
          console.log("[LEDGER_RESERVATION_DEPOSIT_PAYMENT]", {
            booking_ref: resolvedBookingId,
            pi_id:       paymentIntent.id,
            amount:      amountPaid,
            duplicate:   ledgerResult.duplicate,
          });

          try {
            const reconcileResult = await reconcilePaymentPlanPayment(sbLedger, {
              booking_id: bookingRef,
              payment_intent_id: paymentIntent.id,
              amount: amountPaid,
              ledger_transaction_id: ledgerResult?.transaction?.id || null,
              created_by: "stripe_webhook",
            });
            const progress = await computePaymentPlanProgress(sbLedger, {
              bookingId: bookingRef,
            });
            await sbLedger
              .from("renter_balance_ledger")
              .update({
                metadata: {
                  ...(ledgerResult?.transaction?.metadata || {}),
                  payment_source: "reservation_deposit",
                  payment_plan_reconciliation: {
                    duplicate: !!reconcileResult?.duplicate,
                    amount_allocated: Number(reconcileResult?.amount_allocated || 0),
                    amount_unapplied: Number(reconcileResult?.amount_unapplied || 0),
                    allocations: (reconcileResult?.allocations || []).map((row) => ({
                      plan_id: row.plan_id || null,
                      installment_id: row.installment_id || null,
                      amount_allocated: Number(row.amount_allocated || 0),
                      allocation_type: row.allocation_type || "installment_paid",
                    })),
                    remaining_plan_balance: Number(progress?.remaining_balance || 0),
                    overdue_plan_amount: Number(progress?.overdue_amount || 0),
                    next_due_date: progress?.next_due_date || null,
                  },
                },
              })
              .eq("id", ledgerResult?.transaction?.id || null);
          } catch (reconcileErr) {
            console.warn("stripe-webhook: reservation_deposit payment-plan reconciliation failed (non-fatal):", reconcileErr.message);
          }
        }
      } catch (ledgerErr) {
        console.error("stripe-webhook: reservation_deposit ledger payment write failed (non-fatal):", ledgerErr.message);
      }

      // ── Step 4: Persist manage token and balance link ─────────────────────
      // balance_payment_link is stored directly in Supabase via persistBooking above.
      // Persist manage_token and contact fields via a Supabase update.
      try {
        const manageToken = createManageToken(resolvedBookingId);
        const sbForToken = getSupabaseAdmin();
        if (sbForToken) {
          const { error: tokenErr } = await sbForToken
            .from("bookings")
            .update({
              manage_token:         manageToken,
              balance_payment_link: balanceLink,
              customer_name:        bookingForSync.name  || null,
              customer_email:       bookingForSync.email || null,
              customer_phone:       bookingForSync.phone || null,
              renter_phone:         bookingForSync.phone || null,
              updated_at:           new Date().toISOString(),
            })
            .eq("booking_ref", resolvedBookingId);
          if (tokenErr) {
            console.warn("stripe-webhook: could not persist manage_token (non-fatal):", tokenErr.message);
          }
        }
      } catch (tokenErr) {
        console.warn("stripe-webhook: manage token generation failed (non-fatal):", tokenErr.message);
      }

      // ── Step 5: Block dates and mark vehicle unavailable ──────────────────
      try {
        if (vehicle_id && pickup_date && return_date) {
          await blockBookedDates(vehicle_id, pickup_date, return_date, pickup_time || "", return_time || "");
          await markVehicleUnavailable(vehicle_id);
        }
      } catch (availabilityErr) {
        console.error("stripe-webhook: reservation_deposit availability sync failed:", availabilityErr.message);
        return res.status(500).json({ received: false, error: `reservation deposit availability sync failed for ${paymentIntent.id}` });
      }

      // Unified pipeline: revenue guarantee (idempotent — Step 4 above already
      // recorded it; this is a safety net for any gap).
      try {
        await processStripePayment(stripe, paymentIntent, {
          bookingId:        resolvedBookingId,
          preResolvedGross: amountPaid,
          preResolvedFee:   depositFeeFields.stripeFee,
          preResolvedNet:   depositFeeFields.stripeNet,
        });
      } catch (pspErr) {
        console.warn("stripe-webhook: reservation_deposit processStripePayment failed (non-fatal):", pspErr.message);
      }

      return res.status(200).json({ received: true });
    }

    // ── Post-rental charges (late fees, damages, lost keys, etc.) ────────────
    // These PaymentIntents are created off-session by charge-fee.js (admin or AI
    // interface) and carry payment_type in the metadata.  They must NOT be
    // processed as new bookings — they only create a revenue record tied to an
    // existing booking_ref.
    if (
      paymentType === "late_fee" ||
      paymentType === "damage_fee" ||
      paymentType === "lost_key_fee" ||
      paymentType === "other_fee"    ||
      paymentType === "violation_fee"
    ) {
      const meta         = paymentIntent.metadata || {};
      // booking_ref is the canonical field; booking_id is the legacy alias.
      const rawBookingRef = meta.booking_ref || meta.booking_id || "";
      const vehicleId     = meta.vehicle_id  || "";
      const reason        = meta.reason      || "";
      const renterName    = meta.renter_name || "";

      console.log(`stripe-webhook: post-rental ${paymentType} PI=${paymentIntent.id} booking_ref=${rawBookingRef || "<missing>"}`);

      if (!rawBookingRef) {
        console.error("[BOOKING_RESOLVE_FAILED]", {
          paymentType,
          paymentIntentId: paymentIntent.id,
          reason: "missing booking_ref in metadata",
        });
        return res.status(200).json({ received: true });
      }

      // Verify the booking exists before writing the revenue record.
      const resolvedRef = await resolveBookingId(rawBookingRef);
      if (!resolvedRef) {
        console.error("[BOOKING_RESOLVE_FAILED]", { paymentType, bookingRef: rawBookingRef, paymentIntentId: paymentIntent.id });
        return res.status(200).json({ received: true });
      }

      const amountPaid = Math.round(Number(paymentIntent.amount_received || paymentIntent.amount || 0)) / 100;

      // Create/update the revenue record for the charge (idempotent by PI ID).
      try {
        let feeFields = { stripeFee: null, stripeNet: null };
        try {
          feeFields = await resolveStripeFeeFields(stripe, paymentIntent);
        } catch (feeErr) {
          console.warn(`stripe-webhook: post-rental fee lookup failed for PI ${paymentIntent.id} (non-fatal): ${feeErr.message}`);
        }
        await autoCreateRevenueRecord({
          bookingId:       resolvedRef,
          paymentIntentId: paymentIntent.id,
          vehicleId:       vehicleId,
          customerId:      null,
          name:            renterName,
          amountPaid,
          paymentMethod:   "stripe",
          type:            paymentType,
          notes:           reason || paymentType,
          ...feeFields,
        }, { strict: false, requireStripeFee: false });
        console.log("[POST_RENTAL_CHARGE_RECORDED]", {
          payment_type:      paymentType,
          booking_ref:       resolvedRef,
          payment_intent_id: paymentIntent.id,
          amount:            amountPaid,
          reason,
        });
        // ── Ledger: record post-rental payment credit (idempotent on PI ID) ─
        logWebhookOrgFallback({ endpoint: "stripe-webhook", action: "post_rental_ledger", table: "renter_balance_ledger", bookingRef: resolvedRef, paymentIntentId: paymentIntent.id });
        try {
          const sbLedger = getSupabaseAdmin();
          if (sbLedger && resolvedRef) {
            const ledgerResult = await addLedgerPayment(sbLedger, {
              bookingId:       resolvedRef,
              paymentIntentId: paymentIntent.id,
              amount:          amountPaid,
              notes:           `${paymentType} payment${reason ? ` — ${reason}` : ""}`,
            });
            console.log("[LEDGER_POST_RENTAL_PAYMENT]", {
              payment_type: paymentType,
              booking_ref:  resolvedRef,
              pi_id:        paymentIntent.id,
              amount:       amountPaid,
              duplicate:    ledgerResult.duplicate,
            });
          }
        } catch (ledgerErr) {
          console.error(`stripe-webhook: post-rental ledger write failed for PI ${paymentIntent.id} (non-fatal):`, ledgerErr.message);
        }
      } catch (revErr) {
        console.error(`stripe-webhook: post-rental revenue record failed for PI ${paymentIntent.id}:`, revErr.message);
      }

      // Unified pipeline: revenue guarantee (idempotent — autoCreateRevenueRecord
      // above already recorded it; this is a safety net for any gap).
      try {
        await processStripePayment(stripe, paymentIntent, { bookingId: resolvedRef });
      } catch (pspErr) {
        console.warn("stripe-webhook: post-rental processStripePayment failed (non-fatal):", pspErr.message);
      }

      return res.status(200).json({ received: true });
    }

    // ── Booking change fee (paid for changes after the first free one) ─────────
    if (paymentType === "booking_change_fee") {
      const meta = paymentIntent.metadata || {};
      const bookingRef = meta.booking_id || "";
      if (!bookingRef) {
        console.error("[BOOKING_CHANGE_FEE_MISSING_BOOKING_ID]", { paymentIntentId: paymentIntent.id });
        return res.status(200).json({ received: true });
      }

      const sb = getSupabaseAdmin();
      if (!sb) {
        console.error("stripe-webhook: booking_change_fee — Supabase unavailable");
        return res.status(200).json({ received: true });
      }

      // Load the booking and its pending_change
      const { data: bkRow, error: bkErr } = await sb
        .from("bookings")
        .select(
          "id, booking_ref, vehicle_id, pickup_date, return_date, pickup_time, return_time, " +
          "change_count, pending_change, total_price, deposit_paid, remaining_balance, " +
          "customer_email, payment_intent_id, manage_token"
        )
        .eq("booking_ref", bookingRef)
        .maybeSingle();

      if (bkErr || !bkRow) {
        console.error("stripe-webhook: booking_change_fee — booking not found:", bookingRef, bkErr?.message);
        return res.status(200).json({ received: true });
      }

      const pendingChange = bkRow.pending_change;
      if (!pendingChange || !pendingChange.newPickupDate || !pendingChange.newReturnDate) {
        console.error("stripe-webhook: booking_change_fee — no pending_change on booking:", bookingRef);
        return res.status(200).json({ received: true });
      }

      try {
        const {
          newPickupDate, newReturnDate,
          newPickupTime, newReturnTime,
          newVehicleId, newProtectionPlan, newProtectionPlanTier,
        } = pendingChange;

        // newVehicleId in pending_change is already a DB-canonical vehicle ID
        // (stored by manage-booking.js initiate_paid_change via normalizeVehicleId).
        // Use uiVehicleId to map back to the UI key for availability/pricing lookups.
        const pendingDbVehicleId  = newVehicleId || bkRow.vehicle_id;
        const pendingUiVehicleId  = uiVehicleId(pendingDbVehicleId);
        const vehicleData = await getVehicleById(pendingUiVehicleId);
        const depositPaid = Number(bkRow.deposit_paid || 0);

        // Recompute pricing
        let newTotal = Number(bkRow.total_price || 0);
        let newBalanceDue = Number(bkRow.remaining_balance || 0);
        if (vehicleData !== null && vehicleData !== undefined) {
          const settings = await loadPricingSettings();
          const rentalCost = computeCarAmountFromVehicleData(vehicleData, newPickupDate, newReturnDate, settings);
          if (rentalCost !== null && rentalCost !== undefined) {
            const days = computeRentalDays(newPickupDate, newReturnDate);
            const dppCost = newProtectionPlan ? computeDppCostFromSettings(days, newProtectionPlanTier || null) : 0;
            const preTax = rentalCost + dppCost;
            newTotal = applyTax(preTax, settings);
            newBalanceDue = Math.max(0, Math.round((newTotal - depositPaid) * 100) / 100);
          }
        }

        // Build new balance link
        const newBalanceLink = `https://slycarrentals.com/balance.html?v=${encodeURIComponent(pendingUiVehicleId)}&p=${encodeURIComponent(newPickupDate)}&r=${encodeURIComponent(newReturnDate)}&b=${encodeURIComponent(bookingRef)}`;

        // Apply the change
        const { error: updateErr } = await sb
          .from("bookings")
          .update({
            vehicle_id:           pendingDbVehicleId,
            pickup_date:          newPickupDate,
            return_date:          newReturnDate,
            pickup_time:          newPickupTime || bkRow.pickup_time,
            return_time:          newReturnTime || bkRow.return_time,
            total_price:          newTotal,
            remaining_balance:    newBalanceDue,
            change_count:         Number(bkRow.change_count || 0) + 1,
            balance_payment_link: newBalanceLink,
            pending_change:       null,
            has_protection_plan:  !!newProtectionPlan,
            protection_plan_tier: newProtectionPlan ? (newProtectionPlanTier || null) : null,
            updated_at:           new Date().toISOString(),
          })
          .eq("booking_ref", bookingRef);

        if (updateErr) {
          console.error("stripe-webhook: booking_change_fee Supabase update error:", updateErr.message);
          return res.status(200).json({ received: true });
        }

        // Update booked-dates.json — disabled (Phase 4: Supabase is the only write source)
        // try { await bookingChangeFeeDateUpdate(); }

        // Revenue record for the change fee itself
        try {
          const customerId = await resolveCustomerIdFromSupabase("", bkRow.customer_email || "");
          await autoCreateRevenueRecord({
            bookingId:       bookingRef,
            paymentIntentId: paymentIntent.id,
            vehicleId:       pendingDbVehicleId,
            customerId,
            email:           bkRow.customer_email || "",
            amountPaid:      Math.round(Number(paymentIntent.amount_received || paymentIntent.amount || 0)) / 100,
            paymentMethod:   "stripe",
            type:            "booking_change_fee",
          }, { strict: false, requireStripeFee: false });
        } catch (revErr) {
          console.error("stripe-webhook: booking_change_fee revenue record error (non-fatal):", revErr.message);
        }

        // Send confirmation email
        try {
          if (bkRow.customer_email && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
            const transporter = nodemailer.createTransport({
              host:   process.env.SMTP_HOST,
              port:   parseInt(process.env.SMTP_PORT || "587"),
              secure: process.env.SMTP_PORT === "465",
              auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
            });
            await transporter.sendMail({
              from:    `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
              to:      bkRow.customer_email,
              subject: "Your Booking Change Has Been Applied",
              html: `
                <h2>✅ Booking Change Applied</h2>
                <p>Your booking change fee was received and your booking has been updated.</p>
                <table style="border-collapse:collapse;width:100%;margin:16px 0">
                  <tr><td style="padding:8px;border:1px solid #ddd"><strong>New Pickup</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(newPickupDate)}</td></tr>
                  <tr><td style="padding:8px;border:1px solid #ddd"><strong>New Return</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(newReturnDate)}</td></tr>
                  <tr><td style="padding:8px;border:1px solid #ddd"><strong>New Total</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(newTotal.toFixed(2))}</td></tr>
                  <tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Due</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(newBalanceDue.toFixed(2))}</td></tr>
                </table>
                <p><a href="${esc(newBalanceLink)}" style="background:#ffb400;color:#000;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:700">Pay Remaining Balance</a></p>
              `,
            });
          }
        } catch (emailErr) {
          console.error("stripe-webhook: booking_change_fee confirmation email error (non-fatal):", emailErr.message);
        }

        console.log("BOOKING_CHANGE_FEE_APPLIED", {
          booking_id: bookingRef,
          old_dates: { pickup: bkRow.pickup_date, return: bkRow.return_date },
          new_dates: { pickup: newPickupDate, return: newReturnDate },
          payment_intent_id: paymentIntent.id,
        });
      } catch (changeErr) {
        console.error("stripe-webhook: booking_change_fee processing error:", changeErr.message);
      }
      // Unified pipeline: revenue guarantee (idempotent — autoCreateRevenueRecord
      // inside the try above already recorded it; this is a safety net for any gap).
      try {
        await processStripePayment(stripe, paymentIntent, { bookingId: bookingRef || undefined });
      } catch (pspErr) {
        console.warn("stripe-webhook: booking_change_fee processStripePayment failed (non-fatal):", pspErr.message);
      }
      return res.status(200).json({ received: true });
    }

    // Skip date blocking for balance payments — dates were already blocked when the deposit was paid.
    if (paymentType === "balance_payment" || paymentType === "rental_balance" || paymentType === "partial_balance") {
      console.log(
        `stripe-webhook: ${paymentType} for PaymentIntent ${paymentIntent.id} — skipping date blocking`
      );
      const meta = paymentIntent.metadata || {};
      const { vehicle_id } = meta;
      const rawBookingRef = meta.booking_id || meta.original_booking_id || "";
      const originalPiId = meta.original_payment_intent_id || meta.deposit_payment_intent_id;
      let bookingRef = rawBookingRef;
      if (bookingRef) {
        const resolved = await resolveBookingId(bookingRef);
        if (!resolved) {
          console.error("[BOOKING_RESOLVE_FAILED]", { bookingRef, paymentIntentId: paymentIntent.id });
          // Booking not found — still record the payment so it is visible in
          // admin.  The row is flagged is_orphan=true and booking_id=NULL so it
          // is excluded from financial aggregation until manually linked.
          const unlinkedAmount = Math.round(Number(paymentIntent.amount_received || paymentIntent.amount || 0)) / 100;
          try {
            let feeFields = { stripeFee: null, stripeNet: null };
            try {
              feeFields = await resolveStripeFeeFields(stripe, paymentIntent);
            } catch (feeErr) {
              console.warn(`stripe-webhook: ${paymentType} orphan fee lookup failed for PI ${paymentIntent.id} (non-fatal): ${feeErr.message}`);
            }
            await createOrphanRevenueRecord({
              paymentIntentId: paymentIntent.id,
              vehicleId:       vehicle_id,
              name:            meta.renter_name || "",
              phone:           meta.renter_phone ? normalizePhone(meta.renter_phone) : "",
              email:           meta.email || "",
              pickupDate:      meta.pickup_date || "",
              returnDate:      meta.return_date || "",
              amountPaid:      unlinkedAmount,
              type:            "deposit",
              notes:           `unresolved booking_ref=${bookingRef} paymentType=${paymentType}`,
              ...feeFields,
            });
          } catch (orphanErr) {
            console.error(`stripe-webhook: ${paymentType} orphan revenue record failed for PI ${paymentIntent.id} (non-fatal):`, orphanErr.message);
          }
          return res.status(200).json({ received: true });
        }
        bookingRef = resolved;
      }
      if (vehicle_id && (bookingRef || originalPiId)) {
        const paidAmount = Math.round(Number(paymentIntent.amount_received || paymentIntent.amount || 0)) / 100;

        // ── Step 1: Notifications FIRST (never depend on DB) ───────────────
        // Build contact snapshot from PI metadata so notifications fire even
        // if the DB writes below encounter a transient error.
        const preContact = {
          name:        meta.renter_name || "",
          email:       meta.email || "",
          phone:       meta.renter_phone ? normalizePhone(meta.renter_phone) : "",
          vehicleName: meta.vehicle_name || vehicle_id || "",
          vehicleId:   vehicle_id || "",
          pickupDate:  meta.pickup_date || "",
          pickupTime:  meta.pickup_time || "",
          returnDate:  meta.return_date || "",
          returnTime:  meta.return_time || "",
          totalPrice:  normalizeCurrency(meta.full_rental_amount || paidAmount),
        };

        // Owner email — full balance-paid notification
        try {
          await sendBalancePaidOwnerEmail({
            renterName:      preContact.name,
            renterEmail:     preContact.email,
            renterPhone:     preContact.phone,
            vehicleName:     preContact.vehicleName,
            bookingId:       bookingRef || originalPiId || "",
            pickupDate:      preContact.pickupDate,
            returnDate:      preContact.returnDate,
            amountPaid:      paidAmount,
            totalPrice:      preContact.totalPrice,
            paymentIntentId: paymentIntent.id,
          });
        } catch (ownerErr) {
          console.error("stripe-webhook: balance_paid owner email error (non-fatal):", ownerErr.message);
        }

        // Customer email — balance received confirmation with updated agreement
        if (preContact.email) {
          try {
            await sendBalancePaidCustomerEmail({
              renterEmail:     preContact.email,
              renterName:      preContact.name,
              renterPhone:     preContact.phone,
              bookingId:       bookingRef || "",
              paymentIntentId: paymentIntent.id,
              vehicleId:       preContact.vehicleId,
              vehicleName:     preContact.vehicleName,
              pickupDate:      preContact.pickupDate,
              pickupTime:      preContact.pickupTime,
              returnDate:      preContact.returnDate,
              returnTime:      preContact.returnTime,
              amountPaid:      paidAmount,
              totalPrice:      preContact.totalPrice,
            });
          } catch (emailErr) {
            console.error("stripe-webhook: balance_paid customer email error (non-fatal):", emailErr.message);
          }
        }

        // Owner SMS
        if (process.env.OWNER_PHONE && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
          try {
            const ownerSmsText = [
              `✅ Balance paid: ${sanitizeSmsValue(preContact.name || "Unknown")}`,
              `Vehicle: ${sanitizeSmsValue(preContact.vehicleName || "")}`,
              `Dates: ${preContact.pickupDate || ""} → ${preContact.returnDate || ""}`,
              `Amount: $${paidAmount.toFixed(2)} / Total: $${preContact.totalPrice.toFixed(2)}`,
              `PI: ${paymentIntent.id}`,
            ].join("\n");
            await sendSms(normalizePhone(process.env.OWNER_PHONE), ownerSmsText.slice(0, MAX_ALERT_SMS_LENGTH));
          } catch (ownerSmsErr) {
            console.error("stripe-webhook: balance_paid owner SMS error (non-fatal):", ownerSmsErr.message);
          }
        }

        // Renter SMS — booking confirmed
        if (preContact.phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
          try {
            const smsBookingId = bookingRef || originalPiId || paymentIntent.id;
            const eventType = normalizeLifecycleEvent({
              paymentType,
              isPartialPayment: String(meta.is_partial_payment || "").toLowerCase() === "true",
            });
            await sendLifecycleSmsSequence({
              bookingId: smsBookingId,
              phone: preContact.phone,
              eventType,
              smsContext: {
                customerName: preContact.name || "",
                vehicleName: preContact.vehicleName || "your vehicle",
                pickupDate: preContact.pickupDate || "",
                pickupTime: preContact.pickupTime || "",
                returnDate: preContact.returnDate || "",
                returnTime: preContact.returnTime || "",
                bookingId: smsBookingId,
                bookingType: meta.booking_type || "",
                vehicleId: preContact.vehicleId || vehicle_id || "",
                manageLink: buildRenterOnboardingLink({
                  bookingId: smsBookingId,
                  vehicleId: preContact.vehicleId || vehicle_id || "",
                }),
                paymentLink: buildRenterOnboardingLink({
                  bookingId: smsBookingId,
                  vehicleId: preContact.vehicleId || vehicle_id || "",
                }),
              },
              source: "stripe_webhook:balance_payment",
              paymentState: String(meta.is_partial_payment || "").toLowerCase() === "true" ? "partial" : "paid",
            });
          } catch (smsErr) {
            console.error("stripe-webhook: balance_paid SMS error (non-fatal):", smsErr.message);
          }
        }

        // ── Step 2: DB writes (booking update + revenue record) ─────────────
        // Runs AFTER notifications — DB failures are logged but do not prevent
        // the owner/customer from being notified.
        // Look up the existing booking in Supabase to get current deposit_paid
        // and all other fields needed for the patch.
        let bookingPatch = null;
        try {
          const lookupId = bookingRef || originalPiId;
          if (!lookupId) throw new Error("balance_payment: no bookingRef or originalPiId to look up booking");

          const sbBal = getSupabaseAdmin();
          let sbBalRow = null;
          if (sbBal && bookingRef) {
            const { data: balRow } = await sbBal
              .from("bookings")
              .select("booking_ref, vehicle_id, customer_name, customer_phone, renter_phone, customer_email, pickup_date, return_date, pickup_time, return_time, deposit_paid, total_price, stripe_customer_id, stripe_payment_method_id")
              .eq("booking_ref", bookingRef)
              .maybeSingle();
            sbBalRow = balRow || null;
          }

          if (sbBalRow) {
            const existingDeposit = Number(sbBalRow.deposit_paid || 0);
            const resolvedPid = sbBalRow.pickup_date ? String(sbBalRow.pickup_date).split("T")[0] : (meta.pickup_date || "");
            const resolvedRtd = sbBalRow.return_date ? String(sbBalRow.return_date).split("T")[0] : (meta.return_date || "");
            const resolvedPt  = (sbBalRow.pickup_time ? String(sbBalRow.pickup_time).substring(0, 5) : null) || meta.pickup_time || "";
            const resolvedRt  = (sbBalRow.return_time ? String(sbBalRow.return_time).substring(0, 5) : null) || meta.return_time || DEFAULT_RETURN_TIME;
            bookingPatch = {
              bookingId:              sbBalRow.booking_ref,
              vehicleId:              sbBalRow.vehicle_id || vehicle_id,
              vehicleName:            meta.vehicle_name || sbBalRow.vehicle_id || vehicle_id || "",
              name:                   sbBalRow.customer_name || meta.renter_name || "",
              phone:                  sbBalRow.customer_phone || sbBalRow.renter_phone || (meta.renter_phone ? normalizePhone(meta.renter_phone) : ""),
              email:                  sbBalRow.customer_email || meta.email || "",
              pickupDate:             resolvedPid,
              pickupTime:             resolvedPt,
              returnDate:             resolvedRtd,
              returnTime:             resolvedRt,
              amountPaid:             Math.round((existingDeposit + paidAmount) * 100) / 100,
              totalPrice:             normalizeCurrency(meta.full_rental_amount || Number(sbBalRow.total_price) || existingDeposit + paidAmount),
              paymentStatus:          "paid",
              status:                 "active_rental",
              // Prefer the card from this balance payment PI; fall back to the
              // previously-saved card so off-session charges always have a method.
              stripeCustomerId:       paymentIntent.customer        || sbBalRow.stripe_customer_id       || null,
              stripePaymentMethodId:  paymentIntent.payment_method  || sbBalRow.stripe_payment_method_id  || null,
            };
          } else {
            // Booking not found in Supabase — build from metadata.
            bookingPatch = {
              bookingId:   bookingRef,
              vehicleId:   vehicle_id,
              vehicleName: meta.vehicle_name || vehicle_id || "",
              name:        meta.renter_name || "",
              phone:       meta.renter_phone ? normalizePhone(meta.renter_phone) : "",
              email:       meta.email || "",
              pickupDate:  meta.pickup_date || "",
              pickupTime:  meta.pickup_time || "",
              returnDate:  meta.return_date || "",
              returnTime:  meta.return_time || DEFAULT_RETURN_TIME,
              amountPaid:  paidAmount,
              totalPrice:  normalizeCurrency(meta.full_rental_amount || paidAmount),
              paymentStatus:        "paid",
              status:               "active_rental",
              stripeCustomerId:     paymentIntent.customer       || null,
              stripePaymentMethodId: paymentIntent.payment_method || null,
            };
          }

          const customerId = await resolveCustomerIdFromSupabase(
            bookingPatch.phone || "",
            bookingPatch.email || "",
          );
          // Booking status update is best-effort — a conflict trigger (or other
          // transient Supabase error) must NOT prevent the revenue record or
          // ledger credit from being written.  Log the failure and continue.
          try {
            await autoUpsertBooking({ ...bookingPatch, customerId }, { strict: true });
          } catch (upsertErr) {
            console.error("stripe-webhook: balance_payment booking upsert failed (non-fatal — revenue + ledger will still be recorded):", upsertErr.message);
          }
          // Revenue recording is also best-effort so a DB failure here does not
          // prevent the ledger credit from being written.
          try {
            await autoCreateRevenueRecord({
              bookingId:       bookingPatch.bookingId || bookingRef,
              paymentIntentId: paymentIntent.id,
              vehicleId:       bookingPatch.vehicleId || vehicle_id,
              customerId,
              name:            bookingPatch.name || meta.renter_name || "",
              phone:           bookingPatch.phone || "",
              email:           bookingPatch.email || meta.email || "",
              pickupDate:      bookingPatch.pickupDate || meta.pickup_date || "",
              returnDate:      bookingPatch.returnDate || meta.return_date || "",
              amountPaid:      paidAmount,
              paymentMethod:   "stripe",
              type:            "rental_balance",
            }, { strict: true, requireStripeFee: false });
          } catch (revErr) {
            console.error("stripe-webhook: balance_payment revenue record failed (non-fatal — ledger will still be recorded):", revErr.message);
          }
          // Auto-activate if the renter's pickup time has already arrived —
          // e.g. they paid the balance on the day of pickup.
          try {
            await autoActivateIfPickupArrived(bookingPatch);
          } catch (activErr) {
            console.error("stripe-webhook: autoActivateIfPickupArrived (balance) error (non-fatal):", activErr.message);
          }
          // ── Ledger: record balance payment credit (idempotent on PI ID) ────
          logWebhookOrgFallback({ endpoint: "stripe-webhook", action: "balance_payment_ledger", table: "renter_balance_ledger", bookingRef: bookingPatch.bookingId || bookingRef, paymentIntentId: paymentIntent.id });
          try {
            const sbLedger = getSupabaseAdmin();
            if (sbLedger && (bookingPatch.bookingId || bookingRef)) {
              const ledgerResult = await addLedgerPayment(sbLedger, {
                bookingId:       bookingPatch.bookingId || bookingRef,
                paymentIntentId: paymentIntent.id,
                amount:          paidAmount,
                notes:           `Rental balance payment ($${paidAmount.toFixed(2)})`,
                metadata: {
                  payment_source: "balance_self_pay",
                  payment_plan_reconciliation: "pending",
                },
              });
              console.log("[LEDGER_BALANCE_PAYMENT]", {
                booking_ref: bookingPatch.bookingId || bookingRef,
                pi_id:       paymentIntent.id,
                amount:      paidAmount,
                duplicate:   ledgerResult.duplicate,
              });

              try {
                const reconcileResult = await reconcilePaymentPlanPayment(sbLedger, {
                  booking_id: bookingPatch.bookingId || bookingRef,
                  payment_intent_id: paymentIntent.id,
                  amount: paidAmount,
                  ledger_transaction_id: ledgerResult?.transaction?.id || null,
                  created_by: "stripe_webhook",
                });
                const progress = await computePaymentPlanProgress(sbLedger, {
                  bookingId: bookingPatch.bookingId || bookingRef,
                });
                await sbLedger
                  .from("renter_balance_ledger")
                  .update({
                    metadata: {
                      ...(ledgerResult?.transaction?.metadata || {}),
                      payment_source: "balance_self_pay",
                      payment_plan_reconciliation: {
                        duplicate: !!reconcileResult?.duplicate,
                        amount_allocated: Number(reconcileResult?.amount_allocated || 0),
                        amount_unapplied: Number(reconcileResult?.amount_unapplied || 0),
                        allocations: (reconcileResult?.allocations || []).map((row) => ({
                          plan_id: row.plan_id || null,
                          installment_id: row.installment_id || null,
                          amount_allocated: Number(row.amount_allocated || 0),
                          allocation_type: row.allocation_type || "installment_paid",
                        })),
                        remaining_plan_balance: Number(progress?.remaining_balance || 0),
                        overdue_plan_amount: Number(progress?.overdue_amount || 0),
                        next_due_date: progress?.next_due_date || null,
                      },
                    },
                  })
                  .eq("id", ledgerResult?.transaction?.id || "");
                console.log("[PAYMENT_PLAN_RECONCILED]", {
                  booking_ref: bookingPatch.bookingId || bookingRef,
                  pi_id: paymentIntent.id,
                  duplicate: !!reconcileResult?.duplicate,
                  amount_allocated: Number(reconcileResult?.amount_allocated || 0),
                  amount_unapplied: Number(reconcileResult?.amount_unapplied || 0),
                  remaining_plan_balance: Number(progress?.remaining_balance || 0),
                });
              } catch (planErr) {
                console.error("stripe-webhook: payment-plan reconciliation failed (non-fatal):", planErr.message);
              }
            }
          } catch (ledgerErr) {
            console.error("stripe-webhook: balance_payment ledger write failed (non-fatal):", ledgerErr.message);
          }
        } catch (err) {
          console.error("stripe-webhook: balance_payment DB write error:", err);
        }
      } else {
        logWebhookSkip(
          paymentIntent,
          `balance_payment missing linkage metadata vehicle_id=${vehicle_id || "<missing>"} booking_id=${bookingRef || "<missing>"} original_payment_intent_id=${originalPiId || "<missing>"}`
        );
      }
      // Unified pipeline: revenue guarantee (idempotent — autoCreateRevenueRecord
      // above already recorded it; this is a safety net for any gap).
      try {
        await processStripePayment(stripe, paymentIntent, { bookingId: bookingRef || undefined });
      } catch (pspErr) {
        console.warn("stripe-webhook: balance_payment processStripePayment failed (non-fatal):", pspErr.message);
      }
      return res.status(200).json({ received: true });
    }


    const { vehicle_id, pickup_date, return_date, pickup_time: meta_pickup_time, return_time: meta_return_time } = paymentIntent.metadata || {};

    if (!paymentType) {
      logWebhookRouting(paymentIntent, "payment_type missing — processing with generic booking path");
    } else if (paymentType !== "full_payment" && paymentType !== "reservation_deposit") {
      logWebhookRouting(paymentIntent, `unexpected payment_type=${paymentType} — processing with generic booking path`);
    } else {
      logWebhookRouting(paymentIntent, `${paymentType} — processing with generic booking path`);
    }

    // ── Step 1: Send owner + renter communications FIRST ─────────────────────
    // Notifications must NEVER depend on DB success.  They fire here, before any
    // persistence attempt, so the owner and customer are always notified even
    // when Supabase or the JSON store has a transient failure.
    // stripe-reconcile.js will backfill the stripe_fee later.
    {
      const _notifyMeta = paymentIntent.metadata || {};

      // Owner + customer emails (includes rental agreement PDF attachment)
      try {
        await sendWebhookNotificationEmails(paymentIntent);
      } catch (emailErr) {
        console.error("stripe-webhook: sendWebhookNotificationEmails error:", emailErr.message);
      }

      // Owner SMS — inform the business of every new confirmed booking
      if (process.env.OWNER_PHONE && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
        try {
          const ownerSmsText = [
            `🔔 New booking: ${sanitizeSmsValue(_notifyMeta.renter_name || "Unknown")}`,
            `Vehicle: ${sanitizeSmsValue(_notifyMeta.vehicle_name || _notifyMeta.vehicle_id || "")}`,
            `Dates: ${_notifyMeta.pickup_date || ""} → ${_notifyMeta.return_date || ""}`,
            `Amount: $${paymentIntent.amount ? (paymentIntent.amount / 100).toFixed(2) : "N/A"}`,
            `PI: ${paymentIntent.id}`,
          ].join("\n");
          await sendSms(normalizePhone(process.env.OWNER_PHONE), ownerSmsText.slice(0, MAX_ALERT_SMS_LENGTH));
        } catch (ownerSmsErr) {
          console.error("stripe-webhook: owner booking SMS error (non-fatal):", ownerSmsErr.message);
        }
      }

      // Renter SMS — booking confirmation to the customer
      if (_notifyMeta.renter_phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
        try {
          const smsBookingId = _notifyMeta.booking_id || _notifyMeta.original_booking_id || paymentIntent.id;
          const eventType = normalizeLifecycleEvent({
            paymentType,
            isPartialPayment: String(_notifyMeta.is_partial_payment || "").toLowerCase() === "true",
          });
          const manageLink = buildRenterOnboardingLink({
            bookingId: smsBookingId,
            vehicleId: _notifyMeta.vehicle_id,
          });
          await sendLifecycleSmsSequence({
            bookingId: smsBookingId,
            phone: _notifyMeta.renter_phone,
            eventType,
            smsContext: {
              customerName: _notifyMeta.renter_name || "",
              vehicleName: _notifyMeta.vehicle_name || _notifyMeta.vehicle_id || "your vehicle",
              pickupDate: _notifyMeta.pickup_date || "",
              pickupTime: _notifyMeta.pickup_time || "",
              returnDate: _notifyMeta.return_date || "",
              returnTime: _notifyMeta.return_time || "",
              bookingType: _notifyMeta.booking_type || "",
              bookingId: smsBookingId,
              vehicleId: _notifyMeta.vehicle_id || "",
              manageLink,
              paymentLink: _notifyMeta.balance_payment_link || manageLink,
            },
            source: "stripe_webhook:generic_booking",
            paymentState: String(_notifyMeta.is_partial_payment || "").toLowerCase() === "true" ? "partial" : "paid",
          });
        } catch (renterSmsErr) {
          console.error("stripe-webhook: renter booking SMS error (non-fatal):", renterSmsErr.message);
        }
      }
    }

    // ── Step 2: Fee resolution (non-blocking, reconcile backfills if missing) ─
    let feeFields = null;
    try {
      feeFields = await resolveStripeFeeFields(stripe, paymentIntent);
    } catch (feeErr) {
      console.error(
        `stripe-webhook: resolveStripeFeeFields failed for PI ${paymentIntent.id}` +
        ` — booking will be persisted without stripe_fee (backfilled by reconcile):`,
        feeErr
      );
    }

    // ── Step 3: Persist booking (Supabase + revenue record) ──────────────────
    // Runs AFTER notifications so DB failures never silence owner/renter alerts.
    // Returns 500 at the end so Stripe retries if persistence fails.
    let persistenceFailed = false;
    let savedBookingId = null;
    try {
      const saveResult = await saveWebhookBookingRecord(paymentIntent, feeFields || {});
      savedBookingId = saveResult?.bookingId || null;
    } catch (bookingErr) {
      persistenceFailed = true;
      // Log the full error (including stack) so the cause is visible in Vercel logs.
      console.error("stripe-webhook: saveWebhookBookingRecord error:", bookingErr);
    }

    // ── Step 4: Block the booked dates and mark the vehicle unavailable ───────
    if (vehicle_id && pickup_date && return_date) {
      try {
        await blockBookedDates(vehicle_id, pickup_date, return_date, meta_pickup_time || "", meta_return_time || "");
      } catch (err) {
        console.error("stripe-webhook: blockBookedDates error:", err);
      }
      try {
        await markVehicleUnavailable(vehicle_id);
      } catch (err) {
        console.error("stripe-webhook: markVehicleUnavailable error:", err);
      }
    } else {
      logWebhookSkip(
        paymentIntent,
        `calendar/fleet updates skipped — missing metadata vehicle_id=${vehicle_id || "<missing>"} pickup_date=${pickup_date || "<missing>"} return_date=${return_date || "<missing>"}`
      );
    }

    // Return 500 so Stripe retries for persistence failures.
    // Notifications have already been dispatched above.
    if (persistenceFailed) {
      return res.status(500).json({
        received: false,
        error: `booking persistence failed for ${paymentIntent.id} — check server logs for db_atomic_error or db_step_error entries`,
      });
    }

    // Unified pipeline: revenue guarantee (idempotent — saveWebhookBookingRecord
    // above already recorded it via persistBooking; this is a safety net).
    try {
      await processStripePayment(stripe, paymentIntent, {
        bookingId:        savedBookingId || undefined,
        preResolvedGross: feeFields ? ((paymentIntent.amount_received || paymentIntent.amount || 0) / 100) : undefined,
        preResolvedFee:   feeFields?.stripeFee  ?? undefined,
        preResolvedNet:   feeFields?.stripeNet  ?? undefined,
      });
    } catch (pspErr) {
      console.warn("stripe-webhook: full_payment processStripePayment failed (non-fatal):", pspErr.message);
    }
  }

  // ── payment_intent.payment_failed ─────────────────────────────────────────
  // Behaviour depends on the payment type:
  //
  //  • Initial booking payments (full_payment / reservation_deposit):
  //    Cancel the pending/reserved_unpaid booking so dates are immediately
  //    released and the customer is not left with a phantom "balance_due" that
  //    blocks future bookings.  If the customer retries on the same PI and
  //    succeeds, the payment_intent.succeeded handler will upsert the booking
  //    back to booked_paid — the cancellation is safely overwritten.
  //
  //  • Post-rental payments (rental_extension, late_fee, violation_fee, etc.):
  //    Set balance_due on the booking so the customer can be notified via the
  //    balance_due retry SMS system in scheduled-reminders.js.
  if (event.type === "payment_intent.payment_failed") {
    const paymentIntent = event.data.object;
    const piMeta = paymentIntent.metadata || {};
    const paymentType = piMeta.payment_type || piMeta.type || "";
    const bookingRef  = piMeta.booking_id || piMeta.original_booking_id || "";
    const amountDue   = (paymentIntent.amount || 0) / 100;

    console.log("[PAYMENT_FAILED]", {
      pi_id:        paymentIntent.id,
      payment_type: paymentType,
      booking_ref:  bookingRef,
      amount_due:   amountDue,
    });

    const isInitialBooking = isInitialBookingPayment(paymentType);

    if (bookingRef && bookingRef.startsWith("bk-")) {
      try {
        const sbFail = getSupabaseAdmin();
        if (sbFail) {
          const nowIso = new Date().toISOString();

          if (isInitialBooking) {
            await transitionCheckoutBooking(sbFail, bookingRef, "[PAYMENT_FAILED]", "payment_failed", "stripe_payment_intent_failed");
          } else if (amountDue > 0) {
            // Post-rental payment failure — set balance_due for retry reminders.
            const { error: failErr } = await sbFail
              .from("bookings")
              .update({
                balance_due: amountDue,
                updated_at:  nowIso,
              })
              .eq("booking_ref", bookingRef);
            if (failErr) {
              console.warn("[PAYMENT_FAILED] balance_due update failed (non-fatal):", failErr.message);
            } else {
              console.log("[PAYMENT_FAILED] balance_due set", { bookingRef, amountDue });
              // Belt-and-suspenders: set balance_due_set_at only when not already
              // set.  The DB trigger (migration 0120) handles this automatically,
              // but this guard ensures correctness if the migration has not run yet.
              const { error: setAtErr } = await sbFail
                .from("bookings")
                .update({ balance_due_set_at: nowIso })
                .eq("booking_ref", bookingRef)
                .is("balance_due_set_at", null);
              if (setAtErr) {
                console.warn("[PAYMENT_FAILED] balance_due_set_at update failed (non-fatal):", setAtErr.message);
              }
            }
          }
        }
      } catch (failCatchErr) {
        console.warn("[PAYMENT_FAILED] booking update threw (non-fatal):", failCatchErr.message);
      }
    }

    return res.status(200).json({ received: true });
  }

  // ── payment_intent.canceled ────────────────────────────────────────────────
  // Fires when a Stripe PaymentIntent is explicitly cancelled (e.g. the PI
  // expires or is voided by the system).  For initial booking PIs cancel the
  // corresponding pending/reserved_unpaid booking so dates are released and the
  // admin does not see phantom "Pending" entries.
  //
  // NOTE: This event must be enabled in the Stripe webhook dashboard under
  //   Developers → Webhooks → [your endpoint] → Events to send:
  //   add "payment_intent.canceled".
  if (event.type === "payment_intent.canceled") {
    const paymentIntent = event.data.object;
    const piMeta = paymentIntent.metadata || {};
    const paymentType = piMeta.payment_type || piMeta.type || "";
    const bookingRef  = piMeta.booking_id || "";

    console.log("[PAYMENT_CANCELED]", {
      pi_id:        paymentIntent.id,
      payment_type: paymentType,
      booking_ref:  bookingRef,
    });

    if (bookingRef && bookingRef.startsWith("bk-") && isInitialBookingPayment(paymentType)) {
      try {
        const sbCancel = getSupabaseAdmin();
        if (sbCancel) {
          await transitionCheckoutBooking(sbCancel, bookingRef, "[PAYMENT_CANCELED]", "abandoned_checkout", "stripe_payment_intent_canceled");
        }
      } catch (cancelCatchErr) {
        console.warn("[PAYMENT_CANCELED] booking cancel threw (non-fatal):", cancelCatchErr.message);
      }
    }

    return res.status(200).json({ received: true });
  }

  // ── charge.refunded ───────────────────────────────────────────────────────
  // Fires when a charge is refunded (partially or fully) via the Stripe
  // dashboard or API.  On a FULL refund we automatically:
  //   1. Resolve the booking_ref (via PI metadata or payment_intent_id lookup)
  //   2. Cancel the booking in Supabase (status → "cancelled")
  //   3. Delete the blocked_dates row so the vehicle becomes bookable again
  //
  // Partial refunds are logged but do not trigger automatic cancellation —
  // they are often goodwill adjustments that do not cancel the rental.
  if (event.type === "charge.refunded") {
    const charge = event.data.object;
    const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
    const fullyRefunded = charge.refunded === true;
    const amountRefunded = (charge.amount_refunded || 0) / 100;

    console.log("[CHARGE_REFUNDED]", {
      charge_id:       charge.id,
      payment_intent:  piId || "<none>",
      fully_refunded:  fullyRefunded,
      amount_refunded: amountRefunded,
    });

    if (!fullyRefunded) {
      console.log("[CHARGE_REFUNDED] partial refund — no automatic booking cancellation", {
        charge_id:       charge.id,
        amount_refunded: amountRefunded,
      });
      // ── Ledger: record partial refund debit (idempotent on charge ID) ──
      if (amountRefunded > 0) {
        try {
          let partialRefBookingRef = null;
          const partialMeta = charge.metadata || {};
          const partialMetaRef = partialMeta.booking_id || partialMeta.booking_ref || partialMeta.original_booking_id || "";
          if (partialMetaRef && partialMetaRef.startsWith("bk-")) {
            partialRefBookingRef = await resolveBookingId(partialMetaRef);
          }
          if (!partialRefBookingRef && piId) {
            partialRefBookingRef = await resolveBookingIdByPaymentIntent(piId);
          }
          if (partialRefBookingRef) {
            const sbPartialRefund = getSupabaseAdmin();
            if (sbPartialRefund) {
              const ledgerResult = await addLedgerRefund(sbPartialRefund, {
                bookingId:               partialRefBookingRef,
                chargeId:                charge.id,
                stripePaymentIntentId:   piId || undefined,
                amount:                  amountRefunded,
                notes:                   `Partial refund — $${amountRefunded.toFixed(2)} returned to renter`,
              });
              console.log("[LEDGER_PARTIAL_REFUND]", {
                booking_ref:  partialRefBookingRef,
                charge_id:    charge.id,
                amount:       amountRefunded,
                duplicate:    ledgerResult.duplicate,
              });
            }
          }
        } catch (partialLedgerErr) {
          console.error("[CHARGE_REFUNDED] partial refund ledger write failed (non-fatal):", partialLedgerErr.message);
        }
      }
      return res.status(200).json({ received: true });
    }

    // Resolve booking_ref — try metadata first, then payment_intent_id lookup.
    let refundBookingRef = null;
    const chargeMeta = charge.metadata || {};
    const metaRef = chargeMeta.booking_id || chargeMeta.booking_ref || chargeMeta.original_booking_id || "";
    if (metaRef && metaRef.startsWith("bk-")) {
      refundBookingRef = await resolveBookingId(metaRef);
    }
    if (!refundBookingRef && piId) {
      refundBookingRef = await resolveBookingIdByPaymentIntent(piId);
    }

    if (!refundBookingRef) {
      console.warn("[CHARGE_REFUNDED] could not resolve booking_ref — no booking to cancel", {
        charge_id:      charge.id,
        payment_intent: piId || "<none>",
      });
      return res.status(200).json({ received: true });
    }

    const sbRefund = getSupabaseAdmin();
    if (!sbRefund) {
      console.warn("[CHARGE_REFUNDED] Supabase unavailable — skipping booking cancellation for", refundBookingRef);
      return res.status(200).json({ received: true });
    }

    // Fetch the booking row to check status and get vehicle_id.
    let refundBookingRow = null;
    try {
      const { data: rbData, error: rbErr } = await sbRefund
        .from("bookings")
        .select("id, status, vehicle_id")
        .eq("booking_ref", refundBookingRef)
        .maybeSingle();
      if (rbErr) throw rbErr;
      refundBookingRow = rbData;
    } catch (fetchErr) {
      console.error("[CHARGE_REFUNDED] booking row fetch failed (non-fatal):", fetchErr.message);
      return res.status(200).json({ received: true });
    }

    if (!refundBookingRow) {
      console.warn("[CHARGE_REFUNDED] booking row not found for", refundBookingRef);
      return res.status(200).json({ received: true });
    }

    // Skip if already cancelled or completed — nothing to do.
    const REFUND_SKIP_STATUSES = ["cancelled", "cancelled_rental", "completed"];
    if (REFUND_SKIP_STATUSES.includes(refundBookingRow.status)) {
      console.log("[CHARGE_REFUNDED] booking already cancelled/completed — no action taken", {
        booking_ref: refundBookingRef,
        status:      refundBookingRow.status,
      });
      return res.status(200).json({ received: true });
    }

    // Phase C shadow-mode customer-ledger append (non-blocking).
    await appendStripeRefundToCustomerLedger({
      bookingRef: refundBookingRef,
      charge,
      amountDollars: amountRefunded,
    });

    // Step 1: Cancel the booking.
    try {
      const { error: cancelErr } = await sbRefund
        .from("bookings")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("booking_ref", refundBookingRef);
      if (cancelErr) throw cancelErr;
      console.log("[CHARGE_REFUNDED] booking cancelled", { booking_ref: refundBookingRef });
    } catch (cancelErr) {
      console.error("[CHARGE_REFUNDED] booking cancellation failed (non-fatal):", cancelErr.message);
    }

    // Step 2: Delete the blocked_dates row so the vehicle is bookable again.
    if (refundBookingRow.vehicle_id) {
      try {
        await autoReleaseBlockedDateOnReturn(refundBookingRow.vehicle_id, refundBookingRef);
        console.log("[CHARGE_REFUNDED] blocked_dates released", {
          vehicle_id:  refundBookingRow.vehicle_id,
          booking_ref: refundBookingRef,
        });
      } catch (releaseErr) {
        console.error("[CHARGE_REFUNDED] blocked_dates release failed (non-fatal):", releaseErr.message);
      }
    }

    // ── Ledger: record full refund debit (idempotent on charge ID) ───────
    if (amountRefunded > 0) {
      try {
        const sbRefundLedger = getSupabaseAdmin();
        if (sbRefundLedger) {
          const ledgerResult = await addLedgerRefund(sbRefundLedger, {
            bookingId:             refundBookingRef,
            chargeId:              charge.id,
            stripePaymentIntentId: piId || undefined,
            amount:                amountRefunded,
            notes:                 `Full refund — $${amountRefunded.toFixed(2)} returned to renter`,
          });
          console.log("[LEDGER_FULL_REFUND]", {
            booking_ref: refundBookingRef,
            charge_id:   charge.id,
            amount:      amountRefunded,
            duplicate:   ledgerResult.duplicate,
          });
        }
      } catch (refundLedgerErr) {
        console.error("[CHARGE_REFUNDED] full refund ledger write failed (non-fatal):", refundLedgerErr.message);
      }
    }

    return res.status(200).json({ received: true });
  }

  return res.status(200).json({ received: true });
}

// ── Named exports for stripe-replay.js ───────────────────────────────────────
// These allow the replay endpoint to call the exact same pipeline steps as the
// webhook's generic handler (full_payment / reservation_deposit path) without
// duplicating any logic. Each export is a self-contained async function with no
// shared mutable state — safe to call from any module.
export {
  saveWebhookBookingRecord,
  blockBookedDates,
  markVehicleUnavailable,
  sendWebhookNotificationEmails,
};
