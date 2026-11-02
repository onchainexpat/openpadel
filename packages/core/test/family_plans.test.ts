import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, daysAhead, memberPlan, messageHandlers, onDate, openPayment, plan, processOutbox, programPrice, quote, renewMemberships, run, runAsSystem, setPaymentProvider, KumiError, TestProvider,
  type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, family: string, court: string, loc: string, mid: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-12-01T18:00:00Z"), opts = { now: NOW };
const la = (day: string, hhmm: string) => onDate(day, hhmm, TZ);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
const add = (who: string, now = NOW) => run(db, "membership.add_person", { membership_id: mid, person_id: people[who] }, as("Pat"), { now });
async function clinic(name: string) {
  const id = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name, capacity: 8, price_cents: 3000 }, owner, opts)).result as any).program_id;
  const room = ((await run(db, "court.create", { location_id: loc, name: `Court for ${name}` }, owner, opts)).result as any).court_id;
  await run(db, "session.add", { program_id: id, starts_at: la("2026-12-05", "10:00").toISOString(), ends_at: la("2026-12-05", "11:00").toISOString(), court_ids: [room] }, owner, opts);
  await run(db, "program.publish", { program_id: id }, owner, opts);
  return id as string;
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  for (const name of ["Pat", "Sam", "Ann", "Max"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  for (const [name, year] of [["Mia", 2015], ["Leo", 2017]] as const)
    people[name] = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: name, birth_year: year }, as("Pat"), opts)).result as any).person_id;
  const code = ((await run(db, "household.invite", { person_id: people.Pat }, as("Pat"), opts)).result as any).code;
  await run(db, "household.accept_invite", { person_id: people.Sam, code }, as("Sam"), opts);
});
after(async () => drop());

test("a family plan: how many it covers and the price of one more", async () => {
  await rejects(plan(db, "membership.plan_set", { name: "Odd", price_cents: 1000, period: "month", extra_person_cents: 500 }, owner, opts), "error.extra_needs_family");
  const r = await run(db, "membership.plan_set", { name: "Family", price_cents: 20000, period: "month", days_ahead: 21, program_percent_off: 10, included_sessions: 1, included_kinds: ["clinic"],
    family_size: 3, extra_person_cents: 3000 }, owner, opts);
  assert.equal(r.plan.summary.en, "Offer the Family membership: $200.00 a month; members book courts up to 21 days ahead; 10% off programs; 1 session included each month (clinic); a family plan for up to 3 people in one household; $30.00 more for each person beyond that.");
  family = (r.result as any).plan_id;
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Members", cents_per_hour: 2000, plan_ids: [family], priority: 10 }, owner, opts);
});

