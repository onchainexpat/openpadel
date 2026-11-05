// The club's clock both ways (club_clock.ts): a staff phone set to another zone types the club's times.
import { test } from "node:test";
import assert from "node:assert/strict";
import { momentToWall, wallToMoment } from "../src/club_clock.ts";

const LA = "America/Los_Angeles";
test("a typed time is the club's clock, whatever zone the device is set to", () => {
  assert.equal(wallToMoment("2026-11-06T17:00", LA), "2026-11-07T01:00:00.000Z");   // 5 PM Pacific (PST)
  assert.equal(wallToMoment("2026-07-06T18:00", LA), "2026-07-07T01:00:00.000Z");   // 6 PM Pacific (PDT)
  assert.equal(wallToMoment("2026-11-06T17:00", "Europe/Madrid"), "2026-11-06T16:00:00.000Z");
  assert.equal(wallToMoment("2026-11-06T17:00", "UTC"), "2026-11-06T17:00:00.000Z");
  assert.equal(wallToMoment("", LA), "");
  assert.equal(wallToMoment("not a time", LA), "");
});
test("and back: a moment as the club's date and time box shows it", () => {
  assert.equal(momentToWall("2026-11-07T01:00:00Z", LA), "2026-11-06T17:00");
  assert.equal(momentToWall("2026-07-07T01:00:00Z", LA), "2026-07-06T18:00");
  for (const local of ["2026-01-15T09:30", "2026-03-07T23:59", "2026-11-01T00:30", "2026-12-31T23:00"])
    assert.equal(momentToWall(wallToMoment(local, LA), LA), local);
});
test("the days the clocks change", () => {
  // 8 Mar 2026, 2:00 to 3:00 doesn't exist in Los Angeles: 2:30 comes out as 3:30 PDT.
  assert.equal(wallToMoment("2026-03-08T02:30", LA), "2026-03-08T10:30:00.000Z");
  assert.equal(momentToWall("2026-03-08T10:30:00Z", LA), "2026-03-08T03:30");
  // 1 Nov 2026, 1:00 to 2:00 happens twice: 1:30 is the first (PDT, 08:30Z).
  assert.equal(wallToMoment("2026-11-01T01:30", LA), "2026-11-01T08:30:00.000Z");
  // Either side of the changes, nothing moves.
  assert.equal(wallToMoment("2026-03-08T01:30", LA), "2026-03-08T09:30:00.000Z");
  assert.equal(wallToMoment("2026-03-08T03:30", LA), "2026-03-08T10:30:00.000Z");
  assert.equal(wallToMoment("2026-11-01T02:30", LA), "2026-11-01T10:30:00.000Z");
});
