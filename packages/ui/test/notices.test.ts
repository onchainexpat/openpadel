// What both apps say at the top (Notices.tsx) and in place of a button that can't work now (NewOnly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { noticesShown, whyNothingNew } from "../src/notices.ts";

test("while read-only or moved, a button that starts something new says why instead; moved says so first", () => {
  assert.equal(whyNothingNew({ read_only: false, moved: false }), null);
  assert.equal(whyNothingNew(undefined), null, "before the club has loaded, the buttons show as usual");
  assert.equal(whyNothingNew({ read_only: true }), "read_only");
  assert.equal(whyNothingNew({ moved: true }), "moved");
  assert.equal(whyNothingNew({ read_only: true, moved: true }), "moved");
});

test("on a phone only the first notice shows, with how many more, until they're opened; a wide screen shows them all", () => {
  const items = ["read-only", null, "leaving", false, "support"];
  assert.deepEqual(noticesShown(items, false, true), { shown: ["read-only"], more: 2 });
  assert.deepEqual(noticesShown(items, true, true), { shown: ["read-only", "leaving", "support"], more: 0 });
  assert.deepEqual(noticesShown(items, false, false), { shown: ["read-only", "leaving", "support"], more: 0 });
  assert.deepEqual(noticesShown([null, "waiver"], false, true), { shown: ["waiver"], more: 0 }, "one notice: nothing to open");
  assert.deepEqual(noticesShown([null, false, ""], false, true), { shown: [], more: 0 });
});
