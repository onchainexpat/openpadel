// Courts blocked on a repeating pattern: "Courts 1 and 2 every Tuesday 18:00 to 20:00 for the league". Each date is
// an ordinary block (a court_block and its court_time rows), so the database still refuses two things on one court
// at once, and every write locks its courts first, in id order. A booking already in the way stays (the block skips
// that court that day) or is called off, as staff choose; what its players get back is a separate choice (rule 2).
// Changing or ending a series works like programming: this date, this and the following ones, or all still to come.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, money, type Key, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type ApplyCtx, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate, onDate, weekdayOf } from "./clock.ts";
import { courtsAt, insertTime, locationTz, lockCourts, occupied, range } from "./bookings.ts";
import { cancelBooking, cancelRefunds } from "./booking_pay.ts";

/** How far ahead a series' dates are made: a year. One with no end gets its new dates as the year moves on. */
export const SERIES_AHEAD_DAYS = 365;

const clockTime = z.string().check(z.regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/));
const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
const reasons = z.enum(["maintenance", "fault", "resurfacing", "event", "other"]);
const weekdays = z.array(z.number().check(z.int(), z.minimum(0), z.maximum(6))).check(z.minLength(1), z.maxLength(7));
const inTheWay = z.optional(z.enum(["keep", "cancel"]));
const refundChoice = z.optional(z.enum(["rule", "full", "none"]));
const scope = z.enum(["this", "following", "all"]);

const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayIn = (date: string, lang: Lang) => new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));
const day = (date: string): Text => ({ en: dayIn(date, "en"), es: dayIn(date, "es") });
const hhmm = (t: string) => t.slice(0, 5);
const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const join = (parts: Text[], sep = ", "): Text => ({ en: parts.map((p) => p.en).filter(Boolean).join(sep), es: parts.map((p) => p.es).filter(Boolean).join(sep) });
/** "Tue, Thu": the weekdays, Monday first. */
function daysText(ws: number[]): Text {
  const name = (w: number, lang: Lang) => new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));
  const order = [1, 2, 3, 4, 5, 6, 0].filter((w) => ws.includes(w));
  return { en: order.map((w) => name(w, "en")).join(", "), es: order.map((w) => name(w, "es")).join(", ") };
}
/** The first few things, then "and 4 more". */
function some(items: Text[]): Text {
  const shown = join(items.slice(0, 3));
  return items.length > 3 ? join([shown, both("plan.block_repeat.more", { count: items.length - 3 })], " ") : shown;
}

/** A repeating pattern: the weekdays, the times, the dates it runs between, and the dates taken out of it. */
interface Pattern { weekdays: number[]; starts: string; ends: string; from: string; until: string | null; skip: string[] }
/** Its dates from `from` to `to`, both included. */
function datesOf(p: Pattern, from: string, to: string): string[] {
  const out: string[] = [], last = p.until && p.until < to ? p.until : to;
  for (let d = from > p.from ? from : p.from; d <= last; d = addDays(d, 1)) if (p.weekdays.includes(weekdayOf(d)) && !p.skip.includes(d)) out.push(d);
  return out;
}
/** How far a series' dates are made: a year from today, or its end if that's sooner. */
const madeUntil = (today: string, until: string | null) => { const h = addDays(today, SERIES_AHEAD_DAYS); return until && until < h ? until : h; };

/** One date to make: when, and on which courts (a court with something staying in the way is left out that day). */
interface ToMake { date: string; start: string; end: string; courtIds: string[] }
interface Cancel { booking_id: string; refunds: { payment_id: string; cents: number }[] }
interface Layout { make: ToMake[]; cancels: Cancel[]; texts: Text[]; refundCents: number; organisers: string[] }

/** What making these dates would do: the courts and times each takes, what's in the way, and what happens to it.
 *  `ignore`: blocks this change replaces (a series' own dates being moved), which aren't in its way. */
