// lib/ai/mileage.js
// Mileage analysis engine — pure computation, no I/O.
//
// Applies only to Bouncie-tracked vehicles (bouncie_device_id set).

//
// Maintenance thresholds (rideshare-optimised):
//   Oil change    : every 3,000 miles  (warn at 80 % = 2,400 mi)
//   Brakes check  : every 10,000 miles (warn at 80 % = 8,000 mi)
//   Tires         : every 20,000 miles (warn at 80 % = 16,000 mi)
//
// Each service type is tracked independently via dedicated DB columns:
//   last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage
// Callers should fall back to last_service_mileage when the new columns are
// absent (older DB schema / JSON fallback path).
//
// Alert severity:
//   ⚠️  due soon  — mileage >= 80 % of interval since last service
//   🚨  overdue   — mileage >= 100 % of interval since last service
//
// Usage alerts:
//   High daily usage: avg > 300 miles on active-trip days (last 30 days)
//   Idle vehicle    : no trips logged in the last 7 days

// ── Maintenance thresholds ────────────────────────────────────────────────────
const OIL_CHANGE_MILES_DEFAULT = 3000;
const OIL_CHANGE_MAX_MILES  = 4000;  // upper bound of oil change window (rideshare)
const OIL_WARN_PCT          = 0.8;   // warn at 80 % of interval
const BRAKES_MILES_DEFAULT  = 10000;
const TIRES_MILES_DEFAULT   = 20000;
const WARN_PCT              = 0.8;   // 80 % threshold for brakes and tires

// Usage alert thresholds
const HIGH_DAILY_MILES = 300;  // miles per active-trip day
const IDLE_DAYS        = 7;    // no trips for this many days = "idle"

/**
 * Analyse fleet mileage data and return alerts + per-vehicle statistics.
 *
 * @param {Array}  mileageData  - one entry per tracked vehicle:
 *   {
 *     vehicle_id, vehicle_name?,
 *     total_mileage,
 *     last_oil_change_mileage?,   // preferred — specific to oil changes
 *     last_brake_check_mileage?,  // preferred — specific to brakes
 *     last_tire_change_mileage?,  // preferred — specific to tires
 *     last_service_mileage?,      // legacy fallback when per-service fields missing
 *     last_synced_at?
 *   }
 * @param {Array}  [recentTrips] - rows from trip_log (any window), each with:
 *   { vehicle_id, trip_distance, trip_at }
 * @returns {{ alerts: string[], stats: object[] }}
 */
