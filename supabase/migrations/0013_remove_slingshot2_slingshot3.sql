-- Migration: Remove vehicle2 and vehicle3, update vehicle cover image
-- Run this in the Supabase SQL editor or via the Supabase CLI.
--
-- The fleet has been consolidated to a single Vehicle unit.
-- This removes the unused vehicle rows and updates the cover image
-- for the remaining vehicle to the newly uploaded photo.

-- Remove the extra Vehicle units from the vehicles table
DELETE FROM vehicles WHERE vehicle_id IN ('vehicle2', 'vehicle3');

-- Update the vehicle cover image to the real uploaded photo
UPDATE vehicles
SET data = jsonb_set(data, '{cover_image}', '"/images/vehicle.jpg"')
WHERE vehicle_id = 'vehicle';

-- Also set the vehicle_name to the canonical display name
UPDATE vehicles
SET data = jsonb_set(data, '{vehicle_name}', '"Vehicle R"')
WHERE vehicle_id = 'vehicle';
