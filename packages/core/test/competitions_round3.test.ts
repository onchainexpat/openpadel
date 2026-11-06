// The tournaments and leagues review's last round (5 Nov 2026): a junior named only to their partner and family in
// every message, preview and level history; a wrong result staff can take back; results resolved told to the
// players; no sign-ups after the draw; times for matches after a walkover; withdrawn pairs out of the knockout;
// times previewed before a withdrawal; draw-night re-pairs against a court scored meanwhile; King of the Court
// re-seeded without last round's partners; invitations closed at the draw.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { APP_ONLY, SUPPORT_NEVER, messageHandlers, myCompetitions, plan, apply, processOutbox, registerMessageTopics, run, runAsSystem, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";
import { mexicanoRound } from "../src/formats.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, desk: Actor, locationId: string;
const as = (personId: string): Actor => ({ personId, via: "test", lang: "en" });
let n = 0;
async function person(name: string, level?: number, junior = false) {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: junior ? null : `${name.toLowerCase().replace(/ /g, "")}${n++}@example.test`, created_via: "desk", junior }).execute();
  const r = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  if (level !== undefined) await db.insertInto("rating").values({ person_id: id, level: level.toFixed(2) }).execute();
  return id;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function competition(kind: "tournament" | "league", pairs: number, opts: { courts?: number; hours?: number } = {}) {
  n++;
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
const messages = (personId: string) => db.selectFrom("outbound_message").select(["kind", "subject", "body", "channel"]).where("person_id", "=", personId).execute();
const who = (entry: string) => db.selectFrom("pair_entry").select(["person_a", "person_b"]).where("id", "=", entry).executeTakeFirstOrThrow();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  const d = await person("Dana");
  const fr = await db.selectFrom("role").select("id").where("key", "=", "front_desk").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: d, role_id: fr.id, location_id: null }).execute();
  desk = as(d);
  locationId = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string }).location_id;
  await registerMessageTopics(db);
});
after(async () => drop());

test("a junior is named to their partner and family only: match messages, score previews, result messages and level history", async () => {
  const t = await competition("league", 2);
  await db.updateTable("program").set({ rated: true }).where("id", "=", t.programId).execute();
  const kid = await person("Mia Larsen", 3, true), mum = await person("Ana Larsen", 3);
  const hh = uuidv7();
  await db.insertInto("household").values({ id: hh, created_by: mum }).execute();
  await db.insertInto("household_member").values([{ id: uuidv7(), household_id: hh, person_id: mum, role: "adult" }, { id: uuidv7(), household_id: hh, person_id: kid, role: "junior" }]).execute();
  const partner = t.people[0]![0]!, opp = t.people[1]![0]!;
  await db.insertInto("enrolment").values({ id: uuidv7(), program_id: t.programId, person_id: kid, status: "booked" }).execute();
  await run(db, "entry.pair", { program_id: t.programId, person_a: partner, person_b: kid }, desk);
  await run(db, "entry.pair", { program_id: t.programId, person_a: opp, person_b: t.people[1]![1]! }, desk);
  await run(db, "competition.draw", { program_id: t.programId, format: "league" }, desk);
  await run(db, "competition.schedule", { program_id: t.programId }, desk);
  await processOutbox(db, messageHandlers, 500);
  const [f] = await fixtures(t.programId);
  const at = { now: new Date(f!.starts_at!.getTime() + 3 * 3600_000) };
  // The opponent's preview of their own score names "Junior player".
  const pl = await plan(db, "fixture.enter", { fixture_id: f!.id, person_id: opp, sets: [{ us: 6, them: 3 }] }, as(opp), at);
  assert.ok(!JSON.stringify(pl.plan.summary).includes("Mia"), JSON.stringify(pl.plan.summary));
  assert.match(pl.plan.summary.en, /Junior player/);
  const g = ((await apply(db, pl.runId, as(opp), at)) as { game_id: string }).game_id;
  await processOutbox(db, messageHandlers, 500, at.now);
  // The partner reads her name in what they're asked to confirm, and confirms.
  assert.ok((await messages(partner)).some((m) => m.kind === "result_to_confirm"));
  const cp = await plan(db, "result.confirm", { game_id: g, person_id: partner }, as(partner), at);
  assert.match(cp.plan.summary.en, /Mia Larsen/);
  await apply(db, cp.runId, as(partner), at);
  await processOutbox(db, messageHandlers, 500, at.now);
  // The opponent's dispute preview, within the day: still "Junior player".
  const dp = await plan(db, "result.dispute", { game_id: g, person_id: opp, note: "Just checking" }, as(opp), at);
  assert.ok(!JSON.stringify(dp.plan.summary).includes("Mia"));
  // Every message the opponent got (placed, confirmed, any push copy) and their level history: no junior's name.
  const theirs = await messages(opp);
  assert.ok(theirs.some((m) => m.kind === "fixture_placed"), "the match was placed");
  assert.ok(theirs.every((m) => !`${m.subject} ${m.body}`.includes("Mia")), JSON.stringify(theirs.filter((m) => `${m.subject} ${m.body}`.includes("Mia"))));
  const ev = await db.selectFrom("rating_event").select(["person_id", "explanation"]).where("game_id", "=", g).execute();
  assert.equal(ev.length, 4);
  assert.ok(!JSON.stringify(ev.find((e) => e.person_id === opp)!.explanation).includes("Mia"));
  assert.match(JSON.stringify(ev.find((e) => e.person_id === partner)!.explanation), /Mia Larsen/, "her partner's history names her");
  assert.ok(!JSON.stringify(await myCompetitions(db, opp)).includes("Mia"));
});

