// Tournaments and leagues: the pure rules (brackets.ts), then entering, the draw, courts and times, scores,
// walkovers and withdrawals on a real database (competitions.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { competitionView, groups, knockout, knockoutFromGroups, matchWinner, myCompetitions, plan, roundRobin, run, runAsSystem, seedOrder, suggestTimes, table, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

test("seeding keeps the top seeds apart, and byes go to them", () => {
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const ko = knockout(["s1", "s2", "s3", "s4", "s5", "s6"].map((entry) => ({ entry })));
  const first = ko.filter((s) => s.round === 1);
  assert.equal(first.length, 4);
  assert.deepEqual(first[0]!.a, { entry: "s1" }); assert.deepEqual(first[0]!.b, { bye: true });
  assert.ok(first.some((s) => "entry" in s.a && s.a.entry === "s2" && "bye" in s.b), "seed 2 has a bye too");
  assert.equal(ko.filter((s) => s.round === 3).length, 1, "a final");
});

test("groups go snake-wise and are never smaller than 3", () => {
  const e = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, level: 5 - i * 0.1 }));
  assert.deepEqual(groups(e(8), 4).map((g) => g.map((x) => x.id)), [["s1", "s4", "s5", "s8"], ["s2", "s3", "s6", "s7"]]);
  assert.deepEqual(groups(e(10), 4).map((g) => g.length).sort(), [3, 3, 4]);
  assert.deepEqual(groups(e(5), 4).map((g) => g.length), [5], "5 pairs: one group, rather than one of 2");
});

test("a knockout from groups: winners meet runners-up of other groups first", () => {
  for (const n of [2, 3, 4]) {
    const first = knockoutFromGroups(n).filter((s) => s.round === 1);
    for (const m of first) {
      const g = (x: unknown) => (x && typeof x === "object" && "from" in x ? String((x as { from: string }).from).split(":")[0] : null);
      if (g(m.a) && g(m.b)) assert.notEqual(g(m.a), g(m.b), `${n} groups: ${JSON.stringify(m)}`);
    }
  }
});

test("a round robin: everyone once (or twice), nobody twice in a round", () => {
  const rr = roundRobin(["a", "b", "c", "d", "e"]);
  assert.equal(rr.length, 10);
  assert.equal(new Set(rr.map((m) => [m.a, m.b].sort().join())).size, 10);
  for (const r of new Set(rr.map((m) => m.round))) { const ps = rr.filter((m) => m.round === r).flatMap((m) => [m.a, m.b]); assert.equal(new Set(ps).size, ps.length); }
  assert.equal(roundRobin(["a", "b", "c", "d"], 2).length, 12);
});

test("finished scores, by match format", () => {
  assert.equal(matchWinner("one_set", [{ a: 6, b: 4 }]), "a");
  assert.equal(matchWinner("one_set", [{ a: 6, b: 5 }]), null);
  assert.equal(matchWinner("one_set", [{ a: 6, b: 7 }]), "b");
  assert.equal(matchWinner("pro_set", [{ a: 9, b: 8 }]), "a");
  assert.equal(matchWinner("pro_set", [{ a: 8, b: 6 }]), null);
  assert.equal(matchWinner("best_of_three", [{ a: 6, b: 3 }, { a: 6, b: 4 }]), "a");
  assert.equal(matchWinner("best_of_three", [{ a: 6, b: 3 }, { a: 4, b: 6 }]), null, "a set each: not finished");
  assert.equal(matchWinner("best_of_three", [{ a: 6, b: 3 }, { a: 4, b: 6 }, { a: 8, b: 10 }]), "b");
  assert.equal(matchWinner("best_of_three", [{ a: 6, b: 3 }, { a: 4, b: 6 }, { a: 12, b: 10 }]), "a");
  assert.equal(matchWinner("best_of_three", [{ a: 6, b: 3 }, { a: 6, b: 2 }, { a: 10, b: 2 }]), null, "no third set once it's won");
});

