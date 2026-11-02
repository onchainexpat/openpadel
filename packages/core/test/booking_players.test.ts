import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, findPlayers, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

// Players on a court booked in full: the booker names them (people they know, by name) or shares the players
// link; nobody pays, taking someone off moves no money, and with four on it the score counts if the booker says so.
let db: Db, drop: () => Promise<void>, owner: Actor, court: string, booking: string, code: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const START = new Date("2026-12-02T18:00:00-08:00"), AFTER = new Date("2026-12-02T20:00:00-08:00");
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code_: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code_); if (text) assert.equal(e.text.en, text); return true; });
}
const seats = async () => (await db.selectFrom("booking_player").innerJoin("person", "person.id", "booking_player.person_id").select(["booking_player.id", "person.display_name", "booking_player.share_cents"])
  .where("booking_id", "=", booking).where("removed_at", "is", null).orderBy("booking_player.id").execute());
const paymentsNow = async () => Number((await db.selectFrom("payment").select((e) => e.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);

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
  for (const [name, level] of [["Hal", 3.5], ["Ann", 3.4], ["Andy", 3.6], ["Dee", 3.3], ["Eve", 3.5], ["Annabel", 3.0]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
    await run(db, "level.set", { person_id: people[name], level, reason: "Starting level" }, owner, opts);
  }
  // Ann is Hal's friend; Andy is a member Hal has never played with or swapped links with.
  const fc = async (who: string) => (await db.selectFrom("person").select("friend_code").where("id", "=", people[who]!).executeTakeFirstOrThrow()).friend_code;
  await run(db, "friend.add_by_code", { person_id: people.Hal, code: await fc("Ann") }, as("Hal"), opts);
  await run(db, "friend.add", { person_id: people.Ann, friend_id: people.Hal }, as("Ann"), opts);
  await run(db, "friend.add_by_code", { person_id: people.Hal, code: await fc("Dee") }, as("Hal"), opts);   // Hal added Dee (not yet back)
  const monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month" }, owner, opts)).result as any).plan_id;
  await run(db, "membership.grant", { person_id: people.Andy, plan_id: monthly }, owner, opts);

  const r = await run(db, "booking.request", { court_id: court, starts_at: START.toISOString(), minutes: 90, pay: "whole", person_id: people.Hal }, as("Hal"), opts);
  booking = (r.result as any).booking_id;
  await openPayment(db, (r.result as any).payment_id, people.Hal!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", (r.result as any).payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, (r.result as any).payment_id, "test", NOW);
  code = (await db.selectFrom("booking").select("invite_code").where("id", "=", booking).executeTakeFirstOrThrow()).invite_code!;
});
after(async () => drop());

test("finding players by name: only people the booker already knows; anyone else comes in by the players link", async () => {
  assert.deepEqual(await findPlayers(db, people.Hal!, "an"), [{ id: people.Ann, display_name: "Ann", friend: true }]);
  assert.deepEqual(await findPlayers(db, people.Hal!, "de"), [{ id: people.Dee, display_name: "Dee", friend: false }]);
  assert.deepEqual(await findPlayers(db, people.Hal!, "a"), []);   // two letters at least
});

test("the booker names players they know, who are told; others use the link; nothing is paid", async () => {
  const before_ = await paymentsNow();
  const r = await run(db, "booking.add_player", { booking_id: booking, person_id: people.Ann }, as("Hal"), { now: NOW });
  assert.equal(r.plan.summary.en, "Add Ann as a player on your booking on Court 1, Wed, Dec 2, 6:00 PM. There's nothing for them to pay. They're told, and they can enter the score after the game.");
  await rejects(plan(db, "booking.add_player", { booking_id: booking, person_id: people.Andy }, as("Hal"), { now: NOW }), "error.not_known_player",
    "You can name people you know here: friends, and people you've played with. Send anyone else the players link.");
  await run(db, "booking.join_players", { invite_code: code, person_id: people.Andy }, as("Andy"), { now: NOW });
  assert.equal(await paymentsNow(), before_);
  assert.deepEqual((await seats()).map((s) => [s.display_name, s.share_cents]), [["Hal", 6000], ["Ann", 0], ["Andy", 0]]);
  await rejects(plan(db, "booking.add_player", { booking_id: booking, person_id: people.Ann }, as("Hal"), { now: NOW }), "error.already_in_booking");
  await rejects(plan(db, "booking.add_player", { booking_id: booking, person_id: people.Dee }, as("Ann"), { now: NOW }), "error.forbidden_reason");   // only the booker
  await processOutbox(db, messageHandlers);
  const msg = await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people.Ann!).where("kind", "=", "booking_player_added").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.equal(msg.subject, "Hal added you to their booking: Court 1, Wed, Dec 2, 6:00 PM");
});

test("anyone with the players link adds themselves, free, and the booker hears", async () => {
  const r = await run(db, "booking.join_players", { invite_code: code, person_id: people.Dee }, as("Dee"), { now: NOW });
  assert.equal(r.plan.summary.en, "Join Hal's booking on Court 1, Wed, Dec 2, 6:00 PM as a player. The court is paid for, so there's nothing to pay.");
  await rejects(plan(db, "booking.join_players", { invite_code: code, person_id: people.Eve }, as("Eve"), { now: NOW }), "error.booking_full");
  // A link to a shared booking isn't a players link: that one is joined by paying.
  await rejects(plan(db, "booking.join", { invite_code: code, person_id: people.Eve }, as("Eve"), { now: NOW }), "error.invite_closed");
  await processOutbox(db, messageHandlers);
  assert.deepEqual((await db.selectFrom("outbound_message").select("subject").where("person_id", "=", people.Hal!).where("kind", "=", "booking_player_joined").where("channel", "=", "inbox")
    .orderBy("subject").execute()).map((m) => m.subject), ["Andy joined your booking: Court 1, Wed, Dec 2, 6:00 PM", "Dee joined your booking: Court 1, Wed, Dec 2, 6:00 PM"]);
});

test("taking a player off moves no money; a player can take themselves off", async () => {
  const before_ = await paymentsNow(), refunds = async () => Number((await db.selectFrom("refund").select((e) => e.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
  const r0 = await refunds();
  const dee = (await seats()).find((s) => s.display_name === "Dee")!;
  const off = await run(db, "booking.remove_player", { booking_player_id: dee.id }, as("Dee"), { now: NOW });
  assert.equal(off.plan.summary.en, "Take yourself off Hal's booking on Court 1, Wed, Dec 2, 6:00 PM. Nothing is paid or refunded.");
  await run(db, "booking.join_players", { invite_code: code, person_id: people.Eve }, as("Eve"), { now: NOW });
  const eve = (await seats()).find((s) => s.display_name === "Eve")!;
  const by = await run(db, "booking.remove_player", { booking_player_id: eve.id }, as("Hal"), { now: NOW });
  assert.equal(by.plan.summary.en, "Take Eve off your booking on Court 1, Wed, Dec 2, 6:00 PM. Nothing is paid or refunded, and they're told.");
  const hal = (await seats()).find((s) => s.display_name === "Hal")!;
  await rejects(plan(db, "booking.remove_player", { booking_player_id: hal.id }, as("Hal"), { now: NOW }), "error.not_in_match");   // the booker stays
  assert.deepEqual([await paymentsNow(), await refunds()], [before_, r0]);
  await run(db, "booking.join_players", { invite_code: code, person_id: people.Dee }, as("Dee"), { now: NOW });
});

test("the booker makes it count for levels; with four named, the score is entered and levels move", async () => {
  const on = await run(db, "booking.set_rated", { booking_id: booking, rated: true }, as("Hal"), { now: NOW });
  assert.equal(on.plan.summary.en, "Count the game on Court 1, Wed, Dec 2, 6:00 PM for levels: once its score is confirmed, the four players' levels move.");
  await rejects(plan(db, "booking.set_rated", { booking_id: booking, rated: false }, as("Ann"), { now: NOW }), "error.forbidden_reason");
  const halBefore = Number((await db.selectFrom("rating").select("level").where("person_id", "=", people.Hal!).executeTakeFirstOrThrow()).level);
  const g = await run(db, "result.enter", { booking_id: booking, person_id: people.Ann, partner_id: people.Hal, sets: [{ us: 6, them: 2 }, { us: 6, them: 3 }] }, as("Ann"), { now: AFTER });
  assert.match(g.plan.summary.en, /it counts for levels\.$/);
  await run(db, "result.confirm", { game_id: (g.result as any).game_id, person_id: people.Dee }, as("Dee"), { now: AFTER });
  assert.ok(Number((await db.selectFrom("rating").select("level").where("person_id", "=", people.Hal!).executeTakeFirstOrThrow()).level) > halBefore);
  // The score's in: the players and the choice stay as they were.
  const andy = (await seats()).find((s) => s.display_name === "Andy")!;
  await rejects(plan(db, "booking.remove_player", { booking_player_id: andy.id }, as("Hal"), { now: AFTER }), "error.players_scored");
  await rejects(plan(db, "booking.set_rated", { booking_id: booking, rated: false }, as("Hal"), { now: AFTER }), "error.players_scored");
});
