// api/_pricing.js
// Canonical vehicle pricing used by serverless functions.
// The server always recomputes charges from these constants;
// any client-supplied amount is intentionally ignored to prevent tampering.

import { buildDateTimeLA } from "./_time.js";

// Los Angeles, CA combined sales tax rate applied to every rental.
// Business is operated in the City of Los Angeles; tax is always collected
// at this rate regardless of the renter's home address.
// Combined City of Los Angeles rate: CA state 7.25% + LA county 2.25% + LA city 0.75% = 10.25%
export const LA_TAX_RATE = 0.1025;

// Non-refundable reservation deposit for Camry "Reserve Now" mode.
// Renters who choose "Reserve Now" pay this upfront; the remaining rental balance is due at pickup.
export const CAMRY_BOOKING_DEPOSIT = 50;

export const CARS = {
  camry:      { name: "Camry 2012",       pricePerDay: 55,  weekly: 350, biweekly: 650,  monthly: 1300, deposit: 0 },
  camry2013:  { name: "Camry 2013 SE",    pricePerDay: 55,  weekly: 350, biweekly: 650,  monthly: 1300, deposit: 0 },
  fusion2017: { name: "Ford Fusion 2017", pricePerDay: 60,  weekly: 400, biweekly: 800,  monthly: 1500, deposit: 0 },
};

// Late-fee pricing primitive shared across extension/reminder/admin endpoints.
// Global rule: a single flat late fee for all vehicles.
export const LATE_FEE_BASE = 25;

const LATE_FEE_GRACE_MS = 30 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compute overdue late-fee days after the 30-minute grace window.
 * Any time beyond the grace window counts as at least 1 late-fee day.
 *
 * @param {string} returnDate - YYYY-MM-DD
 * @param {string} returnTime - HH:MM or H:MM AM/PM
 * @param {Date|string|number} [now=new Date()]
 * @returns {number}
 */
export function computeLateFeeDays(returnDate, returnTime, now = new Date()) {
  const returnMs = buildDateTimeLA(returnDate, returnTime).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(returnMs) || !Number.isFinite(nowMs)) return 0;
  const overdueAfterGraceMs = nowMs - (returnMs + LATE_FEE_GRACE_MS);
  if (overdueAfterGraceMs <= 0) return 0;
  return Math.max(1, Math.ceil(overdueAfterGraceMs / MS_PER_DAY));
}

/**
 * Compute the automatic late-fee amount at $25 per overdue day after grace.
 *
 * @param {string} returnDate - YYYY-MM-DD
 * @param {string} returnTime - HH:MM or H:MM AM/PM
 * @param {Date|string|number} [now=new Date()]
 * @returns {number}
 */
export function computeLateFeeAmount(returnDate, returnTime, now = new Date()) {
  return computeLateFeeDays(returnDate, returnTime, now) * LATE_FEE_BASE;
}

// Canonical vehicle IDs derived from the CARS registry above.
// Adding a new vehicle to CARS automatically adds it here, which propagates to
// every endpoint that validates or iterates over the fleet — no manual list updates needed.
export const FLEET_VEHICLE_IDS = Object.keys(CARS);

// Damage Protection Plan rates — must stay in sync with car.js client-side constants.
// Legacy tiered rates (used for backward-compatibility and PDF display).
export const PROTECTION_PLAN_WEEKLY   = 85;   // $85/week  (7-day block)
export const PROTECTION_PLAN_BIWEEKLY = 150;  // $150/2 weeks (14-day block)
export const PROTECTION_PLAN_MONTHLY  = 295;  // $295/month (30-day block)
// Legacy daily rate derived from weekly (used when no tier is specified).
export const PROTECTION_PLAN_DAILY    = Math.ceil(PROTECTION_PLAN_WEEKLY / 7); // ≈ $13/day

// Economy car protection plan tiers (flat daily rates — no weekly/monthly discount).
export const PROTECTION_PLAN_BASIC    = 15;  // $15/day — limits liability to $2,500
export const PROTECTION_PLAN_STANDARD = 30;  // $30/day — limits liability to $1,000
export const PROTECTION_PLAN_PREMIUM  = 50;  // $50/day — limits liability to $500

/**
 * Compute the number of rental days from two ISO date strings.
 * Always returns at least 1 (same-day pickup/return counts as 1 day).
 * @param {string} pickup     - ISO date string, e.g. "2025-07-01"
 * @param {string} returnDate - ISO date string, e.g. "2025-07-05"
 * @returns {number} rental days (min 1)
 */
