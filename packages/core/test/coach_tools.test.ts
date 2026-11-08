import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, coachCalendar, coachStudents, exportData, icsFold, icsText, messageHandlers, newCalendarToken, openPayment, plan, playerRecord, processOutbox, rosterOf, run, runAsSystem,
  sessionPlayers, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, clinic: string, date: string, lesson: string, mia: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const START = new Date("2026-12-02T18:00:00-08:00"), LESSON = new Date("2026-12-03T09:00:00-08:00");
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const after_ = (d: Date, minutes: number) => ({ now: new Date(d.getTime() + minutes * 60_000) });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
const mark = (who: string, marks: { person: string; came: boolean | null }[], at: { now: Date }, where: Record<string, string> = { session_id: date }) =>
  run(db, "attendance.mark", { ...where, marks: marks.map((m) => ({ person_id: m.person === "Mia" ? mia : people[m.person], came: m.came })) }, as(who), at);
const noShows = async (who: string) => (await playerRecord(db, [who === "Mia" ? mia : people[who]!], new Date(START.getTime() + 3 * 3600_000))).get(who === "Mia" ? mia : people[who]!)?.no_shows ?? 0;

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const opts = { now: NOW };
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  await db.updateTable("location").set({ address: "12 Bay St, Oakland" }).where("id", "=", loc).execute();
  const c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const name of ["Ann", "Ben", "Kim", "Lou", "Fay", "Pat"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  for (const [who, role] of [["Kim", "coach"], ["Lou", "coach"], ["Fay", "front_desk"]] as const) await run(db, "role.assign", { person_id: people[who], role }, owner, opts);
  await run(db, "level.set", { person_id: people.Ann, level: 3.2, reason: "Starting level" }, owner, opts);
  // A clinic date Kim runs (free, so places are taken at once), with a comma and a semicolon in its name.
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley Clinic; Level 3, Beginners", capacity: 8, price_cents: 0 }, owner, opts)).result as any).program_id;
  const c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner, opts)).result as any).court_id;
  date = ((await run(db, "session.add", { program_id: clinic, starts_at: START.toISOString(), ends_at: new Date(START.getTime() + 3600_000).toISOString(), court_ids: [c2], coach_id: people.Kim }, owner, opts)).result as any).session_id;
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
  mia = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Mia Hale", birth_year: 2015 }, as("Pat"), opts)).result as any).person_id;
  for (const who of ["Ann", "Ben"]) await run(db, "enrolment.join", { program_id: clinic, person_id: people[who] }, as(who), opts);
  await run(db, "enrolment.join", { program_id: clinic, person_id: mia }, as("Pat"), opts);
  // A lesson with Kim, booked and paid by Ann.
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: "Kim coaches.", level_min: 1, level_max: 5, languages: ["en"], rates: [{ minutes: 60, cents: 9000 }], lessons: true, max_players: 4 }, as("Kim"), opts);
  await run(db, "coach.set_hours", { person_id: people.Kim, location_id: loc, stretches: [{ weekday: 4, starts: "08:00", ends: "12:00" }] }, as("Kim"), opts);
  const l = await run(db, "lesson.request", { coach_id: people.Kim, starts_at: LESSON.toISOString(), minutes: 60, pay: "whole", person_id: people.Ann }, as("Ann"), opts);
  lesson = (l.result as any).booking_id;
  const pay = (l.result as any).payment_id as string;
  await openPayment(db, pay, people.Ann!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", pay).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, pay, "test", NOW);
  void c1;
});
after(async () => drop());

test("who's coming: each player's level, a junior's parents, and the waiver once the club has one", async () => {
  let r = await rosterOf(db, "session", date, NOW);
  assert.deepEqual(r.players.map((p) => [p.name, p.level, p.junior, p.parents, p.waiver, p.came]),
    [["Ann", "3.20", false, [], null, null], ["Ben", null, false, [], null, null], ["Mia Hale", null, true, ["Pat"], null, null]]);
  assert.equal(r.marking.open, false);   // it hasn't started
  await run(db, "waiver.set", { body: "Padel is a sport with risks. I play at my own risk and follow the club's rules." }, owner, { now: NOW });
  await run(db, "waiver.accept", { person_id: people.Ann }, as("Ann"), { now: NOW });
  r = await rosterOf(db, "session", date, NOW);
  assert.deepEqual(r.players.map((p) => p.waiver), ["accepted", "missing", "missing"]);
  const l = await rosterOf(db, "lesson", lesson, NOW);
  assert.deepEqual([l.item.courts, l.item.coach, l.players.map((p) => p.name)], [["Court 1"], "Kim", ["Ann"]]);
});

