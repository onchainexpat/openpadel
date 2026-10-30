// Results of court bookings and open matches. One of the four enters the score (their side has confirmed it
// by entering it); someone from the other side confirms or disputes it, and with no answer in two days it
// counts as entered. A rated match moves levels once it's confirmed; a friendly never does. A dispute goes
// to the club, which keeps the score, corrects it, or sets it aside, and levels are replayed from the rest.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { MODEL, shownOdds, winChance, type Skill } from "./levels.ts";
import { rateGame, recompute } from "./ratings.ts";

/** How long the other side has to answer before the score counts as entered. */
export const CONFIRM_HOURS = 48;
/** How long after a match its score can be entered, and after confirming that it can still be disputed. */
export const ENTER_DAYS = 7, DISPUTE_HOURS = 24;

const setsInput = z.array(z.object({ us: z.number().check(z.int(), z.minimum(0), z.maximum(99)), them: z.number().check(z.int(), z.minimum(0), z.maximum(99)) })).check(z.minLength(1), z.maxLength(5));
/** "6-3 6-4", from side a's point of view. */
export const setsText = (sets: { a: number; b: number }[]) => sets.map((s) => `${s.a}-${s.b}`).join(" ");
const pair = (a: string, b: string): Text => both("result.pair", { a, b });

/** The booking's four players, in it now (not left, not giving up their place), with names and skills. */
async function fourOf(db: Db | Trx, bookingId: string) {
  return (await db.selectFrom("booking_player").innerJoin("person", "person.id", "booking_player.person_id")
    .leftJoin("rating", (j) => j.onRef("rating.person_id", "=", "booking_player.person_id").on("rating.sport", "=", "padel"))
    .select(["booking_player.person_id", "person.display_name", "rating.mu", "rating.sigma", "rating.level"])
    .where("booking_player.booking_id", "=", bookingId).where("booking_player.removed_at", "is", null).where("booking_player.leaving_at", "is", null).orderBy("booking_player.id").execute())
    .map((p) => ({ ...p, person_id: p.person_id! }));   // joined to a person, so never a guest
}
const skillOf = (p: { mu: number | null; sigma: number | null; level: string | null }): Skill =>
  ({ mu: p.mu ?? (p.level === null ? MODEL.defaultLevel : Number(p.level)), sigma: p.sigma ?? MODEL.sigmaNew });

/** The fairest of the three ways four players can pair up, and side a's chance of winning it. */
export function fairTeams<T extends { person_id: string; mu: number | null; sigma: number | null; level: string | null }>(four: T[]) {
  const [p, q, r, s] = four as [T, T, T, T];
  const options: [T[], T[]][] = [[[p, q], [r, s]], [[p, r], [q, s]], [[p, s], [q, r]]];
  return options.map(([a, b]) => ({ a, b, p: winChance(a.map(skillOf), b.map(skillOf)) })).sort((x, y) => Math.abs(x.p - 0.5) - Math.abs(y.p - 0.5))[0]!;
}

async function bookingFacts(db: Db | Trx, bookingId: string) {
  const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id")
    .leftJoin("open_match", "open_match.booking_id", "booking.id")
    .select(["booking.id", "booking.status", "booking.location_id", "court.id as court_id", "court.name as court", "location.time_zone", "open_match.rated", sql<Date>`lower(court_time.during)`.as("start")])
    .where("booking.id", "=", bookingId).where("court_time.active", "=", true).executeTakeFirst();
  if (!b) throw new KumiError("error.not_found", { thing: both("thing.booking") }, 404);
  return { ...b, rated: Boolean(b.rated), when: { en: dateTime(new Date(b.start), "en", b.time_zone), es: dateTime(new Date(b.start), "es", b.time_zone) } as Text };
}

