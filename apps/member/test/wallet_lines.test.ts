// The Wallet's lines: each change to club credit has words (a kind the app doesn't know yet reads as a plain change,
// never a bare key), amounts are signed in or out, and the credit tile on Me opens the Wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en } from "../../../packages/i18n/src/en.ts";
import { es } from "../../../packages/i18n/src/es.ts";
import { brandName, creditKindKey, signedCents } from "../src/wallet_lines.ts";

test("every kind of change to club credit has words in English and Spanish", () => {
  for (const kind of ["payment", "credit_grant", "gift_card_redeemed", "pass_use_back", "brought_in", "credit_payout", "something_new", "toString"]) {
    const key = creditKindKey(kind);
    assert.ok(typeof en[key] === "string" && typeof es[key] === "string", `${kind}: ${key}`);
  }
  assert.equal(creditKindKey("something_new"), "ui.credit_kind_other");
  assert.equal(creditKindKey("toString"), "ui.credit_kind_other");
});

test("amounts read in (+) or out (a real minus), and card brands as people write them", () => {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  assert.equal(signedCents(2400, usd), "+$24.00");
  assert.equal(signedCents(-1200, usd), "−$12.00");
  assert.equal(brandName("amex"), "American Express");
  assert.equal(brandName("elo"), "Elo");
});

test("the Wallet has its address, and Me's credit tile opens it", () => {
  const app = readFileSync(join(import.meta.dirname, "../src/App.tsx"), "utf8"), me = readFileSync(join(import.meta.dirname, "../src/Me.tsx"), "utf8");
  assert.match(app, /<Route path="\/wallet" component=\{Wallet\} \/>/);
  assert.match(me, /<a class="tile" href="\/wallet">/);
  assert.doesNotMatch(me, /<a class="tile" href="\/receipts">/);
});
