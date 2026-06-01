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
