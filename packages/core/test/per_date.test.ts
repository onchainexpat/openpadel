import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { decidePrograms, messageHandlers, plan, processOutbox, run, runAsSystem, KumiError, type Actor, type Db } from "../src/index.ts";

// A weekly drop-in clinic signed up per date: each date has its own places, waitlist, watches and minimum.
let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string, clinic: string, d: string[] = [];
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const opts = { now: NOW };
const at = (s: string) => new Date(`${s}-08:00`);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function program(name: string, o: { kind?: string; capacity?: number; price?: number; min?: number; sign_up?: string } = {}) {
  return ((await run(db, "program.create", { location_id: loc, kind: o.kind ?? "clinic", name, capacity: o.capacity ?? 2, price_cents: o.price ?? 2500,
    sign_up: o.sign_up ?? "per_session", ...(o.min ? { min_players: o.min, decide_hours: 24 } : {}) }, owner, opts)).result as { program_id: string }).program_id;
}
const weekly = async (programId: string, start: string, weeks: number, court: string) =>
  ((await run(db, "session.add", { program_id: programId, starts_at: at(start).toISOString(), ends_at: new Date(at(start).getTime() + 90 * 60_000).toISOString(), court_ids: [court], weeks }, owner, opts)).result as { session_ids: string[] }).session_ids;
const place = (programId: string, who: string, sessionId: string) => db.selectFrom("enrolment").selectAll().where("program_id", "=", programId).where("person_id", "=", people[who]!)
  .where("session_id", "=", sessionId).where("status", "in", ["booked", "waitlisted"]).executeTakeFirst();
const deliver = () => processOutbox(db, messageHandlers);
const inbox = (who: string) => db.selectFrom("outbound_message").select(["kind", "subject", "body"]).where("person_id", "=", people[who]!).where("channel", "=", "inbox").orderBy("created_at").execute();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  [c1, c2] = await Promise.all(["Court 1", "Court 2"].map(async (name) => ((await run(db, "court.create", { location_id: loc, name }, owner, opts)).result as any).court_id as string)) as [string, string];
  for (const name of ["Ann", "Bob", "Cal", "Dee", "Eve"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  // Ann's plan: 20% off programs and two clinics included each month.
  const gold = ((await run(db, "membership.plan_set", { name: "Gold", price_cents: 12000, period: "month", program_percent_off: 20, included_sessions: 2, included_kinds: ["clinic"] }, owner, opts)).result as any).plan_id;
  await run(db, "membership.grant", { person_id: people.Ann, plan_id: gold }, owner, opts);
  clinic = await program("Tuesday drop-in");
  d = await weekly(clinic, "2026-12-01T18:00", 3, c1);
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
  await deliver();
});
after(async () => drop());

test("only clinics and socials are signed up date by date, and the preview says so", async () => {
  await rejects(plan(db, "program.create", { location_id: loc, kind: "course", name: "Course", capacity: 4, price_cents: 1000, sign_up: "per_session" }, owner, opts), "error.per_date_kinds");
  const p = await plan(db, "program.create", { location_id: loc, kind: "social", name: "Friday social", capacity: 8, price_cents: 1500, sign_up: "per_session", min_players: 4 }, owner, opts);
  assert.match(p.plan.summary.en, /People sign up date by date: each date has its own places, waitlist and minimum\./);
  assert.match(p.plan.summary.en, /Each date needs at least 4 to run/);
});

test("several dates in one go: included sessions in date order, then the member price, in one payment", async () => {
  const r = await run(db, "enrolment.join_dates", { program_id: clinic, person_id: people.Ann, session_ids: [d[2]!, d[0]!, d[1]!] }, as("Ann"), opts);
  assert.equal(r.plan.summary.en, "Sign Ann up for 3 dates of Tuesday drop-in: Tue, Dec 1, 6:00 PM at no charge: included session 1 of 2 in the membership this period."
    + " Tue, Dec 8, 6:00 PM at no charge: included session 2 of 2 in the membership this period. Tue, Dec 15, 6:00 PM for $20.00 (member price). $20.00 to pay now, in one card payment.");
  assert.equal(r.plan.moneyCents, 2000);
  const pays = await db.selectFrom("payment").select(["amount_cents", "group_id"]).where("person_id", "=", people.Ann!).execute();
  assert.deepEqual(pays.map((x) => [x.amount_cents, x.group_id]), [[2000, null]]);   // one date to pay for: no group needed
  // A program signed up as a whole can't be joined by date, and a date must be named here.
  await rejects(plan(db, "enrolment.join", { program_id: clinic, person_id: people.Bob }, as("Bob"), opts), "error.pick_a_date");
  await rejects(plan(db, "enrolment.join_dates", { program_id: clinic, person_id: people.Ann, session_ids: [d[0]!] }, as("Ann"), opts), "error.already_on_date");
});

