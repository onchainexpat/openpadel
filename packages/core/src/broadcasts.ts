// Broadcasts (v1 scope, Staff > Messages): a message the club writes once, in each of its languages, to a
// group of members. A group (a segment) is a set of filters, saved with a name or built on the spot, and
// means whoever matches when it's used, not a list of names. Two purposes:
// - club news: only people whose latest answer to club news is yes (consent is append-only). Each email
//   carries a one-click unsubscribe (RFC 8058) that needs no sign-in;
// - a service notice (a court closed, a clinic moved): only to people with a booking or place on a date,
//   or in a program, about that. It needs no consent because it's about something of theirs.
// A junior without a login is reached through the adults who manage them ("For Mia: ..."); a kid with a
// login of their own is reached as the kid, and their parents get a copy of service notices only. The inbox
// copy is there at once; email is spread over club days under the club's daily cap, so the email service's
// limit and the club's own messages keep room. The sender (and managers, if the club wants) get a copy.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, pickLang, t, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { atLocal, localDate, onDate } from "./clock.ts";
import { dayText } from "./memberships.ts";
import { managersOf } from "./households.ts";
import { QUIET, quietUntil } from "./messages.ts";
import { hasPushDevice } from "./push.ts";

/** What a broadcast's words may name, filled in for each person. */
export const PLACEHOLDERS = ["first_name", "club"] as const;
/** A service notice about something this close goes at once, even in quiet hours. */
const URGENT_MS = 24 * 3600_000;

const day = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
export const MEMBERSHIP_FILTERS = ["member", "not_member", "past_due", "paused", "upcoming"] as const;
/** A group's filters: all of them must match. Leaving one out means anyone. */
export const filtersInput = z.object({
  membership: z.optional(z.enum(MEMBERSHIP_FILTERS)),
  plan_ids: z.optional(z.array(z.uuid()).check(z.maxLength(50))),
  level_min: z.optional(z.number().check(z.minimum(0), z.maximum(7))),
  level_max: z.optional(z.number().check(z.minimum(0), z.maximum(7))),
  tag_ids: z.optional(z.array(z.uuid()).check(z.maxLength(50))),
  played_within_days: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(3650))),
  not_played_days: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(3650))),
  age: z.optional(z.enum(["adult", "junior"])),
  lang: z.optional(z.enum(["en", "es"])),
  program_id: z.optional(z.uuid()),
  // One date of a program: whoever has a place on it (the whole program's, or that date's): the Schedule's "Message players".
  session_id: z.optional(z.uuid()),
  on_date: z.optional(day),
  joined_from: z.optional(day),
  joined_to: z.optional(day),
});
export type Filters = z.infer<typeof filtersInput>;
/** The filters as they're kept: only the ones set, so two groups that mean the same compare the same. */
export function cleanFilters(f: Filters): Filters {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) out[k] = Array.isArray(v) ? [...new Set(v)] : v;
  return out as Filters;
}

async function clubOf(db: Db | Trx) {
  return db.selectFrom("club").select(["name", "time_zone", "languages", "default_language", "broadcast_daily_cap", "broadcast_copy_managers"]).executeTakeFirstOrThrow();
}

// ---- Who's in a group ----
/** Where a person played or has a place between two instants: a court booking they're in, or a program date
 *  they're signed up for (a whole course, or that one date). */
const placeBetween = (from: Date, to: Date, statuses: string[]) => sql<boolean>`(EXISTS (
    SELECT 1 FROM booking_player bp JOIN booking b ON b.id = bp.booking_id JOIN court_time ct ON ct.booking_id = b.id AND ct.active
    WHERE bp.person_id = person.id AND bp.removed_at IS NULL AND b.status = 'confirmed' AND lower(ct.during) >= ${from} AND lower(ct.during) < ${to})
  OR EXISTS (
    SELECT 1 FROM enrolment e JOIN session s ON s.program_id = e.program_id AND (e.session_id IS NULL OR e.session_id = s.id)
    WHERE e.person_id = person.id AND e.status = ANY (${statuses}::text[]) AND s.status <> 'cancelled' AND s.starts_at >= ${from} AND s.starts_at < ${to}))`;

/** A membership that covers this person (theirs, or a family plan they're on), in one of these states. */
function covering(f: Filters, now: Date, state: "member" | "past_due" | "paused" | "upcoming" | "any") {
  const notPaused = sql`(m.paused_until IS NULL OR m.paused_until <= ${now} OR m.paused_from > ${now})`;
  const cond = state === "member" ? sql`(m.status = 'past_due' OR (m.status = 'active' AND (m.current_period_end IS NULL OR m.current_period_end > ${now}))) AND ${notPaused}`
    : state === "past_due" ? sql`m.status = 'past_due' AND ${notPaused}`
    : state === "paused" ? sql`m.status IN ('active', 'past_due') AND m.paused_from <= ${now} AND m.paused_until > ${now}`
    : state === "upcoming" ? sql`m.status = 'upcoming'`
    : sql`m.status IN ('upcoming', 'active', 'past_due')`;
  const plans = f.plan_ids?.length ? sql`AND m.plan_id = ANY (${f.plan_ids}::uuid[])` : sql``;
  return sql<boolean>`EXISTS (SELECT 1 FROM membership m WHERE ${cond} ${plans} AND (m.person_id = person.id OR EXISTS (
    SELECT 1 FROM membership_member mm WHERE mm.membership_id = m.id AND mm.person_id = person.id AND (mm.ends_at IS NULL OR mm.ends_at > ${now}))))`;
}

