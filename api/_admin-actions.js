// api/_admin-actions.js
// Safe tool executor for the AI admin assistant.
// All tool calls from admin-chat.js are routed through here.
// This module owns validation, audit logging, and all business-logic calls.
// admin-chat.js has ZERO direct Supabase or data-layer access.
//
// Data-layer strategy:
//   Supabase (service role) is the PRIMARY source for analytics reads and
//   ALL writes (ai_logs, fraud flags, vehicle mutations).
//   loadBookings() / loadVehicles() helpers provide fallback when Supabase
//   is not configured or a table does not yet exist.

import { loadBookings, saveBookings, updateBooking, isNetworkError } from "./_bookings.js";
import { loadVehicles, saveVehicles, getVehicleById } from "./_vehicles.js";
import { loadExpenses, saveExpenses } from "./_expenses.js";
import { loadCategories, enrichExpenseCategory, LEGACY_CATEGORY_MAP } from "./_expense-categories.js";
import { computeAmount, computeRentalDays, CARS, PROTECTION_PLAN_BASIC, PROTECTION_PLAN_STANDARD, PROTECTION_PLAN_PREMIUM } from "./_pricing.js";
import { generateRentalAgreementPdf } from "./_rental-agreement-pdf.js";
import {
  loadPricingSettings,
  computeBreakdownLinesFromSettings,
  applyTax,
} from "./_settings.js";
import { dispatchSms } from "./_sms-dispatcher.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { computeInsights } from "../lib/ai/insights.js";
import { detectProblems } from "../lib/ai/monitor.js";
import { scoreAllBookings } from "../lib/ai/fraud.js";
import { analyzeMileage } from "../lib/ai/mileage.js";
import { computeFleetAlerts } from "../lib/ai/maintenance.js";
import { computeVehiclePriority, sortByPriority, hasNoOverdueMaintenance, ACTION_STATUS_ORDER } from "../lib/ai/priority.js";
import { TEMPLATES } from "./_sms-templates.js";
import { hasOverlap } from "./_availability.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { autoCreateRevenueRecord, autoUpsertCustomer, autoUpsertBooking, autoCreateBlockedDate, extendBlockedDateForBooking, parseTime12h } from "./_booking-automation.js";
import { executeChargeFee, PREDEFINED_FEES, CHARGE_TYPE_LABELS } from "./charge-fee.js";
import { executeBackfillStripeCards } from "./backfill-stripe-card.js";
import { getBouncieVehicles, loadTrackedVehicles } from "./_bouncie.js";
import { buildUnifiedConfirmationEmail, buildDocumentNotes, isWebsitePaymentMethod } from "./_booking-confirmation-template.js";
import { persistBooking } from "./_booking-pipeline.js";
import { normalizeVehicleId, uiVehicleId } from "./_vehicle-id.js";
import { normalizeClockTime, isoDateInLA } from "./_time.js";
import { processActiveRentals, loadBookingsFromSupabase } from "./scheduled-reminders.js";
import { runAvailabilitySyncFix } from "./system-health-fix-availability.js";
import { randomBytes } from "crypto";
import nodemailer from "nodemailer";

// DB → app status mapping (mirrors v2-bookings.js)
const DB_TO_APP_STATUS = {
  pending:   "reserved_unpaid",
  approved:  "booked_paid",
  active:    "active_rental",
  completed: "completed_rental",
  cancelled: "cancelled_rental",
};

// ── Revenue helper (mirrors v2-dashboard) ────────────────────────────────────
function revenueFromBooking(booking) {
  if (typeof booking.amountPaid === "number" && booking.amountPaid > 0) return booking.amountPaid;
  if (booking.pickupDate && booking.returnDate && booking.vehicleId) {
    return computeAmount(booking.vehicleId, booking.pickupDate, booking.returnDate) || 0;
  }
  return 0;
}

const VALID_FLEET_SCOPES = new Set(["car", "cars"]);

function normalizeFleetScope(scope) {
  const value = String(scope || "").trim().toLowerCase();
  return VALID_FLEET_SCOPES.has(value) ? value : null;
}

function deriveVehicleCategory(vehicle = {}, fallbackVehicleId = "") {
  const explicit = String(vehicle.category || "").toLowerCase().trim();
  if (explicit === "car") return explicit;
  const type = String(vehicle.type || vehicle.vehicle_type || "").toLowerCase();
  const id = String(vehicle.vehicle_id || fallbackVehicleId || "").toLowerCase();
  const name = String(vehicle.vehicle_name || vehicle.name || "").toLowerCase();
  return "car";
}

function filterVehicleMapByScope(vehicles = {}, scope = null) {
  const normalizedScope = normalizeFleetScope(scope);
  if (!normalizedScope) return vehicles;
  return Object.fromEntries(
    Object.entries(vehicles).filter(([vehicleId, vehicle]) => {
      const category = deriveVehicleCategory(vehicle, vehicleId);
      return category === "car";
    })
  );
}

function filterRowsByVehicleIds(rows = [], vehicleIds = null, key = "vehicle_id") {
  if (!vehicleIds) return rows;
  return rows.filter((row) => {
    const rawId = row?.[key];
    const resolvedId = uiVehicleId(rawId) || rawId;
    return !!resolvedId && vehicleIds.has(resolvedId);
  });
}

// ── AI audit logging (ai_logs table) ────────────────────────────────────────
/**
 * Log an AI tool execution to the ai_logs table.
 * Falls back to admin_action_logs when ai_logs doesn't exist yet.
 *
 * @param {string} action   - tool name
 * @param {object} input    - sanitised args (no secrets)
 * @param {object} output   - tool result
 * @param {string} adminId  - identifier for the admin session ("admin" by default)
 */
