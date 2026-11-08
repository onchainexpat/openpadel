// A starting level from another app (rating-import research, 7 Nov 2026). Nobody signs in to another app through
// Kumi: staff record what they saw in a player's app or looked up, a player claims their own, and a club moving in
// brings its own Playtomic levels from its export. Each is a provisional start, a rating event of kind 'import_seed'
// that the replay treats as an anchor: only while the player has played fewer than 5 rated games here, never a
// floor, and never more certain than a level staff set (0.6), so the first games here still count fully. A player
// can take one away while still new. Links where the player approves sharing (WPR, PadelLevels) come later, as the
// 'partner_link' evidence, once those platforms give API access.
import * as z from "zod/mini";
import { both, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx, type Read } from "./actions.ts";
import { localDate } from "./clock.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { withManagers } from "./households.ts";
import { uuidv7 } from "./ids.ts";
import { MODEL } from "./levels.ts";
import { SELF_ADJUST_GAMES } from "./level_tools.ts";
import { dayText } from "./memberships.ts";
import { loadRating, ratingEvent, recompute, replay, saveRating, type RatingState } from "./ratings.ts";

/** The version of the conversions below: interim guesses until fitted from a club's own members. */
export const IMPORT_TABLE = "interim-2026-11-07";

/** How sure a source says it is: Playtomic's reliability (percent), Playbypoint's matches counted, WPR's
 *  confidence (HC high, LC low, NC none: self-assigned), PadelLevels' confidence (percent). */
type ConfKind = "reliability" | "matches" | "wpr" | "percent" | null;
interface PlatformDef {
  min: number; max: number; whole?: boolean; conf: ConfKind;
  /** To Kumi's 0 to 7; null when the scale isn't known, and staff decide the start. */
  convert: ((raw: number) => number) | null;
  /** The platform's level is the player's own choice (a questionnaire, a statement): it counts as their word. */
  self?: boolean;
}

/** Straight lines between the points. */
const between = (pts: [number, number][]) => (x: number) => {
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1]!, [x1, y1] = pts[k]!;
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return pts[pts.length - 1]![1];
};
// WPR's 0 to 21 (Competition, else Social): midpoints of an unofficial NPRP to WPR table (padelbrowser.com, 1 Jun 2026).
const WPR: [number, number][] = [[0, 1.5], [2, 2.25], [5, 3.25], [8.5, 4.25], [12.5, 5.25], [15, 6], [21, 7]];
// MATCHi's 1 to 10, matched by its own descriptions to the LTA's statements.
const MATCHI = [0, 1, 2, 2.5, 3, 3.5, 4.25, 4.75, 5.5, 6, 6.5];

export const PLATFORMS = {
  playtomic: { min: 0, max: 7, conf: "reliability", convert: (x) => x },
  playbypoint: { min: 1, max: 7, conf: "matches", convert: (x) => x },          // NPRP: the same range
  wpr: { min: 0, max: 21, conf: "wpr", convert: between(WPR) },
  matchi: { min: 1, max: 10, whole: true, conf: null, convert: (x) => MATCHI[x]!, self: true },
  lta: { min: 1, max: 7, conf: null, convert: (x) => x, self: true },
  padellevels: { min: 0, max: 100, conf: "percent", convert: null },            // its scale isn't published
  padelmates: { min: 0, max: 100, conf: null, convert: null },
  other: { min: 0, max: 100, conf: null, convert: null },
} satisfies Record<string, PlatformDef>;
export type Platform = keyof typeof PLATFORMS;
export const PLATFORM_KEYS = Object.keys(PLATFORMS) as [Platform, ...Platform[]];
/** How it reached Kumi: the club's own records (an export or its API key), staff seeing the player's app or
 *  looking them up, the player's own word, or a link the player approved on the platform (not built yet). */
export type Evidence = "club_data" | "staff_seen" | "public_lookup" | "self" | "partner_link";

export interface Confidence { reliability?: number; matches?: number; wpr?: "HC" | "LC" | "NC"; percent?: number }
const round2 = (n: number) => Math.round(n * 100) / 100;
const lvl = (n: number) => n.toFixed(2);

