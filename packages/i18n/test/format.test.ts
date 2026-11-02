import { test } from "node:test";
import assert from "node:assert/strict";
import { format, type Catalog } from "../src/format.ts";

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
