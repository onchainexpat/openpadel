// The Competitions page lists a match played and waiting for its score apart from matches still ahead (next_matches.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitNext } from "../src/next_matches.ts";

test("a match whose time has come and has no score is listed as played, score to come, not as next", () => {
  const now = Date.parse("2026-11-06T20:00:00Z");
  const f = (id: string, at: string | null) => ({ id, starts_at: at });
  const r = splitNext([f("played", "2026-11-06T18:00:00Z"), f("later", "2026-11-07T18:00:00Z"), f("no time", null)], now);
  assert.deepEqual([r.toScore.map((x) => x.id), r.ahead.map((x) => x.id)], [["played"], ["later", "no time"]]);
});
