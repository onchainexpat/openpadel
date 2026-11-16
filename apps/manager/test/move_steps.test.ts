import { test } from "node:test";
import assert from "node:assert/strict";
import { around, stepMarks } from "../src/move_steps.ts";

test("the move-in's stepper: ticks before the club's step, its step now, the rest numbered; all ticked once finished", () => {
  assert.deepEqual(stepMarks("practice", false).map((x) => `${x.state}:${x.mark}`), ["done:✓", "done:✓", "now:3", "later:4", "later:5"]);
  assert.ok(stepMarks("wrap_up", true).every((x) => x.state === "done"));
});

test("going on from a step the club has passed only looks; from its own step it's a change to preview", () => {
  assert.deepEqual(around("review", "switch"), { back: "connect", next: "practice", nextMoves: false });
  assert.deepEqual(around("switch", "switch"), { back: "practice", next: "wrap_up", nextMoves: true });
  assert.deepEqual(around("wrap_up", "wrap_up"), { back: "switch", next: null, nextMoves: false });
  assert.deepEqual(around("connect", "connect"), { back: null, next: "review", nextMoves: true });
});
