import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { levelQueue, messageHandlers, plan, processOutbox, replay, run, runAsSystem, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, coach: Actor, loc: string;
const NOW = new Date("2026-12-01T18:00:00Z"), opts = { now: NOW };
const at = (h: number) => new Date(NOW.getTime() + h * 3600_000);
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
async function rejects(p: Promise<unknown>, code: string, text?: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); if (text) assert.equal(e.text.en, text); return true; });
}
async function staff(name: string, role: string): Promise<Actor> {
  const id = ((await run(db, "person.create", { display_name: name, email: `${name.split(" ")[0]!.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  const r = await db.selectFrom("role").select("id").where("key", "=", role).executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  return { personId: id, via: "test", lang: "en" };
}
const rating = (who: string) => db.selectFrom("rating").selectAll().where("person_id", "=", people[who]!).executeTakeFirstOrThrow();
const inbox = (who: string, kind: string) => db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", people[who] ?? who).where("kind", "=", kind).where("channel", "=", "inbox").execute();
/** Games moved a level (what rated results do), as a game event, without playing them out here. */
async function gamesMoved(who: string, to: number, when: Date) {
  const runId = (await db.selectFrom("action_run").select("id").limit(1).executeTakeFirstOrThrow()).id, r = await rating(who);
  await db.insertInto("rating_event").values({ id: uuidv7(), person_id: people[who]!, kind: "game", mu_before: r.mu, sigma_before: r.sigma, level_before: r.level, mu_after: to, sigma_after: 0.5,
    level_after: to.toFixed(2), explanation: JSON.stringify({ en: "games", es: "partidos" }), action_run_id: runId, model_version: "test", at: when }).execute();
  await db.updateTable("rating").set({ level: to.toFixed(2), mu: to }).where("person_id", "=", people[who]!).execute();
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner, opts)).result as any).location_id;
  desk = await staff("Dana Desk", "front_desk"); people.Dana = desk.personId!;
  coach = await staff("Cole Coach", "coach");
  for (const name of ["Ann", "Ben", "Cy", "Dot", "Eve", "Fay"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, opts)).result as any).person_id;
  for (const [name, lv] of [["Ann", 3], ["Ben", 3.3], ["Dot", 3], ["Fay", 3.2]] as const) await run(db, "level.set", { person_id: people[name], level: lv, reason: "Starting level" }, owner, opts);
});
after(async () => drop());

test("a new player moves their own level once, by up to half a level, and the replay keeps it", async () => {
  await rejects(plan(db, "level.self_adjust", { person_id: people.Ann, level: 3.6 }, as("Ann"), opts), "error.self_adjust_range", "You can move your level by up to 0.50 either way from 3.00.");
  const r = await run(db, "level.self_adjust", { person_id: people.Ann, level: 3.45 }, as("Ann"), opts);
  assert.equal(r.plan.summary.en, "Move your level from 3.00 to 3.45. While you've played fewer than 5 rated games (0 so far), you can do this once, by up to 0.50 either way. Your next games start from 3.45, and your level history shows the change.");
  const a = await rating("Ann");
  assert.deepEqual([a.level, a.self_adjust_used, a.mu], ["3.45", "0.45", 3.45]);
  const ev = await db.selectFrom("rating_event").select(["kind", "explanation", "factors"]).where("person_id", "=", people.Ann!).orderBy("id", "desc").executeTakeFirstOrThrow();
  assert.deepEqual([ev.kind, (ev.explanation as any).en, (ev.factors as any).delta], ["self_adjust", "You moved your own level from 3.00 to 3.45.", 0.45]);
  await rejects(plan(db, "level.self_adjust", { person_id: people.Ann, level: 3.5 }, as("Ann"), opts), "error.self_adjust_used");
  await rejects(plan(db, "level.self_adjust", { person_id: people.Ben, level: 3.5 }, as("Ann"), opts), "error.forbidden_reason");   // only their own
  await db.updateTable("rating").set({ rated_games: 5 }).where("person_id", "=", people.Ben!).execute();
  await rejects(plan(db, "level.self_adjust", { person_id: people.Ben, level: 3.5 }, as("Ben"), opts), "error.self_adjust_late");
  await db.updateTable("rating").set({ rated_games: 0 }).where("person_id", "=", people.Ben!).execute();
  await rejects(plan(db, "level.self_adjust", { person_id: people.Cy, level: 3 }, as("Cy"), opts), "error.no_level_yet");
  await run(db, "level.set_floor", { person_id: people.Dot, floor: 3, reason: "Coach assessment" }, owner, opts);
  await rejects(plan(db, "level.self_adjust", { person_id: people.Dot, level: 2.8 }, as("Dot"), opts), "error.below_floor", "2.80 is below the floor a coach set (3.00).");
  const st = (await replay(db)).get(people.Ann!)!;
  assert.deepEqual([st.level, st.mu], [3.45, 3.45]);
});

test("a review: asked once, answered from the queue, and not again for 30 days", async () => {
  const r = await run(db, "level.request_review", { person_id: people.Ann, note: "I keep losing to 3.0s" }, as("Ann"), opts);
  assert.equal(r.plan.summary.en, "Ask the club to review your level (3.45). It's free: staff look at your games and answer in the app. You can ask once every 30 days. Your note: \"I keep losing to 3.0s\"");
  await rejects(plan(db, "level.request_review", { person_id: people.Ann }, as("Ann"), opts), "error.review_open");
  assert.deepEqual((await levelQueue(db, NOW)).requests.map((x) => [x.name, x.note]), [["Ann", "I keep losing to 3.0s"]]);
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Dana", "level_review_requested_staff"))[0]!.body, "Ann (3.45) asked the club to review their level. Note: \"I keep losing to 3.0s\" Answer it on the Levels page.");
  const k = await run(db, "level.answer_review", { person_id: people.Ann, outcome: "keep", reason: "Your games fit 3.45" }, desk, { now: at(2) });
  assert.equal(k.plan.summary.en, "Keep Ann's level at 3.45. Note: \"Your games fit 3.45\" They're told.");
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Ann", "level_review_kept"))[0]!.body, "The club looked at your level and is keeping it at 3.45. Note: \"Your games fit 3.45\"");
  assert.equal((await levelQueue(db, at(3))).requests.length, 0);
  await rejects(plan(db, "level.request_review", { person_id: people.Ann }, as("Ann"), { now: at(24) }), "error.review_too_soon", "You can ask for a review once every 30 days. You can ask again from December 31, 2026.");
  assert.equal((await plan(db, "level.request_review", { person_id: people.Ann }, as("Ann"), { now: at(30 * 24) })).status, "planned");
});

test("front desk changes a level from a review, with a reason the player sees", async () => {
  await run(db, "level.request_review", { person_id: people.Ben }, as("Ben"), opts);
  await rejects(plan(db, "level.answer_review", { person_id: people.Ben, outcome: "change", level: 3.1 }, desk, opts), "error.change_needs_level");
  const c = await run(db, "level.answer_review", { person_id: people.Ben, outcome: "change", level: 3.1, reason: "Plays more like a 3.1 in clinics" }, desk, { now: at(1) });
  assert.equal(c.status, "planned");   // not sent for approval, unlike other level changes by front desk
  assert.equal(c.plan.summary.en, "Change Ben's level from 3.30 to 3.10: Plays more like a 3.1 in clinics. They're told.");
  assert.equal((await rating("Ben")).level, "3.10");
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Ben", "level_review_changed"))[0]!.body, "The club reviewed your level and changed it from 3.30 to 3.10. Note: \"Plays more like a 3.1 in clinics\"");
  const ev = await db.selectFrom("rating_event").select("explanation").where("person_id", "=", people.Ben!).orderBy("id", "desc").executeTakeFirstOrThrow();
  assert.equal((ev.explanation as any).en, "Reviewed by Dana Desk: Plays more like a 3.1 in clinics.");
});

test("a level that moved more than 0.50 in 30 days is in the queue until staff look at it", async () => {
  await run(db, "level.set", { person_id: people.Eve, level: 3, reason: "Starting level" }, owner, { now: at(-40 * 24) });
  await gamesMoved("Eve", 3.4, at(-10 * 24));
  assert.deepEqual((await levelQueue(db, NOW)).moves.map((m) => m.name), []);
  await gamesMoved("Eve", 3.7, at(-5 * 24));
  const m = (await levelQueue(db, NOW)).moves;
  assert.deepEqual(m.map((x) => [x.name, x.from, x.level]), [["Eve", 3, 3.7]]);
  await rejects(plan(db, "level.answer_review", { person_id: people.Fay, outcome: "keep" }, desk, opts), "error.nothing_to_review");
  const k = await run(db, "level.answer_review", { person_id: people.Eve, outcome: "keep" }, desk, opts);
  assert.equal(k.plan.summary.en, "Keep Eve's level at 3.70.");   // she never asked: nobody to tell
  await gamesMoved("Eve", 3.85, at(1));
  assert.deepEqual((await levelQueue(db, at(2))).moves, []);   // measured from where staff left it
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Eve", "level_review_kept")).length, 0);
});

test("after a clinic, its levels set in one go; each player whose level changes is told", async () => {
  const pid = ((await run(db, "program.create", { location_id: loc, kind: "clinic", name: "Clinic L", capacity: 8, price_cents: 0 }, owner, opts)).result as any).program_id;
  const court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner, opts)).result as any).court_id;
  const session = ((await run(db, "session.add", { program_id: pid, starts_at: at(2).toISOString(), ends_at: at(3).toISOString(), court_ids: [court] }, owner, opts)).result as any).session_id;
  await run(db, "program.publish", { program_id: pid }, owner, opts);
  for (const who of ["Ann", "Ben", "Cy"]) await run(db, "enrolment.join", { program_id: pid, person_id: people[who] }, as(who), opts);
  const levels = [{ person_id: people.Ann, level: 3.45 }, { person_id: people.Ben, level: 3.5 }, { person_id: people.Cy, level: 2.75 }];
  const input = { session_id: session, reason: "Assessed in the clinic drills", levels };
  await rejects(plan(db, "level.set_session", input, coach, opts), "error.session_not_started");
  await rejects(plan(db, "level.set_session", { ...input, levels: [...levels, { person_id: people.Eve, level: 3 }] }, coach, { now: at(3) }), "error.not_in_session", "Eve didn't have a place in this session.");
  await rejects(plan(db, "level.set_session", input, as("Ann"), { now: at(3) }), "error.forbidden_reason");
  const r = await run(db, "level.set_session", input, coach, { now: at(3) });
  assert.equal(r.plan.summary.en, "Set levels after Clinic L, Tue, Dec 1, 12:00 PM: Ben from 3.10 to 3.50; Cy from no level yet to 2.75. Reason: Assessed in the clinic drills. 1 other player stays as they are. Each player whose level changes is told.");
  assert.deepEqual([(await rating("Ben")).level, (await rating("Cy")).level, (await rating("Ann")).level], ["3.50", "2.75", "3.45"]);
  const ev = await db.selectFrom("rating_event").select("explanation").where("person_id", "=", people.Cy!).orderBy("id", "desc").executeTakeFirstOrThrow();
  assert.equal((ev.explanation as any).en, "Set by Cole Coach after Clinic L (December 1, 2026): Assessed in the clinic drills.");
  await processOutbox(db, messageHandlers);
  assert.equal((await inbox("Cy", "level_set_session"))[0]!.body, "After Clinic L, Tue, Dec 1, 12:00 PM, Cole Coach set your level from no level yet to 2.75: Assessed in the clinic drills.");
  assert.equal((await inbox("Ann", "level_set_session")).length, 0);
  await rejects(plan(db, "level.set_session", { ...input, levels: [{ person_id: people.Ben, level: 3.5 }] }, desk, { now: at(4) }), "error.levels_unchanged");
  assert.equal((await plan(db, "level.set_session", { ...input, levels: [{ person_id: people.Ben, level: 3.6 }] }, desk, { now: at(4) })).status, "planned");   // front desk too
});
