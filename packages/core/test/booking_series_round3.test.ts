// Weekly courts, the review's recheck of 8d53139: a week at the club's limit or owed waits instead of being left
// out (and the limit counts only bookings still to start), switching weekly bookings off pauses member series
// instead of ending them, a member can end theirs and delete their account while the club is read-only, ending one
// gives an assistant's allowance back at once, a week charged and refunded before a restore isn't recorded as paid,
// a first week the member cancels before paying ends the series, a series that fails every run is said once, and
// after a declined week the weeks already booked are owed at the desk instead of going on the dead card again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { apply, bookSeriesWeeks, checkPayment, messageHandlers, moneyHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, settleShares, weekSpent,
  KumiError, TestProvider, type Actor } from "../src/index.ts";

const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const when = (day: string, hhmm: string) => new Date(at(day, hhmm));
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
  const pay = async (paymentId: string, who: string, t?: Date) => {
    await openPayment(db, paymentId, people[who]!);
    stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
    return checkPayment(db, paymentId, "test", t);
  };
  const weekly = async (who: string, court: string, day: string, weeks: number, actor = as(who)) =>
    (await run(db, "booking.repeat_request", { court_id: court, starts_at: at(day, "10:00"), minutes: 90, person_id: people[who], weeks }, actor, now)).result as { series_id: string; booking_id: string; payment_id: string };
  const paidWeekly = async (who: string, court: string, day: string, weeks: number) => { const r = await weekly(who, court, day, weeks); await pay(r.payment_id, who); return r; };
  const weeksOf = async (id: string) => (await db.selectFrom("booking_series_week").leftJoin("booking", "booking.id", "booking_series_week.booking_id")
    .select(["booking_series_week.id as week_id", "booking_series_week.on_date", "booking_series_week.missed", "booking.status", "booking.id", "booking.balance_cents", "booking.settled_at"])
    .where("booking_series_week.series_id", "=", id).orderBy("on_date").execute());
  const states = async (id: string) => (await weeksOf(id)).map((w) => w.status ?? (w.missed ? `missed ${w.missed}` : "waiting"));
  const emails = (who: string, kind: string) => db.selectFrom("outbound_message").select("body").where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "email").execute();
  const series = (id: string) => db.selectFrom("booking_series").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  return { db, drop, stripe, owner, desk: as("Lee"), as, loc, c1, c2, people, pay, weekly, paidWeekly, weeksOf, states, emails, series };
}

test("the limit counts only bookings still to start, and a week at the limit waits for room instead of being left out", async () => {
  const k = await club();
  try {
    // The club's limit is 3 upcoming. Ann has a court on Sat 12 Dec and a weekly court from Wed 2 Dec.
    await k.pay(((await run(k.db, "booking.request", { court_id: k.c2, starts_at: at("2026-12-12", "12:00"), minutes: 90, pay: "whole", person_id: k.people.Ann }, k.as("Ann"), { now: NOW })).result as any).payment_id, "Ann");
    const r = await k.paidWeekly("Ann", k.c1, "2026-12-02", 6);
    await bookSeriesWeeks(k.db, NOW);   // Dec 9 (2 Dec, 9 Dec and 12 Dec: 3)
    // The run while 2 Dec is being played, with 16 Dec just inside the window: 2 Dec has started, so it doesn't count.
    await bookSeriesWeeks(k.db, new Date(when("2026-12-02", "10:00").getTime() + 30_000));
    assert.deepEqual((await k.states(r.series_id)).slice(0, 3), ["confirmed", "confirmed", "confirmed"]);
    // At the limit, a week waits and is booked once there's room (12 Dec played), never left out before its deadline.
    await bookSeriesWeeks(k.db, new Date(when("2026-12-09", "10:00").getTime() + 30_000));   // 9 Dec playing; 16 Dec, 12 Dec still ahead
    assert.equal((await k.states(r.series_id))[3], "confirmed", "23 Dec: 12 Dec and 16 Dec ahead, so room for it");
  } finally { await k.drop(); }
});

