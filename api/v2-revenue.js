// api/v2-revenue.js
// SLYTRANS Fleet Control v2 — Revenue records management endpoint.
// All operations are additive; existing booking and payment flows are unaffected.
//
// POST /api/v2-revenue
// Actions:
//   list        — { secret, action:"list", vehicleId?, startDate?, endDate?, status? }
//   get         — { secret, action:"get", id }
//   create      — { secret, action:"create", ...fields }
//   update      — { secret, action:"update", id, updates:{...} }
//   delete      — { secret, action:"delete", id }
//   summary     — { secret, action:"summary" } — per-vehicle aggregated stats
//
// Error contract:
//   • READ actions (list, get, summary) return empty state when Supabase is not
//     configured or the table does not yet exist, so the admin panel never crashes.
//   • WRITE actions fall back to GitHub (revenue-records.json) when Supabase is
//     unavailable or the table does not yet exist, so saves never fail silently.

import { getSupabaseAdmin } from "./_supabase.js";
import { loadVehicles } from "./_vehicles.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { withAdminAuth } from "./_middleware.js";
import { logCompatibilityFallback, logDefaultOrgFallback } from "./_org-rollout-observability.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { normalizeVehicleId, vehicleIdFamily, uiVehicleId } from "./_vehicle-id.js";
import { getAllVehicleIds } from "./_pricing.js";
import crypto from "crypto";

const GITHUB_REPO     = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const RECORDS_FILE    = "revenue-records.json";

/** Returns the Supabase client or null if not configured. */
function getSupabase() {
  return getSupabaseAdmin();
}

const DEFAULT_REVENUE_PAYMENT_STATUSES = ["paid", "partial"];

function resolveRevenuePaymentStatuses(value) {
  const requested = String(value || "").trim().toLowerCase();
  return requested ? [requested] : [...DEFAULT_REVENUE_PAYMENT_STATUSES];
}

function matchesRevenuePaymentStatus(record, statuses) {
  const paymentStatus = String(record?.payment_status || "").trim().toLowerCase();
  return statuses.includes(paymentStatus);
}

// ── GitHub fallback helpers ───────────────────────────────────────────────────

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function loadRecordsFromGitHub() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${RECORDS_FILE}`;
  const resp   = await fetch(apiUrl, { headers: ghHeaders() });
  if (!resp.ok) {
    if (resp.status === 404) return { data: [], sha: null };
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub GET revenue-records.json failed: ${resp.status} ${text}`);
  }
  const file = await resp.json();
  let data = [];
  try {
    const parsed = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (Array.isArray(parsed)) data = parsed;
  } catch { data = []; }
  return { data, sha: file.sha };
}

