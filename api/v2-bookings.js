// api/v2-bookings.js
// SLYTRANS FLEET CONTROL v2 — Bookings CRUD endpoint.
// Supports listing bookings and updating booking status (approve/decline).
//
// POST /api/v2-bookings
    // Actions:
    //   list      — { secret, action:"list", vehicleId?, status?, include_deleted? }
//   list_raw  — { secret, action:"list_raw" }  (unfiltered Supabase read — Phase 6)
//   update    — { secret, action:"update", vehicleId, bookingId, updates:{status,...} }
    //   delete    — { secret, action:"delete", bookingId, reason?, hardDelete? }
    //   restore   — { secret, action:"restore", bookingId }
//   create    — { secret, action:"create", ...bookingFields } (manual booking)
//
// Booking automation (triggered automatically, non-fatal):
//   On create (booked_paid) or status → "booked_paid" / "active_rental":
//   1. Revenue record created in Supabase revenue_records table.
//   2. Customer upserted in Supabase customers table.
//   3. Booking synced to Supabase bookings table.
//   4. Blocked dates inserted in Supabase blocked_dates table.
//   On status → "completed_rental":
//   5. Customer stats incremented.
//   6. completedAt timestamp stamped automatically.
//   7. Blocked date range removed from booked-dates.json (restores availability).
//   On status → "cancelled_rental":
//   1-4 skipped; no revenue or stats updated.
//   8. Blocked date range removed from booked-dates.json.

import crypto from "crypto";
import nodemailer from "nodemailer";
import { loadBookings, saveBookings, normalizePhone } from "./_bookings.js";
import { hasOverlap, hasDateTimeOverlap } from "./_availability.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { withAdminAuth } from "./_middleware.js";
import { APP_TO_DB_STATUS, isIncompleteCheckoutAppStatus, toAppBookingStatus } from "./_booking-status.js";
import {
  autoCreateRevenueRecord,
  autoUpsertCustomer,
  autoUpsertBooking,
  autoCreateBlockedDate,
  autoReleaseBlockedDateOnReturn,
  parseTime12h,
  writeAuditLog,
} from "./_booking-automation.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { persistBooking } from "./_booking-pipeline.js";
import { CARS, computeRentalDays, getAllVehicleIds, getActiveVehicleIds } from "./_pricing.js";
import { loadPricingSettings, computeBreakdownLinesFromSettings } from "./_settings.js";
import { generateRentalAgreementPdf } from "./_rental-agreement-pdf.js";
import { buildUnifiedConfirmationEmail, buildDocumentNotes, isWebsitePaymentMethod } from "./_booking-confirmation-template.js";
import { normalizeVehicleId, uiVehicleId } from "./_vehicle-id.js";
import { render, BOOKING_CONFIRMED, BOOKING_ONBOARDING } from "./_sms-templates.js";
import { triggerMaintenanceUpdate } from "./update-maintenance-status.js";
import { normalizeClockTime, isoDateInLA } from "./_time.js";
import { createManageToken } from "./_manage-booking-token.js";
import { getVehicleById, loadVehicles } from "./_vehicles.js";
import { resolvePickupLocation } from "./_pickup-location.js";
import { sendDedupedSms } from "./_sms-log.js";
import { computePaymentPlanProgress } from "./_payment-plan-reconcile.js";
import { shouldSendBookingLifecycleSms } from "./_sms-rollout.js";
import { loadAgreementPathForDownload, loadAgreementSummaryMap } from "./_agreement-automation.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const VEHICLE_NAMES    = {
  camry:      "Camry 2012",
  camry2013:  "Camry 2013 SE",
  fusion2017: "Ford Fusion 2017",
};

// Mapping from app-level status values (used in bookings.json and the admin UI)
// to database-level status values (used in the Supabase bookings table).
// Migration 0081 expands the DB constraint to include all modern values so
// every status here is directly accepted by Supabase without a constraint error.
const GITHUB_REPO       = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";

// App-level status values that indicate a rental is in progress (vehicle picked up).
// Used by the cancellation guard to require explicit confirmation before overriding.
const ACTIVE_RENTAL_STATUSES = new Set(["active_rental", "overdue", "extended"]);

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function resolveBookingRemainingBalance(row = {}, fallback = 0) {
  const totalPrice = Number(row.total_price || 0);
  const depositPaid = Number(row.deposit_paid || 0);
  const storedRemaining = Number(row.remaining_balance || 0);
  if (storedRemaining > 0) return roundMoney(storedRemaining);
  if (totalPrice > 0 && depositPaid < totalPrice) {
    return roundMoney(totalPrice - depositPaid);
  }
  return roundMoney(fallback || 0);
}

function parseBookingDateTimeInLA(dateValue, timeValue) {
  if (!dateValue || !timeValue) return null;
  const time = String(timeValue).trim();
  const ampmMatch = time.match(/^(\d{1,2}):([0-5]\d)\s*(AM|PM)$/i);
  let hhmm = null;
  if (ampmMatch) {
    let hour = parseInt(ampmMatch[1], 10);
    const minute = ampmMatch[2];
    const period = ampmMatch[3].toUpperCase();
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    hhmm = `${String(hour).padStart(2, "0")}:${minute}`;
  } else {
    const h24Match = time.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (h24Match) hhmm = `${String(parseInt(h24Match[1], 10)).padStart(2, "0")}:${h24Match[2]}`;
  }
  if (!hhmm) return null;
  const laAsUtcProbe = new Date(`${dateValue}T${hhmm}:00Z`);
  if (Number.isNaN(laAsUtcProbe.getTime())) return null;
  try {
    const tzPart = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "longOffset",
    }).formatToParts(laAsUtcProbe).find((part) => part.type === "timeZoneName")?.value || "";
    const offsetMatch = tzPart.match(/GMT([+-]\d{1,2}:\d{2})/);
    const offset = offsetMatch ? offsetMatch[1] : "-08:00";
    const dt = new Date(`${dateValue}T${hhmm}:00${offset}`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  } catch {
    const fallbackDt = new Date(`${dateValue}T${hhmm}:00-08:00`);
    return Number.isNaN(fallbackDt.getTime()) ? null : fallbackDt;
  }
}

function deriveBookingLifecycleState(row, now = new Date()) {
  const baseStatus = toAppBookingStatus(row?.status);
  if (row?.flagged) return "flagged";
  if (baseStatus === "active_rental") {
    const returnDateTime = parseBookingDateTimeInLA(row?.return_date, row?.return_time);
    if (returnDateTime && now >= returnDateTime) return "overdue";
    if (Number(row?.extension_count || 0) > 0) return "extended";
  }
  return baseStatus;
}

function deriveBookingWorkflowStatus(lifecycleState) {
  const status = String(lifecycleState || "").toLowerCase();
  if (["pending_checkout", "upload_failed", "payment_failed", "abandoned_checkout"].includes(status)) return "checkout";
  if (["reserved_unpaid", "booked_paid"].includes(status)) return "reservation";
  if (["active_rental", "overdue", "extended", "flagged"].includes(status)) return "in_rental";
  if (status === "completed_rental") return "closed";
  if (status === "cancelled_rental") return "cancelled";
  return "unknown";
}

function deriveCustomerTier(cust = {}) {
  if (cust.banned) return "risky";
  if (cust.flagged || cust.risk_flag === "high" || Number(cust.no_show_count || 0) >= 2) return "risky";
  const totalProfit = cust.total_profit != null ? Number(cust.total_profit) : null;
  const totalBookings = Number(cust.total_bookings || 0);
  if (totalProfit != null && totalProfit < 0) return "unprofitable";
  if (totalProfit != null && totalProfit >= 500 && totalBookings >= 3) return "vip";
  return "standard";
}

function buildOperationalEventHistory(row = {}) {
  const events = [];
  const pushIfPresent = (type, at, meta = null) => {
    if (!at) return;
    events.push({ type, at, meta });
  };
  pushIfPresent("booking_created", row.created_at);
  pushIfPresent("booking_updated", row.updated_at);
  if (row.pickup_date) pushIfPresent("pickup_scheduled", row.pickup_date, row.pickup_time ? { time: row.pickup_time } : null);
  if (row.return_date) pushIfPresent("return_scheduled", row.return_date, row.return_time ? { time: row.return_time } : null);
  pushIfPresent("late_fee_approved", row.late_fee_approved_at, row.late_fee_amount != null ? { amount: Number(row.late_fee_amount) } : null);
  if (Number(row.extension_count || 0) > 0) {
    pushIfPresent("extension_count_recorded", row.updated_at || row.created_at, { count: Number(row.extension_count || 0) });
  }
  return events;
}

function schemaMismatchDiagnostics(err) {
  const message = String(err?.message || "");
  const code = String(err?.code || "");
  const columnMatch = message.match(/column\s+("?[\w.]+"?)\s+does not exist/i);
  const relationMatch = message.match(/relation\s+("?[\w.]+"?)\s+does not exist/i);
  const schemaCacheMatch = message.match(/Could not find the ['"]?([^'"]+)['"]? in the schema cache/i);
  const missingColumn = columnMatch?.[1] || null;
  const missingRelation = relationMatch?.[1] || null;
  const schemaCacheEntity = schemaCacheMatch?.[1] || null;
  const missingToken = (missingColumn || schemaCacheEntity || missingRelation || "").toLowerCase();
  return {
    code,
    message,
    missingColumn,
    missingRelation,
    schemaCacheEntity,
    suggestsMissing0171: missingToken.includes("extension_risk_override"),
  };
}


function buildBalanceLinkForBooking(row = {}) {
  if (row.balance_payment_link) return String(row.balance_payment_link).trim();
  const base = "https://slycarrentals.com/balance.html";
  const p = new URLSearchParams();
  const vid = uiVehicleId(row.vehicle_id || "");
  if (vid) p.set("v", vid);
  if (row.pickup_date) p.set("p", row.pickup_date);
  if (row.return_date) p.set("r", row.return_date);
  if (row.customer_email) p.set("e", row.customer_email);
  if (row.booking_ref) p.set("b", row.booking_ref);
  if (row.payment_intent_id) p.set("opi", row.payment_intent_id);
  return `${base}?${p.toString()}`;
}

function normalizeStoredDocBase64(base64Value) {
  if (!base64Value || typeof base64Value !== "string") return "";
  return base64Value.replace(/\s+/g, "").replace(/^data:.*;base64,/, "");
}