test("tables: league points 2/1/0, then sets, games and the match between them", () => {
  const rows = table(["x", "y", "z"], [
    { a: "x", b: "y", winner: "x", sets: [{ a: 6, b: 4 }] },
    { a: "y", b: "z", winner: "y", sets: [{ a: 6, b: 0 }] },
    { a: "z", b: "x", winner: "z", walkover: "x", sets: [] },
  ], "league");
  // x: a win (2) and a walkover given (0); y and z: a win and a loss played (3 each), y ahead on sets.
  assert.deepEqual(rows.map((r) => [r.entry, r.points]), [["y", 3], ["z", 3], ["x", 2]]);
  const h2h = table(["p", "q", "r"], [{ a: "p", b: "q", winner: "q", sets: [{ a: 4, b: 6 }] }, { a: "q", b: "r", winner: "r", sets: [{ a: 4, b: 6 }] }, { a: "r", b: "p", winner: "p", sets: [{ a: 4, b: 6 }] }], "group");
  assert.equal(h2h.length, 3, "a three-way tie still orders everyone");
});

test("suggested times: earliest free slot, no court twice, a pair never on two courts, after what they wait for", () => {
  const h = 3600_000, slots = [0, 1].flatMap((k) => ["c1", "c2"].map((court) => ({ court, start: k * h, end: (k + 1) * h, session: 0 })));
  const r = suggestTimes([{ id: "m1", entries: ["A", "B"], deps: [] }, { id: "m2", entries: ["A", "C"], deps: [] }, { id: "m3", entries: ["D", "E"], deps: [] }, { id: "f", entries: [], deps: ["m1", "m2"] }], slots, []);
  const at = new Map(r.placed.map((p) => [p.id, p]));
  assert.equal(at.get("m1")!.start, 0); assert.equal(at.get("m2")!.start, h, "A can't play both at once");
  assert.equal(at.get("m3")!.start, 0);
  assert.deepEqual(r.unplaced, ["f"], "the final waits for both, and there's no slot after them");
}
);

