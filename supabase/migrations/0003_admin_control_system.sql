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