test("Bob pays for two dates in one card payment, and hears once", async () => {
  const r = await run(db, "enrolment.join_dates", { program_id: clinic, person_id: people.Bob, session_ids: [d[0]!, d[1]!] }, as("Bob"), opts);
  const pays = await db.selectFrom("payment").select(["id", "amount_cents", "group_id"]).where("person_id", "=", people.Bob!).orderBy("id").execute();
  assert.equal(pays.length, 2);
  assert.ok(pays[0]!.group_id && pays[0]!.group_id === pays[1]!.group_id);
  await runAsSystem(db, "payment.settle", { payment_id: (r.result as any).payment_id, outcome: "succeeded" }, "test", opts);
  const paid = await db.selectFrom("enrolment").select("paid_by").where("person_id", "=", people.Bob!).execute();
  assert.deepEqual(paid.map((x) => x.paid_by), ["card", "card"]);
  await deliver();
  const msgs = (await inbox("Bob")).filter((m) => m.kind === "dates_paid" || m.kind === "paid");
  assert.deepEqual(msgs.map((m) => m.body), ["We have your $50.00 for Tuesday drop-in: Tue, Dec 1, 6:00 PM; Tue, Dec 8, 6:00 PM. You're in for each of them."]);
});

test("each date fills on its own: a full date puts Cal on that date's waitlist, a date with room books him", async () => {
  const first = await run(db, "enrolment.join", { program_id: clinic, person_id: people.Cal, session_id: d[0] }, as("Cal"), opts);
  assert.equal(first.plan.summary.en, "Put Cal on the waitlist for Tuesday drop-in (number 1). Date: Tue, Dec 1, 6:00 PM.");
  const two = await run(db, "enrolment.join_dates", { program_id: clinic, person_id: people.Cal, session_ids: [d[1]!, d[2]!] }, as("Cal"), opts);
  assert.match(two.plan.summary.en, /Tue, Dec 8, 6:00 PM: full, so the waitlist \(number 1\)\. Tue, Dec 15, 6:00 PM for \$25\.00\. \$25\.00 to pay now/);
  await runAsSystem(db, "payment.settle", { payment_id: (two.result as any).payment_id, outcome: "succeeded" }, "test", opts);
  assert.equal((await place(clinic, "Cal", d[0]!))!.status, "waitlisted");
  assert.equal((await place(clinic, "Cal", d[2]!))!.status, "booked");
});

test("leaving one date frees that date only: its waitlist is offered the place, the other dates stay as they were", async () => {
  const bob = (await place(clinic, "Bob", d[0]!))!;
  const leave = await run(db, "enrolment.leave", { enrolment_id: bob.id }, as("Bob"), opts);
  assert.match(leave.plan.summary.en, /\$25\.00/);   // 34 hours before: all of it back
  assert.match(leave.plan.summary.en, /Cal/);        // offered to Cal, first on that date's waitlist
  const cal = (await place(clinic, "Cal", d[0]!))!;
  assert.ok(await db.selectFrom("waitlist_offer").select("id").where("enrolment_id", "=", cal.id).where("outcome", "is", null).executeTakeFirst());
  const calLater = (await place(clinic, "Cal", d[1]!))!;
  assert.equal(await db.selectFrom("waitlist_offer").select("id").where("enrolment_id", "=", calLater.id).executeTakeFirst(), undefined);   // not the 8th's
  assert.equal((await place(clinic, "Bob", d[1]!))!.status, "booked");
  const back = await db.selectFrom("refund").select("amount_cents").where("enrolment_id", "=", bob.id).execute();
  assert.deepEqual(back.map((x) => x.amount_cents), [2500]);
});

test("a full date can be watched; it's told only when that date has a place nobody on its waitlist takes", async () => {
  await run(db, "program.watch", { program_id: clinic, person_id: people.Eve, session_id: d[1] }, as("Eve"), opts);
  // Cal stops waiting for the 8th, then Bob gives up his place on it: nobody waiting, so Eve hears.
  await run(db, "enrolment.leave", { enrolment_id: (await place(clinic, "Cal", d[1]!))!.id }, as("Cal"), opts);
  await run(db, "enrolment.leave", { enrolment_id: (await place(clinic, "Bob", d[1]!))!.id }, as("Bob"), opts);
  const w = await db.selectFrom("program_watch").select(["told_at", "session_id"]).where("person_id", "=", people.Eve!).executeTakeFirstOrThrow();
  assert.ok(w.told_at);
  assert.equal(w.session_id, d[1]);
  await deliver();
  assert.match((await inbox("Eve")).find((m) => m.kind === "place_open")!.body, /Tue, Dec 8, 6:00 PM/);
});

