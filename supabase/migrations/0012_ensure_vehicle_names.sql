-- =============================================================================
-- SLY RIDES — Migration 0012: Ensure vehicle_name is present in all rows
-- =============================================================================
--
-- PROBLEM
-- -------
-- The vehicles table stores all vehicle fields in a JSONB `data` column.
-- Earlier migrations used ON CONFLICT DO NOTHING (0001) or only updated rows
-- where data was entirely empty (0002), so rows that existed before vehicle_name
-- was introduced — or rows inserted with partial data — may be missing
-- vehicle_name, causing the Vehicles tab in the admin panel to show blank names.
--
-- WHAT THIS DOES
-- --------------
-- For each of the four known fleet vehicles, if vehicle_name is missing or
-- empty in their `data` column, this migration patches just that field using
-- jsonb_set so no other customised data (purchase price, status, images, etc.)
-- is overwritten.
--
-- Safe to re-run: the WHERE clause only touches rows where vehicle_name is
-- genuinely absent or empty, so admin-customised names are never overwritten.
-- =============================================================================

UPDATE vehicles
SET
  data       = jsonb_set(data, '{vehicle_name}', to_jsonb('Vehicle R'::text)),
  updated_at = now()
WHERE vehicle_id = 'vehicle'
  AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');

UPDATE vehicles
SET
  data       = jsonb_set(data, '{vehicle_name}', to_jsonb('Vehicle R (2)'::text)),
  updated_at = now()
WHERE vehicle_id = 'vehicle2'
  AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');

UPDATE vehicles
SET
  data       = jsonb_set(data, '{vehicle_name}', to_jsonb('Camry 2012'::text)),
  updated_at = now()
WHERE vehicle_id = 'camry'
  AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');

UPDATE vehicles
SET
  data       = jsonb_set(data, '{vehicle_name}', to_jsonb('Camry 2013 SE'::text)),
  updated_at = now()
WHERE vehicle_id = 'camry2013'
  AND (data->>'vehicle_name' IS NULL OR data->>'vehicle_name' = '');
