import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, friendsOf, householdOf, managersOf, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, waiverStatus, KumiError, TestProvider,
  type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, court: string, clinic: string, mia: string, code: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T18:00:00Z"), opts = { now: NOW };
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
const msg = async (to: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", to).where("kind", "=", kind).where("channel", "=", "inbox").execute();

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  clinic = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Junior Clinic", capacity: 8, price_cents: 2500 }, owner, opts)).result as any).program_id;
  const room = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner, opts)).result as any).court_id;
  await run(db, "session.add", { program_id: clinic, starts_at: "2026-12-05T10:00:00-08:00", ends_at: "2026-12-05T11:00:00-08:00", court_ids: [room] }, owner, opts);
  await run(db, "program.publish", { program_id: clinic }, owner, opts);
  for (const name of ["Pat", "Sam", "Ann"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", people.Sam!).execute();
});
after(async () => drop());

test("a parent adds a junior: a name and a birth year, no login", async () => {
  await rejects(plan(db, "household.add_junior", { person_id: people.Pat, display_name: "Too Old", birth_year: 2007 }, as("Pat"), opts), "error.junior_age", "A junior is under 18: born between 2008 and 2026.");
  await rejects(plan(db, "household.add_junior", { person_id: people.Pat, display_name: "Mia", birth_year: 2015 }, as("Ann"), opts), "error.forbidden_reason");   // not Ann's family
  const r = await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Mia", birth_year: 2015 }, as("Pat"), opts);
  assert.equal(r.plan.summary.en, "Add Mia (born 2015) to your family. Mia has no login of their own: you sign them up, pay, and get their messages.");
  mia = (r.result as any).person_id;
  const row = await db.selectFrom("person").select(["junior", "email", "phone", "birth_year", "created_via"]).where("id", "=", mia).executeTakeFirstOrThrow();
  assert.deepEqual(row, { junior: true, email: null, phone: null, birth_year: 2015, created_via: "household" });
  assert.equal((await householdOf(db, people.Pat!))?.role, "adult");
  assert.deepEqual(await managersOf(db, mia), [people.Pat]);
  assert.equal((await db.selectFrom("person_role").select("id").where("person_id", "=", mia).execute()).length, 0);   // no role, so nothing to sign in to
});

test("another parent joins by the link and manages the same juniors", async () => {
  const inv = await run(db, "household.invite", { person_id: people.Pat }, as("Pat"), opts);
  assert.equal(inv.plan.summary.en, "Make a link to invite another parent into your family. Whoever accepts it manages Mia with you and gets their messages too. The link works for 7 days.");
  code = (inv.result as any).code;
  await rejects(plan(db, "household.accept_invite", { person_id: people.Sam, code: "not-a-real-code" }, as("Sam"), opts), "error.household_invite_closed");
  await rejects(plan(db, "household.accept_invite", { person_id: people.Sam, code }, as("Sam"), { now: new Date(NOW.getTime() + 8 * 86400_000) }), "error.household_invite_closed");   // ran out
  const a = await run(db, "household.accept_invite", { person_id: people.Sam, code }, as("Sam"), opts);
  assert.equal(a.plan.summary.es, "Unirte a la familia de Pat. Te encargarás de Mia con esa persona: inscribir, pagar y recibir sus mensajes.");
  assert.deepEqual((await managersOf(db, mia)).sort(), [people.Pat, people.Sam].sort());
  await rejects(plan(db, "household.accept_invite", { person_id: people.Ann, code }, as("Ann"), opts), "error.household_invite_closed");   // used
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await msg(people.Pat!, "household_joined"), [{ subject: "Sam joined your family", body: "Sam accepted your invite and now manages your juniors with you, and gets their messages too." }]);
});

