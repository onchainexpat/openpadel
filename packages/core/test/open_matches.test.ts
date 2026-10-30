import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, messageHandlers, openPayment, plan, processOutbox, releaseSeats, run, runAsSystem, setPaymentProvider, settleShares, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string, match: string, friendly: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}
const join = async (who: string, booking = match, now = NOW) => (await run(db, "booking.join", { booking_id: booking, person_id: people[who] }, as(who), { now })).result as { payment_id: string };
const seat = (who: string, booking = match) => db.selectFrom("booking_player").selectAll().where("booking_id", "=", booking).where("person_id", "=", people[who]!).orderBy("id", "desc").executeTakeFirstOrThrow();
const inbox = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "inbox").orderBy("created_at", "desc").executeTakeFirstOrThrow();

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const opts = { now: NOW };
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const [name, level] of [["Hal", 3.5], ["Ann", 3.4], ["Ben", 4.2], ["Cal", null], ["Dee", 3.6], ["Eve", 3.3]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
    if (level !== null) await run(db, "level.set", { person_id: people[name], level, reason: "Starting level" }, owner, opts);
  }
});
after(async () => drop());

test("opening a match: the preview says the band, what it counts for, and what happens if it doesn't fill", async () => {
  const input = { court_id: court, starts_at: at("2026-12-02", "18:00"), minutes: 90, pay: "split", person_id: people.Hal, open: { level_min: 3, level_max: 4 } };
  const r = await run(db, "booking.request", input, as("Hal"), { now: NOW });
  assert.equal(r.plan.summary.en, "Book Court 1, Wed, Dec 2, 6:00 PM, for 90 minutes: $60.00, split between 4 players. You pay your part, $15.00, now, and each player who joins pays $15.00. "
    + "It's an open match for levels 3.00-4.00, rated (it counts for levels); players outside the band can ask you. If it isn't full 24 hours before, it's cancelled and everyone gets their money back.");
  match = (r.result as any).booking_id;
  await pay((r.result as any).payment_id, "Hal");
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", match).executeTakeFirstOrThrow()).status, "confirmed");
  const hostPay = await db.selectFrom("payment").select(["save_card", "saved_method"]).where("id", "=", (r.result as any).payment_id).executeTakeFirstOrThrow();
  assert.deepEqual([hostPay.save_card, hostPay.saved_method], [false, null]);   // nothing will ever go on the host's card, so it isn't kept
  await rejects(plan(db, "booking.request", { ...input, pay: "whole" }, as("Hal"), { now: NOW }), "error.open_match_split");
  await rejects(plan(db, "booking.request", { ...input, open: { level_min: 4, level_max: 3 } }, as("Hal"), { now: NOW }), "error.bad_band");
});

test("inside the band a player joins and pays; outside it they ask, and the host says yes or no", async () => {
  const ann = await join("Ann");
  assert.ok((await seat("Ann")).held_until);   // held while she pays
  await pay(ann.payment_id, "Ann");
  assert.equal((await seat("Ann")).held_until, null);
  await rejects(plan(db, "booking.join", { booking_id: match, person_id: people.Ben }, as("Ben"), { now: NOW }), "error.outside_band_ask",
    "Your level (4.20) is outside this match's band (3.00-4.00). You can ask the host to let you in.");
  await rejects(plan(db, "booking.join", { booking_id: match, person_id: people.Cal }, as("Cal"), { now: NOW }), "error.outside_band_ask",
    "Your level (no level yet) is outside this match's band (3.00-4.00). You can ask the host to let you in.");

  const ask = await run(db, "booking.ask", { booking_id: match, person_id: people.Ben }, as("Ben"), { now: NOW });
  assert.equal(ask.plan.summary.en, "Ask Hal to let you into their match on Court 1, Wed, Dec 2, 6:00 PM. If they say yes, your place is held for 1 hour while you pay $15.00.");
  await rejects(plan(db, "booking.ask", { booking_id: match, person_id: people.Ben }, as("Ben"), { now: NOW }), "error.already_asked");
  const benAsk = (ask.result as any).request_id;
  await rejects(plan(db, "booking.answer_ask", { request_id: benAsk, approve: true }, as("Ann"), { now: NOW }), "error.forbidden_reason");   // only the host
  const yes = await run(db, "booking.answer_ask", { request_id: benAsk, approve: true }, as("Hal"), { now: NOW });
  assert.equal(yes.plan.summary.en, "Let Ben (level 4.20; the band is 3.00-4.00) into your match. Their place is held for 1 hour while they pay $15.00.");
  const ben = await seat("Ben");
  assert.equal(ben.held_until!.toISOString(), later(60).toISOString());
  assert.equal((await db.selectFrom("payment").select(["amount_cents", "status"]).where("booking_player_id", "=", ben.id).executeTakeFirstOrThrow()).amount_cents, 1500);

  const calAsk = (await run(db, "booking.ask", { booking_id: match, person_id: people.Cal }, as("Cal"), { now: NOW })).result as any;
  await run(db, "booking.answer_ask", { request_id: calAsk.request_id, approve: false }, as("Hal"), { now: NOW });

  await processOutbox(db, messageHandlers);
  const email = async (who: string, kind: string) => (await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "email").executeTakeFirstOrThrow());
  assert.equal((await email("Hal", "match_ask")).body, "Ben (level 4.20) asks to join your match on Court 1, Wed, Dec 2, 6:00 PM. The band is 3.00-4.00. Say yes or no in the app.");
  assert.equal((await email("Ben", "match_ask_yes")).body, "Hal said yes. Your place is held for 1 hour: pay $15.00 in the app to keep it.");
  assert.equal((await email("Cal", "match_ask_no")).subject, "Not this time: Court 1, Wed, Dec 2, 6:00 PM");
  assert.equal((await inbox("Hal", "match_player_in")).body, "Ann is in your match on Court 1, Wed, Dec 2, 6:00 PM. 2 places left.");
});

