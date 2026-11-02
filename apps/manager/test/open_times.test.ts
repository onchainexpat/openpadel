import { test } from "node:test";
import assert from "node:assert/strict";
import { courtSlots, lengthsFitting, spanOfCourts } from "../src/open_times.ts";

const at = (hhmm: string) => `2026-11-10T${hhmm}:00.000Z`;

test("a court's half hours run from its own opening to its closing, and a closed court has none", () => {
  assert.deepEqual(courtSlots({ opens: at("16:00"), closes: at("18:00") }), [at("16:00"), at("16:30"), at("17:00"), at("17:30"), at("18:00")]);
  assert.deepEqual(courtSlots(null), []);
});

test("courts chosen together: the earliest opening to the latest closing, ignoring a closed one", () => {
  const outdoor = { open: { opens: at("15:00"), closes: at("18:00") } }, indoor = { open: { opens: at("14:00"), closes: at("22:00") } }, shut = { open: null };
  assert.deepEqual(spanOfCourts([outdoor, shut, indoor]), { opens: at("14:00"), closes: at("22:00") });
  assert.deepEqual(spanOfCourts([outdoor]), outdoor.open);
  assert.equal(spanOfCourts([shut]), null);
});

test("the desk's lengths are only the ones that end by closing time", () => {
  assert.deepEqual(lengthsFitting(at("16:30"), at("18:00")), [60, 90, 30]);
  assert.deepEqual(lengthsFitting(at("17:30"), at("18:00")), [30]);
  assert.deepEqual(lengthsFitting(at("18:00"), at("18:00")), []);
  assert.deepEqual(lengthsFitting("", at("18:00")), []);
});
