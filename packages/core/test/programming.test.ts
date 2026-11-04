import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { decidePrograms, exportData, localParts, messageHandlers, plan, processOutbox, run, runAsSystem, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string, c3: string, course: string;
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const opts = { now: NOW };
const at = (s: string) => new Date(`${s}-08:00`);   // a Pacific winter time, "2026-12-02T18:00"
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: RegExp) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.match(e.text.en, text); return true; });
}
async function join(programId: string, who: string) {
  const r = (await run(db, "enrolment.join", { program_id: programId, person_id: people[who] }, as(who), opts)).result as { enrolment_id: string; status: string; payment_id?: string };
  if (r.payment_id) await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test", opts);
  return r;
}
async function program(name: string, o: { kind?: string; capacity?: number; price?: number; min?: number; level?: [number, number] } = {}) {
  return ((await run(db, "program.create", { location_id: loc, kind: o.kind ?? "clinic", name, capacity: o.capacity ?? 8, price_cents: o.price ?? 0,
    ...(o.min ? { min_players: o.min } : {}), ...(o.level ? { level_min: o.level[0], level_max: o.level[1] } : {}) }, owner, opts)).result as { program_id: string }).program_id;
}
const addDate = async (programId: string, start: string, minutes: number, courts: string[], extra: Record<string, unknown> = {}) =>
  (await run(db, "session.add", { program_id: programId, starts_at: at(start).toISOString(), ends_at: new Date(at(start).getTime() + minutes * 60_000).toISOString(), court_ids: courts, ...extra }, owner, opts)).result as { session_id: string; session_ids: string[] };
const dates = (programId: string) => db.selectFrom("session").select(["id", "starts_at", "ends_at", "status", "coach_id"]).where("program_id", "=", programId).orderBy("starts_at").execute();
const courtsOf = async (sessionId: string) => (await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").select("court.name").where("session_id", "=", sessionId).where("active", "=", true).execute()).map((c) => c.name);
const deliver = () => processOutbox(db, messageHandlers);
const inbox = (who: string) => db.selectFrom("outbound_message").select(["kind", "subject", "body"]).where("person_id", "=", people[who] ?? who).where("channel", "=", "inbox").orderBy("created_at").execute();
const refunds = (who: string, programId: string) => db.selectFrom("refund").innerJoin("enrolment", "enrolment.id", "refund.enrolment_id").select(["refund.amount_cents"])
  .where("enrolment.person_id", "=", people[who]!).where("enrolment.program_id", "=", programId).execute();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  people.Robin = owner.personId!;
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  [c1, c2, c3] = await Promise.all(["Court 1", "Court 2", "Court 3"].map(async (name) => ((await run(db, "court.create", { location_id: loc, name }, owner, opts)).result as any).court_id as string)) as [string, string, string];
  for (const name of ["Ann", "Ben", "Cal", "Dee", "Eve", "Kim"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Kim, role: "coach" }, owner, opts);
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: "Kim coaches.", level_min: 1, level_max: 5, languages: ["en"], rates: [{ minutes: 60, cents: 9000 }], lessons: true, max_players: 4 }, as("Kim"), opts);
  // A course paid once: three Wednesdays, Kim runs it, two places.
  course = await program("Winter course", { kind: "course", capacity: 2, price: 9000, level: [3, 4] });
  await addDate(course, "2026-12-02T18:00", 90, [c1], { coach_id: people.Kim, weeks: 3 });
  await deliver();
});
after(async () => drop());

test("a date repeated each week keeps its club time across a clock change", async () => {
  const p = await program("Spring drills");
  const r = await addDate(p, "2027-03-04T18:00", 60, [c2], { weeks: 3 });
  assert.equal(r.session_ids.length, 3);
  const ds = await dates(p);
  assert.deepEqual(ds.map((d) => localParts(new Date(d.starts_at), TZ).h), [18, 18, 18]);   // 14 March 2027 the clocks go forward
  assert.deepEqual(ds.map((d) => new Date(d.starts_at).getUTCHours()), [2, 2, 1]);
});

