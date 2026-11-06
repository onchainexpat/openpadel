// Weekly court bookings: one member, the same court, day and time every week (booking_series). Each week is an
// ordinary booking (its own code, court time, price, rules and payment), priced and ruled as the series was when it
// was made, so cancelling one week is booking.cancel under that week's rules, and reports count it like any other.
// Staff make one for a member, every week owed at the desk (booking.repeat). A member makes their own when the club
// allows it (booking.repeat_request): the first week is paid now by card, which saves the card, and each later week
// is booked once it comes into their booking window (booking.repeat_week, the job) and goes on that card at the
// club's pay deadline, as unpaid shares do (booking.settle_shares). A week someone else has by then is left out,
// the member is told, and nothing is charged for it. A series never holds a court beyond the member's window.
// Ending one (booking.repeat_end) cancels a week and all after it, each under its own rules.
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, money, type Key, type Text, formatLocale } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type ApplyCtx, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate, localParts, onDate } from "./clock.ts";
import { courtOpening, insertTime, lockCourts, MAX_MINUTES, occupied, range, STEP_MINUTES } from "./bookings.ts";
import { cancelBooking, cancelRefunds, checkSlot, courtAndPlace, daysAhead, deskOrUp, HOLD_MINUTES, lockBooking, newCode, notOwing, upcomingCount } from "./booking_pay.ts";
import { currentPolicy, quote, type Quote } from "./prices.ts";
import { notJunior, requireWaiver, withManagers } from "./households.ts";
import { paymentProvider } from "./money.ts";
import { isReadOnly } from "./read_only.ts";
import { backSql } from "./desk_pay.ts";
import { heartbeat, jobFailed, jobWorked } from "./ops.ts";

/** The most weeks one series runs (a club's own cap for members is lower: club.weekly_max_weeks). */
export const MAX_WEEKS = 26;
type Missed = "taken" | "closed" | "not_bookable" | "too_late" | "no_card" | "unpaid" | "limit";

const clubDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const fmt = (d: Date, tz: string, o: Intl.DateTimeFormatOptions): Text => ({ en: new Intl.DateTimeFormat(formatLocale("en"), { timeZone: tz, ...o }).format(d), es: new Intl.DateTimeFormat(formatLocale("es"), { timeZone: tz, ...o }).format(d) });
const dayOf = (date: string): Text => fmt(new Date(`${date}T12:00:00Z`), "UTC", { weekday: "short", month: "short", day: "numeric" });
const join = (parts: Text[], sep = " "): Text => ({ en: parts.map((p) => p.en).filter(Boolean).join(sep), es: parts.map((p) => p.es).filter(Boolean).join(sep) });
const hhmm = (d: Date, tz: string) => { const p = localParts(d, tz); return `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`; };

/** A week of a series: when it is, what it costs (priced now), and what's in its way now, if anything. */
interface Week { date: string; start: string; end: string; price_cents: number; tax_cents: number; quote: Quote | null; clash: Missed | null }
/** The weeks from the first date: the same local time each week (a clock change doesn't move it). */
async function weeksFor(db: Db | Trx, o: { court: { id: string; location_id: string; bookable: boolean; time_zone: string }; first: string; time: string; minutes: number; count: number;
  personId: string; priceCents?: number; now: Date }): Promise<Week[]> {
  const out: Week[] = [];
  for (let k = 0; k < o.count; k++) {
    const date = addDays(o.first, 7 * k), start = onDate(date, o.time, o.court.time_zone), end = new Date(start.getTime() + o.minutes * 60_000);
    const open = await courtOpening(db, o.court, date);
    const clash: Missed | null = !o.court.bookable ? "not_bookable" : !open || start < open.opens || end > open.closes ? "closed"
      : (await occupied(db, [o.court.id], start, end, o.now)).length ? "taken" : null;
    const q = await quote(db, { courtId: o.court.id, start, minutes: o.minutes, personId: o.personId, at: o.now });
    if (o.priceCents === undefined && !q.priced && !clash) throw new KumiError("error.no_price");
    const price = o.priceCents ?? q.total_cents, tax = o.priceCents === undefined ? q.tax_cents : Math.round(price * q.tax_bp / (10_000 + q.tax_bp));
    out.push({ date, start: start.toISOString(), end: end.toISOString(), price_cents: price, tax_cents: tax, quote: q, clash });
  }
  return out;
}
/** "Tue, Dec 22 (taken), Tue, Dec 29 (closed)". */
const clashList = (weeks: Week[]): Text => join(weeks.filter((w) => w.clash).map((w) => join([dayOf(w.date), both(`plan.booking.repeat_why_${w.clash}` as Key)])), ", ");
/** "Court 1 every Tuesday at 6:00 PM, 90 minutes". */
function patternText(court: string, start: Date, tz: string, minutes: number): Text {
  return both("plan.booking.repeat_pattern", { court, weekday: fmt(start, tz, { weekday: "long" }), time: fmt(start, tz, { hour: "numeric", minute: "2-digit" }), minutes });
}
/** "$40.00 a week, $480.00 in all", or "$480.00 in all" when the weeks cost different amounts. */
function priceText(weeks: Week[]): Text {
  const total = weeks.reduce((n, w) => n + w.price_cents, 0), same = weeks.every((w) => w.price_cents === weeks[0]!.price_cents);
  return same ? both("plan.booking.repeat_each", { each: usd(weeks[0]!.price_cents), total: usd(total) }) : both("plan.booking.repeat_total", { total: usd(total) });
}
function checkLength(minutes: number) {
  if (minutes < STEP_MINUTES || minutes > MAX_MINUTES || minutes % STEP_MINUTES) throw new KumiError("error.invalid_input", { details: "minutes" }, 400);
}