export function computeRentalDays(pickup, returnDate) {
  return Math.max(1, Math.ceil(
    (new Date(returnDate + "T00:00:00") - new Date(pickup + "T00:00:00")) / (1000 * 3600 * 24)
  ));
}

/**
 * Compute the Damage Protection Plan cost for a given number of rental days.
 *
 * When `tier` is "basic", "standard", or "premium" (Economy car tiers), a flat
 * daily rate is applied for all days.
 *
 * When `tier` is null/undefined (legacy callers and PDF display), the greedy
 * monthly → biweekly → weekly → daily algorithm is used.
 *
 * @param {number} days  - number of rental days (min 1)
 * @param {string|null} [tier=null] - "basic" | "standard" | "premium" | null
 * @returns {number} protection plan cost in dollars
 */
export function computeProtectionPlanCost(days, tier = null) {
  const d = Math.max(1, days);
  if (tier === "basic")    return d * PROTECTION_PLAN_BASIC;
  if (tier === "standard") return d * PROTECTION_PLAN_STANDARD;
  if (tier === "premium")  return d * PROTECTION_PLAN_PREMIUM;
  // Legacy / null tier: greedy monthly → biweekly → weekly → daily
  let remaining = d;
  let cost = 0;
  if (remaining >= 30) {
    const months = Math.floor(remaining / 30);
    cost += months * PROTECTION_PLAN_MONTHLY;
    remaining = remaining % 30;
  }
  if (remaining >= 14) {
    const twoWeeks = Math.floor(remaining / 14);
    cost += twoWeeks * PROTECTION_PLAN_BIWEEKLY;
    remaining = remaining % 14;
  }
  if (remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    cost += weeks * PROTECTION_PLAN_WEEKLY;
    remaining = remaining % 7;
  }
  cost += remaining * PROTECTION_PLAN_DAILY;
  return cost;

}

/**
 * Compute the total charge for a rental.
 * Applies the best discount tier greedily: monthly → biweekly → weekly → daily.
 * The security deposit (if any) is always included — it is never waived.
 * @param {string} vehicleId - key from CARS
 * @param {string} pickup    - ISO date string, e.g. "2025-07-01"
 * @param {string} returnDate - ISO date string, e.g. "2025-07-05"
 * @returns {number|null} total in dollars, or null if vehicleId is unknown
 */
export function computeAmount(vehicleId, pickup, returnDate) {
  const car = CARS[vehicleId];
  if (!car) return null;
  let remaining = computeRentalDays(pickup, returnDate);
  let cost = 0;
  if (car.monthly && remaining >= 30) {
    const months = Math.floor(remaining / 30);
    cost += months * car.monthly;
    remaining = remaining % 30;
  }
  if (car.biweekly && remaining >= 14) {
    const twoWeekPeriods = Math.floor(remaining / 14);
    cost += twoWeekPeriods * car.biweekly;
    remaining = remaining % 14;
  }
  if (car.weekly && remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    cost += weeks * car.weekly;
    remaining = remaining % 7;
  }
  cost += remaining * car.pricePerDay;
  return cost + (car.deposit || 0);
}

/**
 * Get the current active vehicle IDs, merging the static FLEET_VEHICLE_IDS list with
 * any vehicles registered in the Supabase `vehicles` table.  Falls back to the static
 * list when Supabase is unavailable or the query fails, so cold-start / no-DB paths
 * are unaffected.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient|null} supabase
 * @returns {Promise<string[]>} deduped list of vehicle IDs
 */
export async function getActiveVehicleIds(supabase) {
  if (!supabase) return FLEET_VEHICLE_IDS;
  try {
    const { data, error } = await supabase
      .from("vehicles")
      .select("vehicle_id, data");
    if (error || !data?.length) return FLEET_VEHICLE_IDS;
    const dynamic = data
      .filter(row => !row.data?.status || row.data.status === "active")
      .map(row => row.vehicle_id);
    return [...new Set([...FLEET_VEHICLE_IDS, ...dynamic])];
  } catch {
    return FLEET_VEHICLE_IDS;
  }
}

/**
 * Get all known vehicle IDs (active, inactive, and maintenance), merging the
 * static FLEET_VEHICLE_IDS list with every vehicle registered in the Supabase
 * `vehicles` table.  Used by admin-only endpoints (v2-bookings, v2-dashboard)
 * so historical bookings for retired vehicles remain visible.  Falls back to
 * the static list when Supabase is unavailable.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient|null} supabase
 * @returns {Promise<string[]>} deduped list of all known vehicle IDs
 */