/** The platform's number on Kumi's scale, or null when staff have to say (an unknown scale). */
export function toKumi(p: Platform, raw: number): number | null {
  const d: PlatformDef = PLATFORMS[p];
  return d.convert ? round2(Math.min(7, Math.max(0, d.convert(raw)))) : null;
}

/** How unsure the start is, from the evidence (the research's table): never surer than a staff-set level. Null: don't. */
export function startSigma(p: Platform, evidence: Evidence, c: Confidence): number | null {
  if (p === "wpr" && c.wpr === "NC") return null;
  const d: PlatformDef = PLATFORMS[p];
  let s: number;
  if (evidence === "self" || d.self) s = 1.0;
  // Playtomic: its reliability decides when it's given, from the club's own file too (a 40% level is a guess);
  // the club's file without one is the club's own data (0.6); seen in the app without one is unknown (0.85).
  else if (p === "playtomic") s = c.reliability !== undefined ? (c.reliability >= 50 ? 0.6 : 0.85) : evidence === "club_data" ? 0.6 : 0.85;
  else if (p === "playbypoint") s = (c.matches ?? 0) >= 20 ? 0.7 : 0.85;
  else if (p === "wpr") s = c.wpr === "HC" ? 0.7 : 0.85;
  else if (p === "padellevels") s = (c.percent ?? 0) >= 70 ? 0.7 : 0.85;
  else s = 0.85;
  return Math.max(MODEL.sigmaSeeded, s);
}

const source = (p: Platform): Text => both(`level_source.${p}` as Key);
/** What the player's app showed: "4.25, reliability 80%", "12.5, HC", "5". */
export function shownText(p: Platform, raw: number, c: Confidence): Text {
  const d: PlatformDef = PLATFORMS[p], n = d.whole ? String(raw) : String(round2(raw));
  const conf: Text | null = c.reliability !== undefined ? both("level_import.reliability", { pct: c.reliability })
    : c.percent !== undefined ? both("level_import.percent", { pct: c.percent })
    : c.wpr ? both("level_import.wpr_conf", { conf: c.wpr })
    : c.matches !== undefined ? both("level_import.matches", { count: c.matches }) : null;
  return conf ? { en: `${n}, ${conf.en}`, es: `${n}, ${conf.es}` } : { en: n, es: n };
}