interface WeekRow { id: string; on_date: string; price_cents: number; tax_cents: number; quote: unknown }
type SeriesRow = { id: string; location_id: string; court_id: string; organiser_id: string; starts: string; minutes: number; source: "app" | "desk"; policy_id: string };
/** One week booked: an ordinary confirmed booking for the series' member, at the week's price and the series' rules.
 *  The caller has locked the court; what's on it now is checked again (something may have taken it since the
 *  preview, or since the week was priced), and why it can't be booked is returned instead. */
async function bookWeek(ctx: ApplyCtx, s: SeriesRow, w: WeekRow, tz: string): Promise<{ booking_id: string } | { missed: Missed }> {
  const court = await ctx.trx.selectFrom("court").select(["id", "location_id", "bookable", "archived_at"]).where("id", "=", s.court_id).executeTakeFirstOrThrow();
  const start = onDate(w.on_date, s.starts.slice(0, 5), tz), end = new Date(start.getTime() + s.minutes * 60_000);
  if (start <= ctx.now) return { missed: "too_late" };
  if (!court.bookable || court.archived_at) return { missed: "not_bookable" };
  const open = await courtOpening(ctx.trx, court, w.on_date);
  if (!open || start < open.opens || end > open.closes) return { missed: "closed" };
  // A card form left open and never paid holds the court only until its time is up.
  await ctx.trx.updateTable("court_time").set({ active: false }).where("court_id", "=", s.court_id).where("kind", "=", "hold").where("active", "=", true).where("hold_until", "<=", ctx.now).execute();
  if ((await occupied(ctx.trx, [s.court_id], start, end, ctx.now)).length) return { missed: "taken" };
  const id = uuidv7(), code = await newCode(ctx.trx);
  await ctx.insert("booking", { id, code, location_id: s.location_id, organiser_id: s.organiser_id, status: "confirmed", source: s.source, price_cents: w.price_cents, tax_cents: w.tax_cents,
    quote: w.quote === null ? null : JSON.stringify(w.quote), policy_id: s.policy_id, invite_code: randomBytes(9).toString("base64url"), series_id: s.id });
  await ctx.insert("booking_player", { id: uuidv7(), booking_id: id, person_id: s.organiser_id, share_cents: w.price_cents });
  await insertTime(ctx, [{ id: uuidv7(), court_id: s.court_id, during: range(start, end), kind: "booking", booking_id: id }]);
  return { booking_id: id };
}

/** The card a member's series goes on: the one saved when they paid its first week. */
export async function seriesCard(db: Db | Trx, seriesId: string) {
  return (await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").innerJoin("booking", "booking.id", "booking_player.booking_id")
    .select(["payment.saved_customer", "payment.saved_method", "payment.provider_account"]).where("booking.series_id", "=", seriesId).where("payment.save_card", "=", true)
    .where("payment.status", "=", "succeeded").where("payment.saved_method", "is not", null).whereRef("payment.person_id", "=", "booking.organiser_id")
    .orderBy("payment.created_at", "desc").limit(1).executeTakeFirst()) ?? null;
}
/** A series' clock: its location's time zone (read directly, so a court archived since still has one). */
async function seriesTz(db: Db | Trx, locationId: string): Promise<string> {
  return (await db.selectFrom("location").select("time_zone").where("id", "=", locationId).executeTakeFirstOrThrow()).time_zone;
}