export async function getAllVehicleIds(supabase) {
  if (!supabase) return FLEET_VEHICLE_IDS;
  try {
    const { data, error } = await supabase
      .from("vehicles")
      .select("vehicle_id");
    if (error || !data?.length) return FLEET_VEHICLE_IDS;
    const dynamic = data.map(row => row.vehicle_id);
    return [...new Set([...FLEET_VEHICLE_IDS, ...dynamic])];
  } catch {
    return FLEET_VEHICLE_IDS;
  }
}

/**
 * Derive a per-day rate from a weekly price, rounded to the nearest cent.
 * Used when daily_price is absent but weekly_price is available.
 * @param {number} weeklyPrice
 * @returns {number}
 */
function deriveDaily(weeklyPrice) {
  return Math.round(weeklyPrice / 7 * 100) / 100;
}

/**
 * Fetch pricing data for a single vehicle.
 *
 * Resolution order (first source with any usable rate wins):
 *   1. vehicle_pricing table — the canonical source for all known vehicles.
 *   2. vehicles.data JSONB   — fallback for vehicles whose vehicle_pricing row
 *      was not yet created (e.g. the upsert failed silently, or pricing was not
 *      entered at creation time).
 *   3. system_settings economy rates — allows newly added vehicles to be booked
 *      immediately using the admin-configurable economy-wide rates (camry_daily_rate
 *      etc.) while per-vehicle pricing is being set up.
 *   4. Hardcoded CARS.camry constants — absolute last resort; never throws.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} vehicleId - vehicle_id value stored in the DB
 * @returns {Promise<object>} a pricing object compatible with computeAmountFromPricing()
 */
