import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, messageHandlers, openPayment, plan, playerRecord, processOutbox, releaseSeats, run, runAsSystem, setPaymentProvider, settleShares, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string, match: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am; the match is Wed 2 Dec, 6 pm
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}
/** Each adds the other (by their friend link), so they're friends. */
async function befriend(a: string, b: string) {
  const code = async (who: string) => (await db.selectFrom("person").select("friend_code").where("id", "=", people[who]!).executeTakeFirstOrThrow()).friend_code;
  await run(db, "friend.add_by_code", { person_id: people[a], code: await code(b) }, as(a));
  await run(db, "friend.add", { person_id: people[b], friend_id: people[a] }, as(b));
}
const seat = (who: string) => db.selectFrom("booking_player").selectAll().where("booking_id", "=", match).where("person_id", "=", people[who]!).orderBy("id", "desc").executeTakeFirstOrThrow();
const pendingFor = async (who: string) => (await db.selectFrom("payment").select("id").where("booking_player_id", "=", (await seat(who)).id).where("status", "=", "pending").executeTakeFirstOrThrow()).id;
const join = async (who: string, now = NOW) => ((await run(db, "booking.join", { booking_id: match, person_id: people[who] }, as(who), { now })).result as { payment_id: string }).payment_id;
const inbox = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "inbox").orderBy("created_at", "desc").executeTakeFirstOrThrow();

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const opts = { now: NOW };
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const [name, level] of [["Hal", 3.5], ["Ann", 3.4], ["Cal", null], ["Dee", 3.6], ["Eve", 3.3], ["Fay", 3.5]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
    if (level !== null) await run(db, "level.set", { person_id: people[name], level, reason: "Starting level" }, owner, opts);
  }
  const r = await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-02", "18:00").toISOString(), minutes: 90, pay: "split", person_id: people.Hal,
    open: { level_min: 3, level_max: 4 } }, as("Hal"), opts);
  match = (r.result as any).booking_id;
  await pay((r.result as any).payment_id, "Hal");
});
after(async () => drop());

test("a place saved for a friend: nobody else takes it, they pay their own, and the host can stop saving it", async () => {
  await rejects(plan(db, "booking.save_place", { booking_id: match, person_id: people.Cal }, as("Hal"), { now: NOW }), "error.not_friends",
    "You can only save a place for a friend (someone you've both added as a friend).");
  await befriend("Hal", "Cal"); await befriend("Hal", "Eve");
  const s = await run(db, "booking.save_place", { booking_id: match, person_id: people.Cal }, as("Hal"), { now: NOW });
  assert.equal(s.plan.summary.en, "Save a place in your match for Cal. They pay their own $15.00 in the app. If it's still unpaid 24 hours before, it counts as empty, and a match that isn't full then is cancelled.");
  assert.deepEqual([(await seat("Cal")).saved_by, (await seat("Cal")).held_until], [people.Hal, null]);   // saved, not held: Cal has no level and still gets in
  assert.deepEqual(await releaseSeats(db, at("2026-12-01", "17:00")), { released: 0 });
  await pay(await pendingFor("Cal"), "Cal");
  await rejects(plan(db, "booking.save_place", { booking_id: match, person_id: people.Eve }, as("Ann"), { now: NOW }), "error.forbidden_reason");   // only the host
  await run(db, "booking.save_place", { booking_id: match, person_id: people.Eve }, as("Hal"), { now: NOW });
  const d = await run(db, "booking.drop_saved_place", { booking_player_id: (await seat("Eve")).id }, as("Hal"), { now: NOW });
  assert.equal(d.plan.summary.en, "Stop saving a place for Eve. It opens for anyone in the band.");
  assert.ok((await seat("Eve")).removed_at);
  await pay(await join("Ann"), "Ann");
  await pay(await join("Dee"), "Dee");
  await rejects(plan(db, "booking.join", { booking_id: match, person_id: people.Eve }, as("Eve"), { now: NOW }), "error.booking_full");
  await processOutbox(db, messageHandlers);
  assert.equal((await db.selectFrom("outbound_message").select("subject").where("person_id", "=", people.Cal!).where("kind", "=", "match_place_saved").where("channel", "=", "email").executeTakeFirstOrThrow()).subject,
    "Hal saved you a place: Court 1, Wed, Dec 2, 6:00 PM");
});

