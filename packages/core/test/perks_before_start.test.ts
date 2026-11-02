import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkCardSetup, daysAhead, memberPlan, openCardSetup, programPrice, quote, run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "../src/index.ts";

// Founding members before the plan starts: once their card is saved, the plan's member prices, program discounts
// and booking window are theirs already (unless the plan says otherwise); included sessions wait for the start.
let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, court: string, clinic: string, founding: string, later: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-12-01T18:00:00Z");   // Tue 1 Dec, 10 am: the plans start on 1 March
const opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function join(who: string, planId: string, card = true) {
  const r = (await run(db, "membership.join", { plan_id: planId, person_id: people[who] }, as(who), opts)).result as { membership_id: string };
  if (card) {
    await openCardSetup(db, r.membership_id, people[who]!);
    stripe.settleSetup((await db.selectFrom("membership").select("provider_ref").where("id", "=", r.membership_id).executeTakeFirstOrThrow()).provider_ref!);
    await checkCardSetup(db, r.membership_id, "test", NOW);
  }
  return r.membership_id;
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  founding = ((await run(db, "membership.plan_set", { name: "Founding", price_cents: 8900, period: "month", starts_on: "2027-03-01", days_ahead: 30, program_percent_off: 10,
    included_sessions: 2, included_kinds: ["clinic"] }, owner, opts)).result as any).plan_id;
  const l = await run(db, "membership.plan_set", { name: "Opening", price_cents: 8900, period: "month", starts_on: "2027-03-01", program_percent_off: 10, perks_before_start: false }, owner, opts);
  assert.match(l.plan.summary.en, /; its member prices and discounts begin that day\.$/);
  later = (l.result as any).plan_id;
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Members", cents_per_hour: 3000, plan_ids: [founding, later], priority: 5 }, owner, opts);
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Beginner clinic", capacity: 8, price_cents: 3000 }, owner, opts)).result as any).program_id;
  const start = new Date("2026-12-10T18:00:00-08:00");
  await run(db, "session.add", { program_id: clinic, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), court_ids: [court] }, owner, opts);
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
  for (const name of ["Ann", "Ben", "Cal", "Dee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
});
after(async () => drop());

test("card saved before the start: member court prices, the program discount and the longer window already, but no included sessions", async () => {
  await join("Ann", founding);
  assert.equal((await memberPlan(db, people.Ann!, NOW))?.name, "Founding");
  const q = await quote(db, { courtId: court, start: new Date("2026-12-10T10:00:00-08:00"), minutes: 60, personId: people.Ann!, at: NOW });
  assert.deepEqual([q.total_cents, q.member], [3000, "Founding"]);
  const pr = await programPrice(db, clinic, people.Ann!, NOW);
  assert.deepEqual([pr.cents, pr.basis], [2700, "member"]);   // 10% off, not an included (free) session
  assert.equal(await daysAhead(db, people.Ann!, NOW), 30);
});

test("no perks before the card is saved, or when the plan keeps them for the start", async () => {
  await join("Ben", founding, false);
  assert.equal(await memberPlan(db, people.Ben!, NOW), null);
  await join("Cal", later);
  assert.equal(await memberPlan(db, people.Cal!, NOW), null);
  assert.deepEqual([(await programPrice(db, clinic, people.Cal!, NOW)).cents, (await programPrice(db, clinic, people.Dee!, NOW)).cents], [3000, 3000]);
});

test("giving up a founding place keeps what was already paid at member prices", async () => {
  const dee = await join("Dee", founding);
  await run(db, "enrolment.join", { program_id: clinic, person_id: people.Dee }, as("Dee"), opts);
  const paid = await db.selectFrom("enrolment").select("price_cents").where("person_id", "=", people.Dee!).executeTakeFirstOrThrow();
  assert.equal(paid.price_cents, 2700);
  const c = await run(db, "membership.cancel", { membership_id: dee }, as("Dee"), opts);
  assert.equal(c.plan.summary.en, "Give up your place in the Founding membership. Nothing has been charged, and nothing will be. Anything already paid for at member prices stays as it was.");
  assert.equal((await db.selectFrom("enrolment").select("price_cents").where("person_id", "=", people.Dee!).executeTakeFirstOrThrow()).price_cents, 2700);
  assert.equal(await memberPlan(db, people.Dee!, NOW), null);
});
