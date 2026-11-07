// Under Stripe Connect one webhook endpoint hears every connected account's events, other clubs' too (Stripe can't
// send a club only its own). The 0.3.0 security review showed a club keeping another club's paid intent as a payment
// "found" here: its payer's email on the staff's list, and a refund of it sent on the other club's account. An event
// on any account but the club's is now read no further, and a row kept from before is never listed or refunded.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { fakeStripe } from "../../../packages/core/test/fake-stripe.ts";
import { clubStripeAccount, dropForeignFound, moneyHandlers, processOutbox, run, runAsSystem, setPaymentProvider, uuidv7, StripeProvider, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const fake = fakeStripe(), WHSEC = "whsec_connect_foreign", OURS = "acct_KESTREL", THEIRS = "acct_OTHERCLUB";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer();
const strong = (a: Actor) => ({ ...a, auth: "passkey" }) as Actor;
const sign = (payload: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex")}`; };
const paidEvent = (id: string, account: string | undefined, email: string) => JSON.stringify({ id: `evt_${id}`, type: "payment_intent.succeeded", ...(account ? { account } : {}),
  data: { object: { id, object: "payment_intent", amount: 9000, amount_received: 9000, currency: "usd", created: Math.floor(Date.now() / 1000), receipt_email: email, description: "Court 3, Saturday" } } });
async function hook(body: string) {
  const said: string[] = [], keep = console.warn;
  console.warn = (...x: unknown[]) => { said.push(x.map(String).join(" ")); };
  try { const r = await app.request("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": sign(body), "content-type": "application/json" }, body }); return { status: r.status, said }; }
  finally { console.warn = keep; }
}
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const listed = async (cookie: string) => { const r = await app.request("/staff/payments-found", { headers: { cookie } }); assert.equal(r.status, 200); return (await r.json() as { found: { id: string; email: string | null }[] }).found; };
const restoreAlerts = () => db.selectFrom("event_outbox").select("id").where("topic", "=", "ops.failed").where(sql<string>`payload->>'job'`, "=", "restore_money").execute();
/** A row as 0.3.0 kept one from another club's event, before whose it was was checked. */
async function keptFromBefore(status: string, ref: string) {
  const id = uuidv7();
  await db.insertInto("payment_found").values({ id, provider: "stripe", provider_ref: ref, account: THEIRS, amount_cents: 9000, paid_at: new Date(), email: "victim@otherclub.test",
    description: "Court 3, Saturday", note: null, done_at: null, kind: "payment", status, currency: "USD" } as any).execute();
  return id;
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(new StripeProvider({ secretKey: "sk_test_platform", fetch: fake.fetch, connect: clubStripeAccount(db) }));
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en" };
  // The club's own connected account, ready for payments.
  fake.accounts.set(OURS, { charges_enabled: true, details_submitted: true, key: "kestrel" });
  await db.updateTable("club").set({ stripe_account_id: OURS, stripe_charges_enabled: true, stripe_details_submitted: true }).execute();
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://kestrel.example", stripe: { publishableKey: "pk_test_platform", webhookSecret: WHSEC } });
});
after(async () => drop());

