-- Migration 0141: Backfill correct category for vehicle vehicles.
--
-- Root cause: vehicle vehicles could be saved with data.category = 'car'
-- (or no category at all) when they were created or edited through admin
-- portals that did not explicitly send category:'vehicle'.  The
-- deriveVehicleCategory helper in admin-ai-insights returns the explicit
-- category value first, so a stored 'car' value overrides all name/type/id
-- fallback checks — causing vehicle vehicles to pass the car scope filter
-- and appear in the car admin's "Detected Problems" panel.
--
-- Fix strategy:
--   For every vehicle row where any of the canonical vehicle signals is
--   present (vehicle_id starts with 'vehicle', data->>'type' is 'vehicle',
--   or data->>'vehicle_name' contains 'vehicle' case-insensitively), force
--   data.category to 'vehicle'.
--
-- Safe to re-run: the WHERE clause is idempotent.

UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{category}', '"vehicle"')
WHERE (
    vehicle_id ILIKE 'vehicle%'
    OR data->>'type' = 'vehicle'
    OR lower(data->>'vehicle_name') LIKE '%vehicle%'
)
  AND (data->>'category' IS NULL OR data->>'category' != 'vehicle');
