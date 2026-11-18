// Moving in from CourtReserve or Playbypoint (move_files.ts, move_read.ts): the files the club exports there, read by
// the server, then members, memberships, club credit, upcoming bookings and program sign-ups, each a preview first.
// Fixtures are built from the columns each system documents (fixtures/move/README.md), and a messy one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb } from "./helpers.ts";
import { apply, appOnly, creditBalance, getAction, KumiError, moveFilesStatus, plan, readMoveFile, readPeopleCell, readWhen, run, runAsSystem, type Actor, type Db, type MovePerson, type MoveBooking } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, manager: Actor, loc: string, c1: string, c2: string, gold: string, junior: string, founding: string;
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-18T18:00:00Z"), opts = { now: NOW };
const file = (name: string) => readFileSync(new URL(`./fixtures/move/${name}`, import.meta.url), "utf8");
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function upload(from: string, kind: string, name: string) {
  const r = await run(db, "move.upload", { from, kind, csv: file(name), file_name: name }, owner, opts);
  return { ...(r.result as { upload_id: string; sha256: string }), summary: r.plan.summary };
}
const ref = (u: { upload_id: string; sha256: string }) => ({ upload_id: u.upload_id, sha256: u.sha256 });
const personBy = async (email: string) => db.selectFrom("person").selectAll().where("email", "=", email).executeTakeFirst();
const ledger = async (kind: string) => Number((await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id")
  .select((eb) => eb.fn.sum<string>("ledger_entry.amount_cents").as("c")).where("ledger_account.kind", "=", kind).executeTakeFirst())?.c ?? 0);

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner, opts)).result as any).court_id;
  // Ann is a member here already, under the same address; Mia is a manager.
  await run(db, "person.create", { display_name: "Ann Lee", email: "ann@example.test" }, owner, opts);
  const mia = ((await run(db, "person.create", { display_name: "Mia", email: "mia@example.test" }, owner, opts)).result as any).person_id;
  await run(db, "role.assign", { person_id: mia, role: "manager" }, owner, opts);
  manager = { personId: mia, via: "test", lang: "en" };
  gold = ((await run(db, "membership.plan_set", { name: "Gold", price_cents: 6000, period: "month", join_in_app: true }, owner, opts)).result as any).plan_id;
  junior = ((await run(db, "membership.plan_set", { name: "Junior", price_cents: 30000, period: "year", join_in_app: false }, owner, opts)).result as any).plan_id;
  founding = ((await run(db, "membership.plan_set", { name: "Founding", price_cents: 5000, period: "month", join_in_app: true }, owner, opts)).result as any).plan_id;
});
after(async () => drop());

test("days and times as the exports write them, and the people a cell names", () => {
  assert.deepEqual(readWhen("11/20/2026 6:00 PM", false), { date: "2026-11-20", time: "18:00" });
  assert.deepEqual(readWhen("20/11/2026 18:00", true), { date: "2026-11-20", time: "18:00" });
  assert.deepEqual(readWhen("2026-11-20T18:30:00", false), { date: "2026-11-20", time: "18:30" });
  assert.deepEqual(readWhen("Friday, November 20, 2026", false), { date: "2026-11-20" });
  assert.deepEqual(readWhen("martes 5 de mayo de 2026", true), { date: "2026-05-05" });
  assert.deepEqual(readWhen("46346.75", false), { date: "2026-11-20", time: "18:00" });
  assert.deepEqual(readWhen("9 am", false), { time: "09:00" });
  assert.equal(readWhen("31/31/2026", true), null);
  assert.equal(readWhen("soon", false), null);
  const cell = readPeopleCell("Ann Lee; Ben Ross <ben@example.test>, Cal Diaz (Organizer)");
  assert.deepEqual(cell.people.map((p) => p.name), ["Ann Lee", "Ben Ross", "Cal Diaz"]);
  assert.equal(cell.people[1]!.email, "ben@example.test");
  assert.equal(cell.organiser, 2);
});

