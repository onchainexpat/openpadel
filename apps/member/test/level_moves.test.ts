// My level's "Why it moved" rows say how much each change moved the level, and mark a floor the club set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { moveOf } from "../src/level_moves.ts";

test("a game up or down shows the change to two places, with a real minus sign", () => {
  assert.deepEqual(moveOf({ kind: "game", level_before: "3.20", level_after: "3.24" }), { kind: "up", text: "+0.04" });
  assert.deepEqual(moveOf({ kind: "game", level_before: "3.24", level_after: "3.22" }), { kind: "down", text: "−0.02" });
});

test("a floor is marked as one; a first level or no change shows nothing", () => {
  assert.deepEqual(moveOf({ kind: "floor", level_before: "2.90", level_after: "3.00" }), { kind: "floor" });
  assert.equal(moveOf({ kind: "staff_set", level_before: null, level_after: "3.50" }), null);
  assert.equal(moveOf({ kind: "game", level_before: "3.50", level_after: "3.50" }), null);
});