test("the payer joins and adds the family: up to the plan's number included, one more charged now", async () => {
  const j = await run(db, "membership.join", { plan_id: family, person_id: people.Pat }, as("Pat"), opts);
  assert.equal(j.plan.summary.en, "Join the Family membership: $200.00 a month, paid now and then every month from the same card until you cancel. Cancelling stops the next payment; it runs to the end of what's paid. It covers you and up to 2 more from your family, and each one after that is $30.00 a month: add them on your Membership page.");
  const pay = (j.result as any).payment_id;
  await openPayment(db, pay, people.Pat!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", pay).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, pay, "test", NOW), "succeeded");
  mid = (await db.selectFrom("membership").select("id").where("person_id", "=", people.Pat!).executeTakeFirstOrThrow()).id;
  await rejects(plan(db, "membership.add_person", { membership_id: mid, person_id: people.Ann }, as("Pat"), opts), "error.not_in_family");
  await rejects(plan(db, "membership.add_person", { membership_id: mid, person_id: people.Mia }, as("Ann"), opts), "error.forbidden_reason");   // not Ann's membership
  const mia = await add("Mia");
  assert.equal(mia.plan.summary.en, "Add Mia to the Family membership, with its member benefits. It's included: the membership covers 3 people.");
  await add("Sam");
  const leo = await add("Leo");
  assert.equal(leo.plan.summary.en, "Add Leo to the Family membership, with its member benefits. That's one more than the 3 it covers, so $30.00 goes on the card now for this period, and each renewal is $230.00.");
  const extra = await db.selectFrom("payment").select(["amount_cents", "status", "person_id"]).where("membership_member_id", "is not", null).executeTakeFirstOrThrow();
  assert.deepEqual(extra, { amount_cents: 3000, status: "succeeded", person_id: people.Pat });
  // Everyone covered has the benefits: the booking window and member court prices.
  for (const who of ["Mia", "Sam", "Leo"]) assert.equal((await memberPlan(db, people[who]!, NOW))?.plan_id, family, who);
  assert.equal(await daysAhead(db, people.Sam!, NOW), 21);
  assert.equal((await quote(db, { courtId: court, start: la("2026-12-03", "10:00"), minutes: 60, personId: people.Sam!, at: NOW })).total_cents, 2000);
  // Covered, so not joining another plan, and nobody is on two family plans.
  await rejects(plan(db, "membership.join", { plan_id: family, person_id: people.Sam }, as("Sam"), opts), "error.already_a_member");
  await processOutbox(db, messageHandlers);
  const msgs = await db.selectFrom("outbound_message").select(["person_id", "subject", "body"]).where("kind", "=", "membership_person_added").where("channel", "=", "inbox").execute();
  assert.deepEqual(msgs, [{ person_id: people.Sam, subject: "You're on the Family membership", body: "Pat added you to their Family membership: its member benefits are yours too." }]);   // the juniors' parents already know
});

test("program perks for each person: their own included session, then the member price", async () => {
  const a = await clinic("Clinic A"), b = await clinic("Clinic B");
  assert.equal((await run(db, "enrolment.join", { program_id: a, person_id: people.Mia }, as("Sam"), opts)).plan.summary.en, "Sign Mia up for Clinic A at no charge: included session 1 of 1 in the membership this period.");
  assert.equal((await run(db, "enrolment.join", { program_id: a, person_id: people.Leo }, as("Pat"), opts)).plan.summary.en, "Sign Leo up for Clinic A at no charge: included session 1 of 1 in the membership this period.");
  assert.equal((await programPrice(db, b, people.Mia!, NOW)).basis, "member");
  assert.equal((await programPrice(db, b, people.Mia!, NOW)).cents, 2700);
});

test("renewals charge the base price and each person more; someone taken off is covered to the renewal", async () => {
  const m = await db.selectFrom("membership").selectAll().where("id", "=", mid).executeTakeFirstOrThrow();
  const end = m.current_period_end!;
  const off = await run(db, "membership.remove_person", { membership_id: mid, person_id: people.Leo }, as("Pat"), opts);
  assert.equal(off.plan.summary.en, "Take Leo off the Family membership. They keep its benefits until January 1, 2027, and it renews without them.");
  assert.equal((await memberPlan(db, people.Leo!, NOW))?.plan_id, family);   // still covered until then
  await renewMemberships(db, new Date(end.getTime() + 60_000));
  const charges = await db.selectFrom("payment").select("amount_cents").where("membership_id", "=", mid).where("membership_member_id", "is", null).orderBy("created_at").execute();
  assert.deepEqual(charges.map((c) => c.amount_cents), [20000, 20000]);   // joined, then renewed: Leo was off by then, so no one more
  assert.equal(await memberPlan(db, people.Leo!, new Date(end.getTime() + 60_000)), null);
  // Add Leo back, then Max can't be added (not in the family); the next renewal includes Leo's extra price.
  const later = new Date(end.getTime() + 86400_000);
  await add("Leo", later);
  const m2 = await db.selectFrom("membership").selectAll().where("id", "=", mid).executeTakeFirstOrThrow();
  await renewMemberships(db, new Date(m2.current_period_end!.getTime() + 60_000));
  const last = await db.selectFrom("payment").select("amount_cents").where("membership_id", "=", mid).where("membership_member_id", "is", null).orderBy("created_at", "desc").executeTakeFirstOrThrow();
  assert.equal(last.amount_cents, 23000);
});

test("pausing the membership pauses everyone's benefits; leaving the family ends cover at the renewal", async () => {
  const t0 = new Date("2027-02-03T18:00:00Z");
  await run(db, "membership.pause", { membership_id: mid, until: "2027-02-10" }, owner, { now: t0 });
  assert.equal(await memberPlan(db, people.Mia!, t0), null);
  await run(db, "membership.unpause", { membership_id: mid }, owner, { now: t0 });
  await run(db, "household.leave", { person_id: people.Sam }, as("Sam"), { now: t0 });
  const row = await db.selectFrom("membership_member").select("ends_at").where("person_id", "=", people.Sam!).executeTakeFirstOrThrow();
  const m = await db.selectFrom("membership").select("current_period_end").where("id", "=", mid).executeTakeFirstOrThrow();
  assert.equal(row.ends_at?.toISOString(), m.current_period_end?.toISOString());
});

test("a declined card for one more person: they aren't added, and adding them again tries the card again", async () => {
  const t0 = new Date("2027-02-03T19:00:00Z");
  people.Zoe = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Zoe", birth_year: 2019 }, as("Pat"), { now: t0 })).result as any).person_id;
  stripe.failNextCharge = "card_declined";
  await rejects(add("Zoe", t0), "error.extra_declined", "The charge for the extra person didn't go through (the card was declined), so they weren't added.");
  assert.equal(await memberPlan(db, people.Zoe!, t0), null);
  const charges = stripe.charges.length;
  await add("Zoe", t0);   // the card works now: a new try, not the first answer again
  assert.equal((await memberPlan(db, people.Zoe!, t0))?.plan_id, family);
  assert.deepEqual([stripe.charges.length, stripe.charges.at(-1)!.amountCents], [charges + 1, 3000]);
});
