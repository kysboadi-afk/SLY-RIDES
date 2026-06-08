// api/v2-mileage.js
// SLYTRANS Fleet Control v2 — Bouncie mileage management endpoint.
//
// POST /api/v2-mileage
// Body: { secret, action, ...params }
//
// Actions:
//   get            — fetch mileage + AI stats for all Bouncie-tracked vehicles
//   sync           — trigger an on-demand Bouncie pull (same as bouncie-sync cron)
//   update_service — record that a specific service was performed at current mileage
//                    Body: { vehicleId, serviceType: "oil"|"brakes"|"tires", mileage? }
//                    When serviceType is omitted, all three service records are updated
//                    (backward-compatible behaviour).
//   driver_report  — per-driver mileage summary aggregated from the trips table
//                    Body: { start_date?, end_date?, driver_phone? }
//                    Returns: [{ driver_name, driver_phone, total_miles, trip_count,
//                                vehicle_ids, last_trip_at }]

import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { getBouncieVehicles, loadTrackedVehicles, updateVehicleMileage } from "./_bouncie.js";
import { analyzeMileage } from "../lib/ai/mileage.js";
import { adminErrorMessage } from "./_error-helpers.js";

export const config = {
  runtime: "nodejs",
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

// Maps serviceType param → DB column and JSONB keys
const SERVICE_COLUMNS = {
  oil:    { col: "last_oil_change_mileage",   jsonKey: "last_oil_change_mileage",  recordedAtJsonKey: "last_oil_change_recorded_at" },
  brakes: { col: "last_brake_check_mileage",  jsonKey: "last_brake_check_mileage", recordedAtJsonKey: "last_brake_check_recorded_at" },
  tires:  { col: "last_tire_change_mileage",  jsonKey: "last_tire_change_mileage", recordedAtJsonKey: "last_tire_change_recorded_at" },
};

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body = req.body || {};
  if (!isAdminAuthorized(body.secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase is not configured" });
  }

  const { action = "get" } = body;

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (action === "get") {
      const [{ data: vehicleRows }, { data: tripRows }] = await Promise.all([
        sb.from("vehicles")
          .select("vehicle_id, mileage, last_synced_at, bouncie_device_id, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
          .not("bouncie_device_id", "is", null)
          .order("vehicle_id"),
        sb.from("trip_log")
          .select("vehicle_id, trip_distance, trip_at")
          .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      ]);

      const mileageData = (vehicleRows || [])
        .filter((r) => {
          const type = r.data?.type || r.data?.vehicle_type || "";
          return true;
        })
        .map((r) => ({
          vehicle_id:               r.vehicle_id,
          vehicle_name:             r.data?.vehicle_name || r.vehicle_id,
          total_mileage:            Number(r.mileage) || 0,
          last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
          last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
          last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
          maintenance_mileage_alert_miles: Number(r.data?.maintenance_mileage_alert_miles) || null,
          maintenance_brakes_interval_miles: Number(r.data?.maintenance_brakes_interval_miles) || null,
          maintenance_tires_interval_miles: Number(r.data?.maintenance_tires_interval_miles) || null,
          last_service_mileage:     Number(r.data?.last_service_mileage) || 0,
          bouncie_device_id:        r.bouncie_device_id,
          last_synced_at:           r.last_synced_at,
        }));

      const { alerts, stats } = analyzeMileage(mileageData, tripRows || []);

      return res.status(200).json({
        stats,
        alerts,
        bouncie_configured: true,
      });
    }

    // ── SYNC ─────────────────────────────────────────────────────────────────
    if (action === "sync") {
      const startedAt = Date.now();

      // Fetch tracked vehicles from DB and live data from Bouncie in parallel.
      // `getBouncieVehicles()` makes an external HTTP request and may throw when
      // the API key is invalid or the Bouncie API is unreachable.  Catch that
      // failure separately so we can surface a clear, actionable message to the
      // admin instead of a generic 500.
      let trackedVehicles, bouncieVehicles;
      try {
        [trackedVehicles, bouncieVehicles] = await Promise.all([
          loadTrackedVehicles(sb),
          getBouncieVehicles(),
        ]);
      } catch (bouncieErr) {
        console.error("v2-mileage sync: Bouncie/DB fetch failed:", bouncieErr.message);
        return res.status(200).json({
          bouncie_error: true,
          skipped:       true,
          reason:        adminErrorMessage(bouncieErr),
          duration_ms:   Date.now() - startedAt,
        });
      }

      const imeiMap = {};
      for (const v of trackedVehicles) {
        if (v.bouncie_device_id) imeiMap[v.bouncie_device_id] = v;
      }

      const synced = [];
      const errors = [];

      for (const bv of bouncieVehicles) {
        const { imei, stats } = bv;
        if (!imei || !stats?.odometer) continue;
        const tracked = imeiMap[imei];
        if (!tracked) continue;

        try {
          await updateVehicleMileage(
            sb, tracked.vehicle_id, stats.odometer,
            stats.lastUpdated ?? null
          );
          synced.push({ vehicleId: tracked.vehicle_id, imei, odometer: stats.odometer });
        } catch (err) {
          errors.push(`${tracked.vehicle_id}: ${err.message}`);
        }
      }

      return res.status(200).json({
        synced_count: synced.length,
        duration_ms:  Date.now() - startedAt,
        synced,
        errors,
      });
    }

    // ── UPDATE SERVICE ────────────────────────────────────────────────────────
    if (action === "update_service") {
      const { vehicleId, serviceType, mileage: serviceMileageParam } = body;
      if (!vehicleId) return res.status(400).json({ error: "vehicleId is required" });

      // Validate serviceType when provided
      if (serviceType && !SERVICE_COLUMNS[serviceType]) {
        return res.status(400).json({ error: `serviceType must be one of: ${Object.keys(SERVICE_COLUMNS).join(", ")}` });
      }

      // Resolve the mileage to record (default to current odometer)
      let serviceMileage;
      if (serviceMileageParam !== undefined && serviceMileageParam !== null) {
        serviceMileage = Number(serviceMileageParam);
        if (isNaN(serviceMileage) || serviceMileage < 0) {
          return res.status(400).json({ error: "mileage must be a non-negative number" });
        }
      } else {
        const { data: row } = await sb
          .from("vehicles")
          .select("mileage")
          .eq("vehicle_id", vehicleId)
          .maybeSingle();
        serviceMileage = Number(row?.mileage) || 0;
      }

      // Fetch existing vehicle data for JSONB merge
      const { data: existing } = await sb
        .from("vehicles")
        .select("data")
        .eq("vehicle_id", vehicleId)
        .maybeSingle();

      if (!existing) return res.status(404).json({ error: `Vehicle "${vehicleId}" not found` });

      // Determine which columns to update
      const colUpdates = {};
      const jsonUpdates = {};
      const recordedAtIso = new Date().toISOString();

      if (serviceType) {
        // Update only the requested service type
        const { col, jsonKey, recordedAtJsonKey } = SERVICE_COLUMNS[serviceType];
        colUpdates[col]               = serviceMileage;
        jsonUpdates[jsonKey]          = serviceMileage;
        jsonUpdates[recordedAtJsonKey] = recordedAtIso;
      } else {
        // Legacy: no serviceType specified — update all three (and old combined field)
        for (const { col, jsonKey, recordedAtJsonKey } of Object.values(SERVICE_COLUMNS)) {
          colUpdates[col]                = serviceMileage;
          jsonUpdates[jsonKey]           = serviceMileage;
          jsonUpdates[recordedAtJsonKey] = recordedAtIso;
        }
        jsonUpdates.last_service_mileage = serviceMileage;  // keep legacy key in sync
      }

      const updatedData = { ...(existing.data || {}), ...jsonUpdates };

      const { error } = await sb
        .from("vehicles")
        .update({
          ...colUpdates,
          data:       updatedData,
          updated_at: new Date().toISOString(),
        })
        .eq("vehicle_id", vehicleId);

      if (error) throw new Error(`Supabase update failed: ${error.message}`);

      // Log to maintenance_history (non-fatal — don't fail the whole request)
      const historyTypes = serviceType
        ? [serviceType]
        : Object.keys(SERVICE_COLUMNS);
      for (const svcType of historyTypes) {
        sb.from("maintenance_history")
          .insert({ vehicle_id: vehicleId, service_type: svcType, mileage: serviceMileage })
          .then(() => {})
          .catch((err) => console.warn(`v2-mileage: maintenance_history insert failed (${svcType}):`, err.message));
      }

      return res.status(200).json({
        success:      true,
        vehicleId,
        serviceType:  serviceType || "all",
        service_mileage: serviceMileage,
        service_recorded_at: recordedAtIso,
      });
    }

    // ── DRIVER REPORT ─────────────────────────────────────────────────────────
    if (action === "driver_report") {
      // Normalize a phone string to a canonical 10-digit form (US) so that
      // "+15303285561" and "5303285561" are treated as the same driver.
      const normalizePhone = (phone) => {
        if (!phone) return null;
        const digits = String(phone).replace(/\D/g, "");
        if (digits.length === 0) return null;
        return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
      };

      const { start_date, end_date, driver_phone: filterPhone } = body;

      // Default lookback window — 30 days when no dates provided
      const DEFAULT_REPORT_DAYS = 30;
      const endTs   = end_date   ? new Date(end_date   + "T23:59:59Z") : new Date();
      const startTs = start_date ? new Date(start_date + "T00:00:00Z") : new Date(endTs.getTime() - DEFAULT_REPORT_DAYS * 86400_000);

      if (isNaN(startTs.getTime()) || isNaN(endTs.getTime())) {
        return res.status(400).json({ error: "Invalid start_date or end_date — use YYYY-MM-DD format" });
      }
      if (endTs < startTs) {
        return res.status(400).json({ error: "end_date must be on or after start_date" });
      }

      // ── 1. Query trips rows in the date window ──────────────────────────────
      // Include booking_id so we can cross-reference active-booking list below.
      let tripsQuery = sb
        .from("trips")
        .select("driver_name, driver_phone, vehicle_id, booking_id, distance, start_mileage, end_mileage, created_at")
        .gte("created_at", startTs.toISOString())
        .lte("created_at", endTs.toISOString())
        .order("created_at", { ascending: false });

      if (filterPhone) {
        tripsQuery = tripsQuery.eq("driver_phone", String(filterPhone).trim());
      }

      const { data: tripRows, error: tripErr } = await tripsQuery;
      if (tripErr) throw new Error(`Supabase trips query failed: ${tripErr.message}`);

      // ── 2. Load currently active bookings ───────────────────────────────────
      // These drivers may have a placeholder trips row (end_mileage=null) created
      // on activation, OR they may have no trips row at all (pre-deployment).
      // Either way we need live vehicle odometer to compute current miles.
      let activeBookingsQuery = sb
        .from("bookings")
        .select("booking_ref, vehicle_id, customer_name, customer_phone, activated_at");
      activeBookingsQuery = activeBookingsQuery.in("status", ["active", "active_rental"]);
      if (filterPhone) {
        activeBookingsQuery = activeBookingsQuery.eq("customer_phone", String(filterPhone).trim());
      }
      const { data: activeBookings } = await activeBookingsQuery;

      // ── 3. Fetch current odometer for all vehicles with active rentals ───────
      const activeVehicleIds = [...new Set(
        (activeBookings || []).map((b) => b.vehicle_id).filter(Boolean)
      )];
      const vehicleOdoMap = {};
      if (activeVehicleIds.length > 0) {
        const { data: vRows } = await sb
          .from("vehicles")
          .select("vehicle_id, mileage")
          .in("vehicle_id", activeVehicleIds);
        for (const v of vRows || []) {
          vehicleOdoMap[v.vehicle_id] = Number(v.mileage) || 0;
        }
      }

      // Set of booking_refs covered by active bookings (for fast lookup)
      const activeBookingRefs = new Set(
        (activeBookings || []).map((b) => b.booking_ref).filter(Boolean)
      );
      // Set of booking_ids already present in our trips query result
      const tripBookingIds = new Set(
        (tripRows || []).map((r) => r.booking_id).filter(Boolean)
      );

      // ── 4. Aggregate per driver ─────────────────────────────────────────────
      const driverMap = {};

      for (const row of tripRows || []) {
        const isActive = activeBookingRefs.has(row.booking_id) && row.end_mileage == null;

        let miles;
        if (row.distance != null) {
          miles = Number(row.distance);
        } else if (row.end_mileage != null && row.start_mileage != null) {
          miles = Math.max(0, Number(row.end_mileage) - Number(row.start_mileage));
        } else if (isActive && row.start_mileage != null) {
          // In-progress rental: compute live miles as current_odometer − start_mileage.
          // Subtract a 10-mile tolerance buffer to absorb Bouncie sync delay and
          // prevent early false triggers for high-usage renters.
          const currentOdo = vehicleOdoMap[row.vehicle_id] || 0;
          miles = Math.max(0, currentOdo - Number(row.start_mileage) - 10);
        } else {
          miles = 0;
        }

        const normPhone = normalizePhone(row.driver_phone);
        const key = normPhone || row.driver_name || "unknown";
        if (!driverMap[key]) {
          driverMap[key] = {
            driver_name:   row.driver_name  || null,
            driver_phone:  normPhone || null,
            total_miles:   0,
            trip_count:    0,
            vehicle_ids:   new Set(),
            last_trip_at:  null,
            is_active:     false,
            miles_live:    false, // true when at least one in-progress trip was estimated
          };
        }
        const entry = driverMap[key];
        entry.total_miles  += miles;
        entry.trip_count   += 1;
        // Backfill missing driver name if this row has one
        if (!entry.driver_name && row.driver_name) entry.driver_name = row.driver_name;
        if (row.vehicle_id) entry.vehicle_ids.add(row.vehicle_id);
        if (!entry.last_trip_at || row.created_at > entry.last_trip_at) {
          entry.last_trip_at = row.created_at;
        }
        if (isActive) {
          entry.is_active = true;
          if (row.start_mileage != null && row.distance == null) entry.miles_live = true;
        }
      }

      // ── 5. Add active bookings with no trips row yet ────────────────────────
      // Drivers who were in a rental before this feature was deployed won't have
      // a trips row.  Surface them so they are visible and mark them active.
      for (const ab of activeBookings || []) {
        if (tripBookingIds.has(ab.booking_ref)) continue; // already in driverMap via trips

        const normPhone = normalizePhone(ab.customer_phone);
        const key = normPhone || ab.customer_name || "unknown";
        if (!driverMap[key]) {
          driverMap[key] = {
            driver_name:  ab.customer_name  || null,
            driver_phone: normPhone || null,
            total_miles:  0,
            trip_count:   0,
            vehicle_ids:  new Set(),
            last_trip_at: ab.activated_at || null,
            is_active:    true,
            miles_live:   false, // start odometer unknown — can't compute live miles
          };
        }
        const entry = driverMap[key];
        entry.is_active = true;
        // Backfill missing driver name from the booking's customer name
        if (!entry.driver_name && ab.customer_name) entry.driver_name = ab.customer_name;
        if (ab.vehicle_id) entry.vehicle_ids.add(ab.vehicle_id);
        if (!entry.last_trip_at || (ab.activated_at && ab.activated_at > entry.last_trip_at)) {
          entry.last_trip_at = ab.activated_at || null;
        }
      }

      // ── 6. Serialize and sort: active drivers first, then by miles desc ──────
      const drivers = Object.values(driverMap)
        .map((d) => ({
          driver_name:  d.driver_name,
          driver_phone: d.driver_phone,
          total_miles:  Math.round(d.total_miles * 10) / 10,
          trip_count:   d.trip_count,
          vehicle_ids:  Array.from(d.vehicle_ids),
          last_trip_at: d.last_trip_at,
          is_active:    d.is_active,
          miles_live:   d.miles_live,
        }))
        .sort((a, b) => {
          if (a.is_active !== b.is_active) return a.is_active ? -1 : 1; // active first
          return b.total_miles - a.total_miles;
        });

      return res.status(200).json({
        drivers,
        start_date:    startTs.toISOString().slice(0, 10),
        end_date:      endTs.toISOString().slice(0, 10),
        total_drivers: drivers.length,
        active_count:  drivers.filter((d) => d.is_active).length,
        total_trips:   drivers.reduce((s, d) => s + d.trip_count, 0),
        total_miles:   Math.round(drivers.reduce((s, d) => s + d.total_miles, 0) * 10) / 10,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-mileage error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