// ---- On a real database ----
let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, locationId: string;
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
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function competition(kind: "tournament" | "league", pairs: number, opts: { days?: number; hours?: number; courts?: number } = {}) {
  const courts: string[] = [];
  for (let c = 1; c <= (opts.courts ?? 2); c++) courts.push(((await run(db, "court.create", { location_id: locationId, name: `T${n} Court ${c}` }, owner)).result as { court_id: string }).court_id);
  const p = (await run(db, "program.create", { location_id: locationId, kind, name: `${kind} ${n}`, capacity: pairs * 2 + 4, price_cents: 0 }, owner)).result as { program_id: string };
  const start = Date.now() + (5 + n) * 864e5;
  for (let d = 0; d < (opts.days ?? 1); d++)
    await run(db, "session.add", { program_id: p.program_id, starts_at: new Date(start + d * 7 * 864e5).toISOString(), ends_at: new Date(start + d * 7 * 864e5 + (opts.hours ?? 6) * 3600_000).toISOString(), court_ids: courts }, owner);
  await run(db, "program.publish", { program_id: p.program_id }, owner);
  const people: string[][] = [];
  for (let k = 0; k < pairs; k++) {
    const a = await person(`A${n}p${k}`, 5 - k * 0.3), b = await person(`B${n}p${k}`, 5 - k * 0.3);
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
/** Staff score every ready match (side a wins), until nothing is ready. */
async function playAll(t: { programId: string; start: number }, stage?: string) {
  for (let guard = 0; guard < 50; guard++) {
    const ready = (await fixtures(t.programId)).filter((f) => f.status === "ready" && (!stage || f.stage === stage));
    if (!ready.length) return;
    for (const f of ready) await run(db, "fixture.score", { fixture_id: f.id, sets: [{ a: 6, b: 3 }] }, desk, later(t));
  }
}

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

test("entering with a partner: both need places, they must be friends, and the partner accepts", async () => {
  const t = await competition("tournament", 1);
  const [a, b] = t.people[0]!;
  const stranger = await person("Stranger", 3);
  await rejects(plan(db, "entry.invite", { program_id: t.programId, person_id: stranger, partner_id: a! }, as(stranger)), "error.need_place_first");
  await rejects(plan(db, "entry.invite", { program_id: t.programId, person_id: a!, partner_id: b! }, as(a!)), "error.partner_not_friend");
  await db.insertInto("friend").values([{ id: uuidv7(), person_id: a!, friend_id: b! }, { id: uuidv7(), person_id: b!, friend_id: a! }]).execute();
  const p = await plan(db, "entry.invite", { program_id: t.programId, person_id: a!, partner_id: b! }, as(a!));
  assert.match(p.plan.summary.en, /accepts from their app/);
  const id = ((await run(db, "entry.invite", { program_id: t.programId, person_id: a!, partner_id: b! }, as(a!))).result as { entry_id: string }).entry_id;
  await rejects(plan(db, "entry.accept", { entry_id: id, person_id: a! }, as(a!)), "error.not_your_invite");
  await assert.rejects(plan(db, "entry.accept", { entry_id: id, person_id: b! }, as(stranger)));
  const mine = await myCompetitions(db, b!);
  assert.equal(mine.entries[0]!.invited_me, true);
  assert.deepEqual((await myCompetitions(db, stranger)).can_enter, []);
  await run(db, "entry.accept", { entry_id: id, person_id: b! }, as(b!));
  assert.equal((await db.selectFrom("pair_entry").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status, "entered");
  const msgs = await db.selectFrom("event_outbox").select("topic").where("topic", "in", ["entry.invited", "entry.accepted"]).execute();
  assert.equal(msgs.length, 2);
});

test("a knockout of 3 pairs: the top seed has a bye, staff scores move winners on, the final ends it", async () => {
  const t = await competition("tournament", 3);
  const ids = await pairAll(t);
  await rejects(plan(db, "competition.draw", { program_id: t.programId, format: "league" }, desk), "error.wrong_competition_format");
  const p = await plan(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  assert.match(p.plan.summary.en, /3 pairs, a knockout .*one set to 6, a tiebreak at 6-6; 2 to play\. Seeds: 1\. /);
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  await rejects(plan(db, "entry.pair", { program_id: t.programId, person_a: t.people[0]![0]!, person_b: t.people[1]![0]! }, desk), "error.competition_drawn");
  let fs = await fixtures(t.programId);
  const bye = fs.find((f) => f.round === 1 && f.status === "bye")!;
  assert.equal(bye.winner, ids[0], "the top seed (best level) goes through");
  const final = fs.find((f) => f.round === 2)!;
  assert.equal(final.entry_a, ids[0]); assert.equal(final.status, "waiting");
  const semi = fs.find((f) => f.round === 1 && f.status === "ready")!;
  await rejects(plan(db, "fixture.score", { fixture_id: semi.id, sets: [{ a: 6, b: 5 }] }, desk, later(t)), "error.bad_match_score");
  // Its preview ends in a sentence of its own (phone check 5 read "...for 24 hours. it counts for levels").
  const sp = await plan(db, "fixture.score", { fixture_id: semi.id, sets: [{ a: 7, b: 6 }] }, desk, later(t));
  assert.match(sp.plan.summary.en, /\. (It counts for levels|It's a friendly, so levels don't move)\.$/);
  assert.match(sp.plan.summary.es, /\. (Cuenta para los niveles|Es un amistoso, así que los niveles no cambian)\.$/);
  await run(db, "fixture.score", { fixture_id: semi.id, sets: [{ a: 7, b: 6 }] }, desk, later(t));
  fs = await fixtures(t.programId);
  assert.equal(fs.find((f) => f.id === final.id)!.status, "ready");
  assert.equal(fs.find((f) => f.id === final.id)!.entry_b, semi.entry_a);
  await run(db, "fixture.score", { fixture_id: final.id, sets: [{ a: 3, b: 6 }] }, desk, later(t));
  assert.equal((await db.selectFrom("competition").select("status").where("program_id", "=", t.programId).executeTakeFirstOrThrow()).status, "finished");
  const v = await competitionView(db, t.programId);
  assert.equal(v.fixtures.find((f) => f.id === final.id)!.score, "3-6");
});

test("groups then a knockout: each group's top two fill the knockout once the group is played", async () => {
  const t = await competition("tournament", 6);
  await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "groups_knockout", group_size: 3 }, desk);
  let fs = await fixtures(t.programId);
  assert.equal(fs.filter((f) => f.stage === "group").length, 6, "two groups of 3: 3 matches each");
  const ko = fs.filter((f) => f.stage === "knockout");
  assert.equal(ko.filter((f) => f.round === 1).length, 2); assert.ok(ko.every((f) => f.status === "waiting"));
  await playAll(t, "group");
  fs = await fixtures(t.programId);
  const semis = fs.filter((f) => f.stage === "knockout" && f.round === 1);
  assert.ok(semis.every((f) => f.status === "ready" && f.entry_a && f.entry_b), "the semi-finals have their pairs");
  const groupOf = new Map((await db.selectFrom("pair_entry").select(["id", "group_no"]).where("program_id", "=", t.programId).execute()).map((e) => [e.id, e.group_no]));
  for (const s of semis) assert.notEqual(groupOf.get(s.entry_a!), groupOf.get(s.entry_b!), "a winner meets the other group's runner-up");
  // Once a semi-final is played, the groups' results stand.
  await run(db, "fixture.score", { fixture_id: semis[0]!.id, sets: [{ a: 6, b: 1 }] }, desk, later(t));
  const v = await competitionView(db, t.programId);
  assert.equal(v.tables.length, 2);
  assert.equal(v.tables[0]!.rows.length, 3);
});

test("players enter their own score; the other pair confirms and the winner moves on, or disputes and it's taken back", async () => {
  const t = await competition("tournament", 4);
  const ids = await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout", match_format: "best_of_three" }, desk);
  await run(db, "competition.schedule", { program_id: t.programId }, desk);
  let fs = await fixtures(t.programId);
  const semi = fs.find((f) => f.round === 1 && f.entry_a === ids[0])!;
  assert.ok(semi.starts_at && semi.court_id, "placed on a court and time");
  const [me] = t.people[0]!, [them] = t.people[3]!;
  await rejects(plan(db, "fixture.enter", { fixture_id: semi.id, person_id: me!, sets: [{ us: 6, them: 3 }, { us: 6, them: 4 }] }, as(me!)), "error.not_played_yet");
  const after = { now: new Date(semi.starts_at!.getTime() + 2 * 3600_000) };
  await rejects(plan(db, "fixture.enter", { fixture_id: semi.id, person_id: me!, sets: [{ us: 6, them: 3 }, { us: 4, them: 6 }] }, as(me!), after), "error.bad_match_score");
  const ep = await plan(db, "fixture.enter", { fixture_id: semi.id, person_id: me!, sets: [{ us: 6, them: 3 }, { us: 4, them: 6 }, { us: 10, them: 7 }] }, as(me!), after);
  assert.match(ep.plan.summary.en, /: you won 6-3 4-6 10-7\. .*\. (It counts for levels|It's a friendly, so levels don't move)\.$/);
  assert.match(ep.plan.summary.es, /: ustedes ganaron 6-3 4-6 10-7\. .*\. (Cuenta para los niveles|Es un amistoso, así que los niveles no cambian)\.$/, "says who won");
  const g = ((await run(db, "fixture.enter", { fixture_id: semi.id, person_id: me!, sets: [{ us: 6, them: 3 }, { us: 4, them: 6 }, { us: 10, them: 7 }] }, as(me!), after)).result as { game_id: string }).game_id;
  assert.equal((await db.selectFrom("game").select("status").where("id", "=", g).executeTakeFirstOrThrow()).status, "awaiting_confirmation");
  assert.equal((await myCompetitions(db, them!)).entries[0]!.to_confirm[0], g, "the other pair has it to confirm");
  await run(db, "result.confirm", { game_id: g, person_id: them! }, as(them!), after);
  fs = await fixtures(t.programId);
  const final = fs.find((f) => f.round === 2)!;
  assert.ok(final.entry_a === ids[0] || final.entry_b === ids[0], "the winner is in the final");
  await run(db, "result.dispute", { game_id: g, person_id: them!, note: "It was 7-10 in the tiebreak" }, as(them!), after);
  const back = (await fixtures(t.programId)).find((f) => f.id === final.id)!;
  assert.ok(back.entry_a !== ids[0] && back.entry_b !== ids[0], "taken back out of the final while the club decides");
  await run(db, "result.resolve", { game_id: g, outcome: "keep" }, desk, after);
  const again = (await fixtures(t.programId)).find((f) => f.id === final.id)!;
  assert.ok(again.entry_a === ids[0] || again.entry_b === ids[0]);
});

test("courts and times: only the program's own, never two matches on one court, a pair never twice at once", async () => {
  const t = await competition("tournament", 4, { hours: 1, courts: 1 });
  const ids = await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  const p = await plan(db, "competition.schedule", { program_id: t.programId }, desk);
  assert.match(p.plan.summary.en, /^Put 1 match on .* at .*\. 2 matches don't fit yet/);
  await run(db, "competition.schedule", { program_id: t.programId }, desk);
  const fs = await fixtures(t.programId);
  const placed = fs.find((f) => f.starts_at)!, other = fs.find((f) => f.round === 1 && !f.starts_at)!;
  await rejects(plan(db, "fixture.place", { fixture_id: other.id, court_id: t.courts[0]!, starts_at: placed.starts_at!.toISOString() }, desk), "error.court_taken_by_match");
  await rejects(plan(db, "fixture.place", { fixture_id: other.id, court_id: t.courts[0]!, starts_at: new Date(t.start - 864e5).toISOString() }, desk), "error.not_program_court_time");
  void ids;
});

test("a league: everyone plays everyone, 2 points a win and 1 a loss, and a pair that withdraws gives its matches", async () => {
  const t = await competition("league", 4, { days: 3, hours: 2 });
  const ids = await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "league" }, desk);
  let fs = await fixtures(t.programId);
  assert.equal(fs.length, 6);
  await run(db, "competition.schedule", { program_id: t.programId }, desk);
  fs = await fixtures(t.programId);
  const weeks = [...new Set(fs.map((f) => f.starts_at && Math.floor((f.starts_at.getTime() - t.start) / (7 * 864e5))))].sort();
  assert.deepEqual(weeks, [0, 1, 2], "a round a week");
  const first = fs.find((f) => f.entry_a === ids[0] || f.entry_b === ids[0])!;
  await run(db, "fixture.score", { fixture_id: first.id, sets: [{ a: 6, b: 2 }] }, desk, later(t));
  await run(db, "entry.withdraw", { entry_id: ids[0]! }, desk, later(t));
  fs = await fixtures(t.programId);
  const theirs = fs.filter((f) => f.entry_a === ids[0] || f.entry_b === ids[0]);
  assert.equal(theirs.filter((f) => f.status === "walkover").length, 2);
  assert.ok(theirs.filter((f) => f.status === "walkover").every((f) => f.walkover_by === ids[0] && f.winner !== ids[0]));
  assert.equal(theirs.filter((f) => f.status === "played").length, 1, "the match played stands");
  const v = await competitionView(db, t.programId);
  const row = v.tables[0]!.rows.find((r) => r.entry === ids[0])!;
  assert.equal(row.points, first.entry_a === ids[0] ? 2 : 1, "what they played still counts; the walkovers score nothing");
});

test("a walkover sends the other pair through", async () => {
  const t = await competition("tournament", 2);
  const ids = await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  const [f] = await fixtures(t.programId);
  await run(db, "fixture.walkover", { fixture_id: f!.id, given_by: ids[1]! }, desk);
  const after = (await fixtures(t.programId))[0]!;
  assert.equal(after.status, "walkover"); assert.equal(after.winner, ids[0]);
});

test("the staff draw form and the members' partner form preview with exactly what they send (the third phone check)", async () => {
  // What Competition.tsx sends with its defaults (groups then knockout, one set, groups of 4), and a league's.
  const t = await competition("tournament", 4);
  await pairAll(t);
  const d = await plan(db, "competition.draw", { program_id: t.programId, format: "groups_knockout", match_format: "one_set", group_size: 4 }, owner);
  assert.match(d.plan.summary.en, /^The draw for /);
  const l = await competition("league", 4);
  await pairAll(l);
  assert.match((await plan(db, "competition.draw", { program_id: l.programId, format: "league", match_format: "one_set", legs: 1 }, owner)).plan.summary.en, /^The draw for /);
  // What Competitions.tsx sends: asked twice (Back, then the same button again), it previews both times.
  const e = await competition("tournament", 1), [a, b] = e.people[0]!;
  await db.insertInto("friend").values([{ id: uuidv7(), person_id: a!, friend_id: b! }, { id: uuidv7(), person_id: b!, friend_id: a! }]).execute();
  for (let k = 0; k < 2; k++) assert.match((await plan(db, "entry.invite", { program_id: e.programId, person_id: a!, partner_id: b! }, as(a!))).plan.summary.en, /accepts from their app/);
});
