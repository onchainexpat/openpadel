// Draw nights (Americano, Mexicano, King of the Court): make the rounds, enter scores, and re-pair what's left
// after a late drop. An Americano makes every round at the start; Mexicano and King of the Court make each round
// from the one before, when staff ask for the next. The preview carries the exact round(s), so what's confirmed
// is what was shown.
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction, readRow, type PlanCtx } from "./actions.ts";
import { emptyHistory, recordRound, schedule, type History, type Player, type Round } from "./americano.ts";
import { KOTC_MINUTES, MEXICANO_POINTS, kotcFirstRound, kotcNextRound, mexicanoRound, type PlayedGame } from "./formats.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { MODEL } from "./levels.ts";
import { rateGame, recompute } from "./ratings.ts";
import { uuidv7 } from "./ids.ts";

export const DEFAULT_LEVEL = MODEL.defaultLevel;

/** Who plays the night: everyone with a place in the program, or (signed up per date) on that date. */
async function sessionPlayers(db: Db | Trx, programId: string, sessionId: string): Promise<Player[]> {
  const rows = await db.selectFrom("enrolment").leftJoin("rating", (j) => j.onRef("rating.person_id", "=", "enrolment.person_id").on("rating.sport", "=", "padel"))
    .select(["enrolment.person_id", "rating.level", "rating.mu", "rating.sigma"]).where("enrolment.program_id", "=", programId).where("enrolment.status", "=", "booked")
    .where((eb) => eb.or([eb("enrolment.session_id", "is", null), eb("enrolment.session_id", "=", sessionId)])).orderBy("enrolment.created_at").execute();
  return rows.map((r) => ({ id: r.person_id, level: r.level === null ? DEFAULT_LEVEL : Number(r.level), mu: r.mu ?? undefined, sigma: r.sigma ?? undefined }));
}
async function sessionCourts(db: Db | Trx, sessionId: string): Promise<{ id: string; name: string }[]> {
  return db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").select(["court.id", "court.name"])
    .where("court_time.session_id", "=", sessionId).where("court_time.active", "=", true).orderBy("court.sort").orderBy("court.name").execute();
}
const fairText = (rounds: Round[]) => {
  const ps = rounds.flatMap((r) => r.games.map((g) => Math.max(g.predictedA, 1 - g.predictedA)));
  const avg = ps.length ? ps.reduce((s, x) => s + x, 0) / ps.length : 0.5;
  const hi = Math.round(avg * 100);
  return `${hi}/${100 - hi}`;
};

/** The rounds already played (any confirmed game), and what they taught the pairing. */
async function played(db: Db | Trx, sessionId: string) {
  const games = await db.selectFrom("game").select(["id", "round", "status"]).where("session_id", "=", sessionId).where("status", "!=", "void").orderBy("round").execute();
  const playedRounds = new Set(games.filter((g) => g.status === "confirmed").map((g) => g.round!));
  const lastPlayed = playedRounds.size ? Math.max(...playedRounds) : 0;
  const h: History = emptyHistory();
  const sides = await db.selectFrom("game_side").innerJoin("game", "game.id", "game_side.game_id").select(["game.round", "game.id", "game_side.side", "game_side.person_id"])
    .where("game.session_id", "=", sessionId).where("game.status", "!=", "void").where("game.round", "<=", lastPlayed).execute();
  const byRound = new Map<number, Map<string, { a: string[]; b: string[] }>>();
  for (const s of sides) {
    const r = byRound.get(s.round!) ?? new Map(); byRound.set(s.round!, r);
    const g = r.get(s.id) ?? { a: [], b: [] }; r.set(s.id, g); g[s.side].push(s.person_id);
  }
  for (const games of byRound.values()) recordRound(h, { games: [...games.values()].map((g) => ({ court: "", a: g.a as [string, string], b: g.b as [string, string], predictedA: 0.5 })), sittingOut: [] });
  return { lastPlayed, history: h };
}

async function summary(ctx: PlanCtx, rounds: Round[], players: number, courts: { name: string }[]) {
  const sit = rounds[0]?.sittingOut.length ?? 0;
  return { fair: fairText(rounds), sitout: sit ? both("plan.draw.sitout", { count: sit }) : { en: "", es: "" }, players, courts: courts.slice(0, Math.floor(players / 4)).map((c) => c.name).join(", ") };
}
type Format = "americano" | "mexicano" | "king_of_court";
const formatOf = (p: { format?: string | null }): Format => (p.format === "mexicano" || p.format === "king_of_court" ? p.format : "americano");
/** One round's pairings as the preview lists them: "Court 1: Ana + Ben vs Cy + Di". */
async function roundText(db: Db | Trx, r: Round, courts: { id: string; name: string }[]) {
  const ids = [...new Set(r.games.flatMap((g) => [...g.a, ...g.b]))];
  const names = new Map((ids.length ? await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", ids).execute() : []).map((p) => [p.id, p.display_name]));
  const court = new Map(courts.map((c) => [c.id, c.name]));
  return r.games.map((g) => `${court.get(g.court) ?? ""}: ${g.a.map((x) => names.get(x)).join(" + ")} / ${g.b.map((x) => names.get(x)).join(" + ")}`).join("; ");
}
/** Who sat out each round so far (rounds are written with their sit-outs). */
const satOutCounts = (sat: Record<string, string[]>, upTo = Infinity) => {
  const m = new Map<string, number>();
  for (const [round, ids] of Object.entries(sat)) if (Number(round) <= upTo) for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
};
/** The latest round written, and whether every game in it has a score (or was set aside). */
async function latestRound(db: Db | Trx, sessionId: string) {
  const games = await db.selectFrom("game").select(["id", "round", "status"]).where("session_id", "=", sessionId).where("status", "!=", "void").execute();
  const latest = games.length ? Math.max(...games.map((g) => g.round!)) : 0;
  const inIt = games.filter((g) => g.round === latest);
  return { latest, done: inIt.length > 0 && inIt.every((g) => g.status === "confirmed"), games: inIt };
}
/** The next round of a Mexicano or King of the Court night, for the players on the roster now. A King of the
 *  Court night whose roster changed (a late drop, a place taken from the waitlist) is seeded again by its
 *  standings, Mexicano style, since the court-to-court moves need the same players. */
async function makeNext(db: Db | Trx, draw: { format: string; sat_out: unknown; version: number }, sessionId: string, players: Player[], courts: { id: string; name: string }[], round: number): Promise<Round> {
  const sat = (draw.sat_out ?? {}) as Record<string, string[]>, sitouts = satOutCounts(sat, round - 1), seed = `${sessionId}:${round}:${draw.version}`;
  const table = await standings(db, sessionId);
  const points = new Map(table.map((s) => [s.person_id, s.points]));
  if (draw.format === "mexicano") return mexicanoRound(players, courts.map((c) => c.id), points, sitouts, seed);
  const prev = await db.selectFrom("game").innerJoin("game_set", (j) => j.onRef("game_set.game_id", "=", "game.id").on("game_set.set_no", "=", 1))
    .select(["game.id", "game.court_id", "game_set.a", "game_set.b"]).where("game.session_id", "=", sessionId).where("game.round", "=", round - 1).where("game.status", "=", "confirmed").execute();
  const sides = prev.length ? await db.selectFrom("game_side").select(["game_id", "side", "person_id"]).where("game_id", "in", prev.map((g) => g.id)).execute() : [];
  const last: PlayedGame[] = prev.map((g) => ({ court: g.court_id!, scoreA: g.a, scoreB: g.b,
    a: sides.filter((x) => x.game_id === g.id && x.side === "a").map((x) => x.person_id) as [string, string], b: sides.filter((x) => x.game_id === g.id && x.side === "b").map((x) => x.person_id) as [string, string] }));
  const waiting = sat[String(round - 1)] ?? [];
  const before = new Set([...last.flatMap((g) => [...g.a, ...g.b]), ...waiting]), now = new Set(players.map((p) => p.id));
  const same = before.size === now.size && [...now].every((id) => before.has(id)) && last.length === Math.min(courts.length, Math.floor(players.length / 4));
  if (!same || !last.length) return mexicanoRound(players, courts.map((c) => c.id), points, sitouts, seed);
  return kotcNextRound(new Map(players.map((p) => [p.id, p])), courts.map((c) => c.id), last, waiting, sitouts, seed);
}

async function writeRounds(ctx: Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0], sessionId: string, rounds: Round[], firstRound: number) {
  const rated = (await ctx.trx.selectFrom("session").innerJoin("program", "program.id", "session.program_id").select("program.rated").where("session.id", "=", sessionId).executeTakeFirstOrThrow()).rated;
  for (const [i, r] of rounds.entries()) for (const g of r.games) {
    const id = uuidv7();
    await ctx.insert("game", { id, session_id: sessionId, round: firstRound + i, court_id: g.court, predicted_a: g.predictedA.toFixed(3), status: "scheduled", rated });
    await ctx.trx.insertInto("game_side").values([...g.a.map((p) => ({ game_id: id, side: "a" as const, person_id: p })), ...g.b.map((p) => ({ game_id: id, side: "b" as const, person_id: p }))]).execute();
  }
}

export const drawGenerate = defineAction({
  name: "draw.generate", version: 1,
  input: z.object({ session_id: z.uuid(), rounds: z.number().check(z.int(), z.minimum(1), z.maximum(20)), points_per_game: z.optional(z.number().check(z.int(), z.minimum(4))),
    round_minutes: z.optional(z.number().check(z.int(), z.minimum(5), z.maximum(60))) }),
  async plan(ctx, i) {
    const { row: s, read } = await readRow(ctx.db, "session", i.session_id, "thing.session");
    if (await ctx.db.selectFrom("draw").select("session_id").where("session_id", "=", i.session_id).where("status", "!=", "void").executeTakeFirst()) throw new KumiError("error.draw_exists");
    const { row: p } = await readRow(ctx.db, "program", s.program_id, "thing.program");
    const format = formatOf(p), points = i.points_per_game ?? 24;
    if (format === "mexicano" && !(MEXICANO_POINTS as readonly number[]).includes(points)) throw new KumiError("error.mexicano_points", { points: MEXICANO_POINTS.join(", ") }, 400);
    const players = await sessionPlayers(ctx.db, s.program_id, s.id), courts = await sessionCourts(ctx.db, s.id);
    if (players.length < 4) throw new KumiError("error.not_enough_players");
    if (format === "americano") {
      const rounds = schedule(players, courts.map((c) => c.id), i.rounds, `${s.id}:0`);
      const sm = await summary(ctx, rounds, players.length, courts);
      return { title: both("action.draw.generate"), summary: both("plan.draw.generate", { rounds: i.rounds, ...sm }), reads: [read], locationId: p.location_id, undo: { kind: "reversible" }, details: { rounds, format } };
    }
    // Mexicano and King of the Court make round 1 now and each later round from the one before.
    const first = format === "mexicano" ? mexicanoRound(players, courts.map((c) => c.id), null, new Map(), `${s.id}:1:1`) : kotcFirstRound(players, courts.map((c) => c.id), `${s.id}:1:1`);
    const sm = await summary(ctx, [first], players.length, courts), minutes = i.round_minutes ?? KOTC_MINUTES;
    const how = format === "mexicano" ? both("plan.draw.mexicano_how", { points }) : both("plan.draw.kotc_how", { minutes });
    return { title: both("action.draw.generate"), summary: both("plan.draw.generate_one", { format: both(`format.${format}`), rounds: i.rounds, players: sm.players, courts: sm.courts, sitout: sm.sitout, how, first: await roundText(ctx.db, first, courts) }),
      reads: [read], locationId: p.location_id, undo: { kind: "reversible" }, details: { rounds: [first], format, minutes } };
  },
  async apply(ctx, i, plan) {
    const det = plan.details as { rounds: Round[]; format: Format; minutes?: number };
    const sat: Record<string, string[]> = Object.fromEntries(det.rounds.map((r, k) => [String(k + 1), r.sittingOut]));
    await ctx.insert("draw", { session_id: i.session_id, format: det.format, points_per_game: det.format === "king_of_court" ? 24 : i.points_per_game ?? 24, rounds: i.rounds, seed: `${i.session_id}:0`,
      round_minutes: det.format === "king_of_court" ? det.minutes ?? KOTC_MINUTES : null, sat_out: JSON.stringify(sat) });
    await writeRounds(ctx, i.session_id, det.rounds, 1);
    await ctx.emit("draw.made", { session_id: i.session_id });
    return null;
  },
});

/** Mexicano and King of the Court: the next round, once every game of the last one has its score. */
export const drawNextRound = defineAction({
  name: "draw.next_round", version: 1,
  input: z.object({ session_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: d, read } = await readRow(ctx.db, "draw", i.session_id, "thing.session");
    if (d.status === "void") throw new KumiError("error.no_draw");
    if (d.format === "americano") throw new KumiError("error.americano_all_rounds");
    const { row: s } = await readRow(ctx.db, "session", i.session_id, "thing.session");
    const { row: p } = await readRow(ctx.db, "program", s.program_id, "thing.program");
    const { latest, done } = await latestRound(ctx.db, i.session_id);
    if (latest >= d.rounds) throw new KumiError("error.nothing_to_repair");
    if (!done) throw new KumiError("error.round_not_scored", { round: latest });
    const players = await sessionPlayers(ctx.db, s.program_id, s.id), courts = await sessionCourts(ctx.db, s.id);
    if (players.length < 4) throw new KumiError("error.not_enough_players");
    const next = await makeNext(ctx.db, d as never, i.session_id, players, courts, latest + 1);
    const sit = next.sittingOut.length;
    return { title: both("action.draw.next_round"), summary: both("plan.draw.next_round", { round: latest + 1, of: d.rounds, pairs: await roundText(ctx.db, next, courts), sitout: sit ? both("plan.draw.sitout", { count: sit }) : { en: "", es: "" } }),
      reads: [read], locationId: p.location_id, undo: { kind: "compensating" }, details: { round: next, number: latest + 1 } };
  },
  async apply(ctx, i, plan) {
    const det = plan.details as { round: Round; number: number };
    const d = await ctx.trx.selectFrom("draw").select(["sat_out"]).where("session_id", "=", i.session_id).forUpdate().executeTakeFirstOrThrow();
    // Two staff asking at once: only the first makes the round.
    if (await ctx.trx.selectFrom("game").select("id").where("session_id", "=", i.session_id).where("round", ">=", det.number).where("status", "!=", "void").executeTakeFirst()) throw new KumiError("error.changed", {}, 409);
    await writeRounds(ctx, i.session_id, [det.round], det.number);
    await ctx.update("draw", i.session_id, { sat_out: JSON.stringify({ ...(d.sat_out as Record<string, string[]>), [String(det.number)]: det.round.sittingOut }) });
    await ctx.emit("draw.next_round", { session_id: i.session_id, round: det.number });
    return null;
  },
});

export const drawRepair = defineAction({
  name: "draw.repair", version: 1,
  input: z.object({ session_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: d, read } = await readRow(ctx.db, "draw", i.session_id, "thing.session");
    if (d.status === "void") throw new KumiError("error.no_draw");
    const { row: s } = await readRow(ctx.db, "session", i.session_id, "thing.session");
    const { row: p } = await readRow(ctx.db, "program", s.program_id, "thing.program");
    const { lastPlayed, history } = await played(ctx.db, i.session_id);
    if (lastPlayed >= d.rounds) throw new KumiError("error.nothing_to_repair");
    const players = await sessionPlayers(ctx.db, s.program_id, s.id), courts = await sessionCourts(ctx.db, s.id);
    if (players.length < 4) throw new KumiError("error.not_enough_players");
    if (d.format !== "americano") {
      // The round not yet played is made again from the standings, for the players on the roster now.
      const { latest, done, games: inRound } = await latestRound(ctx.db, i.session_id);
      if (done || latest === 0) throw new KumiError("error.nothing_to_repair");
      // Games of the round already scored stay as they are (their scores may have moved levels); the rest of the
      // roster is paired again on the courts left, by the standings.
      const scored = inRound.filter((g) => g.status === "confirmed");
      let again: Round;
      if (!scored.length) again = await makeNext(ctx.db, d as never, i.session_id, players, courts, latest);
      else {
        const kept = await ctx.db.selectFrom("game").innerJoin("game_side", "game_side.game_id", "game.id").select(["game.court_id", "game_side.person_id"]).where("game.id", "in", scored.map((g) => g.id)).execute();
        const keptPeople = new Set(kept.map((k) => k.person_id)), keptCourts = new Set(kept.map((k) => k.court_id));
        const points = new Map((await standings(ctx.db, i.session_id)).map((x) => [x.person_id, x.points]));
        const sat = satOutCounts((d.sat_out ?? {}) as Record<string, string[]>, latest - 1);
        again = mexicanoRound(players.filter((x) => !keptPeople.has(x.id)), courts.filter((c) => !keptCourts.has(c.id)).map((c) => c.id), points, sat, `${i.session_id}:${latest}:${d.version}`);
      }
      return { title: both("action.draw.repair"), summary: both("plan.draw.repair_round", { round: latest, players: players.length, pairs: await roundText(ctx.db, again, courts) }),
        reads: [read], locationId: p.location_id, undo: { kind: "compensating" }, details: { rounds: [again], from: latest } };
    }
    const rounds = schedule(players, courts.map((c) => c.id), d.rounds - lastPlayed, `${s.id}:${d.version}`, history);
    return { title: both("action.draw.repair"), summary: both("plan.draw.repair", { from: lastPlayed + 1, to: d.rounds, players: players.length, kept: lastPlayed }),
      reads: [read], locationId: p.location_id, undo: { kind: "compensating" }, details: { rounds, from: lastPlayed + 1 } };
  },
  async apply(ctx, i, plan) {
    const det = plan.details as { rounds: Round[]; from: number };
    const fmt = (await ctx.trx.selectFrom("draw").select("format").where("session_id", "=", i.session_id).executeTakeFirstOrThrow()).format;
    // An Americano re-pairs only rounds nobody has played; a Mexicano or King of the Court round keeps its scored games.
    const stale = await ctx.trx.selectFrom("game").select("id").where("session_id", "=", i.session_id).where("round", ">=", det.from).where("status", "not in", fmt === "americano" ? ["void"] : ["void", "confirmed"]).execute();
    for (const g of stale) await ctx.update("game", g.id, { status: "void" });
    await writeRounds(ctx, i.session_id, det.rounds, det.from);
    const d = await ctx.trx.selectFrom("draw").select("sat_out").where("session_id", "=", i.session_id).executeTakeFirstOrThrow();
    const sat = { ...(d.sat_out as Record<string, string[]>) };
    for (const k of Object.keys(sat)) if (Number(k) >= det.from) delete sat[k];
    det.rounds.forEach((r, k) => { sat[String(det.from + k)] = r.sittingOut; });
    await ctx.update("draw", i.session_id, { sat_out: JSON.stringify(sat) });   // and the next repair gets a fresh seed
    await ctx.emit("draw.repaired", { session_id: i.session_id, from: det.from });
    return null;
  },
});

export const gameScore = defineAction({
  name: "game.score", version: 1,
  input: z.object({ game_id: z.uuid(), a: z.number().check(z.int(), z.minimum(0)), b: z.number().check(z.int(), z.minimum(0)) }),
  async plan(ctx, i) {
    const { row: g, read } = await readRow(ctx.db, "game", i.game_id, "thing.session");
    if (g.status === "void") throw new KumiError("error.no_draw");
    // A score is for a round that has been played: a rated night would otherwise move levels days early.
    const s = g.session_id ? await ctx.db.selectFrom("session").select("starts_at").where("id", "=", g.session_id).executeTakeFirst() : undefined;
    if (s && ctx.now.getTime() < s.starts_at.getTime()) throw new KumiError("error.not_played_yet");
    const d = g.session_id ? await ctx.db.selectFrom("draw").select(["points_per_game", "format"]).where("session_id", "=", g.session_id).executeTakeFirst() : undefined;
    // Americano and Mexicano play to a total; King of the Court plays to the clock, and a round needs a winner.
    if (d && d.format === "king_of_court") { if (i.a === i.b || i.a > 99 || i.b > 99) throw new KumiError("error.score_needs_winner", {}, 400); }
    else if (d && i.a + i.b !== d.points_per_game) throw new KumiError("error.score_total", { points: d.points_per_game }, 400);
    const court = g.court_id ? (await readRow(ctx.db, "court", g.court_id, "thing.court")).row.name : "";
    const loc = g.court_id ? (await readRow(ctx.db, "court", g.court_id, "thing.court")).row.location_id : null;
    return { title: both("action.game.score"), summary: both("plan.game.score", { round: g.round ?? 1, court, a: i.a, b: i.b }), reads: [read], locationId: loc, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const before = await ctx.trx.selectFrom("game").select(["status", "played_at", "rated"]).where("id", "=", i.game_id).executeTakeFirstOrThrow();
    await ctx.update("game", i.game_id, { status: "confirmed", played_at: before.played_at ?? ctx.now, entered_by: ctx.actor.personId });
    await ctx.trx.insertInto("game_set").values({ game_id: i.game_id, set_no: 1, a: i.a, b: i.b }).onConflict((oc) => oc.columns(["game_id", "set_no"]).doUpdateSet({ a: i.a, b: i.b })).execute();
    // A rated game moves levels; a corrected score replays every rating from the events.
    if (before.rated) { if (before.status === "confirmed") await recompute(ctx); else await rateGame(ctx, i.game_id); }
    await ctx.emit("game.scored", { game_id: i.game_id });
    return null;
  },
});

/** The night's standings, best first. Americano: the points each player has won with their teams. Mexicano: the
 *  same, and a round sat out counts half the points of a game, so sitting out in turn costs nobody. King of the
 *  Court: games won, then rounds won on the top court. */
export async function standings(db: Db | Trx, sessionId: string): Promise<{ person_id: string; points: number; games: number; top: number }[]> {
  const d = await db.selectFrom("draw").select(["format", "points_per_game", "sat_out"]).where("session_id", "=", sessionId).where("status", "!=", "void").executeTakeFirst();
  const rows = await db.selectFrom("game_side").innerJoin("game", "game.id", "game_side.game_id").innerJoin("game_set", "game_set.game_id", "game.id")
    .select(["game_side.person_id", "game_side.side", "game.round", "game.court_id", "game_set.a", "game_set.b"]).where("game.session_id", "=", sessionId).where("game.status", "=", "confirmed").execute();
  const t = new Map<string, { points: number; games: number; top: number }>();
  const at = (id: string) => { const x = t.get(id) ?? { points: 0, games: 0, top: 0 }; t.set(id, x); return x; };
  const top = d?.format === "king_of_court" ? (await sessionCourts(db, sessionId))[0]?.id : undefined;
  for (const r of rows) {
    const x = at(r.person_id), mine = r.side === "a" ? r.a : r.b, theirs = r.side === "a" ? r.b : r.a;
    x.points += mine; x.games++;
    if (top && r.court_id === top && mine > theirs) x.top++;
  }
  if (d?.format === "mexicano") {
    const scored = new Set(rows.map((r) => r.round!));
    for (const [round, ids] of Object.entries((d.sat_out ?? {}) as Record<string, string[]>)) if (scored.has(Number(round))) for (const id of ids) at(id).points += d.points_per_game / 2;
  }
  return [...t].map(([person_id, x]) => ({ person_id, ...x })).sort((p, q) => q.points - p.points || q.top - p.top);
}
