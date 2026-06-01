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
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  text  REFERENCES vehicles(vehicle_id) ON DELETE CASCADE,
  start_date  date  NOT NULL,
  end_date    date  NOT NULL,
  reason      text  NOT NULL DEFAULT 'manual'
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
