import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, confirmScores, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, setPaymentProvider, suggestTeams, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string, match: string, friendly: string, game: string;
const stripe = new TestProvider();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
async function pay(paymentId: string, who: string) {
  await openPayment(db, paymentId, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", paymentId).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  return checkPayment(db, paymentId, "test", NOW);
}
/** Hal opens a match and the other three join and pay. */
async function fullMatch(day: string, hhmm: string, rated: boolean) {
  const r = await run(db, "booking.request", { court_id: court, starts_at: at(day, hhmm).toISOString(), minutes: 90, pay: "split", person_id: people.Hal, open: { level_min: 3, level_max: 4, rated } }, as("Hal"), { now: NOW });
  const id = (r.result as any).booking_id;
  await pay((r.result as any).payment_id, "Hal");
  for (const who of ["Ann", "Dee", "Eve"]) await pay(((await run(db, "booking.join", { booking_id: id, person_id: people[who] }, as(who), { now: NOW })).result as any).payment_id, who);
  return id as string;
}
const level = async (who: string) => Number((await db.selectFrom("rating").select("level").where("person_id", "=", people[who]!).executeTakeFirstOrThrow()).level);
const enter = (who: string, partner: string, sets: { us: number; them: number }[], booking = match, now = at("2026-12-02", "20:00")) =>
  run(db, "result.enter", { booking_id: booking, person_id: people[who], partner_id: people[partner], sets }, as(who), { now });

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  const opts = { now: NOW };
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, opts);
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, opts);
  await run(db, "club.update", { court_bookings: true }, owner, opts);
  for (const [name, lv] of [["Hal", 3.5], ["Ann", 3.4], ["Dee", 3.6], ["Eve", 3.3]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as { person_id: string }).person_id;
    await run(db, "level.set", { person_id: people[name], level: lv, reason: "Starting level" }, owner, opts);
  }
  match = await fullMatch("2026-12-02", "18:00", true);
  friendly = await fullMatch("2026-12-03", "10:00", false);
});
after(async () => drop());

test("fair teams for the four, and entering the score: the enterer's side has confirmed it", async () => {
  const t = (await suggestTeams(db, match))!;
  assert.deepEqual([...t.a.map((p) => p.name), ...t.b.map((p) => p.name)].sort(), ["Ann", "Dee", "Eve", "Hal"]);
  assert.match(t.odds, /^\d+\/\d+$/);
  await rejects(plan(db, "result.enter", { booking_id: match, person_id: people.Hal, partner_id: people.Ann, sets: [{ us: 6, them: 3 }] }, as("Hal"), { now: at("2026-12-02", "17:00") }), "error.not_played_yet");
  await rejects(plan(db, "result.enter", { booking_id: match, person_id: people.Hal, partner_id: people.Ann, sets: [{ us: 6, them: 6 }] }, as("Hal"), { now: at("2026-12-02", "20:00") }), "error.set_tied");
  const r = await enter("Hal", "Ann", [{ us: 6, them: 3 }, { us: 6, them: 4 }]);
  assert.equal(r.plan.summary.en, "Enter the score for your match on Court 1, Wed, Dec 2, 6:00 PM: you and Ann won 6-3 6-4 against Dee and Eve. They have 48 hours to confirm or dispute it; after that it counts as entered, and it counts for levels.");
  game = (r.result as any).game_id;
  await rejects(plan(db, "result.enter", { booking_id: match, person_id: people.Dee, partner_id: people.Eve, sets: [{ us: 6, them: 3 }] }, as("Dee"), { now: at("2026-12-02", "20:05") }), "error.score_entered");
  await rejects(plan(db, "result.confirm", { game_id: game, person_id: people.Ann }, as("Ann"), { now: at("2026-12-02", "20:05") }), "error.other_side_confirms");
  assert.equal(await level("Hal"), 3.5);   // nothing moves until it's confirmed
  await processOutbox(db, messageHandlers);
  const msg = await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Dee!).where("kind", "=", "result_to_confirm").where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.equal(msg.body, "Hal entered Ann and Hal 6-3 6-4 Dee and Eve for your match on Court 1, Wed, Dec 2, 6:00 PM. Confirm or dispute it in the app; if nobody answers by Fri, Dec 4, 8:00 PM, it counts as entered.");
});