// ---- Staff make one for a member: every week owed at the desk ----
export const bookingRepeat = defineAction({
  name: "booking.repeat", version: 1,
  input: z.object({
    court_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }), minutes: z.number().check(z.int()), person_id: z.uuid(),
    weeks: z.optional(z.number().check(z.int(), z.minimum(2), z.maximum(MAX_WEEKS))), until_date: z.optional(clubDate),
    price_cents: z.optional(z.number().check(z.int(), z.minimum(0))),
  }),
  async plan(ctx, i) {
    if (Boolean(i.weeks) === Boolean(i.until_date)) throw new KumiError("error.repeat_how_long");
    checkLength(i.minutes);
    const court = await courtAndPlace(ctx.db, i.court_id), tz = court.time_zone, start = new Date(i.starts_at);
    if (start <= ctx.now) throw new KumiError("error.in_the_past");
    const first = localDate(start, tz);
    const count = i.weeks ?? Math.floor((Date.parse(`${i.until_date}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / (7 * 86400_000)) + 1;
    if (count < 2) throw new KumiError("error.bad_dates");
    if (count > MAX_WEEKS) throw new KumiError("error.repeat_too_many", { count: MAX_WEEKS });
    const { row: person, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const weeks = await weeksFor(ctx.db, { court, first, time: hhmm(start, tz), minutes: i.minutes, count, personId: i.person_id, priceCents: i.price_cents, now: ctx.now });
    const booked = weeks.filter((w) => !w.clash);
    if (!booked.length) throw new KumiError("error.no_dates");
    const summary = join([
      both("plan.booking.repeat", { pattern: patternText(court.name, start, tz, i.minutes), who: person.display_name, count: booked.length, first: dayOf(booked[0]!.date), last: dayOf(booked.at(-1)!.date), price: priceText(booked) }),
      both("plan.booking.repeat_desk"),
      booked.length < weeks.length ? both("plan.booking.repeat_left_out", { list: clashList(weeks) }) : { en: "", es: "" },
    ]);
    return { title: both("action.booking.repeat"), summary, reads: [read], locationId: court.location_id, ownerIds: [i.person_id], moneyCents: booked.reduce((n, w) => n + w.price_cents, 0),
      undo: { kind: "none" }, details: { weeks, time: hhmm(start, tz) } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { weeks: Week[]; time: string };
    await lockCourts(ctx, [i.court_id]);
    const court = await courtAndPlace(ctx.trx, i.court_id), policy = await currentPolicy(ctx.trx), id = uuidv7();
    const s = await ctx.insert("booking_series", { id, location_id: court.location_id, court_id: i.court_id, organiser_id: i.person_id, starts: d.time, minutes: i.minutes,
      first_date: d.weeks[0]!.date, last_date: d.weeks.at(-1)!.date, pay: "desk", source: "desk", policy_id: policy.id }) as SeriesRow;
    let booked = 0;
    for (const w of d.weeks) {
      const row = { id: uuidv7(), series_id: id, on_date: w.date, price_cents: w.price_cents, tax_cents: w.tax_cents, quote: w.quote ? JSON.stringify(w.quote) : null };
      const r = w.clash ? { missed: w.clash } : await bookWeek(ctx, s, { ...row, quote: w.quote }, court.time_zone);
      await ctx.insert("booking_series_week", { ...row, ...("booking_id" in r ? { booking_id: r.booking_id } : { missed: r.missed }) });
      if ("booking_id" in r) booked++;
    }
    // Nothing is left to book: every week is booked or left out. Its weeks still show, and can be ended.
    await ctx.update("booking_series", id, { ended_at: ctx.now });
    await ctx.emit("booking.repeat_made", { series_id: id });
    return { series_id: id, booked };
  },
});

// ---- A member makes their own: the first week paid now, the card saved for the rest ----
export const bookingRepeatRequest = defineAction({
  name: "booking.repeat_request", version: 1,
  input: z.object({ court_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }), minutes: z.number().check(z.int()), person_id: z.uuid(),
    weeks: z.number().check(z.int(), z.minimum(2), z.maximum(MAX_WEEKS)) }),
  async plan(ctx, i) {
    const club = await ctx.db.selectFrom("club").select(["court_bookings", "weekly_bookings", "weekly_max_weeks"]).executeTakeFirstOrThrow();
    if (!club.court_bookings) throw new KumiError("error.bookings_off");
    if (!club.weekly_bookings) throw new KumiError("error.weekly_off");
    if (i.weeks > club.weekly_max_weeks) throw new KumiError("error.repeat_too_many", { count: club.weekly_max_weeks });
    await notOwing(ctx.db, i.person_id, ctx.actor.personId, ctx.now);
    await notJunior(ctx.db, i.person_id);
    await requireWaiver(ctx, i.person_id);
    // The first week passes every check a booking made in the app passes: its window, the lengths, the hours, free.
    const policy = await currentPolicy(ctx.db), { court, start } = await checkSlot(ctx, policy, i, i.person_id);
    if (await upcomingCount(ctx.db, i.person_id, ctx.now) >= policy.max_active) throw new KumiError("error.too_many_bookings", { count: policy.max_active });
    const c = await courtAndPlace(ctx.db, i.court_id), tz = c.time_zone;
    const weeks = await weeksFor(ctx.db, { court: c, first: localDate(start, tz), time: hhmm(start, tz), minutes: i.minutes, count: i.weeks, personId: i.person_id, now: ctx.now });
    const ahead = await daysAhead(ctx.db, i.person_id, ctx.now), kept = weeks.filter((w) => !w.clash);
    const summary = join([
      both("plan.booking.repeat_request", { pattern: patternText(court.name, start, tz, i.minutes), count: kept.length, first: dayOf(kept[0]!.date), last: dayOf(kept.at(-1)!.date), price: priceText(kept),
        now: usd(kept[0]!.price_cents), hours: both("count.hours", { count: policy.split_deadline_hours }), days: both("count.days", { count: ahead }) }),
      kept.length < weeks.length ? both("plan.booking.repeat_left_out", { list: clashList(weeks) }) : { en: "", es: "" },
    ]);
    return { title: both("action.booking.repeat_request"), summary, reads: [], locationId: court.location_id, ownerIds: [i.person_id], moneyCents: kept[0]!.price_cents,
      undo: { kind: "compensating" }, details: { weeks, time: hhmm(start, tz), policy_id: policy.id } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { weeks: Week[]; time: string; policy_id: string };
    const first = d.weeks[0]!, start = new Date(first.start), end = new Date(first.end);
    await lockCourts(ctx, [i.court_id]);
    await ctx.trx.updateTable("court_time").set({ active: false }).where("court_id", "=", i.court_id).where("kind", "=", "hold").where("active", "=", true).where("hold_until", "<=", ctx.now).execute();
    if ((await occupied(ctx.trx, [i.court_id], start, end, ctx.now)).length) throw new KumiError("error.court_taken");
    const court = await courtAndPlace(ctx.trx, i.court_id), id = uuidv7();
    await ctx.insert("booking_series", { id, location_id: court.location_id, court_id: i.court_id, organiser_id: i.person_id, starts: d.time, minutes: i.minutes,
      first_date: first.date, last_date: d.weeks.at(-1)!.date, pay: "card", source: "app", policy_id: d.policy_id });
    // The first week: held while the member pays, like any booking made in the app; paying saves the card.
    const bookingId = uuidv7(), code = await newCode(ctx.trx), bp = uuidv7(), payment = uuidv7();
    await ctx.insert("booking", { id: bookingId, code, location_id: court.location_id, organiser_id: i.person_id, status: "held", source: "app", price_cents: first.price_cents, tax_cents: first.tax_cents,
      quote: JSON.stringify(first.quote), policy_id: d.policy_id, pay_mode: "whole", invite_code: randomBytes(9).toString("base64url"), series_id: id });
    await ctx.insert("booking_player", { id: bp, booking_id: bookingId, person_id: i.person_id, share_cents: first.price_cents });
    await ctx.insert("court_time", { id: uuidv7(), court_id: i.court_id, during: sql`tstzrange(${start}, ${end})`, kind: "hold", booking_id: bookingId, hold_until: new Date(ctx.now.getTime() + HOLD_MINUTES * 60_000) });
    await ctx.insert("payment", { id: payment, person_id: i.person_id, amount_cents: first.price_cents, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending",
      booking_player_id: bp, save_card: true });
    for (const w of d.weeks) {
      const row = { id: uuidv7(), series_id: id, on_date: w.date, price_cents: w.price_cents, tax_cents: w.tax_cents, quote: w.quote ? JSON.stringify(w.quote) : null };
      // The weeks in someone's way now are left out, as the preview said; the rest wait for the member's window.
      await ctx.insert("booking_series_week", { ...row, ...(w === first ? { booking_id: bookingId } : w.clash ? { missed: w.clash } : {}) });
    }
    await ctx.emit("booking.requested", { booking_id: bookingId });
    // What the card form says beside the first week: the later weeks going on the same card, and when each is charged.
    const rest = d.weeks.filter((w) => w !== first && !w.clash), pol = await ctx.trx.selectFrom("booking_policy").select("split_deadline_hours").where("id", "=", d.policy_id).executeTakeFirstOrThrow();
    const later = { count: rest.length, cents: rest.reduce((n, w) => n + w.price_cents, 0), hours: pol.split_deadline_hours };
    return { series_id: id, booking_id: bookingId, code, payment_id: payment, total_cents: first.price_cents, later };
  },
});

// ---- The job: each later week of a member's series, once it's inside their booking window ----
/** Someone who owes the club (a declined week, time owed at the desk) gets no more weeks until it's paid. */
async function owes(db: Db | Trx, personId: string, now: Date): Promise<boolean> {
  try { await notOwing(db, personId, null, now); return false; } catch (e) { if (e instanceof KumiError && e.code === "error.balance_owed") return true; throw e; }
}
/** Whether a booking was ever paid for (a payment that went through, whatever came back of it since). */
async function everPaid(db: Db | Trx, bookingId: string): Promise<boolean> {
  return Boolean(await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id")
    .where("booking_player.booking_id", "=", bookingId).where("payment.status", "=", "succeeded").executeTakeFirst());
}
export const bookingRepeatWeek = defineAction({
  name: "booking.repeat_week", version: 1, system: true, internal: true,
  input: z.object({ series_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "booking_series", i.series_id, "thing.weekly_booking");
    return { title: both("action.booking.repeat_week"), summary: both("plan.booking.repeat_week"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const s = await ctx.trx.selectFrom("booking_series").selectAll().where("id", "=", i.series_id).forUpdate().executeTakeFirstOrThrow();
    if (s.ended_at) return { already: true };
    const end = async () => { await ctx.update("booking_series", s.id, { ended_at: ctx.now }); return { closed: "done" }; };
    // The club stopped taking weekly bookings (or court bookings) in the app: the series pauses, nothing is booked
    // and the weeks wait (those booked stay). The member hears once now, and once when the club takes them again;
    // weeks that passed meanwhile are dropped then, in the one message below.
    const club = await ctx.trx.selectFrom("club").select(["court_bookings", "weekly_bookings"]).executeTakeFirstOrThrow();
    if (s.source === "app" && (!club.court_bookings || !club.weekly_bookings)) {
      if (!s.paused_at) { await ctx.update("booking_series", s.id, { paused_at: ctx.now }); await ctx.emit("booking.repeat_paused", { series_id: s.id, why: club.court_bookings ? "weekly_off" : "bookings_off" }); }
      return { paused: true };
    }
    if (s.paused_at) { await ctx.update("booking_series", s.id, { paused_at: null }); await ctx.emit("booking.repeat_resumed", { series_id: s.id }); }
    // It runs on only once its first week is confirmed: one never paid (not in time, lost while its card went
    // through, or cancelled by the member before paying) ends it.
    const first = await ctx.trx.selectFrom("booking_series_week").innerJoin("booking", "booking.id", "booking_series_week.booking_id").select(["booking.id", "booking.status", "booking.cancel_reason"])
      .where("booking_series_week.series_id", "=", s.id).where("booking_series_week.on_date", "=", s.first_date).executeTakeFirst();
    if (s.pay === "card" && first?.status === "held") return { waiting: true };
    // (A first week paid and cancelled afterwards, the member not able to come that week, isn't that: it was had.)
    if (s.pay === "card" && (!first || (first.status === "cancelled" && (["not_paid", "hold_lost"].includes(first.cancel_reason ?? "") || !(await everPaid(ctx.trx, first.id)))))) return end();
    await lockCourts(ctx, [s.court_id]);
    const tz = await seriesTz(ctx.trx, s.location_id), until = new Date(ctx.now.getTime() + (await daysAhead(ctx.trx, s.organiser_id, ctx.now)) * 86400_000);
    const policy = await ctx.trx.selectFrom("booking_policy").selectAll().where("id", "=", s.policy_id).executeTakeFirstOrThrow();
    const card = s.pay === "card" ? await seriesCard(ctx.trx, s.id) : null, owing = await owes(ctx.trx, s.organiser_id, ctx.now);
    const due = await ctx.trx.selectFrom("booking_series_week").selectAll().where("series_id", "=", s.id).where("booking_id", "is", null).where("missed", "is", null)
      .where("on_date", "<=", s.last_date).orderBy("on_date").forUpdate().execute();
    const missed: { date: string; why: Missed }[] = [];
    let booked = 0;
    for (const w of due) {
      const start = onDate(w.on_date, s.starts.slice(0, 5), tz);
      if (start > until) break;   // not inside the window yet: never held sooner than one booking could be
      let r: { booking_id: string } | { missed: Missed };
      // A week that passed unbooked (the club was read-only, or paused, then) is dropped.
      if (start <= ctx.now) r = { missed: "too_late" };
      else if (s.pay === "card" && !card) r = { missed: "no_card" };
      else {
        // Owing (a declined week, time owed at the desk), or at the club's limit on upcoming bookings (counting only
        // those not begun: this week's, being played, makes room as it starts): the week waits and is tried again
        // each run, and is left out only once its pay deadline has passed.
        const wait: Missed | null = owing ? "unpaid" : await upcomingCount(ctx.trx, s.organiser_id, ctx.now, { notStarted: true }) >= policy.max_active ? "limit" : null;
        if (wait && ctx.now.getTime() < start.getTime() - policy.split_deadline_hours * 3600_000) continue;
        r = wait ? { missed: wait } : await bookWeek(ctx, s, w, tz);
      }
      if ("booking_id" in r) { await ctx.update("booking_series_week", w.id, { booking_id: r.booking_id }); booked++; }
      else { await ctx.update("booking_series_week", w.id, { missed: r.missed }); missed.push({ date: w.on_date, why: r.missed }); }
    }
    // The member hears once a run, with every week left out and why.
    if (missed.length) await ctx.emit("booking.repeat_missed", { series_id: s.id, weeks: missed });
    const left = await ctx.trx.selectFrom("booking_series_week").select("id").where("series_id", "=", s.id).where("booking_id", "is", null).where("missed", "is", null)
      .where("on_date", "<=", s.last_date).executeTakeFirst();
    if (!left) await end();   // nothing left to book: its booked weeks still show, and can be ended
    return { booked, missed: missed.length, ...(left ? {} : { closed: "done" }) };
  },
});

/** Every member's series still running: its weeks now inside their booking window are booked (booking.repeat_week).
 *  One series that fails doesn't stop the others (a court archived since, a second runner a moment ahead). Read-only,
 *  nothing new is booked: the weeks wait, and those still to come are booked once it's lifted. A run where some
 *  series keep failing is said once to the owner and managers (ops.ts), and once more when they all work again. */
export async function bookSeriesWeeks(db: Db, now = new Date()) {
  if (await isReadOnly(db)) return { booked: 0, missed: 0, ended: 0 };
  const series = await db.selectFrom("booking_series").select("id").where("ended_at", "is", null).where("pay", "=", "card").execute();
  let booked = 0, missed = 0, ended = 0;
  const failed: string[] = [];
  for (const s of series) {
    try {
      const r = (await runAsSystem(db, "booking.repeat_week", { series_id: s.id }, "jobs", { now })).result as { booked?: number; missed?: number; closed?: string } | null;
      booked += r?.booked ?? 0; missed += r?.missed ?? 0; if (r?.closed) ended++;
    } catch (e) {
      // Another runner a moment ahead (error.changed) is that run's, not a failure.
      if (e instanceof KumiError && e.code === "error.changed") continue;
      const why = e instanceof KumiError ? e.code : (e as Error).message;
      console.error(`weekly courts: series ${s.id}:`, why); failed.push(why);
    }
  }
  if (failed.length) await jobFailed(db, "weekly_courts", `${failed.length} weekly court${failed.length === 1 ? "" : "s"} failed: ${failed[0]}`, now, both("ops.why_weekly_courts", { count: failed.length }));
  else if ((await heartbeat(db, "weekly_courts"))?.last_error) await jobWorked(db, "weekly_courts", { series: series.length }, now);
  return { booked, missed, ended };
}

// ---- Ending one: a week and all after it, each under its own rules ----
async function seriesToEnd(db: Db | Trx, seriesId: string, from: string, now: Date) {
  return db.selectFrom("booking").innerJoin("booking_series_week", "booking_series_week.booking_id", "booking.id").innerJoin("court_time", "court_time.booking_id", "booking.id")
    .select(["booking.id", "booking_series_week.on_date"]).distinct().where("booking.series_id", "=", seriesId).where("booking.status", "in", ["held", "confirmed"])
    .where("booking_series_week.on_date", ">=", from).where("court_time.active", "=", true).where(sql<boolean>`lower(court_time.during) > ${now}`).orderBy("booking_series_week.on_date").execute();
}
export const bookingRepeatEnd = defineAction({
  name: "booking.repeat_end", version: 1,
  input: z.object({ series_id: z.uuid(), from_date: z.optional(clubDate), refund: z.optional(z.enum(["rule", "full", "none"])) }),
  async plan(ctx, i) {
    const { row: s, read } = await readRow(ctx.db, "booking_series", i.series_id, "thing.weekly_booking");
    // Choosing what comes back instead of each week's rule is for the club (rule 2), not the member.
    if (i.refund && !(await deskOrUp(ctx.db, ctx.actor.personId))) throw new KumiError("error.refund_choice_staff", {}, 403);
    const court = { name: (await ctx.db.selectFrom("court").select("name").where("id", "=", s.court_id).executeTakeFirstOrThrow()).name, time_zone: await seriesTz(ctx.db, s.location_id) };
    const today = localDate(ctx.now, court.time_zone), from = i.from_date && i.from_date > today ? i.from_date : today;
    const weeks = await seriesToEnd(ctx.db, s.id, from, ctx.now), cancels = [];
    // Over, with nothing booked still to come: there's nothing to end.
    const waiting = await ctx.db.selectFrom("booking_series_week").select("id").where("series_id", "=", s.id).where("booking_id", "is", null).where("missed", "is", null).where("on_date", ">=", from).executeTakeFirst();
    if (!weeks.length && (s.ended_at || !waiting)) throw new KumiError("error.weekly_over");
    for (const w of weeks) { const r = await cancelRefunds(ctx.db, w.id, ctx.now, i.refund ?? "rule"); cancels.push({ booking_id: w.id, refunds: r.refunds.map(({ payment_id, cents }) => ({ payment_id, cents })) }); }
    const back = cancels.reduce((n, c) => n + c.refunds.reduce((m, r) => m + r.cents, 0), 0);
    const start = onDate(s.first_date, s.starts.slice(0, 5), court.time_zone);
    const summary = join([both("plan.booking.repeat_end", { pattern: patternText(court.name, start, court.time_zone, s.minutes), from: dayOf(from), count: weeks.length }),
      back ? both("plan.booking.repeat_end_back", { amount: usd(back) }) : cancels.some((c) => c.refunds.length) ? both("plan.booking.repeat_end_nothing") : { en: "", es: "" }]);
    return { title: both("action.booking.repeat_end"), summary, reads: [read], locationId: s.location_id, ownerIds: await withManagers(ctx.db, [s.organiser_id]), moneyCents: back,
      undo: { kind: back ? "compensating" : "none" }, details: { from, cancels } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { from: string; cancels: { booking_id: string; refunds: { payment_id: string; cents: number }[] }[] };
    const s = await ctx.trx.selectFrom("booking_series").selectAll().where("id", "=", i.series_id).forUpdate().executeTakeFirstOrThrow();
    await lockCourts(ctx, [s.court_id]);
    await cancelWeeksFrom(ctx, s, d.from, d.cancels);
    const last = addDays(d.from, -1), lastDate = last < s.last_date ? last : s.last_date;
    // Ended whenever no week is left to book from today (as the job would end it, but read-only it isn't running).
    const today = localDate(ctx.now, await seriesTz(ctx.trx, s.location_id));
    const waiting = last >= s.first_date && await ctx.trx.selectFrom("booking_series_week").select("id").where("series_id", "=", s.id).where("booking_id", "is", null).where("missed", "is", null)
      .where("on_date", ">=", today).where("on_date", "<=", lastDate).executeTakeFirst();
    await ctx.update("booking_series", s.id, last < s.first_date ? { ended_at: s.ended_at ?? ctx.now } : { last_date: lastDate, ...(!waiting && !s.ended_at ? { ended_at: ctx.now } : {}) });
    await ctx.emit("booking.repeat_ended", { series_id: s.id, from: d.from, by: ctx.actor.personId });
    return null;
  },
});

type WeekCancel = { booking_id: string; refunds: { payment_id: string; cents: number }[] };
/** A series' booked weeks from a date on, cancelled with what the preview said comes back. The weeks as they are now:
 *  one booked since the preview goes too, and anyone who paid after the preview never agreed to its rule, so all of
 *  theirs comes back (as booking.cancel does). The series and its court are locked by the caller. */
async function cancelWeeksFrom(ctx: ApplyCtx, s: { id: string }, from: string, cancels: WeekCancel[]) {
  for (const w of await seriesToEnd(ctx.trx, s.id, from, ctx.now)) {
    const b = await lockBooking(ctx.trx, w.id);
    if (b.status === "cancelled") continue;
    const planned = cancels.find((c) => c.booking_id === w.id)?.refunds ?? [];
    const late = await ctx.trx.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(["payment.id", "payment.amount_cents", backSql.as("back")])
      .where("booking_player.booking_id", "=", w.id).where("booking_player.removed_at", "is", null).where("payment.status", "=", "succeeded")
      .$if(planned.length > 0, (q) => q.where("payment.id", "not in", planned.map((r) => r.payment_id))).execute();
    await cancelBooking(ctx, w.id, [...planned, ...late.map((p) => ({ payment_id: p.id, cents: p.amount_cents - Number(p.back) }))], "series_ended");
  }
}

/** Every weekly court members made in the app, at once (Settings, owners and managers: front desk's 'booking.*'
 *  doesn't reach it). Either no more weeks are booked and the weeks already booked stay, or those weeks go too, each
 *  by its own cancel rule, everything back, or nothing back (as repeat_end lets staff choose). Weekly courts the desk
 *  made aren't members' and stay. Each member hears once, however many weekly courts they had. */
export const weeklyEndAll = defineAction({
  name: "weekly.end_all", version: 1,
  input: z.object({ booked: z.enum(["keep", "cancel"]), refund: z.optional(z.enum(["rule", "full", "none"])) }),
  async plan(ctx, i) {
    const rows = await ctx.db.selectFrom("booking_series").select("id").where("source", "=", "app").where("ended_at", "is", null).orderBy("id").execute();
    if (!rows.length) throw new KumiError("error.weekly_none_running");
    const series = [], reads = [], members = new Set<string>();
    let weeksGoing = 0, back = 0, anyPaid = false;
    for (const { id } of rows) {
      const { row: s, read } = await readRow(ctx.db, "booking_series", id, "thing.weekly_booking");
      reads.push(read); members.add(s.organiser_id);
      const from = localDate(ctx.now, await seriesTz(ctx.db, s.location_id)), cancels: WeekCancel[] = [];
      if (i.booked === "cancel") for (const w of await seriesToEnd(ctx.db, s.id, from, ctx.now)) {
        const r = await cancelRefunds(ctx.db, w.id, ctx.now, i.refund ?? "rule");
        cancels.push({ booking_id: w.id, refunds: r.refunds.map(({ payment_id, cents }) => ({ payment_id, cents }) ) });
        anyPaid ||= r.refunds.length > 0; back += r.refunds.reduce((n, x) => n + x.cents, 0);
      }
      weeksGoing += cancels.length;
      series.push({ id: s.id, court_id: s.court_id, organiser_id: s.organiser_id, from, cancels });
    }
    const summary = join([both("plan.weekly.end_all", { count: rows.length, members: members.size }),
      i.booked === "keep" ? both("plan.weekly.end_all_keep") : both("plan.weekly.end_all_cancel", { count: weeksGoing }),
      back ? both("plan.booking.repeat_end_back", { amount: usd(back) }) : anyPaid ? both("plan.booking.repeat_end_nothing") : { en: "", es: "" }]);
    return { title: both("action.weekly.end_all"), summary, reads, ownerIds: await withManagers(ctx.db, []), moneyCents: back,
      undo: { kind: back ? "compensating" : "none" }, details: { series } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { series: { id: string; court_id: string; organiser_id: string; from: string; cancels: WeekCancel[] }[] };
    // Every series first (in id order), then all their courts at once, then each week: the order repeat_end takes.
    const locked = [];
    for (const x of d.series) locked.push(await ctx.trx.selectFrom("booking_series").selectAll().where("id", "=", x.id).forUpdate().executeTakeFirstOrThrow());
    await lockCourts(ctx, [...new Set(locked.map((s) => s.court_id))]);
    const told = new Map<string, { series: string[]; from: string }>();
    for (const s of locked) {
      if (s.ended_at) continue;   // ended in the meantime: nothing more to do, nor to tell
      const x = d.series.find((y) => y.id === s.id)!;
      if (i.booked === "cancel") await cancelWeeksFrom(ctx, s, x.from, x.cancels);
      await ctx.update("booking_series", s.id, { ended_at: ctx.now });
      const t = told.get(s.organiser_id) ?? { series: [], from: x.from };
      t.series.push(s.id); if (x.from < t.from) t.from = x.from; told.set(s.organiser_id, t);
    }
    for (const [person_id, t] of told) await ctx.emit("weekly.ended_all", { person_id, series_ids: t.series, booked: i.booked, from: t.from });
    return { series: [...told.values()].reduce((n, t) => n + t.series.length, 0), members: told.size };
  },
});

/** A person's series still running, for My places and the staff's page of the person: the pattern, and each week
 *  from today: booked (its booking), left out (and why), or still to be booked. */
/** Every weekly court an account had, ended from today for an account deleted again after a restore (privacy.ts):
 *  its booked weeks cancelled with no money moving (the person was refunded when they ended it, before the restore),
 *  nothing more booked. Each week cancelled, with what was paid on it, for the staff to check. */
export async function endSeriesForErase(ctx: ApplyCtx, personId: string): Promise<Array<{ code: string; paid_cents: number }>> {
  const out: Array<{ code: string; paid_cents: number }> = [];
  const series = await ctx.trx.selectFrom("booking_series").selectAll().where("organiser_id", "=", personId).where("ended_at", "is", null).forUpdate().execute();
  for (const s of series) {
    await lockCourts(ctx, [s.court_id]);
    const from = localDate(ctx.now, await seriesTz(ctx.trx, s.location_id)), cancels: WeekCancel[] = [];
    for (const w of await seriesToEnd(ctx.trx, s.id, from, ctx.now)) {
      cancels.push({ booking_id: w.id, refunds: [] });
      const b = await ctx.trx.selectFrom("booking").select("code").where("id", "=", w.id).executeTakeFirstOrThrow();
      const pays = sql`p.booking_player_id IN (SELECT bp.id FROM booking_player bp WHERE bp.booking_id = ${w.id}) AND p.status = 'succeeded'`;
      const paid = Number((await sql<{ n: string | null }>`SELECT coalesce(sum(p.amount_cents), 0) - coalesce((SELECT sum(r.amount_cents) FROM refund r
        WHERE r.status <> 'failed' AND r.payment_id IN (SELECT p.id FROM payment p WHERE ${pays})), 0) AS n FROM payment p WHERE ${pays}`.execute(ctx.trx)).rows[0]?.n ?? 0);
      out.push({ code: b.code, paid_cents: paid });
    }
    await cancelWeeksFrom(ctx, s, from, cancels);
    await ctx.update("booking_series", s.id, { ended_at: ctx.now });
  }
  return out;
}

export async function seriesOf(db: Db | Trx, personId: string, now: Date) {
  const rows = await db.selectFrom("booking_series").innerJoin("court", "court.id", "booking_series.court_id").innerJoin("location", "location.id", "booking_series.location_id")
    .select(["booking_series.id", "booking_series.court_id", "court.name as court", "booking_series.starts", "booking_series.minutes", "booking_series.first_date", "booking_series.last_date",
      "booking_series.pay", "booking_series.source", "location.time_zone"])
    .where("booking_series.organiser_id", "=", personId).orderBy("booking_series.first_date").execute();
  const out = [];
  for (const s of rows) {
    const today = localDate(now, s.time_zone);
    const weeks = await db.selectFrom("booking_series_week").leftJoin("booking", "booking.id", "booking_series_week.booking_id")
      .select(["booking_series_week.on_date", "booking_series_week.missed", "booking_series_week.price_cents", "booking.id as booking_id", "booking.code", "booking.status", "booking.settled_at", "booking.balance_cents"])
      .where("booking_series_week.series_id", "=", s.id).where("booking_series_week.on_date", ">=", today).where("booking_series_week.on_date", "<=", s.last_date).orderBy("booking_series_week.on_date").execute();
    // A series ended or done shows only while it has a week still booked (or still to be booked) to come.
    if (!weeks.some((w) => (w.booking_id && w.status !== "cancelled") || (!w.booking_id && !w.missed))) continue;
    out.push({ id: s.id, court: s.court, starts: s.starts.slice(0, 5), minutes: s.minutes, pay: s.pay, source: s.source, time_zone: s.time_zone, last_date: s.last_date,
      weeks: weeks.map((w) => ({ date: w.on_date, starts_at: onDate(w.on_date, s.starts.slice(0, 5), s.time_zone).toISOString(), price_cents: w.price_cents,
        state: w.booking_id ? (w.status === "cancelled" ? "cancelled" : (w.balance_cents ?? 0) > 0 ? "owed" : "booked") : w.missed ? "missed" : "waiting", missed: w.missed, booking_id: w.booking_id, code: w.code,
        charged: Boolean(w.settled_at) && !w.balance_cents })) });
  }
  return out;
}
