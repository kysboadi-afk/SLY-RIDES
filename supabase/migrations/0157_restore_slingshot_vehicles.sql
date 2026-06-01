-- Migration 0157: Restore vehicle vehicle to the fleet.
--
-- Migrations 0105 and 0109 were previously used to delete vehicle vehicles and
-- settings.  Those migrations have been reverted to no-ops.  This migration
-- re-seeds the vehicle row for any database where 0105 already ran and deleted
-- the record.
--
-- Idempotent: uses INSERT ... ON CONFLICT DO UPDATE so re-running is safe.

INSERT INTO vehicles (vehicle_id, data, updated_at)
VALUES (
  'vehicle',
  jsonb_build_object(
    'vehicle_id',    'vehicle',
    'vehicle_name',  'Vehicle R',
    'type',          'vehicle',
    'category',      'vehicle',
    'vehicle_year',  null,
    'purchase_date', '',
    'purchase_price', 0,
    'status',        'active',
    'cover_image',   '/images/vehicle.jpg',
    'gallery_images', jsonb_build_array('/images/vehicle-2.jpg'),
    'scarcity_text', '🏎️ Limited availability — book now'
  ),
  now()
)
ON CONFLICT (vehicle_id) DO UPDATE
  SET data = EXCLUDED.data,
      updated_at = now()
  -- Only restore if the vehicle was previously deleted or set inactive;
  -- if it already exists and is active, keep existing data as-is.
  WHERE vehicles.data->>'status' IS DISTINCT FROM 'active'
     OR vehicles.data->>'category' IS DISTINCT FROM 'vehicle';