// A change nobody made by hand is the club's own, as in ratings.ts: members read this, so it's the club's name, never a product's.
async function nameOf(db: Db | Trx, id: string | null) { return id ? (await readRow(db, "person", id, "thing.person")).row.display_name as string : ((await db.selectFrom("club").select("name").executeTakeFirst())?.name ?? ""); }
async function today(db: Db | Trx, now: Date) { return dayText(localDate(now, (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone)); }
async function ratingRead(db: Db | Trx, personId: string): Promise<Read[]> {
  const r = await db.selectFrom("rating").select("version").where("person_id", "=", personId).where("sport", "=", "padel").executeTakeFirst();
  return r ? [{ entity: "rating", id: personId, version: r.version }] : [];
}

export interface ImportFacts { platform: Platform; raw: number; conf: Confidence; start_level: number; sigma: number; evidence: Evidence; external_id?: string | null; last_played?: string | null }

/** Imports still standing for a person (not taken away), newest first. */
export async function activeImports(db: Db | Trx, personId: string) {
  const evs = await db.selectFrom("rating_event").select(["id", "kind", "level_after", "factors", "explanation", "at"]).where("person_id", "=", personId)
    .where("kind", "in", ["import_seed", "import_removed"]).orderBy("id", "desc").execute();
  const removed = new Set(evs.filter((e) => e.kind === "import_removed").map((e) => (e.factors as { event_id?: string }).event_id));
  return evs.filter((e) => e.kind === "import_seed" && !removed.has(e.id))
    .map((e) => ({ id: e.id, at: e.at, level: Number(e.level_after), factors: e.factors as ImportFacts & { checked_by?: string | null }, explanation: e.explanation as Text }));
}

/** May a start from this platform be recorded now: still new here, and not one already standing from it. */
async function importCheck(db: Db | Trx, personId: string, p: Platform, o: { replace?: boolean } = {}) {
  const r = await loadRating(db, personId);
  if (r.games >= SELF_ADJUST_GAMES) throw new KumiError("error.import_late", { count: SELF_ADJUST_GAMES });
  if (!o.replace && (await activeImports(db, personId)).some((x) => x.factors.platform === p)) throw new KumiError("error.import_already", { source: source(p) });
  return r;
}
function readRaw(p: Platform, raw: number, c: Confidence) {
  const d: PlatformDef = PLATFORMS[p];
  if (raw < d.min || raw > d.max || (d.whole && !Number.isInteger(raw))) throw new KumiError("error.import_range", { source: source(p), min: d.min, max: d.max });
  if (p === "wpr" && c.wpr === "NC") throw new KumiError("error.import_wpr_nc");
}

/** Write the start: the level (a floor a coach set still holds), its event with where it came from, and nothing else. */
export async function writeImport(ctx: ApplyCtx, personId: string, f: ImportFacts, how: Text, checkedBy: string | null) {
  const before = await loadRating(ctx.trx, personId);
  const level = round2(Math.max(before.floor ?? -Infinity, f.start_level));
  const after: RatingState = { mu: level, sigma: f.sigma, level, floor: before.floor, games: before.games };
  await saveRating(ctx, personId, after, before.exists);
  const why = both("level.imported", { level: lvl(level), source: source(f.platform), shown: shownText(f.platform, f.raw, f.conf), how });
  await ratingEvent(ctx, personId, "import_seed", before.exists ? before : null, after, why, {
    factors: { platform: f.platform, raw: f.raw, conf: f.conf, start_level: level, sigma: f.sigma, evidence: f.evidence, external_id: f.external_id ?? null,
      last_played: f.last_played ?? null, checked_by: checkedBy, table: IMPORT_TABLE } });
  return level;
}

const confInput = {
  reliability: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(100), z.describe("Playtomic's reliability for the level, in percent, as its app shows it."))),
  matches: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(100000), z.describe("Playbypoint: how many matches its rating counts."))),
  wpr: z.optional(z.enum(["HC", "LC", "NC"]).check(z.describe("WPR's confidence: HC high, LC low, NC none (self-assigned, not used)."))),
  percent: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(100), z.describe("PadelLevels' confidence, in percent."))),
};
const valueInput = z.number().check(z.minimum(0), z.maximum(100), z.describe("The level as the other app shows it, on its own scale."));
const dayInput = z.optional(z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/), z.describe("When they last played there, if the app shows it.")));
const confOf = (i: Confidence): Confidence => Object.fromEntries(Object.entries({ reliability: i.reliability, matches: i.matches, wpr: i.wpr, percent: i.percent }).filter(([, v]) => v !== undefined));

/** Staff record a start they saw in the player's app, or looked up. They're the check; it applies at once. */
export const levelImport = defineAction({
  name: "level.import", version: 1, clubWide: true,
  input: z.object({
    person_id: z.uuid(), platform: z.enum(PLATFORM_KEYS), value: valueInput, ...confInput,
    evidence: z.enum(["staff_seen", "public_lookup"]).check(z.describe("staff_seen: seen in the player's app; public_lookup: looked up on the app's public pages.")),
    // The starting level on the club's 0 to 7, when staff judge it themselves (an app whose scale isn't converted).
    start_level: z.optional(z.number().check(z.minimum(0), z.maximum(7), z.describe("The starting level on the club's 0 to 7 scale: needed for an app whose levels aren't converted; otherwise the conversion is used."))),
    last_played: dayInput, external_id: z.optional(z.string().check(z.minLength(1), z.maxLength(64), z.describe("The player's id on the other app, if known."))),
  }),
  async plan(ctx, i) {
    const conf = confOf(i);
    readRaw(i.platform, i.value, conf);
    const s = await importCheck(ctx.db, i.person_id, i.platform);
    const open = await ctx.db.selectFrom("level_review").select("kind").where("person_id", "=", i.person_id).where("status", "=", "open").executeTakeFirst();
    if (open?.kind === "import") throw new KumiError("error.import_claim_open");
    const kumi = i.start_level ?? toKumi(i.platform, i.value);
    if (kumi === null) throw new KumiError("error.import_needs_level", { source: source(i.platform) });
    const sigma = startSigma(i.platform, i.evidence, conf)!;
    const level = Math.max(s.floor ?? -Infinity, kumi);
    return { title: both("action.level.import"), reads: await ratingRead(ctx.db, i.person_id), undo: { kind: "compensating" }, details: { start_level: kumi, sigma },
      summary: both(s.exists ? "plan.level.import" : "plan.level.import_none", { person: await nameOf(ctx.db, i.person_id), source: source(i.platform), shown: shownText(i.platform, i.value, conf), level: lvl(level),
        before: s.exists ? lvl(s.level) : both("plan.level.no_level") }) };
  },
  async apply(ctx, i, plan) {
    const conf = confOf(i);
    await importCheck(ctx.trx, i.person_id, i.platform);
    const { start_level, sigma } = plan.details as { start_level: number; sigma: number };
    const by = await nameOf(ctx.trx, ctx.actor.personId), date = await today(ctx.trx, ctx.now);
    const how = both(i.evidence === "staff_seen" ? "level_import.how_seen" : "level_import.how_lookup", { by, date });
    const level = await writeImport(ctx, i.person_id, { platform: i.platform, raw: i.value, conf, start_level, sigma, evidence: i.evidence, external_id: i.external_id ?? null, last_played: i.last_played ?? null }, how, ctx.actor.personId);
    return { level };
  },
});

