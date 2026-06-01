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
