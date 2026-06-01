-- 0022_maintenance_columns.sql
-- Per-service maintenance tracking for Bouncie-tracked vehicles.
--
-- Adds three independent mileage checkpoints to the vehicles table so that
-- oil changes, brake checks, and tire changes are tracked separately.
-- These replace the single `last_service_mileage` key that was stored only
-- inside the JSONB data blob; the JSONB mirror is preserved for the GitHub
-- JSON fallback path.
--
-- Only applies to vehicles where bouncie_device_id IS NOT NULL.
-- Vehicles are excluded in the application layer before alert logic runs.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent.

alter table vehicles
  add column if not exists last_oil_change_mileage   numeric(10,0),
  add column if not exists last_brake_check_mileage  numeric(10,0),
  add column if not exists last_tire_change_mileage  numeric(10,0);

-- Back-fill: if a vehicle already has last_service_mileage stored in its
-- JSONB data blob (from the old single-service-record approach), copy it into
-- all three new columns as a sensible starting point.
-- Only runs when the column is still NULL (i.e. a fresh install or first run).
update vehicles
set
  last_oil_change_mileage  = coalesce(last_oil_change_mileage,  (data->>'last_service_mileage')::numeric),
  last_brake_check_mileage = coalesce(last_brake_check_mileage, (data->>'last_service_mileage')::numeric),
  last_tire_change_mileage = coalesce(last_tire_change_mileage, (data->>'last_service_mileage')::numeric)
where
  bouncie_device_id is not null
  and data ? 'last_service_mileage'
  and (last_oil_change_mileage is null or last_brake_check_mileage is null or last_tire_change_mileage is null);
