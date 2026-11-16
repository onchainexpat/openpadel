// Book's window for a court alert, and Play's category filter (alert_bits.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { genderChoices, genderShown, windowTimes } from "../src/alert_bits.ts";

test("a court alert's window: every half hour from opening to an hour before closing, in the club's time", () => {
  const tz = "America/Los_Angeles";
  const w = windowTimes({ opens: "2026-12-02T15:00:00.000Z", closes: "2026-12-02T19:00:00.000Z" }, tz);   // 7 am to 11 am there
  assert.deepEqual(w, ["07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00"]);
  assert.deepEqual(windowTimes(null, tz), []);
});

test("the category filter: nothing chosen shows all; a category shows those marked with it; choices only from the list", () => {
  assert.equal(genderShown(null, ""), true);
  assert.equal(genderShown("women", ""), true);
  assert.equal(genderShown("women", "women"), true);
  assert.equal(genderShown(null, "women"), false);
  assert.equal(genderShown("mixed", "women"), false);
  assert.deepEqual(genderChoices([{ gender: "women" }, { gender: null }, { gender: "mixed" }, {}]), ["mixed", "women"]);
  assert.deepEqual(genderChoices([{ gender: null }]), []);
});