export type Member = { id: string; display_name: string; given_name: string | null; junior: boolean; own_login: boolean; locale: string; email: string | null };
/** Everyone a group's filters match now, by name. */
export async function segmentMembers(db: Db | Trx, filters: Filters, now: Date): Promise<Member[]> {
  const f = cleanFilters(filters), tz = (await clubOf(db)).time_zone;
  let q = db.selectFrom("person").select(["person.id", "person.display_name", "person.given_name", "person.junior", "person.own_login", "person.locale", "person.email"])
    .where("person.status", "!=", "archived").where("person.redacted_at", "is", null).where("person.created_via", "not in", ["support", "agent"]);   // not support access's accounts, nor club agents'
  if (f.membership === "not_member") q = q.where(sql<boolean>`NOT ${covering(f, now, "any")}`);
  else if (f.membership || f.plan_ids?.length) q = q.where(covering(f, now, f.membership ?? "member"));
  if (f.level_min !== undefined || f.level_max !== undefined)
    q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM rating r WHERE r.person_id = person.id AND r.sport = 'padel' AND r.level >= ${f.level_min ?? 0} AND r.level <= ${f.level_max ?? 99})`);
  if (f.tag_ids?.length) q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM person_tag pt JOIN tag tg ON tg.id = pt.tag_id AND tg.active WHERE pt.person_id = person.id AND pt.removed_at IS NULL AND pt.tag_id = ANY (${f.tag_ids}::uuid[]))`);
  if (f.played_within_days) q = q.where(placeBetween(new Date(now.getTime() - f.played_within_days * 864e5), now, ["booked", "attended"]));
  if (f.not_played_days) q = q.where(sql<boolean>`NOT ${placeBetween(new Date(now.getTime() - f.not_played_days * 864e5), now, ["booked", "attended"])}`);
  if (f.age) q = q.where("person.junior", "=", f.age === "junior");
  if (f.lang) q = q.where("person.locale", "=", f.lang);
  if (f.program_id) q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM enrolment e WHERE e.person_id = person.id AND e.program_id = ${f.program_id} AND e.status = 'booked')`);
  if (f.session_id) q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM enrolment e JOIN session s ON s.program_id = e.program_id AND (e.session_id IS NULL OR e.session_id = s.id)
    WHERE e.person_id = person.id AND e.status = 'booked' AND s.id = ${f.session_id})`);
  if (f.on_date) q = q.where(placeBetween(onDate(f.on_date, "00:00", tz), onDate(f.on_date, "24:00", tz), ["booked"]));
  if (f.joined_from) q = q.where("person.created_at", ">=", onDate(f.joined_from, "00:00", tz));
  if (f.joined_to) q = q.where("person.created_at", "<", onDate(f.joined_to, "24:00", tz));
  return (await q.orderBy("person.display_name").orderBy("person.id").execute()) as Member[];
}

/** The latest answer to club news by email: yes, no, or never asked (consent is append-only). */
async function newsYes(db: Db | Trx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.selectFrom("channel_consent").select(["person_id", "granted"]).distinctOn("person_id").where("person_id", "in", ids)
    .where("channel", "=", "email").where("purpose", "=", "club_news").orderBy("person_id").orderBy("at", "desc").orderBy("id", "desc").execute();
  return new Set(rows.filter((r) => r.granted).map((r) => r.person_id));
}

export interface Recipient { person_id: string; name: string; first_name: string; lang: Lang; email: string | null; juniors: string[] }
export type Purpose = "club_news" | "service";
/** Who a broadcast reaches: juniors through their parents, club news only with a yes. `sample`: the first names
 *  in the group, for staff to see who's in it; `reachSample`: the first of those it would actually reach, so a
 *  message's preview never names someone who'll be left out. */
export async function audience(db: Db | Trx, filters: Filters, purpose: Purpose, now: Date) {
  const club = await clubOf(db), members = await segmentMembers(db, filters, now);
  const direct = new Set<string>(), about = new Map<string, string[]>();
  let viaParents = 0;
  const via = (adult: string, junior: string) => { const l = about.get(adult) ?? []; if (!l.includes(junior)) l.push(junior); about.set(adult, l); };
  for (const m of members) {
    if (!m.junior) { direct.add(m.id); continue; }
    if (m.own_login) {
      direct.add(m.id);
      // A kid with a login of their own hears it themselves; their parents get a copy of service notices only.
      if (purpose === "service") for (const a of await managersOf(db, m.id)) via(a, m.display_name);
      continue;
    }
    viaParents++;
    for (const a of await managersOf(db, m.id)) via(a, m.display_name);
  }
  const ids = [...new Set([...direct, ...about.keys()])];
  const rows = ids.length ? await db.selectFrom("person").select(["id", "display_name", "given_name", "locale", "email"]).where("id", "in", ids)
    .where("status", "!=", "archived").where("redacted_at", "is", null).execute() : [];
  const yes = purpose === "club_news" ? await newsYes(db, rows.map((r) => r.id)) : null;
  const recipients: Recipient[] = [];
  let leftOut = 0;
  for (const r of rows.sort((a, b) => a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id))) {
    if (yes && !yes.has(r.id)) { leftOut++; continue; }
    recipients.push({ person_id: r.id, name: r.display_name, first_name: r.given_name?.trim() || r.display_name.trim().split(/\s+/)[0] || r.display_name,
      lang: pickLang(r.locale, pickLang(club.default_language)), email: r.email, juniors: direct.has(r.id) ? [] : about.get(r.id) ?? [] });
  }
  return { matched: members.length, recipients, leftOut, viaParents, sample: members.slice(0, 8).map((m) => m.display_name), reachSample: recipients.slice(0, 8).map((r) => r.name) };
}

/** When the thing a service notice is about starts: the date's first moment, or the program's next date. */
async function aboutStart(db: Db | Trx, f: Filters, tz: string, now: Date): Promise<Date | null> {
  if (f.session_id) return (await db.selectFrom("session").select("starts_at").where("id", "=", f.session_id).executeTakeFirst())?.starts_at ?? null;
  if (f.on_date) return onDate(f.on_date, "00:00", tz);
  if (f.program_id) {
    const s = await db.selectFrom("session").select((eb) => eb.fn.min("starts_at").as("s")).where("program_id", "=", f.program_id).where("status", "!=", "cancelled")
      .where("ends_at", ">", now).executeTakeFirst();
    return (s?.s as Date | null) ?? null;
  }
  return null;
}
const urgent = (start: Date | null, now: Date) => start !== null && start.getTime() - now.getTime() <= URGENT_MS;

/** When each of `n` emails goes: from `start`, as many each club day as the cap leaves after the broadcast
 *  emails already set for that day; later days start when quiet hours end. Nothing is written. */
