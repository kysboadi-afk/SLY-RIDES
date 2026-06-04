import { buildDateTimeLA, DEFAULT_RETURN_TIME } from "./_time.js";

/**
 * Derive the canonical rental state for a booking using vehicle_blocking_ranges
 * as the authoritative source for the final return date.
 *
 * vehicle_blocking_ranges decomposes each booking into base + extension segments
 * and is the single source of truth for the timeline (migration 0087).
 * The max end_date across all segments gives the true final return date,
 * automatically incorporating every paid extension without additional joins.
 *
 * return_time is still sourced from the bookings row (the view stores dates only).
 * pickup_time is used as a fallback, and DEFAULT_RETURN_TIME ("10:00") is the
 * final safety net so minutesToReturn is never calculated against midnight.
 *
 * Non-fatal: if the vehicle_blocking_ranges query fails (e.g. view not yet
 * deployed in a staging environment), the function falls back gracefully to
 * bookings.return_date so callers never receive a broken result.
 *
 * @param {object} sb          - Supabase admin client (from getSupabaseAdmin())
 * @param {string} bookingRef  - booking_ref value (e.g. "bk-...")
 * @returns {Promise<{
 *   endDate:         string,       // YYYY-MM-DD final return date
 *   returnTime:      string,       // HH:MM return time (always set, never null/empty)
 *   end_datetime:    Date,         // LA-timezone Date for the return moment
 *   minutesToReturn: number|null,  // positive = future, negative = overdue, null = unparseable date
 *   isActive:        boolean       // true when booking status is active, active_rental, or overdue
 * }>}
 */
export async function getRentalState(sb, bookingRef) {
  const empty = {
    endDate:         "",
    returnTime:      DEFAULT_RETURN_TIME,
    end_datetime:    new Date(NaN),
    minutesToReturn: null,
    isActive:        false,
  };

  if (!sb || !bookingRef) return empty;

  // Fire both queries in parallel: blocking-ranges view for the authoritative
  // end date, bookings table for time + status.  Settled promises mean a single
  // failed query never throws — the other result is still used.
  const [rangesRes, bookingRes] = await Promise.allSettled([
    sb
      .from("vehicle_blocking_ranges")
      .select("end_date")
      .eq("booking_ref", bookingRef)
      .order("end_date", { ascending: false })
      .limit(1),
    sb
      .from("bookings")
      .select("return_date, return_time, pickup_time, status")
      .eq("booking_ref", bookingRef)
      .maybeSingle(),
  ]);

  const bk =
    bookingRes.status === "fulfilled" && !bookingRes.value.error
      ? bookingRes.value.data
      : null;

  const rangeRow =
    rangesRes.status === "fulfilled" && !rangesRes.value.error
      ? rangesRes.value.data?.[0]
      : null;

  if (rangesRes.status === "fulfilled" && rangesRes.value.error) {
    console.warn(
      "getRentalState: vehicle_blocking_ranges query failed (using bookings.return_date fallback):",
      rangesRes.value.error.message,
      { bookingRef }
    );
  }

  const rangeEndDate = rangeRow?.end_date
    ? String(rangeRow.end_date).split("T")[0]
    : "";
  const bookingEndDate = bk?.return_date
    ? String(bk.return_date).split("T")[0]
    : "";

  // Use the furthest known end date so reminders never fire from a stale earlier
  // schedule when one source lags the other after date edits/extensions.
  const endDate = rangeEndDate && bookingEndDate
    ? (bookingEndDate > rangeEndDate ? bookingEndDate : rangeEndDate)
    : (rangeEndDate || bookingEndDate);

  // Return time: bookings.return_time → pickup_time → DEFAULT_RETURN_TIME.
  // Trim to HH:MM in case Postgres returns "HH:MM:SS".
  const returnTime = bk?.return_time
    ? String(bk.return_time).substring(0, 5)
    : bk?.pickup_time
    ? String(bk.pickup_time).substring(0, 5)
    : DEFAULT_RETURN_TIME;

  const end_datetime    = buildDateTimeLA(endDate, returnTime);
  const minutesToReturn = isNaN(end_datetime.getTime())
    ? null
    : (end_datetime - new Date()) / 60_000;

  const isActive = ["active", "active_rental", "overdue"].includes(bk?.status);

  return { endDate, returnTime, end_datetime, minutesToReturn, isActive };
}
