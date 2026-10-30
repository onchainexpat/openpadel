import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, checkPayment, coachEarnings, expireHolds, remindBookings, coachPhoto, lessonTimes, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, settleShares, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test");
}
const lesson = (who: string, starts: string, extra: Record<string, unknown> = {}, now = NOW) =>
  run(db, "lesson.request", { coach_id: people.Kim, starts_at: starts, minutes: 60, pay: "whole", person_id: people[who], ...extra }, as(who), { now });
const profile = (coach: string, rates: { minutes: number; cents: number }[]) =>
  ({ person_id: people[coach], bio: `${coach} has coached for ten years.`, level_min: 1.5, level_max: 5, languages: ["en", "es"], rates, lessons: true, max_players: 4 });
const inbox = async (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "inbox").execute();
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
let annLesson: { booking_id: string; payment_id: string }, benLesson: { booking_id: string; payment_id: string }, calLesson: { booking_id: string; payment_id: string };

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const opts = { now: NOW };
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const name of ["Ann", "Ben", "Cal", "Kim", "Lou", "Fay"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  for (const [who, role] of [["Kim", "coach"], ["Lou", "coach"], ["Fay", "front_desk"]] as const) await run(db, "role.assign", { person_id: people[who], role }, owner, opts);
});
after(async () => drop());

test("a coach's profile: only for the coach role; coaches keep their own, front desk any; a photo is checked by its bytes", async () => {
  await rejects(plan(db, "coach.set_profile", profile("Ann", []), owner, { now: NOW }), "error.not_a_coach", "Ann doesn't have the coach role. Give it on their page first.");
  const r = await run(db, "coach.set_profile", profile("Kim", [{ minutes: 90, cents: 12500 }, { minutes: 60, cents: 9000 }]), as("Kim"), { now: NOW });
  assert.equal(r.plan.summary.en, "Save Kim's coach profile. Members can book private lessons with them in the app, court included: 60 minutes: $90.00, 90 minutes: $125.00.");
  await rejects(plan(db, "coach.set_profile", profile("Lou", []), as("Kim"), { now: NOW }), "error.forbidden_reason");   // not their own
  await run(db, "coach.set_profile", { ...profile("Lou", [{ minutes: 60, cents: 8000 }]), lessons: false }, as("Fay"), { now: NOW });   // front desk: anyone's
  await rejects(plan(db, "coach.set_photo", { person_id: people.Kim, photo: Buffer.from("<svg onload='x()'/>").toString("base64") }, as("Kim"), { now: NOW }), "error.photo_type", "Use a JPEG, PNG or WebP photo.");
  await rejects(plan(db, "coach.set_photo", { person_id: people.Kim, photo: Buffer.alloc(160_000, 1).toString("base64") }, as("Kim"), { now: NOW }), "error.invalid_input");   // too big to send
  const p = await run(db, "coach.set_photo", { person_id: people.Kim, photo: png.toString("base64") }, as("Kim"), { now: NOW });
  assert.equal(p.plan.summary.en, "Change Kim's photo. Members see it on their profile, and so does the public page when it's on.");
  const served = await coachPhoto(db, (p.result as any).photo_id);
  assert.equal(served!.content_type, "image/png");
  assert.deepEqual(Buffer.from(served!.bytes), png);
  // The photo isn't copied into the change log: only the profile's new photo id is.
  const logged = await db.selectFrom("entity_change").select("after").where("action_run_id", "=", p.runId).execute();
  assert.deepEqual(logged.map((x) => (x.after as any).photo_id), [(p.result as any).photo_id]);
});

