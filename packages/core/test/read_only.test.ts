// Read-only (read_only.ts): the host's switch for an account that isn't paid. The data is never held hostage
// and no new money moves except back to members: people sign in, look after their accounts, cancel and are
// paid back; nothing new is booked, joined or charged, by people, assistants or the jobs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, checkPayment, getAction, messageHandlers, openPayment, plan, processOutbox, READ_ONLY_ALLOWED, renewMemberships, run, runAsSystem, setPaymentProvider, settleShares,
  KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string, monthly: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const readOnly = (on: boolean, now = NOW) => runAsSystem(db, "club.read_only", { on }, "test", { now });
async function refused(p: Promise<unknown>) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, "error.read_only"); return true; });
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  return checkPayment(db, paymentId, "test");
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true }, owner, { now: NOW });
  monthly = ((await run(db, "membership.plan_set", { name: "Monthly", price_cents: 8000, period: "month" }, owner, { now: NOW })).result as any).plan_id;
  for (const name of ["Ann", "Ben", "Cal", "Dee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, { now: NOW })).result as { person_id: string }).person_id;
});
after(async () => drop());

test("every action read-only lets through is a real one", () => {
  for (const name of READ_ONLY_ALLOWED) assert.ok(getAction(name), name);
});

test("read-only: nothing new is booked, joined or paid for; people still cancel, leave and look after their accounts", async () => {
  // Before: Ann books a court she pays for, Ben has a membership, Cal has joined one and not paid yet.
  const ann = (await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-03", "10:00"), minutes: 90, pay: "whole", person_id: people.Ann }, as("Ann"), { now: NOW })).result as { booking_id: string; payment_id: string };
  await pay(ann.payment_id, "Ann");
  const ben = (await run(db, "membership.join", { plan_id: monthly, person_id: people.Ben }, as("Ben"), { now: NOW })).result as { payment_id: string };
  await pay(ben.payment_id, "Ben");
  const cal = (await run(db, "membership.join", { plan_id: monthly, person_id: people.Cal }, as("Cal"), { now: NOW })).result as { payment_id: string };
  const early = await plan(db, "booking.request", { court_id: court, starts_at: at("2026-12-04", "10:00"), minutes: 90, pay: "whole", person_id: people.Dee }, as("Dee"), { now: NOW });

  const r = await readOnly(true);
  assert.equal(r.plan.summary.en, "The club's app becomes read-only: everyone can still sign in, see everything, cancel and download their data, and nothing new is booked, sold or charged.");
  await refused(plan(db, "booking.request", { court_id: court, starts_at: at("2026-12-05", "10:00"), minutes: 90, pay: "whole", person_id: people.Dee }, as("Dee"), { now: NOW }));
  await refused(apply(db, early.runId, as("Dee"), { now: NOW }));   // a preview from before can't go through now
  await refused(plan(db, "membership.join", { plan_id: monthly, person_id: people.Dee }, as("Dee"), { now: NOW }));
  await refused(openPayment(db, cal.payment_id, people.Cal!));       // no card form opens
  await refused(plan(db, "club.update", { name: "Kestrel" }, owner, { now: NOW }));   // nor is the club changed
  assert.equal(stripe.charges.length, 0);

  // What still works: their own details, and cancelling, with the money going back.
  await run(db, "person.update_profile", { person_id: people.Dee, display_name: "Dee Dee" }, as("Dee"), { now: NOW });
  await run(db, "booking.cancel", { booking_id: ann.booking_id }, as("Ann"), { now: NOW });
  const back = await db.selectFrom("refund").select(["amount_cents", "status"]).where("payment_id", "=", ann.payment_id).executeTakeFirstOrThrow();
  assert.equal(back.amount_cents, 6000);

  // Renewals wait: no card is charged, and Ben's membership doesn't lapse for it.
  const due = new Date("2027-01-01T00:00:00Z");
  assert.deepEqual(await renewMemberships(db, due), { renewed: 0, failed: 0, ended: 0 });
  assert.equal(stripe.charges.length, 0);
  assert.equal((await db.selectFrom("membership").select("status").where("person_id", "=", people.Ben!).executeTakeFirstOrThrow()).status, "active");
  await plan(db, "membership.cancel", { membership_id: (await db.selectFrom("membership").select("id").where("person_id", "=", people.Ben!).executeTakeFirstOrThrow()).id }, as("Ben"), { now: NOW });

  // Off again: everything works, and the renewal that waited goes through.
  await readOnly(false);
  assert.equal((await renewMemberships(db, due)).renewed, 1);
  assert.equal(stripe.charges.length, 1);
});

test("a shared court's deadline while read-only: no card is charged; what's unpaid is owed, and the organiser is told why", async () => {
  const r = (await run(db, "booking.request", { court_id: court, starts_at: at("2026-12-08", "18:00"), minutes: 90, pay: "split", players: 2, person_id: people.Dee }, as("Dee"), { now: NOW })).result as { booking_id: string; payment_id: string };
  await pay(r.payment_id, "Dee");
  const charges = stripe.charges.length;
  await readOnly(true);
  const deadline = new Date(new Date(at("2026-12-08", "18:00")).getTime() - 23 * 3600_000);
  assert.deepEqual(await settleShares(db, deadline), { settled: 1, charged: 0, failed: 1, cancelled: 0 });
  assert.equal(stripe.charges.length, charges);
  assert.equal((await db.selectFrom("booking").select("balance_cents").where("id", "=", r.booking_id).executeTakeFirstOrThrow()).balance_cents, 3000);
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Dee!).where("kind", "=", "booking_balance_due").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.match(told.body, /the club's app is read-only for now, so no card was charged/);
  await readOnly(false);
});
