// api/v2-vehicles.js
// SLYTRANS FLEET CONTROL v2 — Vehicles CRUD endpoint.
// Supports listing, creating, and updating vehicle data stored in Supabase.
// Falls back to GitHub vehicles.json when Supabase is not configured or the
// vehicles table does not yet exist — consistent with all other v2 endpoints.
//
// GET  /api/v2-vehicles
//   Returns an array of vehicle objects: [{ vehicle_id, ...data }, ...]
//   cover_image paths are normalized to root-relative form (/images/...)
//
// POST /api/v2-vehicles
// Actions:
//   list   — { secret, action:"list" }
//   create — { secret, action:"create", vehicleId, vehicleName, type?, vehicleYear?, purchasePrice?, purchaseDate?, status? }
//   update — { secret, action:"update", vehicleId, updates:{...} }

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { loadVehicles, saveVehicles } from "./_vehicles.js";
import { isSchemaError, adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { uiVehicleId } from "./_vehicle-id.js";

const ALLOWED_ORIGINS       = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com", "https://sly-rides.vercel.app"];
const ALLOWED_STATUSES      = ["active", "maintenance", "inactive"];
const ALLOWED_TYPES         = ["car", "economy", "luxury", "suv", "truck", "van", "other"];
// category is the single authoritative field that controls which page a vehicle
// appears on. Only the car category is accepted.
const ALLOWED_CATEGORIES    = ["car"];
const MAX_VEHICLE_NAME_LEN  = 200;
const MAX_PURCHASE_DATE_LEN = 20;
const DEFAULT_MAINTENANCE_MILEAGE_ALERT_MILES = 3000;

// vehicleId must be 2–50 lowercase letters, digits, hyphens, or underscores.
const VEHICLE_ID_RE = /^[a-z0-9_-]{2,50}$/;

// Bouncie IMEI: 15-digit numeric string, or empty string (to clear the mapping)
const BOUNCIE_IMEI_RE = /^\d{15}$/;

function parseMaintenanceMileageAlertMiles(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_MAINTENANCE_MILEAGE_ALERT_MILES;
  }
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}


function deriveCategory() {
  return "car";
}

function enforceVehicleCategoryInvariant({ updates = null } = {}) {
  const next = { ...(updates || {}) };
  if (Object.prototype.hasOwnProperty.call(next, "category")) next.category = "car";
  return next;
}

// Normalize image paths to root-relative form so browsers can resolve
// them correctly regardless of the page's location in the site hierarchy.
// e.g. "../images/car2.jpg" → "/images/car2.jpg"
//      "images/car2.jpg"    → "/images/car2.jpg"
//      "/images/car2.jpg"   → "/images/car2.jpg"  (unchanged)
//      "https://..."        → "https://..."        (unchanged)
function normalizeImagePath(val) {
  if (!val || typeof val !== "string") return val;
  if (val.startsWith("http://") || val.startsWith("https://") || val.startsWith("/")) return val;
  // Strip any leading "../" segments then prepend "/"
  return "/" + val.replace(/^(\.\.\/)+/, "");
}

// Keep the old name as an alias so existing callers continue to work.
const normalizeCoverImage = normalizeImagePath;

// Normalize all gallery_images entries in a vehicle object to root-relative form.
function normalizeGalleryImages(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr.map(normalizeImagePath);
}

function vehicleCompletenessScore(v = {}) {
  let score = 0;
  const id = String(v.vehicle_id || "").trim();
  const name = String(v.vehicle_name || "").trim();
  if (name) score += 1;
  if (name && id && name.toLowerCase() !== id.toLowerCase()) score += 3;
  if (v.cover_image) score += 2;
  if (v.bouncie_device_id) score += 2;
  if (Number(v.total_mileage) > 0) score += 1;
  if (v.last_synced_at) score += 1;
  if (Number(v.purchase_price) > 0) score += 1;
  return score;
}