export function analyzeMileage(mileageData = [], recentTrips = []) {
  const alerts = [];
  const stats  = [];
  const now    = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 86400000);
  const sevenDaysAgo  = new Date(now - IDLE_DAYS * 86400000);

  for (const row of mileageData) {
    const {
      vehicle_id,
      vehicle_name,
      total_mileage            = 0,
      maintenance_mileage_alert_miles,
      maintenance_brakes_interval_miles,
      maintenance_tires_interval_miles,
      last_oil_change_mileage,
      last_brake_check_mileage,
      last_tire_change_mileage,
      last_service_mileage     = 0,   // legacy fallback
      last_synced_at,
    } = row;

    const name  = vehicle_name || vehicle_id;
    const miles = Number(total_mileage) || 0;

    // Resolve per-service last-service mileage, falling back to the legacy
    // single field when the dedicated column has not been populated yet.
    const legacyService  = Number(last_service_mileage) || 0;
    const lastOil        = last_oil_change_mileage   != null ? Number(last_oil_change_mileage)   : legacyService;
    const lastBrakes     = last_brake_check_mileage  != null ? Number(last_brake_check_mileage)  : legacyService;
    const lastTires      = last_tire_change_mileage  != null ? Number(last_tire_change_mileage)  : legacyService;
    const oilInterval    = resolveOilIntervalMiles(maintenance_mileage_alert_miles);
    const brakesInterval = resolveBrakesIntervalMiles(maintenance_brakes_interval_miles);
    const tiresInterval  = resolveTiresIntervalMiles(maintenance_tires_interval_miles);

    const sinceOil    = Math.max(0, miles - lastOil);
    const sinceBrakes = Math.max(0, miles - lastBrakes);
    const sinceTires  = Math.max(0, miles - lastTires);

    // ── Per-service maintenance alerts ─────────────────────────────────────
    const oilAlert    = buildServiceAlert(name, "oil change",       sinceOil,    oilInterval,       OIL_CHANGE_MAX_MILES, OIL_WARN_PCT);
    const brakesAlert = buildServiceAlert(name, "brake inspection", sinceBrakes, brakesInterval,   null,                 WARN_PCT);
    const tiresAlert  = buildServiceAlert(name, "tire replacement", sinceTires,  tiresInterval,    null,                 WARN_PCT);

    if (oilAlert)    alerts.push(oilAlert);
    if (brakesAlert) alerts.push(brakesAlert);
    if (tiresAlert)  alerts.push(tiresAlert);

    // ── Trip stats (last 30 days) ──────────────────────────────────────────
    const vehicleTrips30d = recentTrips.filter(
      (t) => t.vehicle_id === vehicle_id && new Date(t.trip_at) >= thirtyDaysAgo
    );
    const totalDist30d  = vehicleTrips30d.reduce((s, t) => s + (Number(t.trip_distance) || 0), 0);
    const daysWithTrips = new Set(vehicleTrips30d.map((t) => {
      try { return new Date(t.trip_at).toISOString().slice(0, 10); } catch { return ""; }
    }).filter(Boolean)).size;
    const avgDailyMiles = daysWithTrips > 0 ? totalDist30d / daysWithTrips : 0;

    // ── High daily usage alert ─────────────────────────────────────────────
    if (avgDailyMiles > HIGH_DAILY_MILES) {
      alerts.push(
        `⚠️ ${name}: averaging ${Math.round(avgDailyMiles)} miles/day over active-trip days ` +
        `in the last 30 days — above threshold (${HIGH_DAILY_MILES} mi/day)`
      );
    }

    // ── Idle vehicle alert ─────────────────────────────────────────────────
    const tripsLast7d = recentTrips.filter(
      (t) => t.vehicle_id === vehicle_id && new Date(t.trip_at) >= sevenDaysAgo
    );
    if (tripsLast7d.length === 0 && vehicleTrips30d.length > 0) {
      // Only flag idle if there was recent activity (vehicle is in use, not parked)
      alerts.push(`⚠️ ${name}: no trips recorded in the last ${IDLE_DAYS} days — vehicle may be idle`);
    }

    // ── Next upcoming service (earliest due) ──────────────────────────────
    const { nextType, milesUntilService } = nextService(sinceOil, sinceBrakes, sinceTires, oilInterval, brakesInterval, tiresInterval);

    stats.push({
      vehicle_id,
      name,
      total_mileage:             roundMi(miles),
      // Per-service tracking
      last_oil_change_mileage:   roundMi(lastOil),
      last_brake_check_mileage:  roundMi(lastBrakes),
      last_tire_change_mileage:  roundMi(lastTires),
      miles_since_oil:           roundMi(sinceOil),
      maintenance_mileage_alert_miles: oilInterval,
      maintenance_brakes_interval_miles: brakesInterval,
      maintenance_tires_interval_miles: tiresInterval,
      miles_since_brakes:        roundMi(sinceBrakes),
      miles_since_tires:         roundMi(sinceTires),
      // Legacy field — retained for backward compat with existing callers
      last_service_mileage:      roundMi(legacyService),
      miles_since_service:       roundMi(Math.min(sinceOil, sinceBrakes, sinceTires)),
      // Next upcoming service summary
      miles_until_service:       roundMi(milesUntilService),
      next_service_type:         nextType,
      // Trip stats
      trips_last_30d:            vehicleTrips30d.length,
      total_distance_last_30d:   roundMi(totalDist30d),
      avg_daily_miles_30d:       roundMi(avgDailyMiles),
      last_synced_at:            last_synced_at ?? null,
    });
  }

  return { alerts, stats };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function roundMi(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * Build a single maintenance alert for one service type.
 *
 * @param {string} name          - vehicle display name
 * @param {string} serviceLabel  - e.g. "oil change"
 * @param {number} milesSince    - miles since last service of this type
 * @param {number} interval      - service interval in miles (100 % threshold)
 * @param {number|null} maxInterval - upper bound (oil change only), or null
 * @param {number} warnPct       - fraction of interval that triggers warning (e.g. 0.8)
 * @returns {string|null}
 */
function buildServiceAlert(name, serviceLabel, milesSince, interval, maxInterval, warnPct) {
  const overdueMiles = interval;
  const warnMiles    = interval * warnPct;

  if (milesSince >= overdueMiles) {
    const intervalLabel = maxInterval
      ? `every ${fmt(interval)}–${fmt(maxInterval)} mi`
      : `every ${fmt(interval)} mi`;
    return `🚨 ${name}: ${fmt(milesSince)} mi since last ${serviceLabel} — overdue (${intervalLabel})`;
  }
  if (milesSince >= warnMiles) {
    const remaining = overdueMiles - milesSince;
    return `⚠️ ${name}: ${fmt(milesSince)} mi since last ${serviceLabel} — due in ${fmt(remaining)} mi`;
  }
  return null;
}

/**
 * Return the next-due service type and miles remaining, across all three services.
 */
function nextService(
  sinceOil,
  sinceBrakes,
  sinceTires,
  oilInterval = OIL_CHANGE_MILES_DEFAULT,
  brakesInterval = BRAKES_MILES_DEFAULT,
  tiresInterval = TIRES_MILES_DEFAULT
) {
  const candidates = [
    { remaining: oilInterval - sinceOil,   type: "oil change" },
    { remaining: brakesInterval - sinceBrakes, type: "brake inspection" },
    { remaining: tiresInterval  - sinceTires,  type: "tire replacement" },
  ].filter((c) => c.remaining > 0)
   .sort((a, b) => a.remaining - b.remaining);

  if (candidates.length === 0) {
    return { nextType: "all services overdue", milesUntilService: 0 };
  }
  return { nextType: candidates[0].type, milesUntilService: candidates[0].remaining };
}

function fmt(n) {
  return Math.round(n).toLocaleString();
}

function resolveOilIntervalMiles(raw) {
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return OIL_CHANGE_MILES_DEFAULT;
  return parsed;
}

function resolveBrakesIntervalMiles(raw) {
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return BRAKES_MILES_DEFAULT;
  return parsed;
}

function resolveTiresIntervalMiles(raw) {
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return TIRES_MILES_DEFAULT;
  return parsed;
}

//
// Inputs:
//   mileageData  — rows from vehicles table for Bouncie-tracked vehicles
//   recentTrips  — rows from trip_log (used for daily mileage trends)
//
// Outputs:
//   alerts — human-readable strings suitable for detectProblems() and ai_logs
//   stats  — per-vehicle maintenance statistics