test("staff give a free place on one date, and more places on a date go to its waitlist first", async () => {
  await rejects(plan(db, "enrolment.comp", { program_id: clinic, person_id: people.Dee, note: "Gift", session_id: d[0] }, owner, opts), "error.program_full");
  await run(db, "enrolment.comp", { program_id: clinic, person_id: people.Dee, note: "Gift", session_id: d[1] }, owner, opts);
  assert.equal((await place(clinic, "Dee", d[1]!))!.paid_by, "comp");
  // The 15th gets 3 places: still room, nobody waiting there.
  const e = await run(db, "series.edit", { session_id: d[2], scope: "this", capacity: 3 }, owner, opts);
  assert.match(e.plan.summary.en, /1 date gets 3 places\./);
  assert.equal((await db.selectFrom("session").select("capacity_override").where("id", "=", d[2]!).executeTakeFirstOrThrow()).capacity_override, 3);
  await rejects(plan(db, "series.edit", { session_id: d[1], scope: "this", capacity: 1 }, owner, opts), "error.capacity_below_date");
});

test("cancelling one date pays back everyone on it in full; the rest of the program goes on", async () => {
  const c = await run(db, "series.cancel", { session_id: d[2], scope: "this" }, owner, opts);
  assert.match(c.plan.summary.en, /\$25\.00/);   // Cal paid $25; Ann's $20 wasn't paid yet
  for (const who of ["Ann", "Cal"]) assert.equal(await place(clinic, who, d[2]!), undefined);
  assert.equal((await db.selectFrom("program").select("status").where("id", "=", clinic).executeTakeFirstOrThrow()).status, "published");
  assert.equal((await place(clinic, "Ann", d[0]!))!.status, "booked");
  assert.deepEqual((await db.selectFrom("refund").innerJoin("enrolment", "enrolment.id", "refund.enrolment_id").select("refund.amount_cents").where("enrolment.person_id", "=", people.Cal!)
    .where("enrolment.session_id", "=", d[2]!).execute()).map((x) => x.amount_cents), [2500]);
  const annRefund = await db.selectFrom("refund").innerJoin("enrolment", "enrolment.id", "refund.enrolment_id").select("refund.amount_cents").where("enrolment.person_id", "=", people.Ann!).execute();
  assert.deepEqual(annRefund.map((x) => x.amount_cents), []);   // Ann's $20 wasn't paid yet: her payment is called off instead
  const annPay = await db.selectFrom("payment").select("status").where("person_id", "=", people.Ann!).executeTakeFirstOrThrow();
  assert.equal(annPay.status, "failed");
});

test("each date's minimum is decided before that date: a short one is cancelled alone", async () => {
  const social = await program("Friday social", { kind: "social", capacity: 8, price: 1500, min: 2 });
  const [f1, f2] = await weekly(social, "2026-12-04T19:00", 2, c2);
  await run(db, "program.publish", { program_id: social }, owner, opts);
  await run(db, "enrolment.join", { program_id: social, person_id: people.Dee, session_id: f1 }, as("Dee"), opts);
  await run(db, "enrolment.join_dates", { program_id: social, person_id: people.Eve, session_ids: [f2!] }, as("Eve"), opts);
  await run(db, "enrolment.join_dates", { program_id: social, person_id: people.Dee, session_ids: [f2!] }, as("Dee"), opts);
  // A day before the 4th: it has 1 of 2, so it's off. The 11th isn't decided yet.
  const r = await decidePrograms(db, at("2026-12-03T20:00"));
  assert.deepEqual(r, { cancelled: 1, ran: 0, warned: 0 });
  const s = await db.selectFrom("session").select(["id", "status", "min_decided_at"]).where("program_id", "=", social).orderBy("starts_at").execute();
  assert.deepEqual(s.map((x) => [x.status, Boolean(x.min_decided_at)]), [["cancelled", true], ["scheduled", false]]);
  assert.equal((await db.selectFrom("program").select("status").where("id", "=", social).executeTakeFirstOrThrow()).status, "published");
  assert.deepEqual(await decidePrograms(db, at("2026-12-10T20:00")), { cancelled: 0, ran: 1, warned: 0 });
});

test("how people sign up can't change once someone has", async () => {
  await rejects(plan(db, "program.set_sign_up", { program_id: clinic, sign_up: "whole_program" }, owner, opts), "error.sign_up_fixed");
  const fresh = await program("Thursday drills", { sign_up: "whole_program" });
  const r = await run(db, "program.set_sign_up", { program_id: fresh, sign_up: "per_session" }, owner, opts);
  assert.equal(r.plan.summary.en, "People sign up for Thursday drills date by date: each date has its own places, waitlist and minimum.");
  await rejects(plan(db, "program.set_sign_up", { program_id: await program("Course", { kind: "course", sign_up: "whole_program" }), sign_up: "per_session" }, owner, opts), "error.per_date_kinds");
});
