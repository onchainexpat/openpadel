// Weekly courts, the review of 8ea1795: a week charged once even after a restore books it again, a court archived
// later doesn't stop the job, an assistant's weekly limit counts the whole series, a declined week pauses it, the
// club's limit on upcoming bookings holds, a first week lost ends it, and a club that stops weekly bookings says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { apply, bookSeriesWeeks, checkPayment, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, seriesOf, setPaymentProvider, settleShares, weekSpent,
  KumiError, TestProvider, type Actor } from "../src/index.ts";

const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const hours = (n: number, from = NOW) => new Date(from.getTime() + n * 3600_000);

async function club() {
  const { db, drop } = await freshDb(), stripe = new TestProvider();
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup", { now: NOW });
  const owner: Actor = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" }, now = { now: NOW };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner, now)).result as any).location_id;
  const c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, now)).result as any).court_id;
  const c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner, now)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, now);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, now);
  await run(db, "club.update", { court_bookings: true, weekly_bookings: true }, owner, now);
  const people: Record<string, string> = {};
  for (const name of ["Lee", "Ann", "Ben", "Eve"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, now)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, now);
  const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
  const pay = async (paymentId: string, who: string, when?: Date) => {
    await openPayment(db, paymentId, people[who]!);
    stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
    return checkPayment(db, paymentId, "test", when);
  };
  const weekly = async (who: string, court: string, day: string, weeks: number, actor = as(who)) => {
    const r = (await run(db, "booking.repeat_request", { court_id: court, starts_at: at(day, "10:00"), minutes: 90, person_id: people[who], weeks }, actor, now)).result as any;
    return r as { series_id: string; booking_id: string; payment_id: string };
  };
  const weeksOf = async (id: string) => (await db.selectFrom("booking_series_week").leftJoin("booking", "booking.id", "booking_series_week.booking_id")
    .select(["booking_series_week.id as week_id", "booking_series_week.on_date", "booking_series_week.missed", "booking.status", "booking.id"]).where("booking_series_week.series_id", "=", id).orderBy("on_date").execute());
  const states = async (id: string) => (await weeksOf(id)).map((w) => w.status ?? (w.missed ? `missed ${w.missed}` : "waiting"));
  const emails = (who: string, kind: string) => db.selectFrom("outbound_message").select("body").where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "email").execute();
  return { db, drop, stripe, owner, desk: as("Lee"), as, c1, c2, people, pay, weekly, weeksOf, states, emails };
}

test("a week is charged once, even when a restored copy books it again under a new booking", async () => {
  const k = await club();
  try {
    const r = await k.weekly("Ann", k.c1, "2026-12-02", 4);
    await k.pay(r.payment_id, "Ann");
    await bookSeriesWeeks(k.db, NOW);
    const before = k.stripe.charges.length;
    await settleShares(k.db, new Date(at("2026-12-08", "10:01")));
    assert.equal(k.stripe.charges.length, before + 1);
    // What a copy from before the second week was booked looks like: the week not booked, nothing recorded for it.
    const week2 = (await k.weeksOf(r.series_id))[1]!;
    await sql`UPDATE booking_series_week SET booking_id = NULL WHERE id = ${week2.week_id}`.execute(k.db);
    await sql`DELETE FROM payment WHERE booking_player_id IN (SELECT id FROM booking_player WHERE booking_id = ${week2.id})`.execute(k.db);
    await sql`UPDATE court_time SET active = false WHERE booking_id = ${week2.id}`.execute(k.db);
    await sql`UPDATE booking SET status = 'cancelled' WHERE id = ${week2.id}`.execute(k.db);
    // It books the week again (a new booking) and charges at the deadline: the provider gives the first charge back.
    assert.equal((await bookSeriesWeeks(k.db, new Date(at("2026-12-08", "10:02")))).booked, 2, "the second week again, and the third now inside the window");
    await settleShares(k.db, new Date(at("2026-12-08", "10:03")));
    assert.equal(k.stripe.charges.length, before + 1, "never a second charge for the same week");
    const rebooked = (await k.weeksOf(r.series_id))[1]!.id!;
    assert.notEqual(rebooked, week2.id);
    assert.equal((await k.db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.status")
      .where("booking_player.booking_id", "=", rebooked).executeTakeFirstOrThrow()).status, "succeeded");
  } finally { await k.drop(); }
});