/** A player (or a parent, for their junior) says what their level is on another app. At or below the club's line it
 *  starts at once, as their own word; above it, or from an app whose scale Kumi doesn't convert, it waits for staff. */
export const levelClaim = defineAction({
  name: "level.claim", version: 1, clubWide: true,
  input: z.object({ person_id: z.uuid(), platform: z.enum(PLATFORM_KEYS), value: valueInput, ...confInput, last_played: dayInput }),
  async plan(ctx, i) {
    const conf = confOf(i);
    readRaw(i.platform, i.value, conf);
    await importCheck(ctx.db, i.person_id, i.platform);
    if (await ctx.db.selectFrom("level_review").select("id").where("person_id", "=", i.person_id).where("status", "=", "open").executeTakeFirst()) throw new KumiError("error.review_open");
    const kumi = toKumi(i.platform, i.value), line = await clubLine(ctx.db);
    const waits = kumi === null || kumi > line + 1e-9;
    const shown = shownText(i.platform, i.value, conf);
    // A parent bringing their junior's (Family) reads the junior's name where a player reads "your".
    const name = ctx.actor.personId === i.person_id ? null : await nameOf(ctx.db, i.person_id), _for = name === null ? "" : "_for";
    return { title: both("action.level.claim"), reads: await ratingRead(ctx.db, i.person_id), ownerIds: await withManagers(ctx.db, [i.person_id]), undo: { kind: "none" }, details: { waits, kumi },
      summary: waits ? both(`${kumi === null ? "plan.level.claim_staff" : "plan.level.claim_wait"}${_for}` as Key, { source: source(i.platform), shown, line: lvl(line), name: name ?? "" })
        : both(`plan.level.claim_now${_for}` as Key, { source: source(i.platform), shown, level: lvl(kumi), games: SELF_ADJUST_GAMES, name: name ?? "" }) };
  },
  async apply(ctx, i, plan) {
    const conf = confOf(i), { waits, kumi } = plan.details as { waits: boolean; kumi: number | null };
    await importCheck(ctx.trx, i.person_id, i.platform);
    if (waits) {
      const id = uuidv7(), claim = { platform: i.platform, raw: i.value, conf, start_level: kumi, last_played: i.last_played ?? null, by: ctx.actor.personId };
      try { await ctx.insert("level_review", { id, person_id: i.person_id, kind: "import", claim: JSON.stringify(claim), created_at: ctx.now }); }
      catch (e: any) { if (e?.code === "23505") throw new KumiError("error.review_open"); throw e; }
      await ctx.emit("level.import_claimed", { review_id: id, person_id: i.person_id, platform: i.platform, shown: shownText(i.platform, i.value, conf), start_level: kumi });
      return { review_id: id, waits: true };
    }
    // Given by a parent for their junior: the junior's history says who gave it.
    const how = ctx.actor.personId === i.person_id || !ctx.actor.personId ? both("level_import.how_self", { date: await today(ctx.trx, ctx.now) })
      : both("level_import.how_parent", { by: await nameOf(ctx.trx, ctx.actor.personId), date: await today(ctx.trx, ctx.now) });
    const level = await writeImport(ctx, i.person_id, { platform: i.platform, raw: i.value, conf, start_level: kumi!, sigma: startSigma(i.platform, "self", conf)!, evidence: "self", last_played: i.last_played ?? null }, how, null);
    return { level, waits: false };
  },
});