test("another club's paid intent, heard on the shared Connect endpoint, is left alone: nothing kept, nobody told", async () => {
  const r = await hook(paidEvent("pi_other_club", THEIRS, "victim@otherclub.test"));
  assert.equal(r.status, 200, "answered as received, so Stripe doesn't send it again");
  assert.equal((await db.selectFrom("payment_found").select("id").execute()).length, 0, "nothing of the other club's is kept here");
  assert.equal((await restoreAlerts()).length, 0, "and the staff aren't told of money that isn't theirs");
  assert.ok(r.said.some((l) => /another Stripe account \(ending CLUB\).*not this club's/.test(l)), r.said.join("\n"));
  assert.ok(r.said.every((l) => !l.includes("victim@") && !l.includes("pi_other_club")), "the log names neither the payer nor the payment");
  // One with no account at all is the platform's own, not this club's either.
  await hook(paidEvent("pi_platform", undefined, "someone@example.test"));
  assert.equal((await db.selectFrom("payment_found").select("id").execute()).length, 0);
});

test("the club's own paid intent with no record here is still kept for the staff, and listed", async () => {
  const r = await hook(paidEvent("pi_ours_after_restore", OURS, "ann@example.test"));
  assert.equal(r.status, 200);
  const rows = await db.selectFrom("payment_found").select(["provider_ref", "account", "status"]).execute();
  assert.deepEqual(rows, [{ provider_ref: "pi_ours_after_restore", account: OURS, status: "open" }]);
  assert.ok((await restoreAlerts()).length >= 1, "the owner and managers hear");
  const cookie = await signIn("robin@example.test");
  assert.deepEqual((await listed(cookie)).map((f) => f.email), ["ann@example.test"]);
});

test("a row kept from another club's event before the fix is never listed, refunded or kept, and goes at start", async () => {
  const open = await keptFromBefore("open", "pi_theirs_open");
  const asked = await keptFromBefore("refund_asked", "pi_theirs_asked");
  const acted = await keptFromBefore("handled", "pi_theirs_acted");
  const cookie = await signIn("robin@example.test");
  assert.ok((await listed(cookie)).every((f) => f.email !== "victim@otherclub.test"), "the staff's list has only the club's own");
  await assert.rejects(run(db, "payment_found.refund", { id: open }, strong(owner)), /doesn't exist/);
  await assert.rejects(run(db, "payment_found.paid_elsewhere", { id: open, books: "income" }, strong(owner)), /doesn't exist/);
  // A refund already asked of one (0.3.0 let a manager do it): the outbox sends nothing on the other club's account.
  await db.insertInto("event_outbox").values({ topic: "payment_found.refund", payload: JSON.stringify({ id: asked }) } as any).execute();
  const before = fake.refunds.length;
  await processOutbox(db, moneyHandlers);
  assert.equal(fake.refunds.length, before, "no refund goes to Stripe");
  assert.equal(fake.refunds.filter((x) => x.account === THEIRS).length, 0);
  assert.equal(await db.selectFrom("payment_found").select("id").where("id", "=", asked).executeTakeFirst(), undefined, "and the row is gone");
  // As the server starts: what nobody acted on goes; what they did stays, without the other club's payer.
  const r = await dropForeignFound(db);
  assert.deepEqual(r, { removed: 1, scrubbed: 1 });
  assert.equal(await db.selectFrom("payment_found").select("id").where("id", "=", open).executeTakeFirst(), undefined);
  assert.deepEqual(await db.selectFrom("payment_found").select(["status", "email", "description"]).where("id", "=", acted).executeTakeFirstOrThrow(), { status: "handled", email: null, description: null });
  assert.deepEqual(await dropForeignFound(db), { removed: 0, scrubbed: 0 }, "nothing to do the next time");
  // The club's own row is untouched.
  assert.equal((await db.selectFrom("payment_found").select("status").where("provider_ref", "=", "pi_ours_after_restore").executeTakeFirstOrThrow()).status, "open");
});

test("an account the club's own payments were made on (before it moved accounts) is still the club's", async () => {
  const id = uuidv7();
  const person = (await db.selectFrom("person").select("id").executeTakeFirstOrThrow()).id;
  await sql`INSERT INTO payment (id, person_id, amount_cents, method, status, provider, provider_ref, provider_account) VALUES (${id}, ${person}, 4000, 'card', 'succeeded', 'stripe', 'pi_old_account_payment', 'acct_OLDKESTREL')`.execute(db);
  await hook(paidEvent("pi_old_account_unknown", "acct_OLDKESTREL", "ben@example.test"));
  assert.equal((await db.selectFrom("payment_found").select("account").where("provider_ref", "=", "pi_old_account_unknown").executeTakeFirstOrThrow()).account, "acct_OLDKESTREL");
});
