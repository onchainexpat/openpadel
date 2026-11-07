// The review of tournaments, leagues and draw nights (5 Nov 2026): each finding it proved, held to its fix.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { competitionView, fixtureLocked, kotcNextRound, knockoutFromGroups, mexicanoRound, myCompetitions, plan, apply, run, runAsSystem, suggestTimes, table, uuidv7, KumiError, type Actor, type Db, type PlayedGame, type Player, type Side } from "../src/index.ts";

// ---- The pure rules ----
test("a group's winner and runner-up are in opposite halves, so they meet again only in the final (2 to 16 groups)", () => {
  for (let g = 2; g <= 16; g++) {
    const first = knockoutFromGroups(g).filter((s) => s.round === 1);
    const half = new Map<string, number>();
    first.forEach((m, k) => { for (const s of [m.a, m.b] as Side[]) if ("from" in s) half.set(s.from, k < first.length / 2 ? 0 : 1); });
    for (let i = 1; i <= g; i++) assert.notEqual(half.get(`g${i}:1`), half.get(`g${i}:2`), `${g} groups, group ${i}`);
    for (const m of first) if ("from" in m.a && "from" in m.b) assert.notEqual(m.a.from.split(":")[0], m.b.from.split(":")[0]);
    const places = first.flatMap((m) => [m.a, m.b]).filter((s): s is { from: string } => "from" in s).map((s) => s.from);
    assert.equal(new Set(places).size, 2 * g, "every group place once");
  }
});

test("suggested times keep clear of a match staff placed off the slots' grid", () => {
  const h = 45 * 60_000, slots = [0, 1, 2].map((k) => ({ court: "c1", start: k * h, end: (k + 1) * h, session: 0 }));
  const placed = [{ id: "m0", court: "c1", start: 20 * 60_000, end: 20 * 60_000 + h, entries: ["X", "Y"] }];
  const p = suggestTimes([{ id: "m1", entries: ["A", "B"], deps: [] }], slots, placed).placed[0]!;
  assert.ok(!(p.start < placed[0]!.end && placed[0]!.start < p.end));
});

test("a Mexicano sit-out goes to the bottom of the standings, not the leader", () => {
  const players: Player[] = ["a", "b", "c", "d", "e"].map((id) => ({ id, level: 3 }));
  const points = new Map([["a", 40], ["b", 30], ["c", 20], ["d", 10], ["e", 0]]);
  for (let k = 0; k < 20; k++) assert.deepEqual(mexicanoRound(players, ["c1"], points, new Map(), `s${k}`).sittingOut, ["e"]);
  const r1: Player[] = [5, 4, 3, 2, 1].map((level, i) => ({ id: `p${i}`, level }));
  assert.deepEqual(mexicanoRound(r1, ["c1"], null, new Map(), "x").sittingOut, ["p4"], "round 1: the lowest level");
});

test("King of the Court never keeps last round's partner, with players waiting or not", () => {
  for (const nCourts of [1, 2, 3]) for (const nWait of [0, 1, 2, 3, 4, 5, 6]) for (let seed = 0; seed < 60; seed++) {
    const ids = Array.from({ length: nCourts * 4 + nWait }, (_, i) => `p${i}`);
    const byId = new Map(ids.map((id, i) => [id, { id, level: 2 + (i % 5) * 0.7 }]));
    const courts = Array.from({ length: nCourts }, (_, i) => `c${i}`);
    const last: PlayedGame[] = courts.map((c, i) => ({ court: c, a: [ids[i * 4]!, ids[i * 4 + 1]!], b: [ids[i * 4 + 2]!, ids[i * 4 + 3]!], scoreA: (seed + i) % 2 ? 5 : 3, scoreB: (seed + i) % 2 ? 3 : 5 }));
    const sitouts = new Map(ids.map((id, i) => [id, (seed >> (i % 8)) & 1]));
    const r = kotcNextRound(byId, courts, last, ids.slice(nCourts * 4), sitouts, `s${seed}`);
    const partners = new Set(last.flatMap((g) => [[...g.a].sort().join("|"), [...g.b].sort().join("|")]));
    for (const g of r.games) for (const team of [g.a, g.b]) assert.ok(!partners.has([...team].sort().join("|")), `${nCourts} courts, ${nWait} waiting, seed ${seed}`);
    assert.equal(r.games.flatMap((g) => [...g.a, ...g.b]).length + r.sittingOut.length, ids.length);
  }
});

