import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { daysAhead, endLapsedMemberships, memberPlan, messageHandlers, plan, processOutbox, quote, run, runAsSystem, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, loc: string, c1: string, monthly: string, annual: string;
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z"), opts = { now: NOW };   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
const price = (who: string | null, day: string, hhmm: string, now = NOW) => quote(db, { courtId: c1, start: at(day, hhmm), minutes: 60, personId: who ? people[who] : null, at: now });

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Peak", weekdays: [1, 2, 3, 4, 5], starts: "17:00", ends: "22:00", cents_per_hour: 6000, priority: 1 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const name of ["Ann", "Ben", "Cal", "Dee", "Fay"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
  }
  await run(db, "role.assign", { person_id: people.Fay, role: "front_desk" }, owner, opts);
  desk = as("Fay");
});
after(async () => drop());

test("plans: what the preview says, and stopping one", async () => {
  const m = await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month", days_ahead: 21 }, owner, opts);
  assert.equal(m.plan.summary.en, "Offer the Monthly membership: $80.00 a month; members book courts up to 21 days ahead.");
  assert.match(m.plan.summary.es, /^Ofrecer la membresía Monthly: .*80\.00 al mes; los miembros reservan canchas con hasta 21 días de anticipación\.$/);
  monthly = (m.result as any).plan_id;
  const a = await run(db, "membership.plan_set", { name: "Annual", price_cents: 80000, period: "year" }, owner, opts);
  assert.equal(a.plan.summary.en, "Offer the Annual membership: $800.00 a year.");
  annual = (a.result as any).plan_id;
  const old = (await run(db, "membership.plan_set", { name: "Founding", price_cents: 6000, period: "month" }, owner, opts)).result as { plan_id: string };
  const r = await run(db, "membership.plan_remove", { plan_id: old.plan_id }, owner, opts);
  assert.equal(r.plan.summary.en, "Stop offering the Founding membership. People who have it keep it.");
  await rejects(plan(db, "membership.grant", { person_id: people.Ann, plan_id: old.plan_id }, owner, opts), "error.plan_not_offered", "The Founding membership isn't offered any more.");
});

test("member prices: only for members of the plan, and they win a tie", async () => {
  const p = await run(db, "price.rule_set", { location_id: loc, name: "Members peak", weekdays: [1, 2, 3, 4, 5], starts: "17:00", ends: "22:00", cents_per_hour: 4500, priority: 1, plan_ids: [monthly, annual] }, owner, opts);
  assert.equal(p.plan.summary.en, "Member price Members peak at Eastside, for Annual or Monthly members: $45.00 an hour, Mon, Tue, Wed, Thu, Fri, 17:00 to 22:00.");
  await run(db, "price.rule_set", { location_id: loc, name: "Members", cents_per_hour: 3000, plan_ids: [monthly] }, owner, opts);
  // Nobody is a member yet: everyone pays the usual price.
  assert.equal((await price("Ann", "2026-12-01", "18:00")).total_cents, 6000);
  assert.equal((await price("Ann", "2026-12-01", "18:00")).member, null);
  await rejects(plan(db, "price.rule_set", { location_id: loc, name: "x", cents_per_hour: 1, plan_ids: [loc] }, owner, opts), "error.not_found");
});

