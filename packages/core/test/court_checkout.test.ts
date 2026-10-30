import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, combine, messageHandlers, moneyHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, c1: string, c2: string, c3: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
const slot = (court: string, starts: string, minutes = 90) => ({ court_id: court, starts_at: starts, minutes });
const courts = (who: string, list: ReturnType<typeof slot>[], now = NOW) => run(db, "booking.request_courts", { courts: list, person_id: people[who] }, as(who), { now });
const booking = (id: string) => db.selectFrom("booking").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const ref = async (paymentId: string) => (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
const deliver = () => processOutbox(db, combine(moneyHandlers, messageHandlers));

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const opts = { now: NOW };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, opts)).result as any).location_id;
  [c1, c2, c3] = await Promise.all(["Court 1", "Court 2", "Court 3"].map(async (name) => ((await run(db, "court.create", { location_id: loc, name }, owner, opts)).result as any).court_id));
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  const monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month" }, owner, opts)).result as any).plan_id;
  await run(db, "price.rule_set", { location_id: loc, name: "Members", cents_per_hour: 3000, plan_ids: [monthly] }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const name of ["Ann", "Ben", "Cal", "Dee", "Eve"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  await run(db, "membership.grant", { person_id: people.Ann, plan_id: monthly }, owner, opts);
});
after(async () => drop());

test("two courts in one checkout: each its own booking, one card payment for both, one message", async () => {
  const r = await courts("Ann", [slot(c1, at("2026-12-02", "18:00")), slot(c2, at("2026-12-02", "19:30"), 60)]);
  assert.equal(r.plan.summary.en, "Book 2 courts: Court 1, Wed, Dec 2, 6:00 PM, 90 minutes ($45.00); Court 2, Wed, Dec 2, 7:30 PM, 60 minutes ($30.00). $75.00 in all, paid now in one card payment. Each court is its own booking and can be cancelled on its own under the club's rule.");
  const out = r.result as { bookings: { booking_id: string; code: string; payment_id: string }[]; payment_id: string; total_cents: number };
  assert.equal(out.total_cents, 7500);   // member prices on each court
  assert.notEqual(out.bookings[0]!.code, out.bookings[1]!.code);
  assert.deepEqual(await Promise.all(out.bookings.map(async (b) => (await booking(b.booking_id)).status)), ["held", "held"]);
  await openPayment(db, out.payment_id, people.Ann!);
  const pi = await ref(out.payment_id);
  assert.equal(await ref(out.bookings[1]!.payment_id), pi);   // one card payment
  assert.equal(stripe.intents.get(pi)!.amountCents, 7500);
  stripe.settle(pi, "succeeded");
  assert.equal(await checkPayment(db, out.payment_id, "test"), "succeeded");
  assert.deepEqual(await Promise.all(out.bookings.map(async (b) => (await booking(b.booking_id)).status)), ["confirmed", "confirmed"]);
  const paid = await db.selectFrom("payment").select(["status", "amount_cents"]).where("group_id", "is not", null).orderBy("id").execute();
  assert.deepEqual(paid, [{ status: "succeeded", amount_cents: 4500 }, { status: "succeeded", amount_cents: 3000 }]);
  await deliver();
  const msgs = await db.selectFrom("outbound_message").select(["kind", "subject", "body"]).where("person_id", "=", people.Ann!).where("channel", "=", "email").where("kind", "like", "booking%").execute();
  assert.deepEqual(msgs.map((m) => m.kind), ["booking_courts"]);
  assert.equal(msgs[0]!.subject, "Booked: 2 courts");
  assert.equal(msgs[0]!.body, `Your courts are booked: Court 1 at Eastside, Wed, Dec 2, 6:00 PM, for 90 minutes (booking ${out.bookings[0]!.code}); Court 2 at Eastside, Wed, Dec 2, 7:30 PM, for 60 minutes (booking ${out.bookings[1]!.code}). $75.00 paid in one card payment. Each court is its own booking, so you can cancel one without the others.`);

  // Cancelling one court refunds its part of the one card payment; the other stays booked.
  const cancel = await run(db, "booking.cancel", { booking_id: out.bookings[0]!.booking_id }, as("Ann"), { now: NOW });
  assert.match(cancel.plan.summary.en, /\$45\.00/);
  await deliver();
  const back = [...stripe.refunds.values()].find((x) => x.paymentRef === pi)!;
  assert.equal(back.amountCents, 4500);
  assert.equal((await booking(out.bookings[1]!.booking_id)).status, "confirmed");
});

test("the rules: the same day, the same court not twice at once, the club's limit, and all or nothing", async () => {
  await rejects(plan(db, "booking.request_courts", { courts: [slot(c1, at("2026-12-03", "10:00")), slot(c2, at("2026-12-04", "10:00"))], person_id: people.Ben }, as("Ben"), { now: NOW }), "error.courts_same_day");
  await rejects(plan(db, "booking.request_courts", { courts: [slot(c1, at("2026-12-03", "10:00")), slot(c1, at("2026-12-03", "11:00"))], person_id: people.Ben }, as("Ben"), { now: NOW }), "error.court_taken");
  await courts("Ben", [slot(c1, at("2026-12-03", "10:00")), slot(c2, at("2026-12-03", "10:00"))]);
  await rejects(plan(db, "booking.request_courts", { courts: [slot(c1, at("2026-12-05", "10:00")), slot(c2, at("2026-12-05", "10:00"))], person_id: people.Ben }, as("Ben"), { now: NOW }),
    "error.too_many_courts", "That's more than the club's limit of 3 upcoming bookings (you have 2).");
  // Court 1 is Ben's then: Cal asks for it and Court 3, and gets neither.
  const before = Number((await db.selectFrom("booking").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
  await rejects(courts("Cal", [slot(c3, at("2026-12-03", "10:00")), slot(c1, at("2026-12-03", "10:30"))]), "error.court_taken");
  assert.equal(Number((await db.selectFrom("booking").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n), before);
});

test("a court someone else took while the payment was going through is refunded; the others are kept", async () => {
  const out = (await courts("Dee", [slot(c1, at("2026-12-06", "10:00")), slot(c2, at("2026-12-06", "10:00"))])).result as { bookings: { booking_id: string; payment_id: string }[]; payment_id: string };
  await openPayment(db, out.payment_id, people.Dee!);
  // Dee's holds ran out; Eve books Court 1 then and pays.
  const eve = (await run(db, "booking.request", { court_id: c1, starts_at: at("2026-12-06", "10:00"), minutes: 90, pay: "whole", person_id: people.Eve }, as("Eve"), { now: later(12) })).result as { payment_id: string };
  await openPayment(db, eve.payment_id, people.Eve!); stripe.settle(await ref(eve.payment_id), "succeeded"); await checkPayment(db, eve.payment_id, "test");
  stripe.settle(await ref(out.payment_id), "succeeded");
  await checkPayment(db, out.bookings[1]!.payment_id, "test");   // any of the group settles them all
  assert.deepEqual([(await booking(out.bookings[0]!.booking_id)).cancel_reason, (await booking(out.bookings[1]!.booking_id)).status], ["hold_lost", "confirmed"]);
  const refunds = await db.selectFrom("refund").select(["payment_id", "amount_cents"]).where("payment_id", "in", out.bookings.map((b) => b.payment_id)).execute();
  assert.deepEqual(refunds, [{ payment_id: out.bookings[0]!.payment_id, amount_cents: 6000 }]);
  await deliver();
  const kinds = (await db.selectFrom("outbound_message").select("kind").where("person_id", "=", people.Dee!).where("channel", "=", "email").orderBy("id").execute()).map((m) => m.kind);
  assert.deepEqual(kinds, ["booking_lost", "booking_confirmed"]);   // one court left: the usual confirmation
});

test("a declined card leaves every court of the checkout unpaid", async () => {
  const out = (await courts("Eve", [slot(c3, at("2026-12-07", "10:00")), slot(c2, at("2026-12-07", "12:00"))])).result as { bookings: { payment_id: string }[]; payment_id: string };
  await openPayment(db, out.payment_id, people.Eve!);
  stripe.settle(await ref(out.payment_id), "failed");
  assert.equal(await checkPayment(db, out.payment_id, "test"), "failed");
  assert.deepEqual((await db.selectFrom("payment").select("status").where("id", "in", out.bookings.map((b) => b.payment_id)).execute()).map((p) => p.status), ["failed", "failed"]);
});
