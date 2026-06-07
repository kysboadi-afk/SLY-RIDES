// api/_settings.js
// Dynamic pricing loader — reads live pricing from the Supabase system_settings
// table so the admin can update prices (e.g. for promotions) through the admin
// portal without requiring a code deployment.
//
// All functions fall back to the hardcoded constants in _pricing.js when
// Supabase is unavailable, so the system degrades gracefully.
//
// Usage:
//   import { loadPricingSettings, computeAmountFromSettings, ... } from "./_settings.js";
//   const settings = await loadPricingSettings();
//   const total    = computeAmountFromSettings(vehicleId, pickup, returnDate, settings);

import { getSupabaseAdmin } from "./_supabase.js";
import {
  LA_TAX_RATE,
  CARS,
  CAMRY_BOOKING_DEPOSIT,
  PROTECTION_PLAN_BASIC,
  PROTECTION_PLAN_STANDARD,
  PROTECTION_PLAN_PREMIUM,
  computeRentalDays,
  computeProtectionPlanCost,
} from "./_pricing.js";
import { MAINTENANCE_DEFAULTS } from "./_system-settings-defaults.js";

// Keys that live in the system_settings table and their hardcoded fallback values.
// These match the DEFAULT_SETTINGS seed in api/v2-system-settings.js.
export const PRICING_DEFAULTS = {
  la_tax_rate:                LA_TAX_RATE,
  // Camry / economy car rates
  camry_daily_rate:           CARS.camry.pricePerDay,
  camry_weekly_rate:          CARS.camry.weekly,
  camry_biweekly_rate:        CARS.camry.biweekly,
  camry_monthly_rate:         CARS.camry.monthly,
  // Deposits / booking fees
  camry_booking_deposit:      CAMRY_BOOKING_DEPOSIT,
  // Booking change fee (charged for each change after the first free one)
  booking_change_fee:         25,
};

export { MAINTENANCE_DEFAULTS };

/**
 * Loads live pricing settings from the Supabase system_settings table.
 * Only rows with category = "pricing" or "tax" are fetched, keeping the
 * query narrow and fast.
 *
 * Falls back to PRICING_DEFAULTS for any key that is missing, zero, or
 * not a valid positive number, and falls back entirely if Supabase is
 * unavailable (e.g. during local development or a network outage).
 *
 * @returns {Promise<object>} A plain object whose keys match PRICING_DEFAULTS.
 */
export async function loadPricingSettings() {
  const sb = getSupabaseAdmin();
  if (!sb) return { ...PRICING_DEFAULTS };

  try {
    const { data, error } = await sb
      .from("system_settings")
      .select("key, value")
      .in("category", ["pricing", "tax"]);

    if (error || !Array.isArray(data)) return { ...PRICING_DEFAULTS };

    const result = { ...PRICING_DEFAULTS };
    for (const row of data) {
      if (Object.hasOwn(result, row.key)) {
        const num = Number(row.value);
        // Only override when the admin-supplied value is a finite, positive number.
        if (Number.isFinite(num) && num > 0) result[row.key] = num;
      }
    }
    return result;
  } catch {
    // Never crash a payment request because of a settings lookup failure.
    return { ...PRICING_DEFAULTS };
  }
}

/**
 * Reads a single boolean setting from the system_settings table.
 * Returns `defaultVal` when Supabase is unavailable or the key is not found.
 *
 * @param {string}  key          - system_settings key
 * @param {boolean} defaultVal   - value to return when the setting cannot be read
 * @returns {Promise<boolean>}
 */
