// Level tools (v1 scope, Levels): a player asks the club to review their level, free, once every 30 days;
// a new player moves their own level once, by up to half a level, in their first rated games; staff answer
// reviews and check big moves from one queue; and staff set levels for everyone in a clinic session at once.
// Every change is a rating event with its reason, like any other.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, type Text } from "@kumi/i18n";
import { defineAction, readRow, type Read } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { withManagers } from "./households.ts";
import { uuidv7 } from "./ids.ts";
import { localDate } from "./clock.ts";
import { dayText } from "./memberships.ts";
import { MODEL } from "./levels.ts";
import { loadRating, ratingEvent, saveRating, type RatingState } from "./ratings.ts";

/** A review can be asked for once in this many days. */
export const REVIEW_EVERY_DAYS = 30;
/** A player moves their own level only while they've played fewer rated games than this. */
export const SELF_ADJUST_GAMES = 5;
/** How far they can move it, either way. */
export const SELF_ADJUST_MAX = 0.5;
/** A level that moved more than this in the last MOVE_DAYS days goes in the staff queue. */
export const MOVE_LIMIT = 0.5;
export const MOVE_DAYS = 30;

const lvl = (n: number) => n.toFixed(2);
const round2 = (n: number) => Math.round(n * 100) / 100;
const levelInput = z.number().check(z.minimum(0), z.maximum(7));
async function nameOf(db: Db | Trx, id: string | null) { return id ? (await readRow(db, "person", id, "thing.person")).row.display_name as string : "Kumi"; }
async function clubTz(db: Db | Trx) { return (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone; }
async function ratingRead(db: Db | Trx, personId: string): Promise<Read[]> {
  const r = await db.selectFrom("rating").select("version").where("person_id", "=", personId).where("sport", "=", "padel").executeTakeFirst();
  return r ? [{ entity: "rating", id: personId, version: r.version }] : [];
}
const levelText = (s: { exists: boolean; level: number }): Text => s.exists ? { en: lvl(s.level), es: lvl(s.level) } : both("plan.level.no_level");
/** The level a staff member sets: a floor still holds, and someone new starts as sure as a seeded player. */
const staffSet = (before: RatingState & { exists: boolean }, level: number): RatingState =>
  ({ mu: level, sigma: before.exists ? before.sigma : MODEL.sigmaSeeded, level, floor: before.floor, games: before.games });

// ---- What a player can do now ----
/** For the player's level page: whether they can still move their own level, and where a review stands. */
export async function levelOptions(db: Db | Trx, personId: string, now: Date) {
  const r = await db.selectFrom("rating").select(["rated_games", "self_adjust_used", "floor"]).where("person_id", "=", personId).where("sport", "=", "padel").executeTakeFirst();
  const open = await db.selectFrom("level_review").select(["created_at", "note"]).where("person_id", "=", personId).where("status", "=", "open").executeTakeFirst();
  const last = await lastRequest(db, personId);
  const next = last ? new Date(last.getTime() + REVIEW_EVERY_DAYS * 86400_000) : null;
  return {
    self_adjust: { can: Boolean(r) && r!.rated_games < SELF_ADJUST_GAMES && Number(r!.self_adjust_used) === 0, used: r ? Number(r.self_adjust_used) : 0,
      games: SELF_ADJUST_GAMES, played: r?.rated_games ?? 0, max: SELF_ADJUST_MAX, floor: r?.floor === null || !r ? null : Number(r.floor) },
    review: { open: open ?? null, next_at: !open && next && next > now ? next : null, every: REVIEW_EVERY_DAYS },
  };
}
async function lastRequest(db: Db | Trx, personId: string): Promise<Date | null> {
  const r = await db.selectFrom("level_review").select((eb) => eb.fn.max("created_at").as("at")).where("person_id", "=", personId).where("kind", "=", "request").executeTakeFirst();
  return (r?.at as Date | null) ?? null;
}

export const levelRequestReview = defineAction({
  name: "level.request_review", version: 1,
  input: z.object({ person_id: z.uuid(), note: z.optional(z.string().check(z.maxLength(500))) }),
  async plan(ctx, i) {
    if (await ctx.db.selectFrom("level_review").select("id").where("person_id", "=", i.person_id).where("status", "=", "open").executeTakeFirst()) throw new KumiError("error.review_open");
    const last = await lastRequest(ctx.db, i.person_id);
    if (last && last.getTime() + REVIEW_EVERY_DAYS * 86400_000 > ctx.now.getTime())
      throw new KumiError("error.review_too_soon", { count: REVIEW_EVERY_DAYS, date: dayText(localDate(new Date(last.getTime() + REVIEW_EVERY_DAYS * 86400_000), await clubTz(ctx.db))) });
    const s = await loadRating(ctx.db, i.person_id), note = i.note?.trim();
    // A parent can ask for their junior's level to be looked at.
    return { title: both("action.level.request_review"), reads: [], ownerIds: await withManagers(ctx.db, [i.person_id]), undo: { kind: "none" },
      summary: both("plan.level.request_review", { level: levelText(s), count: REVIEW_EVERY_DAYS, note: note ? both("plan.level.review_note", { note }) : { en: "", es: "" } }) };
  },
  async apply(ctx, i) {
    const id = uuidv7(), s = await loadRating(ctx.trx, i.person_id);
    try { await ctx.insert("level_review", { id, person_id: i.person_id, kind: "request", note: i.note?.trim() || null, created_at: ctx.now }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.review_open"); throw e; }
    await ctx.emit("level.review_requested", { review_id: id, person_id: i.person_id, level: s.exists ? lvl(s.level) : null, note: i.note?.trim() || null });
    return { review_id: id };
  },
});

export const levelSelfAdjust = defineAction({
  name: "level.self_adjust", version: 1,
  input: z.object({ person_id: z.uuid(), level: levelInput }),
  async plan(ctx, i) {
    const s = await loadRating(ctx.db, i.person_id), target = round2(i.level);
    await selfAdjustCheck(ctx.db, i.person_id, s, target);
    return { title: both("action.level.self_adjust"), reads: await ratingRead(ctx.db, i.person_id), ownerIds: [i.person_id], undo: { kind: "none" },
      summary: both("plan.level.self_adjust", { before: lvl(s.level), after: lvl(target), max: lvl(SELF_ADJUST_MAX), games: SELF_ADJUST_GAMES, played: s.games }) };
  },
  async apply(ctx, i) {
    const before = await loadRating(ctx.trx, i.person_id), target = round2(i.level);
    await selfAdjustCheck(ctx.trx, i.person_id, before, target);
    const delta = round2(target - before.level);
    const after: RatingState = { ...before, mu: before.mu + delta, level: target };
    await saveRating(ctx, i.person_id, after, true);
    await ctx.update("rating", i.person_id, { self_adjust_used: Math.abs(delta).toFixed(2) });
    await ratingEvent(ctx, i.person_id, "self_adjust", before, after, both("level.self_adjust", { before: lvl(before.level), after: lvl(target) }), { factors: { delta } });
    return { level: target };
  },
});
async function selfAdjustCheck(db: Db | Trx, personId: string, s: RatingState & { exists: boolean }, target: number) {
  if (!s.exists) throw new KumiError("error.no_level_yet");
  const used = await db.selectFrom("rating").select("self_adjust_used").where("person_id", "=", personId).where("sport", "=", "padel").executeTakeFirstOrThrow();
  if (Number(used.self_adjust_used) > 0) throw new KumiError("error.self_adjust_used");
  if (s.games >= SELF_ADJUST_GAMES) throw new KumiError("error.self_adjust_late", { count: SELF_ADJUST_GAMES });
  const delta = round2(target - s.level);
  if (delta === 0) throw new KumiError("error.self_adjust_same", { level: lvl(s.level) });
  if (Math.abs(delta) > SELF_ADJUST_MAX + 1e-9) throw new KumiError("error.self_adjust_range", { max: lvl(SELF_ADJUST_MAX), level: lvl(s.level) });
  if (s.floor !== null && target < s.floor) throw new KumiError("error.below_floor", { level: lvl(target), floor: lvl(s.floor) });
}

// ---- The staff queue: reviews asked for, and levels that moved a lot ----
/** Each person whose level moved more than MOVE_LIMIT in the last MOVE_DAYS days, measured from the last
 *  time staff looked at it in that time (answered a review, or set the level), or else from where it was. */
export async function bigMoves(db: Db | Trx, now: Date, personIds?: string[]) {
  const cutoff = new Date(now.getTime() - MOVE_DAYS * 86400_000);
  const recent = await db.selectFrom("rating_event").select(["person_id", "kind", "level_before", "level_after", "at"]).where("at", ">", cutoff).where("at", "<=", now)
    .$if(Boolean(personIds), (q) => q.where("person_id", "in", personIds!.length ? personIds! : ["00000000-0000-0000-0000-000000000000"])).orderBy("person_id").orderBy("at").orderBy("id").execute();
  const ids = [...new Set(recent.map((e) => e.person_id))];
  if (!ids.length) return [];
  const prior = new Map((await db.selectFrom("rating_event").select(["person_id", "level_after"]).distinctOn("person_id").where("person_id", "in", ids).where("at", "<=", cutoff)
    .orderBy("person_id").orderBy("at", "desc").orderBy("id", "desc").execute()).map((r) => [r.person_id, Number(r.level_after)]));
  const answered = new Map((await db.selectFrom("level_review").select(["person_id", "level_at", "answered_at"]).distinctOn("person_id").where("person_id", "in", ids).where("status", "!=", "open")
    .where("answered_at", ">", cutoff).orderBy("person_id").orderBy("answered_at", "desc").execute()).map((r) => [r.person_id, r]));
  const now_ = new Map((await db.selectFrom("rating").innerJoin("person", "person.id", "rating.person_id").select(["rating.person_id", "rating.level", "person.display_name"])
    .where("rating.person_id", "in", ids).where("rating.sport", "=", "padel").execute()).map((r) => [r.person_id, r]));
  const out: { person_id: string; name: string; level: number; from: number; since: Date }[] = [];
  for (const id of ids) {
    const evs = recent.filter((e) => e.person_id === id), cur = now_.get(id);
    if (!cur) continue;
    // Where it stood: the latest staff look in the window (a set level, a floor, an answered review), or before the window.
    let from = prior.get(id) ?? (evs[0]!.level_before === null ? Number(evs[0]!.level_after) : Number(evs[0]!.level_before)), since = cutoff;
    for (const e of evs) if (["staff_set", "floor", "import_seed"].includes(e.kind)) { from = Number(e.level_after); since = new Date(e.at); }
    const a = answered.get(id);
    if (a && a.answered_at && a.level_at !== null && new Date(a.answered_at) >= since) { from = Number(a.level_at); since = new Date(a.answered_at); }
    if (Math.abs(Number(cur.level) - from) > MOVE_LIMIT + 1e-9) out.push({ person_id: id, name: cur.display_name, level: Number(cur.level), from, since });
  }
  return out.sort((x, y) => Math.abs(y.level - y.from) - Math.abs(x.level - x.from));
}

/** The review queue: open requests first, then big moves (a person who asked is listed once, as a request). */
export async function levelQueue(db: Db | Trx, now: Date) {
  const requests = await db.selectFrom("level_review").innerJoin("person", "person.id", "level_review.person_id")
    .leftJoin("rating", (j) => j.onRef("rating.person_id", "=", "level_review.person_id").on("rating.sport", "=", "padel"))
    .select(["level_review.id", "level_review.person_id", "person.display_name as name", "level_review.note", "level_review.created_at", "rating.level", "rating.provisional", "rating.rated_games", "rating.floor"])
    .where("level_review.status", "=", "open").orderBy("level_review.created_at").execute();
  const asked = new Set(requests.map((r) => r.person_id));
  return { requests, moves: (await bigMoves(db, now)).filter((m) => !asked.has(m.person_id)) };
}

export const levelAnswerReview = defineAction({
  name: "level.answer_review", version: 1,
  input: z.object({ person_id: z.uuid(), outcome: z.enum(["keep", "change"]), level: z.optional(levelInput), reason: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const open = await ctx.db.selectFrom("level_review").selectAll().where("person_id", "=", i.person_id).where("status", "=", "open").executeTakeFirst();
    // Something to answer: a review they asked for, or a big move (so this isn't a way round asking to change a level).
    if (!open && !(await bigMoves(ctx.db, ctx.now, [i.person_id])).length) throw new KumiError("error.nothing_to_review");
    const s = await loadRating(ctx.db, i.person_id), person = await nameOf(ctx.db, i.person_id), reason = i.reason?.trim() ?? "";
    const told = open || i.outcome === "change" ? both("plan.level.told") : { en: "", es: "" };
    const reads: Read[] = [...(open ? [{ entity: "level_review" as const, id: open.id, version: open.version }] : []), ...await ratingRead(ctx.db, i.person_id)];
    if (i.outcome === "keep") return { title: both("action.level.answer_review"), reads, undo: { kind: "none" }, details: { review_id: open?.id ?? null },
      summary: both("plan.level.answer_keep", { person, level: levelText(s), note: reason ? both("plan.level.answer_note", { note: reason }) : { en: "", es: "" }, told }) };
    if (i.level === undefined || reason.length < 3) throw new KumiError("error.change_needs_level");
    const target = round2(i.level);
    if (s.floor !== null && target < s.floor) throw new KumiError("error.below_floor", { level: lvl(target), floor: lvl(s.floor) });
    if (s.exists && target === s.level) throw new KumiError("error.level_unchanged", { level: lvl(target) });
    return { title: both("action.level.answer_review"), reads, undo: { kind: "compensating" }, details: { review_id: open?.id ?? null },
      summary: both("plan.level.answer_change", { person, before: levelText(s), after: lvl(target), reason, told }) };
  },
  async apply(ctx, i, plan) {
    const { review_id } = plan.details as { review_id: string | null };
    const open = await ctx.trx.selectFrom("level_review").select(["id", "status"]).where("person_id", "=", i.person_id).where("status", "=", "open").forUpdate().executeTakeFirst();
    if ((open?.id ?? null) !== review_id) throw new KumiError("error.changed");   // asked, or answered, meanwhile
    const before = await loadRating(ctx.trx, i.person_id);
    let after = before.exists ? before.level : null;
    if (i.outcome === "change") {
      const next = staffSet(before, Math.max(before.floor ?? -Infinity, round2(i.level!)));
      await saveRating(ctx, i.person_id, next, before.exists);
      await ratingEvent(ctx, i.person_id, "staff_set", before.exists ? before : null, next, both("level.reviewed", { by: await nameOf(ctx.trx, ctx.actor.personId), reason: i.reason!.trim() }));
      after = next.level;
    }
    const answer = { status: i.outcome === "keep" ? "kept" : "changed", level_at: after === null ? null : lvl(after), answer: i.reason?.trim() || null, answered_by: ctx.actor.personId, answered_at: ctx.now };
    if (open) await ctx.update("level_review", open.id, answer);
    else await ctx.insert("level_review", { id: uuidv7(), person_id: i.person_id, kind: "move", created_at: ctx.now, ...answer });
    await ctx.emit("level.reviewed", { person_id: i.person_id, asked: Boolean(open), outcome: i.outcome, before: before.exists ? lvl(before.level) : null, after: after === null ? null : lvl(after), reason: i.reason?.trim() || null });
    return { level: after };
  },
});

// ---- A whole clinic session at once ----
/** Who was signed up for a session (a place in that session, or in the whole program), with their levels. */
export async function sessionPlayers(db: Db | Trx, sessionId: string) {
  const s = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").select(["session.id", "session.program_id", "session.starts_at", "session.status", "session.coach_id", "program.name", "program.location_id"])
    .where("session.id", "=", sessionId).executeTakeFirst();
  if (!s) throw new KumiError("error.not_found", { thing: both("thing.session") }, 404);
  const players = await db.selectFrom("enrolment").innerJoin("person", "person.id", "enrolment.person_id")
    .leftJoin("rating", (j) => j.onRef("rating.person_id", "=", "enrolment.person_id").on("rating.sport", "=", "padel"))
    .select(["enrolment.person_id", "person.display_name as name", "rating.level", "rating.floor", "rating.provisional"]).distinct()
    .where("enrolment.program_id", "=", s.program_id).where("enrolment.status", "in", ["booked", "attended"])
    .where((eb) => eb.or([eb("enrolment.session_id", "=", sessionId), eb("enrolment.session_id", "is", null)])).orderBy("person.display_name").execute();
  return { session: s, players };
}

export const levelSetSession = defineAction({
  name: "level.set_session", version: 1,
  input: z.object({ session_id: z.uuid(), reason: z.string().check(z.minLength(3), z.maxLength(300)),
    levels: z.array(z.object({ person_id: z.uuid(), level: levelInput })).check(z.minLength(1), z.maxLength(64)) }),
  async plan(ctx, i) {
    const { session: s, players } = await sessionPlayers(ctx.db, i.session_id);
    if (s.status === "cancelled") throw new KumiError("error.session_cancelled");
    if (new Date(s.starts_at) > ctx.now) throw new KumiError("error.session_not_started");
    if (new Set(i.levels.map((l) => l.person_id)).size !== i.levels.length) throw new KumiError("error.player_twice");
    const changes: { person_id: string; name: string; before: string | null; after: string }[] = [], reads: Read[] = [];
    for (const l of i.levels) {
      const p = players.find((x) => x.person_id === l.person_id);
      if (!p) throw new KumiError("error.not_in_session", { person: await nameOf(ctx.db, l.person_id) });
      const r = await loadRating(ctx.db, l.person_id), target = round2(l.level);
      if (r.floor !== null && target < r.floor) throw new KumiError("error.below_floor_person", { person: p.name, level: lvl(target), floor: lvl(r.floor) });
      if (r.exists && target === r.level) continue;   // left as it is
      changes.push({ person_id: l.person_id, name: p.name, before: r.exists ? lvl(r.level) : null, after: lvl(target) });
      reads.push(...await ratingRead(ctx.db, l.person_id));
    }
    if (!changes.length) throw new KumiError("error.levels_unchanged");
    const tz = await clubTz(ctx.db), when: Text = { en: dateTime(new Date(s.starts_at), "en", tz), es: dateTime(new Date(s.starts_at), "es", tz) };
    const items = changes.map((c) => both("plan.level.change_item", { name: c.name, before: c.before ?? both("plan.level.no_level"), after: c.after }));
    const left = players.length - changes.length;
    // A coach sets levels after the sessions they run (their grant is for their own); front desk and up, any.
    return { title: both("action.level.set_session"), reads, locationId: s.location_id, ownerIds: s.coach_id ? [s.coach_id] : [], undo: { kind: "compensating" }, details: { changes },
      summary: both("plan.level.set_session", { program: s.name, when, changes: { en: items.map((x) => x.en).join("; "), es: items.map((x) => x.es).join("; ") }, reason: i.reason.trim(),
        rest: left > 0 ? both("plan.level.rest_unchanged", { count: left }) : { en: "", es: "" } }) };
  },
  async apply(ctx, i, plan) {
    const { changes } = plan.details as { changes: { person_id: string; after: string }[] };
    const { session: s } = await sessionPlayers(ctx.trx, i.session_id);
    const by = await nameOf(ctx.trx, ctx.actor.personId), tz = await clubTz(ctx.trx);
    const date = dayText(localDate(new Date(s.starts_at), tz));
    const done: { person_id: string; before: string | null; after: string }[] = [];
    for (const c of changes) {
      const before = await loadRating(ctx.trx, c.person_id), next = staffSet(before, Math.max(before.floor ?? -Infinity, Number(c.after)));
      await saveRating(ctx, c.person_id, next, before.exists);
      await ratingEvent(ctx, c.person_id, "staff_set", before.exists ? before : null, next, both("level.clinic", { by, program: s.name, date, reason: i.reason.trim() }), { factors: { session_id: s.id } });
      done.push({ person_id: c.person_id, before: before.exists ? lvl(before.level) : null, after: lvl(next.level) });
    }
    await ctx.emit("level.session_set", { session_id: s.id, program: s.name, starts_at: s.starts_at, by, reason: i.reason.trim(), changes: done });
    return { changed: done.length };
  },
});
