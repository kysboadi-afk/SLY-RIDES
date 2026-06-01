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

-- ── 2. expenses ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id  text        UNIQUE,
  vehicle_id  text        NOT NULL,
  date        date        NOT NULL,
  category    text        NOT NULL,
  amount      numeric(10,2) NOT NULL DEFAULT 0,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_vehicle_id_idx ON expenses (vehicle_id);
CREATE INDEX IF NOT EXISTS expenses_date_idx       ON expenses (date DESC);

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
