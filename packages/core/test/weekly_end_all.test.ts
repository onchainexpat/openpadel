// Every weekly court members booked in the app, stopped at once (weekly.end_all, Settings): owners and managers only;
// either no more weeks are booked and the booked ones stay, or those go too with what the staff chose to give back;
// weekly courts the desk made stay; each member hears once, however many they had.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { bookSeriesWeeks, checkPayment, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, c1: string, c2: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function member(name: string, court: string, day: string, hhmm: string) {
  const r = (await run(db, "booking.repeat_request", { court_id: court, starts_at: at(day, hhmm), minutes: 60, person_id: people[name], weeks: 4 }, as(name), { now: NOW })).result as { series_id: string; payment_id: string };
  await openPayment(db, r.payment_id, people[name]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", r.payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  assert.equal(await checkPayment(db, r.payment_id, "test"), "succeeded");
  return r.series_id;
}
const ended = async (id: string) => Boolean((await db.selectFrom("booking_series").select("ended_at").where("id", "=", id).executeTakeFirstOrThrow()).ended_at);
const booked = (id: string) => db.selectFrom("booking").select("status").where("series_id", "=", id).orderBy("id").execute();
const mail = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who]!).where("kind", "=", kind).where("channel", "=", "email").execute();

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true, weekly_bookings: true }, owner, { now: NOW });
  for (const name of ["Lee", "Ann", "Ben", "Cal", "Dee"])
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, { now: NOW })).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: people.Lee, role: "front_desk" }, owner, { now: NOW });
  desk = as("Lee");
});
after(async () => drop());

test("keep: no more weeks for any member's weekly court, the booked weeks stay, the desk's stays, each member told once", async () => {
  const ann1 = await member("Ann", c1, "2026-12-02", "10:00"), ann2 = await member("Ann", c2, "2026-12-03", "18:00"), ben = await member("Ben", c1, "2026-12-04", "09:00");
  const cal = ((await run(db, "booking.repeat", { court_id: c2, starts_at: at("2026-12-01", "19:00"), minutes: 60, person_id: people.Cal, weeks: 3 }, desk, { now: NOW })).result as { series_id: string }).series_id;
  await bookSeriesWeeks(db, NOW);
  const before = { ann1: (await booked(ann1)).length, ben: (await booked(ben)).length };
  // Front desk's 'booking.*' doesn't reach it: owners and managers only.
  await assert.rejects(plan(db, "weekly.end_all", { booked: "keep" }, desk, { now: NOW }), (e: unknown) => e instanceof KumiError && e.code === "error.forbidden_reason");
  const p = await plan(db, "weekly.end_all", { booked: "keep" }, owner, { now: NOW });
  assert.equal(p.plan.summary.en, "Stop 3 weekly courts members booked in the app (2 members). No more weeks are booked; the weeks already booked stay. Each member is told once.");
  const r = (await run(db, "weekly.end_all", { booked: "keep" }, owner, { now: NOW })).result as { series: number; members: number };
  assert.deepEqual(r, { series: 3, members: 2 });
  for (const id of [ann1, ann2, ben]) assert.ok(await ended(id));
  assert.ok((await booked(cal)).length === 3 && (await booked(cal)).every((b) => b.status === "confirmed"), "the desk's weekly court isn't a member's: its weeks stay");
  assert.equal((await booked(ann1)).length, before.ann1); assert.ok((await booked(ann1)).every((b) => b.status === "confirmed"), "booked weeks stay");
  assert.deepEqual(await bookSeriesWeeks(db, new Date(NOW.getTime() + 10 * 864e5)), { booked: 0, missed: 0, ended: 0 }, "no more weeks booked");
  assert.equal((await booked(ben)).length, before.ben);
  await processOutbox(db, messageHandlers);
  const annMail = await mail("Ann", "weekly_all_stopped");
  assert.equal(annMail.length, 1, "Ann told once for her two");
  assert.equal(annMail[0]!.subject, "Your 2 weekly courts stopped");
  assert.equal((await mail("Ben", "weekly_all_stopped"))[0]!.subject, "Your weekly court stopped");
  assert.equal((await mail("Cal", "weekly_all_stopped")).length, 0);
  await assert.rejects(plan(db, "weekly.end_all", { booked: "keep" }, owner, { now: NOW }), (e: unknown) => e instanceof KumiError && e.code === "error.weekly_none_running");
});

test("cancel: the booked weeks from today go too, with everything back when staff choose it; told once with what came back", async () => {
  // Dee, as Ann already has the club's limit of upcoming bookings from the weeks that stayed.
  const ann = await member("Dee", c1, "2026-12-09", "12:00");
  await bookSeriesWeeks(db, NOW);
  const p = await plan(db, "weekly.end_all", { booked: "cancel", refund: "full" }, owner, { now: NOW });
  assert.match(p.plan.summary.en, /^Stop 1 weekly court members booked in the app \(1 members\)\. 1 booked week from today on is cancelled too\. Each member is told once\. \$40\.00 comes back/);
  await run(db, "weekly.end_all", { booked: "cancel", refund: "full" }, owner, { now: NOW });
  assert.ok(await ended(ann));
  assert.deepEqual((await booked(ann)).map((b) => b.status), ["cancelled"]);
  const back = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").select(["refund.amount_cents", "refund.destination"]).where("payment.person_id", "=", people.Dee!).execute();
  assert.ok(back.some((x) => x.amount_cents === 4000 && x.destination === "card"), "the first week's $40 back to the card");
  await processOutbox(db, messageHandlers);
  const m = await mail("Dee", "weekly_all_ended");
  assert.equal(m.length, 1);
  assert.match(m[0]!.body, /^The club cancelled the weekly courts booked in the app from November 30, 2026 on, yours included\. \$40\.00 goes back to your card/);
});
