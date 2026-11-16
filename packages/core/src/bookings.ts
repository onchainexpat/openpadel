// Court bookings, part one: when each location is open, courts taken out of use, bookings made at the desk,
// and which courts are free. Bookings and blocks are court_time rows, so the database itself refuses two
// things on one court at once; each write also locks its courts first, in id order, which keeps a rush on
// one slot from stalling or deadlocking (spikes/booking_race.md).
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, money, t, type Key, type Lang, type Text, formatLocale } from "@kumi/i18n";
import { defineAction, mayAlso, readRow, type ApplyCtx, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localParts, onDate, weekdayOf } from "./clock.ts";
import { currentPolicy, quote } from "./prices.ts";
import { band, joinRule, levelOf } from "./match_rules.ts";
import { deskMethod, deskPlace, placeFilled, type DeskPlace } from "./desk_places.ts";

/** "in cash", "on the club's card reader", "another way" (desk_pay.ts paidHow). */
export const paidHowOf = (method: string): Text => both(`paid_by.${method}` as Key);
const clockTime = z.string().check(z.regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/));
const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
/** Bookings are in steps of half an hour, from half an hour to eight. Members choose 60, 90 or 120. */
export const STEP_MINUTES = 30, MAX_MINUTES = 480, MEMBER_LENGTHS = [60, 90, 120] as const;

export async function locationTz(db: Db | Trx, locationId: string): Promise<string> {
  return (await readRow(db, "location", locationId, "thing.location")).row.time_zone;
}
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const dayOf = (date: string, lang: Lang) => new Intl.DateTimeFormat(formatLocale(lang), { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));

type Open = { opens: Date; closes: Date };
/** When a location is open on a club date: its special day if it has one, otherwise its weekday. A special day
 *  for one court only (below) isn't the location's. */
export async function openingOn(db: Db | Trx, locationId: string, day: string): Promise<Open | null> {
  const tz = await locationTz(db, locationId);
  const special = await db.selectFrom("hours_exception").select(["opens", "closes"]).where("location_id", "=", locationId).where("court_id", "is", null).where("on_date", "=", day).where("active", "=", true).executeTakeFirst();
  const row = special ?? await db.selectFrom("opening_hours").select(["opens", "closes"]).where("location_id", "=", locationId).where("weekday", "=", weekdayOf(day)).executeTakeFirst();
  if (!row?.opens || !row.closes) return null;
  return { opens: onDate(day, hhmm(row.opens)!, tz), closes: onDate(day, hhmm(row.closes)!, tz) };
}

/** When each of a location's courts is open on a club date. A court can have its own week (an outdoor court that
 *  closes at dusk, one that opens later), inside the location's hours or outside them; a weekday it has no hours
 *  of its own follows the location's. Special days: the court's own for that date, otherwise the location's,
 *  which apply to every court. */
export async function courtOpenings(db: Db | Trx, locationId: string, courtIds: string[], day: string): Promise<Map<string, Open | null>> {
  return (await courtOpeningsOn(db, locationId, courtIds, [day])).get(day)!;
}
/** courtOpenings for several club dates at once (Reports' days, up to a quarter): the same rules, read once
 *  instead of once a day. */
export async function courtOpeningsOn(db: Db | Trx, locationId: string, courtIds: string[], days: string[]): Promise<Map<string, Map<string, Open | null>>> {
  const all = new Map<string, Map<string, Open | null>>();
  if (!days.length) return all;
  const tz = await locationTz(db, locationId);
  const special = await db.selectFrom("hours_exception").select(["on_date", "court_id", "opens", "closes"]).where("location_id", "=", locationId).where("on_date", "in", days).where("active", "=", true).execute();
  const own = courtIds.length ? await db.selectFrom("court_hours").select(["weekday", "court_id", "opens", "closes"]).where("court_id", "in", courtIds).where("active", "=", true).execute() : [];
  const weeks = await db.selectFrom("opening_hours").select(["weekday", "opens", "closes"]).where("location_id", "=", locationId).execute();
  for (const day of days) {
    const w = weekdayOf(day), sp = special.filter((x) => String(x.on_date) === day), mine = own.filter((x) => x.weekday === w), week = weeks.find((x) => x.weekday === w);
    const out = new Map<string, Open | null>();
    for (const id of courtIds) {
      const row = sp.find((x) => x.court_id === id) ?? sp.find((x) => x.court_id === null) ?? mine.find((x) => x.court_id === id) ?? week;
      out.set(id, row?.opens && row.closes ? { opens: onDate(day, hhmm(row.opens)!, tz), closes: onDate(day, hhmm(row.closes)!, tz) } : null);
    }
    all.set(day, out);
  }
  return all;
}
/** When one court is open on a club date (courtOpenings). */
export async function courtOpening(db: Db | Trx, court: { id: string; location_id: string }, day: string): Promise<Open | null> {
  return (await courtOpenings(db, court.location_id, [court.id], day)).get(court.id) ?? null;
}
/** From the earliest opening to the latest closing among these: the location's day on the Schedule. */
export function spanOf(opens: (Open | null)[]): Open | null {
  const o = opens.filter((x): x is Open => Boolean(x));
  return o.length ? { opens: new Date(Math.min(...o.map((x) => x.opens.getTime()))), closes: new Date(Math.max(...o.map((x) => x.closes.getTime()))) } : null;
}

