-- Migration 0124: Remove phantom/stale vehicle rows from Supabase vehicles table.
--
-- Root cause: the dashboard's "Available Vehicles" KPI was showing 3 instead of 2.
-- The canonical fleet includes: camry, camry2013, fusion2017, and vehicle vehicles
-- (vehicle_id LIKE 'vehicle%').  Extra rows (e.g. a legacy "camry2012" alias or
-- a test vehicle created via the admin UI) can survive in the Supabase vehicles table
-- if they were inserted by the admin panel when the GitHub vehicles.json save failed.
--
-- Fix strategy:
--   1. Delete any vehicle row whose vehicle_id is NOT in the canonical set AND that
--      has no referencing bookings (safe — no FK violation risk).
--   2. For any non-canonical vehicle that DOES have bookings (historical data), mark
--      it inactive in its JSONB `data` column so it stops being counted in
--      admin_metrics_v2's available-vehicles tally.
--
-- Safe to re-run: both statements are idempotent.

-- Step 1: hard-delete stale rows with no booking history
DELETE FROM vehicles
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND vehicle_id NOT LIKE 'vehicle%'
  AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );

-- Step 2: soft-delete (set status = 'inactive') for any remaining non-canonical
-- rows that still have booking history and therefore cannot be hard-deleted.
UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{status}', '"inactive"')
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND vehicle_id NOT LIKE 'vehicle%'
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );
