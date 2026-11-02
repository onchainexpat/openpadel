import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { bestSplit, emptyHistory, levelPredict, plan, run, runAsSystem, schedule, standings, uuidv7, KumiError, type Actor, type Db, type Player, type Round } from "../src/index.ts";

const players = (n: number, level = (i: number) => 1 + (i % 7) * 0.5): Player[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, level: level(i) }));
const partnerPairs = (rounds: Round[]) => rounds.flatMap((r) => r.games.flatMap((g) => [g.a, g.b].map(([x, y]) => [x, y].sort().join("|"))));

test("8 players, 2 courts, 4 rounds: nobody repeats a partner and everyone plays every round", () => {
  const rounds = schedule(players(8), ["c1", "c2"], 4, "seed-a");
  const pairs = partnerPairs(rounds);
  assert.equal(new Set(pairs).size, pairs.length, "no partner twice");
  for (const r of rounds) { assert.equal(r.sittingOut.length, 0); assert.equal(new Set(r.games.flatMap((g) => [...g.a, ...g.b])).size, 8); }
});

test("10 players on 2 courts: two sit out each round, and over 5 rounds everyone sits out once", () => {
  const rounds = schedule(players(10), ["c1", "c2"], 5, "seed-b");
  const sat = rounds.flatMap((r) => r.sittingOut);
  assert.equal(sat.length, 10); assert.equal(new Set(sat).size, 10);
});

test("the fairest of the three splits is chosen", () => {
  const four: Player[] = [{ id: "a", level: 4 }, { id: "b", level: 4 }, { id: "c", level: 1 }, { id: "d", level: 1 }];
  const s = bestSplit(four, emptyHistory(), levelPredict);
  assert.equal(s.p, 0.5);
  assert.deepEqual([s.a.map((p) => p.level).sort(), s.b.map((p) => p.level).sort()], [[1, 4], [1, 4]]);
});

test("fair teams beat random pairing on a mixed-level night", () => {
  const ps = players(8, (i) => [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5][i]!);
  const fair = schedule(ps, ["c1", "c2"], 4, "seed-c").flatMap((r) => r.games.map((g) => Math.abs(g.predictedA - 0.5)));
  const lv = new Map(ps.map((p) => [p.id, p.level]));
  let randomTotal = 0, n = 0;
  for (let t = 0; t < 200; t++) {
    const order = [...ps].sort(() => Math.random() - 0.5);
    for (let c = 0; c < 2; c++) { const g = order.slice(c * 4, c * 4 + 4); randomTotal += Math.abs(levelPredict([g[0]!, g[1]!], [g[2]!, g[3]!]) - 0.5); n++; }
  }
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(avg(fair) < randomTotal / n / 2, `fair ${avg(fair).toFixed(3)} vs random ${(randomTotal / n).toFixed(3)}`);
  void lv;
});

test("the same seed always gives the same rounds", () => {
  assert.deepEqual(schedule(players(8), ["c1", "c2"], 3, "x"), schedule(players(8), ["c1", "c2"], 3, "x"));
});

// ---- The actions, on a real roster ----
let db: Db, drop: () => Promise<void>, owner: Actor, monica: Actor, locationId: string;
/** A time after the round's night has started: scores are only taken for rounds that have been played. */
const played = async (gameId: string) => ({ now: new Date((await db.selectFrom("game").innerJoin("session", "session.id", "game.session_id").select("session.starts_at").where("game.id", "=", gameId).executeTakeFirstOrThrow()).starts_at.getTime() + 3 * 3600_000) });
const as = (personId: string): Actor => ({ personId, via: "test", lang: "en" });
let n = 0;
async function person(name: string, level?: number) {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: `${name.toLowerCase()}${n++}@example.test`, created_via: "desk" }).execute();
  const r = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  if (level !== undefined) await db.insertInto("rating").values({ person_id: id, level: level.toFixed(2) }).execute();
  return id;
}
async function night(capacity: number, roster: number) {
  const courts: string[] = [];
  for (let c = 1; c <= 2; c++) courts.push(((await run(db, "court.create", { location_id: locationId, name: `Court ${c}` }, owner)).result as { court_id: string }).court_id);
  const p = (await run(db, "program.create", { location_id: locationId, kind: "social", format: "americano", name: `Americano ${n}`, capacity, price_cents: 0 }, owner)).result as { program_id: string };
  const s = (await run(db, "session.add", { program_id: p.program_id, starts_at: new Date(Date.now() + (3 + n) * 864e5).toISOString(), ends_at: new Date(Date.now() + (3 + n) * 864e5 + 2 * 3600_000).toISOString(), court_ids: courts }, owner)).result as { session_id: string };
  await run(db, "program.publish", { program_id: p.program_id }, owner);
  const ids: { person: string; enrolment: string }[] = [];
  for (let i = 0; i < roster; i++) {
    const pid = await person(`Player${i}`, 1 + (i % 6) * 0.5);
    ids.push({ person: pid, enrolment: ((await run(db, "enrolment.join", { program_id: p.program_id, person_id: pid }, as(pid))).result as { enrolment_id: string }).enrolment_id });
  }
  return { programId: p.program_id, sessionId: s.session_id, players: ids };
}
const games = (sessionId: string) => db.selectFrom("game").selectAll().where("session_id", "=", sessionId).where("status", "!=", "void").orderBy("round").execute();
const sidesOf = async (gameId: string) => (await db.selectFrom("game_side").select(["side", "person_id"]).where("game_id", "=", gameId).execute());
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  const m = await person("Monica");
  const mr = await db.selectFrom("role").select("id").where("key", "=", "manager").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: m, role_id: mr.id, location_id: null }).execute();
  monica = as(m);
  locationId = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string }).location_id;
});
after(async () => drop());

