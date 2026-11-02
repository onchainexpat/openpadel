// Americano nights: make the rounds, enter scores, and re-pair what's left after a late drop.
// The preview carries the exact rounds, so what's confirmed is what was shown.
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction, readRow, type PlanCtx } from "./actions.ts";
import { emptyHistory, recordRound, schedule, type History, type Player, type Round } from "./americano.ts";
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
  input: z.object({ session_id: z.uuid(), rounds: z.number().check(z.int(), z.minimum(1), z.maximum(20)), points_per_game: z.optional(z.number().check(z.int(), z.minimum(4))) }),
  async plan(ctx, i) {
    const { row: s, read } = await readRow(ctx.db, "session", i.session_id, "thing.session");
    if (await ctx.db.selectFrom("draw").select("session_id").where("session_id", "=", i.session_id).where("status", "!=", "void").executeTakeFirst()) throw new KumiError("error.draw_exists");
    const { row: p } = await readRow(ctx.db, "program", s.program_id, "thing.program");
    const players = await sessionPlayers(ctx.db, s.program_id, s.id), courts = await sessionCourts(ctx.db, s.id);
    if (players.length < 4) throw new KumiError("error.not_enough_players");
    const rounds = schedule(players, courts.map((c) => c.id), i.rounds, `${s.id}:0`);
    const sm = await summary(ctx, rounds, players.length, courts);
    return { title: both("action.draw.generate"), summary: both("plan.draw.generate", { rounds: i.rounds, ...sm }), reads: [read], locationId: p.location_id, undo: { kind: "reversible" }, details: { rounds } };
  },
  async apply(ctx, i, plan) {
    await ctx.insert("draw", { session_id: i.session_id, format: "americano", points_per_game: i.points_per_game ?? 24, rounds: i.rounds, seed: `${i.session_id}:0` });
    await writeRounds(ctx, i.session_id, (plan.details as { rounds: Round[] }).rounds, 1);
    await ctx.emit("draw.made", { session_id: i.session_id });
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
    const rounds = schedule(players, courts.map((c) => c.id), d.rounds - lastPlayed, `${s.id}:${d.version}`, history);
    return { title: both("action.draw.repair"), summary: both("plan.draw.repair", { from: lastPlayed + 1, to: d.rounds, players: players.length, kept: lastPlayed }),
      reads: [read], locationId: p.location_id, undo: { kind: "compensating" }, details: { rounds, from: lastPlayed + 1 } };
  },
  async apply(ctx, i, plan) {
    const det = plan.details as { rounds: Round[]; from: number };
    const stale = await ctx.trx.selectFrom("game").select("id").where("session_id", "=", i.session_id).where("round", ">=", det.from).where("status", "!=", "void").execute();
    for (const g of stale) await ctx.update("game", g.id, { status: "void" });
    await writeRounds(ctx, i.session_id, det.rounds, det.from);
    await ctx.update("draw", i.session_id, {});   // the next repair gets a fresh seed
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
    const d = g.session_id ? await ctx.db.selectFrom("draw").select("points_per_game").where("session_id", "=", g.session_id).executeTakeFirst() : undefined;
    if (d && i.a + i.b !== d.points_per_game) throw new KumiError("error.score_total", { points: d.points_per_game }, 400);
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

/** Points each player has won with their teams, best first: the Americano standings. */
export async function standings(db: Db | Trx, sessionId: string): Promise<{ person_id: string; points: number; games: number }[]> {
  const rows = await db.selectFrom("game_side").innerJoin("game", "game.id", "game_side.game_id").innerJoin("game_set", "game_set.game_id", "game.id")
    .select(["game_side.person_id", "game_side.side", "game_set.a", "game_set.b"]).where("game.session_id", "=", sessionId).where("game.status", "=", "confirmed").execute();
  const t = new Map<string, { points: number; games: number }>();
  for (const r of rows) { const x = t.get(r.person_id) ?? { points: 0, games: 0 }; x.points += r.side === "a" ? r.a : r.b; x.games++; t.set(r.person_id, x); }
  return [...t].map(([person_id, x]) => ({ person_id, ...x })).sort((p, q) => q.points - p.points);
}