export async function loadBooleanSetting(key, defaultVal = true) {
  const sb = getSupabaseAdmin();
  if (!sb) return defaultVal;

  try {
    const { data, error } = await sb
      .from("system_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return defaultVal;
    // Supabase stores jsonb booleans as JS booleans; guard against "false" strings.
    if (data.value === false || data.value === "false") return false;
    if (data.value === true  || data.value === "true")  return true;
    return defaultVal;
  } catch {
    return defaultVal;
  }
}

/**
 * Reads a single string setting from the system_settings table.
 * Returns `defaultVal` when Supabase is unavailable or the key is not found.
 *
 * @param {string} key
 * @param {string} defaultVal
 * @returns {Promise<string>}
 */
export async function loadStringSetting(key, defaultVal = "") {
  const sb = getSupabaseAdmin();
  if (!sb) return defaultVal;

  try {
    const { data, error } = await sb
      .from("system_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error || !data || data.value === null || data.value === undefined) return defaultVal;
    const normalized = String(data.value).trim();
    return normalized || defaultVal;
  } catch {
    return defaultVal;
  }
}

/**
 * Reads a single numeric setting from the system_settings table.
 * Returns `defaultVal` when Supabase is unavailable, the key is not found,
 * or the stored value is not a finite non-negative number.
 *
 * Zero is a valid value (e.g. violation_admin_fee may be set to 0 to waive the fee).
 * Negative values are rejected and fall back to `defaultVal`.
 *
 * @param {string} key        - system_settings key
 * @param {number} defaultVal - value to return when the setting cannot be read
 * @returns {Promise<number>}
 */
export async function loadNumericSetting(key, defaultVal) {
  const sb = getSupabaseAdmin();
  if (!sb) return defaultVal;

  try {
    const { data, error } = await sb
      .from("system_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return defaultVal;
    const num = Number(data.value);
    return Number.isFinite(num) && num >= 0 ? num : defaultVal;
  } catch {
    return defaultVal;
  }
}

// ─── Compute helpers using dynamic settings ──────────────────────────────────

/**
 * Compute total pre-tax rental cost for a Camry / economy car using live rates.
 * Applies the same greedy monthly → biweekly → weekly → daily tier logic as
 * computeAmount() in _pricing.js.
 *
 * @param {string} vehicleId  - "camry" | "camry2013"
 * @param {string} pickup     - ISO date string, e.g. "2025-07-01"
 * @param {string} returnDate - ISO date string, e.g. "2025-07-08"
 * @param {object} settings   - result of loadPricingSettings()
 * @returns {number|null} pre-tax total in dollars, or null for unknown vehicle
 */
export function computeCamryAmountFromSettings(vehicleId, pickup, returnDate, settings) {
  if (vehicleId !== "camry" && vehicleId !== "camry2013") return null;

  const monthly  = settings.camry_monthly_rate;
  const biweekly = settings.camry_biweekly_rate;
  const weekly   = settings.camry_weekly_rate;
  const daily    = settings.camry_daily_rate;

  let remaining = computeRentalDays(pickup, returnDate);
  let cost = 0;

  if (monthly  && remaining >= 30) { const m = Math.floor(remaining / 30); cost += m * monthly;  remaining %= 30; }
  if (biweekly && remaining >= 14) { const b = Math.floor(remaining / 14); cost += b * biweekly; remaining %= 14; }
  if (weekly   && remaining >= 7)  { const w = Math.floor(remaining / 7);  cost += w * weekly;   remaining %= 7;  }
  cost += remaining * daily;

  return cost; // Camry has no security deposit
}

/**
 * Compute the total rental amount for any vehicle using live settings.
 * Routes to the appropriate helper based on the vehicle type.
 *
 * @param {string} vehicleId     - key in CARS
 * @param {string} pickup        - ISO date string
 * @param {string} returnDate    - ISO date string
 * @param {object} settings      - result of loadPricingSettings()
 * @returns {number|null}
 */
export function computeAmountFromSettings(vehicleId, pickup, returnDate, settings, vehicleData = null) {
  if (vehicleId === "camry" || vehicleId === "camry2013") {
    return computeCamryAmountFromSettings(vehicleId, pickup, returnDate, settings);
  }
  return computeCarAmountFromVehicleData(vehicleData, pickup, returnDate, settings);
}

/**
 * Compute Damage Protection Plan cost.
 * DPP rates are fixed by contract and are not stored in system_settings, so this
 * function delegates to the same logic used in _pricing.js (but is kept here so
 * payment endpoints only need to import from one place).
 *
 * @param {number}      days - rental days (min 1)
 * @param {string|null} tier - "basic" | "standard" | "premium" | null
 * @returns {number}
 */
export function computeDppCostFromSettings(days, tier) {
  return computeProtectionPlanCost(days, tier ?? null);
}

/**
 * Apply sales tax to a pre-tax amount using the live tax rate.
 * @param {number} preTax   - pre-tax amount in dollars
 * @param {object} settings - result of loadPricingSettings()
 * @returns {number} after-tax amount rounded to the nearest cent
 */
export function applyTax(preTax, settings) {
  return Math.round(preTax * (1 + settings.la_tax_rate) * 100) / 100;
}

/**
 * Compute human-readable pricing breakdown lines for a Camry / economy rental
 * using live settings, for use in email receipts.
 * Mirrors computeBreakdownLines() in _pricing.js but uses dynamic rates.
 *
 * @param {string}      vehicleId          - "camry" | "camry2013"
 * @param {string}      pickup             - ISO date string
 * @param {string}      returnDate         - ISO date string
 * @param {object}      settings           - result of loadPricingSettings()
 * @param {boolean}     [protectionPlan]   - whether DPP was selected
 * @param {string|null} [protectionPlanTier] - "basic"|"standard"|"premium"|null
 * @returns {string[]|null}
 */
export function computeBreakdownLinesFromSettings(vehicleId, pickup, returnDate, settings, protectionPlan = false, protectionPlanTier = null, vehicleData = null) {
  const isKnownEconomy = (vehicleId === "camry" || vehicleId === "camry2013");

  let monthly, biweekly, weekly, daily;

  if (isKnownEconomy) {
    // Known economy cars: use admin-configurable system_settings rates.
    monthly  = settings.camry_monthly_rate;
    biweekly = settings.camry_biweekly_rate;
    weekly   = settings.camry_weekly_rate;
    daily    = settings.camry_daily_rate;
  } else if (vehicleData) {
    // Any vehicle added via the admin portal — resolve rates from the stored data
    // object, handling all field-name aliases used across the codebase:
    //   pricePerDay  (getVehicleById normalised output)
    //   daily_price  (v2-vehicles create JSONB, vehicle_pricing table)
    //   daily_rate   (legacy / AI tool format)
    daily    = vehicleData.pricePerDay    || vehicleData.daily_price    || vehicleData.daily_rate    || null;
    weekly   = vehicleData.weekly         || vehicleData.weekly_price   || vehicleData.weekly_rate   || null;
    biweekly = vehicleData.biweekly       || vehicleData.biweekly_price || vehicleData.biweekly_rate || null;
    monthly  = vehicleData.monthly        || vehicleData.monthly_price  || vehicleData.monthly_rate  || null;
    // Derive daily from weekly when only a weekly rate is stored.
    if (!daily && weekly) daily = Math.round(weekly / 7 * 100) / 100;
    if (!daily) return null;
  } else {
    return null;
  }

  const lines = [];
  let remaining = computeRentalDays(pickup, returnDate);

  if (monthly  && remaining >= 30) { const m = Math.floor(remaining / 30); lines.push(`${m} × Monthly ($${monthly}/month): $${m * monthly}`); remaining %= 30; }
  if (biweekly && remaining >= 14) { const b = Math.floor(remaining / 14); lines.push(`${b} × Bi-weekly ($${biweekly}/2 weeks): $${b * biweekly}`); remaining %= 14; }
  if (weekly   && remaining >= 7)  { const w = Math.floor(remaining / 7);  lines.push(`${w} × Weekly ($${weekly}/week): $${w * weekly}`); remaining %= 7;  }
  if (remaining > 0)               { lines.push(`${remaining} × Daily ($${daily}/day): $${remaining * daily}`); }

  const totalDays  = computeRentalDays(pickup, returnDate);
  const rentalCost = isKnownEconomy
    ? computeCamryAmountFromSettings(vehicleId, pickup, returnDate, settings)
    : computeCarAmountFromVehicleData(vehicleData, pickup, returnDate, settings);
  const dppCost    = protectionPlan ? computeDppCostFromSettings(totalDays, protectionPlanTier) : 0;

  if (protectionPlan) {
    const tierLabel = protectionPlanTier
      ? ` (${protectionPlanTier.charAt(0).toUpperCase() + protectionPlanTier.slice(1)})`
      : "";
    lines.push(`Damage Protection Plan${tierLabel}: $${dppCost}`);
  }

  const preTax    = rentalCost + dppCost;
  const taxAmount = Math.round(preTax * settings.la_tax_rate * 100) / 100;
  const total     = Math.round((preTax + taxAmount) * 100) / 100;

  lines.push(`Sales Tax (${(settings.la_tax_rate * 100).toFixed(2)}%): $${taxAmount.toFixed(2)}`);
  // NOTE: send-reservation-email.js checks startsWith("Total:") for bold styling.
  lines.push(`Total: $${total.toFixed(2)}`);

  return lines;
}

/**
 * Compute the pre-tax rental cost for ANY car vehicle using its stored rate
 * fields and the same greedy monthly → biweekly → weekly → daily tier logic.
 *
 * For the two known economy cars (camry / camry2013) this delegates to the
 * existing computeCamryAmountFromSettings() so their admin-configurable
 * system_settings rates continue to be honoured.
 *
 * For vehicles added via the admin portal or AI (e.g. "civic2024"), the
 * vehicle's own stored rates are used:
 *   vehicleData.pricePerDay  — daily rate (required)
 *   vehicleData.weekly       — weekly rate  (optional; applied for 7+ day rentals)
 *   vehicleData.biweekly     — bi-weekly rate (optional; applied for 14+ days)
 *   vehicleData.monthly      — monthly rate (optional; applied for 30+ days)
 *
 * Returns null when the vehicle data is missing a daily rate.
 *
 * @param {object} vehicleData  - result of getVehicleById() from _vehicles.js
 * @param {string} pickup       - ISO date string, e.g. "2025-07-01"
 * @param {string} returnDate   - ISO date string, e.g. "2025-07-08"
 * @param {object} settings     - result of loadPricingSettings()
 * @returns {number|null}
 */
export function computeCarAmountFromVehicleData(vehicleData, pickup, returnDate, settings) {
  if (!vehicleData) return null;

  // Delegate to the existing settings-aware function for known economy cars.
  if (vehicleData.vehicleId === "camry" || vehicleData.vehicleId === "camry2013") {
    return computeCamryAmountFromSettings(vehicleData.vehicleId, pickup, returnDate, settings);
  }

  // New/custom vehicles: use stored rates with greedy tier logic.
  // Fall back to the configured camry daily rate only when no rate is stored —
  // this is a last-resort guard so the payment endpoint never charges $0.
  const daily    = vehicleData.pricePerDay || settings.camry_daily_rate;
  const weekly   = vehicleData.weekly   || null;
  const biweekly = vehicleData.biweekly || null;
  const monthly  = vehicleData.monthly  || null;

  if (!daily) return null;

  let remaining = computeRentalDays(pickup, returnDate);
  let cost = 0;

  if (monthly && remaining >= 30) {
    const months = Math.floor(remaining / 30);
    cost      += months * monthly;
    remaining  = remaining % 30;
  }
  if (biweekly && remaining >= 14) {
    const periods = Math.floor(remaining / 14);
    cost      += periods * biweekly;
    remaining  = remaining % 14;
  }
  if (weekly && remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    cost      += weeks * weekly;
    remaining  = remaining % 7;
  }
  cost += remaining * daily;

  return cost; // pre-tax, no deposit
}
