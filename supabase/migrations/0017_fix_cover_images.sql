-- Migration 0017: Fix vehicle cover_image paths in the Supabase vehicles table.
--
-- Background: Some deployments have bare filenames (e.g. "camry2013.jpg") stored
-- in the data JSONB column instead of the correct relative paths.  The frontend
-- normalizeCoverImage() helper prepends "/" to relative values, turning them into
-- "/camry2013.jpg" which returns 404.
--
-- This migration force-patches every vehicle row to use the canonical
-- "images/<filename>" paths that exist in the GitHub repo.
-- It only overwrites a value when it does NOT already start with "images/" or
-- "http" (i.e. it's a bare filename or unknown path), so safe to re-run.

-- Vehicle units (all share the same photo)
UPDATE vehicles
  SET data      = jsonb_set(data, '{cover_image}', '"images/vehicle.jpg"'::jsonb),
      updated_at = now()
  WHERE vehicle_id IN ('vehicle', 'vehicle2', 'vehicle3')
    AND NOT (
          data->>'cover_image' LIKE 'images/%'
       OR data->>'cover_image' LIKE '/images/%'
       OR data->>'cover_image' LIKE 'http%'
       OR data->>'cover_image' IS NULL
       OR data->>'cover_image' = ''
    );

-- Camry 2012
UPDATE vehicles
  SET data      = jsonb_set(data, '{cover_image}', '"images/IMG_0046.png"'::jsonb),
      updated_at = now()
  WHERE vehicle_id = 'camry'
    AND NOT (
          data->>'cover_image' LIKE 'images/%'
       OR data->>'cover_image' LIKE '/images/%'
       OR data->>'cover_image' LIKE 'http%'
       OR data->>'cover_image' IS NULL
       OR data->>'cover_image' = ''
    );

-- Camry 2013 SE
UPDATE vehicles
  SET data      = jsonb_set(data, '{cover_image}', '"images/IMG_5144.png"'::jsonb),
      updated_at = now()
  WHERE vehicle_id = 'camry2013'
    AND NOT (
          data->>'cover_image' LIKE 'images/%'
       OR data->>'cover_image' LIKE '/images/%'
       OR data->>'cover_image' LIKE 'http%'
       OR data->>'cover_image' IS NULL
       OR data->>'cover_image' = ''
    );
