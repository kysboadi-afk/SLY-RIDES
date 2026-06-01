-- =============================================================================
-- SLY RIDES — COMPLETE SUPABASE SETUP (FULL)
-- Generated 2026-05-30 — covers ALL migrations 0001–0183
-- =============================================================================
--
-- HOW TO USE
-- ----------
-- 1. Open your Supabase project → SQL Editor → New Query
-- 2. Paste this ENTIRE file and click Run
--    Safe to re-run — every statement uses IF NOT EXISTS / CREATE OR REPLACE.
--


-- =============================================================================
-- SLY RIDES — COMPLETE SUPABASE SETUP
-- Auto-generated 2026-05-01 — covers all 125 numbered migrations (0001-0117)
-- =============================================================================
--
-- HOW TO USE
-- ----------
-- 1. Open your Supabase project → SQL Editor → New Query
-- 2. Paste this ENTIRE file and click Run
--    Safe to re-run — every statement uses IF NOT EXISTS / CREATE OR REPLACE.
--


-- ===========================================================================
-- 0001_create_vehicles.sql
-- ===========================================================================
create table if not exists vehicles (
  vehicle_id text        primary key,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists vehicles_updated_at_idx on vehicles (updated_at);

-- Seed the four known fleet vehicles (safe to re-run; ignores conflicts)
insert into vehicles (vehicle_id, data) values
  ('vehicle',  '{"vehicle_id":"vehicle",  "vehicle_name":"Vehicle R",     "type":"vehicle","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/car2.jpg"}'::jsonb),
  ('vehicle2', '{"vehicle_id":"vehicle2", "vehicle_name":"Vehicle R (2)", "type":"vehicle","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_1749.jpeg"}'::jsonb),
  ('camry',      '{"vehicle_id":"camry",      "vehicle_name":"Camry 2012",      "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_0046.png"}'::jsonb),
  ('camry2013',  '{"vehicle_id":"camry2013",  "vehicle_name":"Camry 2013 SE",   "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_5144.png"}'::jsonb)
on conflict (vehicle_id) do nothing;


-- ===========================================================================
-- 0002_seed_fleet_vehicles.sql
-- ===========================================================================
-- Remove placeholder rows that have no vehicle data.
-- These were created during initial Supabase setup before real fleet data was loaded.
delete from vehicles
where vehicle_id in ('vehicle_1', 'vehicle_2', 'vehicle_3', 'vehicle_4');

-- Upsert the four fleet vehicles with their correct display and financial data.
-- ON CONFLICT DO UPDATE ensures rows are refreshed even if 0001 already ran
-- (0001 used DO NOTHING so real data may never have been written).
-- The WHERE clause prevents overwriting data that was subsequently customised
-- via the admin panel (only empty/null data gets replaced).
insert into vehicles (vehicle_id, data) values
  ('vehicle',  '{"vehicle_id":"vehicle",  "vehicle_name":"Vehicle R",     "type":"vehicle","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/car2.jpg"}'::jsonb),
  ('vehicle2', '{"vehicle_id":"vehicle2", "vehicle_name":"Vehicle R (2)", "type":"vehicle","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_1749.jpeg"}'::jsonb),
  ('camry',      '{"vehicle_id":"camry",      "vehicle_name":"Camry 2012",      "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_0046.png"}'::jsonb),
  ('camry2013',  '{"vehicle_id":"camry2013",  "vehicle_name":"Camry 2013 SE",   "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_5144.png"}'::jsonb)
on conflict (vehicle_id) do update
  set data = excluded.data
  where vehicles.data = '{}'::jsonb or vehicles.data is null;


-- ===========================================================================
-- 0003_admin_control_system.sql
-- ===========================================================================
-- revenue_records: Track revenue per booking
CREATE TABLE IF NOT EXISTS revenue_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id text NOT NULL,
  vehicle_id text NOT NULL,
  customer_name text,
  customer_phone text,
  customer_email text,
  pickup_date date,
  return_date date,
  gross_amount numeric(10,2) NOT NULL DEFAULT 0,
  deposit_amount numeric(10,2) NOT NULL DEFAULT 0,
  refund_amount numeric(10,2) NOT NULL DEFAULT 0,
  net_amount numeric(10,2) GENERATED ALWAYS AS (gross_amount - refund_amount) STORED,
  payment_method text DEFAULT 'stripe',
  payment_status text DEFAULT 'pending', -- pending, paid, partial, refunded
  protection_plan_id uuid,
  notes text,
  is_no_show boolean DEFAULT false,
  is_cancelled boolean DEFAULT false,
  override_by_admin boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS revenue_records_booking_id_idx ON revenue_records (booking_id);
CREATE INDEX IF NOT EXISTS revenue_records_vehicle_id_idx ON revenue_records (vehicle_id);
CREATE INDEX IF NOT EXISTS revenue_records_payment_status_idx ON revenue_records (payment_status);
CREATE INDEX IF NOT EXISTS revenue_records_created_at_idx ON revenue_records (created_at);

-- protection_plans: Admin-configurable coverage plans
CREATE TABLE IF NOT EXISTS protection_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  daily_rate numeric(10,2) NOT NULL DEFAULT 0,
  liability_cap numeric(10,2) DEFAULT 1000,
  is_active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed default protection plans
INSERT INTO protection_plans (name, description, daily_rate, liability_cap, is_active, sort_order) VALUES
  ('None',     'No protection plan selected',          0,     0,    true, 0),
  ('Basic',    'Basic damage protection, $1,000 cap',  15,    1000, true, 1),
  ('Standard', 'Standard coverage, $500 cap',          25,    500,  true, 2),
  ('Premium',  'Full coverage, $0 liability',          40,    0,    true, 3)
ON CONFLICT DO NOTHING;

-- customers: Customer profiles for history/flags
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  email text,
  flagged boolean DEFAULT false,
  banned boolean DEFAULT false,
  flag_reason text,
  ban_reason text,
  total_bookings integer DEFAULT 0,
  total_spent numeric(10,2) DEFAULT 0,
  first_booking_date date,
  last_booking_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_idx ON customers (phone) WHERE phone IS NOT NULL AND phone != '';
CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (email) WHERE email IS NOT NULL AND email != '';
CREATE INDEX IF NOT EXISTS customers_banned_idx ON customers (banned);

-- system_settings: Admin-controlled configuration
CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT 'null'::jsonb,
  description text,
  category text DEFAULT 'general', -- general, pricing, tax, automation, notification
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Seed default settings
INSERT INTO system_settings (key, value, description, category) VALUES
  ('la_tax_rate',                  '0.1025',             'Los Angeles combined sales tax rate',        'tax'),
  ('vehicle_daily_rate',         '350',                'Vehicle R daily rate (USD)',               'pricing'),
  ('camry_daily_rate',             '55',                 'Camry daily rate (USD)',                     'pricing'),
  ('camry_weekly_rate',            '350',                'Camry weekly rate (USD)',                    'pricing'),
  ('camry_biweekly_rate',          '650',                'Camry bi-weekly rate (USD)',                 'pricing'),
  ('camry_monthly_rate',           '1300',               'Camry monthly rate (USD)',                   'pricing'),
  ('vehicle_security_deposit',   '150',                'Vehicle refundable security deposit (USD)','pricing'),
  ('vehicle_booking_deposit',    '50',                 'Vehicle non-refundable booking deposit',   'pricing'),
  ('auto_block_dates_on_approve',  'true',               'Auto-block vehicle dates when booking approved', 'automation'),
  ('auto_create_revenue_on_pay',   'true',               'Auto-create revenue record when payment received', 'automation'),
  ('auto_update_customer_stats',   'true',               'Auto-update customer stats on booking events','automation'),
  ('notify_sms_on_approve',        'true',               'Send SMS to customer when booking approved', 'notification'),
  ('notify_email_on_approve',      'true',               'Send email to customer when booking approved','notification'),
  ('overdue_grace_period_hours',   '2',                  'Hours after return time before booking flagged overdue','automation')
ON CONFLICT (key) DO NOTHING;

-- booking_status_history: Audit trail for status changes
CREATE TABLE IF NOT EXISTS booking_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id text NOT NULL,
  vehicle_id text,
  old_status text,
  new_status text NOT NULL,
  changed_by text DEFAULT 'admin',
  notes text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bsh_booking_id_idx ON booking_status_history (booking_id);
CREATE INDEX IF NOT EXISTS bsh_changed_at_idx ON booking_status_history (changed_at);

-- payment_transactions: Additive payment tracking layer
CREATE TABLE IF NOT EXISTS payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id text NOT NULL,
  vehicle_id text,
  amount numeric(10,2) NOT NULL,
  transaction_type text NOT NULL, -- charge, deposit, refund, adjustment
  payment_method text DEFAULT 'stripe', -- stripe, zelle, cash, other
  payment_status text DEFAULT 'pending', -- pending, completed, failed, refunded
  stripe_payment_intent_id text,
  stripe_refund_id text,
  notes text,
  processed_by text DEFAULT 'system', -- system or admin
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pt_booking_id_idx ON payment_transactions (booking_id);
CREATE INDEX IF NOT EXISTS pt_vehicle_id_idx ON payment_transactions (vehicle_id);
CREATE INDEX IF NOT EXISTS pt_created_at_idx ON payment_transactions (created_at);

-- ── Views ──────────────────────────────────────────────────────────────────

-- vehicle_revenue_summary: Per-vehicle revenue aggregation
CREATE OR REPLACE VIEW vehicle_revenue_summary AS
SELECT
  vehicle_id,
  COUNT(*) FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS booking_count,
  COUNT(*) FILTER (WHERE is_cancelled)  AS cancelled_count,
  COUNT(*) FILTER (WHERE is_no_show)    AS no_show_count,
  SUM(gross_amount) FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS total_gross,
  SUM(refund_amount)                                                    AS total_refunds,
  SUM(net_amount) FILTER (WHERE NOT is_cancelled AND NOT is_no_show)   AS total_net,
  SUM(deposit_amount) FILTER (WHERE NOT is_cancelled)                  AS total_deposits,
  MAX(return_date)  AS last_return_date,
  MIN(pickup_date)  AS first_pickup_date
FROM revenue_records
GROUP BY vehicle_id;

-- ── Triggers ──────────────────────────────────────────────────────────────

-- Auto-update updated_at on revenue_records
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS revenue_records_updated_at ON revenue_records;
CREATE TRIGGER revenue_records_updated_at
  BEFORE UPDATE ON revenue_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS protection_plans_updated_at ON protection_plans;
CREATE TRIGGER protection_plans_updated_at
  BEFORE UPDATE ON protection_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS customers_updated_at ON customers;
CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS system_settings_updated_at ON system_settings;
CREATE TRIGGER system_settings_updated_at
  BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ===========================================================================
-- 0004_sample_data.sql
-- ===========================================================================
-- 0004_sample_data.sql
-- Seeds sample customers and revenue records for the three initial bookings.
--
-- Sample bookings (matching bookings.json):
--   1. David Agbebaku  — Camry 2013 SE, 7 days,  $479.59  (no refund)
--   2. Mariatu Sillah  — Camry 2012,   4 days,  $200.00  (no refund)
--   3. Bernard Gilot   — Camry 2012,  11 days,  $785.00  ($300 refunded → net $485)
--
-- Run AFTER migration 0003 (which creates all required tables).

-- ── Customers ──────────────────────────────────────────────────────────────

INSERT INTO customers (name, phone, email, total_bookings, total_spent, first_booking_date, last_booking_date)
VALUES
  ('David Agbebaku',  NULL, NULL, 1, 479.59, '2025-10-01', '2025-10-01'),
  ('Mariatu Sillah',  NULL, NULL, 1, 200.00, '2025-11-15', '2025-11-15'),
  ('Bernard Gilot',   NULL, NULL, 1, 485.00, '2025-12-01', '2025-12-01')
ON CONFLICT DO NOTHING;

-- ── Revenue Records ────────────────────────────────────────────────────────
-- Each booking_id matches the stable ID in bookings.json so duplicate inserts
-- can be detected and avoided by the API layer.

-- David Agbebaku — Camry 2013 SE, 7 days, $479.59
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-da-001', 'camry2013', 'David Agbebaku',
  '2025-10-01', '2025-10-08',
  479.59, 0, 0,
  'stripe', 'paid',
  '7-day rental — sample booking', true
) ON CONFLICT DO NOTHING;

-- Mariatu Sillah — Camry 2012, 4 days, $200
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-ms-001', 'camry', 'Mariatu Sillah',
  '2025-11-15', '2025-11-19',
  200.00, 0, 0,
  'cash', 'paid',
  '4-day rental — sample booking', true
) ON CONFLICT DO NOTHING;

-- Bernard Gilot — Camry 2012, 11 days, $785 gross / $300 refund / $485 net
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-bg-002', 'camry', 'Bernard Gilot',
  '2025-12-01', '2025-12-12',
  785.00, 0, 300.00,
  'cash', 'partial',
  '11-day rental — $300 refunded, net $485', true
) ON CONFLICT DO NOTHING;

-- ── Payment Transactions ───────────────────────────────────────────────────
-- Detailed payment ledger matching the revenue records above.

-- David Agbebaku — single charge
INSERT INTO payment_transactions (
  booking_id, vehicle_id, amount, transaction_type, payment_method, payment_status, notes, processed_by
) VALUES (
  'sample-da-001', 'camry2013', 479.59, 'charge', 'stripe', 'completed',
  '7-day rental payment', 'admin'
) ON CONFLICT DO NOTHING;

-- Mariatu Sillah — single charge
INSERT INTO payment_transactions (
  booking_id, vehicle_id, amount, transaction_type, payment_method, payment_status, notes, processed_by
) VALUES (
  'sample-ms-001', 'camry', 200.00, 'charge', 'cash', 'completed',
  '4-day rental payment', 'admin'
) ON CONFLICT DO NOTHING;

-- Bernard Gilot — charge + refund
INSERT INTO payment_transactions (
  booking_id, vehicle_id, amount, transaction_type, payment_method, payment_status, notes, processed_by
) VALUES (
  'sample-bg-002', 'camry', 785.00, 'charge', 'cash', 'completed',
  '11-day rental payment', 'admin'
) ON CONFLICT DO NOTHING;

INSERT INTO payment_transactions (
  booking_id, vehicle_id, amount, transaction_type, payment_method, payment_status, notes, processed_by
) VALUES (
  'sample-bg-002', 'camry', 300.00, 'refund', 'cash', 'completed',
  'Partial refund — $300 back to customer (net $485)', 'admin'
) ON CONFLICT DO NOTHING;


-- ===========================================================================
-- 0005_fixes.sql
-- ===========================================================================
-- 0005_fixes.sql
-- Runtime database fixes for the admin portal audit.
--
-- What this migration does:
--   1. Deduplicates revenue_records by booking_id (keeps oldest row).
--   2. Adds a UNIQUE constraint on revenue_records.booking_id so future
--      idempotent inserts (ON CONFLICT (booking_id) DO NOTHING) work correctly.
--   3. Updates sample customers (from 0004_sample_data.sql) with phone numbers
--      that match the updated bookings.json sample data.
--   4. Updates sample revenue records with the matching customer phone numbers.
--   5. Re-seeds any sample data that may be missing (idempotent via the new
--      unique constraint on booking_id).
--
-- Run AFTER migration 0004 (which must be applied first).
-- Safe to re-run: all statements are idempotent.

-- ── 1. Remove duplicate revenue records, keeping the earliest per booking_id ─

DELETE FROM revenue_records
WHERE id NOT IN (
  SELECT DISTINCT ON (booking_id) id
  FROM revenue_records
  ORDER BY booking_id, created_at ASC
);

-- ── 2. Add unique constraint on revenue_records.booking_id ────────────────────

ALTER TABLE revenue_records
  DROP CONSTRAINT IF EXISTS revenue_records_booking_id_unique;

ALTER TABLE revenue_records
  ADD CONSTRAINT revenue_records_booking_id_unique UNIQUE (booking_id);

-- ── 3. Update sample customers with phone numbers ──────────────────────────────
-- These UPDATE statements are no-ops when the customers do not yet exist;
-- migration 0004 inserts them first and 0005 assigns their phone numbers.

UPDATE customers
SET    phone = '+12135550101', email = 'd.agbebaku@example.com', updated_at = now()
WHERE  name  = 'David Agbebaku' AND (phone IS NULL OR phone = '');

UPDATE customers
SET    phone = '+12135550102', email = 'm.sillah@example.com', updated_at = now()
WHERE  name  = 'Mariatu Sillah' AND (phone IS NULL OR phone = '');

UPDATE customers
SET    phone = '+12135550103', email = 'b.gilot@example.com', updated_at = now()
WHERE  name  = 'Bernard Gilot' AND (phone IS NULL OR phone = '');

-- ── 4. Update sample revenue records with customer phone numbers ───────────────

UPDATE revenue_records
SET    customer_phone = '+12135550101', customer_email = 'd.agbebaku@example.com'
WHERE  booking_id = 'sample-da-001';

UPDATE revenue_records
SET    customer_phone = '+12135550102', customer_email = 'm.sillah@example.com'
WHERE  booking_id = 'sample-ms-001';

UPDATE revenue_records
SET    customer_phone = '+12135550103', customer_email = 'b.gilot@example.com'
WHERE  booking_id = 'sample-bg-002';

-- ── 5. Re-seed any missing sample revenue records (idempotent) ────────────────
-- Now that booking_id has a unique constraint, ON CONFLICT (booking_id) DO NOTHING
-- works correctly and prevents duplicates on repeated migration runs.

INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-da-001', 'camry2013', 'David Agbebaku', '+12135550101', 'd.agbebaku@example.com',
  '2025-10-01', '2025-10-08',
  479.59, 0, 0,
  'stripe', 'paid',
  '7-day rental — sample booking', true
) ON CONFLICT (booking_id) DO NOTHING;

INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-ms-001', 'camry', 'Mariatu Sillah', '+12135550102', 'm.sillah@example.com',
  '2025-11-15', '2025-11-19',
  200.00, 0, 0,
  'cash', 'paid',
  '4-day rental — sample booking', true
) ON CONFLICT (booking_id) DO NOTHING;

INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'sample-bg-002', 'camry', 'Bernard Gilot', '+12135550103', 'b.gilot@example.com',
  '2025-12-01', '2025-12-12',
  785.00, 0, 300.00,
  'cash', 'partial',
  '11-day rental — $300 refunded, net $485', true
) ON CONFLICT (booking_id) DO NOTHING;

-- ── 6. Re-seed any missing sample customers (idempotent via phone unique index) ─

INSERT INTO customers (name, phone, email, total_bookings, total_spent, first_booking_date, last_booking_date)
VALUES
  ('David Agbebaku',  '+12135550101', 'd.agbebaku@example.com', 1, 479.59, '2025-10-01', '2025-10-08'),
  ('Mariatu Sillah',  '+12135550102', 'm.sillah@example.com',   1, 200.00, '2025-11-15', '2025-11-19'),
  ('Bernard Gilot',   '+12135550103', 'b.gilot@example.com',    1, 785.00, '2025-12-01', '2025-12-12')
ON CONFLICT (phone) DO UPDATE
  SET
    email              = EXCLUDED.email,
    total_bookings     = EXCLUDED.total_bookings,
    total_spent        = EXCLUDED.total_spent,
    first_booking_date = EXCLUDED.first_booking_date,
    last_booking_date  = EXCLUDED.last_booking_date,
    updated_at         = now()
  WHERE customers.phone = EXCLUDED.phone;


-- ===========================================================================
-- 0006_expenses_and_real_data.sql
-- ===========================================================================
-- 0006_expenses_and_real_data.sql
--
-- What this migration does:
--   1. Creates the `expenses` table so expense records are stored in Supabase
--      instead of GitHub (more reliable for reads AND writes).
--   2. Removes stale 2025 sample revenue records and fake-phone customers that
--      were seeded by migrations 0004 and 0005.
--   3. Inserts real 2026 revenue records and real customer profiles for the
--      three actual rentals on record.
--
-- Safe to re-run: all DML uses ON CONFLICT / WHERE guards.

-- ── 1. Create expenses table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS expenses (
  expense_id  text        PRIMARY KEY,
  vehicle_id  text        NOT NULL,
  date        date        NOT NULL,
  category    text        NOT NULL
                          CHECK (category IN ('maintenance','insurance','repair','fuel','registration','other')),
  amount      numeric(10,2) NOT NULL CHECK (amount > 0),
  notes       text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expenses_vehicle_id_idx ON expenses (vehicle_id);
CREATE INDEX IF NOT EXISTS expenses_date_idx       ON expenses (date DESC);

-- ── 2. Remove stale 2025 sample revenue records ───────────────────────────
-- These were seeded by migrations 0004/0005 with fake booking IDs and
-- placeholder 2025 dates.  Real 2026 records are inserted below.

DELETE FROM revenue_records
WHERE booking_id IN ('sample-da-001', 'sample-ms-001', 'sample-bg-002');

-- ── 3. Remove stale sample customers (identified by fake phone numbers) ───
-- Migrations 0004/0005 seeded these with placeholder phones (+12135550101 etc.).
-- Real customers with actual phones are upserted below.

DELETE FROM customers
WHERE phone IN ('+12135550101', '+12135550102', '+12135550103');

-- ── 4. Upsert real 2026 revenue records ───────────────────────────────────

-- David Agbebaku — Camry 2013 SE, 7 days, $479.59 (active rental)
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'bk-da-2026-0321', 'camry2013', 'David Agbebaku', '+13463814616', 'davosama15@gmail.com',
  '2026-03-21', '2026-03-28',
  479.59, 0, 0,
  'stripe', 'paid',
  '7-day rental', true
) ON CONFLICT (booking_id) DO NOTHING;

-- Mariatu Sillah — Camry 2012, 4 days, $200
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'bk-ms-2026-0313', 'camry', 'Mariatu Sillah', '+12137296017', 'marysillah23@gamil.com',
  '2026-03-13', '2026-03-17',
  200.00, 0, 0,
  'cash', 'paid',
  '4-day rental', true
) ON CONFLICT (booking_id) DO NOTHING;

-- Bernard Gilot — Camry 2012, 11 days, $785 gross / $300 refund / $485 net
INSERT INTO revenue_records (
  booking_id, vehicle_id, customer_name, customer_phone, customer_email,
  pickup_date, return_date,
  gross_amount, deposit_amount, refund_amount,
  payment_method, payment_status,
  notes, override_by_admin
) VALUES (
  'bk-bg-2026-0219', 'camry', 'Bernard Gilot', '+14075586386', 'gilot42@gmail.com',
  '2026-02-19', '2026-03-02',
  785.00, 0, 300.00,
  'cash', 'partial',
  '11-day rental — $300 refunded (car broke down)', true
) ON CONFLICT (booking_id) DO NOTHING;

-- ── 5. Upsert real 2026 customers ─────────────────────────────────────────

INSERT INTO customers (name, phone, email, total_bookings, total_spent, first_booking_date, last_booking_date)
VALUES
  ('David Agbebaku', '+13463814616', 'davosama15@gmail.com',   1, 479.59, '2026-03-21', '2026-03-28'),
  ('Mariatu Sillah', '+12137296017', 'marysillah23@gamil.com', 1, 200.00, '2026-03-13', '2026-03-17'),
  ('Bernard Gilot',  '+14075586386', 'gilot42@gmail.com',      1, 485.00, '2026-02-19', '2026-03-02')
ON CONFLICT (phone) DO UPDATE
  SET
    name               = EXCLUDED.name,
    email              = EXCLUDED.email,
    total_bookings     = EXCLUDED.total_bookings,
    total_spent        = EXCLUDED.total_spent,
    first_booking_date = EXCLUDED.first_booking_date,
    last_booking_date  = EXCLUDED.last_booking_date,
    updated_at         = now();


-- ===========================================================================
-- 0007_sms_templates_and_fixes.sql
-- ===========================================================================
-- 0007_sms_templates_and_fixes.sql
--
-- What this migration does:
--   1. Ensures all tables from migration 0003 exist (IF NOT EXISTS) so that
--      the admin panel works correctly even if earlier migrations were skipped.
--   2. Adds a sms_template_overrides table for storing SMS template customizations
--      in Supabase instead of GitHub (eliminates SHA-conflict errors).
--   3. Re-seeds default protection plans and system settings if missing.
--
-- Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.

-- ── 1. Ensure revenue_records exists ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS revenue_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id text NOT NULL,
  vehicle_id text NOT NULL,
  customer_name text,
  customer_phone text,
  customer_email text,
  pickup_date date,
  return_date date,
  gross_amount numeric(10,2) NOT NULL DEFAULT 0,
  deposit_amount numeric(10,2) NOT NULL DEFAULT 0,
  refund_amount numeric(10,2) NOT NULL DEFAULT 0,
  net_amount numeric(10,2) GENERATED ALWAYS AS (gross_amount - refund_amount) STORED,
  payment_method text DEFAULT 'stripe',
  payment_status text DEFAULT 'pending',
  protection_plan_id uuid,
  notes text,
  is_no_show boolean DEFAULT false,
  is_cancelled boolean DEFAULT false,
  override_by_admin boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revenue_records_booking_id_idx ON revenue_records (booking_id);
CREATE INDEX IF NOT EXISTS revenue_records_vehicle_id_idx ON revenue_records (vehicle_id);
CREATE INDEX IF NOT EXISTS revenue_records_payment_status_idx ON revenue_records (payment_status);
CREATE INDEX IF NOT EXISTS revenue_records_created_at_idx ON revenue_records (created_at);

-- Add unique constraint on booking_id (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'revenue_records'
      AND constraint_name = 'revenue_records_booking_id_unique'
      AND constraint_type = 'UNIQUE'
  ) THEN
    ALTER TABLE revenue_records ADD CONSTRAINT revenue_records_booking_id_unique UNIQUE (booking_id);
  END IF;
END $$;

-- ── 2. Ensure protection_plans exists ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS protection_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  daily_rate numeric(10,2) NOT NULL DEFAULT 0,
  liability_cap numeric(10,2) DEFAULT 1000,
  is_active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed default protection plans (idempotent via name uniqueness check)
INSERT INTO protection_plans (name, description, daily_rate, liability_cap, is_active, sort_order)
SELECT * FROM (VALUES
  ('None',     'No protection plan selected',          0::numeric,  0::numeric,    true, 0),
  ('Basic',    'Basic damage protection, $1,000 cap',  15::numeric, 1000::numeric, true, 1),
  ('Standard', 'Standard coverage, $500 cap',          25::numeric, 500::numeric,  true, 2),
  ('Premium',  'Full coverage, $0 liability',          40::numeric, 0::numeric,    true, 3)
) AS v(name, description, daily_rate, liability_cap, is_active, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM protection_plans);

-- ── 3. Ensure customers exists ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  email text,
  flagged boolean DEFAULT false,
  banned boolean DEFAULT false,
  flag_reason text,
  ban_reason text,
  total_bookings integer DEFAULT 0,
  total_spent numeric(10,2) DEFAULT 0,
  first_booking_date date,
  last_booking_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_idx ON customers (phone) WHERE phone IS NOT NULL AND phone != '';
CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (email) WHERE email IS NOT NULL AND email != '';
CREATE INDEX IF NOT EXISTS customers_banned_idx ON customers (banned);

-- ── 4. Ensure system_settings exists ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT 'null'::jsonb,
  description text,
  category text DEFAULT 'general',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Seed default settings (idempotent)
INSERT INTO system_settings (key, value, description, category) VALUES
  ('la_tax_rate',                  '0.1025',  'Los Angeles combined sales tax rate',             'tax'),
  ('vehicle_daily_rate',         '350',     'Vehicle R daily rate (USD)',                    'pricing'),
  ('camry_daily_rate',             '55',      'Camry daily rate (USD)',                          'pricing'),
  ('camry_weekly_rate',            '350',     'Camry weekly rate (USD)',                         'pricing'),
  ('camry_biweekly_rate',          '650',     'Camry bi-weekly rate (USD)',                      'pricing'),
  ('camry_monthly_rate',           '1300',    'Camry monthly rate (USD)',                        'pricing'),
  ('vehicle_security_deposit',   '150',     'Vehicle refundable security deposit (USD)',     'pricing'),
  ('vehicle_booking_deposit',    '50',      'Vehicle non-refundable booking deposit',        'pricing'),
  ('auto_block_dates_on_approve',  'true',    'Auto-block vehicle dates when booking approved',  'automation'),
  ('auto_create_revenue_on_pay',   'true',    'Auto-create revenue record when payment received','automation'),
  ('auto_update_customer_stats',   'true',    'Auto-update customer stats on booking events',    'automation'),
  ('notify_sms_on_approve',        'true',    'Send SMS to customer when booking approved',      'notification'),
  ('notify_email_on_approve',      'true',    'Send email to customer when booking approved',    'notification'),
  ('overdue_grace_period_hours',   '2',       'Hours after return time before booking flagged overdue','automation')
ON CONFLICT (key) DO NOTHING;

-- ── 5. Ensure booking_status_history exists ───────────────────────────────────

CREATE TABLE IF NOT EXISTS booking_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id text NOT NULL,
  vehicle_id text,
  old_status text,
  new_status text NOT NULL,
  changed_by text DEFAULT 'admin',
  notes text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bsh_booking_id_idx ON booking_status_history (booking_id);
CREATE INDEX IF NOT EXISTS bsh_changed_at_idx ON booking_status_history (changed_at);

-- ── 6. Ensure payment_transactions exists ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id text NOT NULL,
  vehicle_id text,
  amount numeric(10,2) NOT NULL,
  transaction_type text NOT NULL,
  payment_method text DEFAULT 'stripe',
  payment_status text DEFAULT 'pending',
  stripe_payment_intent_id text,
  stripe_refund_id text,
  notes text,
  processed_by text DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pt_booking_id_idx ON payment_transactions (booking_id);
CREATE INDEX IF NOT EXISTS pt_vehicle_id_idx ON payment_transactions (vehicle_id);
CREATE INDEX IF NOT EXISTS pt_created_at_idx ON payment_transactions (created_at);

-- ── 7. Ensure expenses exists (from migration 0006) ───────────────────────────

CREATE TABLE IF NOT EXISTS expenses (
  expense_id  text        PRIMARY KEY,
  vehicle_id  text        NOT NULL,
  date        date        NOT NULL,
  category    text        NOT NULL
                          CHECK (category IN ('maintenance','insurance','repair','fuel','registration','other')),
  amount      numeric(10,2) NOT NULL CHECK (amount > 0),
  notes       text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expenses_vehicle_id_idx ON expenses (vehicle_id);
CREATE INDEX IF NOT EXISTS expenses_date_idx       ON expenses (date DESC);

-- ── 8. Create sms_template_overrides table ────────────────────────────────────
-- Stores per-template overrides for the SMS Automation admin page.
-- Replaces GitHub JSON file storage to eliminate SHA-conflict (409) errors.

CREATE TABLE IF NOT EXISTS sms_template_overrides (
  template_key  text        PRIMARY KEY,
  message       text,
  enabled       boolean     NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 9. Ensure triggers and helper function exist ──────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'revenue_records_updated_at') THEN
    CREATE TRIGGER revenue_records_updated_at
      BEFORE UPDATE ON revenue_records
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'protection_plans_updated_at') THEN
    CREATE TRIGGER protection_plans_updated_at
      BEFORE UPDATE ON protection_plans
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'customers_updated_at') THEN
    CREATE TRIGGER customers_updated_at
      BEFORE UPDATE ON customers
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'system_settings_updated_at') THEN
    CREATE TRIGGER system_settings_updated_at
      BEFORE UPDATE ON system_settings
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ── 10. Ensure vehicle_revenue_summary view exists ────────────────────────────

CREATE OR REPLACE VIEW vehicle_revenue_summary AS
SELECT
  vehicle_id,
  COUNT(*) FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS booking_count,
  COUNT(*) FILTER (WHERE is_cancelled)  AS cancelled_count,
  COUNT(*) FILTER (WHERE is_no_show)    AS no_show_count,
  SUM(gross_amount) FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS total_gross,
  SUM(refund_amount)                                                    AS total_refunds,
  SUM(net_amount) FILTER (WHERE NOT is_cancelled AND NOT is_no_show)   AS total_net,
  SUM(deposit_amount) FILTER (WHERE NOT is_cancelled)                  AS total_deposits,
  MAX(return_date)  AS last_return_date,
  MIN(pickup_date)  AS first_pickup_date
FROM revenue_records
GROUP BY vehicle_id;


-- ===========================================================================
-- 0008_vehicle_image_storage.sql
-- ===========================================================================
-- =============================================================================
-- SLY RIDES — Migration 0008: Vehicle Image Storage Bucket
-- =============================================================================
--
-- HOW TO USE
-- ----------
-- 1. Open your Supabase project → SQL Editor → New Query
-- 2. Paste this ENTIRE file and click Run
--
-- WHAT THIS DOES
-- --------------
-- 1. Creates a public Supabase Storage bucket called "vehicle-images"
-- 2. Adds RLS (Row Level Security) policies so:
--    • Anyone can READ/VIEW images (required for public <img> tags)
--    • Only the service role (Vercel backend) can UPLOAD / DELETE images
-- =============================================================================

-- 1. Create the bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vehicle-images',
  'vehicle-images',
  true,
  5242880,  -- 5 MB
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif'];

-- 2. Enable RLS on storage.objects (usually already enabled, safe to run)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 3. Drop any stale policies for this bucket before recreating them
DROP POLICY IF EXISTS "vehicle-images: public read"   ON storage.objects;
DROP POLICY IF EXISTS "vehicle-images: service write" ON storage.objects;

-- 4. Allow anyone to read images from this bucket (needed for <img> tags on the site)
CREATE POLICY "vehicle-images: public read"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'vehicle-images');

-- 5. Allow only the service role (our Vercel backend) to insert / update / delete
CREATE POLICY "vehicle-images: service write"
  ON storage.objects
  FOR ALL
  USING (bucket_id = 'vehicle-images' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'vehicle-images' AND auth.role() = 'service_role');


-- ===========================================================================
-- 0009_cms_tables.sql
-- ===========================================================================
-- 0009_cms_tables.sql
--
-- What this migration does:
--   Adds the three CMS-related tables that were introduced in COMPLETE_SETUP.sql
--   but were never included in a numbered migration file.  Any Supabase project
--   that was set up by running only migrations 0001–0008 will be missing these
--   tables, which causes "Database schema error" toasts in the admin panel
--   (System Settings save, Site Settings, Content Blocks pages).
--
--   Tables added:
--     site_settings     — flat key/value store for business name, hero text, etc.
--     content_blocks    — FAQs, announcements, and testimonials
--     content_revisions — revision/audit history for CMS changes
--
-- Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.

-- Ensure the shared updated_at helper function exists (created in 0003/0007 but
-- re-declared here for safety so 0009 can be applied independently).
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
-- ── 1. site_settings ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.site_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_settings_key ON public.site_settings (key);

-- Seed default site settings (idempotent)
INSERT INTO public.site_settings (key, value) VALUES
  ('business_name',        'SLY Transportation Services'),
  ('phone',                ''),
  ('whatsapp',             ''),
  ('email',                ''),
  ('instagram_url',        ''),
  ('facebook_url',         ''),
  ('tiktok_url',           ''),
  ('twitter_url',          ''),
  ('promo_banner_enabled', 'false'),
  ('promo_banner_text',    ''),
  ('hero_title',           'Explore LA in Style'),
  ('hero_subtitle',        'Affordable car rentals in Los Angeles'),
  ('about_text',           ''),
  ('policies_cancellation',''),
  ('policies_damage',      ''),
  ('policies_fuel',        ''),
  ('policies_age',         ''),
  ('service_area_notes',   ''),
  ('pickup_instructions',  '')
ON CONFLICT (key) DO NOTHING;

-- Auto-update trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'site_settings_updated_at') THEN
    CREATE TRIGGER site_settings_updated_at
      BEFORE UPDATE ON public.site_settings
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;


-- ── 2. content_blocks ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.content_blocks (
  block_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT        NOT NULL CHECK (type IN ('faq', 'announcement', 'testimonial')),
  title           TEXT,
  body            TEXT,
  author_name     TEXT,
  author_location TEXT,
  sort_order      INTEGER     NOT NULL DEFAULT 0,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_blocks_type   ON public.content_blocks (type);
CREATE INDEX IF NOT EXISTS idx_content_blocks_active ON public.content_blocks (active);
CREATE INDEX IF NOT EXISTS idx_content_blocks_sort   ON public.content_blocks (sort_order, created_at);

-- Seed starter FAQ content blocks (only if table is empty).
-- Note: the Vehicle deposit amount ($150) mentioned here matches the current
-- pricing in car.js / api/_pricing.js — update this text if pricing changes.
INSERT INTO public.content_blocks (type, title, body, sort_order, active)
SELECT type, title, body, sort_order, active FROM (VALUES
  ('faq', 'What is the minimum rental age?',     'The minimum age to rent is 21 years old. A valid driver''s license is required.',                              1, true),
  ('faq', 'Do you offer airport pickup?',         'Yes, we offer pickup and drop-off at major LA area airports. Please contact us to arrange.',                  2, true),
  ('faq', 'What forms of payment do you accept?', 'We accept all major credit cards via Stripe. Payments are processed securely online.',                        3, true),
  ('faq', 'Is there a security deposit?',         'The Vehicle requires a $150 refundable security deposit collected at pickup. The Camry has no deposit.',    4, true)
) AS v(type, title, body, sort_order, active)
WHERE NOT EXISTS (SELECT 1 FROM public.content_blocks);

-- Auto-update trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'content_blocks_updated_at') THEN
    CREATE TRIGGER content_blocks_updated_at
      BEFORE UPDATE ON public.content_blocks
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;


-- ── 3. content_revisions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.content_revisions (
  id            BIGSERIAL   PRIMARY KEY,
  resource_type TEXT        NOT NULL,
  resource_id   TEXT        NOT NULL,
  before        JSONB,
  after         JSONB,
  changed_keys  TEXT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_revisions_resource
  ON public.content_revisions (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_content_revisions_created
  ON public.content_revisions (created_at DESC);


-- ===========================================================================
-- 0010_ensure_all_v2_tables.sql
-- ===========================================================================
-- 0010_ensure_all_v2_tables.sql
--
-- What this migration does:
--   Idempotent catch-up migration that ensures every table required by the
--   Fleet Control v2 admin panel exists, regardless of which earlier migrations
--   have been applied.  Safe to re-run: all statements use IF NOT EXISTS /
--   ON CONFLICT DO NOTHING.
--
--   Tables ensured:
--     revenue_records        — per-booking revenue ledger
--     expenses               — vehicle operating-cost records
--     protection_plans       — configurable rental coverage plans
--     customers              — customer profiles and flag/ban data
--     system_settings        — admin-controlled configuration key/value store
--     sms_template_overrides — customised SMS message templates
--
--   Also ensures:
--     • The unique constraint on revenue_records.booking_id
--     • The update_updated_at_column() trigger function and triggers on every table
--     • Default seed rows for protection_plans and system_settings

-- ── Trigger helper (safe re-declare) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── 1. revenue_records ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue_records (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        text        NOT NULL,
  vehicle_id        text        NOT NULL,
  customer_name     text,
  customer_phone    text,
  customer_email    text,
  pickup_date       date,
  return_date       date,
  gross_amount      numeric(10,2) NOT NULL DEFAULT 0,
  deposit_amount    numeric(10,2) NOT NULL DEFAULT 0,
  refund_amount     numeric(10,2) NOT NULL DEFAULT 0,
  net_amount        numeric(10,2) GENERATED ALWAYS AS (gross_amount - refund_amount) STORED,
  payment_method    text        DEFAULT 'stripe',
  payment_status    text        DEFAULT 'pending',
  protection_plan_id uuid,
  notes             text,
  is_no_show        boolean     DEFAULT false,
  is_cancelled      boolean     DEFAULT false,
  override_by_admin boolean     DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS revenue_records_booking_id_idx     ON revenue_records (booking_id);
CREATE INDEX IF NOT EXISTS revenue_records_vehicle_id_idx     ON revenue_records (vehicle_id);
CREATE INDEX IF NOT EXISTS revenue_records_payment_status_idx ON revenue_records (payment_status);
CREATE INDEX IF NOT EXISTS revenue_records_created_at_idx     ON revenue_records (created_at);

-- Add unique constraint on booking_id if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'revenue_records'
      AND constraint_name = 'revenue_records_booking_id_unique'
  ) THEN
    -- Remove duplicates before adding the constraint
    DELETE FROM revenue_records
    WHERE id NOT IN (
      SELECT MIN(id::text)::uuid
      FROM revenue_records
      GROUP BY booking_id
    );
    ALTER TABLE revenue_records ADD CONSTRAINT revenue_records_booking_id_unique UNIQUE (booking_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS revenue_records_updated_at ON revenue_records;
CREATE TRIGGER revenue_records_updated_at
  BEFORE UPDATE ON revenue_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 2. expense_categories ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_categories (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  group_name  text        NOT NULL,
  is_default  boolean     NOT NULL DEFAULT false,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, group_name)
);
CREATE INDEX IF NOT EXISTS expense_categories_group_idx  ON expense_categories (group_name);
CREATE INDEX IF NOT EXISTS expense_categories_active_idx ON expense_categories (is_active);

INSERT INTO expense_categories (name, group_name, is_default, is_active) VALUES
  ('Loan / Lease','Ownership',true,true),('Insurance','Ownership',true,true),
  ('Registration','Ownership',true,true),('Taxes','Ownership',true,true),
  ('Fuel','Usage',true,true),('EV Charging','Usage',true,true),
  ('Parking','Usage',true,true),('Tolls','Usage',true,true),
  ('Oil Change','Maintenance',true,true),('Tires','Maintenance',true,true),
  ('Brakes','Maintenance',true,true),('Fluids','Maintenance',true,true),
  ('Filters','Maintenance',true,true),('Battery','Maintenance',true,true),
  ('Inspection / Emissions','Maintenance',true,true),
  ('Repair (General)','Repairs',true,true),('Parts','Repairs',true,true),
  ('Labor','Repairs',true,true),('Diagnostics','Repairs',true,true),
  ('Car Wash','Cleaning',true,true),('Detailing','Cleaning',true,true),
  ('Accessories','Extras',true,true),('Mods / Upgrades','Extras',true,true),
  ('Subscriptions','Extras',true,true),
  ('Fines / Tickets','Incidents',true,true),('Towing','Incidents',true,true),
  ('Accident / Damage','Incidents',true,true),('Insurance Deductible','Incidents',true,true),
  ('Depreciation','Advanced',true,false),('Mileage','Advanced',true,false),
  ('Rental / Replacement','Advanced',true,false),('Other','Other',true,false)
ON CONFLICT (name, group_name) DO NOTHING;

-- ── 3. expenses ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id  text        UNIQUE,
  vehicle_id  text        NOT NULL,
  date        date        NOT NULL,
  category    text        NOT NULL,
  category_id uuid        REFERENCES expense_categories(id),
  amount      numeric(10,2) NOT NULL DEFAULT 0,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_vehicle_id_idx  ON expenses (vehicle_id);
CREATE INDEX IF NOT EXISTS expenses_date_idx        ON expenses (date DESC);
CREATE INDEX IF NOT EXISTS expenses_category_id_idx ON expenses (category_id);

DROP TRIGGER IF EXISTS expenses_updated_at ON expenses;
CREATE TRIGGER expenses_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 3. protection_plans ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS protection_plans (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  description   text,
  daily_rate    numeric(10,2) NOT NULL DEFAULT 0,
  liability_cap numeric(10,2) DEFAULT 1000,
  is_active     boolean     DEFAULT true,
  sort_order    integer     DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO protection_plans (name, description, daily_rate, liability_cap, is_active, sort_order) VALUES
  ('None',     'No protection plan selected',          0,     0,    true, 0),
  ('Basic',    'Basic damage protection, $1,000 cap',  15,    1000, true, 1),
  ('Standard', 'Standard coverage, $500 cap',          25,    500,  true, 2),
  ('Premium',  'Full coverage, $0 liability',          40,    0,    true, 3)
ON CONFLICT DO NOTHING;

DROP TRIGGER IF EXISTS protection_plans_updated_at ON protection_plans;
CREATE TRIGGER protection_plans_updated_at
  BEFORE UPDATE ON protection_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 4. customers ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text        NOT NULL,
  phone              text,
  email              text,
  flagged            boolean     DEFAULT false,
  banned             boolean     DEFAULT false,
  flag_reason        text,
  ban_reason         text,
  total_bookings     integer     DEFAULT 0,
  total_spent        numeric(10,2) DEFAULT 0,
  first_booking_date date,
  last_booking_date  date,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_idx ON customers (phone) WHERE phone IS NOT NULL AND phone != '';
CREATE INDEX        IF NOT EXISTS customers_email_idx  ON customers (email)  WHERE email  IS NOT NULL AND email  != '';
CREATE INDEX        IF NOT EXISTS customers_banned_idx  ON customers (banned);

DROP TRIGGER IF EXISTS customers_updated_at ON customers;
CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 5. system_settings ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL DEFAULT 'null'::jsonb,
  description text,
  category    text        DEFAULT 'general',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

INSERT INTO system_settings (key, value, description, category) VALUES
  ('la_tax_rate',                  '0.1025',  'Los Angeles combined sales tax rate',                      'tax'),
  ('vehicle_daily_rate',         '350',     'Vehicle R daily rate (USD)',                             'pricing'),
  ('camry_daily_rate',             '55',      'Camry daily rate (USD)',                                   'pricing'),
  ('camry_weekly_rate',            '350',     'Camry weekly rate (USD)',                                  'pricing'),
  ('camry_biweekly_rate',          '650',     'Camry bi-weekly rate (USD)',                               'pricing'),
  ('camry_monthly_rate',           '1300',    'Camry monthly rate (USD)',                                 'pricing'),
  ('vehicle_security_deposit',   '150',     'Vehicle refundable security deposit (USD)',              'pricing'),
  ('vehicle_booking_deposit',    '50',      'Vehicle non-refundable booking deposit',                 'pricing'),
  ('auto_block_dates_on_approve',  'true',    'Auto-block vehicle dates when booking approved',           'automation'),
  ('auto_create_revenue_on_pay',   'true',    'Auto-create revenue record when payment received',         'automation'),
  ('auto_update_customer_stats',   'true',    'Auto-update customer stats on booking events',             'automation'),
  ('notify_sms_on_approve',        'true',    'Send SMS to customer when booking approved',               'notification'),
  ('notify_email_on_approve',      'true',    'Send email to customer when booking approved',             'notification'),
  ('overdue_grace_period_hours',   '2',       'Hours after return time before booking flagged overdue',   'automation')
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS system_settings_updated_at ON system_settings;
CREATE TRIGGER system_settings_updated_at
  BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 6. sms_template_overrides ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_template_overrides (
  template_key text        PRIMARY KEY,
  message      text        NOT NULL,
  enabled      boolean     NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── 7. vehicle_revenue_summary view ──────────────────────────────────────────
CREATE OR REPLACE VIEW vehicle_revenue_summary AS
SELECT
  vehicle_id,
  COUNT(*) FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS booking_count,
  COUNT(*) FILTER (WHERE is_cancelled)  AS cancelled_count,
  COUNT(*) FILTER (WHERE is_no_show)    AS no_show_count,
  SUM(gross_amount)  FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS total_gross,
  SUM(refund_amount)                                                     AS total_refunds,
  SUM(net_amount)    FILTER (WHERE NOT is_cancelled AND NOT is_no_show) AS total_net,
  SUM(deposit_amount) FILTER (WHERE NOT is_cancelled)                   AS total_deposits,
  MAX(return_date)  AS last_return_date,
  MIN(pickup_date)  AS first_pickup_date
FROM revenue_records
GROUP BY vehicle_id;


-- ===========================================================================
-- 0011_fix_vehicle_cover_images.sql
-- ===========================================================================
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


-- ===========================================================================
-- 0012_ensure_vehicle_names.sql
-- ===========================================================================
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


-- ===========================================================================
-- 0013_remove_vehicle2_vehicle3.sql
-- ===========================================================================
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


-- ===========================================================================
-- 0014_rental_management_backend.sql
-- ===========================================================================
-- =============================================================================
-- SLY RIDES — Rental Management Backend
-- Migration 0014: Normalized bookings, payments, blocked_dates, revenue tables
-- =============================================================================
--
-- What this migration does:
--   1. Adds normalized columns to existing `vehicles` table
--   2. Adds new columns (full_name, driver_license, risk_flag) to `customers`
--   3. Creates `bookings` table (full rental booking structure with FKs)
--   4. Creates `payments` table (payment tracking, FK → bookings)
--   5. Creates `blocked_dates` table (availability management, FK → vehicles)
--   6. Creates `revenue` table (per-booking revenue ledger, FK → bookings/vehicles)
--   7. Creates PG trigger functions for booking automation:
--        check_booking_conflicts   — BEFORE INSERT: reject overlapping bookings
--        on_booking_create         — AFTER INSERT: auto-create blocked_dates + revenue
--        on_booking_status_change  — AFTER UPDATE status: vehicle rental_status sync
--        on_payment_create         — AFTER INSERT payments: update booking payment fields
--   8. Migrates the 3 existing bookings from bookings.json (idempotent)
--
-- Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT guards.
-- =============================================================================

-- ── 1. Update vehicles table ──────────────────────────────────────────────────
-- Adds normalized columns alongside the existing vehicle_id (text PK) + data (JSONB).

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_name   text;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_type   text;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS daily_price    numeric(10,2);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS deposit_amount numeric(10,2);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rental_status  text DEFAULT 'available';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS mileage        numeric(10,0) DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS created_at     timestamptz   DEFAULT now();

-- Check constraint for rental_status
DO $$
BEGIN
  ALTER TABLE vehicles ADD CONSTRAINT vehicles_rental_status_check
    CHECK (rental_status IN ('available', 'rented', 'maintenance'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Populate normalized columns from JSONB data (idempotent)
UPDATE vehicles SET
  vehicle_name   = COALESCE(vehicle_name,   data->>'vehicle_name'),
  vehicle_type   = COALESCE(vehicle_type,   data->>'type'),
  daily_price    = COALESCE(daily_price,    CASE
    WHEN vehicle_id IN ('vehicle','vehicle2','vehicle3') THEN 350
    WHEN vehicle_id IN ('camry','camry2013')                   THEN  55
    ELSE 0
  END),
  deposit_amount = COALESCE(deposit_amount, CASE
    WHEN vehicle_id IN ('vehicle','vehicle2','vehicle3') THEN 150
    ELSE 0
  END),
  rental_status  = COALESCE(rental_status, 'available'),
  mileage        = COALESCE(mileage, 0),
  created_at     = COALESCE(created_at, now())
WHERE vehicle_name IS NULL
   OR vehicle_type IS NULL
   OR daily_price  IS NULL;

-- ── 2. Update customers table ─────────────────────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS full_name      text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS driver_license text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS risk_flag      text DEFAULT 'low';

-- Check constraint for risk_flag
DO $$
BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_risk_flag_check
    CHECK (risk_flag IN ('low', 'medium', 'high'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Populate full_name from name; derive risk_flag from existing flagged/banned booleans
UPDATE customers SET
  full_name = COALESCE(full_name, name),
  risk_flag = CASE
    WHEN risk_flag IS NOT NULL AND risk_flag NOT IN ('low') THEN risk_flag
    WHEN banned  = true THEN 'high'
    WHEN flagged = true THEN 'medium'
    ELSE 'low'
  END
WHERE full_name IS NULL
   OR (risk_flag = 'low' AND (flagged = true OR banned = true));

-- ── 3. Create bookings table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref       text          UNIQUE,                                    -- original bookingId
  customer_id       uuid          REFERENCES customers(id) ON DELETE SET NULL,
  vehicle_id        text          REFERENCES vehicles(vehicle_id) ON DELETE RESTRICT,
  pickup_date       date,
  return_date       date,
  pickup_time       time,
  return_time       time,
  status            text          NOT NULL DEFAULT 'pending',
  total_price       numeric(10,2) NOT NULL DEFAULT 0,
  deposit_paid      numeric(10,2) NOT NULL DEFAULT 0,
  remaining_balance numeric(10,2) NOT NULL DEFAULT 0,
  payment_status    text          NOT NULL DEFAULT 'unpaid',
  notes             text,
  payment_method    text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN ('pending','approved','active','completed','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check
    CHECK (payment_status IN ('unpaid','partial','paid'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS bookings_customer_id_idx  ON bookings (customer_id);
CREATE INDEX IF NOT EXISTS bookings_vehicle_id_idx   ON bookings (vehicle_id);
CREATE INDEX IF NOT EXISTS bookings_pickup_date_idx  ON bookings (pickup_date);
CREATE INDEX IF NOT EXISTS bookings_return_date_idx  ON bookings (return_date);
CREATE INDEX IF NOT EXISTS bookings_status_idx       ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_created_at_idx   ON bookings (created_at DESC);

DROP TRIGGER IF EXISTS bookings_updated_at ON bookings;
CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 4. Create payments table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid          REFERENCES bookings(id) ON DELETE CASCADE,
  amount      numeric(10,2) NOT NULL DEFAULT 0,
  type        text          NOT NULL DEFAULT 'full',
  method      text          NOT NULL DEFAULT 'card',
  status      text          NOT NULL DEFAULT 'completed',
  notes       text,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_type_check
    CHECK (type IN ('deposit','full','refund'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_method_check
    CHECK (method IN ('card','cash','zelle'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS payments_booking_id_idx  ON payments (booking_id);
CREATE INDEX IF NOT EXISTS payments_created_at_idx  ON payments (created_at DESC);

-- ── 5. Create blocked_dates table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blocked_dates (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  text        REFERENCES vehicles(vehicle_id) ON DELETE CASCADE,
  start_date  date        NOT NULL,
  end_date    date        NOT NULL,
  reason      text        NOT NULL DEFAULT 'manual',
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE blocked_dates ADD CONSTRAINT blocked_dates_reason_check
    CHECK (reason IN ('booking','maintenance','manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Unique constraint enables ON CONFLICT DO NOTHING in triggers and migrations
CREATE UNIQUE INDEX IF NOT EXISTS blocked_dates_vehicle_dates_reason_idx
  ON blocked_dates (vehicle_id, start_date, end_date, reason);
CREATE INDEX IF NOT EXISTS blocked_dates_vehicle_id_idx  ON blocked_dates (vehicle_id);
CREATE INDEX IF NOT EXISTS blocked_dates_start_date_idx  ON blocked_dates (start_date);

-- ── 6. Create revenue table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid          UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  vehicle_id  text          REFERENCES vehicles(vehicle_id) ON DELETE RESTRICT,
  gross       numeric(10,2) NOT NULL DEFAULT 0,
  expenses    numeric(10,2) NOT NULL DEFAULT 0,
  net         numeric(10,2) GENERATED ALWAYS AS (gross - expenses) STORED,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revenue_vehicle_id_idx   ON revenue (vehicle_id);
CREATE INDEX IF NOT EXISTS revenue_created_at_idx   ON revenue (created_at DESC);

-- ── 7. Trigger functions ──────────────────────────────────────────────────────

-- 7a. BEFORE INSERT: reject overlapping bookings and blocked_dates conflicts
CREATE OR REPLACE FUNCTION check_booking_conflicts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_conflict_id uuid;
  v_blocked_vid text;
BEGIN
  -- Cancelled bookings never conflict
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Require pickup_date and return_date for conflict checks
  IF NEW.pickup_date IS NULL OR NEW.return_date IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check for overlapping non-cancelled bookings on the same vehicle
  SELECT id INTO v_conflict_id
  FROM   bookings
  WHERE  vehicle_id   = NEW.vehicle_id
    AND  status      NOT IN ('cancelled')
    AND  pickup_date <= NEW.return_date
    AND  return_date >= NEW.pickup_date
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Booking conflict: vehicle % is already booked for % to % (conflicts with booking %)',
      NEW.vehicle_id, NEW.pickup_date, NEW.return_date, v_conflict_id;
  END IF;

  -- Check blocked_dates conflicts (maintenance / manual blocks)
  SELECT vehicle_id INTO v_blocked_vid
  FROM   blocked_dates
  WHERE  vehicle_id  = NEW.vehicle_id
    AND  reason     != 'booking'         -- booking-reason blocks are managed by this system
    AND  start_date <= NEW.return_date
    AND  end_date   >= NEW.pickup_date
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Date conflict: vehicle % has blocked dates overlapping with % to %',
      NEW.vehicle_id, NEW.pickup_date, NEW.return_date;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_check_conflicts ON bookings;
CREATE TRIGGER bookings_check_conflicts
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION check_booking_conflicts();

-- 7b. AFTER INSERT: auto-create blocked_dates entry and revenue record
CREATE OR REPLACE FUNCTION on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Auto-create a blocked_dates entry for this booking period
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason)
    VALUES (NEW.vehicle_id, NEW.pickup_date, NEW.return_date, 'booking')
    ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
  END IF;

  -- Auto-create a revenue record when the booking has a price
  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0)
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  -- Mark vehicle as rented if booking starts in active state
  IF NEW.status = 'active' THEN
    UPDATE vehicles SET rental_status = 'rented'
    WHERE vehicle_id = NEW.vehicle_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_after_insert ON bookings;
CREATE TRIGGER bookings_after_insert
  AFTER INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_create();

-- 7c. AFTER UPDATE OF status: sync vehicle rental_status and clean up on cancel
CREATE OR REPLACE FUNCTION on_booking_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  CASE NEW.status
    WHEN 'active' THEN
      UPDATE vehicles SET rental_status = 'rented'
      WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'completed' THEN
      UPDATE vehicles SET rental_status = 'available'
      WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'cancelled' THEN
      -- Remove the booking-created blocked_dates entry
      DELETE FROM blocked_dates
      WHERE  vehicle_id = NEW.vehicle_id
        AND  start_date = NEW.pickup_date
        AND  end_date   = NEW.return_date
        AND  reason     = 'booking';

      -- Remove revenue record only if no payment was received
      IF NEW.deposit_paid = 0 THEN
        DELETE FROM revenue WHERE booking_id = NEW.id;
      END IF;

      -- Restore vehicle to available if it was actively rented
      IF OLD.status = 'active' THEN
        UPDATE vehicles SET rental_status = 'available'
        WHERE vehicle_id = NEW.vehicle_id;
      END IF;

    ELSE
      NULL;
  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_after_status_change ON bookings;
CREATE TRIGGER bookings_after_status_change
  AFTER UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_status_change();

-- 7d. AFTER INSERT on payments: update booking deposit_paid / remaining_balance / payment_status
CREATE OR REPLACE FUNCTION on_payment_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_total_price      numeric;
  v_new_deposit_paid numeric;
  v_new_pay_status   text;
BEGIN
  SELECT total_price, deposit_paid
  INTO   v_total_price, v_new_deposit_paid
  FROM   bookings
  WHERE  id = NEW.booking_id;

  IF NOT FOUND THEN RETURN NEW; END IF;

  IF NEW.type = 'refund' THEN
    v_new_deposit_paid := GREATEST(0, v_new_deposit_paid - NEW.amount);
  ELSE
    v_new_deposit_paid := v_new_deposit_paid + NEW.amount;
  END IF;

  IF v_total_price > 0 AND v_new_deposit_paid >= v_total_price THEN
    v_new_pay_status := 'paid';
  ELSIF v_new_deposit_paid > 0 THEN
    v_new_pay_status := 'partial';
  ELSE
    v_new_pay_status := 'unpaid';
  END IF;

  UPDATE bookings SET
    deposit_paid      = v_new_deposit_paid,
    remaining_balance = GREATEST(0, v_total_price - v_new_deposit_paid),
    payment_status    = v_new_pay_status
  WHERE id = NEW.booking_id;

  -- Keep revenue gross in sync for non-refund payments
  IF NEW.type != 'refund' THEN
    UPDATE revenue SET gross = v_new_deposit_paid
    WHERE booking_id = NEW.booking_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payments_after_insert ON payments;
CREATE TRIGGER payments_after_insert
  AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION on_payment_create();

-- ── 8. Data migration: seed existing bookings from bookings.json ──────────────
-- Three real bookings:
--   bk-ms-2026-0313  Mariatu Sillah  — camry      2026-03-13 → 2026-03-17  completed  cash    $200
--   bk-bg-2026-0219  Bernard Gilot   — camry      2026-02-19 → 2026-03-02  completed  cash    $485 net
--   bk-da-2026-0321  David Agbebaku  — camry2013  2026-03-21 → 2026-03-28  active     stripe  $479.59
--
-- Safe to re-run: ON CONFLICT (phone) and ON CONFLICT (booking_ref) guards.

-- Ensure customers exist (may already have been seeded by earlier migrations)
INSERT INTO customers (name, full_name, phone, email, risk_flag)
VALUES
  ('Mariatu Sillah', 'Mariatu Sillah', '+12137296017', 'marysillah23@gamil.com', 'low'),
  ('Bernard Gilot',  'Bernard Gilot',  '+14075586386', 'gilot42@gmail.com',      'low'),
  ('David Agbebaku', 'David Agbebaku', '+13463814616', 'davosama15@gmail.com',   'low')
ON CONFLICT (phone) DO UPDATE
  SET
    full_name  = COALESCE(customers.full_name,  EXCLUDED.full_name),
    email      = COALESCE(customers.email,      EXCLUDED.email),
    risk_flag  = COALESCE(customers.risk_flag,  EXCLUDED.risk_flag),
    updated_at = now();

-- Disable the conflict-check trigger so historical data can be inserted without
-- availability validation (these bookings are in the past / already active).
ALTER TABLE bookings DISABLE TRIGGER bookings_check_conflicts;

-- bk-ms-2026-0313 — Mariatu Sillah
INSERT INTO bookings (
  booking_ref, customer_id, vehicle_id,
  pickup_date, return_date, pickup_time, return_time,
  status, total_price, deposit_paid, remaining_balance, payment_status,
  notes, payment_method, created_at
)
SELECT
  'bk-ms-2026-0313', c.id, 'camry',
  '2026-03-13', '2026-03-17', '11:00:00', '11:00:00',
  'completed', 200.00, 200.00, 0.00, 'paid',
  '4-day rental', 'cash', '2026-03-12 18:00:00+00'
FROM customers c WHERE c.phone = '+12137296017'
ON CONFLICT (booking_ref) DO NOTHING;

-- bk-bg-2026-0219 — Bernard Gilot ($300 refunded; net 485)
INSERT INTO bookings (
  booking_ref, customer_id, vehicle_id,
  pickup_date, return_date, pickup_time, return_time,
  status, total_price, deposit_paid, remaining_balance, payment_status,
  notes, payment_method, created_at
)
SELECT
  'bk-bg-2026-0219', c.id, 'camry',
  '2026-02-19', '2026-03-02', '21:00:00', '21:00:00',
  'completed', 485.00, 485.00, 0.00, 'paid',
  '$300 refunded — car broke down', 'cash', '2026-02-18 18:00:00+00'
FROM customers c WHERE c.phone = '+14075586386'
ON CONFLICT (booking_ref) DO NOTHING;

-- bk-da-2026-0321 — David Agbebaku
INSERT INTO bookings (
  booking_ref, customer_id, vehicle_id,
  pickup_date, return_date, pickup_time, return_time,
  status, total_price, deposit_paid, remaining_balance, payment_status,
  notes, payment_method, created_at
)
SELECT
  'bk-da-2026-0321', c.id, 'camry2013',
  '2026-03-21', '2026-03-28', '22:45:00', '05:45:00',
  'active', 479.59, 479.59, 0.00, 'paid',
  '7-day rental', 'stripe', '2026-03-20 18:00:00+00'
FROM customers c WHERE c.phone = '+13463814616'
ON CONFLICT (booking_ref) DO NOTHING;

-- Re-enable the conflict-check trigger
ALTER TABLE bookings ENABLE TRIGGER bookings_check_conflicts;

-- blocked_dates for migrated bookings
-- (the AFTER INSERT trigger already inserted these, but ON CONFLICT ensures idempotency)
INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason)
SELECT b.vehicle_id, b.pickup_date, b.return_date, 'booking'
FROM   bookings b
WHERE  b.booking_ref IN ('bk-ms-2026-0313','bk-bg-2026-0219','bk-da-2026-0321')
  AND  b.status NOT IN ('cancelled')
ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;

-- revenue records for migrated bookings
INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
SELECT b.id, b.vehicle_id, b.deposit_paid, 0
FROM   bookings b
WHERE  b.booking_ref IN ('bk-ms-2026-0313','bk-bg-2026-0219','bk-da-2026-0321')
  AND  b.deposit_paid > 0
ON CONFLICT (booking_id) DO NOTHING;

-- =============================================================================
-- DONE
-- All new tables (bookings, payments, blocked_dates, revenue), updated columns
-- (vehicles.vehicle_name/type/daily_price/deposit_amount/rental_status/mileage,
--  customers.full_name/driver_license/risk_flag), PG triggers, and migrated
-- booking data are now in place.  Safe to re-run.
-- =============================================================================


-- ===========================================================================
-- 0015_conflict_and_status_fixes.sql
-- ===========================================================================
-- =============================================================================
-- SLY RIDES — Migration 0015: Conflict & Status Fixes
-- =============================================================================
--
-- What this migration does:
--   1. Adds 'reserved' to vehicles.rental_status check constraint
--      (approved bookings mark the vehicle as reserved while awaiting pickup)
--   2. Replaces check_booking_conflicts trigger with a datetime-aware version
--      that combines pickup_date + pickup_time and return_date + return_time
--      so that back-to-back bookings on the same day are allowed
--   3. Updates on_booking_status_change trigger to implement the full flow:
--        pending  → vehicle available
--        approved → vehicle reserved
--        active   → vehicle rented
--        completed → vehicle available
--        cancelled → vehicle available (was: active only)
--   4. Updates on_booking_create trigger to set vehicle reserved when a new
--      booking is inserted with status = 'approved'
--
-- Safe to re-run: all statements use CREATE OR REPLACE / DROP IF EXISTS guards.
-- =============================================================================

-- ── 1. Add 'reserved' to rental_status check constraint ──────────────────────
-- We must drop the old constraint and recreate it with the new allowed values.
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_rental_status_check;

ALTER TABLE vehicles ADD CONSTRAINT vehicles_rental_status_check
  CHECK (rental_status IN ('available', 'reserved', 'rented', 'maintenance'));

-- ── 2. Datetime-aware conflict check trigger ──────────────────────────────────
-- Helper: combine a date + time column pair into a timestamp.
-- When time is NULL and is_end = false: uses midnight (start of day).
-- When time is NULL and is_end = true:  uses midnight of the NEXT day (exclusive
--   end boundary) so that the full last day is included.  This is consistent with
--   the JavaScript hasDateTimeOverlap helper in api/_availability.js.
CREATE OR REPLACE FUNCTION booking_datetime(d date, t time, is_end boolean DEFAULT false)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t IS NOT NULL THEN (d + t)::timestamptz
    WHEN is_end        THEN (d + interval '1 day')::timestamptz
    ELSE                    d::timestamptz          -- midnight
  END
$$;

-- Recreate the conflict-check trigger with datetime precision
CREATE OR REPLACE FUNCTION check_booking_conflicts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_conflict_id uuid;
  v_blocked_vid text;
  new_start     timestamptz;
  new_end       timestamptz;
BEGIN
  -- Cancelled bookings never conflict
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Require at least pickup_date for conflict checks
  IF NEW.pickup_date IS NULL THEN
    RETURN NEW;
  END IF;

  new_start := booking_datetime(NEW.pickup_date,  NEW.pickup_time,  false);
  new_end   := booking_datetime(NEW.return_date,  NEW.return_time,  true);

  -- Check for overlapping non-cancelled bookings on the same vehicle.
  -- Two bookings overlap when: existing.start < new.end AND existing.end > new.start
  SELECT b.id INTO v_conflict_id
  FROM   bookings b
  WHERE  b.vehicle_id = NEW.vehicle_id
    AND  b.status NOT IN ('cancelled')
    AND  b.id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND  booking_datetime(b.pickup_date, b.pickup_time, false) < new_end
    AND  booking_datetime(b.return_date, b.return_time, true)  > new_start
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Booking conflict: vehicle % is already booked overlapping % to % (conflicts with booking %)',
      NEW.vehicle_id,
      new_start AT TIME ZONE 'UTC',
      new_end   AT TIME ZONE 'UTC',
      v_conflict_id;
  END IF;

  -- Check blocked_dates conflicts (maintenance / manual blocks only — not 'booking'
  -- rows, which are managed by the bookings table itself).
  SELECT bd.vehicle_id INTO v_blocked_vid
  FROM   blocked_dates bd
  WHERE  bd.vehicle_id = NEW.vehicle_id
    AND  bd.reason    != 'booking'
    AND  bd.start_date <= COALESCE(NEW.return_date, NEW.pickup_date)
    AND  bd.end_date   >= NEW.pickup_date
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Date conflict: vehicle % has blocked dates overlapping with % to %',
      NEW.vehicle_id, NEW.pickup_date, COALESCE(NEW.return_date, NEW.pickup_date);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_check_conflicts ON bookings;
CREATE TRIGGER bookings_check_conflicts
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION check_booking_conflicts();

-- ── 3. Updated on_booking_create trigger ─────────────────────────────────────
-- Status → vehicle rental_status on INSERT:
--   approved → reserved   (vehicle held, awaiting pickup)
--   active   → rented     (vehicle on the road)
--   (other statuses leave rental_status unchanged on insert)
CREATE OR REPLACE FUNCTION on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Auto-create a blocked_dates entry for this booking period
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason)
    VALUES (NEW.vehicle_id, NEW.pickup_date, NEW.return_date, 'booking')
    ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
  END IF;

  -- Auto-create a revenue record when the booking has a price
  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0)
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  -- Sync vehicle rental_status based on incoming booking status
  CASE NEW.status
    WHEN 'approved' THEN
      UPDATE vehicles SET rental_status = 'reserved'
      WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'active' THEN
      UPDATE vehicles SET rental_status = 'rented'
      WHERE vehicle_id = NEW.vehicle_id;
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_after_insert ON bookings;
CREATE TRIGGER bookings_after_insert
  AFTER INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_create();

-- ── 4. Updated on_booking_status_change trigger ───────────────────────────────
-- Full status flow:
--   pending   → vehicle available  (booking not yet confirmed)
--   approved  → vehicle reserved   (booking confirmed; awaiting pickup)
--   active    → vehicle rented     (vehicle on the road)
--   completed → vehicle available  (rental finished)
--   cancelled → vehicle available  (booking cancelled; restore prior state)
CREATE OR REPLACE FUNCTION on_booking_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  CASE NEW.status
    WHEN 'pending' THEN
      -- Un-confirming a booking restores the vehicle to available
      UPDATE vehicles SET rental_status = 'available'
      WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'approved' THEN
      -- Booking confirmed — vehicle is now reserved for this booking
      UPDATE vehicles SET rental_status = 'reserved'
      WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'active' THEN
      -- Vehicle has been picked up
      UPDATE vehicles SET rental_status = 'rented'
      WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'completed' THEN
      -- Rental finished — make vehicle available again
      UPDATE vehicles SET rental_status = 'available'
      WHERE vehicle_id = NEW.vehicle_id;

    WHEN 'cancelled' THEN
      -- Remove the booking-created blocked_dates entry
      DELETE FROM blocked_dates
      WHERE  vehicle_id = NEW.vehicle_id
        AND  start_date = NEW.pickup_date
        AND  end_date   = NEW.return_date
        AND  reason     = 'booking';

      -- Remove revenue record only if no payment was received
      IF NEW.deposit_paid = 0 THEN
        DELETE FROM revenue WHERE booking_id = NEW.id;
      END IF;

      -- Restore vehicle to available regardless of prior status
      UPDATE vehicles SET rental_status = 'available'
      WHERE vehicle_id = NEW.vehicle_id;

    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_after_status_change ON bookings;
CREATE TRIGGER bookings_after_status_change
  AFTER UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_status_change();

-- =============================================================================
-- DONE
-- rental_status now includes 'reserved'.
-- check_booking_conflicts uses datetime precision.
-- on_booking_status_change implements the full pending→approved→active→completed
-- flow with vehicle status sync.
-- =============================================================================


-- ===========================================================================
-- 0016_customer_no_show_count.sql
-- ===========================================================================
-- supabase/migrations/0016_customer_no_show_count.sql
-- Adds no_show_count to customers and a trigger to keep it in sync
-- automatically whenever is_no_show changes on a revenue_records row.
--
-- Trigger behaviour:
--   INSERT  with is_no_show=true   → increment customer.no_show_count
--   UPDATE false→true              → increment customer.no_show_count
--   UPDATE true→false              → decrement customer.no_show_count (floor 0)
--   DELETE with is_no_show=true    → decrement customer.no_show_count (floor 0)
--
-- The customer is looked up by customer_phone (the key used throughout the
-- system).  Rows with a NULL/empty customer_phone are silently skipped.

-- ── 1. Add column ─────────────────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS no_show_count integer NOT NULL DEFAULT 0;

-- Ensure the value can never go below zero
DO $$
BEGIN
  ALTER TABLE customers
    ADD CONSTRAINT customers_no_show_count_non_negative
    CHECK (no_show_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Trigger function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_customer_no_show_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_phone text;
  v_delta integer := 0;
BEGIN
  -- Determine which row's phone to use and the direction of the change
  IF TG_OP = 'DELETE' THEN
    v_phone := OLD.customer_phone;
    IF OLD.is_no_show THEN v_delta := -1; END IF;
  ELSIF TG_OP = 'INSERT' THEN
    v_phone := NEW.customer_phone;
    IF NEW.is_no_show THEN v_delta := 1; END IF;
  ELSE  -- UPDATE
    v_phone := NEW.customer_phone;
    IF     OLD.is_no_show = false AND NEW.is_no_show = true  THEN v_delta :=  1;
    ELSIF  OLD.is_no_show = true  AND NEW.is_no_show = false THEN v_delta := -1;
    END IF;
  END IF;

  -- Nothing to do
  IF v_delta = 0 OR v_phone IS NULL OR v_phone = '' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE customers
     SET no_show_count = GREATEST(0, no_show_count + v_delta),
         updated_at    = now()
   WHERE phone = v_phone;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ── 3. Attach trigger ─────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS on_revenue_no_show_change ON revenue_records;
CREATE TRIGGER on_revenue_no_show_change
  AFTER INSERT OR UPDATE OF is_no_show OR DELETE
  ON revenue_records
  FOR EACH ROW EXECUTE FUNCTION update_customer_no_show_count();

-- =============================================================================
-- DONE
-- customers.no_show_count is now maintained automatically by the
-- on_revenue_no_show_change trigger whenever a revenue_records row has its
-- is_no_show flag toggled.  The column is also readable by v2-customers list
-- and visible in the admin-v2 Customers tab.
-- =============================================================================


-- ===========================================================================
-- 0017_booking_status_timestamps.sql
-- ===========================================================================
-- =============================================================================
-- SLY RIDES — Migration 0017: Booking Status Timestamps
-- =============================================================================
--
-- What this migration does:
--   1. Adds activated_at and completed_at timestamp columns to the bookings
--      table so each booking records exactly when it became active (vehicle
--      picked up) and when it was marked completed (rental finished).
--   2. Adds a BEFORE INSERT OR UPDATE trigger on_booking_status_timestamps that
--      auto-stamps those columns the moment the status column is set to
--      'active' or 'completed', keeping the DB in sync with the JS-side
--      completedAt / activatedAt auto-stamps in v2-bookings.js.
--
-- Alignment with JS auto-stamp logic (v2-bookings.js):
--   JS  status "active_rental"    → activatedAt  stamped
--   DB  status 'active'           → activated_at stamped  (this trigger)
--   JS  status "completed_rental" → completedAt  stamped
--   DB  status 'completed'        → completed_at stamped  (this trigger)
--
-- The BOOKING_STATUS_MAP in _booking-automation.js converts JS statuses to DB
-- statuses before upserting, so the trigger fires on the correct value.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS and CREATE OR REPLACE / DROP IF EXISTS.
-- =============================================================================

-- ── 1. Add new timestamp columns ─────────────────────────────────────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS activated_at  timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at  timestamptz;

-- ── 2. BEFORE trigger function — stamp activated_at / completed_at ────────────
CREATE OR REPLACE FUNCTION on_booking_status_timestamps()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Only act when the status is changing (or on first INSERT)
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  CASE NEW.status
    WHEN 'active' THEN
      -- Stamp activated_at the first time status becomes active; preserve any
      -- value already set (e.g. passed explicitly by the API).
      IF NEW.activated_at IS NULL THEN
        NEW.activated_at := now();
      END IF;

    WHEN 'completed' THEN
      -- Stamp completed_at the first time status becomes completed; preserve
      -- any value already set by the JS auto-stamp in v2-bookings.js.
      IF NEW.completed_at IS NULL THEN
        NEW.completed_at := now();
      END IF;

  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_status_timestamps ON bookings;
CREATE TRIGGER bookings_status_timestamps
  BEFORE INSERT OR UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION on_booking_status_timestamps();

-- =============================================================================
-- DONE
-- bookings now has activated_at and completed_at columns.
-- on_booking_status_timestamps auto-stamps them on status transitions,
-- mirroring the JS-side activatedAt / completedAt logic in v2-bookings.js.
-- =============================================================================


-- ===========================================================================
-- 0017_fix_cover_images.sql
-- ===========================================================================
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


-- ===========================================================================
-- 0018_admin_action_logs.sql
-- ===========================================================================
-- 0018_admin_action_logs.sql
-- Audit log table: every chatbot action is recorded here.
-- Provides: action name, sanitised args, result summary, and timestamp.
-- Used for debugging, accountability, and reviewing AI-driven changes.

create table if not exists admin_action_logs (
  id          bigserial    primary key,
  action_name text         not null,
  args        jsonb,
  result      jsonb,
  created_at  timestamptz  not null default now()
);

create index if not exists admin_action_logs_action_name_idx on admin_action_logs (action_name);
create index if not exists admin_action_logs_created_at_idx  on admin_action_logs (created_at desc);


-- ===========================================================================
-- 0019_ai_system.sql
-- ===========================================================================
-- 0019_ai_system.sql
-- AI Admin Assistant — Supabase schema additions.
--
-- 1. ai_logs table          — full audit trail of every AI tool execution
-- 2. flagged / risk_score   — fraud detection columns on bookings
-- 3. SQL analytics functions — optimised read-only helpers called via RPC

-- ── 1. ai_logs ──────────────────────────────────────────────────────────────
create table if not exists ai_logs (
  id         bigserial    primary key,
  action     text         not null,
  input      jsonb,
  output     jsonb,
  admin_id   text,
  created_at timestamptz  not null default now()
);

create index if not exists ai_logs_action_idx     on ai_logs (action);
create index if not exists ai_logs_created_at_idx on ai_logs (created_at desc);

-- ── 2. Fraud columns on bookings ─────────────────────────────────────────────
alter table bookings
  add column if not exists flagged    boolean not null default false,
  add column if not exists risk_score integer not null default 0;

create index if not exists bookings_flagged_idx on bookings (flagged) where flagged = true;

-- ── 3. SQL analytics functions ───────────────────────────────────────────────

-- Monthly revenue from revenue_records
create or replace function get_monthly_revenue(month_input text)
returns numeric
language sql
security invoker
as $$
  select coalesce(sum(gross_amount), 0)
  from   revenue_records
  where  to_char(created_at, 'YYYY-MM') = month_input
    and  (payment_status = 'paid' or payment_status is null)
    and  (is_cancelled is null or is_cancelled = false);
$$;

-- Booking count per vehicle (paid/active/completed)
create or replace function get_vehicle_booking_counts()
returns table(vehicle_id text, booking_count bigint)
language sql
security invoker
as $$
  select vehicle_id, count(*) as booking_count
  from   bookings
  where  status in ('approved', 'active', 'completed')
  group  by vehicle_id;
$$;

-- Bookings created in the last N days
create or replace function get_recent_booking_count(days_back integer default 3)
returns bigint
language sql
security invoker
as $$
  select count(*)
  from   bookings
  where  created_at >= now() - (days_back || ' days')::interval;
$$;

-- Revenue trend: last N months, grouped by month
create or replace function get_revenue_trend(months_back integer default 12)
returns table(month text, total numeric, booking_count bigint)
language sql
security invoker
as $$
  select
    to_char(created_at, 'YYYY-MM')      as month,
    coalesce(sum(gross_amount), 0)       as total,
    count(*)                             as booking_count
  from   revenue_records
  where  created_at >= date_trunc('month', now()) - ((months_back - 1) || ' months')::interval
    and  (payment_status = 'paid' or payment_status is null)
    and  (is_cancelled is null or is_cancelled = false)
  group  by to_char(created_at, 'YYYY-MM')
  order  by month asc;
$$;


-- ===========================================================================
-- 0020_bouncie_tracking.sql
-- ===========================================================================
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


-- ===========================================================================
-- 0021_app_config.sql
-- ===========================================================================
-- 0021_app_config.sql
-- Generic key-value store for server-side application configuration.
-- Other integrations may use this table for any server-side config that
-- should not be hardcoded or stored only in env vars.
--
-- Safe to re-run: uses IF NOT EXISTS guards.

create table if not exists app_config (
  key        text        primary key,
  value      jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


-- ===========================================================================
-- 0022_maintenance_columns.sql
-- ===========================================================================
-- 0022_maintenance_columns.sql
-- Per-service maintenance tracking for Bouncie-tracked vehicles.
--
-- Adds three independent mileage checkpoints to the vehicles table so that
-- oil changes, brake checks, and tire changes are tracked separately.
-- These replace the single `last_service_mileage` key that was stored only
-- inside the JSONB data blob; the JSONB mirror is preserved for the GitHub
-- JSON fallback path.
--
-- Only applies to vehicles where bouncie_device_id IS NOT NULL.
-- Vehicles are excluded in the application layer before alert logic runs.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent.

alter table vehicles
  add column if not exists last_oil_change_mileage   numeric(10,0),
  add column if not exists last_brake_check_mileage  numeric(10,0),
  add column if not exists last_tire_change_mileage  numeric(10,0);

-- Back-fill: if a vehicle already has last_service_mileage stored in its
-- JSONB data blob (from the old single-service-record approach), copy it into
-- all three new columns as a sensible starting point.
-- Only runs when the column is still NULL (i.e. a fresh install or first run).
update vehicles
set
  last_oil_change_mileage  = coalesce(last_oil_change_mileage,  (data->>'last_service_mileage')::numeric),
  last_brake_check_mileage = coalesce(last_brake_check_mileage, (data->>'last_service_mileage')::numeric),
  last_tire_change_mileage = coalesce(last_tire_change_mileage, (data->>'last_service_mileage')::numeric)
where
  bouncie_device_id is not null
  and data ? 'last_service_mileage'
  and (last_oil_change_mileage is null or last_brake_check_mileage is null or last_tire_change_mileage is null);


-- ===========================================================================
-- 0023_fleet_automation.sql
-- ===========================================================================
-- 0023_fleet_automation.sql
-- Fleet automation: maintenance history log + booking maintenance status.
--
-- New table:
--   maintenance_history — one row per completed service event (oil / brakes / tires).
--     Records the odometer reading at the time of service, which service type was
--     performed, and optionally the booking active at that time.
--
-- New column on bookings:
--   maintenance_status — tracks driver compliance when maintenance is overdue.
--     Values: NULL (normal) | 'non_compliant' (escalation triggered)
--
-- Safe to re-run: all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- ── maintenance_history ──────────────────────────────────────────────────────
create table if not exists maintenance_history (
  id           bigserial     primary key,
  vehicle_id   text          not null,
  service_type text          not null,   -- 'oil' | 'brakes' | 'tires'
  mileage      numeric(10,0) not null,   -- odometer reading at time of service
  notes        text,
  booking_id   text,                     -- active booking at time of service (nullable)
  created_at   timestamptz   not null default now()
);

create index if not exists maint_history_vehicle_idx on maintenance_history (vehicle_id);
create index if not exists maint_history_created_idx on maintenance_history (created_at desc);
create index if not exists maint_history_type_idx    on maintenance_history (service_type);

-- ── bookings maintenance_status column ───────────────────────────────────────
alter table bookings
  add column if not exists maintenance_status text;
-- values: NULL (normal) | 'non_compliant' (escalation triggered by 48h rule)


-- ===========================================================================
-- 0024_vehicle_decision_status.sql
-- ===========================================================================
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


-- ===========================================================================
-- 0025_priority_auto_actions.sql
-- ===========================================================================
-- 0025_priority_auto_actions.sql
-- Priority-based auto-alert deduplication columns.
--
-- These columns are written by the admin-ai-auto cron job after it fires an
-- owner alert or driver message for a high-priority vehicle.  They are used
-- to prevent the same alert from being sent on every cron cycle.
--
-- last_auto_action_at     — ISO timestamp of the last auto-alert sent
-- last_auto_action_reason — the priority_reason string at the time of the
--                           alert (e.g. "Maintenance overdue: oil change").
--                           When the reason changes, a new alert is warranted.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS.

alter table vehicles
  add column if not exists last_auto_action_at     timestamptz,
  add column if not exists last_auto_action_reason text;

create index if not exists vehicles_last_auto_action_idx
  on vehicles (last_auto_action_at desc nulls last);


-- ===========================================================================
-- 0026_resolution_tracking.sql
-- ===========================================================================
-- 0026_resolution_tracking.sql
-- Resolution feedback columns for the priority auto-action system.
--
-- When a vehicle's action_status transitions to "resolved" (via the
-- update_action_status AI tool or the toolMarkMaintenance auto-resolve path),
-- these columns capture the closure of that alert cycle:
--
--   last_resolved_at     — timestamp of the resolution
--   last_resolved_reason — the priority_reason that was active when the alert
--                          was originally fired (copied from last_auto_action_reason
--                          at the moment of resolution)
--
-- Dedup reset: on resolution the cron code also clears last_auto_action_at and
-- last_auto_action_reason (added in migration 0025).  This allows the same issue
-- to re-trigger a new alert if it reoccurs after being resolved, while still
-- preventing redundant alerts within an unresolved cycle.
--
-- Analytics: time_to_resolution can be derived as:
--   last_resolved_at - last_auto_action_at
-- (last_auto_action_at is cleared on resolution, so callers should capture it
--  before the reset if they need the exact delta — the return value of the
--  update_action_status tool includes time_to_resolution_ms for this purpose.)
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS.

alter table vehicles
  add column if not exists last_resolved_at     timestamptz,
  add column if not exists last_resolved_reason text;

create index if not exists vehicles_last_resolved_idx
  on vehicles (last_resolved_at desc nulls last);


-- ===========================================================================
-- 0027_maintenance_appointments.sql
-- ===========================================================================
-- 0027_maintenance_appointments.sql
-- Driver-driven maintenance scheduling.
--
-- When a maintenance alert is sent to a driver (80% / 100% threshold), the SMS
-- now includes a link to the scheduling page (/maintenance-schedule).  The driver
-- picks a date and time which is stored here.
--
-- Status lifecycle:
--   pending_approval — appointment created; awaiting owner approval
--                      (only used when MAINTENANCE_APPROVAL_MODE=approval)
--   scheduled        — appointment confirmed (auto or owner-approved)
--   completed        — service has been performed (future use)
--   cancelled        — appointment cancelled by owner or system
--
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

create table if not exists maintenance_appointments (
  id            bigserial     primary key,
  vehicle_id    text          not null,
  booking_id    text,                        -- active booking when appointment was made (nullable)
  service_type  text          not null,      -- 'oil' | 'brakes' | 'tires'
  scheduled_at  timestamptz   not null,      -- driver-chosen appointment date/time
  status        text          not null default 'scheduled',
                                             -- 'pending_approval' | 'scheduled' | 'completed' | 'cancelled'
  notes         text,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

create index if not exists maint_appts_vehicle_idx    on maintenance_appointments (vehicle_id);
create index if not exists maint_appts_status_idx     on maintenance_appointments (status);
create index if not exists maint_appts_scheduled_idx  on maintenance_appointments (scheduled_at desc);
create index if not exists maint_appts_created_idx    on maintenance_appointments (created_at desc);


-- ===========================================================================
-- 0028_missed_maintenance.sql
-- ===========================================================================
-- 0028_missed_maintenance.sql
-- Missed appointment tracking for the maintenance scheduling system.
--
-- Adds a missed_at column to maintenance_appointments so the cron job
-- (api/missed-maintenance.js) can record exactly when an appointment was
-- detected as missed.  The "missed" status string is handled in application
-- code; no constraint change is needed since status is plain text.
--
-- Also adds a composite index to speed up the per-vehicle+service missed-count
-- queries used for driver risk escalation.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

ALTER TABLE maintenance_appointments
  ADD COLUMN IF NOT EXISTS missed_at timestamptz;

-- Efficient lookup: overdue scheduled appointments (status + scheduled_at)
CREATE INDEX IF NOT EXISTS maint_appts_overdue_idx
  ON maintenance_appointments (status, scheduled_at)
  WHERE status = 'scheduled';

-- Efficient missed-count per booking (supports the (booking_id, status) filter in
-- missed-maintenance.js without relying on a partial index)
CREATE INDEX IF NOT EXISTS maint_appts_missed_booking_idx
  ON maintenance_appointments (booking_id, status);


-- ===========================================================================
-- 0029_maintenance_status_table.sql
-- ===========================================================================
-- 0029_maintenance_status_table.sql
-- Adds a dedicated maintenance status table for tracking scheduled/overdue services.
--
-- This table is the single source of truth for per-vehicle maintenance status
-- (oil, brakes, tires) with explicit due dates and lifecycle statuses.
-- The AI tool get_maintenance_status queries this table alongside
-- maintenance_history (completed events) and maintenance_appointments (driver-
-- scheduled appointments) to answer questions like "What's the maintenance
-- status of Camry 2013?"
--
-- Schema:
--   vehicle_id   TEXT  → matches vehicles.vehicle_id (e.g. "camry2013")
--   service_type TEXT  → 'oil' | 'brakes' | 'tires'
--   due_date     DATE  → when service is due
--   status       TEXT  → 'pending' | 'scheduled' | 'completed' | 'overdue'
--
-- Safe to re-run: uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

-- ── maintenance ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance (
  id           BIGSERIAL    PRIMARY KEY,
  vehicle_id   TEXT         NOT NULL,   -- FK to vehicles.vehicle_id
  service_type TEXT         NOT NULL,   -- 'oil' | 'brakes' | 'tires'
  due_date     DATE,                    -- when service is due
  status       TEXT         NOT NULL DEFAULT 'pending',
  -- 'pending' = due soon, 'scheduled' = appointment exists,
  -- 'completed' = done, 'overdue' = past due_date and not completed
  notes        TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns used by get_maintenance_status
CREATE INDEX IF NOT EXISTS maintenance_vehicle_idx     ON maintenance (vehicle_id);
CREATE INDEX IF NOT EXISTS maintenance_status_idx      ON maintenance (status);
CREATE INDEX IF NOT EXISTS maintenance_due_date_idx    ON maintenance (due_date);
CREATE INDEX IF NOT EXISTS maintenance_vehicle_type_idx ON maintenance (vehicle_id, service_type);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Service-role key (used by all API functions) bypasses RLS automatically.
-- Enable RLS to prevent direct anonymous reads, but allow the service role
-- full access (no explicit policy needed for service role).
ALTER TABLE maintenance ENABLE ROW LEVEL SECURITY;

-- Allow read access for authenticated users (admin dashboard).
CREATE POLICY IF NOT EXISTS maintenance_select_authenticated
  ON maintenance FOR SELECT
  TO authenticated
  USING (true);


-- ===========================================================================
-- 0030_vehicle_tracking_and_trips.sql
-- ===========================================================================
-- 0030_vehicle_tracking_and_trips.sql
-- Smart fleet tracking phase 2: vehicle tracking columns + booking-linked trips table.
--
-- New columns on vehicles:
--   is_tracked          BOOLEAN    — true when this vehicle should be monitored by the
--                                    maintenance auto-checker (updateMaintenanceStatus).
--   maintenance_interval INTEGER   — miles between general services (default 5000).
--                                    Used by updateMaintenanceStatus to derive OK/DUE_SOON/OVERDUE.
--
-- Note: current_mileage is stored in the existing `mileage` column (added by
-- migration 0020 for Bouncie sync). last_service_mileage is already stored in
-- the JSONB `data` blob. No duplicate columns are added.
--
-- New table: trips
--   Booking-linked trip records. One row per completed booking per vehicle.
--   Distinct from trip_log (0020) which stores individual GPS-based Bouncie events.
--   trips records the aggregate: total distance driven during a single rental period.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.

-- ── vehicles — add tracking columns ──────────────────────────────────────────
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS is_tracked           BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS maintenance_interval INTEGER   NOT NULL DEFAULT 5000;

-- Index for fast lookup of all tracked vehicles (used by updateMaintenanceStatus cron).
CREATE INDEX IF NOT EXISTS vehicles_is_tracked_idx ON vehicles (is_tracked) WHERE is_tracked = true;

-- ── trips (booking-linked aggregate trip records) ─────────────────────────────
CREATE TABLE IF NOT EXISTS trips (
  id              BIGSERIAL     PRIMARY KEY,
  vehicle_id      TEXT          NOT NULL,       -- matches vehicles.vehicle_id
  booking_id      TEXT,                         -- matches bookings.booking_id
  start_mileage   NUMERIC(10,1),               -- odometer at booking start
  end_mileage     NUMERIC(10,1),               -- odometer at booking end
  distance        NUMERIC(10,1),               -- miles driven (end - start, or sum of GPS trips)
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trips_vehicle_idx    ON trips (vehicle_id);
CREATE INDEX IF NOT EXISTS trips_booking_idx    ON trips (booking_id);
CREATE INDEX IF NOT EXISTS trips_created_idx    ON trips (created_at DESC);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS trips_select_authenticated
  ON trips FOR SELECT
  TO authenticated
  USING (true);


-- ===========================================================================
-- 0031_fix_rls_and_maintenance_table.sql
-- ===========================================================================
-- 0031_fix_rls_and_maintenance_table.sql
-- Fixes two gaps between the migration files and the actual database state:
--
-- Gap 1 — missing maintenance table
--   Migration 0029 (maintenance_status_table) was never applied to the database.
--   public.maintenance does not exist; this migration creates it.
--
-- Gap 2 — missing RLS on maintenance_history and maintenance_appointments
--   Migrations 0023 and 0027 created these tables without enabling RLS.
--   Both tables have rls_enabled = false in the current database, meaning any
--   Supabase anonymous or authenticated client can read them directly.
--   This migration enables RLS and adds a read policy for authenticated users,
--   matching the pattern used by migrations 0029 and 0030.
--
-- All statements are safe to re-run (IF NOT EXISTS / idempotent ALTER).

-- ── maintenance (from 0029, never applied) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance (
  id           BIGSERIAL    PRIMARY KEY,
  vehicle_id   TEXT         NOT NULL,   -- FK to vehicles.vehicle_id (e.g. "camry2013")
  service_type TEXT         NOT NULL,   -- 'oil' | 'brakes' | 'tires'
  due_date     DATE,                    -- when service is due
  status       TEXT         NOT NULL DEFAULT 'pending',
  -- 'pending' = due soon, 'scheduled' = appointment exists,
  -- 'completed' = done, 'overdue' = past due_date and not completed
  notes        TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS maintenance_vehicle_idx      ON maintenance (vehicle_id);
CREATE INDEX IF NOT EXISTS maintenance_status_idx       ON maintenance (status);
CREATE INDEX IF NOT EXISTS maintenance_due_date_idx     ON maintenance (due_date);
CREATE INDEX IF NOT EXISTS maintenance_vehicle_type_idx ON maintenance (vehicle_id, service_type);

ALTER TABLE maintenance ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS maintenance_select_authenticated
  ON maintenance FOR SELECT
  TO authenticated
  USING (true);

-- ── maintenance_history (RLS was never enabled) ───────────────────────────────
-- Service-role key (used by all API functions) bypasses RLS automatically.
-- Enable RLS so anonymous clients cannot read service history directly.
ALTER TABLE maintenance_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS maintenance_history_select_authenticated
  ON maintenance_history FOR SELECT
  TO authenticated
  USING (true);

-- ── maintenance_appointments (RLS was never enabled) ──────────────────────────
ALTER TABLE maintenance_appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS maintenance_appointments_select_authenticated
  ON maintenance_appointments FOR SELECT
  TO authenticated
  USING (true);


-- ===========================================================================
-- 0032_vehicle_payment_token.sql
-- ===========================================================================
-- Migration 0032: Add payment_link_token column to bookings table
-- Supports the Vehicle deposit-only payment flow where renters pay a
-- security deposit first and complete the rental payment later via a
-- unique secure link.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_link_token text,
  ADD COLUMN IF NOT EXISTS vehicle_payment_status text,
  ADD COLUMN IF NOT EXISTS vehicle_booking_status  text,
  ADD COLUMN IF NOT EXISTS rental_price              numeric(10,2),
  ADD COLUMN IF NOT EXISTS security_deposit          numeric(10,2),
  ADD COLUMN IF NOT EXISTS remaining_balance         numeric(10,2) DEFAULT 0;

-- Index for fast token lookups on the complete-booking page
CREATE UNIQUE INDEX IF NOT EXISTS bookings_payment_link_token_idx
  ON bookings (payment_link_token)
  WHERE payment_link_token IS NOT NULL;


-- ===========================================================================
-- 0033_payment_intent_id.sql
-- ===========================================================================
-- =============================================================================
-- SLY RIDES — Migration 0033: Add payment_intent_id to bookings table
-- =============================================================================
--
-- What this migration does:
--   Adds a payment_intent_id text column to the bookings table so that every
--   booking created via the public booking flow (Stripe) or manually via the
--   admin panel can store the Stripe PaymentIntent ID.  This enables:
--   1. The admin booking list (v2-bookings.js) to surface the Stripe ID
--      directly from Supabase (previously caused a SELECT error and silent
--      fallback to bookings.json).
--   2. autoUpsertBooking in _booking-automation.js to sync the payment
--      intent ID into Supabase alongside all other booking fields.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS guard.
-- =============================================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_intent_id text;

CREATE INDEX IF NOT EXISTS bookings_payment_intent_id_idx
  ON bookings (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;


-- ===========================================================================
-- 0034_clear_camry2013_blocks.sql
-- ===========================================================================
-- =============================================================================
-- SLY RIDES — Migration 0034: Clear all camry2013 blocked_dates rows
-- =============================================================================
--
-- What this migration does:
--   Removes every entry in the blocked_dates table for vehicle_id = 'camry2013'.
--   These rows were created automatically when bookings were confirmed and when
--   the admin manually added blocks.  They have been cleared from booked-dates.json
--   (GitHub) already; this migration brings the Supabase store into sync so that
--   the admin AI assistant's get_blocked_dates tool also shows no blocks for the
--   Camry 2013 SE.
--
-- Safe to re-run: DELETE WHERE is idempotent once the rows are gone.
-- =============================================================================

DELETE FROM blocked_dates
WHERE vehicle_id = 'camry2013';


-- ===========================================================================
-- 0035_stripe_customer_fields.sql
-- ===========================================================================
-- =============================================================================
-- SLY RIDES — Migration 0035: Add Stripe customer / payment-method columns
-- =============================================================================
--
-- What this migration does:
--   Adds stripe_customer_id and stripe_payment_method_id to the bookings table
--   so that every Stripe booking captures the saved card details needed for
--   future off-session charges (e.g., damages, late fees).
--
--   These values are populated by:
--     • create-payment-intent.js  — creates/finds the Stripe Customer and embeds
--                                   stripe_customer_id in the PaymentIntent metadata.
--     • stripe-webhook.js         — extracts paymentIntent.customer and
--                                   paymentIntent.payment_method on
--                                   payment_intent.succeeded and writes them into
--                                   the booking record.
--     • _booking-automation.js    — syncs both fields via autoUpsertBooking().
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS guard.
-- =============================================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS stripe_customer_id       text,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id text;

CREATE INDEX IF NOT EXISTS bookings_stripe_customer_id_idx
  ON bookings (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;


-- ===========================================================================
-- 0036_charges_table.sql
-- ===========================================================================
-- =============================================================================
-- SLY RIDES — Migration 0036: Extra charges table
-- =============================================================================
--
-- Stores every extra charge applied to a booking (damages, late fees, key
-- replacement, smoking penalties, etc.) via the Admin UI or AI assistant.
--
-- Each row records:
--   booking_id               — booking_ref from the bookings table
--   charge_type              — key_replacement | smoking | late_fee | custom
--   amount                   — USD amount charged
--   notes                    — optional admin note or description
--   stripe_payment_intent_id — Stripe PI id for the off-session charge
--   status                   — pending | succeeded | failed
--   charged_by               — "admin" (UI button) | "ai" (AI assistant)
--   error_message            — Stripe error reason when status = failed
--   created_at               — timestamp
-- =============================================================================

CREATE TABLE IF NOT EXISTS charges (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                text        NOT NULL,
  charge_type               text        NOT NULL CHECK (charge_type IN ('key_replacement','smoking','late_fee','custom')),
  amount                    numeric(10,2) NOT NULL CHECK (amount > 0),
  notes                     text,
  stripe_payment_intent_id  text,
  status                    text        NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending','succeeded','failed')),
  charged_by                text        NOT NULL DEFAULT 'admin'
                                        CHECK (charged_by IN ('admin','ai')),
  error_message             text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS charges_booking_id_idx
  ON charges (booking_id);

CREATE INDEX IF NOT EXISTS charges_created_at_idx
  ON charges (created_at DESC);


-- ===========================================================================
-- 0037_bouncie_tokens_table.sql
-- ===========================================================================
-- 0037_bouncie_tokens_table.sql
-- Bouncie OAuth token storage.
--
-- Stores the singleton OAuth token (id=1) used by the Bouncie GPS integration.
-- Tokens are exchanged via /api/bouncie-callback and auto-refreshed on 401.

create table if not exists bouncie_tokens (
  id            int           primary key,
  access_token  text,
  refresh_token text,
  obtained_at   timestamptz,
  updated_at    timestamptz
);


-- ===========================================================================
-- 0038_fix_is_tracked_flag.sql
-- ===========================================================================
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


-- ===========================================================================
-- 0039_trips_driver_columns.sql
-- ===========================================================================
-- 0039_trips_driver_columns.sql
-- Driver mileage tracking: denormalize driver info onto the trips table for
-- fast per-driver reporting without always joining through the bookings JSON.
--
-- New columns on trips:
--   driver_name  TEXT  — customer name from the booking record
--   driver_phone TEXT  — normalized E.164 phone from the booking record
--
-- The booking_id foreign key is TEXT that matches bookings.booking_ref (or
-- the legacy bookings.json bookingId). A backfill JOIN against the Supabase
-- bookings table populates rows that were inserted before this migration.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.

-- ── trips — add driver columns ────────────────────────────────────────────────
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS driver_name  TEXT,
  ADD COLUMN IF NOT EXISTS driver_phone TEXT;

-- Index for fast per-driver queries with date filtering
CREATE INDEX IF NOT EXISTS trips_driver_phone_at_idx
  ON trips (driver_phone, created_at DESC)
  WHERE driver_phone IS NOT NULL;

-- ── Backfill from the normalised Supabase bookings table ─────────────────────
-- Joins on booking_id (trips) ↔ booking_ref (bookings).
-- Only fills rows where the columns are still NULL to remain idempotent.
UPDATE trips t
SET
  driver_name  = b.customer_name,
  driver_phone = b.customer_phone
FROM bookings b
WHERE t.booking_id = b.booking_ref
  AND (t.driver_name IS NULL OR t.driver_phone IS NULL);


-- ===========================================================================
-- 0040_backfill_active_trips.sql
-- ===========================================================================
-- 0040_backfill_active_trips.sql
-- Recognise drivers who are currently mid-rental by creating placeholder trips
-- rows for every active booking that has no trips entry yet.
--
-- These are drivers who were already in a rental when migrations 0039 + the
-- booking-automation changes were first deployed.  Without this backfill they
-- would be invisible in the driver_report because no trips row existed for them.
--
-- Strategy:
--   • JOIN bookings (status = 'active') → vehicles (current odometer).
--   • Use the vehicle's current mileage as start_mileage (best estimate for a
--     driver already mid-rental; better than NULL which gives 0 live miles).
--   • Leave end_mileage + distance NULL — the driver_report API computes live
--     miles in real-time as (current_odometer − start_mileage).
--   • driver_name / driver_phone populated from bookings.customer_name / phone.
--
-- Safe to re-run: the NOT EXISTS guard prevents duplicate insertions.

INSERT INTO trips (vehicle_id, booking_id, driver_name, driver_phone, start_mileage, end_mileage, distance)
SELECT
  b.vehicle_id,
  b.booking_ref,
  b.customer_name,
  b.customer_phone,
  v.mileage,   -- current odometer used as best-available start estimate
  NULL,        -- end_mileage unknown until rental completes
  NULL         -- distance computed in real-time from live odometer
FROM bookings b
JOIN vehicles v ON v.vehicle_id = b.vehicle_id
WHERE b.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM trips t WHERE t.booking_id = b.booking_ref
  );


-- ===========================================================================
-- 0041_booking_audit_log.sql
-- ===========================================================================
-- Migration 0041: booking audit log
-- Tracks every meaningful change to a booking (status, dates, price) so
-- discrepancies can be identified quickly without full-table scans.
--
-- Columns:
--   id           — surrogate PK
--   booking_ref  — matches bookings.booking_ref (and bookings.json bookingId)
--   changed_by   — who/what made the change ("stripe-webhook", "admin", etc.)
--   changed_at   — UTC timestamp of the change
--   field        — which field changed ("status", "return_date", "total_price", …)
--   old_value    — previous value as text (nullable for inserts)
--   new_value    — new value as text

create table if not exists booking_audit_log (
  id          bigserial primary key,
  booking_ref text        not null,
  changed_by  text        not null default 'system',
  changed_at  timestamptz not null default now(),
  field       text        not null,
  old_value   text,
  new_value   text
);

-- Index for fast lookup by booking
create index if not exists booking_audit_log_ref_idx
  on booking_audit_log (booking_ref, changed_at desc);


-- ===========================================================================
-- 0042_revenue_records_original_booking_id.sql
-- ===========================================================================
-- Migration 0042: add original_booking_id to revenue_records
--
-- Extension payments are stored as separate revenue_records rows keyed to
-- the extension PaymentIntent ID.  This column links each extension row back
-- to the original booking so rollups, triggers, and reporting queries can
-- aggregate all revenue (initial + extensions) under one booking reference.
--
-- The column is nullable: rows for initial bookings leave it NULL.
-- Rows for extensions set it to the original booking's booking_ref / bookingId.

alter table revenue_records
  add column if not exists original_booking_id text default null;

-- Index for rollup queries: "give me all revenue rows for booking X"
-- (including extension rows where original_booking_id = X)
create index if not exists revenue_records_original_booking_id_idx
  on revenue_records (original_booking_id)
  where original_booking_id is not null;


-- ===========================================================================
-- 0043_revenue_records_payment_intent_id.sql
-- ===========================================================================
-- Migration 0043: add payment_intent_id to revenue_records
--
-- The reconciliation check in scheduled-reminders.js matches succeeded Stripe
-- PaymentIntents against revenue_records using two strategies:
--   1. payment_intent_id column (this migration)
--   2. booking_id column = PI id (extension records already use this)
--
-- Without this column, strategy 1 returned a Supabase error (silently dropped),
-- leaving recordedPIIds always empty and causing repeat reconciliation alerts
-- every 15-minute cron tick for up to 24 hours per payment.
--
-- The column is nullable:
--   • Rows for Stripe bookings set it to the PaymentIntent id.
--   • Extension rows leave it NULL (their booking_id IS the PI id — strategy 2).
--   • Manual/cash rows leave it NULL.

alter table revenue_records
  add column if not exists payment_intent_id text default null;

create index if not exists revenue_records_payment_intent_id_idx
  on revenue_records (payment_intent_id)
  where payment_intent_id is not null;


-- ===========================================================================
-- 0044_revenue_stripe_fees.sql
-- ===========================================================================
-- Migration 0044: add Stripe fee columns to revenue_records
--
-- Enables fully accurate financial tracking using Stripe as the source of
-- truth.  Each Stripe payment's balance_transaction exposes:
--   fee  → Stripe's processing fee (in cents, stored here in dollars)
--   net  → amount actually paid out after the fee
--
-- Three new columns:
--   stripe_fee       — Stripe processing fee in USD (null for cash/manual)
--   stripe_net       — Net payout in USD after Stripe fee (null for cash/manual)
--   stripe_charge_id — Stripe Charge ID (ch_…) for direct lookup; nullable
--
-- Cash / manual payments:  stripe_fee = 0, stripe_net = gross_amount
-- Stripe payments:         populated by api/stripe-reconcile.js
-- Null values:             record has not yet been reconciled with Stripe

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS stripe_fee       numeric(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_net       numeric(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_charge_id text          DEFAULT NULL;

-- Index for dedup checks during reconciliation (charge_id uniqueness)
CREATE INDEX IF NOT EXISTS revenue_records_stripe_charge_id_idx
  ON revenue_records (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;


-- ===========================================================================
-- 0045_revenue_sync_excluded.sql
-- ===========================================================================
-- Migration 0045: add sync_excluded to revenue_records
--
-- When an admin deletes a revenue record that was auto-synced from a booking,
-- we soft-delete it (sync_excluded = true) instead of hard-deleting it.
-- This prevents the "Sync from Bookings" action from recreating the record on
-- every subsequent sync, because it checks booking_id existence across ALL rows
-- (including sync_excluded ones) before inserting.

alter table revenue_records
  add column if not exists sync_excluded boolean not null default false;

create index if not exists revenue_records_sync_excluded_idx
  on revenue_records (sync_excluded)
  where sync_excluded = true;


-- ===========================================================================
-- 0046_revenue_records_financial_columns.sql
-- ===========================================================================
-- Migration 0046: ensure all Stripe/financial columns exist on revenue_records
--
-- Comprehensive catchup migration for databases that may have only partially
-- applied migrations 0042–0045.  All ALTER TABLE statements use IF NOT EXISTS
-- so this migration is safe to run on any database state.
--
-- Columns covered (no-ops if already present):
--   original_booking_id — links extension rows back to original booking (0042)
--   payment_intent_id   — Stripe PI id (pi_…) for reconciliation matching (0043)
--   stripe_fee          — Stripe processing fee in USD (0044)
--   stripe_net          — Net payout after Stripe fee in USD (0044)
--   stripe_charge_id    — Stripe Charge ID (ch_…) for direct dedup (0044)
--   sync_excluded       — soft-delete flag; prevents re-sync after admin delete (0045)
--
-- After applying this migration, api/stripe-reconcile.js and api/v2-dashboard.js
-- can safely read and write all of these columns without schema errors.

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS original_booking_id text          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS payment_intent_id   text          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_fee          numeric(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_net          numeric(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_charge_id    text          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sync_excluded       boolean       NOT NULL DEFAULT false;

-- ── Indexes (all idempotent) ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS revenue_records_original_booking_id_idx
  ON revenue_records (original_booking_id)
  WHERE original_booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS revenue_records_payment_intent_id_idx
  ON revenue_records (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS revenue_records_stripe_charge_id_idx
  ON revenue_records (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS revenue_records_sync_excluded_idx
  ON revenue_records (sync_excluded)
  WHERE sync_excluded = true;


-- ===========================================================================
-- 0047_customers_profitability_columns.sql
-- ===========================================================================
-- 0047_customers_profitability_columns.sql
-- Adds financial profitability metrics to the customers table.
-- All columns are nullable so existing rows are unaffected until the next sync.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_gross_revenue         numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_stripe_fees           numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_net_revenue           numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS associated_vehicle_expenses numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_profit                numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS profit_per_booking          numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avg_profit_per_day          numeric(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lifetime_value              numeric(10,2);

-- Index for sorting/filtering by profit
CREATE INDEX IF NOT EXISTS customers_total_profit_idx ON customers (total_profit);


-- ===========================================================================
-- 0048_backfill_customer_links.sql
-- ===========================================================================
-- Migration 0048: Backfill customer records and booking links for rentals that
-- were created without a phone number in Stripe metadata, leaving customer_id
-- NULL on the bookings row and showing "–" in the admin Bookings table.
--
-- Affected customers / bookings (as of 2026-04-12):
--   • Brandon Bookhart  (+15303285561) — camry2013 bk-bb-2026-0402, bk-bb-2026-0407
--   • David Agbebaku    (+13463814616) — camry2013 bk-da-2026-0321, bk-da2-2026-0329
--                                        camry (2012)  bk-da-2026-0407
--
-- Safe to re-run: INSERT … ON CONFLICT DO UPDATE, UPDATE … IS DISTINCT FROM are
-- all idempotent.

DO $$
DECLARE
  v_brandon_id   uuid;
  v_david_id     uuid;
BEGIN

  -- ── 1. Upsert customer: Brandon Bookhart ──────────────────────────────────
  INSERT INTO customers (name, phone, email, total_bookings, total_spent, first_booking_date, last_booking_date)
  VALUES ('Brandon Bookhart', '+15303285561', 'brandon.bookhart@gmail.com', 0, 0, '2026-04-02', '2026-04-07')
  ON CONFLICT (phone) DO UPDATE SET
    name       = EXCLUDED.name,
    email      = COALESCE(EXCLUDED.email, customers.email),
    updated_at = now()
  RETURNING id INTO v_brandon_id;

  IF v_brandon_id IS NULL THEN
    SELECT id INTO v_brandon_id FROM customers WHERE phone = '+15303285561';
  END IF;

  -- ── 2. Upsert customer: David Agbebaku ───────────────────────────────────
  INSERT INTO customers (name, phone, email, total_bookings, total_spent, first_booking_date, last_booking_date)
  VALUES ('David Agbebaku', '+13463814616', 'davosama15@gmail.com', 0, 0, '2026-03-21', '2026-04-07')
  ON CONFLICT (phone) DO UPDATE SET
    name       = EXCLUDED.name,
    email      = COALESCE(EXCLUDED.email, customers.email),
    updated_at = now()
  RETURNING id INTO v_david_id;

  IF v_david_id IS NULL THEN
    SELECT id INTO v_david_id FROM customers WHERE phone = '+13463814616';
  END IF;

  -- ── 3. Link Brandon Bookhart to his camry2013 bookings ───────────────────
  UPDATE bookings
  SET    customer_id = v_brandon_id, updated_at = now()
  WHERE  vehicle_id  = 'camry2013'
    AND  booking_ref IN ('bk-bb-2026-0402', 'bk-bb-2026-0407')
    AND  customer_id IS DISTINCT FROM v_brandon_id;

  -- ── 4. Link David Agbebaku to his camry2013 bookings ────────────────────
  UPDATE bookings
  SET    customer_id = v_david_id, updated_at = now()
  WHERE  vehicle_id  = 'camry2013'
    AND  booking_ref IN ('bk-da-2026-0321', 'bk-da2-2026-0329')
    AND  customer_id IS DISTINCT FROM v_david_id;

  -- ── 5. Upsert David Agbebaku's camry 2012 booking (Apr 7–11 2026) ────────
  --  This booking was saved by the Stripe webhook but may have been stored with
  --  a random wh- booking_ref (or not stored at all if metadata was empty).
  --  Authoritative data from admin:
  --    pickup  2026-04-07  return  2026-04-11  amount $308.70  basic DPP
  INSERT INTO bookings (
    booking_ref, customer_id, vehicle_id,
    pickup_date, return_date,
    status, total_price, deposit_paid, remaining_balance,
    payment_status, payment_method,
    notes, updated_at
  )
  VALUES (
    'bk-da-2026-0407', v_david_id, 'camry',
    '2026-04-07', '2026-04-11',
    'completed', 308.70, 308.70, 0,
    'paid', 'stripe',
    '4-day rental. Basic DPP ($60). Sales tax $28.70. Full payment $308.70 via Stripe.',
    now()
  )
  ON CONFLICT (booking_ref) DO UPDATE SET
    customer_id       = EXCLUDED.customer_id,
    return_date       = EXCLUDED.return_date,
    status            = EXCLUDED.status,
    total_price       = EXCLUDED.total_price,
    deposit_paid      = EXCLUDED.deposit_paid,
    remaining_balance = EXCLUDED.remaining_balance,
    payment_status    = EXCLUDED.payment_status,
    notes             = COALESCE(bookings.notes, EXCLUDED.notes),
    updated_at        = now();

  -- If a webhook row was saved with a wh- booking_ref for this same rental
  -- (vehicle camry, pickup 2026-04-07), update it to set customer_id + correct
  -- return date and link it to the canonical booking_ref row above.
  UPDATE bookings
  SET    customer_id = v_david_id,
         return_date = '2026-04-11',
         status      = 'completed',
         updated_at  = now()
  WHERE  vehicle_id  = 'camry'
    AND  pickup_date = '2026-04-07'
    AND  booking_ref <> 'bk-da-2026-0407'
    AND  customer_id IS DISTINCT FROM v_david_id;

  -- ── 6. Patch revenue_records for David's camry Apr 7 booking ─────────────
  UPDATE revenue_records
  SET    customer_name  = 'David Agbebaku',
         customer_phone = '+13463814616',
         customer_email = 'davosama15@gmail.com'
  WHERE  vehicle_id    = 'camry'
    AND  pickup_date   = '2026-04-07'
    AND  (customer_name IS NULL OR customer_name = '');

  -- ── 7. Patch revenue_records for Brandon's camry2013 bookings ────────────
  UPDATE revenue_records
  SET    customer_name  = 'Brandon Bookhart',
         customer_phone = '+15303285561',
         customer_email = 'brandon.bookhart@gmail.com'
  WHERE  booking_id IN ('bk-bb-2026-0402', 'bk-bb-2026-0407')
    AND  (customer_name IS NULL OR customer_name = '');

END $$;


-- ===========================================================================
-- 0049_bookings_customer_email.sql
-- ===========================================================================
-- =============================================================================
-- SLY RIDES — Migration 0049: Add customer_email to bookings table
-- =============================================================================
--
-- What this migration does:
--   Adds a customer_email column to the bookings table so that the renter's
--   email is stored directly on each booking row — without requiring a JOIN
--   to the customers table.
--
--   This field is populated by autoUpsertBooking() in _booking-automation.js
--   from booking.email (sourced from Stripe PaymentIntent metadata or admin
--   input) on both INSERT and UPDATE paths.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS guard.
-- =============================================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS customer_email text;

CREATE INDEX IF NOT EXISTS bookings_customer_email_idx
  ON bookings (customer_email)
  WHERE customer_email IS NOT NULL;


-- ===========================================================================
-- 0050_extension_revenue_records.sql
-- ===========================================================================
-- Migration 0050: extension revenue records pipeline
--
-- Standardises how paid rental extensions are tracked in revenue_records:
--   • Adds `type` column (text NOT NULL DEFAULT 'rental') so extension rows
--     can be distinguished from the original rental row.
--   • Adds `customer_id` column (uuid, FK to customers) so every revenue record
--     carries the full booking_id / customer_id / vehicle_id triple required
--     by the extension pipeline.
--
-- Extension rule (enforced by stripe-webhook.js after this migration):
--   When an extension payment succeeds the webhook:
--     1. Updates the existing booking row (return_date, amountPaid).
--     2. Creates a NEW revenue_records row:
--          booking_id        = extension PaymentIntent ID (unique per payment)
--          original_booking_id = original booking_id (links back to rental row)
--          type              = 'extension'
--          customer_id       = customers.id (looked up by phone / email)
--          vehicle_id        = vehicle_id
--          gross_amount      = extension charge
--     3. Does NOT mutate the original rental revenue_records row.
--     4. Extends blocked_dates accordingly.
--
-- Safe to re-run: all ALTER TABLE statements use IF NOT EXISTS.

-- ── 1. Add type column ────────────────────────────────────────────────────────

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'rental';

-- ── 2. Add customer_id column ─────────────────────────────────────────────────

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;

-- Backfill customer_id for existing rows using phone → customers lookup.
UPDATE revenue_records rr
SET    customer_id = c.id
FROM   customers c
WHERE  rr.customer_id IS NULL
  AND  rr.customer_phone IS NOT NULL
  AND  rr.customer_phone <> ''
  AND  c.phone = rr.customer_phone;

-- ── 3. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS revenue_records_type_idx
  ON revenue_records (type);

CREATE INDEX IF NOT EXISTS revenue_records_customer_id_idx
  ON revenue_records (customer_id)
  WHERE customer_id IS NOT NULL;


-- ===========================================================================
-- 0051_extension_booking_id_grouping.sql
-- ===========================================================================
-- Migration 0051: use original booking_id for extension revenue records
--
-- The previous approach (migration 0050) used the extension PaymentIntent ID
-- as booking_id for extension rows.  This breaks joins and analytics because
-- different booking_id values prevent grouping all records for a single rental.
--
-- New rule:
--   Extension revenue records share the same booking_id as the original rental:
--     booking_id          = original booking_id  (groups all records per rental)
--     payment_intent_id   = extension PaymentIntent ID (unique per payment)
--     type                = 'extension'
--
-- To support multiple rows per booking_id the old full UNIQUE constraint on
-- booking_id is replaced with:
--   1. A PARTIAL unique index on (booking_id) WHERE type = 'rental'
--      → still prevents duplicate rental records per booking.
--   2. A unique index on payment_intent_id (where not null)
--      → prevents duplicate rows for the same Stripe payment.
--
-- Safe to re-run: all statements use IF NOT EXISTS / DROP IF EXISTS patterns.

-- ── 1. Drop the old full unique constraint ────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE  table_name      = 'revenue_records'
      AND  constraint_name = 'revenue_records_booking_id_unique'
      AND  constraint_type = 'UNIQUE'
  ) THEN
    ALTER TABLE revenue_records
      DROP CONSTRAINT revenue_records_booking_id_unique;
  END IF;
END $$;

-- ── 2. Replace with a partial unique index for rental rows ────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS revenue_records_rental_booking_id_unique
  ON revenue_records (booking_id)
  WHERE type = 'rental';

-- ── 3. Add a unique index on payment_intent_id for dedup ─────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS revenue_records_payment_intent_id_unique
  ON revenue_records (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;


-- ===========================================================================
-- 0052_fix_revenue_records_effective_view.sql
-- ===========================================================================
-- Migration 0052: fix revenue_records_effective view
--
-- Problem: The revenue_records_effective view was created with additional
-- filters beyond sync_excluded that excluded valid Stripe-backed rows.
-- This caused the Revenue page to under-report (showing ~$2,008 / 6 records)
-- while the Dashboard correctly showed ~$2,850 by querying the base table
-- with only sync_excluded = false.
--
-- Fix: Redefine revenue_records_effective to expose ALL rows from
-- revenue_records where sync_excluded = false.  This is the only filter that
-- should be applied at the view level:
--   • sync_excluded = true  → admin soft-deleted the record; hide it
--   • everything else       → include (Stripe-backed, manually created, etc.)
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW revenue_records_effective AS
SELECT *
FROM   revenue_records
WHERE  sync_excluded = false;


-- ===========================================================================
-- 0053_revenue_reporting_base_view.sql
-- ===========================================================================
-- Migration 0053: add is_orphan column + create revenue_reporting_base view
--
-- Problem: v2-dashboard.js, v2-analytics.js, and v2-revenue.js all had their
-- own inline WHERE clauses against revenue_records_effective.  They each
-- repeated (or omitted) slightly different combinations of:
--   payment_status = 'paid'
--   sync_excluded  = false
--   is_orphan      = false
-- leading to subtle discrepancies between the Revenue page, Dashboard, and
-- Fleet Analytics totals.
--
-- Fix: introduce a single canonical view, revenue_reporting_base, that
-- centralises every shared filter in one place.  All three endpoints now
-- SELECT from this view and can add only their own run-time filters
-- (pickup_date range, vehicle_id, etc.) on top.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS and CREATE OR REPLACE VIEW are
-- idempotent.

-- ── 1. Add is_orphan column ───────────────────────────────────────────────────
-- Marks revenue_records rows that could not be linked to any known booking or
-- vehicle (e.g. stale Stripe charges from test-mode or deleted bookings).
-- The stripe-reconcile cleanup_orphans action will SET is_orphan = true on
-- unresolvable rows instead of sync_excluding them, so they remain visible
-- in admin audit queries but are excluded from financial reporting.

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS is_orphan boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS revenue_records_is_orphan_idx
  ON revenue_records (is_orphan)
  WHERE is_orphan = true;

-- ── 2. Create revenue_reporting_base view ─────────────────────────────────────
-- Canonical source for all financial reporting queries.
--
-- Filters applied here (never repeat these in JS):
--   • sync_excluded = false  — already guaranteed by source view
--                              (revenue_records_effective); included via COALESCE
--                              for self-documenting clarity
--   • payment_status = 'paid'
--   • is_orphan      = false — exclude Stripe charges with no matching booking
--
-- Filters intentionally left to JS:
--   • is_cancelled / is_no_show — revenue summary counts these separately;
--     dashboard/analytics skip them in the aggregation loop
--   • pickup_date range         — each endpoint applies its own date window
--   • vehicle_id                — fleet analytics filters per vehicle

CREATE OR REPLACE VIEW revenue_reporting_base AS
SELECT
  booking_id,
  vehicle_id,
  pickup_date,
  gross_amount,
  stripe_fee,
  stripe_net,
  refund_amount,
  deposit_amount,
  is_cancelled,
  is_no_show
FROM   revenue_records_effective
WHERE  payment_status              = 'paid'
  AND  COALESCE(sync_excluded,  false) = false
  AND  COALESCE(is_orphan,      false) = false;


-- ===========================================================================
-- 0054_pending_booking_docs.sql
-- ===========================================================================
-- Migration 0054: pending_booking_docs table
--
-- Purpose: store the renter's signature, ID photo, and insurance document
-- server-side BEFORE the Stripe payment is confirmed so the webhook can
-- send the owner a full email (signed agreement PDF + ID + insurance)
-- even when the customer's browser fails to call send-reservation-email.js.
--
-- Rows are cleaned up automatically after 7 days via a lightweight nightly job,
-- or manually after email_sent is confirmed true.
--
-- Safe to re-run: all statements use IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS pending_booking_docs (
  booking_id           text        PRIMARY KEY,
  signature            text,
  id_base64            text,
  id_filename          text,
  id_mimetype          text,
  insurance_base64     text,
  insurance_filename   text,
  insurance_mimetype   text,
  insurance_coverage_choice text,
  email_sent           boolean     NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_booking_docs_created_at_idx
  ON pending_booking_docs (created_at);

-- Service-role only; no public access.
ALTER TABLE pending_booking_docs ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- 0055_atomic_booking_revenue.sql
-- ===========================================================================
-- Migration 0055: atomic booking + revenue upsert transaction
--
-- Guarantees booking + revenue persistence is all-or-nothing in a single DB
-- transaction for strict Stripe webhook processing.

CREATE OR REPLACE FUNCTION public.upsert_booking_revenue_atomic(
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_booking_ref text,
  p_vehicle_id text,
  p_pickup_date date,
  p_return_date date,
  p_pickup_time time,
  p_return_time time,
  p_status text,
  p_total_price numeric,
  p_deposit_paid numeric,
  p_remaining_balance numeric,
  p_payment_status text,
  p_notes text,
  p_payment_method text,
  p_payment_intent_id text,
  p_stripe_customer_id text,
  p_stripe_payment_method_id text,
  p_booking_customer_email text,
  p_activated_at timestamptz,
  p_completed_at timestamptz,
  p_revenue_vehicle_id text,
  p_revenue_customer_name text,
  p_revenue_customer_phone text,
  p_revenue_customer_email text,
  p_revenue_pickup_date date,
  p_revenue_return_date date,
  p_gross_amount numeric,
  p_stripe_fee numeric,
  p_payment_intent_id_revenue text,
  p_refund_amount numeric,
  p_revenue_payment_method text,
  p_revenue_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_customer_id uuid;
  v_booking_id uuid;
  v_revenue_id uuid;
  v_revenue_stripe_fee numeric;
  v_revenue_payment_intent text;
BEGIN
  IF p_booking_ref IS NULL OR btrim(p_booking_ref) = '' THEN
    RAISE EXCEPTION 'booking_ref is required';
  END IF;

  IF p_revenue_vehicle_id IS NULL OR btrim(p_revenue_vehicle_id) = '' THEN
    RAISE EXCEPTION 'revenue vehicle_id is required';
  END IF;

  -- Customer dedupe: email-first (primary identity), then phone fallback.
  IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE lower(c.email) = lower(p_customer_email)
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE c.phone = p_customer_phone
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND (
    (p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '') OR
    (p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '')
  ) THEN
    BEGIN
      INSERT INTO customers (
        name, phone, email, updated_at
      ) VALUES (
        COALESCE(NULLIF(p_customer_name, ''), 'Unknown'),
        NULLIF(p_customer_phone, ''),
        NULLIF(lower(p_customer_email), ''),
        now()
      )
      RETURNING id INTO v_customer_id;
    EXCEPTION
      WHEN unique_violation THEN
        IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE lower(c.email) = lower(p_customer_email)
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE c.phone = p_customer_phone
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL THEN
          RAISE;
        END IF;
    END;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET
      name = COALESCE(NULLIF(p_customer_name, ''), customers.name),
      phone = COALESCE(NULLIF(p_customer_phone, ''), customers.phone),
      email = COALESCE(NULLIF(lower(p_customer_email), ''), customers.email),
      updated_at = now()
    WHERE id = v_customer_id;
  END IF;

  INSERT INTO bookings (
    booking_ref,
    customer_id,
    vehicle_id,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    status,
    total_price,
    deposit_paid,
    remaining_balance,
    payment_status,
    notes,
    payment_method,
    payment_intent_id,
    stripe_customer_id,
    stripe_payment_method_id,
    customer_email,
    activated_at,
    completed_at
  ) VALUES (
    p_booking_ref,
    v_customer_id,
    p_vehicle_id,
    p_pickup_date,
    p_return_date,
    p_pickup_time,
    p_return_time,
    COALESCE(NULLIF(p_status, ''), 'pending'),
    COALESCE(p_total_price, 0),
    COALESCE(p_deposit_paid, 0),
    COALESCE(p_remaining_balance, 0),
    COALESCE(NULLIF(p_payment_status, ''), 'unpaid'),
    p_notes,
    p_payment_method,
    p_payment_intent_id,
    p_stripe_customer_id,
    p_stripe_payment_method_id,
    p_booking_customer_email,
    p_activated_at,
    p_completed_at
  )
  ON CONFLICT (booking_ref) DO UPDATE
  SET
    customer_id = EXCLUDED.customer_id,
    vehicle_id = EXCLUDED.vehicle_id,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    pickup_time = EXCLUDED.pickup_time,
    return_time = EXCLUDED.return_time,
    status = EXCLUDED.status,
    total_price = EXCLUDED.total_price,
    deposit_paid = EXCLUDED.deposit_paid,
    remaining_balance = EXCLUDED.remaining_balance,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    payment_method = EXCLUDED.payment_method,
    payment_intent_id = EXCLUDED.payment_intent_id,
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_payment_method_id = EXCLUDED.stripe_payment_method_id,
    customer_email = EXCLUDED.customer_email,
    activated_at = COALESCE(EXCLUDED.activated_at, bookings.activated_at),
    completed_at = COALESCE(EXCLUDED.completed_at, bookings.completed_at),
    updated_at = now()
  RETURNING id INTO v_booking_id;

  INSERT INTO revenue_records (
    booking_id,
    payment_intent_id,
    vehicle_id,
    customer_id,
    customer_name,
    customer_phone,
    customer_email,
    pickup_date,
    return_date,
    gross_amount,
    refund_amount,
    payment_method,
    payment_status,
    type,
    notes,
    stripe_fee
  ) VALUES (
    p_booking_ref,
    p_payment_intent_id_revenue,
    p_revenue_vehicle_id,
    v_customer_id,
    p_revenue_customer_name,
    p_revenue_customer_phone,
    p_revenue_customer_email,
    p_revenue_pickup_date,
    p_revenue_return_date,
    COALESCE(p_gross_amount, 0),
    COALESCE(p_refund_amount, 0),
    COALESCE(NULLIF(p_revenue_payment_method, ''), 'stripe'),
    'paid',
    'rental',
    p_revenue_notes,
    p_stripe_fee
  )
  ON CONFLICT (booking_id) WHERE type = 'rental' DO UPDATE
  SET
    payment_intent_id = EXCLUDED.payment_intent_id,
    vehicle_id = EXCLUDED.vehicle_id,
    customer_id = EXCLUDED.customer_id,
    customer_name = EXCLUDED.customer_name,
    customer_phone = EXCLUDED.customer_phone,
    customer_email = EXCLUDED.customer_email,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    gross_amount = EXCLUDED.gross_amount,
    refund_amount = EXCLUDED.refund_amount,
    payment_method = EXCLUDED.payment_method,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    stripe_fee = EXCLUDED.stripe_fee,
    updated_at = now()
  RETURNING id, stripe_fee, payment_intent_id
  INTO v_revenue_id, v_revenue_stripe_fee, v_revenue_payment_intent;

  IF v_revenue_stripe_fee IS NULL OR v_revenue_payment_intent IS NULL OR btrim(v_revenue_payment_intent) = '' THEN
    RAISE EXCEPTION 'revenue record incomplete after upsert for booking_ref=%', p_booking_ref;
  END IF;

  RETURN jsonb_build_object(
    'booking_id', v_booking_id,
    'customer_id', v_customer_id,
    'revenue_id', v_revenue_id,
    'revenue_complete', true
  );
END;
$$;


-- ===========================================================================
-- 0055_pending_booking_docs_service_role_policy.sql
-- ===========================================================================
-- Migration 0055: explicit service-role policy for pending_booking_docs
--
-- 0054 already enables RLS for this table. This migration adds explicit
-- privilege and policy statements so access intent is clear in schema history:
-- only service_role can read/write rows.

REVOKE ALL ON TABLE pending_booking_docs FROM anon;
REVOKE ALL ON TABLE pending_booking_docs FROM authenticated;
GRANT ALL ON TABLE pending_booking_docs TO service_role;

CREATE POLICY IF NOT EXISTS pending_booking_docs_service_role_all
  ON pending_booking_docs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ===========================================================================
-- 0056_expand_bookings_status_constraint.sql
-- ===========================================================================
-- Migration 0056: Expand bookings.status allowed values
--
-- Purpose:
-- Replace bookings_status_check so booking lifecycle supports:
--   pending, active, overdue, completed
-- Normalize legacy statuses before enforcing the new check:
--   approved  -> pending
--   cancelled -> completed

UPDATE bookings
SET status = 'pending'
WHERE status = 'approved';

UPDATE bookings
SET status = 'completed'
WHERE status = 'cancelled';

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'active', 'overdue', 'completed'));


-- ===========================================================================
-- 0057_customer_email_dedup_normalization.sql
-- ===========================================================================
-- 0057_customer_email_dedup_normalization.sql
-- Enforce email normalization + case-insensitive uniqueness for customers.
-- Also performs one-time dedup cleanup by LOWER(email), keeping the earliest row.

BEGIN;

-- Normalize stored emails to lowercase/trimmed form.
UPDATE customers
SET email = NULLIF(lower(btrim(email)), '')
WHERE email IS NOT NULL;

UPDATE bookings
SET customer_email = NULLIF(lower(btrim(customer_email)), '')
WHERE customer_email IS NOT NULL;

UPDATE revenue_records
SET customer_email = NULLIF(lower(btrim(customer_email)), '')
WHERE customer_email IS NOT NULL;

-- Re-link records that already reference duplicate customer IDs.
WITH ranked AS (
  SELECT
    id,
    lower(email) AS email_key,
    row_number() OVER (
      PARTITION BY lower(email)
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY lower(email)
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS keeper_id
  FROM customers
  WHERE email IS NOT NULL AND btrim(email) <> ''
),
dupes AS (
  SELECT id, keeper_id
  FROM ranked
  WHERE rn > 1 AND keeper_id <> id
),
keeper_by_email AS (
  SELECT DISTINCT email_key, keeper_id
  FROM ranked
)
UPDATE bookings b
SET customer_id = d.keeper_id,
    updated_at = now()
FROM dupes d
WHERE b.customer_id = d.id;

WITH ranked AS (
  SELECT
    id,
    lower(email) AS email_key,
    row_number() OVER (
      PARTITION BY lower(email)
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY lower(email)
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS keeper_id
  FROM customers
  WHERE email IS NOT NULL AND btrim(email) <> ''
),
dupes AS (
  SELECT id, keeper_id
  FROM ranked
  WHERE rn > 1 AND keeper_id <> id
)
UPDATE revenue_records r
SET customer_id = d.keeper_id,
    updated_at = now()
FROM dupes d
WHERE r.customer_id = d.id;

-- Backfill missing customer_id links by normalized email where possible.
WITH keeper_by_email AS (
  SELECT
    lower(email) AS email_key,
    id AS keeper_id
  FROM (
    SELECT
      id,
      email,
      row_number() OVER (
        PARTITION BY lower(email)
        ORDER BY created_at ASC NULLS LAST, id ASC
      ) AS rn
    FROM customers
    WHERE email IS NOT NULL AND btrim(email) <> ''
  ) s
  WHERE s.rn = 1
)
UPDATE bookings b
SET customer_id = k.keeper_id,
    updated_at = now()
FROM keeper_by_email k
WHERE b.customer_id IS NULL
  AND b.customer_email IS NOT NULL
  AND lower(b.customer_email) = k.email_key;

WITH keeper_by_email AS (
  SELECT
    lower(email) AS email_key,
    id AS keeper_id
  FROM (
    SELECT
      id,
      email,
      row_number() OVER (
        PARTITION BY lower(email)
        ORDER BY created_at ASC NULLS LAST, id ASC
      ) AS rn
    FROM customers
    WHERE email IS NOT NULL AND btrim(email) <> ''
  ) s
  WHERE s.rn = 1
)
UPDATE revenue_records r
SET customer_id = k.keeper_id,
    updated_at = now()
FROM keeper_by_email k
WHERE r.customer_id IS NULL
  AND r.customer_email IS NOT NULL
  AND lower(r.customer_email) = k.email_key;

-- Remove duplicate customer rows (non-keeper rows).
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY lower(email)
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM customers
  WHERE email IS NOT NULL AND btrim(email) <> ''
)
DELETE FROM customers c
USING ranked r
WHERE c.id = r.id
  AND r.rn > 1;

-- Enforce case-insensitive uniqueness forever.
CREATE UNIQUE INDEX IF NOT EXISTS unique_customer_email_lower
ON public.customers (LOWER(btrim(email)))
WHERE email IS NOT NULL AND btrim(email) <> '';

COMMIT;


-- ===========================================================================
-- 0058_customer_email_dedup_cleanup.sql
-- ===========================================================================
-- 0058_customer_email_dedup_cleanup.sql
-- Follow-up cleanup to fully collapse customers by LOWER(email).

BEGIN;

-- Re-normalize customer + ledger emails for legacy rows.
UPDATE customers
SET email = NULLIF(lower(btrim(email)), '')
WHERE email IS NOT NULL;

UPDATE bookings
SET customer_email = NULLIF(lower(btrim(customer_email)), '')
WHERE customer_email IS NOT NULL;

UPDATE revenue_records
SET customer_email = NULLIF(lower(btrim(customer_email)), '')
WHERE customer_email IS NOT NULL;

-- Build canonical keeper + duplicate maps once so all updates share the same winner.
CREATE TEMP TABLE tmp_customer_email_ranked ON COMMIT DROP AS
SELECT
  id,
  lower(btrim(email)) AS email_key,
  row_number() OVER (
    PARTITION BY lower(btrim(email))
    ORDER BY created_at ASC NULLS LAST, id ASC
  ) AS rn,
  first_value(id) OVER (
    PARTITION BY lower(btrim(email))
    ORDER BY created_at ASC NULLS LAST, id ASC
  ) AS keeper_id
FROM customers
WHERE email IS NOT NULL AND btrim(email) <> '';

CREATE TEMP TABLE tmp_customer_email_dupes ON COMMIT DROP AS
SELECT id, keeper_id
FROM tmp_customer_email_ranked
WHERE rn > 1 AND keeper_id <> id;

CREATE TEMP TABLE tmp_customer_email_keepers ON COMMIT DROP AS
SELECT email_key, keeper_id
FROM tmp_customer_email_ranked
WHERE rn = 1;

-- Re-link duplicate customer_id references to canonical keepers.
UPDATE bookings b
SET customer_id = d.keeper_id,
    updated_at = now()
FROM tmp_customer_email_dupes d
WHERE b.customer_id = d.id;

UPDATE revenue_records r
SET customer_id = d.keeper_id,
    updated_at = now()
FROM tmp_customer_email_dupes d
WHERE r.customer_id = d.id;

-- Backfill missing customer_id by strictly normalized LOWER(email).
UPDATE bookings b
SET customer_id = k.keeper_id,
    updated_at = now()
FROM tmp_customer_email_keepers k
WHERE b.customer_id IS NULL
  AND b.customer_email IS NOT NULL
  AND lower(btrim(b.customer_email)) = k.email_key;

UPDATE revenue_records r
SET customer_id = k.keeper_id,
    updated_at = now()
FROM tmp_customer_email_keepers k
WHERE r.customer_id IS NULL
  AND r.customer_email IS NOT NULL
  AND lower(btrim(r.customer_email)) = k.email_key;

-- Remove orphan duplicate rows only when they have no linked bookings or revenue.
DELETE FROM customers c
USING tmp_customer_email_ranked r
WHERE c.id = r.id
  AND r.rn > 1
  AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM revenue_records rr WHERE rr.customer_id = c.id);

-- Final guard: keep exactly one row per normalized email forever.
DROP INDEX IF EXISTS unique_customer_email_lower;
CREATE UNIQUE INDEX unique_customer_email_lower
ON public.customers (LOWER(btrim(email)))
WHERE email IS NOT NULL AND btrim(email) <> '';

COMMIT;


-- ===========================================================================
-- 0059_final_orphan_customer_cleanup.sql
-- ===========================================================================
-- 0059_final_orphan_customer_cleanup.sql
-- Remove remaining orphan customers that are not linked to bookings or revenue.

BEGIN;

DELETE FROM customers
WHERE id NOT IN (
  SELECT DISTINCT customer_id FROM bookings WHERE customer_id IS NOT NULL
  UNION
  SELECT DISTINCT customer_id FROM revenue_records WHERE customer_id IS NOT NULL
)
-- Preserve customers without emails (anonymous/legacy placeholders); cleanup targets email-identified orphans.
AND email IS NOT NULL;

COMMIT;


-- ===========================================================================
-- 0060_revenue_booking_ref_integrity.sql
-- ===========================================================================
-- Migration 0060: enforce revenue_records.booking_id → bookings.booking_ref integrity
--
-- Problem:
--   A successful Stripe payment could create a revenue_records row while the
--   corresponding bookings row was absent (partial pipeline failure or legacy gap),
--   producing an "orphan revenue record" visible in the Revenue tab but invisible
--   in the Bookings page.
--
-- Fix — two parts:
--
--   1. Pre-flight: mark any existing revenue_records rows whose booking_id has NO
--      matching bookings.booking_ref as is_orphan = true so they are excluded from
--      financial reporting and exempt from the new trigger.
--
--   2. Trigger check_revenue_booking_ref:
--      • Fires BEFORE INSERT OR UPDATE on revenue_records.
--      • Skips rows already flagged as is_orphan = true (already excluded from
--        reporting; orphan marking is the deliberate escape hatch).
--      • Skips rows with sync_excluded = true (soft-deleted records).
--      • For all other rows: raises an exception unless booking_id appears in
--        bookings.booking_ref so the row can never be written without a real booking.
--
-- Why a trigger instead of a FK constraint?
--   revenue_records.booking_id is TEXT (stores booking_ref strings like "bk-ro-2026-0401")
--   while bookings.booking_ref is also TEXT UNIQUE.  PostgreSQL allows FK references
--   across text columns but only if both sides share the same collation.  A trigger is
--   more portable and lets us add the is_orphan / sync_excluded escape hatch cleanly
--   without a partial-index FK (which PostgreSQL does not support).
--
-- Safe to re-run: all statements use CREATE OR REPLACE / IF NOT EXISTS / DO $$ guards.

-- ── 1. Pre-flight: mark unlinked existing rows as orphans ─────────────────────
-- Any revenue record whose booking_id is not present in bookings.booking_ref is
-- already an orphan.  Stamp them so they are excluded from reporting and exempt
-- from the new trigger.  Use is_orphan=false guard so repeated runs are idempotent.

UPDATE revenue_records
SET    is_orphan  = true,
       updated_at = now()
WHERE  is_orphan  = false
  AND  sync_excluded = false
  AND  booking_id IS NOT NULL
  AND  NOT EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.booking_id
       );

-- ── 2. Trigger function ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_revenue_booking_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- is_orphan = true  → row is already flagged as having no real booking.
  --                     Allowed so stripe-reconcile and cleanup tools can still
  --                     persist/update these rows without a booking present.
  IF NEW.is_orphan = true THEN
    RETURN NEW;
  END IF;

  -- sync_excluded = true → soft-deleted row; skip the check.
  IF NEW.sync_excluded = true THEN
    RETURN NEW;
  END IF;

  -- Guard: booking_id must be non-null AND have a matching booking_ref.
  -- NULL booking_id is rejected explicitly here for a clear error message;
  -- `NOT EXISTS` with a NULL arg would also evaluate as true (matching nothing)
  -- but the explicit check makes intent readable.
  IF NEW.booking_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM bookings WHERE booking_ref = NEW.booking_id
  ) THEN
    RAISE EXCEPTION
      'revenue_records integrity violation: booking_id=''%'' has no matching row in bookings.booking_ref. '
      'If this is an intentional orphan record (e.g. from stripe-reconcile auto-create), '
      'set is_orphan = true before inserting.',
      COALESCE(NEW.booking_id, '<null>');
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. Attach trigger to revenue_records ─────────────────────────────────────

DROP TRIGGER IF EXISTS revenue_records_booking_ref_check ON revenue_records;

CREATE TRIGGER revenue_records_booking_ref_check
  BEFORE INSERT OR UPDATE ON revenue_records
  FOR EACH ROW EXECUTE FUNCTION public.check_revenue_booking_ref();


-- ===========================================================================
-- 0061_blocked_dates_integer_id.sql
-- ===========================================================================
-- Ensure blocked_dates uses an integer id primary key so admin delete-by-id
-- operations can use numeric IDs consistently.

DO $$
DECLARE
  v_id_type text;
  v_pk_name text;
BEGIN
  SELECT data_type
    INTO v_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'blocked_dates'
    AND column_name = 'id';

  IF v_id_type IS NULL THEN
    ALTER TABLE public.blocked_dates
      ADD COLUMN id SERIAL;
    ALTER TABLE public.blocked_dates
      ADD CONSTRAINT blocked_dates_pkey PRIMARY KEY (id);
    RETURN;
  END IF;

  IF v_id_type = 'integer' THEN
    RETURN;
  END IF;

  SELECT c.conname
    INTO v_pk_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE c.contype = 'p'
    AND n.nspname = 'public'
    AND t.relname = 'blocked_dates'
  LIMIT 1;

  IF v_pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.blocked_dates DROP CONSTRAINT %I', v_pk_name);
  END IF;

  ALTER TABLE public.blocked_dates RENAME COLUMN id TO legacy_uuid_id;
  ALTER TABLE public.blocked_dates ADD COLUMN id SERIAL;
  ALTER TABLE public.blocked_dates ADD CONSTRAINT blocked_dates_pkey PRIMARY KEY (id);
END $$;


-- ===========================================================================
-- 0062_blocked_dates_booking_ref_and_overlap.sql
-- ===========================================================================
-- Migration 0062: blocked_dates — booking_ref linkage + no-overlap constraint + TTL cleanup
--
-- 1. Add optional booking_ref column that links a blocked range back to the booking that created it.
-- 2. Add an overlap-prevention trigger so only non-overlapping ranges can coexist per vehicle.
-- 3. Add an index to support fast TTL queries (cleanup of past ranges).

-- ── 1. Add booking_ref column (nullable, FK to bookings.booking_ref) ──────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'blocked_dates'
      AND column_name  = 'booking_ref'
  ) THEN
    ALTER TABLE public.blocked_dates
      ADD COLUMN booking_ref text REFERENCES public.bookings(booking_ref) ON DELETE SET NULL;
    COMMENT ON COLUMN public.blocked_dates.booking_ref
      IS 'Optional link to the booking that created this block. NULL for manual/maintenance blocks.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS blocked_dates_booking_ref_idx
  ON public.blocked_dates (booking_ref)
  WHERE booking_ref IS NOT NULL;

-- ── 2. Overlap-prevention trigger ─────────────────────────────────────────────
-- Raises an exception when a new row would overlap an existing range for the
-- same vehicle.  Two ranges [a,b] and [c,d] overlap when a <= d AND c <= b.

CREATE OR REPLACE FUNCTION public.check_blocked_dates_overlap()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.blocked_dates
    WHERE vehicle_id  = NEW.vehicle_id
      AND start_date <= NEW.end_date
      AND end_date   >= NEW.start_date
      AND id         != COALESCE(NEW.id, -1)
  ) THEN
    RAISE EXCEPTION
      'blocked_dates overlap: vehicle % already has a blocked range overlapping % – %',
      NEW.vehicle_id, NEW.start_date, NEW.end_date
    USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Drop existing trigger first so re-running the migration is idempotent
DROP TRIGGER IF EXISTS trg_blocked_dates_no_overlap ON public.blocked_dates;

CREATE TRIGGER trg_blocked_dates_no_overlap
  BEFORE INSERT OR UPDATE ON public.blocked_dates
  FOR EACH ROW EXECUTE FUNCTION public.check_blocked_dates_overlap();

-- ── 3. Index for TTL / expired-range cleanup queries ─────────────────────────
CREATE INDEX IF NOT EXISTS blocked_dates_end_date_idx
  ON public.blocked_dates (end_date);


-- ===========================================================================
-- 0063_bookings_actual_return_time.sql
-- ===========================================================================
-- Migration 0063: Add actual_return_time to bookings
--
-- Records the real-world timestamp when a renter physically returns the vehicle.
-- Populated automatically when admin clicks "Returned" (status → completed_rental).
-- Used to compute early-return trimming of blocked_dates and next-available display.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'bookings'
      AND column_name  = 'actual_return_time'
  ) THEN
    ALTER TABLE public.bookings
      ADD COLUMN actual_return_time timestamptz;
    COMMENT ON COLUMN public.bookings.actual_return_time
      IS 'Timestamp when the vehicle was physically returned. Set by the admin "Returned" action.';
  END IF;
END $$;


-- ===========================================================================
-- 0064_backfill_brandon_extension_revenue.sql
-- ===========================================================================
-- Migration 0064: backfill missing Brandon extension revenue row
--
-- Required one-off recovery:
--   payment_intent_id = pi_3TP2RQPo7fICjrtZ26LarkgC
--   booking_id        = ca8ee28ffb888c41
--   type              = extension
--   gross_amount      = 60.64
--   stripe_fee        = 2.06
--   stripe_net        = 58.58
--
-- Important:
--   • Inserts a NEW revenue_records row (no update/merge of existing rental row).
--   • Uses payment_intent_id for deduplication.
--   • Safe to re-run (NOT EXISTS guard on payment_intent_id).

WITH target AS (
  SELECT
    'ca8ee28ffb888c41'::text              AS booking_id,
    'pi_3TP2RQPo7fICjrtZ26LarkgC'::text   AS payment_intent_id,
    60.64::numeric(10,2)                  AS gross_amount,
    2.06::numeric(10,2)                   AS stripe_fee,
    58.58::numeric(10,2)                  AS stripe_net
),
context AS (
  SELECT
    t.booking_id,
    t.payment_intent_id,
    t.gross_amount,
    t.stripe_fee,
    t.stripe_net,
    COALESCE(
      (
        SELECT rr.vehicle_id
        FROM revenue_records rr
        WHERE rr.booking_id = t.booking_id
        ORDER BY (rr.type = 'rental') DESC, rr.created_at ASC
        LIMIT 1
      ),
      (
        SELECT b.vehicle_id
        FROM bookings b
        WHERE b.booking_ref = t.booking_id
        ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC NULLS LAST
        LIMIT 1
      )
    ) AS vehicle_id,
    (
      SELECT rr.customer_id
      FROM revenue_records rr
      WHERE rr.booking_id = t.booking_id
      ORDER BY (rr.type = 'rental') DESC, rr.created_at ASC
      LIMIT 1
    ) AS customer_id,
    (
      SELECT rr.customer_name
      FROM revenue_records rr
      WHERE rr.booking_id = t.booking_id
      ORDER BY (rr.type = 'rental') DESC, rr.created_at ASC
      LIMIT 1
    ) AS customer_name,
    (
      SELECT rr.customer_phone
      FROM revenue_records rr
      WHERE rr.booking_id = t.booking_id
      ORDER BY (rr.type = 'rental') DESC, rr.created_at ASC
      LIMIT 1
    ) AS customer_phone,
    (
      SELECT rr.customer_email
      FROM revenue_records rr
      WHERE rr.booking_id = t.booking_id
      ORDER BY (rr.type = 'rental') DESC, rr.created_at ASC
      LIMIT 1
    ) AS customer_email
  FROM target t
)
INSERT INTO revenue_records (
  booking_id,
  original_booking_id,
  payment_intent_id,
  vehicle_id,
  customer_id,
  customer_name,
  customer_phone,
  customer_email,
  gross_amount,
  payment_method,
  payment_status,
  type,
  stripe_fee,
  stripe_net,
  notes
)
SELECT
  c.booking_id,
  c.booking_id AS original_booking_id,
  c.payment_intent_id,
  c.vehicle_id,
  c.customer_id,
  c.customer_name,
  c.customer_phone,
  c.customer_email,
  c.gross_amount,
  'stripe' AS payment_method,
  'paid'   AS payment_status,
  'extension' AS type,
  c.stripe_fee,
  c.stripe_net,
  'Backfill: missing extension revenue row for PI pi_3TP2RQPo7fICjrtZ26LarkgC' AS notes
FROM context c
WHERE c.vehicle_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM revenue_records rr
    WHERE rr.payment_intent_id = c.payment_intent_id
  );


-- ===========================================================================
-- 0064_standardize_active_rental_status.sql
-- ===========================================================================
-- Migration 0064: Standardize legacy active booking status
--
-- Purpose:
-- Normalize legacy booking rows that still use status='active' so all active
-- rentals use status='active_rental' in application-facing flows.
--
-- Note:
-- Some legacy environments may still enforce older status check constraints
-- that do not yet allow 'active_rental'. In that case this migration logs a
-- notice and skips the rewrite instead of failing.

DO $$
BEGIN
  BEGIN
    UPDATE bookings
    SET status = 'active_rental'
    WHERE status = 'active';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Skipping active→active_rental rewrite because bookings.status constraint rejects active_rental.';
  END;
END $$;


-- ===========================================================================
-- 0065_bookings_vehicle_fk_enforcement.sql
-- ===========================================================================
-- Ensure booking vehicle IDs always reference an existing vehicle record.
-- Also normalize the legacy Camry 2012 ID used in old records.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.vehicles
    WHERE vehicle_id = 'camry'
  ) THEN
    RAISE EXCEPTION 'Required canonical vehicle_id "camry" is missing in public.vehicles; ensure that row exists before running this migration.';
  END IF;
END $$;

UPDATE public.bookings
SET vehicle_id = 'camry'
WHERE vehicle_id = 'camry2012';

DO $$
DECLARE
  existing_fk_name text;
BEGIN
  SELECT con.conname
    INTO existing_fk_name
  FROM pg_constraint con
  JOIN pg_class rel
    ON rel.oid = con.conrelid
  JOIN pg_namespace nsp
    ON nsp.oid = rel.relnamespace
  JOIN pg_attribute att
    ON att.attrelid = rel.oid
   AND att.attnum = ANY(con.conkey)
  WHERE con.contype = 'f'
    AND nsp.nspname = 'public'
    AND rel.relname = 'bookings'
    AND att.attname = 'vehicle_id'
    AND con.confrelid = 'public.vehicles'::regclass
  LIMIT 1;

  IF existing_fk_name IS NULL THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_vehicle_id_fkey
      FOREIGN KEY (vehicle_id)
      REFERENCES public.vehicles(vehicle_id)
      ON DELETE RESTRICT;
    existing_fk_name := 'bookings_vehicle_id_fkey';
  END IF;

  EXECUTE format(
    'ALTER TABLE public.bookings VALIDATE CONSTRAINT %I',
    existing_fk_name
  );
END $$;


-- ===========================================================================
-- 0066_manage_booking_support.sql
-- ===========================================================================
-- Migration 0066: Customer-managed reservation support
--
-- Adds the columns and constraint relaxations needed for customers to view and
-- edit their own booking after paying a reservation deposit.
--
-- New columns on bookings:
--   change_count           — counts how many date/vehicle/plan changes have been applied
--   manage_token           — short-lived HMAC token sent to the customer for portal access
--   balance_payment_link   — current URL for the customer to pay the remaining balance
--   pending_change         — JSONB snapshot of a change awaiting a change-fee payment
--
-- Constraint changes:
--   bookings_status_check         — adds 'reserved' and 'pending_verification'
--   bookings_payment_status_check — adds 'partial'

-- ── 1. New columns ─────────────────────────────────────────────────────────────

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS change_count         integer NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS manage_token         text    UNIQUE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_payment_link text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pending_change       jsonb;

-- ── 2. Relax status check to include 'reserved' and 'pending_verification' ────

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    'pending',
    'reserved',
    'pending_verification',
    'active',
    'overdue',
    'completed'
  ));

-- ── 3. Relax payment_status check to include 'partial' ────────────────────────

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('unpaid', 'partial', 'paid'));

-- ── 4. Index for fast manage_token lookups ─────────────────────────────────────

CREATE INDEX IF NOT EXISTS bookings_manage_token_idx
  ON bookings (manage_token)
  WHERE manage_token IS NOT NULL;


-- ===========================================================================
-- 0067_fix_anthony_pickup_time.sql
-- ===========================================================================
-- Migration 0067: Fix Anthony Johnson pickup/return time for booking bk-3bcf479ac6ec
--
-- Background: Anthony selected 4:00 PM as his pickup time on the booking form,
-- but the booking was stored with 08:00:00 (8am) due to the auto-selected
-- default time slot not being overridden correctly.  This corrects both
-- pickup_time and return_time to 16:00:00 (4:00 PM LA time) and also updates
-- the revenue_records row for the same booking so the times are consistent.
--
-- pickup date:  2026-04-23
-- return date:  2026-04-30
-- vehicle:      camry (Camry 2012)
-- booking_ref:  bk-3bcf479ac6ec

UPDATE public.bookings
SET
  pickup_time = '16:00:00',
  return_time = '16:00:00',
  updated_at  = now()
WHERE booking_ref = 'bk-3bcf479ac6ec';

-- Also update the rental revenue_records placeholder row so pickup/return times
-- are consistent there (the reservation_deposit row does not carry time fields).
UPDATE public.revenue_records
SET
  pickup_date = '2026-04-23',
  return_date = '2026-04-30'
WHERE booking_id = 'bk-3bcf479ac6ec'
  AND type = 'rental';


-- ===========================================================================
-- 0068_extend_pending_fields.sql
-- ===========================================================================
-- Migration 0068: Extension-pending fields on bookings
--
-- Migrates the extendPending and extensionPendingPayment booking fields
-- from bookings.json (GitHub) to the Supabase bookings table so they are
-- durable, queryable, and not dependent on the GitHub file store.
--
-- New columns on bookings:
--   extend_pending              — true while the customer has sent EXTEND but
--                                  not yet selected an option; cleared on
--                                  option selection or payment confirmation.
--   extension_pending_payment   — JSONB snapshot of the selected extension
--                                  option (price, label, newReturnDate, etc.)
--                                  while Stripe payment is outstanding; null
--                                  once the payment succeeds or is abandoned.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extend_pending            boolean NOT NULL DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extension_pending_payment jsonb;

-- Fast lookup: find all bookings awaiting an extend-option reply.
CREATE INDEX IF NOT EXISTS bookings_extend_pending_idx
  ON bookings (extend_pending)
  WHERE extend_pending = true;


-- ===========================================================================
-- 0069_bookings_require_contact.sql
-- ===========================================================================
-- 0069_bookings_require_contact.sql
--
-- Adds a CHECK constraint that requires every booking row to have at least one
-- contact identifier (customer_phone OR customer_email).  This prevents silent
-- data-loss bugs where a booking is created without any way for the customer to
-- later retrieve it via manage-booking.
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ SAFETY — read before deploying                                          │
-- │                                                                         │
-- │ Step A — audit first.  Run this query and confirm it returns 0 before   │
-- │ promoting the constraint to VALIDATED:                                  │
-- │                                                                         │
-- │   SELECT COUNT(*)                                                        │
-- │   FROM public.bookings                                                   │
-- │   WHERE customer_phone IS NULL                                           │
-- │     AND customer_email IS NULL;                                          │
-- │                                                                         │
-- │ If the count > 0, backfill via:                                         │
-- │   POST /api/stripe-backfill  { backfill_contacts: true }                │
-- │                                                                         │
-- │ Step B — validate once clean.  After the audit returns 0, run:          │
-- │   ALTER TABLE public.bookings                                           │
-- │     VALIDATE CONSTRAINT bookings_require_contact;                       │
-- │                                                                         │
-- │ The constraint is added NOT VALID so it does NOT scan existing rows     │
-- │ now — it only guards new INSERTs and UPDATEs immediately.               │
-- └─────────────────────────────────────────────────────────────────────────┘

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname    = 'bookings_require_contact'
      AND conrelid   = 'public.bookings'::regclass
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_require_contact
      CHECK (customer_phone IS NOT NULL OR customer_email IS NOT NULL)
      NOT VALID;

    RAISE NOTICE 'bookings_require_contact constraint added (NOT VALID). '
                 'Run VALIDATE CONSTRAINT after backfilling all existing rows.';
  ELSE
    RAISE NOTICE 'bookings_require_contact constraint already exists — skipping.';
  END IF;
END $$;


-- ===========================================================================
-- 0070_bookings_protection_plan_columns.sql
-- ===========================================================================
-- Migration 0070: Add protection plan columns to bookings
--
-- Purpose: track whether a booking includes the Damage Protection Plan (DPP)
-- and which tier was selected so that manage-booking can pre-fill the edit form
-- and so that apply_change / booking_change_fee correctly reflect the customer's
-- current coverage choice.
--
-- New columns on bookings:
--   has_protection_plan  — true when the booking includes DPP
--   protection_plan_tier — 'basic', 'standard', or 'premium' (null when no DPP)
--
-- Safe to re-run: all statements use IF NOT EXISTS guards.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS has_protection_plan  boolean NOT NULL DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS protection_plan_tier text;


-- ===========================================================================
-- 0071_pending_booking_docs_agreement_pdf_url.sql
-- ===========================================================================
-- Migration 0071: add agreement_pdf_url to pending_booking_docs
--                 and create rental-agreements Storage bucket.
--
-- Purpose: store the path to the generated rental-agreement PDF so that
-- recovery flows (admin-resend-booking, toolResendBookingConfirmation) can
-- retrieve and re-attach it without regenerating from scratch.
--
-- Safe to re-run: all statements use IF NOT EXISTS / DO $$ guards.

-- 1. Add agreement_pdf_url column (stores the Supabase Storage object path)
ALTER TABLE pending_booking_docs
  ADD COLUMN IF NOT EXISTS agreement_pdf_url text;

-- 2. Create a private rental-agreements storage bucket.
--    file_size_limit: 10 MB (PDFs are rarely > 1 MB, generous headroom)
--    public: false — PDFs must not be publicly accessible without auth.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'rental-agreements',
  'rental-agreements',
  false,
  10485760,
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- 3. Service-role only access (no public reads, no anonymous writes).
DROP POLICY IF EXISTS "rental-agreements: service write" ON storage.objects;
CREATE POLICY "rental-agreements: service write"
  ON storage.objects FOR ALL
  USING     (bucket_id = 'rental-agreements' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'rental-agreements' AND auth.role() = 'service_role');


-- ===========================================================================
-- 0072_revenue_reporting_base_net_amount.sql
-- ===========================================================================
-- Migration 0072: extend revenue_reporting_base with net_amount and customer fields
--
-- Problem: revenue_reporting_base (migration 0053) was created with an explicit
-- column list that omits:
--   • net_amount       — the canonical pre-computed net (gross − refund_amount),
--                        stored as a GENERATED ALWAYS column on revenue_records.
--                        Consumer code had to recompute gross_amount − refund_amount
--                        in JavaScript instead of reading it directly.
--   • customer_phone   — required by v2-customers sync to identify the renter.
--   • customer_name    — required by v2-customers sync for display name.
--   • customer_email   — required by v2-customers sync as the primary identity key.
--   • return_date      — required by v2-customers sync to compute rental days.
--   • type             — revenue record type (rental / extension / fee); useful for
--                        auditing that all revenue types are included in totals.
--
-- Fix: replace the view with an updated definition that adds these columns.
-- All existing consumers (v2-analytics.js, v2-dashboard.js, v2-revenue.js) query
-- only a subset of columns and are unaffected by the additions.
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW revenue_reporting_base AS
SELECT
  booking_id,
  vehicle_id,
  customer_name,
  customer_phone,
  customer_email,
  pickup_date,
  return_date,
  gross_amount,
  stripe_fee,
  stripe_net,
  refund_amount,
  net_amount,
  deposit_amount,
  type,
  is_cancelled,
  is_no_show
FROM   revenue_records_effective
WHERE  payment_status              = 'paid'
  AND  COALESCE(sync_excluded,  false) = false
  AND  COALESCE(is_orphan,      false) = false;


-- ===========================================================================
-- 0072_sms_logs.sql
-- ===========================================================================
-- Migration 0072: SMS logs table for extension-aware deduplication
--
-- Purpose:
-- Creates a sms_logs table that records every outbound SMS keyed by
-- (booking_id, template_key, return_date_at_send).  Using return_date_at_send
-- as part of the composite key means that when a rental is extended the old
-- "return-time" triggers (late_warning_30min, late_at_return, etc.) are no
-- longer suppressed for the new return date, preventing missed notifications.
--
-- For SMS not tied to a return date (pickup reminders, payment reminders, etc.)
-- return_date_at_send is stored as '1970-01-01' (a sentinel "not applicable"
-- value) which is excluded from the NULL quirks of unique constraints.

CREATE TABLE IF NOT EXISTS sms_logs (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           text          NOT NULL,   -- booking_ref from bookings table (bk-...)
  template_key         text          NOT NULL,   -- e.g. 'late_warning_30min', 'late_at_return'
  return_date_at_send  date          NOT NULL DEFAULT '1970-01-01', -- sentinel for non-return-time messages
  sent_at              timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT sms_logs_dedup UNIQUE (booking_id, template_key, return_date_at_send)
);

CREATE INDEX IF NOT EXISTS sms_logs_booking_id_idx    ON sms_logs (booking_id);
CREATE INDEX IF NOT EXISTS sms_logs_sent_at_idx       ON sms_logs (sent_at DESC);
CREATE INDEX IF NOT EXISTS sms_logs_template_key_idx  ON sms_logs (template_key);

COMMENT ON TABLE  sms_logs IS 'Outbound SMS audit log; (booking_id, template_key, return_date_at_send) is unique to prevent duplicate sends and handle rental extensions correctly.';
COMMENT ON COLUMN sms_logs.return_date_at_send IS 'The booking return_date in effect when the SMS was sent. 1970-01-01 = not applicable (non-return-time messages). Changing return_date via extension allows return-time triggers to fire again for the new date.';


-- ===========================================================================
-- 0073_bookings_extension_tracking.sql
-- ===========================================================================
-- Migration 0073: Extension tracking columns on bookings
--
-- Purpose:
-- Adds `last_extension_at` and `extension_count` columns to the bookings table
-- so extension history is durably recorded in Supabase (not just in bookings.json).
--
-- These values are written by stripe-webhook.js when a rental_extension payment
-- succeeds.  `last_extension_at` is used by the SMS engine to verify the booking
-- has been extended and to present up-to-date return dates.
--
-- `extension_count` mirrors the extensionCount field already tracked in
-- bookings.json; the default of 0 is correct for all historical rows.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_extension_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extension_count   integer NOT NULL DEFAULT 0;

-- Partial index for finding recently extended bookings efficiently.
CREATE INDEX IF NOT EXISTS bookings_last_extension_at_idx
  ON bookings (last_extension_at)
  WHERE last_extension_at IS NOT NULL;

COMMENT ON COLUMN bookings.last_extension_at IS 'Timestamp of the most recent paid extension. Updated by stripe-webhook on rental_extension payment success.';
COMMENT ON COLUMN bookings.extension_count   IS 'Total number of paid extensions applied to this booking. Mirrors extensionCount in bookings.json.';


-- ===========================================================================
-- 0074_sms_logs_metadata.sql
-- ===========================================================================
-- Migration 0074: Add metadata column to sms_logs
--
-- Purpose:
-- Adds a `metadata` jsonb column to the sms_logs table so the scheduler
-- and SMS handlers can store extra context alongside each logged message.
--
-- Primary use cases:
--   • Link validation: record {link, validated, status} so we know whether
--     the payment link in an SMS was reachable at send time and, if not,
--     which fallback URL was sent instead.
--   • Future: store rendered message length, delivery status, retry count, …
--
-- The column is nullable and has no schema enforcement so callers can evolve
-- what they store without needing further migrations.

ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS metadata jsonb;

COMMENT ON COLUMN sms_logs.metadata IS 'Optional structured context for the SMS (e.g. {link, validated, status, fallback_used}). Null for legacy rows.';


-- ===========================================================================
-- 0075_late_fee_approval_tracking.sql
-- ===========================================================================
-- Migration 0075: Late-fee approval tracking
--
-- Adds the columns needed to fully track late-fee approvals:
--
-- On bookings:
--   late_fee_status      text   — 'pending_approval' | 'approved' | 'dismissed' | 'failed'
--   late_fee_amount      numeric— assessed fee in USD (set when status is first written)
--   late_fee_approved_at timestamptz — when approve/dismiss was actioned
--   late_fee_approved_by text   — who actioned it ('admin_link' | 'admin_panel' | 'ai')
--
-- On charges (existing table, migration 0036):
--   approved_by text       — 'admin_link' | 'admin_panel' | 'ai'
--   approved_at timestamptz— when this specific charge was approved
--   adjusted_from_amount numeric — original assessed amount if admin adjusted it
--
-- Also widens the existing charges.charged_by CHECK constraint to allow
-- 'admin_link' (the new one-click approval flow value).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS late_fee_status      text
    CHECK (late_fee_status IN ('pending_approval','approved','dismissed','failed')),
  ADD COLUMN IF NOT EXISTS late_fee_amount      numeric(10,2),
  ADD COLUMN IF NOT EXISTS late_fee_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_fee_approved_by text;

ALTER TABLE charges
  ADD COLUMN IF NOT EXISTS approved_by           text,
  ADD COLUMN IF NOT EXISTS approved_at           timestamptz,
  ADD COLUMN IF NOT EXISTS adjusted_from_amount  numeric(10,2);

-- Widen charged_by constraint to include 'admin_link'
-- Drop the old constraint (it was created inline in migration 0036 so may have
-- a generated name — find and drop it, then re-add with the expanded list).
DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'charges'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%charged_by%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE charges DROP CONSTRAINT %I', v_con);
  END IF;
END $$;

ALTER TABLE charges
  ADD CONSTRAINT charges_charged_by_check
  CHECK (charged_by IN ('admin', 'ai', 'admin_link'));

CREATE INDEX IF NOT EXISTS bookings_late_fee_status_idx
  ON bookings (late_fee_status)
  WHERE late_fee_status IS NOT NULL;

COMMENT ON COLUMN bookings.late_fee_status IS
  'Tracks where the late-fee approval stands: pending_approval → approved/dismissed/failed.';
COMMENT ON COLUMN bookings.late_fee_amount IS
  'Assessed late-fee amount in USD, set when late_fee_status is first written.';
COMMENT ON COLUMN bookings.late_fee_approved_at IS
  'Timestamp when admin approved or dismissed the late fee.';
COMMENT ON COLUMN bookings.late_fee_approved_by IS
  'Who actioned the approval: admin_link | admin_panel | ai.';

COMMENT ON COLUMN charges.approved_by IS
  'Who approved this charge: admin_link | admin_panel | ai.';
COMMENT ON COLUMN charges.approved_at IS
  'Timestamp when this charge was approved/executed.';
COMMENT ON COLUMN charges.adjusted_from_amount IS
  'If the admin adjusted the fee before charging, the original assessed amount is stored here.';


-- ===========================================================================
-- 0076_late_fee_status_paid.sql
-- ===========================================================================
-- Migration 0076: Add 'paid' to late_fee_status CHECK constraint
--
-- After a successful charge, late_fee_status is written as 'paid' to indicate
-- that the late fee has been fully settled.  This distinguishes "charge was
-- attempted and approved" (approved) from "charge succeeded and is complete"
-- (paid), and is used as a hard idempotency guard so no further charge can be
-- issued once the booking is in the paid state.
--
-- Existing values: pending_approval | approved | dismissed | failed
-- New value added: paid

-- Drop the existing CHECK constraint and re-add with the extended list.
DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'bookings'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%late_fee_status%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', v_con);
  END IF;
END $$;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_late_fee_status_check
  CHECK (late_fee_status IN ('pending_approval','approved','dismissed','failed','paid'));

COMMENT ON COLUMN bookings.late_fee_status IS
  'Late-fee approval state: pending_approval → approved/dismissed/failed/paid. '
  'paid = charge succeeded and settled; no further charge may be issued.';


-- ===========================================================================
-- 0077_sms_logs_high_mileage_dedup.sql
-- ===========================================================================
-- Migration 0077: Relax sms_logs uniqueness for HIGH_DAILY_MILEAGE alerts
--
-- Background:
--   The original sms_logs_dedup constraint is UNIQUE(booking_id, template_key,
--   return_date_at_send).  For return-time SMS this works perfectly: each message
--   fires exactly once per return date, and extending a booking allows the new
--   return-date messages to fire again.
--
--   The HIGH_DAILY_MILEAGE owner alert is NOT tied to a return date.  The previous
--   implementation worked around the constraint by storing fake sentinel dates
--   ('1970-01-01', '1970-01-02').  This migration removes that hack by converting
--   the constraint into a partial unique index that excludes HIGH_DAILY_MILEAGE rows,
--   so those rows can store the real calendar date when each alert was sent.
--
-- Effect on existing behaviour:
--   • All other template keys retain the same UNIQUE(booking_id, template_key,
--     return_date_at_send) guarantee — no functional change.
--   • HIGH_DAILY_MILEAGE rows are no longer subject to the unique constraint;
--     the max-2 cap and 60-minute cooldown are enforced in application code
--     (api/maintenance-alerts.js :: checkHighMileageQuota).

-- 1. Drop the old table-level constraint
ALTER TABLE sms_logs DROP CONSTRAINT IF EXISTS sms_logs_dedup;

-- 2. Re-add deduplication as a partial unique index covering every template key
--    except HIGH_DAILY_MILEAGE.  Rows for that key can now coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS sms_logs_dedup_idx
  ON sms_logs (booking_id, template_key, return_date_at_send)
  WHERE template_key <> 'HIGH_DAILY_MILEAGE';

COMMENT ON INDEX sms_logs_dedup_idx IS
  'Prevents duplicate sends for all template keys except HIGH_DAILY_MILEAGE, '
  'which enforces its own cap (MAX 2) and 60-minute cooldown in application code.';


-- ===========================================================================
-- 0078_admin_metrics_v2.sql
-- ===========================================================================
-- Migration 0078: add admin_metrics_v2 view
--
-- Purpose: Provide a single-row pre-aggregated view of all admin dashboard KPIs
-- so v2-dashboard.js can replace its sequential revenue_records + charges loops
-- with a single parallel query alongside the bookings fetch.
--
-- Design:
--   • Every metric is returned in three scope variants using column prefixes:
--       total_*     — all vehicles combined
--       car_*       — vehicles with vehicle_type != 'vehicle'
--       vehicle_* — vehicles with vehicle_type  = 'vehicle'
--   • Supplemental charges (not already in revenue_records) are included via
--     the charges_net CTE to avoid double-counting.
--   • Booking counts use (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')
--     for timezone-correct "today" comparisons.
--   • vehicle_revenue_json — per-vehicle {gross, net, count} for vehicleStats.
--   • {scope}_revenue_chart — last-12-months JSONB array for the revenue chart.
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW admin_metrics_v2 AS
WITH
  -- ── Vehicle type lookup (vehicle vs car) ──────────────────────────────────
  vt AS (
    SELECT vehicle_id, COALESCE(vehicle_type, '') AS vehicle_type
    FROM   vehicles
  ),

  -- ── Revenue records joined with vehicle type ────────────────────────────────
  rev AS (
    SELECT r.*, COALESCE(vt.vehicle_type, '') AS vehicle_type
    FROM   revenue_reporting_base r
    LEFT JOIN vt ON vt.vehicle_id = r.vehicle_id
  ),

  -- ── Supplemental charges not yet reflected in revenue_records ───────────────
  -- Excludes charges whose Stripe PI is already present in revenue_records to
  -- prevent double-counting (mirrors the JS dedup logic in v2-dashboard.js).
  charges_net AS (
    SELECT
      c.booking_id,
      c.amount,
      c.created_at::date            AS charge_date,
      b.vehicle_id,
      COALESCE(v.vehicle_type, '')  AS vehicle_type
    FROM   charges c
    JOIN   bookings b ON b.booking_ref = c.booking_id
    LEFT JOIN vt v    ON v.vehicle_id  = b.vehicle_id
    WHERE  c.status = 'succeeded'
      AND (
        c.stripe_payment_intent_id IS NULL
        OR c.stripe_payment_intent_id NOT IN (
          SELECT payment_intent_id
          FROM   revenue_records
          WHERE  payment_intent_id IS NOT NULL
        )
      )
  ),

  -- ── Combined revenue: revenue_records + supplemental charges ────────────────
  fin_all AS (
    SELECT
      vehicle_type,
      gross_amount,
      stripe_fee,
      stripe_net,
      refund_amount,
      COALESCE(is_cancelled, false) AS is_cancelled,
      COALESCE(is_no_show,   false) AS is_no_show,
      TRUE                          AS from_rr
    FROM rev
    UNION ALL
    SELECT
      vehicle_type,
      amount AS gross_amount,
      NULL,
      NULL,
      NULL,
      FALSE,
      FALSE,
      FALSE
    FROM charges_net
  ),

  -- ── Financial aggregates (scope-aware) ──────────────────────────────────────
  fin AS (
    SELECT
      -- Total (all vehicles)
      COALESCE(SUM(CASE WHEN NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)
                                                                        AS total_revenue,
      COALESCE(SUM(CASE WHEN from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)
                                                                        AS total_stripe_fees,
      COALESCE(SUM(CASE WHEN NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN COALESCE(stripe_net, gross_amount - COALESCE(stripe_fee, 0))
                    - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                 AS total_net_revenue,
      COUNT(*) FILTER (
        WHERE from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                      AS total_reconciled_count,

      -- Car (vehicle_type != 'vehicle')
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)                               AS car_revenue,
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)                   AS car_stripe_fees,
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN COALESCE(stripe_net, gross_amount - COALESCE(stripe_fee, 0))
                    - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                 AS car_net_revenue,
      COUNT(*) FILTER (
        WHERE vehicle_type != 'vehicle' AND from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                      AS car_reconciled_count,

      -- Vehicle (vehicle_type = 'vehicle')
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)                               AS vehicle_revenue,
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)                   AS vehicle_stripe_fees,
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN COALESCE(stripe_net, gross_amount - COALESCE(stripe_fee, 0))
                    - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                 AS vehicle_net_revenue,
      COUNT(*) FILTER (
        WHERE vehicle_type = 'vehicle' AND from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                      AS vehicle_reconciled_count
    FROM fin_all
  ),

  -- ── Expense aggregates (scope-aware) ────────────────────────────────────────
  exp AS (
    SELECT
      COALESCE(SUM(e.amount), 0)                                        AS total_expenses,
      COALESCE(SUM(CASE WHEN COALESCE(vt.vehicle_type, '') != 'vehicle'
        THEN e.amount ELSE 0 END), 0)                                   AS car_expenses,
      COALESCE(SUM(CASE WHEN vt.vehicle_type = 'vehicle'
        THEN e.amount ELSE 0 END), 0)                                   AS vehicle_expenses
    FROM   expenses e
    LEFT JOIN vt ON vt.vehicle_id = e.vehicle_id
  ),

  -- ── Booking status counts (scope-aware, timezone-aware) ─────────────────────
  bk AS (
    SELECT
      -- Total
      COUNT(*) FILTER (WHERE b.status IN ('active', 'overdue'))
                                                                        AS total_active_rentals,
      COUNT(*) FILTER (
        WHERE b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS total_pending_approvals,
      COUNT(*) FILTER (WHERE b.status = 'overdue')                      AS total_overdue_count,
      COUNT(*) FILTER (
        WHERE b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'overdue'))                        AS total_returns_today,
      COUNT(*) FILTER (
        WHERE b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS total_pickups_today,
      -- Car
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status IN ('active', 'overdue'))                        AS car_active_rentals,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS car_pending_approvals,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status = 'overdue')                                     AS car_overdue_count,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'overdue'))                        AS car_returns_today,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS car_pickups_today,
      -- Vehicle
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status IN ('active', 'overdue'))                        AS vehicle_active_rentals,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS vehicle_pending_approvals,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status = 'overdue')                                     AS vehicle_overdue_count,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'overdue'))                        AS vehicle_returns_today,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS vehicle_pickups_today
    FROM   bookings b
    LEFT JOIN vt ON vt.vehicle_id = b.vehicle_id
    WHERE  b.status NOT IN ('completed')
  ),

  -- ── Available vehicles (scope-aware) ────────────────────────────────────────
  avail AS (
    SELECT
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'overdue')
          ))                                                            AS total_available_vehicles,
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND COALESCE(v.vehicle_type, '') != 'vehicle'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'overdue')
          ))                                                            AS car_available_vehicles,
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND v.vehicle_type = 'vehicle'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'overdue')
          ))                                                            AS vehicle_available_vehicles
    FROM vehicles v
  ),

  -- ── Per-vehicle revenue (revenue_records + charges) for vehicleStats ────────
  veh_rev AS (
    SELECT vehicle_id, SUM(gross) AS gross, SUM(net) AS net, SUM(cnt) AS cnt
    FROM (
      SELECT
        r.vehicle_id,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                               AS gross,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN COALESCE(r.stripe_net, r.gross_amount - COALESCE(r.stripe_fee, 0))
               - COALESCE(r.refund_amount, 0)
          ELSE 0 END)                                                   AS net,
        COUNT(*) FILTER (
          WHERE NOT COALESCE(r.is_cancelled, false)
            AND NOT COALESCE(r.is_no_show, false))                      AS cnt
      FROM revenue_reporting_base r
      GROUP BY r.vehicle_id
      UNION ALL
      SELECT vehicle_id, SUM(amount) AS gross, SUM(amount) AS net, 0 AS cnt
      FROM   charges_net
      GROUP BY vehicle_id
    ) combined
    GROUP BY vehicle_id
  ),

  -- ── Monthly revenue data for the chart (last 12 months) ─────────────────────
  monthly AS (
    SELECT mo, SUM(total_amt) AS total_amt, SUM(car_amt) AS car_amt, SUM(vehicle_amt) AS vehicle_amt
    FROM (
      -- From revenue_records
      SELECT
        LEFT(r.pickup_date::text, 7) AS mo,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                               AS total_amt,
        SUM(CASE WHEN r.vehicle_type != 'vehicle'
                  AND NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                               AS car_amt,
        SUM(CASE WHEN r.vehicle_type = 'vehicle'
                  AND NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                               AS vehicle_amt
      FROM rev r
      WHERE r.pickup_date IS NOT NULL
      GROUP BY LEFT(r.pickup_date::text, 7)
      UNION ALL
      -- From supplemental charges
      SELECT
        LEFT(c.charge_date::text, 7) AS mo,
        SUM(c.amount)                                                   AS total_amt,
        SUM(CASE WHEN c.vehicle_type != 'vehicle' THEN c.amount ELSE 0 END) AS car_amt,
        SUM(CASE WHEN c.vehicle_type  = 'vehicle' THEN c.amount ELSE 0 END) AS vehicle_amt
      FROM charges_net c
      GROUP BY LEFT(c.charge_date::text, 7)
    ) combined
    GROUP BY mo
  )

SELECT
  -- ── Financial KPIs — Total ────────────────────────────────────────────────
  f.total_revenue,
  f.total_stripe_fees,
  f.total_net_revenue,
  f.total_reconciled_count,
  e.total_expenses,
  (f.total_net_revenue - e.total_expenses)::numeric                     AS total_net_profit,
  CASE WHEN e.total_expenses > 0
    THEN ROUND(((f.total_net_revenue - e.total_expenses)
                / e.total_expenses * 100)::numeric, 2)
    ELSE NULL END                                                        AS total_operational_roi,

  -- ── Financial KPIs — Car ─────────────────────────────────────────────────
  f.car_revenue,
  f.car_stripe_fees,
  f.car_net_revenue,
  f.car_reconciled_count,
  e.car_expenses,
  (f.car_net_revenue - e.car_expenses)::numeric                         AS car_net_profit,
  CASE WHEN e.car_expenses > 0
    THEN ROUND(((f.car_net_revenue - e.car_expenses)
                / e.car_expenses * 100)::numeric, 2)
    ELSE NULL END                                                        AS car_operational_roi,

  -- ── Financial KPIs — Vehicle ───────────────────────────────────────────
  f.vehicle_revenue,
  f.vehicle_stripe_fees,
  f.vehicle_net_revenue,
  f.vehicle_reconciled_count,
  e.vehicle_expenses,
  (f.vehicle_net_revenue - e.vehicle_expenses)::numeric             AS vehicle_net_profit,
  CASE WHEN e.vehicle_expenses > 0
    THEN ROUND(((f.vehicle_net_revenue - e.vehicle_expenses)
                / e.vehicle_expenses * 100)::numeric, 2)
    ELSE NULL END                                                        AS vehicle_operational_roi,

  -- ── Booking counts — Total ───────────────────────────────────────────────
  bk.total_active_rentals,
  bk.total_pending_approvals,
  bk.total_overdue_count,
  bk.total_returns_today,
  bk.total_pickups_today,

  -- ── Booking counts — Car ─────────────────────────────────────────────────
  bk.car_active_rentals,
  bk.car_pending_approvals,
  bk.car_overdue_count,
  bk.car_returns_today,
  bk.car_pickups_today,

  -- ── Booking counts — Vehicle ───────────────────────────────────────────
  bk.vehicle_active_rentals,
  bk.vehicle_pending_approvals,
  bk.vehicle_overdue_count,
  bk.vehicle_returns_today,
  bk.vehicle_pickups_today,

  -- ── Available vehicles ───────────────────────────────────────────────────
  av.total_available_vehicles,
  av.car_available_vehicles,
  av.vehicle_available_vehicles,

  -- ── Per-vehicle revenue JSONB (keyed by vehicle_id) ─────────────────────
  -- Used by v2-dashboard.js to populate rrByVehicle for vehicleStats computation.
  (
    SELECT COALESCE(
      json_object_agg(
        vehicle_id,
        json_build_object(
          'gross', ROUND(COALESCE(gross, 0)::numeric, 2),
          'net',   ROUND(COALESCE(net,   0)::numeric, 2),
          'count', COALESCE(cnt, 0)
        )
      ),
      '{}'::json
    )
    FROM veh_rev
  )                                                                      AS vehicle_revenue_json,

  -- ── Monthly revenue charts (last 12 months, chronological order) ────────
  -- Inner subquery takes the 12 most-recent months; json_agg re-sorts them ASC.
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(total_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, total_amt FROM monthly
      WHERE  total_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                      AS total_revenue_chart,
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(car_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, car_amt FROM monthly
      WHERE  car_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                      AS car_revenue_chart,
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(vehicle_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, vehicle_amt FROM monthly
      WHERE  vehicle_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                      AS vehicle_revenue_chart

FROM fin f, exp e, bk, avail av;


-- ===========================================================================
-- 0079_fix_admin_metrics_active_rental_status.sql
-- ===========================================================================
-- Migration 0079: fix admin_metrics_v2 to recognise 'active_rental' booking status
--
-- Root cause: migration 0064_standardize_active_rental_status.sql rewrote every
-- bookings row that had status='active' to status='active_rental'.  Migration 0078
-- (admin_metrics_v2) was written before that change was applied and therefore only
-- checks for status IN ('active', 'overdue').  After 0064 runs on a database, no
-- booking can ever match 'active' again, which causes:
--
--   • *_active_rentals  → always 0   (view misses all active bookings)
--   • *_returns_today   → always 0
--   • available_vehicles count wrong (NOT IN subquery uses same bad filter)
--
-- Fix: add 'active_rental' wherever 'active' is checked in the booking-status
-- filters.  The original 'active' value is kept so the view still works on
-- databases where 0064 has not yet been applied (safe to run in either order).
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW admin_metrics_v2 AS
WITH
  -- ── Vehicle type lookup (vehicle vs car) ──────────────────────────────────
  vt AS (
    SELECT vehicle_id, COALESCE(vehicle_type, '') AS vehicle_type
    FROM   vehicles
  ),

  -- ── Revenue records joined with vehicle type ────────────────────────────────
  rev AS (
    SELECT r.*, COALESCE(vt.vehicle_type, '') AS vehicle_type
    FROM   revenue_reporting_base r
    LEFT JOIN vt ON vt.vehicle_id = r.vehicle_id
  ),

  -- ── Supplemental charges not yet reflected in revenue_records ───────────────
  -- Excludes charges whose Stripe PI is already present in revenue_records to
  -- prevent double-counting (mirrors the JS dedup logic in v2-dashboard.js).
  charges_net AS (
    SELECT
      c.booking_id,
      c.amount,
      c.created_at::date            AS charge_date,
      b.vehicle_id,
      COALESCE(v.vehicle_type, '')  AS vehicle_type
    FROM   charges c
    JOIN   bookings b ON b.booking_ref = c.booking_id
    LEFT JOIN vt v    ON v.vehicle_id  = b.vehicle_id
    WHERE  c.status = 'succeeded'
      AND (
        c.stripe_payment_intent_id IS NULL
        OR c.stripe_payment_intent_id NOT IN (
          SELECT payment_intent_id
          FROM   revenue_records
          WHERE  payment_intent_id IS NOT NULL
        )
      )
  ),

  -- ── Combined revenue: revenue_records + supplemental charges ────────────────
  fin_all AS (
    SELECT
      vehicle_type,
      gross_amount,
      stripe_fee,
      stripe_net,
      refund_amount,
      COALESCE(is_cancelled, false) AS is_cancelled,
      COALESCE(is_no_show,   false) AS is_no_show,
      TRUE                          AS from_rr
    FROM rev
    UNION ALL
    SELECT
      vehicle_type,
      amount AS gross_amount,
      NULL,
      NULL,
      NULL,
      FALSE,
      FALSE,
      FALSE
    FROM charges_net
  ),

  -- ── Financial aggregates (scope-aware) ──────────────────────────────────────
  fin AS (
    SELECT
      -- Total (all vehicles)
      COALESCE(SUM(CASE WHEN NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)
                                                                        AS total_revenue,
      COALESCE(SUM(CASE WHEN from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)
                                                                        AS total_stripe_fees,
      COALESCE(SUM(CASE WHEN NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN COALESCE(stripe_net, gross_amount - COALESCE(stripe_fee, 0))
                    - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                AS total_net_revenue,
      COUNT(*) FILTER (
        WHERE from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                     AS total_reconciled_count,

      -- Car (vehicle_type != 'vehicle')
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)                              AS car_revenue,
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)                  AS car_stripe_fees,
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN COALESCE(stripe_net, gross_amount - COALESCE(stripe_fee, 0))
                    - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                AS car_net_revenue,
      COUNT(*) FILTER (
        WHERE vehicle_type != 'vehicle' AND from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                     AS car_reconciled_count,

      -- Vehicle (vehicle_type = 'vehicle')
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)                              AS vehicle_revenue,
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)                  AS vehicle_stripe_fees,
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN COALESCE(stripe_net, gross_amount - COALESCE(stripe_fee, 0))
                    - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                AS vehicle_net_revenue,
      COUNT(*) FILTER (
        WHERE vehicle_type = 'vehicle' AND from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                     AS vehicle_reconciled_count
    FROM fin_all
  ),

  -- ── Expense aggregates (scope-aware) ────────────────────────────────────────
  exp AS (
    SELECT
      COALESCE(SUM(e.amount), 0)                                       AS total_expenses,
      COALESCE(SUM(CASE WHEN COALESCE(vt.vehicle_type, '') != 'vehicle'
        THEN e.amount ELSE 0 END), 0)                                  AS car_expenses,
      COALESCE(SUM(CASE WHEN vt.vehicle_type = 'vehicle'
        THEN e.amount ELSE 0 END), 0)                                  AS vehicle_expenses
    FROM   expenses e
    LEFT JOIN vt ON vt.vehicle_id = e.vehicle_id
  ),

  -- ── Booking status counts (scope-aware, timezone-aware) ─────────────────────
  -- IMPORTANT: 'active_rental' is the canonical active-booking status after
  -- migration 0064.  The legacy value 'active' is kept alongside it so this
  -- view works correctly on databases where 0064 has not yet been applied.
  bk AS (
    SELECT
      -- Total
      COUNT(*) FILTER (WHERE b.status IN ('active', 'active_rental', 'overdue'))
                                                                        AS total_active_rentals,
      COUNT(*) FILTER (
        WHERE b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS total_pending_approvals,
      COUNT(*) FILTER (WHERE b.status = 'overdue')                     AS total_overdue_count,
      COUNT(*) FILTER (
        WHERE b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'active_rental', 'overdue'))      AS total_returns_today,
      COUNT(*) FILTER (
        WHERE b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification',
                           'approved', 'booked_paid'))                 AS total_pickups_today,
      -- Car
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status IN ('active', 'active_rental', 'overdue'))      AS car_active_rentals,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS car_pending_approvals,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status = 'overdue')                                    AS car_overdue_count,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'active_rental', 'overdue'))      AS car_returns_today,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification',
                           'approved', 'booked_paid'))                 AS car_pickups_today,
      -- Vehicle
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status IN ('active', 'active_rental', 'overdue'))      AS vehicle_active_rentals,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS vehicle_pending_approvals,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status = 'overdue')                                     AS vehicle_overdue_count,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'active_rental', 'overdue'))      AS vehicle_returns_today,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification',
                           'approved', 'booked_paid'))                 AS vehicle_pickups_today
    FROM   bookings b
    LEFT JOIN vt ON vt.vehicle_id = b.vehicle_id
    WHERE  b.status NOT IN ('completed', 'completed_rental', 'cancelled', 'cancelled_rental')
  ),

  -- ── Available vehicles (scope-aware) ────────────────────────────────────────
  avail AS (
    SELECT
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'active_rental', 'overdue')
          ))                                                           AS total_available_vehicles,
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND COALESCE(v.vehicle_type, '') != 'vehicle'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'active_rental', 'overdue')
          ))                                                           AS car_available_vehicles,
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND v.vehicle_type = 'vehicle'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'active_rental', 'overdue')
          ))                                                           AS vehicle_available_vehicles
    FROM vehicles v
  ),

  -- ── Per-vehicle revenue (revenue_records + charges) for vehicleStats ────────
  veh_rev AS (
    SELECT vehicle_id, SUM(gross) AS gross, SUM(net) AS net, SUM(cnt) AS cnt
    FROM (
      SELECT
        r.vehicle_id,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                              AS gross,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN COALESCE(r.stripe_net, r.gross_amount - COALESCE(r.stripe_fee, 0))
               - COALESCE(r.refund_amount, 0)
          ELSE 0 END)                                                  AS net,
        COUNT(*) FILTER (
          WHERE NOT COALESCE(r.is_cancelled, false)
            AND NOT COALESCE(r.is_no_show, false))                    AS cnt
      FROM revenue_reporting_base r
      GROUP BY r.vehicle_id
      UNION ALL
      SELECT vehicle_id, SUM(amount) AS gross, SUM(amount) AS net, 0 AS cnt
      FROM   charges_net
      GROUP BY vehicle_id
    ) combined
    GROUP BY vehicle_id
  ),

  -- ── Monthly revenue data for the chart (last 12 months) ─────────────────────
  monthly AS (
    SELECT mo, SUM(total_amt) AS total_amt, SUM(car_amt) AS car_amt, SUM(vehicle_amt) AS vehicle_amt
    FROM (
      -- From revenue_records
      SELECT
        LEFT(r.pickup_date::text, 7) AS mo,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                              AS total_amt,
        SUM(CASE WHEN r.vehicle_type != 'vehicle'
                  AND NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                              AS car_amt,
        SUM(CASE WHEN r.vehicle_type = 'vehicle'
                  AND NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                              AS vehicle_amt
      FROM rev r
      WHERE r.pickup_date IS NOT NULL
      GROUP BY LEFT(r.pickup_date::text, 7)
      UNION ALL
      -- From supplemental charges
      SELECT
        LEFT(c.charge_date::text, 7) AS mo,
        SUM(c.amount)                                                  AS total_amt,
        SUM(CASE WHEN c.vehicle_type != 'vehicle' THEN c.amount ELSE 0 END) AS car_amt,
        SUM(CASE WHEN c.vehicle_type  = 'vehicle' THEN c.amount ELSE 0 END) AS vehicle_amt
      FROM charges_net c
      GROUP BY LEFT(c.charge_date::text, 7)
    ) combined
    GROUP BY mo
  )

SELECT
  -- ── Financial KPIs — Total ────────────────────────────────────────────────
  f.total_revenue,
  f.total_stripe_fees,
  f.total_net_revenue,
  f.total_reconciled_count,
  e.total_expenses,
  (f.total_net_revenue - e.total_expenses)::numeric                    AS total_net_profit,
  CASE WHEN e.total_expenses > 0
    THEN ROUND(((f.total_net_revenue - e.total_expenses)
                / e.total_expenses * 100)::numeric, 2)
    ELSE NULL END                                                       AS total_operational_roi,

  -- ── Financial KPIs — Car ─────────────────────────────────────────────────
  f.car_revenue,
  f.car_stripe_fees,
  f.car_net_revenue,
  f.car_reconciled_count,
  e.car_expenses,
  (f.car_net_revenue - e.car_expenses)::numeric                        AS car_net_profit,
  CASE WHEN e.car_expenses > 0
    THEN ROUND(((f.car_net_revenue - e.car_expenses)
                / e.car_expenses * 100)::numeric, 2)
    ELSE NULL END                                                       AS car_operational_roi,

  -- ── Financial KPIs — Vehicle ───────────────────────────────────────────
  f.vehicle_revenue,
  f.vehicle_stripe_fees,
  f.vehicle_net_revenue,
  f.vehicle_reconciled_count,
  e.vehicle_expenses,
  (f.vehicle_net_revenue - e.vehicle_expenses)::numeric            AS vehicle_net_profit,
  CASE WHEN e.vehicle_expenses > 0
    THEN ROUND(((f.vehicle_net_revenue - e.vehicle_expenses)
                / e.vehicle_expenses * 100)::numeric, 2)
    ELSE NULL END                                                       AS vehicle_operational_roi,

  -- ── Booking counts — Total ───────────────────────────────────────────────
  bk.total_active_rentals,
  bk.total_pending_approvals,
  bk.total_overdue_count,
  bk.total_returns_today,
  bk.total_pickups_today,

  -- ── Booking counts — Car ─────────────────────────────────────────────────
  bk.car_active_rentals,
  bk.car_pending_approvals,
  bk.car_overdue_count,
  bk.car_returns_today,
  bk.car_pickups_today,

  -- ── Booking counts — Vehicle ───────────────────────────────────────────
  bk.vehicle_active_rentals,
  bk.vehicle_pending_approvals,
  bk.vehicle_overdue_count,
  bk.vehicle_returns_today,
  bk.vehicle_pickups_today,

  -- ── Available vehicles ───────────────────────────────────────────────────
  av.total_available_vehicles,
  av.car_available_vehicles,
  av.vehicle_available_vehicles,

  -- ── Per-vehicle revenue JSONB (keyed by vehicle_id) ─────────────────────
  -- Used by v2-dashboard.js to populate rrByVehicle for vehicleStats computation.
  (
    SELECT COALESCE(
      json_object_agg(
        vehicle_id,
        json_build_object(
          'gross', ROUND(COALESCE(gross, 0)::numeric, 2),
          'net',   ROUND(COALESCE(net,   0)::numeric, 2),
          'count', COALESCE(cnt, 0)
        )
      ),
      '{}'::json
    )
    FROM veh_rev
  )                                                                     AS vehicle_revenue_json,

  -- ── Monthly revenue charts (last 12 months, chronological order) ────────
  -- Inner subquery takes the 12 most-recent months; json_agg re-sorts them ASC.
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(total_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, total_amt FROM monthly
      WHERE  total_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                     AS total_revenue_chart,
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(car_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, car_amt FROM monthly
      WHERE  car_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                     AS car_revenue_chart,
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(vehicle_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, vehicle_amt FROM monthly
      WHERE  vehicle_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                     AS vehicle_revenue_chart

FROM fin f, exp e, bk, avail av;


-- ===========================================================================
-- 0079_oil_check_compliance.sql
-- ===========================================================================
-- =============================================================================
-- Migration 0079: Oil Check Compliance System
-- =============================================================================
--
-- Adds oil check tracking columns to the bookings table and creates a new
-- vehicle_state table that persists per-vehicle oil check state across
-- multiple renters.
--
-- Safe to re-run: all statements are guarded with IF NOT EXISTS or
-- ADD COLUMN IF NOT EXISTS.
-- =============================================================================


-- ── Bookings: oil check tracking columns ─────────────────────────────────────

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS last_oil_check_at       timestamptz,
  ADD COLUMN IF NOT EXISTS oil_status              text,
  ADD COLUMN IF NOT EXISTS oil_check_required      boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS oil_check_last_request  timestamptz,
  ADD COLUMN IF NOT EXISTS oil_check_missed_count  integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS oil_check_photo_url     text;

DO $$ BEGIN
  ALTER TABLE bookings
    ADD CONSTRAINT bookings_oil_status_check
    CHECK (oil_status IN ('full', 'mid', 'low'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── vehicle_state table ───────────────────────────────────────────────────────
-- One row per vehicle.  Tracks oil check state across renters so history is
-- preserved even when a new booking starts on the same vehicle.

CREATE TABLE IF NOT EXISTS vehicle_state (
  vehicle_id              text        PRIMARY KEY REFERENCES vehicles(vehicle_id) ON DELETE CASCADE,
  last_oil_check_at       timestamptz,
  last_oil_status         text,
  last_oil_check_photo_url text,
  last_oil_check_mileage  numeric(10,2),
  current_mileage         numeric(10,2),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE vehicle_state
    ADD CONSTRAINT vehicle_state_oil_status_check
    CHECK (last_oil_status IN ('full', 'mid', 'low'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed a row for every existing vehicle so vehicle_state always has coverage.
INSERT INTO vehicle_state (vehicle_id)
SELECT vehicle_id FROM vehicles
ON CONFLICT (vehicle_id) DO NOTHING;

-- Keep updated_at current on every write.
CREATE OR REPLACE FUNCTION vehicle_state_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vehicle_state_updated_at ON vehicle_state;
CREATE TRIGGER vehicle_state_updated_at
  BEFORE UPDATE ON vehicle_state
  FOR EACH ROW EXECUTE FUNCTION vehicle_state_set_updated_at();


-- ===========================================================================
-- 0080_booking_extensions_table.sql
-- ===========================================================================
-- Migration 0080: dedicated booking_extensions table
--
-- Creates a normalised booking_extensions table so every paid rental extension
-- is tracked as a first-class row rather than a denormalised counter on the
-- bookings row.  Each row carries the Stripe PaymentIntent ID (for deduplication),
-- the extension charge, the new return date, and the return time.
--
-- Return time: extensions do not include a time picker, so new_return_time is
-- always copied from the parent booking's return_time at the moment payment is
-- confirmed.  This keeps the renter on their original daily schedule.
--
-- Replaces manual writes of bookings.extension_count / bookings.last_extension_at
-- with an auto-maintained Postgres trigger that derives those values by aggregating
-- over booking_extensions rows (COUNT / MAX).
--
-- Historical extensions are backfilled from revenue_records where type='extension',
-- with new_return_time sourced from the parent bookings row.
--
-- Safe to re-run: all DDL statements use IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT.

-- ── 1. Create booking_extensions table ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS booking_extensions (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        text          NOT NULL REFERENCES bookings(booking_ref) ON DELETE CASCADE,
  payment_intent_id text          UNIQUE,
  amount            numeric(10,2) NOT NULL DEFAULT 0,
  new_return_date   date          NOT NULL,
  new_return_time   time,
  created_at        timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE  booking_extensions
  IS 'Each row represents one paid rental extension. Linked to bookings via booking_id (= bookings.booking_ref).';
COMMENT ON COLUMN booking_extensions.booking_id
  IS 'booking_ref of the parent booking row (bookings.booking_ref).';
COMMENT ON COLUMN booking_extensions.payment_intent_id
  IS 'Stripe PaymentIntent ID for this extension. UNIQUE; used for idempotent upserts.';
COMMENT ON COLUMN booking_extensions.amount
  IS 'Extension charge in USD.';
COMMENT ON COLUMN booking_extensions.new_return_date
  IS 'The new return date applied by this extension.';
COMMENT ON COLUMN booking_extensions.new_return_time
  IS 'Return time for the extended booking. Copied from the parent booking (no time picker in the extend flow).';

-- ── 2. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS booking_extensions_booking_id_idx
  ON booking_extensions (booking_id);

CREATE INDEX IF NOT EXISTS booking_extensions_created_at_idx
  ON booking_extensions (created_at DESC);

-- ── 3. Trigger: auto-maintain bookings.extension_count / last_extension_at ───
--
-- Fires after every INSERT, UPDATE, or DELETE on booking_extensions and
-- recomputes the two summary columns on the parent bookings row so they
-- are always consistent with the actual extension rows.

CREATE OR REPLACE FUNCTION public.sync_booking_extension_stats()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_booking_id text;
BEGIN
  v_booking_id := COALESCE(NEW.booking_id, OLD.booking_id);

  UPDATE bookings
  SET
    extension_count   = (SELECT COUNT(*)       FROM booking_extensions WHERE booking_id = v_booking_id),
    last_extension_at = (SELECT MAX(created_at) FROM booking_extensions WHERE booking_id = v_booking_id),
    updated_at        = now()
  WHERE booking_ref = v_booking_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS booking_extensions_sync_stats ON booking_extensions;

CREATE TRIGGER booking_extensions_sync_stats
  AFTER INSERT OR UPDATE OR DELETE ON booking_extensions
  FOR EACH ROW EXECUTE FUNCTION public.sync_booking_extension_stats();

-- ── 4. Backfill from revenue_records ─────────────────────────────────────────
--
-- 4a. Stripe-paid extensions: booking_id = bookings.booking_ref (direct link).
--     new_return_time is sourced from the parent booking's return_time since
--     the extend flow has no time picker.

INSERT INTO booking_extensions (booking_id, payment_intent_id, amount, new_return_date, new_return_time, created_at)
SELECT
  rr.booking_id,
  rr.payment_intent_id,
  COALESCE(rr.gross_amount, 0),
  rr.return_date,
  b.return_time,
  COALESCE(rr.created_at, now())
FROM revenue_records rr
JOIN bookings b ON b.booking_ref = rr.booking_id
WHERE rr.type           = 'extension'
  AND rr.payment_status = 'paid'
  AND rr.is_cancelled   = false
  AND rr.booking_id     IS NOT NULL
  AND rr.return_date    IS NOT NULL
ON CONFLICT (payment_intent_id) DO NOTHING;

-- 4b. Manually-created extensions: original_booking_id = bookings.booking_ref.
--     These have a synthetic booking_id (e.g. "ext-...") so we map via
--     original_booking_id which points to the real booking_ref.

INSERT INTO booking_extensions (booking_id, payment_intent_id, amount, new_return_date, new_return_time, created_at)
SELECT
  rr.original_booking_id,
  rr.payment_intent_id,
  COALESCE(rr.gross_amount, 0),
  rr.return_date,
  b.return_time,
  COALESCE(rr.created_at, now())
FROM revenue_records rr
JOIN bookings b ON b.booking_ref = rr.original_booking_id
WHERE rr.type                = 'extension'
  AND rr.payment_status      = 'paid'
  AND rr.is_cancelled        = false
  AND rr.original_booking_id IS NOT NULL
  AND rr.return_date         IS NOT NULL
ON CONFLICT (payment_intent_id) DO NOTHING;


-- ===========================================================================
-- 0081_expand_bookings_status_modern.sql
-- ===========================================================================
-- Migration 0081: Expand bookings.status to include all modern status values
--
-- Problem: The bookings.status CHECK constraint (last set in migration 0066) only
-- allows: 'pending', 'reserved', 'pending_verification', 'active', 'overdue', 'completed'
-- This causes silent failures when application code tries to write:
--   • 'active_rental'    — used throughout JS app layer since migration 0064
--   • 'booked_paid'      — used in booking pipeline and admin status updates
--   • 'completed_rental' — used in booking pipeline and admin status updates
--   • 'cancelled_rental' — used in booking pipeline and admin status updates
--
-- The admin panel v2-bookings.js "Mark Cancelled" action writes status='cancelled_rental'
-- to Supabase, but the constraint rejects it silently (non-fatal error path), so the
-- Supabase row stays as 'active' while bookings.json says 'cancelled_rental'.
-- Similarly, 'approved' (used by some admin flows) is no longer in the constraint.
--
-- Fix: expand the constraint to accept all status values used anywhere in the system.
-- Also adds back 'approved' and 'cancelled' for backward compatibility with any
-- legacy rows or flows that still use those legacy values.
--
-- Safe to re-run: idempotent constraint drop + re-add.

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    -- Legacy values (written by autoUpsertBooking / stripe-webhook pre-0064)
    'pending',
    'approved',
    'active',
    'overdue',
    'completed',
    'cancelled',
    -- Post-0066 values
    'reserved',
    'pending_verification',
    -- Modern app-layer values (written directly by booking pipeline / admin panel)
    'active_rental',
    'booked_paid',
    'completed_rental',
    'cancelled_rental'
  ));


-- ===========================================================================
-- 0082_revenue_nullable_booking_id.sql
-- ===========================================================================
-- Migration 0082: allow NULL booking_id on revenue_records
--
-- Background:
--   revenue_records.booking_id was declared NOT NULL, which prevented creating
--   an "orphan" revenue record for a Stripe payment that could not be matched to
--   a booking row (e.g. when booking_ref resolution fails during a balance_payment
--   or rental_balance webhook).  The DB trigger added in migration 0060 already
--   contains an `is_orphan = true` escape hatch that bypasses the booking_ref
--   integrity check — but the NOT NULL column constraint blocked the NULL write
--   before the trigger even ran.
--
-- This migration:
--   1. Drops the NOT NULL constraint so booking_id = NULL is accepted.
--   2. The existing trigger (check_revenue_booking_ref) continues to enforce
--      booking_ref integrity for all rows where is_orphan = false:
--        • If booking_id IS NULL and is_orphan = false  → trigger raises exception.
--        • If booking_id IS NULL and is_orphan = true   → trigger returns NEW (allowed).
--   3. No data changes: all existing rows keep their non-null booking_id values.
--
-- Safe to re-run: ALTER COLUMN ... DROP NOT NULL is idempotent when the
-- constraint is already absent.

ALTER TABLE revenue_records ALTER COLUMN booking_id DROP NOT NULL;


-- ===========================================================================
-- 0083_fix_net_revenue_calculation.sql
-- ===========================================================================
-- Migration 0083: fix net revenue calculation in admin_metrics_v2
--
-- Problem: The net revenue formula in admin_metrics_v2 was:
--   COALESCE(stripe_net, gross_amount - COALESCE(stripe_fee, 0)) - COALESCE(refund_amount, 0)
--
-- This uses stripe_net from Stripe's balance_transaction.net, which can include
-- hidden deductions (e.g. Stripe adjustments, dispute-related line items) that are
-- not reflected in the separately-displayed stripe_fee column.  When stripe_net < gross - fee,
-- those extra deductions silently reduce Net Revenue without appearing in Stripe Fees,
-- causing the displayed Net to be lower than Gross − Fees − Refunds.
--
-- Fix: compute net strictly as:
--   gross_amount - COALESCE(stripe_fee, 0) - COALESCE(refund_amount, 0)
--
-- This matches the updated formulas in:
--   api/v2-dashboard.js     — net = gross - fee - refund
--   api/v2-analytics.js     — net = gross - fee - refund
--   public/admin-v2/index.html normalizeRevenueRecord — amount_net = gross - fee
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW admin_metrics_v2 AS
WITH
  -- ── Vehicle type lookup (vehicle vs car) ──────────────────────────────────
  vt AS (
    SELECT vehicle_id, COALESCE(vehicle_type, '') AS vehicle_type
    FROM   vehicles
  ),

  -- ── Revenue records joined with vehicle type ────────────────────────────────
  rev AS (
    SELECT r.*, COALESCE(vt.vehicle_type, '') AS vehicle_type
    FROM   revenue_reporting_base r
    LEFT JOIN vt ON vt.vehicle_id = r.vehicle_id
  ),

  -- ── Supplemental charges not yet reflected in revenue_records ───────────────
  -- Excludes charges whose Stripe PI is already present in revenue_records to
  -- prevent double-counting (mirrors the JS dedup logic in v2-dashboard.js).
  charges_net AS (
    SELECT
      c.booking_id,
      c.amount,
      c.created_at::date            AS charge_date,
      b.vehicle_id,
      COALESCE(v.vehicle_type, '')  AS vehicle_type
    FROM   charges c
    JOIN   bookings b ON b.booking_ref = c.booking_id
    LEFT JOIN vt v    ON v.vehicle_id  = b.vehicle_id
    WHERE  c.status = 'succeeded'
      AND (
        c.stripe_payment_intent_id IS NULL
        OR c.stripe_payment_intent_id NOT IN (
          SELECT payment_intent_id
          FROM   revenue_records
          WHERE  payment_intent_id IS NOT NULL
        )
      )
  ),

  -- ── Combined revenue: revenue_records + supplemental charges ────────────────
  fin_all AS (
    SELECT
      vehicle_type,
      gross_amount,
      stripe_fee,
      refund_amount,
      COALESCE(is_cancelled, false) AS is_cancelled,
      COALESCE(is_no_show,   false) AS is_no_show,
      TRUE                          AS from_rr
    FROM rev
    UNION ALL
    SELECT
      vehicle_type,
      amount AS gross_amount,
      NULL,
      NULL,
      FALSE,
      FALSE,
      FALSE
    FROM charges_net
  ),

  -- ── Financial aggregates (scope-aware) ──────────────────────────────────────
  fin AS (
    SELECT
      -- Total (all vehicles)
      COALESCE(SUM(CASE WHEN NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)
                                                                        AS total_revenue,
      COALESCE(SUM(CASE WHEN from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)
                                                                        AS total_stripe_fees,
      -- Net = Gross − Stripe Fees − Refunds (strict: no stripe_net dependency)
      COALESCE(SUM(CASE WHEN NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN gross_amount - COALESCE(stripe_fee, 0) - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                 AS total_net_revenue,
      COUNT(*) FILTER (
        WHERE from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                      AS total_reconciled_count,

      -- Car (vehicle_type != 'vehicle')
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)                               AS car_revenue,
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)                   AS car_stripe_fees,
      COALESCE(SUM(CASE WHEN vehicle_type != 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN gross_amount - COALESCE(stripe_fee, 0) - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                 AS car_net_revenue,
      COUNT(*) FILTER (
        WHERE vehicle_type != 'vehicle' AND from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                      AS car_reconciled_count,

      -- Vehicle (vehicle_type = 'vehicle')
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN gross_amount ELSE 0 END), 0)                               AS vehicle_revenue,
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND from_rr AND NOT is_cancelled AND NOT is_no_show
        THEN COALESCE(stripe_fee, 0) ELSE 0 END), 0)                   AS vehicle_stripe_fees,
      COALESCE(SUM(CASE WHEN vehicle_type = 'vehicle'
        AND NOT is_cancelled AND NOT is_no_show
        THEN CASE WHEN from_rr
               THEN gross_amount - COALESCE(stripe_fee, 0) - COALESCE(refund_amount, 0)
               ELSE gross_amount
             END
        ELSE 0 END), 0)                                                 AS vehicle_net_revenue,
      COUNT(*) FILTER (
        WHERE vehicle_type = 'vehicle' AND from_rr AND stripe_fee IS NOT NULL
          AND NOT is_cancelled AND NOT is_no_show)                      AS vehicle_reconciled_count
    FROM fin_all
  ),

  -- ── Expense aggregates (scope-aware) ────────────────────────────────────────
  exp AS (
    SELECT
      COALESCE(SUM(e.amount), 0)                                        AS total_expenses,
      COALESCE(SUM(CASE WHEN COALESCE(vt.vehicle_type, '') != 'vehicle'
        THEN e.amount ELSE 0 END), 0)                                   AS car_expenses,
      COALESCE(SUM(CASE WHEN vt.vehicle_type = 'vehicle'
        THEN e.amount ELSE 0 END), 0)                                   AS vehicle_expenses
    FROM   expenses e
    LEFT JOIN vt ON vt.vehicle_id = e.vehicle_id
  ),

  -- ── Booking status counts (scope-aware, timezone-aware) ─────────────────────
  bk AS (
    SELECT
      -- Total
      COUNT(*) FILTER (WHERE b.status IN ('active', 'overdue'))
                                                                        AS total_active_rentals,
      COUNT(*) FILTER (
        WHERE b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS total_pending_approvals,
      COUNT(*) FILTER (WHERE b.status = 'overdue')                      AS total_overdue_count,
      COUNT(*) FILTER (
        WHERE b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'overdue'))                        AS total_returns_today,
      COUNT(*) FILTER (
        WHERE b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS total_pickups_today,
      -- Car
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status IN ('active', 'overdue'))                        AS car_active_rentals,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS car_pending_approvals,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.status = 'overdue')                                     AS car_overdue_count,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'overdue'))                        AS car_returns_today,
      COUNT(*) FILTER (
        WHERE COALESCE(vt.vehicle_type, '') != 'vehicle'
          AND b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS car_pickups_today,
      -- Vehicle
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status IN ('active', 'overdue'))                        AS vehicle_active_rentals,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS vehicle_pending_approvals,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.status = 'overdue')                                     AS vehicle_overdue_count,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.return_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('active', 'overdue'))                        AS vehicle_returns_today,
      COUNT(*) FILTER (
        WHERE vt.vehicle_type = 'vehicle'
          AND b.pickup_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
          AND b.status IN ('pending', 'reserved', 'pending_verification'))
                                                                        AS vehicle_pickups_today
    FROM   bookings b
    LEFT JOIN vt ON vt.vehicle_id = b.vehicle_id
    WHERE  b.status NOT IN ('completed')
  ),

  -- ── Available vehicles (scope-aware) ────────────────────────────────────────
  avail AS (
    SELECT
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'overdue')
          ))                                                            AS total_available_vehicles,
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND COALESCE(v.vehicle_type, '') != 'vehicle'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'overdue')
          ))                                                            AS car_available_vehicles,
      COUNT(*) FILTER (
        WHERE (v.data ->> 'status') = 'active'
          AND v.vehicle_type = 'vehicle'
          AND v.vehicle_id NOT IN (
            SELECT DISTINCT vehicle_id FROM bookings
            WHERE  status IN ('active', 'overdue')
          ))                                                            AS vehicle_available_vehicles
    FROM vehicles v
  ),

  -- ── Per-vehicle revenue (revenue_records + charges) for vehicleStats ────────
  veh_rev AS (
    SELECT vehicle_id, SUM(gross) AS gross, SUM(net) AS net, SUM(cnt) AS cnt
    FROM (
      SELECT
        r.vehicle_id,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                               AS gross,
        -- Net per record = Gross − Stripe Fees − Refunds (strict: no stripe_net dependency)
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount - COALESCE(r.stripe_fee, 0) - COALESCE(r.refund_amount, 0)
          ELSE 0 END)                                                   AS net,
        COUNT(*) FILTER (
          WHERE NOT COALESCE(r.is_cancelled, false)
            AND NOT COALESCE(r.is_no_show, false))                      AS cnt
      FROM revenue_reporting_base r
      GROUP BY r.vehicle_id
      UNION ALL
      SELECT vehicle_id, SUM(amount) AS gross, SUM(amount) AS net, 0 AS cnt
      FROM   charges_net
      GROUP BY vehicle_id
    ) combined
    GROUP BY vehicle_id
  ),

  -- ── Monthly revenue data for the chart (last 12 months) ─────────────────────
  monthly AS (
    SELECT mo, SUM(total_amt) AS total_amt, SUM(car_amt) AS car_amt, SUM(vehicle_amt) AS vehicle_amt
    FROM (
      -- From revenue_records
      SELECT
        LEFT(r.pickup_date::text, 7) AS mo,
        SUM(CASE WHEN NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                               AS total_amt,
        SUM(CASE WHEN r.vehicle_type != 'vehicle'
                  AND NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                               AS car_amt,
        SUM(CASE WHEN r.vehicle_type = 'vehicle'
                  AND NOT COALESCE(r.is_cancelled, false)
                  AND NOT COALESCE(r.is_no_show,   false)
          THEN r.gross_amount ELSE 0 END)                               AS vehicle_amt
      FROM rev r
      WHERE r.pickup_date IS NOT NULL
      GROUP BY LEFT(r.pickup_date::text, 7)
      UNION ALL
      -- From supplemental charges
      SELECT
        LEFT(c.charge_date::text, 7) AS mo,
        SUM(c.amount)                                                   AS total_amt,
        SUM(CASE WHEN c.vehicle_type != 'vehicle' THEN c.amount ELSE 0 END) AS car_amt,
        SUM(CASE WHEN c.vehicle_type  = 'vehicle' THEN c.amount ELSE 0 END) AS vehicle_amt
      FROM charges_net c
      GROUP BY LEFT(c.charge_date::text, 7)
    ) combined
    GROUP BY mo
  )

SELECT
  -- ── Financial KPIs — Total ────────────────────────────────────────────────
  f.total_revenue,
  f.total_stripe_fees,
  f.total_net_revenue,
  f.total_reconciled_count,
  e.total_expenses,
  (f.total_net_revenue - e.total_expenses)::numeric                     AS total_net_profit,
  CASE WHEN e.total_expenses > 0
    THEN ROUND(((f.total_net_revenue - e.total_expenses)
                / e.total_expenses * 100)::numeric, 2)
    ELSE NULL END                                                        AS total_operational_roi,

  -- ── Financial KPIs — Car ─────────────────────────────────────────────────
  f.car_revenue,
  f.car_stripe_fees,
  f.car_net_revenue,
  f.car_reconciled_count,
  e.car_expenses,
  (f.car_net_revenue - e.car_expenses)::numeric                         AS car_net_profit,
  CASE WHEN e.car_expenses > 0
    THEN ROUND(((f.car_net_revenue - e.car_expenses)
                / e.car_expenses * 100)::numeric, 2)
    ELSE NULL END                                                        AS car_operational_roi,

  -- ── Financial KPIs — Vehicle ───────────────────────────────────────────
  f.vehicle_revenue,
  f.vehicle_stripe_fees,
  f.vehicle_net_revenue,
  f.vehicle_reconciled_count,
  e.vehicle_expenses,
  (f.vehicle_net_revenue - e.vehicle_expenses)::numeric             AS vehicle_net_profit,
  CASE WHEN e.vehicle_expenses > 0
    THEN ROUND(((f.vehicle_net_revenue - e.vehicle_expenses)
                / e.vehicle_expenses * 100)::numeric, 2)
    ELSE NULL END                                                        AS vehicle_operational_roi,

  -- ── Booking counts — Total ───────────────────────────────────────────────
  bk.total_active_rentals,
  bk.total_pending_approvals,
  bk.total_overdue_count,
  bk.total_returns_today,
  bk.total_pickups_today,

  -- ── Booking counts — Car ─────────────────────────────────────────────────
  bk.car_active_rentals,
  bk.car_pending_approvals,
  bk.car_overdue_count,
  bk.car_returns_today,
  bk.car_pickups_today,

  -- ── Booking counts — Vehicle ───────────────────────────────────────────
  bk.vehicle_active_rentals,
  bk.vehicle_pending_approvals,
  bk.vehicle_overdue_count,
  bk.vehicle_returns_today,
  bk.vehicle_pickups_today,

  -- ── Available vehicles ───────────────────────────────────────────────────
  av.total_available_vehicles,
  av.car_available_vehicles,
  av.vehicle_available_vehicles,

  -- ── Per-vehicle revenue JSONB (keyed by vehicle_id) ─────────────────────
  -- Used by v2-dashboard.js to populate rrByVehicle for vehicleStats computation.
  (
    SELECT COALESCE(
      json_object_agg(
        vehicle_id,
        json_build_object(
          'gross', ROUND(COALESCE(gross, 0)::numeric, 2),
          'net',   ROUND(COALESCE(net,   0)::numeric, 2),
          'count', COALESCE(cnt, 0)
        )
      ),
      '{}'::json
    )
    FROM veh_rev
  )                                                                      AS vehicle_revenue_json,

  -- ── Monthly revenue charts (last 12 months, chronological order) ────────
  -- Inner subquery takes the 12 most-recent months; json_agg re-sorts them ASC.
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(total_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, total_amt FROM monthly
      WHERE  total_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                      AS total_revenue_chart,
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(car_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, car_amt FROM monthly
      WHERE  car_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                      AS car_revenue_chart,
  (
    SELECT COALESCE(
      json_agg(
        json_build_object('month', mo, 'amount', ROUND(vehicle_amt::numeric, 2))
        ORDER BY mo
      ),
      '[]'::json
    )
    FROM (
      SELECT mo, vehicle_amt FROM monthly
      WHERE  vehicle_amt > 0
      ORDER BY mo DESC LIMIT 12
    ) sub
  )                                                                      AS vehicle_revenue_chart

FROM fin f, exp e, bk, avail av;


-- ===========================================================================
-- 0084_fix_extension_booking_id.sql
-- ===========================================================================
-- Migration 0084: fix extension revenue_records so booking_id = canonical booking_ref
--
-- Problem:
--   Extension revenue records were created with booking_id set to either:
--     • A synthetic "ext-{original_booking_id}-{timestamp}" placeholder
--       (produced by the old v2-revenue.js record_extension_fee action).
--     • A Stripe PaymentIntent ID ("pi_xxx") — old behaviour before
--       autoCreateRevenueRecord was standardised to use canonical refs.
--
--   Because the admin revenue view groups rows by booking_id, these extensions
--   appeared as separate bookings instead of collapsing under the parent rental.
--
-- Fix (three independent passes):
--
--   Pass 1 — synthetic ext- records (from record_extension_fee):
--     Set booking_id = original_booking_id and type = 'extension'.
--     original_booking_id is the canonical booking_ref passed by the caller.
--     These records may also have type = 'rental' (the DB default at insertion
--     time), so type is corrected in the same statement.
--     is_orphan is cleared once the canonical booking_id is verified.
--
--   Pass 2 — extension records with a PI-based booking_id:
--     When booking_id looks like a Stripe PI ("pi_xxx") but original_booking_id
--     IS a valid bookings.booking_ref, update booking_id = original_booking_id.
--     is_orphan is cleared when the new booking_id is verified.
--
--   Pass 3 — backfill original_booking_id = booking_id for new-style extensions:
--     autoCreateRevenueRecord now sets both fields consistently, but existing rows
--     created before this change have original_booking_id = NULL.  Fill them in
--     so both fields are canonical for all extension records.
--
-- All three passes are safe to re-run (idempotent WHERE clauses).
-- The DB trigger check_revenue_booking_ref fires on each UPDATE; it verifies
-- that the new booking_id exists in bookings.booking_ref — which is guaranteed
-- by the EXISTS sub-select guard in each statement.

-- ── Pass 1: fix synthetic "ext-…" booking_ids ────────────────────────────────
-- Note: booking_id LIKE 'ext-%' requires a sequential scan of the table.
-- This is a one-time data repair migration and the table is not expected to be
-- large enough to warrant a specialised index for this single run.
UPDATE revenue_records
SET    booking_id  = original_booking_id,
       type        = 'extension',
       is_orphan   = false,
       updated_at  = now()
WHERE  sync_excluded        = false
  AND  booking_id            LIKE 'ext-%'
  AND  original_booking_id  IS NOT NULL
  AND  EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.original_booking_id
       );

-- ── Pass 2: fix Stripe PI-based booking_ids on extension rows ────────────────
UPDATE revenue_records
SET    booking_id  = original_booking_id,
       is_orphan   = false,
       updated_at  = now()
WHERE  type                  = 'extension'
  AND  sync_excluded         = false
  AND  booking_id             LIKE 'pi_%'
  AND  original_booking_id  IS NOT NULL
  AND  EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.original_booking_id
       );

-- ── Pass 3: backfill original_booking_id for new-style extensions ────────────
UPDATE revenue_records
SET    original_booking_id = booking_id,
       updated_at          = now()
WHERE  type              = 'extension'
  AND  sync_excluded     = false
  AND  is_orphan         = false
  AND  original_booking_id IS NULL
  AND  booking_id          IS NOT NULL
  AND  EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.booking_id
       );


-- ===========================================================================
-- 0085_fix_extension_dates.sql
-- ===========================================================================
-- Migration 0085: fix extension revenue record dates and original_booking_id linkage
--
-- Addresses two related issues with historical extension revenue_records:
--
-- Issue A — original_booking_id normalisation (revenue tracker grouping):
--   Some older extension rows have original_booking_id = NULL or pointing to a
--   different value than booking_id.  The admin revenue tracker groups rows by
--   COALESCE(original_booking_id, booking_id); if original_booking_id is wrong,
--   extension rows end up in a separate group from their parent rental.
--
--   Fix: for every extension row whose booking_id resolves to a valid
--   bookings.booking_ref, set original_booking_id = booking_id.
--
-- Issue B — pickup_date / return_date on historical extension rows:
--   Early extension records were created without the pickup_date field set
--   (or with pickup_date = return_date), so the admin UI could not compute
--   "+N days" correctly and would show "+0 days".
--
--   Fix: use the booking_extensions table (which has a row per paid extension
--   with new_return_date) plus LAG() to reconstruct the previous return date
--   for each extension in sequence.  The base rental's return_date is used as
--   the anchor for the first extension.
--
-- Safe to re-run: both UPDATE statements are guarded by IS DISTINCT FROM /
-- condition checks so already-correct rows are not touched.

-- ── A. Normalise original_booking_id for extension rows ──────────────────────
--
-- Sets original_booking_id = booking_id for every extension row whose
-- booking_id points to a real booking and whose original_booking_id doesn't
-- already match.

UPDATE revenue_records rr
SET    original_booking_id = rr.booking_id,
       updated_at           = now()
WHERE  rr.type              = 'extension'
  AND  rr.sync_excluded     = false
  AND  rr.booking_id        IS NOT NULL
  AND  (rr.original_booking_id IS NULL OR rr.original_booking_id != rr.booking_id)
  AND  EXISTS (
         SELECT 1 FROM bookings b WHERE b.booking_ref = rr.booking_id
       );

-- ── B. Fix pickup_date / return_date for historical extension rows ────────────
--
-- For each extension row matched to a booking_extensions record (via
-- payment_intent_id), we reconstruct:
--   return_date  = booking_extensions.new_return_date  (the date this extension ends)
--   pickup_date  = previous extension's new_return_date (via LAG), or the base
--                  rental revenue_record's return_date for the first extension.
--
-- Only rows where pickup_date or return_date differs from the correct value are
-- updated (IS DISTINCT FROM handles NULLs safely).

WITH ext_sequence AS (
  -- Order extensions by new_return_date ASC (primary) and created_at ASC (tiebreaker).
  -- In normal operation each extension increases new_return_date, so this order
  -- correctly reconstructs the chronological chain of extensions per booking.
  SELECT
    be.booking_id,
    be.payment_intent_id,
    be.new_return_date,
    LAG(be.new_return_date) OVER (
      PARTITION BY be.booking_id
      ORDER BY     be.new_return_date ASC, be.created_at ASC
    ) AS prev_return_date
  FROM booking_extensions be
),
base_rental AS (
  SELECT rr.booking_id,
         rr.return_date AS base_return_date
  FROM   revenue_records rr
  WHERE  rr.type          = 'rental'
    AND  rr.sync_excluded = false
    AND  rr.return_date   IS NOT NULL
)
UPDATE revenue_records rr
SET    pickup_date = COALESCE(es.prev_return_date, br.base_return_date),
       return_date = es.new_return_date,
       updated_at  = now()
FROM   ext_sequence es
LEFT JOIN base_rental br ON br.booking_id = es.booking_id
WHERE  rr.payment_intent_id = es.payment_intent_id
  AND  rr.type              = 'extension'
  AND  rr.sync_excluded     = false
  AND  (
         rr.pickup_date IS DISTINCT FROM COALESCE(es.prev_return_date, br.base_return_date)
      OR rr.return_date IS DISTINCT FROM es.new_return_date
       );


-- ===========================================================================
-- 0086_sync_blocked_dates_from_bookings.sql
-- ===========================================================================
-- Migration 0086: sync blocked_dates.end_date to match bookings.return_date for active rentals
--
-- Problem:
--   When a rental extension is paid, stripe-webhook.js calls
--   extendBlockedDateForBooking() to advance blocked_dates.end_date.
--   For historical or edge-case extensions this call may have failed silently,
--   leaving blocked_dates.end_date pointing to the pre-extension return date.
--
--   fleet-status.js derives "Next Available" exclusively from
--   MAX(blocked_dates.end_date) per vehicle, so a stale end_date causes the
--   public car listing to show an outdated availability date even after the
--   renter has paid for an extension.
--
-- Fix:
--   For every 'booking' row in blocked_dates that is linked to an active
--   booking whose current return_date is LATER than the blocked end_date,
--   advance end_date to match bookings.return_date.
--
--   Only advances end_date (never shrinks it) and only for active/overdue
--   bookings, so completed or cancelled rentals are untouched.
--
-- Safe to re-run: the WHERE clause only matches rows that need updating
--   (return_date > end_date), so already-correct rows are skipped.
--
-- Note on the overlap trigger:
--   trg_blocked_dates_no_overlap fires on UPDATE but excludes the row being
--   updated (id != COALESCE(NEW.id, -1)), so extending an existing block
--   never conflicts with itself.

UPDATE public.blocked_dates bd
SET    end_date = b.return_date::date
FROM   public.bookings b
WHERE  bd.booking_ref = b.booking_ref
  AND  bd.vehicle_id  = b.vehicle_id
  AND  bd.reason      = 'booking'
  AND  b.status       IN ('active', 'active_rental', 'overdue')
  AND  b.return_date  IS NOT NULL
  AND  b.return_date::date > bd.end_date;


-- ===========================================================================
-- 0087_vehicle_blocking_ranges.sql
-- ===========================================================================
-- Migration 0087: vehicle_blocking_ranges view
--
-- Purpose:
--   Replace app-code timeline reconstruction from revenue_records with a
--   dedicated DB view that is the single source of truth for per-segment
--   vehicle blocking ranges.
--
--   The view decomposes each booking into:
--     source = 'base'      — the original rental period
--     source = 'extension' — each subsequent paid extension
--
--   Consumers query by vehicle_id:
--     SELECT * FROM public.vehicle_blocking_ranges
--     WHERE vehicle_id = ?
--     ORDER BY start_date ASC
--
-- Why original_return_date is needed:
--   bookings.return_date is advanced on every extension, so after one
--   extension it no longer reflects the base rental's end date.
--   original_return_date is set once on INSERT (via trigger) and never
--   changed by extension processing.  It is the anchor the view uses to
--   reconstruct:
--     - the base segment:       pickup_date → original_return_date
--     - the first extension:    original_return_date → first new_return_date
--     - subsequent extensions:  prev new_return_date → this new_return_date
--
-- Safe to re-run:
--   All DDL uses IF NOT EXISTS / CREATE OR REPLACE.
--   UPDATE backfills are guarded so already-correct rows are skipped.

-- ── 1. Add original_return_date column ───────────────────────────────────────

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS original_return_date date;

COMMENT ON COLUMN bookings.original_return_date
  IS 'Return date of the base rental before any extension was applied. Set from return_date on INSERT and never changed by extension processing.';

-- ── 2. Backfill original_return_date ─────────────────────────────────────────
--
-- 2a. For bookings that have a matching rental-type revenue_record use its
--     return_date as the authoritative base end (the only durable record of
--     the pre-extension return date for historical rows).

UPDATE bookings b
SET    original_return_date = rr.return_date
FROM   revenue_records rr
WHERE  rr.booking_id        = b.booking_ref
  AND  rr.type              = 'rental'
  AND  rr.sync_excluded     = false
  AND  rr.return_date       IS NOT NULL
  AND  b.original_return_date IS NULL;

-- 2b. For all remaining bookings (no revenue record, or already set):
--     fall back to the current return_date.  For bookings with no extensions
--     this is identical to the original; for extended bookings with no
--     revenue record it is the best available approximation.

UPDATE bookings b
SET    original_return_date = b.return_date
WHERE  b.original_return_date IS NULL
  AND  b.return_date          IS NOT NULL;

-- ── 3. Trigger: auto-set original_return_date on INSERT ──────────────────────
--
-- Ensures every new booking row gets original_return_date = return_date so
-- the view works correctly without any app-code changes to the insert path.

CREATE OR REPLACE FUNCTION public.set_original_return_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.original_return_date IS NULL THEN
    NEW.original_return_date := NEW.return_date;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_set_original_return_date ON bookings;

CREATE TRIGGER bookings_set_original_return_date
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_original_return_date();

-- ── 4. Create vehicle_blocking_ranges view ───────────────────────────────────

CREATE OR REPLACE VIEW public.vehicle_blocking_ranges AS
WITH ext_seq AS (
  -- Reconstruct the sequential date chain for every extension.
  -- For the first extension (LAG = NULL) the start date falls back to the
  -- booking's original_return_date (= base rental end).
  -- For subsequent extensions the start date is the previous extension's
  -- new_return_date, giving a gapless chain.
  SELECT
    be.booking_id,
    b.vehicle_id,
    COALESCE(
      LAG(be.new_return_date) OVER (
        PARTITION BY be.booking_id
        ORDER BY     be.new_return_date ASC, be.created_at ASC
      ),
      b.original_return_date
    )                        AS start_date,
    be.new_return_date       AS end_date
  FROM booking_extensions be
  JOIN bookings b ON b.booking_ref = be.booking_id
)
-- Base rental segment (one row per booking)
SELECT
  b.vehicle_id,
  b.booking_ref,
  b.pickup_date             AS start_date,
  b.original_return_date    AS end_date,
  'base'::text              AS source
FROM bookings b
WHERE b.pickup_date          IS NOT NULL
  AND b.original_return_date IS NOT NULL

UNION ALL

-- Extension segments (one row per paid extension)
SELECT
  es.vehicle_id,
  es.booking_id             AS booking_ref,
  es.start_date,
  es.end_date,
  'extension'::text         AS source
FROM ext_seq es
WHERE es.start_date IS NOT NULL
  AND es.end_date   IS NOT NULL;

COMMENT ON VIEW public.vehicle_blocking_ranges
  IS 'Per-segment vehicle blocking timeline. Each base rental and each paid extension appears as a separate row. Query by vehicle_id ORDER BY start_date ASC to get the full chain.';


-- ===========================================================================
-- 0088_backfill_return_time.sql
-- ===========================================================================
-- Backfill return_time for bookings where it is NULL.
-- Use pickup_time when available (keeps the same daily window); fall back to
-- 10:00 AM (DEFAULT_RETURN_TIME in _time.js) as a safe general default.
-- This ensures all SMS cron jobs receive a valid return_time and can compute
-- minutesToReturn correctly.

UPDATE bookings
SET    return_time = COALESCE(pickup_time, '10:00:00')
WHERE  return_time IS NULL;


-- ===========================================================================
-- 0089_backfill_revenue_records.sql
-- ===========================================================================
-- Migration 0089: Backfill revenue_records for paid bookings missing a revenue row.
--
-- Invariant: every booking with deposit_paid > 0 (i.e. at least one payment was
-- received) must have exactly one revenue_records row with type = 'rental'.
--
-- Note: deposit_paid is used as gross_amount because it is the actual amount
-- collected from the customer.  For most bookings deposit_paid == total_price
-- (full payments); for reservation-deposit bookings it holds the partial amount
-- paid, which is the correct value for a gross_amount revenue entry.
--
-- We insert only when ALL of:
--   • deposit_paid > 0
--   • booking is not cancelled (status NOT IN ('cancelled', 'cancelled_rental'))
--   • no rental revenue_records row already exists keyed by booking_ref (booking_id)
--   • if the booking has a payment_intent_id, no row with that same PI already
--     exists in revenue_records (prevents duplicate entries for bookings that were
--     recorded under a different booking_id by stripe-reconcile / early orphan logic)
--
-- Cash/manual bookings (payment_method IN ('cash','zelle','venmo','manual','external'))
-- receive stripe_fee = 0, stripe_net = gross_amount immediately so that analytics are
-- correct without waiting for a Stripe reconciliation pass.
-- All other bookings receive stripe_fee = NULL / stripe_net = NULL, to be filled in
-- later by stripe-reconcile.js.
--
-- Safe to re-run: the NOT EXISTS guards + ON CONFLICT DO NOTHING make this idempotent.

INSERT INTO revenue_records (
  booking_id,
  payment_intent_id,
  vehicle_id,
  pickup_date,
  return_date,
  gross_amount,
  deposit_amount,
  refund_amount,
  payment_method,
  payment_status,
  type,
  is_no_show,
  is_cancelled,
  override_by_admin,
  stripe_fee,
  stripe_net
)
SELECT
  b.booking_ref,
  b.payment_intent_id,
  b.vehicle_id,
  b.pickup_date,
  b.return_date,
  b.deposit_paid                         AS gross_amount,
  0                                      AS deposit_amount,
  0                                      AS refund_amount,
  COALESCE(b.payment_method, 'stripe')   AS payment_method,
  'paid'                                 AS payment_status,
  'rental'                               AS type,
  false                                  AS is_no_show,
  false                                  AS is_cancelled,
  false                                  AS override_by_admin,
  -- Cash/offline payments: fee = 0, net = gross (no Stripe involvement)
  CASE
    WHEN LOWER(COALESCE(b.payment_method, '')) IN ('cash', 'zelle', 'venmo', 'manual', 'external')
      THEN 0
    ELSE NULL
  END                                    AS stripe_fee,
  CASE
    WHEN LOWER(COALESCE(b.payment_method, '')) IN ('cash', 'zelle', 'venmo', 'manual', 'external')
      THEN b.deposit_paid
    ELSE NULL
  END                                    AS stripe_net
FROM bookings b
WHERE
  -- Only bookings where money was actually collected
  b.deposit_paid > 0
  -- Skip cancelled bookings
  AND b.status NOT IN ('cancelled', 'cancelled_rental')
  -- Skip if a rental revenue record already exists for this booking
  AND NOT EXISTS (
    SELECT 1
    FROM   revenue_records rr
    WHERE  rr.booking_id = b.booking_ref
      AND  rr.type = 'rental'
  )
  -- Skip if the booking's payment_intent_id is already covered by another revenue row
  -- (e.g. an orphan record created by stripe-reconcile before the booking was linked)
  AND (
    b.payment_intent_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM   revenue_records rr2
      WHERE  rr2.payment_intent_id = b.payment_intent_id
    )
  )
ON CONFLICT DO NOTHING;


-- ===========================================================================
-- 0090_total_revenue_kpi_view.sql
-- ===========================================================================
-- Migration 0090: total_revenue_kpi view
--
-- Provides a single, stable KPI value for total revenue that is:
--   • ledger-based — sums gross_amount directly from revenue_records
--   • independent of payment_intent_id / Stripe-specific fields
--   • inclusive of Stripe payments, manual/admin payments, and extensions
--
-- Definition matches the problem statement spec exactly:
--   SELECT SUM(gross_amount) FROM revenue_records WHERE is_cancelled = false
--
-- Note: queries revenue_records directly (not revenue_records_effective) so
-- sync_excluded rows are included. This is intentional — the KPI reflects
-- every recorded charge regardless of display exclusions.
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW total_revenue_kpi AS
SELECT
  COALESCE(SUM(gross_amount), 0) AS total_revenue
FROM revenue_records
WHERE is_cancelled = false;


-- ===========================================================================
-- 0091_booking_revenue_grouped_view.sql
-- ===========================================================================
-- Migration 0091: booking_revenue_grouped view
--
-- Groups revenue_records_effective by effective booking ID so the Revenue
-- Tracker always shows one row per booking with extensions collapsed inside.
--
-- Grouping key: COALESCE(original_booking_id, booking_id)
--   Extension rows store their parent booking ref in original_booking_id;
--   base rental rows use booking_id.  COALESCE merges them under one key.
--
-- Aggregation rules (per problem statement spec):
--   min_pickup_date  = MIN(pickup_date)
--   max_return_date  = MAX(return_date)
--   gross_total      = SUM(gross_amount) WHERE is_cancelled = false
--   extensions       = JSONB array of rows WHERE type = 'extension'
--   records          = JSONB array of ALL rows in the group (for detail view)
--
-- Scalar metadata (vehicle_id, customer_*) is taken from MAX() aggregation,
-- which reliably surfaces non-NULL values. In practice all rows in a booking
-- share the same vehicle and customer so MAX() returns the correct value.
--
-- Queries revenue_records_effective (sync_excluded = false already applied).
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW booking_revenue_grouped AS
SELECT
  COALESCE(original_booking_id, booking_id)             AS booking_group_id,
  MAX(vehicle_id)                                        AS vehicle_id,
  MAX(customer_name)                                     AS customer_name,
  MAX(customer_phone)                                    AS customer_phone,
  MAX(customer_email)                                    AS customer_email,
  MIN(pickup_date)                                       AS min_pickup_date,
  MAX(return_date)                                       AS max_return_date,
  COALESCE(
    SUM(gross_amount) FILTER (WHERE is_cancelled = false),
    0
  )                                                      AS gross_total,
  COUNT(*)                                               AS record_count,
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                   id,
      'booking_id',           booking_id,
      'original_booking_id',  original_booking_id,
      'vehicle_id',           vehicle_id,
      'customer_name',        customer_name,
      'customer_phone',       customer_phone,
      'customer_email',       customer_email,
      'pickup_date',          pickup_date,
      'return_date',          return_date,
      'gross_amount',         gross_amount,
      'stripe_fee',           stripe_fee,
      'stripe_net',           stripe_net,
      'refund_amount',        refund_amount,
      'deposit_amount',       deposit_amount,
      'payment_method',       payment_method,
      'payment_status',       payment_status,
      'is_cancelled',         is_cancelled,
      'is_no_show',           is_no_show,
      'type',                 type,
      'notes',                notes,
      'created_at',           created_at
    )
    ORDER BY created_at ASC
  )                                                      AS records,
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                   id,
      'booking_id',           booking_id,
      'original_booking_id',  original_booking_id,
      'vehicle_id',           vehicle_id,
      'pickup_date',          pickup_date,
      'return_date',          return_date,
      'gross_amount',         gross_amount,
      'stripe_fee',           stripe_fee,
      'refund_amount',        refund_amount,
      'payment_method',       payment_method,
      'payment_status',       payment_status,
      'is_cancelled',         is_cancelled,
      'is_no_show',           is_no_show,
      'type',                 type
    )
    ORDER BY created_at ASC
  ) FILTER (WHERE type = 'extension')                    AS extensions
FROM revenue_records_effective
GROUP BY COALESCE(original_booking_id, booking_id);


-- ===========================================================================
-- 0092_booking_extensions_pi_not_null.sql
-- ===========================================================================
-- Migration 0092: enforce payment_intent_id NOT NULL on booking_extensions
--
-- payment_intent_id already carries a UNIQUE constraint (migration 0080) which
-- is the idempotency key for extension upserts.  A NULL value in a UNIQUE column
-- is not comparable to other NULLs in Postgres, so multiple NULL rows are
-- permitted — silently bypassing the dedup guard.
--
-- This migration closes that gap by adding NOT NULL so every extension row is
-- provably traceable to a Stripe PaymentIntent.
--
-- Safe to run: all existing rows inserted by the application always carry a
-- non-null payment_intent_id (enforced at the application layer since 0080).
-- The backfill in 0080 also filters rr.payment_intent_id IS NOT NULL.

ALTER TABLE booking_extensions
  ALTER COLUMN payment_intent_id SET NOT NULL;


-- ===========================================================================
-- 0092_normalize_camry_vehicle_id.sql
-- ===========================================================================
-- Migration 0092: Normalize legacy "camry2012" vehicle_id to canonical "camry"
--
-- Some revenue records were manually inserted using the legacy vehicle ID
-- "camry2012" instead of the canonical "camry".  Because v2-revenue.js
-- filters by exact vehicle_id match, these records were invisible in the
-- Camry 2012 booking count on the Revenue and Admin pages.
--
-- After this migration all Camry 2012 records share the same vehicle_id
-- ("camry") and will be correctly counted and displayed together.

UPDATE revenue_records
SET vehicle_id = 'camry'
WHERE vehicle_id = 'camry2012';


-- ===========================================================================
-- 0093_fix_bookings_status_constraint.sql
-- ===========================================================================
-- Migration 0093: Re-apply expanded bookings.status CHECK constraint
--
-- Problem: The bookings_status_check constraint was last set in migration 0056 to
-- only allow ('pending','active','overdue','completed').  Migration 0081 was meant
-- to expand it, but may not have been applied to all environments (e.g. the live
-- Supabase project).  As a result, writing status='completed_rental' when the admin
-- clicks "✓ Returned" on an overdue booking fails with:
--   "new row for relation "bookings" violates check constraint "bookings_status_check""
--
-- Fix: Drop and re-add the constraint with the full set of status values used
-- anywhere in the application layer.  Idempotent — safe to re-run.

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    -- Legacy values (stripe-webhook / autoUpsertBooking pre-0064)
    'pending',
    'approved',
    'active',
    'overdue',
    'completed',
    'cancelled',
    -- Post-0066 values
    'reserved',
    'pending_verification',
    -- Modern app-layer values (booking pipeline / admin panel / v2-bookings.js)
    'active_rental',
    'booked_paid',
    'completed_rental',
    'cancelled_rental'
  ));


-- ===========================================================================
-- 0094_blocked_dates_end_time.sql
-- ===========================================================================
-- Migration 0094: add end_time to blocked_dates for accurate availability timing
--
-- Problem: blocked_dates only stored end_date (DATE), causing availability to
-- be blocked for the entire day regardless of the actual return time.  A
-- booking that returns at 3 PM would keep the vehicle unavailable until
-- midnight, preventing same-day back-to-back rentals from being offered.
--
-- Fix: add end_time (TIME) to store the return time + preparation buffer so
-- fleet-status can compute an exact "available at" timestamp.
--
--   end_date + end_time = return_datetime + BOOKING_BUFFER_HOURS (2 h)
--
-- Rows written before this migration (no end_time) are backfilled with the
-- canonical DEFAULT_RETURN_TIME so existing blocks stay conservative.
-- Manual and maintenance blocks receive NULL (date-only behaviour is correct
-- for those — no specific return time to reflect).

-- 1. Add the column.
ALTER TABLE public.blocked_dates
  ADD COLUMN IF NOT EXISTS end_time TIME NULL;

-- 2. Backfill booking rows that have a matching bookings.return_time.
--    Uses the stored return_time + 2-hour buffer where available;
--    falls back to DEFAULT_RETURN_TIME (10:00) + buffer (→ 12:00).
UPDATE public.blocked_dates bd
SET end_time = CASE
  WHEN b.return_time IS NOT NULL
    THEN ((b.return_time::interval + interval '2 hours')::time)
  ELSE '12:00:00'::time  -- DEFAULT_RETURN_TIME ("10:00") + 2 h
END
FROM public.bookings b
WHERE bd.booking_ref = b.booking_ref
  AND bd.reason = 'booking'
  AND bd.end_time IS NULL;

-- 3. Any remaining booking rows without a bookings match get the safe default.
UPDATE public.blocked_dates
SET end_time = '12:00:00'::time
WHERE reason = 'booking'
  AND end_time IS NULL;

-- Manual / maintenance rows are intentionally left with end_time = NULL:
-- they have no return time to reflect, so date-only display is correct.


-- ===========================================================================
-- 0095_fix_conflict_trigger_completed.sql
-- ===========================================================================
-- Migration 0095: Fix check_booking_conflicts trigger to exclude completed / cancelled statuses
--
-- Problem: The trigger currently uses `status NOT IN ('cancelled')`, which means
-- bookings with status 'completed', 'completed_rental', or 'cancelled_rental' are
-- still treated as active when checking for date overlaps.
--
-- This causes new bookings to be rejected with "Booking conflict" even when the
-- vehicle was freed up by a completed or cancelled rental, specifically when:
--   • A completed rental's return_date equals the new booking's pickup_date AND
--     the return_time is NULL (booking_datetime returns midnight of the next day),
--     making booking_datetime(return) > new_start TRUE and triggering a false conflict.
--
-- Fix: Expand the status exclusion to include 'completed', 'completed_rental',
-- and 'cancelled_rental'.  These statuses mean the vehicle is free; they must
-- not block new bookings.
--
-- Also: Skip the conflict check when the NEW row itself has a terminal status
-- ('completed', 'completed_rental', 'cancelled_rental') to match the existing
-- 'cancelled' fast-path guard.
--
-- Safe to re-run: DROP + CREATE is idempotent for triggers and functions.

CREATE OR REPLACE FUNCTION check_booking_conflicts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_conflict_id uuid;
  v_blocked_vid text;
  new_start     timestamptz;
  new_end       timestamptz;
BEGIN
  -- Terminal / free-vehicle statuses — no conflict check needed.
  IF NEW.status IN ('cancelled', 'completed', 'completed_rental', 'cancelled_rental') THEN
    RETURN NEW;
  END IF;
  IF NEW.pickup_date IS NULL THEN RETURN NEW; END IF;

  new_start := booking_datetime(NEW.pickup_date, NEW.pickup_time, false);
  new_end   := booking_datetime(NEW.return_date, NEW.return_time, true);

  -- Check for overlapping active bookings on the same vehicle.
  -- Exclude statuses that mean the vehicle is free.
  SELECT b.id INTO v_conflict_id
  FROM   bookings b
  WHERE  b.vehicle_id = NEW.vehicle_id
    AND  b.status NOT IN ('cancelled', 'completed', 'completed_rental', 'cancelled_rental')
    AND  b.id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND  booking_datetime(b.pickup_date, b.pickup_time, false) < new_end
    AND  booking_datetime(b.return_date, b.return_time, true)  > new_start
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Booking conflict: vehicle % is already booked overlapping % to % (conflicts with booking %)',
      NEW.vehicle_id,
      new_start AT TIME ZONE 'UTC',
      new_end   AT TIME ZONE 'UTC',
      v_conflict_id;
  END IF;

  -- Check maintenance / manual blocked_dates only (not 'booking' — managed by bookings table)
  SELECT bd.vehicle_id INTO v_blocked_vid
  FROM   blocked_dates bd
  WHERE  bd.vehicle_id = NEW.vehicle_id
    AND  bd.reason    != 'booking'
    AND  bd.start_date <= COALESCE(NEW.return_date, NEW.pickup_date)
    AND  bd.end_date   >= NEW.pickup_date
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Date conflict: vehicle % has blocked dates overlapping with % to %',
      NEW.vehicle_id, NEW.pickup_date, COALESCE(NEW.return_date, NEW.pickup_date);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_check_conflicts ON bookings;
CREATE TRIGGER bookings_check_conflicts
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION check_booking_conflicts();


-- ===========================================================================
-- 0096_fix_atomic_rpc_stripe_fee.sql
-- ===========================================================================
-- Migration 0096: Fix upsert_booking_revenue_atomic — stripe_fee handling
--
-- Problems fixed:
--
-- 1. RAISE EXCEPTION when stripe_fee IS NULL (line 246 of 0055).
--    The function raised an exception when v_revenue_stripe_fee IS NULL, which
--    caused the atomic RPC to ALWAYS fail for repair-path calls where stripe_fee
--    is not yet available (stripe-reconcile.js backfills it later).  This forced
--    every repair to use the slower legacy fallback path.
--
-- 2. ON CONFLICT DO UPDATE overwrote stripe_fee with NULL.
--    If a revenue record already had stripe_fee populated (e.g. from a prior
--    successful webhook run) and a retry came in with p_stripe_fee = NULL, the
--    ON CONFLICT SET clause wrote NULL, destroying the existing value.
--
-- Fix:
--   • Remove v_revenue_stripe_fee IS NULL from the completeness check — only
--     payment_intent_id is required for the record to be considered complete.
--   • Use COALESCE in the ON CONFLICT SET clause so the existing stripe_fee is
--     preserved when the incoming value is NULL.
--
-- Safe to re-run: CREATE OR REPLACE is idempotent.

CREATE OR REPLACE FUNCTION public.upsert_booking_revenue_atomic(
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_booking_ref text,
  p_vehicle_id text,
  p_pickup_date date,
  p_return_date date,
  p_pickup_time time,
  p_return_time time,
  p_status text,
  p_total_price numeric,
  p_deposit_paid numeric,
  p_remaining_balance numeric,
  p_payment_status text,
  p_notes text,
  p_payment_method text,
  p_payment_intent_id text,
  p_stripe_customer_id text,
  p_stripe_payment_method_id text,
  p_booking_customer_email text,
  p_activated_at timestamptz,
  p_completed_at timestamptz,
  p_revenue_vehicle_id text,
  p_revenue_customer_name text,
  p_revenue_customer_phone text,
  p_revenue_customer_email text,
  p_revenue_pickup_date date,
  p_revenue_return_date date,
  p_gross_amount numeric,
  p_stripe_fee numeric,
  p_payment_intent_id_revenue text,
  p_refund_amount numeric,
  p_revenue_payment_method text,
  p_revenue_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_customer_id uuid;
  v_booking_id uuid;
  v_revenue_id uuid;
  v_revenue_payment_intent text;
BEGIN
  IF p_booking_ref IS NULL OR btrim(p_booking_ref) = '' THEN
    RAISE EXCEPTION 'booking_ref is required';
  END IF;

  IF p_revenue_vehicle_id IS NULL OR btrim(p_revenue_vehicle_id) = '' THEN
    RAISE EXCEPTION 'revenue vehicle_id is required';
  END IF;

  -- Customer dedupe: email-first (primary identity), then phone fallback.
  IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE lower(c.email) = lower(p_customer_email)
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE c.phone = p_customer_phone
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND (
    (p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '') OR
    (p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '')
  ) THEN
    BEGIN
      INSERT INTO customers (
        name, phone, email, updated_at
      ) VALUES (
        COALESCE(NULLIF(p_customer_name, ''), 'Unknown'),
        NULLIF(p_customer_phone, ''),
        NULLIF(lower(p_customer_email), ''),
        now()
      )
      RETURNING id INTO v_customer_id;
    EXCEPTION
      WHEN unique_violation THEN
        IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE lower(c.email) = lower(p_customer_email)
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE c.phone = p_customer_phone
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL THEN
          RAISE;
        END IF;
    END;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET
      name = COALESCE(NULLIF(p_customer_name, ''), customers.name),
      phone = COALESCE(NULLIF(p_customer_phone, ''), customers.phone),
      email = COALESCE(NULLIF(lower(p_customer_email), ''), customers.email),
      updated_at = now()
    WHERE id = v_customer_id;
  END IF;

  INSERT INTO bookings (
    booking_ref,
    customer_id,
    vehicle_id,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    status,
    total_price,
    deposit_paid,
    remaining_balance,
    payment_status,
    notes,
    payment_method,
    payment_intent_id,
    stripe_customer_id,
    stripe_payment_method_id,
    customer_email,
    activated_at,
    completed_at
  ) VALUES (
    p_booking_ref,
    v_customer_id,
    p_vehicle_id,
    p_pickup_date,
    p_return_date,
    p_pickup_time,
    p_return_time,
    COALESCE(NULLIF(p_status, ''), 'pending'),
    COALESCE(p_total_price, 0),
    COALESCE(p_deposit_paid, 0),
    COALESCE(p_remaining_balance, 0),
    COALESCE(NULLIF(p_payment_status, ''), 'unpaid'),
    p_notes,
    p_payment_method,
    p_payment_intent_id,
    p_stripe_customer_id,
    p_stripe_payment_method_id,
    p_booking_customer_email,
    p_activated_at,
    p_completed_at
  )
  ON CONFLICT (booking_ref) DO UPDATE
  SET
    customer_id = EXCLUDED.customer_id,
    vehicle_id = EXCLUDED.vehicle_id,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    pickup_time = EXCLUDED.pickup_time,
    return_time = EXCLUDED.return_time,
    status = EXCLUDED.status,
    total_price = EXCLUDED.total_price,
    deposit_paid = EXCLUDED.deposit_paid,
    remaining_balance = EXCLUDED.remaining_balance,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    payment_method = EXCLUDED.payment_method,
    payment_intent_id = EXCLUDED.payment_intent_id,
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_payment_method_id = EXCLUDED.stripe_payment_method_id,
    customer_email = EXCLUDED.customer_email,
    activated_at = COALESCE(EXCLUDED.activated_at, bookings.activated_at),
    completed_at = COALESCE(EXCLUDED.completed_at, bookings.completed_at),
    updated_at = now()
  RETURNING id INTO v_booking_id;

  INSERT INTO revenue_records (
    booking_id,
    payment_intent_id,
    vehicle_id,
    customer_id,
    customer_name,
    customer_phone,
    customer_email,
    pickup_date,
    return_date,
    gross_amount,
    refund_amount,
    payment_method,
    payment_status,
    type,
    notes,
    stripe_fee
  ) VALUES (
    p_booking_ref,
    p_payment_intent_id_revenue,
    p_revenue_vehicle_id,
    v_customer_id,
    p_revenue_customer_name,
    p_revenue_customer_phone,
    p_revenue_customer_email,
    p_revenue_pickup_date,
    p_revenue_return_date,
    COALESCE(p_gross_amount, 0),
    COALESCE(p_refund_amount, 0),
    COALESCE(NULLIF(p_revenue_payment_method, ''), 'stripe'),
    'paid',
    'rental',
    p_revenue_notes,
    p_stripe_fee
  )
  ON CONFLICT (booking_id) WHERE type = 'rental' DO UPDATE
  SET
    payment_intent_id = EXCLUDED.payment_intent_id,
    vehicle_id = EXCLUDED.vehicle_id,
    customer_id = EXCLUDED.customer_id,
    customer_name = EXCLUDED.customer_name,
    customer_phone = EXCLUDED.customer_phone,
    customer_email = EXCLUDED.customer_email,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    gross_amount = EXCLUDED.gross_amount,
    refund_amount = EXCLUDED.refund_amount,
    payment_method = EXCLUDED.payment_method,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    -- Preserve existing stripe_fee when the incoming value is NULL so that
    -- stripe-reconcile.js can backfill it without being overwritten on retry.
    stripe_fee = COALESCE(EXCLUDED.stripe_fee, revenue_records.stripe_fee),
    updated_at = now()
  RETURNING id, payment_intent_id
  INTO v_revenue_id, v_revenue_payment_intent;

  -- Only require payment_intent_id for completeness — stripe_fee may be NULL
  -- and will be backfilled by stripe-reconcile.js after the balance_transaction settles.
  IF v_revenue_payment_intent IS NULL OR btrim(v_revenue_payment_intent) = '' THEN
    RAISE EXCEPTION 'revenue record incomplete after upsert for booking_ref=%', p_booking_ref;
  END IF;

  RETURN jsonb_build_object(
    'booking_id', v_booking_id,
    'customer_id', v_customer_id,
    'revenue_id', v_revenue_id,
    'revenue_complete', true
  );
END;
$$;


-- ===========================================================================
-- 0097_backfill_stuck_payment_and_stale_bookings.sql
-- ===========================================================================
-- Migration 0097: Fix stale active_rental bookings and backfill stuck payment
--
-- Context:
--   On 2026-04-27 a payment of $60.64 was received for camry2013 (Brandon Bookhart,
--   booking bk-bc8b0ddcc89e, pickup 2026-04-27, return 2026-04-28).  Both the Stripe
--   webhook and the scheduled-reminders repair attempt failed with "Repair failed".
--
-- Root causes addressed by this migration:
--
--   1. Stale bookings in Supabase with status='active_rental' long past their
--      return_date.  The check_booking_conflicts trigger (fixed in 0095) still
--      treated these as active, potentially blocking new inserts.  Mark them
--      completed_rental so they no longer block future bookings.
--
--   2. The stuck booking bk-bc8b0ddcc89e was never persisted because the pipeline
--      failed before completing.  Insert it directly so the renter has a record,
--      the vehicle shows as unavailable, and revenue is recorded.
--
--   3. The reconciliation dedup state in app_config retains pi_3TQwKHPo7fICjrtZ18v5heUr
--      in its 25-hour dedup window, preventing future auto-repair attempts.
--      Remove it so the next cron run can re-check (and will find the revenue
--      record inserted here, confirming it is resolved).
--
-- Safe to re-run: all writes are idempotent (ON CONFLICT DO UPDATE / DO NOTHING,
-- UPDATE with IS DISTINCT FROM guard, DELETE is always safe to re-run).

DO $$
DECLARE
  v_customer_id uuid;
BEGIN

  -- ── 1. Mark stale camry2013 active_rental bookings as completed_rental ──────
  -- bk-bb-2026-0407 (Brandon Bookhart, return 2026-04-12) and
  -- bk-c0c7138a5d2a  (Brandon Bookhart, return 2026-04-26/27 with extension)
  -- have been sitting as active_rental long past their return dates.

  UPDATE public.bookings
  SET    status      = 'completed_rental',
         completed_at = COALESCE(completed_at, return_date::timestamptz),
         updated_at  = now()
  WHERE  booking_ref IN ('bk-bb-2026-0407', 'bk-c0c7138a5d2a')
    AND  status = 'active_rental';

  -- Also mark any other camry2013 bookings that are still non-cancelled /
  -- non-completed but whose return_date is more than 2 days in the past.
  UPDATE public.bookings
  SET    status      = 'completed_rental',
         completed_at = COALESCE(completed_at, return_date::timestamptz),
         updated_at  = now()
  WHERE  vehicle_id   = 'camry2013'
    AND  return_date  < (CURRENT_DATE - INTERVAL '2 days')
    AND  status NOT IN ('cancelled', 'cancelled_rental', 'completed', 'completed_rental');

  -- Do the same for camry (2012) to keep both vehicles clean.
  UPDATE public.bookings
  SET    status      = 'completed_rental',
         completed_at = COALESCE(completed_at, return_date::timestamptz),
         updated_at  = now()
  WHERE  vehicle_id   = 'camry'
    AND  return_date  < (CURRENT_DATE - INTERVAL '2 days')
    AND  status NOT IN ('cancelled', 'cancelled_rental', 'completed', 'completed_rental');

  -- ── 2. Upsert customer: Brandon Bookhart ────────────────────────────────────
  INSERT INTO public.customers (name, phone, email, updated_at)
  VALUES ('Brandon Bookhart', '+15303285561', 'brandon.bookhart@gmail.com', now())
  ON CONFLICT (phone) DO UPDATE
    SET name       = EXCLUDED.name,
        email      = COALESCE(EXCLUDED.email, customers.email),
        updated_at = now()
  RETURNING id INTO v_customer_id;

  IF v_customer_id IS NULL THEN
    SELECT id INTO v_customer_id
    FROM   public.customers
    WHERE  phone = '+15303285561';
  END IF;

  -- ── 3. Insert stuck booking bk-bc8b0ddcc89e ─────────────────────────────────
  -- Payment: $60.64 full_payment, 2026-04-27 → 2026-04-28, camry2013.
  -- PI: pi_3TQwKHPo7fICjrtZ18v5heUr
  -- Pickup was 08:00 on 2026-04-27 (already past), so status is active_rental.
  INSERT INTO public.bookings (
    booking_ref, customer_id, vehicle_id,
    pickup_date, return_date,
    pickup_time, return_time,
    status, total_price, deposit_paid, remaining_balance,
    payment_status, payment_method,
    payment_intent_id, stripe_customer_id,
    customer_name, customer_email, customer_phone,
    notes, updated_at
  )
  VALUES (
    'bk-bc8b0ddcc89e', v_customer_id, 'camry2013',
    '2026-04-27', '2026-04-28',
    '08:00:00', '08:00:00',
    'active_rental', 60.64, 60.64, 0.00,
    'paid', 'stripe',
    'pi_3TQwKHPo7fICjrtZ18v5heUr', 'cus_UKU6OFbaET2wdh',
    'Brandon Bookhart', 'brandon.bookhart@gmail.com', '+15303285561',
    'Full payment $60.64 via Stripe. 1-day rental. Backfilled via migration 0097.',
    now()
  )
  ON CONFLICT (booking_ref) DO UPDATE
    -- Only upgrade the status (never downgrade a terminal state).
    SET status = CASE
          WHEN bookings.status IN ('cancelled', 'cancelled_rental', 'completed', 'completed_rental')
          THEN bookings.status
          ELSE 'active_rental'
        END,
        total_price        = EXCLUDED.total_price,
        deposit_paid       = EXCLUDED.deposit_paid,
        remaining_balance  = EXCLUDED.remaining_balance,
        payment_status     = EXCLUDED.payment_status,
        payment_intent_id  = COALESCE(EXCLUDED.payment_intent_id, bookings.payment_intent_id),
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, bookings.stripe_customer_id),
        customer_id        = COALESCE(EXCLUDED.customer_id, bookings.customer_id),
        updated_at         = now();

  -- ── 4. Insert revenue record for bk-bc8b0ddcc89e ────────────────────────────
  INSERT INTO public.revenue_records (
    booking_id, payment_intent_id, vehicle_id,
    customer_id, customer_name, customer_phone, customer_email,
    pickup_date, return_date,
    gross_amount, refund_amount,
    payment_method, payment_status, type,
    stripe_fee,
    notes
  )
  VALUES (
    'bk-bc8b0ddcc89e', 'pi_3TQwKHPo7fICjrtZ18v5heUr', 'camry2013',
    v_customer_id, 'Brandon Bookhart', '+15303285561', 'brandon.bookhart@gmail.com',
    '2026-04-27', '2026-04-28',
    60.64, 0.00,
    'stripe', 'paid', 'rental',
    NULL,   -- stripe_fee: stripe-reconcile.js will backfill after settlement
    'Full payment $60.64. 1-day rental. Backfilled via migration 0097.'
  )
  ON CONFLICT (booking_id) WHERE type = 'rental' DO UPDATE
    SET payment_intent_id = COALESCE(EXCLUDED.payment_intent_id, revenue_records.payment_intent_id),
        gross_amount      = EXCLUDED.gross_amount,
        stripe_fee        = COALESCE(EXCLUDED.stripe_fee, revenue_records.stripe_fee),
        updated_at        = now();

  -- ── 5. Insert blocked_dates for bk-bc8b0ddcc89e ─────────────────────────────
  -- Buffer: return_time 08:00 + PICKUP_BUFFER_HOURS(2) = 10:00
  INSERT INTO public.blocked_dates (
    vehicle_id, start_date, end_date, end_time, reason, booking_ref
  )
  VALUES (
    'camry2013', '2026-04-27', '2026-04-28', '10:00:00', 'booking', 'bk-bc8b0ddcc89e'
  )
  ON CONFLICT (vehicle_id, start_date, end_date, reason)
  DO UPDATE SET
    end_time    = COALESCE(EXCLUDED.end_time, blocked_dates.end_time),
    booking_ref = COALESCE(EXCLUDED.booking_ref, blocked_dates.booking_ref),
    updated_at  = now();

  -- ── 6. Remove stuck PI from reconciliation dedup state ──────────────────────
  -- Removes pi_3TQwKHPo7fICjrtZ18v5heUr from the alertedPIs map so the next
  -- cron run re-checks it and finds the revenue record inserted above (resolved).
  UPDATE public.app_config
  SET    value = (value - 'pi_3TQwKHPo7fICjrtZ18v5heUr')
  WHERE  key   = 'reconciliation_alerted_pi_ids'
    AND  value ? 'pi_3TQwKHPo7fICjrtZ18v5heUr';

END $$;


-- ===========================================================================
-- 0098_ensure_oil_check_columns.sql
-- ===========================================================================
-- =============================================================================
-- Migration 0098: Ensure oil_check columns exist on bookings table
-- =============================================================================
--
-- Migration 0079 introduced these columns but was not applied to all
-- environments.  This migration re-applies the same ALTER TABLE statements
-- using ADD COLUMN IF NOT EXISTS so it is fully idempotent and safe to run
-- on databases that already have the columns from 0079.
--
-- Safe to re-run: all statements use ADD COLUMN IF NOT EXISTS.
-- =============================================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS last_oil_check_at       timestamptz,
  ADD COLUMN IF NOT EXISTS oil_status              text,
  ADD COLUMN IF NOT EXISTS oil_check_required      boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS oil_check_last_request  timestamptz,
  ADD COLUMN IF NOT EXISTS oil_check_missed_count  integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS oil_check_photo_url     text;

DO $$ BEGIN
  ALTER TABLE bookings
    ADD CONSTRAINT bookings_oil_status_check
    CHECK (oil_status IN ('full', 'mid', 'low'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ===========================================================================
-- 0099_backfill_anthony_camry_booking.sql
-- ===========================================================================
-- Migration 0099: Backfill Anthony Johnson camry booking (bk-da88f9ade3d1)
--
-- Context:
--   A payment of $385.88 was received for camry (Camry 2012) from Anthony Johnson
--   (booking bk-da88f9ade3d1, pickup 2026-04-23 18:00, return 2026-04-30 18:00,
--    stripe_customer_id cus_UO2eMoHJZAbXQd).  The vehicle is showing as Available
--   on the website despite an active rental being in progress.
--
-- This migration:
--   1. Upserts the customer record for Anthony Johnson.
--   2. Upserts the booking as active_rental (pickup already occurred 2026-04-23).
--   3. Inserts / repairs the blocked_dates row for camry so fleet-status.js
--      immediately reflects the vehicle as unavailable (returns 2026-04-30 20:00
--      after the standard 2-hour buffer).
--
-- Safe to re-run: all writes are idempotent.

DO $$
DECLARE
  v_customer_id uuid;
BEGIN

  -- ── 1. Upsert customer: Anthony Johnson ────────────────────────────────────
  INSERT INTO public.customers (name, phone, email, updated_at)
  VALUES ('Anthony Johnson', '+12138011313', 'cheftony90@icloud.com', now())
  ON CONFLICT (phone) DO UPDATE
    SET name       = EXCLUDED.name,
        email      = COALESCE(EXCLUDED.email, customers.email),
        updated_at = now()
  RETURNING id INTO v_customer_id;

  IF v_customer_id IS NULL THEN
    SELECT id INTO v_customer_id
    FROM   public.customers
    WHERE  phone = '+12138011313';
  END IF;

  -- ── 2. Upsert booking bk-da88f9ade3d1 ──────────────────────────────────────
  -- Pickup was 18:00 on 2026-04-23 (already past), return is 2026-04-30 18:00,
  -- so status is active_rental.
  INSERT INTO public.bookings (
    booking_ref, customer_id, vehicle_id,
    pickup_date, return_date,
    pickup_time, return_time,
    status, total_price, deposit_paid, remaining_balance,
    payment_status, payment_method,
    stripe_customer_id,
    customer_name, customer_email, customer_phone,
    notes, updated_at
  )
  VALUES (
    'bk-da88f9ade3d1', v_customer_id, 'camry',
    '2026-04-23', '2026-04-30',
    '18:00:00', '18:00:00',
    'active_rental', 385.88, 385.88, 0.00,
    'paid', 'stripe',
    'cus_UO2eMoHJZAbXQd',
    'Anthony Johnson', 'cheftony90@icloud.com', '+12138011313',
    'Full payment $385.88 via Stripe. Weekly rental. Backfilled via migration 0099.',
    now()
  )
  ON CONFLICT (booking_ref) DO UPDATE
    -- Only upgrade the status; never downgrade a terminal state.
    SET status = CASE
          WHEN bookings.status IN ('cancelled', 'cancelled_rental', 'completed', 'completed_rental')
          THEN bookings.status
          ELSE 'active_rental'
        END,
        total_price        = EXCLUDED.total_price,
        deposit_paid       = EXCLUDED.deposit_paid,
        remaining_balance  = EXCLUDED.remaining_balance,
        payment_status     = EXCLUDED.payment_status,
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, bookings.stripe_customer_id),
        customer_id        = COALESCE(EXCLUDED.customer_id, bookings.customer_id),
        updated_at         = now();

  -- ── 3. Insert / repair blocked_dates for bk-da88f9ade3d1 ───────────────────
  -- Buffer: return_time 18:00 + PICKUP_BUFFER_HOURS(2) = 20:00.
  INSERT INTO public.blocked_dates (
    vehicle_id, start_date, end_date, end_time, reason, booking_ref
  )
  VALUES (
    'camry', '2026-04-23', '2026-04-30', '20:00:00', 'booking', 'bk-da88f9ade3d1'
  )
  ON CONFLICT (vehicle_id, start_date, end_date, reason)
  DO UPDATE SET
    end_time    = COALESCE(EXCLUDED.end_time,    blocked_dates.end_time),
    booking_ref = COALESCE(EXCLUDED.booking_ref, blocked_dates.booking_ref),
    updated_at  = now();

END $$;


-- ===========================================================================
-- 0100_return_booking_atomic.sql
-- ===========================================================================
-- Migration 0100: return_booking_atomic RPC
--
-- Provides a single-transaction "return booking" operation so that
-- status promotion, timestamp stamping, and blocked_dates cleanup are
-- always consistent — even if the calling Vercel function retries.
--
-- What the function does (all in one transaction):
--   1. Locks the bookings row by booking_ref (FOR UPDATE) to prevent
--      concurrent double-returns.
--   2. Validates that the booking exists and is in an active state
--      ('active_rental', 'overdue', or the legacy alias 'active').
--      Raises an exception with a clear message on any other state.
--   3. Updates the booking:
--        status            → 'completed_rental'
--        completed_at      → now()
--        actual_return_time → now()   (ISO timestamp of actual wall-clock return)
--        updated_at        → now()
--   4. Deletes all blocked_dates rows whose booking_ref matches, so
--      fleet-status.js immediately reports the vehicle as available
--      without waiting for the nightly cleanup job.
--   5. Returns a JSONB payload with the booking details for the caller
--      to confirm and log.
--
-- Idempotency: if called a second time for an already-completed booking
-- the validation guard raises EXCEPTION 'already_completed', which the
-- endpoint translates to HTTP 409 rather than 500, so retries are safe.
--
-- Safe to re-run: CREATE OR REPLACE is idempotent.

CREATE OR REPLACE FUNCTION public.return_booking_atomic(
  booking_ref_input text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_booking bookings%ROWTYPE;
BEGIN
  IF booking_ref_input IS NULL OR btrim(booking_ref_input) = '' THEN
    RAISE EXCEPTION 'booking_ref is required';
  END IF;

  -- Lock the row to prevent concurrent double-returns.
  SELECT *
  INTO   v_booking
  FROM   public.bookings
  WHERE  booking_ref = booking_ref_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found: %', booking_ref_input;
  END IF;

  -- Guard: only allow the transition from an active state.
  IF v_booking.status IN ('completed_rental', 'completed') THEN
    RAISE EXCEPTION 'already_completed';
  END IF;

  IF v_booking.status NOT IN ('active_rental', 'overdue', 'active') THEN
    RAISE EXCEPTION
      'Cannot return booking with status "%": must be active_rental, overdue, or active',
      v_booking.status;
  END IF;

  -- Mark the booking as returned.
  UPDATE public.bookings
  SET
    status             = 'completed_rental',
    completed_at       = now(),
    actual_return_time = now(),
    updated_at         = now()
  WHERE booking_ref = booking_ref_input;

  -- Release availability: delete the blocked_dates row(s) for this booking
  -- so fleet-status.js immediately shows the vehicle as available.
  DELETE FROM public.blocked_dates
  WHERE booking_ref = booking_ref_input;

  RETURN jsonb_build_object(
    'booking_ref',       v_booking.booking_ref,
    'vehicle_id',        v_booking.vehicle_id,
    'previous_status',   v_booking.status,
    'status',            'completed_rental',
    'completed_at',      now()
  );
END;
$$;


-- ===========================================================================
-- 0101_add_renter_phone.sql
-- ===========================================================================
-- migration 0101: add renter_phone as the canonical SMS phone column for bookings
--
-- Background: the existing customer_phone column was originally used for all
-- phone writes but its name conflates CRM customer data with booking-level
-- contact info.  renter_phone is the single source of truth for SMS delivery;
-- it is always the phone of the person who made the specific booking.
--
-- customer_phone is kept for backward compatibility with existing queries,
-- admin views, and revenue_records joins.  New writes should target
-- renter_phone; customer_phone will be retired in a future migration.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS renter_phone text;

-- Backfill from customer_phone for all existing rows.
UPDATE bookings
SET    renter_phone = customer_phone
WHERE  customer_phone IS NOT NULL
  AND  renter_phone  IS NULL;

-- Index so scheduled-reminders can efficiently find bookings with missing
-- renter_phone that need a Stripe fallback lookup.
CREATE INDEX IF NOT EXISTS idx_bookings_renter_phone_null
  ON bookings (status)
  WHERE renter_phone IS NULL;


-- ===========================================================================
-- 0101_sms_delivery_logs.sql
-- ===========================================================================
-- Migration 0101: SMS delivery logs table for full SMS visibility
--
-- Purpose:
-- Creates a sms_delivery_logs table that records EVERY outbound SMS attempt
-- with a status of 'sent', 'failed', or 'skipped'.  Unlike the existing
-- sms_logs dedup table, this table is append-only and is used exclusively
-- for visibility and debugging — it does NOT affect deduplication logic.
--
-- Columns:
--   booking_ref   – booking_ref (bk-...) of the affected booking
--   vehicle_id    – vehicle being rented
--   renter_phone  – E.164 recipient number (null if skipped/no phone)
--   message_type  – template key, e.g. 'late_warning_30min'
--   message_body  – rendered SMS text sent (or attempted)
--   status        – 'sent' | 'failed' | 'skipped'
--   error         – error message when status is 'failed' or 'skipped'
--   created_at    – wall-clock time of the attempt

CREATE TABLE IF NOT EXISTS sms_delivery_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref   TEXT,
  vehicle_id    TEXT,
  renter_phone  TEXT,
  message_type  TEXT,
  message_body  TEXT,
  status        TEXT        NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),   -- sent | failed | skipped
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sms_delivery_logs_created_at_idx  ON sms_delivery_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS sms_delivery_logs_booking_ref_idx ON sms_delivery_logs (booking_ref);
CREATE INDEX IF NOT EXISTS sms_delivery_logs_status_idx      ON sms_delivery_logs (status);

COMMENT ON TABLE  sms_delivery_logs IS 'Append-only SMS delivery visibility log. Every send attempt is recorded with status (sent/failed/skipped). Does not affect deduplication — see sms_logs for dedup.';
COMMENT ON COLUMN sms_delivery_logs.status IS 'sent = TextMagic accepted the message; failed = TextMagic threw an error; skipped = no phone number available.';


-- ===========================================================================
-- 0102_sms_delivery_logs_provider_id.sql
-- ===========================================================================
-- Migration 0102: Add provider_id column to sms_delivery_logs
--
-- Purpose:
-- Adds a provider_id column to capture the message/session ID returned by the
-- SMS provider (TextMagic) when a message is successfully accepted.  This
-- allows correlating delivery logs with provider dashboards and delivery
-- receipt webhooks for end-to-end traceability.
--
-- The column is nullable: 'failed' and 'skipped' rows will have NULL here;
-- 'sent' rows will carry the TextMagic session id (top-level "id" field in the
-- POST /api/v2/messages response).

ALTER TABLE sms_delivery_logs ADD COLUMN IF NOT EXISTS provider_id TEXT;

COMMENT ON COLUMN sms_delivery_logs.provider_id IS 'SMS provider message/session ID (e.g. TextMagic session id). Null for failed/skipped rows.';


-- ===========================================================================
-- 0103_ensure_sms_delivery_logs.sql
-- ===========================================================================
-- Migration 0103: Ensure sms_delivery_logs table exists (catch-up for dual-0101 conflict)
--
-- Background:
--   Two migrations were inadvertently numbered 0101:
--     0101_add_renter_phone.sql      — adds bookings.renter_phone
--     0101_sms_delivery_logs.sql     — creates the sms_delivery_logs table
--   Depending on how the migrations were applied, sms_delivery_logs may not
--   have been created in production.  0102_sms_delivery_logs_provider_id.sql
--   would also have silently failed in that case.
--
--   This migration is fully idempotent and ensures:
--     1. The sms_delivery_logs table exists with all required columns.
--     2. The provider_id column (from 0102) is present.
--     3. All indexes are created.
--
--   Safe to run even if 0101 / 0102 were already applied — every statement
--   uses CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS sms_delivery_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref   TEXT,
  vehicle_id    TEXT,
  renter_phone  TEXT,
  message_type  TEXT,
  message_body  TEXT,
  status        TEXT        NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- provider_id was added in 0102; ensure it exists here as well
ALTER TABLE sms_delivery_logs ADD COLUMN IF NOT EXISTS provider_id TEXT;

CREATE INDEX IF NOT EXISTS sms_delivery_logs_created_at_idx  ON sms_delivery_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS sms_delivery_logs_booking_ref_idx ON sms_delivery_logs (booking_ref);
CREATE INDEX IF NOT EXISTS sms_delivery_logs_status_idx      ON sms_delivery_logs (status);

COMMENT ON TABLE  sms_delivery_logs IS 'Append-only SMS delivery visibility log. Every send attempt is recorded with status (sent/failed/skipped). Does not affect deduplication — see sms_logs for dedup.';
COMMENT ON COLUMN sms_delivery_logs.status      IS 'sent = TextMagic accepted the message; failed = TextMagic threw an error; skipped = no phone number available.';
COMMENT ON COLUMN sms_delivery_logs.provider_id IS 'SMS provider message/session ID (e.g. TextMagic session id). Null for failed/skipped rows.';


-- ===========================================================================
-- 0104_ensure_renter_phone.sql
-- ===========================================================================
-- Migration 0104: Ensure bookings.renter_phone column exists (catch-up for dual-0101 conflict)
--
-- Background:
--   Two migrations were inadvertently numbered 0101:
--     0101_add_renter_phone.sql      — adds bookings.renter_phone
--     0101_sms_delivery_logs.sql     — creates the sms_delivery_logs table
--   Migration 0103 corrected the sms_delivery_logs gap.  This migration corrects
--   the renter_phone gap: if 0101_add_renter_phone.sql was not applied, the
--   bookings.renter_phone column is absent, causing the SELECT query in
--   scheduled-reminders.js loadBookingsFromSupabase() to fail (PostgreSQL error
--   42703 — undefined column), which surfaces as a 500 on /api/system-health-fix-sms.
--
--   This migration is fully idempotent — ADD COLUMN IF NOT EXISTS and
--   CREATE INDEX IF NOT EXISTS are safe to run even if 0101 was already applied.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS renter_phone text;

-- Backfill from customer_phone for rows written before this column existed.
UPDATE bookings
SET    renter_phone = customer_phone
WHERE  renter_phone IS NULL
  AND  customer_phone IS NOT NULL;

-- Partial index used by the Stripe phone back-fill logic in _booking-automation.js.
CREATE INDEX IF NOT EXISTS idx_bookings_renter_phone_null
  ON bookings (id)
  WHERE renter_phone IS NULL;

COMMENT ON COLUMN bookings.renter_phone IS
  'Canonical E.164 phone number for SMS delivery. Prefer over customer_phone. '
  'Added in migration 0101; catch-up ensured by migration 0104.';


-- ===========================================================================
-- 0104_fix_extension_revenue_orphan_and_visibility.sql
-- ===========================================================================
-- Migration 0104: fix extension revenue orphan detection and booking_revenue_grouped visibility
--
-- Problem:
--   1. checkOrphanRevenue / fixOrphanRevenue in v2-system-health.js used
--      .eq("type", "rental"), which excluded extension records entirely.
--      Extension records with a missing or stale booking_id were therefore
--      never detected or repaired, and valid extension records could never be
--      cleared if they were accidentally marked is_orphan=true.
--
--   2. Both functions queried bookings.booking_id (which does not exist on
--      the bookings table) instead of bookings.booking_ref.  When PostgREST
--      returned an error for the unknown column the fix function threw before
--      touching any rows, but when it returned empty rows (no error) ALL
--      revenue_records were considered orphans and could be flagged
--      is_orphan=true — causing them to disappear from the admin Revenue tab
--      (the list_by_booking JS fallback path filters is_orphan = false).
--
-- Fix (two passes):
--
--   Pass 1 — Unorphan valid extension records:
--     Clear is_orphan=true on any extension records whose booking_id matches
--     a real booking_ref.  These were either set by a buggy fixOrphanRevenue
--     run or by an old stripe-reconcile path.  Safe to re-run (idempotent).
--
--   Pass 2 — Unorphan valid rental records:
--     Clear is_orphan=true on any rental/other records whose booking_id
--     matches a real booking_ref (defensive repair for the bookings.booking_id
--     query bug described above).  Safe to re-run.
--
--   Pass 3 — Refresh booking_revenue_grouped view:
--     Re-create the view to ensure it explicitly includes all record types
--     (rental, extension, fee) in both the records JSONB array and the
--     gross_total sum.  The view already had no type filter on records, so
--     this is purely a documentation / defense-in-depth refresh.
--
-- Safe to re-run: UPDATE uses idempotent WHERE clause; CREATE OR REPLACE VIEW
-- is idempotent.

-- ── Pass 1: unorphan valid extension records ─────────────────────────────────

UPDATE revenue_records
SET    is_orphan  = false,
       updated_at = now()
WHERE  type        = 'extension'
  AND  is_orphan   = true
  AND  sync_excluded = false
  AND  booking_id  IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM bookings WHERE booking_ref = revenue_records.booking_id
       );

-- ── Pass 2: unorphan rental records with valid booking_ref ───────────────────
-- Repairs any rental records incorrectly flagged by the old health-check bug
-- that queried the non-existent bookings.booking_id column.

UPDATE revenue_records
SET    is_orphan  = false,
       updated_at = now()
WHERE  type        = 'rental'
  AND  is_orphan   = true
  AND  sync_excluded = false
  AND  booking_id  IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM bookings WHERE booking_ref = revenue_records.booking_id
       );

-- ── Pass 3: refresh booking_revenue_grouped view ─────────────────────────────
-- Explicitly includes ALL record types (rental + extension + fee) in both the
-- records JSONB array and the gross_total aggregation.
-- No type filter is applied to the records column — the FILTER clause on the
-- extensions column is intentional and only affects that specific column.

CREATE OR REPLACE VIEW booking_revenue_grouped AS
SELECT
  COALESCE(original_booking_id, booking_id)             AS booking_group_id,
  MAX(vehicle_id)                                        AS vehicle_id,
  MAX(customer_name)                                     AS customer_name,
  MAX(customer_phone)                                    AS customer_phone,
  MAX(customer_email)                                    AS customer_email,
  MIN(pickup_date)                                       AS min_pickup_date,
  MAX(return_date)                                       AS max_return_date,
  -- gross_total: sum ALL record types (rental + extension + fee) that are not
  -- cancelled.  Do NOT add a type filter here — extensions must be included.
  COALESCE(
    SUM(gross_amount) FILTER (WHERE is_cancelled = false),
    0
  )                                                      AS gross_total,
  COUNT(*)                                               AS record_count,
  -- records: full detail for every row in the group — rental, extension, and
  -- fee rows alike.  The frontend splits them by type after receiving this.
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                  id,
      'booking_id',          booking_id,
      'original_booking_id', original_booking_id,
      'payment_intent_id',   payment_intent_id,
      'vehicle_id',          vehicle_id,
      'customer_name',       customer_name,
      'customer_phone',      customer_phone,
      'customer_email',      customer_email,
      'pickup_date',         pickup_date,
      'return_date',         return_date,
      'gross_amount',        gross_amount,
      'deposit_amount',      deposit_amount,
      'refund_amount',       refund_amount,
      'stripe_fee',          stripe_fee,
      'stripe_net',          stripe_net,
      'payment_method',      payment_method,
      'payment_status',      payment_status,
      'type',                type,
      'is_cancelled',        is_cancelled,
      'is_no_show',          is_no_show,
      'is_orphan',           is_orphan,
      'notes',               notes,
      'created_at',          created_at,
      'updated_at',          updated_at
    )
    ORDER BY created_at ASC
  )                                                      AS records,
  -- extensions: convenience column containing only extension rows for the
  -- group (used by some API paths that prefer a pre-filtered list).
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                  id,
      'booking_id',          booking_id,
      'original_booking_id', original_booking_id,
      'payment_intent_id',   payment_intent_id,
      'vehicle_id',          vehicle_id,
      'pickup_date',         pickup_date,
      'return_date',         return_date,
      'gross_amount',        gross_amount,
      'stripe_fee',          stripe_fee,
      'payment_status',      payment_status,
      'type',                type,
      'created_at',          created_at
    )
    ORDER BY created_at ASC
  ) FILTER (WHERE type = 'extension')                    AS extensions
FROM revenue_records_effective
GROUP BY COALESCE(original_booking_id, booking_id);


-- ===========================================================================
-- 0105_delete_vehicle_vehicles.sql
-- ===========================================================================
-- Remove all vehicle vehicles from the fleet.
-- Vehicle units are no longer offered for rental.
DELETE FROM vehicles
WHERE vehicle_id LIKE 'vehicle%'
   OR (data->>'type') = 'vehicle';


-- ===========================================================================
-- 0106_clear_stale_orphan_flags.sql
-- ===========================================================================
-- Migration 0106: clear stale is_orphan=true flags on revenue_records whose
--                  booking_id now matches a real bookings.booking_ref.
--
-- Background:
--   The original health-check (check_revenue_booking_ref trigger in 0060 and
--   the fixOrphanRevenue function in v2-system-health.js) had a bug that
--   queried the non-existent bookings.booking_id column instead of
--   bookings.booking_ref.  When PostgREST returned an empty result for the
--   unknown column every revenue record appeared to have no matching booking,
--   and running "Fix Now" from the health panel flagged all of them as
--   is_orphan=true.
--
--   Migration 0104 performed a one-time repair for extension and rental records
--   created up to that point.  This migration extends the repair to ALL types
--   (including fee and any other future types) and covers records created after
--   migration 0104 that may have been incorrectly flagged by subsequent
--   executions before the JS code fix in v2-system-health.js was deployed.
--
-- Fix:
--   For every revenue_records row where:
--     • is_orphan = true
--     • sync_excluded = false
--     • booking_id IS NOT NULL
--     • booking_id matches bookings.booking_ref
--   → set is_orphan = false and update updated_at.
--
-- Safe to re-run: UPDATE uses idempotent WHERE clause; rows already set to
-- is_orphan=false are untouched.

UPDATE revenue_records
SET    is_orphan  = false,
       updated_at = now()
WHERE  is_orphan      = true
  AND  sync_excluded  = false
  AND  booking_id     IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM bookings WHERE booking_ref = revenue_records.booking_id
       );


-- ===========================================================================
-- 0107_no_synthetic_booking_ids.sql
-- ===========================================================================
-- Migration 0107: remove synthetic "stripe-pi_xxx" booking IDs from revenue_records
--                 and add a CHECK constraint to prevent them in future.
--
-- Background:
--   A previous version of stripe-reconcile.js's auto-create path used a synthetic
--   "stripe-" + payment_intent_id string as the booking_id when no real booking
--   reference could be resolved.  These synthetic strings are not valid booking_ref
--   values — they have no matching row in the bookings table — yet they are stored
--   as non-null booking_ids, bypassing the is_orphan=true escape hatch and causing:
--     1. False-positive "Orphan Revenue Records" and "Payment → No Booking" alerts
--        in System Health.
--     2. Confusion in the Revenue Tracker (rows that look linked but are not).
--   The proper escape hatch for an unresolvable payment is booking_id=NULL with
--   is_orphan=true, as used by createOrphanRevenueRecord in _booking-automation.js.
--
-- Fix — two parts:
--   1. Backfill: for every existing revenue_records row where booking_id starts
--      with 'stripe-', set booking_id=NULL and is_orphan=true so the row behaves
--      like a proper orphan record (visible in admin, excluded from aggregation).
--
--   2. Constraint: add a CHECK constraint that rejects any future INSERT or UPDATE
--      that would set booking_id to a value starting with 'stripe-'.  The constraint
--      allows NULL (legitimate orphan rows) and any other non-synthetic string.
--
-- Safe to re-run: the backfill uses a guarded WHERE clause; the constraint uses
-- ADD CONSTRAINT IF NOT EXISTS (no-op when already present).

-- ── 1. Backfill existing synthetic rows ──────────────────────────────────────
UPDATE revenue_records
SET    booking_id  = NULL,
       is_orphan   = true,
       updated_at  = now()
WHERE  booking_id  LIKE 'stripe-%'
  AND  is_orphan   = false;

-- ── 2. Block synthetic booking IDs going forward ─────────────────────────────
ALTER TABLE revenue_records
  ADD CONSTRAINT IF NOT EXISTS revenue_records_no_synthetic_booking_id
  CHECK (booking_id IS NULL OR booking_id NOT LIKE 'stripe-%');


-- ===========================================================================
-- 0108_backfill_missing_revenue_records.sql
-- ===========================================================================
-- Migration 0108: Re-run revenue_records backfill to catch bookings created
-- or updated after migration 0089 ran.
--
-- Root cause: autoCreateRevenueRecord is non-fatal in all booking creation
-- paths (add-manual-booking.js, v2-bookings.js status transitions,
-- stripe-webhook.js).  A transient DB error silently drops the revenue record
-- while the booking row is preserved, creating an invisible mismatch that the
-- existing revenue-self-heal only catches if a revenue row already exists
-- (it repairs incomplete rows, but can't see rows that were never created).
--
-- Invariant: every booking with deposit_paid > 0 that is not cancelled must
-- have exactly one revenue_records row with type = 'rental'.
--
-- Cash/manual bookings (payment_method IN ('cash','zelle','venmo','manual',
-- 'external')) receive stripe_fee = 0, stripe_net = gross_amount immediately
-- so analytics are correct without needing a Stripe reconciliation pass.
-- All other bookings receive stripe_fee = NULL / stripe_net = NULL, to be
-- filled in later by stripe-reconcile.js.
--
-- Safe to re-run: the NOT EXISTS guards + ON CONFLICT DO NOTHING make this
-- fully idempotent.

INSERT INTO revenue_records (
  booking_id,
  payment_intent_id,
  vehicle_id,
  pickup_date,
  return_date,
  gross_amount,
  deposit_amount,
  refund_amount,
  payment_method,
  payment_status,
  type,
  is_no_show,
  is_cancelled,
  override_by_admin,
  stripe_fee,
  stripe_net
)
SELECT
  b.booking_ref,
  b.payment_intent_id,
  b.vehicle_id,
  b.pickup_date,
  b.return_date,
  b.deposit_paid                         AS gross_amount,
  0                                      AS deposit_amount,
  0                                      AS refund_amount,
  COALESCE(b.payment_method, 'stripe')   AS payment_method,
  'paid'                                 AS payment_status,
  'rental'                               AS type,
  false                                  AS is_no_show,
  false                                  AS is_cancelled,
  false                                  AS override_by_admin,
  -- Cash/offline payments: fee = 0, net = gross (no Stripe involvement)
  CASE
    WHEN LOWER(COALESCE(b.payment_method, '')) IN ('cash', 'zelle', 'venmo', 'manual', 'external')
      THEN 0
    ELSE NULL
  END                                    AS stripe_fee,
  CASE
    WHEN LOWER(COALESCE(b.payment_method, '')) IN ('cash', 'zelle', 'venmo', 'manual', 'external')
      THEN b.deposit_paid
    ELSE NULL
  END                                    AS stripe_net
FROM bookings b
WHERE
  -- Only bookings where money was actually collected
  b.deposit_paid > 0
  -- Skip cancelled bookings
  AND b.status NOT IN ('cancelled', 'cancelled_rental')
  -- Skip if a rental revenue record already exists for this booking
  AND NOT EXISTS (
    SELECT 1
    FROM   revenue_records rr
    WHERE  rr.booking_id = b.booking_ref
      AND  rr.type = 'rental'
  )
  -- Skip if the booking's payment_intent_id is already covered by another
  -- revenue row (e.g. an orphan record or a differently-keyed row created
  -- by stripe-reconcile before the booking was linked).
  AND (
    b.payment_intent_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM   revenue_records rr2
      WHERE  rr2.payment_intent_id = b.payment_intent_id
    )
  )
ON CONFLICT DO NOTHING;


-- ===========================================================================
-- 0109_delete_vehicle_settings.sql
-- ===========================================================================
-- Remove all Vehicle-related entries from system_settings.
-- The Vehicle is no longer offered for rental.
DELETE FROM system_settings
WHERE key LIKE 'vehicle%';


-- ===========================================================================
-- 0110_sync_revenue_vehicle_id.sql
-- ===========================================================================
-- Migration 0110: Normalise legacy "camry2012" vehicle_id to canonical "camry"
--                 across ALL tables that carry a vehicle_id column.
--
-- Background:
--   Before normalisation was enforced in the application layer, the Stripe webhook
--   derived a vehicle_id from the payment metadata vehicle_name ("Camry 2012") and
--   stored it verbatim as "camry2012".  Migration 0092 already normalised
--   revenue_records, but the bookings, blocked_dates, and expenses tables were
--   not updated at that time.
--
--   The canonical vehicle_id for Camry 2012 is "camry" (as registered in the
--   vehicles table and in _pricing.js CARS).  There is NO "camry2012" entry in the
--   vehicles table.  All code now uses FLEET_VEHICLE_IDS = ['camry', 'camry2013'],
--   so any row still holding "camry2012" is invisible to filters and aggregations.
--
-- Fix:
--   Update every table where vehicle_id = 'camry2012' → 'camry'.
--   The WHERE clause is a no-op when no stale rows exist, so this migration is
--   safe to re-run.

-- ── bookings ──────────────────────────────────────────────────────────────────
UPDATE bookings
SET    vehicle_id = 'camry',
       updated_at = now()
WHERE  vehicle_id = 'camry2012';

-- ── revenue_records ──────────────────────────────────────────────────────────
-- 0092 already normalised most rows; this catches any that were re-introduced.
UPDATE revenue_records
SET    vehicle_id = 'camry',
       updated_at = now()
WHERE  vehicle_id = 'camry2012';

-- ── blocked_dates ────────────────────────────────────────────────────────────
UPDATE blocked_dates
SET    vehicle_id = 'camry'
WHERE  vehicle_id = 'camry2012';

-- ── expenses ─────────────────────────────────────────────────────────────────
UPDATE expenses
SET    vehicle_id = 'camry'
WHERE  vehicle_id = 'camry2012';


-- ===========================================================================
-- 0111_fix_blocked_dates_trigger.sql
-- ===========================================================================
-- Migration 0111: Fix on_booking_create trigger — pass booking_ref to blocked_dates
--                 and make the insert non-blocking.
--
-- Root cause:
--   The on_booking_create trigger fires AFTER INSERT on bookings and inserts into
--   blocked_dates WITHOUT booking_ref.  If booking_ref has a NOT NULL constraint the
--   trigger raises an exception and PostgreSQL rolls back the entire booking INSERT —
--   no booking row is saved, no revenue record is created.
--
-- Fix:
--   1. Pass NEW.booking_ref to the blocked_dates INSERT so the row is fully populated.
--   2. Wrap the blocked_dates INSERT in an EXCEPTION handler so any future constraint
--      failure (NOT NULL, overlap, FK) is emitted as a WARNING and never aborts the
--      parent booking transaction.  Revenue and booking persistence are unaffected.

CREATE OR REPLACE FUNCTION public.on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Block the vehicle dates for this booking period.
  -- Always pass booking_ref so the row satisfies any NOT NULL constraint.
  -- Wrapped in EXCEPTION so a blocked_dates failure NEVER rolls back the booking INSERT.
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status NOT IN ('cancelled') THEN
    BEGIN
      INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason, booking_ref)
      VALUES (NEW.vehicle_id, NEW.pickup_date, NEW.return_date, 'booking', NEW.booking_ref)
      ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'on_booking_create: blocked_dates insert failed for booking_ref=% (non-fatal): %',
        NEW.booking_ref, SQLERRM;
    END;
  END IF;

  -- Auto-create a revenue row when the booking has a price.
  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0)
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  -- Sync vehicle rental_status based on initial status.
  CASE NEW.status
    WHEN 'approved' THEN UPDATE vehicles SET rental_status = 'reserved' WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'active'   THEN UPDATE vehicles SET rental_status = 'rented'   WHERE vehicle_id = NEW.vehicle_id;
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;


-- ===========================================================================
-- 0112_harden_blocked_dates_trigger.sql
-- ===========================================================================
-- Migration 0112: Harden on_booking_create trigger — explicit booking_ref guard
--
-- The previous migration (0111) wrapped the blocked_dates INSERT in an
-- EXCEPTION handler so any constraint failure is demoted to a WARNING and the
-- booking transaction is never aborted.  This migration adds an explicit guard
-- *before* the INSERT that fires when NEW.booking_ref IS NULL, producing a
-- clear, actionable error message instead of a cryptic NOT-NULL constraint
-- message from Postgres.
--
-- Because the guard is placed INSIDE the existing BEGIN ... EXCEPTION block,
-- the RAISE EXCEPTION is caught by EXCEPTION WHEN OTHERS and re-emitted as a
-- RAISE WARNING — so the booking INSERT still succeeds even in this degenerate
-- case, which should never occur given the server-side pre-write in
-- create-payment-intent.js.

CREATE OR REPLACE FUNCTION public.on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Block the vehicle dates for this booking period.
  -- Always pass booking_ref so the row satisfies any NOT NULL constraint.
  -- The inner BEGIN/EXCEPTION block ensures a blocked_dates failure NEVER
  -- rolls back the parent booking INSERT.
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status NOT IN ('cancelled') THEN
    BEGIN
      -- Guard: booking_ref must be present.  RAISE EXCEPTION here so the error
      -- message is clear; it will be caught below and re-emitted as a WARNING.
      IF NEW.booking_ref IS NULL THEN
        RAISE EXCEPTION
          'on_booking_create: booking_ref is NULL for booking id=% — blocked_dates insert skipped',
          NEW.id;
      END IF;

      INSERT INTO blocked_dates (vehicle_id, start_date, end_date, reason, booking_ref)
      VALUES (NEW.vehicle_id, NEW.pickup_date, NEW.return_date, 'booking', NEW.booking_ref)
      ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'on_booking_create: blocked_dates insert failed for booking_ref=% (non-fatal): %',
        NEW.booking_ref, SQLERRM;
    END;
  END IF;

  -- Auto-create a revenue row when the booking has a price.
  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0)
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  -- Sync vehicle rental_status based on initial status.
  CASE NEW.status
    WHEN 'approved' THEN UPDATE vehicles SET rental_status = 'reserved' WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'active'   THEN UPDATE vehicles SET rental_status = 'rented'   WHERE vehicle_id = NEW.vehicle_id;
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;


-- ===========================================================================
-- 0113_ensure_late_fee_amount.sql
-- ===========================================================================
-- Migration 0113: Ensure bookings.late_fee_amount column exists (catch-up for migration ordering gap)
--
-- Background:
--   Migration 0075 (0075_late_fee_approval_tracking.sql) defines bookings.late_fee_amount
--   as numeric(10,2).  However, the duplicate-numbered 0104 files
--   (0104_ensure_renter_phone.sql and 0104_fix_extension_revenue_orphan_and_visibility.sql)
--   introduced an ordering ambiguity in some deployment environments that could cause 0075
--   to be skipped or applied out-of-sequence, leaving bookings.late_fee_amount absent.
--
--   scheduled-reminders.js writes late_fee_amount to the bookings table when a late fee
--   is assessed (see loadBookingsFromSupabase SELECT list and the pending_approval write
--   block).  If the column is missing, the SELECT query returns PostgreSQL error 42703
--   (undefined column), surfacing as a 500 on /api/system-health-fix-sms.
--
--   This migration is fully idempotent — ADD COLUMN IF NOT EXISTS is safe to run even
--   if 0075 was already applied.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS late_fee_amount      numeric(10,2),
  ADD COLUMN IF NOT EXISTS late_fee_status      text
    CHECK (late_fee_status IN ('pending_approval','approved','dismissed','failed','paid')),
  ADD COLUMN IF NOT EXISTS late_fee_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_fee_approved_by text;

-- Partial index used by the late-fee approval flow.
CREATE INDEX IF NOT EXISTS bookings_late_fee_status_idx
  ON bookings (late_fee_status)
  WHERE late_fee_status IS NOT NULL;

COMMENT ON COLUMN bookings.late_fee_amount IS
  'Assessed late-fee amount in USD, set when late_fee_status is first written. '
  'Originally added in migration 0075; catch-up ensured by migration 0113.';
COMMENT ON COLUMN bookings.late_fee_status IS
  'Tracks where the late-fee approval stands: pending_approval → approved/dismissed/failed/paid. '
  'Originally added in migration 0075; catch-up ensured by migration 0113.';
COMMENT ON COLUMN bookings.late_fee_approved_at IS
  'Timestamp when admin approved or dismissed the late fee.';
COMMENT ON COLUMN bookings.late_fee_approved_by IS
  'Who actioned the approval: admin_link | admin_panel | ai.';


-- ===========================================================================
-- 0114_fix_blocked_dates_end_time_trigger.sql
-- ===========================================================================
-- Migration 0114: Fix on_booking_create trigger to include end_time;
--                 heal existing blocked_dates rows missing end_time.
--
-- Root cause of "return time not showing on cars page":
--   The on_booking_create DB trigger (migration 0112) inserts a blocked_dates
--   row without the end_time column.  Migration 0094 added end_time and
--   backfilled rows that existed at that time, but every booking created after
--   0094 gets a trigger-created row with end_time = NULL.  The app-side
--   autoCreateBlockedDate used ignoreDuplicates:true, so it never patched those
--   rows.  fleet-status.js only sets available_at (and includes the time in
--   "Next Available") when end_time is non-null.
--
-- Fix:
--   1. Update on_booking_create to compute buffered end_date + end_time from
--      the booking's return_date and return_time (buffer = 2 hours, matching
--      BOOKING_BUFFER_HOURS in _booking-automation.js).
--      Uses UPDATE-by-booking_ref then INSERT (rather than INSERT + ON CONFLICT
--      DO UPDATE on the composite key) so the logic is correct even when the
--      2-hour buffer shifts end_date across midnight.
--   2. Backfill all existing blocked_dates rows that still have end_time = NULL
--      using the same 2-hour buffered logic as migration 0094.

-- ── 1. Replace on_booking_create trigger ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_end_date DATE;
  v_end_time TIME;
BEGIN
  -- Block the vehicle dates for this booking period.
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status NOT IN ('cancelled') THEN
    BEGIN
      -- Guard: booking_ref must be present.
      IF NEW.booking_ref IS NULL THEN
        RAISE EXCEPTION
          'on_booking_create: booking_ref is NULL for booking id=% — blocked_dates insert skipped',
          NEW.id;
      END IF;

      -- Compute buffered end_date + end_time (return_time + 2-hour buffer).
      -- The 2-hour buffer gives the owner preparation time between rentals and
      -- matches BOOKING_BUFFER_HOURS in api/_booking-automation.js.
      IF NEW.return_time IS NOT NULL THEN
        v_end_date := (NEW.return_date::TIMESTAMP + NEW.return_time::INTERVAL + INTERVAL '2 hours')::DATE;
        v_end_time := (NEW.return_date::TIMESTAMP + NEW.return_time::INTERVAL + INTERVAL '2 hours')::TIME;
      ELSE
        v_end_date := NEW.return_date;
        v_end_time := NULL;
      END IF;

      -- First try to patch an existing row by booking_ref (idempotent self-heal).
      -- This avoids the end_date mismatch that would occur with the composite
      -- (vehicle_id, start_date, end_date, reason) conflict key when the 2-hour
      -- buffer shifts end_date across midnight.
      UPDATE blocked_dates
      SET end_date = v_end_date,
          end_time = v_end_time
      WHERE vehicle_id  = NEW.vehicle_id
        AND booking_ref = NEW.booking_ref
        AND reason      = 'booking'
        -- OR: update if either field differs — both are always written together
        AND (end_time IS DISTINCT FROM v_end_time OR end_date IS DISTINCT FROM v_end_date);

      -- If no existing row was updated, insert a new one.
      -- This is the normal path: the trigger fires on the first INSERT of a
      -- new booking, before any blocked_dates row exists for it.
      IF NOT FOUND THEN
        INSERT INTO blocked_dates (vehicle_id, start_date, end_date, end_time, reason, booking_ref)
        VALUES (NEW.vehicle_id, NEW.pickup_date, v_end_date, v_end_time, 'booking', NEW.booking_ref)
        ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'on_booking_create: blocked_dates insert failed for booking_ref=% (non-fatal): %',
        NEW.booking_ref, SQLERRM;
    END;
  END IF;

  -- Auto-create a revenue row when the booking has a price.
  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0)
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  -- Sync vehicle rental_status based on initial status.
  CASE NEW.status
    WHEN 'approved' THEN UPDATE vehicles SET rental_status = 'reserved' WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'active'   THEN UPDATE vehicles SET rental_status = 'rented'   WHERE vehicle_id = NEW.vehicle_id;
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;

-- ── 2. Backfill existing blocked_dates rows with null end_time ─────────────
-- For booking-type rows: compute buffered end_date + end_time from the linked
-- booking's return_time.  Update both end_date (handles midnight-crossing
-- buffer) and end_time.  Matches the logic in the updated trigger above.
UPDATE public.blocked_dates bd
SET
  end_date = (
    b.return_date::TIMESTAMP + b.return_time::INTERVAL + INTERVAL '2 hours'
  )::DATE,
  end_time = (
    b.return_date::TIMESTAMP + b.return_time::INTERVAL + INTERVAL '2 hours'
  )::TIME
FROM public.bookings b
WHERE bd.booking_ref = b.booking_ref
  AND bd.reason      = 'booking'
  AND bd.end_time    IS NULL
  AND b.return_time  IS NOT NULL;

-- Any remaining booking rows without a matching bookings.return_time: apply
-- the safe default (DEFAULT_RETURN_TIME "10:00" + 2-hour buffer = 12:00).
UPDATE public.blocked_dates
SET end_time = '12:00:00'::TIME
WHERE reason   = 'booking'
  AND end_time IS NULL;


-- ===========================================================================
-- 0115_add_balance_due.sql
-- ===========================================================================
-- Migration 0115: add balance_due to bookings
-- balance_due stores the outstanding unpaid amount when a Stripe payment fails.
-- A non-zero balance_due blocks the customer from making new bookings until cleared.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_due NUMERIC DEFAULT 0;

COMMENT ON COLUMN bookings.balance_due IS
  'Outstanding unpaid amount (USD) after a failed Stripe payment. '
  'A non-zero value blocks the customer from creating new bookings. '
  'Cleared to 0 when the balance is successfully paid.';


-- ===========================================================================
-- 0116_late_fee_waiver.sql
-- ===========================================================================
-- Migration 0116: add late-fee waiver fields to bookings
-- These fields store the full audit trail for an admin-applied waiver so that
-- revenue accounting stays accurate and every waiver is traceable.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_fee_waived        BOOLEAN   DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_fee_waived_amount NUMERIC   DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_fee_waived_reason TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_fee_waived_by     TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_fee_waived_at     TIMESTAMPTZ;

COMMENT ON COLUMN bookings.late_fee_waived        IS 'True when an admin has applied a full or partial waiver to the late fee.';
COMMENT ON COLUMN bookings.late_fee_waived_amount IS 'USD amount waived.  For a full waiver this equals the full penalty; for a partial waiver it is the custom amount.';
COMMENT ON COLUMN bookings.late_fee_waived_reason IS 'Mandatory reason supplied by the admin (e.g. "accident", "emergency").';
COMMENT ON COLUMN bookings.late_fee_waived_by     IS 'Admin identifier who applied the waiver.';
COMMENT ON COLUMN bookings.late_fee_waived_at     IS 'Timestamp when the waiver was applied.';


-- ===========================================================================
-- 0117_rental_balance_waiver.sql
-- ===========================================================================
-- Migration 0117: add rental-balance waiver fields to bookings
-- Mirrors the late_fee_waived* pattern so admins can waive the remaining
-- base-rental balance in addition to (or instead of) the late-fee penalty.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_balance_waived        BOOLEAN     DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_balance_waived_amount NUMERIC     DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_balance_waived_reason TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_balance_waived_by     TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rental_balance_waived_at     TIMESTAMPTZ;

COMMENT ON COLUMN bookings.rental_balance_waived        IS 'True when an admin has applied a full or partial waiver to the remaining rental balance.';
COMMENT ON COLUMN bookings.rental_balance_waived_amount IS 'USD amount waived from the remaining balance. For a full waiver this equals the remaining_balance at the time of waiver; for a partial waiver it is the custom amount.';
COMMENT ON COLUMN bookings.rental_balance_waived_reason IS 'Mandatory reason supplied by the admin (e.g. "accident", "financial hardship").';
COMMENT ON COLUMN bookings.rental_balance_waived_by     IS 'Admin identifier who applied the waiver.';
COMMENT ON COLUMN bookings.rental_balance_waived_at     IS 'Timestamp when the waiver was applied.';



-- ===========================================================================
-- 0121_fix_extension_grouping.sql
-- ===========================================================================
-- Migration 0121: fix extension revenue record grouping in Revenue Tracker
--
-- Extension records were showing as standalone rows instead of collapsing under
-- their parent booking.  The booking_revenue_grouped view uses
-- COALESCE(original_booking_id, booking_id) as the group key.  Records where
-- original_booking_id is a stale/incorrect value (PI id, different booking ref,
-- etc.) cause COALESCE to pick the wrong key, creating a phantom group.
-- Migrations 0084/0085 fixed cases where booking_id was wrong; this migration
-- fixes the inverse: booking_id is correct but original_booking_id differs.
--
-- Pass 1: align original_booking_id with booking_id for mismatched extensions.
-- Pass 2: refresh booking_revenue_grouped view with booking_id-first COALESCE.

UPDATE revenue_records
SET    original_booking_id = booking_id,
       updated_at          = now()
WHERE  type              = 'extension'
  AND  sync_excluded     = false
  AND  is_orphan         = false
  AND  booking_id          IS NOT NULL
  AND  original_booking_id IS DISTINCT FROM booking_id
  AND  EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.booking_id
       );

CREATE OR REPLACE VIEW booking_revenue_grouped AS
SELECT
  COALESCE(booking_id, original_booking_id)             AS booking_group_id,
  MAX(vehicle_id)                                        AS vehicle_id,
  MAX(customer_name)                                     AS customer_name,
  MAX(customer_phone)                                    AS customer_phone,
  MAX(customer_email)                                    AS customer_email,
  MIN(pickup_date)                                       AS min_pickup_date,
  MAX(return_date)                                       AS max_return_date,
  COALESCE(
    SUM(gross_amount) FILTER (WHERE is_cancelled = false),
    0
  )                                                      AS gross_total,
  COUNT(*)                                               AS record_count,
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                  id,
      'booking_id',          booking_id,
      'original_booking_id', original_booking_id,
      'payment_intent_id',   payment_intent_id,
      'vehicle_id',          vehicle_id,
      'customer_name',       customer_name,
      'customer_phone',      customer_phone,
      'customer_email',      customer_email,
      'pickup_date',         pickup_date,
      'return_date',         return_date,
      'gross_amount',        gross_amount,
      'deposit_amount',      deposit_amount,
      'refund_amount',       refund_amount,
      'stripe_fee',          stripe_fee,
      'stripe_net',          stripe_net,
      'payment_method',      payment_method,
      'payment_status',      payment_status,
      'type',                type,
      'is_cancelled',        is_cancelled,
      'is_no_show',          is_no_show,
      'is_orphan',           is_orphan,
      'notes',               notes,
      'created_at',          created_at,
      'updated_at',          updated_at
    )
    ORDER BY created_at ASC
  )                                                      AS records,
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                  id,
      'booking_id',          booking_id,
      'original_booking_id', original_booking_id,
      'payment_intent_id',   payment_intent_id,
      'vehicle_id',          vehicle_id,
      'pickup_date',         pickup_date,
      'return_date',         return_date,
      'gross_amount',        gross_amount,
      'stripe_fee',          stripe_fee,
      'payment_status',      payment_status,
      'type',                type,
      'created_at',          created_at
    )
    ORDER BY created_at ASC
  ) FILTER (WHERE type = 'extension')                    AS extensions
FROM revenue_records_effective
GROUP BY COALESCE(booking_id, original_booking_id);


-- ===========================================================================
-- 0122_revenue_records_booking_ref_column.sql
-- ===========================================================================
-- Migration 0122: add booking_ref column to revenue_records
--
-- Root cause
-- ----------
-- revenue_records has a booking_ref column in production (added outside the
-- repo's migration history) with a NOT NULL constraint.  autoCreateRevenueRecord
-- and upsert_booking_revenue_atomic never set this column, so every INSERT fails
-- with:
--   null value in column "booking_ref" of relation "revenue_records"
-- This is the reason extension revenue records have NEVER been successfully
-- written by the automated pipeline.
--
-- Fix: add booking_ref column IF NOT EXISTS, backfill from booking_id,
-- update the upsert RPC to set it.

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS booking_ref text REFERENCES bookings(booking_ref) ON DELETE SET NULL;

COMMENT ON COLUMN revenue_records.booking_ref IS
  'FK to bookings.booking_ref — mirrors booking_id for joined queries. '
  'NULL only for orphan records (is_orphan = true).';

UPDATE revenue_records rr
SET    booking_ref = rr.booking_id
WHERE  rr.booking_ref IS NULL
  AND  rr.booking_id IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM bookings b WHERE b.booking_ref = rr.booking_id
       );

CREATE INDEX IF NOT EXISTS revenue_records_booking_ref_idx
  ON revenue_records (booking_ref)
  WHERE booking_ref IS NOT NULL;
-- ── 4. Update upsert_booking_revenue_atomic to set booking_ref ────────────────
-- Re-creates the latest version of the function (same as migration 0118) with
-- booking_ref added to the revenue_records INSERT and ON CONFLICT SET clause.

CREATE OR REPLACE FUNCTION public.upsert_booking_revenue_atomic(
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_booking_ref text,
  p_vehicle_id text,
  p_pickup_date date,
  p_return_date date,
  p_pickup_time time,
  p_return_time time,
  p_status text,
  p_total_price numeric,
  p_deposit_paid numeric,
  p_remaining_balance numeric,
  p_payment_status text,
  p_notes text,
  p_payment_method text,
  p_payment_intent_id text,
  p_stripe_customer_id text,
  p_stripe_payment_method_id text,
  p_booking_customer_email text,
  p_activated_at timestamptz,
  p_completed_at timestamptz,
  p_revenue_vehicle_id text,
  p_revenue_customer_name text,
  p_revenue_customer_phone text,
  p_revenue_customer_email text,
  p_revenue_pickup_date date,
  p_revenue_return_date date,
  p_gross_amount numeric,
  p_stripe_fee numeric,
  p_payment_intent_id_revenue text,
  p_refund_amount numeric,
  p_revenue_payment_method text,
  p_revenue_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_customer_id uuid;
  v_booking_id uuid;
  v_revenue_id uuid;
  v_revenue_payment_intent text;
BEGIN
  IF p_booking_ref IS NULL OR btrim(p_booking_ref) = '' THEN
    RAISE EXCEPTION 'booking_ref is required';
  END IF;

  IF p_revenue_vehicle_id IS NULL OR btrim(p_revenue_vehicle_id) = '' THEN
    RAISE EXCEPTION 'revenue vehicle_id is required';
  END IF;

  -- Customer dedupe: email-first (primary identity), then phone fallback.
  IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE lower(c.email) = lower(p_customer_email)
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE c.phone = p_customer_phone
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND (
    (p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '') OR
    (p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '')
  ) THEN
    BEGIN
      INSERT INTO customers (
        name, phone, email, updated_at
      ) VALUES (
        COALESCE(NULLIF(p_customer_name, ''), 'Unknown'),
        NULLIF(p_customer_phone, ''),
        NULLIF(lower(p_customer_email), ''),
        now()
      )
      RETURNING id INTO v_customer_id;
    EXCEPTION
      WHEN unique_violation THEN
        IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE lower(c.email) = lower(p_customer_email)
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE c.phone = p_customer_phone
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL THEN
          RAISE;
        END IF;
    END;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET
      name = COALESCE(NULLIF(p_customer_name, ''), customers.name),
      phone = COALESCE(NULLIF(p_customer_phone, ''), customers.phone),
      email = COALESCE(NULLIF(lower(p_customer_email), ''), customers.email),
      updated_at = now()
    WHERE id = v_customer_id;
  END IF;

  INSERT INTO bookings (
    booking_ref,
    customer_id,
    vehicle_id,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    status,
    total_price,
    deposit_paid,
    remaining_balance,
    payment_status,
    notes,
    payment_method,
    payment_intent_id,
    stripe_customer_id,
    stripe_payment_method_id,
    customer_email,
    activated_at,
    completed_at
  ) VALUES (
    p_booking_ref,
    v_customer_id,
    p_vehicle_id,
    p_pickup_date,
    p_return_date,
    p_pickup_time,
    p_return_time,
    COALESCE(NULLIF(p_status, ''), 'pending'),
    COALESCE(p_total_price, 0),
    COALESCE(p_deposit_paid, 0),
    COALESCE(p_remaining_balance, 0),
    COALESCE(NULLIF(p_payment_status, ''), 'unpaid'),
    p_notes,
    p_payment_method,
    p_payment_intent_id,
    p_stripe_customer_id,
    p_stripe_payment_method_id,
    p_booking_customer_email,
    p_activated_at,
    p_completed_at
  )
  ON CONFLICT (booking_ref) DO UPDATE
  SET
    customer_id = EXCLUDED.customer_id,
    vehicle_id = EXCLUDED.vehicle_id,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    pickup_time = EXCLUDED.pickup_time,
    return_time = EXCLUDED.return_time,
    status = EXCLUDED.status,
    total_price = EXCLUDED.total_price,
    deposit_paid = EXCLUDED.deposit_paid,
    remaining_balance = EXCLUDED.remaining_balance,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    payment_method = EXCLUDED.payment_method,
    payment_intent_id = EXCLUDED.payment_intent_id,
    stripe_customer_id       = COALESCE(NULLIF(EXCLUDED.stripe_customer_id, ''),       bookings.stripe_customer_id),
    stripe_payment_method_id = COALESCE(NULLIF(EXCLUDED.stripe_payment_method_id, ''), bookings.stripe_payment_method_id),
    customer_email = EXCLUDED.customer_email,
    activated_at = COALESCE(EXCLUDED.activated_at, bookings.activated_at),
    completed_at = COALESCE(EXCLUDED.completed_at, bookings.completed_at),
    updated_at = now()
  RETURNING id INTO v_booking_id;

  INSERT INTO revenue_records (
    booking_id,
    booking_ref,
    payment_intent_id,
    vehicle_id,
    customer_id,
    customer_name,
    customer_phone,
    customer_email,
    pickup_date,
    return_date,
    gross_amount,
    refund_amount,
    payment_method,
    payment_status,
    type,
    notes,
    stripe_fee
  ) VALUES (
    p_booking_ref,              -- booking_id
    p_booking_ref,              -- booking_ref (FK mirror of booking_id)
    p_payment_intent_id_revenue,
    p_revenue_vehicle_id,
    v_customer_id,
    p_revenue_customer_name,
    p_revenue_customer_phone,
    p_revenue_customer_email,
    p_revenue_pickup_date,
    p_revenue_return_date,
    COALESCE(p_gross_amount, 0),
    COALESCE(p_refund_amount, 0),
    COALESCE(NULLIF(p_revenue_payment_method, ''), 'stripe'),
    'paid',
    'rental',
    p_revenue_notes,
    p_stripe_fee
  )
  ON CONFLICT (booking_id) WHERE type = 'rental' DO UPDATE
  SET
    booking_ref = EXCLUDED.booking_ref,
    payment_intent_id = EXCLUDED.payment_intent_id,
    vehicle_id = EXCLUDED.vehicle_id,
    customer_id = EXCLUDED.customer_id,
    customer_name = EXCLUDED.customer_name,
    customer_phone = EXCLUDED.customer_phone,
    customer_email = EXCLUDED.customer_email,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    gross_amount = EXCLUDED.gross_amount,
    refund_amount = EXCLUDED.refund_amount,
    payment_method = EXCLUDED.payment_method,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    stripe_fee = COALESCE(EXCLUDED.stripe_fee, revenue_records.stripe_fee),
    updated_at = now()
  RETURNING id, payment_intent_id
  INTO v_revenue_id, v_revenue_payment_intent;

  IF v_revenue_payment_intent IS NULL OR btrim(v_revenue_payment_intent) = '' THEN
    RAISE EXCEPTION 'revenue record incomplete after upsert for booking_ref=%', p_booking_ref;
  END IF;

  RETURN jsonb_build_object(
    'booking_id', v_booking_id,
    'customer_id', v_customer_id,
    'revenue_id', v_revenue_id,
    'revenue_complete', true
  );
END;
$$;


-- ===========================================================================
-- 0123_revenue_records_booking_ref_check_constraint.sql
-- ===========================================================================
-- Migration 0123: replace bare NOT NULL on revenue_records.booking_ref with
--                 a precise CHECK constraint
--
-- Replace the bare NOT NULL with a CHECK constraint that encodes the exact
-- business rule:
--   Non-orphan rows MUST have a booking_ref.
--   Orphan rows (is_orphan = true) are explicitly exempt.
--   CHECK (is_orphan = true OR booking_ref IS NOT NULL)
--
-- Safe to re-run: DROP NOT NULL is idempotent; ADD CONSTRAINT uses IF NOT EXISTS.

ALTER TABLE revenue_records
  ALTER COLUMN booking_ref DROP NOT NULL;

ALTER TABLE revenue_records
  ADD CONSTRAINT IF NOT EXISTS revenue_records_booking_ref_required
    CHECK (is_orphan = true OR booking_ref IS NOT NULL);

COMMENT ON COLUMN revenue_records.booking_ref IS
  'FK to bookings.booking_ref — mirrors booking_id for joined queries. '
  'NULL is permitted ONLY when is_orphan = true '
  '(enforced by revenue_records_booking_ref_required CHECK constraint). '
  'Non-orphan rows must always supply a valid booking_ref.';


-- ===========================================================================
-- 0124_remove_phantom_vehicles.sql
-- ===========================================================================
--
-- Root cause: the dashboard's "Available Vehicles" KPI was showing 3 instead of 2.
-- The canonical fleet is exactly two vehicles: "camry" and "camry2013".
-- Extra rows (e.g. a legacy "camry2012" alias, leftover vehicle entries, or a
-- test vehicle created via the admin UI) can survive in the Supabase vehicles table
-- if they were added before migration 0105 (vehicle deletion) or inserted by the
-- admin panel when the GitHub vehicles.json save failed.
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
WHERE vehicle_id NOT IN ('camry', 'camry2013')
  AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );

-- Step 2: soft-delete (set status = 'inactive') for any remaining non-canonical
-- rows that still have booking history and therefore cannot be hard-deleted.
UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{status}', '"inactive"')
WHERE vehicle_id NOT IN ('camry', 'camry2013')
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );


-- ===========================================================================
-- 0125_site_settings_hero_image_url.sql
-- ===========================================================================
-- add hero_image_url to site_settings

INSERT INTO site_settings (key, value, updated_at)
VALUES ('hero_image_url', '', NOW())
ON CONFLICT (key) DO NOTHING;


-- ===========================================================================
-- 0126_expense_categories.sql
-- ===========================================================================
-- Upgrades expense categories to a two-level hierarchy stored in a dedicated
-- table, and adds a nullable category_id FK to expenses.

-- ── 1. expense_categories table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_categories (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  group_name  text        NOT NULL,
  is_default  boolean     NOT NULL DEFAULT false,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, group_name)
);

CREATE INDEX IF NOT EXISTS expense_categories_group_idx  ON expense_categories (group_name);
CREATE INDEX IF NOT EXISTS expense_categories_active_idx ON expense_categories (is_active);

-- ── 2. Default categories ─────────────────────────────────────────────────────
INSERT INTO expense_categories (name, group_name, is_default, is_active) VALUES
  ('Loan / Lease',          'Ownership',   true, true),
  ('Insurance',             'Ownership',   true, true),
  ('Registration',          'Ownership',   true, true),
  ('Taxes',                 'Ownership',   true, true),
  ('Fuel',                  'Usage',       true, true),
  ('EV Charging',           'Usage',       true, true),
  ('Parking',               'Usage',       true, true),
  ('Tolls',                 'Usage',       true, true),
  ('Oil Change',            'Maintenance', true, true),
  ('Tires',                 'Maintenance', true, true),
  ('Brakes',                'Maintenance', true, true),
  ('Fluids',                'Maintenance', true, true),
  ('Filters',               'Maintenance', true, true),
  ('Battery',               'Maintenance', true, true),
  ('Inspection / Emissions','Maintenance', true, true),
  ('Repair (General)',      'Repairs',     true, true),
  ('Parts',                 'Repairs',     true, true),
  ('Labor',                 'Repairs',     true, true),
  ('Diagnostics',           'Repairs',     true, true),
  ('Car Wash',              'Cleaning',    true, true),
  ('Detailing',             'Cleaning',    true, true),
  ('Accessories',           'Extras',      true, true),
  ('Mods / Upgrades',       'Extras',      true, true),
  ('Subscriptions',         'Extras',      true, true),
  ('Fines / Tickets',       'Incidents',   true, true),
  ('Towing',                'Incidents',   true, true),
  ('Accident / Damage',     'Incidents',   true, true),
  ('Insurance Deductible',  'Incidents',   true, true),
  ('Depreciation',          'Advanced',    true, false),
  ('Mileage',               'Advanced',    true, false),
  ('Rental / Replacement',  'Advanced',    true, false),
  ('Other',                 'Other',       true, false)
ON CONFLICT (name, group_name) DO NOTHING;

-- ── 3. Add category_id FK to expenses ────────────────────────────────────────
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'expenses_category_id_fkey'
      AND table_name = 'expenses'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES expense_categories(id);
  END IF;
END$$;

-- ── 4. Backfill existing rows ─────────────────────────────────────────────────
UPDATE expenses
SET    category_id = ec.id
FROM   expense_categories ec
WHERE  expenses.category_id IS NULL
  AND (
      (expenses.category = 'maintenance'   AND ec.name = 'Oil Change'        AND ec.group_name = 'Maintenance')
   OR (expenses.category = 'insurance'     AND ec.name = 'Insurance'         AND ec.group_name = 'Ownership')
   OR (expenses.category = 'repair'        AND ec.name = 'Repair (General)'  AND ec.group_name = 'Repairs')
   OR (expenses.category = 'fuel'          AND ec.name = 'Fuel'              AND ec.group_name = 'Usage')
   OR (expenses.category = 'registration'  AND ec.name = 'Registration'      AND ec.group_name = 'Ownership')
   OR (expenses.category IN ('other', '')  AND ec.name = 'Other'             AND ec.group_name = 'Other')
  );

-- ── 5. Relax the CHECK constraint on expenses.category ───────────────────────
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_category_check;


-- ===========================================================================
-- 0127_extension_stripe_card_columns.sql
-- ===========================================================================
-- Store the Stripe card used for rental extensions separately so it can be
-- used as a fallback for off-session charges.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS extension_stripe_customer_id       TEXT,
  ADD COLUMN IF NOT EXISTS extension_stripe_payment_method_id TEXT;


-- ===========================================================================
-- 0128_late_fee_pending_collection.sql
-- ===========================================================================
-- Add 'pending_collection' to the late_fee_status CHECK constraint.

DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'bookings'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%late_fee_status%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', v_con);
  END IF;
END $$;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_late_fee_status_check
  CHECK (late_fee_status IN (
    'pending_approval',
    'approved',
    'dismissed',
    'failed',
    'paid',
    'pending_collection'
  ));


-- ===========================================================================
-- 0129_remove_phantom_vehicles_updated_fleet.sql
-- ===========================================================================
-- Canonical fleet: camry, camry2013, fusion2017

DELETE FROM vehicles
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );

UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{status}', '"inactive"')
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );


-- ===========================================================================
-- 0130_remove_phantom_vehicles_fleet_v3.sql
-- ===========================================================================
-- Fleet v3 cleanup pass (same canonical set: camry, camry2013, fusion2017)

DELETE FROM vehicles
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );

UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{status}', '"inactive"')
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );


-- ===========================================================================
-- 0133_tickets_and_documents.sql  +  0134_tickets_fk_uuid_and_review_fixes.sql
-- +  0135_ticket_charge_automation.sql  +  0136_repair_tickets_schema.sql
-- ===========================================================================
-- Tickets / Violations system — fully idempotent combined form.
-- (0136 is the authoritative repair migration; its content covers everything
--  from 0133–0135 and is safe to run on any state of the database.)

-- ── tickets table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number            text          NOT NULL,
  vehicle_id               text          REFERENCES vehicles(vehicle_id) ON DELETE SET NULL,
  booking_id               uuid          REFERENCES bookings(id) ON DELETE SET NULL,
  booking_ref              text,
  customer_id              uuid          REFERENCES customers(id) ON DELETE SET NULL,
  violation_date           timestamptz   NOT NULL,
  location                 text,
  amount                   numeric(10,2) NOT NULL CHECK (amount > 0),
  type                     text          NOT NULL DEFAULT 'parking',
  status                   text          NOT NULL DEFAULT 'new',
  notes                    text,
  activity_log             jsonb         NOT NULL DEFAULT '[]'::jsonb,
  renter_responsible       boolean       DEFAULT false,
  admin_fee                numeric(10,2) DEFAULT 25,
  charge_status            text,
  transfer_submitted_at    timestamptz,
  charge_retry_count       integer       NOT NULL DEFAULT 0,
  charge_last_attempted_at timestamptz,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now()
);

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS booking_ref              text,
  ADD COLUMN IF NOT EXISTS renter_responsible       boolean       DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_fee                numeric(10,2) DEFAULT 25,
  ADD COLUMN IF NOT EXISTS charge_status            text,
  ADD COLUMN IF NOT EXISTS transfer_submitted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS charge_retry_count       integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS charge_last_attempted_at timestamptz;

-- Migrate booking_id from text → uuid if it was created as text
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type
    INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'tickets'
     AND column_name  = 'booking_id';

  IF col_type = 'text' THEN
    UPDATE tickets t
       SET booking_ref = t.booking_id
     WHERE t.booking_id IS NOT NULL
       AND t.booking_ref IS NULL;

    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS booking_id_uuid uuid;

    UPDATE tickets t
       SET booking_id_uuid = b.id
      FROM bookings b
     WHERE b.booking_ref = t.booking_id
       AND t.booking_id IS NOT NULL;

    ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_booking_id_fkey;
    ALTER TABLE tickets DROP COLUMN IF EXISTS booking_id;
    ALTER TABLE tickets RENAME COLUMN booking_id_uuid TO booking_id;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE tickets
    ADD CONSTRAINT tickets_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_type_check
    CHECK (type IN ('parking','toll','camera','other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
    CHECK (status IN ('new','matched','transfer_ready','submitted','approved','rejected','charged','closed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS tickets_vehicle_id_idx      ON tickets (vehicle_id);
CREATE INDEX IF NOT EXISTS tickets_booking_id_idx      ON tickets (booking_id);
CREATE INDEX IF NOT EXISTS tickets_customer_id_idx     ON tickets (customer_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx          ON tickets (status);
CREATE INDEX IF NOT EXISTS tickets_violation_date_idx  ON tickets (violation_date DESC);
CREATE INDEX IF NOT EXISTS tickets_created_at_idx      ON tickets (created_at DESC);

DROP TRIGGER IF EXISTS tickets_updated_at ON tickets;
CREATE TRIGGER tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tickets FROM anon;
REVOKE ALL ON TABLE tickets FROM authenticated;
GRANT ALL ON TABLE tickets TO service_role;

DO $$
BEGIN
  CREATE POLICY tickets_service_role_all
    ON tickets FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── booking_documents table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_documents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type        text        NOT NULL DEFAULT 'other',
  file_url    text        NOT NULL,
  file_name   text,
  mime_type   text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- Migrate booking_id from text → uuid if it was created as text
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type
    INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'booking_documents'
     AND column_name  = 'booking_id';

  IF col_type = 'text' THEN
    ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS booking_id_uuid uuid;

    UPDATE booking_documents bd
       SET booking_id_uuid = b.id
      FROM bookings b
     WHERE b.booking_ref = bd.booking_id;

    DELETE FROM booking_documents WHERE booking_id_uuid IS NULL;

    ALTER TABLE booking_documents DROP CONSTRAINT IF EXISTS booking_documents_booking_id_fkey;
    ALTER TABLE booking_documents DROP COLUMN IF EXISTS booking_id;
    ALTER TABLE booking_documents RENAME COLUMN booking_id_uuid TO booking_id;
    ALTER TABLE booking_documents ALTER COLUMN booking_id SET NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE booking_documents
    ADD CONSTRAINT booking_documents_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE booking_documents DROP CONSTRAINT IF EXISTS booking_documents_type_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE booking_documents
    ADD CONSTRAINT booking_documents_type_check
    CHECK (type IN ('agreement','insurance','other','id_copy'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP   INDEX IF EXISTS booking_documents_booking_id_idx;
CREATE INDEX IF NOT EXISTS booking_documents_booking_id_idx ON booking_documents (booking_id);
CREATE INDEX IF NOT EXISTS booking_documents_type_idx       ON booking_documents (type);

ALTER TABLE booking_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE booking_documents FROM anon;
REVOKE ALL ON TABLE booking_documents FROM authenticated;
GRANT ALL ON TABLE booking_documents TO service_role;

DO $$
BEGIN
  CREATE POLICY booking_documents_service_role_all
    ON booking_documents FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── customers: document columns ───────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS license_front_url   text,
  ADD COLUMN IF NOT EXISTS license_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS license_back_url    text;

-- ── system_settings: seed violation_admin_fee ─────────────────────────────────
INSERT INTO system_settings (key, value, description, category)
VALUES (
  'violation_admin_fee',
  '25',
  'Admin processing fee added to violation ticket charge (USD)',
  'fees'
)
ON CONFLICT (key) DO NOTHING;


-- ===========================================================================
-- 0137_pending_booking_docs_id_back.sql
-- ===========================================================================
-- Migration 0137: Add ID back-side columns to pending_booking_docs
--
-- Purpose: store the renter's ID back photo alongside the front so both
-- are attached to the owner notification email when a booking is confirmed.
--
-- Safe to re-run: all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards.

ALTER TABLE pending_booking_docs
  ADD COLUMN IF NOT EXISTS id_back_base64   text,
  ADD COLUMN IF NOT EXISTS id_back_filename text,
  ADD COLUMN IF NOT EXISTS id_back_mimetype text;


-- ===========================================================================
-- 0138_remove_phantom_vehicles_fleet_v4.sql
-- ===========================================================================
-- Migration 0138: Remove phantom vehicle rows (fleet v4 pass).
--
-- Context: migration 0130 ran but a 4th vehicle row has re-appeared in the
-- Supabase vehicles table with status = 'active', causing the
-- admin_metrics_v2 "Available Vehicles" KPI to display 4 instead of 3.
--
-- The canonical fleet remains exactly three vehicles:
--   "camry", "camry2013", "fusion2017"
--
-- Fix strategy (mirrors migrations 0124, 0129, and 0130):
--   1. Hard-delete any vehicle row whose vehicle_id is NOT in the canonical set
--      AND that has no referencing bookings (no FK risk).
--   2. Soft-delete (set status = 'inactive') any remaining non-canonical rows
--      that still have booking history and therefore cannot be hard-deleted.
--
-- Safe to re-run: both statements are idempotent.

-- Step 1: hard-delete stale rows with no booking history
DELETE FROM vehicles
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );

-- Step 2: soft-delete for rows that still have booking history
UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{status}', '"inactive"')
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );


-- ===========================================================================
-- 0139_pending_booking_docs_booking_type.sql
-- ===========================================================================
-- Migration 0139: Add booking_type column to pending_booking_docs
--
-- Purpose: distinguish vehicle agreements from car agreements stored
-- in the rental-agreements bucket.  The column is informational — the
-- agreement_pdf_url path already contains the booking_id which is the
-- canonical lookup key.  This column makes it easy to filter/audit.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS guard.

ALTER TABLE pending_booking_docs
  ADD COLUMN IF NOT EXISTS booking_type text;

COMMENT ON COLUMN pending_booking_docs.booking_type IS
  'Type of booking that produced this agreement row: ''car'' or ''vehicle''';


-- ===========================================================================
-- 0140_category_revenue_separation.sql
-- ===========================================================================
-- Make category ("car" | "vehicle") the canonical partition key for bookings,
-- payment rows, and revenue rows so car/vehicle financial reporting cannot mix.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS category text;

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS category text;

DO $$
BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE payments ADD COLUMN IF NOT EXISTS category text';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS category text';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bookings_category_idx
  ON bookings (category)
  WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS revenue_records_category_idx
  ON revenue_records (category)
  WHERE category IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS payments_category_idx ON payments (category) WHERE category IS NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS payment_transactions_category_idx ON payment_transactions (category) WHERE category IS NOT NULL';
  END IF;
END $$;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_category_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_category_check
  CHECK (category IS NULL OR category IN ('car','vehicle'));

ALTER TABLE revenue_records DROP CONSTRAINT IF EXISTS revenue_records_category_check;
ALTER TABLE revenue_records
  ADD CONSTRAINT revenue_records_category_check
  CHECK (category IS NULL OR category IN ('car','vehicle'));

DO $$
BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_category_check';
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_category_check CHECK (category IS NULL OR category IN (''car'',''vehicle''))';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_category_check';
    EXECUTE 'ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_category_check CHECK (category IS NULL OR category IN (''car'',''vehicle''))';
  END IF;
END $$;

-- Backfill bookings.category from vehicles.data.category.
UPDATE bookings b
SET category = lower(v.data->>'category')
FROM vehicles v
WHERE b.category IS NULL
  AND v.vehicle_id = b.vehicle_id
  AND lower(v.data->>'category') IN ('car', 'vehicle');

-- Backfill revenue_records.category from linked bookings first.
UPDATE revenue_records rr
SET category = b.category
FROM bookings b
WHERE rr.category IS NULL
  AND b.booking_ref IS NOT NULL
  AND rr.booking_id = b.booking_ref
  AND b.category IN ('car', 'vehicle');

-- Secondary backfill by vehicle category for remaining revenue rows.
UPDATE revenue_records rr
SET category = lower(v.data->>'category')
FROM vehicles v
WHERE rr.category IS NULL
  AND rr.vehicle_id = v.vehicle_id
  AND lower(v.data->>'category') IN ('car', 'vehicle');

DO $$
BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE $stmt$
      UPDATE payments p
      SET category = b.category
      FROM bookings b
      WHERE p.category IS NULL
        AND p.booking_id = b.id
        AND b.category IN ('car', 'vehicle')
    $stmt$;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    EXECUTE $stmt$
      UPDATE payment_transactions pt
      SET category = b.category
      FROM bookings b
      WHERE pt.category IS NULL
        AND pt.booking_id = b.booking_ref
        AND b.category IN ('car', 'vehicle')
    $stmt$;
  END IF;
END $$;


-- ===========================================================================
-- 0141_fix_vehicle_vehicle_category.sql
-- ===========================================================================
-- Backfill correct category for vehicle vehicles that were saved with
-- data.category = 'car' or no category at all.
UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{category}', '"vehicle"')
WHERE (
    vehicle_id ILIKE 'vehicle%'
    OR data->>'type' = 'vehicle'
    OR lower(data->>'vehicle_name') LIKE '%vehicle%'
)
  AND (data->>'category' IS NULL OR data->>'category' != 'vehicle');


-- ===========================================================================
-- 0142_canonical_revenue_pipeline.sql
-- ===========================================================================
-- Migration 0142: Canonical revenue pipeline + reconciliation audit surface
--
-- Goal:
--   Ensure every admin financial surface derives from one canonical dataset.
--
-- Canonical inclusion rules:
--   payment_status = 'paid'
--   sync_excluded  = false
--   is_orphan      = false
--   is_cancelled   = false
--   is_no_show     = false
--
-- Notes:
--   • revenue_reporting_base already applies payment_status/sync_excluded/is_orphan.
--   • This migration adds the remaining is_cancelled/is_no_show filters in one place.
--   • The audit view preserves a reusable reconciliation query shape for diagnostics.
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

-- Canonical row-level reporting source for all financial surfaces.
CREATE OR REPLACE VIEW revenue_reporting_canonical AS
SELECT
  booking_id,
  vehicle_id,
  customer_name,
  customer_phone,
  customer_email,
  pickup_date,
  return_date,
  gross_amount,
  COALESCE(stripe_fee, 0)                         AS stripe_fee,
  COALESCE(refund_amount, 0)                      AS refund_amount,
  (gross_amount - COALESCE(stripe_fee, 0) - COALESCE(refund_amount, 0))
                                                  AS canonical_net_amount,
  deposit_amount,
  payment_method,
  payment_status,
  type
FROM revenue_reporting_base
WHERE COALESCE(is_cancelled, false) = false
  AND COALESCE(is_no_show, false)   = false;

-- Canonical gross KPI (all fleets combined).
CREATE OR REPLACE VIEW total_revenue_kpi_canonical AS
SELECT COALESCE(SUM(gross_amount), 0) AS total_revenue
FROM revenue_reporting_canonical;

-- Reconciliation audit surface (preserved diagnostic artifact).
-- Includes raw ledger rows and supplemental charges in one report shape.
CREATE OR REPLACE VIEW revenue_reconciliation_audit AS
WITH rr AS (
  SELECT
    rr.booking_id,
    rr.payment_intent_id,
    COALESCE(rr.gross_amount, 0)::numeric         AS gross,
    COALESCE(rr.stripe_fee, 0)::numeric           AS fees,
    COALESCE(rr.refund_amount, 0)::numeric        AS refunds,
    (COALESCE(rr.gross_amount, 0)
      - COALESCE(rr.stripe_fee, 0)
      - COALESCE(rr.refund_amount, 0))::numeric   AS net,
    'revenue_records'::text                        AS source_table,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan, false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show, false) = false
    ) AS included_in_dashboard,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan, false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show, false) = false
    ) AS included_in_revenue_page,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan, false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show, false) = false
    ) AS included_in_fleet_analytics
  FROM revenue_records rr
),
charges_only AS (
  SELECT
    c.booking_id,
    c.stripe_payment_intent_id                       AS payment_intent_id,
    COALESCE(c.amount, 0)::numeric                   AS gross,
    0::numeric                                       AS fees,
    0::numeric                                       AS refunds,
    COALESCE(c.amount, 0)::numeric                   AS net,
    'charges'::text                                  AS source_table,
    false                                            AS included_in_dashboard,
    false                                            AS included_in_revenue_page,
    false                                            AS included_in_fleet_analytics
  FROM charges c
  WHERE c.status = 'succeeded'
    AND (
      c.stripe_payment_intent_id IS NULL
      OR c.stripe_payment_intent_id NOT IN (
        SELECT payment_intent_id
        FROM revenue_records
        WHERE payment_intent_id IS NOT NULL
      )
    )
)
SELECT * FROM rr
UNION ALL
SELECT * FROM charges_only;


-- ===========================================================================
-- 0143_reconciliation_audit_vehicle_id.sql
-- ===========================================================================
-- Migration 0143: Add vehicle_id to revenue_reconciliation_audit view
--
-- Extends the reconciliation audit view from 0142 to include vehicle_id for
-- per-vehicle diagnostics and API filtering by the v2-revenue-reconciliation
-- endpoint.  The charges CTE pulls vehicle_id via the bookings table join so
-- unlinked charges still appear (with a NULL vehicle_id).
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW revenue_reconciliation_audit AS
WITH rr AS (
  SELECT
    rr.booking_id,
    rr.vehicle_id,
    rr.payment_intent_id,
    COALESCE(rr.gross_amount, 0)::numeric          AS gross,
    COALESCE(rr.stripe_fee, 0)::numeric            AS fees,
    COALESCE(rr.refund_amount, 0)::numeric         AS refunds,
    (COALESCE(rr.gross_amount, 0)
      - COALESCE(rr.stripe_fee, 0)
      - COALESCE(rr.refund_amount, 0))::numeric    AS net,
    'revenue_records'::text                         AS source_table,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan,    false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show,   false) = false
    ) AS included_in_dashboard,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan,    false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show,   false) = false
    ) AS included_in_revenue_page,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan,    false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show,   false) = false
    ) AS included_in_fleet_analytics
  FROM revenue_records rr
),
charges_only AS (
  SELECT
    c.booking_id,
    b.vehicle_id,
    c.stripe_payment_intent_id                        AS payment_intent_id,
    COALESCE(c.amount, 0)::numeric                    AS gross,
    0::numeric                                        AS fees,
    0::numeric                                        AS refunds,
    COALESCE(c.amount, 0)::numeric                    AS net,
    'charges'::text                                   AS source_table,
    false                                             AS included_in_dashboard,
    false                                             AS included_in_revenue_page,
    false                                             AS included_in_fleet_analytics
  FROM charges c
  -- charges.booking_id stores the booking reference value (equivalent to bookings.booking_ref).
  -- The naming difference is an existing schema convention; the join is intentionally cross-column.
  LEFT JOIN bookings b ON b.booking_ref = c.booking_id
  WHERE c.status = 'succeeded'
    AND (
      c.stripe_payment_intent_id IS NULL
      OR c.stripe_payment_intent_id NOT IN (
        SELECT payment_intent_id
        FROM revenue_records
        WHERE payment_intent_id IS NOT NULL
      )
    )
)
SELECT * FROM rr
UNION ALL
SELECT * FROM charges_only;


-- ===========================================================================
-- 0144_renter_applications_foundation.sql
-- ===========================================================================
-- Migration 0144: renter_applications persistence foundation (Phase 1)
--
-- Establishes a durable renter application record independent of email/localStorage
-- and defines explicit lifecycle + identity status columns for future Stripe Identity
-- integration without changing booking/payment flows.

CREATE TABLE IF NOT EXISTS renter_applications (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL,
  phone                 text        NOT NULL,
  email                 text,
  age                   integer,
  experience            text        NOT NULL,
  apps                  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  agree_terms           boolean     NOT NULL DEFAULT false,
  agree_sms_consent     boolean     NOT NULL DEFAULT false,
  has_insurance         text,
  protection_plan_pref  text,
  license_file_name     text,
  license_mime_type     text,
  insurance_file_name   text,
  insurance_mime_type   text,
  has_license_upload    boolean     NOT NULL DEFAULT false,
  has_insurance_proof   boolean     NOT NULL DEFAULT false,
  precheck_decision     text,
  application_status    text        NOT NULL DEFAULT 'submitted',
  identity_status       text        NOT NULL DEFAULT 'not_started',
  identity_session_id   text,
  identity_verified_at  timestamptz,
  identity_last_error   text,
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz,
  reviewed_by           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_age_check
      CHECK (age IS NULL OR (age >= 18 AND age <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_apps_check
      CHECK (jsonb_typeof(apps) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_has_insurance_check
      CHECK (has_insurance IS NULL OR has_insurance IN ('yes','no'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_protection_plan_pref_check
      CHECK (protection_plan_pref IS NULL OR protection_plan_pref IN ('basic','standard','premium','none'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_precheck_decision_check
      CHECK (precheck_decision IS NULL OR precheck_decision IN ('approved','review','declined'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_application_status_check
      CHECK (application_status IN ('submitted','under_review','approved','rejected','withdrawn','expired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_identity_status_check
      CHECK (identity_status IN ('not_started','requires_input','processing','verified','failed','canceled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_identity_verified_at_check
      CHECK (
        (identity_status = 'verified' AND identity_verified_at IS NOT NULL)
        OR (identity_status <> 'verified' AND identity_verified_at IS NULL)
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS renter_applications_identity_session_id_uq
  ON renter_applications (identity_session_id)
  WHERE identity_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS renter_applications_application_status_idx
  ON renter_applications (application_status, created_at DESC);

CREATE INDEX IF NOT EXISTS renter_applications_identity_status_idx
  ON renter_applications (identity_status, created_at DESC);

CREATE INDEX IF NOT EXISTS renter_applications_created_at_idx
  ON renter_applications (created_at DESC);

CREATE INDEX IF NOT EXISTS renter_applications_phone_idx
  ON renter_applications (phone);

CREATE INDEX IF NOT EXISTS renter_applications_email_idx
  ON renter_applications (lower(email))
  WHERE email IS NOT NULL;

DROP TRIGGER IF EXISTS renter_applications_updated_at ON renter_applications;
CREATE TRIGGER renter_applications_updated_at
  BEFORE UPDATE ON renter_applications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE renter_applications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE renter_applications FROM anon;
REVOKE ALL ON TABLE renter_applications FROM authenticated;
GRANT ALL ON TABLE renter_applications TO service_role;

DO $$
BEGIN
  CREATE POLICY renter_applications_service_role_all
    ON renter_applications
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ===========================================================================
-- 0145_stripe_identity_webhook_events.sql
-- ===========================================================================
-- Migration 0145: Stripe Identity webhook idempotency log
--
-- Stores processed Stripe Identity webhook event IDs so webhook handling
-- is idempotent across retries/replays.

CREATE TABLE IF NOT EXISTS stripe_identity_webhook_events (
  id                  bigserial   PRIMARY KEY,
  stripe_event_id     text        NOT NULL UNIQUE,
  event_type          text        NOT NULL,
  application_id      uuid        REFERENCES renter_applications(id) ON DELETE SET NULL,
  identity_session_id text,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stripe_identity_webhook_events_application_id_idx
  ON stripe_identity_webhook_events (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS stripe_identity_webhook_events_identity_session_id_idx
  ON stripe_identity_webhook_events (identity_session_id)
  WHERE identity_session_id IS NOT NULL;

ALTER TABLE stripe_identity_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE stripe_identity_webhook_events FROM anon;
REVOKE ALL ON TABLE stripe_identity_webhook_events FROM authenticated;
GRANT ALL ON TABLE stripe_identity_webhook_events TO service_role;

DO $$
BEGIN
  CREATE POLICY stripe_identity_webhook_events_service_role_all
    ON stripe_identity_webhook_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ===========================================================================
-- 0146_application_review_phase3.sql
-- ===========================================================================
-- Migration 0146: Phase 3 — admin review operations
--
-- Extends renter_applications with:
--   • review_version        — monotonic counter for optimistic concurrency protection
--   • needs_info_reason     — reason text when action is "needs_info"
--   • last_reviewer_notes   — freeform notes from the most recent reviewer
--   • checkr_candidate_id,
--     checkr_report_id,
--     checkr_report_status,
--     checkr_mvr_status     — inert Checkr attachment points (nullable, no integration yet)
--
-- Expands application_status to include "needs_info".
--
-- Creates application_review_actions (append-only audit table) with:
--   • action_request_id uniqueness constraint to prevent duplicate submissions.

-- ── 1. New columns on renter_applications ─────────────────────────────────────

ALTER TABLE renter_applications
  ADD COLUMN IF NOT EXISTS review_version       bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS needs_info_reason    text,
  ADD COLUMN IF NOT EXISTS last_reviewer_notes  text,
  ADD COLUMN IF NOT EXISTS checkr_candidate_id  text,
  ADD COLUMN IF NOT EXISTS checkr_report_id     text,
  ADD COLUMN IF NOT EXISTS checkr_report_status text,
  ADD COLUMN IF NOT EXISTS checkr_mvr_status    text;

-- ── 2. Expand the application_status check constraint to include needs_info ───

DO $$
BEGIN
  ALTER TABLE renter_applications
    DROP CONSTRAINT IF EXISTS renter_applications_application_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE renter_applications
  ADD CONSTRAINT renter_applications_application_status_check
    CHECK (application_status IN (
      'submitted', 'under_review', 'needs_info',
      'approved',  'rejected', 'withdrawn', 'expired'
    ));

-- ── 3. application_review_actions audit table ─────────────────────────────────

CREATE TABLE IF NOT EXISTS application_review_actions (
  id                bigserial    PRIMARY KEY,
  application_id    uuid         NOT NULL REFERENCES renter_applications(id) ON DELETE CASCADE,
  action            text         NOT NULL,
  performed_by      text         NOT NULL,
  notes             text,
  previous_status   text         NOT NULL,
  new_status        text         NOT NULL,
  action_request_id uuid         NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE application_review_actions
    ADD CONSTRAINT application_review_actions_action_check
      CHECK (action IN ('approved', 'rejected', 'needs_info'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE application_review_actions
    ADD CONSTRAINT application_review_actions_previous_status_check
      CHECK (previous_status IN (
        'submitted', 'under_review', 'needs_info',
        'approved',  'rejected', 'withdrawn', 'expired'
      ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE application_review_actions
    ADD CONSTRAINT application_review_actions_new_status_check
      CHECK (new_status IN (
        'submitted', 'under_review', 'needs_info',
        'approved',  'rejected', 'withdrawn', 'expired'
      ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Idempotency: one action per (application, request-id)
CREATE UNIQUE INDEX IF NOT EXISTS application_review_actions_idempotency_uq
  ON application_review_actions (application_id, action_request_id);

CREATE INDEX IF NOT EXISTS application_review_actions_application_id_idx
  ON application_review_actions (application_id, created_at DESC);

ALTER TABLE application_review_actions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE application_review_actions FROM anon;
REVOKE ALL ON TABLE application_review_actions FROM authenticated;
GRANT  ALL ON TABLE application_review_actions TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE application_review_actions_id_seq TO service_role;

DO $$
BEGIN
  CREATE POLICY application_review_actions_service_role_all
    ON application_review_actions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ===========================================================================
-- 0147_expense_receipts.sql
-- ===========================================================================
-- Expense receipt uploads for fleet expenses / expenses admin UI.
-- Safe to re-run.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS receipt_url text,
  ADD COLUMN IF NOT EXISTS receipt_filename text,
  ADD COLUMN IF NOT EXISTS receipt_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_size integer,
  ADD COLUMN IF NOT EXISTS receipt_mime_type text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'fleet_expenses'
  ) THEN
    EXECUTE $sql$
      ALTER TABLE fleet_expenses
        ADD COLUMN IF NOT EXISTS receipt_url text,
        ADD COLUMN IF NOT EXISTS receipt_filename text,
        ADD COLUMN IF NOT EXISTS receipt_uploaded_at timestamptz,
        ADD COLUMN IF NOT EXISTS receipt_size integer,
        ADD COLUMN IF NOT EXISTS receipt_mime_type text
    $sql$;
  END IF;
END $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-receipts',
  'expense-receipts',
  false,
  10485760,
  ARRAY['image/jpeg','image/png','image/webp','application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = 10485760,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','application/pdf'];

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense-receipts: service write" ON storage.objects;

CREATE POLICY "expense-receipts: service write"
  ON storage.objects FOR ALL
  TO service_role
  USING     (bucket_id = 'expense-receipts')
  WITH CHECK (bucket_id = 'expense-receipts');


-- ===========================================================================
-- 0148_customer_ledger_phase_a.sql
-- ===========================================================================
-- Migration 0148: Customer ledger — Phase A foundation
--
-- PHASE A: Additive schema only. Zero production behavior changes.
--
-- What this migration does:
--   1. Extends `customers` with identity-normalization and migration-tracking columns.
--   2. Creates `customer_ledger`            — append-only financial ledger per customer.
--   3. Creates `customer_migration_log`     — audit trail for every customer-link decision.
--   4. Creates `customer_identity_conflicts`— review queue for ambiguous identity matches.
--   5. Creates `ledger_reconciliation_mismatches` — drift log between ledger and legacy.
--   6. Creates `ledger_idempotency_log`     — duplicate-write prevention audit.
--   7. Creates `ledger_rollback_events`     — rollback / replay operation audit.
--   8. Seeds `customer_ledger_mode = 'shadow'` in system_settings.
--
-- Guardrails enforced:
--   • No existing table is altered destructively (all ADD COLUMN IF NOT EXISTS).
--   • No existing view, function, trigger, or RPC is modified.
--   • No Stripe runtime paths are touched.
--   • No enforcement behavior changes — new tables are dormant data structures.
--   • All new tables use append-only + idempotency patterns from day one.
--
-- Safe to re-run: every DDL statement is guarded with IF NOT EXISTS / OR REPLACE.

-- ── 1. Extend `customers` with identity-normalization columns ─────────────────
--
-- normalized_phone  : E.164-like digits-only string (e.g. '+13105551234').
--                     Populated during Phase B backfill; null until then.
-- normalized_email  : Lower-cased, trimmed email (email is already normalised
--                     by migration 0057, so this mirrors that value for
--                     cross-table consistency without a join).
-- stripe_customer_id: Canonical Stripe cus_xxx for this customer entity.
--                     Bookings store their own stripe_customer_id; this column
--                     will hold the single canonical ID after Phase B linking.
-- ledger_migration_status: Lifecycle state for the Phase B backfill process.
--                     pending   → not yet evaluated
--                     migrated  → deterministically linked, ledger populated
--                     conflict  → ambiguous match, routed to identity_conflicts
--                     skipped   → no bookings / nothing to migrate
-- ledger_migrated_at: Timestamp when migration_status was last set to 'migrated'.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS normalized_phone        text,
  ADD COLUMN IF NOT EXISTS normalized_email        text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id      text,
  ADD COLUMN IF NOT EXISTS ledger_migration_status text NOT NULL DEFAULT 'pending'
    CHECK (ledger_migration_status IN ('pending','migrated','conflict','skipped')),
  ADD COLUMN IF NOT EXISTS ledger_migrated_at      timestamptz;

-- Index: deterministic phone match (Phase B linking)
CREATE INDEX IF NOT EXISTS customers_normalized_phone_idx
  ON customers (normalized_phone)
  WHERE normalized_phone IS NOT NULL;

-- Index: deterministic email match (Phase B linking)
CREATE INDEX IF NOT EXISTS customers_normalized_email_idx
  ON customers (normalized_email)
  WHERE normalized_email IS NOT NULL;

-- Index: Stripe customer ID match (Phase B linking)
CREATE UNIQUE INDEX IF NOT EXISTS customers_stripe_customer_id_idx
  ON customers (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Index: migration backfill cursor
CREATE INDEX IF NOT EXISTS customers_ledger_migration_status_idx
  ON customers (ledger_migration_status);

-- ── 2. `customer_ledger` — append-only financial ledger ───────────────────────
--
-- Each row is a single immutable financial event for a customer.
-- Debits (charges, fees) have direction='debit',  amount_cents > 0.
-- Credits (payments, refunds, waivers) have direction='credit', amount_cents > 0.
-- The net balance is SUM(debit) − SUM(credit).
--
-- The UNIQUE constraint on (source_type, source_id) is the idempotency gate:
-- any duplicate write resolves to a conflict at the DB layer rather than a
-- phantom row.  All write helpers must use ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS customer_ledger (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid        NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  booking_ref      text,                   -- bookings.booking_ref; nullable (customer-level entries)
  transaction_type text        NOT NULL
    CHECK (transaction_type IN (
      'rental_charge',
      'extension_charge',
      'late_fee',
      'ticket_charge',
      'manual_charge',
      'stripe_payment',
      'stripe_refund',
      'admin_waiver',
      'balance_payment',
      'payment_plan_installment'
    )),
  direction        text        NOT NULL CHECK (direction IN ('debit','credit')),
  amount_cents     integer     NOT NULL CHECK (amount_cents >= 0),
  source_type      text        NOT NULL,   -- matches transaction_type for most entries
  source_id        text        NOT NULL,   -- idempotency key (pi_id, charge_id, etc.)
  description      text,
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by      text,                   -- 'stripe_webhook' | 'admin' | 'backfill' | 'system'

  -- Idempotency constraint — the sole mechanism preventing duplicate entries.
  CONSTRAINT customer_ledger_source_unique UNIQUE (source_type, source_id)
);

-- Indexes for balance queries and audit lookups
CREATE INDEX IF NOT EXISTS customer_ledger_customer_id_idx
  ON customer_ledger (customer_id);

CREATE INDEX IF NOT EXISTS customer_ledger_booking_ref_idx
  ON customer_ledger (booking_ref)
  WHERE booking_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_ledger_created_at_idx
  ON customer_ledger (created_at DESC);

CREATE INDEX IF NOT EXISTS customer_ledger_source_type_idx
  ON customer_ledger (source_type);

-- ── 3. `customer_migration_log` — backfill audit trail ───────────────────────
--
-- One row per customer-link decision made during Phase B backfill.
-- confidence_tier values:
--   exact_stripe_id  → booking.stripe_customer_id === customers.stripe_customer_id
--   exact_email      → booking.customer_email    === customers.email (normalised)
--   exact_phone      → booking.customer_phone    === customers.normalized_phone
--   ambiguous        → fell through all deterministic tiers; routed to conflict queue
-- action:
--   linked           → booking linked to this customer record
--   conflict_created → entry written to customer_identity_conflicts
--   skipped          → no match possible / nothing to do

CREATE TABLE IF NOT EXISTS customer_migration_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid        REFERENCES customers(id) ON DELETE SET NULL,
  booking_ref      text,
  confidence_tier  text        NOT NULL
    CHECK (confidence_tier IN (
      'exact_stripe_id',
      'exact_email',
      'exact_phone',
      'ambiguous'
    )),
  action           text        NOT NULL
    CHECK (action IN ('linked','conflict_created','skipped')),
  match_details    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  migrated_by      text,       -- 'backfill_script' | 'admin_manual'
  migrated_at      timestamptz NOT NULL DEFAULT now(),
  notes            text
);

CREATE INDEX IF NOT EXISTS customer_migration_log_customer_id_idx
  ON customer_migration_log (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_migration_log_booking_ref_idx
  ON customer_migration_log (booking_ref)
  WHERE booking_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_migration_log_confidence_tier_idx
  ON customer_migration_log (confidence_tier);

CREATE INDEX IF NOT EXISTS customer_migration_log_action_idx
  ON customer_migration_log (action);

-- ── 4. `customer_identity_conflicts` — manual review queue ───────────────────
--
-- Populated only when confidence_tier = 'ambiguous'.
-- Nothing auto-merges from this table.  An admin must set status='resolved'
-- with a chosen customer_id before any ledger linking occurs.
-- status values:
--   pending   → awaiting admin review
--   resolved  → admin chose a canonical customer_id
--   dismissed → admin determined no valid match; booking remains unlinked

CREATE TABLE IF NOT EXISTS customer_identity_conflicts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref           text        NOT NULL,
  candidate_customer_ids jsonb      NOT NULL DEFAULT '[]'::jsonb,
  conflict_reason       text        NOT NULL,
  raw_booking_data      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status                text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','resolved','dismissed')),
  resolved_customer_id  uuid        REFERENCES customers(id) ON DELETE SET NULL,
  resolved_by           text,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_identity_conflicts_booking_ref_idx
  ON customer_identity_conflicts (booking_ref);

CREATE INDEX IF NOT EXISTS customer_identity_conflicts_status_idx
  ON customer_identity_conflicts (status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION _set_customer_identity_conflicts_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_identity_conflicts_updated_at
  ON customer_identity_conflicts;

CREATE TRIGGER customer_identity_conflicts_updated_at
  BEFORE UPDATE ON customer_identity_conflicts
  FOR EACH ROW EXECUTE FUNCTION _set_customer_identity_conflicts_updated_at();

-- ── 5. `ledger_reconciliation_mismatches` — drift audit ──────────────────────
--
-- Populated by the reconciliation cron / shadow-validation step.
-- Each row records one instance where ledger-derived balance ≠ legacy balance.
-- drift_cents = ledger_balance_cents − legacy_balance_cents.
-- status:
--   open        → unresolved mismatch
--   explained   → mismatch understood (e.g. timing, pending entry)
--   resolved    → ledger corrected or legacy corrected

CREATE TABLE IF NOT EXISTS ledger_reconciliation_mismatches (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid        REFERENCES customers(id) ON DELETE SET NULL,
  booking_ref           text,
  ledger_balance_cents  integer     NOT NULL,
  legacy_balance_cents  integer     NOT NULL,
  drift_cents           integer     NOT NULL
    GENERATED ALWAYS AS (ledger_balance_cents - legacy_balance_cents) STORED,
  drift_direction       text        NOT NULL
    CHECK (drift_direction IN ('ledger_higher','ledger_lower','match')),
  detected_at           timestamptz NOT NULL DEFAULT now(),
  detection_run_id      text,       -- correlates rows from a single cron run
  status                text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','explained','resolved')),
  explanation           text,
  resolved_by           text,
  resolved_at           timestamptz,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_customer_id_idx
  ON ledger_reconciliation_mismatches (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_status_idx
  ON ledger_reconciliation_mismatches (status);

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_detected_at_idx
  ON ledger_reconciliation_mismatches (detected_at DESC);

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_run_id_idx
  ON ledger_reconciliation_mismatches (detection_run_id)
  WHERE detection_run_id IS NOT NULL;

-- ── 6. `ledger_idempotency_log` — duplicate-write prevention audit ────────────
--
-- Populated whenever a ledger write attempt is rejected by the
-- (source_type, source_id) unique constraint (ON CONFLICT DO NOTHING path).
-- This makes duplicate-write prevention visible rather than silent.

CREATE TABLE IF NOT EXISTS ledger_idempotency_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type  text        NOT NULL,
  source_id    text        NOT NULL,
  caller       text,       -- which API endpoint / cron attempted the write
  booking_ref  text,
  customer_id  uuid        REFERENCES customers(id) ON DELETE SET NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ledger_idempotency_log_source_idx
  ON ledger_idempotency_log (source_type, source_id);

CREATE INDEX IF NOT EXISTS ledger_idempotency_log_attempted_at_idx
  ON ledger_idempotency_log (attempted_at DESC);

-- ── 7. `ledger_rollback_events` — rollback / replay audit ────────────────────
--
-- Records every time a ledger mode change or rollback/replay operation occurs.
-- event_type:
--   mode_change  → CUSTOMER_LEDGER_MODE setting changed
--   rollback     → explicit rollback of ledger entries for a booking/customer
--   replay       → explicit re-processing of source events into the ledger

CREATE TABLE IF NOT EXISTS ledger_rollback_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text        NOT NULL
    CHECK (event_type IN ('mode_change','rollback','replay')),
  previous_mode text,
  new_mode      text,
  scope_type   text,       -- 'global' | 'customer' | 'booking'
  scope_id     text,       -- customer_id or booking_ref when scoped
  initiated_by text        NOT NULL,
  reason       text,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_rollback_events_event_type_idx
  ON ledger_rollback_events (event_type);

CREATE INDEX IF NOT EXISTS ledger_rollback_events_created_at_idx
  ON ledger_rollback_events (created_at DESC);

-- ── 8. Seed `customer_ledger_mode` in system_settings ────────────────────────
--
-- Controls which balance/enforcement path is canonical.
--   shadow   → ledger writes are dormant; legacy paths are sole authority (DEFAULT)
--   parallel → both paths run; results compared; no enforcement from ledger
--   warn     → ledger runs; mismatches generate admin alerts; no hard blocks
--   review   → ledger mismatches route new bookings to admin review queue
--   block    → ledger is canonical; non-zero balance blocks new bookings
--
-- Default is 'shadow' — no production behavior change until explicitly promoted.

INSERT INTO system_settings (key, value, description, category)
VALUES (
  'customer_ledger_mode',
  '"shadow"',
  'Customer ledger enforcement mode. '
    'shadow=dormant (legacy only), parallel=dual-run+compare, '
    'warn=ledger alerts, review=admin queue routing, block=ledger canonical. '
    'Do not advance past shadow until Phase D reconciliation thresholds are met.',
  'ledger'
)
ON CONFLICT (key) DO NOTHING;


-- ===========================================================================
-- 0148_unified_renter_balance_ledger.sql
-- ===========================================================================
-- Migration 0148: Unified renter balance ledger (Phase 1 foundation)
--
-- Goal:
--   Single append-only transaction ledger for all renter/booking debt events.
--   Balances must be derived from transactions, never manually overwritten.

CREATE TABLE IF NOT EXISTS renter_balance_ledger (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                text NOT NULL,
  customer_id               uuid REFERENCES customers(id) ON DELETE SET NULL,
  transaction_type          text NOT NULL CHECK (
    transaction_type IN (
      'extension',
      'late_fee',
      'ticket',
      'damage',
      'repair',
      'deductible',
      'smoking',
      'cleaning',
      'towing',
      'misc',
      'payment',
      'refund',
      'waiver',
      'adjustment'
    )
  ),
  direction                 text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount                    numeric(10,2) NOT NULL CHECK (amount > 0),
  notes                     text,
  source_type               text,
  source_id                 text,
  stripe_payment_intent_id  text,
  related_charge_id         uuid REFERENCES charges(id) ON DELETE SET NULL,
  related_ticket_id         uuid REFERENCES tickets(id) ON DELETE SET NULL,
  metadata                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by                text NOT NULL DEFAULT 'system',
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT renter_balance_ledger_source_pair_chk
    CHECK (
      (source_type IS NULL AND source_id IS NULL)
      OR
      (source_type IS NOT NULL AND source_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_booking_idx
  ON renter_balance_ledger (booking_id);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_customer_idx
  ON renter_balance_ledger (customer_id);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_created_at_idx
  ON renter_balance_ledger (created_at DESC);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_booking_created_idx
  ON renter_balance_ledger (booking_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS renter_balance_ledger_source_unique_idx
  ON renter_balance_ledger (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

COMMENT ON TABLE renter_balance_ledger IS
  'Append-only renter/booking balance ledger. Outstanding balance is derived from entries, never manually overwritten.';

COMMENT ON COLUMN renter_balance_ledger.direction IS
  'debit increases amount owed by renter; credit decreases amount owed.';

COMMENT ON COLUMN renter_balance_ledger.related_charge_id IS
  'Optional source link; ON DELETE SET NULL intentionally preserves immutable ledger history if source rows are removed.';

COMMENT ON COLUMN renter_balance_ledger.related_ticket_id IS
  'Optional source link; ON DELETE SET NULL intentionally preserves immutable ledger history if source rows are removed.';

-- 0155_ledger_allow_admin_mutations: append-only triggers removed so that
-- admin Delete and Edit actions on the Balance Ledger page function correctly.
DROP TRIGGER IF EXISTS trg_renter_balance_ledger_no_update ON renter_balance_ledger;
DROP TRIGGER IF EXISTS trg_renter_balance_ledger_no_delete ON renter_balance_ledger;
DROP FUNCTION IF EXISTS fn_prevent_renter_balance_ledger_mutation();

CREATE OR REPLACE VIEW renter_balance_ledger_summary AS
WITH grouped AS (
  SELECT
    booking_id,
    customer_id,
    SUM(CASE WHEN direction = 'debit'  THEN amount ELSE 0 END) AS debit_total,
    SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END) AS credit_total,
    COUNT(*)::bigint AS transaction_count,
    MAX(created_at) AS last_transaction_at
  FROM renter_balance_ledger
  GROUP BY booking_id, customer_id
)
SELECT
  booking_id,
  customer_id,
  ROUND(debit_total::numeric, 2) AS total_charges,
  ROUND(credit_total::numeric, 2) AS total_credits,
  ROUND((debit_total - credit_total)::numeric, 2) AS net_balance,
  transaction_count,
  last_transaction_at
FROM grouped;


-- ===========================================================================
-- 0149_customer_identity_backfill.sql
-- ===========================================================================
-- Migration 0149: Customer identity backfill — Phase B supporting indexes
--
-- PHASE B: Additive index-only migration. Zero behavior changes.
--
-- Adds indexes on bookings and customers needed for efficient Phase B
-- identity-matching queries. No new tables are created; Phase A (0148)
-- already created all necessary tables.
--
-- Safe to re-run: every DDL is guarded with IF NOT EXISTS.

-- ── 1. bookings — phone matching index ───────────────────────────────────────
--
-- Phase B matches bookings against customers via customer_phone.
-- The column exists (added via earlier migrations) but has no general index.

CREATE INDEX IF NOT EXISTS bookings_customer_phone_idx
  ON bookings (customer_phone)
  WHERE customer_phone IS NOT NULL;

-- ── 2. bookings — identity backfill cursor index ─────────────────────────────
--
-- Allows the backfill to page through unlinked bookings efficiently using
-- booking_ref as the stable sort key / resume cursor.

CREATE INDEX IF NOT EXISTS bookings_identity_cursor_idx
  ON bookings (booking_ref)
  WHERE booking_ref IS NOT NULL;

-- ── 3. customers — normalized phone lookup index ──────────────────────────────
--
-- Populated during Phase B normalize_customers pass. Used by exact_phone tier.
-- Phase A (0148) already creates this index; this statement is a no-op if
-- 0148 ran first but is idempotent either way.

CREATE INDEX IF NOT EXISTS customers_normalized_phone_idx
  ON customers (normalized_phone)
  WHERE normalized_phone IS NOT NULL;

-- ── 4. customers — normalized email lookup index ──────────────────────────────

CREATE INDEX IF NOT EXISTS customers_normalized_email_idx
  ON customers (normalized_email)
  WHERE normalized_email IS NOT NULL;

-- ── 5. customers — Stripe customer ID lookup ──────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS customers_stripe_customer_id_idx
  ON customers (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ── 6. customer_migration_log — idempotency guard index ───────────────────────
--
-- Allows the backfill to quickly check if a booking_ref has already been
-- processed without a full table scan.

CREATE UNIQUE INDEX IF NOT EXISTS customer_migration_log_booking_ref_action_idx
  ON customer_migration_log (booking_ref, action)
  WHERE booking_ref IS NOT NULL;


-- ===========================================================================
-- 0149_ledger_due_date.sql
-- ===========================================================================
-- Migration 0149: Add due_date to renter_balance_ledger (Phase 2 Add Charge)
--
-- Allows admins to record when a charge becomes due so renters can be
-- reminded before the due date arrives (Phase 5 renter-facing flow).

ALTER TABLE renter_balance_ledger
  ADD COLUMN IF NOT EXISTS due_date date;

CREATE INDEX IF NOT EXISTS renter_balance_ledger_due_date_idx
  ON renter_balance_ledger (due_date)
  WHERE due_date IS NOT NULL;

COMMENT ON COLUMN renter_balance_ledger.due_date IS
  'Optional date when this charge is due. Used for renter reminders and overdue tracking (Phase 5+).';


-- ===========================================================================
-- 0150_ledger_stripe_pi_index.sql
-- ===========================================================================
-- Migration 0150: Ledger Phase 3 — stripe_payment_intent_id index
--
-- Adds a fast lookup index for payment-intent-based idempotency checks
-- so duplicate webhook deliveries are resolved in a single indexed seek
-- rather than a full-table scan.

CREATE INDEX IF NOT EXISTS renter_balance_ledger_pi_idx
  ON renter_balance_ledger (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

COMMENT ON INDEX renter_balance_ledger_pi_idx IS
  'Fast lookup by Stripe payment_intent_id for webhook idempotency checks (Phase 3).';


-- ===========================================================================
-- 0151_ledger_backfill_log.sql
-- ===========================================================================
-- Migration 0151: Ledger Backfill Log
--
-- Provides a resumable cursor and audit trail for the one-time ledger backfill
-- job (api/ledger-backfill.js).  Each row records the outcome of replaying a
-- single source event into the renter_balance_ledger table.
--
-- status values:
--   ok      – transaction inserted (or already existed; idempotent)
--   skip    – skipped (no ledger-eligible data, e.g. missing payment_intent_id)
--   error   – insert attempt failed; error_message captures the reason

CREATE TABLE IF NOT EXISTS ledger_backfill_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          text        NOT NULL,
  source_table    text        NOT NULL CHECK (source_table IN ('revenue_records', 'charges', 'tickets', 'waiver_events')),
  source_id       text        NOT NULL,
  booking_id      text,
  status          text        NOT NULL CHECK (status IN ('ok', 'skip', 'error')),
  ledger_tx_id    uuid        REFERENCES renter_balance_ledger(id) ON DELETE SET NULL,
  error_message   text,
  processed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_backfill_log_run_idx
  ON ledger_backfill_log (run_id);

CREATE INDEX IF NOT EXISTS ledger_backfill_log_source_idx
  ON ledger_backfill_log (source_table, source_id);

CREATE INDEX IF NOT EXISTS ledger_backfill_log_booking_idx
  ON ledger_backfill_log (booking_id)
  WHERE booking_id IS NOT NULL;

-- Unique constraint so re-runs within the same run_id are idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_backfill_log_run_source_unique_idx
  ON ledger_backfill_log (run_id, source_table, source_id);

COMMENT ON TABLE ledger_backfill_log IS
  'Audit trail and resumable cursor for ledger backfill runs (api/ledger-backfill.js). Each row represents one source event processed.';


-- ===========================================================================
-- 0152_ledger_reconcile_snapshots.sql
-- ===========================================================================
-- Migration 0152: Ledger Reconciliation Snapshots
--
-- Persists the output of each on-demand or nightly reconciliation run so that
-- the platform has a long-term operational trust record.
--
-- Each snapshot captures:
--   - aggregate KPIs (matched %, discrepancy total, unresolved count)
--   - top-10 largest mismatches as JSONB for quick inspection
--   - the full per-booking detail array as JSONB for drill-down
--   - anomalies detected during the same run

CREATE TABLE IF NOT EXISTS ledger_reconcile_snapshots (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at              timestamptz NOT NULL DEFAULT now(),
  run_type            text        NOT NULL DEFAULT 'manual' CHECK (run_type IN ('manual', 'nightly')),
  bookings_checked    integer     NOT NULL DEFAULT 0,
  matched_count       integer     NOT NULL DEFAULT 0,
  matched_pct         numeric(5,2),
  unresolved_count    integer     NOT NULL DEFAULT 0,
  discrepancy_total   numeric(12,2) NOT NULL DEFAULT 0,
  largest_mismatches  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  anomalies_count     integer     NOT NULL DEFAULT 0,
  anomaly_types       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  anomaly_detail      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  details_json        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  date_from           text,
  date_to             text,
  duration_ms         integer,
  created_by          text        NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS ledger_reconcile_snapshots_run_at_idx
  ON ledger_reconcile_snapshots (run_at DESC);

CREATE INDEX IF NOT EXISTS ledger_reconcile_snapshots_run_type_idx
  ON ledger_reconcile_snapshots (run_type);

COMMENT ON TABLE ledger_reconcile_snapshots IS
  'Persisted output of each reconciliation run (on-demand or nightly). Provides long-term operational trust records.';


-- ===========================================================================
-- 0153_payment_plans.sql
-- ===========================================================================
-- Migration 0153: Payment Plans + Installments
--
-- Supports multi-installment payment arrangements for renters with outstanding
-- balances.  The ledger architecture makes each installment individually
-- traceable — every installment row links back to its ledger_transaction_id,
-- ensuring partial installment payments reconcile cleanly against ledger totals.
--
-- payment_plans.status:
--   active      – plan is in progress
--   completed   – all installments paid
--   defaulted   – one or more installments failed and no recovery
--   cancelled   – plan cancelled by admin
--
-- payment_plan_installments.status:
--   pending     – not yet due or not yet attempted
--   paid        – successfully charged
--   failed      – charge attempt failed
--   partial     – partial payment applied (remainder still owed)

CREATE TABLE IF NOT EXISTS payment_plans (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        text          NOT NULL REFERENCES bookings(booking_ref) ON DELETE RESTRICT,
  customer_email    text          NOT NULL,
  total_amount      numeric(10,2) NOT NULL CHECK (total_amount > 0),
  installments      integer       NOT NULL CHECK (installments BETWEEN 2 AND 24),
  interval_days     integer       NOT NULL CHECK (interval_days BETWEEN 1 AND 90),
  next_due_date     timestamptz,
  status            text          NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'completed', 'defaulted', 'cancelled')),
  notes             text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  created_by        text          NOT NULL DEFAULT 'admin'
);

CREATE TABLE IF NOT EXISTS payment_plan_installments (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id               uuid          NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
  installment_number    integer       NOT NULL,
  amount                numeric(10,2) NOT NULL CHECK (amount > 0),
  due_date              timestamptz   NOT NULL,
  paid_at               timestamptz,
  payment_intent_id     text,
  ledger_transaction_id uuid          REFERENCES renter_balance_ledger(id) ON DELETE SET NULL,
  status                text          NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'paid', 'failed', 'partial')),
  failure_message       text,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (plan_id, installment_number)
);

CREATE INDEX IF NOT EXISTS payment_plans_booking_idx
  ON payment_plans (booking_id);

CREATE INDEX IF NOT EXISTS payment_plans_customer_email_idx
  ON payment_plans (customer_email);

CREATE INDEX IF NOT EXISTS payment_plans_status_idx
  ON payment_plans (status);

CREATE INDEX IF NOT EXISTS payment_plan_installments_plan_idx
  ON payment_plan_installments (plan_id);

CREATE INDEX IF NOT EXISTS payment_plan_installments_due_date_idx
  ON payment_plan_installments (due_date)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS payment_plan_installments_ledger_idx
  ON payment_plan_installments (ledger_transaction_id)
  WHERE ledger_transaction_id IS NOT NULL;

-- Auto-update updated_at on payment_plans
CREATE OR REPLACE FUNCTION fn_payment_plans_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_plans_updated_at ON payment_plans;
CREATE TRIGGER trg_payment_plans_updated_at
  BEFORE UPDATE ON payment_plans
  FOR EACH ROW EXECUTE FUNCTION fn_payment_plans_set_updated_at();

DROP TRIGGER IF EXISTS trg_payment_plan_installments_updated_at ON payment_plan_installments;
CREATE TRIGGER trg_payment_plan_installments_updated_at
  BEFORE UPDATE ON payment_plan_installments
  FOR EACH ROW EXECUTE FUNCTION fn_payment_plans_set_updated_at();

COMMENT ON TABLE payment_plans IS
  'Multi-installment payment plans for renters with outstanding balances. Installments link to renter_balance_ledger via ledger_transaction_id.';

COMMENT ON TABLE payment_plan_installments IS
  'Individual installments within a payment plan. Each paid installment links to its ledger transaction for reconciliation.';



-- ===========================================================================
-- 0108_backfill_missing_revenue_records.sql
-- ===========================================================================
-- Migration 0108: Re-run revenue_records backfill to catch bookings created
-- or updated after migration 0089 ran.
--
-- Root cause: autoCreateRevenueRecord is non-fatal in all booking creation
-- paths (add-manual-booking.js, v2-bookings.js status transitions,
-- stripe-webhook.js).  A transient DB error silently drops the revenue record
-- while the booking row is preserved, creating an invisible mismatch that the
-- existing revenue-self-heal only catches if a revenue row already exists
-- (it repairs incomplete rows, but can't see rows that were never created).
--
-- Invariant: every booking with deposit_paid > 0 that is not cancelled must
-- have exactly one revenue_records row with type = 'rental'.
--
-- Cash/manual bookings (payment_method IN ('cash','zelle','venmo','manual',
-- 'external')) receive stripe_fee = 0, stripe_net = gross_amount immediately
-- so analytics are correct without needing a Stripe reconciliation pass.
-- All other bookings receive stripe_fee = NULL / stripe_net = NULL, to be
-- filled in later by stripe-reconcile.js.
--
-- Safe to re-run: the NOT EXISTS guards + ON CONFLICT DO NOTHING make this
-- fully idempotent.

INSERT INTO revenue_records (
  booking_id,
  payment_intent_id,
  vehicle_id,
  pickup_date,
  return_date,
  gross_amount,
  deposit_amount,
  refund_amount,
  payment_method,
  payment_status,
  type,
  is_no_show,
  is_cancelled,
  override_by_admin,
  stripe_fee,
  stripe_net
)
SELECT
  b.booking_ref,
  b.payment_intent_id,
  b.vehicle_id,
  b.pickup_date,
  b.return_date,
  b.deposit_paid                         AS gross_amount,
  0                                      AS deposit_amount,
  0                                      AS refund_amount,
  COALESCE(b.payment_method, 'stripe')   AS payment_method,
  'paid'                                 AS payment_status,
  'rental'                               AS type,
  false                                  AS is_no_show,
  false                                  AS is_cancelled,
  false                                  AS override_by_admin,
  -- Cash/offline payments: fee = 0, net = gross (no Stripe involvement)
  CASE
    WHEN LOWER(COALESCE(b.payment_method, '')) IN ('cash', 'zelle', 'venmo', 'manual', 'external')
      THEN 0
    ELSE NULL
  END                                    AS stripe_fee,
  CASE
    WHEN LOWER(COALESCE(b.payment_method, '')) IN ('cash', 'zelle', 'venmo', 'manual', 'external')
      THEN b.deposit_paid
    ELSE NULL
  END                                    AS stripe_net
FROM bookings b
WHERE
  -- Only bookings where money was actually collected
  b.deposit_paid > 0
  -- Skip cancelled bookings
  AND b.status NOT IN ('cancelled', 'cancelled_rental')
  -- Skip if a rental revenue record already exists for this booking
  AND NOT EXISTS (
    SELECT 1
    FROM   revenue_records rr
    WHERE  rr.booking_id = b.booking_ref
      AND  rr.type = 'rental'
  )
  -- Skip if the booking's payment_intent_id is already covered by another
  -- revenue row (e.g. an orphan record or a differently-keyed row created
  -- by stripe-reconcile before the booking was linked).
  AND (
    b.payment_intent_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM   revenue_records rr2
      WHERE  rr2.payment_intent_id = b.payment_intent_id
    )
  )
ON CONFLICT DO NOTHING;


-- ===========================================================================
-- 0109_delete_vehicle_settings.sql
-- ===========================================================================
-- Migration 0109: Vehicle system_settings are kept.
-- The original DELETE has been reverted — vehicle settings remain active.
-- No-op: this migration is intentionally left as a comment-only statement
-- so that the migration sequence remains intact for existing databases.
SELECT 1 WHERE false; -- no-op


-- ===========================================================================
-- 0118_fix_atomic_rpc_stripe_card_coalesce.sql
-- ===========================================================================
-- =============================================================================
-- Migration 0117: Fix upsert_booking_revenue_atomic — never wipe saved card
-- =============================================================================
--
-- Root cause
-- ----------
-- The ON CONFLICT DO UPDATE clause in migration 0055 blindly assigned
--
--   stripe_customer_id       = EXCLUDED.stripe_customer_id,
--   stripe_payment_method_id = EXCLUDED.stripe_payment_method_id,
--
-- Any caller that doesn't pass these fields (e.g. balance_payment or
-- rental_extension handlers going through persistBooking without explicit card
-- data) passed NULL → the saved Stripe card reference was silently erased →
-- subsequent off-session charges via charge-fee.js failed with
-- "no saved payment method".
--
-- Fix
-- ---
-- Replace the plain assignment with COALESCE so that a NULL incoming value
-- never overwrites an existing non-null row value.
--
-- Safe to re-run: CREATE OR REPLACE replaces the existing function.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.upsert_booking_revenue_atomic(
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_booking_ref text,
  p_vehicle_id text,
  p_pickup_date date,
  p_return_date date,
  p_pickup_time time,
  p_return_time time,
  p_status text,
  p_total_price numeric,
  p_deposit_paid numeric,
  p_remaining_balance numeric,
  p_payment_status text,
  p_notes text,
  p_payment_method text,
  p_payment_intent_id text,
  p_stripe_customer_id text,
  p_stripe_payment_method_id text,
  p_booking_customer_email text,
  p_activated_at timestamptz,
  p_completed_at timestamptz,
  p_revenue_vehicle_id text,
  p_revenue_customer_name text,
  p_revenue_customer_phone text,
  p_revenue_customer_email text,
  p_revenue_pickup_date date,
  p_revenue_return_date date,
  p_gross_amount numeric,
  p_stripe_fee numeric,
  p_payment_intent_id_revenue text,
  p_refund_amount numeric,
  p_revenue_payment_method text,
  p_revenue_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_customer_id uuid;
  v_booking_id uuid;
  v_revenue_id uuid;
  v_revenue_stripe_fee numeric;
  v_revenue_payment_intent text;
BEGIN
  IF p_booking_ref IS NULL OR btrim(p_booking_ref) = '' THEN
    RAISE EXCEPTION 'booking_ref is required';
  END IF;

  IF p_revenue_vehicle_id IS NULL OR btrim(p_revenue_vehicle_id) = '' THEN
    RAISE EXCEPTION 'revenue vehicle_id is required';
  END IF;

  -- Customer dedupe: email-first (primary identity), then phone fallback.
  IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE lower(c.email) = lower(p_customer_email)
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE c.phone = p_customer_phone
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND (
    (p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '') OR
    (p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '')
  ) THEN
    BEGIN
      INSERT INTO customers (
        name, phone, email, updated_at
      ) VALUES (
        COALESCE(NULLIF(p_customer_name, ''), 'Unknown'),
        NULLIF(p_customer_phone, ''),
        NULLIF(lower(p_customer_email), ''),
        now()
      )
      RETURNING id INTO v_customer_id;
    EXCEPTION
      WHEN unique_violation THEN
        IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE lower(c.email) = lower(p_customer_email)
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE c.phone = p_customer_phone
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL THEN
          RAISE;
        END IF;
    END;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET
      name = COALESCE(NULLIF(p_customer_name, ''), customers.name),
      phone = COALESCE(NULLIF(p_customer_phone, ''), customers.phone),
      email = COALESCE(NULLIF(lower(p_customer_email), ''), customers.email),
      updated_at = now()
    WHERE id = v_customer_id;
  END IF;

  INSERT INTO bookings (
    booking_ref,
    customer_id,
    vehicle_id,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    status,
    total_price,
    deposit_paid,
    remaining_balance,
    payment_status,
    notes,
    payment_method,
    payment_intent_id,
    stripe_customer_id,
    stripe_payment_method_id,
    customer_email,
    activated_at,
    completed_at
  ) VALUES (
    p_booking_ref,
    v_customer_id,
    p_vehicle_id,
    p_pickup_date,
    p_return_date,
    p_pickup_time,
    p_return_time,
    COALESCE(NULLIF(p_status, ''), 'pending'),
    COALESCE(p_total_price, 0),
    COALESCE(p_deposit_paid, 0),
    COALESCE(p_remaining_balance, 0),
    COALESCE(NULLIF(p_payment_status, ''), 'unpaid'),
    p_notes,
    p_payment_method,
    p_payment_intent_id,
    p_stripe_customer_id,
    p_stripe_payment_method_id,
    p_booking_customer_email,
    p_activated_at,
    p_completed_at
  )
  ON CONFLICT (booking_ref) DO UPDATE
  SET
    customer_id = EXCLUDED.customer_id,
    vehicle_id = EXCLUDED.vehicle_id,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    pickup_time = EXCLUDED.pickup_time,
    return_time = EXCLUDED.return_time,
    status = EXCLUDED.status,
    total_price = EXCLUDED.total_price,
    deposit_paid = EXCLUDED.deposit_paid,
    remaining_balance = EXCLUDED.remaining_balance,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    payment_method = EXCLUDED.payment_method,
    payment_intent_id = EXCLUDED.payment_intent_id,
    -- *** FIX: never overwrite a saved Stripe card reference with NULL.
    -- COALESCE keeps the existing DB value when the incoming value is NULL.
    -- This prevents balance_payment / rental_extension events (which don't
    -- re-supply these fields) from silently erasing the card saved during the
    -- original deposit checkout.
    stripe_customer_id       = COALESCE(NULLIF(EXCLUDED.stripe_customer_id, ''),       bookings.stripe_customer_id),
    stripe_payment_method_id = COALESCE(NULLIF(EXCLUDED.stripe_payment_method_id, ''), bookings.stripe_payment_method_id),
    customer_email = EXCLUDED.customer_email,
    activated_at = COALESCE(EXCLUDED.activated_at, bookings.activated_at),
    completed_at = COALESCE(EXCLUDED.completed_at, bookings.completed_at),
    updated_at = now()
  RETURNING id INTO v_booking_id;

  INSERT INTO revenue_records (
    booking_id,
    payment_intent_id,
    vehicle_id,
    customer_id,
    customer_name,
    customer_phone,
    customer_email,
    pickup_date,
    return_date,
    gross_amount,
    refund_amount,
    payment_method,
    payment_status,
    type,
    notes,
    stripe_fee
  ) VALUES (
    p_booking_ref,
    p_payment_intent_id_revenue,
    p_revenue_vehicle_id,
    v_customer_id,
    p_revenue_customer_name,
    p_revenue_customer_phone,
    p_revenue_customer_email,
    p_revenue_pickup_date,
    p_revenue_return_date,
    COALESCE(p_gross_amount, 0),
    COALESCE(p_refund_amount, 0),
    COALESCE(NULLIF(p_revenue_payment_method, ''), 'stripe'),
    'paid',
    'rental',
    p_revenue_notes,
    p_stripe_fee
  )
  ON CONFLICT (booking_id) WHERE type = 'rental' DO UPDATE
  SET
    payment_intent_id = EXCLUDED.payment_intent_id,
    vehicle_id = EXCLUDED.vehicle_id,
    customer_id = EXCLUDED.customer_id,
    customer_name = EXCLUDED.customer_name,
    customer_phone = EXCLUDED.customer_phone,
    customer_email = EXCLUDED.customer_email,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    gross_amount = EXCLUDED.gross_amount,
    refund_amount = EXCLUDED.refund_amount,
    payment_method = EXCLUDED.payment_method,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    stripe_fee = EXCLUDED.stripe_fee,
    updated_at = now()
  RETURNING id, stripe_fee, payment_intent_id
  INTO v_revenue_id, v_revenue_stripe_fee, v_revenue_payment_intent;

  IF v_revenue_stripe_fee IS NULL OR v_revenue_payment_intent IS NULL OR btrim(v_revenue_payment_intent) = '' THEN
    RAISE EXCEPTION 'revenue record incomplete after upsert for booking_ref=%', p_booking_ref;
  END IF;

  RETURN jsonb_build_object(
    'booking_id', v_booking_id,
    'customer_id', v_customer_id,
    'revenue_id', v_revenue_id,
    'revenue_complete', true
  );
END;
$$;


-- ===========================================================================
-- 0119_sms_logs_full_unique_index.sql
-- ===========================================================================
-- Migration 0119: Add unconditional unique index to sms_logs
--
-- Background:
--   Migration 0077 dropped the table-level UNIQUE constraint sms_logs_dedup and
--   replaced it with a partial unique index sms_logs_dedup_idx:
--
--     CREATE UNIQUE INDEX sms_logs_dedup_idx
--       ON sms_logs (booking_id, template_key, return_date_at_send)
--       WHERE template_key <> 'HIGH_DAILY_MILEAGE';
--
--   PostgreSQL requires that an ON CONFLICT (col1, col2, col3) inference target
--   exactly matches its arbiter index, INCLUDING any predicate.  Because PostgREST
--   emits ON CONFLICT (booking_id, template_key, return_date_at_send) WITHOUT a
--   WHERE clause, Postgres cannot infer sms_logs_dedup_idx as the arbiter and
--   throws "no unique or exclusion constraint matching the ON CONFLICT
--   specification" for every upsert — even for non-HIGH_DAILY_MILEAGE rows.
--
-- Fix:
--   Add a full (non-partial) unconditional unique index that PostgREST can use
--   for conflict inference regardless of the template_key value.  The existing
--   partial index is kept; it becomes logically redundant alongside this one but
--   is harmless and can be dropped separately after verification.
--
--   For HIGH_DAILY_MILEAGE rows: application code (logHighMileageAlert) uses a
--   plain INSERT and silences 23505 (unique_violation) so that a duplicate
--   same-day log entry is gracefully skipped.  The hard cap (2 per booking) and
--   60-minute cooldown are enforced before each send by checkHighMileageQuota.

CREATE UNIQUE INDEX IF NOT EXISTS sms_logs_dedup_triplet_unique
  ON public.sms_logs (booking_id, template_key, return_date_at_send);

COMMENT ON INDEX sms_logs_dedup_triplet_unique IS
  'Full (non-partial) unique index required for PostgREST ON CONFLICT inference. '
  'Fixes "no unique or exclusion constraint matching the ON CONFLICT specification" '
  'that occurred after migration 0077 replaced the table-level constraint with a '
  'partial index. HIGH_DAILY_MILEAGE callers use plain INSERT and silence 23505.';


-- ===========================================================================
-- 0120_add_balance_due_set_at.sql
-- ===========================================================================
-- Migration 0120: add balance_due_set_at to bookings
-- balance_due_set_at records the exact moment balance_due was first set to a
-- positive value for the current unpaid cycle.  It is cleared back to NULL
-- whenever balance_due drops to 0 (i.e. the balance is paid or waived) so that
-- a fresh timestamp is captured if the booking incurs a new balance in the
-- future.
--
-- Using this column (instead of updated_at) as the retry-window base in
-- scheduled-reminders.js prevents past/completed renters from receiving
-- late-payment SMS messages when their booking row is touched for unrelated
-- reasons (admin edits, extension updates, etc.) long after the original
-- balance was first recorded.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS balance_due_set_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN bookings.balance_due_set_at IS
  'Timestamp when balance_due was first set to a positive value for the '
  'current unpaid cycle. Cleared to NULL when balance_due is paid/waived so '
  'that a fresh timestamp is captured on the next failure. Used by '
  'scheduled-reminders.js as the authoritative base time for retry windows, '
  'instead of updated_at which changes on every row update.';

-- ── Trigger: auto-maintain balance_due_set_at ────────────────────────────────
-- Fires BEFORE UPDATE on bookings whenever balance_due changes.
--   • balance_due goes positive (0/NULL → >0) and balance_due_set_at is NULL:
--     set balance_due_set_at = NOW().
--   • balance_due drops to 0 or NULL (paid / waived): clear balance_due_set_at.
-- The trigger intentionally does NOT overwrite balance_due_set_at if it is
-- already non-NULL, so that repeated PAYMENT_FAILED webhooks for the same
-- unpaid balance do not reset the timer.

CREATE OR REPLACE FUNCTION fn_set_balance_due_set_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Balance becomes positive for the first time this cycle.
  IF NEW.balance_due > 0 AND NEW.balance_due_set_at IS NULL THEN
    NEW.balance_due_set_at := NOW();
  END IF;

  -- Balance is cleared (paid or waived) — reset so next failure gets a fresh
  -- timestamp.
  IF (NEW.balance_due IS NULL OR NEW.balance_due <= 0) THEN
    NEW.balance_due_set_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_balance_due_set_at ON bookings;

CREATE TRIGGER trg_balance_due_set_at
  BEFORE UPDATE OF balance_due ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_balance_due_set_at();


-- ===========================================================================
-- 0121_fix_extension_grouping.sql
-- ===========================================================================
-- Migration 0121: fix extension revenue record grouping in Revenue Tracker
--
-- Problem:
--   The booking_revenue_grouped view groups rows by:
--     COALESCE(original_booking_id, booking_id)
--
--   Extension records are supposed to have original_booking_id = booking_id
--   (both set to the canonical booking_ref of the parent booking).  However,
--   some records have a stale/incorrect original_booking_id (e.g. a Stripe PI
--   id, an old synthetic "ext-..." or "pi_..." value, or a different booking
--   ref from an earlier code path).  Because COALESCE picks original_booking_id
--   FIRST, these records end up in a phantom group (keyed by the stale value)
--   and display as a standalone row in the Revenue Tracker instead of collapsing
--   under their parent booking.
--
--   The existing migrations 0084 and 0085 fixed the case where booking_id itself
--   was the wrong value (pi_xxx, ext-xxx, NULL).  They did NOT fix the inverse
--   case: booking_id is already the correct "bk-..." ref but original_booking_id
--   is a stale non-matching value.
--
-- Fix (three passes, all idempotent):
--
--   Pass 1 — Align original_booking_id with booking_id for extension records:
--     For every extension row where booking_id IS a valid bookings.booking_ref
--     AND original_booking_id differs from booking_id, overwrite original_booking_id
--     with booking_id.  This is safe because booking_id is already the canonical
--     value; original_booking_id was historically used as a fallback for legacy
--     rows and is now redundant for correctly-migrated records.
--
--   Pass 2 — Refresh booking_revenue_grouped view (COALESCE order flip):
--     Change the group key from COALESCE(original_booking_id, booking_id) to
--     COALESCE(booking_id, original_booking_id).  booking_id is the canonical
--     field as of migration 0084 — it is always the correct booking_ref for
--     every extension record.  Flipping the order means a stale original_booking_id
--     can never produce a phantom group key.  This also protects against any
--     future case where original_booking_id is not kept in sync.
--
--   Pass 3 — Same fix for revenue_reporting_base view (defensive, same logic):
--     revenue_reporting_base uses COALESCE(original_booking_id, booking_id) in
--     its booking_group_id column.  Apply the same order flip.
--
-- Safe to re-run: UPDATE uses idempotent WHERE clause; CREATE OR REPLACE VIEW
-- is idempotent.

-- ── Pass 1: align original_booking_id with booking_id ────────────────────────

UPDATE revenue_records
SET    original_booking_id = booking_id,
       updated_at          = now()
WHERE  type              = 'extension'
  AND  sync_excluded     = false
  AND  is_orphan         = false
  AND  booking_id          IS NOT NULL
  AND  original_booking_id IS DISTINCT FROM booking_id
  AND  EXISTS (
         SELECT 1
         FROM   bookings
         WHERE  booking_ref = revenue_records.booking_id
       );

-- ── Pass 2: refresh booking_revenue_grouped view (booking_id first) ──────────

CREATE OR REPLACE VIEW booking_revenue_grouped AS
SELECT
  -- Prefer booking_id (canonical booking_ref, always correct after migration 0084).
  -- Fall back to original_booking_id only when booking_id is NULL (e.g. orphan rows).
  COALESCE(booking_id, original_booking_id)             AS booking_group_id,
  MAX(vehicle_id)                                        AS vehicle_id,
  MAX(customer_name)                                     AS customer_name,
  MAX(customer_phone)                                    AS customer_phone,
  MAX(customer_email)                                    AS customer_email,
  MIN(pickup_date)                                       AS min_pickup_date,
  MAX(return_date)                                       AS max_return_date,
  COALESCE(
    SUM(gross_amount) FILTER (WHERE is_cancelled = false),
    0
  )                                                      AS gross_total,
  COUNT(*)                                               AS record_count,
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                  id,
      'booking_id',          booking_id,
      'original_booking_id', original_booking_id,
      'payment_intent_id',   payment_intent_id,
      'vehicle_id',          vehicle_id,
      'customer_name',       customer_name,
      'customer_phone',      customer_phone,
      'customer_email',      customer_email,
      'pickup_date',         pickup_date,
      'return_date',         return_date,
      'gross_amount',        gross_amount,
      'deposit_amount',      deposit_amount,
      'refund_amount',       refund_amount,
      'stripe_fee',          stripe_fee,
      'stripe_net',          stripe_net,
      'payment_method',      payment_method,
      'payment_status',      payment_status,
      'type',                type,
      'is_cancelled',        is_cancelled,
      'is_no_show',          is_no_show,
      'is_orphan',           is_orphan,
      'notes',               notes,
      'created_at',          created_at,
      'updated_at',          updated_at
    )
    ORDER BY created_at ASC
  )                                                      AS records,
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'id',                  id,
      'booking_id',          booking_id,
      'original_booking_id', original_booking_id,
      'payment_intent_id',   payment_intent_id,
      'vehicle_id',          vehicle_id,
      'pickup_date',         pickup_date,
      'return_date',         return_date,
      'gross_amount',        gross_amount,
      'stripe_fee',          stripe_fee,
      'payment_status',      payment_status,
      'type',                type,
      'created_at',          created_at
    )
    ORDER BY created_at ASC
  ) FILTER (WHERE type = 'extension')                    AS extensions
FROM revenue_records_effective
GROUP BY COALESCE(booking_id, original_booking_id);


-- ===========================================================================
-- 0122_revenue_records_booking_ref_column.sql
-- ===========================================================================
-- =============================================================================
-- Migration 0122: add booking_ref column to revenue_records
-- =============================================================================
--
-- Root cause
-- ----------
-- revenue_records has a booking_ref column in production (added outside the
-- repo's migration history) with a NOT NULL constraint.  autoCreateRevenueRecord
-- and upsert_booking_revenue_atomic never set this column, so every INSERT fails
-- with:
--
--   null value in column "booking_ref" of relation "revenue_records"
--   violates not-null constraint  (code 23502)
--
-- This is the reason extension revenue records have NEVER been successfully
-- written by the automated pipeline — the reconciler's recovery path calls
-- autoCreateRevenueRecord, which always crashes at the INSERT step.
--
-- Fix
-- ---
-- 1. Add booking_ref column IF NOT EXISTS (nullable so orphan records, which
--    have booking_id = NULL and is_orphan = true, are never blocked).
-- 2. Backfill booking_ref = booking_id for every row where booking_id already
--    resolves to a real booking.
-- 3. Re-create upsert_booking_revenue_atomic to set booking_ref = p_booking_ref
--    in the revenue_records INSERT and ON CONFLICT SET clause.
--
-- Safe to re-run: all DDL uses IF NOT EXISTS / CREATE OR REPLACE.
-- =============================================================================

-- ── 1. Add the column (no-op if already present) ─────────────────────────────

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS booking_ref text REFERENCES bookings(booking_ref) ON DELETE SET NULL;

COMMENT ON COLUMN revenue_records.booking_ref IS
  'FK to bookings.booking_ref — mirrors booking_id for joined queries. '
  'NULL only for orphan records (is_orphan = true).';

-- ── 2. Backfill from booking_id where resolvable ──────────────────────────────

UPDATE revenue_records rr
SET    booking_ref = rr.booking_id
WHERE  rr.booking_ref IS NULL
  AND  rr.booking_id IS NOT NULL
  AND  EXISTS (
         SELECT 1 FROM bookings b WHERE b.booking_ref = rr.booking_id
       );

-- ── 3. Index for FK lookups ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS revenue_records_booking_ref_idx
  ON revenue_records (booking_ref)
  WHERE booking_ref IS NOT NULL;

-- ── 4. Update upsert_booking_revenue_atomic to set booking_ref ────────────────
-- Re-creates the latest version of the function (same as migration 0118) with
-- booking_ref added to the revenue_records INSERT and ON CONFLICT SET clause.

CREATE OR REPLACE FUNCTION public.upsert_booking_revenue_atomic(
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_booking_ref text,
  p_vehicle_id text,
  p_pickup_date date,
  p_return_date date,
  p_pickup_time time,
  p_return_time time,
  p_status text,
  p_total_price numeric,
  p_deposit_paid numeric,
  p_remaining_balance numeric,
  p_payment_status text,
  p_notes text,
  p_payment_method text,
  p_payment_intent_id text,
  p_stripe_customer_id text,
  p_stripe_payment_method_id text,
  p_booking_customer_email text,
  p_activated_at timestamptz,
  p_completed_at timestamptz,
  p_revenue_vehicle_id text,
  p_revenue_customer_name text,
  p_revenue_customer_phone text,
  p_revenue_customer_email text,
  p_revenue_pickup_date date,
  p_revenue_return_date date,
  p_gross_amount numeric,
  p_stripe_fee numeric,
  p_payment_intent_id_revenue text,
  p_refund_amount numeric,
  p_revenue_payment_method text,
  p_revenue_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_customer_id uuid;
  v_booking_id uuid;
  v_revenue_id uuid;
  v_revenue_payment_intent text;
BEGIN
  IF p_booking_ref IS NULL OR btrim(p_booking_ref) = '' THEN
    RAISE EXCEPTION 'booking_ref is required';
  END IF;

  IF p_revenue_vehicle_id IS NULL OR btrim(p_revenue_vehicle_id) = '' THEN
    RAISE EXCEPTION 'revenue vehicle_id is required';
  END IF;

  -- Customer dedupe: email-first (primary identity), then phone fallback.
  IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE lower(c.email) = lower(p_customer_email)
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM customers c
    WHERE c.phone = p_customer_phone
    ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL AND (
    (p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '') OR
    (p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '')
  ) THEN
    BEGIN
      INSERT INTO customers (
        name, phone, email, updated_at
      ) VALUES (
        COALESCE(NULLIF(p_customer_name, ''), 'Unknown'),
        NULLIF(p_customer_phone, ''),
        NULLIF(lower(p_customer_email), ''),
        now()
      )
      RETURNING id INTO v_customer_id;
    EXCEPTION
      WHEN unique_violation THEN
        IF p_customer_email IS NOT NULL AND btrim(p_customer_email) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE lower(c.email) = lower(p_customer_email)
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL AND p_customer_phone IS NOT NULL AND btrim(p_customer_phone) <> '' THEN
          SELECT c.id INTO v_customer_id
          FROM customers c
          WHERE c.phone = p_customer_phone
          ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
          LIMIT 1;
        END IF;
        IF v_customer_id IS NULL THEN
          RAISE;
        END IF;
    END;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET
      name = COALESCE(NULLIF(p_customer_name, ''), customers.name),
      phone = COALESCE(NULLIF(p_customer_phone, ''), customers.phone),
      email = COALESCE(NULLIF(lower(p_customer_email), ''), customers.email),
      updated_at = now()
    WHERE id = v_customer_id;
  END IF;

  INSERT INTO bookings (
    booking_ref,
    customer_id,
    vehicle_id,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    status,
    total_price,
    deposit_paid,
    remaining_balance,
    payment_status,
    notes,
    payment_method,
    payment_intent_id,
    stripe_customer_id,
    stripe_payment_method_id,
    customer_email,
    activated_at,
    completed_at
  ) VALUES (
    p_booking_ref,
    v_customer_id,
    p_vehicle_id,
    p_pickup_date,
    p_return_date,
    p_pickup_time,
    p_return_time,
    COALESCE(NULLIF(p_status, ''), 'pending'),
    COALESCE(p_total_price, 0),
    COALESCE(p_deposit_paid, 0),
    COALESCE(p_remaining_balance, 0),
    COALESCE(NULLIF(p_payment_status, ''), 'unpaid'),
    p_notes,
    p_payment_method,
    p_payment_intent_id,
    p_stripe_customer_id,
    p_stripe_payment_method_id,
    p_booking_customer_email,
    p_activated_at,
    p_completed_at
  )
  ON CONFLICT (booking_ref) DO UPDATE
  SET
    customer_id = EXCLUDED.customer_id,
    vehicle_id = EXCLUDED.vehicle_id,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    pickup_time = EXCLUDED.pickup_time,
    return_time = EXCLUDED.return_time,
    status = EXCLUDED.status,
    total_price = EXCLUDED.total_price,
    deposit_paid = EXCLUDED.deposit_paid,
    remaining_balance = EXCLUDED.remaining_balance,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    payment_method = EXCLUDED.payment_method,
    payment_intent_id = EXCLUDED.payment_intent_id,
    stripe_customer_id       = COALESCE(NULLIF(EXCLUDED.stripe_customer_id, ''),       bookings.stripe_customer_id),
    stripe_payment_method_id = COALESCE(NULLIF(EXCLUDED.stripe_payment_method_id, ''), bookings.stripe_payment_method_id),
    customer_email = EXCLUDED.customer_email,
    activated_at = COALESCE(EXCLUDED.activated_at, bookings.activated_at),
    completed_at = COALESCE(EXCLUDED.completed_at, bookings.completed_at),
    updated_at = now()
  RETURNING id INTO v_booking_id;

  INSERT INTO revenue_records (
    booking_id,
    booking_ref,
    payment_intent_id,
    vehicle_id,
    customer_id,
    customer_name,
    customer_phone,
    customer_email,
    pickup_date,
    return_date,
    gross_amount,
    refund_amount,
    payment_method,
    payment_status,
    type,
    notes,
    stripe_fee
  ) VALUES (
    p_booking_ref,              -- booking_id
    p_booking_ref,              -- booking_ref (FK mirror of booking_id)
    p_payment_intent_id_revenue,
    p_revenue_vehicle_id,
    v_customer_id,
    p_revenue_customer_name,
    p_revenue_customer_phone,
    p_revenue_customer_email,
    p_revenue_pickup_date,
    p_revenue_return_date,
    COALESCE(p_gross_amount, 0),
    COALESCE(p_refund_amount, 0),
    COALESCE(NULLIF(p_revenue_payment_method, ''), 'stripe'),
    'paid',
    'rental',
    p_revenue_notes,
    p_stripe_fee
  )
  ON CONFLICT (booking_id) WHERE type = 'rental' DO UPDATE
  SET
    booking_ref = EXCLUDED.booking_ref,
    payment_intent_id = EXCLUDED.payment_intent_id,
    vehicle_id = EXCLUDED.vehicle_id,
    customer_id = EXCLUDED.customer_id,
    customer_name = EXCLUDED.customer_name,
    customer_phone = EXCLUDED.customer_phone,
    customer_email = EXCLUDED.customer_email,
    pickup_date = EXCLUDED.pickup_date,
    return_date = EXCLUDED.return_date,
    gross_amount = EXCLUDED.gross_amount,
    refund_amount = EXCLUDED.refund_amount,
    payment_method = EXCLUDED.payment_method,
    payment_status = EXCLUDED.payment_status,
    notes = EXCLUDED.notes,
    stripe_fee = COALESCE(EXCLUDED.stripe_fee, revenue_records.stripe_fee),
    updated_at = now()
  RETURNING id, payment_intent_id
  INTO v_revenue_id, v_revenue_payment_intent;

  IF v_revenue_payment_intent IS NULL OR btrim(v_revenue_payment_intent) = '' THEN
    RAISE EXCEPTION 'revenue record incomplete after upsert for booking_ref=%', p_booking_ref;
  END IF;

  RETURN jsonb_build_object(
    'booking_id', v_booking_id,
    'customer_id', v_customer_id,
    'revenue_id', v_revenue_id,
    'revenue_complete', true
  );
END;
$$;


-- ===========================================================================
-- 0123_revenue_records_booking_ref_check_constraint.sql
-- ===========================================================================
-- =============================================================================
-- Migration 0123: replace bare NOT NULL on revenue_records.booking_ref with
--                 a precise CHECK constraint
-- =============================================================================
--
-- Background
-- ----------
-- Migration 0122 added revenue_records.booking_ref as NULLABLE (correct intent:
-- orphan records with is_orphan = true legitimately have booking_ref = NULL).
--
-- The live database, however, has a bare NOT NULL constraint on this column
-- that was applied outside the migration history.  This causes every call to
-- createOrphanRevenueRecord to fail with:
--
--   null value in column "booking_ref" of relation "revenue_records"
--   violates not-null constraint  (code 23502)
--
-- Fix (permanent)
-- ---------------
-- Replace the bare NOT NULL with a CHECK constraint that encodes the exact
-- business rule:
--
--   Non-orphan rows MUST have a booking_ref.
--   Orphan rows (is_orphan = true) are explicitly exempt.
--
--   CHECK (is_orphan = true OR booking_ref IS NOT NULL)
--
-- This is a schema-level, self-documenting invariant — it can never drift
-- silently the way a bare NOT NULL does.
--
-- Steps
-- -----
-- 1. Drop the NOT NULL constraint (ALTER COLUMN … DROP NOT NULL is a no-op if
--    the column is already nullable — safe to re-run).
-- 2. Add the CHECK constraint (IF NOT EXISTS guard makes it idempotent).
-- 3. Update the column comment to document the rule.
--
-- Safe to re-run: DROP NOT NULL is idempotent; ADD CONSTRAINT uses IF NOT EXISTS.
-- =============================================================================

-- ── 1. Drop bare NOT NULL (makes column nullable for orphan rows) ─────────────

ALTER TABLE revenue_records
  ALTER COLUMN booking_ref DROP NOT NULL;

-- ── 2. Add precise CHECK constraint ──────────────────────────────────────────

ALTER TABLE revenue_records
  ADD CONSTRAINT revenue_records_booking_ref_required
    CHECK (is_orphan = true OR booking_ref IS NOT NULL);

-- ── 3. Update column comment ──────────────────────────────────────────────────

COMMENT ON COLUMN revenue_records.booking_ref IS
  'FK to bookings.booking_ref — mirrors booking_id for joined queries. '
  'NULL is permitted ONLY when is_orphan = true '
  '(enforced by revenue_records_booking_ref_required CHECK constraint). '
  'Non-orphan rows must always supply a valid booking_ref.';


-- ===========================================================================
-- 0124_remove_phantom_vehicles.sql
-- ===========================================================================
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


-- ===========================================================================
-- 0125_site_settings_hero_image_url.sql
-- ===========================================================================
-- Migration 0125: add hero_image_url to site_settings
-- Inserts a default empty row for the hero_image_url key so the public
-- site-content API returns it in its settings object. The value is managed
-- via the admin panel (admin-v2 → Settings → Hero Section).

INSERT INTO site_settings (key, value, updated_at)
VALUES ('hero_image_url', '', NOW())
ON CONFLICT (key) DO NOTHING;


-- ===========================================================================
-- 0126_expense_categories.sql
-- ===========================================================================
-- 0126_expense_categories.sql
-- Upgrades the expense category system from a flat CHECK-constrained text column
-- to a two-level hierarchy: group → category, stored in a dedicated table.
--
-- Changes:
--   1. Creates expense_categories table (id, name, group_name, is_default, is_active)
--   2. Inserts all default categories across 8 groups
--   3. Adds category_id (nullable UUID FK) to the expenses table
--   4. Backfills category_id for existing rows by mapping old category text values
--   5. Drops the restrictive CHECK constraint on expenses.category so free-text
--      values (and the GitHub-fallback path) continue to work

-- ── 1. expense_categories table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_categories (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  group_name  text        NOT NULL,
  is_default  boolean     NOT NULL DEFAULT false,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, group_name)
);

CREATE INDEX IF NOT EXISTS expense_categories_group_idx  ON expense_categories (group_name);
CREATE INDEX IF NOT EXISTS expense_categories_active_idx ON expense_categories (is_active);

-- ── 2. Default categories ─────────────────────────────────────────────────────
INSERT INTO expense_categories (name, group_name, is_default, is_active) VALUES
  -- Ownership
  ('Loan / Lease',          'Ownership',   true, true),
  ('Insurance',             'Ownership',   true, true),
  ('Registration',          'Ownership',   true, true),
  ('Taxes',                 'Ownership',   true, true),
  -- Usage
  ('Fuel',                  'Usage',       true, true),
  ('EV Charging',           'Usage',       true, true),
  ('Parking',               'Usage',       true, true),
  ('Tolls',                 'Usage',       true, true),
  -- Maintenance
  ('Oil Change',            'Maintenance', true, true),
  ('Tires',                 'Maintenance', true, true),
  ('Brakes',                'Maintenance', true, true),
  ('Fluids',                'Maintenance', true, true),
  ('Filters',               'Maintenance', true, true),
  ('Battery',               'Maintenance', true, true),
  ('Inspection / Emissions','Maintenance', true, true),
  -- Repairs
  ('Repair (General)',      'Repairs',     true, true),
  ('Parts',                 'Repairs',     true, true),
  ('Labor',                 'Repairs',     true, true),
  ('Diagnostics',           'Repairs',     true, true),
  -- Cleaning
  ('Car Wash',              'Cleaning',    true, true),
  ('Detailing',             'Cleaning',    true, true),
  -- Extras
  ('Accessories',           'Extras',      true, true),
  ('Mods / Upgrades',       'Extras',      true, true),
  ('Subscriptions',         'Extras',      true, true),
  -- Incidents
  ('Fines / Tickets',       'Incidents',   true, true),
  ('Towing',                'Incidents',   true, true),
  ('Accident / Damage',     'Incidents',   true, true),
  ('Insurance Deductible',  'Incidents',   true, true),
  -- Advanced (hidden by default — is_active=false)
  ('Depreciation',          'Advanced',    true, false),
  ('Mileage',               'Advanced',    true, false),
  ('Rental / Replacement',  'Advanced',    true, false),
  -- Legacy fallback (hidden — kept for backward-compat only)
  ('Other',                 'Other',       true, false)
ON CONFLICT (name, group_name) DO NOTHING;

-- ── 3. Add category_id FK to expenses ────────────────────────────────────────
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'expenses_category_id_fkey'
      AND table_name = 'expenses'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES expense_categories(id);
  END IF;
END$$;

-- ── 4. Backfill existing rows ─────────────────────────────────────────────────
UPDATE expenses
SET    category_id = ec.id
FROM   expense_categories ec
WHERE  expenses.category_id IS NULL
  AND (
      (expenses.category = 'maintenance'   AND ec.name = 'Oil Change'        AND ec.group_name = 'Maintenance')
   OR (expenses.category = 'insurance'     AND ec.name = 'Insurance'         AND ec.group_name = 'Ownership')
   OR (expenses.category = 'repair'        AND ec.name = 'Repair (General)'  AND ec.group_name = 'Repairs')
   OR (expenses.category = 'fuel'          AND ec.name = 'Fuel'              AND ec.group_name = 'Usage')
   OR (expenses.category = 'registration'  AND ec.name = 'Registration'      AND ec.group_name = 'Ownership')
   OR (expenses.category IN ('other', '')  AND ec.name = 'Other'             AND ec.group_name = 'Other')
  );

-- ── 5. Relax the CHECK constraint on expenses.category ───────────────────────
-- The category text column is retained for the GitHub-fallback path and legacy
-- display; the CHECK was too restrictive for the new free-text + category_id model.
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_category_check;


-- ===========================================================================
-- 0127_extension_stripe_card_columns.sql
-- ===========================================================================
-- Migration 0127: store the Stripe card used for rental extensions separately
--
-- A renter may pay for their extension with a different card than the one used
-- for the original booking.  These two columns capture that card so it can be
-- used as a fallback for off-session charges (late fees, damages, etc.) when
-- the original booking card is absent or declined.
--
-- COALESCE semantics are applied in JS (autoUpsertBooking) and in SQL via the
-- upsert_booking_revenue_atomic RPC — these columns are never overwritten with
-- NULL/empty once a value has been written.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS extension_stripe_customer_id      TEXT,
  ADD COLUMN IF NOT EXISTS extension_stripe_payment_method_id TEXT;

COMMENT ON COLUMN bookings.extension_stripe_customer_id IS
  'Stripe Customer ID from the most-recent rental-extension payment. Used as a card-charge fallback when stripe_customer_id is absent.';
COMMENT ON COLUMN bookings.extension_stripe_payment_method_id IS
  'Stripe PaymentMethod ID from the most-recent rental-extension payment. Used as a card-charge fallback when stripe_payment_method_id is absent.';


-- ===========================================================================
-- 0128_late_fee_pending_collection.sql
-- ===========================================================================
-- Migration 0128: add 'pending_collection' to late_fee_status CHECK constraint
--
-- 'pending_collection' means:
--   A late fee was assessed but could not be charged off-session (e.g. the
--   renter had no saved card, or the charge failed).  The fee will be folded
--   into the renter's NEXT payment (rental extension or balance payment).
--
-- Transition sequence for this status:
--   null → pending_collection  (set by admin / AI tool)
--   pending_collection → paid  (set by webhook when next extension payment is
--                               confirmed by Stripe)

-- Drop the existing constraint so we can widen it.
DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'bookings'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%late_fee_status%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', v_con);
  END IF;
END $$;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_late_fee_status_check
  CHECK (late_fee_status IN (
    'pending_approval',
    'approved',
    'dismissed',
    'failed',
    'paid',
    'pending_collection'
  ));

COMMENT ON COLUMN bookings.late_fee_status IS
  'Tracks where the late-fee stands: '
  'pending_approval → approved/dismissed/failed/paid, '
  'pending_collection → fee owed but no card; added to next payment.';


-- ===========================================================================
-- 0129_remove_phantom_vehicles_updated_fleet.sql
-- ===========================================================================
-- Migration 0129: Remove phantom vehicle rows now that the canonical fleet is
-- camry + camry2013 + fusion2017 (three vehicles).
--
-- Context: migration 0124 used ('camry', 'camry2013') as the canonical set.
-- fusion2017 was added to the fleet after 0124 ran, and any other phantom rows
-- (e.g. a test vehicle, a mis-typed ID, or a failed admin-UI create) may still
-- exist in the vehicles table with status = 'active', inflating the
-- admin_metrics_v2 available-vehicles count.
--
-- Fix strategy (mirrors migration 0124 with the updated canonical set):
--   1. Hard-delete any vehicle row whose vehicle_id is NOT in the canonical set
--      AND that has no referencing bookings.
--   2. Soft-delete (set status = 'inactive') any remaining non-canonical rows
--      that have booking history and therefore cannot be hard-deleted.
--
-- Safe to re-run: both statements are idempotent.

-- Step 1: hard-delete stale rows with no booking history
DELETE FROM vehicles
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );

-- Step 2: soft-delete for rows that still have booking history
UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{status}', '"inactive"')
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );


-- ===========================================================================
-- 0130_remove_phantom_vehicles_fleet_v3.sql
-- ===========================================================================
-- Migration 0130: Remove phantom vehicle rows (fleet v3 pass).
--
-- Context: migration 0129 ran with canonical fleet = (camry, camry2013, fusion2017).
-- A 4th vehicle row has since appeared in the Supabase vehicles table with
-- status = 'active', causing the admin_metrics_v2 "Available Vehicles" KPI to
-- display 4 instead of the correct 3.
--
-- The canonical fleet remains exactly three vehicles:
--   "camry", "camry2013", "fusion2017"
--
-- Fix strategy (mirrors migrations 0124 and 0129 with the same canonical set):
--   1. Hard-delete any vehicle row whose vehicle_id is NOT in the canonical set
--      AND that has no referencing bookings (no FK risk).
--   2. Soft-delete (set status = 'inactive') any remaining non-canonical rows
--      that still have booking history and therefore cannot be hard-deleted.
--
-- Safe to re-run: both statements are idempotent.

-- Step 1: hard-delete stale rows with no booking history
DELETE FROM vehicles
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );

-- Step 2: soft-delete for rows that still have booking history
UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{status}', '"inactive"')
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );


-- ===========================================================================
-- 0133_tickets_and_documents.sql
-- ===========================================================================
-- Migration 0130: Tickets / Violations system + booking documents + customer document columns
--
-- Changes:
--   1. tickets table — stores violation tickets linked to bookings and customers
--   2. booking_documents table — stores per-booking file URLs (agreement, insurance, other)
--   3. Adds license_front_url + license_uploaded_at to customers table

-- ── 1. tickets table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number    text          NOT NULL,
  vehicle_id       text          REFERENCES vehicles(vehicle_id) ON DELETE SET NULL,
  booking_id       text          REFERENCES bookings(booking_ref) ON DELETE SET NULL,
  customer_id      uuid          REFERENCES customers(id) ON DELETE SET NULL,
  violation_date   timestamptz   NOT NULL,
  location         text,
  amount           numeric(10,2) NOT NULL CHECK (amount > 0),
  type             text          NOT NULL DEFAULT 'parking',
  status           text          NOT NULL DEFAULT 'new',
  notes            text,
  activity_log     jsonb         NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_type_check
    CHECK (type IN ('parking','toll','camera','other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
    CHECK (status IN ('new','matched','transfer_ready','submitted','approved','rejected','charged','closed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS tickets_vehicle_id_idx     ON tickets (vehicle_id);
CREATE INDEX IF NOT EXISTS tickets_booking_id_idx     ON tickets (booking_id);
CREATE INDEX IF NOT EXISTS tickets_customer_id_idx    ON tickets (customer_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx         ON tickets (status);
CREATE INDEX IF NOT EXISTS tickets_violation_date_idx ON tickets (violation_date DESC);
CREATE INDEX IF NOT EXISTS tickets_created_at_idx     ON tickets (created_at DESC);

DROP TRIGGER IF EXISTS tickets_updated_at ON tickets;
CREATE TRIGGER tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE tickets FROM anon;
REVOKE ALL ON TABLE tickets FROM authenticated;
GRANT ALL ON TABLE tickets TO service_role;

DO $$
BEGIN
  CREATE POLICY tickets_service_role_all
    ON tickets FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. booking_documents table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_documents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  text        NOT NULL REFERENCES bookings(booking_ref) ON DELETE CASCADE,
  type        text        NOT NULL DEFAULT 'other',
  file_url    text        NOT NULL,
  file_name   text,
  mime_type   text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE booking_documents ADD CONSTRAINT booking_documents_type_check
    CHECK (type IN ('agreement','insurance','other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS booking_documents_booking_id_idx ON booking_documents (booking_id);
CREATE INDEX IF NOT EXISTS booking_documents_type_idx       ON booking_documents (type);

ALTER TABLE booking_documents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE booking_documents FROM anon;
REVOKE ALL ON TABLE booking_documents FROM authenticated;
GRANT ALL ON TABLE booking_documents TO service_role;

DO $$
BEGIN
  CREATE POLICY booking_documents_service_role_all
    ON booking_documents FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. Customer document columns ──────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS license_front_url    text,
  ADD COLUMN IF NOT EXISTS license_uploaded_at  timestamptz;


-- ===========================================================================
-- 0134_tickets_fk_uuid_and_review_fixes.sql
-- ===========================================================================
-- Migration 0131: Part 2 review fixes
--
-- Changes:
--   1. tickets.booking_id: change FK from bookings.booking_ref (text) → bookings.id (uuid)
--      and add denormalised booking_ref text column for display
--   2. booking_documents.booking_id: same FK change
--   3. New tickets columns: renter_responsible, admin_fee, charge_status, transfer_submitted_at
--   4. customers: add license_back_url
--   5. booking_documents type check: add 'id_copy'
--   6. Ensure indexes on tickets(vehicle_id), tickets(customer_id), tickets(violation_date)

-- ── 1. tickets table ─────────────────────────────────────────────────────────
-- 1a. Add denormalised booking_ref text column (for display / human-readable ID)
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS booking_ref text;

-- 1b. Add new operational columns
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS renter_responsible   boolean       DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_fee            numeric(10,2) DEFAULT 25,
  ADD COLUMN IF NOT EXISTS charge_status        text,
  ADD COLUMN IF NOT EXISTS transfer_submitted_at timestamptz;

-- 1c. Backfill booking_ref from bookings (where FK currently stores booking_ref text)
UPDATE tickets t
SET    booking_ref = t.booking_id
WHERE  t.booking_id IS NOT NULL
  AND  t.booking_ref IS NULL;

-- 1d. Add a temp UUID column, backfill it from bookings.id, then swap
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS booking_id_uuid uuid;

UPDATE tickets t
SET    booking_id_uuid = b.id
FROM   bookings b
WHERE  b.booking_ref = t.booking_id
  AND  t.booking_id IS NOT NULL;

-- 1e. Drop the old text FK column (constraint drops with it)
DO $$
BEGIN
  -- Drop named FK constraint if it exists
  ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_booking_id_fkey;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE tickets DROP COLUMN IF EXISTS booking_id;

-- 1f. Rename temp column to booking_id
ALTER TABLE tickets RENAME COLUMN booking_id_uuid TO booking_id;

-- 1g. Add new UUID FK
DO $$
BEGIN
  ALTER TABLE tickets
    ADD CONSTRAINT tickets_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1h. Recreate index on new uuid column
DROP   INDEX IF EXISTS tickets_booking_id_idx;
CREATE INDEX IF NOT EXISTS tickets_booking_id_idx ON tickets (booking_id);

-- Ensure other required indexes exist (idempotent)
CREATE INDEX IF NOT EXISTS tickets_vehicle_id_idx     ON tickets (vehicle_id);
CREATE INDEX IF NOT EXISTS tickets_customer_id_idx    ON tickets (customer_id);
CREATE INDEX IF NOT EXISTS tickets_violation_date_idx ON tickets (violation_date DESC);

-- ── 2. booking_documents table ────────────────────────────────────────────────
-- 2a. Add temp UUID column, backfill, swap
ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS booking_id_uuid uuid;

UPDATE booking_documents bd
SET    booking_id_uuid = b.id
FROM   bookings b
WHERE  b.booking_ref = bd.booking_id;

-- Remove rows that could not be linked (orphan rows in newly-created table)
DELETE FROM booking_documents WHERE booking_id_uuid IS NULL;

-- 2b. Drop old text FK column
DO $$
BEGIN
  ALTER TABLE booking_documents DROP CONSTRAINT IF EXISTS booking_documents_booking_id_fkey;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE booking_documents DROP COLUMN IF EXISTS booking_id;

-- 2c. Rename, add NOT NULL, add FK
ALTER TABLE booking_documents RENAME COLUMN booking_id_uuid TO booking_id;
ALTER TABLE booking_documents ALTER COLUMN booking_id SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE booking_documents
    ADD CONSTRAINT booking_documents_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2d. Recreate index
DROP   INDEX IF EXISTS booking_documents_booking_id_idx;
CREATE INDEX IF NOT EXISTS booking_documents_booking_id_idx ON booking_documents (booking_id);

-- 2e. Widen type CHECK to include 'id_copy'
DO $$
BEGIN
  ALTER TABLE booking_documents DROP CONSTRAINT IF EXISTS booking_documents_type_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE booking_documents
    ADD CONSTRAINT booking_documents_type_check
    CHECK (type IN ('agreement', 'insurance', 'other', 'id_copy'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. customers: add license_back_url ────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS license_back_url text;


-- ===========================================================================
-- 0135_ticket_charge_automation.sql
-- ===========================================================================
-- Migration 0132: Ticket charge automation (Part 3)
--
-- Changes:
--   1. tickets: add charge_retry_count, charge_last_attempted_at
--   2. system_settings: seed violation_admin_fee key (if not present)

-- ── 1. tickets table: retry tracking columns ─────────────────────────────────
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS charge_retry_count    integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS charge_last_attempted_at timestamptz;

-- ── 2. system_settings: seed violation_admin_fee ─────────────────────────────
-- Only inserts if the key does not already exist to keep this idempotent.
INSERT INTO system_settings (key, value, description, category)
VALUES (
  'violation_admin_fee',
  '25',
  'Admin processing fee added to violation ticket charge (USD)',
  'fees'
)
ON CONFLICT (key) DO NOTHING;


-- ===========================================================================
-- 0136_repair_tickets_schema.sql
-- ===========================================================================
-- Migration 0136: Idempotent repair for tickets / booking_documents schema
--
-- Migrations 0133–0135 may not have fully applied because 0133 contained
-- invalid "CREATE POLICY IF NOT EXISTS" syntax (PostgreSQL does not support
-- that form), causing Supabase to abort mid-migration.  This migration is a
-- fully idempotent catch-all that brings every table, column, constraint,
-- index, trigger, policy and setting to the correct final state regardless of
-- what was (or was not) applied previously.
--
-- Safe to run on a database where 0133–0135 already applied correctly — every
-- statement uses IF NOT EXISTS / DO ... EXCEPTION WHEN duplicate_object /
-- ON CONFLICT DO NOTHING so nothing is altered twice.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1.  tickets table
-- ═══════════════════════════════════════════════════════════════════════════

-- 1a. Create the table with its final schema if it does not exist yet.
--     booking_id is uuid from the start; if the table already exists this
--     statement is a no-op and step 1b handles any missing pieces.
CREATE TABLE IF NOT EXISTS tickets (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number           text          NOT NULL,
  vehicle_id              text          REFERENCES vehicles(vehicle_id) ON DELETE SET NULL,
  booking_id              uuid          REFERENCES bookings(id) ON DELETE SET NULL,
  booking_ref             text,
  customer_id             uuid          REFERENCES customers(id) ON DELETE SET NULL,
  violation_date          timestamptz   NOT NULL,
  location                text,
  amount                  numeric(10,2) NOT NULL CHECK (amount > 0),
  type                    text          NOT NULL DEFAULT 'parking',
  status                  text          NOT NULL DEFAULT 'new',
  notes                   text,
  activity_log            jsonb         NOT NULL DEFAULT '[]'::jsonb,
  renter_responsible      boolean       DEFAULT false,
  admin_fee               numeric(10,2) DEFAULT 25,
  charge_status           text,
  transfer_submitted_at   timestamptz,
  charge_retry_count      integer       NOT NULL DEFAULT 0,
  charge_last_attempted_at timestamptz,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now()
);

-- 1b. Add any columns that might be missing on a pre-existing table.
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS booking_ref              text,
  ADD COLUMN IF NOT EXISTS renter_responsible       boolean       DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_fee                numeric(10,2) DEFAULT 25,
  ADD COLUMN IF NOT EXISTS charge_status            text,
  ADD COLUMN IF NOT EXISTS transfer_submitted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS charge_retry_count       integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS charge_last_attempted_at timestamptz;

-- 1c. If booking_id is still a text column (old FK to bookings.booking_ref),
--     migrate it to a UUID FK pointing at bookings.id.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type
    INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'tickets'
     AND column_name  = 'booking_id';

  IF col_type = 'text' THEN
    -- Backfill booking_ref from the existing text booking_id value
    UPDATE tickets t
       SET booking_ref = t.booking_id
     WHERE t.booking_id IS NOT NULL
       AND t.booking_ref IS NULL;

    -- Carry the value across to a temp uuid column
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS booking_id_uuid uuid;

    UPDATE tickets t
       SET booking_id_uuid = b.id
      FROM bookings b
     WHERE b.booking_ref = t.booking_id
       AND t.booking_id IS NOT NULL;

    -- Drop old text FK
    ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_booking_id_fkey;
    ALTER TABLE tickets DROP COLUMN IF EXISTS booking_id;

    -- Promote temp column
    ALTER TABLE tickets RENAME COLUMN booking_id_uuid TO booking_id;

  END IF;
END $$;

-- 1d. Ensure the UUID FK constraint exists (idempotent).
DO $$
BEGIN
  ALTER TABLE tickets
    ADD CONSTRAINT tickets_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1e. Constraints (idempotent).
DO $$
BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_type_check
    CHECK (type IN ('parking','toll','camera','other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
    CHECK (status IN ('new','matched','transfer_ready','submitted','approved','rejected','charged','closed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1f. Indexes.
CREATE INDEX IF NOT EXISTS tickets_vehicle_id_idx      ON tickets (vehicle_id);
CREATE INDEX IF NOT EXISTS tickets_booking_id_idx      ON tickets (booking_id);
CREATE INDEX IF NOT EXISTS tickets_customer_id_idx     ON tickets (customer_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx          ON tickets (status);
CREATE INDEX IF NOT EXISTS tickets_violation_date_idx  ON tickets (violation_date DESC);
CREATE INDEX IF NOT EXISTS tickets_created_at_idx      ON tickets (created_at DESC);

-- 1g. updated_at trigger.
DROP TRIGGER IF EXISTS tickets_updated_at ON tickets;
CREATE TRIGGER tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 1h. RLS.
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tickets FROM anon;
REVOKE ALL ON TABLE tickets FROM authenticated;
GRANT ALL ON TABLE tickets TO service_role;

DO $$
BEGIN
  CREATE POLICY tickets_service_role_all
    ON tickets FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2.  booking_documents table
-- ═══════════════════════════════════════════════════════════════════════════

-- 2a. Create with final schema (uuid FK) if it does not exist.
CREATE TABLE IF NOT EXISTS booking_documents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type        text        NOT NULL DEFAULT 'other',
  file_url    text        NOT NULL,
  file_name   text,
  mime_type   text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- 2b. If booking_id is still a text column, migrate it to uuid.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type
    INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'booking_documents'
     AND column_name  = 'booking_id';

  IF col_type = 'text' THEN
    ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS booking_id_uuid uuid;

    UPDATE booking_documents bd
       SET booking_id_uuid = b.id
      FROM bookings b
     WHERE b.booking_ref = bd.booking_id;

    -- Remove rows that could not be linked
    DELETE FROM booking_documents WHERE booking_id_uuid IS NULL;

    ALTER TABLE booking_documents DROP CONSTRAINT IF EXISTS booking_documents_booking_id_fkey;
    ALTER TABLE booking_documents DROP COLUMN IF EXISTS booking_id;

    ALTER TABLE booking_documents RENAME COLUMN booking_id_uuid TO booking_id;
    ALTER TABLE booking_documents ALTER COLUMN booking_id SET NOT NULL;
  END IF;
END $$;

-- 2c. Ensure UUID FK constraint exists.
DO $$
BEGIN
  ALTER TABLE booking_documents
    ADD CONSTRAINT booking_documents_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2d. Widen type CHECK to include 'id_copy' (drop old, add new).
DO $$
BEGIN
  ALTER TABLE booking_documents DROP CONSTRAINT IF EXISTS booking_documents_type_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE booking_documents
    ADD CONSTRAINT booking_documents_type_check
    CHECK (type IN ('agreement','insurance','other','id_copy'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2e. Indexes.
DROP   INDEX IF EXISTS booking_documents_booking_id_idx;
CREATE INDEX IF NOT EXISTS booking_documents_booking_id_idx ON booking_documents (booking_id);
CREATE INDEX IF NOT EXISTS booking_documents_type_idx       ON booking_documents (type);

-- 2f. RLS.
ALTER TABLE booking_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE booking_documents FROM anon;
REVOKE ALL ON TABLE booking_documents FROM authenticated;
GRANT ALL ON TABLE booking_documents TO service_role;

DO $$
BEGIN
  CREATE POLICY booking_documents_service_role_all
    ON booking_documents FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.  customers — add document columns
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS license_front_url   text,
  ADD COLUMN IF NOT EXISTS license_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS license_back_url    text;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4.  system_settings — seed violation_admin_fee
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO system_settings (key, value, description, category)
VALUES (
  'violation_admin_fee',
  '25',
  'Admin processing fee added to violation ticket charge (USD)',
  'fees'
)
ON CONFLICT (key) DO NOTHING;


-- ===========================================================================
-- 0137_pending_booking_docs_id_back.sql
-- ===========================================================================
-- Migration 0137: Add ID back-side columns to pending_booking_docs
--
-- Purpose: store the renter's ID back photo alongside the front so both
-- are attached to the owner notification email when a booking is confirmed.
--
-- Safe to re-run: all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards.

ALTER TABLE pending_booking_docs
  ADD COLUMN IF NOT EXISTS id_back_base64   text,
  ADD COLUMN IF NOT EXISTS id_back_filename text,
  ADD COLUMN IF NOT EXISTS id_back_mimetype text;


-- ===========================================================================
-- 0138_remove_phantom_vehicles_fleet_v4.sql
-- ===========================================================================
-- Migration 0138: Remove phantom vehicle rows (fleet v4 pass).
--
-- Context: migration 0130 ran but a 4th vehicle row has re-appeared in the
-- Supabase vehicles table with status = 'active', causing the
-- admin_metrics_v2 "Available Vehicles" KPI to display 4 instead of 3.
--
-- The canonical fleet remains exactly three vehicles:
--   "camry", "camry2013", "fusion2017"
--
-- Fix strategy (mirrors migrations 0124, 0129, and 0130):
--   1. Hard-delete any vehicle row whose vehicle_id is NOT in the canonical set
--      AND that has no referencing bookings (no FK risk).
--   2. Soft-delete (set status = 'inactive') any remaining non-canonical rows
--      that still have booking history and therefore cannot be hard-deleted.
--
-- Safe to re-run: both statements are idempotent.

-- Step 1: hard-delete stale rows with no booking history
DELETE FROM vehicles
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );

-- Step 2: soft-delete for rows that still have booking history
UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{status}', '"inactive"')
WHERE vehicle_id NOT IN ('camry', 'camry2013', 'fusion2017')
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_id = vehicles.vehicle_id
  );


-- ===========================================================================
-- 0139_pending_booking_docs_booking_type.sql
-- ===========================================================================
-- Migration 0139: Add booking_type column to pending_booking_docs
--
-- Purpose: distinguish vehicle agreements from car agreements stored
-- in the rental-agreements bucket.  The column is informational — the
-- agreement_pdf_url path already contains the booking_id which is the
-- canonical lookup key.  This column makes it easy to filter/audit.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS guard.

ALTER TABLE pending_booking_docs
  ADD COLUMN IF NOT EXISTS booking_type text;

COMMENT ON COLUMN pending_booking_docs.booking_type IS
  'Type of booking that produced this agreement row: ''car'' or ''vehicle''';


-- ===========================================================================
-- 0140_category_revenue_separation.sql
-- ===========================================================================
-- 0140_category_revenue_separation.sql
-- Make category ("car" | "vehicle") the canonical partition key for bookings,
-- payment rows, and revenue rows so car/vehicle financial reporting cannot mix.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS category text;

ALTER TABLE revenue_records
  ADD COLUMN IF NOT EXISTS category text;

DO $$
BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE payments ADD COLUMN IF NOT EXISTS category text';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS category text';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bookings_category_idx
  ON bookings (category)
  WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS revenue_records_category_idx
  ON revenue_records (category)
  WHERE category IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS payments_category_idx ON payments (category) WHERE category IS NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS payment_transactions_category_idx ON payment_transactions (category) WHERE category IS NOT NULL';
  END IF;
END $$;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_category_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_category_check
  CHECK (category IS NULL OR category IN ('car','vehicle'));

ALTER TABLE revenue_records DROP CONSTRAINT IF EXISTS revenue_records_category_check;
ALTER TABLE revenue_records
  ADD CONSTRAINT revenue_records_category_check
  CHECK (category IS NULL OR category IN ('car','vehicle'));

DO $$
BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_category_check';
    EXECUTE 'ALTER TABLE payments ADD CONSTRAINT payments_category_check CHECK (category IS NULL OR category IN (''car'',''vehicle''))';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_category_check';
    EXECUTE 'ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_category_check CHECK (category IS NULL OR category IN (''car'',''vehicle''))';
  END IF;
END $$;

-- Backfill bookings.category from vehicles.data.category.
UPDATE bookings b
SET category = lower(v.data->>'category')
FROM vehicles v
WHERE b.category IS NULL
  AND v.vehicle_id = b.vehicle_id
  AND lower(v.data->>'category') IN ('car', 'vehicle');

-- Backfill revenue_records.category from linked bookings first.
UPDATE revenue_records rr
SET category = b.category
FROM bookings b
WHERE rr.category IS NULL
  AND b.booking_ref IS NOT NULL
  AND rr.booking_id = b.booking_ref
  AND b.category IN ('car', 'vehicle');

-- Secondary backfill by vehicle category for remaining revenue rows.
UPDATE revenue_records rr
SET category = lower(v.data->>'category')
FROM vehicles v
WHERE rr.category IS NULL
  AND rr.vehicle_id = v.vehicle_id
  AND lower(v.data->>'category') IN ('car', 'vehicle');

DO $$
BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE $stmt$
      UPDATE payments p
      SET category = b.category
      FROM bookings b
      WHERE p.category IS NULL
        AND p.booking_id = b.id
        AND b.category IN ('car', 'vehicle')
    $stmt$;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    EXECUTE $stmt$
      UPDATE payment_transactions pt
      SET category = b.category
      FROM bookings b
      WHERE pt.category IS NULL
        AND pt.booking_id = b.booking_ref
        AND b.category IN ('car', 'vehicle')
    $stmt$;
  END IF;
END $$;


-- ===========================================================================
-- 0141_fix_vehicle_vehicle_category.sql
-- ===========================================================================
-- Migration 0141: Backfill correct category for vehicle vehicles.
--
-- Root cause: vehicle vehicles could be saved with data.category = 'car'
-- (or no category at all) when they were created or edited through admin
-- portals that did not explicitly send category:'vehicle'.  The
-- deriveVehicleCategory helper in admin-ai-insights returns the explicit
-- category value first, so a stored 'car' value overrides all name/type/id
-- fallback checks — causing vehicle vehicles to pass the car scope filter
-- and appear in the car admin's "Detected Problems" panel.
--
-- Fix strategy:
--   For every vehicle row where any of the canonical vehicle signals is
--   present (vehicle_id starts with 'vehicle', data->>'type' is 'vehicle',
--   or data->>'vehicle_name' contains 'vehicle' case-insensitively), force
--   data.category to 'vehicle'.
--
-- Safe to re-run: the WHERE clause is idempotent.

UPDATE vehicles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{category}', '"vehicle"')
WHERE (
    vehicle_id ILIKE 'vehicle%'
    OR data->>'type' = 'vehicle'
    OR lower(data->>'vehicle_name') LIKE '%vehicle%'
)
  AND (data->>'category' IS NULL OR data->>'category' != 'vehicle');


-- ===========================================================================
-- 0142_canonical_revenue_pipeline.sql
-- ===========================================================================
-- Migration 0142: Canonical revenue pipeline + reconciliation audit surface
--
-- Goal:
--   Ensure every admin financial surface derives from one canonical dataset.
--
-- Canonical inclusion rules:
--   payment_status = 'paid'
--   sync_excluded  = false
--   is_orphan      = false
--   is_cancelled   = false
--   is_no_show     = false
--
-- Notes:
--   • revenue_reporting_base already applies payment_status/sync_excluded/is_orphan.
--   • This migration adds the remaining is_cancelled/is_no_show filters in one place.
--   • The audit view preserves a reusable reconciliation query shape for diagnostics.
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

-- Canonical row-level reporting source for all financial surfaces.
CREATE OR REPLACE VIEW revenue_reporting_canonical AS
SELECT
  booking_id,
  vehicle_id,
  customer_name,
  customer_phone,
  customer_email,
  pickup_date,
  return_date,
  gross_amount,
  COALESCE(stripe_fee, 0)                         AS stripe_fee,
  COALESCE(refund_amount, 0)                      AS refund_amount,
  (gross_amount - COALESCE(stripe_fee, 0) - COALESCE(refund_amount, 0))
                                                  AS canonical_net_amount,
  deposit_amount,
  payment_method,
  payment_status,
  type
FROM revenue_reporting_base
WHERE COALESCE(is_cancelled, false) = false
  AND COALESCE(is_no_show, false)   = false;

-- Canonical gross KPI (all fleets combined).
CREATE OR REPLACE VIEW total_revenue_kpi_canonical AS
SELECT COALESCE(SUM(gross_amount), 0) AS total_revenue
FROM revenue_reporting_canonical;

-- Reconciliation audit surface (preserved diagnostic artifact).
-- Includes raw ledger rows and supplemental charges in one report shape.
CREATE OR REPLACE VIEW revenue_reconciliation_audit AS
WITH rr AS (
  SELECT
    rr.booking_id,
    rr.payment_intent_id,
    COALESCE(rr.gross_amount, 0)::numeric         AS gross,
    COALESCE(rr.stripe_fee, 0)::numeric           AS fees,
    COALESCE(rr.refund_amount, 0)::numeric        AS refunds,
    (COALESCE(rr.gross_amount, 0)
      - COALESCE(rr.stripe_fee, 0)
      - COALESCE(rr.refund_amount, 0))::numeric   AS net,
    'revenue_records'::text                        AS source_table,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan, false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show, false) = false
    ) AS included_in_dashboard,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan, false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show, false) = false
    ) AS included_in_revenue_page,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan, false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show, false) = false
    ) AS included_in_fleet_analytics
  FROM revenue_records rr
),
charges_only AS (
  SELECT
    c.booking_id,
    c.stripe_payment_intent_id                       AS payment_intent_id,
    COALESCE(c.amount, 0)::numeric                   AS gross,
    0::numeric                                       AS fees,
    0::numeric                                       AS refunds,
    COALESCE(c.amount, 0)::numeric                   AS net,
    'charges'::text                                  AS source_table,
    false                                            AS included_in_dashboard,
    false                                            AS included_in_revenue_page,
    false                                            AS included_in_fleet_analytics
  FROM charges c
  WHERE c.status = 'succeeded'
    AND (
      c.stripe_payment_intent_id IS NULL
      OR c.stripe_payment_intent_id NOT IN (
        SELECT payment_intent_id
        FROM revenue_records
        WHERE payment_intent_id IS NOT NULL
      )
    )
)
SELECT * FROM rr
UNION ALL
SELECT * FROM charges_only;


-- ===========================================================================
-- 0143_reconciliation_audit_vehicle_id.sql
-- ===========================================================================
-- Migration 0143: Add vehicle_id to revenue_reconciliation_audit view
--
-- Extends the reconciliation audit view from 0142 to include vehicle_id for
-- per-vehicle diagnostics and API filtering by the v2-revenue-reconciliation
-- endpoint.  The charges CTE pulls vehicle_id via the bookings table join so
-- unlinked charges still appear (with a NULL vehicle_id).
--
-- Safe to re-run: CREATE OR REPLACE VIEW is idempotent.

CREATE OR REPLACE VIEW revenue_reconciliation_audit AS
WITH rr AS (
  SELECT
    rr.booking_id,
    rr.vehicle_id,
    rr.payment_intent_id,
    COALESCE(rr.gross_amount, 0)::numeric          AS gross,
    COALESCE(rr.stripe_fee, 0)::numeric            AS fees,
    COALESCE(rr.refund_amount, 0)::numeric         AS refunds,
    (COALESCE(rr.gross_amount, 0)
      - COALESCE(rr.stripe_fee, 0)
      - COALESCE(rr.refund_amount, 0))::numeric    AS net,
    'revenue_records'::text                         AS source_table,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan,    false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show,   false) = false
    ) AS included_in_dashboard,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan,    false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show,   false) = false
    ) AS included_in_revenue_page,
    (
      rr.payment_status = 'paid'
      AND COALESCE(rr.sync_excluded, false) = false
      AND COALESCE(rr.is_orphan,    false) = false
      AND COALESCE(rr.is_cancelled, false) = false
      AND COALESCE(rr.is_no_show,   false) = false
    ) AS included_in_fleet_analytics
  FROM revenue_records rr
),
charges_only AS (
  SELECT
    c.booking_id,
    b.vehicle_id,
    c.stripe_payment_intent_id                        AS payment_intent_id,
    COALESCE(c.amount, 0)::numeric                    AS gross,
    0::numeric                                        AS fees,
    0::numeric                                        AS refunds,
    COALESCE(c.amount, 0)::numeric                    AS net,
    'charges'::text                                   AS source_table,
    false                                             AS included_in_dashboard,
    false                                             AS included_in_revenue_page,
    false                                             AS included_in_fleet_analytics
  FROM charges c
  -- charges.booking_id stores the booking reference value (equivalent to bookings.booking_ref).
  -- The naming difference is an existing schema convention; the join is intentionally cross-column.
  LEFT JOIN bookings b ON b.booking_ref = c.booking_id
  WHERE c.status = 'succeeded'
    AND (
      c.stripe_payment_intent_id IS NULL
      OR c.stripe_payment_intent_id NOT IN (
        SELECT payment_intent_id
        FROM revenue_records
        WHERE payment_intent_id IS NOT NULL
      )
    )
)
SELECT * FROM rr
UNION ALL
SELECT * FROM charges_only;


-- ===========================================================================
-- 0144_renter_applications_foundation.sql
-- ===========================================================================
-- Migration 0144: renter_applications persistence foundation (Phase 1)
--
-- Establishes a durable renter application record independent of email/localStorage
-- and defines explicit lifecycle + identity status columns for future Stripe Identity
-- integration without changing booking/payment flows.

CREATE TABLE IF NOT EXISTS renter_applications (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL,
  phone                 text        NOT NULL,
  email                 text,
  age                   integer,
  experience            text        NOT NULL,
  apps                  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  agree_terms           boolean     NOT NULL DEFAULT false,
  agree_sms_consent     boolean     NOT NULL DEFAULT false,
  has_insurance         text,
  protection_plan_pref  text,
  license_file_name     text,
  license_mime_type     text,
  insurance_file_name   text,
  insurance_mime_type   text,
  has_license_upload    boolean     NOT NULL DEFAULT false,
  has_insurance_proof   boolean     NOT NULL DEFAULT false,
  precheck_decision     text,
  application_status    text        NOT NULL DEFAULT 'submitted',
  identity_status       text        NOT NULL DEFAULT 'not_started',
  identity_session_id   text,
  identity_verified_at  timestamptz,
  identity_last_error   text,
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz,
  reviewed_by           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_age_check
      CHECK (age IS NULL OR (age >= 18 AND age <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_apps_check
      CHECK (jsonb_typeof(apps) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_has_insurance_check
      CHECK (has_insurance IS NULL OR has_insurance IN ('yes','no'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_protection_plan_pref_check
      CHECK (protection_plan_pref IS NULL OR protection_plan_pref IN ('basic','standard','premium','none'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_precheck_decision_check
      CHECK (precheck_decision IS NULL OR precheck_decision IN ('approved','review','declined'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_application_status_check
      CHECK (application_status IN ('submitted','under_review','approved','rejected','withdrawn','expired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_identity_status_check
      CHECK (identity_status IN ('not_started','requires_input','processing','verified','failed','canceled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_identity_verified_at_check
      CHECK (
        (identity_status = 'verified' AND identity_verified_at IS NOT NULL)
        OR (identity_status <> 'verified' AND identity_verified_at IS NULL)
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS renter_applications_identity_session_id_uq
  ON renter_applications (identity_session_id)
  WHERE identity_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS renter_applications_application_status_idx
  ON renter_applications (application_status, created_at DESC);

CREATE INDEX IF NOT EXISTS renter_applications_identity_status_idx
  ON renter_applications (identity_status, created_at DESC);

CREATE INDEX IF NOT EXISTS renter_applications_created_at_idx
  ON renter_applications (created_at DESC);

CREATE INDEX IF NOT EXISTS renter_applications_phone_idx
  ON renter_applications (phone);

CREATE INDEX IF NOT EXISTS renter_applications_email_idx
  ON renter_applications (lower(email))
  WHERE email IS NOT NULL;

DROP TRIGGER IF EXISTS renter_applications_updated_at ON renter_applications;
CREATE TRIGGER renter_applications_updated_at
  BEFORE UPDATE ON renter_applications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE renter_applications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE renter_applications FROM anon;
REVOKE ALL ON TABLE renter_applications FROM authenticated;
GRANT ALL ON TABLE renter_applications TO service_role;

DO $$
BEGIN
  CREATE POLICY renter_applications_service_role_all
    ON renter_applications
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ===========================================================================
-- 0145_stripe_identity_webhook_events.sql
-- ===========================================================================
-- Migration 0145: Stripe Identity webhook idempotency log
--
-- Stores processed Stripe Identity webhook event IDs so webhook handling
-- is idempotent across retries/replays.

CREATE TABLE IF NOT EXISTS stripe_identity_webhook_events (
  id                  bigserial   PRIMARY KEY,
  stripe_event_id     text        NOT NULL UNIQUE,
  event_type          text        NOT NULL,
  application_id      uuid        REFERENCES renter_applications(id) ON DELETE SET NULL,
  identity_session_id text,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stripe_identity_webhook_events_application_id_idx
  ON stripe_identity_webhook_events (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS stripe_identity_webhook_events_identity_session_id_idx
  ON stripe_identity_webhook_events (identity_session_id)
  WHERE identity_session_id IS NOT NULL;

ALTER TABLE stripe_identity_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE stripe_identity_webhook_events FROM anon;
REVOKE ALL ON TABLE stripe_identity_webhook_events FROM authenticated;
GRANT ALL ON TABLE stripe_identity_webhook_events TO service_role;

DO $$
BEGIN
  CREATE POLICY stripe_identity_webhook_events_service_role_all
    ON stripe_identity_webhook_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ===========================================================================
-- 0146_application_review_phase3.sql
-- ===========================================================================
-- Migration 0146: Phase 3 — admin review operations
--
-- Extends renter_applications with:
--   • review_version        — monotonic counter for optimistic concurrency protection
--   • needs_info_reason     — reason text when action is "needs_info"
--   • last_reviewer_notes   — freeform notes from the most recent reviewer
--   • checkr_candidate_id,
--     checkr_report_id,
--     checkr_report_status,
--     checkr_mvr_status     — inert Checkr attachment points (nullable, no integration yet)
--
-- Expands application_status to include "needs_info".
--
-- Creates application_review_actions (append-only audit table) with:
--   • action_request_id uniqueness constraint to prevent duplicate submissions.

-- ── 1. New columns on renter_applications ─────────────────────────────────────

ALTER TABLE renter_applications
  ADD COLUMN IF NOT EXISTS review_version       bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS needs_info_reason    text,
  ADD COLUMN IF NOT EXISTS last_reviewer_notes  text,
  ADD COLUMN IF NOT EXISTS checkr_candidate_id  text,
  ADD COLUMN IF NOT EXISTS checkr_report_id     text,
  ADD COLUMN IF NOT EXISTS checkr_report_status text,
  ADD COLUMN IF NOT EXISTS checkr_mvr_status    text;

-- ── 2. Expand the application_status check constraint to include needs_info ───

DO $$
BEGIN
  ALTER TABLE renter_applications
    DROP CONSTRAINT IF EXISTS renter_applications_application_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE renter_applications
  ADD CONSTRAINT renter_applications_application_status_check
    CHECK (application_status IN (
      'submitted', 'under_review', 'needs_info',
      'approved',  'rejected', 'withdrawn', 'expired'
    ));

-- ── 3. application_review_actions audit table ─────────────────────────────────

CREATE TABLE IF NOT EXISTS application_review_actions (
  id                bigserial    PRIMARY KEY,
  application_id    uuid         NOT NULL REFERENCES renter_applications(id) ON DELETE CASCADE,
  action            text         NOT NULL,
  performed_by      text         NOT NULL,
  notes             text,
  previous_status   text         NOT NULL,
  new_status        text         NOT NULL,
  action_request_id uuid         NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE application_review_actions
    ADD CONSTRAINT application_review_actions_action_check
      CHECK (action IN ('approved', 'rejected', 'needs_info'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE application_review_actions
    ADD CONSTRAINT application_review_actions_previous_status_check
      CHECK (previous_status IN (
        'submitted', 'under_review', 'needs_info',
        'approved',  'rejected', 'withdrawn', 'expired'
      ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE application_review_actions
    ADD CONSTRAINT application_review_actions_new_status_check
      CHECK (new_status IN (
        'submitted', 'under_review', 'needs_info',
        'approved',  'rejected', 'withdrawn', 'expired'
      ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Idempotency: one action per (application, request-id)
CREATE UNIQUE INDEX IF NOT EXISTS application_review_actions_idempotency_uq
  ON application_review_actions (application_id, action_request_id);

CREATE INDEX IF NOT EXISTS application_review_actions_application_id_idx
  ON application_review_actions (application_id, created_at DESC);

ALTER TABLE application_review_actions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE application_review_actions FROM anon;
REVOKE ALL ON TABLE application_review_actions FROM authenticated;
GRANT  ALL ON TABLE application_review_actions TO service_role;
GRANT  USAGE, SELECT ON SEQUENCE application_review_actions_id_seq TO service_role;

DO $$
BEGIN
  CREATE POLICY application_review_actions_service_role_all
    ON application_review_actions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ===========================================================================
-- 0147_expense_receipts.sql
-- ===========================================================================
-- Expense receipt uploads for fleet expenses / expenses admin UI.
-- Safe to re-run.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS receipt_url text,
  ADD COLUMN IF NOT EXISTS receipt_filename text,
  ADD COLUMN IF NOT EXISTS receipt_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_size integer,
  ADD COLUMN IF NOT EXISTS receipt_mime_type text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'fleet_expenses'
  ) THEN
    EXECUTE $sql$
      ALTER TABLE fleet_expenses
        ADD COLUMN IF NOT EXISTS receipt_url text,
        ADD COLUMN IF NOT EXISTS receipt_filename text,
        ADD COLUMN IF NOT EXISTS receipt_uploaded_at timestamptz,
        ADD COLUMN IF NOT EXISTS receipt_size integer,
        ADD COLUMN IF NOT EXISTS receipt_mime_type text
    $sql$;
  END IF;
END $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-receipts',
  'expense-receipts',
  false,
  10485760,
  ARRAY['image/jpeg','image/png','image/webp','application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = 10485760,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','application/pdf'];

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense-receipts: service write" ON storage.objects;

CREATE POLICY "expense-receipts: service write"
  ON storage.objects FOR ALL
  TO service_role
  USING     (bucket_id = 'expense-receipts')
  WITH CHECK (bucket_id = 'expense-receipts');


-- ===========================================================================
-- 0148_customer_ledger_phase_a.sql
-- ===========================================================================
-- Migration 0148: Customer ledger — Phase A foundation
--
-- PHASE A: Additive schema only. Zero production behavior changes.
--
-- What this migration does:
--   1. Extends `customers` with identity-normalization and migration-tracking columns.
--   2. Creates `customer_ledger`            — append-only financial ledger per customer.
--   3. Creates `customer_migration_log`     — audit trail for every customer-link decision.
--   4. Creates `customer_identity_conflicts`— review queue for ambiguous identity matches.
--   5. Creates `ledger_reconciliation_mismatches` — drift log between ledger and legacy.
--   6. Creates `ledger_idempotency_log`     — duplicate-write prevention audit.
--   7. Creates `ledger_rollback_events`     — rollback / replay operation audit.
--   8. Seeds `customer_ledger_mode = 'shadow'` in system_settings.
--
-- Guardrails enforced:
--   • No existing table is altered destructively (all ADD COLUMN IF NOT EXISTS).
--   • No existing view, function, trigger, or RPC is modified.
--   • No Stripe runtime paths are touched.
--   • No enforcement behavior changes — new tables are dormant data structures.
--   • All new tables use append-only + idempotency patterns from day one.
--
-- Safe to re-run: every DDL statement is guarded with IF NOT EXISTS / OR REPLACE.

-- ── 1. Extend `customers` with identity-normalization columns ─────────────────
--
-- normalized_phone  : E.164-like digits-only string (e.g. '+13105551234').
--                     Populated during Phase B backfill; null until then.
-- normalized_email  : Lower-cased, trimmed email (email is already normalised
--                     by migration 0057, so this mirrors that value for
--                     cross-table consistency without a join).
-- stripe_customer_id: Canonical Stripe cus_xxx for this customer entity.
--                     Bookings store their own stripe_customer_id; this column
--                     will hold the single canonical ID after Phase B linking.
-- ledger_migration_status: Lifecycle state for the Phase B backfill process.
--                     pending   → not yet evaluated
--                     migrated  → deterministically linked, ledger populated
--                     conflict  → ambiguous match, routed to identity_conflicts
--                     skipped   → no bookings / nothing to migrate
-- ledger_migrated_at: Timestamp when migration_status was last set to 'migrated'.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS normalized_phone        text,
  ADD COLUMN IF NOT EXISTS normalized_email        text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id      text,
  ADD COLUMN IF NOT EXISTS ledger_migration_status text NOT NULL DEFAULT 'pending'
    CHECK (ledger_migration_status IN ('pending','migrated','conflict','skipped')),
  ADD COLUMN IF NOT EXISTS ledger_migrated_at      timestamptz;

-- Index: deterministic phone match (Phase B linking)
CREATE INDEX IF NOT EXISTS customers_normalized_phone_idx
  ON customers (normalized_phone)
  WHERE normalized_phone IS NOT NULL;

-- Index: deterministic email match (Phase B linking)
CREATE INDEX IF NOT EXISTS customers_normalized_email_idx
  ON customers (normalized_email)
  WHERE normalized_email IS NOT NULL;

-- Index: Stripe customer ID match (Phase B linking)
CREATE UNIQUE INDEX IF NOT EXISTS customers_stripe_customer_id_idx
  ON customers (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Index: migration backfill cursor
CREATE INDEX IF NOT EXISTS customers_ledger_migration_status_idx
  ON customers (ledger_migration_status);

-- ── 2. `customer_ledger` — append-only financial ledger ───────────────────────
--
-- Each row is a single immutable financial event for a customer.
-- Debits (charges, fees) have direction='debit',  amount_cents > 0.
-- Credits (payments, refunds, waivers) have direction='credit', amount_cents > 0.
-- The net balance is SUM(debit) − SUM(credit).
--
-- The UNIQUE constraint on (source_type, source_id) is the idempotency gate:
-- any duplicate write resolves to a conflict at the DB layer rather than a
-- phantom row.  All write helpers must use ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS customer_ledger (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid        NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  booking_ref      text,                   -- bookings.booking_ref; nullable (customer-level entries)
  transaction_type text        NOT NULL
    CHECK (transaction_type IN (
      'rental_charge',
      'extension_charge',
      'late_fee',
      'ticket_charge',
      'manual_charge',
      'stripe_payment',
      'stripe_refund',
      'admin_waiver',
      'balance_payment',
      'payment_plan_installment'
    )),
  direction        text        NOT NULL CHECK (direction IN ('debit','credit')),
  amount_cents     integer     NOT NULL CHECK (amount_cents >= 0),
  source_type      text        NOT NULL,   -- matches transaction_type for most entries
  source_id        text        NOT NULL,   -- idempotency key (pi_id, charge_id, etc.)
  description      text,
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by      text,                   -- 'stripe_webhook' | 'admin' | 'backfill' | 'system'

  -- Idempotency constraint — the sole mechanism preventing duplicate entries.
  CONSTRAINT customer_ledger_source_unique UNIQUE (source_type, source_id)
);

-- Indexes for balance queries and audit lookups
CREATE INDEX IF NOT EXISTS customer_ledger_customer_id_idx
  ON customer_ledger (customer_id);

CREATE INDEX IF NOT EXISTS customer_ledger_booking_ref_idx
  ON customer_ledger (booking_ref)
  WHERE booking_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_ledger_created_at_idx
  ON customer_ledger (created_at DESC);

CREATE INDEX IF NOT EXISTS customer_ledger_source_type_idx
  ON customer_ledger (source_type);

-- ── 3. `customer_migration_log` — backfill audit trail ───────────────────────
--
-- One row per customer-link decision made during Phase B backfill.
-- confidence_tier values:
--   exact_stripe_id  → booking.stripe_customer_id === customers.stripe_customer_id
--   exact_email      → booking.customer_email    === customers.email (normalised)
--   exact_phone      → booking.customer_phone    === customers.normalized_phone
--   ambiguous        → fell through all deterministic tiers; routed to conflict queue
-- action:
--   linked           → booking linked to this customer record
--   conflict_created → entry written to customer_identity_conflicts
--   skipped          → no match possible / nothing to do

CREATE TABLE IF NOT EXISTS customer_migration_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid        REFERENCES customers(id) ON DELETE SET NULL,
  booking_ref      text,
  confidence_tier  text        NOT NULL
    CHECK (confidence_tier IN (
      'exact_stripe_id',
      'exact_email',
      'exact_phone',
      'ambiguous'
    )),
  action           text        NOT NULL
    CHECK (action IN ('linked','conflict_created','skipped')),
  match_details    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  migrated_by      text,       -- 'backfill_script' | 'admin_manual'
  migrated_at      timestamptz NOT NULL DEFAULT now(),
  notes            text
);

CREATE INDEX IF NOT EXISTS customer_migration_log_customer_id_idx
  ON customer_migration_log (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_migration_log_booking_ref_idx
  ON customer_migration_log (booking_ref)
  WHERE booking_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_migration_log_confidence_tier_idx
  ON customer_migration_log (confidence_tier);

CREATE INDEX IF NOT EXISTS customer_migration_log_action_idx
  ON customer_migration_log (action);

-- ── 4. `customer_identity_conflicts` — manual review queue ───────────────────
--
-- Populated only when confidence_tier = 'ambiguous'.
-- Nothing auto-merges from this table.  An admin must set status='resolved'
-- with a chosen customer_id before any ledger linking occurs.
-- status values:
--   pending   → awaiting admin review
--   resolved  → admin chose a canonical customer_id
--   dismissed → admin determined no valid match; booking remains unlinked

CREATE TABLE IF NOT EXISTS customer_identity_conflicts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref           text        NOT NULL,
  candidate_customer_ids jsonb      NOT NULL DEFAULT '[]'::jsonb,
  conflict_reason       text        NOT NULL,
  raw_booking_data      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status                text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','resolved','dismissed')),
  resolved_customer_id  uuid        REFERENCES customers(id) ON DELETE SET NULL,
  resolved_by           text,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_identity_conflicts_booking_ref_idx
  ON customer_identity_conflicts (booking_ref);

CREATE INDEX IF NOT EXISTS customer_identity_conflicts_status_idx
  ON customer_identity_conflicts (status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION _set_customer_identity_conflicts_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_identity_conflicts_updated_at
  ON customer_identity_conflicts;

CREATE TRIGGER customer_identity_conflicts_updated_at
  BEFORE UPDATE ON customer_identity_conflicts
  FOR EACH ROW EXECUTE FUNCTION _set_customer_identity_conflicts_updated_at();

-- ── 5. `ledger_reconciliation_mismatches` — drift audit ──────────────────────
--
-- Populated by the reconciliation cron / shadow-validation step.
-- Each row records one instance where ledger-derived balance ≠ legacy balance.
-- drift_cents = ledger_balance_cents − legacy_balance_cents.
-- status:
--   open        → unresolved mismatch
--   explained   → mismatch understood (e.g. timing, pending entry)
--   resolved    → ledger corrected or legacy corrected

CREATE TABLE IF NOT EXISTS ledger_reconciliation_mismatches (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid        REFERENCES customers(id) ON DELETE SET NULL,
  booking_ref           text,
  ledger_balance_cents  integer     NOT NULL,
  legacy_balance_cents  integer     NOT NULL,
  drift_cents           integer     NOT NULL
    GENERATED ALWAYS AS (ledger_balance_cents - legacy_balance_cents) STORED,
  drift_direction       text        NOT NULL
    CHECK (drift_direction IN ('ledger_higher','ledger_lower','match')),
  detected_at           timestamptz NOT NULL DEFAULT now(),
  detection_run_id      text,       -- correlates rows from a single cron run
  status                text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','explained','resolved')),
  explanation           text,
  resolved_by           text,
  resolved_at           timestamptz,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_customer_id_idx
  ON ledger_reconciliation_mismatches (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_status_idx
  ON ledger_reconciliation_mismatches (status);

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_detected_at_idx
  ON ledger_reconciliation_mismatches (detected_at DESC);

CREATE INDEX IF NOT EXISTS ledger_recon_mismatches_run_id_idx
  ON ledger_reconciliation_mismatches (detection_run_id)
  WHERE detection_run_id IS NOT NULL;

-- ── 6. `ledger_idempotency_log` — duplicate-write prevention audit ────────────
--
-- Populated whenever a ledger write attempt is rejected by the
-- (source_type, source_id) unique constraint (ON CONFLICT DO NOTHING path).
-- This makes duplicate-write prevention visible rather than silent.

CREATE TABLE IF NOT EXISTS ledger_idempotency_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type  text        NOT NULL,
  source_id    text        NOT NULL,
  caller       text,       -- which API endpoint / cron attempted the write
  booking_ref  text,
  customer_id  uuid        REFERENCES customers(id) ON DELETE SET NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ledger_idempotency_log_source_idx
  ON ledger_idempotency_log (source_type, source_id);

CREATE INDEX IF NOT EXISTS ledger_idempotency_log_attempted_at_idx
  ON ledger_idempotency_log (attempted_at DESC);

-- ── 7. `ledger_rollback_events` — rollback / replay audit ────────────────────
--
-- Records every time a ledger mode change or rollback/replay operation occurs.
-- event_type:
--   mode_change  → CUSTOMER_LEDGER_MODE setting changed
--   rollback     → explicit rollback of ledger entries for a booking/customer
--   replay       → explicit re-processing of source events into the ledger

CREATE TABLE IF NOT EXISTS ledger_rollback_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text        NOT NULL
    CHECK (event_type IN ('mode_change','rollback','replay')),
  previous_mode text,
  new_mode      text,
  scope_type   text,       -- 'global' | 'customer' | 'booking'
  scope_id     text,       -- customer_id or booking_ref when scoped
  initiated_by text        NOT NULL,
  reason       text,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_rollback_events_event_type_idx
  ON ledger_rollback_events (event_type);

CREATE INDEX IF NOT EXISTS ledger_rollback_events_created_at_idx
  ON ledger_rollback_events (created_at DESC);

-- ── 8. Seed `customer_ledger_mode` in system_settings ────────────────────────
--
-- Controls which balance/enforcement path is canonical.
--   shadow   → ledger writes are dormant; legacy paths are sole authority (DEFAULT)
--   parallel → both paths run; results compared; no enforcement from ledger
--   warn     → ledger runs; mismatches generate admin alerts; no hard blocks
--   review   → ledger mismatches route new bookings to admin review queue
--   block    → ledger is canonical; non-zero balance blocks new bookings
--
-- Default is 'shadow' — no production behavior change until explicitly promoted.

INSERT INTO system_settings (key, value, description, category)
VALUES (
  'customer_ledger_mode',
  '"shadow"',
  'Customer ledger enforcement mode. '
    'shadow=dormant (legacy only), parallel=dual-run+compare, '
    'warn=ledger alerts, review=admin queue routing, block=ledger canonical. '
    'Do not advance past shadow until Phase D reconciliation thresholds are met.',
  'ledger'
)
ON CONFLICT (key) DO NOTHING;


-- ===========================================================================
-- 0148_unified_renter_balance_ledger.sql
-- ===========================================================================
-- Migration 0148: Unified renter balance ledger (Phase 1 foundation)
--
-- Goal:
--   Single append-only transaction ledger for all renter/booking debt events.
--   Balances must be derived from transactions, never manually overwritten.

CREATE TABLE IF NOT EXISTS renter_balance_ledger (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                text NOT NULL,
  customer_id               uuid REFERENCES customers(id) ON DELETE SET NULL,
  transaction_type          text NOT NULL CHECK (
    transaction_type IN (
      'extension',
      'late_fee',
      'ticket',
      'damage',
      'repair',
      'deductible',
      'smoking',
      'cleaning',
      'towing',
      'misc',
      'payment',
      'refund',
      'waiver',
      'adjustment'
    )
  ),
  direction                 text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount                    numeric(10,2) NOT NULL CHECK (amount > 0),
  notes                     text,
  source_type               text,
  source_id                 text,
  stripe_payment_intent_id  text,
  related_charge_id         uuid REFERENCES charges(id) ON DELETE SET NULL,
  related_ticket_id         uuid REFERENCES tickets(id) ON DELETE SET NULL,
  metadata                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by                text NOT NULL DEFAULT 'system',
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT renter_balance_ledger_source_pair_chk
    CHECK (
      (source_type IS NULL AND source_id IS NULL)
      OR
      (source_type IS NOT NULL AND source_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_booking_idx
  ON renter_balance_ledger (booking_id);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_customer_idx
  ON renter_balance_ledger (customer_id);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_created_at_idx
  ON renter_balance_ledger (created_at DESC);

CREATE INDEX IF NOT EXISTS renter_balance_ledger_booking_created_idx
  ON renter_balance_ledger (booking_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS renter_balance_ledger_source_unique_idx
  ON renter_balance_ledger (source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

COMMENT ON TABLE renter_balance_ledger IS
  'Append-only renter/booking balance ledger. Outstanding balance is derived from entries, never manually overwritten.';

COMMENT ON COLUMN renter_balance_ledger.direction IS
  'debit increases amount owed by renter; credit decreases amount owed.';

COMMENT ON COLUMN renter_balance_ledger.related_charge_id IS
  'Optional source link; ON DELETE SET NULL intentionally preserves immutable ledger history if source rows are removed.';

COMMENT ON COLUMN renter_balance_ledger.related_ticket_id IS
  'Optional source link; ON DELETE SET NULL intentionally preserves immutable ledger history if source rows are removed.';

CREATE OR REPLACE FUNCTION fn_prevent_renter_balance_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'renter_balance_ledger is append-only (% not allowed)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_renter_balance_ledger_no_update ON renter_balance_ledger;
DROP TRIGGER IF EXISTS trg_renter_balance_ledger_no_delete ON renter_balance_ledger;

CREATE TRIGGER trg_renter_balance_ledger_no_update
  BEFORE UPDATE ON renter_balance_ledger
  FOR EACH ROW
  EXECUTE FUNCTION fn_prevent_renter_balance_ledger_mutation();

CREATE TRIGGER trg_renter_balance_ledger_no_delete
  BEFORE DELETE ON renter_balance_ledger
  FOR EACH ROW
  EXECUTE FUNCTION fn_prevent_renter_balance_ledger_mutation();

CREATE OR REPLACE VIEW renter_balance_ledger_summary AS
WITH grouped AS (
  SELECT
    booking_id,
    customer_id,
    SUM(CASE WHEN direction = 'debit'  THEN amount ELSE 0 END) AS debit_total,
    SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END) AS credit_total,
    COUNT(*)::bigint AS transaction_count,
    MAX(created_at) AS last_transaction_at
  FROM renter_balance_ledger
  GROUP BY booking_id, customer_id
)
SELECT
  booking_id,
  customer_id,
  ROUND(debit_total::numeric, 2) AS total_charges,
  ROUND(credit_total::numeric, 2) AS total_credits,
  ROUND((debit_total - credit_total)::numeric, 2) AS net_balance,
  transaction_count,
  last_transaction_at
FROM grouped;


-- ===========================================================================
-- 0149_customer_identity_backfill.sql
-- ===========================================================================
-- Migration 0149: Customer identity backfill — Phase B supporting indexes
--
-- PHASE B: Additive index-only migration. Zero behavior changes.
--
-- Adds indexes on bookings and customers needed for efficient Phase B
-- identity-matching queries. No new tables are created; Phase A (0148)
-- already created all necessary tables.
--
-- Safe to re-run: every DDL is guarded with IF NOT EXISTS.

-- ── 1. bookings — phone matching index ───────────────────────────────────────
--
-- Phase B matches bookings against customers via customer_phone.
-- The column exists (added via earlier migrations) but has no general index.

CREATE INDEX IF NOT EXISTS bookings_customer_phone_idx
  ON bookings (customer_phone)
  WHERE customer_phone IS NOT NULL;

-- ── 2. bookings — identity backfill cursor index ─────────────────────────────
--
-- Allows the backfill to page through unlinked bookings efficiently using
-- booking_ref as the stable sort key / resume cursor.

CREATE INDEX IF NOT EXISTS bookings_identity_cursor_idx
  ON bookings (booking_ref)
  WHERE booking_ref IS NOT NULL;

-- ── 3. customers — normalized phone lookup index ──────────────────────────────
--
-- Populated during Phase B normalize_customers pass. Used by exact_phone tier.
-- Phase A (0148) already creates this index; this statement is a no-op if
-- 0148 ran first but is idempotent either way.

CREATE INDEX IF NOT EXISTS customers_normalized_phone_idx
  ON customers (normalized_phone)
  WHERE normalized_phone IS NOT NULL;

-- ── 4. customers — normalized email lookup index ──────────────────────────────

CREATE INDEX IF NOT EXISTS customers_normalized_email_idx
  ON customers (normalized_email)
  WHERE normalized_email IS NOT NULL;

-- ── 5. customers — Stripe customer ID lookup ──────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS customers_stripe_customer_id_idx
  ON customers (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ── 6. customer_migration_log — idempotency guard index ───────────────────────
--
-- Allows the backfill to quickly check if a booking_ref has already been
-- processed without a full table scan.

CREATE UNIQUE INDEX IF NOT EXISTS customer_migration_log_booking_ref_action_idx
  ON customer_migration_log (booking_ref, action)
  WHERE booking_ref IS NOT NULL;


-- ===========================================================================
-- 0149_ledger_due_date.sql
-- ===========================================================================
-- Migration 0149: Add due_date to renter_balance_ledger (Phase 2 Add Charge)
--
-- Allows admins to record when a charge becomes due so renters can be
-- reminded before the due date arrives (Phase 5 renter-facing flow).

ALTER TABLE renter_balance_ledger
  ADD COLUMN IF NOT EXISTS due_date date;

CREATE INDEX IF NOT EXISTS renter_balance_ledger_due_date_idx
  ON renter_balance_ledger (due_date)
  WHERE due_date IS NOT NULL;

COMMENT ON COLUMN renter_balance_ledger.due_date IS
  'Optional date when this charge is due. Used for renter reminders and overdue tracking (Phase 5+).';


-- ===========================================================================
-- 0150_ledger_stripe_pi_index.sql
-- ===========================================================================
-- Migration 0150: Ledger Phase 3 — stripe_payment_intent_id index
--
-- Adds a fast lookup index for payment-intent-based idempotency checks
-- so duplicate webhook deliveries are resolved in a single indexed seek
-- rather than a full-table scan.

CREATE INDEX IF NOT EXISTS renter_balance_ledger_pi_idx
  ON renter_balance_ledger (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

COMMENT ON INDEX renter_balance_ledger_pi_idx IS
  'Fast lookup by Stripe payment_intent_id for webhook idempotency checks (Phase 3).';


-- ===========================================================================
-- 0151_ledger_backfill_log.sql
-- ===========================================================================
-- Migration 0151: Ledger Backfill Log
--
-- Provides a resumable cursor and audit trail for the one-time ledger backfill
-- job (api/ledger-backfill.js).  Each row records the outcome of replaying a
-- single source event into the renter_balance_ledger table.
--
-- status values:
--   ok      – transaction inserted (or already existed; idempotent)
--   skip    – skipped (no ledger-eligible data, e.g. missing payment_intent_id)
--   error   – insert attempt failed; error_message captures the reason

CREATE TABLE IF NOT EXISTS ledger_backfill_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          text        NOT NULL,
  source_table    text        NOT NULL CHECK (source_table IN ('revenue_records', 'charges', 'tickets', 'waiver_events')),
  source_id       text        NOT NULL,
  booking_id      text,
  status          text        NOT NULL CHECK (status IN ('ok', 'skip', 'error')),
  ledger_tx_id    uuid        REFERENCES renter_balance_ledger(id) ON DELETE SET NULL,
  error_message   text,
  processed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_backfill_log_run_idx
  ON ledger_backfill_log (run_id);

CREATE INDEX IF NOT EXISTS ledger_backfill_log_source_idx
  ON ledger_backfill_log (source_table, source_id);

CREATE INDEX IF NOT EXISTS ledger_backfill_log_booking_idx
  ON ledger_backfill_log (booking_id)
  WHERE booking_id IS NOT NULL;

-- Unique constraint so re-runs within the same run_id are idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_backfill_log_run_source_unique_idx
  ON ledger_backfill_log (run_id, source_table, source_id);

COMMENT ON TABLE ledger_backfill_log IS
  'Audit trail and resumable cursor for ledger backfill runs (api/ledger-backfill.js). Each row represents one source event processed.';


-- ===========================================================================
-- 0152_ledger_reconcile_snapshots.sql
-- ===========================================================================
-- Migration 0152: Ledger Reconciliation Snapshots
--
-- Persists the output of each on-demand or nightly reconciliation run so that
-- the platform has a long-term operational trust record.
--
-- Each snapshot captures:
--   - aggregate KPIs (matched %, discrepancy total, unresolved count)
--   - top-10 largest mismatches as JSONB for quick inspection
--   - the full per-booking detail array as JSONB for drill-down
--   - anomalies detected during the same run

CREATE TABLE IF NOT EXISTS ledger_reconcile_snapshots (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at              timestamptz NOT NULL DEFAULT now(),
  run_type            text        NOT NULL DEFAULT 'manual' CHECK (run_type IN ('manual', 'nightly')),
  bookings_checked    integer     NOT NULL DEFAULT 0,
  matched_count       integer     NOT NULL DEFAULT 0,
  matched_pct         numeric(5,2),
  unresolved_count    integer     NOT NULL DEFAULT 0,
  discrepancy_total   numeric(12,2) NOT NULL DEFAULT 0,
  largest_mismatches  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  anomalies_count     integer     NOT NULL DEFAULT 0,
  anomaly_types       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  anomaly_detail      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  details_json        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  date_from           text,
  date_to             text,
  duration_ms         integer,
  created_by          text        NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS ledger_reconcile_snapshots_run_at_idx
  ON ledger_reconcile_snapshots (run_at DESC);

CREATE INDEX IF NOT EXISTS ledger_reconcile_snapshots_run_type_idx
  ON ledger_reconcile_snapshots (run_type);

COMMENT ON TABLE ledger_reconcile_snapshots IS
  'Persisted output of each reconciliation run (on-demand or nightly). Provides long-term operational trust records.';


-- ===========================================================================
-- 0153_payment_plans.sql
-- ===========================================================================
-- Migration 0153: Payment Plans + Installments
--
-- Supports multi-installment payment arrangements for renters with outstanding
-- balances.  The ledger architecture makes each installment individually
-- traceable — every installment row links back to its ledger_transaction_id,
-- ensuring partial installment payments reconcile cleanly against ledger totals.
--
-- payment_plans.status:
--   active      – plan is in progress
--   completed   – all installments paid
--   defaulted   – one or more installments failed and no recovery
--   cancelled   – plan cancelled by admin
--
-- payment_plan_installments.status:
--   pending     – not yet due or not yet attempted
--   paid        – successfully charged
--   failed      – charge attempt failed
--   partial     – partial payment applied (remainder still owed)

CREATE TABLE IF NOT EXISTS payment_plans (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        text          NOT NULL REFERENCES bookings(booking_ref) ON DELETE RESTRICT,
  customer_email    text          NOT NULL,
  total_amount      numeric(10,2) NOT NULL CHECK (total_amount > 0),
  installments      integer       NOT NULL CHECK (installments BETWEEN 2 AND 24),
  interval_days     integer       NOT NULL CHECK (interval_days BETWEEN 1 AND 90),
  next_due_date     timestamptz,
  status            text          NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'completed', 'defaulted', 'cancelled')),
  notes             text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  created_by        text          NOT NULL DEFAULT 'admin'
);

CREATE TABLE IF NOT EXISTS payment_plan_installments (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id               uuid          NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
  installment_number    integer       NOT NULL,
  amount                numeric(10,2) NOT NULL CHECK (amount > 0),
  due_date              timestamptz   NOT NULL,
  paid_at               timestamptz,
  payment_intent_id     text,
  ledger_transaction_id uuid          REFERENCES renter_balance_ledger(id) ON DELETE SET NULL,
  status                text          NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'paid', 'failed', 'partial')),
  failure_message       text,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (plan_id, installment_number)
);

CREATE INDEX IF NOT EXISTS payment_plans_booking_idx
  ON payment_plans (booking_id);

CREATE INDEX IF NOT EXISTS payment_plans_customer_email_idx
  ON payment_plans (customer_email);

CREATE INDEX IF NOT EXISTS payment_plans_status_idx
  ON payment_plans (status);

CREATE INDEX IF NOT EXISTS payment_plan_installments_plan_idx
  ON payment_plan_installments (plan_id);

CREATE INDEX IF NOT EXISTS payment_plan_installments_due_date_idx
  ON payment_plan_installments (due_date)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS payment_plan_installments_ledger_idx
  ON payment_plan_installments (ledger_transaction_id)
  WHERE ledger_transaction_id IS NOT NULL;

-- Auto-update updated_at on payment_plans
CREATE OR REPLACE FUNCTION fn_payment_plans_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_plans_updated_at ON payment_plans;
CREATE TRIGGER trg_payment_plans_updated_at
  BEFORE UPDATE ON payment_plans
  FOR EACH ROW EXECUTE FUNCTION fn_payment_plans_set_updated_at();

DROP TRIGGER IF EXISTS trg_payment_plan_installments_updated_at ON payment_plan_installments;
CREATE TRIGGER trg_payment_plan_installments_updated_at
  BEFORE UPDATE ON payment_plan_installments
  FOR EACH ROW EXECUTE FUNCTION fn_payment_plans_set_updated_at();

COMMENT ON TABLE payment_plans IS
  'Multi-installment payment plans for renters with outstanding balances. Installments link to renter_balance_ledger via ledger_transaction_id.';

COMMENT ON TABLE payment_plan_installments IS
  'Individual installments within a payment plan. Each paid installment links to its ledger transaction for reconciliation.';


-- ===========================================================================
-- 0154_confirmed_inventory_lifecycle.sql
-- ===========================================================================
-- Migration 0154: confirmed inventory lifecycle for blocked_dates
--
-- Goal:
--   Keep pre-payment bookings in the database for webhook linkage / retry cleanup
--   while ensuring public inventory is blocked only after a confirmed payment.
--
-- Change:
--   Tighten on_booking_create so blocked_dates rows are created only for
--   confirmed reservation / occupancy statuses. Pending checkout rows must not
--   create public inventory blocks.

CREATE OR REPLACE FUNCTION public.on_booking_create()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_end_date DATE;
  v_end_time TIME;
BEGIN
  -- Only confirmed reservation / occupancy states may create blocked_dates rows.
  -- This keeps pending checkout attempts from affecting public availability.
  IF NEW.pickup_date IS NOT NULL AND NEW.return_date IS NOT NULL
     AND NEW.status IN ('reserved', 'booked_paid', 'active_rental', 'approved', 'active', 'overdue') THEN
    BEGIN
      IF NEW.booking_ref IS NULL THEN
        RAISE EXCEPTION
          'on_booking_create: booking_ref is NULL for booking id=% — blocked_dates insert skipped',
          NEW.id;
      END IF;

      IF NEW.return_time IS NOT NULL THEN
        v_end_date := (NEW.return_date::TIMESTAMP + NEW.return_time::INTERVAL + INTERVAL '2 hours')::DATE;
        v_end_time := (NEW.return_date::TIMESTAMP + NEW.return_time::INTERVAL + INTERVAL '2 hours')::TIME;
      ELSE
        v_end_date := NEW.return_date;
        v_end_time := NULL;
      END IF;

      UPDATE blocked_dates
      SET end_date = v_end_date,
          end_time = v_end_time
      WHERE vehicle_id  = NEW.vehicle_id
        AND booking_ref = NEW.booking_ref
        AND reason      = 'booking'
        AND (end_time IS DISTINCT FROM v_end_time OR end_date IS DISTINCT FROM v_end_date);

      IF NOT FOUND THEN
        INSERT INTO blocked_dates (vehicle_id, start_date, end_date, end_time, reason, booking_ref)
        VALUES (NEW.vehicle_id, NEW.pickup_date, v_end_date, v_end_time, 'booking', NEW.booking_ref)
        ON CONFLICT (vehicle_id, start_date, end_date, reason) DO NOTHING;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'on_booking_create: blocked_dates insert failed for booking_ref=% (non-fatal): %',
        NEW.booking_ref, SQLERRM;
    END;
  END IF;

  IF NEW.total_price > 0 AND NEW.status NOT IN ('cancelled') THEN
    INSERT INTO revenue (booking_id, vehicle_id, gross, expenses)
    VALUES (NEW.id, NEW.vehicle_id, NEW.total_price, 0)
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  CASE NEW.status
    WHEN 'approved' THEN UPDATE vehicles SET rental_status = 'reserved' WHERE vehicle_id = NEW.vehicle_id;
    WHEN 'active'   THEN UPDATE vehicles SET rental_status = 'rented'   WHERE vehicle_id = NEW.vehicle_id;
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$$;


-- ===========================================================================
-- 0155_checkout_lifecycle_statuses.sql
-- ===========================================================================
-- Migration 0155: explicit checkout lifecycle statuses
--
-- Goal:
--   Separate incomplete/failed checkout attempts from real unpaid reservations.
--
-- Adds:
--   pending_checkout
--   upload_failed
--   payment_failed
--   abandoned_checkout
--
-- Keeps:
--   reserved as the confirmed unpaid reservation state that still blocks inventory.

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    -- Incomplete checkout lifecycle
    'pending',
    'pending_checkout',
    'upload_failed',
    'payment_failed',
    'abandoned_checkout',
    -- Legacy values
    'approved',
    'active',
    'overdue',
    'completed',
    'cancelled',
    -- Operational reservation / rental values
    'reserved',
    'pending_verification',
    'active_rental',
    'booked_paid',
    'completed_rental',
    'cancelled_rental'
  ));


-- ===========================================================================
-- 0155_ledger_allow_admin_mutations.sql
-- ===========================================================================
-- Migration 0155: Allow admin DELETE and UPDATE on renter_balance_ledger
--
-- The append-only triggers (no_delete, no_update) were added in migration 0148
-- to guard ledger integrity. The admin Balance Ledger page exposes Delete and
-- Edit actions that route through the admin-only renter-balance-ledger API,
-- which already enforces authorization and field-level guards. Keeping the DB
-- triggers makes those UI actions non-functional, so we drop them here.

DROP TRIGGER IF EXISTS trg_renter_balance_ledger_no_delete ON renter_balance_ledger;
DROP TRIGGER IF EXISTS trg_renter_balance_ledger_no_update ON renter_balance_ledger;
DROP FUNCTION IF EXISTS fn_prevent_renter_balance_ledger_mutation();


-- ===========================================================================
-- 0156_backfill_vehicle_category_integrity.sql
-- ===========================================================================
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


-- ===========================================================================
-- 0156_payment_plan_reconciliation.sql
-- ===========================================================================
-- Migration 0156: Payment plan reconciliation and allocation audit trail.
--
-- Adds running amount tracking on installments so partial/multi-installment
-- allocations can be reconciled automatically from renter self-payments.
-- Adds payment_plan_allocations table for explicit audit visibility.

ALTER TABLE payment_plan_installments
  ADD COLUMN IF NOT EXISTS amount_paid numeric(10,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  ADD COLUMN IF NOT EXISTS last_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS last_ledger_transaction_id uuid REFERENCES renter_balance_ledger(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_allocation_at timestamptz;

CREATE TABLE IF NOT EXISTS payment_plan_allocations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id                 uuid NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
  installment_id          uuid REFERENCES payment_plan_installments(id) ON DELETE SET NULL,
  booking_id              text NOT NULL REFERENCES bookings(booking_ref) ON DELETE RESTRICT,
  stripe_payment_intent_id text NOT NULL,
  ledger_transaction_id   uuid REFERENCES renter_balance_ledger(id) ON DELETE SET NULL,
  amount_allocated        numeric(10,2) NOT NULL CHECK (amount_allocated >= 0),
  allocation_order        integer NOT NULL CHECK (allocation_order >= 1),
  allocation_type         text NOT NULL DEFAULT 'installment_paid'
    CHECK (allocation_type IN ('installment_paid', 'installment_partial', 'overpayment_unapplied')),
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_plan_allocations_pi_order_uidx
  ON payment_plan_allocations (stripe_payment_intent_id, allocation_order);

CREATE INDEX IF NOT EXISTS payment_plan_allocations_booking_idx
  ON payment_plan_allocations (booking_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_plan_allocations_plan_idx
  ON payment_plan_allocations (plan_id, installment_id);


-- ===========================================================================
-- 0157_restore_vehicle_vehicles.sql
-- ===========================================================================
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


-- ===========================================================================
-- 0158_bookings_identity_session_id.sql
-- ===========================================================================
-- Migration 0158: ensure bookings.identity_session_id exists
--
-- Required for Stripe Identity-aware booking health checks and booking flows
-- that persist Stripe verification session IDs on the bookings table.

ALTER TABLE bookings
ADD COLUMN IF NOT EXISTS identity_session_id text;


-- ===========================================================================
-- 0159_vehicle_inquiry_lifecycle_statuses.sql
-- ===========================================================================
-- Migration 0159: add vehicle inquiry/agreement/manual-payment lifecycle support

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    'inquiry_received',
    'identity_pending',
    'identity_verified',
    'agreement_pending',
    'agreement_signed',
    'pending_manual_payment',
    'ready_for_pickup',
    'pending',
    'pending_checkout',
    'upload_failed',
    'payment_failed',
    'abandoned_checkout',
    'approved',
    'active',
    'overdue',
    'completed',
    'cancelled',
    'reserved',
    'pending_verification',
    'active_rental',
    'booked_paid',
    'completed_rental',
    'cancelled_rental'
  ));

ALTER TABLE pending_booking_docs
  ADD COLUMN IF NOT EXISTS signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS signature_hash text,
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS identity_session_id text,
  ADD COLUMN IF NOT EXISTS signature_method text DEFAULT 'typed_name',
  ADD COLUMN IF NOT EXISTS user_agent text;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS vehicle_payment_method text,
  ADD COLUMN IF NOT EXISTS vehicle_payment_notes text;


-- ===========================================================================
-- 0160_extension_risk_operational_automation.sql
-- ===========================================================================
-- Migration 0160: Phase 4 operational automation foundation for car-rental
-- extension risk management.
--
-- Adds additive tables for:
--   • current risk profile / review state
--   • append-only risk events
--   • operational alerts
--   • internal notes and tagging
--
-- Scope is intentionally limited to category='car'.

CREATE TABLE IF NOT EXISTS extension_risk_profiles (
  id                       bigserial    PRIMARY KEY,
  booking_ref              text         NOT NULL,
  customer_id              text,
  category                 text         NOT NULL DEFAULT 'car',
  current_state            text         NOT NULL DEFAULT 'clear',
  recommended_state        text         NOT NULL DEFAULT 'clear',
  active_override_state    text,
  extension_override_mode  text,
  restricted_extension     boolean      NOT NULL DEFAULT false,
  manual_review_required   boolean      NOT NULL DEFAULT false,
  full_payment_required    boolean      NOT NULL DEFAULT false,
  review_status            text         NOT NULL DEFAULT 'not_queued',
  review_priority          integer      NOT NULL DEFAULT 0,
  open_alert_count         integer      NOT NULL DEFAULT 0,
  signals                  jsonb        NOT NULL DEFAULT '{}'::jsonb,
  reasons                  jsonb        NOT NULL DEFAULT '[]'::jsonb,
  operational_tags         jsonb        NOT NULL DEFAULT '[]'::jsonb,
  notes_summary            text,
  last_evaluated_at        timestamptz  NOT NULL DEFAULT now(),
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_category_check
      CHECK (category = 'car');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_current_state_check
      CHECK (current_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_recommended_state_check
      CHECK (recommended_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_active_override_state_check
      CHECK (active_override_state IS NULL OR active_override_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_extension_override_mode_check
      CHECK (extension_override_mode IS NULL OR extension_override_mode IN ('allow', 'block'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_profiles
    ADD CONSTRAINT extension_risk_profiles_review_status_check
      CHECK (review_status IN ('not_queued', 'queued', 'in_review', 'resolved'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS extension_risk_profiles_booking_ref_uq
  ON extension_risk_profiles (booking_ref);

CREATE INDEX IF NOT EXISTS extension_risk_profiles_state_idx
  ON extension_risk_profiles (current_state, review_status, review_priority DESC, last_evaluated_at DESC);

CREATE INDEX IF NOT EXISTS extension_risk_profiles_customer_idx
  ON extension_risk_profiles (customer_id, current_state);

CREATE TABLE IF NOT EXISTS extension_risk_events (
  id                bigserial    PRIMARY KEY,
  booking_ref       text         NOT NULL,
  customer_id       text,
  category          text         NOT NULL DEFAULT 'car',
  event_type        text         NOT NULL,
  previous_state    text         NOT NULL DEFAULT 'clear',
  new_state         text         NOT NULL DEFAULT 'clear',
  recommended_state text         NOT NULL DEFAULT 'clear',
  actor_type        text         NOT NULL DEFAULT 'system',
  actor_label       text         NOT NULL DEFAULT 'extension-risk-automation',
  trigger_source    text         NOT NULL DEFAULT 'manual',
  reasons           jsonb        NOT NULL DEFAULT '[]'::jsonb,
  signal_snapshot   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  policy_snapshot   jsonb,
  alerts            jsonb        NOT NULL DEFAULT '[]'::jsonb,
  request_id        text,
  created_at        timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE extension_risk_events
    ADD CONSTRAINT extension_risk_events_category_check
      CHECK (category = 'car');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_events
    ADD CONSTRAINT extension_risk_events_previous_state_check
      CHECK (previous_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_events
    ADD CONSTRAINT extension_risk_events_new_state_check
      CHECK (new_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_events
    ADD CONSTRAINT extension_risk_events_recommended_state_check
      CHECK (recommended_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS extension_risk_events_booking_ref_idx
  ON extension_risk_events (booking_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS extension_risk_events_customer_idx
  ON extension_risk_events (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS extension_risk_events_state_idx
  ON extension_risk_events (new_state, created_at DESC);

CREATE TABLE IF NOT EXISTS extension_risk_alerts (
  id               bigserial    PRIMARY KEY,
  booking_ref      text         NOT NULL,
  customer_id      text,
  category         text         NOT NULL DEFAULT 'car',
  risk_state       text         NOT NULL DEFAULT 'clear',
  alert_type       text         NOT NULL,
  severity         text         NOT NULL DEFAULT 'warning',
  status           text         NOT NULL DEFAULT 'pending',
  dedupe_key       text         NOT NULL,
  channel          text         NOT NULL DEFAULT 'internal',
  payload          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  triggered_at     timestamptz  NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  acknowledged_by  text
);

DO $$
BEGIN
  ALTER TABLE extension_risk_alerts
    ADD CONSTRAINT extension_risk_alerts_category_check
      CHECK (category = 'car');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_alerts
    ADD CONSTRAINT extension_risk_alerts_state_check
      CHECK (risk_state IN ('clear', 'warning', 'restricted_extension', 'manual_review_required', 'full_payment_required'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_alerts
    ADD CONSTRAINT extension_risk_alerts_severity_check
      CHECK (severity IN ('info', 'warning', 'high', 'critical'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_alerts
    ADD CONSTRAINT extension_risk_alerts_status_check
      CHECK (status IN ('pending', 'acknowledged', 'resolved', 'dismissed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS extension_risk_alerts_dedupe_key_uq
  ON extension_risk_alerts (dedupe_key);

CREATE INDEX IF NOT EXISTS extension_risk_alerts_queue_idx
  ON extension_risk_alerts (status, severity, triggered_at DESC);

CREATE INDEX IF NOT EXISTS extension_risk_alerts_booking_ref_idx
  ON extension_risk_alerts (booking_ref, triggered_at DESC);

CREATE TABLE IF NOT EXISTS extension_risk_notes (
  id             bigserial    PRIMARY KEY,
  booking_ref    text         NOT NULL,
  customer_id    text,
  category       text         NOT NULL DEFAULT 'car',
  note           text         NOT NULL,
  tags           jsonb        NOT NULL DEFAULT '[]'::jsonb,
  visibility     text         NOT NULL DEFAULT 'internal',
  created_by     text         NOT NULL DEFAULT 'system',
  created_at     timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE extension_risk_notes
    ADD CONSTRAINT extension_risk_notes_category_check
      CHECK (category = 'car');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE extension_risk_notes
    ADD CONSTRAINT extension_risk_notes_visibility_check
      CHECK (visibility IN ('internal'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS extension_risk_notes_booking_ref_idx
  ON extension_risk_notes (booking_ref, created_at DESC);

CREATE OR REPLACE VIEW extension_risk_review_queue AS
SELECT
  p.booking_ref,
  p.customer_id,
  p.current_state,
  p.recommended_state,
  p.review_status,
  p.review_priority,
  p.open_alert_count,
  p.signals,
  p.reasons,
  p.operational_tags,
  p.notes_summary,
  p.last_evaluated_at
FROM extension_risk_profiles p
WHERE p.current_state <> 'clear'
   OR p.review_status <> 'not_queued'
   OR p.open_alert_count > 0;

ALTER TABLE extension_risk_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_risk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_risk_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_risk_notes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE extension_risk_profiles FROM anon, authenticated;
REVOKE ALL ON TABLE extension_risk_events FROM anon, authenticated;
REVOKE ALL ON TABLE extension_risk_alerts FROM anon, authenticated;
REVOKE ALL ON TABLE extension_risk_notes FROM anon, authenticated;

GRANT ALL ON TABLE extension_risk_profiles TO service_role;
GRANT ALL ON TABLE extension_risk_events TO service_role;
GRANT ALL ON TABLE extension_risk_alerts TO service_role;
GRANT ALL ON TABLE extension_risk_notes TO service_role;

GRANT USAGE, SELECT ON SEQUENCE extension_risk_profiles_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE extension_risk_events_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE extension_risk_alerts_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE extension_risk_notes_id_seq TO service_role;

DO $$
BEGIN
  CREATE POLICY extension_risk_profiles_service_role_all
    ON extension_risk_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY extension_risk_events_service_role_all
    ON extension_risk_events FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY extension_risk_alerts_service_role_all
    ON extension_risk_alerts FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY extension_risk_notes_service_role_all
    ON extension_risk_notes FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ===========================================================================
-- 0161_vehicle_conflict_trigger_draft_exclusion.sql
-- ===========================================================================
-- Migration 0161: Exclude vehicle pre-payment draft statuses from booking
-- conflict detection.
--
-- Problem:
--   The check_booking_conflicts trigger treats ANY non-terminal status as a
--   confirmed booking.  Vehicle bookings pass through several "draft"
--   pre-payment states before becoming confirmed:
--
--     pending_checkout  → agreement_pending → agreement_signed
--                       → pending_manual_payment  ← first CONFIRMED state
--
--   If a customer had a previous failed attempt, the leftover draft row
--   (status = 'pending_checkout') blocks all future booking attempts for
--   that vehicle/date with a P0001 "Booking conflict" error that surfaces
--   to the renter as "Booking could not be saved."
--
-- Fix:
--   Add all pre-payment draft statuses to the skip-list in BOTH:
--     1. The fast-path NEW row guard (so inserting a draft never self-conflicts)
--     2. The conflict query exclusion list (so old drafts don't block new ones)
--
--   Only confirmed statuses should block the calendar:
--     pending_manual_payment, ready_for_pickup, reserved, approved, active,
--     booked_paid, active_rental, overdue
--
-- Safe to re-run: CREATE OR REPLACE is idempotent.

CREATE OR REPLACE FUNCTION check_booking_conflicts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_conflict_id uuid;
  v_blocked_vid text;
  new_start     timestamptz;
  new_end       timestamptz;
BEGIN
  -- Terminal statuses and vehicle pre-payment draft statuses never conflict.
  -- Draft rows are not confirmed reservations and must not block the calendar.
  IF NEW.status IN (
    -- Terminal / free-vehicle states
    'cancelled', 'completed', 'completed_rental', 'cancelled_rental',
    -- Failed / abandoned checkout flows
    'abandoned_checkout', 'upload_failed', 'payment_failed',
    -- Vehicle pre-payment draft states (no confirmed reservation yet)
    'pending_checkout',
    'inquiry_received', 'identity_pending', 'identity_verified',
    'agreement_pending', 'agreement_signed'
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.pickup_date IS NULL THEN RETURN NEW; END IF;

  new_start := booking_datetime(NEW.pickup_date, NEW.pickup_time, false);
  new_end   := booking_datetime(NEW.return_date, NEW.return_time, true);

  -- Check for overlapping CONFIRMED bookings on the same vehicle.
  -- Exclude terminal statuses and all vehicle draft states so that
  -- old abandoned or failed draft rows do not block new reservations.
  SELECT b.id INTO v_conflict_id
  FROM   bookings b
  WHERE  b.vehicle_id = NEW.vehicle_id
    AND  b.status NOT IN (
           'cancelled', 'completed', 'completed_rental', 'cancelled_rental',
           'abandoned_checkout', 'upload_failed', 'payment_failed',
           'pending_checkout',
           'inquiry_received', 'identity_pending', 'identity_verified',
           'agreement_pending', 'agreement_signed'
         )
    AND  b.id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND  booking_datetime(b.pickup_date, b.pickup_time, false) < new_end
    AND  booking_datetime(b.return_date, b.return_time, true)  > new_start
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Booking conflict: vehicle % is already booked overlapping % to % (conflicts with booking %)',
      NEW.vehicle_id,
      new_start AT TIME ZONE 'UTC',
      new_end   AT TIME ZONE 'UTC',
      v_conflict_id;
  END IF;

  -- Check maintenance / manual blocked_dates only (not 'booking' rows —
  -- those are managed by the bookings table itself).
  SELECT bd.vehicle_id INTO v_blocked_vid
  FROM   blocked_dates bd
  WHERE  bd.vehicle_id = NEW.vehicle_id
    AND  bd.reason    != 'booking'
    AND  bd.start_date <= COALESCE(NEW.return_date, NEW.pickup_date)
    AND  bd.end_date   >= NEW.pickup_date
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Date conflict: vehicle % has blocked dates overlapping with % to %',
      NEW.vehicle_id, NEW.pickup_date, COALESCE(NEW.return_date, NEW.pickup_date);
  END IF;

  RETURN NEW;
END;
$$;


-- ===========================================================================
-- 0162_bookings_soft_delete.sql
-- ===========================================================================
-- 0162_bookings_soft_delete.sql
-- Adds reversible soft-delete metadata for bookings so admin deletes are recoverable.

alter table public.bookings
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text,
  add column if not exists deleted_reason text;

create index if not exists idx_bookings_deleted_at
  on public.bookings (deleted_at);

create index if not exists idx_bookings_active_lookup
  on public.bookings (vehicle_id, status, created_at desc)
  where deleted_at is null;


-- ===========================================================================
-- 0163_checkr_screening_phase1.sql
-- ===========================================================================
-- Migration 0163: Checkr screening + adverse action + renter screening fields

ALTER TABLE renter_applications
  ADD COLUMN IF NOT EXISTS agree_background_check boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS driver_license_number  text,
  ADD COLUMN IF NOT EXISTS driver_license_state   text,
  ADD COLUMN IF NOT EXISTS zipcode                text,
  ADD COLUMN IF NOT EXISTS checkr_adjudication    text,
  ADD COLUMN IF NOT EXISTS checkr_completed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS checkr_last_error      text,
  ADD COLUMN IF NOT EXISTS checkr_mvr_violations  jsonb,
  ADD COLUMN IF NOT EXISTS adverse_action_step    text,
  ADD COLUMN IF NOT EXISTS adverse_action_sent_at timestamptz;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_driver_license_state_check
      CHECK (
        driver_license_state IS NULL
        OR driver_license_state ~ '^[A-Z]{2}$'
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_zipcode_check
      CHECK (
        zipcode IS NULL
        OR zipcode ~ '^\d{5}(-\d{4})?$'
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_checkr_report_status_check
      CHECK (
        checkr_report_status IS NULL
        OR checkr_report_status IN ('pending', 'clear', 'consider', 'suspended', 'disputed', 'complete_no_adj', 'error')
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_adverse_action_step_check
      CHECK (
        adverse_action_step IS NULL
        OR adverse_action_step IN ('pre_notice_sent', 'final_notice_sent')
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE application_review_actions
    DROP CONSTRAINT IF EXISTS application_review_actions_action_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE application_review_actions
  ADD CONSTRAINT application_review_actions_action_check
    CHECK (action IN ('approved', 'rejected', 'needs_info', 'pre_adverse'));

CREATE INDEX IF NOT EXISTS renter_applications_checkr_candidate_idx
  ON renter_applications (checkr_candidate_id)
  WHERE checkr_candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS renter_applications_checkr_report_idx
  ON renter_applications (checkr_report_id)
  WHERE checkr_report_id IS NOT NULL;


-- ===========================================================================
-- 0164_veriff_webhook_events.sql
-- ===========================================================================
-- Migration 0164: Veriff webhook idempotency log (Stripe-identity naming deprecation)
--
-- Introduces a Veriff-named webhook event table while preserving the legacy
-- stripe_identity_webhook_events table for backward compatibility.

CREATE TABLE IF NOT EXISTS veriff_webhook_events (
  id                  bigserial   PRIMARY KEY,
  event_id            text        NOT NULL UNIQUE,
  event_type          text        NOT NULL,
  application_id      uuid        REFERENCES public.renter_applications(id) ON DELETE SET NULL,
  identity_session_id text,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS veriff_webhook_events_application_id_idx
  ON veriff_webhook_events (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS veriff_webhook_events_identity_session_id_idx
  ON veriff_webhook_events (identity_session_id)
  WHERE identity_session_id IS NOT NULL;

ALTER TABLE veriff_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE veriff_webhook_events FROM anon;
REVOKE ALL ON TABLE veriff_webhook_events FROM authenticated;
GRANT ALL ON TABLE veriff_webhook_events TO service_role;

DO $$
BEGIN
  CREATE POLICY veriff_webhook_events_service_role_all
    ON veriff_webhook_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ===========================================================================
-- 0166_application_review_actions_admin_ops.sql
-- ===========================================================================
-- Migration 0166: allow admin operational actions in application_review_actions

DO $$
BEGIN
  ALTER TABLE application_review_actions
    DROP CONSTRAINT IF EXISTS application_review_actions_action_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE application_review_actions
  ADD CONSTRAINT application_review_actions_action_check
    CHECK (action IN (
      'approved',
      'rejected',
      'needs_info',
      'pre_adverse',
      'move_to_review',
      'resend_verification',
      'restart_verification',
      'manual_recovery',
      'retry_checkr',
      'archive_test',
      'delete_application'
    ));


-- ===========================================================================
-- 0167_checkr_lifecycle_observability.sql
-- ===========================================================================
-- Migration 0167: Checkr lifecycle observability + durable event log

ALTER TABLE renter_applications
  ADD COLUMN IF NOT EXISTS checkr_last_launch_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkr_launch_attempt_count   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkr_last_launch_error      text,
  ADD COLUMN IF NOT EXISTS checkr_last_webhook_at        timestamptz,
  ADD COLUMN IF NOT EXISTS checkr_phase                  text;

DO $$
BEGIN
  ALTER TABLE renter_applications
    DROP CONSTRAINT IF EXISTS renter_applications_checkr_report_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_checkr_report_status_check
      CHECK (
        checkr_report_status IS NULL
        OR checkr_report_status IN (
          'not_started',
          'launch_queued',
          'candidate_created',
          'invitation_sent',
          'pending',
          'completed',
          'clear',
          'consider',
          'suspended',
          'failed',
          'webhook_missing'
        )
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE renter_applications
    ADD CONSTRAINT renter_applications_checkr_phase_check
      CHECK (
        checkr_phase IS NULL
        OR checkr_phase IN (
          'not_started',
          'launch_queued',
          'candidate_created',
          'invitation_sent',
          'pending',
          'completed',
          'clear',
          'consider',
          'suspended',
          'failed',
          'webhook_missing'
        )
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS renter_applications_checkr_phase_idx
  ON renter_applications (checkr_phase)
  WHERE checkr_phase IS NOT NULL;

CREATE INDEX IF NOT EXISTS renter_applications_checkr_last_webhook_at_idx
  ON renter_applications (checkr_last_webhook_at)
  WHERE checkr_last_webhook_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS checkr_screening_events (
  id                  bigserial   PRIMARY KEY,
  event_id            text        NOT NULL UNIQUE,
  event_type          text        NOT NULL,
  application_id      uuid        REFERENCES public.renter_applications(id) ON DELETE SET NULL,
  checkr_candidate_id text,
  checkr_report_id    text,
  phase               text,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkr_screening_events_application_id_idx
  ON checkr_screening_events (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS checkr_screening_events_candidate_id_idx
  ON checkr_screening_events (checkr_candidate_id)
  WHERE checkr_candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS checkr_screening_events_report_id_idx
  ON checkr_screening_events (checkr_report_id)
  WHERE checkr_report_id IS NOT NULL;

ALTER TABLE checkr_screening_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE checkr_screening_events FROM anon;
REVOKE ALL ON TABLE checkr_screening_events FROM authenticated;
GRANT ALL ON TABLE checkr_screening_events TO service_role;

DO $$
BEGIN
  CREATE POLICY checkr_screening_events_service_role_all
    ON checkr_screening_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ===========================================================================
-- 0168_application_review_actions_clear_declined.sql
-- ===========================================================================
-- Migration 0168: allow clear_declined admin audit action

ALTER TABLE application_review_actions
  DROP CONSTRAINT IF EXISTS application_review_actions_action_check;

ALTER TABLE application_review_actions
  ADD CONSTRAINT application_review_actions_action_check
    CHECK (action IN (
      'approved',
      'rejected',
      'needs_info',
      'pre_adverse',
      'move_to_review',
      'resend_verification',
      'restart_verification',
      'manual_recovery',
      'retry_checkr',
      'archive_test',
      'delete_application',
      'clear_declined'
    ));


-- ===========================================================================
-- 0169_oil_check_miles_interval_setting.sql
-- ===========================================================================
-- =============================================================================
-- Migration 0169: oil_check_miles_interval system setting
-- =============================================================================
--
-- Seeds the admin-configurable threshold (miles since last oil check before an
-- oil-check SMS is dispatched to the active renter).  The default of 500 matches
-- the previous hardcoded constant in api/oil-check-cron.js.
--
-- Safe to re-run: ON CONFLICT DO NOTHING skips the insert when the row exists
-- so a subsequent re-run or a fresh seed does not overwrite admin customisations.
-- =============================================================================

INSERT INTO system_settings (key, value, description, category, updated_at, updated_by)
VALUES (
  'oil_check_miles_interval',
  '500'::jsonb,
  'Miles driven since last oil check before an oil-check SMS is sent to the active renter (default: 500)',
  'maintenance',
  now(),
  'system'
)
ON CONFLICT (key) DO NOTHING;


-- ===========================================================================
-- 0170_ensure_veriff_webhook_events.sql
-- ===========================================================================
-- Migration 0170: Ensure Veriff webhook event log table exists everywhere.
--
-- Some environments may have only the legacy stripe_identity_webhook_events
-- table. This migration guarantees the Veriff-named table exists so webhook
-- dedupe/event logging does not depend on fallback behavior.

CREATE TABLE IF NOT EXISTS veriff_webhook_events (
  id                  bigserial   PRIMARY KEY,
  event_id            text        NOT NULL UNIQUE,
  event_type          text        NOT NULL,
  application_id      uuid        REFERENCES public.renter_applications(id) ON DELETE SET NULL,
  identity_session_id text,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS veriff_webhook_events_application_id_idx
  ON veriff_webhook_events (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS veriff_webhook_events_identity_session_id_idx
  ON veriff_webhook_events (identity_session_id)
  WHERE identity_session_id IS NOT NULL;

ALTER TABLE veriff_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE veriff_webhook_events FROM anon;
REVOKE ALL ON TABLE veriff_webhook_events FROM authenticated;
GRANT ALL ON TABLE veriff_webhook_events TO service_role;

DO $$
BEGIN
  CREATE POLICY veriff_webhook_events_service_role_all
    ON veriff_webhook_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ===========================================================================
-- 0171_bookings_extension_risk_override.sql
-- ===========================================================================
-- Migration 0171: ensure bookings.extension_risk_override exists for v2-bookings
-- full-select paths and extension-risk controls.
--
-- This is additive and safe to run repeatedly.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS extension_risk_override text;

DO $$
BEGIN
  ALTER TABLE public.bookings
    ADD CONSTRAINT bookings_extension_risk_override_check
      CHECK (extension_risk_override IS NULL OR extension_risk_override IN ('allow', 'block'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.bookings.extension_risk_override IS
  'Per-booking admin override for extension risk gate. NULL=default policy, allow=force allow, block=force restricted extension posture.';


-- ===========================================================================
-- 0172_checkr_invitation_sms_tracking.sql
-- ===========================================================================
-- Migration 0172: Checkr invitation URL + SMS tracking fields

ALTER TABLE renter_applications
  ADD COLUMN IF NOT EXISTS checkr_invitation_url text,
  ADD COLUMN IF NOT EXISTS checkr_invitation_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkr_invitation_sms_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkr_invitation_reminder_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS renter_applications_checkr_invitation_pending_idx
  ON renter_applications (checkr_report_status, checkr_invitation_sent_at)
  WHERE checkr_invitation_url IS NOT NULL;


-- ===========================================================================
-- 0173_auth_identity_links.sql
-- ===========================================================================
-- 0173_auth_identity_links.sql
-- Adds identity-link and auth-audit tables used by phased renter/admin auth rollout.

create table if not exists public.booking_identity_links (
  id uuid primary key default gen_random_uuid(),
  booking_ref text not null,
  auth_user_id uuid null,
  email text null,
  phone text null,
  role text not null default 'renter',
  linked_at timestamptz not null default now(),
  last_login_at timestamptz null,
  last_auth_method text null,
  constraint booking_identity_links_role_check check (role in ('renter', 'admin', 'support'))
);

create index if not exists booking_identity_links_booking_ref_idx
  on public.booking_identity_links (booking_ref);

create index if not exists booking_identity_links_auth_user_idx
  on public.booking_identity_links (auth_user_id);

create unique index if not exists booking_identity_links_booking_role_unique
  on public.booking_identity_links (booking_ref, role);

create table if not exists public.auth_login_audit (
  id uuid primary key default gen_random_uuid(),
  actor_role text not null,
  actor_id text null,
  booking_ref text null,
  auth_method text not null,
  auth_status text not null,
  ip_address text null,
  user_agent text null,
  created_at timestamptz not null default now(),
  constraint auth_login_audit_role_check check (actor_role in ('admin', 'renter', 'support', 'system')),
  constraint auth_login_audit_status_check check (auth_status in ('success', 'failed', 'locked', 'expired'))
);

create index if not exists auth_login_audit_created_at_idx
  on public.auth_login_audit (created_at desc);

create index if not exists auth_login_audit_booking_ref_idx
  on public.auth_login_audit (booking_ref);



-- ===========================================================================
-- 0174_blocked_dates_created_at.sql
-- ===========================================================================
-- Migration: add created_at to blocked_dates
-- The blocked_dates table was originally created without a created_at column.
-- The admin UI and API now display/query this field, so we add it here with
-- a default of now() and backfill existing rows to the current timestamp.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blocked_dates' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE blocked_dates
      ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  END IF;
END $$;


-- ===========================================================================
-- 0175_organizations_foundation.sql
-- ===========================================================================
-- supabase/migrations/0175_organizations_foundation.sql
-- Phase 0 — Multi-tenant SaaS Foundation
--
-- Creates the core organizational schema for Fleet Control's transition to a
-- multi-tenant SaaS platform. All tables are additive — no existing tables are
-- modified. Existing single-tenant data continues to function without changes.
--
-- Tables created:
--   organizations          — tenant/operator accounts
--   organization_users     — user membership + RBAC roles within an org
--   organization_settings  — per-org configuration overrides
--   operator_leads         — onboarding pipeline for prospective operators
--
-- Design principles:
--   • All tenant tables include organization_id for future cross-table joins
--   • status columns use CHECK constraints to enforce valid state machines
--   • All tables include created_at / updated_at for audit trails
--   • Indexes cover the most common query patterns (membership lookups, lead funnel)
--   • No RLS policies yet — Phase 1 will add RLS once Supabase Auth is integrated
--   • No organization_id columns on existing tables yet — Phase 1 migration handles backfill
--
-- Migration strategy:
--   This migration is safe to run against production at any time.
--   IF NOT EXISTS guards make it fully idempotent.
--   Rolling back is safe — dropping these tables does not affect existing data.

-- ─── organizations ────────────────────────────────────────────────────────────
-- Each row represents a fleet operator tenant.
-- status drives access control: only 'active' orgs can log in.

CREATE TABLE IF NOT EXISTS public.organizations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT        NOT NULL UNIQUE,           -- URL-safe identifier, e.g. "sly-rides"
  name          TEXT        NOT NULL,                  -- display name, e.g. "SLY Rides LLC"
  status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'active', 'suspended', 'cancelled')),
  plan          TEXT        NOT NULL DEFAULT 'starter'
                  CHECK (plan IN ('starter', 'growth', 'pro', 'enterprise')),
  owner_email   TEXT,                                  -- primary contact email
  phone         TEXT,                                  -- primary contact phone
  city          TEXT,
  state         TEXT,
  timezone      TEXT        NOT NULL DEFAULT 'America/Los_Angeles',
  metadata      JSONB       NOT NULL DEFAULT '{}',     -- extensible org-level config
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug   ON public.organizations (slug);
CREATE INDEX IF NOT EXISTS idx_organizations_status ON public.organizations (status);

-- ─── organization_users ───────────────────────────────────────────────────────
-- Maps Supabase Auth users to organizations with RBAC roles.
-- A user may belong to multiple organizations (e.g. a consultant managing two fleets).
-- Phase 0: user_id is nullable (pre-Supabase Auth). Phase 1 will make it NOT NULL.

CREATE TABLE IF NOT EXISTS public.organization_users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID,                                -- Supabase Auth user UUID (nullable in Phase 0)
  email           TEXT        NOT NULL,               -- used before Supabase Auth user is created
  role            TEXT        NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member', 'staff')),
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'invited')),
  invited_at      TIMESTAMPTZ,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, email)                     -- one membership record per email per org
);

CREATE INDEX IF NOT EXISTS idx_org_users_org_id  ON public.organization_users (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_users_user_id ON public.organization_users (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_org_users_email   ON public.organization_users (email);

-- ─── organization_settings ────────────────────────────────────────────────────
-- Per-org configuration that overrides platform defaults.
-- Follows the same JSONB-based extensible pattern as the existing system_settings table.
-- Key categories:
--   notifications — SMS/email preferences
--   integrations  — GPS, Stripe Connect account IDs (Phase 4)
--   branding      — logo, colors (Phase 11)
--   operational   — timezone overrides, late-fee schedules

CREATE TABLE IF NOT EXISTS public.organization_settings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  settings        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_settings_org_id ON public.organization_settings (organization_id);

-- ─── operator_leads ──────────────────────────────────────────────────────────
-- Onboarding pipeline for prospective fleet operators.
-- Captures interest from landing page CTAs:
--   "Request Access", "Book Demo", "Start Your System", "Early Access"
--
-- Status machine:
--   new_lead → contacted → demo_scheduled → onboarding → active_operator
--                       ↘ rejected (from any state)
--
-- When status transitions to 'active_operator', a corresponding organizations
-- row should be created and linked via organization_id.

CREATE TABLE IF NOT EXISTS public.operator_leads (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT        NOT NULL,
  business_name         TEXT,
  email                 TEXT        NOT NULL,
  phone                 TEXT,
  fleet_size            INTEGER,                        -- self-reported number of vehicles
  location              TEXT,                           -- city / region
  source                TEXT,                           -- CTA that triggered submission, e.g. "request_access"
  status                TEXT        NOT NULL DEFAULT 'new_lead'
                          CHECK (status IN (
                            'new_lead',
                            'contacted',
                            'demo_scheduled',
                            'onboarding',
                            'active_operator',
                            'rejected'
                          )),
  onboarding_notes      TEXT,                           -- internal admin notes
  onboarding_progress   JSONB       NOT NULL DEFAULT '{}',  -- checklist state
  stripe_status         TEXT,                           -- e.g. 'not_started', 'in_progress', 'complete'
  organization_id       UUID        REFERENCES public.organizations(id), -- set when activated
  demo_scheduled_at     TIMESTAMPTZ,
  contacted_at          TIMESTAMPTZ,
  activated_at          TIMESTAMPTZ,
  rejected_at           TIMESTAMPTZ,
  rejection_reason      TEXT,
  metadata              JSONB       NOT NULL DEFAULT '{}',  -- extensible fields
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_leads_status  ON public.operator_leads (status);
CREATE INDEX IF NOT EXISTS idx_operator_leads_email   ON public.operator_leads (email);
CREATE INDEX IF NOT EXISTS idx_operator_leads_created ON public.operator_leads (created_at DESC);

-- ─── updated_at triggers ─────────────────────────────────────────────────────
-- Automatically maintain updated_at on all new tables.
-- Uses the moddatetime extension pattern common in this project.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_organizations_updated_at'
  ) THEN
    CREATE TRIGGER set_organizations_updated_at
      BEFORE UPDATE ON public.organizations
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_organization_users_updated_at'
  ) THEN
    CREATE TRIGGER set_organization_users_updated_at
      BEFORE UPDATE ON public.organization_users
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_organization_settings_updated_at'
  ) THEN
    CREATE TRIGGER set_organization_settings_updated_at
      BEFORE UPDATE ON public.organization_settings
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_operator_leads_updated_at'
  ) THEN
    CREATE TRIGGER set_operator_leads_updated_at
      BEFORE UPDATE ON public.operator_leads
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END;
$$;

-- ─── Comments ─────────────────────────────────────────────────────────────────

COMMENT ON TABLE public.organizations       IS 'Fleet operator tenant accounts. Each row = one SaaS customer.';
COMMENT ON TABLE public.organization_users  IS 'User membership and RBAC roles within an organization.';
COMMENT ON TABLE public.organization_settings IS 'Per-org configuration overrides for platform defaults.';
COMMENT ON TABLE public.operator_leads      IS 'Onboarding pipeline for prospective fleet operators.';

COMMENT ON COLUMN public.organizations.slug   IS 'URL-safe identifier for the org, used in future operator subdomains.';
COMMENT ON COLUMN public.organizations.status IS 'Access gate: only active orgs can authenticate.';
COMMENT ON COLUMN public.organizations.metadata IS 'Extensible JSONB for future org-level flags without schema changes.';

COMMENT ON COLUMN public.organization_users.user_id     IS 'Supabase Auth UUID. Nullable in Phase 0; NOT NULL constraint added in Phase 1.';
COMMENT ON COLUMN public.organization_users.role        IS 'RBAC role: owner > admin > member > staff.';

COMMENT ON COLUMN public.operator_leads.source          IS 'CTA button / page that triggered the lead, e.g. request_access, book_demo.';
COMMENT ON COLUMN public.operator_leads.organization_id IS 'Set when lead is activated and an organizations row is provisioned.';
COMMENT ON COLUMN public.operator_leads.onboarding_progress IS 'JSON checklist of completed onboarding steps.';


-- ===========================================================================
-- 0176_bookings_customers_tenant_foundation.sql
-- ===========================================================================
-- 0176_bookings_customers_tenant_foundation.sql
-- Adds compatibility-safe organization_id scaffolding to the highest-risk tables.
-- This migration is additive, idempotent, and keeps single-tenant behavior working
-- by creating/backfilling a default organization until operator auth and full RLS
-- enforcement are ready.

create or replace function public.ensure_default_organization()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  default_org_id uuid;
begin
  insert into public.organizations (slug, name, status, metadata)
  values (
    'sly-rides-default',
    'SLY Rides Default Organization',
    'active',
    jsonb_build_object(
      'is_default', true,
      'seeded_by_migration', '0176_bookings_customers_tenant_foundation'
    )
  )
  on conflict (slug) do update
    set status = 'active',
        metadata = coalesce(public.organizations.metadata, '{}'::jsonb) || excluded.metadata
  returning id into default_org_id;

  if default_org_id is not null then
    return default_org_id;
  end if;

  select id
    into default_org_id
    from public.organizations
   where slug = 'sly-rides-default'
   limit 1;

  return default_org_id;
end;
$$;

create or replace function public.assign_default_organization_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.organization_id is null then
    new.organization_id := public.ensure_default_organization();
  end if;

  return new;
end;
$$;

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'bookings'
  ) then
    alter table public.bookings
      add column if not exists organization_id uuid;

    alter table public.bookings
      alter column organization_id set default public.ensure_default_organization();

    update public.bookings
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'bookings_organization_id_fkey'
    ) then
      alter table public.bookings
        add constraint bookings_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists bookings_organization_id_idx
      on public.bookings (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_bookings_assign_default_organization_id'
    ) then
      create trigger trg_bookings_assign_default_organization_id
        before insert or update of organization_id on public.bookings
        for each row
        execute function public.assign_default_organization_id();
    end if;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'customers'
  ) then
    alter table public.customers
      add column if not exists organization_id uuid;

    alter table public.customers
      alter column organization_id set default public.ensure_default_organization();

    update public.customers
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'customers_organization_id_fkey'
    ) then
      alter table public.customers
        add constraint customers_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists customers_organization_id_idx
      on public.customers (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_customers_assign_default_organization_id'
    ) then
      create trigger trg_customers_assign_default_organization_id
        before insert or update of organization_id on public.customers
        for each row
        execute function public.assign_default_organization_id();
    end if;
  end if;
end $$;


-- ===========================================================================
-- 0177_financial_tenant_foundation.sql
-- ===========================================================================
-- 0177_financial_tenant_foundation.sql
-- Adds additive organization_id scaffolding to the first financial truth tables.
-- This keeps legacy callers working by backfilling from booking/customer links and
-- using the default organization only when no stronger relationship can be found.

create or replace function public.ensure_default_organization()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  default_org_id uuid;
begin
  insert into public.organizations (slug, name, status, metadata)
  values (
    'sly-rides-default',
    'SLY Rides Default Organization',
    'active',
    jsonb_build_object(
      'is_default', true,
      'seeded_by_migration', '0177_financial_tenant_foundation'
    )
  )
  on conflict (slug) do update
    set status = 'active',
        metadata = coalesce(public.organizations.metadata, '{}'::jsonb) || excluded.metadata
  returning id into default_org_id;

  if default_org_id is not null then
    return default_org_id;
  end if;

  select id
    into default_org_id
    from public.organizations
   where slug = 'sly-rides-default'
   limit 1;

  return default_org_id;
end;
$$;

create or replace function public.assign_default_organization_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.organization_id is null then
    new.organization_id := public.ensure_default_organization();
  end if;

  return new;
end;
$$;

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'revenue_records'
  ) then
    alter table public.revenue_records
      add column if not exists organization_id uuid;

    alter table public.revenue_records
      alter column organization_id set default public.ensure_default_organization();

    update public.revenue_records rr
       set organization_id = b.organization_id
      from public.bookings b
     where rr.organization_id is null
       and b.organization_id is not null
       and (
         (rr.booking_ref is not null and b.booking_ref = rr.booking_ref)
         or (rr.original_booking_id is not null and b.booking_ref = rr.original_booking_id)
         or (rr.booking_id is not null and b.booking_ref = rr.booking_id)
       );

    update public.revenue_records rr
       set organization_id = c.organization_id
      from public.customers c
     where rr.organization_id is null
       and rr.customer_email is not null
       and c.organization_id is not null
       and lower(btrim(c.email)) = lower(btrim(rr.customer_email));

    update public.revenue_records
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'revenue_records_organization_id_fkey'
    ) then
      alter table public.revenue_records
        add constraint revenue_records_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists revenue_records_organization_id_idx
      on public.revenue_records (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_revenue_records_assign_default_organization_id'
    ) then
      create trigger trg_revenue_records_assign_default_organization_id
        before insert or update of organization_id on public.revenue_records
        for each row
        execute function public.assign_default_organization_id();
    end if;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'renter_balance_ledger'
  ) then
    alter table public.renter_balance_ledger
      add column if not exists organization_id uuid;

    alter table public.renter_balance_ledger
      alter column organization_id set default public.ensure_default_organization();

    update public.renter_balance_ledger rbl
       set organization_id = b.organization_id
      from public.bookings b
     where rbl.organization_id is null
       and b.organization_id is not null
       and b.booking_ref = rbl.booking_id;

    update public.renter_balance_ledger rbl
       set organization_id = c.organization_id
      from public.customers c
     where rbl.organization_id is null
       and rbl.customer_id is not null
       and c.organization_id is not null
       and c.id = rbl.customer_id;

    update public.renter_balance_ledger
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'renter_balance_ledger_organization_id_fkey'
    ) then
      alter table public.renter_balance_ledger
        add constraint renter_balance_ledger_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists renter_balance_ledger_organization_id_idx
      on public.renter_balance_ledger (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_renter_balance_ledger_assign_default_organization_id'
    ) then
      create trigger trg_renter_balance_ledger_assign_default_organization_id
        before insert or update of organization_id on public.renter_balance_ledger
        for each row
        execute function public.assign_default_organization_id();
    end if;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'payment_plans'
  ) then
    alter table public.payment_plans
      add column if not exists organization_id uuid;

    alter table public.payment_plans
      alter column organization_id set default public.ensure_default_organization();

    update public.payment_plans pp
       set organization_id = b.organization_id
      from public.bookings b
     where pp.organization_id is null
       and b.organization_id is not null
       and b.booking_ref = pp.booking_id;

    update public.payment_plans pp
       set organization_id = c.organization_id
      from public.customers c
     where pp.organization_id is null
       and pp.customer_email is not null
       and c.organization_id is not null
       and lower(btrim(c.email)) = lower(btrim(pp.customer_email));

    update public.payment_plans
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'payment_plans_organization_id_fkey'
    ) then
      alter table public.payment_plans
        add constraint payment_plans_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists payment_plans_organization_id_idx
      on public.payment_plans (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_payment_plans_assign_default_organization_id'
    ) then
      create trigger trg_payment_plans_assign_default_organization_id
        before insert or update of organization_id on public.payment_plans
        for each row
        execute function public.assign_default_organization_id();
    end if;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'payment_plan_installments'
  ) then
    alter table public.payment_plan_installments
      add column if not exists organization_id uuid;

    alter table public.payment_plan_installments
      alter column organization_id set default public.ensure_default_organization();

    update public.payment_plan_installments ppi
       set organization_id = pp.organization_id
      from public.payment_plans pp
     where ppi.organization_id is null
       and pp.organization_id is not null
       and pp.id = ppi.plan_id;

    update public.payment_plan_installments
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'payment_plan_installments_organization_id_fkey'
    ) then
      alter table public.payment_plan_installments
        add constraint payment_plan_installments_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists payment_plan_installments_organization_id_idx
      on public.payment_plan_installments (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_payment_plan_installments_assign_default_organization_id'
    ) then
      create trigger trg_payment_plan_installments_assign_default_organization_id
        before insert or update of organization_id on public.payment_plan_installments
        for each row
        execute function public.assign_default_organization_id();
    end if;
  end if;
end $$;


-- ===========================================================================
-- 0178_staging_validation.sql
-- ===========================================================================
-- supabase/migrations/0178_staging_validation.sql
-- Staging validation for migrations 0175, 0176, and 0177.
--
-- PURPOSE:
--   Confirms that each Wave A migration left the expected schema objects on the
--   target database.  Run this after applying 0175 → 0176 → 0177 (in that order)
--   to verify the full sequence completed without silent failures.
--
-- HOW TO USE:
--   psql <connection> -f 0178_staging_validation.sql
--
--   A successful run prints one NOTICE per validation point, ending with:
--     "VALIDATION COMPLETE: Wave A staging checks passed."
--   Any missing object raises a RAISE EXCEPTION that aborts the script with a
--   clear error message identifying which migration step is incomplete.
--
-- SAFETY:
--   Read-only — no DDL or DML.  Safe to re-run at any time.
--   All checks are wrapped in a single DO block; the exception rolls back the
--   implicit savepoint so the rest of the connection session is unaffected.

DO $$
DECLARE
  -- ── 0175 expected objects ──────────────────────────────────────────────────
  v_table_organizations         boolean;
  v_table_organization_users    boolean;
  v_table_organization_settings boolean;
  v_table_operator_leads        boolean;
  v_idx_org_slug                boolean;
  v_idx_org_status              boolean;
  v_idx_ou_user_id              boolean;
  v_trigger_org_updated_at      boolean;
  v_trigger_ou_updated_at       boolean;

  -- ── 0176 expected objects ──────────────────────────────────────────────────
  v_col_bookings_org_id         boolean;
  v_col_customers_org_id        boolean;
  v_fk_bookings_org             boolean;
  v_fk_customers_org            boolean;
  v_idx_bookings_org            boolean;
  v_idx_customers_org           boolean;
  v_trigger_bookings_default    boolean;
  v_trigger_customers_default   boolean;
  v_fn_ensure_default_org       boolean;
  v_fn_assign_default_org       boolean;
  v_default_org_row             boolean;

  -- ── 0177 expected objects ──────────────────────────────────────────────────
  v_col_revenue_org_id          boolean;
  v_col_ledger_org_id           boolean;
  v_col_payment_plans_org_id    boolean;
  v_col_installments_org_id     boolean;
  v_fk_revenue_org              boolean;
  v_fk_ledger_org               boolean;
  v_fk_payment_plans_org        boolean;
  v_fk_installments_org         boolean;
  v_idx_revenue_org             boolean;
  v_idx_ledger_org              boolean;
  v_idx_payment_plans_org       boolean;
  v_idx_installments_org        boolean;
  v_trigger_revenue_default     boolean;
  v_trigger_ledger_default      boolean;
  v_trigger_payment_plans_default    boolean;
  v_trigger_installments_default boolean;
BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0175: organizations_foundation
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organizations'
  ) INTO v_table_organizations;
  IF NOT v_table_organizations THEN
    RAISE EXCEPTION '[0175 FAIL] Table public.organizations does not exist. Migration 0175 has not been applied.';
  END IF;
  RAISE NOTICE '[0175 OK] Table public.organizations exists.';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organization_users'
  ) INTO v_table_organization_users;
  IF NOT v_table_organization_users THEN
    RAISE EXCEPTION '[0175 FAIL] Table public.organization_users does not exist.';
  END IF;
  RAISE NOTICE '[0175 OK] Table public.organization_users exists.';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organization_settings'
  ) INTO v_table_organization_settings;
  IF NOT v_table_organization_settings THEN
    RAISE EXCEPTION '[0175 FAIL] Table public.organization_settings does not exist.';
  END IF;
  RAISE NOTICE '[0175 OK] Table public.organization_settings exists.';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'operator_leads'
  ) INTO v_table_operator_leads;
  IF NOT v_table_operator_leads THEN
    RAISE EXCEPTION '[0175 FAIL] Table public.operator_leads does not exist.';
  END IF;
  RAISE NOTICE '[0175 OK] Table public.operator_leads exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_organizations_slug'
  ) INTO v_idx_org_slug;
  IF NOT v_idx_org_slug THEN
    RAISE EXCEPTION '[0175 FAIL] Index idx_organizations_slug is missing.';
  END IF;
  RAISE NOTICE '[0175 OK] Index idx_organizations_slug exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_organizations_status'
  ) INTO v_idx_org_status;
  IF NOT v_idx_org_status THEN
    RAISE EXCEPTION '[0175 FAIL] Index idx_organizations_status is missing.';
  END IF;
  RAISE NOTICE '[0175 OK] Index idx_organizations_status exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_org_users_user_id'
  ) INTO v_idx_ou_user_id;
  IF NOT v_idx_ou_user_id THEN
    RAISE EXCEPTION '[0175 FAIL] Index idx_org_users_user_id is missing.';
  END IF;
  RAISE NOTICE '[0175 OK] Index idx_org_users_user_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_organizations_updated_at'
  ) INTO v_trigger_org_updated_at;
  IF NOT v_trigger_org_updated_at THEN
    RAISE EXCEPTION '[0175 FAIL] Trigger set_organizations_updated_at is missing.';
  END IF;
  RAISE NOTICE '[0175 OK] Trigger set_organizations_updated_at exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_organization_users_updated_at'
  ) INTO v_trigger_ou_updated_at;
  IF NOT v_trigger_ou_updated_at THEN
    RAISE EXCEPTION '[0175 FAIL] Trigger set_organization_users_updated_at is missing.';
  END IF;
  RAISE NOTICE '[0175 OK] Trigger set_organization_users_updated_at exists.';

  RAISE NOTICE '[0175 PASS] Migration 0175 (organizations_foundation) validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0176: bookings_customers_tenant_foundation
  -- ══════════════════════════════════════════════════════════════════════════

  -- Verify ensure_default_organization() function exists
  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_proc.proname = 'ensure_default_organization'
  ) INTO v_fn_ensure_default_org;
  IF NOT v_fn_ensure_default_org THEN
    RAISE EXCEPTION '[0176 FAIL] Function public.ensure_default_organization() is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Function public.ensure_default_organization() exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_proc.proname = 'assign_default_organization_id'
  ) INTO v_fn_assign_default_org;
  IF NOT v_fn_assign_default_org THEN
    RAISE EXCEPTION '[0176 FAIL] Function public.assign_default_organization_id() is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Function public.assign_default_organization_id() exists.';

  -- Verify default org row was seeded
  SELECT EXISTS (
    SELECT 1 FROM public.organizations WHERE slug = 'sly-rides-default' AND status = 'active'
  ) INTO v_default_org_row;
  IF NOT v_default_org_row THEN
    RAISE EXCEPTION '[0176 FAIL] Default organization row (slug=sly-rides-default, status=active) is missing. Backfill did not run.';
  END IF;
  RAISE NOTICE '[0176 OK] Default organization row (slug=sly-rides-default) exists and is active.';

  -- bookings.organization_id column
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'organization_id'
  ) INTO v_col_bookings_org_id;
  IF NOT v_col_bookings_org_id THEN
    RAISE EXCEPTION '[0176 FAIL] Column bookings.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0176 OK] Column bookings.organization_id exists.';

  -- customers.organization_id column
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'organization_id'
  ) INTO v_col_customers_org_id;
  IF NOT v_col_customers_org_id THEN
    RAISE EXCEPTION '[0176 FAIL] Column customers.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0176 OK] Column customers.organization_id exists.';

  -- bookings FK
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bookings_organization_id_fkey'
  ) INTO v_fk_bookings_org;
  IF NOT v_fk_bookings_org THEN
    RAISE EXCEPTION '[0176 FAIL] FK constraint bookings_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] FK constraint bookings_organization_id_fkey exists.';

  -- customers FK
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_organization_id_fkey'
  ) INTO v_fk_customers_org;
  IF NOT v_fk_customers_org THEN
    RAISE EXCEPTION '[0176 FAIL] FK constraint customers_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] FK constraint customers_organization_id_fkey exists.';

  -- bookings index
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'bookings_organization_id_idx'
  ) INTO v_idx_bookings_org;
  IF NOT v_idx_bookings_org THEN
    RAISE EXCEPTION '[0176 FAIL] Index bookings_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Index bookings_organization_id_idx exists.';

  -- customers index
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'customers_organization_id_idx'
  ) INTO v_idx_customers_org;
  IF NOT v_idx_customers_org THEN
    RAISE EXCEPTION '[0176 FAIL] Index customers_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Index customers_organization_id_idx exists.';

  -- bookings trigger
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_bookings_assign_default_organization_id'
  ) INTO v_trigger_bookings_default;
  IF NOT v_trigger_bookings_default THEN
    RAISE EXCEPTION '[0176 FAIL] Trigger trg_bookings_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Trigger trg_bookings_assign_default_organization_id exists.';

  -- customers trigger
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_customers_assign_default_organization_id'
  ) INTO v_trigger_customers_default;
  IF NOT v_trigger_customers_default THEN
    RAISE EXCEPTION '[0176 FAIL] Trigger trg_customers_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0176 OK] Trigger trg_customers_assign_default_organization_id exists.';

  RAISE NOTICE '[0176 PASS] Migration 0176 (bookings_customers_tenant_foundation) validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0177: financial_tenant_foundation
  -- ══════════════════════════════════════════════════════════════════════════

  -- revenue_records
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'revenue_records' AND column_name = 'organization_id'
  ) INTO v_col_revenue_org_id;
  IF NOT v_col_revenue_org_id THEN
    RAISE EXCEPTION '[0177 FAIL] Column revenue_records.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0177 OK] Column revenue_records.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'revenue_records_organization_id_fkey'
  ) INTO v_fk_revenue_org;
  IF NOT v_fk_revenue_org THEN
    RAISE EXCEPTION '[0177 FAIL] FK constraint revenue_records_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] FK constraint revenue_records_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'revenue_records_organization_id_idx'
  ) INTO v_idx_revenue_org;
  IF NOT v_idx_revenue_org THEN
    RAISE EXCEPTION '[0177 FAIL] Index revenue_records_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Index revenue_records_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_revenue_records_assign_default_organization_id'
  ) INTO v_trigger_revenue_default;
  IF NOT v_trigger_revenue_default THEN
    RAISE EXCEPTION '[0177 FAIL] Trigger trg_revenue_records_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Trigger trg_revenue_records_assign_default_organization_id exists.';

  -- renter_balance_ledger
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'renter_balance_ledger' AND column_name = 'organization_id'
  ) INTO v_col_ledger_org_id;
  IF NOT v_col_ledger_org_id THEN
    RAISE EXCEPTION '[0177 FAIL] Column renter_balance_ledger.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0177 OK] Column renter_balance_ledger.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'renter_balance_ledger_organization_id_fkey'
  ) INTO v_fk_ledger_org;
  IF NOT v_fk_ledger_org THEN
    RAISE EXCEPTION '[0177 FAIL] FK constraint renter_balance_ledger_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] FK constraint renter_balance_ledger_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'renter_balance_ledger_organization_id_idx'
  ) INTO v_idx_ledger_org;
  IF NOT v_idx_ledger_org THEN
    RAISE EXCEPTION '[0177 FAIL] Index renter_balance_ledger_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Index renter_balance_ledger_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_renter_balance_ledger_assign_default_organization_id'
  ) INTO v_trigger_ledger_default;
  IF NOT v_trigger_ledger_default THEN
    RAISE EXCEPTION '[0177 FAIL] Trigger trg_renter_balance_ledger_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Trigger trg_renter_balance_ledger_assign_default_organization_id exists.';

  -- payment_plans
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_plans' AND column_name = 'organization_id'
  ) INTO v_col_payment_plans_org_id;
  IF NOT v_col_payment_plans_org_id THEN
    RAISE EXCEPTION '[0177 FAIL] Column payment_plans.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0177 OK] Column payment_plans.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_plans_organization_id_fkey'
  ) INTO v_fk_payment_plans_org;
  IF NOT v_fk_payment_plans_org THEN
    RAISE EXCEPTION '[0177 FAIL] FK constraint payment_plans_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] FK constraint payment_plans_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'payment_plans_organization_id_idx'
  ) INTO v_idx_payment_plans_org;
  IF NOT v_idx_payment_plans_org THEN
    RAISE EXCEPTION '[0177 FAIL] Index payment_plans_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Index payment_plans_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_payment_plans_assign_default_organization_id'
  ) INTO v_trigger_payment_plans_default;
  IF NOT v_trigger_payment_plans_default THEN
    RAISE EXCEPTION '[0177 FAIL] Trigger trg_payment_plans_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Trigger trg_payment_plans_assign_default_organization_id exists.';

  -- payment_plan_installments
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_plan_installments' AND column_name = 'organization_id'
  ) INTO v_col_installments_org_id;
  IF NOT v_col_installments_org_id THEN
    RAISE EXCEPTION '[0177 FAIL] Column payment_plan_installments.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0177 OK] Column payment_plan_installments.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_plan_installments_organization_id_fkey'
  ) INTO v_fk_installments_org;
  IF NOT v_fk_installments_org THEN
    RAISE EXCEPTION '[0177 FAIL] FK constraint payment_plan_installments_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] FK constraint payment_plan_installments_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'payment_plan_installments_organization_id_idx'
  ) INTO v_idx_installments_org;
  IF NOT v_idx_installments_org THEN
    RAISE EXCEPTION '[0177 FAIL] Index payment_plan_installments_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Index payment_plan_installments_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_payment_plan_installments_assign_default_organization_id'
  ) INTO v_trigger_installments_default;
  IF NOT v_trigger_installments_default THEN
    RAISE EXCEPTION '[0177 FAIL] Trigger trg_payment_plan_installments_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0177 OK] Trigger trg_payment_plan_installments_assign_default_organization_id exists.';

  RAISE NOTICE '[0177 PASS] Migration 0177 (financial_tenant_foundation) validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- ALL CHECKS PASSED
  -- ══════════════════════════════════════════════════════════════════════════
  RAISE NOTICE 'VALIDATION COMPLETE: Wave A staging checks passed. Safe to proceed to backfill audit.';

END $$;


-- ===========================================================================
-- 0179_backfill_audit.sql
-- ===========================================================================
-- supabase/migrations/0179_backfill_audit.sql
-- Post-backfill default-org usage audit for Wave A migrations.
--
-- PURPOSE:
--   Quantifies how many rows across all six backfilled tables resolved to the
--   default organization (slug = 'sly-rides-default') versus resolving through
--   an explicit booking/customer relationship.
--
--   A high default-org rate indicates that the backfill join paths in 0177
--   failed to match records, and those records must be investigated before
--   RLS or hard org enforcement begins.
--
-- HOW TO USE:
--   psql <connection> -f 0179_backfill_audit.sql
--
--   Outputs one summary row per table plus cross-table parity checks.
--
-- INTERPRETATION:
--   default_org_count / total_count = fallback rate.
--   A rate above ~5% on revenue_records, charges, or tickets warrants manual
--   investigation before enforcement proceeds.
--
-- SAFETY:
--   Read-only — no DDL or DML.  Safe to re-run at any time.
--   Returns empty results gracefully when tables do not yet exist.

DO $$
BEGIN
  RAISE NOTICE 'Starting Wave A post-backfill default-org usage audit...';
END $$;

-- ─── 1. Default organization UUID ────────────────────────────────────────────
-- Capture once so joins below are efficient.

WITH default_org AS (
  SELECT id AS default_org_id
  FROM public.organizations
  WHERE slug = 'sly-rides-default'
  LIMIT 1
),

-- ─── 2. Per-table fallback counts ─────────────────────────────────────────────

bookings_audit AS (
  SELECT
    'bookings'            AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE b.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE b.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT b.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.bookings b
  CROSS JOIN default_org d
),

customers_audit AS (
  SELECT
    'customers'           AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE c.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE c.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT c.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.customers c
  CROSS JOIN default_org d
),

revenue_records_audit AS (
  SELECT
    'revenue_records'     AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE rr.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE rr.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT rr.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.revenue_records rr
  CROSS JOIN default_org d
),

renter_balance_ledger_audit AS (
  SELECT
    'renter_balance_ledger' AS table_name,
    COUNT(*)                AS total_rows,
    COUNT(*) FILTER (WHERE rbl.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE rbl.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT rbl.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.renter_balance_ledger rbl
  CROSS JOIN default_org d
),

payment_plans_audit AS (
  SELECT
    'payment_plans'       AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE pp.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE pp.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT pp.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.payment_plans pp
  CROSS JOIN default_org d
),

payment_plan_installments_audit AS (
  SELECT
    'payment_plan_installments' AS table_name,
    COUNT(*)                    AS total_rows,
    COUNT(*) FILTER (WHERE ppi.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE ppi.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT ppi.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.payment_plan_installments ppi
  CROSS JOIN default_org d
),

-- ─── 3. Union all tables ───────────────────────────────────────────────────────

all_tables AS (
  SELECT * FROM bookings_audit
  UNION ALL SELECT * FROM customers_audit
  UNION ALL SELECT * FROM revenue_records_audit
  UNION ALL SELECT * FROM renter_balance_ledger_audit
  UNION ALL SELECT * FROM payment_plans_audit
  UNION ALL SELECT * FROM payment_plan_installments_audit
)

-- ─── 4. Final summary with fallback rate ──────────────────────────────────────

SELECT
  table_name,
  total_rows,
  default_org_count,
  null_org_count,
  total_rows - default_org_count - null_org_count AS resolved_via_relationship,
  CASE
    WHEN total_rows = 0 THEN '0.0%'
    ELSE ROUND((default_org_count::numeric / total_rows) * 100, 2)::text || '%'
  END AS default_org_fallback_rate,
  CASE
    WHEN null_org_count > 0       THEN 'ACTION REQUIRED — null org_ids remain'
    WHEN total_rows = 0           THEN 'EMPTY TABLE'
    WHEN (default_org_count::numeric / total_rows) > 0.20
                                  THEN 'INVESTIGATE — fallback rate > 20%'
    WHEN (default_org_count::numeric / total_rows) > 0.05
                                  THEN 'REVIEW — fallback rate > 5%'
    ELSE                               'OK'
  END AS health_status
FROM all_tables
ORDER BY table_name;


-- ─── 5. Cross-table org parity check ─────────────────────────────────────────
-- Surfaces revenue_records rows whose organization_id does not match
-- their linked booking's organization_id.  Mismatches indicate backfill
-- join failures or later manual edits that left cross-org references.

SELECT
  'revenue_records vs bookings parity'  AS check_name,
  COUNT(*)                              AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all resolved revenue_records match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' revenue_records have org mismatch with bookings'
  END AS parity_status
FROM public.revenue_records rr
JOIN public.bookings b
  ON b.booking_ref = rr.booking_ref
     OR b.booking_ref = rr.booking_id
     OR b.booking_ref = rr.original_booking_id
WHERE rr.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND rr.organization_id <> b.organization_id;


-- ─── 6. Ledger vs booking org parity ─────────────────────────────────────────

SELECT
  'renter_balance_ledger vs bookings parity' AS check_name,
  COUNT(*)                                    AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all ledger entries match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' ledger entries have org mismatch with bookings'
  END AS parity_status
FROM public.renter_balance_ledger rbl
JOIN public.bookings b ON b.booking_ref = rbl.booking_id
WHERE rbl.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND rbl.organization_id <> b.organization_id;


-- ─── 7. payment_plans vs bookings parity ──────────────────────────────────────

SELECT
  'payment_plans vs bookings parity'   AS check_name,
  COUNT(*)                             AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all payment_plans match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' payment_plans have org mismatch with bookings'
  END AS parity_status
FROM public.payment_plans pp
JOIN public.bookings b ON b.booking_ref = pp.booking_id
WHERE pp.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND pp.organization_id <> b.organization_id;


-- ─── 8. payment_plan_installments vs payment_plans parity ─────────────────────

SELECT
  'payment_plan_installments vs payment_plans parity' AS check_name,
  COUNT(*)                                             AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all installments match parent plan org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' installments have org mismatch with parent plan'
  END AS parity_status
FROM public.payment_plan_installments ppi
JOIN public.payment_plans pp ON pp.id = ppi.plan_id
WHERE ppi.organization_id IS NOT NULL
  AND pp.organization_id IS NOT NULL
  AND ppi.organization_id <> pp.organization_id;


-- ─── 9. Revenue records with no matching booking (orphan check) ────────────────

SELECT
  'revenue_records orphan check' AS check_name,
  COUNT(*)                       AS orphan_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — no orphan revenue records'
    ELSE 'REVIEW — ' || COUNT(*) || ' revenue_records have no matching booking ref (defaulted)'
  END AS orphan_status
FROM public.revenue_records rr
LEFT JOIN public.bookings b
  ON b.booking_ref = rr.booking_ref
  OR b.booking_ref = rr.booking_id
  OR b.booking_ref = rr.original_booking_id
WHERE b.booking_ref IS NULL
  AND rr.organization_id = (
    SELECT id FROM public.organizations WHERE slug = 'sly-rides-default' LIMIT 1
  );


-- ===========================================================================
-- 0179_operator_leads_api_alignment.sql
-- ===========================================================================
-- supabase/migrations/0179_operator_leads_api_alignment.sql
-- Align public.operator_leads with the payload written by api/operator-leads.js
-- and notify PostgREST so /api/operator-leads can write immediately after deploy.

BEGIN;

CREATE TABLE IF NOT EXISTS public.operator_leads (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name          TEXT        NOT NULL,
  last_name           TEXT        NOT NULL,
  email               TEXT        NOT NULL,
  phone               TEXT        NOT NULL,
  fleet_size          TEXT        NOT NULL,
  source              TEXT        NOT NULL DEFAULT 'fleet_control_early_access',
  status              TEXT        NOT NULL DEFAULT 'new_lead',
  notes               TEXT,
  onboarding_progress JSONB       NOT NULL DEFAULT '{}'::jsonb,
  stripe_status       TEXT,
  organization_id     UUID,
  demo_scheduled_at   TIMESTAMPTZ,
  contacted_at        TIMESTAMPTZ,
  activated_at        TIMESTAMPTZ,
  rejected_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.operator_leads
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS fleet_size TEXT,
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_progress JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS stripe_status TEXT,
  ADD COLUMN IF NOT EXISTS organization_id UUID,
  ADD COLUMN IF NOT EXISTS demo_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

DO $$
DECLARE
  v_has_name_column boolean;
  v_has_onboarding_notes_column boolean;
  v_fleet_size_type text;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'operator_leads'
      AND column_name = 'name'
  ) INTO v_has_name_column;

  IF v_has_name_column THEN
    EXECUTE $sql$
      UPDATE public.operator_leads
         SET first_name = COALESCE(
               NULLIF(first_name, ''),
               NULLIF(split_part(BTRIM(name), ' ', 1), ''),
               'Lead'
             ),
             last_name = COALESCE(
               NULLIF(last_name, ''),
               NULLIF(BTRIM(regexp_replace(BTRIM(name), '^\S+\s*', '')), ''),
               'Lead'
             )
       WHERE COALESCE(name, '') <> ''
         AND (
           COALESCE(first_name, '') = ''
           OR COALESCE(last_name, '') = ''
         )
    $sql$;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'operator_leads'
      AND column_name = 'onboarding_notes'
  ) INTO v_has_onboarding_notes_column;

  IF v_has_onboarding_notes_column THEN
    EXECUTE $sql$
      UPDATE public.operator_leads
         SET notes = onboarding_notes
       WHERE COALESCE(notes, '') = ''
         AND COALESCE(onboarding_notes, '') <> ''
    $sql$;
  END IF;

  SELECT data_type
    INTO v_fleet_size_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'operator_leads'
     AND column_name = 'fleet_size';

  IF v_fleet_size_type = 'integer' THEN
    ALTER TABLE public.operator_leads
      ALTER COLUMN fleet_size TYPE TEXT
      USING CASE
        WHEN fleet_size IS NULL THEN NULL
        ELSE fleet_size::text
      END;
  END IF;
END $$;

ALTER TABLE public.operator_leads
  ALTER COLUMN source SET DEFAULT 'fleet_control_early_access',
  ALTER COLUMN status SET DEFAULT 'new_lead',
  ALTER COLUMN onboarding_progress SET DEFAULT '{}'::jsonb,
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET DEFAULT NOW();

UPDATE public.operator_leads
   SET first_name = 'Lead'
 WHERE COALESCE(BTRIM(first_name), '') = '';

UPDATE public.operator_leads
   SET last_name = 'Lead'
 WHERE COALESCE(BTRIM(last_name), '') = '';

UPDATE public.operator_leads
   SET email = CONCAT('unknown+', id::text, '@invalid.local')
 WHERE COALESCE(BTRIM(email), '') = '';

UPDATE public.operator_leads
   SET phone = 'unknown'
 WHERE COALESCE(BTRIM(phone), '') = '';

UPDATE public.operator_leads
   SET fleet_size = 'unknown'
 WHERE COALESCE(BTRIM(fleet_size), '') = '';

UPDATE public.operator_leads
   SET source = 'fleet_control_early_access'
 WHERE COALESCE(BTRIM(source), '') = '';

UPDATE public.operator_leads
   SET status = 'new_lead'
 WHERE status IS NULL
    OR status NOT IN (
      'new_lead',
      'contacted',
      'demo_scheduled',
      'onboarding',
      'active_operator',
      'rejected'
    );

UPDATE public.operator_leads
   SET onboarding_progress = '{}'::jsonb
 WHERE onboarding_progress IS NULL;

UPDATE public.operator_leads
   SET created_at = NOW()
 WHERE created_at IS NULL;

UPDATE public.operator_leads
   SET updated_at = NOW()
 WHERE updated_at IS NULL;

ALTER TABLE public.operator_leads
  ALTER COLUMN first_name SET NOT NULL,
  ALTER COLUMN last_name SET NOT NULL,
  ALTER COLUMN email SET NOT NULL,
  ALTER COLUMN phone SET NOT NULL,
  ALTER COLUMN fleet_size SET NOT NULL,
  ALTER COLUMN source SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN onboarding_progress SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  FOR v_constraint_name IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'operator_leads'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    IF v_constraint_name <> 'operator_leads_status_check' THEN
      EXECUTE format(
        'ALTER TABLE public.operator_leads DROP CONSTRAINT %I',
        v_constraint_name
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'operator_leads'
       AND c.contype = 'c'
       AND c.conname = 'operator_leads_status_check'
  ) THEN
    ALTER TABLE public.operator_leads
      ADD CONSTRAINT operator_leads_status_check
      CHECK (
        status IN (
          'new_lead',
          'contacted',
          'demo_scheduled',
          'onboarding',
          'active_operator',
          'rejected'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_operator_leads_status
  ON public.operator_leads (status);

CREATE INDEX IF NOT EXISTS idx_operator_leads_email
  ON public.operator_leads (email);

CREATE INDEX IF NOT EXISTS idx_operator_leads_created
  ON public.operator_leads (created_at DESC);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'organizations'
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'operator_leads_organization_id_fkey'
  ) THEN
    ALTER TABLE public.operator_leads
      ADD CONSTRAINT operator_leads_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES public.organizations(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'set_operator_leads_updated_at'
  ) THEN
    CREATE TRIGGER set_operator_leads_updated_at
      BEFORE UPDATE ON public.operator_leads
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

ALTER TABLE public.operator_leads ENABLE ROW LEVEL SECURITY;

GRANT INSERT ON TABLE public.operator_leads TO anon;
GRANT ALL ON TABLE public.operator_leads TO service_role;

DROP POLICY IF EXISTS operator_leads_anon_insert ON public.operator_leads;
CREATE POLICY operator_leads_anon_insert
  ON public.operator_leads
  FOR INSERT
  TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS operator_leads_service_role_all ON public.operator_leads;
CREATE POLICY operator_leads_service_role_all
  ON public.operator_leads
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

NOTIFY pgrst, 'reload schema';

COMMIT;


-- ===========================================================================
-- 0180_financial_tenant_wave_b.sql
-- ===========================================================================
-- supabase/migrations/0180_financial_tenant_wave_b.sql
-- Adds compatibility-safe organization_id scaffolding to the next tier of
-- financial and booking-adjacent tables.
--
-- Tables covered:
--   charges            — extra charges applied to bookings (damages, late fees, etc.)
--   tickets            — violation tickets linked to bookings and customers
--   booking_extensions — paid rental extension records
--   customer_ledger    — append-only shadow ledger per customer
--
-- Backfill strategy (same hierarchy as 0177):
--   1. Resolve from linked booking  (highest confidence)
--   2. Resolve from linked customer (secondary)
--   3. Fall back to default organization (ensures NOT NULL / FK compliance)
--
-- Design principles (unchanged from Wave A):
--   • Additive only — no existing columns, constraints, or triggers are removed.
--   • Idempotent — every statement uses IF NOT EXISTS / ON CONFLICT guards.
--   • Compatibility-safe — legacy callers continue working; default-org trigger
--     ensures every new row gets an organization_id even without a resolved tenant.
--   • No RLS policies — enforcement follows once staging validation passes.
--
-- Blockers before activation:
--   • 0175, 0176, 0177 must be applied first (ensure_default_organization()
--     and the organizations table must exist).
--   • Run 0178_staging_validation.sql to confirm Wave A is complete.
--   • Run 0179_backfill_audit.sql and review results before proceeding to
--     RLS or hard org enforcement.

-- ─── Shared helper: ensure_default_organization() ────────────────────────────
-- Re-declared here (idempotent CREATE OR REPLACE) so this migration is
-- self-contained and safe to apply independently.

create or replace function public.ensure_default_organization()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  default_org_id uuid;
begin
  insert into public.organizations (slug, name, status, metadata)
  values (
    'sly-rides-default',
    'SLY Rides Default Organization',
    'active',
    jsonb_build_object(
      'is_default', true,
      'seeded_by_migration', '0180_financial_tenant_wave_b'
    )
  )
  on conflict (slug) do update
    set status = 'active',
        metadata = coalesce(public.organizations.metadata, '{}'::jsonb) || excluded.metadata
  returning id into default_org_id;

  if default_org_id is not null then
    return default_org_id;
  end if;

  select id
    into default_org_id
    from public.organizations
   where slug = 'sly-rides-default'
   limit 1;

  return default_org_id;
end;
$$;

create or replace function public.assign_default_organization_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.organization_id is null then
    new.organization_id := public.ensure_default_organization();
  end if;

  return new;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- TABLE: charges
-- ─────────────────────────────────────────────────────────────────────────────
-- charges.booking_id is a text FK to bookings.booking_ref, so we can resolve
-- org directly in one step.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'charges'
  ) then

    alter table public.charges
      add column if not exists organization_id uuid;

    alter table public.charges
      alter column organization_id set default public.ensure_default_organization();

    -- Step 1: resolve from linked booking
    update public.charges c
       set organization_id = b.organization_id
      from public.bookings b
     where c.organization_id is null
       and b.organization_id is not null
       and b.booking_ref = c.booking_id;

    -- Step 2: fall back to default
    update public.charges
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'charges_organization_id_fkey'
    ) then
      alter table public.charges
        add constraint charges_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists charges_organization_id_idx
      on public.charges (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_charges_assign_default_organization_id'
    ) then
      create trigger trg_charges_assign_default_organization_id
        before insert or update of organization_id on public.charges
        for each row
        execute function public.assign_default_organization_id();
    end if;

  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- TABLE: tickets
-- ─────────────────────────────────────────────────────────────────────────────
-- tickets has FKs to both bookings (booking_id → bookings.booking_ref) and
-- customers (customer_id → customers.id).  Resolution priority:
--   booking link → customer link → default.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'tickets'
  ) then

    alter table public.tickets
      add column if not exists organization_id uuid;

    alter table public.tickets
      alter column organization_id set default public.ensure_default_organization();

    -- Step 1: resolve from linked booking
    update public.tickets t
       set organization_id = b.organization_id
      from public.bookings b
     where t.organization_id is null
       and b.organization_id is not null
       and b.booking_ref = t.booking_id;

    -- Step 2: resolve from linked customer (for tickets not linked to a booking)
    update public.tickets t
       set organization_id = c.organization_id
      from public.customers c
     where t.organization_id is null
       and t.customer_id is not null
       and c.organization_id is not null
       and c.id = t.customer_id;

    -- Step 3: fall back to default
    update public.tickets
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'tickets_organization_id_fkey'
    ) then
      alter table public.tickets
        add constraint tickets_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists tickets_organization_id_idx
      on public.tickets (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_tickets_assign_default_organization_id'
    ) then
      create trigger trg_tickets_assign_default_organization_id
        before insert or update of organization_id on public.tickets
        for each row
        execute function public.assign_default_organization_id();
    end if;

  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- TABLE: booking_extensions
-- ─────────────────────────────────────────────────────────────────────────────
-- booking_extensions.booking_id is a text FK to bookings.booking_ref.
-- Resolution is a single join step.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'booking_extensions'
  ) then

    alter table public.booking_extensions
      add column if not exists organization_id uuid;

    alter table public.booking_extensions
      alter column organization_id set default public.ensure_default_organization();

    -- Step 1: resolve from linked booking
    update public.booking_extensions be
       set organization_id = b.organization_id
      from public.bookings b
     where be.organization_id is null
       and b.organization_id is not null
       and b.booking_ref = be.booking_id;

    -- Step 2: fall back to default
    update public.booking_extensions
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'booking_extensions_organization_id_fkey'
    ) then
      alter table public.booking_extensions
        add constraint booking_extensions_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists booking_extensions_organization_id_idx
      on public.booking_extensions (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_booking_extensions_assign_default_organization_id'
    ) then
      create trigger trg_booking_extensions_assign_default_organization_id
        before insert or update of organization_id on public.booking_extensions
        for each row
        execute function public.assign_default_organization_id();
    end if;

  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- TABLE: customer_ledger
-- ─────────────────────────────────────────────────────────────────────────────
-- customer_ledger has a UUID FK to customers (customer_id) and an optional
-- text booking_ref.  Resolution priority:
--   booking link (via booking_ref) → customer link → default.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'public'
       and table_name = 'customer_ledger'
  ) then

    alter table public.customer_ledger
      add column if not exists organization_id uuid;

    alter table public.customer_ledger
      alter column organization_id set default public.ensure_default_organization();

    -- Step 1: resolve from linked booking (booking_ref → bookings.booking_ref)
    update public.customer_ledger cl
       set organization_id = b.organization_id
      from public.bookings b
     where cl.organization_id is null
       and cl.booking_ref is not null
       and b.organization_id is not null
       and b.booking_ref = cl.booking_ref;

    -- Step 2: resolve from linked customer
    update public.customer_ledger cl
       set organization_id = c.organization_id
      from public.customers c
     where cl.organization_id is null
       and c.organization_id is not null
       and c.id = cl.customer_id;

    -- Step 3: fall back to default
    update public.customer_ledger
       set organization_id = public.ensure_default_organization()
     where organization_id is null;

    if not exists (
      select 1
        from pg_constraint
       where conname = 'customer_ledger_organization_id_fkey'
    ) then
      alter table public.customer_ledger
        add constraint customer_ledger_organization_id_fkey
        foreign key (organization_id)
        references public.organizations(id)
        on delete restrict;
    end if;

    create index if not exists customer_ledger_organization_id_idx
      on public.customer_ledger (organization_id);

    if not exists (
      select 1
        from pg_trigger
       where tgname = 'trg_customer_ledger_assign_default_organization_id'
    ) then
      create trigger trg_customer_ledger_assign_default_organization_id
        before insert or update of organization_id on public.customer_ledger
        for each row
        execute function public.assign_default_organization_id();
    end if;

  end if;
end $$;


-- ===========================================================================
-- 0180_operator_leads_validation.sql
-- ===========================================================================
-- supabase/migrations/0180_operator_leads_validation.sql
-- Read-only validation for operator lead ingestion.
--
-- HOW TO USE:
--   psql <connection> -f 0180_operator_leads_validation.sql

DO $$
DECLARE
  v_table_exists boolean;
  v_rls_enabled boolean;
  v_schema_migrations_exists boolean;
  v_has_0175_record boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
  ) INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE EXCEPTION '[operator_leads FAIL] Table public.operator_leads does not exist.';
  END IF;
  RAISE NOTICE '[operator_leads OK] Table public.operator_leads exists.';

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'first_name'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] first_name is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] first_name must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'last_name'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] last_name is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] last_name must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'email'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] email is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] email must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'phone'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] phone is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] phone must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'fleet_size'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] fleet_size is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] fleet_size must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'source'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] source is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] source must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'notes'
       AND data_type = 'text'
  ) THEN
    RAISE NOTICE '[operator_leads OK] notes is text.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] notes must be text.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'status'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] status is text NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] status must be text NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'onboarding_progress'
       AND data_type = 'jsonb'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] onboarding_progress is jsonb NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] onboarding_progress must be jsonb NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'created_at'
       AND data_type = 'timestamp with time zone'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] created_at is timestamptz NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] created_at must be timestamptz NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operator_leads'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp with time zone'
       AND is_nullable = 'NO'
  ) THEN
    RAISE NOTICE '[operator_leads OK] updated_at is timestamptz NOT NULL.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] updated_at must be timestamptz NOT NULL.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'operator_leads'
       AND c.conname = 'operator_leads_status_check'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%new_lead%'
       AND pg_get_constraintdef(c.oid) ILIKE '%contacted%'
       AND pg_get_constraintdef(c.oid) ILIKE '%demo_scheduled%'
       AND pg_get_constraintdef(c.oid) ILIKE '%onboarding%'
       AND pg_get_constraintdef(c.oid) ILIKE '%active_operator%'
       AND pg_get_constraintdef(c.oid) ILIKE '%rejected%'
  ) THEN
    RAISE NOTICE '[operator_leads OK] Named status check constraint exists and includes expected states.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] Missing or invalid operator_leads_status_check constraint.';
  END IF;

  SELECT c.relrowsecurity
    INTO v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'operator_leads';

  IF COALESCE(v_rls_enabled, false) THEN
    RAISE NOTICE '[operator_leads OK] RLS is enabled.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] RLS must be enabled on public.operator_leads.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'operator_leads'
       AND policyname = 'operator_leads_anon_insert'
       AND cmd = 'INSERT'
       AND roles @> ARRAY['anon']::name[]
  ) THEN
    RAISE NOTICE '[operator_leads OK] Policy operator_leads_anon_insert exists.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] Missing policy operator_leads_anon_insert for anon inserts.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'operator_leads'
       AND policyname = 'operator_leads_service_role_all'
       AND cmd = 'ALL'
       AND roles @> ARRAY['service_role']::name[]
  ) THEN
    RAISE NOTICE '[operator_leads OK] Policy operator_leads_service_role_all exists.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] Missing policy operator_leads_service_role_all for service_role.';
  END IF;

  IF has_table_privilege('anon', 'public.operator_leads', 'INSERT') THEN
    RAISE NOTICE '[operator_leads OK] anon has INSERT grant.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] anon must have INSERT grant on public.operator_leads.';
  END IF;

  IF has_table_privilege('service_role', 'public.operator_leads', 'INSERT,SELECT,UPDATE,DELETE') THEN
    RAISE NOTICE '[operator_leads OK] service_role has ALL table grants.';
  ELSE
    RAISE EXCEPTION '[operator_leads FAIL] service_role must have ALL table grants on public.operator_leads.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'supabase_migrations'
       AND table_name = 'schema_migrations'
  ) INTO v_schema_migrations_exists;

  IF v_schema_migrations_exists THEN
    SELECT EXISTS (
      SELECT 1
        FROM supabase_migrations.schema_migrations
       WHERE version = '0175'
    ) INTO v_has_0175_record;

    IF v_has_0175_record THEN
      RAISE NOTICE '[operator_leads OK] supabase_migrations records version 0175.';
    ELSE
      RAISE NOTICE '[operator_leads WARN] supabase_migrations does not record version 0175.';
    END IF;
  ELSE
    RAISE NOTICE '[operator_leads WARN] supabase_migrations.schema_migrations table not available for history verification.';
  END IF;

  RAISE NOTICE '[operator_leads PASS] Validation complete.';
END $$;


-- ===========================================================================
-- 0181_staging_validation_wave_b.sql
-- ===========================================================================
-- supabase/migrations/0181_staging_validation_wave_b.sql
-- Staging validation for migration 0180 (financial_tenant_wave_b).
--
-- PURPOSE:
--   Confirms that the Wave B migration left the expected schema objects on the
--   target database.  Run this after applying 0175 → 0176 → 0177 → 0178 → 0179
--   → 0180 (in that order) to verify the full sequence completed without silent
--   failures.
--
-- Tables validated:
--   charges, tickets, booking_extensions, customer_ledger
--
-- HOW TO USE:
--   psql <connection> -f 0181_staging_validation_wave_b.sql
--
--   A successful run prints one NOTICE per validation point, ending with:
--     "VALIDATION COMPLETE: Wave B staging checks passed."
--   Any missing object raises a RAISE EXCEPTION that aborts the script with a
--   clear error message identifying which table or constraint is incomplete.
--
-- SAFETY:
--   Read-only — no DDL or DML.  Safe to re-run at any time.
--   All checks are wrapped in a single DO block; the exception rolls back the
--   implicit savepoint so the rest of the connection session is unaffected.

DO $$
DECLARE
  -- ── charges ────────────────────────────────────────────────────────────────
  v_col_charges_org_id          boolean;
  v_fk_charges_org              boolean;
  v_idx_charges_org             boolean;
  v_trigger_charges_default     boolean;

  -- ── tickets ────────────────────────────────────────────────────────────────
  v_col_tickets_org_id          boolean;
  v_fk_tickets_org              boolean;
  v_idx_tickets_org             boolean;
  v_trigger_tickets_default     boolean;

  -- ── booking_extensions ─────────────────────────────────────────────────────
  v_col_bext_org_id             boolean;
  v_fk_bext_org                 boolean;
  v_idx_bext_org                boolean;
  v_trigger_bext_default        boolean;

  -- ── customer_ledger ────────────────────────────────────────────────────────
  v_col_cl_org_id               boolean;
  v_fk_cl_org                   boolean;
  v_idx_cl_org                  boolean;
  v_trigger_cl_default          boolean;

  -- ── shared helpers ─────────────────────────────────────────────────────────
  v_fn_ensure_default_org       boolean;
  v_fn_assign_default_org       boolean;
  v_default_org_row             boolean;
BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- PREREQUISITE: shared helper functions and default org row
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_proc.proname = 'ensure_default_organization'
  ) INTO v_fn_ensure_default_org;
  IF NOT v_fn_ensure_default_org THEN
    RAISE EXCEPTION '[0180 PREREQ FAIL] Function public.ensure_default_organization() is missing. Apply Wave A migrations first.';
  END IF;
  RAISE NOTICE '[PREREQ OK] Function public.ensure_default_organization() exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_proc.proname = 'assign_default_organization_id'
  ) INTO v_fn_assign_default_org;
  IF NOT v_fn_assign_default_org THEN
    RAISE EXCEPTION '[0180 PREREQ FAIL] Function public.assign_default_organization_id() is missing. Apply Wave A migrations first.';
  END IF;
  RAISE NOTICE '[PREREQ OK] Function public.assign_default_organization_id() exists.';

  SELECT EXISTS (
    SELECT 1 FROM public.organizations WHERE slug = 'sly-rides-default' AND status = 'active'
  ) INTO v_default_org_row;
  IF NOT v_default_org_row THEN
    RAISE EXCEPTION '[0180 PREREQ FAIL] Default organization row (slug=sly-rides-default) is missing. Apply migration 0176 first.';
  END IF;
  RAISE NOTICE '[PREREQ OK] Default organization row (slug=sly-rides-default) exists and is active.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0180: charges
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'charges' AND column_name = 'organization_id'
  ) INTO v_col_charges_org_id;
  IF NOT v_col_charges_org_id THEN
    RAISE EXCEPTION '[0180 FAIL] Column charges.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0180 OK] Column charges.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'charges_organization_id_fkey'
  ) INTO v_fk_charges_org;
  IF NOT v_fk_charges_org THEN
    RAISE EXCEPTION '[0180 FAIL] FK constraint charges_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] FK constraint charges_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'charges_organization_id_idx'
  ) INTO v_idx_charges_org;
  IF NOT v_idx_charges_org THEN
    RAISE EXCEPTION '[0180 FAIL] Index charges_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Index charges_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_charges_assign_default_organization_id'
  ) INTO v_trigger_charges_default;
  IF NOT v_trigger_charges_default THEN
    RAISE EXCEPTION '[0180 FAIL] Trigger trg_charges_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Trigger trg_charges_assign_default_organization_id exists.';

  RAISE NOTICE '[0180 PASS] charges scaffolding validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0180: tickets
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'organization_id'
  ) INTO v_col_tickets_org_id;
  IF NOT v_col_tickets_org_id THEN
    RAISE EXCEPTION '[0180 FAIL] Column tickets.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0180 OK] Column tickets.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tickets_organization_id_fkey'
  ) INTO v_fk_tickets_org;
  IF NOT v_fk_tickets_org THEN
    RAISE EXCEPTION '[0180 FAIL] FK constraint tickets_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] FK constraint tickets_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'tickets_organization_id_idx'
  ) INTO v_idx_tickets_org;
  IF NOT v_idx_tickets_org THEN
    RAISE EXCEPTION '[0180 FAIL] Index tickets_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Index tickets_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_tickets_assign_default_organization_id'
  ) INTO v_trigger_tickets_default;
  IF NOT v_trigger_tickets_default THEN
    RAISE EXCEPTION '[0180 FAIL] Trigger trg_tickets_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Trigger trg_tickets_assign_default_organization_id exists.';

  RAISE NOTICE '[0180 PASS] tickets scaffolding validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0180: booking_extensions
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'booking_extensions' AND column_name = 'organization_id'
  ) INTO v_col_bext_org_id;
  IF NOT v_col_bext_org_id THEN
    RAISE EXCEPTION '[0180 FAIL] Column booking_extensions.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0180 OK] Column booking_extensions.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'booking_extensions_organization_id_fkey'
  ) INTO v_fk_bext_org;
  IF NOT v_fk_bext_org THEN
    RAISE EXCEPTION '[0180 FAIL] FK constraint booking_extensions_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] FK constraint booking_extensions_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'booking_extensions_organization_id_idx'
  ) INTO v_idx_bext_org;
  IF NOT v_idx_bext_org THEN
    RAISE EXCEPTION '[0180 FAIL] Index booking_extensions_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Index booking_extensions_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_booking_extensions_assign_default_organization_id'
  ) INTO v_trigger_bext_default;
  IF NOT v_trigger_bext_default THEN
    RAISE EXCEPTION '[0180 FAIL] Trigger trg_booking_extensions_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Trigger trg_booking_extensions_assign_default_organization_id exists.';

  RAISE NOTICE '[0180 PASS] booking_extensions scaffolding validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- VALIDATE 0180: customer_ledger
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customer_ledger' AND column_name = 'organization_id'
  ) INTO v_col_cl_org_id;
  IF NOT v_col_cl_org_id THEN
    RAISE EXCEPTION '[0180 FAIL] Column customer_ledger.organization_id does not exist.';
  END IF;
  RAISE NOTICE '[0180 OK] Column customer_ledger.organization_id exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_ledger_organization_id_fkey'
  ) INTO v_fk_cl_org;
  IF NOT v_fk_cl_org THEN
    RAISE EXCEPTION '[0180 FAIL] FK constraint customer_ledger_organization_id_fkey is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] FK constraint customer_ledger_organization_id_fkey exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'customer_ledger_organization_id_idx'
  ) INTO v_idx_cl_org;
  IF NOT v_idx_cl_org THEN
    RAISE EXCEPTION '[0180 FAIL] Index customer_ledger_organization_id_idx is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Index customer_ledger_organization_id_idx exists.';

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_customer_ledger_assign_default_organization_id'
  ) INTO v_trigger_cl_default;
  IF NOT v_trigger_cl_default THEN
    RAISE EXCEPTION '[0180 FAIL] Trigger trg_customer_ledger_assign_default_organization_id is missing.';
  END IF;
  RAISE NOTICE '[0180 OK] Trigger trg_customer_ledger_assign_default_organization_id exists.';

  RAISE NOTICE '[0180 PASS] customer_ledger scaffolding validated.';

  -- ══════════════════════════════════════════════════════════════════════════
  -- ALL CHECKS PASSED
  -- ══════════════════════════════════════════════════════════════════════════
  RAISE NOTICE 'VALIDATION COMPLETE: Wave B staging checks passed. Safe to proceed to Wave B backfill audit (0182).';

END $$;


-- ===========================================================================
-- 0181_wave_b_backfill_audit.sql
-- ===========================================================================
-- supabase/migrations/0181_wave_b_backfill_audit.sql
-- Post-backfill default-org usage audit for Wave B (0180).
--
-- PURPOSE:
--   Applies the same audit standards as 0179_backfill_audit.sql to Wave B tables:
--     charges, tickets, booking_extensions, customer_ledger.
--
-- HOW TO USE:
--   psql <connection> -f 0181_wave_b_backfill_audit.sql
--
-- INTERPRETATION:
--   default_org_count / total_rows = fallback rate.
--   A rate above ~5% on tenant-sensitive financial tables requires manual review
--   before RLS or hard org enforcement proceeds.
--
-- SAFETY:
--   Read-only. No DDL or DML against persistent schema objects.

DO $$
DECLARE
  v_default_org_id uuid;
BEGIN
  RAISE NOTICE 'Starting Wave B post-backfill default-org usage audit...';

  SELECT id
    INTO v_default_org_id
    FROM public.organizations
   WHERE slug = 'sly-rides-default'
   LIMIT 1;

  IF v_default_org_id IS NULL THEN
    RAISE EXCEPTION '[0181 FAIL] Default organization (slug=sly-rides-default) is missing. Run 0175/0176 foundation first.';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS wave_b_audit_summary (
    table_name text,
    total_rows bigint,
    default_org_count bigint,
    null_org_count bigint,
    resolved_via_relationship bigint,
    default_org_fallback_rate text,
    health_status text
  ) ON COMMIT DROP;

  TRUNCATE wave_b_audit_summary;

  IF to_regclass('public.charges') IS NOT NULL THEN
    INSERT INTO wave_b_audit_summary
    SELECT
      'charges' AS table_name,
      COUNT(*) AS total_rows,
      COUNT(*) FILTER (WHERE c.organization_id = v_default_org_id) AS default_org_count,
      COUNT(*) FILTER (WHERE c.organization_id IS NULL) AS null_org_count,
      COUNT(*) - COUNT(*) FILTER (WHERE c.organization_id = v_default_org_id) - COUNT(*) FILTER (WHERE c.organization_id IS NULL) AS resolved_via_relationship,
      CASE
        WHEN COUNT(*) = 0 THEN '0.0%'
        ELSE ROUND((COUNT(*) FILTER (WHERE c.organization_id = v_default_org_id)::numeric / COUNT(*)) * 100, 2)::text || '%'
      END AS default_org_fallback_rate,
      CASE
        WHEN COUNT(*) FILTER (WHERE c.organization_id IS NULL) > 0 THEN 'ACTION REQUIRED — null org_ids remain'
        WHEN COUNT(*) = 0 THEN 'EMPTY TABLE'
        WHEN (COUNT(*) FILTER (WHERE c.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.20 THEN 'INVESTIGATE — fallback rate > 20%'
        WHEN (COUNT(*) FILTER (WHERE c.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.05 THEN 'REVIEW — fallback rate > 5%'
        ELSE 'OK'
      END AS health_status
    FROM public.charges c;
  ELSE
    INSERT INTO wave_b_audit_summary VALUES
    ('charges', 0, 0, 0, 0, 'N/A', 'MISSING TABLE');
  END IF;

  IF to_regclass('public.tickets') IS NOT NULL THEN
    INSERT INTO wave_b_audit_summary
    SELECT
      'tickets' AS table_name,
      COUNT(*) AS total_rows,
      COUNT(*) FILTER (WHERE t.organization_id = v_default_org_id) AS default_org_count,
      COUNT(*) FILTER (WHERE t.organization_id IS NULL) AS null_org_count,
      COUNT(*) - COUNT(*) FILTER (WHERE t.organization_id = v_default_org_id) - COUNT(*) FILTER (WHERE t.organization_id IS NULL) AS resolved_via_relationship,
      CASE
        WHEN COUNT(*) = 0 THEN '0.0%'
        ELSE ROUND((COUNT(*) FILTER (WHERE t.organization_id = v_default_org_id)::numeric / COUNT(*)) * 100, 2)::text || '%'
      END AS default_org_fallback_rate,
      CASE
        WHEN COUNT(*) FILTER (WHERE t.organization_id IS NULL) > 0 THEN 'ACTION REQUIRED — null org_ids remain'
        WHEN COUNT(*) = 0 THEN 'EMPTY TABLE'
        WHEN (COUNT(*) FILTER (WHERE t.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.20 THEN 'INVESTIGATE — fallback rate > 20%'
        WHEN (COUNT(*) FILTER (WHERE t.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.05 THEN 'REVIEW — fallback rate > 5%'
        ELSE 'OK'
      END AS health_status
    FROM public.tickets t;
  ELSE
    INSERT INTO wave_b_audit_summary VALUES
    ('tickets', 0, 0, 0, 0, 'N/A', 'MISSING TABLE');
  END IF;

  IF to_regclass('public.booking_extensions') IS NOT NULL THEN
    INSERT INTO wave_b_audit_summary
    SELECT
      'booking_extensions' AS table_name,
      COUNT(*) AS total_rows,
      COUNT(*) FILTER (WHERE be.organization_id = v_default_org_id) AS default_org_count,
      COUNT(*) FILTER (WHERE be.organization_id IS NULL) AS null_org_count,
      COUNT(*) - COUNT(*) FILTER (WHERE be.organization_id = v_default_org_id) - COUNT(*) FILTER (WHERE be.organization_id IS NULL) AS resolved_via_relationship,
      CASE
        WHEN COUNT(*) = 0 THEN '0.0%'
        ELSE ROUND((COUNT(*) FILTER (WHERE be.organization_id = v_default_org_id)::numeric / COUNT(*)) * 100, 2)::text || '%'
      END AS default_org_fallback_rate,
      CASE
        WHEN COUNT(*) FILTER (WHERE be.organization_id IS NULL) > 0 THEN 'ACTION REQUIRED — null org_ids remain'
        WHEN COUNT(*) = 0 THEN 'EMPTY TABLE'
        WHEN (COUNT(*) FILTER (WHERE be.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.20 THEN 'INVESTIGATE — fallback rate > 20%'
        WHEN (COUNT(*) FILTER (WHERE be.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.05 THEN 'REVIEW — fallback rate > 5%'
        ELSE 'OK'
      END AS health_status
    FROM public.booking_extensions be;
  ELSE
    INSERT INTO wave_b_audit_summary VALUES
    ('booking_extensions', 0, 0, 0, 0, 'N/A', 'MISSING TABLE');
  END IF;

  IF to_regclass('public.customer_ledger') IS NOT NULL THEN
    INSERT INTO wave_b_audit_summary
    SELECT
      'customer_ledger' AS table_name,
      COUNT(*) AS total_rows,
      COUNT(*) FILTER (WHERE cl.organization_id = v_default_org_id) AS default_org_count,
      COUNT(*) FILTER (WHERE cl.organization_id IS NULL) AS null_org_count,
      COUNT(*) - COUNT(*) FILTER (WHERE cl.organization_id = v_default_org_id) - COUNT(*) FILTER (WHERE cl.organization_id IS NULL) AS resolved_via_relationship,
      CASE
        WHEN COUNT(*) = 0 THEN '0.0%'
        ELSE ROUND((COUNT(*) FILTER (WHERE cl.organization_id = v_default_org_id)::numeric / COUNT(*)) * 100, 2)::text || '%'
      END AS default_org_fallback_rate,
      CASE
        WHEN COUNT(*) FILTER (WHERE cl.organization_id IS NULL) > 0 THEN 'ACTION REQUIRED — null org_ids remain'
        WHEN COUNT(*) = 0 THEN 'EMPTY TABLE'
        WHEN (COUNT(*) FILTER (WHERE cl.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.20 THEN 'INVESTIGATE — fallback rate > 20%'
        WHEN (COUNT(*) FILTER (WHERE cl.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.05 THEN 'REVIEW — fallback rate > 5%'
        ELSE 'OK'
      END AS health_status
    FROM public.customer_ledger cl;
  ELSE
    INSERT INTO wave_b_audit_summary VALUES
    ('customer_ledger', 0, 0, 0, 0, 'N/A', 'MISSING TABLE');
  END IF;
END $$;

SELECT *
FROM wave_b_audit_summary
ORDER BY table_name;

-- Cross-table parity checks.
DO $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS wave_b_parity_checks (
    check_name text,
    mismatch_count bigint,
    parity_status text
  ) ON COMMIT DROP;

  TRUNCATE wave_b_parity_checks;

  IF to_regclass('public.charges') IS NOT NULL AND to_regclass('public.bookings') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'charges vs bookings parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — all charges match booking org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' charges have org mismatch with bookings'
      END AS parity_status
    FROM public.charges c
    JOIN public.bookings b
      ON b.booking_ref = c.booking_id
   WHERE c.organization_id IS NOT NULL
     AND b.organization_id IS NOT NULL
     AND c.organization_id <> b.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('charges vs bookings parity', 0, 'SKIPPED — required table missing');
  END IF;

  IF to_regclass('public.tickets') IS NOT NULL AND to_regclass('public.bookings') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'tickets vs bookings parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — tickets linked to bookings match booking org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' tickets have org mismatch with bookings'
      END AS parity_status
    FROM public.tickets t
    JOIN public.bookings b
      ON b.booking_ref = t.booking_id
   WHERE t.organization_id IS NOT NULL
     AND b.organization_id IS NOT NULL
     AND t.organization_id <> b.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('tickets vs bookings parity', 0, 'SKIPPED — required table missing');
  END IF;

  IF to_regclass('public.tickets') IS NOT NULL AND to_regclass('public.customers') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'tickets vs customers parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — tickets linked to customers match customer org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' tickets have org mismatch with customers'
      END AS parity_status
    FROM public.tickets t
    JOIN public.customers c
      ON c.id = t.customer_id
   WHERE t.organization_id IS NOT NULL
     AND c.organization_id IS NOT NULL
     AND t.organization_id <> c.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('tickets vs customers parity', 0, 'SKIPPED — required table missing');
  END IF;

  IF to_regclass('public.booking_extensions') IS NOT NULL AND to_regclass('public.bookings') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'booking_extensions vs bookings parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — all booking_extensions match booking org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' booking_extensions have org mismatch with bookings'
      END AS parity_status
    FROM public.booking_extensions be
    JOIN public.bookings b
      ON b.booking_ref = be.booking_id
   WHERE be.organization_id IS NOT NULL
     AND b.organization_id IS NOT NULL
     AND be.organization_id <> b.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('booking_extensions vs bookings parity', 0, 'SKIPPED — required table missing');
  END IF;

  IF to_regclass('public.customer_ledger') IS NOT NULL AND to_regclass('public.bookings') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'customer_ledger vs bookings parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — customer_ledger booking-linked rows match booking org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' customer_ledger rows have org mismatch with bookings'
      END AS parity_status
    FROM public.customer_ledger cl
    JOIN public.bookings b
      ON b.booking_ref = cl.booking_ref
   WHERE cl.booking_ref IS NOT NULL
     AND cl.organization_id IS NOT NULL
     AND b.organization_id IS NOT NULL
     AND cl.organization_id <> b.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('customer_ledger vs bookings parity', 0, 'SKIPPED — required table missing');
  END IF;

  IF to_regclass('public.customer_ledger') IS NOT NULL AND to_regclass('public.customers') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'customer_ledger vs customers parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — customer_ledger rows match customer org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' customer_ledger rows have org mismatch with customers'
      END AS parity_status
    FROM public.customer_ledger cl
    JOIN public.customers c
      ON c.id = cl.customer_id
   WHERE cl.customer_id IS NOT NULL
     AND cl.organization_id IS NOT NULL
     AND c.organization_id IS NOT NULL
     AND cl.organization_id <> c.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('customer_ledger vs customers parity', 0, 'SKIPPED — required table missing');
  END IF;
END $$;

SELECT *
FROM wave_b_parity_checks
ORDER BY check_name;


-- ===========================================================================
-- 0182_backfill_audit_wave_b.sql
-- ===========================================================================
-- supabase/migrations/0182_backfill_audit_wave_b.sql
-- Post-backfill default-org usage audit for Wave B migration (0180).
--
-- PURPOSE:
--   Quantifies how many rows across the four Wave B tables resolved to the
--   default organization (slug = 'sly-rides-default') versus resolving through
--   an explicit booking/customer relationship.
--
--   A high default-org rate indicates that the backfill join paths in 0180
--   failed to match records, and those records must be investigated before
--   RLS or hard org enforcement begins.
--
-- HOW TO USE:
--   psql <connection> -f 0182_backfill_audit_wave_b.sql
--
--   Outputs one summary row per table plus cross-table parity checks.
--
-- INTERPRETATION:
--   default_org_count / total_count = fallback rate.
--   A rate above ~5% on charges or tickets warrants manual investigation
--   before enforcement proceeds.
--
-- SAFETY:
--   Read-only — no DDL or DML.  Safe to re-run at any time.
--   Returns empty results gracefully when tables do not yet exist.

DO $$
BEGIN
  RAISE NOTICE 'Starting Wave B post-backfill default-org usage audit...';
END $$;

-- ─── 1. Default organization UUID ────────────────────────────────────────────

WITH default_org AS (
  SELECT id AS default_org_id
  FROM public.organizations
  WHERE slug = 'sly-rides-default'
  LIMIT 1
),

-- ─── 2. Per-table fallback counts ─────────────────────────────────────────────

charges_audit AS (
  SELECT
    'charges'             AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE c.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE c.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT c.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.charges c
  CROSS JOIN default_org d
),

tickets_audit AS (
  SELECT
    'tickets'             AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE t.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE t.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT t.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.tickets t
  CROSS JOIN default_org d
),

booking_extensions_audit AS (
  SELECT
    'booking_extensions'  AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE be.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE be.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT be.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.booking_extensions be
  CROSS JOIN default_org d
),

customer_ledger_audit AS (
  SELECT
    'customer_ledger'     AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE cl.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE cl.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT cl.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.customer_ledger cl
  CROSS JOIN default_org d
),

-- ─── 3. Union all tables ───────────────────────────────────────────────────────

all_tables AS (
  SELECT * FROM charges_audit
  UNION ALL SELECT * FROM tickets_audit
  UNION ALL SELECT * FROM booking_extensions_audit
  UNION ALL SELECT * FROM customer_ledger_audit
)

-- ─── 4. Final summary with fallback rate ──────────────────────────────────────

SELECT
  table_name,
  total_rows,
  default_org_count,
  null_org_count,
  total_rows - default_org_count - null_org_count AS resolved_via_relationship,
  CASE
    WHEN total_rows = 0 THEN '0.0%'
    ELSE ROUND((default_org_count::numeric / total_rows) * 100, 2)::text || '%'
  END AS default_org_fallback_rate,
  CASE
    WHEN null_org_count > 0       THEN 'ACTION REQUIRED — null org_ids remain'
    WHEN total_rows = 0           THEN 'EMPTY TABLE'
    WHEN (default_org_count::numeric / total_rows) > 0.20
                                  THEN 'INVESTIGATE — fallback rate > 20%'
    WHEN (default_org_count::numeric / total_rows) > 0.05
                                  THEN 'REVIEW — fallback rate > 5%'
    ELSE                               'OK'
  END AS health_status
FROM all_tables
ORDER BY table_name;


-- ─── 5. charges vs bookings parity ───────────────────────────────────────────

SELECT
  'charges vs bookings parity'    AS check_name,
  COUNT(*)                        AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all resolved charges match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' charges have org mismatch with bookings'
  END AS parity_status
FROM public.charges c
JOIN public.bookings b ON b.booking_ref = c.booking_id
WHERE c.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND c.organization_id <> b.organization_id;


-- ─── 6. tickets vs bookings parity ───────────────────────────────────────────

SELECT
  'tickets vs bookings parity'    AS check_name,
  COUNT(*)                        AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all tickets with booking links match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' tickets have org mismatch with bookings'
  END AS parity_status
FROM public.tickets t
JOIN public.bookings b ON b.booking_ref = t.booking_id
WHERE t.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND t.organization_id <> b.organization_id;


-- ─── 7. tickets vs customers parity (booking-less tickets) ───────────────────

SELECT
  'tickets vs customers parity'   AS check_name,
  COUNT(*)                        AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all booking-less tickets match customer org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' tickets have org mismatch with customers'
  END AS parity_status
FROM public.tickets t
JOIN public.customers c ON c.id = t.customer_id
LEFT JOIN public.bookings b ON b.booking_ref = t.booking_id
WHERE b.booking_ref IS NULL          -- only tickets not resolved via booking
  AND t.organization_id IS NOT NULL
  AND c.organization_id IS NOT NULL
  AND t.organization_id <> c.organization_id;


-- ─── 8. booking_extensions vs bookings parity ────────────────────────────────

SELECT
  'booking_extensions vs bookings parity' AS check_name,
  COUNT(*)                                 AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all booking_extensions match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' booking_extensions have org mismatch with bookings'
  END AS parity_status
FROM public.booking_extensions be
JOIN public.bookings b ON b.booking_ref = be.booking_id
WHERE be.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND be.organization_id <> b.organization_id;


-- ─── 9. customer_ledger vs bookings parity ───────────────────────────────────

SELECT
  'customer_ledger vs bookings parity'    AS check_name,
  COUNT(*)                                AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all customer_ledger entries with booking refs match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' customer_ledger entries have org mismatch with bookings'
  END AS parity_status
FROM public.customer_ledger cl
JOIN public.bookings b ON b.booking_ref = cl.booking_ref
WHERE cl.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND cl.organization_id <> b.organization_id;


-- ─── 10. customer_ledger vs customers parity (no booking_ref rows) ────────────

SELECT
  'customer_ledger vs customers parity'   AS check_name,
  COUNT(*)                                AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all booking-less ledger entries match customer org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' customer_ledger entries have org mismatch with customers'
  END AS parity_status
FROM public.customer_ledger cl
JOIN public.customers c ON c.id = cl.customer_id
LEFT JOIN public.bookings b ON b.booking_ref = cl.booking_ref
WHERE b.booking_ref IS NULL          -- only entries not resolved via booking
  AND cl.organization_id IS NOT NULL
  AND c.organization_id IS NOT NULL
  AND cl.organization_id <> c.organization_id;


-- ─── 11. charges orphan check ─────────────────────────────────────────────────

SELECT
  'charges orphan check'    AS check_name,
  COUNT(*)                  AS orphan_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — no orphan charges'
    ELSE 'REVIEW — ' || COUNT(*) || ' charges have no matching booking ref (defaulted)'
  END AS orphan_status
FROM public.charges c
LEFT JOIN public.bookings b ON b.booking_ref = c.booking_id
WHERE b.booking_ref IS NULL
  AND c.organization_id = (
    SELECT id FROM public.organizations WHERE slug = 'sly-rides-default' LIMIT 1
  );


-- ─── 12. tickets orphan check ─────────────────────────────────────────────────

SELECT
  'tickets orphan check'    AS check_name,
  COUNT(*)                  AS orphan_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — no orphan tickets'
    ELSE 'REVIEW — ' || COUNT(*) || ' tickets have no matching booking or customer ref (defaulted)'
  END AS orphan_status
FROM public.tickets t
LEFT JOIN public.bookings b ON b.booking_ref = t.booking_id
LEFT JOIN public.customers c ON c.id = t.customer_id
WHERE b.booking_ref IS NULL
  AND c.id IS NULL
  AND t.organization_id = (
    SELECT id FROM public.organizations WHERE slug = 'sly-rides-default' LIMIT 1
  );


-- ===========================================================================
-- 0182_tenant_ownership_inventory.sql
-- ===========================================================================
-- supabase/migrations/0182_tenant_ownership_inventory.sql
-- Tenant-sensitive ownership verification + readiness classification inventory.
--
-- PURPOSE:
--   Verifies organization ownership coverage across financial/reconciliation
--   tables, reconciliation views, and derived reporting surfaces.
--
-- OUTPUTS:
--   1) Detailed surface inventory with readiness classification
--   2) Classification summary counts (ready / owned-but-unaudited / unresolved ownership)
--   3) Wave A/B unresolved ownership surface list (action queue)
--
-- SAFETY:
--   Read-only. No schema/data mutation.

WITH target_audit_status AS (
  SELECT *
  FROM (VALUES
    ('bookings', 'wave_a_audited', true,  'financial_table'),
    ('customers', 'wave_a_audited', true, 'financial_table'),
    ('revenue_records', 'wave_a_audited', true, 'financial_table'),
    ('renter_balance_ledger', 'wave_a_audited', true, 'financial_table'),
    ('payment_plans', 'wave_a_audited', true, 'financial_table'),
    ('payment_plan_installments', 'wave_a_audited', true, 'financial_table'),
    ('charges', 'wave_b_pending_audit', false, 'financial_table'),
    ('tickets', 'wave_b_pending_audit', false, 'financial_table'),
    ('booking_extensions', 'wave_b_pending_audit', false, 'financial_table'),
    ('customer_ledger', 'wave_b_pending_audit', false, 'financial_table'),
    ('revenue_records_effective', 'derived_surface_pending_review', false, 'derived_reporting_surface')
  ) AS t(surface_name, audit_status, is_audited, expected_domain)
),

sensitive_surfaces AS (
  SELECT DISTINCT
    t.table_schema,
    t.table_name AS surface_name,
    t.table_type,
    EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = t.table_schema
        AND c.table_name = t.table_name
        AND c.column_name = 'organization_id'
    ) AS has_organization_id,
    EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = t.table_schema
        AND c.table_name = t.table_name
        AND c.column_name IN ('booking_id', 'booking_ref', 'customer_id', 'payment_intent_id')
    ) AS has_tenant_linkage_key,
    CASE
      WHEN t.table_type = 'VIEW' THEN coalesce(v.view_definition, '')
      ELSE ''
    END AS view_definition
  FROM information_schema.tables t
  LEFT JOIN information_schema.views v
    ON v.table_schema = t.table_schema
   AND v.table_name = t.table_name
  WHERE t.table_schema = 'public'
    AND t.table_type IN ('BASE TABLE', 'VIEW')
    AND (
      EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = t.table_schema
          AND c.table_name = t.table_name
          AND c.column_name = 'organization_id'
      )
      OR EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = t.table_schema
          AND c.table_name = t.table_name
          AND c.column_name IN ('booking_id', 'booking_ref', 'customer_id', 'payment_intent_id')
      )
      OR lower(t.table_name) LIKE '%reconcile%'
      OR lower(t.table_name) LIKE '%reconciliation%'
      OR lower(t.table_name) LIKE '%ledger%'
      OR lower(t.table_name) LIKE '%revenue%'
    )
),

classified AS (
  SELECT
    s.table_schema,
    s.surface_name,
    CASE WHEN s.table_type = 'VIEW' THEN 'view' ELSE 'table' END AS surface_type,
    CASE
      WHEN coalesce(a.expected_domain, '') <> '' THEN a.expected_domain
      WHEN s.table_type = 'VIEW' AND (
        lower(s.surface_name) LIKE '%effective%'
        OR lower(s.surface_name) LIKE '%report%'
        OR lower(s.view_definition) LIKE '%revenue%'
      ) THEN 'derived_reporting_surface'
      WHEN lower(s.surface_name) LIKE '%reconcile%' OR lower(s.surface_name) LIKE '%reconciliation%' THEN
        CASE WHEN s.table_type = 'VIEW' THEN 'reconciliation_view' ELSE 'reconciliation_table' END
      ELSE 'financial_table'
    END AS domain,
    s.has_organization_id,
    s.has_tenant_linkage_key,
    coalesce(a.audit_status, 'not_yet_audited') AS audit_status,
    coalesce(a.is_audited, false) AS is_audited,
    CASE
      WHEN NOT s.has_organization_id THEN 'unresolved ownership'
      WHEN coalesce(a.is_audited, false) THEN 'ready'
      ELSE 'owned-but-unaudited'
    END AS readiness_classification,
    CASE
      WHEN NOT s.has_organization_id THEN 'Add organization_id ownership scaffold before enforcement.'
      WHEN coalesce(a.audit_status, '') = 'wave_b_pending_audit' THEN 'Run 0181_wave_b_backfill_audit.sql and review results.'
      WHEN coalesce(a.audit_status, '') = 'derived_surface_pending_review' THEN 'Validate reporting view tenancy parity against source tables.'
      WHEN coalesce(a.audit_status, '') = 'not_yet_audited' THEN 'Scope and execute audit before enforcement.'
      ELSE 'No blocking ownership gaps identified in this inventory.'
    END AS action_note
  FROM sensitive_surfaces s
  LEFT JOIN target_audit_status a
    ON a.surface_name = s.surface_name
)

SELECT
  table_schema,
  surface_name,
  surface_type,
  domain,
  has_organization_id,
  has_tenant_linkage_key,
  audit_status,
  readiness_classification,
  action_note
FROM classified
ORDER BY
  CASE readiness_classification
    WHEN 'unresolved ownership' THEN 0
    WHEN 'owned-but-unaudited' THEN 1
    ELSE 2
  END,
  domain,
  surface_name;

WITH target_audit_status AS (
  SELECT *
  FROM (VALUES
    ('bookings', 'wave_a_audited', true,  'financial_table'),
    ('customers', 'wave_a_audited', true, 'financial_table'),
    ('revenue_records', 'wave_a_audited', true, 'financial_table'),
    ('renter_balance_ledger', 'wave_a_audited', true, 'financial_table'),
    ('payment_plans', 'wave_a_audited', true, 'financial_table'),
    ('payment_plan_installments', 'wave_a_audited', true, 'financial_table'),
    ('charges', 'wave_b_pending_audit', false, 'financial_table'),
    ('tickets', 'wave_b_pending_audit', false, 'financial_table'),
    ('booking_extensions', 'wave_b_pending_audit', false, 'financial_table'),
    ('customer_ledger', 'wave_b_pending_audit', false, 'financial_table'),
    ('revenue_records_effective', 'derived_surface_pending_review', false, 'derived_reporting_surface')
  ) AS t(surface_name, audit_status, is_audited, expected_domain)
),
classified AS (
  SELECT
    s.table_name AS surface_name,
    CASE
      WHEN NOT EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = s.table_schema
          AND c.table_name = s.table_name
          AND c.column_name = 'organization_id'
      ) THEN 'unresolved ownership'
      WHEN coalesce(a.is_audited, false) THEN 'ready'
      ELSE 'owned-but-unaudited'
    END AS readiness_classification
  FROM information_schema.tables s
  LEFT JOIN target_audit_status a
    ON a.surface_name = s.table_name
  WHERE s.table_schema = 'public'
    AND s.table_type IN ('BASE TABLE', 'VIEW')
    AND (
      EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = s.table_schema
          AND c.table_name = s.table_name
          AND c.column_name = 'organization_id'
      )
      OR EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = s.table_schema
          AND c.table_name = s.table_name
          AND c.column_name IN ('booking_id', 'booking_ref', 'customer_id', 'payment_intent_id')
      )
      OR lower(s.table_name) LIKE '%reconcile%'
      OR lower(s.table_name) LIKE '%reconciliation%'
      OR lower(s.table_name) LIKE '%ledger%'
      OR lower(s.table_name) LIKE '%revenue%'
    )
)
SELECT readiness_classification, COUNT(*) AS surface_count
FROM classified
GROUP BY readiness_classification
ORDER BY readiness_classification;

WITH target_audit_status AS (
  SELECT *
  FROM (VALUES
    ('bookings', 'wave_a_audited', true,  'financial_table'),
    ('customers', 'wave_a_audited', true, 'financial_table'),
    ('revenue_records', 'wave_a_audited', true, 'financial_table'),
    ('renter_balance_ledger', 'wave_a_audited', true, 'financial_table'),
    ('payment_plans', 'wave_a_audited', true, 'financial_table'),
    ('payment_plan_installments', 'wave_a_audited', true, 'financial_table'),
    ('charges', 'wave_b_pending_audit', false, 'financial_table'),
    ('tickets', 'wave_b_pending_audit', false, 'financial_table'),
    ('booking_extensions', 'wave_b_pending_audit', false, 'financial_table'),
    ('customer_ledger', 'wave_b_pending_audit', false, 'financial_table'),
    ('revenue_records_effective', 'derived_surface_pending_review', false, 'derived_reporting_surface')
  ) AS t(surface_name, audit_status, is_audited, expected_domain)
)
SELECT
  s.table_name AS surface_name,
  CASE WHEN s.table_type = 'VIEW' THEN 'view' ELSE 'table' END AS surface_type,
  CASE
    WHEN lower(s.table_name) LIKE '%reconcile%' OR lower(s.table_name) LIKE '%reconciliation%'
      THEN CASE WHEN s.table_type = 'VIEW' THEN 'reconciliation_view' ELSE 'reconciliation_table' END
    WHEN s.table_type = 'VIEW' THEN 'derived_reporting_surface'
    ELSE 'financial_table'
  END AS domain,
  'missing organization_id ownership on Wave A/B enforcement surface' AS unresolved_reason
FROM information_schema.tables s
LEFT JOIN target_audit_status a
  ON a.surface_name = s.table_name
WHERE s.table_schema = 'public'
  AND s.table_type IN ('BASE TABLE', 'VIEW')
  AND a.surface_name IS NOT NULL
  AND a.expected_domain = 'financial_table'
  AND (
    EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = s.table_schema
        AND c.table_name = s.table_name
        AND c.column_name IN ('booking_id', 'booking_ref', 'customer_id', 'payment_intent_id')
    )
    OR lower(s.table_name) LIKE '%reconcile%'
    OR lower(s.table_name) LIKE '%reconciliation%'
    OR lower(s.table_name) LIKE '%ledger%'
    OR lower(s.table_name) LIKE '%revenue%'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = s.table_schema
      AND c.table_name = s.table_name
      AND c.column_name = 'organization_id'
  )
ORDER BY domain, surface_name;


-- ===========================================================================
-- 0183_rls_enforcement_readiness_plan.sql
-- ===========================================================================
-- supabase/migrations/0183_rls_enforcement_readiness_plan.sql
-- RLS / enforcement rollout plan (planning-only, no enforcement activation).
--
-- PURPOSE:
--   Produces a structured readiness checklist and rollout sequence without
--   changing any policy, grant, trigger, or table behavior.
--
-- SAFETY:
--   Read-only plan output only.

SELECT *
FROM (
  VALUES
    (1, 'validation_clean', 'Run 0178_staging_validation.sql with no exceptions.', 'PENDING', 'Block enforcement if any 0178 check fails.'),
    (2, 'wave_a_audit_clean', 'Run 0179_backfill_audit.sql and resolve all INVESTIGATE/ACTION REQUIRED results.', 'PENDING', 'Fallback/parity anomalies must be closed first.'),
    (3, 'wave_b_deployed', 'Apply 0180_financial_tenant_wave_b.sql successfully in target environment.', 'PENDING', 'Do not proceed if migration apply is partial.'),
    (4, 'wave_b_audit_clean', 'Run 0181_wave_b_backfill_audit.sql and close mismatch/null-org findings.', 'PENDING', 'No unresolved parity drift before enforcement.'),
    (5, 'ownership_gaps_closed', 'Run 0182_tenant_ownership_inventory.sql; Result Set 3 must be empty for Wave A/B enforcement surfaces.', 'PENDING', 'No unresolved ownership gaps remain on Wave A/B enforcement tables.'),
    (6, 'runtime_observability_active', 'Confirm runtime events are emitting for auth_mismatch, parity_drift, tenant_isolation_gap, financial_consistency_alert.', 'PENDING', 'Instrumentation must be active in production paths.'),
    (7, 'rollback_plan_ready', 'Document rollback SQL and feature-flag rollback actions for each enforcement step.', 'PENDING', 'Rollback must be validated before policy activation.'),
    (8, 'enforcement_dry_run', 'Execute read-only dry-run checks in staging and compare with expected tenant partitions.', 'PENDING', 'No cross-tenant leakage in dry-run results.'),
    (9, 'phased_enforcement_activation', 'Activate RLS/policy enforcement in phases (read paths, then write paths) with live monitoring.', 'BLOCKED', 'Remain blocked until gates 1-8 are complete.')
) AS rollout(step_order, gate_key, required_evidence, status, notes)
ORDER BY step_order;

SELECT *
FROM (
  VALUES
    ('phase_1', 'Enable read-path RLS policies for lowest-risk reporting surfaces first.'),
    ('phase_2', 'Enable write-path enforcement for Wave A financial tables after clean read metrics.'),
    ('phase_3', 'Enable write-path enforcement for Wave B tables after clean Wave B audits.'),
    ('phase_4', 'Promote tenant isolation checks from warn-only to hard-fail for admin/operator runtime paths.'),
    ('phase_5', 'Retire compatibility fallback paths only after sustained zero-alert window.')
) AS phases(phase, plan_item)
ORDER BY phase;

SELECT *
FROM (
  VALUES
    ('rollback_trigger', 'Any spike in tenant_isolation_gap, parity_drift, or financial_consistency_alert after activation.'),
    ('rollback_action_1', 'Disable new enforcement flag / policy set for affected phase.'),
    ('rollback_action_2', 'Re-run 0179 + 0181 audits to isolate drift source.'),
    ('rollback_action_3', 'Restore compatibility query path where applicable and continue observability capture.'),
    ('rollback_action_4', 'Publish incident summary and remediation checklist before next activation attempt.')
) AS rollback_plan(item, description)
ORDER BY item;

