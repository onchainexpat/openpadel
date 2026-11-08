import { test } from "node:test";
import assert from "node:assert/strict";
import { playtomicParts } from "../src/paid_line.ts";

test("paid in Playtomic with time added here: both what was paid there and what's still owed here", () => {
  assert.deepEqual(playtomicParts({ paid: 4000, pt: 4000, owed: 2000 }), [{ key: "ui.paid_in_playtomic", cents: 4000 }, { key: "ui.unpaid_amount", cents: 2000 }]);
  assert.deepEqual(playtomicParts({ paid: 4000, pt: 4000, owed: 0 }), [{ key: "ui.paid_in_playtomic", cents: 4000 }]);
  // Not paid there (or only part of what they paid was): the usual lines.
  assert.equal(playtomicParts({ paid: 0, pt: 0, owed: 4000 }), null);
  assert.equal(playtomicParts({ paid: 6000, pt: 4000, owed: 0 }), null);
});