test("lesson hours and the times offered: inside the hours, a court free, not on time off", async () => {
  const h = await run(db, "coach.set_hours", { person_id: people.Kim, location_id: loc, stretches: [{ weekday: 3, starts: "17:00", ends: "19:00" }, { weekday: 3, starts: "09:00", ends: "12:00" }, { weekday: 4, starts: "09:00", ends: "11:00" }] }, as("Kim"), { now: NOW });
  assert.equal(h.plan.summary.en, "Set Kim's lesson hours at Eastside: Wed 09:00 to 12:00, 17:00 to 19:00; Thu 09:00 to 11:00. Members can book a lesson inside them when a court is free.");
  await rejects(plan(db, "coach.set_hours", { person_id: people.Kim, location_id: loc, stretches: [{ weekday: 3, starts: "09:00", ends: "12:00" }, { weekday: 3, starts: "11:00", ends: "13:00" }] }, as("Kim"), { now: NOW }), "error.hours_overlap");
  const local = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const wed = async () => (await lessonTimes(db, { coachId: people.Kim!, date: "2026-12-02", minutes: 60, now: NOW })).map((x) => local(x.start));
  assert.deepEqual(await wed(), ["09:00", "09:30", "10:00", "10:30", "11:00", "17:00", "17:30", "18:00"]);
  // Both courts taken 10:00 to 11:30: no lesson can start from 9:30 to 11:00.
  for (const [who, court] of [["Ben", c1], ["Cal", c2]] as const) await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-02", "10:00"), minutes: 90, pay: "whole", person_id: people[who] }, as(who), { now: NOW });
  assert.deepEqual(await wed(), ["09:00", "17:00", "17:30", "18:00"]);
  assert.deepEqual((await lessonTimes(db, { coachId: people.Kim!, date: "2026-12-02", minutes: 90, now: NOW })).map((x) => local(x.start)), ["17:00", "17:30"]);
  assert.deepEqual(await lessonTimes(db, { coachId: people.Kim!, date: "2026-12-02", minutes: 45, now: NOW }), []);   // no rate for it
  const off = await run(db, "coach.time_off_add", { person_id: people.Kim, from: "2026-12-03", to: "2026-12-03", note: "Away" }, as("Kim"), { now: NOW });
  assert.equal(off.plan.summary.en, "Kim is off from Thu, Dec 3 to Thu, Dec 3: no lessons can be booked with them then.");
  assert.deepEqual(await lessonTimes(db, { coachId: people.Kim!, date: "2026-12-03", minutes: 60, now: NOW }), []);
  assert.deepEqual(await lessonTimes(db, { coachId: people.Lou!, date: "2026-12-02", minutes: 60, now: NOW }), []);   // Lou takes no lessons
});

test("booking a lesson: the coach's rate is the price, court included; paid, it's confirmed and both are told", async () => {
  const r = await lesson("Ann", at("2026-12-02", "09:00"));
  assert.equal(r.plan.summary.en, "Book a 60-minute lesson with Kim for 1 player: Court 1, Wed, Dec 2, 9:00 AM. $90.00, court included, paid now.");
  annLesson = r.result as any;
  assert.equal(await pay(annLesson.payment_id, "Ann"), "succeeded");
  const b = await db.selectFrom("booking").selectAll().where("id", "=", annLesson.booking_id).executeTakeFirstOrThrow();
  assert.deepEqual([b.kind, b.coach_id, b.status, b.price_cents], ["lesson", people.Kim, "confirmed", 9000]);
  await processOutbox(db, messageHandlers);
  assert.match((await inbox("Ann", "lesson_confirmed"))[0]!.body, /^Your lesson with Kim is booked: Court 1 at Eastside, Wed, Dec 2, 9:00 AM, for 60 minutes\. Booking KP-\w{4}\.$/);
  assert.match((await inbox("Kim", "coach_lesson_booked"))[0]!.body, /^A lesson is booked with you: Ann, Court 1 at Eastside, Wed, Dec 2, 9:00 AM, for 60 minutes\. Booking KP-\w{4}\.$/);
  // Lesson revenue is its own, apart from courts.
  const rev = await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id").select("ledger_entry.amount_cents")
    .where("ledger_account.kind", "=", "revenue").where("ledger_account.revenue_type", "=", "lessons").execute();
  assert.deepEqual(rev.map((x) => Number(x.amount_cents)), [-9000]);

  await rejects(lesson("Ben", at("2026-12-02", "13:00")), "error.coach_not_then", "Kim doesn't give lessons at Wed, Dec 2, 1:00 PM.");
  await rejects(lesson("Ben", at("2026-12-02", "17:00"), { minutes: 45 }), "error.lesson_length", "Kim gives lessons of 60, 90 minutes.");
  await rejects(lesson("Ben", at("2026-12-02", "09:00")), "error.coach_busy", "Kim already has a lesson or a session at Wed, Dec 2, 9:00 AM.");
  await rejects(lesson("Ben", at("2026-12-03", "09:00")), "error.coach_not_then");   // time off
  await rejects(lesson("Kim", at("2026-12-02", "17:00")), "error.own_lesson");
  await rejects(run(db, "lesson.request", { coach_id: people.Lou, starts_at: at("2026-12-02", "17:00"), minutes: 60, pay: "whole", person_id: people.Ben }, as("Ben"), { now: NOW }), "error.coach_no_lessons", "Lou doesn't take lessons in the app.");
  await rejects(lesson("Ben", at("2026-12-02", "17:00"), { pay: "split", players: 1 }), "error.lesson_split_alone");
  // Lessons don't count against the club's limit on court bookings.
  await run(db, "policy.set", { max_active: 1 }, owner, { now: NOW });
  assert.equal((await plan(db, "booking.request", { court_id: c2, starts_at: at("2026-12-04", "10:00"), minutes: 90, pay: "whole", person_id: people.Ann }, as("Ann"), { now: NOW })).status, "planned");
  await run(db, "policy.set", { max_active: 3 }, owner, { now: NOW });
});

