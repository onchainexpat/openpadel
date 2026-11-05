// Mexicano and King of the Court nights: the pure pairing rules, then the actions on a real roster.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { kotcNextRound, mexicanoRound, plan, run, runAsSystem, standings, uuidv7, KumiError, type Actor, type Db, type Player } from "../src/index.ts";

const ps = (n: number, level = (i: number) => 4 - i * 0.25): Player[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, level: level(i) }));

test("Mexicano round 1 by level: the best four on the top court, 1st and 4th against 2nd and 3rd", () => {
  const r = mexicanoRound(ps(8), ["c1", "c2"], null, new Map(), "s");
  assert.deepEqual(r.games[0]!.a, ["p0", "p3"]); assert.deepEqual(r.games[0]!.b, ["p1", "p2"]);
  assert.deepEqual(r.games[1]!.a, ["p4", "p7"]); assert.deepEqual(r.games[1]!.b, ["p5", "p6"]);
  assert.equal(r.sittingOut.length, 0);
});

test("Mexicano later rounds follow the standings, and sit-outs go round", () => {
  const points = new Map([["p7", 40], ["p6", 38], ["p5", 30], ["p4", 29], ["p3", 20], ["p2", 18], ["p1", 10], ["p0", 5]]);
  const r = mexicanoRound(ps(8), ["c1", "c2"], points, new Map(), "s");
  assert.deepEqual([...r.games[0]!.a, ...r.games[0]!.b].sort(), ["p4", "p5", "p6", "p7"], "the top four of the standings on the top court");
  assert.deepEqual(r.games[0]!.a, ["p7", "p4"]);
  const sat = new Map<string, number>(), ten = ps(10);
  for (let k = 0; k < 5; k++) { const x = mexicanoRound(ten, ["c1", "c2"], points, sat, `s${k}`); for (const id of x.sittingOut) sat.set(id, (sat.get(id) ?? 0) + 1); }
  assert.deepEqual([...sat.values()].sort(), Array(10).fill(1), "10 players, 2 courts, 5 rounds: everyone sits out once");
});

test("Mexicano with no levels: a random first round, the same for the same seed", () => {
  const flat = ps(8, () => 2.5);
  assert.deepEqual(mexicanoRound(flat, ["c1", "c2"], null, new Map(), "x"), mexicanoRound(flat, ["c1", "c2"], null, new Map(), "x"));
  assert.notDeepEqual(mexicanoRound(flat, ["c1", "c2"], null, new Map(), "x"), mexicanoRound(flat, ["c1", "c2"], null, new Map(), "y"));
});

test("King of the Court: winners up, losers down, the top court's winners stay, and nobody keeps a partner", () => {
  const byId = new Map(ps(12).map((p) => [p.id, p]));
  const last = [
    { court: "c1", a: ["p0", "p1"] as [string, string], b: ["p2", "p3"] as [string, string], scoreA: 7, scoreB: 4 },
    { court: "c2", a: ["p4", "p5"] as [string, string], b: ["p6", "p7"] as [string, string], scoreA: 3, scoreB: 6 },
    { court: "c3", a: ["p8", "p9"] as [string, string], b: ["p10", "p11"] as [string, string], scoreA: 5, scoreB: 2 },
  ];
  const r = kotcNextRound(byId, ["c1", "c2", "c3"], last, [], new Map(), "s");
  const on = (c: number) => [...r.games[c]!.a, ...r.games[c]!.b].sort();
  assert.deepEqual(on(0), ["p0", "p1", "p6", "p7"].sort(), "top: its winners stay, court 2's winners come up");
  assert.deepEqual(on(1), ["p2", "p3", "p8", "p9"].sort(), "middle: the top court's losers, court 3's winners");
  assert.deepEqual(on(2), ["p10", "p11", "p4", "p5"].sort(), "bottom: its losers stay, court 2's losers come down");
  const partners = (r.games.flatMap((g) => [g.a, g.b]).map((x) => [...x].sort().join("|")));
  for (const old of ["p0|p1", "p6|p7", "p2|p3", "p8|p9", "p10|p11", "p4|p5"]) assert.ok(!partners.includes(old), `${old} split`);
});

test("King of the Court with players waiting: they come in on the bottom court, its losers wait", () => {
  const byId = new Map(ps(10).map((p) => [p.id, p]));
  const last = [
    { court: "c1", a: ["p0", "p1"] as [string, string], b: ["p2", "p3"] as [string, string], scoreA: 7, scoreB: 4 },
    { court: "c2", a: ["p4", "p5"] as [string, string], b: ["p6", "p7"] as [string, string], scoreA: 3, scoreB: 6 },
  ];
  const r = kotcNextRound(byId, ["c1", "c2"], last, ["p8", "p9"], new Map([["p8", 1], ["p9", 1]]), "s");
  assert.deepEqual(r.sittingOut.sort(), ["p4", "p5"], "the bottom court's losers wait");
  assert.deepEqual([...r.games[1]!.a, ...r.games[1]!.b].sort(), ["p2", "p3", "p8", "p9"]);
});