async function layout(ctx: PlanCtx, o: { courtIds: string[]; dates: string[]; starts: string; ends: string; tz: string; inTheWay: "keep" | "cancel"; refund: "rule" | "full" | "none"; ignore: string[] }): Promise<Layout> {
  const slots = o.dates.map((d) => ({ date: d, start: onDate(d, o.starts, o.tz), end: onDate(d, o.ends, o.tz) })).filter((s) => s.end > ctx.now);
  const taken = slots.length ? (await occupied(ctx.db, o.courtIds, slots[0]!.start, slots.at(-1)!.end, ctx.now)).filter((t) => !t.block_id || !o.ignore.includes(t.block_id)) : [];
  const way = slots.flatMap((s) => taken.filter((t) => new Date(t.start) < s.end && new Date(t.end) > s.start).map((t) => ({ date: s.date, courtId: t.court_id, kind: t.kind, bookingId: t.booking_id })));
  const bookingIds = [...new Set(way.filter((w) => w.kind === "booking" && w.bookingId).map((w) => w.bookingId!))];
  const cancelling = o.inTheWay === "cancel" ? bookingIds : [];
  const stays = way.filter((w) => !(w.bookingId && cancelling.includes(w.bookingId)));
  const make = slots.map((s) => ({ date: s.date, start: s.start.toISOString(), end: s.end.toISOString(), courtIds: o.courtIds.filter((c) => !stays.some((w) => w.date === s.date && w.courtId === c)) }))
    .filter((m) => m.courtIds.length);
  const cancels: Cancel[] = [];
  for (const id of cancelling) { const r = await cancelRefunds(ctx.db, id, ctx.now, o.refund); cancels.push({ booking_id: id, refunds: r.refunds.map(({ payment_id, cents }) => ({ payment_id, cents })) }); }
  const refundCents = cancels.reduce((n, c) => n + c.refunds.reduce((m, r) => m + r.cents, 0), 0);
  const texts: Text[] = [];
  const courtName = new Map((await courtsAt(ctx.db, o.courtIds)).map((c) => [c.id, c.name as string]));
  if (bookingIds.length) {
    const rows = await ctx.db.selectFrom("booking").select(["id", "code", "organiser_id"]).where("id", "in", bookingIds).execute();
    const list = some(bookingIds.map((id) => { const w = way.find((x) => x.bookingId === id)!; return join([{ en: rows.find((r) => r.id === id)?.code ?? "", es: rows.find((r) => r.id === id)?.code ?? "" }, day(w.date)], " "); }));
    texts.push(o.inTheWay === "cancel" ? both("plan.block_repeat.way_cancel", { count: bookingIds.length, list, refund: usd(refundCents) }) : both("plan.block_repeat.way_keep", { count: bookingIds.length, list }));
  }
  const other = stays.filter((w) => w.kind !== "booking");
  if (other.length) texts.push(both("plan.block_repeat.way_other", { count: other.length, list: some(other.map((w) => join([{ en: courtName.get(w.courtId) ?? "", es: courtName.get(w.courtId) ?? "" }, day(w.date)], " "))) }));
  const organisers = cancelling.length ? (await ctx.db.selectFrom("booking").select("organiser_id").where("id", "in", cancelling).execute()).map((r) => r.organiser_id).filter((x): x is string => Boolean(x)) : [];
  return { make, cancels, texts, refundCents, organisers };
}

/** Make the dates: a block for each, holding its courts. The courts are locked first (every caller does), so what's
 *  on them now is all there is: something taken since the preview (a member booking that slot a moment before)
 *  stays, and the block leaves that court out that day, as the preview said a booking in the way would. Returns
 *  how many dates were made. */