export async function getVehiclePricing(supabase, vehicleId) {
  // Use .limit(1) + order instead of .single() so that:
  //   • 0 matching rows  → { data: [], error: null }  → fall through to JSONB
  //   • 1 matching row   → { data: [row], error: null } → return row[0]
  //   • N matching rows  → { data: [row], error: null } → return most-recent row[0]
  // With .single() a table that has no UNIQUE constraint on vehicle_id (manually
  // created in Supabase without the constraint) would accumulate duplicate rows on
  // every upsert, making .single() always return PGRST116 ("multiple rows").
  const { data: rows, error } = await supabase
    .from('vehicle_pricing')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('updated_at', { ascending: false })
    .limit(1);

  // Happy path — at least one vehicle_pricing row found with at least one usable price.
  // A row where every price is 0 or null (e.g. the admin saved $0 as a placeholder)
  // is treated as "not configured" and falls through to the JSONB/system_settings
  // fallback so economy defaults are used instead of a $0 payment intent.
  if (!error && rows && rows.length > 0) {
    const row = rows[0];
    const hasUsablePrice = [row.daily_price, row.weekly_price, row.biweekly_price, row.monthly_price]
      .some(p => p != null && Number(p) > 0);
    if (hasUsablePrice) return row;
    console.warn('[pricing] vehicle_pricing row has no positive prices — falling through to fallback', { vehicleId });
  }

  // Real error (not an empty result) — log and fall through to JSONB fallback.
  if (error) {
    console.warn('[pricing] vehicle_pricing query failed, trying JSONB fallback', { vehicleId, code: error.code, message: error.message });
  }

  // Fallback: read pricing from vehicles.data JSONB (populated by v2-vehicles create).
  // Use .maybeSingle() so 0 rows returns { data: null, error: null } instead of
  // a PGRST116 error that would prevent the system_settings fallback from running.
  const { data: vehicleRow, error: vehicleErr } = await supabase
    .from('vehicles')
    .select('data')
    .eq('vehicle_id', vehicleId)
    .maybeSingle();

  if (!vehicleErr && vehicleRow?.data) {
    const vdata = vehicleRow.data;
    // Support both v2-vehicles field names (daily_price, weekly_price, …) and
    // AI-tool field names (daily_rate, weekly, biweekly, monthly) and legacy
    // CARS/vehicles.json field names (pricePerDay) so that all vehicle records
    // created via any path work without a separate vehicle_pricing row.
    const dailyPrice    = vdata.daily_price    ? Number(vdata.daily_price)    :
                          vdata.daily_rate     ? Number(vdata.daily_rate)     :
                          vdata.pricePerDay    ? Number(vdata.pricePerDay)    : null;
    const weeklyPrice   = vdata.weekly_price   ? Number(vdata.weekly_price)   :
                          vdata.weekly         ? Number(vdata.weekly)         : null;
    const biweeklyPrice = vdata.biweekly_price ? Number(vdata.biweekly_price) :
                          vdata.biweekly       ? Number(vdata.biweekly)       : null;
    const monthlyPrice  = vdata.monthly_price  ? Number(vdata.monthly_price)  :
                          vdata.monthly        ? Number(vdata.monthly)        : null;

    // Derive a daily_price from weekly when only weekly is provided (e.g. a vehicle
    // created without an explicit daily rate).
    const effectiveDaily = dailyPrice || (weeklyPrice ? deriveDaily(weeklyPrice) : null);

    if (effectiveDaily || weeklyPrice || biweeklyPrice || monthlyPrice) {
      console.warn('[pricing] vehicle_pricing row missing — falling back to vehicles.data JSONB', { vehicleId });
      return {
        vehicle_id:     vehicleId,
        daily_price:    effectiveDaily,
        weekly_price:   weeklyPrice   || (effectiveDaily ? Math.round(effectiveDaily * 7  * 100) / 100 : null),
        biweekly_price: biweeklyPrice || (effectiveDaily ? Math.round(effectiveDaily * 14 * 100) / 100 : null),
        monthly_price:  monthlyPrice  || (effectiveDaily ? Math.round(effectiveDaily * 28 * 100) / 100 : null),
      };
    }
  }

  // Third fallback: economy-wide pricing from system_settings so that newly
  // added vehicles without explicit per-vehicle pricing are still bookable.
  // Falls back to the hardcoded CARS.camry constants when Supabase is unavailable
  // or system_settings has no pricing keys configured.
  console.warn('[pricing] no vehicle_pricing row and no JSONB data — trying system_settings economy fallback', { vehicleId });
  try {
    const { data: settingsRows } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', ['camry_daily_rate', 'camry_weekly_rate', 'camry_biweekly_rate', 'camry_monthly_rate']);

    const settingsMap = {};
    for (const row of settingsRows || []) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n > 0) settingsMap[row.key] = n;
    }

    const fallbackDaily    = settingsMap.camry_daily_rate    || CARS.camry.pricePerDay;
    const fallbackWeekly   = settingsMap.camry_weekly_rate   || CARS.camry.weekly;
    const fallbackBiweekly = settingsMap.camry_biweekly_rate || CARS.camry.biweekly;
    const fallbackMonthly  = settingsMap.camry_monthly_rate  || CARS.camry.monthly;

    if (fallbackDaily) {
      console.warn('[pricing] applying economy fallback pricing from system_settings/defaults', { vehicleId, fallbackDaily });
      return {
        vehicle_id:     vehicleId,
        daily_price:    fallbackDaily,
        weekly_price:   fallbackWeekly   || null,
        biweekly_price: fallbackBiweekly || null,
        monthly_price:  fallbackMonthly  || null,
      };
    }
  } catch (settingsErr) {
    console.warn('[pricing] system_settings query failed during economy fallback', { vehicleId, message: settingsErr.message });
  }

  // Absolute last resort: hardcoded economy defaults (never throws).
  console.warn('[pricing] using hardcoded CARS.camry defaults as last resort', { vehicleId });
  return {
    vehicle_id:     vehicleId,
    daily_price:    CARS.camry.pricePerDay,
    weekly_price:   CARS.camry.weekly   || null,
    biweekly_price: CARS.camry.biweekly || null,
    monthly_price:  CARS.camry.monthly  || null,
  };
}

/**
 * Compute the rental cost from a vehicle_pricing row and a day count.
 * Applies greedy tier pricing (monthly → biweekly → weekly → daily remainder),
 * matching the car.js booking page display so Stripe always charges exactly what
 * the renter sees before paying.
 *
 * A tier is skipped when its price is $0 or null (meaning "not offered"); the
 * next lower tier is used instead — it does NOT mean the rental is free.
 *
 * When daily_price is absent or $0, a daily rate is derived from weekly_price so
 * that all day counts remain bookable.
 *
 * @param {object} pricing  - vehicle_pricing row from getVehiclePricing()
 * @param {number} days     - number of rental days (min 1)
 * @returns {number|null} rental cost in dollars (pre-tax, no DPP), or null when
 *                        no usable rate is available
 */
