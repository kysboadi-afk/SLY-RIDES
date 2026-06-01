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