function mergeVehicleRecords(existing, candidate) {
  if (!existing) return candidate;
  const existingScore = vehicleCompletenessScore(existing);
  const candidateScore = vehicleCompletenessScore(candidate);
  const candidateWins = candidateScore >= existingScore;
  const preferred = candidateWins ? candidate : existing;
  const fallback = candidateWins ? existing : candidate;
  return { ...fallback, ...preferred, vehicle_id: preferred.vehicle_id };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── GET — public listing (no secret required) ──────────────────────────────
  if (req.method === "GET") {
    // Prevent CDN/browser caches from serving stale vehicle lists after creation.
    res.setHeader("Cache-Control", "no-store");

    // Optional scope filter: ?scope=car → car-category vehicles only
    const scope = (req.query?.scope || "").toLowerCase();
    // Filtering is now entirely driven by the category field (derived via deriveCategory
    // when the field is absent) so bad type values can never cause cross-page leaks.
    function inScopeGET(category, type, vehicleId, vehicleName) {
      if (!scope) return true;
      const cat = deriveCategory(category, type, vehicleId, vehicleName);
      if (scope === "car" || scope === "cars") return cat === "car";
      return true;
    }
    const supabase = getSupabaseAdmin();
    if (supabase) {
      try {
        const [{ data: rows, error }, { data: pricingRows }] = await Promise.all([
          supabase.from("vehicles").select("*"),
          supabase.from("vehicle_pricing").select("vehicle_id, daily_price, weekly_price, biweekly_price, monthly_price"),
        ]);

        if (error) {
          console.error("Supabase error:", error);
          throw error;
        }

        // Build a lookup of the authoritative pricing keyed by UI vehicle ID
        const pricingById = {};
        for (const p of pricingRows || []) {
          const pid = uiVehicleId(p.vehicle_id) || p.vehicle_id;
          pricingById[pid] = p;
        }

        const vehiclesById = {};
        for (const row of rows || []) {
          // Only expose active vehicles publicly; treat missing status as active
          // for backward compatibility with records created before this field existed.
          const status = row.data?.status;
          if (status && status !== "active") continue;
          const type = row.data?.type || row.data?.vehicle_type || "";
          const rowCategory = row.data?.category || "";
          if (!inScopeGET(rowCategory, type, row.vehicle_id, row.data?.vehicle_name)) continue;

          const id = uiVehicleId(row.vehicle_id) || row.vehicle_id;
          const obj = {
            ...(row.data || {}),
            rental_status:             row.rental_status             || null,
            bouncie_device_id:         row.bouncie_device_id         || row.data?.bouncie_device_id || null,
            total_mileage:             Number(row.mileage)           || 0,
            last_synced_at:            row.last_synced_at            || null,
            last_oil_change_mileage:   row.last_oil_change_mileage   != null ? Number(row.last_oil_change_mileage)   : null,
            last_brake_check_mileage:  row.last_brake_check_mileage  != null ? Number(row.last_brake_check_mileage)  : null,
            last_tire_change_mileage:  row.last_tire_change_mileage  != null ? Number(row.last_tire_change_mileage)  : null,
            // tracked = true when a Bouncie IMEI is assigned (independent of rental status)
            tracked: !!(row.bouncie_device_id || row.data?.bouncie_device_id),
            vehicle_id: id,
            // Always expose a canonical category so frontend never has to guess
            category: deriveCategory(rowCategory, type, row.vehicle_id, row.data?.vehicle_name),
          };
          // Overlay vehicle_pricing table values so the booking page always
          // reflects the latest rates set via the Vehicle Pricing admin page.
          const p = pricingById[id];
          if (p) {
            if (p.daily_price    != null) obj.daily_price    = p.daily_price;
            if (p.weekly_price   != null) obj.weekly_price   = p.weekly_price;
            if (p.biweekly_price != null) obj.biweekly_price = p.biweekly_price;
            if (p.monthly_price  != null) obj.monthly_price  = p.monthly_price;
          }
          if (obj.cover_image) obj.cover_image = normalizeCoverImage(obj.cover_image);
          if (obj.gallery_images) obj.gallery_images = normalizeGalleryImages(obj.gallery_images);
          vehiclesById[id] = mergeVehicleRecords(vehiclesById[id], obj);
        }
        return res.status(200).json(Object.values(vehiclesById));
      } catch (err) {
        console.warn("v2-vehicles GET: Supabase threw, falling back to GitHub:", err.message);
      }
    }
    // GitHub fallback
    try {
      const { data: vehicles } = await loadVehicles();
      const resultById = {};
      for (const v of Object.values(vehicles)) {
        const status = v.status;
        if (status && status !== "active") continue;
        const type = v.type || "";
        if (!inScopeGET(v.category || "", type, v.vehicle_id, v.vehicle_name)) continue;
        const id = uiVehicleId(v.vehicle_id) || v.vehicle_id;
        let next = {
          ...v,
          vehicle_id: id,
          tracked: !!v.bouncie_device_id,
          category: deriveCategory(v.category || "", type, v.vehicle_id, v.vehicle_name),
        };
        if (next.cover_image) next = { ...next, cover_image: normalizeCoverImage(next.cover_image) };
        if (next.gallery_images) next = { ...next, gallery_images: normalizeGalleryImages(next.gallery_images) };
        resultById[id] = mergeVehicleRecords(resultById[id], next);
      }
      const result = Object.values(resultById);
      return res.status(200).json(result);
    } catch (err) {
      console.error("v2-vehicles GET GitHub fallback error:", err);
      return res.status(500).json({ error: adminErrorMessage(err) });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).send("Method Not Allowed");
  }

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body   = req.body || {};
  const { secret, action } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabase = getSupabaseAdmin();
  // Note: supabase may be null here — all actions below have GitHub fallbacks.

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (action === "list" || !action) {
      // scope: "car" → category=car vehicles only; omit → all
      const scope = (body.scope || "").toLowerCase();
      const scopeFilter = (category, type, vehicleId, vehicleName) => {
        if (!scope) return true;
        const cat = deriveCategory(category, type, vehicleId, vehicleName);
        if (scope === "car" || scope === "cars") return cat === "car";
        return true;
      };

      if (supabase) {
        const [{ data: rows, error }, { data: pricingRows }] = await Promise.all([
          supabase.from("vehicles").select("vehicle_id, data, bouncie_device_id, mileage, last_synced_at, updated_at, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage"),
          supabase.from("vehicle_pricing").select("vehicle_id, daily_price, weekly_price, biweekly_price, monthly_price"),
        ]);

        if (!error) {
          // Build a lookup of the authoritative pricing keyed by UI vehicle ID
          const pricingById = {};
          for (const p of pricingRows || []) {
            const pid = uiVehicleId(p.vehicle_id) || p.vehicle_id;
            pricingById[pid] = p;
          }

          const vehicles = {};
          const serviceTimestampBackfills = [];
          for (const row of rows || []) {
            const type = row.data?.type || row.data?.vehicle_type || "";
            const rowCategory = row.data?.category || "";
            if (!scopeFilter(rowCategory, type, row.vehicle_id, row.data?.vehicle_name)) continue;
            const id = uiVehicleId(row.vehicle_id) || row.vehicle_id;
            const baseData = { ...(row.data || {}) };
            const fallbackRecordedAt = row.last_synced_at || row.updated_at || new Date().toISOString();
            const backfilledData = { ...baseData };
            let needsServiceTimestampBackfill = false;
            for (const { mileageCol, jsonMileageKey, recordedAtKey } of [
              { mileageCol: "last_oil_change_mileage", jsonMileageKey: "last_oil_change_mileage", recordedAtKey: "last_oil_change_recorded_at" },
              { mileageCol: "last_brake_check_mileage", jsonMileageKey: "last_brake_check_mileage", recordedAtKey: "last_brake_check_recorded_at" },
              { mileageCol: "last_tire_change_mileage", jsonMileageKey: "last_tire_change_mileage", recordedAtKey: "last_tire_change_recorded_at" },
            ]) {
              const hasMileage =
                row[mileageCol] != null
                || (backfilledData[jsonMileageKey] != null && backfilledData[jsonMileageKey] !== "");
              const hasRecordedAt =
                typeof backfilledData[recordedAtKey] === "string"
                && backfilledData[recordedAtKey].trim().length > 0;
              if (hasMileage && !hasRecordedAt) {
                backfilledData[recordedAtKey] = fallbackRecordedAt;
                needsServiceTimestampBackfill = true;
              }
            }
            if (needsServiceTimestampBackfill) {
              serviceTimestampBackfills.push({
                vehicle_id: row.vehicle_id,
                data: backfilledData,
              });
            }
            const next = {
              ...backfilledData,
              bouncie_device_id:        row.bouncie_device_id        || row.data?.bouncie_device_id || null,
              total_mileage:            Number(row.mileage)          || 0,
              last_synced_at:           row.last_synced_at           || null,
              last_oil_change_mileage:  row.last_oil_change_mileage  != null ? Number(row.last_oil_change_mileage)  : null,
              last_brake_check_mileage: row.last_brake_check_mileage != null ? Number(row.last_brake_check_mileage) : null,
              last_tire_change_mileage: row.last_tire_change_mileage != null ? Number(row.last_tire_change_mileage) : null,
              tracked: !!(row.bouncie_device_id || row.data?.bouncie_device_id),
              vehicle_id: id,
              category: deriveCategory(rowCategory, type, row.vehicle_id, row.data?.vehicle_name),
            };
            // Overlay vehicle_pricing table values so the admin cache and booking
            // page always reflect the latest rates from the Vehicle Pricing admin.
            const p = pricingById[id];
            if (p) {
              if (p.daily_price    != null) next.daily_price    = p.daily_price;
              if (p.weekly_price   != null) next.weekly_price   = p.weekly_price;
              if (p.biweekly_price != null) next.biweekly_price = p.biweekly_price;
              if (p.monthly_price  != null) next.monthly_price  = p.monthly_price;
            }
            if (next.cover_image) next.cover_image = normalizeCoverImage(next.cover_image);
            if (next.gallery_images) next.gallery_images = normalizeGalleryImages(next.gallery_images);
            vehicles[id] = mergeVehicleRecords(vehicles[id], next);
          }
          if (serviceTimestampBackfills.length > 0) {
            await Promise.all(serviceTimestampBackfills.map(async (entry) => {
              const { error: backfillErr } = await supabase
                .from("vehicles")
                .update({
                  data: entry.data,
                  updated_at: new Date().toISOString(),
                })
                .eq("vehicle_id", entry.vehicle_id);
              if (backfillErr) {
                console.warn(`v2-vehicles list: failed service timestamp backfill for ${entry.vehicle_id}:`, backfillErr.message);
              }
            }));
          }
          return res.status(200).json({ vehicles });
        }
        // Schema error or other Supabase error → fall back to GitHub
        console.warn("v2-vehicles list: Supabase error, falling back to GitHub:", error.message);
      }
      // GitHub fallback
      const { data: rawVehicles } = await loadVehicles();
      const vehicles = {};
      for (const [id, v] of Object.entries(rawVehicles)) {
        const type = v.type || "";
        if (!scopeFilter(v.category || "", type, v.vehicle_id || id, v.vehicle_name)) continue;
        const uiId = uiVehicleId(v.vehicle_id || id) || (v.vehicle_id || id);
        let next = {
          ...v,
          vehicle_id: uiId,
          tracked: !!v.bouncie_device_id,
          category: deriveCategory(v.category || "", type, v.vehicle_id || id, v.vehicle_name),
        };
        if (next.cover_image) next = { ...next, cover_image: normalizeCoverImage(next.cover_image) };
        if (next.gallery_images) next = { ...next, gallery_images: normalizeGalleryImages(next.gallery_images) };
        vehicles[uiId] = mergeVehicleRecords(vehicles[uiId], next);
      }
      return res.status(200).json({ vehicles });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      const { vehicleId, updates } = body;

      if (!vehicleId || !VEHICLE_ID_RE.test(vehicleId)) {
        return res.status(400).json({ error: "Invalid or missing vehicleId" });
      }
      if (!updates || typeof updates !== "object") {
        return res.status(400).json({ error: "updates object is required" });
      }

      // Validate and build safe updates
      const safeUpdates = {};
      const allowedUpdateFields = [
        "purchase_price", "purchase_date", "status",
        "vehicle_name", "vehicle_year", "type", "category", "cover_image", "gallery_images",
        "bouncie_device_id", "vin", "scarcity_text", "make",
        "earnings_tagline", "earnings_title", "earnings_row1", "earnings_cta",
      ];
      for (const f of allowedUpdateFields) {
        if (Object.prototype.hasOwnProperty.call(updates, f)) {
          const val = updates[f];
          if (f === "status" && !ALLOWED_STATUSES.includes(val)) {
            return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(", ")}` });
          }
          if (f === "type" && val && !ALLOWED_TYPES.includes(val)) {
            return res.status(400).json({ error: `type must be one of: ${ALLOWED_TYPES.join(", ")}` });
          }
          if (f === "category" && val && !ALLOWED_CATEGORIES.includes((val || "").toLowerCase())) {
            return res.status(400).json({ error: `category must be one of: ${ALLOWED_CATEGORIES.join(", ")}` });
          }
          if (f === "purchase_price" || f === "vehicle_year") {
            const n = Number(val);
            if (isNaN(n) || n < 0) {
              return res.status(400).json({ error: `${f} must be a non-negative number` });
            }
            safeUpdates[f] = Math.round(n * 100) / 100;
          } else if (f === "cover_image") {
            safeUpdates[f] = typeof val === "string" ? val.trim().slice(0, 500) : "";
          } else if (f === "gallery_images") {
            if (!Array.isArray(val)) {
              return res.status(400).json({ error: "gallery_images must be an array of URLs" });
            }
            if (val.length > 10) {
              return res.status(400).json({ error: "gallery_images: maximum 10 extra photos allowed" });
            }
            const safeGallery = [];
            for (const u of val) {
              if (typeof u !== "string") continue;
              const trimmed = u.trim().slice(0, 500);
              if (!trimmed) continue;
              if (!/^(https?:\/\/|\/images\/)/i.test(trimmed)) {
                return res.status(400).json({ error: "gallery_images: each URL must start with https://, http://, or /images/" });
              }
              safeGallery.push(trimmed);
            }
            safeUpdates[f] = safeGallery;
          } else if (f === "bouncie_device_id") {
            // Accept 15-digit IMEI or empty string (to remove mapping)
            const trimmed = typeof val === "string" ? val.trim() : "";
            if (trimmed !== "" && !BOUNCIE_IMEI_RE.test(trimmed)) {
              return res.status(400).json({ error: "bouncie_device_id must be a 15-digit IMEI or empty" });
            }
            safeUpdates[f] = trimmed || null;
          } else if (f === "category") {
            safeUpdates[f] = typeof val === "string" ? val.toLowerCase().trim() : val;
          } else if (["earnings_tagline", "earnings_title", "earnings_row1", "earnings_cta"].includes(f)) {
            safeUpdates[f] = typeof val === "string" ? val.trim().slice(0, 500) : (val || null);
          } else {
            safeUpdates[f] = typeof val === "string" ? val.trim().slice(0, 200) : val;
          }
        }
      }

      let normalizedUpdates = enforceVehicleCategoryInvariant({
        updates: safeUpdates,
        vehicleId,
        scope: body.scope,
      });

      if (supabase) {
        // Fetch existing row
        const { data: existing, error: fetchErr } = await supabase
          .from("vehicles")
          .select("data")
          .eq("vehicle_id", vehicleId)
          .maybeSingle();

        if (!fetchErr && existing) {
          normalizedUpdates = enforceVehicleCategoryInvariant({
            existingData: existing.data || {},
            updates: normalizedUpdates,
            vehicleId,
            scope: body.scope,
          });

          // Separate column-level fields from JSONB fields
          const { bouncie_device_id: newImei, ...jsonbUpdates } = normalizedUpdates;
          const updatedData = { ...existing.data, ...jsonbUpdates };

          // Build the upsert payload — include bouncie_device_id column if provided
          const upsertPayload = {
            vehicle_id:  vehicleId,
            data:        updatedData,
            updated_at:  new Date().toISOString(),
          };
          if (Object.prototype.hasOwnProperty.call(normalizedUpdates, "bouncie_device_id")) {
            upsertPayload.bouncie_device_id = newImei;
            // Automatically enable/disable tracking when IMEI is set/cleared
            upsertPayload.is_tracked = newImei !== null;
            // Mirror into JSONB too for the fallback path
            updatedData.bouncie_device_id = newImei;
          }

          const { data: upserted, error: upsertErr } = await supabase
            .from("vehicles")
            .upsert(upsertPayload, { onConflict: "vehicle_id" })
            .select("data, bouncie_device_id")
            .single();

          if (!upsertErr) {
            // Return the same shape as the list action so the frontend cache
            // always gets bouncie_device_id from the authoritative DB column.
            return res.status(200).json({
              success: true,
              vehicle: {
                ...(upserted.data || {}),
                bouncie_device_id: upserted.bouncie_device_id || null,
              },
            });
          }
          if (!isSchemaError(upsertErr)) throw new Error(`Supabase upsert failed: ${upsertErr.message}`);
          // Schema error on full upsert (e.g. bouncie_device_id column missing).
          // Retry with only data + updated_at so at least the JSONB fields are saved.
          const { data: upserted2, error: upsertErr2 } = await supabase
            .from("vehicles")
            .upsert(
              { vehicle_id: vehicleId, data: updatedData, updated_at: upsertPayload.updated_at },
              { onConflict: "vehicle_id" }
            )
            .select("data")
            .single();
          if (!upsertErr2) {
            return res.status(200).json({
              success: true,
              vehicle: { ...(upserted2.data || {}) },
            });
          }
          if (!isSchemaError(upsertErr2)) throw new Error(`Supabase upsert (retry) failed: ${upsertErr2.message}`);
          console.warn("v2-vehicles update: Supabase schema error on retry, falling back to GitHub:", upsertErr2.message);
        } else if (fetchErr && !isSchemaError(fetchErr)) {
          throw new Error(`Supabase fetch failed: ${fetchErr.message}`);
        } else if (!fetchErr && !existing) {
          // Vehicle not found in Supabase — fall back to GitHub check below
          console.warn("v2-vehicles update: vehicle not found in Supabase, falling back to GitHub");
        } else {
          console.warn("v2-vehicles update: Supabase schema error, falling back to GitHub:", fetchErr.message);
        }
      }

      // GitHub fallback
      const { data: ghVehicles, sha } = await loadVehicles();
      if (!ghVehicles[vehicleId]) {
        return res.status(404).json({ error: "Vehicle not found" });
      }
      normalizedUpdates = enforceVehicleCategoryInvariant({
        existingData: ghVehicles[vehicleId] || {},
        updates: normalizedUpdates,
        vehicleId,
        scope: body.scope,
      });
      let updatedVehicle;
      await updateJsonFileWithRetry({
        load:    loadVehicles,
        apply:   (data) => {
          if (!data[vehicleId]) return;
          data[vehicleId] = { ...data[vehicleId], ...normalizedUpdates };
          updatedVehicle = data[vehicleId];
        },
        save:    saveVehicles,
        message: `v2: Update vehicle ${vehicleId}: ${JSON.stringify(Object.keys(normalizedUpdates))}`,
      });
      return res.status(200).json({ success: true, vehicle: updatedVehicle });
    }

    // ── CREATE ──────────────────────────────────────────────────────────────
    if (action === "create") {
      const { vehicleId, vehicleName, type, category, vehicleYear, purchasePrice, purchaseDate, status, coverImage, galleryImages, bouncieDeviceId, vin, scarcityText, make, dailyRate, weeklyRate, biweeklyRate, monthlyRate, earningsTagline, earningsTitle, earningsRow1, earningsCta, hourlyTiers, maintenanceMileageAlertMiles } = body;

      if (!vehicleId || !VEHICLE_ID_RE.test(vehicleId)) {
        return res.status(400).json({ error: "vehicleId must be 2–50 lowercase letters, digits, hyphens, or underscores" });
      }
      if (!vehicleName || typeof vehicleName !== "string" || !vehicleName.trim()) {
        return res.status(400).json({ error: "vehicleName is required" });
      }

      const vehicleType = type || "economy";
      if (!ALLOWED_TYPES.includes(vehicleType)) {
        return res.status(400).json({ error: `type must be one of: ${ALLOWED_TYPES.join(", ")}` });
      }

      // category is required on create; derive from type when not provided for
      // backward compatibility but reject any explicitly invalid value.
      const rawCategory = (category || "").toLowerCase().trim();
      if (rawCategory && !ALLOWED_CATEGORIES.includes(rawCategory)) {
        return res.status(400).json({ error: `category must be one of: ${ALLOWED_CATEGORIES.join(", ")}` });
      }
      const vehicleCategory = rawCategory || deriveCategory("", vehicleType, vehicleId, vehicleName);

      const vehicleStatus = status || "active";
      if (!ALLOWED_STATUSES.includes(vehicleStatus)) {
        return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(", ")}` });
      }

      // Validate vehicleYear if provided
      if (vehicleYear !== undefined && vehicleYear !== null && vehicleYear !== "") {
        const yearNum = Number(vehicleYear);
        if (isNaN(yearNum) || yearNum < 0) {
          return res.status(400).json({ error: "vehicle_year must be a non-negative number" });
        }
      }

      // Validate purchasePrice if provided
      if (purchasePrice !== undefined && purchasePrice !== null && purchasePrice !== "") {
        const priceNum = Number(purchasePrice);
        if (isNaN(priceNum) || priceNum < 0) {
          return res.status(400).json({ error: "purchase_price must be a non-negative number" });
        }
      }

      // Validate bouncieDeviceId if provided
      let safeBouncieId = null;
      if (bouncieDeviceId !== undefined && bouncieDeviceId !== null && bouncieDeviceId !== "") {
        const trimmed = String(bouncieDeviceId).trim();
        if (!BOUNCIE_IMEI_RE.test(trimmed)) {
          return res.status(400).json({ error: "bouncieDeviceId must be a 15-digit IMEI" });
        }
        safeBouncieId = trimmed;
      }
      const parsedMaintenanceMileageAlertMiles = parseMaintenanceMileageAlertMiles(maintenanceMileageAlertMiles);
      if (parsedMaintenanceMileageAlertMiles == null) {
        return res.status(400).json({ error: "maintenanceMileageAlertMiles must be a positive number" });
      }

      // Parse pricing fields once so they can go into both the data blob and
      // the dedicated vehicle_pricing table (two sources stay in sync at creation).
      const parsedDaily    = dailyRate    ? Math.round(parseFloat(dailyRate)    * 100) / 100 : null;
      const parsedWeekly   = weeklyRate   ? Math.round(parseFloat(weeklyRate)   * 100) / 100 : null;
      const parsedBiweekly = biweeklyRate ? Math.round(parseFloat(biweeklyRate) * 100) / 100 : null;
      const parsedMonthly  = monthlyRate  ? Math.round(parseFloat(monthlyRate)  * 100) / 100 : null;

      // Build the new vehicle data object
      const newData = {
        vehicle_id:     vehicleId,
        vehicle_name:   vehicleName.trim().slice(0, MAX_VEHICLE_NAME_LEN),
        type:           vehicleType,
        category:       vehicleCategory,
        vehicle_year:   vehicleYear ? Math.round(Number(vehicleYear)) : null,
        purchase_price: purchasePrice ? Math.round(parseFloat(purchasePrice) * 100) / 100 : 0,
        purchase_date:  (purchaseDate && typeof purchaseDate === "string") ? purchaseDate.slice(0, MAX_PURCHASE_DATE_LEN) : "",
        status:         vehicleStatus,
        cover_image:    typeof coverImage === "string" ? coverImage.trim().slice(0, 500) : "",
        ...(Array.isArray(galleryImages) && galleryImages.length
          ? { gallery_images: galleryImages
              .filter(u => typeof u === "string" && u.trim() && /^(https?:\/\/|\/images\/)/i.test(u.trim()))
              .map(u => u.trim().slice(0, 500))
              .slice(0, 10) }
          : {}),
        ...(vin           ? { vin:           String(vin).trim().slice(0, 50) }         : {}),
        ...(scarcityText  ? { scarcity_text: String(scarcityText).trim().slice(0, 200) } : {}),
        ...(make          ? { make:          String(make).trim().slice(0, 100) }         : {}),
        ...(safeBouncieId ? { bouncie_device_id: safeBouncieId } : {}),
        ...(earningsTagline ? { earnings_tagline: String(earningsTagline).trim().slice(0, 500) } : {}),
        ...(earningsTitle   ? { earnings_title:   String(earningsTitle).trim().slice(0, 500) }   : {}),
        ...(earningsRow1    ? { earnings_row1:    String(earningsRow1).trim().slice(0, 500) }    : {}),
        ...(earningsCta     ? { earnings_cta:     String(earningsCta).trim().slice(0, 500) }     : {}),
        // Store pricing in the data blob so GET /api/v2-vehicles returns it and
        // the booking page (car.js) can display the correct rates immediately.
        ...(parsedDaily    ? { daily_price:    parsedDaily }    : {}),
        ...(parsedWeekly   ? { weekly_price:   parsedWeekly }   : {}),
        ...(parsedBiweekly ? { biweekly_price: parsedBiweekly } : {}),
        ...(parsedMonthly  ? { monthly_price:  parsedMonthly }  : {}),
        ...(hourlyTiers && typeof hourlyTiers === 'object' ? { hourlyTiers } : {}),
        maintenance_mileage_alert_miles: parsedMaintenanceMileageAlertMiles,
      };

      if (supabase) {
        // Check the vehicle doesn't already exist
        const { data: existing, error: fetchErr } = await supabase
          .from("vehicles")
          .select("vehicle_id")
          .eq("vehicle_id", vehicleId)
          .maybeSingle();

        if (!fetchErr) {
          if (existing) {
            return res.status(409).json({ error: `Vehicle "${vehicleId}" already exists` });
          }

          const { data: inserted, error: insertErr } = await supabase
            .from("vehicles")
            .insert({
              vehicle_id:        vehicleId,
              data:              newData,
              updated_at:        new Date().toISOString(),
              ...(safeBouncieId ? { bouncie_device_id: safeBouncieId, is_tracked: true } : {}),
            })
            .select("data, bouncie_device_id")
            .single();

          if (!insertErr) {
            // Upsert vehicle_pricing row if any rates were provided (use
            // pre-parsed values to avoid duplicating the parsing logic).
            // Always populate daily_price: derive from weekly when not explicitly
            // provided so that getVehiclePricing never fails for this vehicle.
            if (parsedDaily || parsedWeekly || parsedBiweekly || parsedMonthly) {
              const derivedDaily = parsedDaily ||
                (parsedWeekly ? Math.round(parsedWeekly / 7 * 100) / 100 : null);
              const pricingRow = {
                vehicle_id:     vehicleId,
                daily_price:    derivedDaily,
                weekly_price:   parsedWeekly,
                biweekly_price: parsedBiweekly,
                monthly_price:  parsedMonthly,
                updated_at:     new Date().toISOString(),
              };
              const { error: pricingErr } = await supabase
                .from("vehicle_pricing")
                .upsert(pricingRow, { onConflict: "vehicle_id" });
              if (pricingErr) {
                console.warn("v2-vehicles create: vehicle_pricing upsert failed:", pricingErr.message);
              }
            }

            // Sync vehicles.json before returning so that vehicles.json (the
            // canonical fleet source) stays in sync with Supabase.  If this
            // write fails the Supabase row is rolled back, ensuring the two
            // sources never diverge and phantom rows never accumulate.
            try {
              await updateJsonFileWithRetry({
                load:    loadVehicles,
                apply:   (data) => { if (!data[vehicleId]) data[vehicleId] = newData; },
                save:    saveVehicles,
                message: `v2: Add vehicle ${vehicleId} (${newData.vehicle_name})`,
              });
            } catch (syncErr) {
              console.error("v2-vehicles create: vehicles.json sync failed, rolling back Supabase row:", syncErr?.message);
              await supabase.from("vehicles").delete().eq("vehicle_id", vehicleId)
                .then(() => {}, (e) => console.warn(`v2-vehicles create: rollback delete failed for vehicle ${vehicleId}:`, e?.message));
              return res.status(500).json({ error: "Failed to sync vehicle configuration. Please try again." });
            }

            return res.status(201).json({
              success: true,
              vehicle: {
                ...(inserted.data || {}),
                bouncie_device_id: inserted.bouncie_device_id || null,
              },
            });
          }
          if (!isSchemaError(insertErr)) throw new Error(`Supabase insert failed: ${insertErr.message}`);
          console.warn("v2-vehicles create: Supabase schema error, falling back to GitHub:", insertErr.message);
        } else if (!isSchemaError(fetchErr)) {
          throw new Error(`Supabase fetch failed: ${fetchErr.message}`);
        } else {
          console.warn("v2-vehicles create: Supabase schema error on fetch, falling back to GitHub:", fetchErr.message);
        }
      }

      // GitHub fallback
      let createdVehicle;
      await updateJsonFileWithRetry({
        load:    loadVehicles,
        apply:   (data) => {
          if (data[vehicleId]) return; // idempotent — skip if already exists
          data[vehicleId] = newData;
          createdVehicle = newData;
        },
        save:    saveVehicles,
        message: `v2: Add vehicle ${vehicleId} (${newData.vehicle_name})`,
      });
      if (!createdVehicle) {
        return res.status(409).json({ error: `Vehicle "${vehicleId}" already exists` });
      }
      return res.status(201).json({ success: true, vehicle: createdVehicle });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-vehicles error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
