import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { membersFrom, messageHandlers, plan, processOutbox, programPrice, run, runAsSystem, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, gold: string, silver: string;
const NOW = new Date("2026-12-01T18:00:00Z"), opts = { now: NOW };
const at = (h: number) => new Date(NOW.getTime() + h * 3600_000);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
/** A published program with `dates` sessions, the first `startsIn` hours from now (on a court of its own). */
async function program(name: string, kind: string, price: number, o: { member?: number; dates?: number; startsIn?: number; capacity?: number } = {}) {
  const id = ((await run(db, "program.create", { location_id: loc, kind, name, capacity: o.capacity ?? 8, price_cents: price, ...(o.member !== undefined ? { member_price_cents: o.member } : {}) }, owner, opts)).result as any).program_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: `Court for ${name}` }, owner, opts)).result as any).court_id;
  for (let d = 0; d < (o.dates ?? 1); d++) {
    const start = at((o.startsIn ?? 72) + d * 168);
    await run(db, "session.add", { program_id: id, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), court_ids: [court] }, owner, opts);
  }
  await run(db, "program.publish", { program_id: id }, owner, opts);
  return id as string;
}
const join = (pid: string, who: string, now = NOW) => run(db, "enrolment.join", { program_id: pid, person_id: people[who] }, as(who), { now });
const place = (id: string) => db.selectFrom("enrolment").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner, opts)).result as any).location_id;
  const g = await run(db, "membership.plan_set", { name: "Gold", price_cents: 12000, period: "month", program_percent_off: 20, included_sessions: 2, included_kinds: ["clinic"] }, owner, opts);
  assert.equal(g.plan.summary.en, "Offer the Gold membership: $120.00 a month; 20% off programs; 2 sessions included each month (clinic).");
  gold = (g.result as any).plan_id;
  silver = ((await run(db, "membership.plan_set", { name: "Silver", price_cents: 6000, period: "month", program_cents_off: 500 }, owner, opts)).result as any).plan_id;
  await rejects(plan(db, "membership.plan_set", { name: "Both", price_cents: 1, period: "month", program_percent_off: 10, program_cents_off: 100 }, owner, opts), "error.one_program_discount");
  for (const name of ["Ann", "Bob", "Cal", "Dee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  await run(db, "membership.grant", { person_id: people.Ann, plan_id: gold }, owner, opts);
  await run(db, "membership.grant", { person_id: people.Cal, plan_id: silver }, owner, opts);
  await run(db, "membership.grant", { person_id: people.Dee, plan_id: gold }, owner, opts);
});
after(async () => drop());

test("a member's clinics: included sessions first, then the plan's discount; a non-member pays the price", async () => {
  const a = await program("Clinic A", "clinic", 3000), b = await program("Clinic B", "clinic", 3000), e = await program("Clinic E", "clinic", 3000);
  const bob = await join(a, "Bob");
  assert.equal(bob.plan.summary.en, "Sign Bob up for Clinic A for $30.00.");
  const first = await join(a, "Ann");
  assert.equal(first.plan.summary.en, "Sign Ann up for Clinic A at no charge: included session 1 of 2 in the membership this period.");
  assert.equal((first.result as any).payment_id, undefined);   // nothing to pay
  assert.deepEqual([(await place((first.result as any).enrolment_id)).price_cents, (await place((first.result as any).enrolment_id)).price_basis], [0, "included"]);
  assert.match((await join(b, "Ann")).plan.summary.en, /included session 2 of 2/);
  const third = await join(e, "Ann");
  assert.equal(third.plan.summary.en, "Sign Ann up for Clinic E for $24.00 (member price).");
  assert.equal((third.result as any).payment_id !== undefined, true);
});

test("courses are never included, and kinds the plan doesn't name only get the discount", async () => {
  const course = await program("Beginner course", "course", 10000, { dates: 3 }), social = await program("Friday social", "social", 2000);
  assert.match((await join(course, "Dee")).plan.summary.en, /for \$80\.00 \(member price\)\.$/);
  assert.match((await join(social, "Dee")).plan.summary.en, /for \$16\.00 \(member price\)\.$/);
  assert.match((await join(await program("Saturday clinic", "clinic", 3000), "Dee")).plan.summary.en, /included session 1 of 2/);
});

test("a program's own member price wins over the plan's discount, and non-members see what members pay", async () => {
  const p = await program("Clinic M", "clinic", 3000, { member: 1800 }), q = await program("Clinic Q", "clinic", 3000);
  assert.equal((await join(p, "Cal")).plan.summary.en, "Sign Cal up for Clinic M for $18.00 (member price).");   // not $25.00 (Silver's $5 off)
  assert.equal((await join(q, "Cal")).plan.summary.en, "Sign Cal up for Clinic Q for $25.00 (member price).");
  const shown = await membersFrom(db, [{ id: p, price_cents: 3000, member_price_cents: 1800 }, { id: q, price_cents: 3000, member_price_cents: null }, { id: "x", price_cents: 0, member_price_cents: null }]);
  assert.deepEqual([shown.get(p), shown.get(q), shown.get("x")], [1800, 2400, null]);   // Gold's 20% beats Silver's $5
  await rejects(plan(db, "program.set_prices", { program_id: q, price_cents: 3000, member_price_cents: 4000 }, owner, opts), "error.member_price_higher");
});

