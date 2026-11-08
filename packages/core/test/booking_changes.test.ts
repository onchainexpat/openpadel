import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { checkPayment, coachEarnings, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, staffAlerts, uuidv7, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string, annBooking: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const DAY = "2026-12-01";                                                    // Tuesday
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const opts = { now: NOW };
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test");
}
const booking = (id: string) => db.selectFrom("booking").select(["price_cents", "balance_cents", "tax_cents", "reminded_at"]).where("id", "=", id).executeTakeFirstOrThrow();
const time = (id: string) => db.selectFrom("court_time").select(["court_id", sql<Date>`lower(during)`.as("start"), sql<Date>`upper(during)`.as("end")]).where("booking_id", "=", id).where("active", "=", true).executeTakeFirstOrThrow();
const refunds = (id: string) => db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
  .select(["refund.amount_cents", "payment.person_id"]).where("booking_player.booking_id", "=", id).orderBy("refund.id").execute();
const told = async (who: string, kind: string) => { await processOutbox(db, messageHandlers); return db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "inbox").orderBy("id").execute(); };
/** A summary with its booking code, which is random, as KP-0000. */
const plain = (s: string) => s.replace(/\b[A-Z]{2}-[A-Z0-9]{4}\b/g, "KP-0000");

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Evening", cents_per_hour: 6000, starts: "18:00", ends: "22:00", priority: 10 }, owner, opts);
  await run(db, "policy.set", { late_refund_percent: 50 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const name of ["Ann", "Ben", "Kim", "Lee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, opts);
  await run(db, "role.assign", { person_id: people.Kim, role: "coach" }, owner, opts);
  const r = await run(db, "booking.request", { court_id: c1, starts_at: at("10:00"), minutes: 90, pay: "whole", person_id: people.Ann }, as("Ann"), opts);
  annBooking = (r.result as any).booking_id;
  await pay((r.result as any).payment_id, "Ann");
});
after(async () => drop());

test("moving a booking: another court and time, the price as paid, the players told; what's in the way is refused", async () => {
  await run(db, "booking.create", { court_id: c2, starts_at: at("12:00"), minutes: 60, guest_name: "Walk-in" }, owner, opts);
  await rejects(plan(db, "booking.move", { booking_id: annBooking, court_id: c2, starts_at: at("11:30") }, as("Lee"), opts), "error.court_taken");
  await rejects(plan(db, "booking.move", { booking_id: annBooking, court_id: c2, starts_at: at("22:00") }, as("Lee"), opts), "error.closed_then");
  await rejects(plan(db, "booking.move", { booking_id: annBooking, court_id: c1, starts_at: at("10:00") }, as("Lee"), opts), "error.nothing_changed");
  await rejects(plan(db, "booking.move", { booking_id: annBooking, court_id: c2, starts_at: at("15:00") }, as("Ann"), opts), "error.forbidden_reason");   // staff move bookings
  // Its own time isn't in its way: half an hour later on the same court is fine.
  assert.ok(await plan(db, "booking.move", { booking_id: annBooking, court_id: c1, starts_at: at("10:30") }, as("Lee"), opts));
  const r = await run(db, "booking.move", { booking_id: annBooking, court_id: c2, starts_at: at("15:00") }, as("Lee"), opts);
  assert.equal(plain(r.plan.summary.en), "Move booking KP-0000 (Ann) from Court 1, Tue, Dec 1, 10:00 AM to Court 2, Tue, Dec 1, 3:00 PM. The price stays as it was. The players are told.");
  const t = await time(annBooking);
  assert.equal(t.court_id, c2);
  assert.deepEqual([new Date(t.start).toISOString(), new Date(t.end).toISOString()], [at("15:00"), at("16:30")].map((x) => new Date(x).toISOString()));
  assert.equal((await db.selectFrom("court_time").select("id").where("booking_id", "=", annBooking).where("active", "=", true).execute()).length, 1);
  assert.equal((await booking(annBooking)).price_cents, 6000);
  const msg = await told("Ann", "booking_moved");
  assert.equal(plain(msg[0]!.body), "The club moved booking KP-0000 from Court 1, Tue, Dec 1, 10:00 AM to Court 2, Tue, Dec 1, 3:00 PM.");
});

test("priced again: a dearer time is owed at the desk; a cheaper one gives back by the club's rule", async () => {
  const up = await run(db, "booking.move", { booking_id: annBooking, court_id: c2, starts_at: at("19:00"), reprice: true }, as("Lee"), opts);
  assert.match(up.plan.summary.en, /\. Priced again, it's \$90\.00, so \$30\.00 more is owed at the desk\. The players are told\.$/);
  assert.deepEqual(await booking(annBooking).then((b) => [b.price_cents, b.balance_cents]), [9000, 3000]);
  assert.match((await told("Ann", "booking_moved")).at(-1)!.body, /\$30\.00 more is to pay at the desk\.$/);
  await run(db, "booking.record_payment", { booking_id: annBooking, cents: 3000, method: "cash" }, as("Lee"), opts);
  // Back to the morning: $60, so the $30 paid beyond it goes back (more than 24 hours before: all of it, by the rule).
  const down = await run(db, "booking.move", { booking_id: annBooking, court_id: c1, starts_at: at("10:00"), reprice: true }, as("Lee"), opts);
  assert.match(down.plan.summary.en, /\. Priced again, it's \$60\.00\. \$30\.00 goes back to the card \(the club's cancellation rule: 100%\)\. The players are told\.$/);
  assert.equal((await booking(annBooking)).price_cents, 6000);
  assert.deepEqual((await refunds(annBooking)).map((x) => [x.amount_cents, x.person_id]), [[3000, people.Ann]]);
  assert.match((await told("Ann", "booking_moved")).at(-1)!.body, /\$30\.00 goes back to your card\.$/);
});

test("longer: the added time's price, owed at the desk; shorter: back by the rule (later, only part), all, or nothing", async () => {
  const ben = ((await run(db, "booking.create", { court_id: c1, starts_at: at("16:00"), minutes: 60, person_id: people.Ben }, as("Lee"), opts)).result as any).booking_id;
  const longer = await run(db, "booking.extend", { booking_id: ben, minutes: 90 }, as("Lee"), opts);
  assert.equal(plain(longer.plan.summary.en), "Make booking KP-0000 (Ben) on Court 1, Tue, Dec 1, 4:00 PM, run 90 minutes instead of 60, until 5:30 PM. The extra 30 minutes cost $20.00, owed at the desk. The players are told.");
  assert.deepEqual(await booking(ben).then((b) => [b.price_cents, b.balance_cents]), [6000, 2000]);
  // Into the evening price, and then into someone else's time.
  assert.match((await plan(db, "booking.extend", { booking_id: ben, minutes: 150 }, as("Lee"), opts)).plan.summary.en, /The extra 60 minutes cost \$50\.00/);
  await run(db, "booking.create", { court_id: c1, starts_at: at("18:30"), minutes: 60, guest_name: "Walk-in" }, owner, opts);
  await rejects(plan(db, "booking.extend", { booking_id: ben, minutes: 180 }, as("Lee"), opts), "error.court_taken");
  await rejects(plan(db, "booking.extend", { booking_id: ben, minutes: 100 }, as("Lee"), opts), "error.bad_length");
  assert.equal(plain((await told("Ben", "booking_resized"))[0]!.body), "Booking KP-0000 for Court 1 at Eastside, Tue, Dec 1, 4:00 PM, now runs 90 minutes, until 5:30 PM (it was 60). $20.00 more is to pay at the desk.");

  // Ann paid $60 for 90 minutes; 60 minutes is $40. An hour before, the rule gives back half of the $20.
  const late = new Date(new Date(at("09:00")).getTime());
  assert.match((await plan(db, "booking.extend", { booking_id: annBooking, minutes: 60 }, as("Lee"), { now: late })).plan.summary.en, /ending at 11:00 AM\. \$10\.00 goes back to the card \(the club's cancellation rule: 50%\)\./);
  assert.match((await plan(db, "booking.extend", { booking_id: annBooking, minutes: 60, refund: "none" }, as("Lee"), opts)).plan.summary.en, /\. Nothing goes back \(you chose nothing\)\./);
  const shorter = await run(db, "booking.extend", { booking_id: annBooking, minutes: 60, refund: "full" }, as("Lee"), opts);
  assert.match(shorter.plan.summary.en, /\. \$20\.00 goes back to the card \(you chose all of it\)\. The players are told\.$/);
  assert.equal((await booking(annBooking)).price_cents, 4000);
  assert.deepEqual((await refunds(annBooking)).map((x) => x.amount_cents), [3000, 2000]);
  // Ben's desk booking, made shorter again: nothing was paid beyond the new price, so what's owed comes down.
  const back = await run(db, "booking.extend", { booking_id: ben, minutes: 60 }, as("Lee"), opts);
  assert.match(back.plan.summary.en, /Nothing was paid beyond the new price, so nothing goes back\./);
  assert.deepEqual(await booking(ben).then((b) => [b.price_cents, b.balance_cents]), [4000, 0]);
});

test("a lesson moves only to a time its coach gives lessons and isn't busy; the coach hears of it", async () => {
  await run(db, "coach.set_profile", { person_id: people.Kim, bio: "Kim has coached for ten years.", level_min: 1.5, level_max: 5, languages: ["en"], rates: [{ minutes: 60, cents: 9000 }], lessons: true, max_players: 4 }, owner, opts);
  await run(db, "coach.set_hours", { person_id: people.Kim, location_id: loc, stretches: [{ weekday: 3, starts: "09:00", ends: "13:00" }] }, owner, opts);
  const day = "2026-12-02";   // Wednesday
  const mine = await run(db, "lesson.request", { coach_id: people.Kim, starts_at: at("09:00", day), minutes: 60, pay: "whole", person_id: people.Ann }, as("Ann"), opts);
  await pay((mine.result as any).payment_id, "Ann");
  const ben = await run(db, "lesson.request", { coach_id: people.Kim, starts_at: at("12:00", day), minutes: 60, pay: "whole", person_id: people.Ben }, as("Ben"), opts);
  await pay((ben.result as any).payment_id, "Ben");
  const id = (mine.result as any).booking_id;
  await rejects(plan(db, "booking.move", { booking_id: id, court_id: c2, starts_at: at("14:00", day) }, as("Lee"), opts), "error.coach_not_then");
  await rejects(plan(db, "booking.move", { booking_id: id, court_id: c2, starts_at: at("11:30", day) }, as("Lee"), opts), "error.coach_busy");
  const r = await run(db, "booking.move", { booking_id: id, court_id: c2, starts_at: at("10:30", day) }, as("Lee"), opts);
  assert.equal(plain(r.plan.summary.en), "Move the lesson KP-0000 with Kim (Ann) from Court 1, Wed, Dec 2, 9:00 AM to Court 2, Wed, Dec 2, 10:30 AM. The price stays as it was. The players are told.");
  // An hour more would run into Ben's lesson at noon.
  await rejects(plan(db, "booking.extend", { booking_id: id, minutes: 120 }, as("Lee"), opts), "error.coach_busy");
  assert.equal(plain((await told("Kim", "coach_lesson_moved"))[0]!.body), "Your lesson with Ann (booking KP-0000) moved from Court 1, Wed, Dec 2, 9:00 AM to Court 2, Wed, Dec 2, 10:30 AM.");
  assert.match((await told("Ann", "lesson_moved"))[0]!.subject, /^Lesson moved: Kim, Wed, Dec 2, 10:30 AM$/);
});

test("a lesson moved, then cancelled: the coach's earnings and everyone's cancellation say where it last was", async () => {
  // Kim gives lessons on Wednesdays from 9 to 1 (the test above).
  const day = "2026-12-09";
  const l = await run(db, "lesson.request", { coach_id: people.Kim, starts_at: at("09:00", day), minutes: 60, pay: "whole", person_id: people.Ann }, as("Ann"), opts);
  await pay((l.result as any).payment_id, "Ann");
  const id = (l.result as any).booking_id;
  await run(db, "booking.move", { booking_id: id, court_id: c2, starts_at: at("11:00", day) }, as("Lee"), opts);
  await processOutbox(db, messageHandlers);
  await run(db, "booking.cancel", { booking_id: id }, as("Lee"), opts);
  const line = (await coachEarnings(db, day, day, [people.Kim!])).lessons.find((x: any) => x.id === id) as any;
  assert.equal(new Date(line.start).toISOString(), at("11:00", day));
  assert.equal(line.court, "Court 2");
  assert.match((await told("Ann", "lesson_cancelled")).at(-1)!.subject, /Wed, Dec 9, 11:00 AM$/);
  assert.match((await told("Kim", "coach_lesson_cancelled")).at(-1)!.body, /on Court 2 at Eastside, Wed, Dec 9, 11:00 AM, is cancelled/);
});

test("staff alerts: each shows to whoever was told until someone handles it, once for the whole club", async () => {
  const ev = await db.insertInto("event_outbox").values({ topic: "booking.balance_due", payload: JSON.stringify({}), delivered_at: NOW }).returning("id").executeTakeFirstOrThrow();
  const msg = (to: string, kind: string, staleAt: Date | null = null, eventId = ev.id) => ({ id: uuidv7(), event_id: eventId, person_id: to, kind, channel: "inbox" as const, purpose: "staff" as const, essential: false,
    lang: "en", subject: `${kind} for Ben`, body: "Ben's card was declined.", link: "/courts", status: "sent" as const, send_after: NOW, sent_at: NOW, stale_at: staleAt, created_at: NOW, failure: null, read_at: null });
  const other = await db.insertInto("event_outbox").values({ topic: "booking.player_left", payload: JSON.stringify({}), delivered_at: NOW }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("outbound_message").values([msg(owner.personId!, "booking_balance_due_staff"), msg(people.Lee!, "booking_balance_due_staff"),
    msg(people.Lee!, "match_late_cancel_staff", new Date(NOW.getTime() - 60_000), other.id), msg(people.Lee!, "privacy_exported_staff", null, other.id)]).execute();
  const lee = await staffAlerts(db, people.Lee!, NOW);
  assert.deepEqual(lee.open.map((a) => a.kind), ["booking_balance_due_staff"]);   // the stale one and the one that needs nobody aren't there
  assert.deepEqual((await staffAlerts(db, people.Ben!, NOW)).open, []);              // not told, not shown
  await rejects(plan(db, "alert.handle", { event_id: ev.id, kind: "booking_balance_due_staff" }, as("Ann"), opts), "error.forbidden_reason");
  const h = await run(db, "alert.handle", { event_id: ev.id, kind: "booking_balance_due_staff" }, as("Lee"), opts);
  assert.equal(h.plan.summary.en, "Mark this as handled for everyone: booking_balance_due_staff for Ben");
  const robin = await staffAlerts(db, owner.personId!, NOW);
  assert.deepEqual(robin.open, []);
  assert.deepEqual(robin.handled.map((a) => a.handled_by), ["Lee"]);
  await rejects(plan(db, "alert.handle", { event_id: ev.id, kind: "booking_balance_due_staff" }, owner, opts), "error.alert_handled");
});
