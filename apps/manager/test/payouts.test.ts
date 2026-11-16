// The Money page's payouts (payouts.ts): each day read as that day wherever the reader is, and the next one the soonest
// still on its way or scheduled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPayout, payoutDay, type PayoutRow } from "../src/payouts.ts";

const row = (id: string, status: PayoutRow["status"], arrives_on: string): PayoutRow => ({ id, amount_cents: 100, currency: "USD", status, arrives_on, created_at: `${arrives_on}T00:00:00Z` });

test("a payout's day is that day, in English and Spanish", () => {
  assert.equal(payoutDay("2026-10-28", "en-US"), "Wed, Oct 28");
  assert.match(payoutDay("2026-10-28", "es-US"), /28/);
  assert.match(payoutDay("2026-10-28", "es-US"), /oct/i);
});

test("the next payout: the soonest on its way or scheduled, none when all have arrived", () => {
  assert.equal(nextPayout([row("a", "paid", "2026-10-27"), row("b", "pending", "2026-10-30"), row("c", "in_transit", "2026-10-28")])?.id, "c");
  assert.equal(nextPayout([row("a", "paid", "2026-10-27"), row("d", "failed", "2026-10-29")]), null);
});