test("a match tiebreak counts as one game in the games difference", () => {
  const rows = table(["x", "y"], [{ a: "x", b: "y", winner: "x", sets: [{ a: 6, b: 4 }, { a: 4, b: 6 }, { a: 10, b: 0 }] }], "group");
  const x = rows.find((r) => r.entry === "x")!;
  assert.deepEqual([x.setsFor, x.setsAgainst, x.gamesFor, x.gamesAgainst], [2, 1, 11, 10]);
});

// ---- On a real database ----
let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, locationId: string;
const as = (personId: string): Actor => ({ personId, via: "test", lang: "en" });
let n = 0;
async function person(name: string, level?: number, junior = false) {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: junior ? null : `${name.toLowerCase()}${n++}@example.test`, created_via: "desk", junior }).execute();
  const r = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  if (level !== undefined) await db.insertInto("rating").values({ person_id: id, level: level.toFixed(2) }).execute();
  return id;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function competition(kind: "tournament" | "league", pairs: number, opts: { courts?: number; hours?: number } = {}) {
  const courts: string[] = [];
  for (let c = 1; c <= (opts.courts ?? 3); c++) courts.push(((await run(db, "court.create", { location_id: locationId, name: `R${n} Court ${c}` }, owner)).result as { court_id: string }).court_id);
  const p = (await run(db, "program.create", { location_id: locationId, kind, name: `${kind} ${n}`, capacity: pairs * 2 + 4, price_cents: 0 }, owner)).result as { program_id: string };
  const start = Date.now() + (5 + n) * 864e5;
  await run(db, "session.add", { program_id: p.program_id, starts_at: new Date(start).toISOString(), ends_at: new Date(start + (opts.hours ?? 12) * 3600_000).toISOString(), court_ids: courts }, owner);
  await run(db, "program.publish", { program_id: p.program_id }, owner);
  const people: string[][] = [];
  for (let k = 0; k < pairs; k++) {
    const a = await person(`A${n}p${k}`, 5 - k * 0.1), b = await person(`B${n}p${k}`, 5 - k * 0.1);
    for (const x of [a, b]) await run(db, "enrolment.join", { program_id: p.program_id, person_id: x }, as(x));
    people.push([a, b]);
  }
  return { programId: p.program_id, courts, people, start };
}
async function pairAll(t: { programId: string; people: string[][] }) {
  const ids: string[] = [];
  for (const [a, b] of t.people) ids.push(((await run(db, "entry.pair", { program_id: t.programId, person_a: a!, person_b: b! }, desk)).result as { entry_id: string }).entry_id);
  return ids;
}
const fixtures = (programId: string) => db.selectFrom("fixture").selectAll().where("program_id", "=", programId).where("status", "!=", "void").orderBy("stage").orderBy("group_no").orderBy("round").orderBy("slot").execute();
const later = (t: { start: number }) => ({ now: new Date(t.start + 30 * 864e5) });

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  const d = await person("Dana");
  const fr = await db.selectFrom("role").select("id").where("key", "=", "front_desk").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: d, role_id: fr.id, location_id: null }).execute();
  desk = as(d);
  locationId = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string }).location_id;
});
after(async () => drop());

test("a pair that withdraws mid-group never takes a knockout place", async () => {
  const t = await competition("tournament", 6);
  const ids = await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "groups_knockout", group_size: 3 }, desk);
  const X = ids[0]!;
  const mine = (await fixtures(t.programId)).filter((f) => f.stage === "group" && (f.entry_a === X || f.entry_b === X));
  const first = mine[0]!;
  await run(db, "fixture.score", { fixture_id: first.id, sets: first.entry_a === X ? [{ a: 6, b: 0 }] : [{ a: 0, b: 6 }] }, desk, later(t));
  await run(db, "entry.withdraw", { entry_id: X }, desk, later(t));
  for (const f of (await fixtures(t.programId)).filter((x) => x.stage === "group" && x.status === "ready")) await run(db, "fixture.score", { fixture_id: f.id, sets: [{ a: 6, b: 3 }] }, desk, later(t));
  const ko = (await fixtures(t.programId)).filter((f) => f.stage === "knockout");
  assert.ok(!ko.some((f) => f.entry_a === X || f.entry_b === X));
});

