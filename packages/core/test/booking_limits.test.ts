// What stops a court or a member price for less than it costs: a court shared at most 4 ways, nothing more
// booked while a court is still owed, and a founding place given up before the start not taken again in the app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkCardSetup, checkPayment, openCardSetup, openPayment, plan, run, runAsSystem, setPaymentProvider, settleShares, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, c1: string, c2: string, founding: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test");
}
before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  founding = ((await run(db, "membership.plan_set", { name: "Founding", price_cents: 8900, period: "month", starts_on: "2027-03-01", days_ahead: 30 }, owner, { now: NOW })).result as any).plan_id;
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true }, owner, { now: NOW });
  for (const name of ["Ann", "Bob"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, { now: NOW })).result as any).person_id;
});
after(async () => drop());

test("a court is shared at most 4 ways", async () => {
  await rejects(plan(db, "booking.request", { court_id: c1, starts_at: at("2026-12-07", "18:00"), minutes: 90, pay: "split", players: 8, person_id: people.Ann }, as("Ann"), { now: NOW }), "error.invalid_input");
});

test("while a court is still owed, nothing more is booked or joined in the app; staff can, and paying at the desk clears it", async () => {
  const r = (await run(db, "booking.request", { court_id: c1, starts_at: at("2026-12-07", "18:00"), minutes: 90, pay: "split", players: 4, person_id: people.Ann }, as("Ann"), { now: NOW })).result as any;
  await pay(r.payment_id, "Ann");
  stripe.failNextCharge = "card_declined";
  const deadline = new Date(new Date(at("2026-12-07", "18:00")).getTime() - 23 * 3600_000);
  await settleShares(db, deadline);
  assert.equal((await db.selectFrom("booking").select("balance_cents").where("id", "=", r.booking_id).executeTakeFirstOrThrow()).balance_cents, 4500);
  const again = { court_id: c2, starts_at: at("2026-12-08", "18:00"), minutes: 90, pay: "split" as const, players: 4, person_id: people.Ann };
  await assert.rejects(plan(db, "booking.request", again, as("Ann"), { now: deadline }), (e: unknown) => {
    assert.ok(e instanceof KumiError); assert.equal(e.code, "error.balance_owed");
    assert.equal(e.text.en, "You still owe $45.00 on a court booking. Pay it at the club's front desk, then you can book and join again."); return true;
  });
  assert.equal((await plan(db, "booking.request", again, owner, { now: deadline })).status, "planned");   // the desk can still book for her
  await run(db, "booking.record_payment", { booking_id: r.booking_id, cents: 4500, method: "cash" }, owner, { now: deadline });
  assert.equal((await plan(db, "booking.request", again, as("Ann"), { now: deadline })).status, "planned");
});

test("a founding place given up before the start isn't taken again in the app; staff can add them", async () => {
  const join = async (who: Actor) => {
    const m = (await run(db, "membership.join", { plan_id: founding, person_id: people.Bob }, who, { now: NOW })).result as { membership_id: string };
    await openCardSetup(db, m.membership_id, people.Bob!);
    stripe.settleSetup((await db.selectFrom("membership").select("provider_ref").where("id", "=", m.membership_id).executeTakeFirstOrThrow()).provider_ref!);
    await checkCardSetup(db, m.membership_id, "test", NOW);
    return m.membership_id;
  };
  const m1 = await join(as("Bob"));
  await run(db, "membership.cancel", { membership_id: m1 }, as("Bob"), { now: NOW });
  await rejects(plan(db, "membership.join", { plan_id: founding, person_id: people.Bob }, as("Bob"), { now: NOW }), "error.presale_given_up");
  assert.ok(await join(owner));
});