test("a staff score the players can dispute for a day, unless it's final; and staff take a wrong result back", async () => {
  const t = await competition("tournament", 4);
  await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  await run(db, "competition.schedule", { program_id: t.programId }, desk);
  const fs0 = await fixtures(t.programId);
  const at = { now: new Date(Math.max(...fs0.map((f) => f.starts_at!.getTime())) + 3 * 3600_000) };
  const [s1, s2] = fs0.filter((f) => f.round === 1);
  // A staff typo (3-6 meant 6-3): the wronged pair can dispute it at once.
  const g = ((await run(db, "fixture.score", { fixture_id: s1!.id, sets: [{ a: 3, b: 6 }] }, desk, at)).result as { game_id: string }).game_id;
  const A = await who(s1!.entry_a!);
  await plan(db, "result.dispute", { game_id: g, person_id: A.person_a, note: "We won 6-3" }, as(A.person_a), at);
  // One marked final can't be disputed.
  const g2 = ((await run(db, "fixture.score", { fixture_id: s2!.id, sets: [{ a: 6, b: 4 }], final: true }, desk, at)).result as { game_id: string }).game_id;
  const C = await who(s2!.entry_b!);
  await rejects(plan(db, "result.dispute", { game_id: g2, person_id: C.person_a, note: "Not right" }, as(C.person_a), at), "error.dispute_closed");
  // The final has a score waiting; taking semi 1 back undoes it too, and says so.
  const final = (await fixtures(t.programId)).find((f) => f.round === 2)!;
  const winner = await who(final.entry_a === s1!.entry_b ? final.entry_a! : final.entry_b === s1!.entry_b ? final.entry_b! : final.entry_a!);
  const fg = ((await run(db, "fixture.enter", { fixture_id: final.id, person_id: winner.person_a, sets: [{ us: 6, them: 1 }] }, as(winner.person_a), at)).result as { game_id: string }).game_id;
  await rejects(plan(db, "result.dispute", { game_id: g, person_id: A.person_a, note: "We won 6-3" }, as(A.person_a), at), "error.next_match_played");
  const pl = await plan(db, "fixture.reopen", { fixture_id: s1!.id, note: "Entered the wrong way round" }, desk, at);
  assert.match(pl.plan.summary.en, /also undoes/);
  await apply(db, pl.runId, desk, at);
  const after1 = await fixtures(t.programId);
  assert.equal(after1.find((f) => f.id === s1!.id)!.status, "ready");
  assert.equal(after1.find((f) => f.id === final.id)!.status, "waiting");
  assert.equal((await db.selectFrom("game").select("status").where("id", "=", g).executeTakeFirstOrThrow()).status, "void");
  assert.equal((await db.selectFrom("game").select("status").where("id", "=", fg).executeTakeFirstOrThrow()).status, "void");
  await processOutbox(db, messageHandlers, 500, at.now);
  const told = await db.selectFrom("outbound_message").select(["person_id"]).where("kind", "=", "fixture_reopened").where("channel", "=", "email").execute();
  assert.equal(new Set(told.map((x) => x.person_id)).size, told.length, "each player told once");
  assert.ok(told.some((x) => x.person_id === A.person_a));
  // Now the right score goes in, and the right pair reaches the final.
  await run(db, "fixture.score", { fixture_id: s1!.id, sets: [{ a: 6, b: 3 }] }, desk, at);
  const fin = (await fixtures(t.programId)).find((f) => f.round === 2)!;
  assert.ok(fin.entry_a === s1!.entry_a || fin.entry_b === s1!.entry_a);
  await rejects(plan(db, "fixture.reopen", { fixture_id: final.id }, desk, at), "error.nothing_to_reopen");
  assert.ok(APP_ONLY.has("fixture.reopen") && SUPPORT_NEVER.includes("fixture.reopen"));
});

test("players hear how a tournament dispute was resolved, and to enter the score again after it's set aside", async () => {
  const t = await competition("tournament", 2);
  await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  await run(db, "competition.schedule", { program_id: t.programId }, desk);
  const [f] = await fixtures(t.programId);
  const [p0] = t.people[0]!, [p1] = t.people[1]!;
  const at = { now: new Date(f!.starts_at!.getTime() + 3 * 3600_000) };
  const g = ((await run(db, "fixture.enter", { fixture_id: f!.id, person_id: p0!, sets: [{ us: 6, them: 3 }] }, as(p0!), at)).result as { game_id: string }).game_id;
  await run(db, "result.dispute", { game_id: g, person_id: p1!, note: "It was 3-6" }, as(p1!), at);
  await run(db, "result.resolve", { game_id: g, outcome: "set_aside" }, desk, at);
  await processOutbox(db, messageHandlers, 500, at.now);
  const ev = await db.selectFrom("event_outbox").select(["attempts", "delivered_at"]).where("topic", "=", "result.resolved").execute();
  assert.ok(ev.every((e) => e.delivered_at), JSON.stringify(ev));
  const ms = await db.selectFrom("outbound_message").select("kind").where("person_id", "in", [p0!, p1!]).where("kind", "=", "fixture_result_set_aside").execute();
  assert.ok(ms.length >= 2);
});

test("a drawn tournament takes no more sign-ups; invitations still open are closed at the draw", async () => {
  const t = await competition("tournament", 4);
  const ids = await pairAll(t);
  void ids;
  const x = await person("Inv A", 4), y = await person("Inv B", 4);
  for (const p of [x, y]) await run(db, "enrolment.join", { program_id: t.programId, person_id: p }, as(p));
  await run(db, "friend.add", { person_id: x, friend_id: y }, as(x)).catch(() => undefined);
  await db.insertInto("pair_entry").values({ id: uuidv7(), program_id: t.programId, person_a: x, person_b: y, status: "invited" }).execute();
  await run(db, "competition.draw", { program_id: t.programId, format: "knockout" }, desk);
  const late = await person("Late One", 4);
  await rejects(plan(db, "enrolment.join", { program_id: t.programId, person_id: late }, as(late)), "error.competition_drawn");
  const e = await db.selectFrom("pair_entry").select("status").where("person_a", "=", x).executeTakeFirstOrThrow();
  assert.equal(e.status, "declined");
  await processOutbox(db, messageHandlers, 500);
  for (const p of [x, y]) assert.ok((await messages(p)).some((m) => m.kind === "entry_closed"));
  const mine = await myCompetitions(db, y);
  assert.ok(!JSON.stringify(mine).includes('"invited_me":true'));
});

test("suggest times places the knockout after a walkover given before any times", async () => {
  const t = await competition("tournament", 6, { courts: 2 });
  const ids = await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "groups_knockout", group_size: 3 }, desk);
  await run(db, "entry.withdraw", { entry_id: ids[5]! }, desk);
  await run(db, "competition.schedule", { program_id: t.programId }, desk);
  const fs = await fixtures(t.programId);
  const unplaced = fs.filter((f) => !f.starts_at && (f.status === "ready" || f.status === "waiting") && f.from_a !== "bye" && f.from_b !== "bye");
  assert.deepEqual(unplaced.map((f) => `${f.stage}${f.round}`), []);
});

test("two pairs of a group of three withdraw: only the pair still in goes through, the other place is a bye", async () => {
  const t = await competition("tournament", 6);
  await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "groups_knockout", group_size: 3 }, desk);
  const g1 = await db.selectFrom("pair_entry").select(["id"]).where("program_id", "=", t.programId).where("group_no", "=", 1).orderBy("seed").execute();
  await run(db, "entry.withdraw", { entry_id: g1[1]!.id }, desk, later(t));
  await run(db, "entry.withdraw", { entry_id: g1[2]!.id }, desk, later(t));
  for (const f of (await fixtures(t.programId)).filter((x) => x.stage === "group" && x.status === "ready")) await run(db, "fixture.score", { fixture_id: f.id, sets: [{ a: 6, b: 3 }] }, desk, later(t));
  const ko = (await fixtures(t.programId)).filter((f) => f.stage === "knockout");
  const out = new Set([g1[1]!.id, g1[2]!.id]);
  assert.deepEqual(ko.filter((f) => out.has(f.entry_a ?? "") || out.has(f.entry_b ?? "")).map((f) => f.id), []);
  assert.ok(ko.some((f) => f.from_a === "bye" || f.from_b === "bye"), "the empty place is a bye");
});

