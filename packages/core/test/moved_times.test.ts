// A booking moved keeps its old court time, retired; "how long before it" and "is it over" are measured from the time
// it has now (bookingTimeNow, itsTimeNow), never the earliest it ever had. Found in review round 4: a booking moved
// later was refunded by the time it left (0.1.0 to 0.4.0), and a court moved to next week counted as over, and owing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { plan, refundedStillBooked, run, runAsSystem, setPaymentProvider, uuidv7, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

const TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, court: string, court2: string, loc: string;
const people: Record<string, string> = {};
const as = (id: string): Actor => ({ personId: id, via: "test", lang: "en" });
const H = 3600_000, D = 24 * H;
const NOW = new Date("2026-11-16T16:00:00Z");            // Mon 08:00 in Los Angeles
const at = (ms: number) => new Date(NOW.getTime() + ms);
const refunded = async (bookingId: string) => (await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
  .select("refund.amount_cents").where("booking_player.booking_id", "=", bookingId).execute()).reduce((n, r) => n + r.amount_cents, 0);

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(new TestProvider());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as any).owner_person_id);
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  court2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  for (const n of ["Ann", "Ben", "Cy", "Dana"]) people[n] = ((await run(db, "person.create", { display_name: n, email: `${n.toLowerCase()}@example.test` }, owner, { now: NOW })).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Dana!, role: "front_desk" }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true }, { ...owner, auth: "passkey" } as Actor, { now: NOW });
  desk = as(people.Dana!);
});
after(async () => drop());

test("a booking the club moved later is cancelled early or late by its new time: five days ahead, all of it back", async () => {
  // Ann's court tomorrow at 10:00, paid at the desk ($60). The club's rule: free to cancel up to 24 hours before, nothing
  // back after (the defaults). The desk moves it to the same time next week; two days later she cancels.
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: at(26 * H).toISOString(), minutes: 90, person_id: people.Ann }, desk, { now: NOW })).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 6000, method: "cash" }, desk, { now: NOW });
  await run(db, "booking.move", { booking_id: b, court_id: court, starts_at: at(26 * H + 7 * D).toISOString() }, desk, { now: NOW });
  const later = { now: at(2 * D) };
  const p = await plan(db, "booking.cancel", { booking_id: b }, as(people.Ann!), later);
  assert.doesNotMatch(p.plan.summary.en, /less than 24 hours/);
  await run(db, "booking.cancel", { booking_id: b }, as(people.Ann!), later);
  assert.equal(await refunded(b), 6000, p.plan.summary.en);
});

test("a booking moved earlier is late by its new time, not early by the old one", async () => {
  // Cy's court in a week; the desk moves it to tomorrow at 10:00; he cancels in the morning, 2 hours before: nothing back.
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: at(7 * D + 4 * H).toISOString(), minutes: 60, person_id: people.Cy }, desk, { now: NOW })).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "cash" }, desk, { now: NOW });
  await run(db, "booking.move", { booking_id: b, court_id: court2, starts_at: at(26 * H).toISOString() }, desk, { now: NOW });
  await run(db, "booking.cancel", { booking_id: b }, as(people.Cy!), { now: at(24 * H) });
  assert.equal(await refunded(b), 0);
});

test("a court moved to next week isn't over when the time it left goes by: nothing is owed on it yet", async () => {
  // Ben's court today at 10:00; the desk adds 30 minutes ($20 owed at the desk), then moves it to next Monday.
  const b = ((await run(db, "booking.create", { court_id: court2, starts_at: at(2 * H).toISOString(), minutes: 90, person_id: people.Ben }, desk, { now: NOW })).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 6000, method: "cash" }, desk, { now: NOW });
  await run(db, "booking.extend", { booking_id: b, minutes: 120 }, desk, { now: NOW });
  await run(db, "booking.move", { booking_id: b, court_id: court2, starts_at: at(2 * H + 7 * D).toISOString() }, desk, { now: NOW });
  // That afternoon, after the old 10:00 to 12:00 has gone by, Ben books another court in the app.
  const ask = (now: Date) => plan(db, "booking.request", { court_id: court, starts_at: at(3 * D).toISOString(), minutes: 60, pay: "whole", person_id: people.Ben }, as(people.Ben!), { now });
  assert.ok(await ask(at(6 * H)));
  // Once the court he has now is over, the $20 is owed, and he books nothing more until it's paid.
  await assert.rejects(ask(at(7 * D + 6 * H)), (e: unknown) => e instanceof KumiError && e.code === "error.balance_owed");
});

test("refunded after a restore and still booked: by the time it has now, not one it was moved from", async () => {
  // Booked for next week, moved to later today, its money refunded after a restore: once today's time is over, it isn't
  // listed as still to come.
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: at(7 * D + 6 * H).toISOString(), minutes: 60, person_id: people.Cy }, desk, { now: NOW })).result as any).booking_id;
  await run(db, "booking.record_payment", { booking_id: b, cents: 4000, method: "cash" }, desk, { now: NOW });
  await run(db, "booking.move", { booking_id: b, court_id: court, starts_at: at(4 * H).toISOString() }, desk, { now: NOW });
  const pay = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id").where("booking_player.booking_id", "=", b).executeTakeFirstOrThrow();
  await db.insertInto("refund").values({ id: uuidv7(), payment_id: pay.id, enrolment_id: null, amount_cents: 4000, destination: "desk", status: "sent", provider_ref: null, failure: null, seen_after_restore: true } as any).execute();
  assert.ok((await refundedStillBooked(db, at(2 * H))).bookings.some((x) => x.booking_id === b), "before it: still to come");
  assert.equal((await refundedStillBooked(db, at(6 * H))).bookings.some((x) => x.booking_id === b), false, "after it: over");
});
