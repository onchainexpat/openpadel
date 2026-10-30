// Court bookings, part one: when each location is open, courts taken out of use, bookings made at the desk,
// and which courts are free. Bookings and blocks are court_time rows, so the database itself refuses two
// things on one court at once; each write also locks its courts first, in id order, which keeps a rush on
// one slot from stalling or deadlocking (spikes/booking_race.md).
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, type Key, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { onDate, weekdayOf } from "./clock.ts";

const clockTime = z.string().check(z.regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/));
const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
/** Bookings are in steps of half an hour, from half an hour to eight. Members choose 60, 90 or 120. */
export const STEP_MINUTES = 30, MAX_MINUTES = 480, MEMBER_LENGTHS = [60, 90, 120] as const;

async function locationTz(db: Db | Trx, locationId: string): Promise<string> {
  return (await readRow(db, "location", locationId, "thing.location")).row.time_zone;
}
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

/** When a location is open on a club date: its special day if it has one, otherwise its weekday. */
export async function openingOn(db: Db | Trx, locationId: string, day: string): Promise<{ opens: Date; closes: Date } | null> {
  const tz = await locationTz(db, locationId);
  const special = await db.selectFrom("hours_exception").select(["opens", "closes"]).where("location_id", "=", locationId).where("on_date", "=", day).where("active", "=", true).executeTakeFirst();
  const row = special ?? await db.selectFrom("opening_hours").select(["opens", "closes"]).where("location_id", "=", locationId).where("weekday", "=", weekdayOf(day)).executeTakeFirst();
  if (!row?.opens || !row.closes) return null;
  return { opens: onDate(day, hhmm(row.opens)!, tz), closes: onDate(day, hhmm(row.closes)!, tz) };
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

/** Each bookable court at a location, and every start time on that date when it's free for `minutes`. */
export async function freeCourts(db: Db | Trx, i: { locationId: string; date: string; minutes: number; now: Date }) {
  const open = await openingOn(db, i.locationId, i.date);
  if (!open) return { open: null, courts: [] };
  const courts = await db.selectFrom("court").select(["id", "name", "kind"]).where("location_id", "=", i.locationId).where("archived_at", "is", null).where("bookable", "=", true).orderBy("sort").orderBy("name").execute();
  const taken = await occupied(db, courts.map((c) => c.id), open.opens, open.closes, i.now);
  const len = i.minutes * 60_000, step = STEP_MINUTES * 60_000;
  return { open, courts: courts.map((c) => {
    const busy = taken.filter((t) => t.court_id === c.id);
    const starts: string[] = [];
    for (let s = open.opens.getTime(); s + len <= open.closes.getTime(); s += step) {
      if (s < i.now.getTime()) continue;
      if (!busy.some((b) => new Date(b.start).getTime() < s + len && new Date(b.end).getTime() > s)) starts.push(new Date(s).toISOString());
    }
    return { ...c, starts };
  }) };
}

// ---- Hours ----
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
function dayName(w: number, lang: Lang) { return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w))); }
/** "Mon to Fri 07:00 to 22:00; Sat, Sun 08:00 to 20:00; closed Tue": days with the same hours together. */
function hoursText(days: { weekday: number; opens: string | null; closes: string | null }[], lang: Lang): string {
  const key = (d: { opens: string | null; closes: string | null }) => (d.opens ? `${d.opens} ${lang === "es" ? "a" : "to"} ${d.closes}` : lang === "es" ? "cerrado" : "closed");
  const order = [1, 2, 3, 4, 5, 6, 0], groups: { days: number[]; text: string }[] = [];
  for (const w of order) {
    const d = days.find((x) => x.weekday === w) ?? { opens: null, closes: null }, text = key(d), last = groups.at(-1);
    if (last && last.text === text) last.days.push(w); else groups.push({ days: [w], text });
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

export const hoursExceptionSet = defineAction({
  name: "hours.exception_set", version: 1,
  input: z.object({ location_id: z.uuid(), date: clubDate, opens: z.optional(clockTime), closes: z.optional(clockTime), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const { row: loc } = await readRow(ctx.db, "location", i.location_id, "thing.location");
    if ((i.opens === undefined) !== (i.closes === undefined) || (i.opens && i.closes! <= i.opens)) throw new KumiError("error.bad_hours");
    const p = { location: loc.name, date: i.date, opens: i.opens ?? "", closes: i.closes ?? "" };
    return { title: both("action.hours.exception_set"), summary: both(i.opens ? "plan.hours.special_open" : "plan.hours.special_closed", p), reads: [], locationId: i.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const have = await ctx.trx.selectFrom("hours_exception").select("id").where("location_id", "=", i.location_id).where("on_date", "=", i.date).where("active", "=", true).executeTakeFirst();
    const row = { opens: i.opens ?? null, closes: i.closes ?? null, note: i.note ?? null };
    if (have) await ctx.update("hours_exception", have.id, row);
    else await ctx.insert("hours_exception", { id: uuidv7(), location_id: i.location_id, on_date: i.date, ...row });
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
async function lockCourts(ctx: ApplyCtx, courtIds: string[]) {
  for (const id of [...new Set(courtIds)].sort()) await ctx.trx.selectFrom("court").select("id").where("id", "=", id).forUpdate().execute();
  await ctx.trx.updateTable("court_time").set({ active: false }).where("court_id", "in", courtIds).where("kind", "=", "hold").where("active", "=", true).where("hold_until", "<=", ctx.now).execute();
}
const range = (start: Date, end: Date) => sql<string>`tstzrange(${start}, ${end})`;
async function insertTime(ctx: ApplyCtx, rows: Record<string, unknown>[]) {
  try { for (const r of rows) await ctx.insert("court_time", r); }
  catch (e: any) { if (e?.code === "23P01") throw new KumiError("error.court_taken"); throw e; }
}
async function courtsAt(db: Db | Trx, courtIds: string[]) {
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
    return { title: both("action.court.unblock"), summary: both("plan.court.unblock", { courts: names.map((n) => n.name).join(", ") }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    for (const t of await ctx.trx.selectFrom("court_time").select("id").where("block_id", "=", i.block_id).where("active", "=", true).execute()) await ctx.update("court_time", t.id, { active: false });
    await ctx.update("court_block", i.block_id, { active: false });
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
  const open = await openingOn(ctx.db, court!.location_id, day);
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
    return { title: both("action.booking.create"), summary: both("plan.booking.create", { court: court.name, when: when(start, tz), minutes: i.minutes, who }),
      reads: [], locationId: court.location_id, ownerIds: i.person_id ? [i.person_id] : [], moneyCents: i.price_cents ?? 0, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const start = new Date(i.starts_at), end = new Date(start.getTime() + i.minutes * 60_000);
    await lockCourts(ctx, [i.court_id]);
    const court = await ctx.trx.selectFrom("court").select("location_id").where("id", "=", i.court_id).executeTakeFirstOrThrow();
    const club = await ctx.trx.selectFrom("club").select("name").executeTakeFirstOrThrow();
    const id = uuidv7(), code = await newCode(ctx.trx, club.name), price = i.price_cents ?? 0;
    await ctx.insert("booking", { id, code, location_id: court.location_id, organiser_id: i.person_id ?? null, status: "confirmed", source: "desk", price_cents: price, note: i.note ?? null });
    await ctx.insert("booking_player", { id: uuidv7(), booking_id: id, person_id: i.person_id ?? null, guest_name: i.person_id ? null : i.guest_name!, share_cents: price });
    await insertTime(ctx, [{ id: uuidv7(), court_id: i.court_id, during: range(start, end), kind: "booking", booking_id: id }]);
    await ctx.emit("booking.created", { booking_id: id });
    return { booking_id: id, code };
  },
});

export const bookingCancel = defineAction({
  name: "booking.cancel", version: 1,
  input: z.object({ booking_id: z.uuid(), reason: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const { row: b, read } = await readRow(ctx.db, "booking", i.booking_id, "thing.booking");
    if (b.status === "cancelled") throw new KumiError("error.already_cancelled");
    return { title: both("action.booking.cancel"), summary: both("plan.booking.cancel", { code: b.code }), reads: [read], locationId: b.location_id,
      ownerIds: b.organiser_id ? [b.organiser_id] : [], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.update("booking", i.booking_id, { status: "cancelled", cancelled_at: ctx.now, cancel_reason: i.reason ?? null });
    for (const t of await ctx.trx.selectFrom("court_time").select("id").where("booking_id", "=", i.booking_id).where("active", "=", true).execute()) await ctx.update("court_time", t.id, { active: false });
    await ctx.emit("booking.cancelled", { booking_id: i.booking_id });
    return null;
  },
});