/** What holds courts in a window: everything active, except checkout holds that have run out. */
export async function occupied(db: Db | Trx, courtIds: string[], from: Date, to: Date, now: Date) {
  if (!courtIds.length) return [];
  return db.selectFrom("court_time").select(["id", "court_id", "kind", "booking_id", "block_id", "session_id"])
    .select([sql<Date>`lower(during)`.as("start"), sql<Date>`upper(during)`.as("end")])
    .where("court_id", "in", courtIds).where("active", "=", true).where(sql<boolean>`during && tstzrange(${from}, ${to})`)
    .where((eb) => eb.or([eb("kind", "!=", "hold"), eb("hold_until", "is", null), eb("hold_until", ">", now)]))
    .orderBy(sql`lower(during)`).execute();
}

/** Each bookable court at a location, and every start time on that date when it's free for `minutes`, inside
 *  that court's own hours. `open` is from the earliest opening to the latest closing. */
export async function freeCourts(db: Db | Trx, i: { locationId: string; date: string; minutes: number; now: Date }) {
  const courts = await db.selectFrom("court").select(["id", "name", "kind"]).where("location_id", "=", i.locationId).where("archived_at", "is", null).where("bookable", "=", true).orderBy("sort").orderBy("name").execute();
  const hours = await courtOpenings(db, i.locationId, courts.map((c) => c.id), i.date), open = spanOf([...hours.values()]);
  if (!open) return { open: null, courts: [] };
  const taken = await occupied(db, courts.map((c) => c.id), open.opens, open.closes, i.now);
  const len = i.minutes * 60_000, step = STEP_MINUTES * 60_000;
  return { open, courts: courts.map((c) => {
    const busy = taken.filter((t) => t.court_id === c.id), mine = hours.get(c.id) ?? null;
    const starts: string[] = [];
    if (mine) for (let s = mine.opens.getTime(); s + len <= mine.closes.getTime(); s += step) {
      if (s < i.now.getTime()) continue;
      if (!busy.some((b) => new Date(b.start).getTime() < s + len && new Date(b.end).getTime() > s)) starts.push(new Date(s).toISOString());
    }
    return { ...c, open: mine, starts };
  }) };
}

// ---- Hours ----
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
function dayName(w: number, lang: Lang) { return new Intl.DateTimeFormat(formatLocale(lang), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w))); }
/** "Mon to Fri 07:00 to 22:00; Sat, Sun 08:00 to 20:00; closed Tue": days with the same hours together. With
 *  `all` false, only the days listed (a court's own), and only days next to each other share a "to". */
function hoursText(days: { weekday: number; opens: string | null; closes: string | null }[], lang: Lang, all = true): string {
  const key = (d: { opens: string | null; closes: string | null }) => (d.opens ? `${d.opens} ${lang === "es" ? "a" : "to"} ${d.closes}` : lang === "es" ? "cerrado" : "closed");
  const order = [1, 2, 3, 4, 5, 6, 0], groups: { days: number[]; text: string }[] = [];
  let prev = -1;
  for (const [n, w] of order.entries()) {
    const listed = days.find((x) => x.weekday === w);
    if (!all && !listed) continue;
    const text = key(listed ?? { opens: null, closes: null }), last = groups.at(-1);
    if (last && last.text === text && prev === n - 1) last.days.push(w); else groups.push({ days: [w], text });
    prev = n;
  }
  const span = (ds: number[]) => ds.length > 2 ? `${dayName(ds[0]!, lang)} ${lang === "es" ? "a" : "to"} ${dayName(ds.at(-1)!, lang)}` : ds.map((w) => dayName(w, lang)).join(", ");
  return groups.map((g) => `${span(g.days)} ${g.text}`).join("; ");
}

