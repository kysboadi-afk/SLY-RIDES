import { test } from "node:test";
import assert from "node:assert/strict";
import { getRentalState } from "./_rental-state.js";

function makeSb({ rangeEndDate = null, booking = null } = {}) {
  return {
    from(table) {
      if (table === "vehicle_blocking_ranges") {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() {
            return Promise.resolve({
              data: rangeEndDate ? [{ end_date: rangeEndDate }] : [],
              error: null,
            });
          },
        };
      }
      if (table === "bookings") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({
              data: booking,
              error: null,
            });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

test("getRentalState uses later bookings.return_date when range is stale earlier", async () => {
  const sb = makeSb({
    rangeEndDate: "2026-07-10",
    booking: {
      return_date: "2026-07-12",
      return_time: "10:00:00",
      pickup_time: "09:00:00",
      status: "active_rental",
    },
  });

  const result = await getRentalState(sb, "bk-1");
  assert.equal(result.endDate, "2026-07-12");
});

test("getRentalState keeps later range date when booking row is older", async () => {
  const sb = makeSb({
    rangeEndDate: "2026-07-14",
    booking: {
      return_date: "2026-07-12",
      return_time: "10:00:00",
      pickup_time: "09:00:00",
      status: "active_rental",
    },
  });

  const result = await getRentalState(sb, "bk-2");
  assert.equal(result.endDate, "2026-07-14");
});
