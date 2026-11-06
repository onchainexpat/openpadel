// What the sixth phone check found in the members' app. The gift card sheet read "Pay $50.00 for Gift cards"; a card
// whose bank declined stayed "Waiting for payment" with nothing to tap; and in a club in Spain the card form started
// on the US, asking for a US postal code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cardFormOptions } from "../src/pay_mode.ts";
import { en } from "../../../packages/i18n/src/en.ts";
import { es } from "../../../packages/i18n/src/es.ts";

const src = (f: string) => readFileSync(join(import.meta.dirname, "../src", f), "utf8");
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? `{${k}}`);

test("the card form starts on the club's country, for a payment and for saving a card alike", () => {
  assert.deepEqual(cardFormOptions("ES"), { layout: "tabs", defaultValues: { billingDetails: { address: { country: "ES" } } } });
  assert.deepEqual(cardFormOptions("US"), { layout: "tabs", defaultValues: { billingDetails: { address: { country: "US" } } } });
  // Nothing known (an older server): Stripe's own guess, as before. Never a malformed country.
  assert.deepEqual(cardFormOptions(undefined), { layout: "tabs" });
  assert.deepEqual(cardFormOptions("es"), { layout: "tabs" });
  // One card form in the app, used for payments and saved cards: it takes the options.
  const pay = src("Pay.tsx");
  assert.equal(pay.match(/elements\.create\(/g)?.length, 1);
  assert.match(pay, /elements\.create\("payment", cardFormOptions\(club\.value\?\.country\)\)/);
});

test("the gift card sheet is named for the card, not the page", () => {
  const page = src("GiftCards.tsx");
  assert.doesNotMatch(page, /<PaySheet[^>]*name=\{t\("ui\.gift_cards_title"\)\}/);
  assert.match(page, /name=\{paying\.forName \? t\("ui\.gift_card_pay_for", \{ name: paying\.forName \}\) : t\("ui\.gift_card_pay"\)\}/);
  assert.equal(fill(en["ui.pay_title"], { amount: "$50.00", name: fill(en["ui.gift_card_pay_for"], { name: "Maya" }) }), "Pay $50.00 for a gift card for Maya");
  assert.equal(fill(en["ui.pay_title"], { amount: "$50.00", name: en["ui.gift_card_pay"] }), "Pay $50.00 for a gift card");
  assert.equal(fill(es["ui.pay_title"] as string, { amount: "50,00 €", name: fill(es["ui.gift_card_pay_for"] as string, { name: "Maya" }) }), "Pagar 50,00 € por una tarjeta regalo para Maya");
  // A pass's sheet already names the pass (its product's name).
  assert.match(src("Passes.tsx"), /name=\{paying\.name\}/);
});

test("a card waiting for its payment offers Pay and Remove, unless its payment is being confirmed", () => {
  const page = src("GiftCards.tsx");
  assert.match(page, /x\.status === "pending" && x\.pending_payment_id && !isConfirming\(x\.pending_payment_id\)/);
  assert.match(page, /setPaying\(\{ id: x\.pending_payment_id!, cents: x\.amount_cents, forName: x\.for_name \}\)/);
  assert.match(page, /preview\("gift_card\.drop", \{ gift_card_id: x\.id \}\)/);
});