test("attendance: the date's coach or front desk, from the start until 48 hours after; didn't come counts as a no-show", async () => {
  await rejects(plan(db, "attendance.mark", { session_id: date, marks: [{ person_id: people.Ann, came: true }] }, as("Kim"), after_(START, -5)), "error.attendance_window",
    "Attendance can be marked from the start until 48 hours after.");
  await rejects(plan(db, "attendance.mark", { session_id: date, marks: [{ person_id: people.Ann, came: true }] }, as("Lou"), after_(START, 30)), "error.forbidden_reason");   // not Lou's date
  await rejects(plan(db, "attendance.mark", { session_id: date, marks: [{ person_id: people.Lou, came: true }] }, as("Kim"), after_(START, 30)), "error.not_in_session");
  await rejects(plan(db, "attendance.mark", { session_id: date, booking_id: lesson, marks: [{ person_id: people.Ann, came: true }] }, as("Kim"), after_(START, 30)), "error.invalid_input");
  const r = await mark("Kim", [{ person: "Ann", came: true }, { person: "Ben", came: false }, { person: "Mia", came: true }], after_(START, 30));
  assert.equal(r.plan.summary.en, "Attendance at Volley Clinic; Level 3, Beginners, Wed, Dec 2, 6:00 PM: came: Ann, Mia Hale; didn't come: Ben. Anyone marked as not having come is told, and it counts in their no-show record.");
  await rejects(plan(db, "attendance.mark", { session_id: date, marks: [{ person_id: people.Ann, came: true }] }, as("Kim"), after_(START, 40)), "error.attendance_unchanged");
  assert.equal(await noShows("Ben"), 1);
  assert.equal(await noShows("Ann"), 0);
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people.Ben!).where("kind", "=", "attendance_no_show").where("channel", "=", "inbox").execute();
  assert.deepEqual(told, [{ subject: "Marked as not coming: Volley Clinic; Level 3, Beginners, Wed, Dec 2, 6:00 PM",
    body: "Kim marked you as not having come to Volley Clinic; Level 3, Beginners, Wed, Dec 2, 6:00 PM. If that's wrong, tell the club." }]);
  // Setting the clinic's levels leaves out whoever didn't come.
  const s = await sessionPlayers(db, date);
  assert.deepEqual([s.players.map((p) => [p.name, p.came]), s.absent], [[["Ann", true], ["Mia Hale", true]], 1]);
  await rejects(plan(db, "level.set_session", { session_id: date, reason: "Assessed", levels: [{ person_id: people.Ben, level: 3 }] }, as("Kim"), after_(START, 60)), "error.not_in_session");
  // Cleared is as if never marked: Ben counts again, and isn't a no-show.
  const c = await mark("Fay", [{ person: "Ben", came: null }], after_(START, 90));   // front desk, any date
  assert.equal(c.plan.summary.en, "Attendance at Volley Clinic; Level 3, Beginners, Wed, Dec 2, 6:00 PM: not marked: Ben.");
  assert.equal(await noShows("Ben"), 0);
  assert.equal((await sessionPlayers(db, date)).players.length, 3);
  await mark("Kim", [{ person: "Ben", came: false }], after_(START, 47 * 60));
  await rejects(plan(db, "attendance.mark", { session_id: date, marks: [{ person_id: people.Ben, came: true }] }, as("Kim"), after_(START, 48 * 60 + 1)), "error.attendance_window");
  // Marked again, he's told once more (it changed from not marked); unchanged marks never repeat it.
  await processOutbox(db, messageHandlers);
  assert.equal((await db.selectFrom("outbound_message").select("id").where("person_id", "=", people.Ben!).where("kind", "=", "attendance_no_show").where("channel", "=", "inbox").execute()).length, 2);
});