test("can't make it: before the deadline it all comes back at once and the place opens; after it, it's a late cancellation", async () => {
  const l = await run(db, "booking.leave", { booking_id: match, person_id: people.Ann }, as("Ann"), { now: NOW });
  assert.equal(l.plan.summary.en, "Leave the match on Court 1, Wed, Dec 2, 6:00 PM. Your $15.00 goes back to your card and your place opens for someone else.");
  assert.ok((await seat("Ann")).removed_at);
  const annPaid = await db.selectFrom("payment").select("id").where("booking_player_id", "=", (await seat("Ann")).id).where("status", "=", "succeeded").executeTakeFirstOrThrow();
  assert.equal((await db.selectFrom("refund").select("amount_cents").where("payment_id", "=", annPaid.id).executeTakeFirstOrThrow()).amount_cents, 1500);
  await rejects(plan(db, "booking.leave", { booking_id: match, person_id: people.Hal }, as("Hal"), { now: NOW }), "error.host_cancels");
  await pay(await join("Eve"), "Eve");
  // Full at the deadline (Hal, Cal, Dee and Eve): it goes ahead, and nothing is charged.
  assert.deepEqual(await settleShares(db, at("2026-12-01", "18:00")), { settled: 1, charged: 0, failed: 0, cancelled: 0 });
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", match).executeTakeFirstOrThrow()).status, "confirmed");

  const late = at("2026-12-01", "19:00");
  const d = await run(db, "booking.leave", { booking_id: match, person_id: people.Dee }, as("Dee"), { now: late });
  assert.match(d.plan.summary.en, /It's past the deadline, so it counts as a late cancellation: you get \$0\.00 back now, or \$15\.00 in all if the club fills your place with a paying player\./);
  assert.equal((await playerRecord(db, [people.Dee!])).get(people.Dee!)!.late_leaves, 1);

  assert.equal((await seat("Dee")).removed_at, null);   // the place stays Dee's, and so does the money
  assert.equal((await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").select("refund.id").where("payment.booking_player_id", "=", (await seat("Dee")).id).execute()).length, 0);

  await processOutbox(db, messageHandlers);
  assert.equal((await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Ann!).where("kind", "=", "match_left_refund").where("channel", "=", "email").executeTakeFirstOrThrow()).body,
    "You're out of the match on Court 1, Wed, Dec 2, 6:00 PM, and $15.00 goes back to your card.");
  assert.equal((await inbox("Hal", "match_player_left")).body, "Ann can't make your match on Court 1, Wed, Dec 2, 6:00 PM. Their place is open again.");
  assert.equal((await inbox("Hal", "match_player_leaving")).body, "Dee can't make your match on Court 1, Wed, Dec 2, 6:00 PM. It's past the deadline, so the club has been told and may fill the place.");
  assert.equal((await db.selectFrom("outbound_message").select("id").where("person_id", "=", people.Dee!).where("kind", "=", "match_left_refund").execute()).length, 0);
});

test("running late tells the others; the host marks who didn't come, and it goes on their record", async () => {
  await rejects(plan(db, "booking.running_late", { booking_id: match, person_id: people.Cal, minutes: 10 }, as("Cal"), { now: at("2026-12-02", "14:00") }), "error.not_now_late");
  const r = await run(db, "booking.running_late", { booking_id: match, person_id: people.Cal, minutes: 10 }, as("Cal"), { now: at("2026-12-02", "17:40") });
  assert.equal(r.plan.summary.en, "Tell the others in the match on Court 1, Wed, Dec 2, 6:00 PM that you're running about 10 minutes late.");
  await rejects(plan(db, "booking.mark_no_show", { booking_player_id: (await seat("Eve")).id }, as("Hal"), { now: at("2026-12-02", "17:00") }), "error.no_show_window");
  await rejects(plan(db, "booking.mark_no_show", { booking_player_id: (await seat("Eve")).id }, as("Cal"), { now: at("2026-12-02", "20:00") }), "error.forbidden_reason");
  const n = await run(db, "booking.mark_no_show", { booking_player_id: (await seat("Eve")).id }, as("Hal"), { now: at("2026-12-02", "20:00") });
  assert.equal(n.plan.summary.en, "Mark Eve as not having come to the match on Court 1, Wed, Dec 2, 6:00 PM. It goes on their record for 90 days, and they're told.");
  assert.deepEqual((await playerRecord(db, [people.Eve!])).get(people.Eve!), { no_shows: 1, late_leaves: 0 });
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Hal", "match_running_late")).body, "Cal is running about 10 minutes late for Court 1, Wed, Dec 2, 6:00 PM.");
  assert.equal((await db.selectFrom("outbound_message").select("id").where("person_id", "=", people.Cal!).where("kind", "=", "match_running_late").execute()).length, 0);   // not to Cal
  assert.equal((await inbox("Eve", "match_no_show")).subject, "Marked as not coming: Court 1, Wed, Dec 2, 6:00 PM");
});