export async function logAiAction(action, input, output, adminId = "admin") {
  const sb = getSupabaseAdmin();
  if (!sb) return; // non-fatal: skip when Supabase not configured

  // Try ai_logs first (0019 migration); fall back to admin_action_logs (0018)
  try {
    const { error } = await sb.from("ai_logs").insert({
      action,
      input:  input  || null,
      output: output || null,
      admin_id: adminId,
    });
    if (!error) return;
    // If ai_logs table/column doesn't exist yet, fall through to legacy table
    const msg = error.message || "";
    const isSchemaError =
      msg.includes("relation") ||
      msg.includes("does not exist") ||
      (msg.includes("Could not find") && msg.includes("column"));
    if (!isSchemaError) {
      console.warn("_admin-actions: ai_logs insert error:", msg);
      return;
    }
  } catch {
    // ignore
  }

  // Legacy fallback
  try {
    await sb.from("admin_action_logs").insert({
      action_name: action,
      args:        input  || null,
      result:      output || null,
    });
  } catch (err) {
    console.warn("_admin-actions: audit log fallback failed:", err.message);
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

// Columns selected from the Supabase bookings table for AI queries.
// Keep in sync with DB schema (migration 0019 adds flagged + risk_score).
const BOOKING_COLUMNS =
  "id, booking_ref, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, deposit_paid, total_price, payment_intent_id, stripe_customer_id, stripe_payment_method_id, extension_stripe_customer_id, extension_stripe_payment_method_id, created_at, flagged, risk_score, customers(name, phone, email)";

// ── Supabase-first helpers ───────────────────────────────────────────────────

/**
 * Load all bookings as a flat array.
 * Tries Supabase bookings table first; falls back to bookings.json.
 */
async function loadAllBookings(scope = null) {
  const sb = getSupabaseAdmin();
  let bookings = [];
  if (sb) {
    try {
      const { data, error } = await sb
        .from("bookings")
        .select(BOOKING_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(50);
      if (!error && data) {
        bookings = data.map((row) => ({
          bookingId:  row.booking_ref || String(row.id),
          name:       row.customers?.name  || "",
          phone:      row.customers?.phone || "",
          email:      row.customers?.email || "",
          vehicleId:  row.vehicle_id || "",
          pickupDate: row.pickup_date || "",
          returnDate: row.return_date || "",
          status:     DB_TO_APP_STATUS[row.status] || row.status,
          amountPaid: row.deposit_paid || row.total_price || 0,
          createdAt:  row.created_at || "",
          flagged:    row.flagged || false,
          risk_score: row.risk_score || 0,
          _dbId:      row.id,
        }));
      }
    } catch {
      // fall through
    }
  }
  if (bookings.length === 0) {
    const { data: bookingsData } = await loadBookings();
    bookings = Object.values(bookingsData).flat();
  }
  const normalizedScope = normalizeFleetScope(scope);
  if (!normalizedScope) return bookings;
  const scopedVehicles = await loadAllVehicles(normalizedScope);
  const scopedVehicleIds = new Set(Object.keys(scopedVehicles));
  if (scopedVehicleIds.size === 0) return [];
  return bookings.filter((booking) => {
    const resolvedId = uiVehicleId(booking.vehicleId) || booking.vehicleId;
    return !!resolvedId && scopedVehicleIds.has(resolvedId);
  });
}

/**
 * Load vehicles as a { [vehicleId]: vehicleObj } map.
 * Tries Supabase vehicles table first; falls back to vehicles.json.
 */
async function loadAllVehicles(scope = null) {
  const sb = getSupabaseAdmin();
  let vehicles = null;
  if (sb) {
    try {
      const { data, error } = await sb
        .from("vehicles")
        .select("vehicle_id, data, rental_status, bouncie_device_id, last_synced_at, decision_status, action_status, mileage, maintenance_interval, is_tracked, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage");
      if (!error && data) {
        const map = {};
        for (const row of data) {
          map[row.vehicle_id] = {
            vehicle_id:                row.vehicle_id,
            ...(row.data || {}),
            rental_status:             row.rental_status              || null,
            bouncie_device_id:         row.bouncie_device_id          || null,
            last_synced_at:            row.last_synced_at             || null,
            decision_status:           row.decision_status            || null,
            action_status:             row.action_status              || null,
            mileage:                   row.mileage                    ?? null,
            maintenance_interval:      row.maintenance_interval       ?? 5000,
            is_tracked:                row.is_tracked                 ?? false,
            last_oil_change_mileage:   row.last_oil_change_mileage    ?? null,
            last_brake_check_mileage:  row.last_brake_check_mileage   ?? null,
            last_tire_change_mileage:  row.last_tire_change_mileage   ?? null,
          };
        }
        vehicles = map;
      }
    } catch {
      // fall through
    }
  }
  if (!vehicles) {
    const { data } = await loadVehicles();
    vehicles = data;
  }
  return filterVehicleMapByScope(vehicles, scope);
}

/**
 * Store fraud flags for a booking back to Supabase bookings table.
 * Non-fatal — failure is logged as a warning.
 */
async function storeFraudFlags(bookingId, flagged, riskScore) {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  try {
    await sb
      .from("bookings")
      .update({ flagged, risk_score: riskScore })
      .eq("booking_ref", bookingId);
  } catch (err) {
    console.warn("_admin-actions: storeFraudFlags failed:", err.message);
  }
}

// ── Vehicle writes: Supabase + JSON fallback ─────────────────────────────────

async function upsertVehicleToSupabase(vehicleId, vehicleData) {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  try {
    await sb
      .from("vehicles")
      .upsert({ vehicle_id: vehicleId, data: vehicleData }, { onConflict: "vehicle_id" });
  } catch (err) {
    console.warn("_admin-actions: upsertVehicleToSupabase failed:", err.message);
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function toolGetRevenue({ month, scope } = {}) {
  const sb = getSupabaseAdmin();
  const normalizedScope = normalizeFleetScope(scope);
  const scopedVehicleIds = normalizedScope
    ? new Set(Object.keys(await loadAllVehicles(normalizedScope)))
    : null;

  // Primary source: revenue_records_effective (same as v2-dashboard.js and v2-analytics.js).
  // Falls back to bookings.amountPaid only when Supabase is unavailable or the view is empty.
  if (sb) {
    try {
      let q = sb
        .from("revenue_records_effective")
        .select("booking_id, vehicle_id, gross_amount, stripe_fee, stripe_net, is_cancelled, is_no_show, payment_status, pickup_date, created_at")
        .eq("payment_status", "paid")
        .eq("sync_excluded", false);
      if (month) q = q.gte("pickup_date", `${month}-01`).lte("pickup_date", `${month}-31`);
      const { data: rrRows, error: rrErr } = await q;

      if (!rrErr && (rrRows || []).length > 0) {
        const byVehicle = {};
        let total = 0;
        let totalFees = 0;
        let totalNet  = 0;
        let bookingCount = 0;

        for (const r of rrRows) {
          if (r.is_cancelled || r.is_no_show) continue;
          const vid   = uiVehicleId(r.vehicle_id) || r.vehicle_id || "unknown";
          if (scopedVehicleIds && !scopedVehicleIds.has(vid)) continue;
          const gross = Number(r.gross_amount || 0);
          const fee   = r.stripe_fee != null ? Number(r.stripe_fee) : 0;
          // Net = Gross − Stripe Fees (strict formula, no stripe_net).
          const net   = gross - fee;

          total     += gross;
          totalFees += fee;
          totalNet  += net;
          bookingCount++;

          if (!byVehicle[vid]) byVehicle[vid] = { count: 0, revenue: 0 };
          byVehicle[vid].count   += 1;
          byVehicle[vid].revenue += gross;
        }

        for (const v of Object.values(byVehicle)) {
          v.revenue = Math.round(v.revenue * 100) / 100;
        }

        return {
          period:    month || "all-time",
          total:     Math.round(total     * 100) / 100,
          gross:     Math.round(total     * 100) / 100,
          fees:      Math.round(totalFees * 100) / 100,
          net:       Math.round(totalNet  * 100) / 100,
          bookings:  bookingCount,
          byVehicle,
          _source:   "revenue_records_effective",
        };
      }
    } catch { /* fall through to bookings fallback */ }
  }

  // Fallback: compute from bookings.json when Supabase is unavailable or view is empty.
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
  const allBookings  = await loadAllBookings(scope);
  let filtered = allBookings.filter((b) => paidStatuses.has(b.status));
  if (month) filtered = filtered.filter((b) => (b.pickupDate || b.createdAt || "").startsWith(month));

  // Build bookingId → vehicleId map for charges lookup
  const bookingVehicleMap = {};
  for (const b of filtered) {
    if (b.bookingId) bookingVehicleMap[b.bookingId] = b.vehicleId;
  }

  const byVehicle = {};
  let total = 0;
  for (const b of filtered) {
    const vid = b.vehicleId || "unknown";
    const amt = revenueFromBooking(b);
    total += amt;
    if (!byVehicle[vid]) byVehicle[vid] = { count: 0, revenue: 0 };
    byVehicle[vid].count   += 1;
    byVehicle[vid].revenue += amt;
  }

  for (const v of Object.values(byVehicle)) {
    v.revenue = Math.round(v.revenue * 100) / 100;
  }

  return {
    period:   month || "all-time",
    total:    Math.round(total * 100) / 100,
    gross:    Math.round(total * 100) / 100,
    bookings: filtered.length,
    byVehicle,
    _source:  "bookings_fallback",
  };
}

async function toolGetBookings({ vehicleId, status, search, limit = 20, scope } = {}) {
  const safeLimit = Math.min(Number(limit) || 20, 100);
  const sb = getSupabaseAdmin();
  const normalizedScope = normalizeFleetScope(scope);
  const scopedVehicleIds = normalizedScope
    ? new Set(Object.keys(await loadAllVehicles(normalizedScope)))
    : null;

  let results = [];
  let total   = 0;

  if (scopedVehicleIds && scopedVehicleIds.size === 0) {
    return { total: 0, returned: 0, bookings: [] };
  }

  if (sb) {
    try {
        let query = sb
          .from("bookings")
          .select(BOOKING_COLUMNS, { count: "exact" })
          .order("created_at", { ascending: false })
          .limit(safeLimit);

        if (scopedVehicleIds) query = query.in("vehicle_id", Array.from(scopedVehicleIds));
        if (vehicleId) query = query.eq("vehicle_id", vehicleId);

      // Map app status to DB status for filtering
      if (status) {
        const APP_TO_DB = {
          reserved_unpaid:  "pending",
          booked_paid:      "booked_paid",
          active_rental:    "active_rental",
          completed_rental: "completed_rental",
          cancelled_rental: "cancelled_rental",
        };
        const dbStatus = APP_TO_DB[status] || status;
        query = query.eq("status", dbStatus);
      }

      if (search) {
        // Strip characters that have special meaning in PostgREST filter strings
        // to prevent filter injection via the .or() expression.
        const safeSearch = search.replace(/[,()'"\\]/g, "");
        // PostgREST does not support filtering on embedded (joined) table columns
        // inside .or() — restrict to booking_ref only.  Customer name/phone/email
        // searches fall through to the GitHub JSON fallback which handles them fine.
        query = query.or(`booking_ref.ilike.%${safeSearch}%`);
      }

      const { data, error, count } = await query;
      if (!error && data) {
        total   = count ?? data.length;
        results = data.map((row) => ({
          bookingId:    row.booking_ref || String(row.id),
          name:         row.customers?.name  || "",
          phone:        row.customers?.phone || "",
          email:        row.customers?.email || "",
          vehicleId:    row.vehicle_id || "",
          pickupDate:   row.pickup_date || "",
          returnDate:   row.return_date || "",
          status:       DB_TO_APP_STATUS[row.status] || row.status,
          amountPaid:   row.deposit_paid || row.total_price || 0,
          createdAt:    row.created_at || "",
          flagged:      row.flagged || false,
          risk_score:   row.risk_score || 0,
          hasSavedCard: !!(
            (row.stripe_customer_id && row.stripe_payment_method_id) ||
            (row.extension_stripe_customer_id && row.extension_stripe_payment_method_id)
          ),
        }));
        return { total, returned: results.length, bookings: results };
      }
    } catch {
      // fall through
    }
  }

  // Fallback: JSON files
  let all = await loadAllBookings(scope);
  if (vehicleId) all = all.filter((b) => b.vehicleId === vehicleId);
  if (status)    all = all.filter((b) => b.status === status);
  if (search) {
    const q = search.toLowerCase();
    all = all.filter((b) =>
      (b.name || "").toLowerCase().includes(q) ||
      (b.phone || "").includes(q) ||
      (b.email || "").toLowerCase().includes(q) ||
      (b.bookingId || "").toLowerCase().includes(q)
    );
  }
  all.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  total   = all.length;
  results = all.slice(0, safeLimit).map((b) => ({
    bookingId:  b.bookingId,
    name:       b.name,
    phone:      b.phone,
    email:      b.email,
    vehicleId:  b.vehicleId,
    pickupDate: b.pickupDate,
    returnDate: b.returnDate,
    status:     b.status,
    amountPaid: b.amountPaid || revenueFromBooking(b),
    createdAt:  b.createdAt,
  }));

  return { total, returned: results.length, bookings: results };
}

async function toolGetVehicles({ scope } = {}) {
  const sb = getSupabaseAdmin();
  const vehicles = await loadAllVehicles(scope);
  const allBookings = await loadAllBookings(scope);
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
  const scopedVehicleIds = new Set(Object.keys(vehicles));

  // Try to get booking counts from Supabase RPC
  let sbCounts = null;
  if (sb) {
    try {
      const { data, error } = await sb.rpc("get_vehicle_booking_counts");
      if (!error && data) {
        sbCounts = {};
        for (const row of data) sbCounts[row.vehicle_id] = Number(row.booking_count);
      }
    } catch {
      // fall through
    }
  }

  // Fetch mileage stats for priority computation (cars with Bouncie only)
  let mileageStatMap = {};
  if (sb) {
    try {
      const [{ data: vehicleRows }, { data: tripRows }] = await Promise.all([
        sb.from("vehicles")
          .select("vehicle_id, mileage, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
          .not("bouncie_device_id", "is", null),
        sb.from("trip_log")
          .select("vehicle_id, trip_distance, trip_at")
          .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      ]);
      const mileageInput = filterRowsByVehicleIds(vehicleRows || [], scopedVehicleIds).map((r) => ({
        vehicle_id:               r.vehicle_id,
        total_mileage:            Number(r.mileage) || 0,
        last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
          last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
          last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
        }));
      const { stats } = analyzeMileage(mileageInput, filterRowsByVehicleIds(tripRows || [], scopedVehicleIds).map((r) => ({
        vehicle_id: r.vehicle_id, trip_distance: r.trip_distance, trip_at: r.trip_at,
      })));
      for (const s of stats) mileageStatMap[s.vehicle_id] = s;
    } catch {
      // priority falls back to decision_status only
    }
  }

  const entries = Object.entries(vehicles).map(([vehicleId, v]) => {
    const vBookings  = allBookings.filter((b) => b.vehicleId === vehicleId && paidStatuses.has(b.status));
    const revenue    = vBookings.reduce((s, b) => s + (b.amountPaid || revenueFromBooking(b)), 0);
    const bookCount  = sbCounts ? (sbCounts[vehicleId] ?? vBookings.length) : vBookings.length;
    const vType      = v.type || v.vehicle_type || "";
    const isCar      = true;

    const { priority, reason: priorityReason } = computeVehiclePriority(v, mileageStatMap[vehicleId] || null);

    const entry = {
      vehicleId,
      name:              v.vehicle_name || vehicleId,
      type:              vType || "car",
      status:            v.status || "active",
      bouncie_device_id: v.bouncie_device_id || null,
      decision_status:   v.decision_status || null,
      action_status:     v.action_status    || null,
      priority,
      priority_reason:   priorityReason,
      totalBookings:     bookCount,
      totalRevenue:      Math.round(revenue * 100) / 100,
    };

    // Tracking warning: cars without a Bouncie device are not monitored
    if (isCar && !v.bouncie_device_id) {
      entry.tracking_warning = "⚠️ This vehicle is not tracked — no mileage or maintenance alerts";
    }

    return entry;
  });

  // Sort by priority: high → medium → low
  return { vehicles: sortByPriority(entries) };
}

async function toolAddVehicle({ vehicleId, vehicleName, type, dailyRate }) {
  if (!vehicleName) throw new Error("vehicleName is required");

  const vehicles = await loadAllVehicles();

  if (!vehicleId) {
    // Auto-generate a slug from the vehicle name (max 45 chars to leave room for suffix)
    const base = vehicleName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 45) || "vehicle";
    if (!vehicles[base]) {
      vehicleId = base;
    } else {
      // Append a guaranteed 4-char hex suffix using a cryptographically secure source
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      let candidate;
      let attempts = 0;
      do {
        if (++attempts > 100) throw new Error(`Could not generate a unique vehicle ID from name "${vehicleName}"`);
        const suffix = randomBytes(3).toString("hex").slice(0, 4); // always 4 lowercase hex chars
        candidate = `${base}-${suffix}`;
      } while (vehicles[candidate]);
      vehicleId = candidate;
    }
  } else if (!/^[a-z0-9_-]{2,50}$/.test(vehicleId)) {
    throw new Error("vehicleId must be lowercase letters, digits, hyphens, or underscores (2–50 chars)");
  }

  if (vehicles[vehicleId]) throw new Error(`Vehicle "${vehicleId}" already exists`);

  const vehicleObj = {
    vehicle_id:   vehicleId,
    vehicle_name: String(vehicleName).slice(0, 200),
    type:         type || "car",
    status:       "active",
    daily_rate:   dailyRate ? Number(dailyRate) : undefined,
  };

  // Write to Supabase vehicles table
  const sb = getSupabaseAdmin();
  if (sb) {
    const { error } = await sb.from("vehicles").insert({
      vehicle_id: vehicleId,
      data: vehicleObj,
    });
    if (error && !error.message?.includes("relation")) {
      throw new Error(`Supabase insert failed: ${error.message}`);
    }

    // Upsert vehicle_pricing row so create-payment-intent can load pricing
    // without relying on the JSONB fallback.
    if (dailyRate) {
      const pricingRow = {
        vehicle_id:     vehicleId,
        daily_price:    Number(dailyRate),
        weekly_price:   null,
        biweekly_price: null,
        monthly_price:  null,
        updated_at:     new Date().toISOString(),
      };
      const { error: pricingErr } = await sb
        .from("vehicle_pricing")
        .upsert(pricingRow, { onConflict: "vehicle_id" });
      if (pricingErr) {
        console.warn("toolAddVehicle: vehicle_pricing upsert failed:", pricingErr.message);
      }
    }
  }

  // Also update vehicles.json as fallback store
  const { data: jsonVehicles } = await loadVehicles();
  jsonVehicles[vehicleId] = vehicleObj;
  await saveVehicles(jsonVehicles);

  return { created: vehicleId, name: vehicleName };
}

// ISO date pattern YYYY-MM-DD
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function toolCreateVehicle({ vehicle_id: requestedVehicleId, name, type, price_per_day, weekly_rate, deposit, purchase_price, purchase_date, bouncie_device_id }) {
  // ── Validation ─────────────────────────────────────────────────────────────
  if (!name || !String(name).trim()) throw new Error("name is required");

  const resolvedType = (type || "car").toLowerCase();

  const dailyRate = Number(price_per_day);
  if (!price_per_day || isNaN(dailyRate) || dailyRate <= 0) {
    throw new Error("price_per_day must be a number greater than 0");
  }

  const weeklyRate = weekly_rate != null ? Number(weekly_rate) : null;
  if (weeklyRate !== null && (isNaN(weeklyRate) || weeklyRate < 0)) {
    throw new Error("weekly_rate must be a non-negative number");
  }

  const depositAmt = deposit != null ? Number(deposit) : null;
  if (depositAmt !== null && (isNaN(depositAmt) || depositAmt < 0)) {
    throw new Error("deposit must be a non-negative number");
  }

  const purchaseCost = Number(purchase_price);
  if (!purchase_price || isNaN(purchaseCost) || purchaseCost <= 0) {
    throw new Error("purchase_price must be a number greater than 0");
  }

  if (!purchase_date || !ISO_DATE_RE.test(String(purchase_date))) {
    throw new Error("purchase_date must be a valid date in YYYY-MM-DD format (e.g. \"2024-01-10\")");
  }
  // Reject dates that parse as invalid (e.g. 2024-13-99)
  if (isNaN(Date.parse(purchase_date))) {
    throw new Error(`purchase_date "${purchase_date}" is not a valid calendar date`);
  }

  // ── ID generation ─────────────────────────────────────────────────────────
  const vehicles = await loadAllVehicles();

  // Validate and use a caller-supplied vehicle_id when provided.
  const VEHICLE_ID_RE_LOCAL = /^[a-z0-9_-]{2,50}$/;
  let vehicleId;
  if (requestedVehicleId) {
    const candidateId = String(requestedVehicleId).trim().toLowerCase();
    if (!VEHICLE_ID_RE_LOCAL.test(candidateId)) {
      throw new Error(`vehicle_id "${candidateId}" is invalid — must be 2–50 lowercase letters, digits, hyphens, or underscores`);
    }
    if (vehicles[candidateId]) {
      throw new Error(`vehicle_id "${candidateId}" is already taken — choose a different ID`);
    }
    vehicleId = candidateId;
  } else {
    // Auto-generate from name (reuse same logic as toolAddVehicle)
    const base = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 45) || "vehicle";

    if (!vehicles[base]) {
      vehicleId = base;
    } else {
      let attempts = 0;
      do {
        if (++attempts > 100) throw new Error(`Could not generate a unique vehicle ID from name "${name}"`);
        const suffix = randomBytes(3).toString("hex").slice(0, 4);
        vehicleId = `${base}-${suffix}`;
      } while (vehicles[vehicleId]);
    }
  }

  // ── Build vehicle record ───────────────────────────────────────────────────
  const vehicleObj = {
    vehicle_id:     vehicleId,
    vehicle_name:   String(name).slice(0, 200),
    type:           resolvedType,
    status:         "active",
    daily_rate:     dailyRate,
    purchase_price: purchaseCost,
    purchase_date:  purchase_date,
  };
  if (weeklyRate !== null) vehicleObj.weekly = weeklyRate;
  if (depositAmt !== null) vehicleObj.deposit = depositAmt;

  // ── Write to Supabase ──────────────────────────────────────────────────────
  const sb = getSupabaseAdmin();
  if (sb) {
    const insertPayload = {
      vehicle_id: vehicleId,
      data: vehicleObj,
    };
    if (bouncie_device_id) {
      insertPayload.bouncie_device_id = String(bouncie_device_id).trim();
    }
    const { error } = await sb.from("vehicles").insert(insertPayload);
    if (error && !error.message?.includes("relation")) {
      throw new Error(`Supabase insert failed: ${error.message}`);
    }
    // Mirror bouncie_device_id into the data blob for consistency
    if (bouncie_device_id) {
      vehicleObj.bouncie_device_id = String(bouncie_device_id).trim();
    }

    // Upsert vehicle_pricing row so create-payment-intent can load pricing
    // without relying on the JSONB fallback.
    const pricingRow = {
      vehicle_id:     vehicleId,
      daily_price:    Number(dailyRate),
      weekly_price:   weeklyRate != null ? Number(weeklyRate) : null,
      biweekly_price: null,
      monthly_price:  null,
      updated_at:     new Date().toISOString(),
    };
    const { error: pricingErr } = await sb
      .from("vehicle_pricing")
      .upsert(pricingRow, { onConflict: "vehicle_id" });
    if (pricingErr) {
      console.warn("toolCreateVehicle: vehicle_pricing upsert failed:", pricingErr.message);
    }
  }

  // ── Write to vehicles.json fallback ───────────────────────────────────────
  const { data: jsonVehicles } = await loadVehicles();
  jsonVehicles[vehicleId] = vehicleObj;
  await saveVehicles(jsonVehicles);

  console.log(`toolCreateVehicle: created "${vehicleId}" (${name}), price=$${dailyRate}/day, purchase=$${purchaseCost}`);

  // ── Post-creation verification ────────────────────────────────────────────
  const hasTracking = !!bouncie_device_id;
  const warnings = [];
  if (!hasTracking) {
    warnings.push("No Bouncie device assigned — mileage and maintenance tracking is not active for this vehicle.");
  }

  return {
    created:        vehicleId,
    name:           vehicleObj.vehicle_name,
    type:           resolvedType,
    price_per_day:  dailyRate,
    weekly_rate:    weeklyRate,
    deposit:        depositAmt,
    purchase_price: purchaseCost,
    purchase_date,
    bouncie_device_id: bouncie_device_id || null,
    tracking_active: hasTracking,
    warnings,
  };
}

async function toolUpdateVehicle({ vehicleId, updates = {} }) {
  if (!vehicleId) throw new Error("vehicleId is required");

  const vehicles = await loadAllVehicles();
  if (!vehicles[vehicleId]) throw new Error(`Vehicle "${vehicleId}" not found`);

  const allowed = ["vehicle_name", "status", "daily_rate", "price_per_day", "bouncie_device_id"];
  const sanitized = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) sanitized[key] = updates[key];
  }
  // price_per_day is an alias for daily_rate
  if (sanitized.price_per_day !== undefined && sanitized.daily_rate === undefined) {
    sanitized.daily_rate = sanitized.price_per_day;
  }
  delete sanitized.price_per_day;

  if (sanitized.status) {
    const validStatuses = ["active", "maintenance", "inactive"];
    if (!validStatuses.includes(sanitized.status)) {
      throw new Error(`Invalid status "${sanitized.status}". Must be one of: ${validStatuses.join(", ")}`);
    }
  }

  const updated = { ...vehicles[vehicleId], ...sanitized };

  // Write to Supabase — bouncie_device_id lives as a real column as well as in data JSONB
  const sb = getSupabaseAdmin();
  if (sb) {
    const colUpdates = { data: updated };
    if (sanitized.bouncie_device_id !== undefined) {
      colUpdates.bouncie_device_id = sanitized.bouncie_device_id || null;
    }
    const { error } = await sb
      .from("vehicles")
      .update(colUpdates)
      .eq("vehicle_id", vehicleId);
    if (error && !error.message?.includes("relation")) {
      throw new Error(`Supabase update failed: ${error.message}`);
    }

    // Keep vehicle_pricing in sync when daily_rate is updated so that
    // getVehiclePricing (which checks vehicle_pricing FIRST) returns the
    // correct price. Without this, price changes via the AI chat are silently
    // ignored at payment time because the old vehicle_pricing row wins.
    if (sanitized.daily_rate !== undefined) {
      const newDailyPrice = Number(sanitized.daily_rate);
      if (!isNaN(newDailyPrice) && newDailyPrice > 0) {
        const { error: pricingErr } = await sb
          .from("vehicle_pricing")
          .upsert(
            { vehicle_id: vehicleId, daily_price: newDailyPrice, updated_at: new Date().toISOString() },
            { onConflict: "vehicle_id" }
          );
        if (pricingErr) {
          console.warn("toolUpdateVehicle: vehicle_pricing sync failed (non-fatal):", pricingErr.message);
        }
      }
    }
  }

  // Also update vehicles.json
  const { data: jsonVehicles } = await loadVehicles();
  if (jsonVehicles[vehicleId]) {
    jsonVehicles[vehicleId] = { ...jsonVehicles[vehicleId], ...sanitized };
    await saveVehicles(jsonVehicles);
  }

  return { updated: vehicleId, applied: sanitized };
}

async function toolSendSms({ phone, message }) {
  if (!phone)   throw new Error("phone is required");
  if (!message) throw new Error("message is required");
  if (typeof message !== "string" || message.length > 1000) {
    throw new Error("message must be a string of 1–1000 characters");
  }

  const result = await dispatchSms({
    phone,
    body: message,
    templateKey: "admin_manual_sms",
    source: "admin_actions",
    dedupe: false,
    throwOnError: true,
  });
  return { sent: !!result.sent, to: phone, id: result?.providerId || null };
}

async function resolveQueryOrEmpty(query) {
  try {
    return await query;
  } catch {
    return { data: [] };
  }
}

async function toolGetInsights({ scope } = {}) {
  console.time("toolGetInsights execution");
  try {
  const sb = getSupabaseAdmin();
  const vehicles = await loadAllVehicles(scope);
  const scopedVehicleIds = new Set(Object.keys(vehicles));

  // Run all 4 Supabase queries in parallel instead of two sequential batches.
  // Previously: batch-1 (bookings + vehicles) then batch-2 (mileage + trips).
  // Now: all 4 fire simultaneously, cutting total query time roughly in half.
  const mileageQuery = sb
    ? resolveQueryOrEmpty(sb.from("vehicles")
        .select("vehicle_id, mileage, last_synced_at, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
        .not("bouncie_device_id", "is", null)
      )
    : Promise.resolve({ data: [] });

  const tripQuery = sb
    ? resolveQueryOrEmpty(sb.from("trip_log")
        .select("vehicle_id, trip_distance, trip_at")
        .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString())
      )
    : Promise.resolve({ data: [] });

  const [allBookings, mileageResult, tripResult] = await Promise.all([
    loadAllBookings(scope),
    mileageQuery,
    tripQuery,
  ]);

  const mileageData = filterRowsByVehicleIds(mileageResult.data || [], scopedVehicleIds).map((r) => ({
      vehicle_id:               r.vehicle_id,
      vehicle_name:             r.data?.vehicle_name || r.vehicle_id,
      total_mileage:            Number(r.mileage) || 0,
      last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
      last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
      last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
      last_service_mileage:     Number(r.data?.last_service_mileage) || 0,
      last_synced_at:           r.last_synced_at,
    }));

  const recentTrips = filterRowsByVehicleIds(tripResult.data || [], scopedVehicleIds).map((r) => ({
    vehicle_id:    r.vehicle_id,
    trip_distance: r.trip_distance,
    trip_at:       r.trip_at,
  }));

  const insights = computeInsights({ allBookings, vehicles, revenueFromBooking });
  const problems = detectProblems({ allBookings, vehicles, revenueFromBooking, insights, mileageData, recentTrips });

  console.timeEnd("toolGetInsights execution");
  return { insights, problems };
  } catch (err) {
    console.timeEnd("toolGetInsights execution");
    throw err;
  }
}

async function toolGetMileage({ scope } = {}) {
  const sb = getSupabaseAdmin();
  if (!sb) {
    return {
      tracked_vehicles:   0,
      stats:              [],
      alerts:             [],
      bouncie_configured: false,
      note:               "Database not configured — mileage tracking requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set in Vercel.",
    };
  }

  // Check if Bouncie OAuth token is stored in the bouncie_tokens table.
  // Wrap in try/catch so a network error here doesn't propagate uncaught.
  let bouncie_configured = false;
  try {
    const { data: tokenRow } = await sb.from("bouncie_tokens").select("access_token").eq("id", 1).maybeSingle();
    bouncie_configured = !!(tokenRow?.access_token);
  } catch (tokenErr) {
    console.error("toolGetMileage: bouncie_tokens check error:", tokenErr.message);
    // Non-fatal — continue with bouncie_configured = false
  }

  // Load canonical vehicle names from the same source as the dashboard.
  // Non-fatal — falls back to the JSONB data field if unavailable.
  let vehicleNameMap = {};
  let vehicleTypeMap = {};
  const scopedVehicles = await loadAllVehicles(scope);
  const scopedVehicleIds = new Set(Object.keys(scopedVehicles));
  try {
    for (const [vid, v] of Object.entries(scopedVehicles)) {
      if (v.vehicle_name) vehicleNameMap[vid] = v.vehicle_name;
      if (v.type)         vehicleTypeMap[vid] = v.type;
    }
  } catch {
    // non-fatal
  }

  let vehicleRows = null;
  let tripRows    = [];
  try {
    const [vehicleResult, tripResult] = await Promise.all([
      sb.from("vehicles")
        .select("vehicle_id, mileage, last_synced_at, bouncie_device_id, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
        .not("bouncie_device_id", "is", null),
      resolveQueryOrEmpty(sb.from("trip_log")
        .select("vehicle_id, trip_distance, trip_at")
        .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString())),
    ]);

    // Surface DB errors rather than silently returning empty results.
    if (vehicleResult.error) {
      console.error("toolGetMileage: vehicles query error:", vehicleResult.error.message);
      return {
        tracked_vehicles:   0,
        stats:              [],
        alerts:             [],
        bouncie_configured,
        error:              adminErrorMessage(vehicleResult.error),
      };
    }

    vehicleRows = vehicleResult.data;
    tripRows    = tripResult.data || [];
  } catch (err) {
    console.error("toolGetMileage: DB error:", err.message);
    return {
      tracked_vehicles:   0,
      stats:              [],
      alerts:             [],
      bouncie_configured,
      error:              adminErrorMessage(err),
    };
  }

  const scopedBouncieRows = filterRowsByVehicleIds(vehicleRows || [], scopedVehicleIds);
  const mileageData = scopedBouncieRows.map((r) => ({
      vehicle_id:               r.vehicle_id,
      // Use canonical vehicle name from vehicles.json (same source as dashboard).
      vehicle_name:             vehicleNameMap[r.vehicle_id] || r.data?.vehicle_name || r.vehicle_id,
      total_mileage:            Number(r.mileage) || 0,
      last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
      last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
      last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
      last_service_mileage:     Number(r.data?.last_service_mileage) || 0,
      bouncie_device_id:        r.bouncie_device_id,
      last_synced_at:           r.last_synced_at,
    }));

  const { alerts, stats } = analyzeMileage(mileageData, filterRowsByVehicleIds(tripRows || [], scopedVehicleIds).map((r) => ({
    vehicle_id:    r.vehicle_id,
    trip_distance: r.trip_distance,
    trip_at:       r.trip_at,
  })));

  // Derive a per-vehicle maintenance_status from the alerts produced above.
  const statsWithStatus = stats.map((s) => {
    const prefix = `${s.name}:`;
    const vehicleAlerts = alerts.filter((a) => a.includes(prefix));
    const hasOverdue  = vehicleAlerts.some((a) => a.startsWith("🚨"));
    const hasDueSoon  = vehicleAlerts.some((a) => a.startsWith("⚠️"));
    return {
      ...s,
      maintenance_status: hasOverdue ? "overdue" : hasDueSoon ? "due_soon" : "ok",
    };
  });

  return {
    tracked_vehicles:   mileageData.length,
    raw_bouncie_rows:   scopedBouncieRows.length,
    stats:              statsWithStatus,
    alerts,
    bouncie_configured,
  };
}

/**
 * Real-time GPS tracking data for all Bouncie-tracked vehicles.
 * Calls the Bouncie API directly — returns live location, speed, movement
 * status, odometer, and last-sync timestamp for every tracked vehicle.
 */
async function toolGetGpsTracking({ scope } = {}) {
  const sb = getSupabaseAdmin();
  if (!sb) {
    return {
      connected: false,
      message: "Database not configured — GPS tracking requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set in Vercel.",
    };
  }

  // Fetch real-time data from Bouncie API.
  let bouncieVehicles;
  try {
    bouncieVehicles = await getBouncieVehicles();
  } catch (err) {
    console.error("toolGetGpsTracking: Bouncie API error:", err.message);
    return {
      connected: false,
      message: adminErrorMessage(err),
    };
  }

  // Load tracked vehicles from DB so we can map IMEI → vehicle name/ID.
  let trackedVehicles = [];
  try {
    trackedVehicles = await loadTrackedVehicles(sb);
  } catch (err) {
    console.error("toolGetGpsTracking: loadTrackedVehicles error:", err.message);
    // Non-fatal — continue with Bouncie data only; names will fall back to IMEI.
  }
  const scopedVehicleIds = new Set(Object.keys(await loadAllVehicles(scope)));
  if (normalizeFleetScope(scope)) {
    trackedVehicles = trackedVehicles.filter((vehicle) => scopedVehicleIds.has(vehicle.vehicle_id));
  }

  // Build lookup maps: IMEI → DB vehicle record.
  const imeiMap = {};
  for (const v of trackedVehicles) {
    if (v.bouncie_device_id) imeiMap[v.bouncie_device_id] = v;
  }

  // Build an entry for every tracked DB vehicle so vehicles with no GPS ping
  // are still visible (with null location fields).
  const vehicleMap = {};
  for (const v of trackedVehicles) {
    vehicleMap[v.vehicle_id] = {
      vehicle_id:   v.vehicle_id,
      vehicle_name: v.vehicle_name || v.vehicle_id,
      imei:         v.bouncie_device_id || null,
      lat:          null,
      lon:          null,
      speed_mph:    null,
      heading:      null,
      is_moving:    false,
      odometer:     typeof v.mileage === "number" ? v.mileage : null,
      last_updated: null,
      signal:       v.bouncie_device_id ? "no_signal" : "no_device",
    };
  }

  // Enrich with live Bouncie data.
  for (const bv of bouncieVehicles) {
    const { imei, stats } = bv;
    if (!imei) continue;
    const dbVehicle = imeiMap[imei];
    if (!dbVehicle) continue; // IMEI not in our fleet

    const loc = stats?.location || {};
    const vehicleId = dbVehicle.vehicle_id;

    vehicleMap[vehicleId] = {
      ...vehicleMap[vehicleId],
      lat:          typeof loc.lat     === "number" ? loc.lat                : null,
      lon:          typeof loc.lon     === "number" ? loc.lon                : null,
      speed_mph:    typeof loc.speed   === "number" ? Math.round(loc.speed)  : null,
      heading:      typeof loc.heading === "number" ? Math.round(loc.heading): null,
      is_moving:    loc.isMoving ?? false,
      odometer:     stats?.odometer ?? vehicleMap[vehicleId]?.odometer ?? null,
      last_updated: stats?.lastUpdated ?? null,
      signal:       loc.lat != null ? "ok" : "no_signal",
    };
  }

  const vehicles = Object.values(vehicleMap);
  const movingCount = vehicles.filter((v) => v.is_moving).length;
  const noSignalCount = vehicles.filter((v) => v.signal === "no_signal").length;
  const noDeviceCount = vehicles.filter((v) => v.signal === "no_device").length;

  return {
    connected:        true,
    vehicle_count:    vehicles.length,
    moving_count:     movingCount,
    no_signal_count:  noSignalCount,
    no_device_count:  noDeviceCount,
    vehicles,
    fetched_at:       new Date().toISOString(),
  };
}


async function toolGetExpenses({ vehicleId, category, group, scope } = {}) {
  const sb = getSupabaseAdmin();
  let expenses = null;
  const normalizedScope = normalizeFleetScope(scope);
  const scopedVehicleIds = normalizedScope
    ? new Set(Object.keys(await loadAllVehicles(normalizedScope)))
    : null;
  if (scopedVehicleIds && scopedVehicleIds.size === 0) {
    return { total: 0, count: 0, byGroup: {}, byCategory: {}, byVehicle: {}, expenses: [] };
  }

  if (sb) {
    try {
      let q = sb.from("expenses")
        .select("*, expense_categories!category_id(name, group_name)")
        .order("date", { ascending: false }).limit(200);
      if (scopedVehicleIds) q = q.in("vehicle_id", Array.from(scopedVehicleIds));
      if (vehicleId) q = q.eq("vehicle_id", vehicleId);
      const { data, error } = await q;
      if (!error) {
        expenses = (data || []).map((e) => {
          const { category_name, category_group } = enrichExpenseCategory(e);
          const { expense_categories: _rel, ...flat } = e;
          return { ...flat, category_name, category_group };
        });
      }
    } catch {
      // fall through
    }
  }

  if (!expenses) {
    const { data } = await loadExpenses();
    expenses = data;
    if (scopedVehicleIds) expenses = expenses.filter((e) => scopedVehicleIds.has(uiVehicleId(e.vehicle_id) || e.vehicle_id));
    if (vehicleId) expenses = expenses.filter((e) => e.vehicle_id === vehicleId);
    expenses = expenses.map((e) => {
      const { category_name, category_group } = enrichExpenseCategory(e);
      return { ...e, category_name, category_group };
    });
  }

  // Filter by legacy category text or new group
  if (category) {
    expenses = expenses.filter((e) =>
      e.category === category ||
      e.category_name?.toLowerCase() === category.toLowerCase()
    );
  }
  if (group) {
    expenses = expenses.filter((e) =>
      e.category_group?.toLowerCase() === group.toLowerCase()
    );
  }

  const total      = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const byCategory = {};
  const byGroup    = {};
  const byVehicle  = {};
  for (const e of expenses) {
    const cat = e.category_name || e.category || "other";
    byCategory[cat] = (byCategory[cat] || 0) + (Number(e.amount) || 0);
    const grp = e.category_group || "Other";
    byGroup[grp]    = (byGroup[grp] || 0) + (Number(e.amount) || 0);
    const vid = e.vehicle_id || "unknown";
    byVehicle[vid]  = (byVehicle[vid] || 0) + (Number(e.amount) || 0);
  }

  return {
    total:      Math.round(total * 100) / 100,
    count:      expenses.length,
    byGroup:    Object.fromEntries(Object.entries(byGroup).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    byVehicle:  Object.fromEntries(Object.entries(byVehicle).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    expenses:   expenses.slice(0, 50),
  };
}

async function toolGetAnalytics({ action = "fleet", vehicleId, months = 6, scope } = {}) {
  const allBookings = await loadAllBookings(scope);
  const vehicles = await loadAllVehicles(scope);
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
  const normalizedScope = normalizeFleetScope(scope);
  const scopedVehicleIds = new Set(Object.keys(vehicles));

  // Load expenses for investment ROI / profit calculations
  let expensesData = [];
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb.from("expenses").select("vehicle_id, amount");
      if (!error) expensesData = data || [];
    } catch { /* fallback below */ }
  }
  if (!expensesData.length) {
    const { data } = await loadExpenses();
    expensesData = data || [];
  }
  if (normalizedScope) {
    expensesData = expensesData.filter((e) => scopedVehicleIds.has(uiVehicleId(e.vehicle_id) || e.vehicle_id));
  }

  // Load revenue from revenue_records_effective (primary) — same source as v2-dashboard.js
  // and v2-analytics.js so AI-reported totals match the admin pages.
  // rrByVehicle: { [vehicleId]: { gross, fees, net, count, monthly: { [YYYY-MM]: gross } } }
  const rrByVehicle = {};
  let financialsFromRevRecords = false;
  if (sb) {
    try {
      const { data: rrRows, error: rrErr } = await sb
        .from("revenue_records_effective")
        .select("vehicle_id, gross_amount, stripe_fee, stripe_net, is_cancelled, is_no_show, payment_status, pickup_date, created_at")
        .eq("payment_status", "paid")
        .eq("sync_excluded", false);
      if (!rrErr && (rrRows || []).length > 0) {
        financialsFromRevRecords = true;
        for (const r of rrRows) {
          if (r.is_cancelled || r.is_no_show) continue;
          const vid   = uiVehicleId(r.vehicle_id) || r.vehicle_id || "unknown";
          if (normalizedScope && !scopedVehicleIds.has(vid)) continue;
          const gross = Number(r.gross_amount || 0);
          const fee   = r.stripe_fee != null ? Number(r.stripe_fee) : 0;
          // Net = Gross − Stripe Fees (strict formula, no stripe_net).
          const net   = gross - fee;
          if (!rrByVehicle[vid]) rrByVehicle[vid] = { gross: 0, fees: 0, net: 0, count: 0, monthly: {} };
          rrByVehicle[vid].gross += gross;
          rrByVehicle[vid].fees  += fee;
          rrByVehicle[vid].net   += net;
          rrByVehicle[vid].count += 1;
          const monthKey = (r.pickup_date || r.created_at || "").slice(0, 7);
          if (monthKey) {
            rrByVehicle[vid].monthly[monthKey] = (rrByVehicle[vid].monthly[monthKey] || 0) + gross;
          }
        }
      }
    } catch { /* fall through to bookings fallback */ }
  }

  // Helper: compute investment ROI fields for a vehicle
  function computeInvestmentFields(v, revenue, vExpenseTotal) {
    const profit        = Math.round((revenue - vExpenseTotal) * 100) / 100;
    const purchasePrice = Number(v.purchase_price || 0);
    const purchaseDateMs = v.purchase_date ? new Date(v.purchase_date).getTime() : 0;
    const monthsActive  = purchaseDateMs > 0
      ? Math.max(1, Math.round((Date.now() - purchaseDateMs) / (86400000 * 30.4375 /* avg days/month */)))
      : null;
    const vehicleRoi    = purchasePrice > 0 ? Math.round((profit / purchasePrice) * 10000) / 100 : null;
    const monthlyProfit = monthsActive != null && monthsActive > 0
      ? Math.round((profit / monthsActive) * 100) / 100
      : null;
    const annualRoi     = purchasePrice > 0 && monthlyProfit != null
      ? Math.round(((monthlyProfit * 12) / purchasePrice) * 10000) / 100
      : null;
    const paybackMonths = purchasePrice > 0 && monthlyProfit != null && monthlyProfit > 0
      ? Math.round((purchasePrice / monthlyProfit) * 10) / 10
      : null;
    return { profit, purchase_price: purchasePrice, months_active: monthsActive, vehicle_roi: vehicleRoi, monthly_profit: monthlyProfit, annual_roi: annualRoi, payback_months: paybackMonths };
  }

  if (action === "revenue_trend") {
    const safeMonths = Math.min(Number(months) || 6, 24);
    const trend = [];
    const now = new Date();

    if (financialsFromRevRecords) {
      // Build trend from revenue_records monthly data.
      // Initialize all months in the requested range first so booking counts
      // from bookings.json are included even if no revenue_records exist for that month.
      const monthly = {};
      for (let i = safeMonths - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        monthly[m] = { revenue: 0, bookings: 0 };
      }
      for (const vr of Object.values(rrByVehicle)) {
        for (const [m, amount] of Object.entries(vr.monthly)) {
          if (monthly[m]) monthly[m].revenue += amount;
        }
      }
      // Count bookings per month from bookings.json (non-financial, same as v2-analytics.js)
      for (const b of allBookings) {
        if (!paidStatuses.has(b.status)) continue;
        const m = (b.pickupDate || b.createdAt || "").slice(0, 7);
        if (m && monthly[m]) monthly[m].bookings += 1;
      }
      for (let i = safeMonths - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const entry = monthly[month];
        trend.push({ month, revenue: Math.round(entry.revenue * 100) / 100, bookings: entry.bookings });
      }
    } else {
      // Fallback: bookings.json
      for (let i = safeMonths - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const monthBookings = allBookings.filter(
          (b) => paidStatuses.has(b.status) && (b.pickupDate || b.createdAt || "").startsWith(month)
        );
        const revenue = monthBookings.reduce((s, b) => s + revenueFromBooking(b), 0);
        trend.push({ month, revenue: Math.round(revenue * 100) / 100, bookings: monthBookings.length });
      }
    }
    return { action: "revenue_trend", months: safeMonths, trend, _source: financialsFromRevRecords ? "revenue_records_effective" : "bookings_fallback" };
  }

  if (action === "vehicle" && vehicleId) {
    const v = vehicles[vehicleId];
    if (!v) return { error: `Vehicle "${vehicleId}" not found` };
    const vBookings = allBookings.filter((b) => b.vehicleId === vehicleId && paidStatuses.has(b.status));

    let revenue;
    if (financialsFromRevRecords) {
      revenue = (rrByVehicle[vehicleId] || { gross: 0 }).gross;
    } else {
      revenue = vBookings.reduce((s, b) => s + revenueFromBooking(b), 0);
    }

    const avgDays = vBookings.length
      ? vBookings.reduce((s, b) => {
          if (!b.pickupDate || !b.returnDate) return s;
          return s + Math.max(1, Math.round((new Date(b.returnDate) - new Date(b.pickupDate)) / 86400000));
        }, 0) / vBookings.length
      : 0;
    const dayCounts = {};
    for (const b of vBookings) {
      if (!b.pickupDate) continue;
      const day = new Date(b.pickupDate + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long" });
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    }
    const vExpenseTotal = expensesData
      .filter((e) => e.vehicle_id === vehicleId)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    const inv = computeInvestmentFields(v, revenue, vExpenseTotal);
    return {
      action: "vehicle",
      vehicleId,
      name:            v.vehicle_name || vehicleId,
      total_bookings:  financialsFromRevRecords ? (rrByVehicle[vehicleId] || { count: 0 }).count : vBookings.length,
      total_revenue:   Math.round(revenue * 100) / 100,
      total_expenses:  Math.round(vExpenseTotal * 100) / 100,
      avg_rental_days: Math.round(avgDays * 10) / 10,
      popular_days:    Object.entries(dayCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([day, count]) => ({ day, count })),
      _source: financialsFromRevRecords ? "revenue_records_effective" : "bookings_fallback",
      ...inv,
    };
  }

  // Default: fleet overview
  const summary = Object.entries(vehicles).map(([vid, v]) => {
    const vBookings = allBookings.filter((b) => b.vehicleId === vid && paidStatuses.has(b.status));

    let revenue, totalBookings;
    if (financialsFromRevRecords) {
      const vr = rrByVehicle[vid] || { gross: 0, count: 0 };
      revenue       = vr.gross;
      totalBookings = vr.count;
    } else {
      revenue       = vBookings.reduce((s, b) => s + revenueFromBooking(b), 0);
      totalBookings = vBookings.length;
    }

    const firstBooking = vBookings.reduce((earliest, b) => {
      const d = b.pickupDate || b.createdAt || "";
      return !earliest || d < earliest ? d : earliest;
    }, null);
    const daysSinceFirst = firstBooking
      ? Math.max(90, Math.round((Date.now() - new Date(firstBooking).getTime()) / 86400000))
      : 90;
    // Estimate utilization: assume average 3 rental days per booking as a rough proxy.
    const AVG_RENTAL_DAYS = 3;
    const utilization = Math.min(100, Math.round((totalBookings * AVG_RENTAL_DAYS / daysSinceFirst) * 100));
    const vExpenseTotal = expensesData
      .filter((e) => e.vehicle_id === vid)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    const inv = computeInvestmentFields(v, revenue, vExpenseTotal);
    return {
      vehicleId:        vid,
      name:             v.vehicle_name || vid,
      type:             v.type || "car",
      total_bookings:   totalBookings,
      total_revenue:    Math.round(revenue * 100) / 100,
      total_expenses:   Math.round(vExpenseTotal * 100) / 100,
      utilization_pct:  utilization,
      ...inv,
    };
  });

  return {
    action: "fleet",
    vehicles: summary.sort((a, b) => b.total_revenue - a.total_revenue),
    total_revenue: Math.round(summary.reduce((s, v) => s + v.total_revenue, 0) * 100) / 100,
    total_bookings: summary.reduce((s, v) => s + v.total_bookings, 0),
    _source: financialsFromRevRecords ? "revenue_records_effective" : "bookings_fallback",
  };
}

async function toolGetCustomers({ search, flagged, banned, limit = 50, scope } = {}) {
  const sb = getSupabaseAdmin();
  const safeLimit = Math.min(Number(limit) || 50, 200);
  const normalizedScope = normalizeFleetScope(scope);
  let customers = null;

  // The customers table is global, not fleet-scoped. When a valid scope is
  // requested we derive the customer list from scoped bookings instead so the
  // fleet-scoped assistant requests should not leak unrelated customer data.
  if (sb && !normalizedScope) {
    try {
      let q = sb.from("customers").select("*").order("total_bookings", { ascending: false }).limit(safeLimit);
      if (flagged !== undefined) q = q.eq("flagged", !!flagged);
      if (banned  !== undefined) q = q.eq("banned",  !!banned);
      if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`);
      const { data, error } = await q;
      if (!error) customers = data || [];
    } catch {
      // fall through
    }
  }

  if (!customers) {
    // Derive customers from bookings as fallback
    const allBookings = await loadAllBookings(scope);
    const byPhone = {};
    for (const b of allBookings) {
      const phone = b.phone || "unknown";
      if (!byPhone[phone]) {
        byPhone[phone] = { phone, name: b.name || "", email: b.email || "", total_bookings: 0, total_spent: 0 };
      }
      byPhone[phone].total_bookings += 1;
      byPhone[phone].total_spent += b.amountPaid || revenueFromBooking(b);
    }
    customers = Object.values(byPhone);
    if (search) {
      const q = search.toLowerCase();
      customers = customers.filter((c) =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.phone || "").includes(q) ||
        (c.email || "").toLowerCase().includes(q)
      );
    }
    customers = customers.sort((a, b) => b.total_bookings - a.total_bookings).slice(0, safeLimit);
  }

  return {
    total:     customers.length,
    customers: customers.map((c) => ({
      id:             c.id || undefined,
      name:           c.name || c.customer_name || "",
      phone:          c.phone || "",
      email:          c.email || "",
      total_bookings: c.total_bookings || 0,
      total_spent:    typeof c.total_spent === "number" ? Math.round(c.total_spent * 100) / 100 : undefined,
      flagged:        c.flagged || false,
      banned:         c.banned  || false,
      flag_reason:    c.flag_reason || undefined,
      ban_reason:     c.ban_reason  || undefined,
      notes:          c.notes       || undefined,
    })),
  };
}

async function toolGetProtectionPlans() {
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb.from("protection_plans")
        .select("id, name, description, daily_rate, liability_cap, is_active, sort_order")
        .order("sort_order").order("name");
      if (!error && data && data.length > 0) {
        return { plans: data };
      }
    } catch {
      // fall through
    }
  }

  // Hardcoded defaults (mirrors v2-protection-plans.js)
  return {
    plans: [
      { name: "None",     description: "No protection plan",                    daily_rate: 0,  liability_cap: 0,    is_active: true },
      { name: "Basic",    description: "Basic damage protection, $1,000 cap",   daily_rate: 15, liability_cap: 1000, is_active: true },
      { name: "Standard", description: "Standard coverage, $500 cap",           daily_rate: 25, liability_cap: 500,  is_active: true },
      { name: "Premium",  description: "Full coverage, $0 liability",           daily_rate: 40, liability_cap: 0,    is_active: true },
    ],
    source: "defaults",
  };
}

async function toolGetSystemSettings({ category } = {}) {
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      let q = sb.from("system_settings").select("key, value, description, category");
      if (category) q = q.eq("category", category);
      const { data, error } = await q;
      if (!error && data && data.length > 0) {
        return {
          settings: data.map((r) => ({ key: r.key, value: r.value, description: r.description, category: r.category })),
          count: data.length,
        };
      }
    } catch {
      // fall through to defaults
    }
  }

  // Hardcoded defaults (mirrors v2-system-settings.js)
  const defaults = [
    { key: "la_tax_rate",                value: 0.1025, description: "LA combined sales tax rate",             category: "tax" },
    { key: "camry_daily_rate",           value: 55,     description: "Camry daily rate (USD)",                 category: "pricing" },
    { key: "camry_weekly_rate",          value: 350,    description: "Camry weekly rate (USD)",                category: "pricing" },
    { key: "auto_block_dates_on_approve",value: true,   description: "Auto-block dates when booking approved", category: "automation" },
    { key: "notify_sms_on_approve",      value: true,   description: "Send SMS on booking approval",           category: "notification" },
    { key: "notify_email_on_approve",    value: true,   description: "Send email on booking approval",         category: "notification" },
  ];

  const filtered = category ? defaults.filter((s) => s.category === category) : defaults;
  return { settings: filtered, count: filtered.length, source: "defaults" };
}

/**
 * Compute a rental price quote using the live pricing system.
 * Routes to the appropriate settings-based helper depending on vehicle type:
 *   - Known economy cars (camry/camry2013) → computeBreakdownLinesFromSettings
 *   - Newly created "car" type vehicles → daily_rate × days + live tax
 */
async function toolGetPriceQuote({ vehicleId, pickup, returnDate }) {
  if (!vehicleId) return { error: "vehicleId is required" };

  const settings = await loadPricingSettings();
  const vehicles = await loadAllVehicles();
  const vehicle  = vehicles[vehicleId];

  if (!vehicle) return { error: `Vehicle "${vehicleId}" not found` };

  const vType = (vehicle.type || vehicle.vehicle_type || "").toLowerCase();
  if (!pickup || !returnDate) {
    return { error: "pickup and returnDate (YYYY-MM-DD) are required for car price quotes" };
  }

  const days = computeRentalDays(pickup, returnDate);

  // Use getVehicleById for non-camry vehicles so we get normalised pricing
  // fields (pricePerDay, weekly, biweekly, monthly) regardless of how the
  // vehicle was created (admin portal, AI tool, or vehicles.json).
  const isKnownEconomy = (vehicleId === "camry" || vehicleId === "camry2013");
  const vehicleDataForBreakdown = isKnownEconomy ? null : await getVehicleById(vehicleId).catch(() => null);

  const lines = computeBreakdownLinesFromSettings(vehicleId, pickup, returnDate, settings, false, null, vehicleDataForBreakdown || vehicle);
  if (!lines) return { error: `Vehicle "${vehicleId}" has no daily rate configured. Update it with update_vehicle first.` };
  const totalLine = lines.find((l) => l.startsWith("Total:")) || "";
  const total = parseFloat(totalLine.replace("Total: $", "")) || 0;
  return {
    vehicleId,
    vehicle_name: vehicle.vehicle_name || vehicleId,
    type:         vType || "car",
    pickup,
    return_date:  returnDate,
    days,
    breakdown:    lines,
    total,
    note: `Add Damage Protection Plan (basic $${PROTECTION_PLAN_BASIC}/day, standard $${PROTECTION_PLAN_STANDARD}/day, premium $${PROTECTION_PLAN_PREMIUM}/day) for additional coverage.`,
  };
}

async function toolGetSmsTemplates() {
  const sb = getSupabaseAdmin();
  let overrides = {};

  if (sb) {
    try {
      const { data, error } = await sb.from("sms_template_overrides").select("template_key, message, enabled");
      if (!error && data) {
        for (const row of data) {
          overrides[row.template_key] = { message: row.message, enabled: row.enabled };
        }
      }
    } catch {
      // use defaults only
    }
  }

  const templates = Object.entries(TEMPLATES).map(([key, defaultMessage]) => {
    const override = overrides[key];
    return {
      key,
      message:    override?.message  ?? defaultMessage,
      enabled:    override?.enabled  ?? true,
      customized: !!override,
    };
  });

  return { total: templates.length, templates };
}

async function toolGetBlockedDates({ vehicleId } = {}) {
  const sb = getSupabaseAdmin();

  // ── 1. Booking timeline from vehicle_blocking_ranges (single source of truth)
  //       Returns one row per segment (base rental + each extension) with
  //       source = 'base' | 'extension' so the timeline is always correct.
  let timelineByVehicle = null;
  if (sb) {
    try {
      let q = sb
        .from("vehicle_blocking_ranges")
        .select("vehicle_id, booking_ref, start_date, end_date, source")
        .order("start_date", { ascending: true });
      if (vehicleId) q = q.eq("vehicle_id", vehicleId);
      const { data, error } = await q;
      if (!error && data) {
        timelineByVehicle = {};
        for (const row of data) {
          const vid = row.vehicle_id;
          if (!timelineByVehicle[vid]) timelineByVehicle[vid] = [];
          timelineByVehicle[vid].push({
            from:        row.start_date,
            to:          row.end_date,
            source:      row.source,
            booking_ref: row.booking_ref || undefined,
          });
        }
      }
    } catch {
      // fall through to manual/maintenance blocks only
    }
  }

  // ── 2. Manual / maintenance blocks from blocked_dates (non-booking rows)
  //       These cover 'manual' and 'maintenance' reasons and are NOT included
  //       in vehicle_blocking_ranges (which only tracks booking segments).
  let manualBlocksByVehicle = {};
  if (sb) {
    try {
      let q = sb
        .from("blocked_dates")
        .select("vehicle_id, start_date, end_date, reason")
        .neq("reason", "booking")
        .order("start_date", { ascending: true });
      if (vehicleId) q = q.eq("vehicle_id", vehicleId);
      const { data, error } = await q;
      if (!error && data) {
        for (const row of data) {
          const vid = row.vehicle_id;
          if (!manualBlocksByVehicle[vid]) manualBlocksByVehicle[vid] = [];
          manualBlocksByVehicle[vid].push({ from: row.start_date, to: row.end_date, reason: row.reason });
        }
      }
    } catch {
      // ignore
    }
  }

  // ── 3. If vehicle_blocking_ranges is unavailable, fall back to flat blocked_dates.
  if (!timelineByVehicle) {
    let blockedDates = null;
    if (sb) {
      try {
        let q = sb.from("blocked_dates").select("vehicle_id, start_date, end_date, reason").order("start_date", { ascending: true });
        if (vehicleId) q = q.eq("vehicle_id", vehicleId);
        const { data, error } = await q;
        if (!error && data) {
          blockedDates = {};
          for (const row of data) {
            const vid = row.vehicle_id;
            if (!blockedDates[vid]) blockedDates[vid] = [];
            blockedDates[vid].push({ from: row.start_date, to: row.end_date, reason: row.reason || undefined });
          }
        }
      } catch {
        // fall through
      }
    }
    if (!blockedDates) {
      return { blocked_dates: {}, note: "Could not retrieve blocked dates — Supabase unavailable." };
    }
    const summary = {};
    let total = 0;
    for (const [vid, ranges] of Object.entries(blockedDates)) {
      const arr = Array.isArray(ranges) ? ranges : [];
      summary[vid] = arr;
      total += arr.length;
    }
    return { total_ranges: total, blocked_dates: summary };
  }

  // ── 4. Merge timeline segments + manual blocks per vehicle ────────────────
  const allVehicleIds = new Set([
    ...Object.keys(timelineByVehicle),
    ...Object.keys(manualBlocksByVehicle),
  ]);
  const summary = {};
  let total = 0;
  for (const vid of allVehicleIds) {
    const segments = (timelineByVehicle[vid] || []).concat(
      (manualBlocksByVehicle[vid] || []).map((b) => ({ ...b, source: "manual" }))
    );
    segments.sort((a, b) => (a.from || "").localeCompare(b.from || ""));
    summary[vid] = segments;
    total += segments.length;
  }

  return { total_ranges: total, blocked_dates: summary, source: "vehicle_blocking_ranges" };
}

async function toolGetFraudReport({ flaggedOnly = true } = {}) {
  const allBookings = await loadAllBookings();
  let scored = scoreAllBookings(allBookings);

  // Persist risk scores to Supabase in the background (non-blocking)
  const flaggedItems = scored.filter((b) => b.flagged);
  Promise.all(
    flaggedItems.map((b) => storeFraudFlags(b.bookingId, b.flagged, b.risk_score))
  ).catch((err) => console.warn("_admin-actions: batch fraud persist failed:", err.message));

  if (flaggedOnly) scored = scored.filter((b) => b.flagged);
  scored.sort((a, b) => b.risk_score - a.risk_score);

  return {
    total:    allBookings.length,
    flagged:  flaggedItems.length,
    results:  scored.slice(0, 50),
  };
}

// Maps serviceType → DB column name and JSONB key (matches v2-mileage.js and migration 0022)
const MAINTENANCE_SERVICE_COLUMNS = {
  oil:    { col: "last_oil_change_mileage",   jsonKey: "last_oil_change_mileage" },
  brakes: { col: "last_brake_check_mileage",  jsonKey: "last_brake_check_mileage" },
  tires:  { col: "last_tire_change_mileage",  jsonKey: "last_tire_change_mileage" },
};

/**
 * Run the fleet-wide maintenance status check.
 * Computes OK / DUE_SOON / OVERDUE for each tracked vehicle using
 * lib/ai/maintenance.js, upserts maintenance table rows, and escalates
 * OVERDUE vehicles to action_status = "pending".
 */
async function toolUpdateMaintenanceStatus() {
  const sb = getSupabaseAdmin();
  if (!sb) {
    return { error: "Database not configured — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set." };
  }

  let vehicleRows;
  try {
    const { data, error } = await sb
      .from("vehicles")
      .select("vehicle_id, data, mileage, maintenance_interval, is_tracked, bouncie_device_id, action_status");
    if (error) throw new Error(`vehicles query failed: ${error.message}`);
    vehicleRows = data || [];
  } catch (err) {
    console.error("toolUpdateMaintenanceStatus: vehicles query error:", err.message);
    return { error: err.message };
  }

  const enriched = vehicleRows
    .filter((v) => v.is_tracked || v.bouncie_device_id != null)
    .map((v) => ({
      ...v,
      vehicle_name:         v.data?.vehicle_name || v.data?.name || v.vehicle_id,
      last_service_mileage: v.data?.last_service_mileage ?? null,
    }));

  if (enriched.length === 0) {
    return {
      processed: 0,
      alerts:    [],
      overdue:   0,
      due_soon:  0,
      ok:        0,
      note:      "No tracked vehicles found. Set is_tracked = true on vehicles to enable monitoring.",
    };
  }

  const { results, alerts, overdue, due_soon, ok } = computeFleetAlerts(enriched);
  const now = new Date().toISOString();

  for (const result of results) {
    const { vehicle_id, status, miles_since_service, interval, miles_until_service } = result;
    const dbStatus = status === "OVERDUE"  ? "overdue"
                   : status === "DUE_SOON" ? "pending"
                   :                         "completed";

    try {
      const { error: upsertErr } = await sb
        .from("maintenance")
        .upsert(
          {
            vehicle_id,
            service_type: "general",
            status:       dbStatus,
            notes:        `Auto-computed: ${miles_since_service} mi since last service. Interval: ${interval} mi. Miles until next service: ${miles_until_service}.`,
            updated_at:   now,
          },
          { onConflict: "vehicle_id,service_type" }
        );
      if (upsertErr) console.error(`toolUpdateMaintenanceStatus: upsert failed for ${vehicle_id}:`, upsertErr.message);
    } catch (err) {
      console.error(`toolUpdateMaintenanceStatus: upsert threw for ${vehicle_id}:`, err.message);
    }

    if (status === "OVERDUE") {
      const v = enriched.find((row) => row.vehicle_id === vehicle_id);
      if (!v?.action_status || v.action_status === "resolved") {
        try {
          const { error: updateErr } = await sb
            .from("vehicles")
            .update({ action_status: "pending", updated_at: now })
            .eq("vehicle_id", vehicle_id);
          if (updateErr) console.error(`toolUpdateMaintenanceStatus: action_status update failed for ${vehicle_id}:`, updateErr.message);
        } catch (err) {
          console.error(`toolUpdateMaintenanceStatus: action_status update threw for ${vehicle_id}:`, err.message);
        }
      }
    }
  }

  return { processed: results.length, alerts, overdue, due_soon, ok };
}



/**
 * Get maintenance status for a vehicle looked up by name.
 * Queries maintenance_history (completed services), maintenance_appointments
 * (driver-scheduled appointments), the maintenance table (migration 0029),
 * and the mileage columns on vehicles (migration 0022).
 * Works for ALL vehicles regardless of GPS tracking.
 */
async function toolGetMaintenanceStatus({ vehicleName, scope } = {}) {
  if (!vehicleName) {
    return { error: "vehicleName is required" };
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return { error: "Database not configured — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Vercel." };
  }

  // Load vehicles to find matching vehicle_id by name
  let vehicleRows;
  try {
    const { data, error } = await sb
      .from("vehicles")
      .select("vehicle_id, data, mileage, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, rental_status, bouncie_device_id, action_status");
    if (error) throw new Error(`vehicles query failed: ${error.message}`);
    vehicleRows = data || [];
  } catch (err) {
    console.error("toolGetMaintenanceStatus: vehicles query error:", err.message);
    return { error: err.message };
  }

  const scopedVehicleIds = new Set(Object.keys(await loadAllVehicles(scope)));
  if (normalizeFleetScope(scope)) {
    vehicleRows = vehicleRows.filter((row) => scopedVehicleIds.has(uiVehicleId(row.vehicle_id) || row.vehicle_id));
  }

  // Case-insensitive name match — check vehicle_name in data JSONB, then vehicle_id
  const lower = vehicleName.toLowerCase().trim();
  const vehicle = vehicleRows.find((r) => {
    const name = (r.data?.vehicle_name || r.data?.name || "").toLowerCase();
    return name.includes(lower) || r.vehicle_id.toLowerCase().includes(lower);
  });

  if (!vehicle) {
    const available = vehicleRows.map((r) => r.data?.vehicle_name || r.vehicle_id).filter(Boolean);
    return {
      error:              `No vehicle found matching "${vehicleName}".`,
      available_vehicles: available,
    };
  }

  const vehicleId          = vehicle.vehicle_id;
  const vehicleDisplayName = vehicle.data?.vehicle_name || vehicle.data?.name || vehicleId;
  const currentMileage     = Number(vehicle.mileage) || null;

  // Fetch all maintenance data in parallel; each query is non-fatal if table missing
  const [historyResult, appointmentsResult, maintenanceResult] = await Promise.allSettled([
    sb
      .from("maintenance_history")
      .select("id, service_type, mileage, notes, created_at, booking_id")
      .eq("vehicle_id", vehicleId)
      .order("created_at", { ascending: false })
      .limit(10),
    sb
      .from("maintenance_appointments")
      .select("id, service_type, scheduled_at, status, notes, created_at, missed_at")
      .eq("vehicle_id", vehicleId)
      .order("scheduled_at", { ascending: false })
      .limit(10),
    sb
      .from("maintenance")
      .select("id, service_type, due_date, status, notes, created_at, updated_at")
      .eq("vehicle_id", vehicleId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  // Surface real errors, skip "relation does not exist" (table not migrated yet)
  const extractRows = (settled, label) => {
    if (settled.status === "rejected") {
      console.error(`toolGetMaintenanceStatus: ${label} query threw:`, settled.reason?.message);
      return [];
    }
    const { data, error } = settled.value;
    if (error) {
      const msg = error.message || "";
      if (!msg.includes("relation") && !msg.includes("does not exist")) {
        console.error(`toolGetMaintenanceStatus: ${label} error:`, msg);
      }
      return [];
    }
    return data || [];
  };

  const serviceHistory       = extractRows(historyResult,      "maintenance_history");
  const appointments         = extractRows(appointmentsResult, "maintenance_appointments");
  const maintenanceRecords   = extractRows(maintenanceResult,  "maintenance");

  // Compute mileage-based maintenance status from vehicle columns
  const lastOil    = vehicle.last_oil_change_mileage    != null ? Number(vehicle.last_oil_change_mileage)    : null;
  const lastBrakes = vehicle.last_brake_check_mileage   != null ? Number(vehicle.last_brake_check_mileage)   : null;
  const lastTires  = vehicle.last_tire_change_mileage   != null ? Number(vehicle.last_tire_change_mileage)   : null;

  // Use analyzeMileage to compute per-service alerts (same logic as get_mileage)
  let mileageAlerts = [];
  let mileageAlertsWarning = null;
  if (vehicle.bouncie_device_id && currentMileage) {
    try {
      const { alerts } = analyzeMileage([{
        vehicle_id:               vehicleId,
        vehicle_name:             vehicleDisplayName,
        total_mileage:            currentMileage,
        last_oil_change_mileage:  lastOil,
        last_brake_check_mileage: lastBrakes,
        last_tire_change_mileage: lastTires,
        last_service_mileage:     Number(vehicle.data?.last_service_mileage) || 0,
        bouncie_device_id:        vehicle.bouncie_device_id,
      }], []);
      mileageAlerts = alerts;
    } catch (err) {
      console.error("toolGetMaintenanceStatus: analyzeMileage error:", err.message);
      mileageAlertsWarning = "Could not compute mileage-based maintenance alerts.";
    }
  }

  return {
    vehicle_id:              vehicleId,
    vehicle_name:            vehicleDisplayName,
    rental_status:           vehicle.rental_status || null,
    action_status:           vehicle.action_status || null,
    mileage_tracked:         !!vehicle.bouncie_device_id,
    current_mileage:         currentMileage,
    mileage_based: {
      last_oil_change_mileage:    lastOil,
      last_brake_check_mileage:   lastBrakes,
      last_tire_change_mileage:   lastTires,
    },
    mileage_alerts:          mileageAlerts,
    mileage_alerts_warning:  mileageAlertsWarning,
    maintenance_records:     maintenanceRecords,   // from migration 0029 maintenance table
    appointments:            appointments,          // from maintenance_appointments (driver-scheduled)
    service_history:         serviceHistory,        // from maintenance_history (completed services)
  };
}



// Risk score assigned when an admin manually flags a booking
const ADMIN_FLAGGED_RISK_SCORE = 100;

async function toolFlagBooking({ bookingId, reason }) {
  if (!bookingId) throw new Error("bookingId is required");
  if (!reason)    throw new Error("reason is required");

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot flag booking");

  const { error } = await sb
    .from("bookings")
    .update({ flagged: true, risk_score: ADMIN_FLAGGED_RISK_SCORE })
    .eq("booking_ref", bookingId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  return { success: true, bookingId, flagged: true, reason };
}

async function toolUpdateBookingStatus({ bookingId, status }) {
  if (!bookingId) throw new Error("bookingId is required");
  if (!status)    throw new Error("status is required");

  const APP_TO_DB_STATUS = {
    reserved_unpaid:  "pending",
    booked_paid:      "booked_paid",
    active_rental:    "active_rental",
    completed_rental: "completed_rental",
    cancelled_rental: "cancelled_rental",
  };
  const validStatuses = Object.keys(APP_TO_DB_STATUS);
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status "${status}". Must be one of: ${validStatuses.join(", ")}`);
  }

  // ── Find the booking in bookings.json to get vehicleId ────────────────────
  const { data: bookingsData } = await loadBookings();
  let foundVehicleId = null;
  let foundBooking   = null;
  for (const [vid, list] of Object.entries(bookingsData)) {
    if (!Array.isArray(list)) continue;
    const booking = list.find((b) => b.bookingId === bookingId || b.paymentIntentId === bookingId);
    if (booking) { foundVehicleId = vid; foundBooking = booking; break; }
  }

  // Build status update fields including auto-stamps for activated/completed
  const now = new Date().toISOString();
  const statusUpdates = { status };
  if (status === "active_rental"    && !foundBooking?.activatedAt)  statusUpdates.activatedAt  = now;
  if (status === "completed_rental" && !foundBooking?.completedAt)  statusUpdates.completedAt  = now;

  // ── 1. Update bookings.json ────────────────────────────────────────────────
  let updatedInJson = false;
  if (foundVehicleId && foundBooking) {
    try {
      await updateBooking(foundVehicleId, bookingId, statusUpdates);
      updatedInJson = true;
    } catch (jsonErr) {
      console.warn("toolUpdateBookingStatus: bookings.json update failed (non-fatal):", jsonErr.message);
    }
  }

  // ── 2. Sync to Supabase ────────────────────────────────────────────────────
  const sb = getSupabaseAdmin();
  if (!sb) {
    if (!updatedInJson) throw new Error("Supabase not configured and booking not found in bookings.json");
    return { success: true, bookingId, status, updatedInJson };
  }

  if (foundBooking) {
    // Use autoUpsertBooking for a complete sync (updates deposit_paid, status, audit log)
    try {
      await autoUpsertBooking({ ...foundBooking, ...statusUpdates });
    } catch (upsertErr) {
      // Fall back to a targeted status-only update
      console.warn("toolUpdateBookingStatus: autoUpsertBooking failed, falling back:", upsertErr.message);
      const { error } = await sb
        .from("bookings")
        .update({ status: APP_TO_DB_STATUS[status] })
        .eq("booking_ref", bookingId);
      if (error) throw new Error(`Supabase update failed: ${error.message}`);
    }
  } else {
    // Booking only exists in Supabase — do a targeted update
    const { error } = await sb
      .from("bookings")
      .update({ status: APP_TO_DB_STATUS[status] })
      .eq("booking_ref", bookingId);
    if (error) throw new Error(`Supabase update failed: ${error.message}`);
  }

  return { success: true, bookingId, status, updatedInJson };
}

/**
 * Update only the pickup_time and return_time for a booking without changing
 * the dates or repricing. Used to correct an incorrect time on an active rental.
 */
async function toolUpdateBookingTimes({ bookingId, pickupTime, returnTime }) {
  if (!bookingId) throw new Error("bookingId is required");
  if (!pickupTime && !returnTime) throw new Error("At least one of pickupTime or returnTime is required");

  const fPickupTime = pickupTime ? normalizeClockTime(pickupTime) : null;
  const fReturnTime = returnTime ? normalizeClockTime(returnTime) : null;
  if (pickupTime && !fPickupTime) throw new Error(`Invalid pickupTime "${pickupTime}". Use HH:MM or H:MM AM/PM format.`);
  if (returnTime && !fReturnTime) throw new Error(`Invalid returnTime "${returnTime}". Use HH:MM or H:MM AM/PM format.`);

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Database unavailable");

  // Load current booking row from Supabase
  const { data: row, error: fetchErr } = await sb
    .from("bookings")
    .select("booking_ref, vehicle_id, pickup_time, return_time")
    .eq("booking_ref", bookingId)
    .single();
  if (fetchErr || !row) throw new Error(`Booking not found: ${bookingId}`);

  const patch = {};
  if (fPickupTime) patch.pickup_time = fPickupTime;
  if (fReturnTime) patch.return_time = fReturnTime;
  patch.updated_at = new Date().toISOString();

  const { error: updateErr } = await sb
    .from("bookings")
    .update(patch)
    .eq("booking_ref", bookingId);
  if (updateErr) throw new Error(`Supabase update failed: ${updateErr.message}`);

  // Audit log (non-fatal)
  try {
    const auditChanges = [];
    if (fPickupTime) auditChanges.push({ field: "pickup_time", oldValue: row.pickup_time || "", newValue: fPickupTime });
    if (fReturnTime) auditChanges.push({ field: "return_time", oldValue: row.return_time || "", newValue: fReturnTime });
    await writeAuditLog(bookingId, auditChanges, "admin");
  } catch (auditErr) {
    console.warn("toolUpdateBookingTimes: audit log failed (non-fatal):", auditErr.message);
  }

  // Sync to bookings.json (non-fatal)
  try {
    const { data: bookingsData } = await loadBookings();
    for (const [vid, list] of Object.entries(bookingsData)) {
      if (!Array.isArray(list)) continue;
      const booking = list.find((b) => b.bookingId === bookingId);
      if (booking) {
        await updateBooking(vid, bookingId, {
          ...(fPickupTime ? { pickupTime: fPickupTime } : {}),
          ...(fReturnTime ? { returnTime: fReturnTime } : {}),
          updatedAt: new Date().toISOString(),
        });
        break;
      }
    }
  } catch (jsonErr) {
    console.warn("toolUpdateBookingTimes: bookings.json update failed (non-fatal):", jsonErr.message);
  }

  return {
    success: true,
    bookingId,
    ...(fPickupTime ? { pickupTime: fPickupTime } : {}),
    ...(fReturnTime ? { returnTime: fReturnTime } : {}),
    message: `Booking times updated successfully.`,
  };
}

/**
 * Manually record a rental extension payment (cash, phone, or admin-logged).
 * Updates amountPaid + returnDate on the booking, creates an extension revenue
 * record, and syncs both bookings.json and Supabase.
 */
async function toolRecordExtensionPayment({
  bookingId, vehicleId, extensionAmount, newReturnDate, newReturnTime, notes,
}) {
  if (!bookingId) throw new Error("bookingId is required");
  if (typeof extensionAmount !== "number" || extensionAmount <= 0) {
    throw new Error("extensionAmount must be a positive number (in dollars)");
  }
  if (!newReturnDate || !/^\d{4}-\d{2}-\d{2}$/.test(newReturnDate)) {
    throw new Error("newReturnDate is required in YYYY-MM-DD format");
  }

  const amount = Math.round(extensionAmount * 100) / 100;

  // ── Find the booking in bookings.json ──────────────────────────────────────
  const { data: bookingsData } = await loadBookings();
  let foundVehicleId = vehicleId || null;
  let foundBooking   = null;

  if (foundVehicleId) {
    const list = Array.isArray(bookingsData[foundVehicleId]) ? bookingsData[foundVehicleId] : [];
    foundBooking = list.find((b) => b.bookingId === bookingId || b.paymentIntentId === bookingId) || null;
  }
  if (!foundBooking) {
    for (const [vid, list] of Object.entries(bookingsData)) {
      if (!Array.isArray(list)) continue;
      const b = list.find((b) => b.bookingId === bookingId || b.paymentIntentId === bookingId);
      if (b) { foundVehicleId = vid; foundBooking = b; break; }
    }
  }
  if (!foundBooking) throw new Error(`Booking "${bookingId}" not found`);

  const oldReturnDate     = foundBooking.returnDate;
  const newExtensionCount = (foundBooking.extensionCount || 0) + 1;
  const updatedReturnTime = typeof newReturnTime === "string" ? newReturnTime.trim() : (foundBooking.returnTime || "");

  // Clear late-return / end-of-rental SMS markers so automation re-fires for the new return date
  const clearedSmsSentAt = { ...(foundBooking.smsSentAt || {}) };
  delete clearedSmsSentAt.late_warning_30min;
  delete clearedSmsSentAt.late_at_return;
  delete clearedSmsSentAt.late_grace_expired;
  delete clearedSmsSentAt.late_fee_pending;
  delete clearedSmsSentAt.active_1h;
  delete clearedSmsSentAt.active_15min;

  // ── 1. Update bookings.json ────────────────────────────────────────────────
  await updateJsonFileWithRetry({
    load:  loadBookings,
    apply: (freshData) => {
      const list = freshData[foundVehicleId];
      if (!Array.isArray(list)) return;
      const idx = list.findIndex((b) => b.bookingId === bookingId || b.paymentIntentId === bookingId);
      if (idx === -1) return;
      const cur = list[idx];
      cur.amountPaid     = Math.round(((cur.amountPaid || 0) + amount) * 100) / 100;
      cur.returnDate     = newReturnDate;
      cur.returnTime     = updatedReturnTime;
      cur.extensionCount = (cur.extensionCount || 0) + 1;
      cur.smsSentAt      = clearedSmsSentAt;
      delete cur.lateFeeApplied;
      if (notes) cur.notes = (cur.notes ? cur.notes + " | " : "") + String(notes).trim().slice(0, 500);
    },
    save:    saveBookings,
    message: `Record extension payment for booking ${bookingId}: +$${amount}, return → ${newReturnDate}`,
  });

  const updatedBooking = {
    ...foundBooking,
    amountPaid:     Math.round(((foundBooking.amountPaid || 0) + amount) * 100) / 100,
    returnDate:     newReturnDate,
    returnTime:     updatedReturnTime,
    extensionCount: newExtensionCount,
    smsSentAt:      clearedSmsSentAt,
  };

  // ── 2. Supabase booking sync ───────────────────────────────────────────────
  try {
    await autoUpsertBooking(updatedBooking);
  } catch (syncErr) {
    console.warn("toolRecordExtensionPayment: Supabase sync error (non-fatal):", syncErr.message);
  }

  // ── 3. Extension revenue record ────────────────────────────────────────────
  try {
    await autoCreateRevenueRecord({
      bookingId,
      paymentIntentId: "manual_ext_" + randomBytes(6).toString("hex"),
      vehicleId:       foundVehicleId,
      name:            foundBooking.name  || "",
      phone:           foundBooking.phone || "",
      email:           foundBooking.email || "",
      pickupDate:      foundBooking.pickupDate || "",
      returnDate:      newReturnDate,
      amountPaid:      amount,
      paymentMethod:   "cash",
      type:            "extension",
    });
  } catch (revErr) {
    console.warn("toolRecordExtensionPayment: revenue record error (non-fatal):", revErr.message);
  }

  // ── 4. Update blocked dates ────────────────────────────────────────────────
  if (foundBooking.pickupDate && newReturnDate) {
    try {
      await extendBlockedDateForBooking(foundVehicleId, bookingId, newReturnDate);
    } catch (bdErr) {
      console.warn("toolRecordExtensionPayment: blocked_dates update error (non-fatal):", bdErr.message);
    }
  }

  return {
    success:          true,
    bookingId,
    vehicleId:        foundVehicleId,
    customerName:     foundBooking.name || "",
    extensionAmount:  amount,
    extensionCount:   newExtensionCount,
    oldReturnDate,
    newReturnDate,
    newReturnTime:    updatedReturnTime,
    updatedAmountPaid: updatedBooking.amountPaid,
    message: `Extension recorded: +$${amount.toFixed(2)} for ${foundBooking.name || bookingId}. Return date updated ${oldReturnDate} → ${newReturnDate}. Total paid: $${updatedBooking.amountPaid.toFixed(2)}.`,
  };
}

async function toolConfirmVehicleAction({ vehicleId, action }) {
  if (!vehicleId) throw new Error("vehicleId is required");
  if (!action)    throw new Error("action is required");

  const validActions = ["review_for_sale", "needs_attention"];
  if (!validActions.includes(action)) {
    throw new Error(`Invalid action "${action}". Must be one of: ${validActions.join(", ")}`);
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot update vehicle action");

  const { error } = await sb
    .from("vehicles")
    .update({
      decision_status: action,
      action_status:   "pending",
      updated_at:      new Date().toISOString(),
    })
    .eq("vehicle_id", vehicleId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  const labels = { review_for_sale: "Review for sale", needs_attention: "Needs attention" };
  return {
    success:         true,
    vehicleId,
    decision_status: action,
    action_status:   "pending",
    message:         `${labels[action]} decision recorded for ${vehicleId}. Action status set to pending.`,
  };
}

async function toolUpdateActionStatus({ vehicleId, action_status }) {
  if (!vehicleId)     throw new Error("vehicleId is required");
  if (!action_status) throw new Error("action_status is required");

  const validStatuses = ["pending", "in_progress", "resolved"];
  if (!validStatuses.includes(action_status)) {
    throw new Error(`Invalid action_status "${action_status}". Must be one of: ${validStatuses.join(", ")}`);
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot update action status");

  // Fetch current action_status to enforce forward-only progression
  const { data: row, error: fetchErr } = await sb
    .from("vehicles")
    .select("action_status, decision_status, last_auto_action_at, last_auto_action_reason")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();

  if (fetchErr) throw new Error(`Supabase fetch failed: ${fetchErr.message}`);
  if (!row)     throw new Error(`Vehicle "${vehicleId}" not found`);
  if (!row.decision_status) {
    throw new Error(`Vehicle "${vehicleId}" has no active decision — use confirm_vehicle_action first`);
  }

  const currentOrder = ACTION_STATUS_ORDER[row.action_status] ?? -1;
  const newOrder     = ACTION_STATUS_ORDER[action_status];
  if (newOrder < currentOrder) {
    throw new Error(
      `Cannot move action_status backwards from "${row.action_status}" to "${action_status}". Allowed progression: pending → in_progress → resolved.`
    );
  }

  const resolvedAt  = action_status === "resolved" ? new Date().toISOString() : null;
  const resolutionPatch = resolvedAt
    ? {
        last_resolved_at:        resolvedAt,
        last_resolved_reason:    row.last_auto_action_reason || null,
        // Reset dedup state so the same issue can re-alert if it reoccurs
        last_auto_action_at:     null,
        last_auto_action_reason: null,
      }
    : {};

  const { error } = await sb
    .from("vehicles")
    .update({ action_status, updated_at: new Date().toISOString(), ...resolutionPatch })
    .eq("vehicle_id", vehicleId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  // Compute time-to-resolution when closing an issue
  let time_to_resolution_ms = null;
  if (resolvedAt && row.last_auto_action_at) {
    time_to_resolution_ms = new Date(resolvedAt).getTime() - new Date(row.last_auto_action_at).getTime();
  }

  return {
    success:               true,
    vehicleId,
    action_status,
    previous:              row.action_status,
    ...(resolvedAt && {
      last_resolved_at:     resolvedAt,
      last_resolved_reason: row.last_auto_action_reason || null,
      time_to_resolution_ms,
    }),
    message: `Action status for ${vehicleId} updated: ${row.action_status || "none"} → ${action_status}.`,
  };
}


async function toolSendMessageToDriver({ bookingId, message }) {
  if (!bookingId) throw new Error("bookingId is required");
  if (!message)   throw new Error("message is required");
  if (typeof message !== "string" || message.length > 1000) {
    throw new Error("message must be a string of 1–1000 characters");
  }

  const allBookings = await loadAllBookings();
  const booking = allBookings.find((b) => b.bookingId === bookingId);
  if (!booking)   throw new Error(`Booking "${bookingId}" not found`);
  if (!booking.phone) throw new Error(`Booking "${bookingId}" has no phone number on record`);

  const result = await dispatchSms({
    bookingId,
    vehicleId: booking.vehicleId || booking.vehicle_id || null,
    phone: booking.phone,
    body: message,
    templateKey: "admin_driver_message",
    source: "admin_actions",
    dedupe: false,
    throwOnError: true,
  });
  return { sent: !!result.sent, bookingId, to: booking.phone, name: booking.name, id: result?.providerId || null };
}


async function toolMarkMaintenance({ vehicleId, serviceType, mileage }) {
  if (!vehicleId)   throw new Error("vehicleId is required");
  if (!serviceType) throw new Error("serviceType is required (oil | brakes | tires)");
  const mapping = MAINTENANCE_SERVICE_COLUMNS[serviceType];
  if (!mapping) throw new Error(`Invalid serviceType "${serviceType}". Must be one of: ${Object.keys(MAINTENANCE_SERVICE_COLUMNS).join(", ")}`);

  if (mileage !== undefined && mileage !== null) {
    const parsed = Number(mileage);
    if (isNaN(parsed) || parsed < 0) throw new Error("mileage must be a non-negative number");
    mileage = parsed;
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot record maintenance");

  // Look up the vehicle's current odometer and JSONB data
  const { data: row, error: fetchErr } = await sb
    .from("vehicles")
    .select("mileage, data")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();

  if (fetchErr) throw new Error(`Supabase fetch failed: ${fetchErr.message}`);
  if (!row)     throw new Error(`Vehicle "${vehicleId}" not found`);

  // Use provided mileage if given, otherwise fall back to current odometer
  const serviceMileage = (mileage !== undefined && mileage !== null) ? mileage : (Number(row.mileage) || 0);
  const updatedData    = { ...(row.data || {}), [mapping.jsonKey]: serviceMileage };

  const { error } = await sb
    .from("vehicles")
    .update({
      [mapping.col]: serviceMileage,
      data:          updatedData,
      updated_at:    new Date().toISOString(),
    })
    .eq("vehicle_id", vehicleId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  // Log to maintenance_history (non-fatal)
  sb.from("maintenance_history")
    .insert({ vehicle_id: vehicleId, service_type: serviceType, mileage: serviceMileage })
    .then(() => {})
    .catch((err) => console.warn(`_admin-actions: maintenance_history insert failed:`, err.message));

  const labels = { oil: "Oil change", brakes: "Brake inspection", tires: "Tire change" };

  // ── Optional: auto-resolve action_status when no maintenance remains overdue ──
  // After recording the service, recompute mileage for this vehicle and check
  // whether ALL services are now within interval. If so and action_status is
  // pending/in_progress, set it to "resolved".
  let autoResolved = false;
  try {
    const { data: freshRow } = await sb
      .from("vehicles")
      .select("mileage, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, action_status, data, last_auto_action_at, last_auto_action_reason")
      .eq("vehicle_id", vehicleId)
      .maybeSingle();

    if (freshRow) {
      const freshMiles = Number(freshRow.mileage) || 0;
      const { stats: freshStats } = analyzeMileage([{
        vehicle_id:               vehicleId,
        total_mileage:            freshMiles,
        last_oil_change_mileage:  freshRow.last_oil_change_mileage  != null ? Number(freshRow.last_oil_change_mileage)  : null,
        last_brake_check_mileage: freshRow.last_brake_check_mileage != null ? Number(freshRow.last_brake_check_mileage) : null,
        last_tire_change_mileage: freshRow.last_tire_change_mileage != null ? Number(freshRow.last_tire_change_mileage) : null,
      }], []);

      const activeActionStatus = freshRow.action_status;
      if (
        freshStats.length > 0 &&
        hasNoOverdueMaintenance(freshStats[0]) &&
        (activeActionStatus === "pending" || activeActionStatus === "in_progress")
      ) {
        const autoResolvedAt = new Date().toISOString();
        await sb
          .from("vehicles")
          .update({
            action_status:           "resolved",
            last_resolved_at:        autoResolvedAt,
            last_resolved_reason:    freshRow.last_auto_action_reason || null,
            // Reset dedup state so a reoccurrence triggers a fresh alert
            last_auto_action_at:     null,
            last_auto_action_reason: null,
            updated_at:              autoResolvedAt,
          })
          .eq("vehicle_id", vehicleId);
        autoResolved = true;
      }
    }
  } catch {
    // auto-resolve is best-effort — do not fail the maintenance record
  }

  return {
    success:         true,
    vehicleId,
    serviceType,
    service_label:   labels[serviceType],
    service_mileage: serviceMileage,
    auto_resolved:   autoResolved,
    message:         `${labels[serviceType]} recorded at ${serviceMileage.toLocaleString()} mi for ${vehicleId}.`
      + (autoResolved ? " Action status auto-resolved (no remaining overdue services)." : ""),
  };
}

// ── New tool implementations ───────────────────────────────────────────────────

const LEGACY_EXPENSE_CATEGORIES = Object.keys(LEGACY_CATEGORY_MAP);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

async function toolAddExpense({ vehicle_id, date, category_id, category, amount, notes }) {
  if (!vehicle_id || typeof vehicle_id !== "string") throw new Error("vehicle_id is required");
  if (!date || !ISO_DATE_PATTERN.test(String(date))) throw new Error("date must be in YYYY-MM-DD format");

  const sb = getSupabaseAdmin();
  let resolvedCategoryId   = null;
  let resolvedCategoryText = null;

  if (category_id && typeof category_id === "string") {
    // New path: validate UUID in expense_categories
    if (sb) {
      const { data: catRow, error: catErr } = await sb
        .from("expense_categories").select("id, name, group_name")
        .eq("id", category_id).maybeSingle();
      if (catErr || !catRow) throw new Error("Invalid category_id");
      resolvedCategoryId   = catRow.id;
      resolvedCategoryText = catRow.name;
    } else {
      resolvedCategoryId   = category_id;
      resolvedCategoryText = category || "other";
    }
  } else if (category && typeof category === "string") {
    // Legacy path
    if (!LEGACY_EXPENSE_CATEGORIES.includes(category)) {
      throw new Error(`category must be one of: ${LEGACY_EXPENSE_CATEGORIES.join(", ")}`);
    }
    resolvedCategoryText = category;
    if (sb) {
      const allCats = await loadCategories(sb);
      const { name: tName, group_name: tGroup } = LEGACY_CATEGORY_MAP[category];
      const match = allCats.find((c) => c.name === tName && c.group_name === tGroup);
      if (match) resolvedCategoryId = match.id;
    }
  } else {
    throw new Error("category_id or category is required");
  }

  const parsedAmount = Number(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) throw new Error("amount must be a positive number");

  const expense = {
    expense_id:  randomBytes(8).toString("hex"),
    vehicle_id:  String(vehicle_id).trim(),
    date:        String(date),
    category:    resolvedCategoryText || "",
    amount:      Math.round(parsedAmount * 100) / 100,
    notes:       typeof notes === "string" ? notes.trim().slice(0, 500) : "",
    created_at:  new Date().toISOString(),
  };
  // Only include category_id when it was actually resolved
  if (resolvedCategoryId !== null) expense.category_id = resolvedCategoryId;

  let useGitHub = !sb;
  if (sb) {
    const { error: sbErr } = await sb.from("expenses").insert(expense);
    if (sbErr) {
      console.warn("toolAddExpense: Supabase insert failed, falling back to GitHub:", sbErr.message);
      useGitHub = true;
    }
  }
  if (useGitHub) {
    if (!process.env.GITHUB_TOKEN) throw new Error("Neither Supabase nor GITHUB_TOKEN is configured.");
    await updateJsonFileWithRetry({
      load:    loadExpenses,
      apply:   (data) => { if (!data.some((e) => e.expense_id === expense.expense_id)) data.push(expense); },
      save:    saveExpenses,
      message: `Add expense for ${vehicle_id}: ${resolvedCategoryText || category_id} $${expense.amount} on ${date}`,
    });
  }
  return { success: true, expense };
}

async function toolDeleteExpense({ expense_id }) {
  if (!expense_id || typeof expense_id !== "string") throw new Error("expense_id is required");

  const sb = getSupabaseAdmin();
  let useGitHub = !sb;
  if (sb) {
    const { data: existing, error: fetchErr } = await sb
      .from("expenses").select("expense_id").eq("expense_id", expense_id).maybeSingle();
    if (fetchErr && isSchemaError(fetchErr)) {
      useGitHub = true;
    } else if (fetchErr) {
      throw new Error(fetchErr.message);
    } else if (!existing) {
      throw new Error(`Expense "${expense_id}" not found`);
    } else {
      const { error: delErr } = await sb.from("expenses").delete().eq("expense_id", expense_id);
      if (delErr && isSchemaError(delErr)) {
        useGitHub = true;
      } else if (delErr) {
        throw new Error(delErr.message);
      }
    }
  }
  if (useGitHub) {
    if (!process.env.GITHUB_TOKEN) throw new Error("Neither Supabase nor GITHUB_TOKEN is configured.");
    const { data: checkData } = await loadExpenses();
    if (!checkData.some((e) => e.expense_id === expense_id)) {
      throw new Error(`Expense "${expense_id}" not found`);
    }
    await updateJsonFileWithRetry({
      load:    loadExpenses,
      apply:   (data) => { const after = data.filter((e) => e.expense_id !== expense_id); data.splice(0, data.length, ...after); },
      save:    saveExpenses,
      message: `Delete expense ${expense_id}`,
    });
  }
  return { success: true, deleted: expense_id };
}

async function toolGetExpenseCategories() {
  const sb = getSupabaseAdmin();
  const categories = await loadCategories(sb);
  return { categories };
}

async function toolManageExpenseCategory({ action, id, name, group_name, is_active }) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase is required to manage categories.");

  if (action === "create") {
    const trimName  = typeof name       === "string" ? name.trim().slice(0, 80)  : "";
    const trimGroup = typeof group_name === "string" ? group_name.trim().slice(0, 60) : "";
    if (!trimName)  throw new Error("name is required");
    if (!trimGroup) throw new Error("group_name is required");

    const { data, error } = await sb.from("expense_categories")
      .insert({ name: trimName, group_name: trimGroup, is_default: false, is_active: true })
      .select().single();
    if (error) {
      if (error.code === "23505") throw new Error(`Category "${trimName}" already exists in group "${trimGroup}".`);
      throw new Error(error.message);
    }
    return { success: true, category: data, categories: await loadCategories(sb) };
  }

  if (action === "update") {
    if (!id)   throw new Error("id is required");
    const trimName = typeof name === "string" ? name.trim().slice(0, 80) : "";
    if (!trimName) throw new Error("name is required");
    const { data, error } = await sb.from("expense_categories")
      .update({ name: trimName }).eq("id", id).select().single();
    if (error) {
      if (error.code === "23505") throw new Error(`A category named "${trimName}" already exists in this group.`);
      throw new Error(error.message);
    }
    return { success: true, category: data, categories: await loadCategories(sb) };
  }

  if (action === "toggle") {
    if (!id)                          throw new Error("id is required");
    if (typeof is_active !== "boolean") throw new Error("is_active (boolean) is required");
    const { data, error } = await sb.from("expense_categories")
      .update({ is_active }).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return { success: true, category: data, categories: await loadCategories(sb) };
  }

  throw new Error(`Unknown action: ${action}`);
}

async function toolBlockDates({ vehicleId, from, to }) {
  if (!vehicleId) throw new Error("vehicleId is required");
  if (!from || !ISO_DATE_PATTERN.test(from)) throw new Error("from must be in YYYY-MM-DD format");
  if (!to   || !ISO_DATE_PATTERN.test(to))   throw new Error("to must be in YYYY-MM-DD format");
  if (from > to) throw new Error("from must not be after to");
  // Phase 4: GITHUB_TOKEN no longer required — booked-dates.json writes are disabled.

  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  let added = 0;
  try {
    await autoCreateBlockedDate(vehicleId, from, to, "manual");
    added = 1;
  } catch (sbErr) { console.warn("toolBlockDates: Supabase sync failed (non-fatal):", sbErr.message); }

  return {
    success:  true,
    vehicleId, from, to, added,
    message: added > 0
      ? `✅ ${from} → ${to} is now blocked for ${vehicleId}.`
      : `ℹ️ Date range ${from} → ${to} was already blocked for ${vehicleId} (no change).`,
  };
}

async function toolOpenDates({ vehicleId, from, to }) {
  if (!vehicleId) throw new Error("vehicleId is required");
  if (!from || !ISO_DATE_PATTERN.test(from)) throw new Error("from must be in YYYY-MM-DD format");
  if (!to   || !ISO_DATE_PATTERN.test(to))   throw new Error("to must be in YYYY-MM-DD format");
  if (from > to) throw new Error("from must not be after to");
  // Phase 4: GITHUB_TOKEN no longer required — booked-dates.json writes are disabled.

  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  let removed = 0;
  try {
    const sb = getSupabaseAdmin();
    if (sb) {
      await sb
        .from("blocked_dates")
        .delete()
        .eq("vehicle_id", vehicleId)
        .lte("start_date", to)
        .gte("end_date", from);
      removed = 1;
    }
  } catch (sbErr) { console.warn("toolOpenDates: Supabase sync failed (non-fatal):", sbErr.message); }

  return {
    success:  true,
    vehicleId, from, to, removed,
    message: removed > 0
      ? `✅ ${from} → ${to} is now unblocked for ${vehicleId}.`
      : `ℹ️ Date range ${from} → ${to} was not blocked for ${vehicleId} (no change).`,
  };
}

// ── Site content tools ────────────────────────────────────────────────────────

const SITE_CONTENT_ALLOWED_KEYS = new Set([
  "business_name", "logo_url", "phone", "whatsapp", "email",
  "instagram_url", "facebook_url", "tiktok_url", "twitter_url",
  "promo_banner_enabled", "promo_banner_text",
  "hero_title", "hero_subtitle", "about_text",
  "policies_cancellation", "policies_damage", "policies_fuel",
  "policies_age", "service_area_notes", "pickup_instructions",
]);

async function toolGetSiteContent() {
  const sb = getSupabaseAdmin();
  if (!sb) {
    return {
      source: "default",
      message: "Supabase not configured — returning default settings.",
      settings: {
        business_name: "Sly Car Rentals",
        logo_url: "",
        phone: "",
        email: "",
        hero_title: "Explore LA in Style",
        hero_subtitle: "Affordable car rentals in Los Angeles",
        about_text: "",
      },
    };
  }
  const { data, error } = await sb.from("site_settings").select("key, value").order("key");
  if (error) throw new Error(`Supabase error: ${error.message}`);
  const settings = {};
  for (const row of (data || [])) {
    if (SITE_CONTENT_ALLOWED_KEYS.has(row.key)) settings[row.key] = row.value;
  }
  return { source: "supabase", settings };
}

async function toolUpdateSiteContent({ settings }) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("settings must be a non-null object of key-value pairs.");
  }

  // Filter to allowed keys only
  const safe = {};
  for (const [k, v] of Object.entries(settings)) {
    if (SITE_CONTENT_ALLOWED_KEYS.has(k)) safe[k] = v;
  }
  if (Object.keys(safe).length === 0) {
    throw new Error(
      `No valid setting keys provided. Allowed: ${[...SITE_CONTENT_ALLOWED_KEYS].join(", ")}`
    );
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot save site content.");

  const now = new Date().toISOString();
  const rows = Object.entries(safe).map(([key, value]) => ({
    key,
    value: value === null || value === undefined ? "" : String(value),
    updated_at: now,
  }));

  const { error } = await sb
    .from("site_settings")
    .upsert(rows, { onConflict: "key" });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);

  return {
    success: true,
    updated: Object.keys(safe),
    message: `Updated ${Object.keys(safe).length} site setting(s): ${Object.keys(safe).join(", ")}. Changes are live on the public website.`,
  };
}

async function toolUpdateSystemSetting({ key, value, description, category }) {
  if (!key || value === undefined || value === null) throw new Error("key and value are required");
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot save system settings.");

  const record = {
    key:        String(key).trim(),
    value,
    updated_at: new Date().toISOString(),
    updated_by: "admin-ai",
  };
  if (description !== undefined) record.description = description;
  if (category    !== undefined) record.category    = category;

  // Try UPDATE first; if no rows affected, INSERT the new row
  const { data: updatedData, error: updateErr } = await sb
    .from("system_settings").update(record).eq("key", record.key).select();
  if (updateErr) throw new Error(`Supabase update failed: ${updateErr.message}`);

  let finalData;
  if (updatedData && updatedData.length > 0) {
    finalData = updatedData[0];
  } else {
    const { data: insertedData, error: insertErr } = await sb
      .from("system_settings").insert(record).select().single();
    if (insertErr) throw new Error(`Supabase insert failed: ${insertErr.message}`);
    finalData = insertedData;
  }

  return { success: true, setting: finalData };
}

async function toolUpdateSmsTemplate({ templateKey, message, enabled }) {
  if (!templateKey) throw new Error("templateKey is required");
  if (message === undefined && enabled === undefined) {
    throw new Error("At least one of message or enabled must be provided");
  }
  // Validate templateKey against the known TEMPLATES map
  if (!Object.prototype.hasOwnProperty.call(TEMPLATES, templateKey)) {
    throw new Error(`Unknown template key "${templateKey}". Use get_sms_templates to see valid keys.`);
  }

  const sb = getSupabaseAdmin();
  const record = { template_key: templateKey, updated_at: new Date().toISOString() };
  if (message !== undefined) record.message = String(message).slice(0, 1000);
  if (enabled !== undefined) record.enabled = !!enabled;

  if (sb) {
    const { data, error } = await sb
      .from("sms_template_overrides")
      .upsert(record, { onConflict: "template_key" })
      .select("template_key, message, enabled")
      .single();
    if (error && !isSchemaError(error)) throw new Error(`Supabase upsert failed: ${error.message}`);
    if (!error && data) return { success: true, template: data };
  }

  // GitHub fallback
  if (!process.env.GITHUB_TOKEN) throw new Error("Neither Supabase nor GITHUB_TOKEN is configured.");
  const TEMPLATES_DB_PATH = "sms-templates.json";
  const GITHUB_TEMPLATES_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
  const apiUrl = `https://api.github.com/repos/${GITHUB_TEMPLATES_REPO}/contents/${TEMPLATES_DB_PATH}`;
  const ghHdrs = {
    Authorization:          `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  async function loadTpl() {
    const resp = await fetch(apiUrl, { headers: ghHdrs });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      throw new Error(`GitHub GET sms-templates.json failed: ${resp.status}`);
    }
    const file = await resp.json();
    let data = {};
    try { data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8")); if (typeof data !== "object" || Array.isArray(data)) data = {}; } catch { data = {}; }
    return { data, sha: file.sha };
  }
  async function saveTpl(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content, branch: GITHUB_DATA_BRANCH };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, { method: "PUT", headers: { ...ghHdrs, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`GitHub PUT sms-templates.json failed: ${resp.status}`);
  }
  await updateJsonFileWithRetry({
    load:    loadTpl,
    apply:   (data) => {
      if (!data[templateKey]) data[templateKey] = {};
      if (message !== undefined) data[templateKey].message = String(message).slice(0, 1000);
      if (enabled !== undefined) data[templateKey].enabled = !!enabled;
    },
    save:    saveTpl,
    message: `Update SMS template ${templateKey}`,
  });
  return { success: true, template: { template_key: templateKey, ...record } };
}

async function toolUpdateCustomer({ id, updates }) {
  if (!id) throw new Error("id is required");
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    throw new Error("updates object is required");
  }
  const allowed = ["flagged", "banned", "flag_reason", "ban_reason", "notes", "name", "phone", "email", "risk_flag"];
  const sanitized = { updated_at: new Date().toISOString() };
  for (const f of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, f)) sanitized[f] = updates[f];
  }
  if (sanitized.risk_flag !== undefined && sanitized.risk_flag !== null &&
      !["low", "medium", "high"].includes(sanitized.risk_flag)) {
    throw new Error("risk_flag must be low, medium, or high");
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb.from("customers").update(sanitized).eq("id", id).select().single();
    if (!error) return { success: true, customer: data };
    if (!isSchemaError(error)) throw new Error(`Supabase update failed: ${error.message}`);
  }

  throw new Error("Customer updates require Supabase — database not configured.");
}

async function toolRecountCustomerCounts() {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase is not configured — recount requires database access.");

  const CANCELLED_STATUSES = ["cancelled", "cancelled_rental"];
  const updatedCustomers = [];
  const errors = [];

  // Step 1: backfill bookings.customer_id for rows linked only by email
  const { data: unlinkedBookings, error: unlinkedErr } = await sb
    .from("bookings")
    .select("id, customer_email, customer_id")
    .is("customer_id", null)
    .not("customer_email", "is", null);

  if (unlinkedErr) {
    errors.push(`backfill-fetch: ${unlinkedErr.message}`);
  } else if (Array.isArray(unlinkedBookings) && unlinkedBookings.length > 0) {
    const emails = [...new Set(unlinkedBookings.filter((b) => b.customer_email).map((b) => b.customer_email.trim().toLowerCase()))];
    const { data: custByEmail, error: custEmailErr } = await sb
      .from("customers")
      .select("id, email")
      .in("email", emails);

    if (custEmailErr) {
      errors.push(`backfill-lookup: ${custEmailErr.message}`);
    } else if (Array.isArray(custByEmail) && custByEmail.length > 0) {
      const emailToId = new Map(custByEmail.map((c) => [c.email.toLowerCase(), c.id]));
      let backfilled = 0;
      for (const bk of unlinkedBookings) {
        if (!bk.customer_email) continue;
        const custId = emailToId.get(bk.customer_email.trim().toLowerCase());
        if (!custId) continue;
        const { error: patchErr } = await sb
          .from("bookings")
          .update({ customer_id: custId, updated_at: new Date().toISOString() })
          .eq("id", bk.id);
        if (patchErr) {
          errors.push(`backfill-patch(${bk.id}): ${patchErr.message}`);
        } else {
          backfilled++;
        }
      }
      console.log(`recount_customer_counts: backfilled customer_id on ${backfilled} booking(s)`);
    }
  }

  // Step 2: fetch all customers
  const { data: customers, error: custErr } = await sb
    .from("customers")
    .select("id, phone, email, name, total_bookings");
  if (custErr) throw new Error(`Could not fetch customers: ${custErr.message}`);
  if (!Array.isArray(customers) || customers.length === 0) {
    return { updated: 0, message: "No customers found — run sync first." };
  }

  // Step 3: count non-cancelled bookings per customer from the bookings table
  const { data: bookingCounts, error: countErr } = await sb
    .from("bookings")
    .select("customer_id")
    .not("customer_id", "is", null)
    .not("status", "in", `(${CANCELLED_STATUSES.join(",")})`);
  if (countErr) throw new Error(`Could not count bookings: ${countErr.message}`);

  const countByCustomerId = {};
  for (const row of (bookingCounts || [])) {
    const cid = row.customer_id;
    countByCustomerId[cid] = (countByCustomerId[cid] || 0) + 1;
  }

  // Step 4: update each customer whose total_bookings is stale
  for (const cust of customers) {
    const accurate = countByCustomerId[cust.id] || 0;
    if (accurate === (cust.total_bookings || 0)) continue;

    const { error: upErr } = await sb
      .from("customers")
      .update({ total_bookings: accurate, updated_at: new Date().toISOString() })
      .eq("id", cust.id);

    if (upErr) {
      errors.push(`update(${cust.id}): ${upErr.message}`);
    } else {
      updatedCustomers.push({ id: cust.id, name: cust.name, old: cust.total_bookings, new: accurate });
      console.log(`recount_customer_counts: ${cust.name} ${cust.total_bookings ?? "null"} → ${accurate}`);
    }
  }

  return {
    updated:  updatedCustomers.length,
    changes:  updatedCustomers,
    errors:   errors.length > 0 ? errors : undefined,
    message:  updatedCustomers.length === 0
      ? "All booking counts are already accurate."
      : `Updated ${updatedCustomers.length} customer(s) with corrected booking counts.`,
  };
}


async function toolDeleteVehicle({ vehicleId }) {
  if (!vehicleId) throw new Error("vehicleId is required");

  const vehicles = await loadAllVehicles();
  if (!vehicles[vehicleId]) throw new Error(`Vehicle "${vehicleId}" not found`);
  const vehicleName = vehicles[vehicleId]?.vehicle_name || vehicleId;

  const sb = getSupabaseAdmin();
  if (sb) {
    const { error } = await sb.from("vehicles").delete().eq("vehicle_id", vehicleId);
    if (error && !isSchemaError(error)) throw new Error(`Supabase delete failed: ${error.message}`);
  }

  const { data: jsonVehicles } = await loadVehicles();
  if (jsonVehicles[vehicleId]) {
    delete jsonVehicles[vehicleId];
    await saveVehicles(jsonVehicles);
  }

  return { success: true, deleted: vehicleId, name: vehicleName };
}

async function toolDeleteBooking({ booking_id }) {
  if (!booking_id || typeof booking_id !== "string") throw new Error("booking_id is required");

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase is required to delete a booking.");

  // Fetch booking to verify it exists and check its status
  const { data: booking, error: fetchErr } = await sb
    .from("bookings")
    .select("id, booking_ref, status, customers(name)")
    .eq("booking_ref", booking_id)
    .maybeSingle();

  if (fetchErr) throw new Error(`Failed to fetch booking: ${fetchErr.message}`);
  if (!booking) throw new Error(`Booking "${booking_id}" not found`);

  const DELETABLE_STATUSES = ["cancelled", "cancelled_rental", "pending"];
  if (!DELETABLE_STATUSES.includes(booking.status)) {
    throw new Error(
      `Cannot permanently delete booking "${booking_id}" — it has status "${booking.status}". ` +
        `Only cancelled or pending bookings may be deleted. ` +
        `Update the booking status to cancelled first if needed.`
    );
  }

  const customerName = booking.customers?.name || booking_id;

  // Delete all related records that do not cascade automatically
  const tablesToClean = [
    { table: "revenue_records",        column: "booking_id" },
    { table: "booking_status_history", column: "booking_id" },
    { table: "payment_transactions",   column: "booking_id" },
    { table: "charges",                column: "booking_id" },
    { table: "sms_logs",               column: "booking_id" },
    { table: "pending_booking_docs",   column: "booking_id" },
  ];

  for (const { table, column } of tablesToClean) {
    const { error: delErr } = await sb.from(table).delete().eq(column, booking_id);
    if (delErr && !isSchemaError(delErr)) {
      throw new Error(`Failed to delete related ${table} records: ${delErr.message}`);
    }
  }

  // Delete the booking itself; booking_extensions and payments cascade via DB FK
  const { error: bookingDelErr } = await sb.from("bookings").delete().eq("booking_ref", booking_id);
  if (bookingDelErr) throw new Error(`Failed to delete booking: ${bookingDelErr.message}`);

  // Also remove from bookings.json if present
  try {
    const { data: bookingsData } = await loadBookings();
    let changed = false;
    for (const [vid, list] of Object.entries(bookingsData)) {
      if (!Array.isArray(list)) continue;
      const idx = list.findIndex((b) => b.bookingId === booking_id || b.paymentIntentId === booking_id);
      if (idx !== -1) { list.splice(idx, 1); changed = true; break; }
    }
    if (changed) {
      await updateJsonFileWithRetry({
        load:    loadBookings,
        apply:   (data) => {
          for (const [vid, list] of Object.entries(data)) {
            if (!Array.isArray(list)) continue;
            const idx = list.findIndex((b) => b.bookingId === booking_id || b.paymentIntentId === booking_id);
            if (idx !== -1) { list.splice(idx, 1); break; }
          }
        },
        save:    saveBookings,
        message: `Delete booking ${booking_id}`,
      });
    }
  } catch (jsonErr) {
    console.warn("toolDeleteBooking: bookings.json cleanup failed (non-fatal):", jsonErr.message);
  }

  return {
    success: true,
    deleted: booking_id,
    customer: customerName,
    message: `Booking "${booking_id}" for ${customerName} has been permanently deleted along with all associated revenue, charge, and SMS records.`,
  };
}

async function toolChargeCustomerFee({ booking_id, charge_type, amount, notes }) {
  // Validate before calling executeChargeFee so AI sees clean error messages
  if (!booking_id) throw new Error("booking_id is required");
  const validTypes = Object.keys(CHARGE_TYPE_LABELS);
  if (!charge_type || !validTypes.includes(charge_type)) {
    throw new Error(`charge_type must be one of: ${validTypes.join(", ")}`);
  }
  const resolvedAmount =
    amount !== undefined && amount !== null
      ? Number(amount)
      : PREDEFINED_FEES[charge_type] ?? null;
  if (resolvedAmount === null) {
    throw new Error(`amount is required for charge_type "${charge_type}"`);
  }
  if (isNaN(resolvedAmount) || resolvedAmount <= 0) {
    throw new Error("amount must be a positive number");
  }

  return await executeChargeFee({
    bookingId:  booking_id,
    chargeType: charge_type,
    amount:     resolvedAmount,
    notes:      notes || "",
    chargedBy:  "ai",
  });
}

async function toolGetCharges({ booking_id, limit = 50 } = {}) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase is not configured");

  const cap = Math.min(Number(limit) || 50, 200);
  let query = sb
    .from("charges")
    .select("id, booking_id, charge_type, amount, notes, stripe_payment_intent_id, status, charged_by, error_message, created_at")
    .order("created_at", { ascending: false })
    .limit(cap);

  if (booking_id) query = query.eq("booking_id", booking_id);

  const { data, error } = await query;
  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  const rows = data || [];
  const total = rows.filter((r) => r.status === "succeeded").reduce((s, r) => s + Number(r.amount || 0), 0);
  return {
    charges:         rows,
    total_charged:   Math.round(total * 100) / 100,
    count:           rows.length,
  };
}

async function toolBackfillStripeCards({ action = "preview", confirmed } = {}) {
  // Preview is always safe (read-only). Backfill requires explicit confirmation.
  if (action === "backfill" && !confirmed) {
    return {
      requires_confirmation: true,
      action,
      message: "Running the backfill will write stripe_customer_id, stripe_payment_method_id, extension_stripe_customer_id, and extension_stripe_payment_method_id to all affected bookings. Confirm to proceed (retry with confirmed:true).",
    };
  }
  return await executeBackfillStripeCards(action);
}

async function toolDeferLateFee({ booking_id, amount, confirmed }) {
  if (!booking_id) throw new Error("booking_id is required");
  const resolvedAmount = Number(amount);
  if (isNaN(resolvedAmount) || resolvedAmount <= 0) {
    throw new Error("amount must be a positive number in USD");
  }

  if (!confirmed) {
    return {
      requires_confirmation: true,
      booking_id,
      amount: resolvedAmount,
      message: `This will flag a $${resolvedAmount.toFixed(2)} late fee as pending_collection on booking "${booking_id}". The fee will be added to the renter's next extension payment. Confirm to proceed (retry with confirmed:true).`,
    };
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase is not configured");

  // Verify the booking exists
  const { data: booking, error: bkErr } = await sb
    .from("bookings")
    .select("booking_ref, late_fee_status, late_fee_amount, customers(name)")
    .eq("booking_ref", booking_id)
    .maybeSingle();
  if (bkErr) throw new Error(`Booking lookup failed: ${bkErr.message}`);
  if (!booking) throw new Error(`Booking "${booking_id}" not found`);

  // Guard: don't overwrite a fee that has already been fully resolved.
  // 'dismissed' means the admin explicitly chose not to collect — block it too.
  const blockedStatuses = ["paid", "approved", "dismissed"];
  if (blockedStatuses.includes(booking.late_fee_status)) {
    throw new Error(
      `Cannot defer late fee for booking "${booking_id}" — current status is "${booking.late_fee_status}". ` +
      "The fee has already been approved, dismissed, or paid. Use charge_customer_fee or check with the admin first."
    );
  }

  const { error: updateErr } = await sb
    .from("bookings")
    .update({
      late_fee_status:      "pending_collection",
      late_fee_amount:      resolvedAmount,
      late_fee_approved_by: "ai",
      late_fee_approved_at: new Date().toISOString(),
    })
    .eq("booking_ref", booking_id);

  if (updateErr) throw new Error(`Failed to update booking: ${updateErr.message}`);

  const renterName = booking.customers?.name || booking_id;
  return {
    success: true,
    booking_id,
    late_fee_status: "pending_collection",
    late_fee_amount: resolvedAmount,
    message:
      `Late fee of $${resolvedAmount.toFixed(2)} flagged as pending_collection for ${renterName} (${booking_id}). ` +
      "It will be automatically added to their next rental extension payment.",
  };
}

async function toolRunSystemHealthFix({ target = "all", confirmed } = {}) {
  const normalizedTarget = String(target || "all").trim();
  const validTargets = new Set(["smsDeliveryHealth", "availabilitySyncHealth", "all"]);
  if (!validTargets.has(normalizedTarget)) {
    throw new Error('target must be one of: "smsDeliveryHealth", "availabilitySyncHealth", or "all"');
  }

  if (!confirmed) {
    return {
      requires_confirmation: true,
      target: normalizedTarget,
      message:
        `This will run backend system-health repair action(s) for "${normalizedTarget}". ` +
        "It can write database repairs and may send missed SMS reminders. " +
        "Confirm to proceed (retry with confirmed:true).",
    };
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase is not configured");

  const runSmsFix = async () => {
    if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) {
      return {
        check: "smsDeliveryHealth",
        ok: true,
        skipped: true,
        processed: 0,
        sent: 0,
        message: "TextMagic not configured — no SMS sent.",
      };
    }

    const allBookings = await loadBookingsFromSupabase(sb);
    if (allBookings === null) {
      throw new Error("Database query error while loading bookings for SMS repair.");
    }

    const processed = Object.values(allBookings)
      .flat()
      .filter((b) => b.status === "active_rental" || b.status === "active" || b.status === "overdue")
      .length;

    const sentMarks = [];
    await processActiveRentals(allBookings, new Date(), sentMarks, false, { repairMode: true });
    const sent = sentMarks.filter((m) => !m.key.startsWith("_")).length;
    const skippedMarkers = sentMarks.filter((m) => m.key.startsWith("_")).length;
    // processActiveRentals can emit internal markers that are not strictly
    // one-per-booking; keep skipped at least as high as processed-sent so the
    // summary never under-reports evaluated bookings.
    const skipped = Math.max(skippedMarkers, processed - sent);

    return {
      check: "smsDeliveryHealth",
      ok: true,
      processed,
      sent,
      skipped,
      message:
        sent > 0
          ? `Sent ${sent} missing SMS across ${processed} active rental${processed !== 1 ? "s" : ""}.`
          : `No missing SMS found across ${processed} active rental${processed !== 1 ? "s" : ""}.`,
    };
  };

  const runAvailabilityFix = async () => {
    const result = await runAvailabilitySyncFix(sb);
    return {
      check: "availabilitySyncHealth",
      ok: true,
      ...result,
    };
  };

  if (normalizedTarget === "smsDeliveryHealth") {
    return await runSmsFix();
  }
  if (normalizedTarget === "availabilitySyncHealth") {
    return await runAvailabilityFix();
  }

  const [sms, availability] = await Promise.all([
    runSmsFix(),
    runAvailabilityFix(),
  ]);

  return {
    ok: true,
    target: "all",
    results: {
      smsDeliveryHealth: sms,
      availabilitySyncHealth: availability,
    },
    message: "System-health repairs completed for SMS delivery and availability sync.",
  };
}

// ── Destructive-action guard ──────────────────────────────────────────────────
// Tools that mutate data require the "confirmed" flag in their args.

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Vehicles supported by manual booking ─────────────────────────────────────
const MANUAL_BOOKING_VEHICLES = {
  camry:      "Camry 2012",
  camry2013:  "Camry 2013 SE",
};

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
const FLEET_STATUS_PATH  = "fleet-status.json";
const BUSINESS_TZ        = "America/Los_Angeles";

/**
 * Block a date range in booked-dates.json for the given vehicle.
 * Used by toolCreateManualBooking to mark calendar dates unavailable.
 */
async function blockBookedDatesForManualBooking(_vehicleId, _from, _to) {
  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  console.log("_admin-actions: blockBookedDatesForManualBooking() called but writes are disabled (Phase 4)");
}

function normalizeCurrency(value) {
  return typeof value === "number" && value > 0 ? Math.round(value * 100) / 100 : 0;
}

const STRIPE_AMOUNT_TOLERANCE = 0.01;

function normalizeOptionalAmount(value) {
  if (!Number.isFinite(Number(value))) return null;
  const n = Math.round(Number(value) * 100) / 100;
  return n >= 0 ? n : null;
}

function getLANowParts() {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date()).map((part) => [part.type, part.value])
  );
}

/**
 * Returns today's date as YYYY-MM-DD in America/Los_Angeles.
 * @returns {string}
 */
function todayIsoInLA() {
  const map = getLANowParts();
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Returns true when pickup date/time has already arrived in Los Angeles time.
 * @param {string} pickupDate - YYYY-MM-DD
 * @param {string} pickupTime - 12h/24h time string
 * @returns {boolean}
 */
function isPickupArrivedInLA(pickupDate, pickupTime) {
  if (!pickupDate) return false;
  const today = todayIsoInLA();
  if (pickupDate < today) return true;
  if (pickupDate > today) return false;

  const parsedPickupTime = parseTime12h(pickupTime || "");
  if (!parsedPickupTime) return false;

  const nowMap = getLANowParts();
  const nowTime = `${nowMap.hour}:${nowMap.minute}:${nowMap.second}`;
  return parsedPickupTime <= nowTime;
}

/**
 * Maps pickup timing to fleet rental_status for public availability badges.
 * @param {string} pickupDate - YYYY-MM-DD
 * @param {string} pickupTime - pickup time string
 * @returns {"reserved"|"rented"}
 */
function inferVehicleRentalStatusForManualBooking(pickupDate, pickupTime) {
  return isPickupArrivedInLA(pickupDate, pickupTime) ? "rented" : "reserved";
}

/**
 * Sync manual-booking vehicle availability status (Supabase first, GitHub fallback).
 * @param {string} vehicleId
 * @param {"reserved"|"rented"} rentalStatus
 * @returns {Promise<{synced:boolean,target:string,rental_status:string,warning?:string}>}
 */
async function syncVehicleStatusForManualBooking(vehicleId, rentalStatus) {
  const sb = getSupabaseAdmin();
  const normalizedVehicle = normalizeVehicleId(vehicleId) || vehicleId;
  const fleetStatusVehicleId = vehicleId;
  if (sb) {
    const { error } = await sb
      .from("vehicles")
      .update({ rental_status: rentalStatus, updated_at: new Date().toISOString() })
      .eq("vehicle_id", normalizedVehicle);
    if (!error) {
      return { synced: true, target: "supabase", rental_status: rentalStatus };
    }
    console.warn("toolCreateManualBooking: Supabase vehicle status update failed, falling back to GitHub:", error.message);
  }

  if (!process.env.GITHUB_TOKEN) {
    return {
      synced: false,
      target: "none",
      rental_status: rentalStatus,
      warning: "Vehicle status not persisted (no Supabase and no GITHUB_TOKEN).",
    };
  }

  const token = process.env.GITHUB_TOKEN;
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const ghHeaders = {
    Authorization:          `Bearer ${token}`,
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function loadFleetStatus() {
    const resp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers: ghHeaders });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub GET fleet-status.json failed: ${resp.status} ${text}`);
    }
    const file = await resp.json();
    let data = {};
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
      if (typeof data !== "object" || Array.isArray(data)) data = {};
    } catch { data = {}; }
    return { data, sha: file.sha };
  }

  async function saveFleetStatus(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content, branch: GITHUB_DATA_BRANCH };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method:  "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT fleet-status.json failed: ${resp.status} ${text}`);
    }
  }

  await updateJsonFileWithRetry({
    load:    loadFleetStatus,
    apply:   (data) => {
      if (!data[fleetStatusVehicleId]) data[fleetStatusVehicleId] = {};
      data[fleetStatusVehicleId].available = false;
      data[fleetStatusVehicleId].rental_status = rentalStatus;
    },
    save:    saveFleetStatus,
    message: `Mark ${fleetStatusVehicleId} unavailable (${rentalStatus}) after manual booking via admin AI`,
  });

  return { synced: true, target: "github", rental_status: rentalStatus };
}

/**
 * Create a manual booking for a cash or offline reservation.
 * Blocks the calendar dates, saves to bookings.json, and syncs to Supabase.
 */
async function toolCreateManualBooking({
  vehicleId, name, phone, email,
  pickupDate, pickupTime, returnDate, returnTime,
  amountPaid, totalPrice, paymentIntentId: suppliedPaymentIntentId, notes,
  stripeFee, stripeNet, sendConfirmationEmail,
}) {
  if (!vehicleId || !MANUAL_BOOKING_VEHICLES[vehicleId]) {
    throw new Error(`Invalid vehicleId "${vehicleId}". Must be one of: ${Object.keys(MANUAL_BOOKING_VEHICLES).join(", ")}.`);
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new Error("Customer name is required.");
  }
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!pickupDate || !ISO_DATE.test(pickupDate)) {
    throw new Error("pickupDate must be in YYYY-MM-DD format.");
  }
  if (!returnDate || !ISO_DATE.test(returnDate)) {
    throw new Error("returnDate must be in YYYY-MM-DD format.");
  }
  if (pickupDate > returnDate) {
    throw new Error("pickupDate must not be after returnDate.");
  }
  const normalizedPickupTime = typeof pickupTime === "string" ? pickupTime.trim() : "";
  if (!parseTime12h(normalizedPickupTime)) {
    throw new Error("pickupTime is required and must be a valid time (e.g. 10:00 AM or 08:00).");
  }
  const normalizedReturnTime = typeof returnTime === "string" ? returnTime.trim() : "";
  if (!parseTime12h(normalizedReturnTime)) {
    throw new Error("returnTime is required and must be a valid time (e.g. 5:00 PM or 08:00).");
  }

  // Phase 4: GITHUB_TOKEN no longer required — booked-dates.json writes are disabled.

  // Use the real Stripe Payment Intent ID when the customer paid on the website,
  // or generate a synthetic identifier for cash/phone bookings.
  const resolvedPaymentIntentId =
    suppliedPaymentIntentId && typeof suppliedPaymentIntentId === "string" && suppliedPaymentIntentId.trim()
      ? suppliedPaymentIntentId.trim()
      : "manual_" + randomBytes(6).toString("hex");

  const isWebsitePayment = resolvedPaymentIntentId.startsWith("pi_");
  const normalizedAmountPaid = normalizeCurrency(amountPaid);
  const normalizedTotalPrice = normalizeCurrency(totalPrice);
  if (normalizedTotalPrice > 0 && normalizedTotalPrice < normalizedAmountPaid) {
    throw new Error("totalPrice must be greater than or equal to amountPaid when provided.");
  }
  const hasOutstandingBalance = normalizedTotalPrice > 0 && normalizedTotalPrice > normalizedAmountPaid;
  const bookingStatus = normalizedAmountPaid <= 0 || hasOutstandingBalance
    ? "reserved_unpaid"
    : "booked_paid";
  const normalizedStripeFee = normalizeOptionalAmount(stripeFee);
  const normalizedStripeNet = normalizeOptionalAmount(stripeNet);
  if (normalizedStripeFee != null && normalizedAmountPaid > 0 && normalizedStripeFee > normalizedAmountPaid) {
    throw new Error("stripeFee must be less than or equal to amountPaid.");
  }
  if (normalizedStripeNet != null && normalizedStripeNet > normalizedAmountPaid) {
    throw new Error("stripeNet must be less than or equal to amountPaid.");
  }
  if (
    normalizedStripeFee != null &&
    normalizedStripeNet != null &&
    Math.abs((normalizedStripeFee + normalizedStripeNet) - normalizedAmountPaid) > STRIPE_AMOUNT_TOLERANCE
  ) {
    throw new Error("stripeFee + stripeNet must equal amountPaid.");
  }
  // Keep legacy manual-booking behavior: when totalPrice is not provided, treat
  // the paid amount as the booking total for persistence/reporting. If both are
  // zero, this remains a no-payment reservation placeholder.
  const persistedTotalPrice = normalizedTotalPrice > 0 ? normalizedTotalPrice : normalizedAmountPaid;
  const vehicleRentalStatus = inferVehicleRentalStatusForManualBooking(pickupDate, pickupTime);

  // 1. Block calendar dates (booked-dates.json)
  await blockBookedDatesForManualBooking(vehicleId, pickupDate, returnDate);

  // 2. Persist booking through the unified pipeline (Supabase + bookings.json).
  const generatedBookingId = randomBytes(8).toString("hex");
  const result = await persistBooking({
    bookingId:       generatedBookingId,
    vehicleId,
    vehicleName:     MANUAL_BOOKING_VEHICLES[vehicleId],
    name:            name.trim(),
    phone:           typeof phone === "string" ? phone.trim() : "",
    email:           typeof email === "string" ? email.trim() : "",
    pickupDate,
    pickupTime:      normalizedPickupTime,
    returnDate,
    returnTime:      normalizedReturnTime,
    location:        "",
    status:          bookingStatus,
    paymentIntentId: resolvedPaymentIntentId,
    amountPaid:      normalizedAmountPaid,
    totalPrice:      persistedTotalPrice,
    notes:           typeof notes === "string" ? notes.trim().slice(0, 500)
                       : (isWebsitePayment ? "Website payment — confirmation email not received" : ""),
    paymentMethod:   isWebsitePayment ? "stripe" : "cash",
    stripeFee:       normalizedStripeFee,
    stripeNet:       normalizedStripeNet,
    // AI-created manual bookings must fail fast if booking+revenue cannot be
    // written to Supabase so dashboard/revenue never silently miss new records.
    strictPersistence: true,
    source:          "admin_ai",
  });

  let vehicleStatusSync = {
    synced: false,
    target: "unknown",
    rental_status: vehicleRentalStatus,
    warning: "Vehicle status sync unavailable.",
  };
  try {
    vehicleStatusSync = await syncVehicleStatusForManualBooking(vehicleId, vehicleRentalStatus);
  } catch (statusErr) {
    console.warn("toolCreateManualBooking: vehicle status sync failed (non-fatal):", statusErr.message);
    vehicleStatusSync = {
      synced: false,
      target: "error",
      rental_status: vehicleRentalStatus,
      warning: statusErr.message,
    };
  }
  const statusSyncMsg = vehicleStatusSync?.synced
    ? `fleet status is set to ${vehicleRentalStatus}`
    : `fleet status sync failed (${vehicleStatusSync?.warning || "unknown error"})`;
  const shouldSendConfirmation = sendConfirmationEmail !== false;
  const confirmationMsg = shouldSendConfirmation
    ? ` Use resend_booking_confirmation(bookingId: "${result.bookingId}") if you want to send one.`
    : " Email sending was intentionally skipped.";

  return {
    success:          true,
    bookingId:        result.bookingId,
    vehicle:          result.booking.vehicleName,
    renter:           result.booking.name,
    pickupDate,
    returnDate,
    amountPaid:       result.booking.amountPaid,
    totalPrice:       result.booking.totalPrice || result.booking.amountPaid,
    status:           result.booking.status,
    paymentIntentId:  resolvedPaymentIntentId,
    isWebsitePayment,
    vehicleStatus:    vehicleStatusSync,
    notes:            result.booking.notes || null,
    sendConfirmationEmail: shouldSendConfirmation,
    message:          `Booking created (${result.booking.status}). Dates ${pickupDate} → ${returnDate} are blocked for ${result.booking.vehicleName}, and ${statusSyncMsg}. No email was sent automatically.${confirmationMsg}`,
  };
}

/**
 * Re-send a booking confirmation email to the renter and owner.
 * Fetches stored docs (signature, ID, insurance) from pending_booking_docs in
 * Supabase, generates the rental agreement PDF when a signature is on file,
 * and attaches all documents to the owner email.
 */
async function toolResendBookingConfirmation({ bookingId }) {
  if (!bookingId) throw new Error("bookingId is required");

  // ── Find the booking ─────────────────────────────────────────────────────
  // Primary: Supabase bookings table. JSON fallback only on network error.
  let booking = null;
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data: row, error: sbErr } = await sb
        .from("bookings")
        .select(`
          booking_ref, vehicle_id, status, pickup_date, return_date,
          pickup_time, return_time, deposit_paid, total_price,
          payment_intent_id, payment_method, notes, created_at,
          customers ( name, phone, email )
        `)
        .eq("booking_ref", bookingId)
        .maybeSingle();
      if (sbErr) throw sbErr; // query error → propagate, do NOT fallback
      if (row) {
        booking = {
          bookingId:       row.booking_ref || bookingId,
          vehicleId:       row.vehicle_id,
          vehicleName:     (CARS[row.vehicle_id] || {}).name || row.vehicle_id,
          name:            row.customers?.name  || "",
          email:           row.customers?.email || "",
          phone:           row.customers?.phone || "",
          pickupDate:      row.pickup_date  || "",
          pickupTime:      row.pickup_time  || "",
          returnDate:      row.return_date  || "",
          returnTime:      row.return_time  || "",
          amountPaid:      Number(row.deposit_paid || 0),
          totalPrice:      Number(row.total_price  || 0),
          status:          DB_TO_APP_STATUS[row.status] || row.status,
          paymentIntentId: row.payment_intent_id || "",
          paymentMethod:   row.payment_method    || "",
          notes:           row.notes || "",
        };
      }
    } catch (err) {
      if (isNetworkError(err)) {
        console.error("[FALLBACK] Supabase unreachable in toolResendBookingConfirmation, using bookings.json:", err.message);
        // fall through to JSON lookup below
      } else {
        throw err; // non-network Supabase error → propagate
      }
    }
  }

  if (!booking) {
    // JSON fallback (also handles Supabase network error or not configured)
    const { data: bookingsData } = await loadBookings();
    for (const list of Object.values(bookingsData)) {
      if (!Array.isArray(list)) continue;
      const found = list.find(b => b.bookingId === bookingId);
      if (found) { booking = found; break; }
    }
  }
  if (!booking) throw new Error(`No booking found with bookingId "${bookingId}"`);

  const {
    name, email, phone, vehicleName, vehicleId,
    pickupDate, pickupTime, returnDate, returnTime,
    amountPaid, totalPrice, status, paymentIntentId,
    notes, source,
  } = booking;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP is not configured on the server — add SMTP_HOST, SMTP_USER, SMTP_PASS in Vercel environment variables.");
  }

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const firstName = (name || "there").split(" ")[0];

  // Determine whether this was a website (Stripe) payment or cash/manual.
  const isWebsitePayment = isWebsitePaymentMethod(paymentIntentId);
  const paymentMethodLabel = isWebsitePayment ? "Website (Stripe)" : "Cash / Manual";
  const normalizeStoredDocBase64 = (base64Value) => {
    if (!base64Value || typeof base64Value !== "string") return "";
    return base64Value.replace(/\s+/g, "").replace(/^data:.*;base64,/, "");
  };

  // ── Retrieve stored docs (signature, ID, insurance) from Supabase ────────
  // For resends we fetch regardless of email_sent status.
  let storedDocs = null;
  try {
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
            console.log(`toolResendBookingConfirmation: loaded pending_booking_docs via fallback key ${documentKey}`);
          }
          break;
        }
      }
    }
  } catch (docsErr) {
    console.warn("toolResendBookingConfirmation: could not retrieve pending_booking_docs (non-fatal):", docsErr.message);
  }

  // ── Build attachments ────────────────────────────────────────────────────
  // Pre-fetch vehicle data from DB so
  // VIN, make, year, etc. are available for both PDF regeneration and email bodies.
  const _vehicleDbData = (vehicleId && CARS[vehicleId])
    ? null
    : await getVehicleById(vehicleId).catch(() => null);
  const attachments = [];

  // Rental agreement PDF: use the pre-stored PDF when available; regenerate
  // (without a signature gate) when it is missing so every recovery email
  // always includes an agreement document.
  let agreementPdfFilename = null;
  try {
    const safeName_ = (name || "renter").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
    const safeDate_ = (pickupDate || isoDateInLA()).replace(/[^0-9-]/g, "");
    agreementPdfFilename = `rental-agreement-${safeName_}-${safeDate_}.pdf`;

    let pdfBuffer = null;

    // Try to download the stored PDF from Supabase Storage.
    // agreement_pdf_url is stored as a raw bucket-relative path.
    if (storedDocs?.agreement_pdf_url && sb) {
      try {
        const { data: blobData, error: dlErr } = await sb.storage
          .from("rental-agreements")
          .download(storedDocs.agreement_pdf_url);
        if (!dlErr && blobData) {
          pdfBuffer = Buffer.from(await blobData.arrayBuffer());
          console.log(`toolResendBookingConfirmation: downloaded stored PDF for booking ${bookingId}`);
        } else if (dlErr) {
          console.warn("toolResendBookingConfirmation: stored PDF download failed (will regenerate):", dlErr.message);
        }
      } catch (dlErr) {
        console.warn("toolResendBookingConfirmation: stored PDF download error (will regenerate):", dlErr.message);
      }
    }

    // Regenerate if we still don't have a buffer.
    if (!pdfBuffer) {
      const vehicleInfo = (vehicleId && CARS[vehicleId]) ? CARS[vehicleId] : (_vehicleDbData || {});
      const rentalDays  = (pickupDate && returnDate) ? computeRentalDays(pickupDate, returnDate) : 0;
      const hasProtectionPlan = !!(storedDocs?.protection_plan_tier || booking.protectionPlanTier);
      // storedDocs.protection_plan_tier is the authoritative source (captured at booking time);
      // booking.protectionPlanTier is a fallback for older records that predated pending_booking_docs.
      const protectionPlanTier = storedDocs?.protection_plan_tier || booking.protectionPlanTier || null;

      const pdfBody = {
        vehicleId:   vehicleId   || "",
        car:         vehicleName || (vehicleInfo.name) || vehicleId || "",
        vehicleMake:  vehicleInfo.make  || null,
        vehicleModel: vehicleInfo.model || null,
        vehicleYear:  vehicleInfo.year  || null,
        vehicleVin:   vehicleInfo.vin   || null,
        vehicleColor: vehicleInfo.color || null,
        name:         name      || "",
        email:        email     || "",
        phone:        phone     || "",
        pickup:       pickupDate || "",
        pickupTime:   pickupTime || "",
        returnDate:   returnDate || "",
        returnTime:   returnTime || "",
        total:        amountPaid != null ? String(amountPaid) : (totalPrice != null ? String(totalPrice) : ""),
        deposit:      vehicleInfo.deposit || 0,
        days:         rentalDays,
        protectionPlan:          hasProtectionPlan,
        protectionPlanTier:      protectionPlanTier,
        signature:               storedDocs?.signature || null,
        fullRentalCost:          booking.fullRentalCost  || null,
        balanceAtPickup:         booking.balanceAtPickup || null,
        insuranceCoverageChoice: storedDocs?.insurance_coverage_choice ||
          (hasProtectionPlan ? "no" : "yes"),
      };

      pdfBuffer = await generateRentalAgreementPdf(pdfBody);
      console.log(`toolResendBookingConfirmation: rental agreement PDF regenerated for booking ${bookingId}`);

      // Persist the regenerated PDF so future recoveries can reuse it.
      if (sb) {
        try {
          const storagePath = `${bookingId}/${agreementPdfFilename}`;
          const { error: uploadErr } = await sb.storage
            .from("rental-agreements")
            .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });
          if (!uploadErr) {
            await sb.from("pending_booking_docs").upsert(
              { booking_id: bookingId, agreement_pdf_url: storagePath, email_sent: storedDocs?.email_sent ?? false },
              { onConflict: "booking_id" }
            );
            console.log(`toolResendBookingConfirmation: regenerated PDF stored at ${storagePath}`);
          } else {
            console.warn("toolResendBookingConfirmation: PDF storage upload failed (non-fatal):", uploadErr.message);
          }
        } catch (storageErr) {
          console.warn("toolResendBookingConfirmation: PDF storage persist failed (non-fatal):", storageErr.message);
        }
      }
    }

    attachments.push({
      filename:    agreementPdfFilename,
      content:     pdfBuffer,
      contentType: "application/pdf",
    });
  } catch (pdfErr) {
    console.error("toolResendBookingConfirmation: PDF generation failed (non-fatal):", pdfErr.message);
    agreementPdfFilename = null;
  }

  const idFrontBase64 = normalizeStoredDocBase64(storedDocs?.id_base64);
  const idBackBase64 = normalizeStoredDocBase64(storedDocs?.id_back_base64);
  const insuranceDocBase64 = normalizeStoredDocBase64(storedDocs?.insurance_base64);

  // Attach renter's ID photo if available.
  if (idFrontBase64 && storedDocs?.id_filename) {
    try {
      attachments.push({
        filename:    storedDocs.id_filename,
        content:     Buffer.from(idFrontBase64, "base64"),
        contentType: storedDocs.id_mimetype || "application/octet-stream",
      });
    } catch (idErr) {
      console.error("toolResendBookingConfirmation: ID attachment failed (non-fatal):", idErr.message);
    }
  }

  // Attach renter's ID back photo if available.
  if (idBackBase64 && storedDocs?.id_back_filename) {
    try {
      attachments.push({
        filename:    storedDocs.id_back_filename,
        content:     Buffer.from(idBackBase64, "base64"),
        contentType: storedDocs.id_back_mimetype || "application/octet-stream",
      });
    } catch (idBackErr) {
      console.error("toolResendBookingConfirmation: ID back attachment failed (non-fatal):", idBackErr.message);
    }
  }

  // Attach insurance document if available.
  if (insuranceDocBase64 && storedDocs?.insurance_filename) {
    try {
      attachments.push({
        filename:    storedDocs.insurance_filename,
        content:     Buffer.from(insuranceDocBase64, "base64"),
        contentType: storedDocs.insurance_mimetype || "application/octet-stream",
      });
    } catch (insErr) {
      console.error("toolResendBookingConfirmation: insurance attachment failed (non-fatal):", insErr.message);
    }
  }

  const hasAttachments = attachments.length > 0;
  const attachmentList = attachments.map(a => a.filename).join(", ");
  const hasProtectionPlan = !!(storedDocs?.protection_plan_tier || booking.protectionPlanTier || booking.protectionPlan);
  const protectionPlanTier = storedDocs?.protection_plan_tier || booking.protectionPlanTier || null;

  let breakdownLines = null;
  try {
    const isHourly = !!(vehicleId && CARS[vehicleId] && CARS[vehicleId].hourlyTiers);
    if (!isHourly && vehicleId && pickupDate && returnDate) {
      const pricingSettings = await loadPricingSettings();
      const isKnownEconomy = (vehicleId === "camry" || vehicleId === "camry2013");
      const vehicleDataForBreakdown = !isKnownEconomy
        ? (_vehicleDbData ?? await getVehicleById(vehicleId).catch(() => null))
        : null;
      breakdownLines = computeBreakdownLinesFromSettings(
        vehicleId,
        pickupDate,
        returnDate,
        pricingSettings,
        hasProtectionPlan,
        protectionPlanTier,
        vehicleDataForBreakdown
      );
    }
  } catch (err) {
    console.warn("toolResendBookingConfirmation: pricing breakdown generation failed (non-fatal):", err.message);
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
    ...(notes ? [`Booking notes: ${notes}`] : []),
    ...(hasAttachments ? [`Attachments: ${attachmentList}`] : []),
  ];

  const ownerTemplate = buildUnifiedConfirmationEmail({
    audience:           "owner",
    bookingId,
    vehicleName,
    vehicleId,
    vehicleMake:        CARS[vehicleId]?.make || _vehicleDbData?.make || null,
    vehicleModel:       CARS[vehicleId]?.model || _vehicleDbData?.model || null,
    vehicleYear:        CARS[vehicleId]?.year || _vehicleDbData?.year || null,
    vehicleVin:         CARS[vehicleId]?.vin || _vehicleDbData?.vin || null,
    vehicleColor:       CARS[vehicleId]?.color || _vehicleDbData?.color || null,
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

  // ── Owner notification ────────────────────────────────────────────────────
  try {
    await transporter.sendMail({
      from:        `"Sly Car Rentals LLC Bookings" <${process.env.SMTP_USER}>`,
      to:          OWNER_EMAIL,
      ...(email ? { replyTo: email } : {}),
      subject:     ownerTemplate.subject,
      attachments,
      html: ownerTemplate.html,
      text: ownerTemplate.text,
    });
  } catch (ownerErr) {
    throw new Error(`Owner notification email failed: ${ownerErr.message}`);
  }

  // ── Customer confirmation ─────────────────────────────────────────────────
  let customerSent = false;
  if (email) {
    const customerTemplate = buildUnifiedConfirmationEmail({
      audience:           "customer",
      bookingId,
      vehicleName,
      vehicleId,
      vehicleMake:        CARS[vehicleId]?.make || _vehicleDbData?.make || null,
      vehicleModel:       CARS[vehicleId]?.model || _vehicleDbData?.model || null,
      vehicleYear:        CARS[vehicleId]?.year || _vehicleDbData?.year || null,
      vehicleVin:         CARS[vehicleId]?.vin || _vehicleDbData?.vin || null,
      vehicleColor:       CARS[vehicleId]?.color || _vehicleDbData?.color || null,
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
        html:    customerTemplate.html,
        text:    customerTemplate.text,
      });
      customerSent = true;
    } catch (custErr) {
      console.error("toolResendBookingConfirmation: customer email failed:", custErr.message);
    }
  }

  return {
    success:          true,
    bookingId,
    renter:           name || "N/A",
    vehicle:          vehicleName || vehicleId || "N/A",
    paymentMethod:    paymentMethodLabel,
    ownerNotified:    true,
    customerEmail:    email || null,
    customerSent,
    attachments:      hasAttachments ? attachmentList : null,
    message: customerSent
      ? `✅ Confirmation emails sent to owner and ${email}.${hasAttachments ? ` Documents attached: ${attachmentList}.` : " No stored documents found for this booking."}`
      : `✅ Owner notification sent. No customer email — no email address on this booking.${hasAttachments ? ` Documents attached: ${attachmentList}.` : ""}`,
  };
}

