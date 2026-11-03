import { test } from "node:test";
import assert from "node:assert/strict";
import { StripeProvider } from "../src/stripe.ts";
import { fakeStripe } from "./fake-stripe.ts";

// A renewal or a booking's deadline charge asked for again after the database was put back to before it (a backup,
// a minute in the archive, an export on another server): Stripe's idempotency only lasts a day, so Kumi asks first.
test("a saved card is charged once for one charge, even asked again after Stripe has forgotten the key", async () => {
  const f = fakeStripe(), p = new StripeProvider({ secretKey: "sk_test_once", fetch: f.fetch });
  const charge = { customer: "cus_1", paymentMethod: "pm_1", amountCents: 8900, currency: "USD", description: "Founding membership", idempotencyKey: "renew:m1:2026-12-01T08:00:00.000Z:0" };
  const first = await p.chargeSaved(charge);
  assert.equal(first.status, "succeeded");
  for (const it of f.intents.values()) it.key = "forgotten by Stripe";   // more than a day later
  const again = await p.chargeSaved(charge);
  assert.equal(again.ref, first.ref);
  assert.equal(f.intents.size, 1, "no second charge");
  // The next attempt (a new key) is a new charge; so is another person's with the same Kumi id.
  assert.notEqual((await p.chargeSaved({ ...charge, idempotencyKey: "renew:m1:2026-12-01T08:00:00.000Z:1" })).ref, first.ref);
  assert.notEqual((await p.chargeSaved({ ...charge, customer: "cus_2" })).ref, first.ref);
  assert.equal(f.intents.size, 3);
});