test("a semi-final's score can't be disputed once the final has a score entered", async () => {
  const t = await competition("tournament", 4);
  await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  await run(db, "competition.schedule", { program_id: t.programId }, desk);
  const semis = (await fixtures(t.programId)).filter((f) => f.round === 1);
  const at = { now: new Date(Math.max(...(await fixtures(t.programId)).map((f) => f.starts_at!.getTime())) + 3 * 3600_000) };
  const [p0] = t.people[0]!, [p3] = t.people[3]!;
  const semi = semis.find((f) => f.entry_a && (f.entry_a === (semis[0]!.entry_a)))!;
  const g = ((await run(db, "fixture.enter", { fixture_id: semi.id, person_id: p0!, sets: [{ us: 6, them: 2 }] }, as(p0!), at)).result as { game_id: string }).game_id;
  await run(db, "result.confirm", { game_id: g, person_id: p3! }, as(p3!), at);
  const other = semis.find((f) => f.id !== semi.id)!;
  await run(db, "fixture.score", { fixture_id: other.id, sets: [{ a: 6, b: 4 }] }, desk, at);
  const final = (await fixtures(t.programId)).find((f) => f.round === 2)!;
  const [w] = t.people[0]!;
  await run(db, "fixture.enter", { fixture_id: final.id, person_id: w!, sets: [{ us: 6, them: 1 }] }, as(w!), at);
  await rejects(plan(db, "result.dispute", { game_id: g, person_id: p3!, note: "That was 2-6" }, as(p3!), at), "error.next_match_played");
});

test("with byes from 5 groups, a group's results stand once its winner has played on past the bye", async () => {
  const t = await competition("tournament", 15, { courts: 4 });
  await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "groups_knockout", group_size: 3 }, desk);
  for (const f of (await fixtures(t.programId)).filter((x) => x.stage === "group")) await run(db, "fixture.score", { fixture_id: f.id, sets: [{ a: 6, b: 3 }] }, desk, later(t));
  let fs = await fixtures(t.programId);
  const bye = fs.find((f) => f.stage === "knockout" && f.round === 1 && f.status === "bye" && f.from_a?.startsWith("g"))!;
  const group = Number(bye.from_a!.slice(1).split(":")[0]);
  const groupMatch = fs.find((f) => f.stage === "group" && f.group_no === group)!;
  assert.equal(await fixtureLocked(db, groupMatch.id), false, "before round 2: still open");
  const r2 = fs.find((f) => f.id === bye.next_id)!;
  for (let guard = 0; guard < 5 && (await fixtures(t.programId)).find((f) => f.id === r2.id)!.status !== "ready"; guard++)
    for (const f of (await fixtures(t.programId)).filter((x) => x.stage === "knockout" && x.round === 1 && x.status === "ready")) await run(db, "fixture.score", { fixture_id: f.id, sets: [{ a: 6, b: 3 }] }, desk, later(t));
  await run(db, "fixture.score", { fixture_id: r2.id, sets: [{ a: 6, b: 2 }] }, desk, later(t));
  assert.equal(await fixtureLocked(db, groupMatch.id), true, "after its winner played on past the bye");
  fs = await fixtures(t.programId);
  assert.equal(fs.filter((f) => f.from_a === "bye" || f.from_b === "bye").filter((f) => f.starts_at).length, 0);
});

