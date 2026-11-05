// Tournaments and leagues: pairs enter together, staff make the draw, matches go on the program's own courts,
// and scores come from staff or from the players (with the usual confirmation, results.ts). A knockout match's
// winner moves on; a group's top two go to the knockout once the group is played; a league keeps its table.
// The pure rules are in brackets.ts.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx } from "./actions.ts";
import { groups, knockout, knockoutFromGroups, matchWinner, roundRobin, suggestTimes, table, MATCH_FORMATS, MATCH_MINUTES, type MatchFormat, type Need, type Placed, type Result, type Seeded, type Side, type Slot, type Spec } from "./brackets.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { areFriends } from "./friends.ts";
import { uuidv7 } from "./ids.ts";
import { MODEL, winChance } from "./levels.ts";
import { rateGame } from "./ratings.ts";

/** How long the other pair has to answer a score the players entered (as for court bookings, results.ts). */
const CONFIRM_HOURS = 48;
const LIVE = ["invited", "entered"] as const;
type Format = "groups_knockout" | "knockout" | "league";

async function programOf(db: Db | Trx, programId: string) {
  const { row: p, read } = await readRow(db, "program", programId, "thing.program");
  if (p.kind !== "tournament" && p.kind !== "league") throw new KumiError("error.not_a_competition");
  return { p, read };
}
async function drawnOf(db: Db | Trx, programId: string) {
  return db.selectFrom("competition").selectAll().where("program_id", "=", programId).where("status", "!=", "void").executeTakeFirst();
}
async function hasPlace(db: Db | Trx, programId: string, personId: string) {
  return Boolean(await db.selectFrom("enrolment").select("id").where("program_id", "=", programId).where("person_id", "=", personId).where("status", "=", "booked").executeTakeFirst());
}
async function liveEntry(db: Db | Trx, programId: string, personId: string, except?: string) {
  let q = db.selectFrom("pair_entry").select(["id", "person_a", "person_b", "status"]).where("program_id", "=", programId).where("status", "in", [...LIVE])
    .where((eb) => eb.or([eb("person_a", "=", personId), eb("person_b", "=", personId)]));
  if (except) q = q.where("id", "!=", except);
  return q.executeTakeFirst();
}
async function names(db: Db | Trx, ids: string[]) {
  return new Map((ids.length ? await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", ids).execute() : []).map((p) => [p.id, p.display_name]));
}
/** "Ana + Ben" for each entry. */
export async function pairNames(db: Db | Trx, entryIds: (string | null)[]) {
  const ids = [...new Set(entryIds.filter((x): x is string => Boolean(x)))];
  const rows = ids.length ? await db.selectFrom("pair_entry").select(["id", "person_a", "person_b"]).where("id", "in", ids).execute() : [];
  const n = await names(db, rows.flatMap((r) => [r.person_a, r.person_b]));
  return new Map(rows.map((r) => [r.id, `${n.get(r.person_a) ?? ""} + ${n.get(r.person_b) ?? ""}`]));
}
const levelOf = (l: string | null | undefined) => (l === null || l === undefined ? MODEL.defaultLevel : Number(l));
const lock = (trx: Trx, programId: string) => trx.selectFrom("program").select("id").where("id", "=", programId).forUpdate().executeTakeFirstOrThrow();
const notDrawn = async (db: Db | Trx, programId: string) => { if (await drawnOf(db, programId)) throw new KumiError("error.competition_drawn"); };

// ---- Entering with a partner ----

export const entryInvite = defineAction({
  name: "entry.invite", version: 1,
  input: z.object({ program_id: z.uuid(), person_id: z.uuid(), partner_id: z.uuid() }),
  async plan(ctx, i) {
    const { p, read } = await programOf(ctx.db, i.program_id);
    if (p.status !== "published") throw new KumiError("error.not_published");
    await notDrawn(ctx.db, i.program_id);
    if (i.partner_id === i.person_id) throw new KumiError("error.bad_partner");
    if (!(await hasPlace(ctx.db, i.program_id, i.person_id))) throw new KumiError("error.need_place_first");
    if (!(await areFriends(ctx.db, i.person_id, i.partner_id))) throw new KumiError("error.partner_not_friend");
    if (await liveEntry(ctx.db, i.program_id, i.person_id)) throw new KumiError("error.already_entered");
    if (await liveEntry(ctx.db, i.program_id, i.partner_id)) throw new KumiError("error.partner_entered");
    const partner = (await names(ctx.db, [i.partner_id])).get(i.partner_id) ?? "";
    const place = await hasPlace(ctx.db, i.program_id, i.partner_id);
    return { title: both("action.entry.invite"), summary: both(place ? "plan.entry.invite" : "plan.entry.invite_needs_place", { program: p.name, partner }), reads: [read],
      locationId: p.location_id, ownerIds: [i.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await lock(ctx.trx, i.program_id);
    if (await liveEntry(ctx.trx, i.program_id, i.person_id) || await liveEntry(ctx.trx, i.program_id, i.partner_id)) throw new KumiError("error.changed", {}, 409);
    const id = uuidv7();
    await ctx.insert("pair_entry", { id, program_id: i.program_id, person_a: i.person_id, person_b: i.partner_id, status: "invited", created_by: ctx.actor.personId });
    await ctx.emit("entry.invited", { entry_id: id });
    return { entry_id: id };
  },
});

async function answerable(db: Db | Trx, entryId: string, personId: string) {
  const { row: e, read } = await readRow(db, "pair_entry", entryId, "thing.entry");
  if (e.status !== "invited") throw new KumiError("error.entry_answered");
  if (e.person_b !== personId) throw new KumiError("error.not_your_invite");
  const { p } = await programOf(db, e.program_id);
  await notDrawn(db, e.program_id);
  return { e, p, read };
}

export const entryAccept = defineAction({
  name: "entry.accept", version: 1,
  input: z.object({ entry_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const { e, p, read } = await answerable(ctx.db, i.entry_id, i.person_id);
    if (!(await hasPlace(ctx.db, e.program_id, i.person_id))) throw new KumiError("error.need_place_first");
    if (await liveEntry(ctx.db, e.program_id, i.person_id, e.id)) throw new KumiError("error.already_entered");
    const partner = (await names(ctx.db, [e.person_a])).get(e.person_a) ?? "";
    return { title: both("action.entry.accept"), summary: both("plan.entry.accept", { program: p.name, partner }), reads: [read], locationId: p.location_id, ownerIds: [i.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const e = await ctx.trx.selectFrom("pair_entry").select(["program_id"]).where("id", "=", i.entry_id).executeTakeFirstOrThrow();
    await lock(ctx.trx, e.program_id);
    if (await liveEntry(ctx.trx, e.program_id, i.person_id, i.entry_id)) throw new KumiError("error.changed", {}, 409);
    await ctx.update("pair_entry", i.entry_id, { status: "entered", answered_at: ctx.now });
    await ctx.emit("entry.accepted", { entry_id: i.entry_id });
    return null;
  },
});

export const entryDecline = defineAction({
  name: "entry.decline", version: 1,
  input: z.object({ entry_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const { e, p, read } = await answerable(ctx.db, i.entry_id, i.person_id);
    const partner = (await names(ctx.db, [e.person_a])).get(e.person_a) ?? "";
    return { title: both("action.entry.decline"), summary: both("plan.entry.decline", { program: p.name, partner }), reads: [read], locationId: p.location_id, ownerIds: [i.person_id], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    await ctx.update("pair_entry", i.entry_id, { status: "declined", answered_at: ctx.now });
    await ctx.emit("entry.declined", { entry_id: i.entry_id });
    return null;
  },
});

/** Staff pair two people with places. */
export const entryPair = defineAction({
  name: "entry.pair", version: 1,
  input: z.object({ program_id: z.uuid(), person_a: z.uuid(), person_b: z.uuid() }),
  async plan(ctx, i) {
    const { p, read } = await programOf(ctx.db, i.program_id);
    await notDrawn(ctx.db, i.program_id);
    if (i.person_a === i.person_b) throw new KumiError("error.bad_partner");
    for (const who of [i.person_a, i.person_b]) {
      if (!(await hasPlace(ctx.db, i.program_id, who))) throw new KumiError("error.need_place_first");
      if (await liveEntry(ctx.db, i.program_id, who)) throw new KumiError("error.already_entered");
    }
    const n = await names(ctx.db, [i.person_a, i.person_b]);
    return { title: both("action.entry.pair"), summary: both("plan.entry.pair", { program: p.name, a: n.get(i.person_a) ?? "", b: n.get(i.person_b) ?? "" }), reads: [read], locationId: p.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await lock(ctx.trx, i.program_id);
    if (await liveEntry(ctx.trx, i.program_id, i.person_a) || await liveEntry(ctx.trx, i.program_id, i.person_b)) throw new KumiError("error.changed", {}, 409);
    const id = uuidv7();
    await ctx.insert("pair_entry", { id, program_id: i.program_id, person_a: i.person_a, person_b: i.person_b, status: "entered", created_by: ctx.actor.personId, answered_at: ctx.now });
    await ctx.emit("entry.accepted", { entry_id: id, by_staff: true });
    return { entry_id: id };
  },
});

/** A pair leaves the competition (either player, or staff). Once drawn, the matches it hasn't played go to the
 *  other pairs as walkovers; what's been played stands. Their places in the program are a separate decision. */
export const entryWithdraw = defineAction({
  name: "entry.withdraw", version: 1,
  input: z.object({ entry_id: z.uuid(), person_id: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const { row: e, read } = await readRow(ctx.db, "pair_entry", i.entry_id, "thing.entry");
    if (e.status !== "invited" && e.status !== "entered") throw new KumiError("error.entry_answered");
    if (i.person_id && i.person_id !== e.person_a && i.person_id !== e.person_b) throw new KumiError("error.not_your_invite");
    const { p } = await programOf(ctx.db, e.program_id);
    const open = await ctx.db.selectFrom("fixture").select("id").where("program_id", "=", e.program_id).where("status", "in", ["ready", "waiting"])
      .where((eb) => eb.or([eb("entry_a", "=", e.id), eb("entry_b", "=", e.id)])).execute();
    const pair = (await pairNames(ctx.db, [e.id])).get(e.id) ?? "";
    return { title: both("action.entry.withdraw"), summary: both("plan.entry.withdraw", { program: p.name, pair, count: open.length }), reads: [read], locationId: p.location_id,
      ...(i.person_id ? { ownerIds: [i.person_id] } : {}), undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const e = await ctx.trx.selectFrom("pair_entry").selectAll().where("id", "=", i.entry_id).executeTakeFirstOrThrow();
    await lock(ctx.trx, e.program_id);
    await ctx.update("pair_entry", e.id, { status: "withdrawn" });
    const open = await ctx.trx.selectFrom("fixture").selectAll().where("program_id", "=", e.program_id).where("status", "in", ["ready", "waiting"])
      .where((eb) => eb.or([eb("entry_a", "=", e.id), eb("entry_b", "=", e.id)])).orderBy("round").execute();
    for (const f of open) {
      const other = f.entry_a === e.id ? f.entry_b : f.entry_a;
      await voidLiveGame(ctx, f.id);
      if (other) await walkover(ctx, f.id, e.id, other);
      // Its opponent isn't known yet (a knockout match waiting on another): it goes through when they are.
      else await ctx.update("fixture", f.id, { [f.entry_a === e.id ? "from_a" : "from_b"]: "bye", [f.entry_a === e.id ? "entry_a" : "entry_b"]: null });
    }
    await ctx.emit("entry.withdrawn", { entry_id: e.id });
    return null;
  },
});

// ---- The draw ----

const formatsFor = (kind: string): Format[] => (kind === "league" ? ["league"] : ["groups_knockout", "knockout"]);

/** The pairs in the draw: entered, both players with a place, best average level first. */
async function drawEntries(db: Db | Trx, programId: string) {
  const rows = await db.selectFrom("pair_entry").select(["id", "person_a", "person_b", "created_at"]).where("program_id", "=", programId).where("status", "=", "entered").orderBy("created_at").execute();
  const people = rows.flatMap((r) => [r.person_a, r.person_b]);
  const levels = new Map((people.length ? await db.selectFrom("rating").select(["person_id", "level"]).where("person_id", "in", people).where("sport", "=", "padel").execute() : []).map((r) => [r.person_id, levelOf(r.level)]));
  const placed = new Set((people.length ? await db.selectFrom("enrolment").select("person_id").where("program_id", "=", programId).where("status", "=", "booked").where("person_id", "in", people).execute() : []).map((r) => r.person_id));
  const ok: Seeded[] = [], out: string[] = [];
  for (const r of rows) {
    if (!placed.has(r.person_a) || !placed.has(r.person_b)) { out.push(r.id); continue; }
    ok.push({ id: r.id, level: ((levels.get(r.person_a) ?? MODEL.defaultLevel) + (levels.get(r.person_b) ?? MODEL.defaultLevel)) / 2 });
  }
  ok.sort((x, y) => y.level - x.level);   // a stable sort: equal levels keep who entered first
  return { ok, out };
}

function buildDraw(format: Format, seeded: Seeded[], groupSize: 3 | 4, legs: 1 | 2): { specs: Spec[]; groupOf: Map<string, number> } {
  const groupOf = new Map<string, number>();
  if (format === "knockout") return { specs: knockout(seeded.map((s) => ({ entry: s.id }))), groupOf };
  if (format === "league") return { specs: roundRobin(seeded.map((s) => s.id), legs).map((m, k) => ({ key: `l${k}`, stage: "league" as const, round: m.round, slot: k, a: { entry: m.a }, b: { entry: m.b } })), groupOf };
  const gs = groups(seeded, groupSize), specs: Spec[] = [];
  gs.forEach((g, n) => { for (const s of g) groupOf.set(s.id, n + 1); roundRobin(g.map((s) => s.id)).forEach((m, k) => specs.push({ key: `g${n + 1}.${k}`, stage: "group", group: n + 1, round: m.round, slot: k, a: { entry: m.a }, b: { entry: m.b } })); });
  specs.push(...knockoutFromGroups(gs.length));
  return { specs, groupOf };
}

const formatText = (f: Format, groupSize: number, nGroups: number, legs: number): Text =>
  f === "knockout" ? both("plan.competition.knockout") : f === "league" ? both(legs === 2 ? "plan.competition.league_twice" : "plan.competition.league_once") : both("plan.competition.groups", { count: nGroups, size: groupSize });

export const competitionDraw = defineAction({
  name: "competition.draw", version: 1,
  input: z.object({ program_id: z.uuid(), format: z.enum(["groups_knockout", "knockout", "league"]), group_size: z.optional(z.union([z.literal(3), z.literal(4)])),
    match_format: z.optional(z.enum(["one_set", "pro_set", "best_of_three"])), legs: z.optional(z.union([z.literal(1), z.literal(2)])),
    match_minutes: z.optional(z.number().check(z.int(), z.minimum(15), z.maximum(240))) }),
  async plan(ctx, i) {
    const { p, read } = await programOf(ctx.db, i.program_id);
    if (!formatsFor(p.kind).includes(i.format)) throw new KumiError("error.wrong_competition_format");
    await notDrawn(ctx.db, i.program_id);
    const { ok, out } = await drawEntries(ctx.db, i.program_id);
    if (ok.length < (i.format === "groups_knockout" ? 3 : 2)) throw new KumiError("error.not_enough_pairs");
    const size = i.group_size ?? 4, legs = i.legs ?? 1, mf: MatchFormat = i.match_format ?? "one_set";
    const { specs, groupOf } = buildDraw(i.format, ok, size, legs);
    const pairs = await pairNames(ctx.db, [...ok.map((s) => s.id), ...out]);
    const seeds = ok.slice(0, 8).map((s, k) => `${k + 1}. ${pairs.get(s.id)} (${s.level.toFixed(2)})`).join(", ");
    const nGroups = new Set(groupOf.values()).size;
    const left = out.length ? both("plan.competition.left_out", { pairs: out.map((x) => pairs.get(x)).join(", ") }) : { en: "", es: "" };
    const matches = specs.filter((s) => !("bye" in s.a) && !("bye" in s.b)).length;
    return { title: both("action.competition.draw"), summary: both("plan.competition.draw", { program: p.name, pairs: ok.length, how: formatText(i.format, size, nGroups, legs), match: both(`match_format.${mf}`), matches, seeds, left }),
      reads: [read], locationId: p.location_id, undo: { kind: "reversible" },
      details: { specs, seeds: ok.map((s, k) => ({ id: s.id, seed: k + 1, level: s.level, group: groupOf.get(s.id) ?? null })), format: i.format, size, legs, mf, minutes: i.match_minutes ?? MATCH_MINUTES[mf] } };
  },
  async apply(ctx, i, plan) {
    const det = plan.details as { specs: Spec[]; seeds: { id: string; seed: number; level: number; group: number | null }[]; format: Format; size: number; legs: number; mf: MatchFormat; minutes: number };
    await lock(ctx.trx, i.program_id);
    if (await drawnOf(ctx.trx, i.program_id)) throw new KumiError("error.competition_drawn");
    await ctx.insert("competition", { program_id: i.program_id, format: det.format, group_size: det.format === "groups_knockout" ? det.size : null, match_format: det.mf, match_minutes: det.minutes, legs: det.legs, status: "drawn" });
    for (const s of det.seeds) await ctx.update("pair_entry", s.id, { seed: s.seed, group_no: s.group, level: s.level.toFixed(2) });
    const id = new Map(det.specs.map((s) => [s.key, uuidv7()]));
    const sideCols = (s: Side) => ("entry" in s ? { entry: s.entry, from: null } : "bye" in s ? { entry: null, from: "bye" } : { entry: null, from: s.from.startsWith("w:") ? `w:${id.get(s.from.slice(2))}` : s.from });
    // Later rounds first, so each match's next one is already there.
    for (const s of [...det.specs].sort((x, y) => (y.stage === "knockout" ? y.round : 0) - (x.stage === "knockout" ? x.round : 0))) {
      const a = sideCols(s.a), b = sideCols(s.b);
      await ctx.insert("fixture", { id: id.get(s.key)!, program_id: i.program_id, stage: s.stage, group_no: s.group ?? null, round: s.round, slot: s.slot, entry_a: a.entry, entry_b: b.entry, from_a: a.from, from_b: b.from,
        status: a.entry && b.entry ? "ready" : "waiting", next_id: s.next ? id.get(s.next.key)! : null, next_side: s.next?.side ?? null });
    }
    // Byes: the pair facing nobody goes straight through.
    for (const s of det.specs) if (s.round === 1 && s.stage === "knockout") await refresh(ctx, id.get(s.key)!);
    await ctx.emit("competition.drawn", { program_id: i.program_id });
    return null;
  },
});

// ---- What a result does next ----

/** A fixture whose sides have changed: through on a bye, ready when both pairs are known, otherwise waiting. */
async function refresh(ctx: ApplyCtx, fixtureId: string) {
  const f = await ctx.trx.selectFrom("fixture").selectAll().where("id", "=", fixtureId).executeTakeFirstOrThrow();
  if (f.status === "played" || f.status === "walkover" || f.status === "void") return;
  const one = f.entry_a && f.from_b === "bye" ? f.entry_a : f.entry_b && f.from_a === "bye" ? f.entry_b : null;
  if (one) { await ctx.update("fixture", f.id, { status: "bye", winner: one }); await advance(ctx, f.id, one); return; }
  if (f.from_a === "bye" && f.from_b === "bye") { await ctx.update("fixture", f.id, { status: "bye", winner: null }); if (f.next_id) await setSide(ctx, f.next_id, f.next_side!, null, "bye"); return; }
  await ctx.update("fixture", f.id, { status: f.entry_a && f.entry_b ? "ready" : "waiting" });
}
async function setSide(ctx: ApplyCtx, fixtureId: string, side: "a" | "b", entry: string | null, from?: string) {
  await ctx.update("fixture", fixtureId, { [`entry_${side}`]: entry, ...(from ? { [`from_${side}`]: from } : {}) });
  await refresh(ctx, fixtureId);
}
/** The winner of a knockout match into the next one; a group's last result fills its places in the knockout. */
async function advance(ctx: ApplyCtx, fixtureId: string, winner: string) {
  const f = await ctx.trx.selectFrom("fixture").selectAll().where("id", "=", fixtureId).executeTakeFirstOrThrow();
  if (f.next_id) await setSide(ctx, f.next_id, f.next_side!, winner);
  if (f.stage === "group") await groupDone(ctx, f.program_id, f.group_no!);
  await finishedYet(ctx, f.program_id);
}
async function groupDone(ctx: ApplyCtx, programId: string, groupNo: number) {
  const fs = await ctx.trx.selectFrom("fixture").selectAll().where("program_id", "=", programId).where("stage", "=", "group").where("group_no", "=", groupNo).where("status", "!=", "void").execute();
  if (fs.some((f) => f.status === "ready" || f.status === "waiting")) return;
  const entries = (await ctx.trx.selectFrom("pair_entry").select("id").where("program_id", "=", programId).where("group_no", "=", groupNo).orderBy("seed").execute()).map((e) => e.id);
  const rows = table(entries, await resultsOf(ctx.trx, fs), "group");
  for (const [k, r] of rows.slice(0, 2).entries()) {
    for (const side of ["a", "b"] as const) {
      const ko = await ctx.trx.selectFrom("fixture").select(["id"]).where("program_id", "=", programId).where("stage", "=", "knockout").where(`from_${side}`, "=", `g${groupNo}:${k + 1}`).execute();
      for (const x of ko) await setSide(ctx, x.id, side, r.entry);
    }
  }
}
async function finishedYet(ctx: ApplyCtx, programId: string) {
  const open = await ctx.trx.selectFrom("fixture").select("id").where("program_id", "=", programId).where("status", "in", ["ready", "waiting"]).executeTakeFirst();
  if (!open) await ctx.update("competition", programId, { status: "finished" });
}

/** The scores of decided fixtures, as brackets.ts reads them. */
export async function resultsOf(db: Db | Trx, fs: { id: string; entry_a: string | null; entry_b: string | null; winner: string | null; walkover_by: string | null; status: string }[]): Promise<Result[]> {
  const decided = fs.filter((f) => (f.status === "played" || f.status === "walkover") && f.entry_a && f.entry_b);
  const games = decided.length ? await db.selectFrom("game").select(["id", "fixture_id"]).where("fixture_id", "in", decided.map((f) => f.id)).where("status", "=", "confirmed").execute() : [];
  const sets = games.length ? await db.selectFrom("game_set").select(["game_id", "set_no", "a", "b"]).where("game_id", "in", games.map((g) => g.id)).orderBy("set_no").execute() : [];
  const sides = games.length ? await db.selectFrom("game_side").select(["game_id", "side", "person_id"]).where("game_id", "in", games.map((g) => g.id)).execute() : [];
  const entries = new Map((decided.length ? await db.selectFrom("pair_entry").select(["id", "person_a"]).where("id", "in", decided.flatMap((f) => [f.entry_a!, f.entry_b!])).execute() : []).map((e) => [e.id, e.person_a]));
  return decided.map((f) => {
    const g = games.find((x) => x.fixture_id === f.id);
    // The game's side a is whoever entered it: turn its sets round to the fixture's side a.
    const flip = g ? sides.some((s) => s.game_id === g.id && s.side === "b" && s.person_id === entries.get(f.entry_a!)) : false;
    const ss = g ? sets.filter((s) => s.game_id === g.id).map((s) => (flip ? { a: s.b, b: s.a } : { a: s.a, b: s.b })) : [];
    return { a: f.entry_a!, b: f.entry_b!, winner: f.winner, walkover: f.walkover_by, sets: ss };
  });
}

/** A confirmed score decides its fixture (results.ts calls this when a fixture's game counts). */
export async function fixtureDecided(ctx: ApplyCtx, gameId: string) {
  const g = await ctx.trx.selectFrom("game").select(["fixture_id"]).where("id", "=", gameId).executeTakeFirstOrThrow();
  if (!g.fixture_id) return;
  const f = await ctx.trx.selectFrom("fixture").selectAll().where("id", "=", g.fixture_id).executeTakeFirstOrThrow();
  const sets = await ctx.trx.selectFrom("game_set").select(["a", "b"]).where("game_id", "=", gameId).orderBy("set_no").execute();
  const aPeople = (await ctx.trx.selectFrom("game_side").select("person_id").where("game_id", "=", gameId).where("side", "=", "a").execute()).map((s) => s.person_id);
  const ea = await ctx.trx.selectFrom("pair_entry").select(["person_a", "person_b"]).where("id", "=", f.entry_a!).executeTakeFirstOrThrow();
  const gameAIsFixtureA = aPeople.includes(ea.person_a) || aPeople.includes(ea.person_b);
  const wonA = sets.filter((s) => s.a > s.b).length > sets.filter((s) => s.b > s.a).length;
  const winner = (wonA === gameAIsFixtureA ? f.entry_a : f.entry_b)!;
  await ctx.update("fixture", f.id, { status: "played", winner });
  await advance(ctx, f.id, winner);
  await ctx.emit("fixture.decided", { fixture_id: f.id });
}
/** A score set aside or disputed: the fixture is open again, and what it had decided is taken back (while that
 *  hasn't been played: results.ts refuses a dispute once the next match is played). */
export async function fixtureUndecided(ctx: ApplyCtx, gameId: string) {
  const g = await ctx.trx.selectFrom("game").select(["fixture_id"]).where("id", "=", gameId).executeTakeFirstOrThrow();
  if (!g.fixture_id) return;
  const f = await ctx.trx.selectFrom("fixture").selectAll().where("id", "=", g.fixture_id).executeTakeFirstOrThrow();
  if (f.status !== "played") return;
  await ctx.update("fixture", f.id, { status: "ready", winner: null });
  if (f.next_id) await setSide(ctx, f.next_id, f.next_side!, null);
  if (f.stage === "group") {
    const ko = await ctx.trx.selectFrom("fixture").select(["id", "from_a", "from_b", "status"]).where("program_id", "=", f.program_id).where("stage", "=", "knockout")
      .where((eb) => eb.or([eb("from_a", "like", `g${f.group_no}:%`), eb("from_b", "like", `g${f.group_no}:%`)])).execute();
    for (const x of ko) {
      if (x.from_a?.startsWith(`g${f.group_no}:`)) await setSide(ctx, x.id, "a", null);
      if (x.from_b?.startsWith(`g${f.group_no}:`)) await setSide(ctx, x.id, "b", null);
    }
  }
  await ctx.update("competition", f.program_id, { status: "drawn" });
}
/** Whether a fixture's result can still be changed: not once the match it led to has been decided. */
export async function fixtureLocked(db: Db | Trx, fixtureId: string) {
  const f = await db.selectFrom("fixture").select(["next_id", "stage", "program_id", "group_no"]).where("id", "=", fixtureId).executeTakeFirst();
  if (!f) return false;
  if (f.next_id) { const n = await db.selectFrom("fixture").select("status").where("id", "=", f.next_id).executeTakeFirst(); if (n && (n.status === "played" || n.status === "walkover")) return true; }
  if (f.stage === "group") {
    const ko = await db.selectFrom("fixture").select("id").where("program_id", "=", f.program_id).where("stage", "=", "knockout").where("status", "in", ["played", "walkover"])
      .where((eb) => eb.or([eb("from_a", "like", `g${f.group_no}:%`), eb("from_b", "like", `g${f.group_no}:%`)])).executeTakeFirst();
    if (ko) return true;
  }
  return false;
}
async function voidLiveGame(ctx: ApplyCtx, fixtureId: string) {
  const g = await ctx.trx.selectFrom("game").select("id").where("fixture_id", "=", fixtureId).where("status", "!=", "void").executeTakeFirst();
  if (g) await ctx.update("game", g.id, { status: "void" });
}
async function walkover(ctx: ApplyCtx, fixtureId: string, givenBy: string, winner: string) {
  await ctx.update("fixture", fixtureId, { status: "walkover", walkover_by: givenBy, winner });
  await advance(ctx, fixtureId, winner);
}

// ---- Times and courts ----

/** The program's own courts and dates, cut into match-length slots. */
async function slotsOf(db: Db | Trx, programId: string, minutes: number): Promise<{ slots: Slot[]; courts: Map<string, string> }> {
  const rows = await db.selectFrom("court_time").innerJoin("session", "session.id", "court_time.session_id").innerJoin("court", "court.id", "court_time.court_id")
    .select(["court.id as court_id", "court.name", "session.id as session_id", "session.starts_at", "session.ends_at"])
    .where("session.program_id", "=", programId).where("session.status", "!=", "cancelled").where("court_time.active", "=", true).orderBy("session.starts_at").orderBy("court.sort").orderBy("court.name").execute();
  const sessions = [...new Set(rows.map((r) => r.session_id))];
  const slots: Slot[] = [];
  for (const r of rows) for (let t = r.starts_at.getTime(); t + minutes * 60_000 <= r.ends_at.getTime(); t += minutes * 60_000) slots.push({ court: r.court_id, start: t, end: t + minutes * 60_000, session: sessions.indexOf(r.session_id) });
  return { slots, courts: new Map(rows.map((r) => [r.court_id, r.name])) };
}
async function placedOf(db: Db | Trx, programId: string): Promise<Placed[]> {
  const fs = await db.selectFrom("fixture").select(["id", "court_id", "starts_at", "ends_at", "entry_a", "entry_b"]).where("program_id", "=", programId).where("status", "!=", "void").where("starts_at", "is not", null).execute();
  return fs.map((f) => ({ id: f.id, court: f.court_id!, start: f.starts_at!.getTime(), end: f.ends_at!.getTime(), entries: [f.entry_a, f.entry_b].filter((x): x is string => Boolean(x)) }));
}
/** What each match waits for: a knockout match its earlier ones (or its groups); a league round its date. */
function needsOf(fs: { id: string; stage: string; round: number; group_no: number | null; from_a: string | null; from_b: string | null; entry_a: string | null; entry_b: string | null; status: string; starts_at: Date | null }[]): Need[] {
  const groupMatches = (n: string) => fs.filter((f) => f.stage === "group" && f.group_no === Number(n) && f.status !== "bye").map((f) => f.id);
  const order = [...fs].sort((x, y) => (x.stage === "knockout" ? 1 : 0) - (y.stage === "knockout" ? 1 : 0) || x.round - y.round || (x.group_no ?? 0) - (y.group_no ?? 0));
  const byes = new Set(fs.filter((f) => f.status === "bye").map((f) => f.id));
  return order.filter((f) => !f.starts_at && (f.status === "ready" || f.status === "waiting")).map((f) => {
    const deps: string[] = [];
    for (const from of [f.from_a, f.from_b]) {
      if (!from) continue;
      if (from.startsWith("w:")) { const d = from.slice(2); if (!byes.has(d)) deps.push(d); }
      else if (from.startsWith("g")) deps.push(...groupMatches(from.slice(1).split(":")[0]!));
    }
    return { id: f.id, entries: [f.entry_a, f.entry_b].filter((x): x is string => Boolean(x)), deps: [...new Set(deps)], ...(f.stage === "league" ? { minSession: f.round - 1 } : {}) };
  });
}

export const competitionSchedule = defineAction({
  name: "competition.schedule", version: 1,
  input: z.object({ program_id: z.uuid() }),
  async plan(ctx, i) {
    const { p, read } = await programOf(ctx.db, i.program_id);
    const c = await drawnOf(ctx.db, i.program_id);
    if (!c) throw new KumiError("error.no_competition_draw");
    const { slots, courts } = await slotsOf(ctx.db, i.program_id, c.match_minutes);
    const fs = await ctx.db.selectFrom("fixture").selectAll().where("program_id", "=", i.program_id).where("status", "!=", "void").execute();
    const res = suggestTimes(needsOf(fs), slots, await placedOf(ctx.db, i.program_id));
    if (!res.placed.length) throw new KumiError(res.unplaced.length ? "error.no_room_for_matches" : "error.nothing_to_place");
    const tz = await clubTz(ctx.db);
    const first = Math.min(...res.placed.map((x) => x.start)), last = Math.max(...res.placed.map((x) => x.start));
    return { title: both("action.competition.schedule"), summary: both("plan.competition.schedule", { count: res.placed.length, courts: [...new Set(res.placed.map((x) => courts.get(x.court)))].join(", "),
      first: { en: dateTime(new Date(first), "en", tz), es: dateTime(new Date(first), "es", tz) }, last: { en: dateTime(new Date(last), "en", tz), es: dateTime(new Date(last), "es", tz) },
      unplaced: res.unplaced.length ? both("plan.competition.unplaced", { count: res.unplaced.length }) : { en: "", es: "" } }),
      reads: [read], locationId: p.location_id, undo: { kind: "compensating" }, details: { placed: res.placed } };
  },
  async apply(ctx, i, plan) {
    await lock(ctx.trx, i.program_id);
    const taken = await placedOf(ctx.trx, i.program_id);
    for (const x of (plan.details as { placed: Placed[] }).placed) {
      if (taken.some((t) => t.id !== x.id && t.court === x.court && t.start < x.end && x.start < t.end)) throw new KumiError("error.changed", {}, 409);
      await ctx.update("fixture", x.id, { court_id: x.court, starts_at: new Date(x.start), ends_at: new Date(x.end) });
      await ctx.emit("fixture.placed", { fixture_id: x.id });
    }
    return null;
  },
});

/** Staff put one match on a court and time of the program's own (or move it there). */
export const fixturePlace = defineAction({
  name: "fixture.place", version: 1,
  input: z.object({ fixture_id: z.uuid(), court_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }) }),
  async plan(ctx, i) {
    const { row: f, read } = await readRow(ctx.db, "fixture", i.fixture_id, "thing.match");
    if (f.status !== "ready" && f.status !== "waiting") throw new KumiError("error.match_decided");
    const { p } = await programOf(ctx.db, f.program_id);
    const c = (await drawnOf(ctx.db, f.program_id))!;
    const start = new Date(i.starts_at), end = new Date(start.getTime() + c.match_minutes * 60_000);
    const { slots, courts } = await slotsOf(ctx.db, f.program_id, 1);
    const inside = await ctx.db.selectFrom("court_time").innerJoin("session", "session.id", "court_time.session_id").select("court_time.id")
      .where("session.program_id", "=", f.program_id).where("court_time.court_id", "=", i.court_id).where("court_time.active", "=", true)
      .where("session.starts_at", "<=", start).where("session.ends_at", ">=", end).executeTakeFirst();
    void slots;
    if (!inside) throw new KumiError("error.not_program_court_time");
    const others = (await placedOf(ctx.db, f.program_id)).filter((x) => x.id !== f.id && x.start < end.getTime() && start.getTime() < x.end);
    if (others.some((x) => x.court === i.court_id)) throw new KumiError("error.court_taken_by_match");
    if (others.some((x) => x.entries.some((e) => e === f.entry_a || e === f.entry_b))) throw new KumiError("error.pair_busy");
    const tz = await clubTz(ctx.db), pairs = await pairNames(ctx.db, [f.entry_a, f.entry_b]);
    return { title: both("action.fixture.place"), summary: both("plan.fixture.place", { a: pairs.get(f.entry_a) ?? "?", b: pairs.get(f.entry_b) ?? "?", court: courts.get(i.court_id) ?? "",
      when: { en: dateTime(start, "en", tz), es: dateTime(start, "es", tz) } }), reads: [read], locationId: p.location_id, undo: { kind: "reversible" }, details: { end: end.toISOString() } };
  },
  async apply(ctx, i, plan) {
    const f = await ctx.trx.selectFrom("fixture").select("program_id").where("id", "=", i.fixture_id).executeTakeFirstOrThrow();
    await lock(ctx.trx, f.program_id);
    const start = new Date(i.starts_at), end = new Date((plan.details as { end: string }).end);
    if ((await placedOf(ctx.trx, f.program_id)).some((x) => x.id !== i.fixture_id && x.court === i.court_id && x.start < end.getTime() && start.getTime() < x.end)) throw new KumiError("error.court_taken_by_match", {}, 409);
    await ctx.update("fixture", i.fixture_id, { court_id: i.court_id, starts_at: start, ends_at: end, move_asked: null, move_asked_by: null, move_asked_at: null });
    await ctx.emit("fixture.placed", { fixture_id: i.fixture_id, moved: true });
    return null;
  },
});

/** A player asks the club to move a match (the club moves it: players don't pick times themselves). */
export const fixtureAskMove = defineAction({
  name: "fixture.ask_move", version: 1,
  input: z.object({ fixture_id: z.uuid(), person_id: z.uuid(), note: z.string().check(z.minLength(3), z.maxLength(300)) }),
  async plan(ctx, i) {
    const { f, p, read } = await myFixture(ctx.db, i.fixture_id, i.person_id);
    if (f.status !== "ready" && f.status !== "waiting") throw new KumiError("error.match_decided");
    return { title: both("action.fixture.ask_move"), summary: both("plan.fixture.ask_move", { program: p.name }), reads: [read], locationId: p.location_id, ownerIds: [i.person_id], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    await ctx.update("fixture", i.fixture_id, { move_asked: i.note, move_asked_by: i.person_id, move_asked_at: ctx.now });
    await ctx.emit("fixture.move_asked", { fixture_id: i.fixture_id, person_id: i.person_id, note: i.note });
    return null;
  },
});

// ---- Scores ----

async function myFixture(db: Db | Trx, fixtureId: string, personId: string) {
  const { row: f, read } = await readRow(db, "fixture", fixtureId, "thing.match");
  const es = await db.selectFrom("pair_entry").select(["id", "person_a", "person_b"]).where("id", "in", [f.entry_a, f.entry_b].filter(Boolean)).execute();
  const mine = es.find((e) => e.person_a === personId || e.person_b === personId);
  if (!mine) throw new KumiError("error.not_in_match");
  const { p } = await programOf(db, f.program_id);
  return { f, p, read, mine, theirs: es.find((e) => e !== mine) };
}
async function scorable(db: Db | Trx, f: Record<string, any>, now: Date) {
  if (f.status !== "ready") throw new KumiError(f.status === "waiting" ? "error.match_not_ready" : "error.match_decided");
  if (f.starts_at && now.getTime() < new Date(f.starts_at).getTime()) throw new KumiError("error.not_played_yet");
  if (await db.selectFrom("game").select("id").where("fixture_id", "=", f.id).where("status", "!=", "void").executeTakeFirst()) throw new KumiError("error.score_entered");
  return (await drawnOf(db, f.program_id))!;
}
const setsInput = z.array(z.object({ a: z.number().check(z.int(), z.minimum(0), z.maximum(99)), b: z.number().check(z.int(), z.minimum(0), z.maximum(99)) })).check(z.minLength(1), z.maxLength(3));
const setsText = (sets: { a: number; b: number }[]) => sets.map((s) => `${s.a}-${s.b}`).join(" ");
async function skills(db: Db | Trx, people: string[]) {
  const r = new Map((await db.selectFrom("rating").select(["person_id", "mu", "sigma", "level"]).where("person_id", "in", people).where("sport", "=", "padel").execute()).map((x) => [x.person_id, x]));
  return people.map((id) => { const x = r.get(id); return { mu: x?.mu ?? levelOf(x?.level), sigma: x?.sigma ?? MODEL.sigmaNew }; });
}
/** The game for a fixture, with the two pairs as its sides (side a = `first`). */
async function writeGame(ctx: ApplyCtx, f: Record<string, any>, first: { person_a: string; person_b: string }, second: { person_a: string; person_b: string }, sets: { a: number; b: number }[], status: "confirmed" | "awaiting_confirmation") {
  const rated = (await ctx.trx.selectFrom("program").select("rated").where("id", "=", f.program_id).executeTakeFirstOrThrow()).rated;
  const a = [first.person_a, first.person_b], b = [second.person_a, second.person_b];
  const id = uuidv7();
  try {
    await ctx.insert("game", { id, fixture_id: f.id, court_id: f.court_id, format: "doubles", rated, status, played_at: f.starts_at ?? ctx.now, entered_by: ctx.actor.personId,
      predicted_a: winChance(await skills(ctx.trx, a), await skills(ctx.trx, b)).toFixed(3),
      ...(status === "confirmed" ? { editable_until: ctx.now } : { confirm_by: new Date(ctx.now.getTime() + CONFIRM_HOURS * 3600_000) }) });
  } catch (e: any) { if (e?.code === "23505") throw new KumiError("error.score_entered"); throw e; }
  await ctx.trx.insertInto("game_side").values([...a.map((p) => ({ game_id: id, side: "a" as const, person_id: p })), ...b.map((p) => ({ game_id: id, side: "b" as const, person_id: p }))]).execute();
  await ctx.trx.insertInto("game_set").values(sets.map((s, k) => ({ game_id: id, set_no: k + 1, a: s.a, b: s.b }))).execute();
  return { id, rated };
}

/** Staff enter a match's score; it counts at once. */
export const fixtureScore = defineAction({
  name: "fixture.score", version: 1,
  input: z.object({ fixture_id: z.uuid(), sets: setsInput }),
  async plan(ctx, i) {
    const { row: f, read } = await readRow(ctx.db, "fixture", i.fixture_id, "thing.match");
    const { p } = await programOf(ctx.db, f.program_id);
    const c = await scorable(ctx.db, f, ctx.now);
    if (!matchWinner(c.match_format as MatchFormat, i.sets)) throw new KumiError("error.bad_match_score", { format: both(`match_format.${c.match_format}` as "match_format.one_set") }, 400);
    const pairs = await pairNames(ctx.db, [f.entry_a, f.entry_b]);
    return { title: both("action.fixture.score"), summary: both("plan.fixture.score", { a: pairs.get(f.entry_a)!, b: pairs.get(f.entry_b)!, score: setsText(i.sets), counts: both(p.rated ? "result.counts_rated" : "result.counts_friendly") }),
      reads: [read], locationId: p.location_id, undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const f = await ctx.trx.selectFrom("fixture").selectAll().where("id", "=", i.fixture_id).forUpdate().executeTakeFirstOrThrow();
    if (f.status !== "ready") throw new KumiError("error.changed", {}, 409);
    const [ea, eb] = await Promise.all([f.entry_a!, f.entry_b!].map((e) => ctx.trx.selectFrom("pair_entry").select(["person_a", "person_b"]).where("id", "=", e).executeTakeFirstOrThrow()));
    const g = await writeGame(ctx, f, ea!, eb!, i.sets, "confirmed");
    if (g.rated) await rateGame(ctx, g.id);
    await fixtureDecided(ctx, g.id);
    await ctx.emit("game.scored", { game_id: g.id });
    return { game_id: g.id };
  },
});

/** A player enters their match's score; the other pair confirms or disputes it (results.ts), and with no answer
 *  in two days it counts. */
export const fixtureEnter = defineAction({
  name: "fixture.enter", version: 1,
  input: z.object({ fixture_id: z.uuid(), person_id: z.uuid(), sets: z.array(z.object({ us: z.number().check(z.int(), z.minimum(0), z.maximum(99)), them: z.number().check(z.int(), z.minimum(0), z.maximum(99)) })).check(z.minLength(1), z.maxLength(3)) }),
  async plan(ctx, i) {
    const { f, p, read, theirs } = await myFixture(ctx.db, i.fixture_id, i.person_id);
    const c = await scorable(ctx.db, f, ctx.now);
    if (!f.starts_at) throw new KumiError("error.match_not_placed");
    const sets = i.sets.map((s) => ({ a: s.us, b: s.them }));
    const w = matchWinner(c.match_format as MatchFormat, sets);
    if (!w) throw new KumiError("error.bad_match_score", { format: both(`match_format.${c.match_format}` as "match_format.one_set") }, 400);
    const pairs = await pairNames(ctx.db, [theirs?.id ?? null]);
    return { title: both("action.fixture.enter"), summary: both("plan.fixture.enter", { opponents: pairs.get(theirs!.id) ?? "", result: both(w === "a" ? "result.won" : "result.lost"), score: setsText(sets), hours: CONFIRM_HOURS,
      counts: both(p.rated ? "result.counts_rated" : "result.counts_friendly") }), reads: [read], locationId: p.location_id, ownerIds: [i.person_id], undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const f = await ctx.trx.selectFrom("fixture").selectAll().where("id", "=", i.fixture_id).forUpdate().executeTakeFirstOrThrow();
    if (f.status !== "ready") throw new KumiError("error.changed", {}, 409);
    const es = await ctx.trx.selectFrom("pair_entry").select(["id", "person_a", "person_b"]).where("id", "in", [f.entry_a!, f.entry_b!]).execute();
    const mine = es.find((e) => e.person_a === i.person_id || e.person_b === i.person_id)!, theirs = es.find((e) => e !== mine)!;
    const g = await writeGame(ctx, f, mine, theirs, i.sets.map((s) => ({ a: s.us, b: s.them })), "awaiting_confirmation");
    await ctx.trx.insertInto("result_answer").values({ id: uuidv7(), game_id: g.id, person_id: i.person_id, side: "a", answer: "entered", note: null, at: ctx.now }).execute();
    await ctx.emit("result.entered", { game_id: g.id });
    return { game_id: g.id };
  },
});

/** A pair didn't come (or can't play): the other goes through, or takes the league's points. */
export const fixtureWalkover = defineAction({
  name: "fixture.walkover", version: 1,
  input: z.object({ fixture_id: z.uuid(), given_by: z.uuid() }),
  async plan(ctx, i) {
    const { row: f, read } = await readRow(ctx.db, "fixture", i.fixture_id, "thing.match");
    if (f.status !== "ready") throw new KumiError(f.status === "waiting" ? "error.match_not_ready" : "error.match_decided");
    if (i.given_by !== f.entry_a && i.given_by !== f.entry_b) throw new KumiError("error.not_in_match");
    const { p } = await programOf(ctx.db, f.program_id);
    const pairs = await pairNames(ctx.db, [f.entry_a, f.entry_b]);
    const winner = i.given_by === f.entry_a ? f.entry_b : f.entry_a;
    return { title: both("action.fixture.walkover"), summary: both("plan.fixture.walkover", { gave: pairs.get(i.given_by)!, winner: pairs.get(winner)! }), reads: [read], locationId: p.location_id, undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const f = await ctx.trx.selectFrom("fixture").selectAll().where("id", "=", i.fixture_id).forUpdate().executeTakeFirstOrThrow();
    if (f.status !== "ready") throw new KumiError("error.changed", {}, 409);
    await voidLiveGame(ctx, f.id);
    await walkover(ctx, f.id, i.given_by, (i.given_by === f.entry_a ? f.entry_b : f.entry_a)!);
    await ctx.emit("fixture.decided", { fixture_id: f.id, walkover: true });
    return null;
  },
});

async function clubTz(db: Db | Trx) {
  return (await db.selectFrom("club").select("time_zone").executeTakeFirst())?.time_zone ?? "UTC";
}

// ---- What people see ----

export interface FixtureView { id: string; stage: string; group: number | null; round: number; a: string; b: string; a_id: string | null; b_id: string | null; status: string; winner: string | null;
  court: string | null; starts_at: Date | null; score: string; walkover: boolean; move_asked: string | null; game_id: string | null; game_status: string | null }
/** The whole draw: entries, fixtures with their scores, each group's table (or the league's). */
export async function competitionView(db: Db | Trx, programId: string) {
  const c = await drawnOf(db, programId);
  const entries = await db.selectFrom("pair_entry").selectAll().where("program_id", "=", programId).where("status", "in", ["invited", "entered", "withdrawn"]).orderBy("seed").orderBy("created_at").execute();
  const pairs = await pairNames(db, entries.map((e) => e.id));
  const fs = c ? await db.selectFrom("fixture").leftJoin("court", "court.id", "fixture.court_id").selectAll("fixture").select("court.name as court").where("fixture.program_id", "=", programId).where("fixture.status", "!=", "void")
    .orderBy("fixture.stage").orderBy("fixture.group_no").orderBy("fixture.round").orderBy("fixture.slot").execute() : [];
  const games = fs.length ? await db.selectFrom("game").select(["id", "fixture_id", "status"]).where("fixture_id", "in", fs.map((f) => f.id)).where("status", "!=", "void").execute() : [];
  const res = await resultsOf(db, fs);
  const label = (from: string | null) => (!from ? "" : from === "bye" ? "bye" : from.startsWith("g") ? `g${from.slice(1)}` : "winner");
  const fixtures: FixtureView[] = fs.map((f) => {
    const g = games.find((x) => x.fixture_id === f.id), r = res.find((x) => x.a === f.entry_a && x.b === f.entry_b && x.winner === f.winner && (f.status === "played" || f.status === "walkover"));
    return { id: f.id, stage: f.stage, group: f.group_no, round: f.round, a: f.entry_a ? pairs.get(f.entry_a) ?? "" : label(f.from_a), b: f.entry_b ? pairs.get(f.entry_b) ?? "" : label(f.from_b),
      a_id: f.entry_a, b_id: f.entry_b, status: f.status, winner: f.winner, court: f.court, starts_at: f.starts_at, score: f.status === "played" && r ? setsText(r.sets) : "", walkover: f.status === "walkover",
      move_asked: f.move_asked, game_id: g?.id ?? null, game_status: g?.status ?? null };
  });
  const tables: { group: number | null; rows: (ReturnType<typeof table>[number] & { name: string })[] }[] = [];
  if (c?.format === "league") tables.push({ group: null, rows: table(entries.filter((e) => e.seed !== null).map((e) => e.id), res, "league").map((r) => ({ ...r, name: pairs.get(r.entry) ?? "" })) });
  if (c?.format === "groups_knockout") for (const g of [...new Set(entries.map((e) => e.group_no).filter((x): x is number => x !== null))].sort())
    tables.push({ group: g, rows: table(entries.filter((e) => e.group_no === g).map((e) => e.id), await resultsOf(db, fs.filter((f) => f.stage === "group" && f.group_no === g)), "group").map((r) => ({ ...r, name: pairs.get(r.entry) ?? "" })) });
  return { competition: c ?? null, entries: entries.map((e) => ({ id: e.id, name: pairs.get(e.id) ?? "", status: e.status, seed: e.seed, group: e.group_no, level: e.level, person_a: e.person_a, person_b: e.person_b })), fixtures, tables };
}

/** A member's own: invitations to answer, entries, their next matches and the tables they're in. */
export async function myCompetitions(db: Db | Trx, personId: string) {
  const mine = await db.selectFrom("pair_entry").innerJoin("program", "program.id", "pair_entry.program_id").select(["pair_entry.id", "pair_entry.program_id", "pair_entry.status", "pair_entry.person_a", "pair_entry.person_b", "program.name", "program.kind", "program.status as program_status"])
    .where((eb) => eb.or([eb("pair_entry.person_a", "=", personId), eb("pair_entry.person_b", "=", personId)])).where("pair_entry.status", "in", ["invited", "entered"]).where("program.status", "!=", "cancelled").execute();
  const out = [];
  for (const e of mine) {
    const v = await competitionView(db, e.program_id);
    const partner = e.person_a === personId ? e.person_b : e.person_a;
    const myFixtures = v.fixtures.filter((f) => f.a_id === e.id || f.b_id === e.id);
    const answered = myFixtures.filter((f) => f.game_id && f.game_status === "awaiting_confirmation");
    const toConfirm = answered.length ? await db.selectFrom("game_side").select(["game_id"]).where("game_id", "in", answered.map((f) => f.game_id!)).where("side", "=", "b").where("person_id", "=", personId).execute() : [];
    out.push({ entry_id: e.id, program_id: e.program_id, program: e.name, kind: e.kind, status: e.status, partner: (await names(db, [partner])).get(partner) ?? "", invited_me: e.status === "invited" && e.person_b === personId,
      format: v.competition?.format ?? null, match_format: v.competition?.match_format ?? null,
      next: myFixtures.filter((f) => f.status === "ready" || f.status === "waiting").sort((x, y) => (x.starts_at?.getTime() ?? Infinity) - (y.starts_at?.getTime() ?? Infinity)),
      played: myFixtures.filter((f) => f.status === "played" || f.status === "walkover"), to_confirm: toConfirm.map((t) => t.game_id),
      tables: v.tables.filter((t) => t.rows.some((r) => r.entry === e.id)) });
  }
  // Tournaments and leagues the member has a place in, without a partner yet, still open for entries.
  const entered = new Set(mine.map((e) => e.program_id));
  const open = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id").leftJoin("competition", (j) => j.onRef("competition.program_id", "=", "program.id").on("competition.status", "!=", "void"))
    .select(["program.id", "program.name", "program.kind"]).where("enrolment.person_id", "=", personId).where("enrolment.status", "=", "booked").where("program.kind", "in", ["tournament", "league"])
    .where("program.status", "=", "published").where("competition.program_id", "is", null).execute();
  return { entries: out, can_enter: open.filter((p) => !entered.has(p.id)).map((p) => ({ program_id: p.id, program: p.name, kind: p.kind })) };
}

void sql; void MATCH_FORMATS;
