// Whose a provider account is (payments_after_restore.ts clubsAccount): without Connect, a payment on any account is
// another club's (direct charges carry none), so it's never kept as found here; under Connect, only the club's own
// connected account, or one its own payments were made on.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { fakeStripe } from "./fake-stripe.ts";
import { clubsAccount, clubStripeAccount, noteFound, runAsSystem, setPaymentProvider, StripeProvider, TestProvider, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>;
const found = (ref: string) => ({ ref, amountCents: 2500, created: new Date(), email: "x@example.test", description: null, kumiChargeId: null, currency: "USD" });
before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
});
after(async () => drop());

test("direct keys: no account is the club's; any account is someone else's, and isn't kept", async () => {
  setPaymentProvider(new TestProvider());
  assert.equal(await clubsAccount(db, null), true);
  assert.equal(await clubsAccount(db, "acct_SOMEONE"), false);
  assert.equal(await noteFound(db, found("pi_direct_foreign"), "acct_SOMEONE", new Date(), { tell: false }), false);
  assert.equal(await noteFound(db, found("pi_direct_ours"), null, new Date(), { tell: false }), true);
  assert.deepEqual((await db.selectFrom("payment_found").select("provider_ref").execute()).map((r) => r.provider_ref), ["pi_direct_ours"]);
});

test("Connect: only the club's connected account; none at all is the platform's, not the club's", async () => {
  const fake = fakeStripe();
  setPaymentProvider(new StripeProvider({ secretKey: "sk_test_platform", fetch: fake.fetch, connect: clubStripeAccount(db) }));
  assert.equal(await clubsAccount(db, "acct_KESTREL"), false, "before the club has connected one, no account is its");
  await db.updateTable("club").set({ stripe_account_id: "acct_KESTREL" }).execute();
  assert.equal(await clubsAccount(db, "acct_KESTREL"), true);
  assert.equal(await clubsAccount(db, "acct_OTHER"), false);
  assert.equal(await clubsAccount(db, null), false);
  assert.equal(await noteFound(db, found("pi_connect_foreign"), "acct_OTHER", new Date(), { tell: false }), false);
  assert.equal(await noteFound(db, found("pi_connect_ours"), "acct_KESTREL", new Date(), { tell: false }), true);
});