test("the desk gives a membership: member prices, the longer window, one at a time, and a welcome", async () => {
  const g = await run(db, "membership.grant", { person_id: people.Ann, plan_id: monthly, note: "Founding member" }, desk, opts);
  assert.equal(g.plan.summary.en, "Give Ann the Monthly membership, with no end date.");
  const q = await price("Ann", "2026-12-01", "18:00");
  assert.deepEqual([q.total_cents, q.member, q.lines[0]!.name], [4500, "Monthly", "Members peak"]);
  assert.equal((await price("Ann", "2026-12-05", "10:00")).total_cents, 3000);   // Saturday: the monthly members' everyday price
  assert.equal((await price("Ben", "2026-12-01", "18:00")).total_cents, 6000);   // not a member
  await rejects(plan(db, "membership.grant", { person_id: people.Ann, plan_id: annual }, owner, opts), "error.already_member", "Ann already has a membership. End it first to change plans.");

  assert.equal(await daysAhead(db, people.Ann!, NOW), 21);
  assert.equal(await daysAhead(db, people.Ben!, NOW), 14);
  const far = { court_id: c1, starts_at: at("2026-12-17", "10:00").toISOString(), minutes: 90, pay: "whole" };   // 17 days ahead
  await rejects(plan(db, "booking.request", { ...far, person_id: people.Ben }, as("Ben"), opts), "error.too_far_ahead", "Courts can be booked up to 14 days ahead.");
  const ok = await plan(db, "booking.request", { ...far, person_id: people.Ann }, as("Ann"), opts);
  assert.equal(ok.plan.moneyCents, 4500);   // 90 minutes at the members' $30 an hour
  // A desk booking for a member takes the member's price too.
  const b = await run(db, "booking.create", { court_id: c1, starts_at: at("2026-12-02", "18:00").toISOString(), minutes: 60, person_id: people.Ann }, desk, opts);
  assert.match(b.plan.summary.en, /for Ann: \$45\.00\.$/);

  await processOutbox(db, messageHandlers);
  const welcome = await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people.Ann!).where("kind", "=", "membership_started").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.equal(welcome.subject, "Your membership: Monthly");
  assert.equal(welcome.body, "Your Monthly membership runs from today. You get member prices on courts. You can book courts up to 21 days ahead.");
});

test("a membership with an end date runs out by itself; ending one early; undo", async () => {
  const g = await run(db, "membership.grant", { person_id: people.Cal, plan_id: annual, until: "2026-12-31" }, owner, opts);
  assert.equal(g.plan.summary.en, "Give Cal the Annual membership until December 31, 2026.");
  await rejects(plan(db, "membership.grant", { person_id: people.Dee, plan_id: annual, until: "2026-11-29" }, owner, opts), "error.in_the_past");
  const lastDay = at("2026-12-31", "22:00"), after = at("2027-01-01", "00:30");
  assert.ok(await memberPlan(db, people.Cal!, lastDay));
  assert.equal(await memberPlan(db, people.Cal!, after), null);   // its benefits stop on time, job or no job
  assert.equal(await endLapsedMemberships(db, lastDay), 0);
  assert.equal(await endLapsedMemberships(db, after), 1);
  const m = await db.selectFrom("membership").select(["status", "ended_at"]).where("person_id", "=", people.Cal!).executeTakeFirstOrThrow();
  assert.equal(m.status, "ended"); assert.equal(m.ended_at!.toISOString(), "2027-01-01T08:00:00.000Z");

  const id = ((await db.selectFrom("membership").select("id").where("person_id", "=", people.Ann!).executeTakeFirstOrThrow()).id);
  const e = await run(db, "membership.end", { membership_id: id }, desk, opts);
  assert.equal(e.plan.summary.en, "End Ann's Monthly membership now. Member prices and the longer booking window stop; bookings already made keep their price.");
  assert.equal((await price("Ann", "2026-12-01", "18:00")).total_cents, 6000);
  await rejects(plan(db, "membership.end", { membership_id: id }, owner, opts), "error.membership_ended");
  await run(db, "action.undo", { run_id: e.runId }, owner, opts);
  assert.equal((await price("Ann", "2026-12-01", "18:00")).total_cents, 4500);

  await processOutbox(db, messageHandlers);
  const kinds = async (who: string) => (await db.selectFrom("outbound_message").select("kind").where("person_id", "=", people[who]!).where("channel", "=", "email").orderBy("created_at").execute()).map((x) => x.kind);
  assert.deepEqual(await kinds("Cal"), ["membership_started", "membership_ended"]);
  const cal = await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Cal!).where("kind", "=", "membership_started").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.equal(cal.body, "Your Annual membership runs from today until December 31, 2026. You get member prices on courts.");
});

test("members can't give themselves a membership", async () => {
  await rejects(plan(db, "membership.grant", { person_id: people.Dee, plan_id: monthly }, as("Dee"), opts), "error.forbidden_reason");
  await rejects(plan(db, "membership.plan_set", { name: "Free", price_cents: 0, period: "year" }, desk, opts), "error.forbidden_reason");
});