test("a seat not paid in time opens again; an open card form is called off first, and one that went through stays", async () => {
  // Hal, Ann (paid) and Ben (approved, unpaid): Dee takes the last seat and never pays.
  await join("Dee");
  assert.deepEqual(await releaseSeats(db, later(9)), { released: 0 });
  assert.deepEqual(await releaseSeats(db, later(10)), { released: 1 });   // Dee's seat
  assert.ok((await seat("Dee")).removed_at);

  // Eve takes it and opens the card form, then wanders off: the payment is called off, and the seat opens.
  const eve = await join("Eve", match, later(11));
  await openPayment(db, eve.payment_id, people.Eve!);
  assert.deepEqual(await releaseSeats(db, later(21)), { released: 1 });
  const evePay = await db.selectFrom("payment").select(["status", "provider_ref"]).where("id", "=", eve.payment_id).executeTakeFirstOrThrow();
  assert.equal(evePay.status, "failed");
  assert.equal(stripe.intents.get(evePay.provider_ref!)!.status, "failed");   // called off at the provider: it can't go through later

  // Dee tries again and pays just as her time runs out: the payment is kept, and so is the seat.
  const dee = await join("Dee", match, later(22));
  await openPayment(db, dee.payment_id, people.Dee!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", dee.payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.deepEqual(await releaseSeats(db, later(32)), { released: 0 });
  assert.deepEqual([(await seat("Dee")).removed_at, (await seat("Dee")).held_until], [null, null]);

  // Ben, approved an hour ago, never paid.
  assert.deepEqual(await releaseSeats(db, later(61)), { released: 1 });
  assert.ok((await seat("Ben")).removed_at);
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Ben", "match_seat_released")).subject, "Your place wasn't paid: Court 1, Wed, Dec 2, 6:00 PM");
});

test("not full at the deadline: it's cancelled, the court is free, and everyone gets back all they paid (a saved place nobody paid for is empty)", async () => {
  // Hal, Ann and Dee have paid; Cal's place is saved but not paid.
  await run(db, "booking.save_place", { booking_id: match, person_id: people.Cal }, as("Hal"), { now: NOW });
  const charges = stripe.charges.length;
  assert.deepEqual(await settleShares(db, new Date(at("2026-12-01", "17:59"))), { settled: 0, charged: 0, failed: 0, cancelled: 0 });
  assert.deepEqual(await settleShares(db, new Date(at("2026-12-01", "18:00"))), { settled: 1, charged: 0, failed: 0, cancelled: 1 });
  assert.equal(stripe.charges.length, charges);   // nothing on the host's card
  const b = await db.selectFrom("booking").select(["status", "cancel_reason"]).where("id", "=", match).executeTakeFirstOrThrow();
  assert.deepEqual([b.status, b.cancel_reason], ["cancelled", "not_filled"]);
  assert.equal((await db.selectFrom("court_time").select("id").where("booking_id", "=", match).where("active", "=", true).execute()).length, 0);
  const back = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .select(["booking_player.person_id", "refund.amount_cents"]).where("booking_player.booking_id", "=", match).execute();
  assert.deepEqual(back.map((x) => [x.person_id, x.amount_cents]).sort(), [[people.Hal, 1500], [people.Ann, 1500], [people.Dee, 1500]].sort());
  assert.equal((await db.selectFrom("payment").select("status").where("booking_player_id", "=", (await seat("Cal")).id).executeTakeFirstOrThrow()).status, "failed");
  await rejects(plan(db, "booking.join", { booking_id: match, person_id: people.Eve }, as("Eve"), { now: new Date(at("2026-12-01", "18:05")) }), "error.invite_closed");
  assert.deepEqual(await settleShares(db, new Date(at("2026-12-01", "18:05"))), { settled: 0, charged: 0, failed: 0, cancelled: 0 });   // once
  await processOutbox(db, messageHandlers);
  const told = async (who: string) => (await db.selectFrom("outbound_message").select("body").where("person_id", "=", people[who]!).where("kind", "=", "match_not_filled").where("channel", "=", "email").executeTakeFirstOrThrow()).body;
  assert.equal(await told("Hal"), "Your match on Court 1, Wed, Dec 2, 6:00 PM, didn't fill by the deadline, so it's cancelled and the court is free. $15.00 goes back to your card.");
  assert.equal(await told("Cal"), "Your match on Court 1, Wed, Dec 2, 6:00 PM, didn't fill by the deadline, so it's cancelled and the court is free.");
  assert.equal((await db.selectFrom("outbound_message").select("subject").where("person_id", "=", people.Ann!).where("kind", "=", "match_not_filled").where("channel", "=", "inbox").executeTakeFirstOrThrow()).subject,
    "Cancelled, not full: Court 1, Wed, Dec 2, 6:00 PM");
});

test("a match kept to its band; a booking that isn't an open match can't be joined by its id", async () => {
  const f = await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-04", "10:00"), minutes: 90, pay: "split", person_id: people.Hal,
    open: { level_min: 3.25, level_max: 3.75, outside_band: "closed", rated: false } }, as("Hal"), { now: NOW });
  assert.match(f.plan.summary.en, /a friendly \(it doesn't count for levels\); players outside the band can't join\. If it isn't full 24 hours before, it's cancelled/);
  friendly = (f.result as any).booking_id;
  await pay((f.result as any).payment_id, "Hal");
  await rejects(plan(db, "booking.join", { booking_id: friendly, person_id: people.Ben }, as("Ben"), { now: NOW }), "error.outside_band");
  await rejects(plan(db, "booking.ask", { booking_id: friendly, person_id: people.Ben }, as("Ben"), { now: NOW }), "error.match_closed_outside");
  // A booking that isn't an open match can't be joined by its id (only from its link).
  const plain = await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-05", "10:00"), minutes: 90, pay: "split", person_id: people.Ann }, as("Ann"), { now: NOW });
  await pay((plain.result as any).payment_id, "Ann");
  await rejects(plan(db, "booking.join", { booking_id: (plain.result as any).booking_id, person_id: people.Eve }, as("Eve"), { now: NOW }), "error.invite_closed");
});