test("the waiver: asked before the first sign-up, for an adult and for each junior, by a parent only", async () => {
  await run(db, "waiver.set", { body: "Padel is a sport with risks. I play at my own risk and follow the club's rules." }, owner, opts);
  await rejects(plan(db, "enrolment.join", { program_id: clinic, person_id: mia }, as("Pat"), opts), "error.waiver_needed_junior",
    "Before Mia plays, the club asks you to accept its waiver for them. Open it from the note at the top of the app.");
  await rejects(plan(db, "booking.request", { court_id: court, starts_at: "2026-12-04T18:00:00-08:00", minutes: 90, pay: "whole", person_id: people.Pat }, as("Pat"), opts), "error.waiver_needed");
  await rejects(plan(db, "waiver.accept", { person_id: mia }, as("Ann"), opts), "error.waiver_own");
  await rejects(plan(db, "waiver.accept", { person_id: mia }, owner, opts), "error.waiver_own");   // staff don't accept it for anyone
  const w = await run(db, "waiver.accept", { person_id: mia }, as("Sam"), opts);
  assert.equal(w.plan.summary.en, "Accept the club's waiver (version 1) for Mia, as their parent.");
  assert.deepEqual(await waiverStatus(db, mia), { version_no: 1, accepted_at: NOW, accepted_by: "Sam" });
  await rejects(plan(db, "waiver.accept", { person_id: mia }, as("Pat"), opts), "error.waiver_accepted");
  // Staff at the desk aren't stopped by it (the person page shows who hasn't accepted).
  assert.ok(await plan(db, "booking.request", { court_id: court, starts_at: "2026-12-04T18:00:00-08:00", minutes: 90, pay: "whole", person_id: people.Ann }, owner, opts));
  // A new version asks again.
  const v2 = await run(db, "waiver.set", { body: "Version two: padel has risks, and juniors follow their coach." }, owner, opts);
  assert.equal(v2.plan.summary.en, "Change the club's waiver (version 2). Everyone, including whoever accepted the last one, is asked to accept it before their next booking or sign-up.");
  assert.equal((await waiverStatus(db, mia))?.accepted_at, null);
  await run(db, "waiver.accept", { person_id: mia }, as("Pat"), opts);
});

test("a parent signs a junior up and pays; the junior's messages go to each parent, in their language", async () => {
  const j = await run(db, "enrolment.join", { program_id: clinic, person_id: mia }, as("Pat"), opts);
  assert.equal(j.plan.summary.en, "Sign Mia up for Junior Clinic for $25.00.");
  const pay = (j.result as any).payment_id as string;
  await assert.rejects(openPayment(db, pay, people.Ann!), (e: any) => e.code === "error.not_found");   // not Ann's to pay
  await openPayment(db, pay, people.Sam!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", pay).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, pay, "test", NOW), "succeeded");
  await processOutbox(db, messageHandlers);
  const pat = await msg(people.Pat!, "paid"), sam = await msg(people.Sam!, "paid");
  assert.equal(pat.length, 1);
  assert.match(pat[0]!.subject, /^Mia: /);
  assert.match(pat[0]!.body, /^For Mia: /);
  assert.match(sam[0]!.body, /^Para Mia: /);
  assert.equal((await db.selectFrom("outbound_message").select("id").where("person_id", "=", mia).execute()).length, 0);   // nothing to a child
  // And a parent can take the place back, under the program's rule, as the junior would.
  assert.ok(await plan(db, "enrolment.leave", { enrolment_id: (j.result as any).enrolment_id }, as("Sam"), opts));
  await rejects(plan(db, "enrolment.leave", { enrolment_id: (j.result as any).enrolment_id }, as("Ann"), opts), "error.forbidden_reason");
});

test("juniors don't book courts or join matches, and never show among friends", async () => {
  await rejects(plan(db, "booking.request", { court_id: court, starts_at: "2026-12-04T18:00:00-08:00", minutes: 90, pay: "whole", person_id: mia }, as("Pat"), opts), "error.junior_no_courts",
    "Mia is a junior: a parent books their lessons and programs, but not courts or matches.");
  await rejects(plan(db, "booking.request", { court_id: court, starts_at: "2026-12-04T18:00:00-08:00", minutes: 90, pay: "whole", person_id: mia }, owner, opts), "error.junior_no_courts");
  await rejects(plan(db, "friend.add_by_code", { person_id: people.Ann, code: (await db.selectFrom("person").select("friend_code").where("id", "=", mia).executeTakeFirstOrThrow()).friend_code }, as("Ann"), opts), "error.friend_link_unknown");
  // Mia shares a booking with Ann (staff put them in one, say): Ann still doesn't see Mia to add.
  const b = await db.insertInto("booking").values({ id: "0194e000-0000-7000-8000-00000000b001", code: "KP-TEST", location_id: loc, organiser_id: people.Ann!, status: "confirmed", source: "desk", price_cents: 0,
    tax_cents: 0, quote: "{}", pay_mode: "whole", players: 2 } as any).returning("id").executeTakeFirstOrThrow();
  for (const p of [people.Ann!, mia]) await db.insertInto("booking_player").values({ id: crypto.randomUUID(), booking_id: b.id, person_id: p, share_cents: 0 } as any).execute();
  assert.deepEqual((await friendsOf(db, people.Ann!, NOW)).played_with, []);
  await rejects(plan(db, "friend.add", { person_id: people.Ann, friend_id: mia }, as("Ann"), opts), "error.not_found");
});

test("turning 18: a login of their own; a parent can't leave the juniors with nobody", async () => {
  await rejects(plan(db, "household.give_login", { person_id: mia, email: "mia@example.test" }, as("Pat"), opts), "error.junior_too_young", "Mia can have their own login from 2033, the year they turn 18.");
  const leo = ((await run(db, "household.add_junior", { person_id: people.Pat, display_name: "Leo", birth_year: 2008 }, as("Pat"), opts)).result as any).person_id;
  await rejects(plan(db, "household.give_login", { person_id: leo, email: "ann@example.test" }, as("Pat"), opts), "error.duplicate_email");
  const g = await run(db, "household.give_login", { person_id: leo, email: "Leo@Example.test" }, as("Sam"), opts);
  assert.equal(g.plan.summary.en, "Give Leo their own login: they sign in with leo@example.test from now on and look after their own bookings and messages. They stay in your family.");
  assert.deepEqual(await db.selectFrom("person").select(["junior", "email"]).where("id", "=", leo).executeTakeFirstOrThrow(), { junior: false, email: "leo@example.test" });
  assert.equal((await householdOf(db, leo))?.role, "member");
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await msg(leo, "household_login_given"), [{ subject: "Your own login at Kestrel Padel", body: "You can now sign in to Kestrel Padel with leo@example.test. Your bookings, places and messages are yours to look after from now on." }]);
  // Leo is family still, but not a parent: Mia stays with Pat and Sam. A parent can't leave Mia with nobody.
  assert.deepEqual((await managersOf(db, mia)).sort(), [people.Pat, people.Sam].sort());
  await rejects(plan(db, "household.add_junior", { person_id: leo, display_name: "Kit", birth_year: 2020 }, { ...as("Pat"), personId: leo }, opts), "error.household_not_parent");
  await run(db, "household.leave", { person_id: people.Sam }, as("Sam"), opts);
  await rejects(plan(db, "household.leave", { person_id: people.Pat }, as("Pat"), opts), "error.household_last_adult");
  await run(db, "household.leave", { person_id: leo }, { ...as("Pat"), personId: leo }, opts);
});

