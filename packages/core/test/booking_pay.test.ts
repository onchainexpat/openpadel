import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, expireHolds, messageHandlers, openPayment, plan, processOutbox, remindBookings, run, runAsSystem, setPaymentProvider, settleShares, uuidv7, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
const request = (who: string, court: string, starts: string, extra: Record<string, unknown> = {}, now = NOW) =>
  run(db, "booking.request", { court_id: court, starts_at: starts, minutes: 90, pay: "whole", person_id: people[who], ...extra }, as(who), { now });
/** What the card form and Stripe do: open the payment, the person pays, and the app checks. */
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  return checkPayment(db, paymentId, "test");
}
const booking = (id: string) => db.selectFrom("booking").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const courtTime = (id: string) => db.selectFrom("court_time").select(["kind", "active", "hold_until"]).where("booking_id", "=", id).executeTakeFirstOrThrow();

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true }, owner, { now: NOW });
  for (const name of ["Ann", "Ben", "Cal", "Dee", "Eve"]) {
    const id = (await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, { now: NOW })).result as { person_id: string };
    people[name] = id.person_id;
  }
});
after(async () => drop());

test("pay the whole court: held while paying, then confirmed, and its court time is the booking's", async () => {
  const r = await request("Ann", c1, at("2026-12-02", "10:00"));
  assert.equal(r.plan.summary.en, "Book Court 1, Wed, Dec 2, 10:00 AM, for 90 minutes: $60.00, paid now.");
  const { booking_id, payment_id } = r.result as { booking_id: string; payment_id: string };
  assert.equal((await booking(booking_id)).status, "held");
  assert.equal((await courtTime(booking_id)).kind, "hold");
  assert.equal(await pay(payment_id, "Ann"), "succeeded");
  assert.equal((await booking(booking_id)).status, "confirmed");
  assert.deepEqual(await courtTime(booking_id), { kind: "booking", active: true, hold_until: null });
});

test("the club's rules: lengths, how far ahead, how many at once, splitting too late, bookings off", async () => {
  await rejects(request("Ben", c1, at("2026-12-02", "12:00"), { minutes: 45 }), "error.length_not_offered");
  await rejects(request("Ben", c1, at("2026-12-20", "12:00")), "error.too_far_ahead", "Courts can be booked up to 14 days ahead.");
  await rejects(request("Ben", c1, at("2026-12-01", "07:30"), { pay: "split" }), "error.too_late_to_split");
  for (const [k, hhmm] of [["a", "12:00"], ["b", "14:00"], ["c", "16:00"]] as const) { void k; await pay(((await request("Ben", c2, at("2026-12-03", hhmm))).result as any).payment_id, "Ben"); }
  await rejects(request("Ben", c2, at("2026-12-03", "18:00")), "error.too_many_bookings", "You already have 3 upcoming bookings, the club's limit.");
  await run(db, "club.update", { court_bookings: false }, owner, { now: NOW });
  await rejects(request("Cal", c2, at("2026-12-04", "10:00")), "error.bookings_off");
  await run(db, "club.update", { court_bookings: true }, owner, { now: NOW });
});

test("a hold nobody pays for lapses; a payment that arrives after is refunded", async () => {
  const r = (await request("Cal", c1, at("2026-12-04", "10:00"))).result as { booking_id: string; payment_id: string };
  await openPayment(db, r.payment_id, people.Cal!);
  assert.deepEqual(await expireHolds(db, later(5)), { lapsed: 0 });
  assert.deepEqual(await expireHolds(db, later(11)), { lapsed: 1 });
  assert.equal((await booking(r.booking_id)).cancel_reason, "not_paid");
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", r.payment_id).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded"); await checkPayment(db, r.payment_id, "test");
  const refund = await db.selectFrom("refund").selectAll().where("payment_id", "=", r.payment_id).executeTakeFirstOrThrow();
  assert.equal(refund.amount_cents, 6000);
});

