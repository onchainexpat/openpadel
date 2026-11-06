// Weekly court bookings (booking_series.ts): each week an ordinary booking. Staff make one for a member, every week
// owed at the desk; a member makes their own (when the club allows it), paying the first week now, and each later week
// is booked once it's inside their booking window and goes on the saved card at the club's deadline. Never a court
// held beyond the window, never a week booked twice, and ending it cancels each week under its own rules.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { bookSeriesWeeks, checkPayment, expireHolds, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, seriesOf, setPaymentProvider, settleShares,
  KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, loc: string, c1: string, c2: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const hours = (n: number, from = NOW) => new Date(from.getTime() + n * 3600_000);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  return checkPayment(db, paymentId, "test");
}
const weeksOf = (seriesId: string) => db.selectFrom("booking_series_week").leftJoin("booking", "booking.id", "booking_series_week.booking_id")
  .select(["booking_series_week.on_date", "booking_series_week.missed", "booking.status", "booking.id"]).where("booking_series_week.series_id", "=", seriesId).orderBy("on_date").execute();
const messages = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "email").execute();
const onCourt = async (court: string, from: string, to: string) => (await db.selectFrom("court_time").select("booking_id").where("court_id", "=", court).where("active", "=", true)
  .where("kind", "in", ["booking", "hold"]).where((w) => w.and([w(w.fn("lower", ["during"]), ">=", new Date(from)), w(w.fn("lower", ["during"]), "<", new Date(to))])).execute()).length;

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
  for (const name of ["Lee", "Ann", "Ben", "Cal", "Dee", "Eve", "Fay"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, { now: NOW })).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, { now: NOW });
  desk = as("Lee");
});
after(async () => drop());

test("the desk books a member every week: each week its own booking, owed at the desk, the weeks in the way left out", async () => {
  // Something on the third Tuesday already: that week is left out, named in the preview, never moved.
  await run(db, "booking.create", { court_id: c1, starts_at: at("2026-12-15", "18:00"), minutes: 60, guest_name: "Walk-in" }, desk, { now: NOW });
  const input = { court_id: c1, starts_at: at("2026-12-01", "18:00"), minutes: 90, person_id: people.Ben, weeks: 4 };
  const p = await plan(db, "booking.repeat", input, desk, { now: NOW });
  assert.equal(p.plan.summary.en, "Book Court 1 every Tuesday at 6:00 PM, 90 minutes, for Ben: 3 weeks, Tue, Dec 1 to Tue, Dec 22 ($60.00 a week, $180.00 in all). "
    + "Each week is its own booking, paid at the desk, with the club's cancel rules for that week. Left out, as something is in the way: Tue, Dec 15 (taken).");
  const r = (await run(db, "booking.repeat", input, desk, { now: NOW })).result as { series_id: string; booked: number };
  assert.equal(r.booked, 3);
  const weeks = await weeksOf(r.series_id);
  assert.deepEqual(weeks.map((w) => [w.on_date, w.missed, w.status]), [["2026-12-01", null, "confirmed"], ["2026-12-08", null, "confirmed"], ["2026-12-15", "taken", null], ["2026-12-22", null, "confirmed"]]);
  // Ordinary desk bookings: nothing charged, owed at the desk; the member sees the series.
  assert.equal(Number((await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select((eb) => eb.fn.countAll<string>().as("n"))
    .where("booking_player.booking_id", "in", weeks.filter((w) => w.id).map((w) => w.id!)).executeTakeFirstOrThrow()).n), 0);
  const mine = await seriesOf(db, people.Ben!, NOW);
  assert.equal(mine.length, 1); assert.deepEqual(mine[0]!.weeks.map((w) => w.state), ["booked", "booked", "missed", "booked"]);
  await processOutbox(db, messageHandlers);
  assert.match((await messages("Ben", "booking_repeat_made"))[0]!.body, /Court 1 for you every Tuesday at 6:00 PM for 90 minutes: 3 weeks, from December 1, 2026 to December 22, 2026\. Each week is paid at the desk/);
  await rejects(plan(db, "booking.repeat", { ...input, weeks: 27 }, desk, { now: NOW }), "error.invalid_input");
  await rejects(plan(db, "booking.repeat", { ...input, weeks: 3, until_date: "2026-12-30" }, desk, { now: NOW }), "error.repeat_how_long");
});

test("two desks at once on the same court and times: each week goes to one of them, never both", async () => {
  const a = { court_id: c2, starts_at: at("2026-12-02", "12:00"), minutes: 60, person_id: people.Cal, weeks: 3 };
  const b = { ...a, person_id: people.Dee };
  const [pa, pb] = await Promise.all([plan(db, "booking.repeat", a, desk, { now: NOW }), plan(db, "booking.repeat", b, owner, { now: NOW })]);
  void pa; void pb;
  const results = await Promise.allSettled([run(db, "booking.repeat", a, desk, { now: NOW }), run(db, "booking.repeat", b, owner, { now: NOW })]);
  const ok = results.filter((x) => x.status === "fulfilled").length;
  assert.ok(ok >= 1);
  assert.equal(await onCourt(c2, at("2026-12-02", "00:00"), at("2026-12-24", "00:00")), 3, "three weeks on the court, each once");
});

