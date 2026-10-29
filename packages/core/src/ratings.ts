// Ratings in the database: rate a game, change a level, set a floor, and replay everything from
// the events. Game and recompute events are derived; staff changes, floors and seeds are anchors.
import * as z from "zod/mini";

import { both, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { uuidv7 } from "./ids.ts";
import { MODEL, MODEL_VERSION, shownLevel, shownOdds, update, type Skill } from "./levels.ts";

interface State { mu: number; sigma: number; level: number; floor: number | null; games: number }
const fresh = (): State => ({ mu: MODEL.defaultLevel, sigma: MODEL.sigmaNew, level: MODEL.defaultLevel, floor: null, games: 0 });
const pct = (p: number) => `${Math.round(p * 100)}/${100 - Math.round(p * 100)}`;
const lvl = (n: number) => n.toFixed(2);

async function load(db: Db | Trx, personId: string): Promise<State & { exists: boolean }> {
  const r = await db.selectFrom("rating").selectAll().where("person_id", "=", personId).where("sport", "=", "padel").executeTakeFirst();
  if (!r) return { ...fresh(), exists: false };
  return { mu: r.mu ?? Number(r.level), sigma: r.sigma ?? MODEL.sigmaNew, level: Number(r.level), floor: r.floor === null ? null : Number(r.floor), games: r.rated_games, exists: true };
}
async function save(ctx: ApplyCtx, personId: string, s: State, existed: boolean) {
  const row = { mu: s.mu, sigma: s.sigma, level: lvl(s.level), rated_games: s.games, provisional: s.sigma > MODEL.provisionalSigma, floor: s.floor === null ? null : lvl(s.floor) };
  if (existed) await ctx.update("rating", personId, row); else await ctx.insert("rating", { person_id: personId, ...row });
}
async function event(ctx: ApplyCtx, personId: string, kind: string, before: State | null, after: State, explanation: Text, extra: { gameId?: string; share?: number; factors?: unknown } = {}) {
  await ctx.trx.insertInto("rating_event").values({
    id: uuidv7(), person_id: personId, game_id: extra.gameId ?? null, kind, mu_before: before?.mu ?? null, sigma_before: before?.sigma ?? null, level_before: before ? lvl(before.level) : null,
    mu_after: after.mu, sigma_after: after.sigma, level_after: lvl(after.level), share: extra.share ?? null, factors: JSON.stringify(extra.factors ?? {}),
    explanation: JSON.stringify(explanation), action_run_id: ctx.runId, model_version: MODEL_VERSION,
  }).execute();
}

async function gameFacts(db: Db | Trx, gameId: string) {
  const sides = await db.selectFrom("game_side").innerJoin("person", "person.id", "game_side.person_id").select(["game_side.side", "game_side.person_id", "person.display_name"]).where("game_id", "=", gameId).orderBy("game_side.person_id").execute();
  const set = await db.selectFrom("game_set").select(["a", "b"]).where("game_id", "=", gameId).where("set_no", "=", 1).executeTakeFirstOrThrow();
  return { a: sides.filter((s) => s.side === "a"), b: sides.filter((s) => s.side === "b"), scoreA: set.a, scoreB: set.b };
}

/** One rated game: four players' ratings move, each with a sentence on why. */
export async function rateGame(ctx: ApplyCtx, gameId: string): Promise<void> {
  const g = await gameFacts(ctx.trx, gameId);
  const states = new Map<string, State & { exists: boolean }>();
  for (const p of [...g.a, ...g.b]) states.set(p.person_id, await load(ctx.trx, p.person_id));
  const skill = (id: string): Skill => ({ mu: states.get(id)!.mu, sigma: states.get(id)!.sigma });
  const r = update({ a: g.a.map((p) => skill(p.person_id)), b: g.b.map((p) => skill(p.person_id)), scoreA: g.scoreA, scoreB: g.scoreB });
  for (const [side, team, mine, theirs, next, p] of [["a", g.a, g.scoreA, g.scoreB, r.a, r.p], ["b", g.b, g.scoreB, g.scoreA, r.b, 1 - r.p]] as const) {
    for (const [k, pl] of team.entries()) {
      const before = states.get(pl.person_id)!;
      const est = next[k]!;
      const after: State = { mu: est.mu, sigma: est.sigma, level: shownLevel(before.level, est.mu, est.sigma, before.floor), floor: before.floor, games: before.games + 1 };
      const partner = team.find((x) => x.person_id !== pl.person_id)!.display_name;
      const opp = side === "a" ? g.b : g.a;
      const expect = p > 0.55 ? both("level.favored", { odds: pct(shownOdds(p)) }) : p < 0.45 ? both("level.underdog", { odds: pct(shownOdds(p)) }) : both("level.even");
      const result = mine > theirs ? both("level.won") : mine < theirs ? both("level.lost") : both("level.drew");
      const why = both("level.why", { result, us: mine, them: theirs, partner, opponents: both("level.opponents", { a: opp[0]!.display_name, b: opp[1]!.display_name }), expect, before: lvl(before.level), after: lvl(after.level) });
      await save(ctx, pl.person_id, after, before.exists);
      await event(ctx, pl.person_id, "game", before, after, why, { gameId, share: side === "a" ? r.share : 1 - r.share, factors: { win_chance: p, provisional: before.sigma > MODEL.provisionalSigma } });
    }
  }
}

/** Replay every rating from the events, in order. Game events are recomputed from today's scores;
 *  staff changes, floors and seeds are applied as they were. This is the invariant the tests hold. */
export async function replay(db: Db | Trx): Promise<Map<string, State>> {
  const events = await db.selectFrom("rating_event").select(["id", "person_id", "kind", "game_id", "mu_after", "sigma_after", "level_after", "factors"]).where("kind", "!=", "recompute").orderBy("id").execute();
  const st = new Map<string, State>(), done = new Set<string>();
  const get = (id: string) => st.get(id) ?? fresh();
  for (const e of events) {
    if (e.kind === "game") {
      if (!e.game_id || done.has(e.game_id)) continue;
      done.add(e.game_id);
      const g = await gameFacts(db, e.game_id);
      const r = update({ a: g.a.map((p) => get(p.person_id)), b: g.b.map((p) => get(p.person_id)), scoreA: g.scoreA, scoreB: g.scoreB });
      for (const [team, next] of [[g.a, r.a], [g.b, r.b]] as const) for (const [k, pl] of team.entries()) {
        const b = get(pl.person_id), est = next[k]!;
        st.set(pl.person_id, { mu: est.mu, sigma: est.sigma, level: shownLevel(b.level, est.mu, est.sigma, b.floor), floor: b.floor, games: b.games + 1 });
      }
    } else {
      const b = get(e.person_id), f = (e.factors ?? {}) as { floor?: number };
      st.set(e.person_id, { mu: e.mu_after, sigma: e.sigma_after, level: Number(e.level_after), floor: e.kind === "floor" ? f.floor ?? b.floor : b.floor, games: b.games });
    }
  }
  return st;
}

/** After a corrected score: replay, and write whatever changed, with a "recalculated" event. */
export async function recompute(ctx: ApplyCtx): Promise<void> {
  for (const [personId, s] of await replay(ctx.trx)) {
    const cur = await load(ctx.trx, personId);
    if (Math.abs(cur.mu - s.mu) < 1e-9 && Math.abs(cur.sigma - s.sigma) < 1e-9 && cur.level === s.level) continue;
    await save(ctx, personId, s, cur.exists);
    await event(ctx, personId, "recompute", cur, s, both("level.recompute"));
  }
}

async function nameOf(db: Db | Trx, id: string | null) { return id ? (await readRow(db, "person", id, "thing.person")).row.display_name as string : "Kumi"; }

export const levelSet = defineAction({
  name: "level.set", version: 1,
  input: z.object({ person_id: z.uuid(), level: z.number().check(z.minimum(0), z.maximum(7)), reason: z.string().check(z.minLength(3)) }),
  async plan(ctx, i) {
    const s = await load(ctx.db, i.person_id);
    const reads = s.exists ? [{ entity: "rating" as const, id: i.person_id, version: (await readRow(ctx.db, "rating", i.person_id)).row.version }] : [];
    return { title: both("action.level.set"), summary: both("plan.level.set", { person: await nameOf(ctx.db, i.person_id), before: lvl(s.level), after: lvl(i.level), reason: i.reason }), reads,
      undo: { kind: "compensating" }, details: { before: s.level } };
  },
  async apply(ctx, i) {
    const before = await load(ctx.trx, i.person_id);
    const level = Math.max(before.floor ?? -Infinity, i.level);
    const after: State = { mu: level, sigma: before.exists ? before.sigma : MODEL.sigmaSeeded, level, floor: before.floor, games: before.games };
    await save(ctx, i.person_id, after, before.exists);
    await event(ctx, i.person_id, "staff_set", before.exists ? before : null, after, both("level.staff", { by: await nameOf(ctx.trx, ctx.actor.personId), reason: i.reason }));
    return { level: after.level };
  },
});

export const levelSetFloor = defineAction({
  name: "level.set_floor", version: 1,
  input: z.object({ person_id: z.uuid(), floor: z.number().check(z.minimum(0), z.maximum(7)), reason: z.string().check(z.minLength(3)) }),
  async plan(ctx, i) {
    return { title: both("action.level.set_floor"), summary: both("plan.level.set_floor", { person: await nameOf(ctx.db, i.person_id), floor: lvl(i.floor), reason: i.reason }), reads: [], undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const before = await load(ctx.trx, i.person_id);
    const after: State = { ...before, floor: i.floor, level: Math.max(before.level, i.floor) };
    await save(ctx, i.person_id, after, before.exists);
    await event(ctx, i.person_id, "floor", before.exists ? before : null, after, both("level.floor", { floor: lvl(i.floor), by: await nameOf(ctx.trx, ctx.actor.personId), reason: i.reason }), { factors: { floor: i.floor } });
    return null;
  },
});
