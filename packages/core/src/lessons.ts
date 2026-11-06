// Coaches and private lessons (v1 scope, Clinics and lessons, and Coaches). A coach's profile is what members
// see; their weekly hours and time off say when they give lessons; their rate for each length is the whole
// price, court included. A lesson is a court booking with a coach (kind 'lesson'), so it's held, paid (the
// whole, or each player's part), reminded and cancelled like any booking, and its court can't be taken twice.
// A coach can't be in two places at once either: their lessons and the sessions they run are checked under a
// lock on the coach, so two people booking the same coach at once can't both get the time.
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, money, type Lang, type Text, formatLocale } from "@kumi/i18n";
import { defineAction, readRow, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { mergeTranslations, translationsInput } from "./club_text.ts";
import { uuidv7 } from "./ids.ts";
import { localDate, onDate, weekdayOf } from "./clock.ts";
import { freeCourts, occupied } from "./bookings.ts";
import { currentPolicy } from "./prices.ts";
import { paymentProvider } from "./money.ts";
import { checkSlot, courtAndPlace, HOLD_MINUTES, newCode, notOwing, shares } from "./booking_pay.ts";
import { requireWaiver, withManagers } from "./households.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const when = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });
const join = (xs: Text[], sep = ", "): Text => ({ en: xs.map((x) => x.en).join(sep), es: xs.map((x) => x.es).join(sep) });
const clockTime = z.string().check(z.regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/));
const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
const hhmm = (t: string) => t.slice(0, 5);
const clubTz = async (db: Db | Trx) => (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
const nameOf = async (db: Db | Trx, id: string) => (await readRow(db, "person", id, "thing.person")).row.display_name as string;

// ---- Photos ----
/** The largest photo kept: the apps shrink a picture to 400 px before sending it, which comes well under. */
export const PHOTO_MAX_BYTES = 150_000;
export type PhotoType = "image/jpeg" | "image/png" | "image/webp";
/** What a picture's first bytes say it is. Only JPEG, PNG and WebP: never SVG, or anything that could run. */
export function photoType(b: Buffer): PhotoType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}
/** A coach's photo, for the apps and the public page. Only photos on a coach's profile are served. */
export async function coachPhoto(db: Db, photoId: string) {
  return (await db.selectFrom("photo").innerJoin("coach", "coach.photo_id", "photo.id").select(["photo.content_type", "photo.bytes"])
    .where("photo.id", "=", photoId).where("coach.active", "=", true).executeTakeFirst()) ?? null;
}

// ---- Who coaches ----
/** Whether a person holds the coach role. */
export async function isCoach(db: Db | Trx, personId: string): Promise<boolean> {
  return Boolean(await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id")
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).where("role.key", "=", "coach").executeTakeFirst());
}
type Rates = Record<string, number>;
/** "60 minutes $90.00, 90 minutes $125.00", shortest first. */
export function ratesText(rates: Rates): Text {
  const rows = Object.entries(rates).map(([m, c]) => [Number(m), c] as const).sort((a, b) => a[0] - b[0]);
  return rows.length ? join(rows.map(([m, c]) => both("plan.coach.rate_item", { minutes: both("ui.minutes", { count: m }), price: usd(c) }))) : both("plan.coach.no_rates");
}
/** The coach members can book a lesson with, or why not. */
async function lessonCoach(db: Db | Trx, coachId: string) {
  const c = await db.selectFrom("coach").innerJoin("person", "person.id", "coach.person_id").selectAll("coach").select("person.display_name as name")
    .where("coach.person_id", "=", coachId).executeTakeFirst();
  if (!c || !c.active || !c.lessons || !(await isCoach(db, coachId))) throw new KumiError("error.coach_no_lessons", { coach: c?.name ?? "" });
  return { ...c, rates: c.rates as Rates };
}

/** What keeps a coach busy between `from` and `to`: their lessons (one being paid for counts until its hold
 *  runs out) and the sessions they run. */