test("a member's own weekly court: off unless the club allows it, at most its weeks, the first week paid now", async () => {
  const input = { court_id: c1, starts_at: at("2026-12-02", "10:00"), minutes: 90, person_id: people.Ann, weeks: 5 };
  await rejects(plan(db, "booking.repeat_request", input, as("Ann"), { now: NOW }), "error.weekly_off");
  await run(db, "club.update", { weekly_bookings: true, weekly_max_weeks: 4 }, owner, { now: NOW });
  await rejects(plan(db, "booking.repeat_request", input, as("Ann"), { now: NOW }), "error.repeat_too_many", "A weekly booking runs for at most 4 weeks.");
  const p = await plan(db, "booking.repeat_request", { ...input, weeks: 4 }, as("Ann"), { now: NOW });
  assert.match(p.plan.summary.en, /^Book Court 1 every Wednesday at 10:00 AM, 90 minutes: 4 weeks, Wed, Dec 2 to Wed, Dec 23 \(\$60.00 a week, \$240.00 in all\)\. You pay \$60.00 for the first week now/);
  assert.match(p.plan.summary.en, /booked once it's within 14 days of the day, and goes on that card 24 hours before it starts/);
  const r = (await run(db, "booking.repeat_request", { ...input, weeks: 4 }, as("Ann"), { now: NOW })).result as { series_id: string; booking_id: string; payment_id: string; later: { count: number; cents: number; hours: number } };
  // The card form for the first week says what the later weeks put on that card (the third phone check).
  assert.deepEqual(r.later, { count: 3, cents: 18000, hours: 24 });
  // Only the first week holds a court; the others wait for the window.
  assert.equal((await db.selectFrom("booking").select("id").where("series_id", "=", r.series_id).execute()).length, 1);
  assert.equal(await pay(r.payment_id, "Ann"), "succeeded");
  // Inside the window now (14 days): the second week. The third and fourth wait.
  assert.deepEqual(await bookSeriesWeeks(db, NOW), { booked: 1, missed: 0, ended: 0 });
  assert.deepEqual((await weeksOf(r.series_id)).map((w) => w.status ?? (w.missed ? `missed ${w.missed}` : "waiting")), ["confirmed", "confirmed", "waiting", "waiting"]);
  assert.deepEqual(await bookSeriesWeeks(db, NOW), { booked: 0, missed: 0, ended: 0 }, "a week is booked once");
  // Someone books the fourth week before it comes into Ann's window: that week is left out, she hears, nothing is charged.
  const other = (await run(db, "booking.request", { court_id: c1, starts_at: at("2026-12-23", "10:00"), minutes: 90, pay: "whole", person_id: people.Eve }, as("Eve"), { now: hours(24 * 10) })).result as { payment_id: string };
  await pay(other.payment_id, "Eve");
  assert.deepEqual(await bookSeriesWeeks(db, hours(24 * 10)), { booked: 1, missed: 1, ended: 1 }, "nothing left to book, so it's closed; its weeks still show");
  assert.deepEqual((await weeksOf(r.series_id)).map((w) => w.status ?? `missed ${w.missed}`), ["confirmed", "confirmed", "confirmed", "missed taken"]);
  await processOutbox(db, messageHandlers);
  assert.match((await messages("Ann", "booking_repeat_missed"))[0]!.body, /We couldn't book Court 1 at 10:00 AM for your weekly court on this week, and nothing is charged for it: December 23, 2026 \(someone else had it booked by then\)\./);
});

test("each later week goes on the saved card at the deadline; a declined week is owed at the desk and the rest stay", async () => {
  const series = (await db.selectFrom("booking_series").select("id").where("organiser_id", "=", people.Ann!).executeTakeFirstOrThrow()).id;
  const week2 = (await weeksOf(series))[1]!.id!, week3 = (await weeksOf(series))[2]!.id!;
  const before = stripe.charges.length;
  // 24 hours before the second week (Wed 9 Dec, 10 am): charged once.
  await settleShares(db, new Date(new Date(at("2026-12-08", "10:01")).getTime()));
  assert.equal(stripe.charges.length, before + 1);
  assert.equal(stripe.charges.at(-1)!.amountCents, 6000);
  const paid = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(["payment.amount_cents", "payment.status"])
    .where("booking_player.booking_id", "=", week2).execute();
  assert.deepEqual(paid, [{ amount_cents: 6000, status: "succeeded" }]);
  await settleShares(db, new Date(at("2026-12-08", "10:30")));
  assert.equal(stripe.charges.length, before + 1, "charged once");
  await processOutbox(db, messageHandlers);
  assert.match((await messages("Ann", "booking_week_charged"))[0]!.body, /\$60\.00 for your weekly court, Court 1, Wed, Dec 9, 10:00 AM, went on your card/);
  // The third week's charge is declined: owed at the desk, Ann and the desk told; the series goes on.
  stripe.failNextCharge = "card_declined";
  await settleShares(db, new Date(at("2026-12-15", "10:01")));
  assert.equal((await db.selectFrom("booking").select("balance_cents").where("id", "=", week3).executeTakeFirstOrThrow()).balance_cents, 6000);
  await processOutbox(db, messageHandlers);
  assert.match((await messages("Ann", "booking_week_due"))[0]!.body, /We couldn't charge \$60\.00 for your weekly court, Court 1, Wed, Dec 16, 10:00 AM, to your card/);
  assert.ok((await db.selectFrom("outbound_message").select("id").where("kind", "=", "booking_balance_due_staff").execute()).length > 0);
  // Owed, not paid: My places says so.
  assert.equal((await seriesOf(db, people.Ann!, new Date(at("2026-12-15", "10:02"))))[0]!.weeks.find((w) => w.date === "2026-12-16")!.state, "owed");
});

test("ending a weekly court: from a week on, each under its own rules; the member can't choose the refund; told once", async () => {
  const input = { court_id: c2, starts_at: at("2026-12-03", "08:00"), minutes: 60, person_id: people.Fay, weeks: 4 };
  const r = (await run(db, "booking.repeat", input, desk, { now: NOW })).result as { series_id: string };
  await rejects(plan(db, "booking.repeat_end", { series_id: r.series_id, refund: "full" }, as("Fay"), { now: NOW }), "error.refund_choice_staff");
  const p = await plan(db, "booking.repeat_end", { series_id: r.series_id, from_date: "2026-12-10" }, as("Fay"), { now: NOW });
  assert.equal(p.plan.summary.en, "Cancel Court 2 every Thursday at 8:00 AM, 60 minutes from Thu, Dec 10 on: 3 booked weeks are cancelled.");
  await run(db, "booking.repeat_end", { series_id: r.series_id, from_date: "2026-12-10" }, as("Fay"), { now: NOW });
  assert.deepEqual((await weeksOf(r.series_id)).map((w) => w.status), ["confirmed", "cancelled", "cancelled", "cancelled"]);
  assert.equal((await db.selectFrom("booking_series").select("last_date").where("id", "=", r.series_id).executeTakeFirstOrThrow()).last_date, "2026-12-09");
  await processOutbox(db, messageHandlers);
  assert.equal((await messages("Fay", "booking_cancelled")).length, 0, "no message a week");
  assert.equal((await messages("Fay", "booking_repeat_ended")).length, 0, "she ended it herself");
  // The desk ends the rest: Fay hears once.
  await run(db, "booking.repeat_end", { series_id: r.series_id, refund: "full" }, desk, { now: NOW });
  await processOutbox(db, messageHandlers);
  assert.equal((await messages("Fay", "booking_repeat_ended")).length, 1);
  assert.ok((await db.selectFrom("booking_series").select("ended_at").where("id", "=", r.series_id).executeTakeFirstOrThrow()).ended_at);
  await rejects(plan(db, "booking.repeat_end", { series_id: r.series_id }, desk, { now: NOW }), "error.weekly_over");
});

test("a member's first week never paid: the hold lapses and the series closes; read-only books nothing new", async () => {
  const r = (await run(db, "booking.repeat_request", { court_id: c2, starts_at: at("2026-12-04", "19:00"), minutes: 90, person_id: people.Eve, weeks: 3 }, as("Eve"), { now: NOW })).result as { series_id: string };
  await expireHolds(db, hours(1));
  assert.deepEqual(await bookSeriesWeeks(db, hours(1)), { booked: 0, missed: 0, ended: 1 });
  assert.ok((await db.selectFrom("booking_series").select("ended_at").where("id", "=", r.series_id).executeTakeFirstOrThrow()).ended_at);
  await runAsSystem(db, "club.read_only", { on: true }, "test", { now: NOW });
  await assert.rejects(plan(db, "booking.repeat", { court_id: c2, starts_at: at("2026-12-05", "09:00"), minutes: 60, person_id: people.Dee, weeks: 2 }, desk, { now: NOW }),
    (e: unknown) => e instanceof KumiError && e.code === "error.read_only");
  assert.deepEqual(await bookSeriesWeeks(db, hours(24 * 12)), { booked: 0, missed: 0, ended: 0 });
  await runAsSystem(db, "club.read_only", { on: false }, "test", { now: NOW });
});
