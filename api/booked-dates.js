// api/booked-dates.js
// Vercel serverless function — serves booked-dates.json merged with real-time
// Supabase booking data.
//
// When Supabase is configured, this endpoint merges date ranges from:
//   1. booked-dates.json  (GitHub)         — legacy static blocked ranges
//   2. Supabase bookings table             — active bookings (pickup/return dates)
//   3. Supabase blocked_dates table        — manual admin blocks / maintenance
//
// The merged result guarantees that any booking saved to Supabase immediately
// appears on the calendar, even before booked-dates.json is updated.
//
// When Supabase is not configured the endpoint falls back to reading only from
// booked-dates.json as before.
//
// GitHub Pages CDN caches static files for several minutes after a commit,
// so fetching booked-dates.json directly from the Pages URL gives stale data.
// This endpoint reads the file from the GitHub Contents API on every request
// so the calendar always reflects the latest blocked ranges immediately after
// a booking is confirmed.
//
// Optional environment variable:
//   GITHUB_TOKEN  — increases the GitHub API rate limit from 60 to 5 000
//                   requests/hour.  Not required but recommended.
//   GITHUB_REPO   — repo in "owner/name" format (defaults to kysboadi-afk/SLY-RIDES)

import { getSupabaseAdmin } from "./_supabase.js";

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
// Statuses that mean the vehicle is actually occupied / unavailable.
// "reserved" is a confirmed deposit/partial-payment reservation and must block.
const ACTIVE_STATUSES = ["reserved", "approved", "active", "booked_paid", "active_rental", "overdue"];

// Business timezone — must match fleet-status.js.
const BUSINESS_TZ = "America/Los_Angeles";

// Hours between a vehicle return and the earliest valid next pickup slot.
// Must match PICKUP_BUFFER_HOURS in car.js (frontend).
const PICKUP_BUFFER_HOURS = 2;

// Returns today's date in Los Angeles as "YYYY-MM-DD".
function getLADate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Returns the current Los Angeles time as minutes-since-midnight.
function getLAMinutes() {
  const now = new Date();
  const h = parseInt(now.toLocaleString("en-US", { timeZone: BUSINESS_TZ, hour: "2-digit", hour12: false }), 10);
  const m = parseInt(now.toLocaleString("en-US", { timeZone: BUSINESS_TZ, minute: "2-digit" }), 10);
  return h * 60 + m;
}

// Parse "HH:MM" into minutes-since-midnight.  Returns -1 on failure.
function timeStrToMinutes(t) {
  if (!t || typeof t !== "string") return -1;
  const parts = t.substring(0, 5).split(":");
  if (parts.length < 2) return -1;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
  return h * 60 + m;
}