export async function emailSlots(db: Db | Trx, n: number, start: Date, tz: string, cap: number): Promise<Date[]> {
  const slots: Date[] = [];
  let date = localDate(start, tz);
  for (let i = 0; slots.length < n && i < 1000; i++) {
    const from = onDate(date, "00:00", tz), to = onDate(date, "24:00", tz);
    const used = Number((await db.selectFrom("outbound_message").select((eb) => eb.fn.countAll<string>().as("n")).where("broadcast_id", "is not", null).where("channel", "=", "email")
      .where("status", "in", ["waiting", "sent"]).where("send_after", ">=", from).where("send_after", "<", to).executeTakeFirstOrThrow()).n);
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const at = i === 0 ? start : atLocal(y, m, d, QUIET.until, tz);
    for (let k = Math.max(0, cap - used); k > 0 && slots.length < n; k--) slots.push(at);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    date = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  }
  return slots;
}
const daysIn = (slots: Date[], tz: string) => Math.max(1, new Set(slots.map((s) => localDate(s, tz))).size);

// ---- The words ----
type Words = { subject_en?: string | null; body_en?: string | null; subject_es?: string | null; body_es?: string | null };
const clean = (v: string | null | undefined) => (v ?? "").trim() || null;
const cleanWords = (w: Words) => ({ subject_en: clean(w.subject_en), body_en: clean(w.body_en), subject_es: clean(w.subject_es), body_es: clean(w.body_es) });
async function clubLanguages(db: Db | Trx): Promise<Lang[]> {
  return ((await db.selectFrom("club").select("languages").executeTakeFirstOrThrow()).languages as string[]).filter((l): l is Lang => l === "en" || l === "es");
}
/** Each of the club's languages needs a subject and a body; only the placeholders Kumi fills are allowed. */
async function checkWords(db: Db | Trx, w: ReturnType<typeof cleanWords>) {
  for (const l of ["en", "es"] as const) if (Boolean(w[`subject_${l}`]) !== Boolean(w[`body_${l}`])) throw new KumiError("error.words_half", { lang: both(`lang.word_${l}`) });
  for (const l of await clubLanguages(db)) if (!w[`subject_${l}`]) throw new KumiError("error.words_need_lang", { lang: both(`lang.word_${l}`) });
  if (!w.subject_en && !w.subject_es) throw new KumiError("error.words_need_lang", { lang: both("lang.word_en") });
  for (const s of Object.values(w)) for (const m of (s ?? "").matchAll(/\{([^{}\s]*)\}/g))
    if (!(PLACEHOLDERS as readonly string[]).includes(m[1]!)) throw new KumiError("error.unknown_placeholder", { name: `{${m[1]}}`, known: PLACEHOLDERS.map((p) => `{${p}}`).join(", ") });
}
/** The words in one language: that one if the club wrote it, otherwise the other. */
function wordsIn(w: Words, lang: Lang): { subject: string; body: string } {
  const en = w.subject_en ? { subject: w.subject_en, body: w.body_en! } : null, es = w.subject_es ? { subject: w.subject_es, body: w.body_es! } : null;
  return (lang === "es" ? es ?? en : en ?? es)!;
}
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (all, k: string) => v[k] ?? all);
const subjectText = (w: Words): Text => ({ en: wordsIn(w, "en").subject, es: wordsIn(w, "es").subject });

// ---- Saying what a group is ----
const joinT = (xs: Text[], sep: Text): Text => ({ en: xs.map((x) => x.en).join(sep.en), es: xs.map((x) => x.es).join(sep.es) });
/** "members on Monthly, level 3.00 to 4.00, tagged league A", in each language; "everyone" with no filters. */
export async function describeFilters(db: Db | Trx, filters: Filters): Promise<Text> {
  const f = cleanFilters(filters), parts: Text[] = [], or: Text = { en: " or ", es: " o " };
  const named = async (table: "membership_plan" | "tag" | "program", ids: string[]) =>
    ids.length ? (await db.selectFrom(table).select(["id", "name"]).where("id", "in", ids).execute()).map((r) => r.name as string) : [];
  if (f.membership) parts.push(both(`seg.membership_${f.membership}`));
  if (f.plan_ids?.length) { const n = await named("membership_plan", f.plan_ids); parts.push(both(f.membership === "not_member" ? "seg.not_on_plans" : "seg.on_plans", { plans: joinT(n.map((x) => ({ en: x, es: x })), or) })); }
  const lv = (x: number) => x.toFixed(2);
  if (f.level_min !== undefined && f.level_max !== undefined) parts.push(both("seg.level_between", { from: lv(f.level_min), to: lv(f.level_max) }));
  else if (f.level_min !== undefined) parts.push(both("seg.level_from", { from: lv(f.level_min) }));
  else if (f.level_max !== undefined) parts.push(both("seg.level_to", { to: lv(f.level_max) }));
  if (f.tag_ids?.length) { const n = await named("tag", f.tag_ids); parts.push(both("seg.tagged", { tags: joinT(n.map((x) => ({ en: x, es: x })), or) })); }
  if (f.played_within_days) parts.push(both("seg.played_within", { count: f.played_within_days }));
  if (f.not_played_days) parts.push(both("seg.not_played", { count: f.not_played_days }));
  if (f.age) parts.push(both(`seg.age_${f.age}`));
  if (f.lang) parts.push(both("seg.lang", { lang: both(`lang.word_${f.lang}`) }));
  if (f.program_id) { const n = await named("program", [f.program_id]); parts.push(both("seg.program", { program: n[0] ?? "" })); }
  if (f.session_id) {
    const d = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").select(["program.name", "session.starts_at"]).where("session.id", "=", f.session_id).executeTakeFirst();
    const tz = (await clubOf(db)).time_zone;
    parts.push(both("seg.session", { program: d?.name ?? "", when: d ? { en: dateTime(d.starts_at, "en", tz), es: dateTime(d.starts_at, "es", tz) } : "" }));
  }
  if (f.on_date) parts.push(both("seg.on_date", { date: dayText(f.on_date) }));
  if (f.joined_from && f.joined_to) parts.push(both("seg.joined_between", { from: dayText(f.joined_from), to: dayText(f.joined_to) }));
  else if (f.joined_from) parts.push(both("seg.joined_from", { from: dayText(f.joined_from) }));
  else if (f.joined_to) parts.push(both("seg.joined_to", { to: dayText(f.joined_to) }));
  return parts.length ? joinT(parts, { en: ", ", es: ", " }) : both("seg.everyone");
}

