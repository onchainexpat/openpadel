import { test } from "node:test";
import assert from "node:assert/strict";
import { allIn, bookingsIn, checkInInput } from "../src/check_in.ts";

test("Now and next: a booking is in once all its places are; the count is of bookings with places; the button checks in or takes back", () => {
  const rows = [{ kind: "booking", id: "a", places: 4, checked_in: 4 }, { kind: "booking", id: "b", places: 2, checked_in: 1 }, { kind: "booking", id: "c", places: 0 },
    { kind: "session", id: "s" }];
  assert.deepEqual(rows.map(allIn), [true, false, false, false]);
  assert.deepEqual(bookingsIn(rows), { count: 1, total: 2 });
  assert.deepEqual(checkInInput(rows[0]!), { booking_id: "a", checked_in: false });
  assert.deepEqual(checkInInput(rows[1]!), { booking_id: "b" });
});
