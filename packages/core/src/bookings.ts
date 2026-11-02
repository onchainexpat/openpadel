// Court bookings, part one: when each location is open, courts taken out of use, bookings made at the desk,
// and which courts are free. Bookings and blocks are court_time rows, so the database itself refuses two
// things on one court at once; each write also locks its courts first, in id order, which keeps a rush on
// one slot from stalling or deadlocking (spikes/booking_race.md).
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, money, type Key, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { onDate, weekdayOf } from "./clock.ts";
import { currentPolicy, quote } from "./prices.ts";

const clockTime = z.string().check(z.regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/));
const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
/** Bookings are in steps of half an hour, from half an hour to eight. Members choose 60, 90 or 120. */
export const STEP_MINUTES = 30, MAX_MINUTES = 480, MEMBER_LENGTHS = [60, 90, 120] as const;

export async function locationTz(db: Db | Trx, locationId: string): Promise<string> {
  return (await readRow(db, "location", locationId, "thing.location")).row.time_zone;
}
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const dayOf = (date: string, lang: Lang) => new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));

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
  const tz = await locationTz(db, locationId), w = weekdayOf(day);
  const special = await db.selectFrom("hours_exception").select(["court_id", "opens", "closes"]).where("location_id", "=", locationId).where("on_date", "=", day).where("active", "=", true).execute();
  const own = courtIds.length ? await db.selectFrom("court_hours").select(["court_id", "opens", "closes"]).where("court_id", "in", courtIds).where("weekday", "=", w).where("active", "=", true).execute() : [];
  const week = await db.selectFrom("opening_hours").select(["opens", "closes"]).where("location_id", "=", locationId).where("weekday", "=", w).executeTakeFirst();
  const out = new Map<string, Open | null>();
  for (const id of courtIds) {
    const row = special.find((x) => x.court_id === id) ?? special.find((x) => x.court_id === null) ?? own.find((x) => x.court_id === id) ?? week;
    out.set(id, row?.opens && row.closes ? { opens: onDate(day, hhmm(row.opens)!, tz), closes: onDate(day, hhmm(row.closes)!, tz) } : null);
  }
  return out;
}
/** When one court is open on a club date (courtOpenings). */
export async function courtOpening(db: Db | Trx, court: { id: string; location_id: string }, day: string): Promise<Open | null> {
  return (await courtOpenings(db, court.location_id, [court.id], day)).get(court.id) ?? null;
}
/** From the earliest opening to the latest closing among these: the location's day on the Courts page. */
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
function dayName(w: number, lang: Lang) { return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w))); }
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
    return { title: both("action.court.hours_set"), summary: both(i.days.length === 0 ? "plan.court.hours_follow" : i.days.length === 7 ? "plan.court.hours_own" : "plan.court.hours_some", p),
      reads: [], locationId: court!.location_id, undo: { kind: "reversible" } };
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
    reason: z.enum(["maintenance", "fault", "resurfacing", "event", "other"]), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const start = new Date(i.starts_at), end = new Date(i.ends_at);
    if (end <= start) throw new KumiError("error.bad_times");
    const courts = await courtsAt(ctx.db, i.court_ids), tz = await locationTz(ctx.db, courts[0]!.location_id);
    if ((await occupied(ctx.db, i.court_ids, start, end, ctx.now)).length) throw new KumiError("error.court_taken");
    return { title: both("action.court.block"), summary: both("plan.court.block", { courts: courts.map((c) => c.name).join(", "), from: when(start, tz), to: when(end, tz), reason: both(`block.${i.reason}` as Key) }),
      reads: [], locationId: courts[0]!.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await lockCourts(ctx, i.court_ids);
    const id = uuidv7();
    await ctx.insert("court_block", { id, reason: i.reason, note: i.note ?? null });
    await insertTime(ctx, i.court_ids.map((court) => ({ id: uuidv7(), court_id: court, during: range(new Date(i.starts_at), new Date(i.ends_at)), kind: "block", block_id: id })));
    await ctx.emit("court.blocked", { block_id: id });
    return { block_id: id };
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

/** A booking's court and time are possible: the court can be booked, the club is open then, it isn't over, and it's free. */
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

export const bookingCreate = defineAction({
  name: "booking.create", version: 1,
  input: z.object({
    court_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }), minutes: z.number().check(z.int()),
    person_id: z.optional(z.uuid()), guest_name: z.optional(z.string().check(z.minLength(1), z.maxLength(80))),
    price_cents: z.optional(z.number().check(z.int(), z.minimum(0))), note: z.optional(z.string().check(z.maxLength(200))),
  }),
  async plan(ctx, i) {
    if (Boolean(i.person_id) === Boolean(i.guest_name)) throw new KumiError("error.booking_who");
    const start = new Date(i.starts_at), { court, tz } = await checkSlot(ctx, i.court_id, start, i.minutes);
    const who = i.person_id ? (await readRow(ctx.db, "person", i.person_id, "thing.person")).row.display_name : i.guest_name!;
    // The quote's price unless the desk says otherwise (a promotion, a regular's rate).
    const q = await quote(ctx.db, { courtId: i.court_id, start, minutes: i.minutes, personId: i.person_id, at: ctx.now }), price = i.price_cents ?? q.total_cents;
    const amount = { en: money(price, "en"), es: money(price, "es") };
    return { title: both("action.booking.create"), summary: both("plan.booking.create_priced", { court: court.name, when: when(start, tz), minutes: i.minutes, who, amount }),
      reads: [], locationId: court.location_id, ownerIds: i.person_id ? [i.person_id] : [], moneyCents: price, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const start = new Date(i.starts_at), end = new Date(start.getTime() + i.minutes * 60_000);
    await lockCourts(ctx, [i.court_id]);
    const court = await ctx.trx.selectFrom("court").select("location_id").where("id", "=", i.court_id).executeTakeFirstOrThrow();
    const club = await ctx.trx.selectFrom("club").select("name").executeTakeFirstOrThrow();
    const q = await quote(ctx.trx, { courtId: i.court_id, start, minutes: i.minutes, personId: i.person_id, at: ctx.now }), policy = await currentPolicy(ctx.trx);
    const price = i.price_cents ?? q.total_cents, tax = i.price_cents === undefined ? q.tax_cents : Math.round(price * q.tax_bp / (10_000 + q.tax_bp));
    const id = uuidv7(), code = await newCode(ctx.trx, club.name);
    // Booked for a member: the court is theirs in full, and it gets the players link (booking_players.ts) like one they
    // book in the app. A walk-in under a guest name has none: no member owns it, and a guest can't be in a scored game.
    await ctx.insert("booking", { id, code, location_id: court.location_id, organiser_id: i.person_id ?? null, status: "confirmed", source: "desk", price_cents: price, tax_cents: tax,
      quote: JSON.stringify(q), policy_id: policy.id, note: i.note ?? null, invite_code: i.person_id ? randomBytes(9).toString("base64url") : null });
    await ctx.insert("booking_player", { id: uuidv7(), booking_id: id, person_id: i.person_id ?? null, guest_name: i.person_id ? null : i.guest_name!, share_cents: price });
    await insertTime(ctx, [{ id: uuidv7(), court_id: i.court_id, during: range(start, end), kind: "booking", booking_id: id }]);
    await ctx.emit("booking.created", { booking_id: id });
    return { booking_id: id, code };
  },
});
