-- =============================================================================
-- SLY RIDES — Migration 0011: Fix Vehicle Cover Images
-- =============================================================================
--
-- PROBLEM
-- -------
-- Migration 0001 seeded vehicles with generic image paths (car1.jpg, car3.jpg)
-- that are vehicle photos rather than vehicle-specific images.
-- Migration 0002 attempted to fix this but the ON CONFLICT ... WHERE clause
-- only ran when data was empty/null, so existing rows were never updated.
--
-- WHAT THIS DOES
-- --------------
-- Unconditionally updates cover_image for vehicle2, camry, and camry2013
-- to the correct vehicle-specific photos that exist in the /images/ directory.
-- The vehicle (primary) already has the correct image (car2.jpg) and is left
-- unchanged unless it was somehow set to one of the wrong values.
--
-- Safe to re-run: uses WHERE guards to avoid overwriting admin-customised URLs
-- (e.g. Supabase Storage URLs from image uploads).
-- =============================================================================

-- Fix vehicle2: was seeded with /images/car3.jpg (a vehicle photo)
UPDATE vehicles
SET
  data       = jsonb_set(data, '{cover_image}', to_jsonb('/images/IMG_1749.jpeg'::text)),
  updated_at = now()
WHERE vehicle_id = 'vehicle2'
  AND (
    data->>'cover_image' IS NULL
    OR data->>'cover_image' IN ('/images/car3.jpg', 'images/car3.jpg', '/images/car2.jpg', 'images/car2.jpg')
  );

-- Fix camry: was seeded with /images/car1.jpg (a vehicle photo)
UPDATE vehicles
SET
  data       = jsonb_set(data, '{cover_image}', to_jsonb('/images/IMG_0046.png'::text)),
  updated_at = now()
WHERE vehicle_id = 'camry'
  AND (
    data->>'cover_image' IS NULL
    OR data->>'cover_image' IN ('/images/car1.jpg', 'images/car1.jpg', '/images/car2.jpg', 'images/car2.jpg')
  );

-- Fix camry2013: was seeded with /images/camry-beach-hero.png
-- Update to the dedicated vehicle photo only if still on the original seeded value.
UPDATE vehicles
SET
  data       = jsonb_set(data, '{cover_image}', to_jsonb('/images/IMG_5144.png'::text)),
  updated_at = now()
WHERE vehicle_id = 'camry2013'
  AND (
    data->>'cover_image' IS NULL
    OR data->>'cover_image' IN ('/images/camry-beach-hero.png', 'images/camry-beach-hero.png',
                                '/images/car1.jpg', 'images/car1.jpg',
                                '/images/car2.jpg', 'images/car2.jpg')
  );
