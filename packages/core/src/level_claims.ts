// Levels a player brings from other apps (docs/levels-from-other-apps.md). A player, a parent for their junior, or their
// assistant through the door, says what another app shows: the app, the number on its own scale, how sure that app says
// it is, and if they like a link to their profile there and (in the members' app) a screenshot. Every claim is kept,
// one per app. At or below the club's line it counts at once as the player's word; above it, or from an app whose scale
// isn't converted (Padelmates, CourtReserve's club ratings, another app), it waits for staff. Staff or a coach confirm a
// claim (it then counts as seen in the app, so its start is surer), change its start, or turn it down with a reason the
// player reads.
//
// With several claims the start comes from the surest (settleStart): the lowest uncertainty, then the one its own app is
// surest of, then the newest; the others are shown beside it. The rules of level_import.ts hold throughout: only while
// the player has played fewer than 5 rated games here, never a floor, never surer than a level staff set.
//
// A screenshot reaches the server first (stageProof, from the members' app), sealed; the claim names it. Only the player
// (and a parent who manages them) and staff who read levels see it, and it's deleted once staff answer the claim, when
// the claim is taken away, or after 60 days (tidyLevelProofs).
import * as z from "zod/mini";
import { both, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx, type PlanCtx, type Read } from "./actions.ts";
import { localDate } from "./clock.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { withManagers } from "./households.ts";
import { uuidv7 } from "./ids.ts";
import { photoType } from "./lessons.ts";
import { MODEL } from "./levels.ts";
import { activeImports, clubLine, confInput, confOf, dayInput, PLATFORM_KEYS, readRaw, shownText, startSigma, toKumi, valueInput, writeImport, type Confidence, type Platform } from "./level_import.ts";
import { SELF_ADJUST_GAMES } from "./level_tools.ts";
import { dayText } from "./memberships.ts";
import { loadRating, ratingEvent, recompute, replay, saveRating, type RatingState } from "./ratings.ts";
import { openBytes, sealBytes } from "./sealed.ts";

/** The largest screenshot taken (the app sends it as base64 under the server's 3 MB limit). */
export const PROOF_MAX_BYTES = 2_000_000;
/** A screenshot not named by a claim within this long is dropped. */
export const PROOF_UPLOAD_MINUTES = 60;
/** A screenshot staff haven't answered is deleted after this many days. */
export const PROOF_KEEP_DAYS = 60;

type Status = "waiting" | "standing" | "confirmed" | "rejected" | "removed";
interface ClaimRow { id: string; person_id: string; platform: string; raw: number; conf: unknown; start_level: string | null; last_played: string | null; sent_by: string | null; status: Status;
  evidence: "self" | "staff_seen"; sigma: number | null; event_id: string | null; proof: "none" | "kept" | "deleted"; answer: string | null; answered_by: string | null; answered_at: Date | null; created_at: Date; version: number }
const LIVE: Status[] = ["waiting", "standing", "confirmed"];
const lvl = (n: number) => n.toFixed(2);
const round2 = (n: number) => Math.round(n * 100) / 100;
const source = (p: string): Text => both(`level_source.${p}` as Key);
/** Sentences one after another (a part that starts with its own space, like plan.level.told, keeps just that one). */
const glue = (xs: string[]) => xs.filter(Boolean).reduce((a, b) => !a ? b.trimStart() : b.startsWith(" ") ? a + b : `${a} ${b}`, "");
const join = (...t: Text[]): Text => ({ en: glue(t.map((x) => x.en)), es: glue(t.map((x) => x.es)) });
const NONE: Text = { en: "", es: "" };

