// Cancelling with nothing back says why (booking_pay.ts): the staff chose nothing, or everything paid has gone back
// already. Found on a browser check of the staff app (Nov 2026): both read "Nothing comes back: it's less than 24 hours
// before." on a court three days away, the club's late rule, which wasn't why.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, openPayment, plan, run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string, dee: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as { location_id: string }).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as { court_id: string }).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true }, owner, { now: NOW });
  dee = ((await run(db, "person.create", { display_name: "Dee", email: "dee@example.test" }, owner, { now: NOW })).result as { person_id: string }).person_id;
});
after(async () => { await drop(); });

test("nothing back says why: the staff chose nothing, or it has all gone back already, not that it's late", async () => {
  // A week ahead, so the rule would give everything back: "less than 24 hours" would be untrue.
  const as = { personId: dee, via: "test", lang: "en" } as Actor;
  const b = (await run(db, "booking.request", { court_id: court, starts_at: new Date("2026-12-09T10:00:00-08:00").toISOString(), minutes: 90, pay: "whole", person_id: dee }, as, { now: NOW })).result as { booking_id: string; payment_id: string };
  await openPayment(db, b.payment_id, dee);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", b.payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, b.payment_id, "test");
  const none = await plan(db, "booking.cancel", { booking_id: b.booking_id, refund: "none" }, owner, { now: NOW });
  assert.match(none.plan.summary.en, /Nothing comes back, as you chose\.$/);
  assert.match(none.plan.summary.es, /No se devuelve nada, como elegiste\.$/);
  assert.doesNotMatch(none.plan.summary.en, /less than/);
  // Refunded in full while it stays, then cancelled with "everything back": there's nothing left to give.
  await run(db, "booking.refund", { booking_id: b.booking_id, payment_id: b.payment_id, cents: 6000 }, owner, { now: NOW });
  for (const refund of ["full", "credit", "rule"] as const) {
    const p = await plan(db, "booking.cancel", { booking_id: b.booking_id, refund }, owner, { now: NOW });
    assert.match(p.plan.summary.en, /Nothing comes back: everything paid on it has gone back already\.$/, refund);
    assert.equal(p.plan.moneyCents, 0);
  }
});