test("a parent books their junior's lesson, pays for it, and can cancel it", async () => {
  people.Kim = ((await run(db, "person.create", { display_name: "Kim", email: "kim@example.test" }, owner, opts)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Kim, role: "coach" }, owner, opts);
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: "Kim coaches juniors.", level_min: 1, level_max: 4, languages: ["en"], rates: [{ minutes: 60, cents: 8000 }], lessons: true, max_players: 2 }, owner, opts);
  await run(db, "coach.set_hours", { person_id: people.Kim, location_id: loc, stretches: [{ weekday: 3, starts: "09:00", ends: "12:00" }] }, owner, opts);
  const l = await run(db, "lesson.request", { coach_id: people.Kim, starts_at: "2026-12-02T09:00:00-08:00", minutes: 60, pay: "whole", person_id: mia }, as("Pat"), opts);
  assert.match(l.plan.summary.en, /^Book a 60-minute lesson with Kim for 1 player/);
  await rejects(plan(db, "lesson.request", { coach_id: people.Kim, starts_at: "2026-12-02T10:00:00-08:00", minutes: 60, pay: "whole", person_id: mia }, as("Ann"), opts), "error.forbidden_reason");
  const pay = (l.result as any).payment_id as string;
  await openPayment(db, pay, people.Pat!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", pay).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, pay, "test", NOW), "succeeded");
  const b = (l.result as any).booking_id as string;
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", b).executeTakeFirstOrThrow()).status, "confirmed");
  await rejects(plan(db, "booking.cancel", { booking_id: b }, as("Ann"), opts), "error.forbidden_reason");
  const c = await run(db, "booking.cancel", { booking_id: b }, as("Pat"), opts);
  assert.match(c.plan.summary.en, /\$80\.00 goes back to the card/);
});
