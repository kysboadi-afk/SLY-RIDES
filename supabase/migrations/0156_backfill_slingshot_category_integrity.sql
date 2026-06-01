-- Migration 0156: backfill vehicle category integrity with audit trail.
--
-- Goal:
--   Ensure vehicles that are clearly vehicle inventory are always tagged with
--   data.category = 'vehicle' so scope=vehicle pages/APIs include them.
--
-- Detection signals (any one):
--   1) vehicle_id starts with "vehicle"
--   2) data->>'type' = 'vehicle'
--   3) data->>'vehicle_name' contains "vehicle" (case-insensitive)
--
-- The migration is idempotent and non-destructive.

CREATE TABLE IF NOT EXISTS vehicle_category_backfill_audit (
  vehicle_id         text PRIMARY KEY,
  previous_category  text,
  detected_reason    text NOT NULL,
  corrected_category text NOT NULL DEFAULT 'vehicle',
  corrected_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_category_backfill_audit_corrected_at_idx
  ON vehicle_category_backfill_audit (corrected_at DESC);

WITH candidates AS (
  SELECT
    v.vehicle_id,
    v.data->>'category' AS previous_category,
    CASE
      WHEN v.vehicle_id ILIKE 'vehicle%' THEN 'vehicle_id_prefix'
      WHEN lower(COALESCE(v.data->>'type', '')) = 'vehicle' THEN 'type_field'
      ELSE 'vehicle_name_contains_vehicle'
    END AS detected_reason
  FROM vehicles v
  WHERE (
      v.vehicle_id ILIKE 'vehicle%'
      OR lower(COALESCE(v.data->>'type', '')) = 'vehicle'
      OR lower(COALESCE(v.data->>'vehicle_name', '')) LIKE '%vehicle%'
    )
    AND COALESCE(v.data->>'category', '') <> 'vehicle'
),
audit_upsert AS (
  INSERT INTO vehicle_category_backfill_audit (vehicle_id, previous_category, detected_reason)
  SELECT vehicle_id, previous_category, detected_reason
  FROM candidates
  ON CONFLICT (vehicle_id) DO UPDATE
    SET previous_category = EXCLUDED.previous_category,
        detected_reason = EXCLUDED.detected_reason,
        corrected_at = now()
  RETURNING vehicle_id
)
UPDATE vehicles v
SET
  data = jsonb_set(COALESCE(v.data, '{}'::jsonb), '{category}', '"vehicle"'::jsonb, true),
  updated_at = now()
WHERE v.vehicle_id IN (SELECT vehicle_id FROM audit_upsert);

-- Verification helper (run manually):
-- SELECT vehicle_id, data->>'vehicle_name' AS vehicle_name, data->>'type' AS type, data->>'category' AS category
-- FROM vehicles
-- WHERE vehicle_id ILIKE 'vehicle%'
--    OR lower(COALESCE(data->>'type', '')) = 'vehicle'
--    OR lower(COALESCE(data->>'vehicle_name','')) LIKE '%vehicle%'
-- ORDER BY vehicle_id;
