// Shared system-setting defaults that need to be consumed by both runtime
// handlers and the admin system-settings endpoint.

export const MAINTENANCE_DEFAULT_SETTINGS = [
  { key: "oil_check_miles_interval", value: 500, description: "Miles driven since last oil check before an oil-check SMS is sent to the active renter", category: "maintenance" },
  { key: "maintenance_oil_interval_miles", value: 3000, description: "Fleet default oil-change mileage interval when a vehicle-specific override is not set", category: "maintenance" },
  { key: "maintenance_brakes_interval_miles", value: 10000, description: "Fleet default brake inspection mileage interval", category: "maintenance" },
  { key: "maintenance_tires_interval_miles", value: 20000, description: "Fleet default tire replacement mileage interval", category: "maintenance" },
  { key: "maintenance_oil_warn_pct", value: 0.8, description: "Fraction of the oil interval that should trigger the first renter maintenance alert", category: "maintenance" },
  { key: "maintenance_oil_urgent_pct", value: 1, description: "Fraction of the oil interval that should trigger the urgent renter maintenance alert", category: "maintenance" },
  { key: "maintenance_brakes_warn_pct", value: 0.8, description: "Fraction of the brake interval that should trigger the first renter maintenance alert", category: "maintenance" },
  { key: "maintenance_brakes_urgent_pct", value: 1, description: "Fraction of the brake interval that should trigger the urgent renter maintenance alert", category: "maintenance" },
  { key: "maintenance_tires_warn_pct", value: 0.8, description: "Fraction of the tire interval that should trigger the first renter maintenance alert", category: "maintenance" },
  { key: "maintenance_tires_urgent_pct", value: 1, description: "Fraction of the tire interval that should trigger the urgent renter maintenance alert", category: "maintenance" },
  { key: "maintenance_alert_window_start_hour", value: 8, description: "Los Angeles hour when maintenance-alert cron SMS sending may begin", category: "maintenance" },
  { key: "maintenance_alert_window_end_hour", value: 19, description: "Los Angeles hour when maintenance-alert cron SMS sending stops (exclusive)", category: "maintenance" },
  { key: "maintenance_hard_cooldown_minutes", value: 24 * 60, description: "Minimum minutes before the same maintenance alert template can send again", category: "maintenance" },
  { key: "maintenance_escalation_delay_hours", value: 48, description: "Hours after an urgent maintenance alert before escalation is allowed", category: "maintenance" },
  { key: "maintenance_high_mileage_threshold_daily", value: 200, description: "Miles in 24 hours that trigger an owner high-mileage alert", category: "maintenance" },
  { key: "maintenance_high_mileage_max_alerts", value: 2, description: "Maximum number of owner high-mileage alerts allowed per booking", category: "maintenance" },
  { key: "maintenance_high_mileage_cooldown_minutes", value: 60, description: "Minutes required between owner high-mileage alerts for the same booking", category: "maintenance" },
  { key: "maintenance_owner_phone", value: process.env.OWNER_PHONE || "", description: "Owner phone number for maintenance escalation and high-mileage alerts", category: "maintenance" },
  { key: "maintenance_owner_email", value: process.env.OWNER_EMAIL || "", description: "Owner email for maintenance escalation and high-mileage alerts", category: "maintenance" },
  { key: "oil_check_min_rental_days", value: 3, description: "Minimum rental length in days before oil-check automation can trigger", category: "maintenance" },
  { key: "oil_check_days_since_check", value: 5, description: "Days since the last oil check that trigger an oil-check request", category: "maintenance" },
  { key: "oil_check_cooldown_hours", value: 24, description: "Minimum hours between oil-check SMS requests for the same booking", category: "maintenance" },
  { key: "oil_check_window_start_hour", value: 8, description: "Los Angeles hour when oil-check cron SMS sending may begin", category: "maintenance" },
  { key: "oil_check_window_end_hour", value: 19, description: "Los Angeles hour when oil-check cron SMS sending stops (exclusive)", category: "maintenance" },
  { key: "oil_check_escalation_delay_hours", value: 24, description: "Hours after an unanswered oil-check request before escalation is allowed", category: "maintenance" },
  { key: "oil_check_avg_miles_risk_threshold", value: 150, description: "Average miles per day that trigger the oil-check risk SMS", category: "maintenance" },
  { key: "oil_check_avg_miles_maintenance_required_threshold", value: 250, description: "Average miles per day that trigger the maintenance-required SMS", category: "maintenance" },
];

export const MAINTENANCE_DEFAULTS = Object.freeze(
  Object.fromEntries(MAINTENANCE_DEFAULT_SETTINGS.map((setting) => [setting.key, setting.value]))
);
