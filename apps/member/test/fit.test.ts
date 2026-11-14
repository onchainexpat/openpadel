// The fit tags on Play and Learn (fit.ts): from the member's level and the band, and nothing when either is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitOf } from "../src/fit.ts";

test("a great fit in the middle of the band, a good fit at its edges, a step up below, below your level above", () => {
  assert.equal(fitOf(3.25, "3.00", "3.50"), "great");
  assert.equal(fitOf(3.05, "3.00", "3.50"), "good");
  assert.equal(fitOf(3.5, "3.00", "3.50"), "good");
  assert.equal(fitOf(2.9, "3.00", "3.50"), "step_up");
  assert.equal(fitOf(3.6, "3.00", "3.50"), "below");
  // A narrow band: anywhere in it fits well.
  assert.equal(fitOf(3.0, 3, 3.25), "great");
});

test("no level yet, or a class open to every level: no tag, never a guess", () => {
  assert.equal(fitOf(null, "3.00", "3.50"), null);
  assert.equal(fitOf(undefined, "3.00", "3.50"), null);
  assert.equal(fitOf(3.2, null, null), null);
  assert.equal(fitOf(3.2, "4", "3"), null);
});
