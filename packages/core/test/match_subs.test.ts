import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, messageHandlers, openPayment, plan, playerRecord, processOutbox, run, runAsSystem, setPaymentProvider, settleShares, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

// A club whose rules for late leavers aren't the defaults: half back when their own sub takes the place,
// nothing when the club fills it, a quarter when nobody does.
let db: Db, drop: () => Promise<void>, owner: Actor, court: string, court2: string, match: string, older: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am; the match is Wed 2 Dec, 6 pm; its deadline Tue 6 pm
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`);
const LATE = at("2026-12-01", "19:00");
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
async function pay(paymentId: string, who: string, now = NOW) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test", now);
}
async function befriend(a: string, b: string) {
  const code = async (who: string) => (await db.selectFrom("person").select("friend_code").where("id", "=", people[who]!).executeTakeFirstOrThrow()).friend_code;
  await run(db, "friend.add_by_code", { person_id: people[a], code: await code(b) }, as(a));
  await run(db, "friend.add", { person_id: people[b], friend_id: people[a] }, as(b));
}
const seat = (who: string, booking = match) => db.selectFrom("booking_player").selectAll().where("booking_id", "=", booking).where("person_id", "=", people[who]!).orderBy("id", "desc").executeTakeFirstOrThrow();
const back = async (who: string, booking = match) => Number((await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").select((eb) => eb.fn.coalesce(eb.fn.sum<string>("refund.amount_cents"), eb.val("0")).as("c"))
  .where("payment.booking_player_id", "=", (await seat(who, booking)).id).executeTakeFirstOrThrow()).c);
const joinPaid = async (who: string, booking: string, now = NOW) => pay(((await run(db, "booking.join", { booking_id: booking, person_id: people[who] }, as(who), { now })).result as any).payment_id, who, now);
async function openMatch(c: string, start: Date) {
  const r = (await run(db, "booking.request", { court_id: c, starts_at: start.toISOString(), minutes: 90, pay: "split", person_id: people.Hal, open: { level_min: 3, level_max: 4 } }, as("Hal"), { now: NOW })).result as any;
  await pay(r.payment_id, "Hal");
  return r.booking_id as string;
}
const email = async (who: string, kind: string) => (await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who] ?? who).where("kind", "=", kind).where("channel", "=", "email")
  .orderBy("created_at", "desc").executeTakeFirstOrThrow());

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  people.Robin = owner.personId!;
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  court2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true }, owner, { now: NOW });
  for (const [name, level] of [["Hal", 3.5], ["Ann", 3.4], ["Dee", 3.6], ["Eve", 3.3], ["Fay", 3.5], ["Ben", 4.2], ["Gus", 3.5], ["Ivy", 3.4]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await run(db, "level.set", { person_id: people[name], level, reason: "Starting level" }, owner);
  }
  // A match booked under the default rules, before the club changed them; it keeps them.
  older = await openMatch(court2, at("2026-12-02", "18:00"));
  for (const who of ["Gus", "Ivy", "Fay"]) await joinPaid(who, older);
  const p = await run(db, "policy.set", { late_sub_refund_percent: 50, late_filled_refund_percent: 0, late_empty_refund_percent: 25 }, owner, { now: NOW });
  assert.match(p.plan.summary.en, /a player who can't make a match after the deadline gets back 50% when their own sub takes the place, 0% when the club fills it with a paying player, and 25% when nobody takes it\. Bookings already made keep their rules\.$/);
  match = await openMatch(court, at("2026-12-02", "18:00"));
  for (const who of ["Ann", "Dee", "Eve"]) await joinPaid(who, match);
  await befriend("Ann", "Fay"); await befriend("Ann", "Ben");
});
after(async () => drop());

test("a friend takes my place before the deadline: they pay, the place is theirs, and it all comes back to me", async () => {
  await rejects(plan(db, "booking.offer_place", { booking_id: match, person_id: people.Ann, to_person_id: people.Ben }, as("Ann"), { now: NOW }), "error.sub_outside_band",
    "Ben's level (4.20) is outside this match's band (3.00-4.00), so they can't take your place.");
  await rejects(plan(db, "booking.offer_place", { booking_id: match, person_id: people.Ann, to_person_id: people.Gus }, as("Ann"), { now: NOW }), "error.sub_not_friend");
  await rejects(plan(db, "booking.offer_place", { booking_id: match, person_id: people.Hal }, as("Hal"), { now: NOW }), "error.host_cancels");
  const o = await run(db, "booking.offer_place", { booking_id: match, person_id: people.Ann, to_person_id: people.Fay }, as("Ann"), { now: NOW });
  assert.equal(o.plan.summary.en, "Ask Fay to take your place in the match on Court 1, Wed, Dec 2, 6:00 PM. When they pay their $15.00 in the app, the place is theirs and $15.00 goes back to your card "
    + "($7.50 if they pay after the deadline). Until then you're still in.");
  const code = (o.result as any).code;
  await rejects(plan(db, "booking.take_place", { code, person_id: people.Gus }, as("Gus"), { now: NOW }), "error.offer_not_yours");
  const t = await run(db, "booking.take_place", { code, person_id: people.Fay }, as("Fay"), { now: NOW });
  assert.equal(t.plan.summary.en, "Take Ann's place in the match on Court 1, Wed, Dec 2, 6:00 PM: $15.00, paid now. Once it's paid, the place is yours.");
  // Until Fay pays, Ann is in and the match is still full: Fay's seat isn't a fifth place.
  assert.equal((await seat("Ann")).removed_at, null);
  await rejects(plan(db, "booking.join", { booking_id: match, person_id: people.Gus }, as("Gus"), { now: NOW }), "error.booking_full");
  await pay((t.result as any).payment_id, "Fay");
  assert.ok((await seat("Ann")).removed_at);
  assert.deepEqual([(await seat("Fay")).replaces, (await seat("Fay")).held_until], [null, null]);
  assert.equal(await back("Ann"), 1500);
  assert.equal((await playerRecord(db, [people.Ann!])).get(people.Ann!)?.late_leaves ?? 0, 0);   // not a late cancellation
  await processOutbox(db, messageHandlers);
  assert.equal((await email("Fay", "match_place_offered")).body, "Ann can't make the match on Court 1, Wed, Dec 2, 6:00 PM, and asked you to take their place. Pay $15.00 in the app and it's yours.");
  assert.deepEqual(await email("Ann", "match_place_handed"), { subject: "Fay took your place: Court 1, Wed, Dec 2, 6:00 PM",
    body: "Fay paid and took your place in the match on Court 1, Wed, Dec 2, 6:00 PM. $15.00 goes back to your card." });
  const changed = await db.selectFrom("outbound_message").select(["person_id", "subject"]).where("kind", "=", "match_place_changed").where("channel", "=", "inbox").execute();
  assert.deepEqual(changed.map((m) => m.person_id).sort(), [people.Hal, people.Dee, people.Eve].sort());
  assert.equal(changed[0]!.subject, "Fay is in for Ann: Court 1, Wed, Dec 2, 6:00 PM");
});

test("after the deadline, a sub through a link brings back the club's rule (half); an offer taken back refunds a sub who pays late", async () => {
  assert.deepEqual(await settleShares(db, at("2026-12-01", "18:00")), { settled: 2, charged: 0, failed: 0, cancelled: 0 });   // both full: they go ahead
  const o = await run(db, "booking.offer_place", { booking_id: match, person_id: people.Dee }, as("Dee"), { now: LATE });
  assert.equal(o.plan.summary.en, "Make a link for someone to take your place in the match on Court 1, Wed, Dec 2, 6:00 PM. Whoever uses it (inside the band, 3.00-4.00) pays $15.00 in the app; "
    + "then the place is theirs and $7.50 goes back to your card. Until then you're still in.");
  const code = (o.result as any).code;
  await rejects(plan(db, "booking.take_place", { code, person_id: people.Ben }, as("Ben"), { now: LATE }), "error.take_outside_band",
    "Your level (4.20) is outside this match's band (3.00-4.00), so you can't take this place.");
  // Ivy starts paying, then Dee takes the offer back: Ivy's payment, going through anyway, comes back to her.
  const ivy = (await run(db, "booking.take_place", { code, person_id: people.Ivy }, as("Ivy"), { now: LATE })).result as any;
  await openPayment(db, ivy.payment_id, people.Ivy!);
  const offer = (await db.selectFrom("place_offer").select("id").where("code", "=", code).executeTakeFirstOrThrow()).id;
  const w = await run(db, "booking.withdraw_offer", { offer_id: offer }, as("Dee"), { now: LATE });
  assert.equal(w.plan.summary.en, "Take back the offer of your place in the match on Court 1, Wed, Dec 2, 6:00 PM. You stay in the match.");
  await rejects(plan(db, "booking.take_place", { code, person_id: people.Gus }, as("Gus"), { now: LATE }), "error.offer_closed");
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", ivy.payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, ivy.payment_id, "test", LATE);
  assert.equal((await db.selectFrom("refund").select("amount_cents").where("payment_id", "=", ivy.payment_id).executeTakeFirstOrThrow()).amount_cents, 1500);
  assert.equal((await seat("Dee")).removed_at, null);
  // A new link: Gus takes it and pays, and Dee gets the club's half.
  const again = (await run(db, "booking.offer_place", { booking_id: match, person_id: people.Dee }, as("Dee"), { now: LATE })).result as any;
  await pay(((await run(db, "booking.take_place", { code: again.code, person_id: people.Gus }, as("Gus"), { now: LATE })).result as any).payment_id, "Gus", LATE);
  assert.ok((await seat("Dee")).removed_at);
  assert.equal(await back("Dee"), 750);
});

test("backing out after the deadline: the club's quarter now, the desk hears once, and staff open the place (choosing all of it back)", async () => {
  const l = await run(db, "booking.leave", { booking_id: match, person_id: people.Eve }, as("Eve"), { now: LATE });
  assert.equal(l.plan.summary.en, "Say you can't make the match on Court 1, Wed, Dec 2, 6:00 PM. It's past the deadline, so it counts as a late cancellation: you get $3.75 back now, "
    + "or $3.75 in all if the club fills your place with a paying player. If you find a player to take your place instead, you get $7.50 back and it isn't a late cancellation.");
  assert.equal(await back("Eve"), 375);
  assert.equal((await playerRecord(db, [people.Eve!])).get(people.Eve!)!.late_leaves, 1);
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await email("Robin", "match_late_cancel_staff"), { subject: "Late cancellation: Court 1, Wed, Dec 2, 6:00 PM",
    body: "Eve can't make the match on Court 1, Wed, Dec 2, 6:00 PM, after the deadline, so a place is empty. Open it in the app or give it to someone on the Schedule." });
  const eve = (await seat("Eve")).id;
  await rejects(plan(db, "booking.join", { booking_id: match, person_id: people.Ivy }, as("Ivy"), { now: LATE }), "error.invite_settled");
  await rejects(plan(db, "booking.reopen_place", { booking_player_id: eve }, as("Hal"), { now: LATE }), "error.forbidden_reason");   // staff only
  const rule = await plan(db, "booking.reopen_place", { booking_player_id: eve }, owner, { now: LATE });
  assert.equal(rule.plan.summary.en, "Open Eve's place in the match on Court 1, Wed, Dec 2, 6:00 PM in the app, for a player inside the band (3.00-4.00) to join and pay $15.00. "
    + "When one does, Eve gets back $3.75 in all (the club's rule when it fills a place: 0%).");
  const full = await run(db, "booking.reopen_place", { booking_player_id: eve, refund: "full" }, owner, { now: LATE });
  assert.match(full.plan.summary.en, /When one does, Eve gets back \$15\.00 in all \(you chose all of it\)\.$/);
  await joinPaid("Ivy", match, LATE);
  assert.ok((await seat("Eve")).removed_at);
  assert.equal(await back("Eve"), 1500);   // the quarter already back, and the rest now
  await processOutbox(db, messageHandlers);
  assert.equal((await email("Eve", "match_place_taken")).body, "Ivy has taken your place in the match on Court 1, Wed, Dec 2, 6:00 PM. $11.25 goes back to your card.");
});

test("staff give an empty place free: nothing is charged, and the player keeps what the club's rule gave", async () => {
  await run(db, "booking.leave", { booking_id: match, person_id: people.Fay }, as("Fay"), { now: LATE });
  assert.equal(await back("Fay"), 375);
  const fay = (await seat("Fay")).id;
  const none = await plan(db, "booking.give_place", { booking_player_id: fay, person_id: people.Ben, refund: "none" }, owner, { now: LATE });
  assert.match(none.plan.summary.en, /Fay gets back \$3\.75 in all \(you chose nothing more than they've had\)\.$/);
  const g = await run(db, "booking.give_place", { booking_player_id: fay, person_id: people.Ben }, owner, { now: LATE });
  assert.equal(g.plan.summary.en, "Give Fay's place in the match on Court 1, Wed, Dec 2, 6:00 PM to Ben, free: nothing is charged. Fay gets back $3.75 in all (the club's rule when nobody pays for a place: 25%).");
  const ben = await seat("Ben");
  assert.equal(ben.share_cents, 0);
  assert.equal((await db.selectFrom("payment").select("id").where("booking_player_id", "=", ben.id).execute()).length, 0);
  assert.equal(await back("Fay"), 375);
  await processOutbox(db, messageHandlers);
  assert.equal((await email("Ben", "match_place_given")).body, "The club gave you a place in the match on Court 1, Wed, Dec 2, 6:00 PM, free. See you there.");
  assert.equal((await email("Fay", "match_place_taken")).body, "Ben has taken your place in the match on Court 1, Wed, Dec 2, 6:00 PM. Under the club's rules, nothing more comes back.");
  await rejects(plan(db, "booking.give_place", { booking_player_id: fay, person_id: people.Ann }, owner, { now: LATE }), "error.place_not_empty");
});

test("a match keeps the rules it was booked under", async () => {
  const p = await plan(db, "booking.leave", { booking_id: older, person_id: people.Gus }, as("Gus"), { now: LATE });
  assert.match(p.plan.summary.en, /you get \$0\.00 back now, or \$15\.00 in all if the club fills your place with a paying player\. If you find a player to take your place instead, you get \$15\.00 back/);
});