// Convert a buffered end_time ("HH:MM" = return_time + PICKUP_BUFFER_HOURS) back
// to the raw return time so the frontend can apply its own buffer correctly.
// Returns null if the result would cross midnight (extremely rare with a 2-hour
// buffer; in that case the range is kept without a toTime and the frontend falls
// back to conservative full-day blocking).
function unbufferEndTime(endTime) {
  const totalMins = timeStrToMinutes(endTime);
  if (totalMins < 0) return null;
  const rawMins = totalMins - PICKUP_BUFFER_HOURS * 60;
  if (rawMins < 0) return null; // return was before midnight on this date — skip toTime
  const h = Math.floor(rawMins / 60);
  const m = rawMins % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

/**
 * Merge date ranges for a vehicle without adding duplicates.
 * @param {Array} existing  - array of {from, to[, toTime]} ranges already in the map
 * @param {string} from     - YYYY-MM-DD
 * @param {string} to       - YYYY-MM-DD
 * @param {string|null} [toTime] - "HH:MM" raw return time (frontend adds its own buffer)
 */
function mergeRange(existing, from, to, toTime) {
  if (!from || !to) return;
  // De-duplicate on {from, to, toTime} so that ranges with the same dates but
  // different time information (e.g. bookings vs blocked_dates) are kept
  // separately and the frontend can use whichever is most restrictive.
  const normToTime = toTime || null;
  const already = existing.some((r) => r.from === from && r.to === to && (r.toTime ?? null) === normToTime);
  if (!already) {
    const range = { from, to };
    if (toTime) range.toTime = toTime;
    existing.push(range);
  }
}

/**
 * Load active bookings from Supabase and add their date ranges to the map.
 * return_time is included as toTime so the frontend can block only the slots
 * before return_time + PICKUP_BUFFER_HOURS instead of the entire return day.
 * Non-fatal — returns without modifying the map on any error.
 */
async function mergeSupabaseBookings(sb, map) {
  try {
    const { data: rows, error } = await sb
      .from("bookings")
      .select("vehicle_id, pickup_date, return_date, return_time")
      .in("status", ACTIVE_STATUSES)
      .not("pickup_date", "is", null)
      .not("return_date", "is", null);

    if (error) {
      console.warn("booked-dates: Supabase bookings query error (non-fatal):", error.message);
      return;
    }
    for (const row of rows || []) {
      const vid = row.vehicle_id;
      if (!vid) continue;
      if (!map[vid]) map[vid] = [];
      const toTime = row.return_time ? String(row.return_time).substring(0, 5) : null;
      mergeRange(map[vid], row.pickup_date, row.return_date, toTime);
    }
  } catch (err) {
    console.warn("booked-dates: Supabase bookings merge error (non-fatal):", err.message);
  }
}

/**
 * Load blocked_dates from Supabase and add them to the map.
 * Expired entries (end_date < today, or end_date === today with end_time already
 * passed in LA time) are skipped so a vehicle that was returned earlier today
 * is not incorrectly blocked for the rest of the day.
 * end_time (already buffered = return_time + PICKUP_BUFFER_HOURS) is un-buffered
 * back to the raw return time so the frontend's own PICKUP_BUFFER_HOURS logic
 * produces the correct slot cutoff without double-counting the buffer.
 * Non-fatal — returns without modifying the map on any error.
 */
async function mergeSupabaseBlockedDates(sb, map) {
  const today = getLADate();
  const nowMinsLA = getLAMinutes();
  try {
    const activeBookingRefs = new Set();
    const { data: activeBookings, error: activeBookingError } = await sb
      .from("bookings")
      .select("booking_ref, vehicle_id")
      .in("status", ACTIVE_STATUSES)
      .not("booking_ref", "is", null);
    if (activeBookingError) {
      console.warn("booked-dates: Supabase active bookings query error (non-fatal):", activeBookingError.message);
    } else {
      for (const row of activeBookings || []) {
        const vid = row.vehicle_id ? String(row.vehicle_id) : "";
        const ref = row.booking_ref ? String(row.booking_ref) : "";
        if (vid && ref) activeBookingRefs.add(`${vid}::${ref}`);
      }
    }

    const { data: rows, error } = await sb
      .from("blocked_dates")
      .select("vehicle_id, booking_ref, reason, start_date, end_date, end_time");

    if (error) {
      console.warn("booked-dates: Supabase blocked_dates query error (non-fatal):", error.message);
      return;
    }
    for (const row of rows || []) {
      const vid = row.vehicle_id;
      if (!vid) continue;
      if (!map[vid]) map[vid] = [];

      const reason = row.reason ? String(row.reason) : "";
      const bookingRef = row.booking_ref ? String(row.booking_ref) : "";
      if (reason === "booking" && (!bookingRef || !activeBookingRefs.has(`${vid}::${bookingRef}`))) {
        continue;
      }

      const endDate = row.end_date ? String(row.end_date).split("T")[0] : null; // strip timestamp if present
      if (!endDate) continue;

      // Skip entries that are entirely in the past.
      if (endDate < today) continue;

      const endTime = row.end_time ? String(row.end_time).substring(0, 5) : null;

      // Skip entries whose buffered end_time has already passed today — the
      // vehicle is now free and must not block any remaining slots.
      if (endDate === today && endTime) {
        const endMins = timeStrToMinutes(endTime);
        if (endMins >= 0 && endMins <= nowMinsLA) continue;
      }

      // Convert the already-buffered end_time back to the raw return time so
      // the frontend applies its own PICKUP_BUFFER_HOURS without double-buffering.
      const toTime = endTime ? unbufferEndTime(endTime) : null;

      mergeRange(map[vid], row.start_date, endDate, toTime);
    }
  } catch (err) {
    console.warn("booked-dates: Supabase blocked_dates merge error (non-fatal):", err.message);
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  // Never cache — we need fresh data on every request so blocked dates appear
  // immediately after a booking is confirmed.
  res.setHeader("Cache-Control", "no-store");

  // ── 1. Load static booked-dates.json from GitHub ─────────────────────────
  let map = {};
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const ghRes = await fetch(apiUrl, { headers });
    if (ghRes.ok) {
      const fileData = await ghRes.json();
      map = JSON.parse(
        Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
      );
      if (typeof map !== "object" || Array.isArray(map)) map = {};
    } else {
      console.warn(`booked-dates: GitHub Contents API returned ${ghRes.status} for ${BOOKED_DATES_PATH}`);
    }
  } catch (err) {
    console.error("booked-dates: GitHub fetch error (non-fatal):", err.message);
  }

  // ── 2. Merge Supabase data when configured ────────────────────────────────
  try {
    const sb = getSupabaseAdmin();
    if (sb) {
      await mergeSupabaseBookings(sb, map);
      await mergeSupabaseBlockedDates(sb, map);
    }
  } catch (err) {
    console.warn("booked-dates: Supabase client init error (non-fatal):", err.message);
  }

  return res.status(200).json(map);
}