async function makeDates(ctx: ApplyCtx, seriesId: string, reason: string, note: string | null, make: ToMake[]): Promise<number> {
  let made = 0;
  for (const m of make) {
    const start = new Date(m.start), end = new Date(m.end);
    const busy = await occupied(ctx.trx, m.courtIds, start, end, ctx.now);
    const courts = m.courtIds.filter((c) => !busy.some((b) => b.court_id === c));
    if (!courts.length) continue;
    const blockId = uuidv7();
    await ctx.insert("court_block", { id: blockId, reason, note, series_id: seriesId, on_date: m.date });
    await insertTime(ctx, courts.map((court) => ({ id: uuidv7(), court_id: court, during: range(start, end), kind: "block", block_id: blockId })));
    made++;
  }
  return made;
}
/** Take dates off the courts: their blocks and court time end. */
async function openDates(ctx: ApplyCtx, blockIds: string[]) {
  if (!blockIds.length) return;
  for (const t of await ctx.trx.selectFrom("court_time").select("id").where("block_id", "in", blockIds).where("active", "=", true).execute()) await ctx.update("court_time", t.id, { active: false });
  for (const id of blockIds) await ctx.update("court_block", id, { active: false });
}
/** A series' dates from `from` on that haven't started (or every one still to come), with their courts. */
async function datesAhead(db: Db | Trx, seriesId: string, from: string | null, now: Date) {
  return db.selectFrom("court_block").innerJoin("court_time", "court_time.block_id", "court_block.id")
    .select(["court_block.id", "court_block.on_date", sql<Date>`min(lower(court_time.during))`.as("start")])
    .where("court_block.series_id", "=", seriesId).where("court_block.active", "=", true).where("court_time.active", "=", true)
    .$if(Boolean(from), (q) => q.where("court_block.on_date", ">=", from!)).groupBy(["court_block.id", "court_block.on_date"])
    .having(sql<boolean>`min(lower(court_time.during)) > ${now}`).orderBy("court_block.on_date").execute();
}

const courtList = (courts: { name: string }[]): Text => ({ en: courts.map((c) => c.name).join(", "), es: courts.map((c) => c.name).join(", ") });
/** "Block Court 1, Court 2 every Tue, 18:00 to 20:00 (an event)". */
const patternText = (courts: { name: string }[], ws: number[], starts: string, ends: string, reason: string): Text =>
  both("plan.block_repeat.pattern", { courts: courtList(courts), days: daysText(ws), from: hhmm(starts), to: hhmm(ends), reason: both(`block.${reason}` as Key) });
const spanText = (from: string, until: string | null): Text => until ? both("plan.block_repeat.span_until", { start: day(from), end: day(until) }) : both("plan.block_repeat.span_open", { start: day(from) });