/** A game and its sides, sets and booking, for the answers below. */
export async function gameView(db: Db | Trx, gameId: string) {
  const g = await db.selectFrom("game").selectAll().where("id", "=", gameId).executeTakeFirst();
  if (!g || !g.booking_id) throw new KumiError("error.not_found", { thing: both("thing.result") }, 404);
  const sides = await db.selectFrom("game_side").innerJoin("person", "person.id", "game_side.person_id").select(["game_side.side", "game_side.person_id", "person.display_name"]).where("game_id", "=", gameId).orderBy("person.display_name").execute();
  const sets = await db.selectFrom("game_set").select(["a", "b"]).where("game_id", "=", gameId).orderBy("set_no").execute();
  const a = sides.filter((s) => s.side === "a"), b = sides.filter((s) => s.side === "b");
  return { ...g, a, b, sets, score: setsText(sets), teamA: pair(a[0]?.display_name ?? "", a[1]?.display_name ?? ""), teamB: pair(b[0]?.display_name ?? "", b[1]?.display_name ?? "") };
}
const answer = (ctx: ApplyCtx, gameId: string, personId: string | null, side: "a" | "b" | null, kind: string, note?: string | null) =>
  ctx.trx.insertInto("result_answer").values({ id: uuidv7(), game_id: gameId, person_id: personId, side, answer: kind, note: note ?? null, at: ctx.now }).execute();