test("another coach hears nothing of a date or a lesson that isn't theirs, before the no", async () => {
  // Its own coach hears what stands in the way; another coach only that it isn't theirs (who's on it, when it opens).
  await rejects(plan(db, "attendance.mark", { session_id: date, marks: [{ person_id: people.Lou, came: true }] }, as("Kim"), after_(START, 30)), "error.not_in_session");
  await rejects(plan(db, "attendance.mark", { session_id: date, marks: [{ person_id: people.Lou, came: true }] }, as("Lou"), after_(START, 30)), "error.forbidden_reason");
  await rejects(plan(db, "attendance.mark", { session_id: date, marks: [{ person_id: people.Ann, came: true }] }, as("Lou"), after_(START, -5)), "error.forbidden_reason");
  await rejects(plan(db, "attendance.mark", { booking_id: lesson, marks: [{ person_id: people.Ann, came: true }] }, as("Lou"), after_(START, 30)), "error.forbidden_reason");
  await rejects(plan(db, "attendance.mark", { session_id: "00000000-0000-7000-8000-00000000dead", marks: [{ person_id: people.Ann, came: true }] }, as("Lou"), after_(START, 30)), "error.forbidden_reason");
  await rejects(plan(db, "level.set_session", { session_id: date, reason: "Assessed", levels: [{ person_id: people.Ben, level: 3 }] }, as("Kim"), after_(START, 60)), "error.not_in_session");
  await rejects(plan(db, "level.set_session", { session_id: date, reason: "Assessed", levels: [{ person_id: people.Ben, level: 3 }] }, as("Lou"), after_(START, 60)), "error.forbidden_reason");
});

test("a lesson's attendance, and one no-show however it was marked", async () => {
  const r = await mark("Kim", [{ person: "Ann", came: false }], after_(LESSON, 10), { booking_id: lesson });
  assert.equal(r.plan.summary.en, "Attendance at the lesson on Court 1, Thu, Dec 3, 9:00 AM: didn't come: Ann. Anyone marked as not having come is told, and it counts in their no-show record.");
  const at = new Date(LESSON.getTime() + 3600_000);
  assert.equal((await playerRecord(db, [people.Ann!], at)).get(people.Ann!)?.no_shows, 1);
  await db.updateTable("booking_player").set({ no_show: true }).where("booking_id", "=", lesson).execute();   // also marked on the booking itself
  assert.equal((await playerRecord(db, [people.Ann!], at)).get(people.Ann!)?.no_shows, 1);
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Ann!).where("kind", "=", "attendance_no_show").where("channel", "=", "inbox").execute(),
    [{ body: "Kim marked you as not having come to your lesson with Kim, Thu, Dec 3, 9:00 AM. If that's wrong, tell the club." }]);
});

test("my students: who a coach worked with in 90 days, less whoever didn't come", async () => {
  const s = await coachStudents(db, people.Kim!, new Date(LESSON.getTime() + 2 * 3600_000));
  assert.deepEqual(s.map((x) => [x.name, x.times, x.last_kind, x.junior, x.level]), [["Ann", 1, "session", false, "3.20"], ["Mia Hale", 1, "session", true, null]]);
  assert.deepEqual(await coachStudents(db, people.Lou!, new Date(LESSON.getTime() + 2 * 3600_000)), []);
  // A day before the first session, the list isn't empty: who's booked in, with when they're next.
  const before = await coachStudents(db, people.Kim!, new Date(START.getTime() - 86400_000));
  assert.deepEqual(before.map((x) => [x.name, x.times, x.last_at, x.next_kind, x.next_at?.toISOString()]),
    [["Ann", 0, null, "session", START.toISOString()], ["Mia Hale", 0, null, "session", START.toISOString()]]);
});

