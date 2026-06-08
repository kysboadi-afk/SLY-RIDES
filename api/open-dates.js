// api/open-dates.js
// Vercel serverless function — removes a blocked date range from booked-dates.json
// so that previously unavailable dates become bookable again (e.g. after a cancellation).
//
// Required environment variables:
//   GITHUB_TOKEN  — personal access token with contents:write on the repo
//   ADMIN_SECRET  — a secret string the caller must supply to authorise the request
//
// Request body (JSON):
//   {
//     "secret":    "<ADMIN_SECRET value>",
//     "vehicleId": "camry" | "camry2013",
//     "from":      "YYYY-MM-DD",
//     "to":        "YYYY-MM-DD"
//   }
//
// The endpoint removes every stored range whose [from, to] overlaps the
// requested range.

import { adminErrorMessage } from "./_error-helpers.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { extractAdminSecret, isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Guard: ADMIN_SECRET must be configured
  if (!isAdminConfigured()) {
    console.error("ADMIN_SECRET environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  // Guard: GITHUB_TOKEN must be configured to write the file
  // (Phase 4: JSON write disabled, guard kept for compatibility but no longer blocks)

  const { vehicleId, from, to } = req.body || {};
  const suppliedAdminCredential = extractAdminSecret(req);

  // Authenticate the caller
  if (!isAdminAuthorized(suppliedAdminCredential)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const normalizedVehicleId = typeof vehicleId === "string" ? vehicleId.trim() : "";
  const allVehiclesRequested = normalizedVehicleId === "__all__" || normalizedVehicleId === "*" || normalizedVehicleId.toLowerCase() === "all";

  // Validate inputs
  if (!allVehiclesRequested && !normalizedVehicleId) {
    return res.status(400).json({ error: "vehicleId is required" });
  }
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!allVehiclesRequested && !from) {
    return res.status(400).json({ error: "from must be a date in YYYY-MM-DD format" });
  }
  if (!allVehiclesRequested && !to) {
    return res.status(400).json({ error: "to must be a date in YYYY-MM-DD format" });
  }
  if (from && !ISO_DATE.test(from)) {
    return res.status(400).json({ error: "from must be a date in YYYY-MM-DD format" });
  }
  if (to && !ISO_DATE.test(to)) {
    return res.status(400).json({ error: "to must be a date in YYYY-MM-DD format" });
  }
  const normalizedFrom = from || "1900-01-01";
  const normalizedTo = to || "2999-12-31";
  if (!ISO_DATE.test(normalizedFrom) || !ISO_DATE.test(normalizedTo)) {
    return res.status(400).json({ error: "from/to must be dates in YYYY-MM-DD format" });
  }
  if (normalizedFrom > normalizedTo) {
    return res.status(400).json({ error: "from must not be after to" });
  }

  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  // The JSON load/save infrastructure is removed; Supabase is written directly.
  try {
    let removed = 0;
    let locked = 0;
    try {
      const sb = getSupabaseAdmin();
      if (sb) {
        let query = sb
          .from("blocked_dates")
          .delete();
        if (!allVehiclesRequested) {
          query = query.eq("vehicle_id", normalizedVehicleId);
        }
        const { data: removedRows, error: sbErr } = await query
          .lte("start_date", normalizedTo)
          .gte("end_date", normalizedFrom)
          .select("id");
        if (sbErr) {
          console.warn("open-dates: Supabase delete failed (non-fatal):", sbErr.message);
        } else {
          removed = Array.isArray(removedRows) ? removedRows.length : 0;
        }
      }
    } catch (sbErr) {
      console.warn("open-dates: Supabase sync failed (non-fatal):", sbErr.message);
    }

    return res.status(200).json({ success: true, removed, locked });
  } catch (err) {
    console.error("open-dates endpoint error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