export const courtBlockRepeat = defineAction({
  name: "court.block_repeat", version: 1,
  input: z.object({ court_ids: z.array(z.uuid()).check(z.minLength(1)), weekdays, starts: clockTime, ends: clockTime, from_date: clubDate, until_date: z.optional(clubDate),
    reason: reasons, note: z.optional(z.string().check(z.maxLength(200))), in_the_way: inTheWay, refund: refundChoice }),
  async plan(ctx, i) {
    if (i.ends <= i.starts) throw new KumiError("error.bad_times");
    if (i.until_date && i.until_date < i.from_date) throw new KumiError("error.bad_dates");
    const courts = await courtsAt(ctx.db, i.court_ids), locationId = courts[0]!.location_id, tz = await locationTz(ctx.db, locationId);
    const until = madeUntil(localDate(ctx.now, tz), i.until_date ?? null), ws = [...new Set(i.weekdays)].sort();
    const dates = datesOf({ weekdays: ws, starts: i.starts, ends: i.ends, from: i.from_date, until: i.until_date ?? null, skip: [] }, i.from_date, until);
    const l = await layout(ctx, { courtIds: i.court_ids, dates, starts: i.starts, ends: i.ends, tz, inTheWay: i.in_the_way ?? "keep", refund: i.refund ?? "full", ignore: [] });
    if (!l.make.length) throw new KumiError("error.no_dates");
    const summary = join([both("plan.court.block_repeat", { pattern: patternText(courts, ws, i.starts, i.ends, i.reason), span: spanText(i.from_date, i.until_date ?? null), count: l.make.length }), ...l.texts], " ");
    return { title: both("action.court.block_repeat"), summary, reads: [], locationId, ownerIds: l.organisers, moneyCents: l.refundCents,
      undo: { kind: l.refundCents ? "compensating" : "reversible" }, details: { make: l.make, cancels: l.cancels, made_until: until, location_id: locationId, weekdays: ws } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { make: ToMake[]; cancels: Cancel[]; made_until: string; location_id: string; weekdays: number[] };
    await lockCourts(ctx, i.court_ids);
    for (const c of d.cancels) await cancelBooking(ctx, c.booking_id, c.refunds, "court_blocked");
    const id = uuidv7();
    await ctx.insert("block_series", { id, location_id: d.location_id, court_ids: i.court_ids, weekdays: d.weekdays, starts: i.starts, ends: i.ends, from_date: i.from_date,
      until_date: i.until_date ?? null, made_until: d.made_until, reason: i.reason, note: i.note ?? null });
    const dates = await makeDates(ctx, id, i.reason, i.note ?? null, d.make);
    await ctx.emit("court.blocked", { series_id: id });
    return { series_id: id, dates };
  },
});

/** A date of a series, chosen to start a change from, and its series. */
async function chosenDate(ctx: PlanCtx, blockId: string) {
  const { row: b, read } = await readRow(ctx.db, "court_block", blockId, "thing.block");
  if (!b.active) throw new KumiError("error.not_found", { thing: both("thing.block") }, 404);
  if (!b.series_id || !b.on_date) throw new KumiError("error.not_repeating");
  const { row: s, read: sRead } = await readRow(ctx.db, "block_series", b.series_id, "thing.block");
  const tz = await locationTz(ctx.db, s.location_id);
  const t = await ctx.db.selectFrom("court_time").select([sql<Date>`min(lower(during))`.as("start"), sql<Date>`max(upper(during))`.as("end")]).where("block_id", "=", blockId).where("active", "=", true).executeTakeFirst();
  return { b, s, tz, start: t?.start ? new Date(t.start) : null, end: t?.end ? new Date(t.end) : null, reads: [read, sRead] };
}

export const courtBlockRepeatEnd = defineAction({
  name: "court.block_repeat_end", version: 1,
  input: z.object({ block_id: z.uuid(), scope }),
  async plan(ctx, i) {
    const c = await chosenDate(ctx, i.block_id);
    const courts = await courtsAt(ctx.db, c.s.court_ids);
    if (i.scope === "this") {
      if (c.end && c.end <= ctx.now) throw new KumiError("error.date_started");
      return { title: both("action.court.block_repeat_end"), summary: both("plan.court.block_repeat_end_this", { courts: courtList(courts), date: day(c.b.on_date!) }), reads: c.reads,
        locationId: c.s.location_id, undo: { kind: "reversible" }, details: { blocks: [c.b.id] } };
    }
    const ahead = await datesAhead(ctx.db, c.s.id, i.scope === "following" ? c.b.on_date : null, ctx.now);
    const key = i.scope === "following" ? "plan.court.block_repeat_end_following" : "plan.court.block_repeat_end_all";
    return { title: both("action.court.block_repeat_end"), summary: both(key, { courts: courtList(courts), date: day(c.b.on_date!), count: ahead.length }), reads: c.reads,
      locationId: c.s.location_id, undo: { kind: "reversible" }, details: { blocks: ahead.map((a) => a.id) } };
  },
  async apply(ctx, i, plan) {
    const c = await chosenDate(ctx, i.block_id), d = plan.details as { blocks: string[] };
    await lockCourts(ctx, c.s.court_ids);
    await openDates(ctx, d.blocks);
    if (i.scope === "this") await ctx.update("block_series", c.s.id, { skip_dates: [...new Set([...c.s.skip_dates, c.b.on_date!])].sort() });
    else if (i.scope === "all") await ctx.update("block_series", c.s.id, { active: false });
    else {
      const until = addDays(c.b.on_date!, -1);
      await ctx.update("block_series", c.s.id, until < c.s.from_date ? { active: false } : { until_date: until, made_until: c.s.made_until < until ? c.s.made_until : until });
    }
    return null;
  },
});

export const courtBlockRepeatEdit = defineAction({
  name: "court.block_repeat_edit", version: 1,
  input: z.object({ block_id: z.uuid(), scope, court_ids: z.optional(z.array(z.uuid()).check(z.minLength(1))), weekdays: z.optional(weekdays), starts: z.optional(clockTime), ends: z.optional(clockTime),
    until_date: z.optional(z.nullable(clubDate)), reason: z.optional(reasons), note: z.optional(z.nullable(z.string().check(z.maxLength(200)))), in_the_way: inTheWay, refund: refundChoice }),
  async plan(ctx, i) {
    const c = await chosenDate(ctx, i.block_id);
    const courtIds = i.court_ids ?? c.s.court_ids, courts = await courtsAt(ctx.db, courtIds);
    if (courts[0]!.location_id !== c.s.location_id) throw new KumiError("error.one_location");
    const starts = i.starts ?? hhmm(c.s.starts), ends = i.ends ?? hhmm(c.s.ends), reason = i.reason ?? c.s.reason;
    if (ends <= starts) throw new KumiError("error.bad_times");
    // The dates being replaced: this one, or this and the following ones, or all still to come.
    let split: string, old: string[], dates: string[], ws = c.s.weekdays, until: string | null = c.s.until_date;
    if (i.scope === "this") {
      if (c.start && c.start <= ctx.now) throw new KumiError("error.date_started");
      split = c.b.on_date!; old = [c.b.id]; dates = [split];
    } else {
      const ahead = await datesAhead(ctx.db, c.s.id, i.scope === "following" ? c.b.on_date : null, ctx.now);
      if (!ahead.length) throw new KumiError("error.series_over");
      split = i.scope === "following" ? c.b.on_date! : ahead[0]!.on_date!; old = ahead.map((a) => a.id);
      ws = i.weekdays ? [...new Set(i.weekdays)].sort() : ws; until = i.until_date !== undefined ? i.until_date : until;
      if (until && until < split) throw new KumiError("error.bad_dates");
      dates = datesOf({ weekdays: ws, starts, ends, from: split, until, skip: [] }, split, madeUntil(localDate(ctx.now, c.tz), until));
    }
    const l = await layout(ctx, { courtIds, dates, starts, ends, tz: c.tz, inTheWay: i.in_the_way ?? "keep", refund: i.refund ?? "full", ignore: old });
    const which = i.scope === "this" ? both("plan.block_repeat.only", { date: day(split) }) : i.scope === "following" ? both("plan.block_repeat.from", { date: day(split) }) : both("plan.block_repeat.all");
    const summary = join([both("plan.court.block_repeat_edit", { which, pattern: patternText(courts, ws, starts, ends, reason), count: l.make.length }), ...l.texts], " ");
    return { title: both("action.court.block_repeat_edit"), summary, reads: c.reads, locationId: c.s.location_id, ownerIds: l.organisers, moneyCents: l.refundCents,
      undo: { kind: l.refundCents ? "compensating" : "reversible" },
      details: { old, make: l.make, cancels: l.cancels, split, weekdays: ws, until, starts, ends, court_ids: courtIds, reason, made_until: madeUntil(localDate(ctx.now, c.tz), until) } };
  },
  async apply(ctx, i, plan) {
    const c = await chosenDate(ctx, i.block_id);
    const d = plan.details as { old: string[]; make: ToMake[]; cancels: Cancel[]; split: string; weekdays: number[]; until: string | null; starts: string; ends: string; court_ids: string[]; reason: string; made_until: string };
    await lockCourts(ctx, [...c.s.court_ids, ...d.court_ids]);
    for (const x of d.cancels) await cancelBooking(ctx, x.booking_id, x.refunds, "court_blocked");
    await openDates(ctx, d.old);
    const note = i.note !== undefined ? i.note : c.s.note;
    if (i.scope === "this") {
      // The date changed on its own stays part of the series (ending the series ends it too), and is never made again.
      await ctx.update("block_series", c.s.id, { skip_dates: [...new Set([...c.s.skip_dates, d.split])].sort() });
      await makeDates(ctx, c.s.id, d.reason, note, d.make);
      return { series_id: c.s.id };
    }
    const until = addDays(d.split, -1);
    await ctx.update("block_series", c.s.id, until < c.s.from_date ? { active: false } : { until_date: until, made_until: c.s.made_until < until ? c.s.made_until : until });
    const id = uuidv7();
    await ctx.insert("block_series", { id, location_id: c.s.location_id, court_ids: d.court_ids, weekdays: d.weekdays, starts: d.starts, ends: d.ends, from_date: d.split, until_date: d.until,
      made_until: d.made_until, reason: d.reason, note });
    await makeDates(ctx, id, d.reason, note, d.make);
    return { series_id: id };
  },
});

/** The job: a series' dates are made a year ahead, so each day one more may come into that year. Whatever is in the
 *  way of a new date then stays, and the block skips that court that day. */
export const blockSeriesExtend = defineAction({
  name: "block_series.extend", version: 1, system: true, internal: true,
  input: z.object({ series_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: s, read } = await readRow(ctx.db, "block_series", i.series_id, "thing.block");
    const tz = await locationTz(ctx.db, s.location_id), to = madeUntil(localDate(ctx.now, tz), s.until_date);
    const dates = s.active && to > s.made_until ? datesOf({ weekdays: s.weekdays, starts: s.starts, ends: s.ends, from: s.from_date, until: s.until_date, skip: s.skip_dates }, addDays(s.made_until, 1), to) : [];
    const l = await layout(ctx, { courtIds: s.court_ids, dates, starts: hhmm(s.starts), ends: hhmm(s.ends), tz, inTheWay: "keep", refund: "rule", ignore: [] });
    return { title: both("action.block_series.extend"), summary: both("plan.block_series.extend", { count: l.make.length }), reads: [read], locationId: s.location_id, undo: { kind: "none" },
      details: { make: l.make, made_until: to } };
  },
  async apply(ctx, i, plan) {
    const s = await ctx.trx.selectFrom("block_series").selectAll().where("id", "=", i.series_id).forUpdate().executeTakeFirstOrThrow();
    const d = plan.details as { make: ToMake[]; made_until: string };
    if (!s.active || s.made_until >= d.made_until) return { dates: 0 };
    await lockCourts(ctx, s.court_ids);
    const dates = await makeDates(ctx, s.id, s.reason, s.note, d.make);
    await ctx.update("block_series", s.id, { made_until: d.made_until });
    return { dates };
  },
});

/** Every series whose year ahead has moved on: its new dates. */
export async function extendBlockSeries(db: Db, now = new Date()) {
  const rows = await db.selectFrom("block_series").innerJoin("location", "location.id", "block_series.location_id")
    .select(["block_series.id", "block_series.made_until", "block_series.until_date", "location.time_zone"]).where("block_series.active", "=", true).execute();
  let dates = 0;
  for (const s of rows) {
    const to = madeUntil(localDate(now, s.time_zone), s.until_date);
    if (to <= s.made_until) continue;
    dates += ((await runAsSystem(db, "block_series.extend", { series_id: s.id }, "jobs", { now })).result as { dates: number }).dates;
  }
  return { dates };
}
