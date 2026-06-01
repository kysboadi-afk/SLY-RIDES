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
