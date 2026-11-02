import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, openPayment, plan, run, runAsSystem, setPaymentProvider, settleShares, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

// Same-day open matches: opened after the club's "pay my part" deadline, each player pays when they join, and
// the match has its own cutoff (2 hours before, by default). Not full by then, it's cancelled and everyone is paid back.
let db: Db, drop: () => Promise<void>, owner: Actor, court: string, court2: string, match: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (hhmm: string) => new Date(`2026-11-30T${hhmm}:00-08:00`);
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
const open = (who: string, hhmm: string, c = court) => ({ court_id: c, starts_at: at(hhmm).toISOString(), minutes: 90, pay: "split", person_id: people[who], open: { level_min: 3, level_max: 4 } });
const join = async (who: string, booking = match, now = NOW) => (await run(db, "booking.join", { booking_id: booking, person_id: people[who] }, as(who), { now })).result as { payment_id: string };
const status = async (id: string) => (await db.selectFrom("booking").select(["status", "settled_at", "cancel_reason"]).where("id", "=", id).executeTakeFirstOrThrow());

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const opts = { now: NOW };
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  court2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const [name, level] of [["Hal", 3.5], ["Ann", 3.4], ["Dee", 3.6], ["Eve", 3.3], ["Fay", 3.5]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
    await run(db, "level.set", { person_id: people[name], level, reason: "Starting level" }, owner, opts);
  }
});
after(async () => drop());

test("past the deadline a shared booking can't be set up, but an open match can, as a same-day match, until the cutoff", async () => {
  await rejects(plan(db, "booking.request", { ...open("Hal", "18:00"), open: undefined }, as("Hal"), { now: NOW }), "error.too_late_to_split");
  await rejects(plan(db, "booking.request", open("Hal", "09:30"), as("Hal"), { now: NOW }), "error.too_late_for_match",
    "An open match has to be opened more than 2 hours before it starts, so it has time to fill.");
  const r = await run(db, "booking.request", open("Hal", "18:00"), as("Hal"), { now: NOW });
  assert.equal(r.plan.summary.en, "Book Court 1, Mon, Nov 30, 6:00 PM, for 90 minutes: $60.00, split between 4 players. You pay your part, $15.00, now, and each player who joins pays $15.00. "
    + "It's an open match for levels 3.00-4.00, rated (it counts for levels); players outside the band can ask you. If it isn't full 2 hours before, it's cancelled and everyone gets their money back. "
    + "It's a same-day match: each player pays their part when they join, and places can't be saved for friends.");
  match = (r.result as any).booking_id;
  await pay((r.result as any).payment_id, "Hal");
  const om = await db.selectFrom("open_match").select("cutoff_at").where("booking_id", "=", match).executeTakeFirstOrThrow();
  assert.equal(om.cutoff_at!.toISOString(), at("16:00").toISOString());
  // A match opened before the deadline keeps the club's deadline: no cutoff of its own.
  const early = await run(db, "booking.request", { ...open("Fay", "18:00"), starts_at: new Date("2026-12-02T18:00:00-08:00").toISOString() }, as("Fay"), { now: NOW });
  assert.equal((await db.selectFrom("open_match").select("cutoff_at").where("booking_id", "=", (early.result as any).booking_id).executeTakeFirstOrThrow()).cutoff_at, null);
});

test("each player pays when they join, places can't be saved, and leaving before the cutoff gives it all back", async () => {
  const ann = await join("Ann");
  assert.ok((await db.selectFrom("booking_player").select("held_until").where("booking_id", "=", match).where("person_id", "=", people.Ann!).executeTakeFirstOrThrow()).held_until);
  await pay(ann.payment_id, "Ann");
  await rejects(plan(db, "booking.save_place", { booking_id: match, person_id: people.Dee }, as("Hal"), { now: NOW }), "error.same_day_no_saving");
  const leave = await run(db, "booking.leave", { booking_id: match, person_id: people.Ann }, as("Ann"), { now: at("12:00") });
  assert.equal(leave.plan.summary.en, "Leave the match on Court 1, Mon, Nov 30, 6:00 PM. Your $15.00 goes back to your card and your place opens for someone else.");
  const back = await db.selectFrom("refund").select("amount_cents").where("payment_id", "=", ann.payment_id).executeTakeFirstOrThrow();
  assert.equal(back.amount_cents, 1500);
});

test("not full at the cutoff, it's cancelled and everyone paid back; a full one goes ahead", async () => {
  // Another same-day match, on Court 2 at 8 pm (cutoff 6 pm), that fills.
  const r = await run(db, "booking.request", open("Dee", "20:00", court2), as("Dee"), { now: NOW });
  const full = (r.result as any).booking_id;
  await pay((r.result as any).payment_id, "Dee");
  for (const who of ["Eve", "Ann", "Fay"]) await pay((await join(who, full)).payment_id, who);

  assert.deepEqual(await settleShares(db, at("15:59")), { settled: 0, charged: 0, failed: 0, cancelled: 0 });
  assert.equal((await status(match)).status, "confirmed");
  const cut = await settleShares(db, at("16:00"));
  assert.equal(cut.cancelled, 1);
  assert.deepEqual({ ...(await status(match)), settled_at: undefined }, { status: "cancelled", settled_at: undefined, cancel_reason: "not_filled" });
  const halPaid = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id")
    .where("booking_player.booking_id", "=", match).where("booking_player.person_id", "=", people.Hal!).where("payment.status", "=", "succeeded").executeTakeFirstOrThrow();
  assert.equal((await db.selectFrom("refund").select("amount_cents").where("payment_id", "=", halPaid.id).executeTakeFirstOrThrow()).amount_cents, 1500);

  assert.equal((await status(full)).settled_at, null);   // its cutoff is later
  assert.equal((await settleShares(db, at("18:00"))).cancelled, 0);
  const s = await status(full);
  assert.equal(s.status, "confirmed"); assert.ok(s.settled_at);
});

test("staff set the same-day cutoff in the booking rules", async () => {
  const r = await run(db, "policy.set", { same_day_cutoff_hours: 3 }, owner, { now: NOW });
  assert.match(r.plan.summary.en, /shared costs settled 24 hours before; a same-day open match has to be full 3 hours before;/);
  await rejects(plan(db, "booking.request", open("Eve", "10:30"), as("Eve"), { now: NOW }), "error.too_late_for_match",
    "An open match has to be opened more than 3 hours before it starts, so it has time to fill.");
  await rejects(plan(db, "policy.set", { same_day_cutoff_hours: 0 }, owner, { now: NOW }), "error.invalid_input");
});