test("a 21-day window and nothing else booked: a weekly court never loses a week to itself", async () => {
  const k = await club();
  try {
    await run(k.db, "policy.set", { days_ahead: 21 }, k.owner, { now: NOW });
    const r = await k.paidWeekly("Ann", k.c1, "2026-12-02", 10);
    await bookSeriesWeeks(k.db, NOW);
    // The job every 30 s: 30 s after each week starts, and after it ends.
    for (let d = 0; d < 8; d++) {
      const start = new Date(when("2026-12-02", "10:00").getTime() + d * 7 * 86400_000);
      await bookSeriesWeeks(k.db, new Date(start.getTime() + 30_000));
      await bookSeriesWeeks(k.db, new Date(start.getTime() + 2 * 3600_000));
    }
    assert.ok(!(await k.states(r.series_id)).some((s) => s.startsWith("missed")), (await k.states(r.series_id)).join(", "));
  } finally { await k.drop(); }
});

test("a week owed or at the limit is left out only once its pay deadline has passed, in one message", async () => {
  const k = await club();
  try {
    const r = await k.paidWeekly("Ann", k.c1, "2026-12-02", 6);
    await bookSeriesWeeks(k.db, NOW);
    k.stripe.failNextCharge = "expired_card";
    await settleShares(k.db, when("2026-12-08", "10:01"));   // 9 Dec declined: owed
    await bookSeriesWeeks(k.db, when("2026-12-09", "12:00"));   // 23 Dec in the window: waits while she owes
    assert.equal((await k.states(r.series_id))[3], "waiting");
    // Never paid: past 23 Dec's deadline (24 h before) it's left out, and she hears once.
    await bookSeriesWeeks(k.db, when("2026-12-22", "10:30"));
    assert.equal((await k.states(r.series_id))[3], "missed unpaid");
    await processOutbox(k.db, messageHandlers);
    assert.equal((await k.emails("Ann", "booking_repeat_missed")).length, 1);
  } finally { await k.drop(); }
});