test("someone else takes a court whose hold ran out: the late payer is refunded, not double-booked", async () => {
  const slow = (await request("Dee", c1, at("2026-12-05", "10:00"))).result as { booking_id: string; payment_id: string };
  await openPayment(db, slow.payment_id, people.Dee!);
  const fast = (await request("Eve", c1, at("2026-12-05", "10:00"), {}, later(12))).result as { booking_id: string; payment_id: string };
  await pay(fast.payment_id, "Eve");
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", slow.payment_id).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded"); await checkPayment(db, slow.payment_id, "test");
  assert.equal((await booking(slow.booking_id)).cancel_reason, "hold_lost");
  assert.equal((await booking(fast.booking_id)).status, "confirmed");
  assert.equal((await db.selectFrom("refund").select("amount_cents").where("payment_id", "=", slow.payment_id).executeTakeFirstOrThrow()).amount_cents, 6000);
});

test("pay my part: each pays a share; at the deadline the rest goes on the organiser's saved card, once", async () => {
  const r = await request("Dee", c2, at("2026-12-06", "18:00"), { pay: "split" });
  assert.equal(r.plan.summary.en, "Book Court 2, Sun, Dec 6, 6:00 PM, for 90 minutes: $60.00, split between 4 players. You pay your part, $15.00, now; the others pay $15.00 each in the app, and anything unpaid 24 hours before goes on your card.");
  const { booking_id, payment_id } = r.result as { booking_id: string; payment_id: string };
  await pay(payment_id, "Dee");
  const saved = await db.selectFrom("payment").select(["saved_customer", "saved_method"]).where("id", "=", payment_id).executeTakeFirstOrThrow();
  assert.ok(saved.saved_customer && saved.saved_method, "the organiser's card is saved, not held");
  const code = (await booking(booking_id)).invite_code!;
  const ben = (await run(db, "booking.join", { invite_code: code, person_id: people.Ben }, as("Ben"), { now: NOW })).result as { payment_id: string };
  await pay(ben.payment_id, "Ben");
  const cal = (await run(db, "booking.join", { invite_code: code, person_id: people.Cal }, as("Cal"), { now: NOW })).result as { payment_id: string };   // joins, doesn't pay
  await rejects(plan(db, "booking.join", { invite_code: code, person_id: people.Ben }, as("Ben"), { now: NOW }), "error.already_in_booking");
  assert.deepEqual(await settleShares(db, later(60)), { settled: 0, charged: 0, failed: 0, cancelled: 0 });   // not the deadline yet
  const deadline = new Date(new Date(at("2026-12-06", "18:00")).getTime() - 24 * 3600_000 + 60_000);
  assert.deepEqual(await settleShares(db, deadline), { settled: 1, charged: 1, failed: 0, cancelled: 0 });
  assert.equal(stripe.charges.at(-1)!.amountCents, 3000);   // Cal's share and the empty place
  assert.equal((await db.selectFrom("payment").select("status").where("id", "=", cal.payment_id).executeTakeFirstOrThrow()).status, "failed");
  assert.ok((await booking(booking_id)).settled_at);
  await rejects(plan(db, "booking.join", { invite_code: code, person_id: people.Eve }, as("Eve"), { now: deadline }), "error.invite_settled");
  assert.deepEqual(await settleShares(db, deadline), { settled: 0, charged: 0, failed: 0, cancelled: 0 });   // once
});

test("when the saved card is declined at the deadline, the booking shows what's owed", async () => {
  const r = (await request("Eve", c2, at("2026-12-07", "18:00"), { pay: "split", players: 2 })).result as { booking_id: string; payment_id: string };
  await pay(r.payment_id, "Eve");
  stripe.failNextCharge = "card_declined";
  const deadline = new Date(new Date(at("2026-12-07", "18:00")).getTime() - 23 * 3600_000);
  assert.deepEqual(await settleShares(db, deadline), { settled: 1, charged: 0, failed: 1, cancelled: 0 });
  assert.equal((await booking(r.booking_id)).balance_cents, 3000);
});