async function saveRecordsToGitHub(data, sha, message) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("v2-revenue: GITHUB_TOKEN not set — revenue-records.json will not be updated");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${RECORDS_FILE}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content };
  if (sha) body.sha = sha;
  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT revenue-records.json failed: ${resp.status} ${text}`);
  }
}

export default withAdminAuth(async function handler(req, res) {
  const body = req.body || {};
  const { action } = body;

  const sb = getSupabase();

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (!action || action === "list") {
      const effectivePaymentStatuses = resolveRevenuePaymentStatuses(body.status);
      // When a scope filter is requested, resolve the matching vehicle IDs first.
      // scope='car' → car-type vehicles only.
      let scopedVehicleIds = null;
      if (body.scope) {
        try {
          const REVENUE_CAR_TYPES = new Set(["car", "economy", "luxury", "suv", "truck", "van"]);
          const sc = (body.scope || "").toLowerCase();
          const { data: vData } = await loadVehicles();
          scopedVehicleIds = Object.values(vData || {})
            .filter((v) => {
              const t = (v.type || "").toLowerCase();
              if (sc === "car" || sc === "cars") return REVENUE_CAR_TYPES.has(t) || t === "";
              return true;
            })
            .map((v) => v.vehicle_id)
            .filter(Boolean);
        } catch (scopeErr) {
          console.warn("v2-revenue: scope vehicle lookup failed (non-fatal):", scopeErr.message);
        }
      }

      // Try Supabase first; fall back to GitHub when not configured or table missing.
      if (sb) {
        try {
          let q = sb.from("revenue_records_effective").select("*").eq("is_orphan", false).order("created_at", { ascending: false });
          if (body.vehicleId)  q = q.in("vehicle_id",    vehicleIdFamily(body.vehicleId));
          q = effectivePaymentStatuses.length === 1
            ? q.eq("payment_status", effectivePaymentStatuses[0])
            : q.in("payment_status", effectivePaymentStatuses);
          if (body.startDate)  q = q.gte("pickup_date",   body.startDate);
          if (body.endDate)    q = q.lte("return_date",   body.endDate);
          if (body.limit)      q = q.limit(Number(body.limit));
          if (scopedVehicleIds && scopedVehicleIds.length > 0) q = q.in("vehicle_id", scopedVehicleIds);
          const { data, error } = await q;
          if (!error) {
            // If Supabase has records, return them directly.
            if ((data || []).length > 0) return res.status(200).json({ records: data });
            // Supabase table exists but is empty — fall through to bookings-derived view below.
          } else {
            console.error("v2-revenue list error:", error.message);
          }
        } catch (qErr) {
          console.error("v2-revenue list query error:", qErr);
        }
      }
      // GitHub fallback
      logCompatibilityFallback({
        endpoint: "v2-revenue",
        action: "list",
        fallback: "github_records",
        reason: "supabase_unavailable_or_empty",
      });
      const { data: ghRecords } = await loadRecordsFromGitHub();
      let records = ghRecords.filter((r) => !r.sync_excluded && !r.is_orphan);
      if (body.vehicleId)  records = records.filter((r) => vehicleIdFamily(body.vehicleId).includes(r.vehicle_id));
      records = records.filter((r) => matchesRevenuePaymentStatus(r, effectivePaymentStatuses));
      if (body.startDate)  records = records.filter((r) => r.pickup_date   >= body.startDate);
      if (body.endDate)    records = records.filter((r) => r.return_date   <= body.endDate);
      if (scopedVehicleIds) records = records.filter((r) => scopedVehicleIds.includes(r.vehicle_id));
      records.sort((a, b) => (b.created_at || "") > (a.created_at || "") ? 1 : -1);
      if (body.limit) records = records.slice(0, Number(body.limit));
      if (records.length > 0) return res.status(200).json({ records });

      // Both Supabase and revenue-records.json are empty — return empty.
      return res.status(200).json({ records: [] });
    }

    // ── GET ─────────────────────────────────────────────────────────────────
    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (sb) {
        const { data, error } = await sb.from("revenue_records_effective").select("*").eq("id", body.id).single();
        if (!error) return res.status(200).json({ record: data });
        if (!isSchemaError(error)) throw error;
      }
      // GitHub fallback
      const { data: ghRecords } = await loadRecordsFromGitHub();
      const found = ghRecords.find((r) => r.id === body.id);
      if (!found) return res.status(404).json({ error: "Record not found" });
      return res.status(200).json({ record: found });
    }

    // ── CREATE ──────────────────────────────────────────────────────────────
    if (action === "create") {
      const { gross_amount } = body;
      // Normalize vehicle_id to canonical form (e.g. "camry2012" → "camry") so
      // manually-inserted records are always grouped with their vehicle's history.
      const vehicle_id = normalizeVehicleId(body.vehicle_id);
      // booking_id is optional for manual entries; auto-generate a unique id if not supplied
      const booking_id = body.booking_id || ("manual-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"));
      if (!vehicle_id || gross_amount == null)
        return res.status(400).json({ error: "vehicle_id and gross_amount are required" });

      const commonFields = {
        booking_id,
        // booking_ref mirrors booking_id when it is a real bk- reference; null for
        // auto-generated "manual-…" ids (no corresponding bookings row to FK against).
        booking_ref:        body.booking_id || null,
        vehicle_id,
        customer_name:      body.customer_name   || null,
        customer_phone:     body.customer_phone  || null,
        customer_email:     body.customer_email  || null,
        pickup_date:        body.pickup_date      || null,
        return_date:        body.return_date      || null,
        gross_amount:       Number(gross_amount),
        deposit_amount:     Number(body.deposit_amount  || 0),
        refund_amount:      Number(body.refund_amount   || 0),
        payment_method:     body.payment_method   || "stripe",
        payment_status:     body.payment_status   || "paid",
        protection_plan_id: body.protection_plan_id || null,
        notes:              body.notes            || null,
        is_no_show:         Boolean(body.is_no_show),
        is_cancelled:       Boolean(body.is_cancelled),
        override_by_admin:  Boolean(body.override_by_admin),
        created_at:         new Date().toISOString(),
        updated_at:         new Date().toISOString(),
      };
      logDefaultOrgFallback(req, { endpoint: "v2-revenue", action: "create", table: "revenue_records" });

      if (sb) {
        // Do NOT pass `id` — Supabase generates it via gen_random_uuid()
        const { data, error } = await sb.from("revenue_records").insert(commonFields).select().single();
        if (!error) return res.status(201).json({ record: data });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-revenue create: revenue_records table missing, falling back to GitHub");
        logCompatibilityFallback({
          endpoint: "v2-revenue",
          action: "create",
          fallback: "github_records",
          reason: "schema_compat",
          detail: error.message,
        });
      }
      // GitHub fallback — include a client-generated UUID for the id field
      const ghRecord = { id: crypto.randomUUID(), ...commonFields };
      let created;
      await updateJsonFileWithRetry({
        load:    loadRecordsFromGitHub,
        apply:   (data) => {
          if (!data.some((r) => r.booking_id === ghRecord.booking_id)) {
            data.push(ghRecord);
          }
          created = ghRecord;
        },
        save:    saveRecordsToGitHub,
        message: `v2: Add revenue record for ${vehicle_id}`,
      });
      return res.status(201).json({ record: created });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const allowed = [
        "vehicle_id",
        "gross_amount","deposit_amount","refund_amount","payment_method","payment_status",
        "protection_plan_id","notes","is_no_show","is_cancelled","override_by_admin",
        "customer_name","customer_phone","customer_email","pickup_date","return_date",
        "stripe_fee","stripe_net","stripe_charge_id","payment_intent_id",
      ];
      const updates = {};
      for (const f of allowed) {
        if (Object.prototype.hasOwnProperty.call(body.updates || {}, f)) updates[f] = (body.updates)[f];
      }
      if (!Object.keys(updates).length)
        return res.status(400).json({ error: "No valid update fields provided" });
      if ("vehicle_id" in updates) {
        if (!updates.vehicle_id) {
          console.warn(`v2-revenue update [${body.id}]: vehicle_id was provided but is empty — record will have no vehicle assigned`);
        } else {
          updates.vehicle_id = normalizeVehicleId(updates.vehicle_id);
        }
      }

      if (sb) {
        logDefaultOrgFallback(req, { endpoint: "v2-revenue", action: "update", table: "revenue_records" });
        const { data, error } = await sb.from("revenue_records").update(updates).eq("id", body.id).select().single();
        if (!error) return res.status(200).json({ record: data });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-revenue update: revenue_records table missing, falling back to GitHub");
        logCompatibilityFallback({
          endpoint: "v2-revenue",
          action: "update",
          fallback: "github_records",
          reason: "schema_compat",
          detail: error.message,
        });
      }
      // GitHub fallback
      let updated;
      await updateJsonFileWithRetry({
        load:    loadRecordsFromGitHub,
        apply:   (data) => {
          const idx = data.findIndex((r) => r.id === body.id);
          if (idx === -1) throw new Error("Record not found");
          Object.assign(data[idx], updates, { updated_at: new Date().toISOString() });
          updated = data[idx];
        },
        save:    saveRecordsToGitHub,
        message: `v2: Update revenue record ${body.id}`,
      });
      return res.status(200).json({ record: updated });
    }

    // ── DELETE ──────────────────────────────────────────────────────────────
    // Hard-delete from the active store so admin UI removal is immediate.
    if (action === "delete") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (sb) {
        const { error } = await sb.from("revenue_records")
          .delete()
          .eq("id", body.id);
        if (!error) return res.status(200).json({ success: true });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-revenue delete: revenue_records table missing, falling back to GitHub");
        logCompatibilityFallback({
          endpoint: "v2-revenue",
          action: "delete",
          fallback: "github_records",
          reason: "schema_compat",
          detail: error.message,
        });
      }
      // GitHub fallback — hard-delete by id
      await updateJsonFileWithRetry({
        load:    loadRecordsFromGitHub,
        apply:   (data) => {
          const idx = data.findIndex((r) => r.id === body.id);
          if (idx !== -1) data.splice(idx, 1);
        },
        save:    saveRecordsToGitHub,
        message: `v2: Delete revenue record ${body.id}`,
      });
      return res.status(200).json({ success: true });
    }

    // ── SUMMARY (per-vehicle) ────────────────────────────────────────────────
    if (action === "summary") {
      // Aggregate revenue_records rows using the same formula as v2-dashboard.js and
      // v2-analytics.js so all three pages report identical totals:
      //   gross   = SUM(gross_amount)
      //   fees    = SUM(stripe_fee)          (null → 0 for unreconciled rows)
      //   net     = SUM(gross − fee)         (fees deducted; refunds tracked separately)
      //   refunds = SUM(refund_amount)
      //   net_after_refunds = net − refunds  (= Gross − Fees − Refunds)
      function aggregateRecords(recs) {
        const summary = {};
        const totals = { gross: 0, fees: 0, refunds: 0, net: 0, deposits: 0, bookingCount: 0 };
        for (const r of (recs || [])) {
          const vid = normalizeVehicleId(r.vehicle_id) || "unknown";
          if (!summary[vid]) {
            summary[vid] = { vehicle_id: vid, booking_count:0, cancelled_count:0, no_show_count:0, total_gross:0, total_fees:0, total_refunds:0, total_net:0, total_deposits:0 };
          }
          const s = summary[vid];
          if (r.is_cancelled) { s.cancelled_count++; continue; }
          if (r.is_no_show)   { s.no_show_count++;   continue; }
          const gross  = Number(r.gross_amount   || 0);
          const fee    = r.stripe_fee != null ? Number(r.stripe_fee) : 0;
          // Net after fees only (refunds tracked separately in total_refunds).
          const net    = gross - fee;
          const refund = Number(r.refund_amount  || 0);
          const dep    = Number(r.deposit_amount || 0);
          s.booking_count++;
          s.total_gross    += gross;
          s.total_fees     += fee;
          s.total_refunds  += refund;
          s.total_net      += net;
          s.total_deposits += dep;
          totals.gross    += gross;
          totals.fees     += fee;
          totals.refunds  += refund;
          totals.net      += net;
          totals.deposits += dep;
          totals.bookingCount++;
        }
        return { summary: Object.values(summary), totals };
      }

      if (sb) {
        try {
          const { data: recs, error: recsErr } = await sb
            .from("revenue_records_effective")
            .select("vehicle_id, gross_amount, stripe_fee, stripe_net, refund_amount, deposit_amount, is_cancelled, is_no_show")
            .in("payment_status", DEFAULT_REVENUE_PAYMENT_STATUSES);
          if (!recsErr) {
            const result = aggregateRecords(recs);
            // Override booking_count with counts from the bookings table (source of truth).
            // This ensures camry/camry2012 legacy IDs are collapsed and every booking
            // is counted exactly once, regardless of how many revenue_records it has.
            // getAllVehicleIds() merges the static fleet list with vehicles registered in
            // Supabase so newly-added vehicles are included automatically.
            try {
              const allVehicleIds = await getAllVehicleIds(sb);
              const { data: bRows, error: bErr } = await sb
                .from("bookings")
                .select("vehicle_id")
                .in("vehicle_id", allVehicleIds);
              if (!bErr && bRows) {
                const countsByVehicle = {};
                for (const row of bRows) {
                  const vid = uiVehicleId(row.vehicle_id) || row.vehicle_id;
                  countsByVehicle[vid] = (countsByVehicle[vid] || 0) + 1;
                }
                let totalBookingCount = 0;
                for (const s of result.summary) {
                  s.booking_count = countsByVehicle[s.vehicle_id] ?? 0;
                  totalBookingCount += s.booking_count;
                }
                result.totals.bookingCount = totalBookingCount;
              } else if (bErr) {
                console.warn("v2-revenue summary: bookings count query failed (non-fatal):", bErr.message);
              }
            } catch (bEx) {
              console.warn("v2-revenue summary: bookings count query error (non-fatal):", bEx.message);
            }
            return res.status(200).json(result);
          }
          if (!isSchemaError(recsErr)) console.error("v2-revenue summary error (revenue_records_effective):", recsErr.message);
        } catch (sumErr) {
          console.error("v2-revenue summary error:", sumErr);
        }
      }
      // GitHub fallback
      const { data: ghRecords } = await loadRecordsFromGitHub();
      return res.status(200).json(
        aggregateRecords(ghRecords.filter((r) => !r.sync_excluded && matchesRevenuePaymentStatus(r, DEFAULT_REVENUE_PAYMENT_STATUSES)))
      );
    }

    // ── RECORD EXTENSION FEE ────────────────────────────────────────────────
    // Convenience action for recording an external or manual extension fee that
    // was NOT processed through the Stripe rental-extension flow (e.g. cash,
    // Zelle, or a phone-agreed payment).
    //
    // booking_id is set to original_booking_id (the canonical booking_ref) so
    // all records for the same booking share the same booking_id and group
    // correctly in the admin revenue view.  original_booking_id is set to the
    // same value for consistency and to make the parent link explicit.
    if (action === "record_extension_fee") {
      const { original_booking_id, vehicle_id, amount, extension_label, payment_method, notes } = body;
      if (!original_booking_id || !vehicle_id || amount == null)
        return res.status(400).json({ error: "original_booking_id, vehicle_id, and amount are required" });

      const resolvedAmount = Number(amount);
      if (isNaN(resolvedAmount) || resolvedAmount <= 0)
        return res.status(400).json({ error: "amount must be a positive number" });

      const label    = extension_label ? ` (${extension_label})` : "";
      const noteText = notes || `Extension${label} for booking ${original_booking_id} — external payment`;

      const commonFields = {
        booking_id:          original_booking_id,
        booking_ref:         original_booking_id,
        original_booking_id: original_booking_id,
        vehicle_id,
        gross_amount:        resolvedAmount,
        deposit_amount:      0,
        refund_amount:       0,
        payment_method:      payment_method || "external",
        payment_status:      "paid",
        type:                "extension",
        notes:               noteText,
        is_no_show:          false,
        is_cancelled:        false,
        override_by_admin:   true,
        created_at:          new Date().toISOString(),
        updated_at:          new Date().toISOString(),
      };

      if (sb) {
        const { data, error } = await sb.from("revenue_records").insert(commonFields).select().single();
        if (!error) return res.status(201).json({ record: data, booking_id: original_booking_id });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-revenue record_extension_fee: Supabase unavailable, falling back to GitHub");
      }
      // GitHub fallback — insert without deduplication.
      // Multiple extensions for the same booking are legitimate (a booking can
      // be extended more than once), so there is no stable unique key to dedup
      // on.  Each call generates a fresh UUID, matching Supabase's INSERT behaviour.
      const ghRecord = { id: crypto.randomUUID(), ...commonFields };
      let created;
      await updateJsonFileWithRetry({
        load:    loadRecordsFromGitHub,
        apply:   (data) => {
          data.push(ghRecord);
          created = ghRecord;
        },
        save:    saveRecordsToGitHub,
        message: `v2: Record extension fee for booking ${original_booking_id}`,
      });
      return res.status(201).json({ record: created, booking_id: original_booking_id });
    }

    // ── KPI — total revenue from the canonical reporting view ─────────────────
    // Returns { total_revenue } from the canonical SQL layer:
    //   revenue_reporting_canonical (row-level) + total_revenue_kpi_canonical (aggregate)
    // with shared inclusion rules:
    //   payment_status='paid', sync_excluded=false, is_orphan=false,
    //   is_cancelled=false, is_no_show=false.
    // When scope='car' is provided, revenue is filtered to
    // only the matching fleet type by querying revenue_records directly.
    if (action === "kpi") {
      // Resolve scope → vehicle IDs when a scope filter is requested.
      let kpiScopedVehicleIds = null;
      if (body.scope) {
        try {
          const REVENUE_CAR_TYPES_KPI = new Set(["car", "economy", "luxury", "suv", "truck", "van"]);
          const sc = (body.scope || "").toLowerCase();
          const { data: vData } = await loadVehicles();
          kpiScopedVehicleIds = Object.values(vData || {})
            .filter((v) => {
              const t = (v.type || "").toLowerCase();
              // Vehicles with no type recorded default to the car fleet.
              if (sc === "car" || sc === "cars") return REVENUE_CAR_TYPES_KPI.has(t) || t === "";
              return true;
            })
            .map((v) => v.vehicle_id)
            .filter(Boolean);
        } catch (scopeErr) {
          console.warn("v2-revenue kpi: scope vehicle lookup failed (non-fatal):", scopeErr.message);
        }
      }

      if (sb) {
        try {
          let q = sb
            .from("revenue_records_effective")
            .select("gross_amount, is_cancelled, is_no_show, is_orphan")
            .in("payment_status", DEFAULT_REVENUE_PAYMENT_STATUSES);
          if (kpiScopedVehicleIds && kpiScopedVehicleIds.length > 0) {
            q = q.in("vehicle_id", kpiScopedVehicleIds);
          }
          const { data: rreData, error: rreErr } = await q;
          if (!rreErr) {
            const total = (rreData || [])
              .filter((r) => !r.is_orphan)
              .filter((r) => !r.is_cancelled && !r.is_no_show)
              .reduce((s, r) => s + Number(r.gross_amount || 0), 0);
            return res.status(200).json({ total_revenue: Math.round(total * 100) / 100 });
          }
          if (!isSchemaError(rreErr)) console.error("v2-revenue kpi error:", rreErr.message);
        } catch (kpiErr) {
          console.error("v2-revenue kpi error:", kpiErr);
        }
      }
      // GitHub fallback: compute from revenue-records.json
      const { data: ghRecords } = await loadRecordsFromGitHub();
      const kpiScopedSet = kpiScopedVehicleIds ? new Set(kpiScopedVehicleIds) : null;
      const total = ghRecords
        .filter((r) => matchesRevenuePaymentStatus(r, DEFAULT_REVENUE_PAYMENT_STATUSES))
        .filter((r) => !r.sync_excluded)
        .filter((r) => !r.is_orphan)
        .filter((r) => !r.is_cancelled)
        .filter((r) => !r.is_no_show)
        .filter((r) => !kpiScopedSet || kpiScopedSet.has(r.vehicle_id))
        .reduce((s, r) => s + Number(r.gross_amount || 0), 0);
      return res.status(200).json({ total_revenue: Math.round(total * 100) / 100 });
    }

    // ── LIST BY BOOKING (aggregated UI view) ────────────────────────────────
    // Returns one entry per booking: MIN(pickup_date), MAX(return_date),
    // SUM(gross_amount WHERE is_cancelled = false), plus the individual child
    // rows so the UI can expand base + extension detail.
    //
    // Primary path: queries the booking_revenue_grouped Supabase view (which
    // does the grouping in SQL).  Falls back to loading all rows and grouping
    // in JavaScript when the view is unavailable (schema migration not yet run).
    if (action === "list_by_booking") {
      const acceptedPaymentStatuses = resolveRevenuePaymentStatuses(body.status);
      const isIncludedRevenue = (record) => matchesRevenuePaymentStatus(record, acceptedPaymentStatuses);
      // Resolve scope → vehicle IDs (same logic as the list action).
      let scopedVehicleIds = null;
      if (body.scope) {
        try {
          const REVENUE_CAR_TYPES_LB = new Set(["car", "economy", "luxury", "suv", "truck", "van"]);
          const sc = (body.scope || "").toLowerCase();
          const { data: vData } = await loadVehicles();
          scopedVehicleIds = Object.values(vData || {})
            .filter((v) => {
              const t = (v.type || "").toLowerCase();
              if (sc === "car" || sc === "cars") return REVENUE_CAR_TYPES_LB.has(t) || t === "";
              return true;
            })
            .map((v) => v.vehicle_id)
            .filter(Boolean);
        } catch (scopeErr) {
          console.warn("v2-revenue list_by_booking: scope vehicle lookup failed (non-fatal):", scopeErr.message);
        }
      }

      let allRows = null;

      if (sb) {
        try {
          let q = sb
            .from("revenue_records_effective")
            .select("*")
            .eq("is_orphan", false)
            .order("created_at", { ascending: true });
          if (body.vehicleId)  q = q.in("vehicle_id",    vehicleIdFamily(body.vehicleId));
          if (body.startDate)  q = q.gte("pickup_date",  body.startDate);
          if (body.endDate)    q = q.lte("return_date",  body.endDate);
          if (scopedVehicleIds && scopedVehicleIds.length > 0) q = q.in("vehicle_id", scopedVehicleIds);
          const { data, error } = await q;
          if (!error) allRows = data || [];
        } catch (qErr) {
          console.error("v2-revenue list_by_booking query error:", qErr);
        }
      }

      if (!allRows) {
        const { data: ghRecords } = await loadRecordsFromGitHub();
        allRows = ghRecords.filter((r) => !r.sync_excluded && !r.is_orphan);
        if (scopedVehicleIds) allRows = allRows.filter((r) => scopedVehicleIds.includes(r.vehicle_id));
        if (body.vehicleId) allRows = allRows.filter((r) => vehicleIdFamily(body.vehicleId).includes(r.vehicle_id));
      }
      allRows = allRows.filter(isIncludedRevenue);

      // Aggregate: group by effective_booking_id, MIN(pickup_date), MAX(return_date), SUM.
      // Use booking_id as the primary group key (canonical booking_ref after migration 0084).
      // Fall back to original_booking_id only when booking_id is absent — this prevents
      // stale/legacy original_booking_id values (e.g. old PI ids) from creating phantom
      // groups that display as standalone rows in the Revenue Tracker.
      const groups = {};
      for (const r of allRows) {
        const key = r.booking_id ?? r.original_booking_id ?? r.id;
        if (!groups[key]) {
          groups[key] = {
            booking_id:     key,
            vehicle_id:     r.vehicle_id     || null,
            customer_name:  r.customer_name  || null,
            customer_phone: r.customer_phone || null,
            customer_email: r.customer_email || null,
            min_pickup_date: r.pickup_date   || null,
            max_return_date: r.return_date   || null,
            total_gross:    0,
            record_count:   0,
            records:        [],
          };
        }
        const g = groups[key];
        // MIN(pickup_date)
        if (r.pickup_date && (!g.min_pickup_date || r.pickup_date < g.min_pickup_date)) {
          g.min_pickup_date = r.pickup_date;
        }
        // MAX(return_date)
        if (r.return_date && (!g.max_return_date || r.return_date > g.max_return_date)) {
          g.max_return_date = r.return_date;
        }
        // SUM(gross_amount) — skip cancelled/no-show rows
        if (!r.is_cancelled && !r.is_no_show) {
          g.total_gross = Math.round((g.total_gross + Number(r.gross_amount || 0)) * 100) / 100;
        }
        g.record_count += 1;
        g.records.push(r);
      }

      // Sort groups: most recent pickup first
      const sorted = Object.values(groups).sort((a, b) => {
        const da = a.min_pickup_date || "";
        const db = b.min_pickup_date || "";
        return da > db ? -1 : da < db ? 1 : 0;
      });

      if (body.limit) sorted.splice(Number(body.limit));

      return res.status(200).json({ groups: sorted });
    }

    // ── REBUILD ANALYTICS ───────────────────────────────────────────────────
    // Recomputes total gross / stripe fees / net revenue and per-vehicle profit
    // from the revenue_records table.  Requires Supabase.
    if (action === "rebuild_analytics") {
      if (!sb) return res.status(503).json({ error: "Supabase is not configured." });
      const { data: rows, error: rowsErr } = await sb
        .from("revenue_records_effective")
        .select("vehicle_id, gross_amount, stripe_fee, stripe_net, refund_amount, is_cancelled, is_no_show, payment_status");
      if (rowsErr) throw rowsErr;

      let totalGross = 0;
      let totalFees  = 0;
      let totalNet   = 0;
      let totalRefunds = 0;
      const byVehicle  = {};

      for (const r of (rows || [])) {
        if (r.is_cancelled || r.is_no_show) continue;
        const gross   = Number(r.gross_amount  || 0);
        const fee     = r.stripe_fee != null ? Number(r.stripe_fee) : 0;
        // Net after fees only; refunds tracked separately (net_after_refunds = net − refunds).
        const net     = gross - fee;
        const refund  = Number(r.refund_amount || 0);

        totalGross   += gross;
        totalFees    += fee;
        totalNet     += net;
        totalRefunds += refund;

        const vid = r.vehicle_id || "unknown";
        if (!byVehicle[vid]) byVehicle[vid] = { vehicle_id: vid, gross: 0, fees: 0, net: 0, refunds: 0, count: 0 };
        byVehicle[vid].gross   += gross;
        byVehicle[vid].fees    += fee;
        byVehicle[vid].net     += net;
        byVehicle[vid].refunds += refund;
        byVehicle[vid].count   += 1;
      }

      const round = (n) => Math.round(n * 100) / 100;
      return res.status(200).json({
        total_gross:   round(totalGross),
        total_fees:    round(totalFees),
        total_net:     round(totalNet),
        total_refunds: round(totalRefunds),
        net_after_refunds: round(totalNet - totalRefunds),
        by_vehicle: Object.values(byVehicle)
          .map((v) => ({ ...v, gross: round(v.gross), fees: round(v.fees), net: round(v.net), refunds: round(v.refunds) }))
          .sort((a, b) => b.net - a.net),
        record_count: (rows || []).length,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-revenue error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
});
