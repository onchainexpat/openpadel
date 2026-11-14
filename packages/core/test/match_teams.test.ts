// The teams of a court's four: the fairest, and as joined; two people who came together (a place saved for a friend,
// a player added by someone who brought no one else) are never split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchTeams, pairsOf } from "../src/results.ts";

const p = (person_id: string, level: number, brought_by: string | null = null) => ({ person_id, display_name: person_id, mu: level, sigma: 1, level: String(level), brought_by });
const ids = (x: { person_id: string }[]) => x.map((y) => y.person_id);

test("the fair teams balance the levels; as joined is the first to join with the next", () => {
  const t = matchTeams([p("A", 4), p("B", 4), p("C", 2), p("D", 2)]);
  assert.deepEqual([ids(t.fair.a), ids(t.fair.b)], [["A", "C"], ["B", "D"]]);
  assert.deepEqual([ids(t.joined.a), ids(t.joined.b)], [["A", "B"], ["C", "D"]]);
  assert.ok(Math.abs(t.fair.p - 0.5) < Math.abs(t.joined.p - 0.5));
  assert.equal(t.together, false);
});

test("two who came together stay together, even when it isn't the fairest", () => {
  // B came with C (a place C saved for B): they play together, fair or as joined.
  const t = matchTeams([p("A", 4), p("B", 4, "C"), p("C", 2), p("D", 2)]);
  assert.deepEqual(ids(t.fair.a).concat(ids(t.fair.b)).join(), "A,D,B,C");
  assert.deepEqual([ids(t.joined.a), ids(t.joined.b)], [["A", "D"], ["B", "C"]]);
  assert.equal(t.together, true);
});

test("someone who brought in everyone (a court paid in full, its players named) came with nobody in particular", () => {
  assert.deepEqual(pairsOf([p("A", 3), p("B", 3, "A"), p("C", 3, "A"), p("D", 3, "A")]), []);
  assert.deepEqual(pairsOf([p("A", 3), p("B", 3, "A"), p("C", 3), p("D", 3, "C")]), [["A", "B"], ["C", "D"]]);
  // Someone brought by a person not among the four (they left): nobody to keep them with.
  assert.deepEqual(pairsOf([p("A", 3), p("B", 3, "X"), p("C", 3), p("D", 3)]), []);
});
