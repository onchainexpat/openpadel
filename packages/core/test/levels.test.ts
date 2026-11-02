import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { MODEL, plan, replay, run, runAsSystem, shownLevel, shownOdds, stretchedShare, update, uuidv7, winChance, type Actor, type Db } from "../src/index.ts";

const P = (mu: number, sigma = 0.4) => ({ mu, sigma });

test("equal teams are 50/50; a stronger team is favored; it's symmetric", () => {
  assert.equal(winChance([P(3), P(3)], [P(3), P(3)]), 0.5);
  const p = winChance([P(4), P(4)], [P(3), P(3)]);
  assert.ok(p > 0.8, String(p));
  assert.ok(Math.abs(p + winChance([P(3), P(3)], [P(4), P(4)]) - 1) < 1e-12);
});

test("winners go up, losers go down, and everyone is a little more certain", () => {
  const r = update({ a: [P(3), P(3)], b: [P(3), P(3)], scoreA: 16, scoreB: 8 });
  assert.ok(r.a.every((s) => s.mu > 3) && r.b.every((s) => s.mu < 3));
  assert.ok([...r.a, ...r.b].every((s) => s.sigma < Math.sqrt(0.4 ** 2 + MODEL.tau ** 2)));
});

test("a blowout counts more than a close game, and an upset more than an expected win", () => {
  const close = update({ a: [P(3), P(3)], b: [P(3), P(3)], scoreA: 13, scoreB: 11 }).a[0]!.mu - 3;
  const blowout = update({ a: [P(3), P(3)], b: [P(3), P(3)], scoreA: 24, scoreB: 0 }).a[0]!.mu - 3;
  assert.ok(blowout > close * 3, `${blowout} vs ${close}`);
  const expected = update({ a: [P(4), P(4)], b: [P(3), P(3)], scoreA: 18, scoreB: 6 }).a[0]!.mu - 4;
  const upset = update({ a: [P(3), P(3)], b: [P(4), P(4)], scoreA: 18, scoreB: 6 }).a[0]!.mu - 3;
  assert.ok(upset > expected * 2, `${upset} vs ${expected}`);
  assert.equal(stretchedShare(13, 11), 0.5 + 3 * (13 / 24 - 0.5));
});

test("the shown level: provisional players see the estimate, others move 30% of the way, floors hold", () => {
  assert.equal(shownLevel(3, 3.5, 1.0, null), 3.5);
  assert.equal(shownLevel(3, 3.5, 0.3, null), 3.15);
  assert.equal(shownLevel(3, 2.0, 0.3, 2.9), 2.9);
  assert.equal(shownOdds(0.93), 0.8); assert.equal(shownOdds(0.05), 0.2);
});

// ---- In the database ----
let db: Db, drop: () => Promise<void>, owner: Actor, monica: Actor, desk: Actor, locationId: string;
/** A time after the round's night has started: scores are only taken for rounds that have been played. */
const played = async (gameId: string) => ({ now: new Date((await db.selectFrom("game").innerJoin("session", "session.id", "game.session_id").select("session.starts_at").where("game.id", "=", gameId).executeTakeFirstOrThrow()).starts_at.getTime() + 3 * 3600_000) });
const as = (personId: string, lang: "en" | "es" = "en"): Actor => ({ personId, via: "test", lang });
let n = 0;
async function person(name: string, role = "member", level?: number) {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: `${name.toLowerCase()}${n++}@example.test`, created_via: "desk" }).execute();
  const r = await db.selectFrom("role").select("id").where("key", "=", role).executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  if (level !== undefined) await run(db, "level.set", { person_id: id, level, reason: "Playtomic level at move-in" }, owner);
  return id;
}
async function americano(names: [string, number][], rated = true) {
  const courts: string[] = [];
  for (let c = 1; c <= 2; c++) courts.push(((await run(db, "court.create", { location_id: locationId, name: `Court ${n}-${c}` }, owner)).result as { court_id: string }).court_id);
  const p = (await run(db, "program.create", { location_id: locationId, kind: "social", format: "americano", name: `Americano ${n++}`, capacity: names.length, price_cents: 0, rated }, owner)).result as { program_id: string };
  const at = Date.now() + (5 + n) * 864e5;
  const s = (await run(db, "session.add", { program_id: p.program_id, starts_at: new Date(at).toISOString(), ends_at: new Date(at + 7200_000).toISOString(), court_ids: courts }, owner)).result as { session_id: string };
  await run(db, "program.publish", { program_id: p.program_id }, owner);
  const people: string[] = [];
  for (const [name, level] of names) { const id = await person(name, "member", level); people.push(id); await run(db, "enrolment.join", { program_id: p.program_id, person_id: id }, as(id)); }
  await run(db, "draw.generate", { session_id: s.session_id, rounds: 2 }, monica);
  const games = await db.selectFrom("game").select(["id", "round", "predicted_a"]).where("session_id", "=", s.session_id).orderBy("round").execute();
  return { people, games };
}
const rating = (id: string) => db.selectFrom("rating").selectAll().where("person_id", "=", id).executeTakeFirst();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  monica = as(await person("Monica", "manager"));
  desk = as(await person("Desk", "front_desk"));
  locationId = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string }).location_id;
});
after(async () => drop());