test("a court archived later: its series' weeks are left out, and every other series goes on", async () => {
  const k = await club();
  try {
    const a = await k.weekly("Ann", k.c2, "2026-12-02", 6), b = await k.weekly("Ben", k.c1, "2026-12-02", 6);
    await k.pay(a.payment_id, "Ann"); await k.pay(b.payment_id, "Ben");
    await bookSeriesWeeks(k.db, NOW);
    for (const w of await k.weeksOf(a.series_id)) if (w.status === "confirmed") await run(k.db, "booking.cancel", { booking_id: w.id!, refund: "full" }, k.desk, { now: NOW });
    await run(k.db, "court.archive", { court_id: k.c2 }, k.owner, { now: NOW });
    const r = await bookSeriesWeeks(k.db, hours(24 * 10));
    assert.equal(r.booked, 2, "Ben's next two weeks, now inside his window");
    assert.ok((await k.states(a.series_id)).includes("missed not_bookable"));
    assert.deepEqual((await k.states(b.series_id)).slice(0, 3), ["confirmed", "confirmed", "confirmed"]);
  } finally { await k.drop(); }
});

test("an assistant's weekly limit counts the whole series, as a shared court counts in full", async () => {
  const k = await club();
  try {
    const grant = "00000000-0000-7000-9000-0000000000a1";
    await k.db.insertInto("oauth_client").values({ client_id: "kc_test", kind: "registered", name: "Test Agent", redirect_uris: ["http://localhost:9999/cb"], secret_hash: null, metadata: null }).execute();
    await k.db.insertInto("oauth_grant").values({ id: grant, person_id: k.people.Ann!, client_id: "kc_test", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 20000 }).execute();
    const bot: Actor = { personId: k.people.Ann!, via: "mcp:Test Agent", lang: "en", auth: "oauth", grantId: grant };
    const input = { court_id: k.c1, starts_at: at("2026-12-02", "10:00"), minutes: 90, person_id: k.people.Ann };
    // 4 weeks at $60 is $240: over a $200 limit, though the first week alone is $60.
    await assert.rejects(plan(k.db, "booking.repeat_request", { ...input, weeks: 4 }, bot, { now: NOW }), (e: unknown) => e instanceof KumiError && e.code === "error.assistant_over_cap");
    const p = await plan(k.db, "booking.repeat_request", { ...input, weeks: 3 }, bot, { now: NOW });
    const r = await apply(k.db, p.runId, bot, { now: NOW }) as any;
    assert.equal(await weekSpent(k.db, grant, NOW), 18000, "all three weeks count");
    await k.pay(r.payment_id, "Ann");
    assert.equal(await weekSpent(k.db, grant, NOW), 18000);
  } finally { await k.drop(); }
});