test("before publishing: what members will see, and each date with its courts and coach", async () => {
  const p = await plan(db, "program.publish", { program_id: course }, owner, opts);
  assert.match(p.plan.summary.en, /^Publish Winter course so players can sign up\. Members will see it as a course at \$90\.00, with 2 places\. It has 3 dates: Wed, Dec 2, 6:00 PM, on Court 1, with Kim\./);
  await run(db, "program.publish", { program_id: course }, owner, opts);
  await rejects(plan(db, "program.publish", { program_id: course }, owner, opts), "error.not_draft");
  for (const who of ["Ann", "Ben"]) assert.equal((await join(course, who)).status, "booked");
});

test("a coach away on a date blocks publishing it, and adding it", async () => {
  await run(db, "coach.time_off_add", { person_id: people.Kim, from: "2026-12-21", to: "2026-12-21", note: "Away" }, as("Kim"), opts);
  await rejects(addDate(await program("Monday drills"), "2026-12-21T10:00", 60, [c2], { coach_id: people.Kim }), "error.dates_clash", /Kim is off at Mon, Dec 21, 10:00 AM\./);
  const p = await program("Tuesday drills");
  const d = await addDate(p, "2026-12-22T10:00", 60, [c2], { coach_id: people.Kim });
  await run(db, "coach.time_off_add", { person_id: people.Kim, from: "2026-12-22", to: "2026-12-22" }, as("Kim"), opts);
  await rejects(plan(db, "program.publish", { program_id: p }, owner, opts), "error.dates_clash", /Kim is off at Tue, Dec 22/);
  void d;
});

