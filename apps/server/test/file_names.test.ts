import { test } from "node:test";
import assert from "node:assert/strict";
import { fileStem } from "../src/file_names.ts";

test("downloads are named for the club, in plain letters, never for the software", () => {
  assert.equal(fileStem("Kestrel Padel"), "kestrel-padel");
  assert.equal(fileStem("Pádel Club Ñandú"), "padel-club-nandu");
  assert.equal(fileStem("  The Court & Co.  "), "the-court-co");
  assert.equal(fileStem(""), "club");
  assert.equal(fileStem(null), "club");
  assert.equal(fileStem("A".repeat(60)).length, 40);
  assert.ok(!fileStem("x".repeat(39) + " y").endsWith("-"));
});