async function nameOf(db: Db | Trx, id: string | null) { return id ? (await readRow(db, "person", id, "thing.person")).row.display_name as string : ((await db.selectFrom("club").select("name").executeTakeFirst())?.name ?? ""); }
async function clubTz(db: Db | Trx) { return (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone; }
async function ratingRead(db: Db | Trx, personId: string): Promise<Read[]> {
  const r = await db.selectFrom("rating").select("version").where("person_id", "=", personId).where("sport", "=", "padel").executeTakeFirst();
  return r ? [{ entity: "rating", id: personId, version: r.version }] : [];
}
async function claimOf(db: Db | Trx, id: string): Promise<ClaimRow> {
  const c = await db.selectFrom("level_claim").selectAll().where("id", "=", id).executeTakeFirst();
  if (!c) throw new KumiError("error.not_found", { thing: both("thing.level_claim") }, 404);
  return c as ClaimRow;
}
const shownOf = (c: ClaimRow) => shownText(c.platform as Platform, c.raw, c.conf as Confidence);

// ---- Which claim the start comes from ----
/** How sure the app itself is of a level (as staff seeing it would take it): between two of the player's word, the one
 *  the other app is surer of starts. */
const appSigma = (p: string, c: Confidence) => startSigma(p as Platform, "staff_seen", c) ?? 9;
interface Candidate { sigma: number; tie: number; at: number; claim?: ClaimRow; source: string; level: number }
const better = (a: Candidate, b: Candidate) => a.sigma - b.sigma || a.tie - b.tie || b.at - a.at;

/** Every start the player could have now: their claims that count, and the newest start staff or the club's own file
 *  gave (level.import, the member import), best first. `leave` is a claim to leave out (to show what taking it away does). */
async function candidates(db: Db | Trx, personId: string, o: { leave?: string; extra?: Candidate } = {}): Promise<Candidate[]> {
  const claims = (await db.selectFrom("level_claim").selectAll().where("person_id", "=", personId).where("status", "in", ["standing", "confirmed"]).execute()) as ClaimRow[];
  const other = (await activeImports(db, personId)).find((x) => !x.factors.claim_id);
  const out: Candidate[] = claims.filter((c) => c.id !== o.leave && c.start_level !== null && c.sigma !== null)
    .map((c) => ({ sigma: c.sigma!, tie: appSigma(c.platform, c.conf as Confidence), at: new Date(c.created_at).getTime(), claim: c, source: c.platform, level: Number(c.start_level) }));
  if (other) out.push({ sigma: other.factors.sigma, tie: appSigma(other.factors.platform, other.factors.conf), at: new Date(other.at).getTime(), source: other.factors.platform, level: other.level });
  if (o.extra) out.push(o.extra);
  return out.sort(better);
}

/** How a claim's start came about, in the player's history. */
async function howOf(db: Db | Trx, c: ClaimRow): Promise<Text> {
  const tz = await clubTz(db), day = (d: Date) => dayText(localDate(new Date(d), tz));
  const parent = c.sent_by && c.sent_by !== c.person_id ? await nameOf(db, c.sent_by) : null;
  if (c.evidence === "staff_seen") {
    const by = await nameOf(db, c.answered_by), date = day(c.answered_at ?? new Date());
    return parent ? both("level_import.how_checked_parent", { parent, by, date }) : both("level_import.how_checked", { by, date });
  }
  return parent ? both("level_import.how_parent", { by: parent, date: day(c.created_at) }) : both("level_import.how_self", { date: day(c.created_at) });
}

/** Make the player's start the surest of what they have: a claim's start that no longer is (taken away, turned down, or
 *  outdone by a surer one) goes, as if it never came (everyone's games replayed), and the best one's start is written if
 *  it isn't the start already. Nothing moves once they've played 5 rated games here: their games set the level then. */
export async function settleStart(ctx: ApplyCtx, personId: string): Promise<void> {
  const before = await loadRating(ctx.trx, personId);
  if (before.games >= SELF_ADJUST_GAMES) return;
  const imports = await activeImports(ctx.trx, personId), top = imports[0] ?? null;
  const claims = (await ctx.trx.selectFrom("level_claim").selectAll().where("person_id", "=", personId).execute()) as ClaimRow[];
  const want = (await candidates(ctx.trx, personId))[0]?.claim ?? null;
  // In place: the best claim's own start is the newest one standing.
  const reseed = want !== null && !(want.event_id && top?.id === want.event_id);
  const remove = imports.filter((x) => x.factors.claim_id && (x.factors.claim_id !== want?.id || reseed));
  if (!remove.length && !reseed) return;
  if (remove.length) {
    const ids = new Set(remove.map((x) => x.id));
    const next = (await replay(ctx.trx, { leaveOut: ids })).get(personId) ?? null;
    const fresh: RatingState = { mu: MODEL.defaultLevel, sigma: MODEL.sigmaNew, level: MODEL.defaultLevel, floor: null, games: 0 };
    for (const x of remove) {
      const c = claims.find((k) => k.id === x.factors.claim_id);
      // Why it went: taken away, turned down, checked again (its checked start follows), or a surer one came.
      const why = c?.status === "rejected" ? "level.import_rejected" : c?.status === "removed" ? "level.import_removed" : c && c.id === want?.id ? "level.import_rechecked" : "level.import_replaced";
      await ratingEvent(ctx, personId, "import_removed", before, next ?? fresh, both(why, { source: source(x.factors.platform), level: lvl(x.level) }), { factors: { event_id: x.id } });
      if (c?.event_id === x.id) await ctx.update("level_claim", c.id, { event_id: null });
    }
    if (next) await saveRating(ctx, personId, next, before.exists);
    else if (before.exists) await ctx.trx.deleteFrom("rating").where("person_id", "=", personId).where("sport", "=", "padel").execute();
  }
  if (reseed && want) {
    const { eventId } = await writeImport(ctx, personId, { platform: want.platform as Platform, raw: want.raw, conf: want.conf as Confidence, start_level: Number(want.start_level), sigma: want.sigma!,
      evidence: want.evidence, last_played: want.last_played, claim_id: want.id }, await howOf(ctx.trx, want), want.evidence === "staff_seen" ? want.answered_by : null);
    await ctx.update("level_claim", want.id, { event_id: eventId });
  }
  if (remove.length) await recompute(ctx);   // the others in their games, if there were any
}

// ---- Screenshots ----
/** Seal a screenshot of the other app for a claim about to be made. Returns its id, for level.claim's proof_id. */
export async function stageProof(db: Db, personId: string, by: string, bytes: Buffer, now = new Date()) {
  if (!bytes.length || bytes.length > PROOF_MAX_BYTES) throw new KumiError("error.proof_big", { mb: PROOF_MAX_BYTES / 1_000_000 }, 413);
  const type = photoType(bytes);
  if (!type) throw new KumiError("error.proof_type", {}, 400);
  const id = uuidv7(now.getTime());
  await db.insertInto("level_proof").values({ id, person_id: personId, claim_id: null, content_type: type, bytes: sealBytes(bytes), size_bytes: bytes.length, created_by: by, created_at: now, attached_at: null }).execute();
  return { proof_id: id, size_bytes: bytes.length, content_type: type };
}
async function waitingProof(ctx: PlanCtx, proofId: string, personId: string) {
  const p = await ctx.db.selectFrom("level_proof").select(["id", "person_id", "created_by", "created_at", "attached_at"]).where("id", "=", proofId).executeTakeFirst();
  if (!p || p.attached_at || p.person_id !== personId || p.created_by !== ctx.actor.personId || ctx.now.getTime() - new Date(p.created_at).getTime() > PROOF_UPLOAD_MINUTES * 60_000)
    throw new KumiError("error.proof_gone");
}
/** A claim's screenshot, opened, for the player or staff to look at; null once it's deleted. */
export async function claimProof(db: Db | Trx, claimId: string) {
  const p = await db.selectFrom("level_proof").select(["content_type", "bytes"]).where("claim_id", "=", claimId).executeTakeFirst();
  return p ? { content_type: p.content_type, bytes: openBytes(p.bytes) } : null;
}
/** Delete a claim's screenshot (staff answered it, or it was taken away). */
async function dropProof(ctx: ApplyCtx, c: ClaimRow) {
  if (c.proof !== "kept") return {};
  await ctx.trx.deleteFrom("level_proof").where("claim_id", "=", c.id).execute();
  return { proof: "deleted" as const };
}
/** Screenshots never named by a claim (after an hour), and those kept 60 days with nobody answering, are deleted. */
export async function tidyLevelProofs(db: Db, now = new Date()) {
  const loose = await db.deleteFrom("level_proof").where("claim_id", "is", null).where("created_at", "<", new Date(now.getTime() - PROOF_UPLOAD_MINUTES * 60_000)).executeTakeFirst();
  const old = await db.deleteFrom("level_proof").where("claim_id", "is not", null).where("created_at", "<", new Date(now.getTime() - PROOF_KEEP_DAYS * 86400_000)).returning("claim_id").execute();
  const ids = old.map((o) => o.claim_id!).filter(Boolean);
  if (ids.length) await db.updateTable("level_claim").set({ proof: "deleted" }).where("id", "in", ids).execute();
  return { dropped: Number(loose.numDeletedRows), expired: ids.length };
}

// ---- The actions ----
const profileInput = z.optional(z.string().check(z.maxLength(300), z.regex(/^https:\/\/[^\s<>"]+$/), z.describe("Their public profile there")));

/** A player (or a parent, for their junior, or their assistant) says what their level is on another app. */
export const levelClaim = defineAction({
  name: "level.claim", version: 2, clubWide: true,
  owners: (db, i) => withManagers(db, [i.person_id]),
  input: z.object({ person_id: z.uuid(), platform: z.enum(PLATFORM_KEYS).check(z.describe("courtreserve: a club's own rating there (its WPR is wpr)")),
    value: valueInput, ...confInput, last_played: dayInput, profile_url: profileInput,
    proof_id: z.optional(z.uuid().check(z.describe("The members' app's only"))) }),
  async plan(ctx, i) {
    const conf = confOf(i), p = i.platform;
    readRaw(p, i.value, conf);
    const r = await loadRating(ctx.db, i.person_id);
    if (r.games >= SELF_ADJUST_GAMES) throw new KumiError("error.import_late", { count: SELF_ADJUST_GAMES });
    if (await ctx.db.selectFrom("level_claim").select("id").where("person_id", "=", i.person_id).where("platform", "=", p).where("status", "in", LIVE).executeTakeFirst()
      || (await activeImports(ctx.db, i.person_id)).some((x) => x.factors.platform === p)) throw new KumiError("error.import_already", { source: source(p) });
    if (i.proof_id) await waitingProof(ctx, i.proof_id, i.person_id);
    const kumi = toKumi(p, i.value), line = await clubLine(ctx.db), waits = kumi === null || kumi > line + 1e-9;
    const sigma = waits ? null : startSigma(p, "self", conf);
    const shown = shownText(p, i.value, conf);
    // A parent bringing their junior's (Family) reads the junior's name where a player reads "your".
    const name = ctx.actor.personId === i.person_id ? null : await nameOf(ctx.db, i.person_id), _for = name === null ? "" : "_for";
    let say: Text;
    if (waits) say = both(`${kumi === null ? "plan.level.claim_staff" : "plan.level.claim_wait"}${_for}` as Key, { source: source(p), shown, line: lvl(line), name: name ?? "" });
    else {
      // The start comes from the surest: this one, or one they already have.
      const best = (await candidates(ctx.db, i.person_id))[0];
      const mine: Candidate = { sigma: sigma!, tie: appSigma(p, conf), at: ctx.now.getTime(), source: p, level: kumi! };
      say = !best || better(mine, best) < 0
        ? both(`plan.level.claim_now${_for}` as Key, { source: source(p), shown, level: lvl(Math.max(r.floor ?? -Infinity, kumi!)), games: SELF_ADJUST_GAMES, name: name ?? "" })
        : both(`plan.level.claim_kept${_for}` as Key, { source: source(p), shown, best: source(best.source), level: lvl(r.exists ? r.level : best.level), name: name ?? "" });
    }
    if (i.proof_id) say = join(say, both("plan.level.claim_proof", { days: PROOF_KEEP_DAYS }));
    return { title: both("action.level.claim"), reads: await ratingRead(ctx.db, i.person_id), ownerIds: await withManagers(ctx.db, [i.person_id]), undo: { kind: "none" },
      details: { waits, kumi, sigma }, summary: say };
  },
  async apply(ctx, i, plan) {
    const conf = confOf(i), { waits, kumi, sigma } = plan.details as { waits: boolean; kumi: number | null; sigma: number | null };
    if ((await loadRating(ctx.trx, i.person_id)).games >= SELF_ADJUST_GAMES) throw new KumiError("error.import_late", { count: SELF_ADJUST_GAMES });
    const id = uuidv7();
    try {
      await ctx.insert("level_claim", { id, person_id: i.person_id, platform: i.platform, raw: i.value, conf: JSON.stringify(conf), start_level: kumi === null ? null : lvl(kumi), last_played: i.last_played ?? null,
        profile_url: i.profile_url ?? null, sent_by: ctx.actor.personId, status: waits ? "waiting" : "standing", evidence: "self", sigma, event_id: null, proof: i.proof_id ? "kept" : "none", created_at: ctx.now });
    } catch (e: any) { if (e?.code === "23505") throw new KumiError("error.import_already", { source: source(i.platform) }); throw e; }
    if (i.proof_id) {
      const done = await ctx.trx.updateTable("level_proof").set({ claim_id: id, attached_at: ctx.now }).where("id", "=", i.proof_id).where("person_id", "=", i.person_id).where("attached_at", "is", null).executeTakeFirst();
      if (!Number(done.numUpdatedRows)) throw new KumiError("error.proof_gone");
    }
    if (waits) {
      await ctx.emit("level.import_claimed", { claim_id: id, person_id: i.person_id, platform: i.platform, shown: shownText(i.platform, i.value, conf), start_level: kumi,
        ...(ctx.actor.personId && ctx.actor.personId !== i.person_id ? { sent_by: ctx.actor.personId } : {}) });
      return { claim_id: id, waits: true };
    }
    await settleStart(ctx, i.person_id);
    const r = await loadRating(ctx.trx, i.person_id);
    return { claim_id: id, waits: false, level: r.exists ? r.level : null };
  },
});

/** What happens to the start when a claim goes, in the preview's words. */
async function afterGoing(db: Db | Trx, c: ClaimRow): Promise<Text> {
  const imp = (await activeImports(db, c.person_id))[0];
  if (!imp || imp.factors.claim_id !== c.id) return NONE;   // not the start: nothing moves
  const r = await loadRating(db, c.person_id);
  if (r.games >= SELF_ADJUST_GAMES) return both("plan.level.claim_after_games");
  const next = (await candidates(db, c.person_id, { leave: c.id }))[0];
  if (next) return both("plan.level.claim_after_next", { level: lvl(Math.max(r.floor ?? -Infinity, next.level)), source: source(next.source) });
  const after = (await replay(db, { leaveOut: new Set([imp.id]) })).get(c.person_id);
  return after ? both("plan.level.claim_after", { level: lvl(after.level) }) : both("plan.level.claim_after_none");
}

/** Staff or a coach answer a claim: confirm it as seen (a surer start), give it another start, or turn it down. */
export const levelAnswerClaim = defineAction({
  name: "level.answer_claim", version: 1, clubWide: true,
  input: z.object({ claim_id: z.uuid(), outcome: z.enum(["confirm", "change", "reject"]).check(z.describe("confirm: as the other app shows it (seen, so surer); change: start at another level, with a reason; reject: not used, with a reason. The player reads the reason.")),
    level: z.optional(z.number().check(z.minimum(0), z.maximum(7), z.describe("The start on the club's 0 to 7: for change, and to confirm a level from an app whose scale isn't converted."))),
    reason: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const c = await claimOf(ctx.db, i.claim_id);
    if (c.status === "rejected" || c.status === "removed" || (c.status === "confirmed" && i.outcome === "confirm")) throw new KumiError("error.claim_answered");
    const r = await loadRating(ctx.db, c.person_id), person = await nameOf(ctx.db, c.person_id), reason = i.reason?.trim() ?? "";
    const p = c.platform as Platform, conf = c.conf as Confidence, shown = shownOf(c);
    const reads: Read[] = [{ entity: "level_claim", id: c.id, version: c.version }, ...await ratingRead(ctx.db, c.person_id)];
    const base = { title: both("action.level.answer_claim"), reads, ownerIds: [] as string[], undo: { kind: "none" as const } };
    if (i.outcome === "reject") {
      if (reason.length < 3) throw new KumiError("error.reject_needs_reason");
      return { ...base, details: {}, summary: join(both("plan.level.claim_reject", { person, source: source(p), shown, reason }), await afterGoing(ctx.db, c), both("plan.level.told")) };
    }
    if (r.games >= SELF_ADJUST_GAMES) throw new KumiError("error.import_late", { count: SELF_ADJUST_GAMES });
    let start: number;
    if (i.outcome === "change") {
      if (i.level === undefined || reason.length < 3) throw new KumiError("error.change_needs_level");
      start = round2(i.level);
    } else {
      const s = c.start_level !== null ? Number(c.start_level) : i.level ?? null;
      if (s === null) throw new KumiError("error.accept_needs_level");
      start = round2(s);
    }
    const sigma = startSigma(p, "staff_seen", conf) ?? 0.85;
    const mine: Candidate = { sigma, tie: appSigma(p, conf), at: new Date(c.created_at).getTime(), source: p, level: start };
    const best = (await candidates(ctx.db, c.person_id, { leave: c.id }))[0];
    const level = Math.max(r.floor ?? -Infinity, start);
    const result = !best || better(mine, best) < 0 ? both("plan.level.claim_result_start", { level: lvl(level) })
      : both("plan.level.claim_result_kept", { level: lvl(Math.max(r.floor ?? -Infinity, best.level)), best: source(best.source) });
    const say = i.outcome === "change" ? both("plan.level.claim_change", { person, source: source(p), shown, level: lvl(start), reason })
      : both("plan.level.claim_confirm", { person, source: source(p), shown, level: lvl(start) });
    return { ...base, details: { start, sigma }, summary: join(say, result, both("plan.level.told")) };
  },
  async apply(ctx, i, plan) {
    const c = await claimOf(ctx.trx, i.claim_id);
    if (c.status === "rejected" || c.status === "removed") throw new KumiError("error.changed");
    const answered = { answer: i.reason?.trim() || null, answered_by: ctx.actor.personId, answered_at: ctx.now, ...await dropProof(ctx, c) };
    if (i.outcome === "reject") await ctx.update("level_claim", c.id, { status: "rejected", ...answered });
    else {
      const { start, sigma } = plan.details as { start: number; sigma: number };
      if ((await loadRating(ctx.trx, c.person_id)).games >= SELF_ADJUST_GAMES) throw new KumiError("error.import_late", { count: SELF_ADJUST_GAMES });
      // Its start is written again from what staff saw (event_id cleared), if it's the surest.
      await ctx.update("level_claim", c.id, { status: "confirmed", evidence: "staff_seen", sigma, start_level: lvl(start), ...answered });
    }
    await settleStart(ctx, c.person_id);
    const r = await loadRating(ctx.trx, c.person_id);
    await ctx.emit("level.claim_answered", { claim_id: c.id, person_id: c.person_id, platform: c.platform, outcome: i.outcome, level: r.exists ? lvl(r.level) : null,
      start_level: i.outcome === "reject" ? null : lvl((plan.details as { start: number }).start), reason: i.reason?.trim() || null,
      ...(c.sent_by && c.sent_by !== c.person_id ? { sent_by: c.sent_by } : {}) });
    return { level: r.exists ? r.level : null };
  },
});

/** The player (or their parent) takes a claim away: before staff answer it, or while still new here. */
export const levelRemoveClaim = defineAction({
  name: "level.remove_claim", version: 1, clubWide: true,
  owners: async (db, i) => { const c = await db.selectFrom("level_claim").select("person_id").where("id", "=", i.claim_id).executeTakeFirst(); return withManagers(db, [c?.person_id]); },
  input: z.object({ claim_id: z.uuid() }),
  async plan(ctx, i) {
    const c = await claimOf(ctx.db, i.claim_id);
    if (!LIVE.includes(c.status)) throw new KumiError("error.claim_answered");
    if (c.status !== "waiting" && (await loadRating(ctx.db, c.person_id)).games >= SELF_ADJUST_GAMES) throw new KumiError("error.import_remove_late", { count: SELF_ADJUST_GAMES });
    const say = both(c.status === "waiting" ? "plan.level.remove_claim_waiting" : "plan.level.remove_claim", { source: source(c.platform), shown: shownOf(c) });
    return { title: both("action.level.remove_claim"), reads: [{ entity: "level_claim", id: c.id, version: c.version }, ...await ratingRead(ctx.db, c.person_id)],
      ownerIds: await withManagers(ctx.db, [c.person_id]), undo: { kind: "none" }, details: {}, summary: join(say, await afterGoing(ctx.db, c)) };
  },
  async apply(ctx, i) {
    const c = await claimOf(ctx.trx, i.claim_id);
    if (!LIVE.includes(c.status)) throw new KumiError("error.changed");
    await ctx.update("level_claim", c.id, { status: "removed", ...await dropProof(ctx, c) });
    await settleStart(ctx, c.person_id);
    const r = await loadRating(ctx.trx, c.person_id);
    return { level: r.exists ? r.level : null };
  },
});

/** For the staff Levels page: claims to answer, oldest first. Those waiting for staff, and those counting as the
 *  player's word that staff could still confirm (while the player is new here). */
export async function claimQueue(db: Db | Trx) {
  const rows = await db.selectFrom("level_claim").innerJoin("person", "person.id", "level_claim.person_id")
    .leftJoin("rating", (j) => j.onRef("rating.person_id", "=", "level_claim.person_id").on("rating.sport", "=", "padel"))
    .leftJoin("person as by", "by.id", "level_claim.sent_by")
    .select(["level_claim.id", "level_claim.person_id", "person.display_name as name", "level_claim.platform", "level_claim.raw", "level_claim.conf", "level_claim.start_level", "level_claim.status",
      "level_claim.profile_url", "level_claim.proof", "level_claim.created_at", "level_claim.sent_by", "by.display_name as sent_by_name", "level_claim.event_id", "rating.level", "rating.provisional", "rating.rated_games"])
    .where("level_claim.status", "in", ["waiting", "standing"]).orderBy("level_claim.created_at").execute();
  return rows.filter((r) => r.status === "waiting" || (r.rated_games ?? 0) < SELF_ADJUST_GAMES).map((r) => ({
    id: r.id, person_id: r.person_id, name: r.name, platform: r.platform, raw: r.raw, conf: r.conf as Confidence, start_level: r.start_level === null ? null : Number(r.start_level), status: r.status,
    profile_url: r.profile_url, proof: r.proof, created_at: r.created_at, sent_by: r.sent_by && r.sent_by !== r.person_id ? r.sent_by_name : null, level: r.level, provisional: r.provisional, rated_games: r.rated_games,
    shown: shownText(r.platform as Platform, r.raw, r.conf as Confidence) }));
}