test("CourtReserve's members list: by the names it documents, every line it can't use listed with why", () => {
  const r = readMoveFile("people", { csv: file("courtreserve-members.csv") }, { dayFirst: false });
  assert.equal(r.fatal, undefined);
  assert.deepEqual(r.columns.map((c) => c.what).sort(), ["credit", "email", "ext_id", "first", "last", "membership", "news", "next_payment", "phone", "start"]);
  const rows = r.rows as MovePerson[];
  assert.deepEqual(rows.map((x) => x.name), ["Ann Lee", "Ben Ross", "Cal Diaz", "Dee Park", "Zoe Kim"]);
  // Paid until the day before the next payment.
  assert.deepEqual(rows[0]!.membership, { name: "Gold Monthly", start: "2026-10-01", until: "2026-11-30" });
  assert.equal(rows[0]!.news, true);
  assert.equal(rows[1]!.news, undefined, "No isn't a yes");
  assert.equal(rows[3]!.ext_id, "CR-1004");
  assert.deepEqual(r.problems.map((p) => p.line), [8, 9]);
  assert.match(r.problems[0]!.text.en, /not-an-email/);
  assert.match(r.problems[1]!.text.en, /Line 9 \(Fay Wu\) has no email or member number/);
});

test("a messy export: title lines, odd spacing, accents, Excel's date numbers, and an unsubscribe column that is never a yes", () => {
  const r = readMoveFile("people", { csv: file("courtreserve-members-messy.csv") }, { dayFirst: false });
  const rows = r.rows as MovePerson[];
  assert.deepEqual(rows.map((x) => x.name), ["Gus Núñez", "Gus Núñez", "Hal Ortiz", "Ivy Sato", "Jo Ruiz"]);
  assert.equal(rows[0]!.email, "gus@example.test");
  assert.deepEqual(rows[0]!.membership, { name: "Gold Monthly", status: "active", until: "2026-12-31" });
  assert.ok(rows.every((x) => !x.news), "an unsubscribe column's No never becomes consent");
  assert.equal(rows[4]!.membership, undefined);
  assert.deepEqual(r.problems.map((p) => p.line), [8]);
  assert.match(r.problems[0]!.text.en, /"31\/31\/2026" isn't a date/);
});

test("bookings and sign-ups files: CourtReserve's and Playbypoint's", () => {
  const b = readMoveFile("bookings", { csv: file("courtreserve-reservations.csv") }, { dayFirst: false });
  const rows = b.rows as MoveBooking[];
  assert.equal(rows.length, 7);
  assert.deepEqual({ court: rows[0]!.court, date: rows[0]!.date, start: rows[0]!.start, minutes: rows[0]!.minutes, organiser: rows[0]!.organiser?.name, players: rows[0]!.players.map((p) => p.name) },
    { court: "Court 1", date: "2026-11-20", start: "18:00", minutes: 90, organiser: "Ann Lee", players: ["Ben Ross"] });
  assert.equal(rows[0]!.ref, "R-501");
  assert.deepEqual(b.problems.map((p) => p.line), [8]);
  const p = readMoveFile("bookings", { csv: file("playbypoint-bookings.csv") }, { dayFirst: false });
  assert.deepEqual((p.rows as MoveBooking[]).map((x) => [x.date, x.start, x.minutes, x.organiser?.name, x.players.length]), [["2026-11-25", "20:00", 90, "Kai Moss", 2], ["2026-11-26", "20:00", 60, "Lou Chen", 0]]);
  const s = readMoveFile("programs", { csv: file("courtreserve-registrants.csv") }, { dayFirst: false });
  assert.equal(s.rows.length, 5);
  assert.match(s.problems[0]!.text.en, /Line 4 isn't a place \(Waitlist\)/);
  assert.match(readMoveFile("bookings", { csv: file("courtreserve-members.csv") }, { dayFirst: false }).fatal!.en, /no Court column/);
});

test("every step is the app's and the server's, never an assistant's; a file's rows never reach the change log", async () => {
  for (const name of ["move.upload", "move.members", "move.memberships", "move.credit", "move.bookings", "move.programs"]) assert.ok(appOnly(getAction(name)), name);
  const u = await upload("courtreserve", "people", "courtreserve-members.csv");
  assert.match(u.summary.en, /^Read courtreserve-members\.csv from CourtReserve as a people list: 5 lines it can use\./);
  assert.match(u.summary.en, /2 lines can't be used: Line 8: "not-an-email" isn't an email address\./);
  assert.match(u.summary.en, /haven't been checked against a real CourtReserve file/);
  assert.match(u.summary.es, /no se comprobaron con un archivo real de CourtReserve/);
  const logged = await db.selectFrom("entity_change").select("after").where("entity", "=", "move_upload").execute();
  assert.ok(logged.length && logged.every((l) => !JSON.stringify(l.after).includes("ann@example.test")));
  await rejects(plan(db, "move.members", { upload_id: u.upload_id, sha256: "0".repeat(64) }, owner, opts), "error.changed");
  await rejects(plan(db, "move.bookings", ref(u), owner, opts), "error.move_wrong_file");
});

test("members: someone already here isn't added twice, and club news comes over only where the file says yes", async () => {
  const u = await upload("courtreserve", "people", "courtreserve-members.csv");
  const p = await plan(db, "move.members", ref(u), owner, opts);
  assert.match(p.plan.summary.en, /^Bring members in from CourtReserve: 4 new people, and 1 person already here get what the file adds/);
  assert.match(p.plan.summary.en, /New: Ben Ross, Cal Diaz, Dee Park, Zoe Kim\./);
  assert.match(p.plan.summary.en, /3 people said yes to club news there/);
  assert.match(p.plan.summary.en, /Nobody is told/);
  assert.match(p.plan.summary.es, /^Traer miembros desde CourtReserve: 4 personas nuevas/);
  await apply(db, p.runId, owner, opts);
  const ann = (await personBy("ann@example.test"))!, ben = (await personBy("ben@example.test"))!;
  assert.equal(ann.display_name, "Ann Lee");
  assert.equal(ann.phone, "+14155550101");
  assert.equal((await db.selectFrom("person").select("id").where("email", "=", "ann@example.test").execute()).length, 1);
  const news = async (id: string) => Boolean(await db.selectFrom("channel_consent").select("id").where("person_id", "=", id).where("purpose", "=", "club_news").where("granted", "=", true).executeTakeFirst());
  assert.equal(await news(ann.id), true);
  assert.equal(await news(ben.id), false, "No is not a yes");
  const dee = await db.selectFrom("external_ref").select("entity_id").where("system", "=", "courtreserve").where("external_id", "=", "CR-1004").executeTakeFirstOrThrow();
  assert.equal(await news(dee.entity_id), true);
  // The same file again brings nothing; the messy one is matched by its numbers and addresses, with no consent from it.
  await rejects(run(db, "move.members", ref(u), owner, opts), "error.nothing_to_do");
  const m = await upload("courtreserve", "people", "courtreserve-members-messy.csv");
  const p2 = await run(db, "move.members", ref(m), owner, opts);
  assert.match(p2.plan.summary.en, /4 new people/);
  assert.match(p2.plan.summary.en, /1 line is the same person as an earlier line/);
  assert.equal(await news((await personBy("hal@example.test"))!.id), false);
});

test("memberships carry over on the plans chosen, paid through the date there; the owner's, a manager asks", async () => {
  const u = await upload("courtreserve", "people", "courtreserve-members.csv");
  const map = { "Gold Monthly": gold, "Junior Annual": junior };
  const asked = await plan(db, "move.memberships", { ...ref(u), map }, manager, opts);
  assert.equal(asked.status, "awaiting_approval");
  const p = await plan(db, "move.memberships", { ...ref(u), map }, owner, opts);
  assert.match(p.plan.summary.en, /^Carry 3 memberships over from CourtReserve, paid through their dates there\. Nothing is charged now\./);
  assert.match(p.plan.summary.en, /Ann Lee: Gold until November 30, 2026, then \$60\.00 a month on a card they add in the app\./);
  assert.match(p.plan.summary.en, /Cal Diaz: Junior until December 31, 2026, then paid at the desk/);
  assert.match(p.plan.summary.en, /1 person's memberships there have all ended/);
  assert.match(p.plan.summary.en, /In CourtReserve, stop these memberships renewing/);
  await apply(db, p.runId, owner, opts);
  const ann = (await personBy("ann@example.test"))!;
  const m = await db.selectFrom("membership").selectAll().where("person_id", "=", ann.id).executeTakeFirstOrThrow();
  assert.equal(m.brought_from, "courtreserve");
  assert.equal(m.current_period_end!.toISOString(), "2026-12-01T08:00:00.000Z");
  assert.equal(await db.selectFrom("payment").select("id").where("membership_id", "=", m.id).executeTakeFirst(), undefined, "nothing charged");
  // Again: already carried over, nothing to do. Undo ends them.
  const again = await plan(db, "move.memberships", { ...ref(u), map }, owner, opts);
  assert.match(again.plan.summary.en, /^No memberships to carry over from CourtReserve\./);
  // Playbypoint's: a "Cancelling" one ends here on its day too.
  await run(db, "move.members", ref(await upload("playbypoint", "people", "playbypoint-memberships.csv")), owner, opts);
  const pb = await upload("playbypoint", "people", "playbypoint-memberships.csv");
  const q = await run(db, "move.memberships", { ...ref(pb), map: { "Founding Member": founding } }, owner, opts);
  assert.match(q.plan.summary.en, /Lou Chen: Founding until December 14, 2026, then it ends, as it was cancelled there\./);
  const lou = await db.selectFrom("membership").innerJoin("person", "person.id", "membership.person_id").select(["membership.cancel_at_period_end", "membership.brought_from"]).where("person.email", "=", "lou@example.test").executeTakeFirstOrThrow();
  assert.deepEqual(lou, { cancel_at_period_end: true, brought_from: "playbypoint" });
  const undo = await run(db, "action.undo", { run_id: q.runId }, owner, opts);
  assert.ok(undo.result);
});

test("club credit: a liability from the brought-in account, the totals right, only the difference on a newer file", async () => {
  const u = await upload("courtreserve", "people", "courtreserve-members.csv");
  const before = { credit: await ledger("member_credit"), brought: await ledger("brought_in") };
  const p = await plan(db, "move.credit", ref(u), owner, opts);
  // Ann 25.50, Cal 1,200.00, Dee 10, Zoe 5; Ben's 0 brings nothing.
  assert.match(p.plan.summary.en, /^Bring club credit in from CourtReserve for 4 people, \$1,240\.50 in all: money the club owes them, not a payment\./);
  assert.equal(p.plan.moneyCents, 124050);
  await apply(db, p.runId, owner, opts);
  const ann = (await personBy("ann@example.test"))!;
  assert.equal(await creditBalance(db, ann.id), 2550);
  assert.equal(await ledger("member_credit") - before.credit, -124050);
  assert.equal(await ledger("brought_in") - before.brought, 124050);
  assert.equal(await ledger("revenue"), 0, "never revenue");
  assert.equal(await db.selectFrom("payment").select("id").where("person_id", "=", ann.id).executeTakeFirst(), undefined, "never a payment");
  // The same file: nothing new. The messy one: Gus's lines disagree, Ivy owes there.
  assert.match((await plan(db, "move.credit", ref(u), owner, opts)).plan.summary.en, /^No new club credit to bring in from CourtReserve\./);
  const m = await plan(db, "move.credit", ref(await upload("courtreserve", "people", "courtreserve-members-messy.csv")), owner, opts);
  assert.match(m.plan.summary.en, /Left out, on more than one line with different amounts \(check the file\): Gus Núñez\./);
  assert.match(m.plan.summary.en, /Left out, as they owe money in CourtReserve rather than hold credit \(settle it there\): Ivy Sato \(-20\.00\)\./);
  // Less there now: kept unless staff take it back, and then only the difference.
  const less = await run(db, "move.upload", { from: "courtreserve", kind: "people", csv: "Email,Member #,Account Credit\nann@example.test,CR-1001,20.00\n", file_name: "later.csv" }, owner, opts);
  const l = { ...(less.result as any) };
  assert.match((await plan(db, "move.credit", ref(l), owner, opts)).plan.summary.en, /Less in CourtReserve now than brought in, and left as it is here .*: Ann Lee \(\$5\.50\)/);
  await run(db, "move.credit", { ...ref(l), take_back: true }, owner, opts);
  assert.equal(await creditBalance(db, ann.id), 2000);
  const asked = await plan(db, "move.credit", ref(u), manager, opts);
  assert.equal(asked.status, "awaiting_approval");
});

test("upcoming bookings take court time like any booking: a clash here, an unknown court, the past and strangers are listed and left", async () => {
  // Something here already on Court 1 at 10:00 on 22 Nov.
  await run(db, "court.block", { court_ids: [c1], starts_at: "2026-11-22T18:00:00Z", ends_at: "2026-11-22T19:00:00Z", reason: "maintenance" }, owner, opts);
  const u = await upload("courtreserve", "bookings", "courtreserve-reservations.csv");
  assert.match(u.summary.en, /1 line can't be used: Line 8 has no end time or length/);
  const p = await plan(db, "move.bookings", ref(u), owner, opts);
  const s = p.plan.summary.en;
  assert.match(s, /^Bring 3 upcoming bookings in from CourtReserve, on 2 courts, from Nov 20, 2026, 6:00\sPM to Nov 20, 2026, 8:00\sPM\./, s);
  assert.match(s, /nothing is owed here, and if one is cancelled, any refund is made in CourtReserve/);
  assert.match(s, /Courts in CourtReserve with no court here of the same name: .*Court 9 \(1\)/);
  assert.match(s, /Left out, as the court is taken here then: line 7, Court 1, 2026-11-22 10:00 \(block\)\./);
  assert.match(s, /Left out, as who booked isn't a member here .*line 4, Court 1, 2026-11-21 09:00 \(Nobody Here\)/);
  assert.match(s, /1 booking has already been played/);
  assert.match(p.plan.summary.es, /^Traer 3 reservas próximas desde CourtReserve, en 2 canchas/);
  // Court 9 is Court 2 here, after all.
  const q = await plan(db, "move.bookings", { ...ref(u), courts: { "Court 9": c2 } }, owner, opts);
  assert.match(q.plan.summary.en, /^Bring 4 upcoming bookings/);
  await apply(db, q.runId, owner, opts);
  const brought = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").select(["booking.id", "booking.price_cents", "booking.source", "court_time.court_id", "booking.status"])
    .where("booking.source", "=", "import").execute();
  assert.equal(brought.length, 4);
  assert.ok(brought.every((b) => b.price_cents === 0 && b.status === "confirmed"));
  const first = brought.find((b) => b.court_id === c1)!;
  const players = await db.selectFrom("booking_player").select(["person_id", "guest_name"]).where("booking_id", "=", first.id).execute();
  assert.equal(players.length, 2);
  const guest = await db.selectFrom("booking_player").innerJoin("court_time", "court_time.booking_id", "booking_player.booking_id").select("guest_name")
    .where("court_time.court_id", "=", c2).where("guest_name", "is not", null).executeTakeFirst();
  assert.equal(guest?.guest_name, "Guest Player");
  // The court can't be taken twice: the database's own rule holds.
  await assert.rejects(db.insertInto("court_time").values({ id: "01900000-0000-7000-8000-000000000999", court_id: c1, during: "[2026-11-21 02:00:00+00, 2026-11-21 02:30:00+00)", kind: "mirror" } as any).execute(),
    (e: any) => e?.code === "23P01");
  // Again: already here. Undone: cancelled, and the court free again.
  assert.match((await plan(db, "move.bookings", { ...ref(u), courts: { "Court 9": c2 } }, owner, opts)).plan.summary.en, /4 bookings came over already/);
  await run(db, "action.undo", { run_id: q.runId }, owner, opts);
  assert.equal((await db.selectFrom("booking").select("id").where("source", "=", "import").where("status", "!=", "cancelled").execute()).length, 0);
  assert.equal((await db.selectFrom("court_time").select("id").where("kind", "=", "booking").where("active", "=", true).execute()).length, 0);
});

test("program sign-ups: into the programs chosen here, marked paid there, a full one listed", async () => {
  const prog = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Clinic", capacity: 1, price_cents: 2500, sign_up: "per_session" }, owner, opts)).result as any).program_id;
  await run(db, "session.add", { program_id: prog, starts_at: "2026-11-25T02:00:00Z", ends_at: "2026-11-25T03:00:00Z", court_ids: [c2], weeks: 2 }, owner, opts);
  await run(db, "program.publish", { program_id: prog }, owner, opts);
  const u = await upload("courtreserve", "programs", "courtreserve-registrants.csv");
  const p = await plan(db, "move.programs", { ...ref(u), map: { "Tuesday Clinic": prog } }, owner, opts);
  const s = p.plan.summary.en;
  assert.match(s, /^Bring 2 places in from CourtReserve, in 1 program\./, s);
  assert.match(s, /Choose the program here for these .*: Winter League \(1\)/);
  assert.match(s, /Left out, as the program here has no places left: line 3, Ben Ross, Clinic 2026-11-24/);
  assert.match(s, /Left out, not members here .*Nobody Here/);
  await apply(db, p.runId, owner, opts);
  const places = await db.selectFrom("enrolment").select(["paid_by", "price_cents", "comp_note", "session_id"]).where("program_id", "=", prog).execute();
  assert.equal(places.length, 2);
  assert.ok(places.every((x) => x.paid_by === "comp" && x.price_cents === 0 && x.comp_note === "Paid in CourtReserve" && x.session_id));
  const st = await moveFilesStatus(db, "courtreserve", "en");
  assert.equal(st.brought.places, 2);
  assert.deepEqual(st.events.map((e) => e.name), ["Tuesday Clinic", "Winter League"]);
  assert.equal(st.uploads.programs?.rows, 5);
});

test("a deleted account takes the files that name them with it", async () => {
  const u = await upload("courtreserve", "people", "courtreserve-members-messy.csv");
  const jo = (await personBy("jo@example.test"))!;
  await run(db, "privacy.erase", { person_id: jo.id }, owner, opts);
  assert.equal(await db.selectFrom("move_upload").select("id").where("id", "=", u.upload_id).executeTakeFirst(), undefined);
  // Files that don't name them stay.
  assert.ok(await db.selectFrom("move_upload").select("id").where("kind", "=", "bookings").executeTakeFirst());
});
