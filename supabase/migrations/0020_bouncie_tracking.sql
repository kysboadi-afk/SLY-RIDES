-- 0020_bouncie_tracking.sql
-- Bouncie GPS integration.
--
-- Changes to vehicles table:
--   bouncie_device_id  — Bouncie IMEI (NULL for vehicles and untracked vehicles)
--   last_synced_at     — timestamp of the last successful Bouncie sync
--   (mileage column already exists from COMPLETE_SETUP step 1)
--
-- New table:
--   trip_log — one row per Bouncie trip event (tripEnd / tripMetrics webhooks)
--              used to detect high daily usage (>300 mi/day) and idle periods
--
-- Seed:
--   camry2013 → bouncie_device_id = '865612074262698'
--
-- Safe to re-run: all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- ── vehicles table additions ──────────────────────────────────────────────────
alter table vehicles
  add column if not exists bouncie_device_id text,
  add column if not exists last_synced_at    timestamptz;

-- Partial unique index: only one vehicle per IMEI, NULLs are excluded
create unique index if not exists vehicles_bouncie_device_id_idx
  on vehicles (bouncie_device_id)
  where bouncie_device_id is not null;

-- ── trip_log ──────────────────────────────────────────────────────────────────
create table if not exists trip_log (
  id              bigserial     primary key,
  vehicle_id      text          not null,
  bouncie_imei    text          not null,
  transaction_id  text          unique,           -- Bouncie transactionId — deduplication key
  trip_distance   numeric(8,2),                   -- miles
  end_odometer    numeric(10,1),
  trip_time_secs  integer,
  max_speed_mph   numeric(5,1),
  hard_braking    integer       not null default 0,
  hard_accel      integer       not null default 0,
  trip_at         timestamptz   not null,
  created_at      timestamptz   not null default now()
);

create index if not exists trip_log_vehicle_idx on trip_log (vehicle_id);
create index if not exists trip_log_trip_at_idx on trip_log (trip_at desc);
create index if not exists trip_log_tx_idx      on trip_log (transaction_id);

-- ── Seed: Camry 2013 SE ──────────────────────────────────────────────────────
-- Map the only currently active Bouncie device to camry2013.
-- Also store bouncie_device_id inside the JSONB data blob so the GitHub
-- JSON fallback path (vehicles.json) also carries the mapping.
update vehicles
set
  bouncie_device_id = '865612074262698',
  data = jsonb_set(
    coalesce(data, '{}'::jsonb),
    '{bouncie_device_id}',
    '"865612074262698"'::jsonb
  )
where vehicle_id = 'camry2013';
