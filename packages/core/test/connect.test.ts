import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { fakeStripe } from "./fake-stripe.ts";
import { checkPayment, clubStripeAccount, connectStripe, moneyHandlers, openPayment, plan, processOutbox, refreshStripeAccount, run, runAsSystem,
  setPaymentProvider, uuidv7, KumiError, StripeProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, manager: Actor, desk: Actor, member: Actor, program: string, stripe: StripeProvider;
const fake = fakeStripe();
const urls = { refresh: "https://kestrel.example/payments?stripe=refresh", return: "https://kestrel.example/payments?stripe=return" };
const as = (personId: string): Actor => ({ personId, via: "test", lang: "en" });
const club = () => db.selectFrom("club").select(["stripe_account_id", "stripe_charges_enabled", "stripe_details_submitted"]).executeTakeFirstOrThrow();
async function person(name: string, role: string) {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: `${name.toLowerCase()}@example.test`, created_via: "desk" }).execute();
  const r = await db.selectFrom("role").select("id").where("key", "=", role).executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  return id;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}

before(async () => {
  ({ db, drop } = await freshDb());
  stripe = new StripeProvider({ secretKey: "sk_test_platform", fetch: fake.fetch, connect: clubStripeAccount(db) });
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  manager = as(await person("Monica", "manager")); desk = as(await person("Dee", "front_desk")); member = as(await person("Ana", "member"));
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string }).location_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as { court_id: string }).court_id;
  program = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Beginner Clinic", capacity: 8, price_cents: 3000, refund_window_hours: 48 }, owner)).result as { program_id: string }).program_id;
  await run(db, "session.add", { program_id: program, starts_at: new Date(Date.now() + 6 * 864e5).toISOString(), ends_at: new Date(Date.now() + 6 * 864e5 + 5400_000).toISOString(), court_ids: [court] }, owner);
  await run(db, "program.publish", { program_id: program }, owner);
});
after(async () => drop());

test("no card payments until the club's own Stripe account is connected and ready", async () => {
  const j = (await run(db, "enrolment.join", { program_id: program, person_id: member.personId! }, member)).result as { payment_id: string };
  await rejects(openPayment(db, j.payment_id, member.personId!), "error.payments_not_set_up");
  assert.equal(fake.intents.size, 0, "nothing ever goes into the platform's own account");
});

test("connecting: only owners and managers start it, a manager's ask waits for the owner, and Stripe makes one account", async () => {
  await rejects(connectStripe(db, stripe, member, urls), "error.forbidden");
  await rejects(connectStripe(db, stripe, desk, urls), "error.forbidden");
  assert.equal(fake.accounts.size, 0, "nothing asked of Stripe for them");

  const asked = await connectStripe(db, stripe, manager, urls);
  assert.ok("awaiting_approval" in asked);
  assert.equal((await club()).stripe_account_id, null, "not linked until the owner says so");

  const r = await connectStripe(db, stripe, owner, urls, "robin@example.test");
  assert.ok("url" in r && r.url.startsWith("https://connect.stripe.com/"));
  assert.equal(fake.accounts.size, 1, "the manager's ask and the owner's made one account between them");
  const acct = (await club()).stripe_account_id!;
  assert.match(acct, /^acct_/);
  const create = fake.calls.find((c) => c.path === "/v1/accounts" && c.method === "POST")!;
  assert.equal(create.body.get("type"), "standard"); assert.equal(create.body.get("country"), "US");
  assert.match(create.key!, /^account:club:/, "the retry key is this club's own");
  const link = fake.calls.findLast((c) => c.path === "/v1/account_links")!;
  assert.equal(link.body.get("return_url"), urls.return); assert.equal(link.body.get("type"), "account_onboarding");
  // Coming back to it gives a fresh link to the same account.
  await connectStripe(db, stripe, owner, urls);
  assert.equal(fake.accounts.size, 1);
  const runs = await db.selectFrom("event_outbox").select("payload").where("topic", "=", "club.payment_account_changed").execute();
  assert.equal(runs.length, 1, "the change is announced once");
});

test("Stripe says the account is ready: recorded once, and payments open on the club's account", async () => {
  const acct = (await club()).stripe_account_id!;
  assert.equal((await refreshStripeAccount(db, stripe))!.chargesEnabled, false);
  fake.accounts.get(acct)!.charges_enabled = true; fake.accounts.get(acct)!.details_submitted = true;   // the owner finished Stripe's setup
  await refreshStripeAccount(db, stripe);
  await refreshStripeAccount(db, stripe);
  assert.deepEqual(await club(), { stripe_account_id: acct, stripe_charges_enabled: true, stripe_details_submitted: true });
  assert.equal((await db.selectFrom("event_outbox").select("id").where("topic", "=", "club.payments_on").execute()).length, 1);

  const pay = (await db.selectFrom("payment").select("id").where("person_id", "=", member.personId!).executeTakeFirstOrThrow()).id;
  const form = await openPayment(db, pay, member.personId!);
  assert.equal(form.account, acct);
  const ref = (await db.selectFrom("payment").select(["provider_ref", "provider_account"]).where("id", "=", pay).executeTakeFirstOrThrow());
  assert.equal(ref.provider_account, acct);
  assert.equal(fake.intents.get(ref.provider_ref!)!.account, acct, "a direct charge on the club's own account");
  fake.intents.get(ref.provider_ref!)!.status = "succeeded";
  assert.equal(await checkPayment(db, pay), "succeeded");
});

test("a refund goes back through the account the payment was taken on, even after the club changes accounts", async () => {
  const first = (await club()).stripe_account_id!;
  const e = await db.selectFrom("enrolment").select("id").where("person_id", "=", member.personId!).where("status", "=", "booked").executeTakeFirstOrThrow();
  // The club moves to another Stripe account; the preview says what happens to refunds of earlier payments.
  const p = await plan(db, "club.payment_account_set", { stripe_account_id: "acct_2NEWONE" }, owner);
  assert.match(p.plan.summary.en, /Refunds for payments already taken still go back through …/);
  await run(db, "club.payment_account_set", { stripe_account_id: "acct_2NEWONE" }, owner);
  await run(db, "enrolment.remove", { enrolment_id: e.id, reason: "club" }, owner);
  await processOutbox(db, moneyHandlers);
  assert.equal(fake.refunds.length, 1);
  assert.deepEqual({ account: fake.refunds[0]!.account, amount: fake.refunds[0]!.amount }, { account: first, amount: 3000 });
  assert.equal((await db.selectFrom("refund").select("status").where("enrolment_id", "=", e.id).executeTakeFirstOrThrow()).status, "sent");
  // And new payments wait until Stripe says the new account is ready.
  assert.equal((await club()).stripe_charges_enabled, false);
});
