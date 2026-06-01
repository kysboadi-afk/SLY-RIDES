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