test("this date and the ones after it: a new time, the earlier date as it was, the players told", async () => {
  // Another clinic for anyone, at the new time: worth a word, not in the way.
  await addDate(await program("Evening social"), "2026-12-09T19:00", 60, [c3]);
  const [first, second] = await dates(course);
  const p = await plan(db, "series.edit", { session_id: second!.id, scope: "following", start_time: "19:00" }, owner, opts);
  assert.match(p.plan.summary.en, /^Change this date and the ones after it of Winter course \(2 dates\): Wed, Dec 9, 6:00 PM becomes Wed, Dec 9, 7:00 PM, 90 minutes, on Court 1, with Kim\./);
  assert.match(p.plan.summary.en, /Signed up \(2\): Ann, Ben\. They're told\. Worth knowing: Evening social is on at the same time \(Wed, Dec 9, 7:00 PM\), for the same players\.$/);
  await run(db, "series.edit", { session_id: second!.id, scope: "following", start_time: "19:00" }, owner, opts);
  const ds = await dates(course);
  assert.deepEqual(ds.map((d) => localParts(new Date(d.starts_at), TZ).h), [18, 19, 19]);
  assert.equal(ds[0]!.id, first!.id);
  await deliver();
  const m = (await inbox("Ann")).find((x) => x.kind === "dates_changed")!;
  assert.equal(m.subject, "Winter course: dates changed");
  assert.match(m.body, /^The club changed Winter course\. Wed, Dec 9, 6:00 PM becomes Wed, Dec 9, 7:00 PM.*Your place stays as it is\.$/);
});

test("what's in the way blocks a change, with why; dates that have started can't change", async () => {
  const [first] = await dates(course);
  await run(db, "court.block", { court_ids: [c3], starts_at: at("2026-12-02T17:00").toISOString(), ends_at: at("2026-12-02T20:00").toISOString(), reason: "maintenance" }, owner, opts);
  await rejects(plan(db, "series.edit", { session_id: first!.id, scope: "this", court_ids: [c3] }, owner, opts), "error.dates_clash", /Court 3 is blocked at Wed, Dec 2, 6:00 PM\./);
  await rejects(plan(db, "series.edit", { session_id: first!.id, scope: "all", starts_at: at("2026-12-03T18:00").toISOString() }, owner, opts), "error.new_date_one_only");
  await rejects(plan(db, "series.edit", { session_id: first!.id, scope: "this", minutes: 90 }, owner, opts), "error.nothing_changed");
  await rejects(plan(db, "series.edit", { session_id: first!.id, scope: "this", start_time: "19:00" }, owner, { now: at("2026-12-02T18:30") }), "error.date_started");
});

test("one date moved to another day and court, then undone: back as it was, and the players hear", async () => {
  const third = (await dates(course))[2]!;
  const r = await run(db, "series.edit", { session_id: third.id, scope: "this", starts_at: at("2026-12-17T19:00").toISOString(), court_ids: [c2] }, owner, opts);
  assert.match(r.plan.summary.en, /^Change one date of Winter course: Wed, Dec 16, 7:00 PM becomes Thu, Dec 17, 7:00 PM, 90 minutes, on Court 2, with Kim\./);
  assert.deepEqual(await courtsOf(third.id), ["Court 2"]);
  await run(db, "action.undo", { run_id: r.runId }, owner, opts);
  const back = (await dates(course))[2]!;
  assert.equal(new Date(back.starts_at).getTime(), at("2026-12-16T19:00").getTime());
  assert.deepEqual(await courtsOf(third.id), ["Court 1"]);
  await deliver();
  const m = (await inbox("Ben")).filter((x) => x.kind.startsWith("dates_")).map((x) => [x.kind, x.body]);
  assert.deepEqual(m.at(-1), ["dates_restored", "The club undid its change to Winter course. It's back to: Wed, Dec 16, 7:00 PM, 90 minutes, on Court 1, with Kim."]);
});

test("watching a full program: the waitlist is offered places first, then whoever watches hears once", async () => {
  assert.equal((await join(course, "Cal")).status, "waitlisted");
  await rejects(plan(db, "program.watch", { program_id: course, person_id: people.Ann }, as("Ann"), opts), "error.already_signed_up");
  await rejects(plan(db, "program.watch", { program_id: course, person_id: people.Cal }, as("Cal"), opts), "error.already_signed_up");
  const w = await run(db, "program.watch", { program_id: course, person_id: people.Dee }, as("Dee"), opts);
  assert.match(w.plan.summary.en, /^Tell Dee once when a place opens in Winter course\./);
  await rejects(plan(db, "program.watch", { program_id: course, person_id: people.Dee }, as("Dee"), opts), "error.already_watching");
  const [first] = await dates(course);
  // One more place: Cal, waiting, is offered it; Dee hears nothing yet.
  await run(db, "series.edit", { session_id: first!.id, scope: "all", capacity: 3 }, owner, opts);
  assert.equal((await db.selectFrom("waitlist_offer").select("id").execute()).length, 1);
  assert.equal((await db.selectFrom("program_watch").select("told_at").where("person_id", "=", people.Dee!).executeTakeFirstOrThrow()).told_at, null);
  // Another: nobody else is waiting, so it's open to anyone, and Dee hears it, once.
  await run(db, "series.edit", { session_id: first!.id, scope: "all", capacity: 4 }, owner, opts);
  assert.ok((await db.selectFrom("program_watch").select("told_at").where("person_id", "=", people.Dee!).executeTakeFirstOrThrow()).told_at);
  await rejects(plan(db, "program.watch", { program_id: course, person_id: people.Eve }, as("Eve"), opts), "error.places_open");
  await rejects(plan(db, "series.edit", { session_id: first!.id, scope: "all", capacity: 1 }, owner, opts), "error.capacity_below", /^3 places are taken/);
  await deliver();
  const m = (await inbox("Dee")).filter((x) => x.kind === "place_open");
  assert.deepEqual(m.map((x) => x.body), ["A place opened in Winter course, Wed, Dec 2, 6:00 PM. Nobody on the waitlist took it, so it goes to whoever signs up first in the app."]);
});

test("a watch ends when the person signs up", async () => {
  const p = await program("Small clinic", { capacity: 1 });
  await addDate(p, "2026-12-05T09:00", 60, [c2]);
  await run(db, "program.publish", { program_id: p }, owner, opts);
  await join(p, "Ann");
  await run(db, "program.watch", { program_id: p, person_id: people.Eve }, as("Eve"), opts);
  await join(p, "Eve");   // the waitlist
  const w = await db.selectFrom("program_watch").select(["told_at", "ended_at"]).where("program_id", "=", p).executeTakeFirstOrThrow();
  assert.equal(w.told_at, null); assert.ok(w.ended_at);
});

test("cancelling one date of a course pays back that date's share; a refund other than that needs a note", async () => {
  const [first] = await dates(course);
  await rejects(plan(db, "series.cancel", { session_id: first!.id, scope: "this", refund: "full" }, owner, opts), "error.refund_note_needed");
  const r = await run(db, "series.cancel", { session_id: first!.id, scope: "this" }, owner, opts);
  assert.match(r.plan.summary.en, /^Cancel one date of Winter course: Wed, Dec 2, 6:00 PM\. 2 people get money back, \$60\.00 in all\./);
  assert.deepEqual((await refunds("Ann", course)).map((x) => x.amount_cents), [3000]);
  assert.equal((await dates(course))[0]!.status, "cancelled");
  assert.equal((await db.selectFrom("program").select("status").where("id", "=", course).executeTakeFirstOrThrow()).status, "published");
  assert.equal((await db.selectFrom("court_time").select("id").where("session_id", "=", first!.id).where("active", "=", true).execute()).length, 0);
  await deliver();
  const m = (await inbox("Ann")).find((x) => x.kind === "dates_cancelled")!;
  assert.equal(m.body, "The club cancelled these dates of Winter course: Wed, Dec 2, 6:00 PM. $30.00 goes back to your card.");
});

test("cancelling one date of a course: a place not paid for yet comes down to the dates left", async () => {
  const spring = await program("Spring course", { kind: "course", capacity: 2, price: 9000 });
  await addDate(spring, "2026-12-04T10:00", 90, [c3], { weeks: 3 });
  await run(db, "program.publish", { program_id: spring }, owner, opts).catch(() => null);
  people.Fay = ((await run(db, "person.create", { display_name: "Fay", email: "fay@example.test" }, owner, opts)).result as any).person_id;
  const r = (await run(db, "enrolment.join", { program_id: spring, person_id: people.Fay }, as("Fay"), opts)).result as { enrolment_id: string; payment_id?: string };
  assert.ok(r.payment_id);   // owed, not paid
  const [first] = await dates(spring);
  const c = await run(db, "series.cancel", { session_id: first!.id, scope: "this" }, owner, opts);
  assert.match(c.plan.summary.en, / 1 place not paid for yet now costs less, for the dates left\./);
  assert.equal((await db.selectFrom("enrolment").select("price_cents").where("id", "=", r.enrolment_id).executeTakeFirstOrThrow()).price_cents, 6000);
  // Asked again for the new price, never the same payment for less (a card form opening now can't pay the old amount).
  assert.deepEqual((await db.selectFrom("payment").select(["amount_cents", "status"]).where("enrolment_id", "=", r.enrolment_id).orderBy("created_at").execute()).map((p) => [p.amount_cents, p.status]),
    [[9000, "failed"], [6000, "pending"]]);
  assert.equal((await refunds("Fay", spring)).length, 0);   // nothing was paid, so nothing goes back
});

test("cancelling a program altogether: everyone paid back, the waitlist told, places no longer payable", async () => {
  const p = await program("Friday clinic", { capacity: 2, price: 2500 });
  await addDate(p, "2026-12-11T18:00", 60, [c2]);
  await run(db, "program.publish", { program_id: p }, owner, opts);
  await join(p, "Ann"); await join(p, "Ben");
  assert.equal((await join(p, "Cal")).status, "waitlisted");
  const r = await run(db, "program.cancel", { program_id: p }, owner, opts);
  assert.match(r.plan.summary.en, /^Cancel Friday clinic altogether\. Fri, Dec 11, 6:00 PM\. 2 people get money back, \$50\.00 in all\. 3 people are told\.$/);
  assert.equal(r.plan.undo.kind, "none");
  const pr = await db.selectFrom("program").select(["status", "cancel_reason"]).where("id", "=", p).executeTakeFirstOrThrow();
  assert.deepEqual([pr.status, pr.cancel_reason], ["cancelled", "club"]);
  assert.deepEqual((await db.selectFrom("enrolment").select("status").where("program_id", "=", p).execute()).map((e) => e.status), ["cancelled", "cancelled", "cancelled"]);
  assert.deepEqual((await refunds("Ben", p)).map((x) => x.amount_cents), [2500]);
  await deliver();
  assert.equal((await inbox("Ann")).find((x) => x.kind === "program_cancelled")!.body, "The club cancelled Friday clinic, Fri, Dec 11, 6:00 PM. $25.00 goes back to your card.");
  assert.equal((await inbox("Cal")).find((x) => x.kind === "program_cancelled")!.body, "The club cancelled Friday clinic, Fri, Dec 11, 6:00 PM. You were on its waitlist, so there's nothing to pay back.");
});

test("a minimum: staff hear once when it's short, then at the decision time it's cancelled and everyone paid back", async () => {
  const p = await program("Saturday social", { kind: "social", capacity: 8, price: 2000, min: 4 });
  const c = await plan(db, "program.create", { location_id: loc, kind: "social", name: "x", capacity: 8, price_cents: 0, min_players: 4 }, owner, opts);
  assert.match(c.plan.summary.en, /It needs at least 4 to run: if fewer have signed up 24 hours before it starts, it's cancelled and everyone gets their money back\.$/);
  await rejects(plan(db, "program.set_minimum", { program_id: p, min_players: 9 }, owner, opts), "error.min_over_capacity");
  await addDate(p, "2026-12-12T10:00", 120, [c3]);
  await run(db, "program.publish", { program_id: p }, owner, opts);
  await join(p, "Ann"); await join(p, "Ben");
  // A second program that has enough: it runs.
  const q = await program("Sunday social", { kind: "social", capacity: 8, min: 2 });
  await addDate(q, "2026-12-13T10:00", 120, [c3]);
  await run(db, "program.publish", { program_id: q }, owner, opts);
  await join(q, "Ann"); await join(q, "Ben");
  // Decided 24 hours before (Fri 10 am); staff hear 24 hours before that.
  assert.deepEqual(await decidePrograms(db, at("2026-12-10T09:00")), { cancelled: 0, ran: 0, warned: 0 });
  assert.deepEqual(await decidePrograms(db, at("2026-12-10T11:00")), { cancelled: 0, ran: 0, warned: 1 });
  assert.deepEqual(await decidePrograms(db, at("2026-12-10T12:00")), { cancelled: 0, ran: 0, warned: 0 });   // said once
  await deliver();
  const short = (await inbox("Robin")).filter((x) => x.kind === "program_min_short");
  assert.deepEqual(short.map((x) => x.subject), ["Saturday social needs 2 more to run"]);
  assert.equal(short[0]!.body, "Saturday social, Sat, Dec 12, 10:00 AM, has 2 of the 4 it needs. If it's still short at Fri, Dec 11, 10:00 AM, it's cancelled and everyone is paid back. A message to members can help fill it.");
  assert.deepEqual(await decidePrograms(db, at("2026-12-11T10:30")), { cancelled: 1, ran: 0, warned: 0 });
  const pr = await db.selectFrom("program").select(["status", "cancel_reason", "min_decided_at"]).where("id", "=", p).executeTakeFirstOrThrow();
  assert.deepEqual([pr.status, pr.cancel_reason, Boolean(pr.min_decided_at)], ["cancelled", "below_minimum", true]);
  assert.deepEqual((await refunds("Ann", p)).map((x) => x.amount_cents), [2000]);
  assert.deepEqual(await decidePrograms(db, at("2026-12-12T10:30")), { cancelled: 0, ran: 1, warned: 0 });   // Sunday's runs
  assert.equal((await db.selectFrom("program").select("status").where("id", "=", q).executeTakeFirstOrThrow()).status, "published");
  assert.deepEqual(await decidePrograms(db, at("2026-12-12T11:00")), { cancelled: 0, ran: 0, warned: 0 });
  await deliver();
  assert.equal((await inbox("Ann")).find((x) => x.kind === "program_cancelled_minimum")!.body, "Saturday social, Sat, Dec 12, 10:00 AM, didn't get enough players to run, so it's cancelled. $20.00 goes back to your card.");
  assert.deepEqual((await inbox("Robin")).filter((x) => x.kind === "program_min_cancelled_staff").map((x) => x.body),
    ["Saturday social, Sat, Dec 12, 10:00 AM, had 2 of the 4 it needed, so it was cancelled. Everyone signed up is paid back and told."]);
});

test("a watch is in the person's data file, and goes with their account", async () => {
  const file = await exportData(db, people.Dee!, NOW, "en") as any;
  assert.deepEqual(file.place_watches.map((w: any) => [w.program, Boolean(w.told_at)]), [["Winter course", true]]);
  await run(db, "privacy.erase", { person_id: people.Dee }, as("Dee"), opts);
  assert.equal((await db.selectFrom("program_watch").select("id").where("person_id", "=", people.Dee!).execute()).length, 0);
});
