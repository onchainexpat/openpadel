// The pay sheet (Pay.tsx): saving a card and paying by card only are different things. Phone check 5 found gift cards
// and passes (card only) opened as a save-a-card sheet: no bot-check proof, Stripe's confirmSetup on a payment, and
// the server refusing it. And after paying, a court still offered Pay for half a minute (confirming.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { payMode } from "../src/pay_mode.ts";
import { clearConfirming, CONFIRMING_MS, isConfirmingAt as isConfirming, markConfirmingAt as markConfirming } from "../src/confirming.ts";

const src = (f: string) => readFileSync(join(import.meta.dirname, "../src", f), "utf8");

test("card only is a payment without credit, passes or promo codes; only saving a card is a card setup", () => {
  assert.deepEqual(payMode({ cardOnly: true }), { saveCard: false, extras: false });
  assert.deepEqual(payMode({}), { saveCard: false, extras: true });
  assert.deepEqual(payMode({ cardFor: "m1" }), { saveCard: true, extras: false });
  assert.deepEqual(payMode({ familyCard: true }), { saveCard: true, extras: false });
  assert.deepEqual(payMode({ cardOnFile: true }), { saveCard: true, extras: false });
});

test("the sheet takes the bot check and confirms as a payment unless it's saving a card", () => {
  const pay = src("Pay.tsx");
  assert.match(pay, /saveCard \? await api<Opened>\(urls\.open, \{\}\) : await protectedPost<Opened>\(urls\.open, \{\}\)/);
  assert.match(pay, /saveCard \? await stripe\.current\.stripe\.confirmSetup\(confirm\) : await stripe\.current\.stripe\.confirmPayment\(confirm\)/);
  // Nothing else decides either: card only reaches the sheet as `cardOnly` and only drops the extras.
  assert.doesNotMatch(pay, /cardOnly\s*\|\||\|\|\s*cardOnly/);
  for (const page of ["GiftCards.tsx", "Passes.tsx"]) {
    const s = src(page);
    assert.match(s, /<PaySheet paymentId=\{paying\.id\} cardOnly /, page);
    assert.doesNotMatch(s, /cardFor|familyCard/, page);
  }
});

test("a payment the card form took reads as confirming for a few minutes, in this tab, until it's recorded", () => {
  const kept = new Map<string, string>();
  const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  const t0 = 1_800_000_000_000;
  assert.equal(isConfirming("p1", t0, store), false);
  markConfirming("p1", t0, store);
  assert.equal(isConfirming("p1", t0 + 1000, store), true);
  assert.equal(isConfirming("p2", t0 + 1000, store), false);
  assert.equal(isConfirming(null, t0, store), false);
  assert.equal(isConfirming("p1", t0 + CONFIRMING_MS + 1, store), false, "then it's worth paying again (the server answers paid if it went through)");
  markConfirming("p3", t0, store); clearConfirming("p3", store);
  assert.equal(isConfirming("p3", t0 + 1, store), false, "the bank said no: Pay comes back");
});

test("every Pay button for a waiting payment stands down while that payment is confirming", () => {
  for (const [file, uses] of [["MyPlaces.tsx", 2], ["Play.tsx", 1], ["Take.tsx", 1], ["Family.tsx", 1], ["Membership.tsx", 1], ["GiftCards.tsx", 1]] as const) {
    const s = src(file);
    assert.ok((s.match(/isConfirming\(/g) ?? []).length >= uses, `${file} checks isConfirming`);
    assert.match(s, /useConfirming\(/, `${file} asks again until it's recorded`);
  }
});

test("with prices that include tax, the sheet says how much of it is tax", () => {
  const pay = src("Pay.tsx");
  assert.match(pay, /if \(it\.tax_cents\) setTax\(/);
  assert.match(pay, /t\(tax\.rate \? "ui\.pay_tax_included_rate" : "ui\.pay_tax_included"/);
});