test("making the rounds: the preview is what gets written", async () => {
  const t = await night(8, 8);
  const p = await plan(db, "draw.generate", { session_id: t.sessionId, rounds: 4 }, monica);
  assert.match(p.plan.summary.en, /^4 rounds for 8 players on Court 1, Court 2\. Teams are \d+\/\d+ on average\.$/);
  await run(db, "draw.generate", { session_id: t.sessionId, rounds: 4 }, monica);
  const g = await games(t.sessionId);
  assert.equal(g.length, 8);
  await rejects(plan(db, "draw.generate", { session_id: t.sessionId, rounds: 4 }, monica), "error.draw_exists");
});

test("scores must add up to the night's points, then the standings follow", async () => {
  const t = await night(8, 8);
  await run(db, "draw.generate", { session_id: t.sessionId, rounds: 2, points_per_game: 24 }, monica);
  const [g1] = await games(t.sessionId);
  await rejects(plan(db, "game.score", { game_id: g1!.id, a: 15, b: 9 }, monica), "error.not_played_yet");   // days before the night: levels mustn't move yet
  await rejects(plan(db, "game.score", { game_id: g1!.id, a: 20, b: 6 }, monica, await played(g1!.id)), "error.score_total");
  await run(db, "game.score", { game_id: g1!.id, a: 15, b: 9 }, monica, await played(g1!.id));
  const table = await standings(db, t.sessionId);
  const winners = (await sidesOf(g1!.id)).filter((s) => s.side === "a").map((s) => s.person_id).sort();
  assert.deepEqual(table.slice(0, 2).map((r) => r.person_id).sort(), winners);
  assert.equal(table[0]!.points, 15);
});

test("Monica's Americano: a late drop after round 2, the rest re-paired, played rounds untouched", async () => {
  const t = await night(8, 9);   // 8 places, one on the waitlist
  await run(db, "draw.generate", { session_id: t.sessionId, rounds: 4 }, monica);
  const before = await games(t.sessionId);
  for (const g of before.filter((x) => x.round! <= 2)) await run(db, "game.score", { game_id: g.id, a: 13, b: 11 }, monica, await played(g.id));
  const dropped = t.players[0]!, waiting = t.players[8]!;
  await run(db, "enrolment.remove", { enrolment_id: dropped.enrolment, reason: "late_cancel" }, monica);
  await run(db, "enrolment.accept_offer", { enrolment_id: waiting.enrolment }, as(waiting.person));
  const rp = await plan(db, "draw.repair", { session_id: t.sessionId }, monica);
  assert.equal(rp.plan.summary.en, "Re-pair rounds 3 to 4 for the 8 players now on the roster. Rounds already played keep their scores.");
  await run(db, "draw.repair", { session_id: t.sessionId }, monica);
  const after = await games(t.sessionId);
  assert.deepEqual(after.filter((g) => g.round! <= 2).map((g) => g.id), before.filter((g) => g.round! <= 2).map((g) => g.id), "played rounds keep their games");
  const later = after.filter((g) => g.round! > 2);
  assert.equal(later.length, 4);
  const inLater = new Set((await Promise.all(later.map((g) => sidesOf(g.id)))).flat().map((s) => s.person_id));
  assert.ok(!inLater.has(dropped.person), "the dropped player is out of the later rounds");
  assert.ok(inLater.has(waiting.person), "the new player is in");
  const pairs: string[] = [];
  for (const g of after) { const s = await sidesOf(g.id); for (const side of ["a", "b"]) pairs.push(s.filter((x) => x.side === side).map((x) => x.person_id).sort().join("|")); }
  assert.equal(new Set(pairs).size, pairs.length, "nobody partners the same person twice across the night");
});

test("re-pairing when every round has been played is refused", async () => {
  const t = await night(4, 4);
  await run(db, "draw.generate", { session_id: t.sessionId, rounds: 1 }, monica);
  for (const g of await games(t.sessionId)) await run(db, "game.score", { game_id: g.id, a: 12, b: 12 }, monica, await played(g.id));
  await rejects(plan(db, "draw.repair", { session_id: t.sessionId }, monica), "error.nothing_to_repair");
});

test("creating an Americano: the preview says it's an Americano", async () => {
  const p = await plan(db, "program.create", { location_id: locationId, kind: "social", format: "americano", name: "Friday night", capacity: 8, price_cents: 1500 }, owner);
  assert.equal(p.plan.summary.en, "Create Friday night (social, Americano), 8 places at $15.00.");
  assert.equal(p.plan.summary.es, "Crear Friday night (social, Americano), con cupo para 8, a $15.00.");
});