// ---- Tags ----
const tagName = z.string().check(z.trim(), z.minLength(1), z.maxLength(40));
async function activeTagNamed(db: Db | Trx, name: string) {
  return (await db.selectFrom("tag").select(["id", "name"]).where("active", "=", true).where(sql<boolean>`lower(name) = lower(${name.trim()})`).executeTakeFirst()) ?? null;
}
async function nameOf(db: Db | Trx, id: string) { return (await readRow(db, "person", id, "thing.person")).row.display_name as string; }

export const tagCreate = defineAction({
  name: "tag.create", version: 1, clubWide: true,
  input: z.object({ name: tagName }),
  async plan(ctx, i) {
    if (await activeTagNamed(ctx.db, i.name)) throw new KumiError("error.tag_exists", { name: i.name });
    return { title: both("action.tag.create"), summary: both("plan.tag.create", { name: i.name }), reads: [], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("tag", { id, name: i.name, created_by: ctx.actor.personId, created_at: ctx.now });
    return { tag_id: id };
  },
});

export const tagUpdate = defineAction({
  name: "tag.update", version: 1, wholeClub: "reason.whole_club_tags",
  input: z.object({ tag_id: z.uuid(), name: z.optional(tagName), active: z.optional(z.boolean()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "tag", i.tag_id, "thing.tag");
    if (i.name !== undefined && i.name !== row.name) {
      const other = await activeTagNamed(ctx.db, i.name);
      if (other && other.id !== row.id) throw new KumiError("error.tag_exists", { name: i.name });
    }
    const on = await ctx.db.selectFrom("person_tag").select((eb) => eb.fn.countAll<string>().as("n")).where("tag_id", "=", row.id).where("removed_at", "is", null).executeTakeFirstOrThrow();
    if (i.active === false && row.active) return { title: both("action.tag.update"), summary: both("plan.tag.retire", { name: row.name, people: both("count.people", { count: Number(on.n) }) }), reads: [read], undo: { kind: "none" } };
    if (i.active === true && !row.active) {
      if (await activeTagNamed(ctx.db, i.name ?? row.name)) throw new KumiError("error.tag_exists", { name: i.name ?? row.name });
      return { title: both("action.tag.update"), summary: both("plan.tag.restore", { name: i.name ?? row.name }), reads: [read], undo: { kind: "reversible" } };
    }
    if (i.name === undefined || i.name === row.name) throw new KumiError("error.nothing_changed");
    return { title: both("action.tag.update"), summary: both("plan.tag.rename", { name: row.name, to: i.name, people: both("count.people", { count: Number(on.n) }) }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const patch: Record<string, unknown> = {};
    if (i.name !== undefined) patch.name = i.name;
    if (i.active !== undefined) patch.active = i.active;
    await ctx.update("tag", i.tag_id, patch);
    // A tag the club stops using comes off everyone who had it.
    if (i.active === false) for (const p of await ctx.trx.selectFrom("person_tag").select("id").where("tag_id", "=", i.tag_id).where("removed_at", "is", null).execute())
      await ctx.update("person_tag", p.id, { removed_at: ctx.now });
    return null;
  },
});

export const personTag = defineAction({
  name: "person.tag", version: 1, clubWide: true,
  // An existing tag, or a new one by name (made on the spot).
  input: z.object({ person_id: z.uuid(), tag_id: z.optional(z.uuid()), name: z.optional(tagName) }),
  async plan(ctx, i) {
    const person = await nameOf(ctx.db, i.person_id);
    const tag = i.tag_id ? (await readRow(ctx.db, "tag", i.tag_id, "thing.tag")).row : i.name ? await activeTagNamed(ctx.db, i.name) : null;
    if (!i.tag_id && !i.name) throw new KumiError("error.invalid_input", { details: "tag_id or name" }, 400);
    if (tag && i.tag_id && !(tag as { active?: boolean }).active) throw new KumiError("error.not_found", { thing: both("thing.tag") }, 404);
    if (tag && await ctx.db.selectFrom("person_tag").select("id").where("person_id", "=", i.person_id).where("tag_id", "=", tag.id).where("removed_at", "is", null).executeTakeFirst())
      throw new KumiError("error.already_tagged", { name: tag.name, person });
    return { title: both("action.person.tag"), reads: [], undo: { kind: "reversible" }, details: { tag_id: tag?.id ?? null },
      summary: both(tag ? "plan.person.tag" : "plan.person.tag_new", { person, tag: tag?.name ?? i.name! }) };
  },
  async apply(ctx, i, plan) {
    let tagId = (plan.details as { tag_id: string | null }).tag_id;
    if (!tagId) {
      const again = await activeTagNamed(ctx.trx, i.name!);
      tagId = again?.id ?? uuidv7();
      if (!again) await ctx.insert("tag", { id: tagId, name: i.name!, created_by: ctx.actor.personId, created_at: ctx.now });
    }
    try { await ctx.insert("person_tag", { id: uuidv7(), person_id: i.person_id, tag_id: tagId, added_by: ctx.actor.personId, created_at: ctx.now }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
    return { tag_id: tagId };
  },
});

export const personUntag = defineAction({
  name: "person.untag", version: 1, clubWide: true,
  input: z.object({ person_id: z.uuid(), tag_id: z.uuid() }),
  async plan(ctx, i) {
    const row = await ctx.db.selectFrom("person_tag").innerJoin("tag", "tag.id", "person_tag.tag_id").select(["person_tag.id", "tag.name"])
      .where("person_tag.person_id", "=", i.person_id).where("person_tag.tag_id", "=", i.tag_id).where("person_tag.removed_at", "is", null).executeTakeFirst();
    if (!row) throw new KumiError("error.not_tagged");
    const { read } = await readRow(ctx.db, "person_tag", row.id, "thing.tag");
    return { title: both("action.person.untag"), summary: both("plan.person.untag", { person: await nameOf(ctx.db, i.person_id), tag: row.name }), reads: [read], undo: { kind: "reversible" }, details: { id: row.id } };
  },
  async apply(ctx, _i, plan) { await ctx.update("person_tag", (plan.details as { id: string }).id, { removed_at: ctx.now }); return null; },
});

// ---- Saved groups ----
/** The filters as text with their keys in order (the database keeps jsonb keys in its own order). */
const stable = (o: unknown) => JSON.stringify(Object.fromEntries(Object.entries((o ?? {}) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
const segName = z.string().check(z.trim(), z.minLength(1), z.maxLength(60));
export const segmentSave = defineAction({
  name: "segment.save", version: 1, wholeClub: "reason.whole_club_groups",
  input: z.object({ name: segName, filters: filtersInput }),
  async plan(ctx, i) {
    const f = cleanFilters(i.filters), n = (await segmentMembers(ctx.db, f, ctx.now)).length;
    return { title: both("action.segment.save"), reads: [], undo: { kind: "reversible" },
      summary: both("plan.segment.save", { name: i.name, what: await describeFilters(ctx.db, f), people: both("count.people", { count: n }) }) };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("segment", { id, name: i.name, filters: JSON.stringify(cleanFilters(i.filters)), created_by: ctx.actor.personId, created_at: ctx.now });
    return { segment_id: id };
  },
});

export const segmentUpdate = defineAction({
  name: "segment.update", version: 1, wholeClub: "reason.whole_club_groups",
  input: z.object({ segment_id: z.uuid(), name: z.optional(segName), filters: z.optional(filtersInput), active: z.optional(z.boolean()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "segment", i.segment_id, "thing.segment");
    if (i.active === false) return { title: both("action.segment.update"), summary: both("plan.segment.off", { name: row.name }), reads: [read], undo: { kind: "reversible" } };
    const f = i.filters ? cleanFilters(i.filters) : row.filters as Filters;
    const same = (i.name === undefined || i.name === row.name) && stable(f) === stable(row.filters) && (i.active === undefined || i.active === row.active);
    if (same) throw new KumiError("error.nothing_changed");
    const n = (await segmentMembers(ctx.db, f, ctx.now)).length;
    return { title: both("action.segment.update"), reads: [read], undo: { kind: "reversible" },
      summary: both("plan.segment.update", { name: i.name ?? row.name, what: await describeFilters(ctx.db, f), people: both("count.people", { count: n }) }) };
  },
  async apply(ctx, i) {
    const patch: Record<string, unknown> = {};
    if (i.name !== undefined) patch.name = i.name;
    if (i.filters !== undefined) patch.filters = JSON.stringify(cleanFilters(i.filters));
    if (i.active !== undefined) patch.active = i.active;
    await ctx.update("segment", i.segment_id, patch);
    return null;
  },
});

// ---- Templates ----
const subject = z.optional(z.nullable(z.string().check(z.maxLength(150))));
const text = z.optional(z.nullable(z.string().check(z.maxLength(5000))));
const wordsShape = { subject_en: subject, body_en: text, subject_es: subject, body_es: text };

export const templateSave = defineAction({
  name: "template.save", version: 1, wholeClub: "reason.whole_club_templates",
  input: z.object({ name: segName, ...wordsShape }),
  async plan(ctx, i) {
    await checkWords(ctx.db, cleanWords(i));
    return { title: both("action.template.save"), summary: both("plan.template.save", { name: i.name }), reads: [], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("message_template", { id, name: i.name, ...cleanWords(i), created_by: ctx.actor.personId, created_at: ctx.now });
    return { template_id: id };
  },
});

export const templateUpdate = defineAction({
  name: "template.update", version: 1, wholeClub: "reason.whole_club_templates",
  input: z.object({ template_id: z.uuid(), name: z.optional(segName), ...wordsShape, active: z.optional(z.boolean()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "message_template", i.template_id, "thing.template");
    if (i.active === false) return { title: both("action.template.update"), summary: both("plan.template.off", { name: row.name }), reads: [read], undo: { kind: "reversible" } };
    const next = cleanWords({ ...row, ...Object.fromEntries(Object.entries(cleanWords(i)).filter(([k]) => (i as Record<string, unknown>)[k] !== undefined)) });
    await checkWords(ctx.db, next);
    return { title: both("action.template.update"), summary: both("plan.template.update", { name: i.name ?? row.name }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const patch: Record<string, unknown> = {};
    if (i.name !== undefined) patch.name = i.name;
    for (const k of ["subject_en", "body_en", "subject_es", "body_es"] as const) if (i[k] !== undefined) patch[k] = clean(i[k]);
    if (i.active !== undefined) patch.active = i.active;
    await ctx.update("message_template", i.template_id, patch);
    return null;
  },
});

// ---- Broadcasts ----
/** The group a broadcast goes to: a saved one, or filters given there and then. */
async function groupOf(db: Db | Trx, i: { segment_id?: string; filters?: Filters }) {
  if (i.segment_id) {
    const { row, read } = await readRow(db, "segment", i.segment_id, "thing.segment");
    if (!row.active) throw new KumiError("error.not_found", { thing: both("thing.segment") }, 404);
    return { filters: row.filters as Filters, name: row.name as string, read };
  }
  if (!i.filters) throw new KumiError("error.broadcast_no_group");
  return { filters: cleanFilters(i.filters), name: null, read: null };
}
/** A service notice is only for people with a place on a date, or in a program: what it's about. */
function checkService(f: Filters) {
  if (!f.on_date && !f.program_id && !f.session_id) throw new KumiError("error.service_needs_place");
}

/** What a broadcast would do now, in numbers: for the preview and the sender's copy. */
async function outlook(db: Db | Trx, f: Filters, purpose: Purpose, now: Date, sendAt: Date) {
  const club = await clubOf(db), a = await audience(db, f, purpose, now);
  const at = sendAt > now ? sendAt : now;
  const isUrgent = purpose === "service" && urgent(await aboutStart(db, f, club.time_zone, at), at);
  const start = isUrgent ? at : quietUntil(at, club.time_zone) ?? at;
  const emails = a.recipients.filter((r) => r.email).length;
  // A service notice about something within a day goes all at once: spread over days, it would come too late.
  const slots = isUrgent ? Array.from({ length: emails }, () => start) : await emailSlots(db, emails, start, club.time_zone, club.broadcast_daily_cap);
  return { club, a, isUrgent, start, emails, slots, days: emails ? daysIn(slots, club.time_zone) : 1, quiet: !isUrgent && start > at };
}

const when = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });

export const broadcastSend = defineAction({
  name: "broadcast.send", version: 1, wholeClub: "reason.whole_club_messages",
  input: z.object({ purpose: z.enum(["club_news", "service"]), segment_id: z.optional(z.uuid()), filters: z.optional(filtersInput), ...wordsShape,
    send_at: z.optional(z.iso.datetime({ offset: true })) }),
  async plan(ctx, i) {
    const g = await groupOf(ctx.db, i);
    if (i.purpose === "service") checkService(g.filters);
    const w = cleanWords(i);
    await checkWords(ctx.db, w);
    const sendAt = i.send_at ? new Date(i.send_at) : ctx.now;
    if (i.send_at && sendAt.getTime() < ctx.now.getTime() - 60_000) throw new KumiError("error.in_the_past");
    if (sendAt.getTime() > ctx.now.getTime() + 90 * 864e5) throw new KumiError("error.broadcast_too_far", { count: 90 });
    const o = await outlook(ctx.db, g.filters, i.purpose, ctx.now, sendAt);
    if (!o.a.recipients.length) throw new KumiError(o.a.leftOut ? "error.broadcast_no_consent" : "error.broadcast_nobody", { count: o.a.leftOut });
    const tz = o.club.time_zone, scheduled = sendAt.getTime() > ctx.now.getTime() + 60_000;
    const group = g.name ? both("plan.broadcast.group_named", { name: g.name, what: await describeFilters(ctx.db, g.filters) }) : await describeFilters(ctx.db, g.filters);
    const parts: Text[] = [both(i.purpose === "club_news" ? "plan.broadcast.news" : "plan.broadcast.service", { subject: subjectText(w), people: both("count.people", { count: o.a.recipients.length }), group })];
    if (o.a.leftOut) parts.push(both("plan.broadcast.left_out", { count: o.a.leftOut }));
    if (o.a.viaParents) parts.push(both("plan.broadcast.via_parents", { count: o.a.viaParents }));
    if (i.purpose === "service") parts.push(both("plan.broadcast.service_rule"));
    if (scheduled) parts.push(both("plan.broadcast.scheduled", { when: when(sendAt, tz) }));
    if (o.isUrgent) parts.push(both("plan.broadcast.urgent"));
    else if (o.quiet) parts.push(both("plan.broadcast.quiet", { when: when(o.start, tz) }));
    if (o.days > 1) parts.push(both("plan.broadcast.spread", { emails: o.emails, days: o.days, cap: o.club.broadcast_daily_cap }));
    // Undo isn't how a broadcast is called off: broadcast.cancel is (before it goes, or what's still to go).
    return { title: both("action.broadcast.send"), reads: g.read ? [g.read] : [], undo: { kind: "none", note: both(scheduled ? "reason.undo_cancel_broadcast" : "reason.undo_sent") },
      summary: joinT(parts, { en: " ", es: " " }), details: { filters: g.filters, segment_name: g.name } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { filters: Filters; segment_name: string | null };
    const id = uuidv7(), sendAt = i.send_at && new Date(i.send_at) > ctx.now ? new Date(i.send_at) : ctx.now;
    await ctx.insert("broadcast", { id, purpose: i.purpose, ...cleanWords(i), filters: JSON.stringify(d.filters), segment_id: i.segment_id ?? null, segment_name: d.segment_name,
      status: "scheduled", send_at: sendAt, created_by: ctx.actor.personId, created_at: ctx.now });
    if (sendAt.getTime() <= ctx.now.getTime() + 60_000) return { broadcast_id: id, ...(await deliver(ctx, id)) };
    return { broadcast_id: id, scheduled: true };
  },
});

/** Write a broadcast's messages for whoever matches now: the inbox copy at once, email and phone
 *  notifications from the start (after quiet hours for club news), email spread under the daily cap. */
async function deliver(ctx: ApplyCtx, broadcastId: string) {
  const b = await ctx.trx.selectFrom("broadcast").selectAll().where("id", "=", broadcastId).forUpdate().executeTakeFirstOrThrow();
  if (b.status !== "scheduled") return { already: b.status };
  const now = ctx.now, f = b.filters as Filters;
  const o = await outlook(ctx.trx, f, b.purpose, now, now);
  const slots = o.slots;
  const purpose = b.purpose === "club_news" ? "club_news" as const : "account" as const, essential = b.purpose === "service" && o.isUrgent;
  const rows: Record<string, unknown>[] = [];
  let slot = 0;
  for (const r of o.a.recipients) {
    let words = wordsIn(b, r.lang);
    words = { subject: fill(words.subject, { first_name: r.first_name, club: o.club.name }), body: fill(words.body, { first_name: r.first_name, club: o.club.name }) };
    // Reached through a junior: say whom it's about.
    if (r.juniors.length) {
      const name = r.juniors.join(r.lang === "es" ? " y " : " and ");
      words = { subject: t(r.lang, "msg.for_junior.subject", { name, text: words.subject }), body: t(r.lang, "msg.for_junior.body", { name, text: words.body }) };
    }
    const base = { broadcast_id: b.id, event_id: null, person_id: r.person_id, kind: "broadcast", purpose, essential, lang: r.lang, ...words, link: null, stale_at: null };
    rows.push({ ...base, id: uuidv7(now.getTime()), channel: "inbox", status: "sent", send_after: now, sent_at: now });
    if (r.email) rows.push({ ...base, id: uuidv7(now.getTime()), channel: "email", status: "waiting", send_after: slots[slot++] ?? o.start, sent_at: null });
    if (await hasPushDevice(ctx.trx, r.person_id)) rows.push({ ...base, id: uuidv7(now.getTime()), channel: "push", status: "waiting", send_after: o.start, sent_at: null });
  }
  for (let k = 0; k < rows.length; k += 500) await ctx.trx.insertInto("outbound_message").values(rows.slice(k, k + 500) as any).onConflict((oc) => oc.doNothing()).execute();
  await ctx.update("broadcast", b.id, { status: "sent", sent_at: now, matched: o.a.matched, recipients: o.a.recipients.length, left_out_consent: o.a.leftOut, email_days: o.days });
  await copies(ctx, b, o.a.recipients.length, o.a.leftOut, o.days);
  return { recipients: o.a.recipients.length, left_out: o.a.leftOut, email_days: o.days };
}

/** The sender's copy (and managers', if the club wants one): what went, to whom, and the words. */
async function copies(ctx: ApplyCtx, b: { id: string; purpose: Purpose; filters: unknown; segment_name: string | null; created_by: string | null } & Words, recipients: number, leftOut: number, days: number) {
  const club = await clubOf(ctx.trx);
  const to = new Set<string>(b.created_by ? [b.created_by] : []);
  if (club.broadcast_copy_managers) for (const r of await ctx.trx.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.person_id")
    .where("role.key", "in", ["owner", "manager"]).where("person_role.active", "=", true).execute()) to.add(r.person_id);
  if (!to.size) return;
  const group = b.segment_name ? both("plan.broadcast.group_named", { name: b.segment_name, what: await describeFilters(ctx.trx, b.filters as Filters) }) : await describeFilters(ctx.trx, b.filters as Filters);
  const people = await ctx.trx.selectFrom("person").select(["id", "locale", "email", "redacted_at", "status"]).where("id", "in", [...to]).execute();
  const rows: Record<string, unknown>[] = [];
  for (const p of people) {
    if (p.redacted_at || p.status === "archived") continue;
    const lang = pickLang(p.locale, pickLang(club.default_language)), w = wordsIn(b, lang);
    const subject = t(lang, "msg.broadcast_copy.subject", { subject: w.subject });
    const body = t(lang, "msg.broadcast_copy.body", { people: t(lang, "count.people", { count: recipients }), group: group[lang], purpose: t(lang, b.purpose === "club_news" ? "ui.purpose_club_news" : "ui.purpose_service"),
      left_out: leftOut ? t(lang, "msg.broadcast_copy.left_out", { count: leftOut }) : "",
      spread: days > 1 ? t(lang, "msg.broadcast_copy.spread", { days }) : "", subject: w.subject, body: w.body }).replace(/ {2,}/g, " ");
    const base = { broadcast_id: b.id, event_id: null, person_id: p.id, kind: "broadcast_copy", purpose: "staff", essential: false, lang, subject, body, link: "/messages", stale_at: null };
    rows.push({ ...base, id: uuidv7(ctx.now.getTime()), channel: "inbox", status: "sent", send_after: ctx.now, sent_at: ctx.now });
    if (p.email) rows.push({ ...base, id: uuidv7(ctx.now.getTime()), channel: "email", status: "waiting", send_after: ctx.now, sent_at: null });
    if (await hasPushDevice(ctx.trx, p.id)) rows.push({ ...base, id: uuidv7(ctx.now.getTime()), channel: "push", status: "waiting", send_after: ctx.now, sent_at: null });
  }
  if (rows.length) await ctx.trx.insertInto("outbound_message").values(rows as any).onConflict((oc) => oc.doNothing()).execute();
}

/** Kumi sends a scheduled broadcast when its time comes (whoever matches then gets it). */
export const broadcastDeliver = defineAction({
  name: "broadcast.deliver", version: 1, system: true, internal: true,
  input: z.object({ broadcast_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "broadcast", i.broadcast_id, "thing.broadcast");
    return { title: both("action.broadcast.deliver"), summary: both("plan.broadcast.deliver", { subject: subjectText(row as Words) }), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const b = await ctx.trx.selectFrom("broadcast").select(["status", "send_at"]).where("id", "=", i.broadcast_id).executeTakeFirstOrThrow();
    if (b.status !== "scheduled" || b.send_at > ctx.now) return { already: b.status };
    return deliver(ctx, i.broadcast_id);
  },
});

/** The job: broadcasts whose time has come. */
export async function sendBroadcasts(db: Db, now = new Date()) {
  const due = await db.selectFrom("broadcast").select("id").where("status", "=", "scheduled").where("send_at", "<=", now).orderBy("send_at").execute();
  let sent = 0;
  for (const b of due) {
    const r = await runAsSystem(db, "broadcast.deliver", { broadcast_id: b.id }, "jobs", { now });
    if (!(r.result as { already?: string })?.already) sent++;
  }
  return { sent };
}

export const broadcastCancel = defineAction({
  name: "broadcast.cancel", version: 1, wholeClub: "reason.whole_club_messages",
  input: z.object({ broadcast_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "broadcast", i.broadcast_id, "thing.broadcast");
    const tz = (await clubOf(ctx.db)).time_zone, subject = subjectText(row as Words);
    if (row.status === "scheduled") return { title: both("action.broadcast.cancel"), summary: both("plan.broadcast.cancel", { subject, when: when(row.send_at, tz) }), reads: [read], undo: { kind: "none" } };
    const waiting = Number((await ctx.db.selectFrom("outbound_message").select((eb) => eb.fn.countAll<string>().as("n")).where("broadcast_id", "=", row.id).where("kind", "=", "broadcast")
      .where("status", "=", "waiting").where("channel", "=", "email").executeTakeFirstOrThrow()).n);
    if (row.status !== "sent" || !waiting) throw new KumiError("error.broadcast_gone");
    return { title: both("action.broadcast.cancel"), summary: both("plan.broadcast.stop", { subject, count: waiting }), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const b = await ctx.trx.selectFrom("broadcast").select(["status"]).where("id", "=", i.broadcast_id).forUpdate().executeTakeFirstOrThrow();
    if (b.status === "scheduled") { await ctx.update("broadcast", i.broadcast_id, { status: "cancelled", cancelled_at: ctx.now }); return { cancelled: true }; }
    const r = await ctx.trx.updateTable("outbound_message").set({ status: "dropped", failure: "stopped by the club" }).where("broadcast_id", "=", i.broadcast_id).where("kind", "=", "broadcast")
      .where("status", "=", "waiting").where("channel", "in", ["email", "push"]).executeTakeFirst();
    await ctx.update("broadcast", i.broadcast_id, { status: "stopped", cancelled_at: ctx.now });
    return { stopped: Number(r.numUpdatedRows) };
  },
});

/** What each broadcast came to, by channel: sent, still to go, dropped (no consent by then, or stopped), failed. */
export async function broadcastCounts(db: Db | Trx, ids: string[]) {
  if (!ids.length) return new Map<string, Record<string, Record<string, number>>>();
  const rows = await db.selectFrom("outbound_message").select((eb) => ["broadcast_id", "channel", "status", eb.fn.countAll<string>().as("n")])
    .where("broadcast_id", "in", ids).where("kind", "=", "broadcast").groupBy(["broadcast_id", "channel", "status"]).execute();
  const out = new Map<string, Record<string, Record<string, number>>>();
  for (const r of rows) {
    const b = out.get(r.broadcast_id!) ?? {};
    (b[r.channel] ??= {})[r.status] = Number(r.n);
    out.set(r.broadcast_id!, b);
  }
  return out;
}

// ---- Saying yes or no to club news ----
async function clubNews(db: Db | Trx, personId: string): Promise<boolean | null> {
  const c = await db.selectFrom("channel_consent").select("granted").where("person_id", "=", personId).where("channel", "=", "email").where("purpose", "=", "club_news")
    .orderBy("at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst();
  return c ? c.granted : null;
}
export { clubNews as clubNewsAnswer };

/** The club-news list (the `club_news` read): adults with an account here and an email whose latest answer to club news
 *  by email is yes, a page at a time in id order. Each row is their id, email, first name and language, and nothing
 *  else: it's what a marketing sync (the Klaviyo plugin) is given, filtered here on the server for whoever reads it. */
export const NEWS_LIST_PAGE = 500;
export interface NewsListRow { id: string; email: string; first_name: string; language: Lang }
export async function clubNewsList(db: Db | Trx, o: { after?: string | null; limit?: number } = {}): Promise<{ total: number; members: NewsListRow[]; next: string | null }> {
  const club = await clubOf(db), limit = Math.min(Math.max(1, Math.floor(o.limit ?? NEWS_LIST_PAGE)), NEWS_LIST_PAGE);
  const said = sql<boolean>`(SELECT c.granted FROM channel_consent c WHERE c.person_id = person.id AND c.channel = 'email' AND c.purpose = 'club_news'
    ORDER BY c.at DESC, c.id DESC LIMIT 1) IS TRUE`;
  const yes = () => db.selectFrom("person").where("status", "!=", "archived").where("redacted_at", "is", null).where("junior", "=", false)
    .where("email", "is not", null).where("email", "!=", "").where(said);
  const total = Number((await yes().select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
  const rows = await yes().select(["id", "email", "display_name", "given_name", "locale"]).$if(Boolean(o.after), (q) => q.where("id", ">", o.after!))
    .orderBy("id").limit(limit + 1).execute();
  const page = rows.slice(0, limit);
  return { total, next: rows.length > limit ? page.at(-1)!.id : null, members: page.map((r) => ({ id: r.id, email: r.email!.trim().toLowerCase(),
    first_name: r.given_name?.trim() || r.display_name.trim().split(/\s+/)[0] || "", language: pickLang(r.locale, pickLang(club.default_language)) })) };
}

export const consentClubNews = defineAction({
  name: "consent.club_news", version: 1,
  input: z.object({ person_id: z.uuid(), granted: z.boolean() }),
  owners: async (_db, i) => [i.person_id],   // their answer ("nothing changed") is theirs
  async plan(ctx, i) {
    const club = await clubOf(ctx.db);
    if (await clubNews(ctx.db, i.person_id) === i.granted) throw new KumiError("error.nothing_changed");
    return { title: both("action.consent.club_news"), summary: both(i.granted ? "plan.consent.news_yes" : "plan.consent.news_no", { club: club.name }), reads: [], ownerIds: [i.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: i.person_id, channel: "email", purpose: "club_news", granted: i.granted, source: "profile", form_version: null,
      evidence: JSON.stringify({ via: ctx.actor.via }), at: ctx.now }).execute();
    await ctx.emit(i.granted ? "club_news.joined" : "club_news.left", { person_id: i.person_id, ...(i.granted ? {} : { why: "said_no" }) });
    return null;
  },
});

/** From the link in a club news email, with no sign-in: the link's key stops club news by email for its
 *  person, and nothing else. */
export const consentUnsubscribe = defineAction({
  name: "consent.unsubscribe", version: 1, system: true, internal: true,
  input: z.object({ token: z.string().check(z.minLength(20), z.maxLength(80)), how: z.enum(["one_click", "page"]) }),
  async plan(ctx, i) {
    const p = await ctx.db.selectFrom("person").select(["id"]).where("news_token", "=", i.token).where("redacted_at", "is", null).executeTakeFirst();
    if (!p) throw new KumiError("error.not_found", { thing: both("thing.link") }, 404);
    return { title: both("action.consent.unsubscribe"), summary: both("plan.consent.unsubscribe"), reads: [], undo: { kind: "none" }, details: { person_id: p.id } };
  },
  async apply(ctx, i, plan) {
    const personId = (plan.details as { person_id: string }).person_id;
    if (await clubNews(ctx.trx, personId) === false) return { already: true, person_id: personId };
    await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: personId, channel: "email", purpose: "club_news", granted: false, source: "unsubscribe_link", form_version: null,
      evidence: JSON.stringify({ how: i.how }), at: ctx.now }).execute();
    await ctx.emit("club_news.left", { person_id: personId, why: "unsubscribed" });
    return { person_id: personId };
  },
});

/** Turn off club news from an email's link. Who it was for, so the page can speak their language. */
export async function unsubscribe(db: Db, token: string, how: "one_click" | "page", now = new Date()) {
  const r = await runAsSystem(db, "consent.unsubscribe", { token, how }, "email_link", { now });
  return r.result as { person_id: string; already?: boolean };
}
/** The person an unsubscribe link is for (their language and the club's name for the page), or null. */
export async function unsubscribeTarget(db: Db, token: string) {
  if (token.length < 20 || token.length > 80) return null;
  const p = await db.selectFrom("person").select(["id", "locale"]).where("news_token", "=", token).where("redacted_at", "is", null).executeTakeFirst();
  if (!p) return null;
  const club = await clubOf(db);
  return { lang: pickLang(p.locale, pickLang(club.default_language)), club: club.name, answer: await clubNews(db, p.id) };
}