export async function coachBusy(db: Db | Trx, coachId: string, from: Date, to: Date, now: Date, skip: { sessionId?: string; bookingId?: string } = {}) {
  const lessons = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id")
    .select(["booking.id", sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
    .where("booking.coach_id", "=", coachId).where("booking.status", "in", ["held", "confirmed"]).where("court_time.active", "=", true)
    .where(sql<boolean>`court_time.during && tstzrange(${from}, ${to})`).$if(Boolean(skip.bookingId), (q) => q.where("booking.id", "!=", skip.bookingId!))
    .where((eb) => eb.or([eb("court_time.kind", "!=", "hold"), eb("court_time.hold_until", "is", null), eb("court_time.hold_until", ">", now)])).execute();
  const sessions = await db.selectFrom("session").select(["id", "starts_at as start", "ends_at as end"]).where("coach_id", "=", coachId).where("status", "!=", "cancelled")
    .where("starts_at", "<", to).where("ends_at", ">", from).$if(Boolean(skip.sessionId), (q) => q.where("id", "!=", skip.sessionId!)).execute();
  return [...lessons.map((x) => ({ kind: "lesson" as const, ...x })), ...sessions.map((x) => ({ kind: "session" as const, ...x }))];
}
/** The coach's stretches on a club date at each location, as instants, less their time off. */
async function coachDay(db: Db | Trx, coachId: string, day: string, tz: string) {
  const rows = await db.selectFrom("coach_hours").select(["location_id", "starts", "ends"]).where("coach_id", "=", coachId).where("weekday", "=", weekdayOf(day)).where("active", "=", true).execute();
  const from = onDate(day, "00:00", tz), to = onDate(day, "24:00", tz);
  const off = await db.selectFrom("coach_time_off").select([sql<Date>`lower(during)`.as("start"), sql<Date>`upper(during)`.as("end")])
    .where("coach_id", "=", coachId).where("active", "=", true).where(sql<boolean>`during && tstzrange(${from}, ${to})`).execute();
  return { stretches: rows.map((r) => ({ location_id: r.location_id, start: onDate(day, hhmm(r.starts), tz), end: onDate(day, hhmm(r.ends), tz) })), off };
}
const overlaps = (a: { start: Date; end: Date }, s: number, e: number) => new Date(a.start).getTime() < e && new Date(a.end).getTime() > s;

/** Why a coach can't give a lesson from `start` to `end` at a location (outside their hours there, on time off,
 *  or busy with something else), or null when they can. `bookingId`: the lesson being moved doesn't count. */
export async function coachNotFree(db: Db | Trx, coachId: string, locationId: string, start: Date, end: Date, now: Date, bookingId?: string): Promise<"not_then" | "busy" | null> {
  const tz = await clubTz(db), day = await coachDay(db, coachId, localDate(start, tz), tz);
  if (!day.stretches.some((x) => x.location_id === locationId && x.start <= start && end <= x.end) || day.off.some((x) => overlaps(x, start.getTime(), end.getTime()))) return "not_then";
  if ((await coachBusy(db, coachId, start, end, now, { bookingId })).length) return "busy";
  return null;
}

/** Every start on a club date when the coach gives a lesson of `minutes`: inside their hours, not on time off,
 *  not busy, and with a court free at that location. Each comes with the courts free then. */
export async function lessonTimes(db: Db | Trx, i: { coachId: string; date: string; minutes: number; now: Date }) {
  const c = await lessonCoach(db, i.coachId).catch(() => null);
  if (!c || !c.rates[String(i.minutes)]) return [];
  const tz = await clubTz(db), day = await coachDay(db, i.coachId, i.date, tz), len = i.minutes * 60_000;
  const busy = await coachBusy(db, i.coachId, onDate(i.date, "00:00", tz), onDate(i.date, "24:00", tz), i.now);
  const out: { start: string; location_id: string; court_ids: string[] }[] = [];
  for (const loc of [...new Set(day.stretches.map((s) => s.location_id))]) {
    const free = await freeCourts(db, { locationId: loc, date: i.date, minutes: i.minutes, now: i.now });
    const starts = [...new Set(free.courts.flatMap((x) => x.starts))].sort();
    for (const s of starts) {
      const a = new Date(s).getTime(), b = a + len;
      if (!day.stretches.some((x) => x.location_id === loc && x.start.getTime() <= a && b <= x.end.getTime())) continue;
      if (day.off.some((x) => overlaps(x, a, b)) || busy.some((x) => overlaps(x, a, b))) continue;
      out.push({ start: s, location_id: loc, court_ids: free.courts.filter((x) => x.starts.includes(s)).map((x) => x.id) });
    }
  }
  return out.sort((x, y) => x.start.localeCompare(y.start));
}

/** Coaches members can book, with what they show: never contact details. */
export async function lessonCoaches(db: Db | Trx) {
  const rows = await db.selectFrom("coach").innerJoin("person", "person.id", "coach.person_id")
    .select(["coach.person_id as id", "person.display_name as name", "coach.bio", "coach.translations", "coach.level_min", "coach.level_max", "coach.languages", "coach.rates", "coach.photo_id", "coach.lessons", "coach.max_players"])
    .where("coach.active", "=", true).where("person.status", "!=", "archived")
    .where((eb) => eb.exists(eb.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id")
      .whereRef("person_role.person_id", "=", "coach.person_id").where("person_role.active", "=", true).where("role.key", "=", "coach")))
    .orderBy("person.display_name").execute();
  return rows.map((r) => ({ ...r, rates: r.rates as Rates }));
}

// ---- The coach's own profile, hours and time off ----
const ratesInput = z.array(z.object({ minutes: z.number().check(z.int(), z.minimum(30), z.maximum(240), z.multipleOf(30)), cents: z.number().check(z.int(), z.minimum(0), z.maximum(100_000)) })).check(z.maxLength(6));
const levelInput = z.nullable(z.number().check(z.minimum(0.5), z.maximum(7)));

export const coachSetProfile = defineAction({
  name: "coach.set_profile", version: 1,
  input: z.object({ person_id: z.uuid(), bio: z.nullable(z.string().check(z.maxLength(600))), level_min: levelInput, level_max: levelInput,
    languages: z.array(z.enum(["en", "es"])).check(z.minLength(1), z.maxLength(2)), rates: ratesInput,
    lessons: z.boolean().check(z.describe("Whether members can book private lessons with this coach in the app.")), max_players: z.number().check(z.int(), z.minimum(1), z.maximum(4)),
    translations: translationsInput("coach") }),
  async plan(ctx, i) {
    const name = await nameOf(ctx.db, i.person_id);
    if (!(await isCoach(ctx.db, i.person_id))) throw new KumiError("error.not_a_coach", { name });
    if (i.level_min !== null && i.level_max !== null && i.level_max < i.level_min) throw new KumiError("error.bad_band");
    if (new Set(i.rates.map((r) => r.minutes)).size !== i.rates.length) throw new KumiError("error.rate_twice");
    const existing = await ctx.db.selectFrom("coach").select("person_id").where("person_id", "=", i.person_id).executeTakeFirst();
    const read = existing ? (await readRow(ctx.db, "coach", i.person_id, "thing.coach")).read : null;
    const rates = ratesText(Object.fromEntries(i.rates.map((r) => [String(r.minutes), r.cents])));
    return { title: both("action.coach.set_profile"), reads: read ? [read] : [], ownerIds: [i.person_id], undo: { kind: "reversible" },
      summary: both(i.lessons && i.rates.length ? "plan.coach.profile_lessons" : "plan.coach.profile_no_lessons", { name, rates }) };
  },
  async apply(ctx, i) {
    const row = { bio: i.bio?.trim() || null, level_min: i.level_min === null ? null : i.level_min.toFixed(2), level_max: i.level_max === null ? null : i.level_max.toFixed(2), languages: i.languages,
      rates: JSON.stringify(Object.fromEntries(i.rates.map((r) => [String(r.minutes), r.cents]))), lessons: i.lessons, max_players: i.max_players, active: true };
    const existing = await ctx.trx.selectFrom("coach").select(["person_id", "translations"]).where("person_id", "=", i.person_id).executeTakeFirst();
    const translations = JSON.stringify(mergeTranslations(existing?.translations, i.translations));
    if (existing) await ctx.update("coach", i.person_id, { ...row, translations }); else await ctx.insert("coach", { person_id: i.person_id, ...row, translations });
    return null;
  },
});

export const coachSetPhoto = defineAction({
  name: "coach.set_photo", version: 1,
  // The picture as base64: the apps shrink it to 400 px first. Null takes the photo off.
  input: z.object({ person_id: z.uuid(), photo: z.nullable(z.string().check(z.maxLength(Math.ceil(PHOTO_MAX_BYTES / 3) * 4 + 4))) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "coach", i.person_id, "thing.coach");
    const name = await nameOf(ctx.db, i.person_id);
    if (i.photo !== null) {
      const b = Buffer.from(i.photo, "base64");
      if (!b.length || b.length > PHOTO_MAX_BYTES) throw new KumiError("error.photo_too_big", { kb: Math.round(PHOTO_MAX_BYTES / 1000) });
      if (!photoType(b)) throw new KumiError("error.photo_type");
    }
    return { title: both("action.coach.set_photo"), summary: both(i.photo === null ? "plan.coach.photo_off" : "plan.coach.photo", { name }), reads: [read], ownerIds: [i.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    let photoId: string | null = null;
    if (i.photo !== null) {
      // Straight into its table, not through the change log: the bytes would swamp it. The profile's change is logged.
      const b = Buffer.from(i.photo, "base64");
      photoId = uuidv7();
      await ctx.trx.insertInto("photo").values({ id: photoId, content_type: photoType(b)!, bytes: b, created_by: ctx.actor.personId }).execute();
    }
    await ctx.update("coach", i.person_id, { photo_id: photoId });
    return { photo_id: photoId };
  },
});

/** "Mon 09:00 to 12:00, 17:00 to 21:00; Sat 08:00 to 12:00". */
function stretchesText(rows: { weekday: number; starts: string; ends: string }[]): Text {
  const f = (lang: Lang) => [1, 2, 3, 4, 5, 6, 0].map((w) => {
    const day = rows.filter((r) => r.weekday === w).sort((a, b) => a.starts.localeCompare(b.starts));
    if (!day.length) return null;
    const name = new Intl.DateTimeFormat(formatLocale(lang), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));
    return `${name} ${day.map((r) => `${r.starts} ${lang === "es" ? "a" : "to"} ${r.ends}`).join(", ")}`;
  }).filter(Boolean).join("; ");
  return { en: f("en"), es: f("es") };
}

export const coachSetHours = defineAction({
  name: "coach.set_hours", version: 1,
  input: z.object({ person_id: z.uuid(), location_id: z.uuid(),
    stretches: z.array(z.object({ weekday: z.number().check(z.int(), z.minimum(0), z.maximum(6)), starts: clockTime, ends: clockTime })).check(z.maxLength(28)) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "coach", i.person_id, "thing.coach");
    const loc = (await readRow(ctx.db, "location", i.location_id, "thing.location")).row;
    for (const s of i.stretches) if (s.ends <= s.starts) throw new KumiError("error.hours_backwards");
    for (const [k, a] of i.stretches.entries()) for (const b of i.stretches.slice(k + 1))
      if (a.weekday === b.weekday && a.starts < b.ends && b.starts < a.ends) throw new KumiError("error.hours_overlap");
    const name = await nameOf(ctx.db, i.person_id);
    return { title: both("action.coach.set_hours"), reads: [read], locationId: i.location_id, ownerIds: [i.person_id], undo: { kind: "reversible" },
      summary: i.stretches.length ? both("plan.coach.hours", { name, location: loc.name, hours: stretchesText(i.stretches) }) : both("plan.coach.no_hours", { name, location: loc.name }) };
  },
  async apply(ctx, i) {
    for (const r of await ctx.trx.selectFrom("coach_hours").select("id").where("coach_id", "=", i.person_id).where("location_id", "=", i.location_id).where("active", "=", true).execute())
      await ctx.update("coach_hours", r.id, { active: false });
    for (const s of i.stretches) await ctx.insert("coach_hours", { id: uuidv7(), coach_id: i.person_id, location_id: i.location_id, weekday: s.weekday, starts: s.starts, ends: s.ends });
    return null;
  },
});

export const coachTimeOffAdd = defineAction({
  name: "coach.time_off_add", version: 1,
  // Whole club days, from the first to the last.
  input: z.object({ person_id: z.uuid(), from: clubDate, to: clubDate, note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "coach", i.person_id, "thing.coach");
    if (i.to < i.from) throw new KumiError("error.dates_backwards");
    const tz = await clubTz(ctx.db), start = onDate(i.from, "00:00", tz), end = onDate(i.to, "24:00", tz);
    const booked = (await coachBusy(ctx.db, i.person_id, start, end, ctx.now)).filter((x) => x.kind === "lesson").length;
    const name = await nameOf(ctx.db, i.person_id), d = (x: string) => dayLong(x);
    const summary = both("plan.coach.time_off", { name, from: d(i.from), to: d(i.to) });
    return { title: both("action.coach.time_off_add"), reads: [read], ownerIds: [i.person_id], undo: { kind: "reversible" },
      summary: booked ? join([summary, both("plan.coach.time_off_booked", { count: booked })], " ") : summary };
  },
  async apply(ctx, i) {
    const tz = await clubTz(ctx.trx), id = uuidv7();
    await ctx.insert("coach_time_off", { id, coach_id: i.person_id, during: sql`tstzrange(${onDate(i.from, "00:00", tz)}, ${onDate(i.to, "24:00", tz)})`, note: i.note?.trim() || null });
    return { time_off_id: id };
  },
});
const dayLong = (date: string): Text => {
  const f = (lang: Lang) => new Intl.DateTimeFormat(formatLocale(lang), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  return { en: f("en"), es: f("es") };
};

export const coachTimeOffRemove = defineAction({
  name: "coach.time_off_remove", version: 1,
  input: z.object({ time_off_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "coach_time_off", i.time_off_id, "thing.time_off");
    if (!row.active) throw new KumiError("error.not_found", { thing: both("thing.time_off") }, 404);
    return { title: both("action.coach.time_off_remove"), summary: both("plan.coach.time_off_remove", { name: await nameOf(ctx.db, row.coach_id) }), reads: [read], ownerIds: [row.coach_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("coach_time_off", i.time_off_id, { active: false }); return null; },
});

// ---- Which coach runs a session ----
/** A coach for a session must hold the coach role and have no lesson then. */
async function checkSessionCoach(ctx: PlanCtx, coachId: string, start: Date, end: Date, sessionId?: string) {
  const name = await nameOf(ctx.db, coachId);
  if (!(await isCoach(ctx.db, coachId))) throw new KumiError("error.not_a_coach", { name });
  const [clash] = await coachBusy(ctx.db, coachId, start, end, ctx.now, { sessionId });
  if (clash) throw new KumiError("error.coach_busy", { coach: name, when: when(new Date(clash.start), await clubTz(ctx.db)) });
  return name;
}
export { checkSessionCoach };

export const sessionSetCoach = defineAction({
  name: "session.set_coach", version: 1,
  input: z.object({ session_id: z.uuid(), coach_id: z.nullable(z.uuid()) }),
  async plan(ctx, i) {
    const { row: s, read } = await readRow(ctx.db, "session", i.session_id, "thing.session");
    const p = (await readRow(ctx.db, "program", s.program_id, "thing.program")).row, at = when(new Date(s.starts_at), await clubTz(ctx.db));
    if (i.coach_id === null) return { title: both("action.session.set_coach"), summary: both("plan.session.no_coach", { program: p.name, when: at }), reads: [read], locationId: p.location_id, undo: { kind: "reversible" } };
    const coach = await checkSessionCoach(ctx, i.coach_id, new Date(s.starts_at), new Date(s.ends_at), s.id);
    return { title: both("action.session.set_coach"), summary: both("plan.session.coach", { coach, program: p.name, when: at }), reads: [read], locationId: p.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    if (i.coach_id) {
      // One booking of a coach at a time (a lesson asked for this very moment waits for this).
      await ctx.trx.selectFrom("person").select("id").where("id", "=", i.coach_id).forUpdate().execute();
      const s = await ctx.trx.selectFrom("session").select(["starts_at", "ends_at"]).where("id", "=", i.session_id).executeTakeFirstOrThrow();
      if ((await coachBusy(ctx.trx, i.coach_id, new Date(s.starts_at), new Date(s.ends_at), ctx.now, { sessionId: i.session_id })).length) throw new KumiError("error.changed");
    }
    await ctx.update("session", i.session_id, { coach_id: i.coach_id });
    return null;
  },
});

// ---- Booking a lesson ----
/** A court at the coach's location free for the lesson, if the member didn't pick one. */
async function lessonCourt(db: Db | Trx, coachId: string, start: Date, minutes: number, now: Date, tz: string) {
  const day = await coachDay(db, coachId, localDate(start, tz), tz), end = start.getTime() + minutes * 60_000;
  const where = day.stretches.find((x) => x.start.getTime() <= start.getTime() && end <= x.end.getTime());
  if (!where) return null;
  const courts = await db.selectFrom("court").select("id").where("location_id", "=", where.location_id).where("archived_at", "is", null).where("bookable", "=", true).orderBy("sort").orderBy("name").execute();
  const taken = new Set((await occupied(db, courts.map((c) => c.id), start, new Date(end), now)).map((x) => x.court_id));
  return courts.find((c) => !taken.has(c.id))?.id ?? null;
}

export const lessonRequest = defineAction({
  name: "lesson.request", version: 1,
  input: z.object({ coach_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }), minutes: z.number().check(z.int()), court_id: z.optional(z.uuid()),
    pay: z.enum(["whole", "split"]), players: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(4), z.describe("Players in the lesson. Paying each their part: 2 to 4."))), person_id: z.uuid() }),
  async plan(ctx, i) {
    const c = await lessonCoach(ctx.db, i.coach_id), rate = c.rates[String(i.minutes)];
    if (i.person_id === i.coach_id) throw new KumiError("error.own_lesson");
    await notOwing(ctx.db, i.person_id, ctx.actor.personId, ctx.now);
    await requireWaiver(ctx, i.person_id);
    if (rate === undefined) throw new KumiError("error.lesson_length", { coach: c.name, lengths: Object.keys(c.rates).join(", ") });
    const players = i.players ?? (i.pay === "split" ? 2 : 1);
    if (players > c.max_players) throw new KumiError("error.lesson_too_many", { coach: c.name, count: c.max_players });
    if (i.pay === "split" && players < 2) throw new KumiError("error.lesson_split_alone");
    const policy = await currentPolicy(ctx.db), tz = await clubTz(ctx.db), start = new Date(i.starts_at), end = new Date(start.getTime() + i.minutes * 60_000);
    // When the coach doesn't give lessons then, say that before anything about courts.
    const day = await coachDay(ctx.db, i.coach_id, localDate(start, tz), tz);
    if (!day.stretches.some((x) => x.start <= start && end <= x.end) || day.off.some((x) => overlaps(x, start.getTime(), end.getTime())))
      throw new KumiError("error.coach_not_then", { coach: c.name, when: when(start, tz) });
    if ((await coachBusy(ctx.db, i.coach_id, start, end, ctx.now)).length) throw new KumiError("error.coach_busy", { coach: c.name, when: when(start, tz) });
    const courtId = i.court_id ?? await lessonCourt(ctx.db, i.coach_id, start, i.minutes, ctx.now, tz);
    if (!courtId) throw new KumiError("error.court_taken");
    const { court } = await checkSlot(ctx, policy, { court_id: courtId, starts_at: i.starts_at, minutes: i.minutes }, i.person_id, { anyLength: true });
    if (!day.stretches.some((x) => x.location_id === court.location_id && x.start <= start && end <= x.end)) throw new KumiError("error.coach_not_there", { coach: c.name, court: court.name });
    if (i.pay === "split" && start.getTime() - ctx.now.getTime() <= policy.split_deadline_hours * 3600_000) throw new KumiError("error.too_late_to_split", { count: policy.split_deadline_hours });
    const club = await ctx.db.selectFrom("club").select("tax_rate_bp").executeTakeFirstOrThrow();
    const tax = Math.round(rate * club.tax_rate_bp / 10_000), total = rate + tax, s = shares(total, players);
    const p = { coach: c.name, court: court.name, when: when(start, tz), minutes: i.minutes, total: usd(total) };
    const summary = i.pay === "whole" ? both("plan.lesson.request_whole", { ...p, players: both("count.players", { count: players }) })
      : both("plan.lesson.request_split", { ...p, share: usd(s.organiser), players: both("count.players", { count: players }), others: usd(s.each), hours: both("count.hours", { count: policy.split_deadline_hours }) });
    // A parent books their junior's lesson: the lesson is the junior's, the parent pays and manages it.
    return { title: both("action.lesson.request"), summary, reads: [], locationId: court.location_id, ownerIds: await withManagers(ctx.db, [i.person_id]), undo: { kind: "compensating" },
      moneyCents: i.pay === "whole" ? total : s.organiser, details: { court_id: courtId, rate, tax, tax_bp: club.tax_rate_bp, total, players, policy_id: policy.id } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { court_id: string; rate: number; tax: number; tax_bp: number; total: number; players: number; policy_id: string };
    const start = new Date(i.starts_at), end = new Date(start.getTime() + i.minutes * 60_000);
    // The coach first, then the court: two people booking the same coach at once can't both get the time.
    await ctx.trx.selectFrom("person").select("id").where("id", "=", i.coach_id).forUpdate().execute();
    if ((await coachBusy(ctx.trx, i.coach_id, start, end, ctx.now)).length) throw new KumiError("error.changed");
    await ctx.trx.selectFrom("court").select("id").where("id", "=", d.court_id).forUpdate().execute();
    await ctx.trx.updateTable("court_time").set({ active: false }).where("court_id", "=", d.court_id).where("kind", "=", "hold").where("active", "=", true).where("hold_until", "<=", ctx.now).execute();
    const court = await courtAndPlace(ctx.trx, d.court_id), code = await newCode(ctx.trx), s = shares(d.total, d.players);
    const id = uuidv7(), bp = uuidv7(), payment = uuidv7();
    // What it cost, as sold: the coach's rate (court included) and the club's tax.
    const quote = { lines: [], lesson: { coach_id: i.coach_id, minutes: i.minutes, rate_cents: d.rate }, subtotal_cents: d.rate, tax_bp: d.tax_bp, tax_cents: d.tax, total_cents: d.total, priced: true, member: null };
    await ctx.insert("booking", { id, code, location_id: court.location_id, kind: "lesson", coach_id: i.coach_id, organiser_id: i.person_id, status: "held", source: "app", price_cents: d.total,
      tax_cents: d.tax, quote: JSON.stringify(quote), policy_id: d.policy_id, pay_mode: i.pay, players: d.players, invite_code: i.pay === "split" ? randomBytes(9).toString("base64url") : null });
    await ctx.insert("booking_player", { id: bp, booking_id: id, person_id: i.person_id, share_cents: i.pay === "whole" ? d.total : s.organiser });
    try {
      await ctx.insert("court_time", { id: uuidv7(), court_id: d.court_id, during: sql`tstzrange(${start}, ${end})`, kind: "hold", booking_id: id, hold_until: new Date(ctx.now.getTime() + HOLD_MINUTES * 60_000) });
    } catch (e: any) { if (e?.code === "23P01") throw new KumiError("error.court_taken"); throw e; }
    await ctx.insert("payment", { id: payment, person_id: i.person_id, amount_cents: i.pay === "whole" ? d.total : s.organiser, method: "card", provider: paymentProvider().name,
      provider_ref: null, status: "pending", booking_player_id: bp, save_card: i.pay === "split" });
    await ctx.emit("booking.requested", { booking_id: id });
    return { booking_id: id, code, payment_id: payment, total_cents: i.pay === "whole" ? d.total : s.organiser };
  },
});

// ---- For the coach and the club: the schedule, and earnings for payroll ----
/** A coach's lessons and the sessions they run, from `from` to `to`. */
export async function coachSchedule(db: Db | Trx, coachId: string, from: Date, to: Date) {
  const lessons = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
    .select(["booking.id", "booking.code", "booking.status", "booking.pay_mode", "booking.players", "court.name as court", sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
    .select((eb) => eb.selectFrom("booking_player").innerJoin("person", "person.id", "booking_player.person_id").select(sql<string>`string_agg(person.display_name, ', ' ORDER BY person.display_name)`.as("n"))
      .whereRef("booking_player.booking_id", "=", "booking.id").where("booking_player.removed_at", "is", null).where("booking_player.replaces", "is", null).as("players_names"))
    .where("booking.coach_id", "=", coachId).where("booking.status", "=", "confirmed").where("court_time.active", "=", true)
    .where(sql<boolean>`court_time.during && tstzrange(${from}, ${to})`).execute();
  const sessions = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id")
    .select(["session.id", "session.program_id", "program.name", "program.kind as program_kind", "session.starts_at as start", "session.ends_at as end"])
    .select((eb) => eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.program_id", "=", "program.id")
      .where((w) => w.or([w("enrolment.session_id", "is", null), w("enrolment.session_id", "=", w.ref("session.id"))])).where("enrolment.status", "in", ["booked", "attended"]).as("booked"))
    .where("session.coach_id", "=", coachId).where("session.status", "!=", "cancelled").where("session.starts_at", "<", to).where("session.ends_at", ">", from).execute();
  return [...lessons.map((x) => ({ kind: "lesson" as const, ...x })), ...sessions.map((x) => ({ kind: "session" as const, ...x, booked: Number(x.booked ?? 0) }))]
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

/** For payroll, club dates `from` to `to` (inclusive): each coach's lessons (what was paid, less what went
 *  back, whatever became of the lesson) and the sessions they ran. Only `coachIds`, when given. */
export async function coachEarnings(db: Db | Trx, from: string, to: string, coachIds?: string[]) {
  const tz = await clubTz(db), start = onDate(from, "00:00", tz), end = onDate(to, "24:00", tz);
  const lessons = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
    .innerJoin("person as coach", "coach.id", "booking.coach_id").leftJoin("person as org", "org.id", "booking.organiser_id")
    .select(["booking.id", "booking.code", "booking.status", "booking.coach_id", "coach.display_name as coach", "org.display_name as booked_by", "court.name as court",
      sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
    .select((eb) => [
      eb.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select((x) => x.fn.sum<string>("payment.amount_cents").as("c"))
        .whereRef("booking_player.booking_id", "=", "booking.id").where("payment.status", "=", "succeeded").as("paid"),
      eb.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select((x) => x.fn.sum<string>("refund.amount_cents").as("c"))
        .whereRef("booking_player.booking_id", "=", "booking.id").where("refund.status", "!=", "failed").as("back"),
    ])
    .where("booking.kind", "=", "lesson").where("booking.status", "in", ["confirmed", "completed", "cancelled"])
    // A cancelled lesson's court time is let go; its time is still when it was meant to be.
    .where(sql<boolean>`court_time.id = (SELECT ct.id FROM court_time ct WHERE ct.booking_id = booking.id ORDER BY ct.active DESC, ct.id LIMIT 1)`)
    .where(sql<boolean>`lower(court_time.during) >= ${start}`).where(sql<boolean>`lower(court_time.during) < ${end}`)
    .$if(Boolean(coachIds), (q) => q.where("booking.coach_id", "in", coachIds!.length ? coachIds! : ["00000000-0000-0000-0000-000000000000"])).orderBy(sql`lower(court_time.during)`).execute();
  const sessions = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").innerJoin("person as coach", "coach.id", "session.coach_id")
    .select(["session.id", "session.coach_id", "coach.display_name as coach", "program.name", "session.starts_at as start", "session.ends_at as end"])
    .where("session.status", "!=", "cancelled").where("session.starts_at", ">=", start).where("session.starts_at", "<", end)
    .$if(Boolean(coachIds), (q) => q.where("session.coach_id", "in", coachIds!.length ? coachIds! : ["00000000-0000-0000-0000-000000000000"])).orderBy("session.starts_at").execute();
  const minutes = (x: { start: Date; end: Date }) => Math.round((new Date(x.end).getTime() - new Date(x.start).getTime()) / 60_000);
  const lines = lessons.map((l) => ({ ...l, minutes: minutes(l), paid_cents: Number(l.paid ?? 0), refunded_cents: Number(l.back ?? 0), net_cents: Number(l.paid ?? 0) - Number(l.back ?? 0), paid: undefined, back: undefined }));
  const runs = sessions.map((s) => ({ ...s, minutes: minutes(s) }));
  const ids = [...new Set([...lines.map((l) => l.coach_id!), ...runs.map((s) => s.coach_id!)])];
  const coaches = ids.map((id) => {
    const mine = lines.filter((l) => l.coach_id === id), held = mine.filter((l) => l.status !== "cancelled"), ran = runs.filter((s) => s.coach_id === id);
    return { coach_id: id, coach: (mine[0]?.coach ?? ran[0]?.coach)!, lessons: held.length, lesson_minutes: held.reduce((n, l) => n + l.minutes, 0),
      net_cents: mine.reduce((n, l) => n + l.net_cents, 0), sessions: ran.length, session_minutes: ran.reduce((n, s) => n + s.minutes, 0) };
  }).sort((a, b) => a.coach.localeCompare(b.coach));
  return { from, to, time_zone: tz, coaches, lessons: lines, sessions: runs };
}