export function computeAmountFromPricing(pricing, days) {
  // Coerce all values to numbers — Supabase TEXT columns and string payloads are
  // safely handled; null/undefined/non-finite values become null.
  function toFinite(v) {
    if (v == null) return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  const w  = toFinite(pricing.weekly_price);
  const bw = toFinite(pricing.biweekly_price);
  const m  = toFinite(pricing.monthly_price);
  const d  = toFinite(pricing.daily_price);

  // Derive daily_price from weekly when it is not explicitly stored, or when
  // daily_price is 0 ($0 means "not configured", not "free").
  const derived = (w != null && w > 0) ? deriveDaily(w) : null;
  const daily = (d != null && d > 0) ? d : derived;
  if (!daily) return null;

  // Greedy chain: monthly → biweekly → weekly → daily remainder.
  // Each tier is applied only when its price is strictly positive (> 0).
  let remaining = Math.max(1, days);
  let cost = 0;

  if (m != null && m > 0 && remaining >= 30) {
    const months = Math.floor(remaining / 30);
    cost += months * m;
    remaining -= months * 30;
  }
  if (bw != null && bw > 0 && remaining >= 14) {
    const periods = Math.floor(remaining / 14);
    cost += periods * bw;
    remaining -= periods * 14;
  }
  if (w != null && w > 0 && remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    cost += weeks * w;
    remaining -= weeks * 7;
  }
  cost += remaining * daily;
  return Math.round(cost * 100) / 100;
}

/**
 * Compute human-readable pricing breakdown lines for a daily/weekly rental.
 * Uses the same greedy tier logic as computeAmount.
 * @param {string} vehicleId   - key from CARS
 * @param {string} pickup      - ISO date string
 * @param {string} returnDate  - ISO date string
 * @param {boolean} [protectionPlan=false] - whether the renter opted in to DPP
 * @param {string|null} [protectionPlanTier=null] - "basic"|"standard"|"premium"|null
 * @returns {string[]|null} array of plain-text line items, or null if vehicleId unknown
 *
 * Example output for a 10-day camry rental with DPP:
 *   ["1 × Weekly ($350/week): $350", "3 × Daily ($55/day): $165",
 *    "Damage Protection Plan: $98", "Total: $613"]
 */
export function computeBreakdownLines(vehicleId, pickup, returnDate, protectionPlan = false, protectionPlanTier = null) {
  const car = CARS[vehicleId];
  if (!car) return null;

  const lines = [];
  let remaining = computeRentalDays(pickup, returnDate);

  if (car.monthly && remaining >= 30) {
    const months = Math.floor(remaining / 30);
    const subtotal = months * car.monthly;
    lines.push(`${months} × Monthly ($${car.monthly}/month): $${subtotal}`);
    remaining = remaining % 30;
  }
  if (car.biweekly && remaining >= 14) {
    const twoWeeks = Math.floor(remaining / 14);
    const subtotal = twoWeeks * car.biweekly;
    lines.push(`${twoWeeks} × Bi-weekly ($${car.biweekly}/2 weeks): $${subtotal}`);
    remaining = remaining % 14;
  }
  if (car.weekly && remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    const subtotal = weeks * car.weekly;
    lines.push(`${weeks} × Weekly ($${car.weekly}/week): $${subtotal}`);
    remaining = remaining % 7;
  }
  if (remaining > 0) {
    const subtotal = remaining * car.pricePerDay;
    lines.push(`${remaining} × Daily ($${car.pricePerDay}/day): $${subtotal}`);
  }

  if (car.deposit) {
    lines.push(`Security Deposit: $${car.deposit}`);
  }

  if (protectionPlan) {
    const days = computeRentalDays(pickup, returnDate);
    const dppCost = computeProtectionPlanCost(days, protectionPlanTier);
    const tierLabel = protectionPlanTier ? ` (${protectionPlanTier.charAt(0).toUpperCase() + protectionPlanTier.slice(1)})` : "";
    lines.push(`Damage Protection Plan${tierLabel}: $${dppCost}`);
  }

  const totalDays = computeRentalDays(pickup, returnDate);
  const rentalCost = computeAmount(vehicleId, pickup, returnDate);
  const dppCost = protectionPlan ? computeProtectionPlanCost(totalDays, protectionPlanTier) : 0;
  const preTax = rentalCost + dppCost;
  const taxAmount = Math.round(preTax * LA_TAX_RATE * 100) / 100;
  const total = Math.round((preTax + taxAmount) * 100) / 100;
  lines.push(`Sales Tax (${(LA_TAX_RATE * 100).toFixed(2)}%): $${taxAmount.toFixed(2)}`);
  // NOTE: send-reservation-email.js checks startsWith("Total:") to apply bold styling.
  // Keep this prefix consistent if the format ever changes.
  lines.push(`Total: $${total.toFixed(2)}`);

  return lines;
}