test("changing prices keeps what people already agreed to, and says so", async () => {
  const p = await program("Clinic P", "clinic", 3000);
  const r = await join(p, "Bob");
  const change = await run(db, "program.set_prices", { program_id: p, price_cents: 4000, member_price_cents: 3000 }, owner, opts);
  assert.equal(change.plan.summary.en, "Set the price of Clinic P to $40.00. Members pay $30.00. 1 person has already signed up and keeps the price they agreed to.");
  assert.equal((await place((r.result as any).enrolment_id)).price_cents, 3000);
  assert.equal((await programPrice(db, p, people.Cal!, NOW)).cents, 3000);
});

test("leaving in time gives the included session back; leaving late doesn't", async () => {
  const early = await program("Clinic L1", "clinic", 3000, { startsIn: 100 }), late = await program("Clinic L2", "clinic", 3000, { startsIn: 10 });
  const e1 = (await join(early, "Dee")).result as any;   // Dee's 2nd included session
  assert.match((await join(late, "Dee")).plan.summary.en, /for \$24\.00 \(member price\)/);   // none left
  const left = await run(db, "enrolment.leave", { enrolment_id: e1.enrolment_id }, as("Dee"), opts);
  assert.equal(left.plan.summary.en, "Dee leaves Clinic L1. The included session goes back to the membership.");
  assert.equal((await programPrice(db, late, people.Dee!, NOW)).basis, "included");   // one free again
  const l3 = await program("Clinic L3", "clinic", 3000, { startsIn: 10 });
  const e3 = (await join(l3, "Dee")).result as any;
  const gone = await run(db, "enrolment.leave", { enrolment_id: e3.enrolment_id }, as("Dee"), opts);
  assert.equal(gone.plan.summary.en, "Dee leaves Clinic L3. The included session isn't given back, so it still counts this period.");
  assert.equal((await programPrice(db, late, people.Dee!, NOW)).basis, "member");
});

test("included sessions start again each membership period; a paused membership gives nothing", async () => {
  const p = await program("Clinic N", "clinic", 3000, { startsIn: 24 * 35 });
  assert.equal((await programPrice(db, p, people.Ann!, NOW)).basis, "member");                       // Ann used both in December
  assert.equal((await programPrice(db, p, people.Ann!, new Date("2027-01-01T18:00:00Z"))).basis, "included");   // a new period from 1 January
  const m = (await db.selectFrom("membership").select("id").where("person_id", "=", people.Cal!).executeTakeFirstOrThrow()).id;
  await run(db, "membership.pause", { membership_id: m, until: "2026-12-20" }, owner, opts);
  assert.equal((await programPrice(db, p, people.Cal!, NOW)).basis, "full");
});

test("a waitlist place is held at the member price, and takes an included session when it becomes a real place", async () => {
  const p = await program("Clinic W", "clinic", 3000, { capacity: 1, startsIn: 24 * 40 });
  await join(p, "Bob");
  const w = (await join(p, "Ann", new Date("2027-01-02T18:00:00Z"))).result as any;
  assert.deepEqual([(await place(w.enrolment_id)).status, (await place(w.enrolment_id)).price_basis, (await place(w.enrolment_id)).price_cents], ["waitlisted", "member", 2400]);
  const bob = await db.selectFrom("enrolment").select("id").where("program_id", "=", p).where("person_id", "=", people.Bob!).executeTakeFirstOrThrow();
  const jan = { now: new Date("2027-01-02T19:00:00Z") };
  await run(db, "enrolment.leave", { enrolment_id: bob.id }, { personId: people.Bob!, via: "test", lang: "en" }, jan);
  const take = await run(db, "enrolment.accept_offer", { enrolment_id: w.enrolment_id }, as("Ann"), jan);
  assert.equal(take.plan.summary.en, "Ann takes the offered place in Clinic W at no charge: included session 1 of 2 in the membership this period.");
  assert.deepEqual([(await place(w.enrolment_id)).price_basis, (await place(w.enrolment_id)).price_cents], ["included", 0]);
});

test("the membership's welcome says what it gives on programs", async () => {
  await processOutbox(db, messageHandlers);
  const msg = await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Ann!).where("kind", "=", "membership_started").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.match(msg.body, /You get 20% off clinics and other programs\. 2 sessions are included each month \(clinic\)\./);
});