const IMEI_RE = /^\d{15}$/;
const BOUNCIE_SYNC_STALE_MS = 48 * 60 * 60 * 1000; // 48 hours

async function toolRegisterBouncieDevice({ vehicleId, imei }) {
  // ── Input validation ────────────────────────────────────────────────────
  if (!vehicleId) throw new Error("vehicleId is required");
  if (!imei)      throw new Error("imei is required — provide the 15-digit Bouncie device IMEI");

  const cleanImei = String(imei).replace(/[\s-]/g, "");
  if (!IMEI_RE.test(cleanImei)) {
    throw new Error(`Invalid IMEI "${imei}" — must be exactly 15 digits (e.g. 123456789012345)`);
  }

  // ── Vehicle existence check ─────────────────────────────────────────────
  const vehicles = await loadAllVehicles();
  if (!vehicles[vehicleId]) {
    throw new Error(`Vehicle "${vehicleId}" not found. Valid IDs: ${Object.keys(vehicles).join(", ")}`);
  }

  // ── Duplicate IMEI check (across all vehicles) ──────────────────────────
  for (const [vid, v] of Object.entries(vehicles)) {
    if (vid !== vehicleId && v.bouncie_device_id === cleanImei) {
      throw new Error(
        `IMEI ${cleanImei} is already assigned to vehicle "${v.vehicle_name || vid}". ` +
        `Each device can only be linked to one vehicle.`
      );
    }
  }

  // ── Write: Supabase + vehicles.json ─────────────────────────────────────
  const sb = getSupabaseAdmin();
  if (sb) {
    const updatedData = { ...vehicles[vehicleId], bouncie_device_id: cleanImei };
    const { error } = await sb
      .from("vehicles")
      .update({ bouncie_device_id: cleanImei, data: updatedData })
      .eq("vehicle_id", vehicleId);
    if (error && !error.message?.includes("relation")) {
      throw new Error(`Supabase update failed: ${error.message}`);
    }
  }

  const { data: jsonVehicles } = await loadVehicles();
  if (jsonVehicles[vehicleId]) {
    jsonVehicles[vehicleId] = { ...jsonVehicles[vehicleId], bouncie_device_id: cleanImei };
    await saveVehicles(jsonVehicles);
  }

  // ── Post-assignment verification ─────────────────────────────────────────
  // Read back the row so we can confirm bouncie_device_id was persisted
  // and report the current sync state.
  let confirmedImei = null;
  let lastSyncedAt  = null;

  if (sb) {
    try {
      const { data: row } = await sb
        .from("vehicles")
        .select("bouncie_device_id, last_synced_at")
        .eq("vehicle_id", vehicleId)
        .maybeSingle();
      if (row) {
        confirmedImei = row.bouncie_device_id || null;
        lastSyncedAt  = row.last_synced_at    || null;
      }
    } catch {
      // non-fatal — we still report success from the write
    }
  }

  const vehicleName   = vehicles[vehicleId]?.vehicle_name || vehicleId;
  const syncPending   = !lastSyncedAt;
  const syncAgeMs     = lastSyncedAt ? Date.now() - new Date(lastSyncedAt).getTime() : null;
  const syncRecent    = syncAgeMs !== null && syncAgeMs <= BOUNCIE_SYNC_STALE_MS;

  return {
    success:           true,
    vehicleId,
    vehicle_name:      vehicleName,
    bouncie_device_id: confirmedImei || cleanImei,
    tracking_active:   !!confirmedImei,
    last_synced_at:    lastSyncedAt,
    sync_status:       syncPending
      ? "awaiting_first_sync"
      : syncRecent
        ? "active"
        : "stale",
    message:
      `Bouncie device ${cleanImei} assigned to ${vehicleName}. ` +
      (syncPending
        ? "Waiting for first GPS sync — this usually takes a few minutes once the device is powered on."
        : syncRecent
          ? `Tracking is active (last sync: ${lastSyncedAt}).`
          : `Device was last seen at ${lastSyncedAt} — check that the device is powered on.`),
  };
}