test("a full match goes ahead at the deadline; if its host cancels late, the players who joined still get everything back", async () => {
  const r = await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-03", "10:00"), minutes: 90, pay: "split", person_id: people.Hal, open: { level_min: 3, level_max: 4 } }, as("Hal"), { now: NOW });
  const id = (r.result as any).booking_id;
  await pay((r.result as any).payment_id, "Hal");
  for (const who of ["Ann", "Dee", "Eve"]) await pay((await join(who, id)).payment_id, who);
  assert.deepEqual(await settleShares(db, new Date(at("2026-12-02", "10:00"))), { settled: 1, charged: 0, failed: 0, cancelled: 0 });
  assert.equal((await db.selectFrom("booking").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status, "confirmed");
  const late = new Date(at("2026-12-03", "08:00"));
  const code = (await db.selectFrom("booking").select("code").where("id", "=", id).executeTakeFirstOrThrow()).code;
  const c = await run(db, "booking.cancel", { booking_id: id }, as("Hal"), { now: late });
  assert.equal(c.plan.summary.en, `Cancel booking ${code}; the court is free again. Nothing goes back to the host's card (it's less than 24 hours before), but the players who joined get back everything they paid ($45.00).`);
  const back = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .select(["booking_player.person_id", "refund.amount_cents"]).where("booking_player.booking_id", "=", id).execute();
  assert.deepEqual(back.map((x) => [x.person_id, x.amount_cents]).sort(), [[people.Ann, 1500], [people.Dee, 1500], [people.Eve, 1500]].sort());
  await processOutbox(db, messageHandlers);
  const ann = await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Ann!).where("kind", "=", "booking_cancelled").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.match(ann.body, /is cancelled\. \$15\.00 goes back to your card\.$/);
});
