import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkCardSetup, memberPlan, messageHandlers, onDate, openCardSetup, plan, processOutbox, renewMemberships, run, runAsSystem, setPaymentProvider, tidyPresales, KumiError, TestProvider,
  type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, founding: string, foundingYear: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-12-01T18:00:00Z");   // Tue 1 Dec, 10 am: the club opens on 1 March
const la = (day: string, hhmm: string) => onDate(day, hhmm, TZ);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
const join = async (who: string, planId: string, now = NOW) => (await run(db, "membership.join", { plan_id: planId, person_id: people[who] }, as(who), { now })).result as { membership_id?: string; payment_id?: string; save_card?: boolean };
const membership = (who: string) => db.selectFrom("membership").selectAll().where("person_id", "=", people[who]!).orderBy("created_at", "desc").executeTakeFirstOrThrow();
/** What the card form and Stripe do for a card setup: the member saves the card, and the app checks. */
async function saveCard(id: string, who: string) {
  await openCardSetup(db, id, people[who]!);
  stripe.settleSetup((await db.selectFrom("membership").select("provider_ref").where("id", "=", id).executeTakeFirstOrThrow()).provider_ref!);
  return checkCardSetup(db, id, "test", NOW);
}
const email = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "email").executeTakeFirstOrThrow();

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const f = await run(db, "membership.plan_set", { name: "Founding", price_cents: 6000, period: "month", max_members: 2, starts_on: "2027-03-01" }, owner, { now: NOW });
  assert.equal(f.plan.summary.en, "Offer the Founding membership: $60.00 a month; for the first 2 members; it starts on March 1, 2027, and members who join before then are first charged that day.");
  founding = (f.result as any).plan_id;
  foundingYear = ((await run(db, "membership.plan_set", { name: "Founding annual", price_cents: 60000, period: "year", starts_on: "2027-03-01" }, owner, { now: NOW })).result as any).plan_id;
  for (const name of ["Ann", "Ben", "Cal", "Dee", "Eve", "Fay"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, { now: NOW })).result as { person_id: string }).person_id;
  }
});
after(async () => drop());

test("joining before the start: a place and the card saved, nothing charged; the limit, and places whose card never came", async () => {
  const p = await plan(db, "membership.join", { plan_id: founding, person_id: people.Ann }, as("Ann"), { now: NOW });
  assert.equal(p.plan.summary.en, "Join the Founding membership: $60.00 a month. Your card is saved now and first charged on March 1, 2027, then every month until you cancel. Cancel before March 1, 2027 and nothing is charged.");
  assert.equal(p.plan.moneyCents, 0);
  const r = await join("Ann", founding);
  assert.equal(r.save_card, true); assert.equal(r.payment_id, undefined);
  assert.equal((await membership("Ann")).status, "upcoming");
  assert.equal(await memberPlan(db, people.Ann!, NOW), null);   // nothing to use until the club opens
  const charges = stripe.charges.length;
  assert.equal(await saveCard(r.membership_id!, "Ann"), "succeeded");
  const ann = await membership("Ann");
  assert.match(ann.saved_method!, /^pm_test_/); assert.match(ann.saved_customer!, /^cus_test_/);
  assert.equal(stripe.charges.length, charges);
  assert.equal((await db.selectFrom("payment").select("id").where("person_id", "=", people.Ann!).execute()).length, 0);
  await rejects(plan(db, "membership.join", { plan_id: foundingYear, person_id: people.Ann }, as("Ann"), { now: NOW }), "error.already_a_member");

  // Two places: Ben takes the last one, so Cal can't, until Ben's card doesn't come and his place is let go.
  const ben = await join("Ben", founding);
  await rejects(plan(db, "membership.join", { plan_id: founding, person_id: people.Cal }, as("Cal"), { now: NOW }), "error.plan_full", "The Founding membership is full.");
  assert.deepEqual(await tidyPresales(db, new Date(NOW.getTime() + 3600_000)), { saved: 0, released: 0 });
  assert.deepEqual(await tidyPresales(db, new Date(NOW.getTime() + 2 * 3600_000)), { saved: 0, released: 1 });
  assert.deepEqual([(await membership("Ben")).status, (await membership("Ben")).end_reason], ["ended", "no_card"]);
  await rejects(openCardSetup(db, ben.membership_id!, people.Ben!), "error.not_pending");
  await saveCard((await join("Cal", founding)).membership_id!, "Cal");

  await processOutbox(db, messageHandlers);
  assert.equal((await email("Ann", "membership_reserved")).body, "Your Founding membership starts on March 1, 2027, when your card is first charged $60.00. Cancel before then in the app and nothing is charged.");
});

test("on the start date the first charge starts it, and it renews monthly from then", async () => {
  assert.equal((await renewMemberships(db, la("2027-02-28", "23:59"))).renewed, 0);
  const charges = stripe.charges.length;
  assert.equal((await renewMemberships(db, la("2027-03-01", "00:00"))).renewed, 2);   // Ann and Cal
  assert.deepEqual(stripe.charges.slice(charges).map((c) => c.amountCents), [6000, 6000]);
  const ann = await membership("Ann");
  assert.equal(ann.status, "active");
  assert.equal(ann.current_period_end!.toISOString(), la("2027-04-01", "00:00").toISOString());
  assert.equal((await memberPlan(db, people.Ann!, la("2027-03-01", "09:00")))!.name, "Founding");
  await processOutbox(db, messageHandlers);
  assert.equal((await email("Ann", "membership_started")).body, "Your Founding membership runs from today. It renews on April 1, 2027 for $60.00; you can cancel any time in the app.");
});

test("giving up a place before the start; a declined first charge; joining once it has started", async () => {
  const dee = await join("Dee", foundingYear);
  await saveCard(dee.membership_id!, "Dee");
  const c = await run(db, "membership.cancel", { membership_id: dee.membership_id }, as("Dee"), { now: NOW });
  assert.equal(c.plan.summary.en, "Give up your place in the Founding annual membership. Nothing has been charged, and nothing will be.");
  assert.deepEqual([(await membership("Dee")).status, (await membership("Dee")).end_reason], ["ended", "gave_up_place"]);

  await saveCard((await join("Eve", foundingYear)).membership_id!, "Eve");
  stripe.failNextCharge = "card_declined";
  assert.equal((await renewMemberships(db, la("2027-03-01", "00:00"))).failed, 1);
  assert.equal((await membership("Eve")).status, "past_due");
  assert.equal((await db.selectFrom("payment").select("amount_cents").where("membership_id", "=", (await membership("Eve")).id).where("status", "=", "pending").executeTakeFirstOrThrow()).amount_cents, 60000);

  // After the start date, joining is paying, as for any plan.
  const fay = await join("Fay", foundingYear, la("2027-03-02", "10:00"));
  assert.ok(fay.payment_id);

  await processOutbox(db, messageHandlers);
  assert.equal((await email("Dee", "membership_released")).body, "You're no longer down for the Founding annual membership. Nothing was charged.");
});
