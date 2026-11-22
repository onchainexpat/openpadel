// The second-step screen (TwoFactor.tsx, gate "verify"): a passkey that doesn't answer there (it's saved on another
// phone or computer) says what to do from that screen, which has no emailed code to offer: an emailed code isn't a
// second step. passkey_not_saved, which offers one, stays for adding a passkey (passkeys.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { en } from "../../i18n/src/en.ts";
import { es } from "../../i18n/src/es.ts";

const read = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");

test("signing in with a passkey on the second step says to use the device that has it, or have the second step started over", () => {
  const src = read("packages/ui/src/TwoFactor.tsx");
  const verify = src.slice(src.indexOf("export function TwoFactor()"), src.indexOf("export function StepUp"));
  assert.match(verify, /startAuthentication\(\{ optionsJSON: o\.options \}\)\.catch\(\(e\) => \{ throw passkeyFailure\(e\) \? new Error\(t\("ui\.two_step_passkey_failed"\)\) : e; \}\)/);
  for (const words of [en["ui.two_step_passkey_failed"], es["ui.two_step_passkey_failed"] as string]) {
    assert.match(words, /openpadel reset-sign-in/);
    assert.doesNotMatch(words, /code|código/, "no code is offered on this screen");
    assert.doesNotMatch(words, /—/);
  }
  assert.match(en["ui.two_step_passkey_failed"], /phone or computer where it's saved/);
  assert.match(en["ui.two_step_passkey_failed"], /an owner can start your second step over/);
  // Adding a passkey keeps its own words.
  assert.match(read("packages/ui/src/passkeys.ts"), /t\("ui\.passkey_not_saved"\)/);
});
