// Staff entering a match's score can make it final, as fixture.score allows: after a dispute, the players don't get
// another 24 hours to dispute the club's word (phone check 5 found no way to say so).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the staff score entry sends final when it's ticked", () => {
  const page = readFileSync(join(import.meta.dirname, "../src/Competition.tsx"), "utf8");
  assert.match(page, /preview\("fixture\.score", \{ fixture_id: f\.id, sets: parse\(sets\[f\.id\] \?\? ""\), final: final\[f\.id\] \?\? false \}\)/);
  assert.match(page, /t\("ui\.score_final"\)/);
});