// ---- The actions, on a real roster ----
let db: Db, drop: () => Promise<void>, owner: Actor, monica: Actor, locationId: string;
const as = (personId: string): Actor => ({ personId, via: "test", lang: "en" });
const played = async (gameId: string) => ({ now: new Date((await db.selectFrom("game").innerJoin("session", "session.id", "game.session_id").select("session.starts_at").where("game.id", "=", gameId).executeTakeFirstOrThrow()).starts_at.getTime() + 3 * 3600_000) });
let n = 0;
async function person(name: string, level?: number) {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: `${name.toLowerCase()}${n++}@example.test`, created_via: "desk" }).execute();
  const r = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  if (level !== undefined) await db.insertInto("rating").values({ person_id: id, level: level.toFixed(2) }).execute();
  return id;
}
async function night(format: "mexicano" | "king_of_court", roster: number, courts = 2) {
  const ids: string[] = [];
  for (let c = 1; c <= courts; c++) ids.push(((await run(db, "court.create", { location_id: locationId, name: `Court ${n}-${c}` }, owner)).result as { court_id: string }).court_id);
  const p = (await run(db, "program.create", { location_id: locationId, kind: "social", format, name: `${format} ${n}`, capacity: roster, price_cents: 0 }, owner)).result as { program_id: string };
  const s = (await run(db, "session.add", { program_id: p.program_id, starts_at: new Date(Date.now() + (3 + n) * 864e5).toISOString(), ends_at: new Date(Date.now() + (3 + n) * 864e5 + 2 * 3600_000).toISOString(), court_ids: ids }, owner)).result as { session_id: string };
  await run(db, "program.publish", { program_id: p.program_id }, owner);
  const players: string[] = [];
  for (let i = 0; i < roster; i++) { const pid = await person(`P${n}x${i}`, 4 - i * 0.25); players.push(pid); await run(db, "enrolment.join", { program_id: p.program_id, person_id: pid }, as(pid)); }
  return { sessionId: s.session_id, players, courts: ids };
}
const games = (sessionId: string, round?: number) => { let q = db.selectFrom("game").selectAll().where("session_id", "=", sessionId).where("status", "!=", "void"); if (round) q = q.where("round", "=", round); return q.orderBy("round").execute(); };
const sides = (gameId: string) => db.selectFrom("game_side").select(["side", "person_id"]).where("game_id", "=", gameId).execute();
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

test("a Mexicano night: round 1 by level, the next round waits for the scores, then follows the standings", async () => {
  const t = await night("mexicano", 8);
  await rejects(plan(db, "draw.generate", { session_id: t.sessionId, rounds: 3, points_per_game: 20 }, monica), "error.mexicano_points");
  const p = await plan(db, "draw.generate", { session_id: t.sessionId, rounds: 3, points_per_game: 21 }, monica);
  assert.match(p.plan.summary.en, /^Mexicano, 3 rounds for 8 players on Court \d+-1, Court \d+-2\. Games to 21 points;.* Round 1: Court/);
  await run(db, "draw.generate", { session_id: t.sessionId, rounds: 3, points_per_game: 21 }, monica);
  const r1 = await games(t.sessionId, 1);
  assert.equal(r1.length, 2);
  assert.equal((await games(t.sessionId)).length, 2, "only round 1 so far");
  await rejects(plan(db, "draw.next_round", { session_id: t.sessionId }, monica), "error.round_not_scored");
  await rejects(plan(db, "game.score", { game_id: r1[0]!.id, a: 12, b: 12 }, monica, await played(r1[0]!.id)), "error.score_total");
  // The bottom court's winners do best this round.
  await run(db, "game.score", { game_id: r1[0]!.id, a: 11, b: 10 }, monica, await played(r1[0]!.id));
  await run(db, "game.score", { game_id: r1[1]!.id, a: 18, b: 3 }, monica, await played(r1[1]!.id));
  const winners = (await sides(r1[1]!.id)).filter((s) => s.side === "a").map((s) => s.person_id);
  await run(db, "draw.next_round", { session_id: t.sessionId }, monica, await played(r1[1]!.id));
  const r2 = await games(t.sessionId, 2);
  assert.equal(r2.length, 2);
  const top = await sides(r2.find((g) => g.court_id === t.courts[0])!.id);
  for (const w of winners) assert.ok(top.some((s) => s.person_id === w), "the night's leaders move to the top court");
  const table = await standings(db, t.sessionId);
  assert.deepEqual(table.slice(0, 2).map((s) => s.person_id).sort(), winners.sort());
  assert.equal(table[0]!.points, 18);
});