test("the calendar link: Kim's lessons and dates in UTC, juniors by first name, cancelled ones kept as cancelled, a new link ends the old", async () => {
  const token = await newCalendarToken(db, people.Kim!, NOW);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  let ics = (await coachCalendar(db, token, NOW))!;
  assert.ok(ics.endsWith("\r\n") && !/[^\r]\n/.test(ics), "CRLF line endings");
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line}`);
  const unfolded = ics.replace(/\r\n /g, "");
  assert.match(unfolded, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/Kumi\/\/Coach calendar\/\/EN\r\n/);
  assert.match(unfolded, /\r\nX-WR-CALNAME:Kim at Kestrel Padel\r\n/);
  assert.match(unfolded, /\r\nUID:session-[0-9a-f-]+@kumi\r\nDTSTAMP:20261130T160000Z\r\nDTSTART:20261203T020000Z\r\nDTEND:20261203T030000Z\r\nSEQUENCE:\d+\r\nSTATUS:CONFIRMED\r\nSUMMARY:Volley Clinic\\; Level 3\\, Beginners \(3 signed up\)\r\nLOCATION:Court 2\\, Eastside\\, 12 Bay St\\, Oakland\r\nDESCRIPTION:Signed up: Ann\\, Ben\\, Mia\r\n/);
  assert.ok(!unfolded.includes("Hale"), "a junior goes in by first name only");
  assert.ok(!unfolded.includes("@example.test"), "no contact details");
  assert.match(unfolded, /\r\nUID:lesson-[0-9a-f-]+@kumi\r\n[^]*?SUMMARY:Lesson: Ann\r\nLOCATION:Court 1\\, Eastside/);
  // Cancelled: still in, as CANCELLED, with a higher sequence, so a calendar drops it.
  await run(db, "booking.cancel", { booking_id: lesson, refund: "full" }, owner, { now: NOW });
  ics = (await coachCalendar(db, token, NOW))!.replace(/\r\n /g, "");
  assert.match(ics, /UID:lesson-[^\r]+\r\nDTSTAMP:[^\r]+\r\nDTSTART:20261203T170000Z\r\nDTEND:20261203T180000Z\r\nSEQUENCE:\d+\r\nSTATUS:CANCELLED\r\n/);
  // In Spanish, for a coach who reads Spanish.
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", people.Kim!).execute();
  assert.match((await coachCalendar(db, token, NOW))!.replace(/\r\n /g, ""), /SUMMARY:Volley Clinic\\; Level 3\\, Beginners \(3 inscripciones\)/);
  // A new link ends the old one; and a coach no longer is no feed at all.
  const next = await newCalendarToken(db, people.Kim!, NOW);
  assert.equal(await coachCalendar(db, token, NOW), null);
  assert.ok(await coachCalendar(db, next, NOW));
  assert.equal(await coachCalendar(db, "short", NOW), null);
  await run(db, "role.remove", { person_id: people.Kim, role: "coach" }, owner, { now: NOW });
  assert.equal(await coachCalendar(db, next, NOW), null);
});

test("a person's file carries their attendance; deleting a coach's account ends their calendar link", async () => {
  const ben: any = await exportData(db, people.Ben!, new Date(START.getTime() + 49 * 3600_000), "en");
  assert.deepEqual(ben.attendance.map((a: any) => [a.came, a.program]), [[false, "Volley Clinic; Level 3, Beginners"]]);
  // Lou, a coach no longer, with a calendar link: deleting the account takes the link with it.
  const token = await newCalendarToken(db, people.Lou!, NOW);
  await run(db, "role.remove", { person_id: people.Lou, role: "coach" }, owner, { now: NOW });
  await run(db, "privacy.erase", { person_id: people.Lou }, owner, { now: NOW });
  assert.equal((await db.selectFrom("calendar_feed").select("id").where("token", "=", token).execute()).length, 0);
});

test("iCalendar text: escaped, and folded at 75 octets without splitting a character", () => {
  assert.equal(icsText("a\\b;c,d\ne\r\nf"), "a\\\\b\\;c\\,d\\ne\\nf");
  const line = `SUMMARY:${"Clínica de volea ñandú 🎾 ".repeat(8)}`;
  const folded = icsFold(line);
  for (const l of folded.split("\r\n")) assert.ok(Buffer.byteLength(l) <= 75, l);
  assert.equal(folded.replace(/\r\n /g, ""), line);
  assert.ok(!folded.includes("�"));
  assert.equal(icsFold("SHORT:x"), "SHORT:x");
});
