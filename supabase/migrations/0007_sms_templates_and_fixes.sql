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