test("times previewed, then a pair withdraws: the walkover gets no court and nobody is told they play the pair that left", async () => {
  const t = await competition("league", 3);
  await pairAll(t);
  await run(db, "competition.draw", { program_id: t.programId, format: "league" }, desk);
  const pl = await plan(db, "competition.schedule", { program_id: t.programId }, desk);
  const victim = ((pl.plan as unknown as { details: { placed: { entries: string[] }[] } }).details.placed)[0]!.entries[0]!;
  await run(db, "entry.withdraw", { entry_id: victim }, desk);
  await apply(db, pl.runId, desk);
  await processOutbox(db, messageHandlers, 500);
  const wo = (await fixtures(t.programId)).filter((f) => f.status === "walkover");
  assert.ok(wo.length >= 1);
  assert.ok(wo.every((f) => !f.starts_at));
  const left = await who(victim);
  const names = (await db.selectFrom("person").select("display_name").where("id", "in", [left.person_a, left.person_b]).execute()).map((p) => p.display_name);
  const placed = await db.selectFrom("outbound_message").select("body").where("kind", "=", "fixture_placed").execute();
  assert.ok(placed.every((m) => names.every((nm) => !m.body.includes(nm))));
});

test("a draw-night re-pair confirmed after another court was scored is refused; nobody is in two games of a round", async () => {
  const courts: string[] = [];
  for (let c = 1; c <= 2; c++) courts.push(((await run(db, "court.create", { location_id: locationId, name: `MR Court ${c}` }, owner)).result as { court_id: string }).court_id);
  const p = (await run(db, "program.create", { location_id: locationId, kind: "social", format: "mexicano", name: "Mex race", capacity: 9, price_cents: 0 }, owner)).result as { program_id: string };
  const startAt = Date.now() + 41 * 864e5;
  const s = (await run(db, "session.add", { program_id: p.program_id, starts_at: new Date(startAt).toISOString(), ends_at: new Date(startAt + 2 * 3600_000).toISOString(), court_ids: courts }, owner)).result as { session_id: string };
  await run(db, "program.publish", { program_id: p.program_id }, owner);
  for (let i = 0; i < 9; i++) { const x = await person(`Mr${i}`, 4 - i * 0.2); await run(db, "enrolment.join", { program_id: p.program_id, person_id: x }, as(x)); }
  const at = { now: new Date(startAt + 3600_000) };
  await run(db, "draw.generate", { session_id: s.session_id, rounds: 3 }, desk);
  for (const g of await db.selectFrom("game").selectAll().where("session_id", "=", s.session_id).where("round", "=", 1).execute()) await run(db, "game.score", { game_id: g.id, a: 14, b: 10 }, desk, at);
  await run(db, "draw.next_round", { session_id: s.session_id }, desk, at);
  const r2 = await db.selectFrom("game").selectAll().where("session_id", "=", s.session_id).where("round", "=", 2).where("status", "!=", "void").execute();
  await run(db, "game.score", { game_id: r2[0]!.id, a: 15, b: 9 }, desk, at);
  const pl = await plan(db, "draw.repair", { session_id: s.session_id }, desk, at);
  await run(db, "game.score", { game_id: r2[1]!.id, a: 12, b: 12 }, desk, at);       // court 2 finishes meanwhile
  await rejects(apply(db, pl.runId, desk, at), "error.changed");
  const rows = await db.selectFrom("game").innerJoin("game_side", "game_side.game_id", "game.id").select(["game_side.person_id"]).where("game.session_id", "=", s.session_id).where("game.round", "=", 2).where("game.status", "!=", "void").execute();
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.person_id, (per.get(r.person_id) ?? 0) + 1);
  assert.deepEqual([...per.values()].filter((k) => k > 1), []);
});

test("King of the Court seeded again: nobody keeps last round's partner", () => {
  const players = Array.from({ length: 8 }, (_, k) => ({ id: `p${k}`, level: 5 - k * 0.1 }));
  const plainRound = mexicanoRound(players, ["c1", "c2"], null, new Map(), "seed");
  const partners = new Set(plainRound.games.flatMap((g) => [[...g.a].sort().join("|"), [...g.b].sort().join("|")]));
  const again = mexicanoRound(players, ["c1", "c2"], null, new Map(), "seed", undefined, partners);
  for (const g of again.games) for (const team of [g.a, g.b]) assert.ok(!partners.has([...team].sort().join("|")), `kept ${team.join("+")}`);
});