test("two people booking the same coach at the same time: one gets it", async () => {
  const a = await plan(db, "lesson.request", { coach_id: people.Kim, starts_at: at("2026-12-02", "17:00"), minutes: 60, court_id: c1, pay: "whole", person_id: people.Ben }, as("Ben"), { now: NOW });
  const b = await plan(db, "lesson.request", { coach_id: people.Kim, starts_at: at("2026-12-02", "17:00"), minutes: 60, court_id: c2, pay: "whole", person_id: people.Cal }, as("Cal"), { now: NOW });
  benLesson = await apply(db, a.runId, as("Ben"), { now: NOW }) as any;
  await rejects(apply(db, b.runId, as("Cal"), { now: NOW }), "error.changed");
  await pay(benLesson.payment_id, "Ben");
});

test("a lesson split between players: each pays their part, and what's unpaid at the deadline goes on the booker's card", async () => {
  const r = await lesson("Cal", at("2026-12-02", "18:00"), { pay: "split", players: 2 });
  assert.equal(r.plan.summary.en, "Book a 60-minute lesson with Kim for 2 players: Court 1, Wed, Dec 2, 6:00 PM. $90.00, court included, split: you pay your part, $45.00, now; the others pay $45.00 each in the app, and anything unpaid 24 hours before goes on your card.");
  calLesson = r.result as any;
  await pay(calLesson.payment_id, "Cal");
  const code = (await db.selectFrom("booking").select("invite_code").where("id", "=", calLesson.booking_id).executeTakeFirstOrThrow()).invite_code!;
  const j = await plan(db, "booking.join", { invite_code: code, person_id: people.Ann }, as("Ann"), { now: NOW });
  assert.equal(j.plan.summary.en, "Join Cal's lesson with Kim: Court 1, Wed, Dec 2, 6:00 PM. Your part is $45.00.");
  const deadline = new Date(new Date(at("2026-12-02", "18:00")).getTime() - 24 * 3600_000 + 60_000);
  assert.deepEqual(await settleShares(db, deadline), { settled: 1, charged: 1, failed: 0, cancelled: 0 });
  assert.equal(stripe.charges.at(-1)!.amountCents, 4500);
  // A few hours before: the players and the coach are reminded.
  await remindBookings(db, new Date(new Date(at("2026-12-02", "18:00")).getTime() - 2 * 3600_000));
  await processOutbox(db, messageHandlers);
  assert.match((await inbox("Cal", "lesson_reminder"))[0]!.body, /^A reminder: your lesson with Kim on Court 1 at Eastside, Wed, Dec 2, 6:00 PM, for 60 minutes\./);
  assert.equal((await inbox("Kim", "coach_lesson_reminder"))[0]!.body, "A reminder: your lesson with Cal, Court 1 at Eastside, Wed, Dec 2, 6:00 PM, for 60 minutes.");
});

test("cancelling: the booker under the club's rule; the coach or the club calls it off and everyone gets everything back", async () => {
  const late = { now: new Date(at("2026-12-02", "06:00")) };
  const mine = await plan(db, "booking.cancel", { booking_id: annLesson.booking_id }, as("Ann"), late);
  assert.equal(mine.plan.moneyCents, 0);   // under 24 hours: the club's rule gives nothing back
  await rejects(plan(db, "booking.cancel", { booking_id: annLesson.booking_id, refund: "full" }, as("Ann"), late), "error.refund_choice_staff");
  await rejects(plan(db, "booking.cancel", { booking_id: annLesson.booking_id }, as("Lou"), late), "error.forbidden_reason");   // another coach's lesson
  await rejects(plan(db, "booking.cancel", { booking_id: annLesson.booking_id, refund: "none" }, as("Kim"), late), "error.refund_choice_staff");   // a coach can't choose less
  const byCoach = await run(db, "booking.cancel", { booking_id: annLesson.booking_id }, as("Kim"), late);
  assert.equal(byCoach.plan.moneyCents, 9000);
  assert.match(byCoach.plan.summary.en, /^Cancel lesson KP-\w{4}; the court and the coach are free again\. \$90\.00 goes back/);
  const byDesk = await run(db, "booking.cancel", { booking_id: benLesson.booking_id }, as("Fay"), late);
  assert.equal(byDesk.plan.moneyCents, 9000);
  await processOutbox(db, messageHandlers);
  assert.match((await inbox("Ann", "lesson_cancelled"))[0]!.body, /^Your lesson with Kim on Court 1 at Eastside, Wed, Dec 2, 9:00 AM, is cancelled \(booking KP-\w{4}\)\. \$90\.00 goes back to your card\.$/);
  const told = (await inbox("Kim", "coach_lesson_cancelled")).map((x) => x.body);
  assert.equal(told.length, 1);   // not for the one Kim called off herself
  assert.match(told[0]!, /^Your lesson with Ben on Court 1 at Eastside, Wed, Dec 2, 5:00 PM, is cancelled/);
});