test("a declined week is owed, not paid, and pauses the series until it's paid; the club's limit on upcoming bookings holds", async () => {
  const k = await club();
  try {
    const r = await k.weekly("Ann", k.c1, "2026-12-02", 6);
    await k.pay(r.payment_id, "Ann");
    await bookSeriesWeeks(k.db, NOW);
    k.stripe.failNextCharge = "expired_card";
    await settleShares(k.db, new Date(at("2026-12-08", "10:01")));
    const wk = (await seriesOf(k.db, k.people.Ann!, new Date(at("2026-12-08", "10:02"))))[0]!.weeks.find((w) => w.date === "2026-12-09")!;
    assert.equal(wk.state, "owed"); assert.equal(wk.charged, false);
    // Owing, the weeks coming into the window wait, and nothing is charged for them (left out only past their
    // deadline: booking_series_round3.test.ts).
    await bookSeriesWeeks(k.db, new Date(at("2026-12-09", "12:00")));
    assert.deepEqual((await k.states(r.series_id)).slice(2, 4), ["waiting", "waiting"]);
    // Paid at the desk: the weeks waiting are booked.
    await run(k.db, "booking.record_payment", { booking_id: wk.booking_id!, cents: 6000, method: "cash" }, k.desk, { now: new Date(at("2026-12-09", "13:00")) });
    assert.equal((await bookSeriesWeeks(k.db, new Date(at("2026-12-09", "14:00")))).booked, 2);
    assert.deepEqual((await k.states(r.series_id)).slice(2, 4), ["confirmed", "confirmed"]);
    // The limit (3 upcoming, not begun): Ben has two bookings already, so of his weekly weeks one fits now, and the
    // next waits until there's room (his 1 Dec court played), not left out.
    for (const d of ["2026-12-01", "2026-12-03"]) await k.pay(((await run(k.db, "booking.request", { court_id: k.c2, starts_at: at(d, "12:00"), minutes: 90, pay: "whole", person_id: k.people.Ben }, k.as("Ben"), { now: NOW })).result as any).payment_id, "Ben");
    const b = await k.weekly("Ben", k.c2, "2026-12-04", 4);
    await k.pay(b.payment_id, "Ben");
    await bookSeriesWeeks(k.db, NOW);
    assert.deepEqual((await k.states(b.series_id)).slice(0, 2), ["confirmed", "waiting"]);
    await bookSeriesWeeks(k.db, new Date(at("2026-12-01", "14:00")));
    assert.deepEqual((await k.states(b.series_id)).slice(0, 2), ["confirmed", "confirmed"]);
  } finally { await k.drop(); }
});

test("the first week lost while its card went through ends the weekly court; a club that stops weekly bookings pauses it and says so once", async () => {
  const k = await club();
  try {
    const r = await k.weekly("Ann", k.c1, "2026-12-02", 4);
    await openPayment(k.db, r.payment_id, k.people.Ann!);
    const ref = (await k.db.selectFrom("payment").select("provider_ref").where("id", "=", r.payment_id).executeTakeFirstOrThrow()).provider_ref!;
    const t = hours(0.2);
    await k.pay(((await run(k.db, "booking.request", { court_id: k.c1, starts_at: at("2026-12-02", "10:00"), minutes: 90, pay: "whole", person_id: k.people.Eve }, k.as("Eve"), { now: t })).result as any).payment_id, "Eve", t);
    k.stripe.settle(ref, "succeeded");
    await checkPayment(k.db, r.payment_id, "test", t);
    const before = k.stripe.charges.length;
    assert.equal((await bookSeriesWeeks(k.db, t)).ended, 1);
    await settleShares(k.db, new Date(at("2026-12-08", "10:01")));
    assert.equal(k.stripe.charges.length, before, "nothing more charged");
    await processOutbox(k.db, messageHandlers);
    assert.match((await k.emails("Ann", "booking_lost_weekly"))[0]!.body, /your weekly court is off too/);
    // Ben's runs; then the club switches weekly bookings off: paused, not ended; no more weeks, the booked ones
    // stay, Ben told once.
    const b = await k.weekly("Ben", k.c2, "2026-12-02", 5);
    await k.pay(b.payment_id, "Ben");
    await bookSeriesWeeks(k.db, NOW);
    await run(k.db, "club.update", { weekly_bookings: false }, k.owner, { now: NOW });
    assert.equal((await bookSeriesWeeks(k.db, hours(24 * 10))).ended, 0);
    assert.equal((await bookSeriesWeeks(k.db, hours(24 * 11))).ended, 0);
    assert.deepEqual((await k.states(b.series_id)).slice(0, 3), ["confirmed", "confirmed", "waiting"]);
    await processOutbox(k.db, messageHandlers);
    assert.equal((await k.emails("Ben", "booking_repeat_paused")).length, 1);
  } finally { await k.drop(); }
});