/** Take an import away while still new: the level is worked out again as if it never came, everyone's games replayed. */
export const levelRemoveImport = defineAction({
  name: "level.remove_import", version: 1, clubWide: true,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const imp = (await activeImports(ctx.db, i.person_id))[0];
    if (!imp) throw new KumiError("error.no_import");
    const s = await loadRating(ctx.db, i.person_id);
    if (s.games >= SELF_ADJUST_GAMES) throw new KumiError("error.import_remove_late", { count: SELF_ADJUST_GAMES });
    const after = (await replay(ctx.db, { leaveOut: new Set([imp.id]) })).get(i.person_id);
    const name = ctx.actor.personId === i.person_id ? null : await nameOf(ctx.db, i.person_id), _for = name === null ? "" : "_for";   // a parent, for their junior
    return { title: both("action.level.remove_import"), reads: await ratingRead(ctx.db, i.person_id), ownerIds: await withManagers(ctx.db, [i.person_id]), undo: { kind: "none" }, details: { event_id: imp.id },
      summary: both(`${after ? "plan.level.remove_import" : "plan.level.remove_import_none"}${_for}` as Key, { source: source(imp.factors.platform), level: lvl(imp.level), after: after ? lvl(after.level) : both("plan.level.no_level"), name: name ?? "" }) };
  },
  async apply(ctx, i, plan) {
    const { event_id } = plan.details as { event_id: string };
    const imp = (await activeImports(ctx.trx, i.person_id))[0];
    if (imp?.id !== event_id) throw new KumiError("error.changed");
    const before = await loadRating(ctx.trx, i.person_id);
    if (before.games >= SELF_ADJUST_GAMES) throw new KumiError("error.import_remove_late", { count: SELF_ADJUST_GAMES });
    const next = (await replay(ctx.trx, { leaveOut: new Set([event_id]) })).get(i.person_id) ?? null;
    const fresh: RatingState = { mu: MODEL.defaultLevel, sigma: MODEL.sigmaNew, level: MODEL.defaultLevel, floor: null, games: 0 };
    await ratingEvent(ctx, i.person_id, "import_removed", before, next ?? fresh, both("level.import_removed", { source: source(imp.factors.platform), level: lvl(imp.level) }), { factors: { event_id } });
    // With nothing else behind it, they're back to no level at all, as before the import.
    if (next) await saveRating(ctx, i.person_id, next, before.exists);
    else await ctx.trx.deleteFrom("rating").where("person_id", "=", i.person_id).where("sport", "=", "padel").execute();
    await recompute(ctx);   // the others in their games, if there were any
    return { level: next ? next.level : null };
  },
});

export async function clubLine(db: Db | Trx): Promise<number> {
  return Number((await db.selectFrom("club").select("level_import_line").executeTakeFirstOrThrow()).level_import_line);
}

/** For the level pages: where a start came from, and what the person can still do with it. */
export async function importOptions(db: Db | Trx, personId: string) {
  const imp = (await activeImports(db, personId))[0] ?? null, r = await loadRating(db, personId);
  return {
    import: imp ? { at: imp.at, level: imp.level, platform: imp.factors.platform, evidence: imp.factors.evidence, explanation: imp.explanation } : null,
    can_remove: Boolean(imp) && r.games < SELF_ADJUST_GAMES,
    can_claim: r.games < SELF_ADJUST_GAMES,
    games: SELF_ADJUST_GAMES, line: await clubLine(db),
    platforms: PLATFORM_KEYS.map((k) => { const d: PlatformDef = PLATFORMS[k]; return { key: k, min: d.min, max: d.max, whole: Boolean(d.whole), conf: d.conf, converts: Boolean(d.convert) }; }),
  };
}
