-- 0024_vehicle_decision_status.sql
-- AI Fleet Control: per-vehicle decision and action status columns.
--
-- decision_status — AI / admin decision about the vehicle's future
--   Values: NULL (no decision) | 'review_for_sale' | 'needs_attention'
--
-- action_status   — lifecycle of the active decision
--   Values: NULL (no action) | 'pending' | 'in_progress' | 'resolved'
--
-- These columns are set by the confirm_vehicle_action AI tool and displayed
-- as badges in the admin dashboard.  Vehicles and cars both carry these
-- columns; the vehicle-type rules only restrict mileage/maintenance logic.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS; constraint blocks use
-- idempotent DO…EXCEPTION guards (PostgreSQL does not support
-- ADD CONSTRAINT IF NOT EXISTS).

alter table vehicles
  add column if not exists decision_status text,
  add column if not exists action_status   text;

-- Constraint: only allow known values (NULL is always permitted).
do $$
begin
  alter table vehicles
    add constraint vehicles_decision_status_check
      check (decision_status is null or decision_status in ('review_for_sale', 'needs_attention'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table vehicles
    add constraint vehicles_action_status_check
      check (action_status is null or action_status in ('pending', 'in_progress', 'resolved'));
exception when duplicate_object then null;
end $$;
