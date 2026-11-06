// The members' app answers every address it's given: /tournaments (what people type) goes to the Competitions page,
// and an address it doesn't have goes home, never a blank page (phone check 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("tournaments and leagues go to Competitions; anything else unknown goes home", () => {
  const app = readFileSync(join(import.meta.dirname, "../src/App.tsx"), "utf8");
  assert.match(app, /<Route path="\/tournaments" component=\{ToCompetitions\} \/>/);
  assert.match(app, /<Route path="\/leagues" component=\{ToCompetitions\} \/>/);
  assert.match(app, /<Route default component=\{ToHome\} \/>/);
  assert.match(app, /const ToCompetitions = \(\) => <Go to="\/competitions" \/>/);
  assert.match(app, /<Route path="\/competitions" component=\{Competitions\} \/>/);
});
