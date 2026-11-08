import { test } from "node:test";
import assert from "node:assert/strict";
import { AMOUNT_PATTERN, format, parseDollars, type Catalog } from "../src/format.ts";

const cat = { a: "Reviewed by {by}: {reason}.", b: "Loading {what}...", c: "At {time}.", d: "Note: {note}. Thanks" } as unknown as Catalog;
const f = (key: string, params: Record<string, string>) => format(cat, "en", key as any, params);

test("a value that ends its own sentence takes the place of the full stop after it", () => {
  assert.equal(f("a", { by: "Robin", reason: "Fine for now." }), "Reviewed by Robin: Fine for now.");
  assert.equal(f("a", { by: "Robin", reason: "Fine for now" }), "Reviewed by Robin: Fine for now.");
  assert.equal(f("a", { by: "Robin", reason: "Really?" }), "Reviewed by Robin: Really?");
  assert.equal(f("a", { by: "Robin", reason: "Great! " }), "Reviewed by Robin: Great!");
  assert.equal(f("d", { note: "Bring water." }), "Note: Bring water. Thanks");
  assert.equal(f("b", { what: "courts" }), "Loading courts...");   // an ellipsis in the wording stays
  assert.equal(format({ c: "A las {time}." } as unknown as Catalog, "es", "c" as any, { time: "9:00 a. m." }), "A las 9:00 a. m.");
});

test("quoted, a value that ends its own sentence ends inside the quotes, with no stop after them", () => {
  const q = { q: "Answer {person}: \"{body}\". They hear straight away.", n: "Tag {person} \"{tag}\"." } as unknown as Catalog;
  const g = (key: string, params: Record<string, string>) => format(q, "en", key as any, params);
  assert.equal(g("q", { person: "Ann Lee", body: "Yes, there is free parking behind the club." }), "Answer Ann Lee: \"Yes, there is free parking behind the club.\" They hear straight away.");
  assert.equal(g("q", { person: "Ann Lee", body: "Is it the back gate?" }), "Answer Ann Lee: \"Is it the back gate?\" They hear straight away.");
  assert.equal(g("q", { person: "Ann Lee", body: "Behind the club" }), "Answer Ann Lee: \"Behind the club\". They hear straight away.");
  assert.equal(g("n", { person: "Ann", tag: "Beginners" }), "Tag Ann \"Beginners\".");
  // A value with no quote after it, or a quote with no stop after it, is as it was.
  assert.equal(format({ x: "{a}\" and {b}" } as unknown as Catalog, "en", "x" as any, { a: "One.", b: "two" }), "One.\" and two");
});

test("an amount the staff type reads the US way, and one that could mean two things is refused, not guessed", () => {
  for (const [typed, cents] of [["1,200", 120000], ["1,200.50", 120050], ["12.5", 1250], ["$40", 4000], [" 40 ", 4000], ["0.05", 5], ["12,345,678", 1234567800]] as const)
    assert.equal(parseDollars(typed), cents, typed);
  for (const typed of ["12,5", "1.200", "1,20", "1,2000", "12.", ".5", "", "abc", "-5", "1 200"]) assert.equal(parseDollars(typed), null, typed);
  // The same rule for an input's pattern, which browsers read with the v flag.
  const input = new RegExp(`^(?:${AMOUNT_PATTERN})$`, "v");
  assert.equal(input.test("1,200.50"), true);
  assert.equal(input.test("12,5"), false);
});