test("a Mexicano round sat out counts half a game's points", async () => {
  const t = await night("mexicano", 5, 1);
  await run(db, "draw.generate", { session_id: t.sessionId, rounds: 2, points_per_game: 24 }, monica);
  const [g] = await games(t.sessionId, 1);
  const d = await db.selectFrom("draw").select("sat_out").where("session_id", "=", t.sessionId).executeTakeFirstOrThrow();
  const out = (d.sat_out as Record<string, string[]>)["1"]!;
  assert.equal(out.length, 1);
  await run(db, "game.score", { game_id: g!.id, a: 13, b: 11 }, monica, await played(g!.id));
  const table = await standings(db, t.sessionId);
  assert.equal(table.find((s) => s.person_id === out[0])!.points, 12);
});

test("a King of the Court night: timed rounds need a winner, winners move up, and a late drop re-seeds the round", async () => {
  const t = await night("king_of_court", 8);
  const p = await plan(db, "draw.generate", { session_id: t.sessionId, rounds: 4, round_minutes: 10 }, monica);
  assert.match(p.plan.summary.en, /Rounds of 10 minutes; winners move up a court/);
  await run(db, "draw.generate", { session_id: t.sessionId, rounds: 4, round_minutes: 10 }, monica);
  const draw = await db.selectFrom("draw").selectAll().where("session_id", "=", t.sessionId).executeTakeFirstOrThrow();
  assert.equal(draw.format, "king_of_court"); assert.equal(draw.round_minutes, 10);
  const r1 = await games(t.sessionId, 1);
  await rejects(plan(db, "game.score", { game_id: r1[0]!.id, a: 5, b: 5 }, monica, await played(r1[0]!.id)), "error.score_needs_winner");
  const top = r1.find((g) => g.court_id === t.courts[0])!, bottom = r1.find((g) => g.court_id === t.courts[1])!;
  await run(db, "game.score", { game_id: top.id, a: 6, b: 3 }, monica, await played(top.id));
  await run(db, "game.score", { game_id: bottom.id, a: 2, b: 5 }, monica, await played(bottom.id));
  await run(db, "draw.next_round", { session_id: t.sessionId }, monica, await played(top.id));
  const r2 = await games(t.sessionId, 2);
  const onTop = (await sides(r2.find((g) => g.court_id === t.courts[0])!.id)).map((s) => s.person_id).sort();
  const expected = [...(await sides(top.id)).filter((s) => s.side === "a"), ...(await sides(bottom.id)).filter((s) => s.side === "b")].map((s) => s.person_id).sort();
  assert.deepEqual(onTop, expected, "the top court's winners stay and the bottom court's winners come up");
  const table = await standings(db, t.sessionId);
  assert.equal(table[0]!.top, 1);
  assert.equal(table[0]!.points, 6);
  // A late drop before round 2 is played: the round is made again for who's there.
  await run(db, "enrolment.remove", { enrolment_id: (await db.selectFrom("enrolment").select("id").where("person_id", "=", t.players[7]!).executeTakeFirstOrThrow()).id, reason: "late_cancel" }, monica);
  const extra = await person("Latecomer", 2);
  await db.insertInto("enrolment").values({ id: uuidv7(), program_id: (await db.selectFrom("session").select("program_id").where("id", "=", t.sessionId).executeTakeFirstOrThrow()).program_id, person_id: extra, status: "booked" }).execute();
  const rp = await plan(db, "draw.repair", { session_id: t.sessionId }, monica, await played(top.id));
  assert.match(rp.plan.summary.en, /^Make round 2 again for the 8 players now on the roster: /);
  await run(db, "draw.repair", { session_id: t.sessionId }, monica, await played(top.id));
  const again = await games(t.sessionId, 2);
  const inIt = new Set((await Promise.all(again.map((g) => sides(g.id)))).flat().map((s) => s.person_id));
  assert.ok(!inIt.has(t.players[7]!) && inIt.has(extra));
  assert.equal((await games(t.sessionId, 1)).length, 2, "round 1 keeps its games");
});

test("an Americano still makes all its rounds at once and has no next round", async () => {
  const t = await night("mexicano", 4, 1);
  await db.updateTable("program").set({ format: "americano" }).where("id", "=", (await db.selectFrom("session").select("program_id").where("id", "=", t.sessionId).executeTakeFirstOrThrow()).program_id).execute();
  await run(db, "draw.generate", { session_id: t.sessionId, rounds: 3 }, monica);
  assert.equal((await games(t.sessionId)).length, 3);
  await rejects(plan(db, "draw.next_round", { session_id: t.sessionId }, monica), "error.americano_all_rounds");
});
