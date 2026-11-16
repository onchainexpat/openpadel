// "Tell me when" alerts (play_alerts.ts): a member's own court alert for a day and window, and match alert at their
// level; who hears when a booking is called off or an open match opens, once each and within the cap; and the
// category on matches and programs, a label that nothing checks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { alertsOf, checkPayment, exportData, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, loc: string, c1: string, c2: string, c3: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const opts = { now: NOW };
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const deliver = () => processOutbox(db, messageHandlers);
const inbox = async (who: string, kind: string) => (await db.selectFrom("outbound_message").select(["subject", "body", "link"]).where("person_id", "=", people[who]!).where("kind", "=", kind)
  .where("channel", "=", "inbox").orderBy("created_at").execute());
const channels = async (who: string, kind: string) => (await db.selectFrom("outbound_message").select("channel").where("person_id", "=", people[who]!).where("kind", "=", kind).execute()).map((r) => r.channel).sort();
/** A court booked at the desk for someone, then called off by the club: its time is free again. */
async function bookThenCancel(court: string, day: string, from: string, minutes = 90, who = "Bob") {
  const b = (await run(db, "booking.create", { court_id: court, starts_at: at(day, from), minutes, person_id: people[who] }, owner, opts)).result as { booking_id: string };
  await run(db, "booking.cancel", { booking_id: b.booking_id, refund: "none" }, owner, opts);
  return b.booking_id;
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  const ref = (await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!;
  stripe.settle(ref, "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  [c1, c2, c3] = await Promise.all(["Court 1", "Court 2", "Court 3"].map(async (name) => ((await run(db, "court.create", { location_id: loc, name }, owner)).result as any).court_id as string)) as [string, string, string];
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const [name, level] of [["Ann", 3.4], ["Bob", 3.0], ["Cal", null], ["Dee", 3.6], ["Eve", 2.0], ["Hal", 3.5]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
    if (level !== null) await run(db, "level.set", { person_id: people[name], level, reason: "Starting level" }, owner, opts);
  }
});
after(async () => drop());

test("a court alert: the member's own, for a day and a window; the preview says what it does; changed, then turned off", async () => {
  const input = { person_id: people.Ann, kind: "court", location_id: loc, date: "2026-12-02", from: "17:00", until: "20:00" };
  const p = (await plan(db, "play_alert.set", input, as("Ann"), opts)).plan;
  assert.equal(p.summary.en, "Tell Ann when a court frees up at Eastside on Wednesday, December 2, for a start between 5:00 PM and 8:00 PM. "
    + "One message for each time that frees up, at most 3 for the day, in the app, by push and by email (quiet hours wait). The court goes to whoever books it first.");
  assert.match(p.summary.es, /^Avisarle a Ann cuando se libere una cancha en Eastside el miércoles, 2 de diciembre, con inicio entre/);
  // Not someone else's, a window backwards, a day gone by, or a day further ahead than members can book.
  await rejects(plan(db, "play_alert.set", input, as("Cal"), opts), "error.forbidden_reason");
  await rejects(plan(db, "play_alert.set", { ...input, from: "20:00", until: "17:00" }, as("Ann"), opts), "error.alert_window");
  await rejects(plan(db, "play_alert.set", { ...input, date: "2026-11-29" }, as("Ann"), opts), "error.alert_day");
  await rejects(plan(db, "play_alert.set", { ...input, date: "2027-06-01" }, as("Ann"), opts), "error.alert_day");
  await rejects(plan(db, "play_alert.set", { ...input, location_id: undefined }, as("Ann"), opts), "error.alert_court_needs");
  const id = ((await run(db, "play_alert.set", input, as("Ann"), opts)).result as { alert_id: string }).alert_id;
  await rejects(plan(db, "play_alert.set", input, as("Ann"), opts), "error.alert_already_on");
  // Another window the same day changes the one alert.
  const changed = await run(db, "play_alert.set", { ...input, from: "18:00" }, as("Ann"), opts);
  assert.match(changed.plan.summary.en, /^Change Ann's alert for Wednesday, December 2 at Eastside: a start between 6:00 PM and 8:00 PM\./);
  assert.equal((changed.result as { alert_id: string }).alert_id, id);
  assert.deepEqual((await alertsOf(db, people.Ann!, NOW)).map((a) => [a.kind, a.date, a.from, a.until]), [["court", "2026-12-02", "18:00", "20:00"]]);
  // Its day over, it isn't listed as on.
  assert.equal((await alertsOf(db, people.Ann!, new Date("2026-12-03T12:00:00Z"))).length, 0);
  const off = await run(db, "play_alert.end", { alert_id: id }, as("Ann"), opts);
  assert.equal(off.plan.summary.en, "Stop telling Ann when a court frees up at Eastside on Wednesday, December 2.");
  await rejects(plan(db, "play_alert.end", { alert_id: id }, as("Ann"), opts), "error.alert_not_on");
  // Undo turns it back on.
  await run(db, "action.undo", { run_id: off.runId }, as("Ann"), opts);
  assert.equal((await alertsOf(db, people.Ann!, NOW)).length, 1);
});

test("a booking called off: whoever's window has the freed time hears it once; its own player, and windows it misses, don't", async () => {
  await run(db, "play_alert.set", { person_id: people.Dee, kind: "court", location_id: loc, date: "2026-12-02", from: "10:00", until: "12:00" }, as("Dee"), opts);
  await deliver();
  await bookThenCancel(c1, "2026-12-02", "18:30", 90, "Ann");   // Ann gave it up herself: she isn't told of it
  await bookThenCancel(c2, "2026-12-02", "18:30");
  await deliver();
  const ann = await inbox("Ann", "court_free"), dee = await inbox("Dee", "court_free"), bob = await inbox("Bob", "court_free");
  assert.equal(ann.length, 1);
  assert.equal(ann[0]!.subject, "A court is free: Wed, Dec 2, 6:30 PM");
  assert.equal(ann[0]!.body, "Court 2 is free from Wed, Dec 2, 6:30 PM, in the time you asked about. It goes to whoever books it first in the app.");
  assert.equal(ann[0]!.link, `/book?location=${loc}&date=2026-12-02&time=18:30`);
  assert.deepEqual([dee.length, bob.length], [0, 0]);
  // By email and the app (push only for phones that have it), never by text; email waits out quiet hours like any non-urgent news.
  assert.deepEqual(await channels("Ann", "court_free"), ["email", "inbox"]);
  // The same time freed again on another court: not told twice.
  await bookThenCancel(c3, "2026-12-02", "18:30");
  await deliver();
  assert.equal((await inbox("Ann", "court_free")).length, 1);
});

test("a court alert tells at most three times for its day, and not about time taken again before it was told", async () => {
  // Booked again before the messages go: nothing to tell.
  const freed = await bookThenCancel(c1, "2026-12-02", "17:00", 60);
  assert.ok(freed);
  await run(db, "booking.create", { court_id: c1, starts_at: at("2026-12-02", "17:00"), minutes: 60, guest_name: "Walk-in" }, owner, opts);
  await deliver();
  assert.equal((await inbox("Ann", "court_free")).length, 1);
  for (const from of ["19:00", "19:30", "20:00"]) await bookThenCancel(c2, "2026-12-02", from, 60);
  await deliver();
  assert.deepEqual((await inbox("Ann", "court_free")).map((m) => m.link!.slice(-5)), ["18:30", "19:00", "19:30"]);
});

test("a match alert: only with a level; an open match opened for anyone tells those whose level is in its band, once", async () => {
  await rejects(plan(db, "play_alert.set", { person_id: people.Cal, kind: "match" }, as("Cal"), opts), "error.alert_needs_level");
  await rejects(plan(db, "play_alert.set", { person_id: people.Dee, kind: "match", date: "2026-12-02" }, as("Dee"), opts), "error.alert_match_no_day");
  const p = await run(db, "play_alert.set", { person_id: people.Dee, kind: "match" }, as("Dee"), opts);
  assert.equal(p.plan.summary.en, "Tell Dee when an open match opens whose levels include theirs (3.60). One message for each match, at most 3 a day, in the app, by push and by email (quiet hours wait). It stays on until it's turned off.");
  await rejects(plan(db, "play_alert.set", { person_id: people.Dee, kind: "match" }, as("Dee"), opts), "error.alert_already_on");
  await run(db, "play_alert.set", { person_id: people.Eve, kind: "match" }, as("Eve"), opts);
  await run(db, "play_alert.set", { person_id: people.Hal, kind: "match" }, as("Hal"), opts);
  // Hal opens a match for 3.00-4.00, marked Mixed; it's news once he has paid his part.
  const r = await run(db, "booking.request", { court_id: c3, starts_at: at("2026-12-03", "18:00"), minutes: 90, pay: "split", person_id: people.Hal,
    open: { level_min: 3, level_max: 4, gender: "mixed" } }, as("Hal"), opts);
  assert.match(r.plan.summary.en, / Category: Mixed\. It's a label to help players choose; nobody is checked against it\.$/);
  const match = (r.result as { booking_id: string }).booking_id;
  assert.equal((await db.selectFrom("open_match").select("gender").where("booking_id", "=", match).executeTakeFirstOrThrow()).gender, "mixed");
  await deliver();
  assert.equal((await inbox("Dee", "match_alert")).length, 0);   // not until it's confirmed
  await pay((r.result as { payment_id: string }).payment_id, "Hal");
  await deliver();
  const dee = await inbox("Dee", "match_alert");
  assert.equal(dee.length, 1);
  assert.equal(dee[0]!.subject, "An open match at your level: Thu, Dec 3, 6:00 PM");
  assert.equal(dee[0]!.body, "An open match for levels 3.00-4.00 opened: Court 3, Eastside, Thu, Dec 3, 6:00 PM. Category: Mixed. Join in the app while there's a place.");
  assert.equal(dee[0]!.link, `/match/${match}`);
  assert.deepEqual([(await inbox("Eve", "match_alert")).length, (await inbox("Hal", "match_alert")).length], [0, 0]);   // outside the band; the host
});

test("a match opened at the desk tells match alerts too; one not listed doesn't", async () => {
  const listed = await run(db, "booking.create", { court_id: c1, starts_at: at("2026-12-04", "18:00"), minutes: 90, pay: "split", places: [{ person_id: people.Bob }],
    open: { level_min: 3, level_max: 4, gender: "women" } }, owner, opts);
  assert.match(listed.plan.summary.en, /Category: Women\./);
  await run(db, "booking.create", { court_id: c2, starts_at: at("2026-12-04", "18:00"), minutes: 90, pay: "split", places: [{ person_id: people.Bob }],
    open: { level_min: 3, level_max: 4, listed: false } }, owner, opts);
  await deliver();
  const id = (listed.result as { booking_id: string }).booking_id;
  const links = (await inbox("Dee", "match_alert")).map((m) => m.link);
  assert.equal(links.length, 2);
  assert.equal(links[1], `/match/${id}`);
});

test("programs carry a category, set when made and changed later; it's in a person's data export with their alerts", async () => {
  const r = await run(db, "program.create", { location_id: loc, kind: "league", name: "Winter league", capacity: 12, price_cents: 5500, gender: "mixed_pairs" }, owner, opts);
  assert.match(r.plan.summary.en, / Category: Mixed pairs\. It's a label to help players choose; nobody is checked against it\.$/);
  assert.match(r.plan.summary.es, / Categoría: Parejas mixtas\./);
  const id = (r.result as { program_id: string }).program_id;
  await rejects(plan(db, "program.set_gender", { program_id: id, gender: "mixed_pairs" }, owner, opts), "error.nothing_changed");
  const w = await run(db, "program.set_gender", { program_id: id, gender: "women" }, owner, opts);
  assert.equal(w.plan.summary.en, "Change the category of Winter league. Category: Women. It's a label to help players choose; nobody is checked against it.");
  assert.equal((await plan(db, "program.set_gender", { program_id: id, gender: null }, owner, opts)).plan.summary.en, "Winter league has no category: it's open to all.");
  assert.equal((await db.selectFrom("program").select("gender").where("id", "=", id).executeTakeFirstOrThrow()).gender, "women");
  await rejects(plan(db, "program.set_gender", { program_id: id, gender: null }, as("Ann"), opts), "error.forbidden_reason");
  const data = await exportData(db, people.Dee!, NOW, "en") as unknown as { alerts: { kind: string }[] };
  assert.deepEqual(data.alerts.map((a) => a.kind).sort(), ["court", "match"]);
});