// ── Stripe Reconciliation ─────────────────────────────────────────────────────

/**
 * Calls stripe-reconcile.js to rebuild financial data from Stripe API.
 * Supports reconcile (full sync), preview (dry-run), cash_update, and analytics.
 */
async function toolReconcileStripe({ action = "reconcile" } = {}) {
  const validActions = ["reconcile", "preview", "cash_update", "analytics"];
  if (!validActions.includes(action)) {
    return { error: `Invalid action. Must be one of: ${validActions.join(", ")}` };
  }

  const secret = process.env.ADMIN_SECRET;
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://sly-rides.vercel.app";

  const resp = await fetch(`${baseUrl}/api/stripe-reconcile`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", origin: "https://slycarrentals.com" },
    body:    JSON.stringify({ secret, action }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `stripe-reconcile returned ${resp.status}`);

  if (action === "analytics") {
    return { analytics: data.analytics };
  }

  if (action === "cash_update") {
    return { updated: data.updated, message: data.message };
  }

  const v = data.verification || {};
  return {
    dry_run:     data.dry_run || false,
    total_pis:   data.total_pis,
    matched:     data.matched,
    updated:     data.updated,
    skipped:     data.skipped,
    unmatched:   data.unmatched,
    analytics:   data.analytics,
    verification: {
      stripe_total_gross:  v.stripe_total_gross,
      stripe_total_fees:   v.stripe_total_fees,
      stripe_total_net:    v.stripe_total_net,
      db_reconciled_net:   v.db_reconciled_net,
      unmatched_pi_count:  v.unmatched_pi_count,
    },
    ...(data.preview ? { preview: data.preview } : {}),
  };
}

const DESTRUCTIVE_TOOLS = new Set([
  "create_vehicle",
  "add_vehicle",
  "update_vehicle",
  "delete_vehicle",
  "delete_booking",
  "send_sms",
  "mark_maintenance",
  "flag_booking",
  "update_booking_status",
  "update_booking_times",
  "confirm_vehicle_action",
  "update_action_status",
  "send_message_to_driver",
  "register_bouncie_device",
  "create_manual_booking",
  "add_expense",
  "delete_expense",
  "manage_expense_category",
  "block_dates",
  "open_dates",
  "update_system_setting",
  "update_sms_template",
  "update_customer",
  "charge_customer_fee",
  "record_extension_payment",
  "update_site_content",
  "defer_late_fee",
  "run_system_health_fix",
]);

// ── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * Execute a named tool with the given args.
 * Logs the action to ai_logs (falls back to admin_action_logs).
 *
 * @param {string} toolName
 * @param {object} args
 * @param {object} [options]
 * @param {boolean} [options.requireConfirmation] - if true, reject destructive calls without args.confirmed
 * @param {string}  [options.adminId]             - identifier for the admin session
 * @returns {Promise<object>} Tool result
 */
export async function executeAction(toolName, args = {}, { requireConfirmation = true, adminId = "admin", scope = null } = {}) {
  const normalizedScope = normalizeFleetScope(scope);
  const scopedArgs = normalizedScope ? { ...args, scope: normalizedScope } : args;
  // Guard: destructive ops need confirmation flag when requireConfirmation is enabled
  if (requireConfirmation && DESTRUCTIVE_TOOLS.has(toolName) && !scopedArgs.confirmed) {
    const result = {
      requires_confirmation: true,
      message: `Action "${toolName}" requires confirmation. Ask the admin to confirm, then retry with confirmed:true.`,
    };
    await logAiAction(toolName, scopedArgs, result, adminId);
    return result;
  }

  let result;
  try {
    switch (toolName) {
      case "get_revenue":               result = await toolGetRevenue(scopedArgs);         break;
      case "get_bookings":              result = await toolGetBookings(scopedArgs);        break;
      case "get_vehicles":              result = await toolGetVehicles(scopedArgs);        break;
      case "create_vehicle":           result = await toolCreateVehicle(args);           break;
      case "add_vehicle":              result = await toolAddVehicle(args);              break;
      case "update_vehicle":           result = await toolUpdateVehicle(args);           break;
      case "send_sms":                 result = await toolSendSms(args);                 break;
      case "get_insights":              result = await toolGetInsights(scopedArgs);        break;
      case "get_fraud_report":         result = await toolGetFraudReport(args);          break;
      case "get_mileage":               result = await toolGetMileage(scopedArgs);         break;
      case "get_gps_tracking":          result = await toolGetGpsTracking(scopedArgs);     break;
      case "get_maintenance_status":    result = await toolGetMaintenanceStatus(scopedArgs); break;
      case "update_maintenance_status": result = await toolUpdateMaintenanceStatus();    break;
      case "mark_maintenance":         result = await toolMarkMaintenance(args);         break;
      case "flag_booking":             result = await toolFlagBooking(args);             break;
      case "update_booking_status":    result = await toolUpdateBookingStatus(args);     break;
      case "update_booking_times":     result = await toolUpdateBookingTimes(args);      break;
      case "confirm_vehicle_action":   result = await toolConfirmVehicleAction(args);    break;
      case "update_action_status":     result = await toolUpdateActionStatus(args);      break;
      case "send_message_to_driver":   result = await toolSendMessageToDriver(args);     break;
      case "get_expenses":             result = await toolGetExpenses(scopedArgs);       break;
      case "get_analytics":            result = await toolGetAnalytics(scopedArgs);      break;
      case "get_customers":            result = await toolGetCustomers(scopedArgs);      break;
      case "get_protection_plans":     result = await toolGetProtectionPlans();          break;
      case "get_system_settings":      result = await toolGetSystemSettings(args);       break;
      case "get_price_quote":          result = await toolGetPriceQuote(args);           break;
      case "get_sms_templates":        result = await toolGetSmsTemplates();             break;
      case "get_blocked_dates":        result = await toolGetBlockedDates(args);         break;
      case "register_bouncie_device":      result = await toolRegisterBouncieDevice(args);      break;
      case "resend_booking_confirmation":   result = await toolResendBookingConfirmation(args);   break;
      case "create_manual_booking":         result = await toolCreateManualBooking(args);         break;
      case "add_expense":                   result = await toolAddExpense(args);                   break;
      case "delete_expense":                result = await toolDeleteExpense(args);                break;
      case "get_expense_categories":        result = await toolGetExpenseCategories();             break;
      case "manage_expense_category":       result = await toolManageExpenseCategory(args);        break;
      case "block_dates":                   result = await toolBlockDates(args);                   break;
      case "open_dates":                    result = await toolOpenDates(args);                    break;
      case "update_system_setting":         result = await toolUpdateSystemSetting(args);          break;
      case "update_sms_template":           result = await toolUpdateSmsTemplate(args);            break;
      case "update_customer":               result = await toolUpdateCustomer(args);               break;
      case "recount_customer_counts":        result = await toolRecountCustomerCounts();            break;
      case "delete_vehicle":                result = await toolDeleteVehicle(args);                break;
      case "delete_booking":                result = await toolDeleteBooking(args);                break;
      case "charge_customer_fee":           result = await toolChargeCustomerFee(args);            break;
      case "get_charges":                   result = await toolGetCharges(args);                   break;
      case "record_extension_payment":      result = await toolRecordExtensionPayment(args);       break;
      case "reconcile_stripe":              result = await toolReconcileStripe(args);              break;
      case "get_site_content":              result = await toolGetSiteContent();                  break;
      case "update_site_content":           result = await toolUpdateSiteContent(args);           break;
      case "backfill_stripe_cards":         result = await toolBackfillStripeCards(args);         break;
      case "defer_late_fee":                result = await toolDeferLateFee(args);                break;
      case "run_system_health_fix":         result = await toolRunSystemHealthFix(args);          break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (err) {
    console.error("TOOL ERROR:", err);
    const errorResult = { error: adminErrorMessage(err), details: err.message };
    try { await logAiAction(toolName, scopedArgs, errorResult, adminId); } catch (logErr) { console.error("TOOL ERROR: failed to log action:", logErr); }
    return errorResult;
  }

  await logAiAction(toolName, scopedArgs, result, adminId);
  return result;
}

// ── Unified data loader ───────────────────────────────────────────────────────

/**
 * Load all core admin data in parallel from Supabase (with JSON fallbacks).
 * Returns a single context object used by all admin and AI systems.
 *
 * @returns {Promise<{
 *   bookings:      object[],
 *   vehicles:      object,
 *   expenses:      object[],
 *   settings:      object,
 *   maintenance:   object[],
 *   blocked_dates: object[],
 *   customers:     object[],
 * }>}
 */
export async function loadAdminContext() {
  const sb = getSupabaseAdmin();

  // Supabase-specific loaders — non-fatal when table missing or Supabase not configured
  async function loadMaintenance() {
    if (!sb) return [];
    try {
      const { data, error } = await sb
        .from("maintenance")
        .select("id, vehicle_id, service_type, due_date, status, notes, updated_at")
        .order("updated_at", { ascending: false })
        .limit(200);
      if (error) {
        const msg = error.message || "";
        if (!msg.includes("relation") && !msg.includes("does not exist")) {
          console.error("loadAdminContext: maintenance query error:", msg);
        }
        return [];
      }
      return data || [];
    } catch (err) {
      console.error("loadAdminContext: maintenance query threw:", err.message);
      return [];
    }
  }

  async function loadBlockedDates() {
    if (!sb) return [];
    try {
      const { data, error } = await sb
        .from("blocked_dates")
        .select("id, vehicle_id, start_date, end_date, reason, source")
        .order("start_date", { ascending: true })
        .limit(50);
      if (error) {
        const msg = error.message || "";
        if (!msg.includes("relation") && !msg.includes("does not exist")) {
          console.error("loadAdminContext: blocked_dates query error:", msg);
        }
        return [];
      }
      return data || [];
    } catch (err) {
      console.error("loadAdminContext: blocked_dates query threw:", err.message);
      return [];
    }
  }

  async function loadCustomers() {
    if (!sb) return [];
    try {
      const { data, error } = await sb
        .from("customers")
        .select("id, name, phone, email, total_bookings, total_spent, is_banned, no_show_count, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) {
        const msg = error.message || "";
        if (!msg.includes("relation") && !msg.includes("does not exist")) {
          console.error("loadAdminContext: customers query error:", msg);
        }
        return [];
      }
      return data || [];
    } catch (err) {
      console.error("loadAdminContext: customers query threw:", err.message);
      return [];
    }
  }

  const [bookingsResult, vehiclesResult, expensesResult, settingsResult,
         maintenanceResult, blockedDatesResult, customersResult] = await Promise.allSettled([
    loadAllBookings(),
    loadAllVehicles(),
    loadExpenses().then((r) => r.data || []).catch(() => []),
    loadPricingSettings().catch(() => ({})),
    loadMaintenance(),
    loadBlockedDates(),
    loadCustomers(),
  ]);

  return {
    bookings:      bookingsResult.status      === "fulfilled" ? bookingsResult.value      : [],
    vehicles:      vehiclesResult.status      === "fulfilled" ? vehiclesResult.value      : {},
    expenses:      expensesResult.status      === "fulfilled" ? expensesResult.value      : [],
    settings:      settingsResult.status      === "fulfilled" ? settingsResult.value      : {},
    maintenance:   maintenanceResult.status   === "fulfilled" ? maintenanceResult.value   : [],
    blocked_dates: blockedDatesResult.status  === "fulfilled" ? blockedDatesResult.value  : [],
    customers:     customersResult.status     === "fulfilled" ? customersResult.value     : [],
  };
}