export const resultEnter = defineAction({
  name: "result.enter", version: 1,
  input: z.object({ booking_id: z.uuid(), person_id: z.uuid(), partner_id: z.uuid(), sets: setsInput }),
  async plan(ctx, i) {
    const b = await bookingFacts(ctx.db, i.booking_id);
    if (b.status === "cancelled") throw new KumiError("error.already_cancelled");
    const start = new Date(b.start).getTime();
    if (ctx.now.getTime() < start) throw new KumiError("error.not_played_yet");
    if (ctx.now.getTime() > start + ENTER_DAYS * 86400_000) throw new KumiError("error.too_late_for_score", { count: ENTER_DAYS });
    const four = await fourOf(ctx.db, i.booking_id);
    if (four.length !== 4) throw new KumiError("error.need_four");
    const me = four.find((p) => p.person_id === i.person_id), partner = four.find((p) => p.person_id === i.partner_id);
    if (!me) throw new KumiError("error.not_in_match");
    if (!partner || partner === me) throw new KumiError("error.bad_partner");
    if (await ctx.db.selectFrom("game").select("id").where("booking_id", "=", i.booking_id).where("status", "!=", "void").executeTakeFirst()) throw new KumiError("error.score_entered");
    if (i.sets.some((s) => s.us === s.them)) throw new KumiError("error.set_tied");
    const them = four.filter((p) => p !== me && p !== partner);
    const won = i.sets.filter((s) => s.us > s.them).length, lost = i.sets.length - won;
    const p = { court: b.court, when: b.when, partner: partner.display_name, opponents: pair(them[0]!.display_name, them[1]!.display_name),
      result: both(won > lost ? "result.won" : won < lost ? "result.lost" : "result.drew"), score: setsText(i.sets.map((s) => ({ a: s.us, b: s.them }))),
      hours: CONFIRM_HOURS, counts: both(b.rated ? "result.counts_rated" : "result.counts_friendly") };
    return { title: both("action.result.enter"), summary: both("plan.result.enter", p), reads: [], locationId: b.location_id, ownerIds: [i.person_id], undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const b = await bookingFacts(ctx.trx, i.booking_id), four = await fourOf(ctx.trx, i.booking_id);
    const a = four.filter((p) => p.person_id === i.person_id || p.person_id === i.partner_id), bSide = four.filter((p) => !a.includes(p));
    const id = uuidv7();
    try {
      await ctx.insert("game", { id, booking_id: i.booking_id, court_id: b.court_id, format: "doubles", rated: b.rated, status: "awaiting_confirmation", played_at: b.start,
        entered_by: i.person_id, predicted_a: winChance(a.map(skillOf), bSide.map(skillOf)).toFixed(3), confirm_by: new Date(ctx.now.getTime() + CONFIRM_HOURS * 3600_000) });
    } catch (e: any) { if (e?.code === "23505") throw new KumiError("error.score_entered"); throw e; }
    await ctx.trx.insertInto("game_side").values([...a.map((p) => ({ game_id: id, side: "a" as const, person_id: p.person_id })), ...bSide.map((p) => ({ game_id: id, side: "b" as const, person_id: p.person_id }))]).execute();
    await ctx.trx.insertInto("game_set").values(i.sets.map((s, k) => ({ game_id: id, set_no: k + 1, a: s.us, b: s.them }))).execute();
    await answer(ctx, id, i.person_id, "a", "entered");
    await ctx.emit("result.entered", { game_id: id });
    return { game_id: id };
  },
});

/** The game counts: confirmed, and (rated) levels move. Already counted and only being kept: nothing to redo. */
async function count(ctx: ApplyCtx, gameId: string) {
  const g = await ctx.trx.selectFrom("game").select(["rated"]).where("id", "=", gameId).executeTakeFirstOrThrow();
  await ctx.update("game", gameId, { status: "confirmed", editable_until: new Date(ctx.now.getTime() + DISPUTE_HOURS * 3600_000) });
  if (g.rated) await rateGame(ctx, gameId);
}

export const resultConfirm = defineAction({
  name: "result.confirm", version: 1,
  input: z.object({ game_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const g = await gameView(ctx.db, i.game_id);
    if (g.status !== "awaiting_confirmation") throw new KumiError("error.result_answered");
    if (!g.b.some((p) => p.person_id === i.person_id)) throw new KumiError(g.a.some((p) => p.person_id === i.person_id) ? "error.other_side_confirms" : "error.not_in_match");
    const b = await bookingFacts(ctx.db, g.booking_id!);
    return { title: both("action.result.confirm"), summary: both("plan.result.confirm", { score: g.score, teamA: g.teamA, teamB: g.teamB, counts: both(g.rated ? "result.counts_rated" : "result.counts_friendly") }),
      reads: [{ entity: "game", id: g.id, version: g.version }], locationId: b.location_id, ownerIds: [i.person_id], undo: { kind: "none", note: both("result.undo_dispute") } };
  },
  async apply(ctx, i) {
    await answer(ctx, i.game_id, i.person_id, "b", "confirm");
    await count(ctx, i.game_id);
    await ctx.emit("result.confirmed", { game_id: i.game_id });
    return null;
  },
});

export const resultDispute = defineAction({
  name: "result.dispute", version: 1,
  input: z.object({ game_id: z.uuid(), person_id: z.uuid(), note: z.string().check(z.minLength(3), z.maxLength(300)) }),
  async plan(ctx, i) {
    const g = await gameView(ctx.db, i.game_id);
    const side = g.a.some((p) => p.person_id === i.person_id) ? "a" : g.b.some((p) => p.person_id === i.person_id) ? "b" : null;
    if (!side) throw new KumiError("error.not_in_match");
    const open = g.status === "awaiting_confirmation" || (g.status === "confirmed" && g.editable_until && g.editable_until > ctx.now);
    if (!open) throw new KumiError("error.dispute_closed", { hours: DISPUTE_HOURS });
    const b = await bookingFacts(ctx.db, g.booking_id!);
    return { title: both("action.result.dispute"), summary: both("plan.result.dispute", { score: g.score, teamA: g.teamA, teamB: g.teamB }),
      reads: [{ entity: "game", id: g.id, version: g.version }], locationId: b.location_id, ownerIds: [i.person_id], undo: { kind: "none" }, details: { side } };
  },
  async apply(ctx, i, plan) {
    const g = await ctx.trx.selectFrom("game").select(["status", "rated"]).where("id", "=", i.game_id).executeTakeFirstOrThrow();
    await answer(ctx, i.game_id, i.person_id, (plan.details as { side: "a" | "b" }).side, "dispute", i.note);
    await ctx.update("game", i.game_id, { status: "disputed" });
    // It had counted already: levels are replayed without it until the club decides.
    if (g.status === "confirmed" && g.rated) await recompute(ctx);
    await ctx.emit("result.disputed", { game_id: i.game_id, person_id: i.person_id, note: i.note });
    return null;
  },
});

export const resultResolve = defineAction({
  name: "result.resolve", version: 1,
  input: z.object({ game_id: z.uuid(), outcome: z.enum(["keep", "correct", "set_aside"]), sets: z.optional(z.array(z.object({ a: z.number().check(z.int(), z.minimum(0)), b: z.number().check(z.int(), z.minimum(0)) })).check(z.minLength(1), z.maxLength(5))),
    note: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const g = await gameView(ctx.db, i.game_id);
    if (g.status !== "disputed") throw new KumiError("error.not_disputed");
    if (i.outcome === "correct" && (!i.sets || i.sets.some((s) => s.a === s.b))) throw new KumiError("error.set_tied");
    const b = await bookingFacts(ctx.db, g.booking_id!);
    const p = { score: i.outcome === "correct" ? setsText(i.sets!) : g.score, teamA: g.teamA, teamB: g.teamB, court: b.court, when: b.when };
    return { title: both("action.result.resolve"), summary: both(`plan.result.${i.outcome}` as "plan.result.keep", p), reads: [{ entity: "game", id: g.id, version: g.version }],
      locationId: b.location_id, undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    if (i.outcome === "set_aside") {
      await ctx.update("game", i.game_id, { status: "void" });
      await answer(ctx, i.game_id, ctx.actor.personId, null, "set_aside", i.note);
    } else {
      if (i.outcome === "correct") {
        await ctx.trx.deleteFrom("game_set").where("game_id", "=", i.game_id).execute();
        await ctx.trx.insertInto("game_set").values(i.sets!.map((s, k) => ({ game_id: i.game_id, set_no: k + 1, a: s.a, b: s.b }))).execute();
      }
      await answer(ctx, i.game_id, ctx.actor.personId, null, i.outcome === "keep" ? "kept" : "corrected", i.note);
      await ctx.update("game", i.game_id, { status: "confirmed", editable_until: ctx.now });   // the club's word is final
    }
    // Levels as if this game had always been decided this way.
    const rated = (await ctx.trx.selectFrom("game").select("rated").where("id", "=", i.game_id).executeTakeFirstOrThrow()).rated;
    if (rated) {
      const already = await ctx.trx.selectFrom("rating_event").select("id").where("game_id", "=", i.game_id).where("kind", "=", "game").executeTakeFirst();
      if (already || i.outcome === "set_aside") await recompute(ctx); else await rateGame(ctx, i.game_id);
    }
    await ctx.emit("result.resolved", { game_id: i.game_id, outcome: i.outcome });
    return null;
  },
});

/** Kumi counts a score nobody answered in time. */
export const resultAutoConfirm = defineAction({
  name: "result.auto_confirm", version: 1, system: true, internal: true,
  input: z.object({ game_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "game", i.game_id, "thing.result");
    return { title: both("action.result.auto_confirm"), summary: both("action.result.auto_confirm"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const g = await ctx.trx.selectFrom("game").select(["status", "confirm_by"]).where("id", "=", i.game_id).forUpdate().executeTakeFirstOrThrow();
    if (g.status !== "awaiting_confirmation" || !g.confirm_by || g.confirm_by > ctx.now) return { already: true };
    await answer(ctx, i.game_id, null, null, "auto");
    await count(ctx, i.game_id);
    await ctx.emit("result.confirmed", { game_id: i.game_id, auto: true });
    return null;
  },
});

/** The job: scores nobody answered in time count as entered. */
export async function confirmScores(db: Db, now = new Date()) {
  const due = await db.selectFrom("game").select("id").where("status", "=", "awaiting_confirmation").where("confirm_by", "<=", now).execute();
  for (const g of due) await runAsSystem(db, "result.auto_confirm", { game_id: g.id }, "jobs", { now });
  return { confirmed: due.length };
}

/** The suggested teams for a booking with four players, and the odds shown (never stronger than 80/20). */
export async function suggestTeams(db: Db | Trx, bookingId: string) {
  const four = await fourOf(db, bookingId);
  if (four.length !== 4) return null;
  const t = fairTeams(four), odds = Math.round(shownOdds(t.p) * 100);
  return { a: t.a.map((p) => ({ person_id: p.person_id, name: p.display_name })), b: t.b.map((p) => ({ person_id: p.person_id, name: p.display_name })), odds: `${odds}/${100 - odds}` };
}