function mergeBookingConfirmationSource(existingBooking = null, row = null) {
  if (!row) return existingBooking;
  const cust = row.customers || {};
  const nextVehicleId = uiVehicleId(row.vehicle_id || existingBooking?.vehicleId || "");
  return {
    ...(existingBooking || {}),
    bookingId:       row.booking_ref || existingBooking?.bookingId || "",
    vehicleId:       nextVehicleId || existingBooking?.vehicleId || "",
    vehicleName:     VEHICLE_NAMES[nextVehicleId] || existingBooking?.vehicleName || row.vehicle_id || "",
    name:            row.customer_name || cust.name || existingBooking?.name || "",
    email:           row.customer_email || cust.email || existingBooking?.email || "",
    phone:           row.customer_phone || row.renter_phone || cust.phone || existingBooking?.phone || "",
    pickupDate:      row.pickup_date || existingBooking?.pickupDate || "",
    pickupTime:      row.pickup_time || existingBooking?.pickupTime || "",
    returnDate:      row.return_date || existingBooking?.returnDate || "",
    returnTime:      row.return_time || existingBooking?.returnTime || "",
    amountPaid:      row.deposit_paid != null ? Number(row.deposit_paid || 0) : Number(existingBooking?.amountPaid || 0),
    totalPrice:      row.total_price != null ? Number(row.total_price || 0) : Number(existingBooking?.totalPrice || 0),
    status:          row.status ? toAppBookingStatus(row.status) : (existingBooking?.status || ""),
    paymentIntentId: row.payment_intent_id || existingBooking?.paymentIntentId || "",
    paymentStatus:   row.payment_status || existingBooking?.paymentStatus || "",
    paymentMethod:   row.payment_method || existingBooking?.paymentMethod || "",
    notes:           row.notes ?? existingBooking?.notes ?? "",
  };
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
  const getResp = await fetch(apiUrl, { headers: ghHeaders() });
  if (!getResp.ok) {
    if (getResp.status === 404) return { data: {}, sha: null };
    return { data: {}, sha: null }; // non-fatal
  }
  const fileData = await getResp.json();
  let data = {};
  try {
    data = JSON.parse(Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (typeof data !== "object" || Array.isArray(data)) data = {};
  } catch {
    data = {};
  }
  return { data, sha: fileData.sha };
}

async function saveBookedDates(_data, _sha, _message) {
  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  console.log("v2-bookings: saveBookedDates() called but writes are disabled (Phase 4)");
}

async function blockBookedDates(_vehicleId, _from, _to) {
  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  console.log("v2-bookings: blockBookedDates() called but writes are disabled (Phase 4)");
}

async function unblockBookedDates(_vehicleId, _from, _to) {
  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  console.log("v2-bookings: unblockBookedDates() called but writes are disabled (Phase 4)");
}

export default withAdminAuth(async function handler(req, res) {
  const body   = req.body || {};
  const { action } = body;

  try {
    // Resolve the full set of known vehicle IDs from the DB on each request so
    // newly-added vehicles are immediately visible in all list/create actions
    // without requiring a code re-deploy.  Falls back to the static list when
    // Supabase is unavailable.
    const ALLOWED_VEHICLES = await getAllVehicleIds(getSupabaseAdmin());

    // ── LIST ────────────────────────────────────────────────────────────────
    // Primary source: Supabase bookings table (includes all Stripe webhook
    // bookings saved by saveWebhookBookingRecord).  Falls back to bookings.json
    // so the admin always sees data even when Supabase is unreachable.
    if (action === "list" || !action) {
      const { vehicleId, status, scope, include_deleted: includeDeletedRaw } = body;
      const includeDeleted = includeDeletedRaw === true;

      // When scope='car' is provided, restrict the vehicle
      // list to the matching fleet type so each admin panel only sees its own
      // bookings.
      let effectiveVehicles = ALLOWED_VEHICLES;
      if (scope) {
        try {
          const BOOKING_CAR_TYPES = new Set(["car", "economy", "luxury", "suv", "truck", "van"]);
          const sc = scope.toLowerCase();
          const { data: vData } = await loadVehicles();
          const scopedIds = Object.values(vData || {})
            .filter((v) => {
              const t = (v.type || "").toLowerCase();
              // Vehicles with no type recorded default to the car fleet.
              if (sc === "car" || sc === "cars") return BOOKING_CAR_TYPES.has(t) || t === "";
              return true;
            })
            .map((v) => v.vehicle_id)
            .filter(Boolean);
          if (scopedIds.length > 0) {
            const scopedSet = new Set(scopedIds);
            effectiveVehicles = ALLOWED_VEHICLES.filter((id) => scopedSet.has(id));
          }
        } catch (scopeErr) {
          console.warn("v2-bookings list: scope vehicle lookup failed (non-fatal):", scopeErr.message);
        }
      }

      const sb = getSupabaseAdmin();
      if (sb) {
        // Build the query with filters BEFORE .order() so the chain terminates
        // correctly (the Supabase JS SDK — and our test stubs — resolve on .order()).
        const LIST_SELECT_FULL = `
          id,
          booking_ref,
          vehicle_id,
          pickup_date,
          return_date,
          pickup_time,
          return_time,
          status,
          total_price,
          deposit_paid,
          remaining_balance,
          payment_status,
          payment_method,
          payment_intent_id,
          stripe_customer_id,
          stripe_payment_method_id,
          extension_stripe_customer_id,
          extension_stripe_payment_method_id,
          flagged,
          risk_score,
          notes,
          created_at,
          updated_at,
          extension_count,
          late_fee_amount,
          late_fee_status,
          late_fee_approved_at,
          late_fee_waived,
          late_fee_waived_amount,
          deleted_at,
          deleted_by,
          deleted_reason,
          extension_risk_override,
          extend_pending,
          extension_pending_payment,
          customers ( id, name, phone, email, risk_flag, flagged, banned, total_profit, total_bookings, no_show_count )
        `;

        const LIST_SELECT_COMPAT = `
          id,
          booking_ref,
          vehicle_id,
          pickup_date,
          return_date,
          pickup_time,
          return_time,
          status,
          total_price,
          deposit_paid,
          remaining_balance,
          payment_status,
          payment_method,
          payment_intent_id,
          stripe_customer_id,
          stripe_payment_method_id,
          extension_stripe_customer_id,
          extension_stripe_payment_method_id,
          flagged,
          risk_score,
          notes,
          created_at,
          updated_at,
          extension_count,
          late_fee_amount,
          late_fee_status,
          late_fee_approved_at,
          late_fee_waived,
          late_fee_waived_amount,
          deleted_at,
          deleted_by,
          deleted_reason,
          customers ( id, name, phone, email )
        `;

        const buildListQuery = (selectClause, excludeDeleted) => {
          let q = sb.from("bookings").select(selectClause);
          if (vehicleId && effectiveVehicles.includes(vehicleId)) {
            q = q.eq("vehicle_id", vehicleId);
          } else {
            q = q.in("vehicle_id", effectiveVehicles);
          }
          if (excludeDeleted) {
            q = q.is("deleted_at", null);
          }
          if (status) q = q.eq("status", status);
          return q;
        };

        let usedCompatibilitySelect = false;
        let usedLegacyDeletedFallback = false;
        let { data: rows, error } = await buildListQuery(LIST_SELECT_FULL, !includeDeleted).order("created_at", { ascending: false });
        if (error && isSchemaError(error)) {
          const details = schemaMismatchDiagnostics(error);
          console.warn("v2-bookings list: schema mismatch on full select, retrying with compatibility columns:", details);
          if (details.suggestsMissing0171) {
            console.warn("v2-bookings list: extension_risk_override appears missing; apply migration 0171_bookings_extension_risk_override.sql");
          }
          usedCompatibilitySelect = true;
          ({ data: rows, error } = await buildListQuery(LIST_SELECT_COMPAT, !includeDeleted).order("created_at", { ascending: false }));
        }
        if (error && isSchemaError(error)) {
          const details = schemaMismatchDiagnostics(error);
          console.warn("v2-bookings list: retrying legacy query without deleted_at filter:", details);
          usedLegacyDeletedFallback = true;
          ({ data: rows, error } = await buildListQuery(LIST_SELECT_COMPAT, false).order("created_at", { ascending: false }));
        }

        if (!error) {
          if (usedCompatibilitySelect || usedLegacyDeletedFallback) {
            console.warn("v2-bookings list: compatibility fallback served request; production schema drift remains.", {
              usedCompatibilitySelect,
              usedLegacyDeletedFallback,
            });
          }
          // Fetch revenue_records for financial totals (best-effort; non-fatal)
          let revenueByBookingId = {};
          try {
            const bookingRefs = (rows || []).map((r) => r.booking_ref || String(r.id)).filter(Boolean);
            if (bookingRefs.length) {
              const { data: rrRows } = await sb
                .from("revenue_records_effective")
                .select("booking_id, gross_amount, stripe_fee, stripe_net, payment_method, customer_name, customer_phone, customer_email")
                .in("booking_id", bookingRefs);
              for (const rr of (rrRows || [])) {
                if (!rr?.booking_id) continue;
                if (!revenueByBookingId[rr.booking_id]) {
                  revenueByBookingId[rr.booking_id] = {
                    gross_amount:   0,
                    stripe_fee:     null,
                    stripe_net:     null,
                    payment_method: rr.payment_method || null,
                    customer_name:  rr.customer_name  || null,
                    customer_phone: rr.customer_phone || null,
                    customer_email: rr.customer_email || null,
                  };
                }
                const agg = revenueByBookingId[rr.booking_id];
                const gross = Number(rr.gross_amount || 0);
                if (Number.isFinite(gross)) agg.gross_amount += gross;

                const fee = rr.stripe_fee != null ? Number(rr.stripe_fee) : null;
                if (fee != null && Number.isFinite(fee)) {
                  agg.stripe_fee = (agg.stripe_fee == null ? 0 : agg.stripe_fee) + fee;
                }

                const net = rr.stripe_net != null ? Number(rr.stripe_net) : null;
                if (net != null && Number.isFinite(net)) {
                  agg.stripe_net = (agg.stripe_net == null ? 0 : agg.stripe_net) + net;
                }

                if (!agg.payment_method && rr.payment_method) agg.payment_method = rr.payment_method;
                if (!agg.customer_name  && rr.customer_name)  agg.customer_name  = rr.customer_name;
                if (!agg.customer_phone && rr.customer_phone) agg.customer_phone = rr.customer_phone;
                if (!agg.customer_email && rr.customer_email) agg.customer_email = rr.customer_email;
              }
            }
          } catch (_e) { /* non-fatal */ }

          const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
          const bookings = (rows || []).map((r) => {
            const bookingRef = r.booking_ref || String(r.id);
            const rr = revenueByBookingId[bookingRef] || null;
            const lifecycleState = deriveBookingLifecycleState(r);
            const workflowStatus = deriveBookingWorkflowStatus(lifecycleState);
            const totalPrice = Number(r.total_price || 0);
            const amountPaid = Number(r.deposit_paid || 0);
            const remaining = resolveBookingRemainingBalance(r);
            const gross      = round2(rr ? Number(rr.gross_amount || 0) : totalPrice);
            const stripeFee  = rr && rr.stripe_fee != null ? round2(rr.stripe_fee) : null;
            const amountNet  = rr && rr.stripe_net != null
              ? round2(rr.stripe_net)
              : (stripeFee != null ? round2(gross - stripeFee) : null);
            const cust = r.customers || {};
            const customerTier = deriveCustomerTier(cust);
            return {
              bookingId:       bookingRef,
              dbId:            r.id,
              vehicleId:       uiVehicleId(r.vehicle_id),
              vehicleName:     VEHICLE_NAMES[uiVehicleId(r.vehicle_id)] || r.vehicle_id,
              name:            cust.name  || rr?.customer_name  || "",
              phone:           cust.phone || rr?.customer_phone || "",
              email:           cust.email || rr?.customer_email || "",
              pickupDate:      r.pickup_date  || "",
              pickupTime:      r.pickup_time  || "",
              returnDate:      r.return_date  || "",
              returnTime:      r.return_time  || "",
              location:        "",
              status:          toAppBookingStatus(r.status),
              lifecycleState,
              workflowStatus,
              amountPaid,
              totalPrice,
              remaining,
              paymentStatus:   r.payment_status  || "",
              paymentMethod:   r.payment_method  || "",
              paymentIntentId: r.payment_intent_id || "",
              hasSavedCard:    !!(
                (r.stripe_customer_id && r.stripe_payment_method_id) ||
                (r.extension_stripe_customer_id && r.extension_stripe_payment_method_id)
              ),
              flagged:         r.flagged || false,
              riskScore:       r.risk_score || 0,
              // Financial
              amountGross:     gross,
              stripeFee,
              amountNet,
              // Customer insight
              custRiskFlag:    cust.risk_flag    || "low",
              custFlagged:     cust.flagged      || false,
              custBanned:      cust.banned       || false,
              custTotalProfit: cust.total_profit != null ? Number(cust.total_profit) : null,
              custBookings:    cust.total_bookings || 0,
              custNoShows:     cust.no_show_count  || 0,
              customerTier,
              financialSnapshot: {
                amountPaid,
                totalPrice,
                remaining,
                amountGross: gross,
                stripeFee,
                amountNet,
              },
              operationalEventHistory: buildOperationalEventHistory(r),
              notes:           r.notes || "",
              smsSentAt:       {},
              createdAt:       r.created_at,
              updatedAt:       r.updated_at || null,
              extensionCount:  r.extension_count  || 0,
              lateFeeAmount:   r.late_fee_amount != null ? Number(r.late_fee_amount) : null,
              lateFeeStatus:   r.late_fee_status || null,
              lateFeeApprovedAt: r.late_fee_approved_at || null,
              lateFeeWaived:   r.late_fee_waived || false,
              lateFeeWaivedAmount: r.late_fee_waived_amount != null ? Number(r.late_fee_waived_amount) : null,
              deletedAt:       r.deleted_at || null,
              deletedBy:       r.deleted_by || null,
              deletedReason:   r.deleted_reason || null,
              extensionRiskOverride: r.extension_risk_override || null,
              extensionPaymentPending: !!r.extend_pending,
              pendingExtensionReturnDate: r.extension_pending_payment?.newReturnDate || null,
              pendingExtensionReturnTime: r.extension_pending_payment?.newReturnTime || null,
              pendingExtensionAmount:     r.extension_pending_payment?.extensionTotal != null ? Number(r.extension_pending_payment.extensionTotal) : null,
              pendingExtensionPaid:       r.extension_pending_payment?.amountPaid != null ? Number(r.extension_pending_payment.amountPaid) : null,
              pendingExtensionRemaining:  r.extension_pending_payment?.remainingBalance != null ? Number(r.extension_pending_payment.remainingBalance) : null,
              _source:         "supabase",
            };
          });
          try {
            const summaryMap = await loadAgreementSummaryMap(
              sb,
              bookings.map((booking) => booking.bookingId)
            );
            for (const booking of bookings) {
              const history = summaryMap.get(booking.bookingId) || [];
              booking.currentAgreement = history[0] || null;
              booking.agreements = history;
            }
          } catch {
            for (const booking of bookings) {
              booking.currentAgreement = null;
              booking.agreements = [];
            }
          }
          const adminVisibleBookings = bookings.filter((b) => !isIncompleteCheckoutAppStatus(b.status));
          return res.status(200).json({ bookings: adminVisibleBookings });
        }

        console.error("v2-bookings list: Supabase error, falling back to bookings.json:", error.message);
      }

      // Fallback: bookings.json
      const { data } = await loadBookings();
      let result = [];
      if (vehicleId && effectiveVehicles.includes(vehicleId)) {
        result = data[vehicleId] || [];
      } else {
        for (const vid of effectiveVehicles) {
          result = result.concat((data[vid] || []).map((b) => ({ ...b, vehicleId: b.vehicleId || vid })));
        }
      }

      result = result.filter((b) => !isIncompleteCheckoutAppStatus(toAppBookingStatus(b.status)));

      if (status) {
        result = result.filter((b) => toAppBookingStatus(b.status) === status);
      }

      // Newest first
      result.sort((a, b) => (b.createdAt || b.pickupDate || "") > (a.createdAt || a.pickupDate || "") ? 1 : -1);
      result = result.map((booking) => ({
        ...booking,
        currentAgreement: booking.currentAgreement || null,
        agreements: Array.isArray(booking.agreements) ? booking.agreements : [],
      }));

      return res.status(200).json({ bookings: result });
    }

    // ── LIST_RAW (Phase 6) — unfiltered direct Supabase read ─────────────────
    // Returns every row from the Supabase bookings table with no status/vehicle
    // filters and no aggregation.  Used by the admin panel to verify data
    // consistency independently of the bookings.json flat-file store.
    // Falls back to the same flat-file data as "list" when Supabase is not
    // configured, so the admin never sees an empty table due to misconfiguration.
    if (action === "list_raw") {
      const { scope, include_deleted: includeDeletedRaw } = body;
      const includeDeleted = includeDeletedRaw !== false;

      // When scope='car' is provided, restrict results to
      // vehicles in the matching fleet so each admin panel only sees its own data.
      let rawScopedIds = null;
      if (scope) {
        try {
          const RAW_CAR_TYPES = new Set(["car", "economy", "luxury", "suv", "truck", "van"]);
          const sc = scope.toLowerCase();
          const { data: vData } = await loadVehicles();
          rawScopedIds = Object.values(vData || {})
            .filter((v) => {
              const t = (v.type || "").toLowerCase();
              if (sc === "car" || sc === "cars") return RAW_CAR_TYPES.has(t) || t === "";
              return true;
            })
            .map((v) => v.vehicle_id)
            .filter(Boolean);
        } catch (scopeErr) {
          console.warn("v2-bookings list_raw: scope vehicle lookup failed (non-fatal):", scopeErr.message);
        }
      }

      const sb = getSupabaseAdmin();
      if (sb) {
        const LIST_RAW_SELECT_FULL = `
            id,
            booking_ref,
            vehicle_id,
            pickup_date,
            return_date,
            pickup_time,
            return_time,
            status,
            total_price,
            deposit_paid,
            remaining_balance,
            payment_status,
            payment_method,
            notes,
            created_at,
            updated_at,
            activated_at,
            completed_at,
            deleted_at,
            deleted_by,
            deleted_reason,
            customers ( id, name, phone, email )
          `;

        const LIST_RAW_SELECT_COMPAT = `
            id,
            booking_ref,
            vehicle_id,
            pickup_date,
            return_date,
            pickup_time,
            return_time,
            status,
            total_price,
            deposit_paid,
            remaining_balance,
            payment_status,
            payment_method,
            notes,
            created_at,
            updated_at,
            activated_at,
            completed_at,
            customers ( id, name, phone, email )
          `;

        const buildRawListQuery = (selectClause, excludeDeleted) => {
          let q = sb
          .from("bookings")
          .select(selectClause);

          if (rawScopedIds && rawScopedIds.length > 0) {
            q = q.in("vehicle_id", rawScopedIds);
          }
          if (excludeDeleted) {
            q = q.is("deleted_at", null);
          }
          return q;
        };

        let usedCompatibilitySelect = false;
        let usedLegacyDeletedFallback = false;
        let { data: rows, error } = await buildRawListQuery(LIST_RAW_SELECT_FULL, !includeDeleted).order("created_at", { ascending: false });
        if (error && isSchemaError(error)) {
          const details = schemaMismatchDiagnostics(error);
          console.warn("v2-bookings list_raw: schema mismatch on full select, retrying with compatibility columns:", details);
          usedCompatibilitySelect = true;
          ({ data: rows, error } = await buildRawListQuery(LIST_RAW_SELECT_COMPAT, !includeDeleted).order("created_at", { ascending: false }));
        }
        if (error && isSchemaError(error)) {
          const details = schemaMismatchDiagnostics(error);
          console.warn("v2-bookings list_raw: retrying legacy query without deleted_at filter:", details);
          usedLegacyDeletedFallback = true;
          ({ data: rows, error } = await buildRawListQuery(LIST_RAW_SELECT_COMPAT, false).order("created_at", { ascending: false }));
        }

        if (error) {
          console.error("v2-bookings list_raw Supabase error:", error.message);
          // Fall through to JSON fallback
        } else {
          if (usedCompatibilitySelect || usedLegacyDeletedFallback) {
            console.warn("v2-bookings list_raw: compatibility fallback served request; production schema drift remains.", {
              usedCompatibilitySelect,
              usedLegacyDeletedFallback,
            });
          }
          const bookings = (rows || []).map((r) => ({
            bookingId:       r.booking_ref || r.id,
            vehicleId:       r.vehicle_id,
            name:            r.customers?.name  || "",
            phone:           r.customers?.phone || "",
            email:           r.customers?.email || "",
            pickupDate:      r.pickup_date  || "",
            pickupTime:      r.pickup_time  || "",
            returnDate:      r.return_date  || "",
            returnTime:      r.return_time  || "",
            status:          toAppBookingStatus(r.status),
            amountPaid:      Number(r.deposit_paid   || 0),
            totalPrice:      Number(r.total_price    || 0),
            remaining:       resolveBookingRemainingBalance(r),
            paymentStatus:   r.payment_status,
            paymentMethod:   r.payment_method || "",
            notes:           r.notes || "",
            createdAt:       r.created_at,
            activatedAt:     r.activated_at  || null,
            completedAt:     r.completed_at  || null,
            deletedAt:       r.deleted_at || null,
            deletedBy:       r.deleted_by || null,
            deletedReason:   r.deleted_reason || null,
            _source:         "supabase",
          }));
          return res.status(200).json({ bookings, source: "supabase", total: bookings.length });
        }
      }

      // Fallback: return the same flat-file bookings as "list"
      const { data: fbData } = await loadBookings();
      let fbResult = [];
      for (const vid of ALLOWED_VEHICLES) {
        fbResult = fbResult.concat((fbData[vid] || []).map((b) => ({ ...b, vehicleId: b.vehicleId || vid, _source: "bookings_json" })));
      }
      fbResult.sort((a, b) => (b.createdAt || b.pickupDate || "") > (a.createdAt || a.pickupDate || "") ? 1 : -1);
      return res.status(200).json({ bookings: fbResult, source: "bookings_json", total: fbResult.length });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      const { vehicleId, bookingId, updates } = body;

      if (!vehicleId || !bookingId || !updates || typeof updates !== "object") {
        return res.status(400).json({ error: "vehicleId, bookingId, and updates are required" });
      }

      const hasGitHubToken = !!process.env.GITHUB_TOKEN;
      const hasSupabase = !!getSupabaseAdmin();
      if (!hasGitHubToken && !hasSupabase) {
        return res.status(500).json({ error: "Booking update is unavailable: GITHUB_TOKEN not configured and Supabase is unavailable" });
      }

      // Validate booking exists before the retry loop
      const { data: checkData } = await loadBookings();
      // foundInJson is false when the vehicle has no entry in bookings.json
      // (e.g. Ford Fusion bookings that exist only in Supabase).  The Supabase
      // fallback below will locate those bookings without a "Vehicle not found" error.
      const foundInJson = Array.isArray(checkData[vehicleId]) && checkData[vehicleId].some(
        (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
      );

      // If the booking isn't in bookings.json, it may exist only in Supabase
      // (e.g. created via the Stripe webhook before bookings.json was written,
      //  or an extended booking whose Supabase row diverged from the JSON).
      // Try to locate it in Supabase so the status update can still proceed.
      let sbOnlyRow = null;
      if (!foundInJson) {
        const sbVal = getSupabaseAdmin();
        if (sbVal) {
          try {
            // Try by booking_ref first
            let { data: sbCheck } = await sbVal
              .from("bookings")
              .select("id, booking_ref, payment_intent_id, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, payment_status, total_price, deposit_paid, notes, payment_method")
              .eq("vehicle_id", normalizeVehicleId(vehicleId))
              .eq("booking_ref", bookingId)
              .maybeSingle();
            // Fallback: try by numeric Supabase row id
            if (!sbCheck) {
              const numId = parseInt(bookingId, 10);
              if (!isNaN(numId)) {
                const { data: sbCheckById } = await sbVal
                  .from("bookings")
                  .select("id, booking_ref, payment_intent_id, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, payment_status, total_price, deposit_paid, notes, payment_method")
                  .eq("vehicle_id", normalizeVehicleId(vehicleId))
                  .eq("id", numId)
                  .maybeSingle();
                sbCheck = sbCheckById;
              }
            }
            sbOnlyRow = sbCheck || null;
          } catch (_sbValErr) { /* non-fatal */ }
        }
        if (!sbOnlyRow) {
          return res.status(404).json({ error: "Booking not found" });
        }
      }

      // Build safe update set (timestamp is fixed before retry to stay consistent)
      // forceCancel is read separately as a transient request flag and must NOT
      // be stored in the database, so it is excluded from allowedUpdateFields.
      const forceCancel = updates.forceCancel === true;
      const safeUpdates = {};
      const allowedUpdateFields = ["status", "notes", "amountPaid", "totalPrice", "paymentMethod", "cancelReason", "returnDate", "returnTime", "actualReturnTime", "customerName", "customerPhone", "customerEmail", "pickupDate", "pickupTime", "paymentStatus", "vehicleId"];
      for (const f of allowedUpdateFields) {
        if (Object.prototype.hasOwnProperty.call(updates, f)) {
          safeUpdates[f] = updates[f];
        }
      }
      safeUpdates.updatedAt = new Date().toISOString();
      // Auto-stamp activatedAt when an admin marks the vehicle as picked up
      if (safeUpdates.status === "active_rental" && !safeUpdates.activatedAt) {
        safeUpdates.activatedAt = safeUpdates.updatedAt;
      }
      // Auto-stamp completedAt and actualReturnTime when an admin marks the rental as returned.
      // Safety guard: only allow this transition when the booking is currently active or overdue.
      if (safeUpdates.status === "completed_rental") {
        let currentStatus = null;
        if (sbOnlyRow) {
          currentStatus = toAppBookingStatus(sbOnlyRow.status) || null;
        } else {
          const currentBooking = (checkData[vehicleId] || []).find(
            (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
          );
          currentStatus = currentBooking?.status || null;
        }
        if (currentStatus && currentStatus !== "active_rental" && currentStatus !== "overdue") {
          return res.status(409).json({
            error: `Cannot mark as returned: booking must be active or overdue (current status: ${currentStatus})`,
          });
        }
        if (!safeUpdates.completedAt) {
          safeUpdates.completedAt = safeUpdates.updatedAt;
        }
        if (!safeUpdates.actualReturnTime) {
          safeUpdates.actualReturnTime = safeUpdates.updatedAt;
        }
        // Auto-dismiss any pending late fee when completing a rental.
        // If the booking is being closed without charging the fee, clear the
        // pending_approval status so the admin UI no longer shows it as an
        // unresolved action item.
        safeUpdates._autoDismissLateFee = true;
      }

      // Guard: require explicit forceCancel flag when cancelling an active rental.
      // A booking in active_rental, overdue, or extended state means the vehicle
      // has already been picked up by the customer.  Accidental cancellation of a
      // live rental is a common operator error; this forces an explicit acknowledgement.
      if (safeUpdates.status === "cancelled_rental") {
        let currentStatusForCancel = null;
        if (sbOnlyRow) {
          currentStatusForCancel = toAppBookingStatus(sbOnlyRow.status) || null;
        } else {
          const currentBookingForCancel = (checkData[vehicleId] || []).find(
            (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
          );
          currentStatusForCancel = currentBookingForCancel?.status || null;
        }
        const ACTIVE_STATUSES = ACTIVE_RENTAL_STATUSES;
        if (ACTIVE_STATUSES.has(currentStatusForCancel) && !forceCancel) {
          return res.status(409).json({
            error: "Cannot cancel an active rental: the vehicle has already been picked up. Confirm the cancellation explicitly to proceed.",
          });
        }
      }


      // ── Supabase direct update (primary path when configured) ──────────────
      // Update the Supabase bookings table directly so that status transitions
      // ("Mark Active", "Mark Completed", etc.) succeed immediately even if
      // the GitHub bookings.json write is temporarily blocked by a SHA conflict.
      // This is intentionally done BEFORE the bookings.json write so that, if
      // GitHub fails after all retries, we can fall back to the Supabase result.
      // Also fires when returnDate/returnTime are being changed (e.g. admin
      // correcting a return date or processing a manual extension) so Supabase-
      // only bookings stay consistent with the updated dates.
      let sbUpdateSuccess = false;
      let sbOnlyRowUpdateError = null;
      const sbInstance = getSupabaseAdmin();
      const hasReturnUpdate  = safeUpdates.returnDate !== undefined || safeUpdates.returnTime !== undefined;
      const hasContactUpdate = safeUpdates.customerName !== undefined || safeUpdates.customerPhone !== undefined || safeUpdates.customerEmail !== undefined;
      const hasPickupUpdate  = safeUpdates.pickupDate !== undefined || safeUpdates.pickupTime !== undefined;
      const hasPaymentStatusUpdate = safeUpdates.paymentStatus !== undefined;
      const hasPaymentMethodUpdate = safeUpdates.paymentMethod !== undefined;
      const hasNotesUpdate = safeUpdates.notes !== undefined;
      const hasVehicleUpdate = safeUpdates.vehicleId !== undefined;
      if (sbInstance && (safeUpdates.status || hasReturnUpdate || hasContactUpdate || hasPickupUpdate || hasPaymentStatusUpdate || hasPaymentMethodUpdate || hasNotesUpdate || hasVehicleUpdate)) {
        const dbStatus = safeUpdates.status ? APP_TO_DB_STATUS[safeUpdates.status] : null;
        if (dbStatus || hasReturnUpdate || hasContactUpdate || hasPickupUpdate || hasPaymentStatusUpdate || hasPaymentMethodUpdate || hasNotesUpdate || hasVehicleUpdate) {
          try {
            const sbPayload = {
              ...(dbStatus ? { status: dbStatus } : {}),
              updated_at: safeUpdates.updatedAt,
              ...(safeUpdates.activatedAt ? { activated_at: safeUpdates.activatedAt } : {}),
              ...(safeUpdates.completedAt ? { completed_at: safeUpdates.completedAt } : {}),
              ...(safeUpdates.actualReturnTime ? { actual_return_time: safeUpdates.actualReturnTime } : {}),
              ...(safeUpdates.notes !== undefined  ? { notes: safeUpdates.notes } : {}),
              ...(safeUpdates.returnDate !== undefined ? { return_date: safeUpdates.returnDate } : {}),
              ...(safeUpdates.returnTime !== undefined ? { return_time: parseTime12h(safeUpdates.returnTime) } : {}),
              ...(safeUpdates.customerName  !== undefined ? { customer_name:  safeUpdates.customerName  } : {}),
              ...(safeUpdates.customerPhone !== undefined ? { customer_phone: safeUpdates.customerPhone, renter_phone: safeUpdates.customerPhone } : {}),
              ...(safeUpdates.customerEmail !== undefined ? { customer_email: safeUpdates.customerEmail } : {}),
              ...(safeUpdates.pickupDate !== undefined ? { pickup_date: safeUpdates.pickupDate } : {}),
              ...(safeUpdates.pickupTime !== undefined ? { pickup_time: parseTime12h(safeUpdates.pickupTime) } : {}),
              ...(safeUpdates.paymentStatus !== undefined ? { payment_status: safeUpdates.paymentStatus } : {}),
              ...(safeUpdates.paymentMethod !== undefined ? { payment_method: safeUpdates.paymentMethod } : {}),
              ...(safeUpdates.vehicleId !== undefined ? { vehicle_id: safeUpdates.vehicleId } : {}),
            };

            // If we already located the Supabase row during validation (Supabase-only
            // bookings not present in bookings.json), update it directly by id to avoid
            // any booking_ref / payment_intent_id mismatch.
            if (sbOnlyRow) {
              const { error: soErr } = await sbInstance
                .from("bookings")
                .update(sbPayload)
                .eq("id", sbOnlyRow.id);
              if (!soErr) {
                sbUpdateSuccess = true;
              } else {
                sbOnlyRowUpdateError = soErr;
                console.error("RETURN UPDATE ERROR:", soErr);
                console.error("v2-bookings: Supabase-only booking update error:", soErr.message, "| details:", soErr.details, "| code:", soErr.code, "| hint:", soErr.hint);
              }
            } else {
              const { data: sbRow, error: sbErr } = await sbInstance
                .from("bookings")
                .update(sbPayload)
                .eq("booking_ref", bookingId)
                .select("id")
                .maybeSingle();
              if (!sbErr && sbRow) {
                sbUpdateSuccess = true;
              } else if (!sbErr && !sbRow) {
                // The booking_ref lookup matched 0 rows — try payment_intent_id as a
                // fallback.  This handles Supabase rows that have no booking_ref set
                // (e.g. created before the column was populated, or where the initial
                // autoUpsertBooking failed).  Using UPDATE avoids the INSERT conflict-
                // check trigger that fires on date-overlapping bookings.
                const preCheck = (checkData[vehicleId] || []).find(
                  (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
                );
                const piId = preCheck?.paymentIntentId;
                if (piId) {
                  const { data: piRow } = await sbInstance
                    .from("bookings")
                    .select("id")
                    .eq("payment_intent_id", piId)
                    .maybeSingle();
                  if (piRow) {
                    const { error: piErr } = await sbInstance
                      .from("bookings")
                      .update(sbPayload)
                      .eq("id", piRow.id);
                    if (!piErr) {
                      sbUpdateSuccess = true;
                    } else {
                      console.error("v2-bookings: Supabase fallback update error (non-fatal):", piErr.message, "| details:", piErr.details, "| code:", piErr.code, "| hint:", piErr.hint);
                    }
                  }
                }
              } else if (sbErr) {
                console.error("v2-bookings: Supabase direct update error (non-fatal):", sbErr.message, "| details:", sbErr.details, "| code:", sbErr.code, "| hint:", sbErr.hint);
              }
            }
          } catch (sbCatchErr) {
            console.error("v2-bookings: Supabase direct update threw (non-fatal):", sbCatchErr.message);
          }
        }
      }

      // Auto-dismiss pending late fee on rental completion (non-fatal, fire-and-forget).
      // Only overrides late_fee_status if it is currently 'pending_approval' or NULL,
      // so 'paid' / 'failed' / 'approved' fees are preserved.
      if (safeUpdates._autoDismissLateFee && sbInstance) {
        (async () => {
          try {
            await sbInstance
              .from("bookings")
              .update({
                late_fee_status:      "dismissed",
                late_fee_approved_at: new Date().toISOString(),
                late_fee_approved_by: "auto_dismiss",
              })
              .eq("booking_ref", bookingId)
              .or("late_fee_status.eq.pending_approval,late_fee_status.is.null");
          } catch (dismissErr) {
            console.warn("v2-bookings: auto-dismiss late fee failed (non-fatal):", dismissErr.message);
          }
        })();
      }

      let updatedBooking;
      // Only attempt the bookings.json write when the booking exists there.
      // Supabase-only bookings (sbOnlyRow set) skip the GitHub write entirely
      // to avoid writing an unchanged file and creating a spurious commit.
      if (!sbOnlyRow && hasGitHubToken) {
        try {
          await updateJsonFileWithRetry({
            load:    loadBookings,
            apply:   (data) => {
              if (!Array.isArray(data[vehicleId])) return;
              const idx = data[vehicleId].findIndex(
                (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
              );
              if (idx === -1) return;
              data[vehicleId][idx] = { ...data[vehicleId][idx], ...safeUpdates };
              updatedBooking = data[vehicleId][idx];
            },
            save:    saveBookings,
            message: `v2: Update booking ${bookingId} for ${vehicleId}: ${JSON.stringify(Object.keys(safeUpdates))}`,
          });
        } catch (githubErr) {
          if (sbUpdateSuccess) {
            // Supabase already has the updated status — treat the GitHub write
            // failure as non-fatal and reconstruct updatedBooking from local state.
            console.error(
              "v2-bookings: bookings.json write failed after Supabase update succeeded (non-fatal):",
              githubErr.message
            );
            const preCheckBooking = (checkData[vehicleId] || []).find(
              (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
            );
            if (preCheckBooking) {
              updatedBooking = { ...preCheckBooking, ...safeUpdates };
            }
          } else {
            // No Supabase fallback available — propagate the error to the client.
            throw githubErr;
          }
        }
      } else if (!sbOnlyRow && !hasGitHubToken) {
        if (sbUpdateSuccess) {
          console.warn("v2-bookings: skipping bookings.json write because GITHUB_TOKEN is not configured");
          if (sbInstance) {
            try {
              const { data: freshRow } = await sbInstance
                .from("bookings")
                .select("booking_ref, vehicle_id, pickup_date, pickup_time, return_date, return_time, total_price, deposit_paid, remaining_balance, payment_status, payment_method, payment_intent_id, notes, customer_name, customer_phone, customer_email, status")
                .eq("booking_ref", bookingId)
                .maybeSingle();
              if (freshRow) {
                updatedBooking = {
                  bookingId:       freshRow.booking_ref || bookingId,
                  vehicleId:       uiVehicleId(freshRow.vehicle_id || vehicleId),
                  pickupDate:      freshRow.pickup_date || "",
                  pickupTime:      freshRow.pickup_time || "",
                  returnDate:      freshRow.return_date || "",
                  returnTime:      freshRow.return_time || "",
                  totalPrice:      Number(freshRow.total_price || 0),
                  amountPaid:      Number(freshRow.deposit_paid || 0),
                  remaining:       resolveBookingRemainingBalance(freshRow),
                  paymentStatus:   freshRow.payment_status || "",
                  paymentMethod:   freshRow.payment_method || "",
                  paymentIntentId: freshRow.payment_intent_id || "",
                  notes:           freshRow.notes || "",
                  name:            freshRow.customer_name || "",
                  phone:           freshRow.customer_phone || "",
                  email:           freshRow.customer_email || "",
                  ...safeUpdates,
                  status:          toAppBookingStatus(freshRow.status),
                };
              }
            } catch (refreshErr) {
              // Non-fatal: if refresh fails we fall back to the pre-update
              // booking snapshot from checkData (if available) just below.
              void refreshErr;
            }
          }
          if (!updatedBooking) {
            const preCheckBooking = (checkData[vehicleId] || []).find(
              (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
            );
            if (preCheckBooking) {
              updatedBooking = { ...preCheckBooking, ...safeUpdates };
            }
          }
        } else {
          return res.status(500).json({ error: "Failed to update booking: GitHub write unavailable and database update failed" });
        }
      }

      // For Supabase-only bookings (not found in bookings.json), the apply()
      // callback above silently skips the write (idx === -1) so updatedBooking
      // stays undefined.  Reconstruct a minimal booking object from the Supabase
      // row so that downstream automation (unblock dates, customer stats, etc.)
      // can still run correctly.
      if (sbOnlyRow) {
        if (!sbUpdateSuccess) {
          // The Supabase update failed and there is no bookings.json to fall back on.
          const errMsg = sbOnlyRowUpdateError ? sbOnlyRowUpdateError.message : "Failed to update booking in database";
          return res.status(500).json({ error: errMsg, details: sbOnlyRowUpdateError });
        }
        updatedBooking = {
          bookingId,
          vehicleId,
          pickupDate:      sbOnlyRow.pickup_date  || "",
          pickupTime:      sbOnlyRow.pickup_time  || "",
          returnDate:      sbOnlyRow.return_date  || "",
          returnTime:      sbOnlyRow.return_time  || "",
          totalPrice:      Number(sbOnlyRow.total_price  || 0),
          amountPaid:      Number(sbOnlyRow.deposit_paid || 0),
          paymentMethod:   sbOnlyRow.payment_method  || "",
          paymentIntentId: sbOnlyRow.payment_intent_id || "",
          notes:           sbOnlyRow.notes || "",
          ...safeUpdates,
        };
      }

      // ── Booking automation ────────────────────────────────────────────────
      // When a booking becomes paid, automatically create a revenue record,
      // upsert the customer, sync to the Supabase bookings table, and create
      // a blocked_dates entry.  All operations are non-fatal.
      // Stats (total_bookings, total_spent) are only incremented on
      // "completed_rental" to prevent double-counting across status transitions.
      const newStatus = safeUpdates.status;
      if (updatedBooking && (newStatus === "booked_paid" || newStatus === "active_rental")) {
        await autoCreateRevenueRecord(updatedBooking);
        await autoUpsertCustomer(updatedBooking, false); // create record, no stat increment yet
        await autoUpsertBooking(updatedBooking);
        await autoCreateBlockedDate(
          updatedBooking.vehicleId,
          updatedBooking.pickupDate,
          updatedBooking.returnDate,
          "booking",
          updatedBooking.bookingId || null,
          updatedBooking.returnTime || null
        );
        // Send booking confirmation SMS when status transitions to booked_paid
        if (newStatus === "booked_paid" && shouldSendBookingLifecycleSms("v2_bookings") && updatedBooking.phone &&
            process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
          try {
            const bookingConfirmedSent = await sendDedupedSms({
              bookingId: updatedBooking.bookingId || updatedBooking.paymentIntentId,
              templateKey: "booking_confirmed",
              phone: updatedBooking.phone,
              body: render(BOOKING_CONFIRMED, {
                vehicle:       updatedBooking.vehicleName || updatedBooking.vehicleId || "",
                customer_name: (updatedBooking.name || "Customer").split(" ")[0],
                pickup_date:   updatedBooking.pickupDate  || "",
                pickup_time:   updatedBooking.pickupTime  || "",
                return_date:   updatedBooking.returnDate || "",
                return_time_line: updatedBooking.returnTime ? ` at ${updatedBooking.returnTime}\n` : "\n",
                location:      resolvePickupLocation({
                  vehicleId: updatedBooking.vehicleId || "",
                  vehicleName: updatedBooking.vehicleName || "",
                }),
              }),
            });
            if (bookingConfirmedSent && updatedBooking.pickupDate !== updatedBooking.returnDate) {
              await sendDedupedSms({
                bookingId: updatedBooking.bookingId || updatedBooking.paymentIntentId,
                templateKey: "booking_onboarding",
                phone: updatedBooking.phone,
                body: render(BOOKING_ONBOARDING, {
                  customer_name: (updatedBooking.name || "Customer").split(" ")[0],
                  booking_id: updatedBooking.bookingId || updatedBooking.paymentIntentId || "",
                  manage_link: "https://slycarrentals.com/manage-booking.html",
                }),
              });
            }
          } catch (smsErr) {
            console.error("v2-bookings: booking confirmation SMS failed (non-fatal):", smsErr.message);
          }
        }

        // ── Capture start odometer on rental activation (non-fatal) ───────────
        // Reads the current vehicle mileage (synced by the bouncie-sync cron every
        // 5 minutes) and writes a placeholder trips record so the driver's start
        // odometer is preserved even before GPS trip_log data accumulates.
        // Idempotent: skips the insert when a placeholder already exists for this
        // booking_id (e.g. created by migration 0040 for pre-deployment rentals).
        if (newStatus === "active_rental" && updatedBooking.vehicleId) {
          try {
            const sb = getSupabaseAdmin();
            if (sb) {
              // Guard: only insert if no trips row already exists for this booking
              const { data: existingStart } = await sb
                .from("trips")
                .select("id")
                .eq("booking_id", updatedBooking.bookingId)
                .is("end_mileage", null)
                .limit(1)
                .maybeSingle();

              if (!existingStart) {
                const { data: vRow } = await sb
                  .from("vehicles")
                  .select("mileage")
                  .eq("vehicle_id", updatedBooking.vehicleId)
                  .maybeSingle();

                const startOdo = vRow?.mileage != null ? Number(vRow.mileage) : null;

                const { error: startTripErr } = await sb.from("trips").insert({
                  vehicle_id:    updatedBooking.vehicleId,
                  booking_id:    updatedBooking.bookingId,
                  start_mileage: startOdo,
                  end_mileage:   null,
                  distance:      null,
                  driver_name:   updatedBooking.name  || null,
                  driver_phone:  updatedBooking.phone || null,
                });
                if (startTripErr) {
                  console.warn("v2-bookings: start mileage trips insert failed (non-fatal):", startTripErr.message);
                } else {
                  console.log(`v2-bookings: captured start odometer ${startOdo ?? "n/a"} mi for booking ${updatedBooking.bookingId}`);
                }
              } else {
                // Placeholder already exists (from migration 0040) — ensure driver info is populated
                const { error: patchErr } = await sb
                  .from("trips")
                  .update({
                    driver_name:  updatedBooking.name  || null,
                    driver_phone: updatedBooking.phone || null,
                  })
                  .eq("id", existingStart.id)
                  .is("driver_name", null); // only patch if still empty
                if (patchErr) {
                  console.warn("v2-bookings: driver info patch on existing trips row failed (non-fatal):", patchErr.message);
                }
              }
            }
          } catch (startTripCatchErr) {
            console.error("v2-bookings: start mileage capture failed (non-fatal):", startTripCatchErr.message);
          }
        }
      } else if (updatedBooking && newStatus === "completed_rental") {
        await autoUpsertCustomer(updatedBooking, true); // increment stats once on completion
        await autoUpsertBooking(updatedBooking);

        // ── Record trip + update vehicle mileage (non-fatal) ───────────────
        // Sum GPS trip_log distances for this vehicle during the booking window,
        // then insert a booking-linked trip record in the trips table and
        // recompute maintenance status.
        try {
          const sb = getSupabaseAdmin();
          if (sb && updatedBooking.vehicleId && updatedBooking.pickupDate && updatedBooking.returnDate) {
            // Aggregate distance from GPS trip_log entries during the rental window
            const { data: tripLogRows } = await sb
              .from("trip_log")
              .select("trip_distance, end_odometer")
              .eq("vehicle_id", updatedBooking.vehicleId)
              .gte("trip_at", new Date(updatedBooking.pickupDate).toISOString())
              .lte("trip_at", new Date(updatedBooking.returnDate + "T23:59:59Z").toISOString());

            const gpsRows    = tripLogRows || [];
            const distance   = gpsRows.reduce((s, r) => s + (Number(r.trip_distance) || 0), 0);
            const endOdoRows = gpsRows.filter((r) => r.end_odometer != null);
            const endOdo     = endOdoRows.length > 0
              ? Math.max(...endOdoRows.map((r) => Number(r.end_odometer)))
              : null;

            // ── Upsert booking-linked trip record (trips table — migration 0030) ──
            // Check for a placeholder row inserted when the booking was activated.
            // If found, update it with end mileage and driver info.
            // If not found (e.g. booking was activated before this feature), insert fresh.
            const { data: existingTrip } = await sb
              .from("trips")
              .select("id, start_mileage")
              .eq("booking_id", updatedBooking.bookingId)
              .is("end_mileage", null)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            const startOdo = existingTrip?.start_mileage != null ? Number(existingTrip.start_mileage) : null;
            // Prefer GPS-summed distance; fall back to odometer delta when start was captured
            const finalDistance =
              distance > 0
                ? distance
                : (startOdo != null && endOdo != null ? Math.max(0, endOdo - startOdo) : null);

            if (existingTrip) {
              const { error: tripErr } = await sb
                .from("trips")
                .update({
                  end_mileage:  endOdo,
                  distance:     finalDistance,
                  driver_name:  updatedBooking.name  || null,
                  driver_phone: updatedBooking.phone || null,
                })
                .eq("id", existingTrip.id);
              if (tripErr) console.warn("v2-bookings: trips update failed (non-fatal):", tripErr.message);
            } else {
              const { error: tripErr } = await sb.from("trips").insert({
                vehicle_id:    updatedBooking.vehicleId,
                booking_id:    updatedBooking.bookingId,
                start_mileage: null,
                end_mileage:   endOdo,
                distance:      finalDistance,
                driver_name:   updatedBooking.name  || null,
                driver_phone:  updatedBooking.phone || null,
              });
              if (tripErr) console.warn("v2-bookings: trips insert failed (non-fatal):", tripErr.message);
            }

            // Update vehicle current_mileage (mileage column) when GPS data available
            if (endOdo) {
              const { error: mileageErr } = await sb
                .from("vehicles")
                .update({ mileage: endOdo, updated_at: new Date().toISOString() })
                .eq("vehicle_id", updatedBooking.vehicleId)
                .lt("mileage", endOdo); // only update if higher than stored (prevent rollback)
              if (mileageErr) console.warn("v2-bookings: vehicle mileage update failed (non-fatal):", mileageErr.message);
            }

            // Recompute maintenance status for this vehicle
            await triggerMaintenanceUpdate(updatedBooking.vehicleId);
          }
        } catch (tripErr) {
          console.error("v2-bookings: trip recording failed (non-fatal):", tripErr.message);
        }

        // ── Release blocked_dates row + structured return log ─────────────
        // Delete the Supabase blocked_dates row so that fleet-status.js
        // immediately reports the vehicle as available.  fleet-status queries
        // end_date >= today, so merely trimming to today still blocks the car
        // for the rest of the day.  Deletion is safe: the booking record in
        // the bookings table is the authoritative history.
        try {
          await autoReleaseBlockedDateOnReturn(
            updatedBooking.vehicleId,
            updatedBooking.bookingId || null
          );
        } catch (releaseErr) {
          console.error("v2-bookings: autoReleaseBlockedDateOnReturn failed (non-fatal):", releaseErr.message);
        }

        console.log("[BOOKING_RETURNED]", {
          booking_ref:       updatedBooking.bookingId,
          vehicle_id:        updatedBooking.vehicleId,
          actual_return_time: safeUpdates.actualReturnTime,
          original_return:   updatedBooking.returnDate,
        });
      } else if (updatedBooking) {
        // Sync any other status change (cancelled, reserved_unpaid, etc.)
        // Also re-sync when returnDate/returnTime were edited so Supabase and
        // booked-dates.json stay consistent with the updated dates.
        await autoUpsertBooking(updatedBooking);
        if (safeUpdates.returnDate && updatedBooking.pickupDate && updatedBooking.returnDate) {
          // Re-block with the corrected date range so /api/booked-dates returns
          // the updated range and "Next Available" badges show correctly.
          await autoCreateBlockedDate(
            updatedBooking.vehicleId,
            updatedBooking.pickupDate,
            updatedBooking.returnDate,
            "booking",
            updatedBooking.bookingId || null,
            updatedBooking.returnTime || null
          );
          await blockBookedDates(updatedBooking.vehicleId, updatedBooking.pickupDate, updatedBooking.returnDate).catch((err) => {
            console.warn("v2-bookings: blockBookedDates on returnDate update failed (non-fatal):", err.message);
          });
        }
      }
      // "cancelled_rental" intentionally skips revenue creation and stat updates

      // Restore availability in booked-dates.json when a rental ends
      if (updatedBooking && (newStatus === "completed_rental" || newStatus === "cancelled_rental")) {
        try {
          await unblockBookedDates(
            updatedBooking.vehicleId,
            updatedBooking.pickupDate,
            updatedBooking.returnDate
          );
        } catch (err) {
          console.error("v2-bookings: unblockBookedDates failed (non-fatal):", err.message);
        }
      }

      return res.status(200).json({ success: true, booking: updatedBooking });
    }

    // ── DELETE (soft-delete by default; optional hard-delete) ─────────────────
    if (action === "delete") {
      const { bookingId, reason, hardDelete } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });

      let canonicalBookingId = bookingId;
      let deleteVehicleId = null;
      let deletePickupDate = null;
      let deleteReturnDate = null;
      let foundInSupabase = false;
      const doHardDelete = hardDelete === true;

      const sbDelete = getSupabaseAdmin();
      if (sbDelete) {
        let bookingRow = null;

        const { data: byRef, error: byRefErr } = await sbDelete
          .from("bookings")
            .select("booking_ref, payment_intent_id, vehicle_id, pickup_date, return_date, deleted_at")
            .eq("booking_ref", bookingId)
            .maybeSingle();
        if (byRefErr && !isSchemaError(byRefErr)) throw byRefErr;
        bookingRow = byRef || null;

        if (!bookingRow) {
          const { data: byPi, error: byPiErr } = await sbDelete
            .from("bookings")
            .select("booking_ref, payment_intent_id, vehicle_id, pickup_date, return_date, deleted_at")
            .eq("payment_intent_id", bookingId)
            .maybeSingle();
          if (byPiErr && !isSchemaError(byPiErr)) throw byPiErr;
          bookingRow = byPi || null;
        }

        if (bookingRow) {
          foundInSupabase = true;
          canonicalBookingId = bookingRow.booking_ref || bookingId;
          deleteVehicleId = uiVehicleId(bookingRow.vehicle_id) || null;
          deletePickupDate = bookingRow.pickup_date || null;
          deleteReturnDate = bookingRow.return_date || null;

          if (doHardDelete) {
            const { error: rrErr } = await sbDelete
              .from("revenue_records")
              .delete()
              .eq("booking_id", canonicalBookingId);
            if (rrErr && !isSchemaError(rrErr)) throw rrErr;

            const { error: bdErr } = await sbDelete
              .from("blocked_dates")
              .delete()
              .eq("booking_ref", canonicalBookingId);
            if (bdErr && !isSchemaError(bdErr)) throw bdErr;

            const { error: bookingDelErr } = await sbDelete
              .from("bookings")
              .delete()
              .eq("booking_ref", canonicalBookingId);
            if (bookingDelErr && !isSchemaError(bookingDelErr)) throw bookingDelErr;
          } else {
            const archivedAt = new Date().toISOString();
            const archivePayload = {
              deleted_at: archivedAt,
              deleted_by: "admin_panel",
              deleted_reason: String(reason || "").trim() || "Deleted from admin panel",
              updated_at: archivedAt,
            };
            const { error: archiveErr } = await sbDelete
              .from("bookings")
              .update(archivePayload)
              .eq("booking_ref", canonicalBookingId);
            if (archiveErr) {
              if (isSchemaError(archiveErr)) {
                return res.status(409).json({
                  error: "Soft delete is unavailable until migration 0162 is applied (missing deleted_at/deleted_by/deleted_reason columns).",
                });
              }
              throw archiveErr;
            }
          }
        }
      }

      let foundInJson = false;
      const shouldDeleteJson = !foundInSupabase || doHardDelete;
      if (shouldDeleteJson && process.env.GITHUB_TOKEN) {
        await updateJsonFileWithRetry({
          load: loadBookings,
          apply: (data) => {
            for (const vid of ALLOWED_VEHICLES) {
              if (!Array.isArray(data[vid])) continue;
              const originalLen = data[vid].length;
              data[vid] = data[vid].filter((b) => {
                const id = b?.bookingId || "";
                const pi = b?.paymentIntentId || "";
                const matches = (
                  id === bookingId ||
                  id === canonicalBookingId ||
                  pi === bookingId ||
                  pi === canonicalBookingId
                );
                if (matches && !deleteVehicleId) {
                  deleteVehicleId = b?.vehicleId || vid;
                  deletePickupDate = b?.pickupDate || null;
                  deleteReturnDate = b?.returnDate || null;
                }
                return !matches;
              });
              if (data[vid].length !== originalLen) foundInJson = true;
            }
          },
          save: saveBookings,
          message: `v2: Delete booking ${canonicalBookingId}`,
        });
      }

      if (!foundInSupabase && !foundInJson) {
        return res.status(404).json({ error: `Booking "${bookingId}" not found` });
      }

      if (doHardDelete && deleteVehicleId && deletePickupDate && deleteReturnDate) {
        await unblockBookedDates(deleteVehicleId, deletePickupDate, deleteReturnDate).catch((err) => {
          console.warn("v2-bookings delete: unblockBookedDates failed (non-fatal):", err.message);
        });
      }

      return res.status(200).json({
        success: true,
        bookingId: canonicalBookingId,
        mode: doHardDelete ? "hard_delete" : "soft_delete",
      });
    }

    // ── RESTORE (reverse soft-delete) ─────────────────────────────────────────
    if (action === "restore") {
      const { bookingId } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });

      const sbRestore = getSupabaseAdmin();
      if (!sbRestore) return res.status(500).json({ error: "Database not configured" });

      let bookingRow = null;
      const { data: byRef, error: byRefErr } = await sbRestore
        .from("bookings")
        .select("booking_ref, payment_intent_id")
        .eq("booking_ref", bookingId)
        .maybeSingle();
      if (byRefErr && !isSchemaError(byRefErr)) throw byRefErr;
      bookingRow = byRef || null;

      if (!bookingRow) {
        const { data: byPi, error: byPiErr } = await sbRestore
          .from("bookings")
          .select("booking_ref, payment_intent_id")
          .eq("payment_intent_id", bookingId)
          .maybeSingle();
        if (byPiErr && !isSchemaError(byPiErr)) throw byPiErr;
        bookingRow = byPi || null;
      }

      if (!bookingRow) {
        return res.status(404).json({ error: `Booking "${bookingId}" not found` });
      }

      const canonicalBookingId = bookingRow.booking_ref || bookingId;
      const restoreAt = new Date().toISOString();
      const restorePayload = {
        deleted_at: null,
        deleted_by: null,
        deleted_reason: null,
        updated_at: restoreAt,
      };
      const { error: restoreErr } = await sbRestore
        .from("bookings")
        .update(restorePayload)
        .eq("booking_ref", canonicalBookingId);
      if (restoreErr) {
        if (isSchemaError(restoreErr)) {
          return res.status(409).json({
            error: "Restore is unavailable until migration 0162 is applied (missing deleted_at/deleted_by/deleted_reason columns).",
          });
        }
        throw restoreErr;
      }

      return res.status(200).json({ success: true, bookingId: canonicalBookingId });
    }

    // ── FLAG (toggle flagged state on a booking) ────────────────────────────
    if (action === "flag") {
      const { bookingId, flagged: flagValue, notes: flagNotes } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });
      const sbFlag = getSupabaseAdmin();
      if (!sbFlag) return res.status(500).json({ error: "Database not configured" });

      const flagPayload = {
        flagged:    typeof flagValue === "boolean" ? flagValue : true,
        updated_at: new Date().toISOString(),
        ...(flagNotes !== undefined ? { notes: flagNotes } : {}),
      };
      const { error: flagErr } = await sbFlag
        .from("bookings")
        .update(flagPayload)
        .eq("booking_ref", bookingId);
      if (flagErr) return res.status(500).json({ error: flagErr.message });
      return res.status(200).json({ success: true });
    }

    // ── DISMISS_LATE_FEE ────────────────────────────────────────────────────
    // Sets late_fee_status = 'dismissed' on a booking so the pending badge
    // is cleared without charging the customer.  Used by the admin Late Fees
    // page when the owner decides not to collect the fee.
    if (action === "dismiss_late_fee") {
      const { bookingId } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });
      const sbDismiss = getSupabaseAdmin();
      if (!sbDismiss) return res.status(500).json({ error: "Database not configured" });

      const dismissPatch = {
        late_fee_status:      "dismissed",
        late_fee_amount:      null,
        late_fee_approved_at: new Date().toISOString(),
        late_fee_approved_by: "admin_panel",
        updated_at:           new Date().toISOString(),
      };
      const { data: dismissedByRef, error: dismissErr } = await sbDismiss
        .from("bookings")
        .update(dismissPatch)
        .eq("booking_ref", bookingId)
        .select("id");
      if (dismissErr) return res.status(500).json({ error: dismissErr.message });

      if (!dismissedByRef || dismissedByRef.length === 0) {
        const numericId = parseInt(bookingId, 10);
        if (!isNaN(numericId)) {
          const { data: dismissedById, error: dismissErr2 } = await sbDismiss
            .from("bookings")
            .update(dismissPatch)
            .eq("id", numericId)
            .select("id");
          if (dismissErr2) return res.status(500).json({ error: dismissErr2.message });
          if (!dismissedById || dismissedById.length === 0) {
            return res.status(404).json({ error: "Booking not found" });
          }
        } else {
          return res.status(404).json({ error: "Booking not found" });
        }
      }
      return res.status(200).json({ success: true });
    }

    // ── SET_LATE_FEE ────────────────────────────────────────────────────────
    // Allows the admin to update the late fee amount and/or status directly
    // from the Late Fees page edit modal.
    if (action === "set_late_fee") {
      const { bookingId, lateFeeAmount, lateFeeStatus } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });

      const VALID_STATUSES = ["pending_approval", "approved", "paid", "failed", "dismissed"];
      if (lateFeeStatus && !VALID_STATUSES.includes(lateFeeStatus)) {
        return res.status(400).json({ error: "Invalid lateFeeStatus" });
      }
      const hasAmount = "lateFeeAmount" in body;
      if (hasAmount && lateFeeAmount != null && (typeof lateFeeAmount !== "number" || lateFeeAmount < 0)) {
        return res.status(400).json({ error: "lateFeeAmount must be a non-negative number" });
      }
      if (!hasAmount && !lateFeeStatus) {
        return res.status(400).json({ error: "At least one of lateFeeAmount or lateFeeStatus is required" });
      }

      const sbEdit = getSupabaseAdmin();
      if (!sbEdit) return res.status(500).json({ error: "Database not configured" });

      const patch = { updated_at: new Date().toISOString() };
      if (hasAmount)   patch.late_fee_amount = lateFeeAmount ?? null;
      if (lateFeeStatus) patch.late_fee_status = lateFeeStatus;

      const { data: updatedByRef, error: editErr } = await sbEdit
        .from("bookings")
        .update(patch)
        .eq("booking_ref", bookingId)
        .select("id");
      if (editErr) return res.status(500).json({ error: editErr.message });

      if (!updatedByRef || updatedByRef.length === 0) {
        // Fallback: bookingId may be a numeric row id when booking_ref is null
        const numericId = parseInt(bookingId, 10);
        if (!isNaN(numericId)) {
          const { data: updatedById, error: editErr2 } = await sbEdit
            .from("bookings")
            .update(patch)
            .eq("id", numericId)
            .select("id");
          if (editErr2) return res.status(500).json({ error: editErr2.message });
          if (!updatedById || updatedById.length === 0) {
            return res.status(404).json({ error: "Booking not found" });
          }
        } else {
          return res.status(404).json({ error: "Booking not found" });
        }
      }
      return res.status(200).json({ success: true });
    }

    // ── CREATE (manual booking) ─────────────────────────────────────────────
    if (action === "create") {
      if (!process.env.GITHUB_TOKEN) {
        return res.status(500).json({ error: "GITHUB_TOKEN not configured" });
      }

      const {
        vehicleId, name, phone, email,
        pickupDate, pickupTime, returnDate, returnTime,
        amountPaid, totalPrice, paymentMethod, paymentIntentId, notes,
        paymentStatus,
      } = body;

      if (!vehicleId || !ALLOWED_VEHICLES.includes(vehicleId)) {
        return res.status(400).json({ error: "Invalid or missing vehicleId" });
      }
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name is required" });
      }
      const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
      if (!pickupDate || !ISO_DATE.test(pickupDate)) {
        return res.status(400).json({ error: "pickupDate must be YYYY-MM-DD" });
      }
      if (!returnDate || !ISO_DATE.test(returnDate)) {
        return res.status(400).json({ error: "returnDate must be YYYY-MM-DD" });
      }
      if (returnDate < pickupDate) {
        return res.status(400).json({ error: "returnDate must not be before pickupDate" });
      }
      const trimmedPickupTime = typeof pickupTime === "string" ? pickupTime.trim() : "";
      if (!normalizeClockTime(trimmedPickupTime)) {
        return res.status(400).json({ error: "pickupTime is required and must be a valid time" });
      }
      const trimmedReturnTime = typeof returnTime === "string" ? returnTime.trim() : "";
      if (!normalizeClockTime(trimmedReturnTime)) {
        return res.status(400).json({ error: "returnTime is required and must be a valid time" });
      }

      // Check for overlapping bookings — uses datetime-aware comparison so that
      // back-to-back bookings on the same day (different time slots) are allowed.
      const { data: existingBookings } = await loadBookings();
      const vehicleBookings = existingBookings[vehicleId] || [];
      const activeOverlap = vehicleBookings.filter(
        (b) => b.status === "booked_paid" || b.status === "active_rental"
      );
      for (const existing of activeOverlap) {
        const eFrom = existing.pickupDate;
        const eTo   = existing.returnDate;
        if (eFrom && eTo) {
          const conflictRanges = [{ from: eFrom, to: eTo, fromTime: existing.pickupTime, toTime: existing.returnTime }];
          if (hasDateTimeOverlap(conflictRanges, pickupDate, returnDate, trimmedPickupTime, trimmedReturnTime)) {
            return res.status(409).json({
              error: `Date/time conflict: vehicle already booked from ${eFrom} ${existing.pickupTime || ""} to ${eTo} ${existing.returnTime || ""} for ${existing.name}`.trim(),
            });
          }
        }
      }

      const parsedAmount = (() => {
        // When admin explicitly marks the booking as unpaid, force amountPaid to 0
        // regardless of what was entered in the form.
        if (paymentStatus === "unpaid") return 0;
        return typeof amountPaid === "number" ? amountPaid : parseFloat(amountPaid) || 0;
      })();
      const parsedTotal  = typeof totalPrice === "number" ? totalPrice  : parseFloat(totalPrice)  || 0;
      const bookingId    = crypto.randomBytes(8).toString("hex");

      // Ensure every manual booking has a stable payment_intent_id for revenue
      // deduplication.  When the admin doesn't supply one (cash/offline bookings),
      // generate a "manual_" prefixed ID, matching add-manual-booking.js behaviour.
      const trimmedPI = typeof paymentIntentId === "string" ? paymentIntentId.trim() : "";
      const resolvedPaymentIntentId = trimmedPI || "manual_" + crypto.randomBytes(6).toString("hex");

      // Persist booking through the unified pipeline (Supabase + bookings.json).
      // bookingId is stable across retries for idempotency.
      const result = await persistBooking({
        bookingId,
        vehicleId,
        vehicleName:    VEHICLE_NAMES[vehicleId] || vehicleId,
        name:           name.trim().slice(0, 100),
        phone:          typeof phone === "string" ? phone.trim().slice(0, 20) : "",
        email:          typeof email === "string" ? email.trim().slice(0, 100) : "",
        pickupDate,
        pickupTime:     trimmedPickupTime,
        returnDate,
        returnTime:     trimmedReturnTime,
        amountPaid:     Math.round(parsedAmount * 100) / 100,
        // For unpaid bookings, totalPrice must be set to the full rental amount so
        // the renter can pay the outstanding balance through manage-booking.
        totalPrice:     Math.round((parsedTotal || parsedAmount) * 100) / 100,
        paymentMethod:  typeof paymentMethod    === "string" ? paymentMethod.trim()    : "cash",
        paymentIntentId: resolvedPaymentIntentId,
        status:         parsedAmount > 0 ? "booked_paid" : "reserved_unpaid",
        notes:          typeof notes === "string" ? notes.trim().slice(0, 500) : "",
        source:         "admin_v2",
      });

      await blockBookedDates(vehicleId, pickupDate, returnDate).catch((err) => {
        console.warn("v2-bookings: blockBookedDates failed (non-fatal):", err.message);
      });

      return res.status(200).json({ success: true, booking: result.booking });
    }

    if (action === "resend_confirmation") {
      const { bookingId } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });

      // Find the booking in bookings.json
      const { data: bData } = await loadBookings();
      let booking = null;
      for (const list of Object.values(bData)) {
        if (!Array.isArray(list)) continue;
        const found = list.find((b) => b.bookingId === bookingId);
        if (found) { booking = found; break; }
      }

      // Overlay the latest persisted booking data from Supabase so edits made in
      // admin are reflected immediately even if bookings.json lags behind.
      try {
        const sbLookup = getSupabaseAdmin();
        if (sbLookup) {
          const bookingSelect = `
            booking_ref, vehicle_id, pickup_date, return_date,
            pickup_time, return_time, status, total_price, deposit_paid,
            payment_intent_id, payment_status, payment_method, notes,
            customer_name, customer_phone, customer_email, renter_phone,
            customers ( name, phone, email )
          `;
          let sbRow = null;
          const { data: byRefRow } = await sbLookup
            .from("bookings")
            .select(bookingSelect)
            .eq("booking_ref", bookingId)
            .maybeSingle();
          sbRow = byRefRow || null;
          if (!sbRow) {
            const numericBookingId = parseInt(bookingId, 10);
            if (!Number.isNaN(numericBookingId)) {
              const { data: byIdRow } = await sbLookup
                .from("bookings")
                .select(bookingSelect)
                .eq("id", numericBookingId)
                .maybeSingle();
              sbRow = byIdRow || null;
            }
          }
          if (sbRow) {
            booking = mergeBookingConfirmationSource(booking, sbRow);
            if (booking?.bookingId === bookingId && !Object.values(bData).some((list) => Array.isArray(list) && list.some((b) => b.bookingId === bookingId))) {
              console.log(`v2-bookings resend_confirmation: found booking ${bookingId} in Supabase (not in bookings.json)`);
            }
          }
        }
      } catch (sbLookupErr) {
        console.warn("v2-bookings resend_confirmation: Supabase fallback lookup failed (non-fatal):", sbLookupErr.message);
      }

      if (!booking) return res.status(404).json({ error: `No booking found with ID "${bookingId}"` });

      if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return res.status(500).json({ error: "SMTP not configured — add SMTP_HOST, SMTP_USER, SMTP_PASS in Vercel." });
      }

      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_PORT === "465",
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      const ownerEmail = process.env.OWNER_EMAIL || process.env.SMTP_USER;
      const { name, email, phone, vehicleName, vehicleId: bVid,
              pickupDate, pickupTime, returnDate, returnTime,
              amountPaid, totalPrice, status, paymentIntentId } = booking;
      const firstName = (name || "there").split(" ")[0];

      // Retrieve stored docs for attachments (if available).
      let storedDocs = null;
      try {
        const sb = getSupabaseAdmin();
        if (sb) {
          const documentLookupKeys = [...new Set([bookingId, paymentIntentId].map((v) => String(v || "").trim()).filter(Boolean))];
          for (const documentKey of documentLookupKeys) {
            const { data: docsRow } = await sb
              .from("pending_booking_docs")
              .select("*")
              .eq("booking_id", documentKey)
              .maybeSingle();
            if (docsRow) {
              storedDocs = docsRow;
              if (documentKey !== bookingId) {
                console.log(`v2-bookings resend_confirmation: loaded pending_booking_docs via fallback key ${documentKey}`);
              }
              break;
            }
          }
        }
      } catch (docsErr) {
        console.warn("v2-bookings resend_confirmation: pending_booking_docs read failed (non-fatal):", docsErr.message);
      }

      // Pre-fetch vehicle data from DB so
      // VIN, make, year, etc. are available for both PDF regeneration and email bodies.
      const _vehicleDbData = (bVid && CARS[bVid])
        ? null
        : await getVehicleById(bVid).catch(() => null);

      const attachments = [];

      // Rental agreement PDF: use the pre-stored PDF when available; regenerate
      // (without a signature gate) when it is missing.
      try {
        const sbPdf = getSupabaseAdmin();
        const safeName = (name || "renter").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
        const safeDate = (pickupDate || isoDateInLA()).replace(/[^0-9-]/g, "");
        const pdfFilename = `rental-agreement-${safeName}-${safeDate}.pdf`;

        let pdfBuffer = null;

        if (storedDocs?.agreement_pdf_url && sbPdf) {
          try {
            const { data: blobData, error: dlErr } = await sbPdf.storage
              .from("rental-agreements")
              .download(storedDocs.agreement_pdf_url);
            if (!dlErr && blobData) {
              pdfBuffer = Buffer.from(await blobData.arrayBuffer());
            } else if (dlErr) {
              console.warn("v2-bookings resend_confirmation: stored PDF download failed (will regenerate):", dlErr.message);
            }
          } catch (dlErr) {
            console.warn("v2-bookings resend_confirmation: stored PDF download error (will regenerate):", dlErr.message);
          }
        }

        if (!pdfBuffer) {
          const vehicleInfo = (bVid && CARS[bVid]) ? CARS[bVid] : (_vehicleDbData || {});
          const hasProtectionPlan = !!(storedDocs?.protection_plan_tier || booking.protectionPlanTier || booking.protectionPlan);
          const protectionPlanTier = storedDocs?.protection_plan_tier || booking.protectionPlanTier || null;
          const pdfBody = {
            vehicleId:   bVid || "",
            car:         vehicleName || vehicleInfo.name || bVid || "",
            vehicleMake: vehicleInfo.make || null,
            vehicleModel: vehicleInfo.model || null,
            vehicleYear: vehicleInfo.year || null,
            vehicleVin:  vehicleInfo.vin || null,
            vehicleColor: vehicleInfo.color || null,
            name:        name || "",
            email:       email || "",
            phone:       phone || "",
            pickup:      pickupDate || "",
            pickupTime:  pickupTime || "",
            returnDate:  returnDate || "",
            returnTime:  returnTime || "",
            total:       amountPaid != null ? String(amountPaid) : (totalPrice != null ? String(totalPrice) : ""),
            deposit:     vehicleInfo.deposit || 0,
            days:        (pickupDate && returnDate) ? computeRentalDays(pickupDate, returnDate) : 0,
            protectionPlan:          hasProtectionPlan,
            protectionPlanTier:      protectionPlanTier,
            signature:               storedDocs?.signature || null,
            fullRentalCost:          booking.fullRentalCost || null,
            balanceAtPickup:         booking.balanceAtPickup || null,
            insuranceCoverageChoice: storedDocs?.insurance_coverage_choice || (hasProtectionPlan ? "no" : null),
          };
          pdfBuffer = await generateRentalAgreementPdf(pdfBody);

          // Persist for future recoveries.
          if (sbPdf) {
            try {
              const storagePath = `${bookingId}/${pdfFilename}`;
              const { error: uploadErr } = await sbPdf.storage
                .from("rental-agreements")
                .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });
              if (!uploadErr) {
                await sbPdf.from("pending_booking_docs").upsert(
                  { booking_id: bookingId, agreement_pdf_url: storagePath, email_sent: storedDocs?.email_sent ?? false },
                  { onConflict: "booking_id" }
                );
              } else {
                console.warn("v2-bookings resend_confirmation: PDF storage upload failed (non-fatal):", uploadErr.message);
              }
            } catch (storageErr) {
              console.warn("v2-bookings resend_confirmation: PDF storage persist failed (non-fatal):", storageErr.message);
            }
          }
        }

        attachments.push({
          filename: pdfFilename,
          content: pdfBuffer,
          contentType: "application/pdf",
        });
      } catch (pdfErr) {
        console.warn("v2-bookings resend_confirmation: PDF generation failed (non-fatal):", pdfErr.message);
      }
      const idFrontBase64 = normalizeStoredDocBase64(storedDocs?.id_base64);
      const idBackBase64 = normalizeStoredDocBase64(storedDocs?.id_back_base64);
      const insuranceDocBase64 = normalizeStoredDocBase64(storedDocs?.insurance_base64);

      if (idFrontBase64 && storedDocs?.id_filename) {
        try {
          attachments.push({
            filename: storedDocs.id_filename,
            content: Buffer.from(idFrontBase64, "base64"),
            contentType: storedDocs.id_mimetype || "application/octet-stream",
          });
        } catch (idErr) {
          console.warn("v2-bookings resend_confirmation: ID attachment failed (non-fatal):", idErr.message);
        }
      }
      if (idBackBase64 && storedDocs?.id_back_filename) {
        try {
          attachments.push({
            filename: storedDocs.id_back_filename,
            content: Buffer.from(idBackBase64, "base64"),
            contentType: storedDocs.id_back_mimetype || "application/octet-stream",
          });
        } catch (idBackErr) {
          console.warn("v2-bookings resend_confirmation: ID back attachment failed (non-fatal):", idBackErr.message);
        }
      }
      if (insuranceDocBase64 && storedDocs?.insurance_filename) {
        try {
          attachments.push({
            filename: storedDocs.insurance_filename,
            content: Buffer.from(insuranceDocBase64, "base64"),
            contentType: storedDocs.insurance_mimetype || "application/octet-stream",
          });
        } catch (insErr) {
          console.warn("v2-bookings resend_confirmation: insurance attachment failed (non-fatal):", insErr.message);
        }
      }

      const hasProtectionPlan = !!(storedDocs?.protection_plan_tier || booking.protectionPlanTier || booking.protectionPlan);
      const protectionPlanTier = storedDocs?.protection_plan_tier || booking.protectionPlanTier || null;
      let breakdownLines = null;
      try {
        const isHourly = !!(bVid && CARS[bVid] && CARS[bVid].hourlyTiers);
        if (!isHourly && bVid && pickupDate && returnDate) {
          const pricingSettings = await loadPricingSettings();
          const isKnownEconomy = (bVid === "camry" || bVid === "camry2013");
          const vehicleDataForBreakdown = !isKnownEconomy
            ? (_vehicleDbData ?? await getVehicleById(bVid).catch(() => null))
            : null;
          breakdownLines = computeBreakdownLinesFromSettings(
            bVid,
            pickupDate,
            returnDate,
            pricingSettings,
            hasProtectionPlan,
            protectionPlanTier,
            vehicleDataForBreakdown
          );
        }
      } catch (err) {
        console.warn("v2-bookings resend_confirmation: pricing breakdown generation failed (non-fatal):", err.message);
      }

      const insuranceStatus = storedDocs?.insurance_coverage_choice === "no"
        ? "No personal insurance provided (Damage Protection Plan or renter liability applies)"
        : (storedDocs?.insurance_coverage_choice === "yes"
            ? (storedDocs?.insurance_filename ? "Own insurance provided (document attached)" : "Own insurance selected (proof not uploaded)")
            : (hasProtectionPlan
                ? `Protection plan selected (${protectionPlanTier || "tier not specified"})`
                : "Not selected / No protection plan"));

      const missingItemNotes = buildDocumentNotes({
        idUploaded:        !!(idFrontBase64 && idBackBase64),
        signatureUploaded: !!storedDocs?.signature,
        insuranceUploaded: !!insuranceDocBase64,
        insuranceExpected: storedDocs?.insurance_coverage_choice === "yes",
      });
      const additionalNotes = [
        ...(booking.notes ? [`Booking notes: ${booking.notes}`] : []),
        ...(attachments.length ? [`Attachments: ${attachments.map(a => a.filename).join(", ")}`] : []),
      ];

      const isWebsitePayment = isWebsitePaymentMethod(paymentIntentId);
      const paymentMethodLabel = isWebsitePayment ? "Website (Stripe)" : "Cash / Manual";
      const ownerTemplate = buildUnifiedConfirmationEmail({
        audience:           "owner",
        bookingId,
        vehicleName,
        vehicleId:          bVid,
        vehicleMake:        CARS[bVid]?.make || _vehicleDbData?.make || null,
        vehicleModel:       CARS[bVid]?.model || _vehicleDbData?.model || null,
        vehicleYear:        CARS[bVid]?.year || _vehicleDbData?.year || null,
        vehicleVin:         CARS[bVid]?.vin || _vehicleDbData?.vin || null,
        vehicleColor:       CARS[bVid]?.color || _vehicleDbData?.color || null,
        renterName:         name,
        renterEmail:        email,
        renterPhone:        phone,
        pickupDate,
        pickupTime,
        returnDate,
        returnTime,
        amountPaid,
        totalPrice,
        fullRentalCost:     booking.fullRentalCost || null,
        balanceAtPickup:    booking.balanceAtPickup || null,
        status:             status || "booked_paid",
        paymentMethodLabel: `${paymentMethodLabel}${isWebsitePayment ? ` (${paymentIntentId})` : ""}`,
        insuranceStatus,
        pricingBreakdownLines: breakdownLines || [],
        missingItemNotes: [...missingItemNotes, ...additionalNotes],
      });

      // Owner email
      await transporter.sendMail({
        from:    `"Sly Car Rentals Bookings" <${process.env.SMTP_USER}>`,
        to:      ownerEmail,
        ...(email ? { replyTo: email } : {}),
        subject: ownerTemplate.subject,
        attachments,
        html: ownerTemplate.html,
        text: ownerTemplate.text,
      });

      // Mark email_sent in pending_booking_docs now that the owner email succeeded
      try {
        const sbMark = getSupabaseAdmin();
        if (sbMark) {
          await sbMark
            .from("pending_booking_docs")
            .upsert(
              { booking_id: bookingId, email_sent: true },
              { onConflict: "booking_id" }
            );
        }
      } catch (markErr) {
        console.warn("v2-bookings resend_confirmation: could not mark email_sent (non-fatal):", markErr.message);
      }

      // Customer email
      let customerSent = false;
      if (email) {
        const customerTemplate = buildUnifiedConfirmationEmail({
          audience:           "customer",
          bookingId,
          vehicleName,
          vehicleId:          bVid,
          vehicleMake:        CARS[bVid]?.make || _vehicleDbData?.make || null,
          vehicleModel:       CARS[bVid]?.model || _vehicleDbData?.model || null,
          vehicleYear:        CARS[bVid]?.year || _vehicleDbData?.year || null,
          vehicleVin:         CARS[bVid]?.vin || _vehicleDbData?.vin || null,
          vehicleColor:       CARS[bVid]?.color || _vehicleDbData?.color || null,
          renterName:         name,
          renterEmail:        email,
          renterPhone:        phone,
          pickupDate,
          pickupTime,
          returnDate,
          returnTime,
          amountPaid,
          totalPrice,
          fullRentalCost:     booking.fullRentalCost || null,
          balanceAtPickup:    booking.balanceAtPickup || null,
          status:             status || "booked_paid",
          paymentMethodLabel: `${paymentMethodLabel}${isWebsitePayment ? ` (${paymentIntentId})` : ""}`,
          insuranceStatus,
          pricingBreakdownLines: breakdownLines || [],
          missingItemNotes: [...missingItemNotes, ...additionalNotes],
          firstName,
        });
        try {
          await transporter.sendMail({
            from:    `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
            to:      email,
            subject: customerTemplate.subject,
            html: customerTemplate.html,
            text: customerTemplate.text,
          });
          customerSent = true;
        } catch (custErr) {
          console.error("v2-bookings resend_confirmation: customer email failed:", custErr.message);
        }
      }

      return res.status(200).json({
        success: true, bookingId,
        ownerNotified: true,
        customerEmail: email || null,
        customerSent,
        note: customerSent
          ? "Confirmation sent to owner and customer with standardized template."
          : "Confirmation sent to owner with standardized template. No customer email on file — customer not notified.",
      });
    }

    // ── RESEND_MANAGE_LINK — regenerate manage token + resend email to customer ─
    if (action === "resend_manage_link") {
      const { bookingId } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });

      const sbManage = getSupabaseAdmin();
      if (!sbManage) return res.status(503).json({ error: "Database not configured" });

      // Load the booking row
      const { data: bkRow, error: bkErr } = await sbManage
        .from("bookings")
        .select("id, booking_ref, customer_email, vehicle_id, pickup_date, return_date, remaining_balance, balance_payment_link")
        .eq("booking_ref", bookingId)
        .maybeSingle();

      if (bkErr || !bkRow) {
        return res.status(404).json({ error: `Booking "${bookingId}" not found` });
      }

      // Generate a new 72-hour manage token
      const newToken = createManageToken(bookingId);
      const manageLink = `https://slycarrentals.com/manage-booking.html?t=${encodeURIComponent(newToken)}`;

      const { error: updErr } = await sbManage
        .from("bookings")
        .update({ manage_token: newToken, updated_at: new Date().toISOString() })
        .eq("booking_ref", bookingId);

      if (updErr) return res.status(500).json({ error: `Failed to update manage token: ${updErr.message}` });

      // Optionally send email
      if (bkRow.customer_email && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        try {
          const transporter = nodemailer.createTransport({
            host:   process.env.SMTP_HOST,
            port:   parseInt(process.env.SMTP_PORT || "587"),
            secure: process.env.SMTP_PORT === "465",
            auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          });
          const balanceLink = bkRow.balance_payment_link || "";
          await transporter.sendMail({
            from:    `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
            to:      bkRow.customer_email,
            subject: "Your Booking Management Link",
            html: `
              <h2>Manage Your Booking</h2>
              <p>Here is your link to manage your reservation. It expires in 72 hours.</p>
              <p><a href="${manageLink}" style="background:#1a73e8;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px">Manage Your Booking</a></p>
              ${balanceLink ? `<p>Or <a href="${balanceLink}">pay your remaining balance here</a>.</p>` : ""}
              <p>Questions? Call us at (844) 511-4059.</p>
            `,
          });
        } catch (emailErr) {
          console.error("v2-bookings resend_manage_link: email failed (non-fatal):", emailErr.message);
        }
      }

      return res.status(200).json({ success: true, manageLink });
    }

    // ── SET_EXTENSION_OVERRIDE — admin sets per-booking risk gate override ────
    // Allows the admin to force-allow or force-block partial extensions for a
    // specific booking, bypassing the system-wide Phase 2 risk limits.
    if (action === "set_extension_override") {
      const { bookingId, override } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });

      const VALID_OVERRIDES = ["allow", "block", null];
      if (!VALID_OVERRIDES.includes(override === undefined ? null : override)) {
        return res.status(400).json({ error: "override must be 'allow', 'block', or null" });
      }

      const sbOvr = getSupabaseAdmin();
      if (!sbOvr) return res.status(500).json({ error: "Database not configured" });

      const overrideValue = override ?? null;
      const patch = { extension_risk_override: overrideValue, updated_at: new Date().toISOString() };

      const { data: updatedOvr, error: ovrErr } = await sbOvr
        .from("bookings")
        .update(patch)
        .eq("booking_ref", bookingId)
        .select("id");
      if (ovrErr) return res.status(500).json({ error: ovrErr.message });

      if (!updatedOvr || updatedOvr.length === 0) {
        const numericId = parseInt(bookingId, 10);
        if (!isNaN(numericId)) {
          const { data: updatedOvrById, error: ovrErr2 } = await sbOvr
            .from("bookings")
            .update(patch)
            .eq("id", numericId)
            .select("id");
          if (ovrErr2) return res.status(500).json({ error: ovrErr2.message });
          if (!updatedOvrById || updatedOvrById.length === 0) {
            return res.status(404).json({ error: "Booking not found" });
          }
        } else {
          return res.status(404).json({ error: "Booking not found" });
        }
      }

      return res.status(200).json({ success: true, override: overrideValue });
    }

    // ── SEND_PAYMENT_LINK — admin-driven renter payment collection workflow ───
    if (action === "send_payment_link") {
      const { bookingId, customerId } = body;
      const sendSmsChannel = body.send_sms !== false;
      const sendEmailChannel = !!body.send_email;
      const forceSms = body.force_sms === true;
      const customMessage = typeof body.message === "string" ? body.message.trim() : "";

      const sbLinks = getSupabaseAdmin();
      if (!sbLinks) return res.status(503).json({ error: "Database not configured" });

      let bkRow = null;
      if (bookingId) {
        const { data, error } = await sbLinks
          .from("bookings")
            .select("booking_ref, customer_id, customer_name, customer_phone, renter_phone, customer_email, vehicle_id, pickup_date, return_date, total_price, deposit_paid, remaining_balance, payment_intent_id, balance_payment_link, category")
          .eq("booking_ref", String(bookingId).trim())
          .maybeSingle();
        if (error) return res.status(500).json({ error: `Booking lookup failed: ${error.message}` });
        bkRow = data || null;
      } else if (customerId) {
        const { data, error } = await sbLinks
          .from("bookings")
            .select("booking_ref, customer_id, customer_name, customer_phone, renter_phone, customer_email, vehicle_id, pickup_date, return_date, total_price, deposit_paid, remaining_balance, payment_intent_id, balance_payment_link, created_at, category")
          .eq("customer_id", String(customerId).trim())
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) return res.status(500).json({ error: `Customer booking lookup failed: ${error.message}` });
        bkRow = data || null;
      } else {
        return res.status(400).json({ error: "bookingId or customerId is required" });
      }

      if (!bkRow?.booking_ref) return res.status(404).json({ error: "No eligible booking found." });

      // Generate a fresh manage token so the renter can pay inside the dashboard
      const newManageToken = createManageToken(bkRow.booking_ref);
      const manageLink = `https://slycarrentals.com/manage-booking.html?t=${encodeURIComponent(newManageToken)}`;

      // Best-effort persist the token so the dashboard's existing token stays fresh
      try {
        await sbLinks
          .from("bookings")
          .update({ manage_token: newManageToken, updated_at: new Date().toISOString() })
          .eq("booking_ref", bkRow.booking_ref);
      } catch (tokenErr) {
        console.warn("send_payment_link: manage token persist failed (non-fatal):", tokenErr.message);
      }

      // Keep balance.html link as fallback (for SMS-only receivers who cannot open the dashboard)
      const balanceLink = buildBalanceLinkForBooking(bkRow);

      const planProgress = await computePaymentPlanProgress(sbLinks, { bookingId: bkRow.booking_ref });
      const remainingBalance = resolveBookingRemainingBalance(bkRow, planProgress.remaining_balance || 0);
      const overdueAmount = roundMoney(planProgress.overdue_amount || 0);
      const nextDueDate = planProgress.next_due_date ? String(planProgress.next_due_date).slice(0, 10) : "";
      const paymentPlanRemaining = roundMoney(planProgress.remaining_balance || 0);

      const renterName = String(bkRow.customer_name || "").trim();
      const phone = normalizePhone(bkRow.customer_phone || bkRow.renter_phone || "");
      const email = String(bkRow.customer_email || "").trim().toLowerCase();
      const vehicleLabel = bkRow.vehicle_id || "your rental";

      const planLine = planProgress.has_active_plan
        ? `Installment plan remaining: $${paymentPlanRemaining.toFixed(2)}${nextDueDate ? ` (next due ${nextDueDate})` : ""}.`
        : "";
      const overdueLine = overdueAmount > 0
        ? `Overdue amount: $${overdueAmount.toFixed(2)}.`
        : "";
      const defaultSms = [
        customMessage || "Your next payment is due.",
        `Booking: ${bkRow.booking_ref}`,
        `Vehicle: ${vehicleLabel}`,
        `Current balance: $${remainingBalance.toFixed(2)}.`,
        overdueLine,
        planLine,
        `Manage & pay here: ${manageLink}`,
      ].filter(Boolean).join(" ");

      let smsSent = false;
      let smsDedupSkipped = false;
      if (sendSmsChannel && phone) {
        const smsResult = await sendDedupedSms({
          bookingId: bkRow.booking_ref,
          templateKey: "admin_payment_link",
          phone,
          body: defaultSms,
          forceSend: forceSms,
          returnDateAtSend: bkRow.return_date || "9999-12-31",
          metadata: {
            source: "admin_send_payment_link",
            booking_id: bkRow.booking_ref,
            customer_id: bkRow.customer_id || null,
            manage_link: manageLink,
            balance_link: balanceLink,
            remaining_balance: remainingBalance,
            overdue_amount: overdueAmount,
            payment_plan_remaining: paymentPlanRemaining,
            next_due_date: nextDueDate || null,
          },
        });
        smsSent = !!smsResult;
        smsDedupSkipped = !smsResult;
      }

      let emailSent = false;
      if (sendEmailChannel && email && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        try {
          const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || "587"),
            secure: process.env.SMTP_PORT === "465",
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          });
          await transporter.sendMail({
            from: `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
            to: email,
            subject: "Manage & Pay Your Booking",
            html: `
              <h2>Your Booking Payment Link</h2>
              <p>Hi ${escHtml(renterName || "there")},</p>
              <p>${escHtml(customMessage || "Your next payment is due.")}</p>
              <p><strong>Booking:</strong> ${escHtml(bkRow.booking_ref)}</p>
              <p><strong>Current balance:</strong> $${remainingBalance.toFixed(2)}</p>
              ${overdueAmount > 0 ? `<p><strong>Overdue amount:</strong> $${overdueAmount.toFixed(2)}</p>` : ""}
              ${planProgress.has_active_plan ? `<p><strong>Payment plan remaining:</strong> $${paymentPlanRemaining.toFixed(2)}${nextDueDate ? ` (next due ${escHtml(nextDueDate)})` : ""}</p>` : ""}
              <p><a href="${escHtml(manageLink)}" style="background:#1a73e8;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px">Manage &amp; Pay Now</a></p>
              <p>If you need help, call us at (844) 511-4059.</p>
            `,
          });
          emailSent = true;
        } catch (emailErr) {
          console.error("v2-bookings send_payment_link: email failed (non-fatal):", emailErr.message);
        }
      }

      return res.status(200).json({
        success: true,
        bookingId: bkRow.booking_ref,
        manageLink,
        balanceLink,
        smsSent,
        smsDedupSkipped,
        emailSent,
        paymentPlan: {
          hasActivePlan: !!planProgress.has_active_plan,
          remainingBalance: paymentPlanRemaining,
          overdueAmount,
          nextDueDate: nextDueDate || null,
          remainingInstallments: Number(planProgress.remaining_installments || 0),
        },
      });
    }


    // ── OVERRIDE_BALANCE — admin manually sets a new balance payment link ─────
    if (action === "override_balance") {
      const { bookingId, balancePaymentLink, changeCount } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });
      if (!balancePaymentLink || typeof balancePaymentLink !== "string") {
        return res.status(400).json({ error: "balancePaymentLink is required and must be a string" });
      }

      const sbOvr = getSupabaseAdmin();
      if (!sbOvr) return res.status(503).json({ error: "Database not configured" });

      const ovrPayload = {
        balance_payment_link: balancePaymentLink.trim(),
        updated_at: new Date().toISOString(),
      };
      if (typeof changeCount === "number" && changeCount >= 0) {
        ovrPayload.change_count = changeCount;
      }

      const { error: ovrErr } = await sbOvr
        .from("bookings")
        .update(ovrPayload)
        .eq("booking_ref", bookingId);

      if (ovrErr) return res.status(500).json({ error: `Failed to override balance link: ${ovrErr.message}` });

      return res.status(200).json({ success: true });
    }

    // ── GET_AGREEMENT_URL — return a short-lived signed URL for the rental ─────
    // agreement PDF stored in Supabase Storage (rental-agreements bucket).
    // Used by the admin dashboard "Download Agreement" button.
    if (action === "get_agreement_url") {
      const { bookingId } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });

      const sbAg = getSupabaseAdmin();
      if (!sbAg) return res.status(503).json({ error: "Database not configured" });
      const agreementDetails = await loadAgreementPathForDownload(sbAg, bookingId);
      if (!agreementDetails?.path) {
        return res.status(404).json({ error: "No agreement PDF found for this booking." });
      }
      let bookingType = null;
      try {
        const { data: legacyDoc } = await sbAg
          .from("pending_booking_docs")
          .select("booking_type")
          .eq("booking_id", bookingId)
          .maybeSingle();
        bookingType = legacyDoc?.booking_type || null;
      } catch {
        bookingType = null;
      }

      // Generate a signed URL valid for 60 minutes.
      const { data: signedData, error: signedErr } = await sbAg.storage
        .from("rental-agreements")
        .createSignedUrl(agreementDetails.path, 3600);

      if (signedErr) {
        return res.status(500).json({ error: `Failed to generate signed URL: ${signedErr.message}` });
      }

      return res.status(200).json({
        url:         signedData.signedUrl,
        bookingType,
        path:        agreementDetails.path,
        currentAgreement: agreementDetails.currentAgreement || null,
        agreements: agreementDetails.agreements || [],
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-bookings error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
});
