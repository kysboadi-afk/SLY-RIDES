-- 0038_fix_is_tracked_flag.sql
-- Data-correction migration: ensure every vehicle that has a Bouncie IMEI
-- assigned (bouncie_device_id IS NOT NULL) also has is_tracked = true.
--
-- The is_tracked column defaults to false (added in migration 0030).
-- Vehicles whose IMEI was set before the auto-sync logic in v2-vehicles.js
-- (line 267: upsertPayload.is_tracked = newImei !== null) was deployed, or
-- vehicles inserted directly into the DB, may have is_tracked = false even
-- though they have a valid IMEI.  This caused them to be invisible in the
-- GPS Tracking page and skipped during Bouncie mileage sync.
--
-- Note: Vehicle vehicles with an IMEI are also corrected — the vehicle
-- exclusion is handled at the application layer, not by this flag.

UPDATE vehicles
SET    is_tracked = true
WHERE  bouncie_device_id IS NOT NULL
  AND  is_tracked = false;