test("the other side confirms: levels move, each with why", async () => {
  const c = await run(db, "result.confirm", { game_id: game, person_id: people.Dee }, as("Dee"), { now: at("2026-12-02", "20:30") });
  assert.equal(c.plan.summary.en, "Confirm the score: Ann and Hal 6-3 6-4 Dee and Eve. Once confirmed, it counts for levels.");
  assert.ok(await level("Hal") > 3.5); assert.ok(await level("Dee") < 3.6);
  const why = await db.selectFrom("rating_event").select("explanation").where("person_id", "=", people.Hal!).where("game_id", "=", game).executeTakeFirstOrThrow();
  assert.match((why.explanation as any).en, /^Won 12 to 7 with Ann against Dee and Eve/);
});

test("a dispute stops it counting until the club decides; the club corrects it and levels are replayed", async () => {
  const halBefore = await level("Hal");
  await rejects(plan(db, "result.dispute", { game_id: game, person_id: people.Eve, note: "x" }, as("Eve"), { now: at("2026-12-02", "21:00") }), "error.invalid_input");
  const d = await run(db, "result.dispute", { game_id: game, person_id: people.Eve, note: "The second set was 4-6 to us" }, as("Eve"), { now: at("2026-12-02", "21:00") });
  assert.equal(d.plan.summary.en, "Dispute the score Ann and Hal 6-3 6-4 Dee and Eve. It won't count until the club decides.");
  assert.equal(await level("Hal"), 3.5);   // as if it hadn't been played
  await rejects(plan(db, "result.resolve", { game_id: game, outcome: "keep" }, as("Ann"), { now: at("2026-12-03", "09:00") }), "error.forbidden_reason");   // the club decides
  const fix = await run(db, "result.resolve", { game_id: game, outcome: "correct", sets: [{ a: 6, b: 3 }, { a: 4, b: 6 }, { a: 10, b: 8 }] }, owner, { now: at("2026-12-03", "09:00") });
  assert.equal(fix.plan.summary.en, "Correct the score for the match on Court 1, Wed, Dec 2, 6:00 PM to Ann and Hal 6-3 4-6 10-8 Dee and Eve. It counts, and the players are told.");
  const after = await level("Hal");
  assert.ok(after > 3.5 && after < halBefore, `a closer win moves Hal less: ${after} vs ${halBefore}`);
  await rejects(plan(db, "result.dispute", { game_id: game, person_id: people.Dee, note: "Still wrong" }, as("Dee"), { now: at("2026-12-03", "10:00") }), "error.dispute_closed");
  await processOutbox(db, messageHandlers);
  assert.equal((await db.selectFrom("outbound_message").select("subject").where("person_id", "=", owner.personId!).where("kind", "=", "result_disputed_staff").executeTakeFirstOrThrow()).subject,
    "A score is disputed: Court 1, Wed, Dec 2, 6:00 PM");
  assert.equal((await db.selectFrom("outbound_message").select("body").where("person_id", "=", people.Ann!).where("kind", "=", "result_corrected").where("channel", "=", "email").executeTakeFirstOrThrow()).body,
    "After the dispute, the club set the score to Ann and Hal 6-3 4-6 10-8 Dee and Eve. It counts.");
});

test("with no answer in 48 hours it counts as entered; a friendly never moves levels", async () => {
  const before = await level("Ann");
  const r = await enter("Ann", "Dee", [{ us: 6, them: 2 }, { us: 6, them: 1 }], friendly, at("2026-12-03", "12:00"));
  assert.match(r.plan.summary.en, /and it's a friendly, so levels don't move\.$/);
  const id = (r.result as any).game_id;
  assert.deepEqual(await confirmScores(db, at("2026-12-05", "11:59")), { confirmed: 0 });
  assert.deepEqual(await confirmScores(db, at("2026-12-05", "12:00")), { confirmed: 1 });
  assert.equal((await db.selectFrom("game").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status, "confirmed");
  assert.equal(await level("Ann"), before);
  assert.equal((await db.selectFrom("rating_event").select("id").where("game_id", "=", id).execute()).length, 0);
});