test("previews confirmed after the draw changed: a late pairing is refused, a draw after a withdrawal is refused", async () => {
  const t = await competition("tournament", 5);
  const ids = await pairAll(t.people.length ? { ...t, people: t.people.slice(0, 4) } : t);
  const [x, y] = t.people[4]!;
  const late = await plan(db, "entry.pair", { program_id: t.programId, person_a: x!, person_b: y! }, desk);
  const draw = await plan(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  await run(db, "entry.withdraw", { entry_id: ids[3]! }, desk);
  await rejects(apply(db, draw.runId, desk), "error.changed");
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  await rejects(apply(db, late.runId, desk), "error.competition_drawn");
  const fs = await fixtures(t.programId);
  assert.ok(!fs.some((f) => f.entry_a === ids[3] || f.entry_b === ids[3]));
});

test("juniors and the public page: no names until the club turns them on, juniors only to their own people", async () => {
  const t = await competition("league", 2);
  const kid = await person("Mia Larsen", 3, true), mum = await person("Ana Larsen", 3);
  const hh = uuidv7();
  await db.insertInto("household").values({ id: hh, created_by: mum }).execute();
  await db.insertInto("household_member").values([{ id: uuidv7(), household_id: hh, person_id: mum, role: "adult" }, { id: uuidv7(), household_id: hh, person_id: kid, role: "junior" }]).execute();
  const partner = t.people[0]![0]!;
  for (const x of [kid]) await db.insertInto("enrolment").values({ id: uuidv7(), program_id: t.programId, person_id: x, status: "booked" }).execute();
  await run(db, "entry.pair", { program_id: t.programId, person_a: partner, person_b: kid }, desk);
  await run(db, "entry.pair", { program_id: t.programId, person_a: t.people[1]![0]!, person_b: t.people[1]![1]! }, desk);
  await run(db, "competition.draw", { program_id: t.programId, format: "league" }, desk);
  const pub = await competitionView(db, t.programId, { public: { names: false, lang: "en" } });
  assert.ok(pub.fixtures.every((f) => /^Pair \d$/.test(f.a) && /^Pair \d$/.test(f.b)), "no names to start");
  const named = await competitionView(db, t.programId, { public: { names: true, lang: "en" } });
  assert.ok(named.fixtures.some((f) => f.a.includes("Junior player") || f.b.includes("Junior player")) && !JSON.stringify(named.fixtures).includes("Mia"));
  const other = t.people[1]![0]!;
  assert.ok(!JSON.stringify((await myCompetitions(db, other)).entries).includes("Mia"), "an opponent sees Junior player");
  assert.ok(JSON.stringify((await myCompetitions(db, partner)).entries).includes("Mia"), "her partner sees her name");
  assert.ok(JSON.stringify(await competitionView(db, t.programId, { viewer: mum })).includes("Mia"), "her family sees her name");
});

test("a staff correction is checked against the match format, and a move request's words stay with the club", async () => {
  const t = await competition("tournament", 2);
  await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  await run(db, "competition.schedule", { program_id: t.programId }, desk);
  const [f] = await fixtures(t.programId);
  const [p0] = t.people[0]!, [p1] = t.people[1]!;
  await run(db, "fixture.ask_move", { fixture_id: f!.id, person_id: p0!, note: "Away that weekend, any Sunday works" }, as(p0!));
  const theirs = (await myCompetitions(db, p1!)).entries[0]!.next[0]!;
  assert.equal(theirs.move_asked, "asked");
  const at = { now: new Date(f!.starts_at!.getTime() + 3 * 3600_000) };
  await run(db, "fixture.place", { fixture_id: f!.id, court_id: t.courts[1]!, starts_at: f!.starts_at!.toISOString() }, desk);
  const g = ((await run(db, "fixture.enter", { fixture_id: f!.id, person_id: p0!, sets: [{ us: 6, them: 3 }] }, as(p0!), at)).result as { game_id: string }).game_id;
  await run(db, "result.dispute", { game_id: g, person_id: p1!, note: "It was 3-6" }, as(p1!), at);
  await rejects(plan(db, "result.resolve", { game_id: g, outcome: "correct", sets: [{ a: 6, b: 5 }] }, desk, at), "error.bad_match_score");
});

test("re-pairing a half-scored Mexicano round keeps its scored game and the levels it moved", async () => {
  const courts: string[] = [];
  for (let c = 1; c <= 2; c++) courts.push(((await run(db, "court.create", { location_id: locationId, name: `M Court ${c}` }, owner)).result as { court_id: string }).court_id);
  const p = (await run(db, "program.create", { location_id: locationId, kind: "social", format: "mexicano", name: "Mex review", capacity: 9, price_cents: 0 }, owner)).result as { program_id: string };
  const startAt = Date.now() + 40 * 864e5;
  const s = (await run(db, "session.add", { program_id: p.program_id, starts_at: new Date(startAt).toISOString(), ends_at: new Date(startAt + 2 * 3600_000).toISOString(), court_ids: courts }, owner)).result as { session_id: string };
  await run(db, "program.publish", { program_id: p.program_id }, owner);
  const ps: string[] = [];
  for (let i = 0; i < 9; i++) { const x = await person(`Mx${i}`, 4 - i * 0.2); ps.push(x); await run(db, "enrolment.join", { program_id: p.program_id, person_id: x }, as(x)); }
  const at = { now: new Date(startAt + 3600_000) };
  await run(db, "draw.generate", { session_id: s.session_id, rounds: 3 }, desk);
  const r1 = await db.selectFrom("game").selectAll().where("session_id", "=", s.session_id).where("round", "=", 1).execute();
  for (const g of r1) await run(db, "game.score", { game_id: g.id, a: 14, b: 10 }, desk, at);
  await run(db, "draw.next_round", { session_id: s.session_id }, desk, at);
  const r2 = await db.selectFrom("game").selectAll().where("session_id", "=", s.session_id).where("round", "=", 2).where("status", "!=", "void").execute();
  await run(db, "game.score", { game_id: r2[0]!.id, a: 15, b: 9 }, desk, at);
  const inScored = new Set((await db.selectFrom("game_side").select("person_id").where("game_id", "=", r2[0]!.id).execute()).map((x) => x.person_id));
  const leaving = ps.find((x) => !inScored.has(x) && r2.length > 1)!;
  const en = await db.selectFrom("enrolment").select("id").where("person_id", "=", leaving).executeTakeFirstOrThrow();
  await run(db, "enrolment.remove", { enrolment_id: en.id, reason: "late_cancel" }, desk);
  await run(db, "draw.repair", { session_id: s.session_id }, desk, at);
  assert.equal((await db.selectFrom("game").select("status").where("id", "=", r2[0]!.id).executeTakeFirstOrThrow()).status, "confirmed", "the scored game stands");
  const now2 = await db.selectFrom("game").innerJoin("game_side", "game_side.game_id", "game.id").select("game_side.person_id").where("game.session_id", "=", s.session_id).where("game.round", "=", 2).where("game.status", "!=", "void").execute();
  assert.ok(!now2.some((x) => x.person_id === leaving));
});

// The 0.3.0 security review: game.score took any game, so it rewrote a tournament's decided result (levels replayed,
// the winner kept) and confirmed a score a player entered without the fixture deciding, stuck for good. It's for a
// draw night's games only; a competition's results change through fixture.* and result.*.
test("game.score refuses a tournament match's game: decided, or with a score a player entered", async () => {
  const t = await competition("tournament", 2);
  await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  await run(db, "competition.schedule", { program_id: t.programId }, desk);
  const final = (await fixtures(t.programId))[0]!;
  const at = { now: new Date(final.starts_at!.getTime() + 3 * 3600_000) };
  // (b) A player enters 6-2: the desk can't confirm it past the fixture.
  const [p0] = t.people[0]!, [p1] = t.people[1]!;
  const [enterer, other] = [p0!, p1!];
  const g = ((await run(db, "fixture.enter", { fixture_id: final.id, person_id: enterer, sets: [{ us: 6, them: 2 }] }, as(enterer), at)).result as { game_id: string }).game_id;
  await rejects(plan(db, "game.score", { game_id: g, a: 6, b: 2 }, desk, at), "error.score_not_a_night");
  await run(db, "result.confirm", { game_id: g, person_id: other }, as(other), at);
  assert.equal((await db.selectFrom("fixture").select("status").where("id", "=", final.id).executeTakeFirstOrThrow()).status, "played", "the fixture decides the usual way");
  // (a) Decided: neither the desk nor support access at manager level can rewrite it.
  const help = (await run(db, "support.grant", { email: "sue@help.test", name: "Sue", reason: "Looking at the draws", level: "manager", hours: 24 }, { ...owner, auth: "passkey" } as Actor)).result as { person_id: string };
  for (const who of [desk, as(help.person_id)]) await rejects(plan(db, "game.score", { game_id: g, a: 0, b: 6 }, who, at), "error.score_not_a_night");
  assert.deepEqual(await db.selectFrom("game_set").select(["a", "b"]).where("game_id", "=", g).execute(), [{ a: 6, b: 2 }]);
});