test("a rated game moves four levels, each with a sentence on why, in both languages", async () => {
  const t = await americano([["Ana", 3], ["Ben", 3], ["Cy", 3.5], ["Dee", 3.5], ["Eve", 2.5], ["Fay", 4], ["Gus", 3], ["Hal", 3]]);
  const g = t.games[0]!;
  await run(db, "game.score", { game_id: g.id, a: 16, b: 8 }, monica, await played(g.id));
  const events = await db.selectFrom("rating_event").selectAll().where("game_id", "=", g.id).execute();
  assert.equal(events.length, 4);
  const winner = events.find((e) => Number(e.level_after) > Number(e.level_before))!;
  assert.match((winner.explanation as any).en, /^Won 16 to 8 with \w+ against \w+ and \w+ \((an even game|you were (favored|the underdogs), \d+\/\d+)\)\. Level \d\.\d\d to \d\.\d\d\.$/);
  assert.match((winner.explanation as any).es, /^Ganaste 16 a 8 con /);
});

test("friendlies never move a level", async () => {
  const t = await americano([["Ivy", 3], ["Jo", 3], ["Kai", 3], ["Lu", 3]], false);
  const before = await rating(t.people[0]!);
  for (const g of t.games) await run(db, "game.score", { game_id: g.id, a: 20, b: 4 }, monica, await played(g.id));
  assert.equal((await rating(t.people[0]!))!.level, before!.level);
  assert.equal(await db.selectFrom("rating_event").select("id").where("game_id", "in", t.games.map((g) => g.id)).executeTakeFirst(), undefined);
});

test("fair teams use the levels: four players at 4, 4, 2, 2 are split evenly", async () => {
  const t = await americano([["Mo", 4], ["Ned", 4], ["Oz", 2], ["Pia", 2]]);
  for (const g of t.games) assert.ok(Math.abs(Number(g.predicted_a) - 0.5) < 0.01, String(g.predicted_a));
});

test("staff change a level with a reason; the front desk has to ask", async () => {
  const q = await person("Quinn", "member", 3);
  const p = await plan(db, "level.set", { person_id: q, level: 3.4, reason: "Assessment on court" }, desk);
  assert.equal(p.status, "awaiting_approval");
  assert.equal(p.plan.summary.en, "Change Quinn's level from 3.00 to 3.40: Assessment on court.");
  await run(db, "level.set", { person_id: q, level: 3.4, reason: "Assessment on court" }, monica);
  assert.equal((await rating(q))!.level, "3.40");
});

test("a coach's floor holds, however the results go", async () => {
  const t = await americano([["Ray", 3], ["Sol", 3], ["Tia", 3], ["Uma", 3]]);
  for (const id of t.people) await run(db, "level.set_floor", { person_id: id, floor: 2.95, reason: "Assessed in clinic" }, monica);
  for (const g of t.games) await run(db, "game.score", { game_id: g.id, a: 0, b: 24 }, monica, await played(g.id));
  for (const id of t.people) assert.ok(Number((await rating(id))!.level) >= 2.95);
});

test("replaying every event reproduces the ratings exactly, including after a corrected score", async () => {
  const t = await americano([["Vi", 3], ["Wes", 3.5], ["Xan", 2.5], ["Yu", 4], ["Zed", 3], ["Abe", 3], ["Bo", 3.5], ["Cal", 2.5]]);
  for (const g of t.games) await run(db, "game.score", { game_id: g.id, a: 15, b: 9 }, monica, await played(g.id));
  await run(db, "level.set", { person_id: t.people[0]!, level: 3.2, reason: "Coach review" }, monica);
  const check = async () => {
    const replayed = await replay(db);
    for (const r of await db.selectFrom("rating").selectAll().execute()) {
      const s = replayed.get(r.person_id);
      if (!s) continue;   // anyone only ever set by staff before replay began is covered by their own event
      assert.ok(Math.abs(s.mu - r.mu!) < 1e-9 && Math.abs(s.sigma - r.sigma!) < 1e-9, `mu/sigma for ${r.person_id}`);
      assert.equal(s.level.toFixed(2), r.level);
    }
  };
  await check();
  const before = (await rating(t.people[1]!))!.mu;
  await run(db, "game.score", { game_id: t.games[0]!.id, a: 4, b: 20 }, monica, await played(t.games[0]!.id));   // the score was entered the wrong way round
  await check();
  const sidesOfFirst = await db.selectFrom("game_side").select("person_id").where("game_id", "=", t.games[0]!.id).execute();
  if (sidesOfFirst.some((s) => s.person_id === t.people[1])) assert.notEqual((await rating(t.people[1]!))!.mu, before);
});