test("cancelling: early gets everything back, late gets the club's rule, and staff can choose", async () => {
  const early = (await request("Cal", c1, at("2026-12-08", "10:00"))).result as { booking_id: string; payment_id: string };
  await pay(early.payment_id, "Cal");
  const e = await run(db, "booking.cancel", { booking_id: early.booking_id }, as("Cal"), { now: NOW });
  assert.equal(e.plan.summary.en, "Cancel booking " + (await booking(early.booking_id)).code + "; the court is free again. $60.00 goes back to the card.");
  const late = (await request("Cal", c1, at("2026-12-01", "07:00"))).result as { booking_id: string; payment_id: string };   // 23 hours ahead
  await pay(late.payment_id, "Cal");
  const p = await plan(db, "booking.cancel", { booking_id: late.booking_id }, as("Cal"), { now: NOW });
  assert.match(p.plan.summary.en, /Nothing comes back: it's less than 24 hours before\.$/);
  const staff = await plan(db, "booking.cancel", { booking_id: late.booking_id, refund: "full", reason: "rain" }, owner, { now: NOW });
  assert.match(staff.plan.summary.en, /\$60\.00 goes back to the card\.$/);
  // A member can't cancel someone else's booking.
  await rejects(plan(db, "booking.cancel", { booking_id: late.booking_id }, as("Dee"), { now: NOW }), "error.forbidden_reason");
});

test("who hears what: confirmations, a part paid, what was charged or is owed, a lost court, cancelling", async () => {
  await processOutbox(db, messageHandlers);
  const kinds = async (who: string) => (await db.selectFrom("outbound_message").select("kind").where("person_id", "=", people[who] ?? who).where("channel", "=", "email").orderBy("created_at").execute()).map((m) => m.kind);
  assert.ok((await kinds("Ann")).includes("booking_confirmed"));
  assert.ok((await kinds("Ben")).includes("booking_share_paid"));
  assert.deepEqual((await kinds("Dee")).filter((k) => k.startsWith("booking_")), ["booking_lost", "booking_confirmed_split", "booking_shares_charged"]);
  assert.ok((await kinds("Eve")).includes("booking_balance_due"));
  assert.ok((await kinds(owner.personId!)).includes("booking_balance_due_staff"));
  // Why the card failed, in words: never Stripe's code.
  const due = async (who: string, kind: string) => (await db.selectFrom("outbound_message").select("body").where("person_id", "=", who).where("kind", "=", kind).where("channel", "=", "email").executeTakeFirstOrThrow()).body;
  assert.match(await due(people.Eve!, "booking_balance_due"), /^We couldn't charge \$30\.00 for the unpaid places of Court 2, Mon, Dec 7, 6:00 PM to your card \(the card was declined\)\. Please pay it at the desk \(booking /);
  assert.match(await due(owner.personId!, "booking_balance_due_staff"), /^Eve owes \$30\.00 for the unpaid places of Court 2, Mon, Dec 7, 6:00 PM: the charge didn't go through \(the card was declined\)\. Record the payment/);
  const cancelled = await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Cal!).where("kind", "=", "booking_cancelled").where("channel", "=", "email").execute();
  assert.ok(cancelled.some((m) => /\$60\.00 goes back to your card\.$/.test(m.body)), cancelled.map((m) => m.body).join(" | "));
  const charged = await db.selectFrom("outbound_message").select("subject").where("person_id", "=", people.Dee!).where("kind", "=", "booking_shares_charged").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.equal(charged.subject, "$30.00 for the unpaid places");
});

test("a reminder a few hours before, once; and paying at the desk", async () => {
  const twoHoursBefore = new Date(new Date(at("2026-12-02", "10:00")).getTime() - 2 * 3600_000);
  const r = await remindBookings(db, twoHoursBefore);
  assert.ok(r.reminded >= 1);
  assert.deepEqual(await remindBookings(db, twoHoursBefore), { reminded: 0 });
  const desk = (await run(db, "booking.create", { court_id: c2, starts_at: at("2026-12-09", "10:00"), minutes: 60, guest_name: "Walk-in" }, owner, { now: NOW })).result as { booking_id: string };
  const paid = await run(db, "booking.record_payment", { booking_id: desk.booking_id, cents: 4000, method: "cash" }, owner, { now: NOW });
  assert.equal(paid.plan.summary.en, "Record $40.00 paid in cash for booking " + (await booking(desk.booking_id)).code + ".");
  const pay = await db.selectFrom("payment").selectAll().where("id", "=", (paid.result as any).payment_id).executeTakeFirstOrThrow();
  assert.deepEqual([pay.status, pay.method, pay.provider, pay.amount_cents], ["succeeded", "cash", "none", 4000]);
});