test("switching weekly bookings off pauses members' weekly courts; back on, they go on, each member told once each way", async () => {
  const k = await club();
  try {
    const r = await k.paidWeekly("Ann", k.c1, "2026-12-02", 8);
    await bookSeriesWeeks(k.db, NOW);
    const off = await run(k.db, "club.update", { weekly_bookings: false }, k.owner, { now: NOW });
    assert.match(off.plan.summary.en, /pauses 1 member's weekly court/);
    await bookSeriesWeeks(k.db, hours(0.01));
    await bookSeriesWeeks(k.db, hours(0.02));
    assert.equal((await k.series(r.series_id)).ended_at, null, "paused, not ended");
    assert.ok((await k.series(r.series_id)).paused_at);
    await run(k.db, "action.undo", { run_id: off.runId }, k.owner, { now: hours(0.03) });
    await bookSeriesWeeks(k.db, hours(24 * 10));   // 10 Dec: 16 Dec and 23 Dec now inside the window
    assert.equal((await k.series(r.series_id)).paused_at, null);
    assert.deepEqual((await k.states(r.series_id)).slice(0, 4), ["confirmed", "confirmed", "confirmed", "confirmed"]);
    // Court bookings off pauses them too.
    await run(k.db, "club.update", { court_bookings: false }, k.owner, { now: hours(24 * 10) });
    await bookSeriesWeeks(k.db, hours(24 * 10 + 0.01));
    assert.equal((await k.series(r.series_id)).ended_at, null);
    await processOutbox(k.db, messageHandlers);
    assert.equal((await k.emails("Ann", "booking_repeat_paused")).length, 2);
    assert.equal((await k.emails("Ann", "booking_repeat_resumed")).length, 1);
    assert.equal((await k.emails("Ann", "booking_repeat_stopped")).length, 0);
  } finally { await k.drop(); }
});

test("read-only: a member ends their weekly court and can delete their account", async () => {
  const k = await club();
  try {
    const r = await k.paidWeekly("Ann", k.c1, "2026-12-02", 4);
    await bookSeriesWeeks(k.db, NOW);   // 9 Dec
    await runAsSystem(k.db, "club.read_only", { on: true }, "test", { now: hours(48) });
    const t = when("2026-12-10", "09:00");   // 2 and 9 Dec played; 16 and 23 Dec never booked (read-only)
    const erase = async (w: Date) => { try { await plan(k.db, "privacy.erase", { person_id: k.people.Ann }, k.as("Ann"), { now: w }); return "allowed"; } catch (e) { return (e as KumiError).code; } };
    assert.notEqual(await erase(t), "allowed", "a week still to be booked: end it first");
    await run(k.db, "booking.repeat_end", { series_id: r.series_id }, k.as("Ann"), { now: t });
    assert.ok((await k.series(r.series_id)).ended_at, "nothing left to book: ended");
    assert.equal(await erase(t), "allowed");
    await runAsSystem(k.db, "club.read_only", { on: false }, "test", { now: t });
  } finally { await k.drop(); }
});

test("a series whose waiting weeks have all passed doesn't block deleting the account", async () => {
  const k = await club();
  try {
    await k.paidWeekly("Ann", k.c1, "2026-12-02", 3);
    await bookSeriesWeeks(k.db, NOW);   // 9 Dec
    await runAsSystem(k.db, "club.read_only", { on: true }, "test", { now: hours(48) });
    const t = when("2026-12-24", "09:00");   // 16 Dec passed unbooked; the last week is gone
    await plan(k.db, "privacy.erase", { person_id: k.people.Ann }, k.as("Ann"), { now: t });
    await runAsSystem(k.db, "club.read_only", { on: false }, "test", { now: t });
  } finally { await k.drop(); }
});

test("ending a weekly court from a later week gives an assistant's allowance back at once", async () => {
  const k = await club();
  try {
    const grant = "00000000-0000-7000-9000-0000000000a1";
    await k.db.insertInto("oauth_client").values({ client_id: "kc_test", kind: "registered", name: "Test Agent", redirect_uris: ["http://localhost:9999/cb"], secret_hash: null, metadata: null }).execute();
    await k.db.insertInto("oauth_grant").values({ id: grant, person_id: k.people.Ann!, client_id: "kc_test", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 80000 }).execute();
    const bot: Actor = { personId: k.people.Ann!, via: "mcp:Test Agent", lang: "en", auth: "oauth", grantId: grant };
    const p = await plan(k.db, "booking.repeat_request", { court_id: k.c1, starts_at: at("2026-12-02", "10:00"), minutes: 90, person_id: k.people.Ann, weeks: 12 }, bot, { now: NOW });
    const r = await apply(k.db, p.runId, bot, { now: NOW }) as any;
    await k.pay(r.payment_id, "Ann");
    await bookSeriesWeeks(k.db, NOW);
    const before = await weekSpent(k.db, grant, NOW);
    await run(k.db, "booking.repeat_end", { series_id: r.series_id, from_date: "2027-01-06" }, k.as("Ann"), { now: hours(1) });
    assert.equal(await weekSpent(k.db, grant, hours(1.1)), before - 7 * 6000, "the 7 weeks from 6 Jan, never to be booked");
  } finally { await k.drop(); }
});

test("a week charged and refunded before a restore isn't recorded as paid when the copy books it again: it's owed", async () => {
  const k = await club();
  try {
    const r = await k.paidWeekly("Ann", k.c1, "2026-12-02", 4);
    await bookSeriesWeeks(k.db, NOW);
    await settleShares(k.db, when("2026-12-08", "10:01"));
    const week2 = (await k.weeksOf(r.series_id))[1]!;
    await run(k.db, "booking.cancel", { booking_id: week2.id!, refund: "full" }, k.desk, { now: when("2026-12-08", "11:00") });
    await processOutbox(k.db, moneyHandlers);   // the refund goes to the provider
    const charges = k.stripe.charges.length;
    // A copy from before the second week was booked: the week not booked, nothing recorded for it.
    await sql`UPDATE booking_series_week SET booking_id = NULL WHERE id = ${week2.week_id}`.execute(k.db);
    await sql`DELETE FROM refund WHERE payment_id IN (SELECT id FROM payment WHERE booking_player_id IN (SELECT id FROM booking_player WHERE booking_id = ${week2.id}))`.execute(k.db);
    await sql`DELETE FROM payment WHERE booking_player_id IN (SELECT id FROM booking_player WHERE booking_id = ${week2.id})`.execute(k.db);
    await sql`UPDATE court_time SET active = false WHERE booking_id = ${week2.id}`.execute(k.db);
    await bookSeriesWeeks(k.db, when("2026-12-08", "12:00"));
    await settleShares(k.db, when("2026-12-08", "12:01"));
    assert.equal(k.stripe.charges.length, charges, "never a second charge");
    const again = (await k.weeksOf(r.series_id))[1]!;
    assert.notEqual(again.id, week2.id);
    const pays = await k.db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(["payment.id", "payment.status", "payment.amount_cents"])
      .where("booking_player.booking_id", "=", again.id).execute();
    assert.deepEqual(pays.map((p) => [p.status, p.amount_cents]), [["succeeded", 6000]]);
    const back = await k.db.selectFrom("refund").select(["amount_cents", "status"]).where("payment_id", "=", pays[0]!.id).execute();
    assert.deepEqual(back, [{ amount_cents: 6000, status: "sent" }], "the money that went back is recorded as gone back");
    assert.equal(again.balance_cents, 6000, "and the week is owed at the desk");
  } finally { await k.drop(); }
});

test("a first week the member cancels before paying ends the weekly court, with no 'no card' messages", async () => {
  const k = await club();
  try {
    const r = await k.weekly("Ann", k.c1, "2026-12-02", 5);
    await run(k.db, "booking.cancel", { booking_id: r.booking_id }, k.as("Ann"), { now: hours(0.05) });
    for (const d of ["2026-11-30", "2026-12-02", "2026-12-09"]) await bookSeriesWeeks(k.db, new Date(`${d}T18:30:30Z`));
    assert.ok((await k.series(r.series_id)).ended_at);
    await processOutbox(k.db, messageHandlers);
    assert.equal((await k.emails("Ann", "booking_repeat_missed")).length, 0);
  } finally { await k.drop(); }
});

test("a weekly court that fails every run is said once to the staff, and once when it works again", async () => {
  const k = await club();
  try {
    const r = await k.paidWeekly("Ann", k.c1, "2026-12-02", 4);
    // Something only this series trips on (its location's clock broken by hand).
    await sql`UPDATE location SET time_zone = 'Nowhere/Never' WHERE id = ${k.loc}`.execute(k.db);
    for (let n = 0; n < 3; n++) await bookSeriesWeeks(k.db, hours(n * 0.01));
    const told = await k.db.selectFrom("action_run").select("input").where("action", "=", "ops.report_failure").execute();
    assert.equal(told.filter((t) => (t.input as any).job === "weekly_courts").length, 1);
    await sql`UPDATE location SET time_zone = ${TZ} WHERE id = ${k.loc}`.execute(k.db);
    await bookSeriesWeeks(k.db, hours(0.1));
    await bookSeriesWeeks(k.db, hours(0.2));
    const cleared = await k.db.selectFrom("action_run").select("input").where("action", "=", "ops.report_cleared").execute();
    assert.equal(cleared.filter((t) => (t.input as any).job === "weekly_courts").length, 1);
    assert.equal((await k.states(r.series_id))[1], "confirmed");
  } finally { await k.drop(); }
});

test("after a declined week, the weeks already booked are owed at the desk at their deadlines; the dead card isn't tried again", async () => {
  const k = await club();
  try {
    const r = await k.paidWeekly("Ann", k.c1, "2026-12-02", 6);
    await bookSeriesWeeks(k.db, NOW);   // 9 Dec
    await bookSeriesWeeks(k.db, when("2026-12-02", "12:00"));   // 16 Dec too
    k.stripe.failNextCharge = "expired_card";
    await settleShares(k.db, when("2026-12-08", "10:01"));   // 9 Dec declined
    const charges = k.stripe.charges.length;
    await settleShares(k.db, when("2026-12-15", "10:01"));   // 16 Dec's deadline
    assert.equal(k.stripe.charges.length, charges);
    const w = await k.weeksOf(r.series_id);
    assert.deepEqual([w[1]!.balance_cents, w[2]!.balance_cents], [6000, 6000]);
    await processOutbox(k.db, messageHandlers);
    const due = await k.emails("Ann", "booking_week_due");
    assert.equal(due.length, 1, "told once");
    assert.match(due[0]!.body, /paid at the desk too/);
    // Paid at the desk: the next week goes on the card again.
    for (const x of [w[1]!, w[2]!]) await run(k.db, "booking.record_payment", { booking_id: x.id!, cents: 6000, method: "cash" }, k.desk, { now: when("2026-12-15", "12:00") });
    await bookSeriesWeeks(k.db, when("2026-12-16", "12:00"));
    await settleShares(k.db, when("2026-12-22", "10:01"));
    assert.equal(k.stripe.charges.length, charges + 1);
  } finally { await k.drop(); }
});