export const hoursSet = defineAction({
  name: "hours.set", version: 1,
  input: z.object({ location_id: z.uuid(), days: z.array(z.object({ weekday: z.number().check(z.int(), z.minimum(0), z.maximum(6)), opens: z.nullable(clockTime), closes: z.nullable(clockTime) })).check(z.maxLength(7)) }),
  async plan(ctx, i) {
    const { row: loc } = await readRow(ctx.db, "location", i.location_id, "thing.location");
    for (const d of i.days) if ((d.opens === null) !== (d.closes === null) || (d.opens && d.closes! <= d.opens)) throw new KumiError("error.bad_hours");
    const days = WEEKDAYS.map((w) => i.days.find((d) => d.weekday === w) ?? { weekday: w, opens: null, closes: null });
    return { title: both("action.hours.set"), summary: both("plan.hours.set", { location: loc.name, hours: { en: hoursText(days, "en"), es: hoursText(days, "es") } }),
      reads: [], locationId: i.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    for (const w of WEEKDAYS) {
      const d = i.days.find((x) => x.weekday === w), opens = d?.opens ?? null, closes = d?.closes ?? null;
      const have = await ctx.trx.selectFrom("opening_hours").select(["id", "opens", "closes"]).where("location_id", "=", i.location_id).where("weekday", "=", w).executeTakeFirst();
      if (have) { if (hhmm(have.opens) !== opens || hhmm(have.closes) !== closes) await ctx.update("opening_hours", have.id, { opens, closes }); }
      else if (opens) await ctx.insert("opening_hours", { id: uuidv7(), location_id: i.location_id, weekday: w, opens, closes });
    }
    return null;
  },
});

/** What's booked on a court from now on that a new week of its own hours would leave outside (a day with no times is closed). */
async function outsideHours(db: Db | Trx, courtId: string, tz: string, days: { weekday: number; opens: string | null; closes: string | null }[], now: Date) {
  const rows = await db.selectFrom("court_time").leftJoin("booking", "booking.id", "court_time.booking_id").leftJoin("session", "session.id", "court_time.session_id")
    .leftJoin("program", "program.id", "session.program_id")
    .select([sql<Date>`lower(court_time.during)`.as("from"), sql<Date>`upper(court_time.during)`.as("to"), "booking.code", "booking.status", "program.name"])
    .where("court_time.court_id", "=", courtId).where("court_time.active", "=", true).where(sql<boolean>`lower(court_time.during) >= ${now}`)
    .where((w) => w.or([w("court_time.booking_id", "is not", null), w("court_time.session_id", "is not", null)])).orderBy(sql`lower(court_time.during)`).execute();
  const hm = (d: Date) => { const q = localParts(d, tz); return `${String(q.h).padStart(2, "0")}:${String(q.min).padStart(2, "0")}`; };
  return rows.filter((r) => r.status !== "cancelled").filter((r) => {
    const day = days.find((d) => d.weekday === localParts(r.from, tz).weekday);
    if (!day) return false;   // that day follows the location, as it did
    if (!day.opens || !day.closes) return true;
    const end = hm(r.to) === "00:00" ? "24:00" : hm(r.to);
    return hm(r.from) < day.opens || end > day.closes;
  }).map((r) => ({ what: r.code ?? r.name ?? "", at: r.from }));
}

/** A court's own week: the weekdays listed are its own (no times: closed that day), the rest follow the location. */
export const courtHoursSet = defineAction({
  name: "court.hours_set", version: 1,
  input: z.object({ court_id: z.uuid(), days: z.array(z.object({ weekday: z.number().check(z.int(), z.minimum(0), z.maximum(6)), opens: z.nullable(clockTime), closes: z.nullable(clockTime) })).check(z.maxLength(7)) }),
  async plan(ctx, i) {
    const [court] = await courtsAt(ctx.db, [i.court_id]);
    const { row: loc } = await readRow(ctx.db, "location", court!.location_id, "thing.location");
    if (new Set(i.days.map((d) => d.weekday)).size !== i.days.length) throw new KumiError("error.bad_hours");
    for (const d of i.days) if ((d.opens === null) !== (d.closes === null) || (d.opens && d.closes! <= d.opens)) throw new KumiError("error.bad_hours");
    const p = { court: court!.name, location: loc.name, hours: { en: hoursText(i.days, "en", false), es: hoursText(i.days, "es", false) } };
    let summary = both(i.days.length === 0 ? "plan.court.hours_follow" : i.days.length === 7 ? "plan.court.hours_own" : "plan.court.hours_some", p);
    // Bookings and program dates already on the court that the new hours leave outside: they stay, and the staff are told which.
    const outside = await outsideHours(ctx.db, i.court_id, loc.time_zone, i.days, ctx.now);
    if (outside.length) {
      const list = (l: Lang) => outside.slice(0, 5).map((o) => `${o.what} ${dateTime(o.at, l, loc.time_zone)}`).join(", ") + (outside.length > 5 ? ", ..." : "");
      const more = { en: t("en", "plan.court.hours_outside", { list: list("en") }), es: t("es", "plan.court.hours_outside", { list: list("es") }) };
      summary = { en: `${summary.en} ${more.en}`, es: `${summary.es} ${more.es}` };
    }
    return { title: both("action.court.hours_set"), summary, reads: [], locationId: court!.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    for (const w of WEEKDAYS) {
      const d = i.days.find((x) => x.weekday === w);
      const have = await ctx.trx.selectFrom("court_hours").select(["id", "opens", "closes", "active"]).where("court_id", "=", i.court_id).where("weekday", "=", w).executeTakeFirst();
      if (!d) { if (have?.active) await ctx.update("court_hours", have.id, { active: false }); continue; }
      if (!have) await ctx.insert("court_hours", { id: uuidv7(), court_id: i.court_id, weekday: w, opens: d.opens, closes: d.closes });
      else if (!have.active || hhmm(have.opens) !== d.opens || hhmm(have.closes) !== d.closes) await ctx.update("court_hours", have.id, { opens: d.opens, closes: d.closes, active: true });
    }
    return null;
  },
});

export const hoursExceptionSet = defineAction({
  name: "hours.exception_set", version: 1,
  // `court_id`: a special day for that court only (rain on an outdoor court is a block; a court let for a day is this).
  input: z.object({ location_id: z.uuid(), date: clubDate, opens: z.optional(clockTime), closes: z.optional(clockTime), note: z.optional(z.string().check(z.maxLength(200))), court_id: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const { row: loc } = await readRow(ctx.db, "location", i.location_id, "thing.location");
    if ((i.opens === undefined) !== (i.closes === undefined) || (i.opens && i.closes! <= i.opens)) throw new KumiError("error.bad_hours");
    const court = i.court_id ? (await courtsAt(ctx.db, [i.court_id]))[0]! : null;
    if (court && court.location_id !== i.location_id) throw new KumiError("error.one_location");
    const p = { location: court ? court.name : loc.name, date: i.date, opens: i.opens ?? "", closes: i.closes ?? "" };
    return { title: both("action.hours.exception_set"), summary: both(i.opens ? "plan.hours.special_open" : "plan.hours.special_closed", p), reads: [], locationId: i.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const have = await ctx.trx.selectFrom("hours_exception").select("id").where("location_id", "=", i.location_id).where("on_date", "=", i.date).where("active", "=", true)
      .$if(Boolean(i.court_id), (q) => q.where("court_id", "=", i.court_id!)).$if(!i.court_id, (q) => q.where("court_id", "is", null)).executeTakeFirst();
    const row = { opens: i.opens ?? null, closes: i.closes ?? null, note: i.note ?? null };
    if (have) await ctx.update("hours_exception", have.id, row);
    else await ctx.insert("hours_exception", { id: uuidv7(), location_id: i.location_id, court_id: i.court_id ?? null, on_date: i.date, ...row });
    return null;
  },
});

export const hoursExceptionRemove = defineAction({
  name: "hours.exception_remove", version: 1,
  input: z.object({ exception_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "hours_exception", i.exception_id, "thing.special_day");
    const { row: loc } = await readRow(ctx.db, "location", row.location_id, "thing.location");
    return { title: both("action.hours.exception_remove"), summary: both("plan.hours.exception_remove", { location: loc.name, date: String(row.on_date) }), reads: [read], locationId: row.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("hours_exception", i.exception_id, { active: false }); return null; },
});

// ---- Taking court time ----
/** Lock the courts in id order, then free any checkout holds on them that have run out. */
export async function lockCourts(ctx: ApplyCtx, courtIds: string[]) {
  for (const id of [...new Set(courtIds)].sort()) await ctx.trx.selectFrom("court").select("id").where("id", "=", id).forUpdate().execute();
  await ctx.trx.updateTable("court_time").set({ active: false }).where("court_id", "in", courtIds).where("kind", "=", "hold").where("active", "=", true).where("hold_until", "<=", ctx.now).execute();
}
export const range = (start: Date, end: Date) => sql<string>`tstzrange(${start}, ${end})`;
/** In a query joining a booking to its court_time: only the time it has now, or, once it's let go (cancelled), the
 *  last one it had. A move or a new length retires the old time and takes a new one, so a booking has as many as
 *  it has had places; ids are time-ordered (uuidv7), so the newest is where it is (or was, when it was called off). */
export const itsTimeNow = sql<boolean>`court_time.id = (SELECT ct.id FROM court_time ct WHERE ct.booking_id = booking.id ORDER BY ct.active DESC, ct.id DESC LIMIT 1)`;
/** One booking's time by the same rule as itsTimeNow: what "how long before it" and "is it over" are measured from. Never
 *  the earliest of its times: a booking moved later would be refunded, or counted as over, by the time it left. */
export async function bookingTimeNow(db: Db | Trx, bookingId: string): Promise<{ start: Date; end: Date } | undefined> {
  const t = await db.selectFrom("court_time").select([sql<Date>`lower(during)`.as("start"), sql<Date>`upper(during)`.as("end")]).where("booking_id", "=", bookingId)
    .orderBy("active", "desc").orderBy("id", "desc").executeTakeFirst();
  return t ? { start: new Date(t.start), end: new Date(t.end) } : undefined;
}
export async function insertTime(ctx: ApplyCtx, rows: Record<string, unknown>[]) {
  try { for (const r of rows) await ctx.insert("court_time", r); }
  catch (e: any) { if (e?.code === "23P01") throw new KumiError("error.court_taken"); throw e; }
}
export async function courtsAt(db: Db | Trx, courtIds: string[]) {
  const courts = await db.selectFrom("court").select(["id", "name", "location_id", "bookable", "archived_at"]).where("id", "in", courtIds).execute();
  if (courts.length !== new Set(courtIds).size || courts.some((c) => c.archived_at)) throw new KumiError("error.not_found", { thing: both("thing.court") }, 404);
  if (new Set(courts.map((c) => c.location_id)).size > 1) throw new KumiError("error.one_location");
  return courts;
}
const when = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });

export const courtBlock = defineAction({
  name: "court.block", version: 1,
  input: z.object({ court_ids: z.array(z.uuid()).check(z.minLength(1)), starts_at: z.iso.datetime({ offset: true }), ends_at: z.iso.datetime({ offset: true }),
    reason: z.enum(["maintenance", "fault", "resurfacing", "event", "other"]), note: z.optional(z.string().check(z.maxLength(200))),
    // Bookings in the way move to another court like theirs at the same time (block_moves.ts); without it, a court with
    // anything on it then can't be blocked.
    move_bookings: z.optional(z.boolean().check(z.describe("Move bookings in the way to another free court of the same kind, same time. What can't move stays, and the block leaves its time free."))) }),
  async plan(ctx, i) {
    const start = new Date(i.starts_at), end = new Date(i.ends_at);
    if (end <= start) throw new KumiError("error.bad_times");
    const courts = await courtsAt(ctx.db, i.court_ids), tz = await locationTz(ctx.db, courts[0]!.location_id);
    const block = both("plan.court.block", { courts: courts.map((c) => c.name).join(", "), from: when(start, tz), to: when(end, tz), reason: both(`block.${i.reason}` as Key) });
    const base = { title: both("action.court.block"), reads: [], locationId: courts[0]!.location_id };
    if (!i.move_bookings) {
      if ((await occupied(ctx.db, i.court_ids, start, end, ctx.now)).length) throw new KumiError("error.court_taken");
      return { ...base, summary: block, undo: { kind: "reversible" } };
    }
    const { blockLayout, layoutWords } = await import("./block_moves.ts");
    const layout = await blockLayout(ctx.db, { courtIds: i.court_ids, locationId: courts[0]!.location_id, tz, start, end, now: ctx.now });
    const words = await layoutWords(ctx.db, layout, tz, block);
    // Undone, the moved bookings go back to the blocked court, and their players, told of the move, aren't told again.
    return { ...base, summary: words.summary, rows: words.rows.length > 1 ? words.rows : undefined, undo: { kind: layout.moves.length ? "compensating" : "reversible" },
      details: { layout, location_id: courts[0]!.location_id, tz } };
  },
  undoSummary(changes) {
    const moved = changes.filter((c) => c.entity === "court_time" && c.op === "insert" && (c.after as { kind?: string } | null)?.kind === "booking").length;
    return moved ? both("plan.court.block_undo_moves", { count: moved }) : null;
  },
  async apply(ctx, i, plan) {
    const id = uuidv7();
    if (!i.move_bookings) {
      await lockCourts(ctx, i.court_ids);
      await ctx.insert("court_block", { id, reason: i.reason, note: i.note ?? null });
      await insertTime(ctx, i.court_ids.map((court) => ({ id: uuidv7(), court_id: court, during: range(new Date(i.starts_at), new Date(i.ends_at)), kind: "block", block_id: id })));
      await ctx.emit("court.blocked", { block_id: id });
      return { block_id: id };
    }
    const d = plan.details as { layout: import("./block_moves.ts").BlockLayout; location_id: string; tz: string };
    // Every court at the location, in id order: the blocked ones and any a booking moves to.
    const all = await ctx.trx.selectFrom("court").select("id").where("location_id", "=", d.location_id).execute();
    await lockCourts(ctx, all.map((c) => c.id));
    const { blockLayout, sameLayout } = await import("./block_moves.ts");
    const now = await blockLayout(ctx.trx, { courtIds: i.court_ids, locationId: d.location_id, tz: d.tz, start: new Date(i.starts_at), end: new Date(i.ends_at), now: ctx.now });
    // Anything booked, moved or started since the preview: it's previewed again rather than done differently.
    if (!sameLayout(now, d.layout)) throw new KumiError("error.changed");
    const names = new Map((await ctx.trx.selectFrom("court").select(["id", "name"]).where("location_id", "=", d.location_id).execute()).map((c) => [c.id, c.name]));
    const at = (court: string, iso: string): Text => { const w = when(new Date(iso), d.tz); return { en: `${names.get(court)}, ${w.en}`, es: `${names.get(court)}, ${w.es}` }; };
    for (const m of now.moves) {
      await ctx.update("court_time", m.time_id, { active: false });
      await insertTime(ctx, [{ id: uuidv7(), court_id: m.to_court, during: range(new Date(m.start), new Date(m.end)), kind: "booking", booking_id: m.booking_id }]);
    }
    await ctx.insert("court_block", { id, reason: i.reason, note: i.note ?? null });
    await insertTime(ctx, now.pieces.map((p) => ({ id: uuidv7(), court_id: p.court_id, during: range(new Date(p.start), new Date(p.end)), kind: "block", block_id: id })));
    // Each moved booking's players hear where it is now; no money moved, so nothing about money.
    for (const m of now.moves) await ctx.emit("booking.moved", { booking_id: m.booking_id, from: at(m.from_court, m.start), to: at(m.to_court, m.start), owed: 0, refunds: {} });
    await ctx.emit("court.blocked", { block_id: id });
    return { block_id: id, moved: now.moves.map((m) => m.booking_id), stayed: now.stays.flatMap((s) => (s.booking_id ? [s.booking_id] : [])) };
  },
});

export const courtUnblock = defineAction({
  name: "court.unblock", version: 1,
  input: z.object({ block_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "court_block", i.block_id, "thing.block");
    if (!row.active) throw new KumiError("error.not_found", { thing: both("thing.block") }, 404);
    const names = await ctx.db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").select("court.name").where("block_id", "=", i.block_id).where("active", "=", true).execute();
    const courts = names.map((n) => n.name).join(", ");
    // One date of a repeating block: only that date opens (block_series.ts), and it's never made again.
    const summary = row.series_id && row.on_date ? both("plan.court.block_repeat_end_this", { courts, date: { en: dayOf(row.on_date, "en"), es: dayOf(row.on_date, "es") } }) : both("plan.court.unblock", { courts });
    return { title: both("action.court.unblock"), summary, reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    for (const t of await ctx.trx.selectFrom("court_time").select("id").where("block_id", "=", i.block_id).where("active", "=", true).execute()) await ctx.update("court_time", t.id, { active: false });
    await ctx.update("court_block", i.block_id, { active: false });
    const b = await ctx.trx.selectFrom("court_block").select(["series_id", "on_date"]).where("id", "=", i.block_id).executeTakeFirstOrThrow();
    if (b.series_id && b.on_date) {
      const s = await ctx.trx.selectFrom("block_series").select("skip_dates").where("id", "=", b.series_id).executeTakeFirstOrThrow();
      await ctx.update("block_series", b.series_id, { skip_dates: [...new Set([...s.skip_dates, b.on_date])].sort() });
    }
    return null;
  },
});

// ---- Bookings made at the desk (members book and pay with prices, next) ----
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O or 1/I
async function newCode(trx: Trx, clubName: string): Promise<string> {
  const prefix = clubName.split(/\s+/).map((w) => w[0]).join("").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase().padEnd(2, "K");
  for (;;) {
    const code = `${prefix}-${Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("")}`;
    if (!await trx.selectFrom("booking").select("id").where("code", "=", code).executeTakeFirst()) return code;
  }
}

/** A booking's court and time are possible: the court can be booked, the club is open then, it isn't over, and it's free.
 *  The desk's rules, not a member's: no days-ahead limit, no lengths list (lessons.ts booking.create_lesson too). */
export async function deskSlot(ctx: PlanCtx, courtId: string, start: Date, minutes: number) { return checkSlot(ctx, courtId, start, minutes); }
async function checkSlot(ctx: PlanCtx, courtId: string, start: Date, minutes: number) {
  if (minutes % STEP_MINUTES || minutes < STEP_MINUTES || minutes > MAX_MINUTES) throw new KumiError("error.bad_length");
  const [court] = await courtsAt(ctx.db, [courtId]);
  if (!court!.bookable) throw new KumiError("error.court_not_bookable", { court: court!.name });
  const end = new Date(start.getTime() + minutes * 60_000), tz = await locationTz(ctx.db, court!.location_id);
  if (end <= ctx.now) throw new KumiError("error.in_the_past");
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(start);
  const open = await courtOpening(ctx.db, court!, day);
  if (!open || start < open.opens || end > open.closes) throw new KumiError("error.closed_then", { court: court!.name, when: when(start, tz) });
  if ((await occupied(ctx.db, [courtId], start, end, ctx.now)).length) throw new KumiError("error.court_taken");
  return { court: court!, end, tz };
}

/** A same-day open match's own cutoff, as the members' app sets it (booking_pay.ts booking.request): opened after the
 *  club's "pay my part" deadline, it must fill by `same_day_cutoff_hours` before the start. Null for any other booking. */
function matchCutoff(open: unknown, start: Date, now: Date, policy: { split_deadline_hours: number; same_day_cutoff_hours: number }): Date | null {
  const ahead = start.getTime() - now.getTime();
  if (!open || ahead > policy.split_deadline_hours * 3600_000) return null;
  if (ahead <= policy.same_day_cutoff_hours * 3600_000) throw new KumiError("error.too_late_for_match", { count: policy.same_day_cutoff_hours });
  return new Date(start.getTime() - policy.same_day_cutoff_hours * 3600_000);
}



/** Each place's part of the court. The whole court: the organiser's place carries the price, the others nothing. Each
 *  pays their part: four equal parts, the organiser taking the odd cents (booking_pay.ts shares, as in the app). */
export function deskParts(price: number, pay: "whole" | "split", places: number): number[] {
  if (pay === "whole") return Array.from({ length: places }, (_, n) => (n === 0 ? price : 0));
  const each = Math.floor(price / 4), first = price - each * 3;
  return Array.from({ length: places }, (_, n) => (n === 0 ? first : each));
}

/** The places as the desk gave them (the first is the organiser's), or, from an older caller, the organiser alone. */
function placesOf(i: { person_id?: string; guest_name?: string; places?: DeskPlace[] }): DeskPlace[] {
  if (i.places) {
    if (i.person_id || i.guest_name) throw new KumiError("error.booking_who");
    return i.places;
  }
  if (i.person_id && i.guest_name) throw new KumiError("error.booking_who");
  return [i.person_id ? { person_id: i.person_id } : i.guest_name ? { guest_name: i.guest_name } : {}];
}
const filled = placeFilled;
/** An open match made at the desk (+ Create, Open match): the level band and who may join, as in the members' app. */
const levelIn = z.number().check(z.minimum(0.5), z.maximum(7));
const deskOpen = z.object({ level_min: levelIn, level_max: levelIn, outside_band: z.optional(z.enum(["ask", "closed"])), rated: z.optional(z.boolean()),
  listed: z.optional(z.boolean()), note: z.optional(z.string().check(z.maxLength(200))) });

export const bookingCreate = defineAction({
  name: "booking.create", version: 1,
  input: z.object({
    court_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }), minutes: z.number().check(z.int()),
    person_id: z.optional(z.uuid()), guest_name: z.optional(z.string().check(z.minLength(1), z.maxLength(80))),
    price_cents: z.optional(z.number().check(z.int(), z.minimum(0))), note: z.optional(z.string().check(z.maxLength(200))),
    // The desk's full form (Schedule, + Create): whole court or each their part, up to four places, places paid now,
    // and a note the players see beside the staff's own.
    pay: z.optional(z.enum(["whole", "split"])), places: z.optional(z.array(deskPlace).check(z.minLength(1), z.maxLength(4))),
    paid_method: z.optional(deskMethod), player_note: z.optional(z.string().check(z.maxLength(200))),
    // An open match (each their part, four places): others at the level join and pay in the app; not full by the
    // deadline, it's cancelled and everyone paid back (booking.settle_shares). Places the desk names are owed at the desk.
    open: z.optional(deskOpen),
  }),
  async plan(ctx, i) {
    const places = placesOf(i), org = places[0]!, pay = i.pay ?? "whole";
    if (i.open && pay !== "split") throw new KumiError("error.open_match_split");
    if (i.open && i.open.level_max < i.open.level_min) throw new KumiError("error.bad_band");
    // Everyone in an open match is a member: a guest can't be in a game that counts for levels, or be found to join.
    if (i.open && places.some((p) => p.guest_name)) throw new KumiError("error.open_match_members");
    if (places.some((p) => p.person_id && p.guest_name) || !filled(org)) throw new KumiError("error.booking_who");
    const ids = places.flatMap((p) => (p.person_id ? [p.person_id] : []));
    if (new Set(ids).size !== ids.length) throw new KumiError("error.player_twice");
    if (places.some((p) => p.paid && !filled(p))) throw new KumiError("error.paid_place_empty");
    // Each their part: the organiser is a member (what's unpaid at the deadline is theirs), and there's still time.
    if (pay === "split" && !org.person_id) throw new KumiError("error.split_needs_member");
    const start = new Date(i.starts_at), { court, tz } = await checkSlot(ctx, i.court_id, start, i.minutes);
    const policy = await currentPolicy(ctx.db), cutoff = matchCutoff(i.open, start, ctx.now, policy);
    if (pay === "split" && !cutoff && start.getTime() - ctx.now.getTime() <= policy.split_deadline_hours * 3600_000) throw new KumiError("error.too_late_to_split", { count: policy.split_deadline_hours });
    // Another price, and places marked paid, are the desk's money: whoever takes payments at the desk here.
    const mayMoney = (wanted: boolean) => wanted ? mayAlso(ctx.db, ctx.actor, "booking.record_payment", { locationId: court.location_id, at: ctx.now }) : Promise.resolve(true);
    if (!(await mayMoney(i.price_cents !== undefined))) throw new KumiError("error.price_not_yours");
    if (!(await mayMoney(places.some((p) => p.paid)))) throw new KumiError("error.paid_not_yours");
    const names = new Map<string, string>();
    for (const id of ids) {
      const { row } = await readRow(ctx.db, "person", id, "thing.person");
      if (row.status !== "active" || row.redacted_at) throw new KumiError("error.not_found", { thing: both("thing.person") }, 404);
      names.set(id, row.display_name as string);
    }
    const nameOf = (p: DeskPlace) => (p.person_id ? names.get(p.person_id)! : p.guest_name ?? "");
    const who = nameOf(org);
    // The quote's price unless the desk says otherwise (a promotion, a regular's rate).
    const q = await quote(ctx.db, { courtId: i.court_id, start, minutes: i.minutes, personId: org.person_id, at: ctx.now }), price = i.price_cents ?? q.total_cents;
    const usd = (c: number): Text => ({ en: money(c, "en"), es: money(c, "es") });
    const p = { court: court.name, when: when(start, tz), minutes: i.minutes, who, amount: usd(price) };
    const parts: Text[] = [];
    if (pay === "whole") parts.push(both("plan.booking.create_priced", p));
    else if (i.open) {
      const s = deskParts(price, "split", 4), o = i.open, hours = both("count.hours", { count: cutoff ? policy.same_day_cutoff_hours : policy.split_deadline_hours });
      parts.push(both("plan.booking.create_open", { ...p, first: usd(s[0]!), each: usd(s[1]!) }));
      parts.push(both(o.rated === false ? "plan.booking.open_friendly" : "plan.booking.open_rated", { band: band(o), hours,
        outside: both(o.outside_band === "closed" ? "plan.booking.outside_closed" : "plan.booking.outside_ask_host") }));
      parts.push(both("plan.booking.desk_match_owed"));
      if (cutoff) parts.push(both("plan.booking.same_day_note"));
      // Named here whatever their level, as the desk knows them; said, so nobody is put out of their band unawares.
      const outside: string[] = [];
      for (const x of places) if (x.person_id && joinRule({ ...o, outside_band: "closed" }, await levelOf(ctx.db, x.person_id)) !== "join") outside.push(names.get(x.person_id)!);
      if (outside.length) parts.push(both("plan.booking.desk_outside_band", { names: outside.join(", ") }));
    } else {
      const s = deskParts(price, "split", 4);
      parts.push(both("plan.booking.create_split", { ...p, first: usd(s[0]!), each: usd(s[1]!) }));
      parts.push(both("plan.booking.desk_deadline", { who, when: when(new Date(start.getTime() - policy.split_deadline_hours * 3600_000), tz) }));
    }
    const others = places.slice(1).filter(filled).map(nameOf);
    if (others.length) parts.push(both("plan.booking.desk_players", { names: others.join(", ") }));
    const share = deskParts(price, pay, places.length);
    // A place with nothing to pay (another player on a whole court, a free court) can't be marked paid.
    if (places.some((x, n) => x.paid && share[n]! <= 0)) throw new KumiError("error.paid_place_nothing");
    const paid = places.map((x, n) => ({ x, cents: share[n]! })).filter((y) => y.x.paid);
    if (paid.length) parts.push(both("plan.booking.desk_paid", { names: paid.map((y) => nameOf(y.x)).join(", "), amount: usd(paid.reduce((n, y) => n + y.cents, 0)), how: paidHowOf(i.paid_method ?? "cash") }));
    const owed = price - paid.reduce((n, y) => n + y.cents, 0);
    // The desk's full form says what's left to pay at the desk (an older caller's preview stays as it was).
    if (i.places && pay === "whole" && owed > 0) parts.push(both("plan.booking.desk_owed", { amount: usd(owed) }));
    const open = (pay === "split" ? 4 : places.length) - places.filter(filled).length;
    if (open > 0 && org.person_id) parts.push(i.open ? both("plan.booking.desk_open_match", { count: open })
      : both(pay === "split" ? "plan.booking.desk_open_split" : "plan.booking.desk_open_whole", { count: open }));
    if (i.player_note?.trim()) parts.push(both("plan.booking.desk_player_note", { note: i.player_note.trim() }));
    const summary: Text = { en: parts.map((x) => x.en).join(" "), es: parts.map((x) => x.es).join(" ") };
    return { title: both("action.booking.create"), summary, reads: [], locationId: court.location_id, ownerIds: org.person_id ? [org.person_id] : [], moneyCents: price, undo: { kind: "reversible" },
      ...(cutoff ? { details: { cutoff_at: cutoff.toISOString() } } : {}) };
  },
  async apply(ctx, i, plan) {
    const places = placesOf(i), org = places[0]!, pay = i.pay ?? "whole";
    const start = new Date(i.starts_at), end = new Date(start.getTime() + i.minutes * 60_000);
    const cutoffAt = (plan.details as { cutoff_at?: string } | undefined)?.cutoff_at;
    await lockCourts(ctx, [i.court_id]);
    const court = await ctx.trx.selectFrom("court").select("location_id").where("id", "=", i.court_id).executeTakeFirstOrThrow();
    const club = await ctx.trx.selectFrom("club").select("name").executeTakeFirstOrThrow();
    const q = await quote(ctx.trx, { courtId: i.court_id, start, minutes: i.minutes, personId: org.person_id, at: ctx.now }), policy = await currentPolicy(ctx.trx);
    const price = i.price_cents ?? q.total_cents, tax = i.price_cents === undefined ? q.tax_cents : Math.round(price * q.tax_bp / (10_000 + q.tax_bp));
    const id = uuidv7(), code = await newCode(ctx.trx, club.name);
    // Booked for a member: the court is theirs, and it gets the players link (booking_players.ts) like one they book in
    // the app; each their part, the same link lets others take an open place and pay for it (booking.join). A walk-in
    // under a guest name has none: no member owns it, and a guest can't be in a scored game.
    await ctx.insert("booking", { id, code, location_id: court.location_id, organiser_id: org.person_id ?? null, status: "confirmed", source: "desk", price_cents: price, tax_cents: tax,
      quote: JSON.stringify(q), policy_id: policy.id, note: i.note?.trim() || null, player_note: i.player_note?.trim() || null, pay_mode: pay, ...(pay === "split" ? { players: 4 } : {}),
      invite_code: org.person_id ? randomBytes(9).toString("base64url") : null });
    if (i.open) await ctx.insert("open_match", { booking_id: id, level_min: i.open.level_min.toFixed(2), level_max: i.open.level_max.toFixed(2), outside_band: i.open.outside_band ?? "ask",
      rated: i.open.rated ?? true, listed: i.open.listed ?? true, note: i.open.note?.trim() || null, cutoff_at: cutoffAt ? new Date(cutoffAt) : null });
    const share = deskParts(price, pay, places.length);
    const seats: { id: string; place: DeskPlace; cents: number }[] = [];
    for (const [n, p] of places.entries()) {
      if (!filled(p)) continue;
      const seat = uuidv7();
      await ctx.insert("booking_player", { id: seat, booking_id: id, person_id: p.person_id ?? null, guest_name: p.person_id ? null : p.guest_name!, share_cents: share[n]!,
        ...(n > 0 ? { added_by: ctx.actor.personId } : {}) });
      seats.push({ id: seat, place: p, cents: share[n]! });
    }
    await insertTime(ctx, [{ id: uuidv7(), court_id: i.court_id, during: range(start, end), kind: "booking", booking_id: id }]);
    // Places paid at the desk now: each its own payment, on its own place, as booking.record_payment records one.
    const { recordAtDesk } = await import("./desk_pay.ts");
    for (const s of seats.filter((x) => x.place.paid && x.cents > 0))
      await recordAtDesk(ctx, { personId: s.place.person_id ?? org.person_id ?? ctx.actor.personId!, cents: s.cents, method: i.paid_method ?? "cash", revenue: "courts", memo: "court booking",
        link: { booking_player_id: s.id } });
    await ctx.emit("booking.created", { booking_id: id });
    return { booking_id: id, code };
  },
});
