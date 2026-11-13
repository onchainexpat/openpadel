// The welcome for members who moved in from Playtomic (Welcome.tsx): the yes to texts is never ticked for them, and
// nothing is asked of the server (so no consent is recorded) unless they tick it themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { offerTexts, textsConsent, type TextsState } from "../src/welcome_texts.ts";

const s: TextsState = { on: true, phone: "(415) 555-0100", waiting_code_for: null, answer: null, kid: null, form: { version: "2026-10", words: "Yes, the club may text me." } };

test("texts: no consent unless ticked, and only with a confirmed number and the form's version", () => {
  assert.equal(textsConsent(false, s, "p1", "ua"), null);
  assert.equal(textsConsent(true, { ...s, phone: null }, "p1", "ua"), null);
  assert.equal(textsConsent(true, { ...s, on: false }, "p1", "ua"), null);
  assert.deepEqual(textsConsent(true, s, "p1", "ua"), { person_id: "p1", granted: true, form_version: "2026-10", app: "member", device: "ua" });
});

test("texts are offered only when the club sends them, to someone who hasn't said yes, and a kid only when allowed", () => {
  assert.equal(offerTexts(s), true);
  assert.equal(offerTexts({ ...s, answer: true }), false);
  assert.equal(offerTexts({ ...s, on: false }), false);
  assert.equal(offerTexts({ ...s, kid: { allowed: false } }), false);
  assert.equal(offerTexts(null), false);
});

test("the box starts unticked and its words are the club's consent wording", () => {
  const w = readFileSync(join(import.meta.dirname, "../src/Welcome.tsx"), "utf8");
  assert.match(w, /const \[yes, setYes\] = useState\(false\)/);
  assert.match(w, /<input type="checkbox" checked=\{yes\}/);
  assert.match(w, /\{texts\.form\.words\}/);
  assert.match(w, /preview\("consent\.texts", consent\)/);
});