test("a date names its coach: that coach sets its levels, another can't, and the coach is never in two places", async () => {
  await expireHolds(db, new Date(NOW.getTime() + 3600_000));   // the courts Ben and Cal never paid for
  const pid = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Volley Clinic", capacity: 6, price_cents: 0 }, owner, { now: NOW })).result as any).program_id;
  await rejects(plan(db, "session.add", { program_id: pid, starts_at: at("2026-12-02", "17:30"), ends_at: at("2026-12-02", "18:30"), court_ids: [c2], coach_id: people.Kim }, owner, { now: NOW }),
    "error.coach_busy", "Kim already has a lesson or a session at Wed, Dec 2, 6:00 PM.");
  const add = await run(db, "session.add", { program_id: pid, starts_at: at("2026-12-02", "11:00"), ends_at: at("2026-12-02", "12:00"), court_ids: [c2], coach_id: people.Kim }, owner, { now: NOW });
  assert.equal(add.plan.summary.en, "Add Volley Clinic on Wed, Dec 2, 11:00 AM, on Court 2. Kim runs it.");
  const session = (add.result as any).session_id;
  await rejects(lesson("Ben", at("2026-12-02", "10:30"), { court_id: c1 }, new Date(at("2026-12-01", "08:00"))), "error.coach_busy");
  await run(db, "program.publish", { program_id: pid }, owner, { now: NOW });
  for (const who of ["Ann", "Ben"]) await run(db, "enrolment.join", { program_id: pid, person_id: people[who] }, as(who), { now: NOW });
  const input = { session_id: session, reason: "Assessed in the clinic", levels: [{ person_id: people.Ann, level: 3.25 }] }, after = { now: new Date(at("2026-12-02", "12:30")) };
  await rejects(plan(db, "level.set_session", input, as("Lou"), after), "error.forbidden_reason");
  assert.equal((await plan(db, "level.set_session", input, as("Kim"), after)).status, "planned");
  const swap = await run(db, "session.set_coach", { session_id: session, coach_id: people.Lou }, as("Fay"), { now: NOW });
  assert.equal(swap.plan.summary.en, "Lou runs Volley Clinic, Wed, Dec 2, 11:00 AM, and can set levels after it.");
  assert.equal((await plan(db, "level.set_session", input, as("Lou"), after)).status, "planned");
  await rejects(plan(db, "session.set_coach", { session_id: session, coach_id: people.Ann }, owner, { now: NOW }), "error.not_a_coach");
});

test("earnings for payroll: each coach's lessons, paid less refunds, and the dates they ran", async () => {
  const e = await coachEarnings(db, "2026-12-01", "2026-12-31");
  const kim = e.coaches.find((x) => x.coach === "Kim")!, lou = e.coaches.find((x) => x.coach === "Lou")!;
  assert.deepEqual([kim.lessons, kim.lesson_minutes, kim.net_cents, kim.sessions], [1, 60, 9000, 0]);   // Cal's (both halves paid); the two called off came back in full
  assert.deepEqual([lou.lessons, lou.sessions, lou.session_minutes], [0, 1, 60]);
  assert.deepEqual(e.lessons.map((l) => [l.status, l.paid_cents, l.net_cents]).sort(), [["cancelled", 9000, 0], ["cancelled", 9000, 0], ["confirmed", 9000, 9000]]);
  assert.deepEqual((await coachEarnings(db, "2026-12-01", "2026-12-31", [people.Lou!])).lessons, []);
});
