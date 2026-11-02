// Members book and pay for courts. A booking holds its court for a few minutes while the organiser pays.
// Two ways to pay: the whole court, or only their part, when each player pays their own share in the app
// and the organiser's card is saved (never held); whatever is unpaid at the club's deadline is charged to
// that card once. An open match is the exception: not full by the deadline, it's cancelled and everyone
// gets their money back (nothing is saved or charged). The club's booking rules (how far ahead, how many
// at once, the lengths, cancellation) are the version in force when the booking is made, and stay with it.
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, money, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type ApplyCtx, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { account, paymentProvider, post } from "./money.ts";
import { occupied, openingOn } from "./bookings.ts";
import { currentPolicy, quote } from "./prices.ts";
import { memberPlan } from "./memberships.ts";
import { band, joinRule, levelOf, openMatchOf } from "./match_rules.ts";
import { notJunior, requireWaiver, withManagers } from "./households.ts";

/** How long a court is held while the organiser pays. */
export const HOLD_MINUTES = 10;
const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const when = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const levelInput = z.number().check(z.minimum(0.5), z.maximum(7));
const code4 = () => Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("");

/** Each player's share; the organiser takes the odd cents. */
export function shares(total: number, players: number): { organiser: number; each: number } {
  const each = Math.floor(total / players);
  return { organiser: total - each * (players - 1), each };
}

/** How far ahead a person can book: the club's rule, or their membership's when it's longer. */
export async function daysAhead(db: Db | Trx, personId: string, now = new Date()): Promise<number> {
  const policy = await currentPolicy(db), member = await memberPlan(db, personId, now);
  return Math.max(policy.days_ahead, member?.days_ahead ?? 0);
}

export async function courtAndPlace(db: Db | Trx, courtId: string) {
  const c = await db.selectFrom("court").innerJoin("location", "location.id", "court.location_id")
    .select(["court.id", "court.name", "court.location_id", "court.bookable", "court.archived_at", "location.time_zone"]).where("court.id", "=", courtId).executeTakeFirst();
  if (!c || c.archived_at) throw new KumiError("error.not_found", { thing: both("thing.court") }, 404);
  return c;
}

/** The checks every court booking passes: a length the club offers, a bookable court, in the future, inside
 *  the person's booking window and the opening hours, and free. A lesson's length is the coach's to offer. */
export async function checkSlot(ctx: PlanCtx, policy: Awaited<ReturnType<typeof currentPolicy>>, s: { court_id: string; starts_at: string; minutes: number }, personId: string, o: { anyLength?: boolean } = {}) {
  const court = await courtAndPlace(ctx.db, s.court_id), start = new Date(s.starts_at), end = new Date(start.getTime() + s.minutes * 60_000);
  if (!o.anyLength && !policy.lengths.includes(s.minutes)) throw new KumiError("error.length_not_offered", { lengths: policy.lengths.join(", ") });
  if (!court.bookable) throw new KumiError("error.court_not_bookable", { court: court.name });
  if (start <= ctx.now) throw new KumiError("error.in_the_past");
  const ahead = await daysAhead(ctx.db, personId, ctx.now);
  if (start.getTime() > ctx.now.getTime() + ahead * 86400_000) throw new KumiError("error.too_far_ahead", { count: ahead });
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: court.time_zone }).format(start), open = await openingOn(ctx.db, court.location_id, day);
  if (!open || start < open.opens || end > open.closes) throw new KumiError("error.closed_then", { court: court.name, when: when(start, court.time_zone) });
  if ((await occupied(ctx.db, [s.court_id], start, end, ctx.now)).length) throw new KumiError("error.court_taken");
  return { court, start, end, day };
}
/** How many court bookings a person has coming up (or being paid for), against the club's limit. Lessons
 *  don't count: the limit shares out courts members book for themselves. */
async function upcomingCount(db: Db | Trx, personId: string, now: Date): Promise<number> {
  const r = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").select((eb) => eb.fn.count<string>("booking.id").distinct().as("n"))
    .where("booking.organiser_id", "=", personId).where("booking.kind", "=", "court").where("booking.status", "in", ["held", "confirmed"]).where("court_time.active", "=", true).where(sql<boolean>`upper(court_time.during) > ${now}`).executeTakeFirstOrThrow();
  return Number(r.n);
}
/** A booking code no booking has yet: the club's initials and four letters ("KP-7QX2"). */
export async function newCode(trx: Trx): Promise<string> {
  const club = await trx.selectFrom("club").select("name").executeTakeFirstOrThrow();
  const prefix = club.name.split(/\s+/).map((w) => w[0]).join("").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase().padEnd(2, "K");
  let code = `${prefix}-${code4()}`;
  while (await trx.selectFrom("booking").select("id").where("code", "=", code).executeTakeFirst()) code = `${prefix}-${code4()}`;
  return code;
}

export const bookingRequest = defineAction({
  name: "booking.request", version: 1,
  input: z.object({ court_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }), minutes: z.number().check(z.int()), pay: z.enum(["whole", "split"]),
    players: z.optional(z.number().check(z.int(), z.minimum(2), z.maximum(8))), person_id: z.uuid(),
    // An open match: other players can find it and join, inside the level band (or ask the host).
    open: z.optional(z.object({ level_min: levelInput, level_max: levelInput, outside_band: z.optional(z.enum(["ask", "closed"])), rated: z.optional(z.boolean()),
      listed: z.optional(z.boolean()), note: z.optional(z.string().check(z.maxLength(200))) })) }),
  async plan(ctx, i) {
    const club = await ctx.db.selectFrom("club").select(["court_bookings"]).executeTakeFirstOrThrow();
    if (!club.court_bookings) throw new KumiError("error.bookings_off");
    if (i.open && (i.pay !== "split" || (i.players ?? 4) !== 4)) throw new KumiError("error.open_match_split");
    if (i.open && i.open.level_max < i.open.level_min) throw new KumiError("error.bad_band");
    await notJunior(ctx.db, i.person_id);
    await requireWaiver(ctx, i.person_id);
    const policy = await currentPolicy(ctx.db), { court, start } = await checkSlot(ctx, policy, i, i.person_id);
    if (await upcomingCount(ctx.db, i.person_id, ctx.now) >= policy.max_active) throw new KumiError("error.too_many_bookings", { count: policy.max_active });
    const q = await quote(ctx.db, { courtId: i.court_id, start, minutes: i.minutes, personId: i.person_id, at: ctx.now });
    if (!q.priced) throw new KumiError("error.no_price");
    // Past the "pay my part" deadline, only an open match can still be shared: a same-day match, where each
    // player pays when they join, with its own cutoff (not full by then, it's cancelled and everyone paid back).
    const ahead = start.getTime() - ctx.now.getTime(), sameDay = Boolean(i.open) && ahead <= policy.split_deadline_hours * 3600_000;
    if (sameDay && ahead <= policy.same_day_cutoff_hours * 3600_000) throw new KumiError("error.too_late_for_match", { count: policy.same_day_cutoff_hours });
    if (i.pay === "split" && !sameDay && ahead <= policy.split_deadline_hours * 3600_000) throw new KumiError("error.too_late_to_split", { count: policy.split_deadline_hours });
    const cutoffAt = sameDay ? new Date(start.getTime() - policy.same_day_cutoff_hours * 3600_000) : null;
    const players = i.players ?? 4, s = shares(q.total_cents, players);
    const p = { court: court.name, when: when(start, court.time_zone), minutes: i.minutes, total: usd(q.total_cents) };
    const hours = both("count.hours", { count: sameDay ? policy.same_day_cutoff_hours : policy.split_deadline_hours });
    const summary = i.pay === "whole" ? both("plan.booking.request_whole", p)
      : both(i.open ? "plan.booking.request_open" : "plan.booking.request_split", { ...p, share: usd(s.organiser), players: both("count.players", { count: players }), others: usd(s.each), hours });
    const band_ = i.open ? both(i.open.rated === false ? "plan.booking.open_friendly" : "plan.booking.open_rated", { band: band(i.open), hours,
      outside: both(i.open.outside_band === "closed" ? "plan.booking.outside_closed" : "plan.booking.outside_ask") }) : null;
    const openText = band_ && sameDay ? (() => { const n = both("plan.booking.same_day_note"); return { en: `${band_.en} ${n.en}`, es: `${band_.es} ${n.es}` }; })() : band_;
    return { title: both("action.booking.request"), reads: [], locationId: court.location_id, ownerIds: [i.person_id], undo: { kind: "compensating" },
      moneyCents: i.pay === "whole" ? q.total_cents : s.organiser, details: { quote: q, policy_id: policy.id, cutoff_at: cutoffAt?.toISOString() ?? null },
      summary: openText ? { en: `${summary.en} ${openText.en}`, es: `${summary.es} ${openText.es}` } : summary };
  },
  async apply(ctx, i, plan) {
    const { quote: q, policy_id, cutoff_at } = plan.details as { quote: Awaited<ReturnType<typeof quote>>; policy_id: string; cutoff_at: string | null };
    const start = new Date(i.starts_at), end = new Date(start.getTime() + i.minutes * 60_000);
    for (const id of [i.court_id]) await ctx.trx.selectFrom("court").select("id").where("id", "=", id).forUpdate().execute();
    await ctx.trx.updateTable("court_time").set({ active: false }).where("court_id", "=", i.court_id).where("kind", "=", "hold").where("active", "=", true).where("hold_until", "<=", ctx.now).execute();
    const court = await courtAndPlace(ctx.trx, i.court_id), code = await newCode(ctx.trx);
    const id = uuidv7(), players = i.players ?? 4, s = shares(q.total_cents, players);
    await ctx.insert("booking", { id, code, location_id: court.location_id, organiser_id: i.person_id, status: "held", source: "app", price_cents: q.total_cents, tax_cents: q.tax_cents,
      quote: JSON.stringify(q), policy_id, pay_mode: i.pay, players, invite_code: randomBytes(9).toString("base64url") });   // whole court: the players link (booking_players.ts)
    if (i.open) await ctx.insert("open_match", { booking_id: id, level_min: i.open.level_min.toFixed(2), level_max: i.open.level_max.toFixed(2), outside_band: i.open.outside_band ?? "ask",
      rated: i.open.rated ?? true, listed: i.open.listed ?? true, note: i.open.note ?? null, cutoff_at: cutoff_at ? new Date(cutoff_at) : null });
    const bp = uuidv7();
    await ctx.insert("booking_player", { id: bp, booking_id: id, person_id: i.person_id, share_cents: i.pay === "whole" ? q.total_cents : s.organiser });
    try {
      await ctx.insert("court_time", { id: uuidv7(), court_id: i.court_id, during: sql`tstzrange(${start}, ${end})`, kind: "hold", booking_id: id, hold_until: new Date(ctx.now.getTime() + HOLD_MINUTES * 60_000) });
    } catch (e: any) { if (e?.code === "23P01") throw new KumiError("error.court_taken"); throw e; }
    const payment = uuidv7();
    await ctx.insert("payment", { id: payment, person_id: i.person_id, amount_cents: i.pay === "whole" ? q.total_cents : s.organiser, method: "card", provider: paymentProvider().name,
      provider_ref: null, status: "pending", booking_player_id: bp, save_card: i.pay === "split" && !i.open });   // an open match never charges the host for empty places
    await ctx.emit("booking.requested", { booking_id: id });
    return { booking_id: id, code, payment_id: payment };
  },
});

// ---- Several courts in one checkout ----
// Each court is its own booking (its own code, court time, and cancellation under its own rule), with its
// own payment for its own price, so cancelling, refunds and reports treat it like any booking. The
// payments share a group: the card form opens one provider payment for their total, and when it settles,
// every payment in the group settles with it, in one change (payment.settle). A court's refund is then a
// partial refund of that one card payment.
const slotInput = z.object({ court_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }), minutes: z.number().check(z.int()) });
export const bookingRequestCourts = defineAction({
  name: "booking.request_courts", version: 1,
  input: z.object({ courts: z.array(slotInput).check(z.minLength(2), z.maxLength(8)), person_id: z.uuid() }),
  async plan(ctx, i) {
    const club = await ctx.db.selectFrom("club").select(["court_bookings"]).executeTakeFirstOrThrow();
    if (!club.court_bookings) throw new KumiError("error.bookings_off");
    await notJunior(ctx.db, i.person_id);
    await requireWaiver(ctx, i.person_id);
    const policy = await currentPolicy(ctx.db), slots = [];
    for (const s of i.courts) slots.push({ ...s, ...(await checkSlot(ctx, policy, s, i.person_id)) });
    if (new Set(slots.map((s) => s.day)).size > 1) throw new KumiError("error.courts_same_day");
    for (const [k, a] of slots.entries()) for (const b of slots.slice(k + 1))
      if (a.court_id === b.court_id && a.start < b.end && b.start < a.end) throw new KumiError("error.court_taken");   // the same court twice at once
    const upcoming = await upcomingCount(ctx.db, i.person_id, ctx.now);
    if (upcoming + slots.length > policy.max_active) throw new KumiError("error.too_many_courts", { count: policy.max_active, have: upcoming });
    const priced = [];
    for (const s of slots) {
      const q = await quote(ctx.db, { courtId: s.court_id, start: s.start, minutes: s.minutes, personId: i.person_id, at: ctx.now });
      if (!q.priced) throw new KumiError("error.no_price");
      priced.push({ ...s, q });
    }
    const total = priced.reduce((n, s) => n + s.q.total_cents, 0);
    const items = priced.map((s) => both("plan.booking.court_item", { court: s.court.name, when: when(s.start, s.court.time_zone), minutes: s.minutes, price: usd(s.q.total_cents) }));
    return { title: both("action.booking.request_courts"), reads: [], locationId: priced[0]!.court.location_id, ownerIds: [i.person_id], undo: { kind: "compensating" }, moneyCents: total,
      summary: both("plan.booking.request_courts", { count: priced.length, list: { en: items.map((x) => x.en).join("; "), es: items.map((x) => x.es).join("; ") }, total: usd(total) }),
      details: { policy_id: policy.id, quotes: priced.map((s) => s.q) } };
  },
  async apply(ctx, i, plan) {
    const { quotes, policy_id } = plan.details as { quotes: Awaited<ReturnType<typeof quote>>[]; policy_id: string };
    // Lock the courts in id order (spikes/booking_race.md), clear holds that ran out, then hold them all, or none.
    for (const id of [...new Set(i.courts.map((s) => s.court_id))].sort()) await ctx.trx.selectFrom("court").select("id").where("id", "=", id).forUpdate().execute();
    await ctx.trx.updateTable("court_time").set({ active: false }).where("court_id", "in", i.courts.map((s) => s.court_id)).where("kind", "=", "hold").where("active", "=", true).where("hold_until", "<=", ctx.now).execute();
    const group = uuidv7(), out: { booking_id: string; code: string; payment_id: string }[] = [];
    for (const [k, s] of i.courts.entries()) {
      const court = await courtAndPlace(ctx.trx, s.court_id), q = quotes[k]!, start = new Date(s.starts_at), end = new Date(start.getTime() + s.minutes * 60_000);
      const id = uuidv7(), code = await newCode(ctx.trx), bp = uuidv7(), payment = uuidv7();
      await ctx.insert("booking", { id, code, location_id: court.location_id, organiser_id: i.person_id, status: "held", source: "app", price_cents: q.total_cents, tax_cents: q.tax_cents,
        quote: JSON.stringify(q), policy_id, pay_mode: "whole", players: 4, invite_code: randomBytes(9).toString("base64url") });
      await ctx.insert("booking_player", { id: bp, booking_id: id, person_id: i.person_id, share_cents: q.total_cents });
      try {
        await ctx.insert("court_time", { id: uuidv7(), court_id: s.court_id, during: sql`tstzrange(${start}, ${end})`, kind: "hold", booking_id: id, hold_until: new Date(ctx.now.getTime() + HOLD_MINUTES * 60_000) });
      } catch (e: any) { if (e?.code === "23P01") throw new KumiError("error.court_taken"); throw e; }
      await ctx.insert("payment", { id: payment, person_id: i.person_id, amount_cents: q.total_cents, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", booking_player_id: bp, group_id: group });
      await ctx.emit("booking.requested", { booking_id: id });
      out.push({ booking_id: id, code, payment_id: payment });
    }
    // The member pays the first; its card form covers them all.
    return { bookings: out, payment_id: out[0]!.payment_id, total_cents: quotes.reduce((n, q) => n + q.total_cents, 0) };
  },
});

export const bookingJoin = defineAction({
  name: "booking.join", version: 1,
  // From its link, or (an open match) from the Play page.
  input: z.object({ invite_code: z.optional(z.string().check(z.minLength(8))), booking_id: z.optional(z.uuid()), person_id: z.uuid() }),
  async plan(ctx, i) {
    const b = await ctx.db.selectFrom("booking").selectAll().$if(Boolean(i.invite_code), (q) => q.where("invite_code", "=", i.invite_code!))
      .$if(!i.invite_code, (q) => q.where("id", "=", i.booking_id ?? "00000000-0000-0000-0000-000000000000")).executeTakeFirst();
    if (!b || b.status !== "confirmed" || b.pay_mode !== "split") throw new KumiError("error.invite_closed");
    // After the deadline only a place staff opened again can be joined.
    if (b.settled_at && !(await reopenedPlace(ctx.db, b.id))) throw new KumiError("error.invite_settled");
    await notJunior(ctx.db, i.person_id);
    await requireWaiver(ctx, i.person_id);
    const players = await ctx.db.selectFrom("booking_player").select(["person_id", "leaving_at"]).where("booking_id", "=", b.id).where("removed_at", "is", null).where("replaces", "is", null).execute();
    if (players.some((p) => p.person_id === i.person_id)) throw new KumiError("error.already_in_booking");
    // A place someone can't make counts as free: whoever takes it pays, and they get their money back.
    if (players.filter((p) => !p.leaving_at).length >= b.players) throw new KumiError("error.booking_full");
    // An open match: only from inside its level band (outside it, players ask the host). Not by id otherwise.
    const om = await openMatchOf(ctx.db, b.id);
    if (!om && !i.invite_code) throw new KumiError("error.invite_closed");
    if (om) {
      const level = await levelOf(ctx.db, i.person_id), rule = joinRule(om, level);
      const lv = level === null ? both("plan.booking.no_level") : level.toFixed(2);
      if (rule === "ask") throw new KumiError("error.outside_band_ask", { level: lv, band: band(om) });
      if (rule === "closed") throw new KumiError("error.outside_band", { level: lv, band: band(om) });
    }
    const t = await ctx.db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id")
      .select(["court.name", "location.time_zone", sql<Date>`lower(during)`.as("start")]).where("court_time.booking_id", "=", b.id).where("court_time.active", "=", true).executeTakeFirstOrThrow();
    const organiser = b.organiser_id ? (await readRow(ctx.db, "person", b.organiser_id, "thing.person")).row.display_name : "";
    const coach = b.coach_id ? (await readRow(ctx.db, "person", b.coach_id, "thing.person")).row.display_name : "";
    const s = shares(b.price_cents, b.players);
    return { title: both("action.booking.join"), summary: both(om ? "plan.booking.join_match" : b.kind === "lesson" ? "plan.lesson.join" : "plan.booking.join", { organiser, coach, court: t.name, when: when(new Date(t.start), t.time_zone), share: usd(s.each) }),
      reads: [], locationId: b.location_id, ownerIds: [i.person_id], moneyCents: s.each, undo: { kind: "compensating" }, details: { booking_id: b.id, share: s.each } };
  },
  async apply(ctx, i, plan) {
    const { booking_id, share } = plan.details as { booking_id: string; share: number };
    await ctx.trx.selectFrom("booking").select("id").where("id", "=", booking_id).forUpdate().execute();   // one joiner at a time
    const n = await ctx.trx.selectFrom("booking_player").select((eb) => eb.fn.countAll<string>().as("n")).where("booking_id", "=", booking_id).where("removed_at", "is", null).where("leaving_at", "is", null)
      .where("replaces", "is", null).executeTakeFirstOrThrow();
    const b = await ctx.trx.selectFrom("booking").select(["players", "settled_at", "status"]).where("id", "=", booking_id).executeTakeFirstOrThrow();
    if (Number(n.n) >= b.players || (b.settled_at && !(await reopenedPlace(ctx.trx, booking_id))) || b.status !== "confirmed") throw new KumiError("error.changed");
    const bp = uuidv7(), payment = uuidv7();
    // The seat is theirs while they pay; unpaid, it opens again (releaseSeats).
    await ctx.insert("booking_player", { id: bp, booking_id, person_id: i.person_id, share_cents: share, held_until: new Date(ctx.now.getTime() + HOLD_MINUTES * 60_000) });
    await ctx.insert("payment", { id: payment, person_id: i.person_id, amount_cents: share, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", booking_player_id: bp });
    await ctx.emit("booking.joined", { booking_id, booking_player_id: bp });
    return { booking_id, payment_id: payment };
  },
});

/** Refund a payment to its card (the outbox sends it). */
export async function refundPayment(ctx: ApplyCtx, paymentId: string, cents: number) {
  if (cents <= 0) return;
  const id = uuidv7();
  await ctx.insert("refund", { id, payment_id: paymentId, enrolment_id: null, amount_cents: cents, destination: "card", status: "pending" });
  await ctx.emit("refund.requested", { refund_id: id });
}

/** The booking's own rules: the version in force when it was made. */
export async function policyOf(db: Db | Trx, bookingId: string) {
  const b = await db.selectFrom("booking").select("policy_id").where("id", "=", bookingId).executeTakeFirstOrThrow();
  return b.policy_id ? db.selectFrom("booking_policy").selectAll().where("id", "=", b.policy_id).executeTakeFirstOrThrow() : currentPolicy(db);
}

/** A booking's deadline in SQL: a same-day open match's own cutoff, otherwise the club's deadline before the start
 *  (needs booking_policy, court_time and a left join of open_match). */
export const deadlineSql = sql<Date>`coalesce(open_match.cutoff_at, lower(court_time.during) - make_interval(hours => booking_policy.split_deadline_hours))`;

/** Whether the club's deadline for this booking has passed (after it, nobody new can take a place, unless staff open one). */
export async function pastDeadline(db: Db | Trx, bookingId: string, now: Date) {
  const r = await db.selectFrom("booking").innerJoin("booking_policy", "booking_policy.id", "booking.policy_id").innerJoin("court_time", "court_time.booking_id", "booking.id")
    .leftJoin("open_match", "open_match.booking_id", "booking.id")
    .select(sql<boolean>`booking.settled_at IS NOT NULL OR ${deadlineSql} <= ${now}`.as("past"))
    .where("booking.id", "=", bookingId).where("court_time.active", "=", true).executeTakeFirst();
  return Boolean(r?.past);
}

/** A late leaver's place staff opened in the app, if there is one. */
export async function reopenedPlace(db: Db | Trx, bookingId: string) {
  return (await db.selectFrom("booking_player").select(["id", "fill_refund_percent"]).where("booking_id", "=", bookingId).where("removed_at", "is", null)
    .where("leaving_at", "is not", null).where("fill_refund_percent", "is not", null).orderBy("leaving_at").executeTakeFirst()) ?? null;
}

/** What a player paid for a place, and how much of it has come back already. */
export async function paidAndBack(db: Db | Trx, seatId: string) {
  const pays = await db.selectFrom("payment").select(["id", "amount_cents"]).select((eb) => eb.selectFrom("refund").select(sql<string>`coalesce(sum(refund.amount_cents), 0)`.as("c"))
    .whereRef("refund.payment_id", "=", "payment.id").where("refund.status", "!=", "failed").as("back"))
    .where("booking_player_id", "=", seatId).where("status", "=", "succeeded").execute();
  return { pays: pays.map((p) => ({ id: p.id, amount: p.amount_cents, back: Number(p.back ?? 0) })), paid: pays.reduce((n, p) => n + p.amount_cents, 0), back: pays.reduce((n, p) => n + Number(p.back ?? 0), 0) };
}
/** The cents that `percent` of a player's payment comes to, in all, and what would still go back to reach it. */
export async function refundTarget(db: Db | Trx, seatId: string, percent: number) {
  const m = await paidAndBack(db, seatId), total = Math.round(m.paid * percent / 100);
  return { total: Math.max(total, m.back), more: Math.max(0, total - m.back), paid: m.paid };
}
/** Bring what a player has had back up to `percent` of what they paid (nothing already back is taken again). */
export async function refundUpTo(ctx: ApplyCtx, seatId: string, percent: number): Promise<number> {
  const m = await paidAndBack(ctx.trx, seatId);
  let more = Math.max(0, Math.round(m.paid * percent / 100) - m.back);
  const sent = more;
  for (const p of m.pays) {
    const cents = Math.min(more, p.amount - p.back);
    if (cents > 0) { await refundPayment(ctx, p.id, cents); more -= cents; }
  }
  return sent - more;
}

/** When a new player's payment goes through and the match was full only because someone can't make it: the
 *  oldest such place (one staff opened, first) is theirs now, and its player gets back what the club's rule
 *  for a place it fills gives (or what staff chose when they opened it). */
async function takeOverLeavingPlace(ctx: ApplyCtx, bookingId: string, newPlayer: string) {
  const b = await ctx.trx.selectFrom("booking").select("players").where("id", "=", bookingId).executeTakeFirstOrThrow();
  const seats = await ctx.trx.selectFrom("booking_player").select(["id", "leaving_at", "fill_refund_percent"]).where("booking_id", "=", bookingId).where("removed_at", "is", null)
    .where("replaces", "is", null).orderBy(sql`fill_refund_percent IS NULL`).orderBy("leaving_at").execute();
  const leaving = seats.filter((s) => s.leaving_at);
  if (!leaving.length || seats.length <= b.players) return;
  const out = leaving[0]!, policy = await policyOf(ctx.trx, bookingId);
  await ctx.update("booking_player", out.id, { removed_at: ctx.now });
  const refunded = await refundUpTo(ctx, out.id, out.fill_refund_percent ?? policy.late_filled_refund_percent);
  await ctx.emit("booking.place_taken", { booking_player_id: out.id, by: newPlayer, refunded });
}

/** A sub's payment went through: the place they were offered is theirs, and its player is paid back (all of
 *  it before the deadline; after it, the club's rule for a player's own sub). False if the offer is gone. */
async function takeOverOfferedPlace(ctx: ApplyCtx, subSeat: string, placeId: string): Promise<boolean> {
  const offer = await ctx.trx.selectFrom("place_offer").selectAll().where("booking_player_id", "=", placeId).where("status", "=", "offered").forUpdate().executeTakeFirst();
  const place = await ctx.trx.selectFrom("booking_player").selectAll().where("id", "=", placeId).executeTakeFirstOrThrow();
  if (!offer || place.removed_at) return false;
  await ctx.update("booking_player", subSeat, { held_until: null, replaces: null });
  await ctx.update("booking_player", placeId, { removed_at: ctx.now });
  await ctx.update("place_offer", offer.id, { status: "taken", taken_by: subSeat, decided_at: ctx.now });
  const late = await pastDeadline(ctx.trx, place.booking_id, ctx.now), policy = await policyOf(ctx.trx, place.booking_id);
  const refunded = await refundUpTo(ctx, placeId, late ? policy.late_sub_refund_percent : 100);
  await ctx.emit("booking.place_handed", { from_seat: placeId, to_seat: subSeat, refunded });
  return true;
}

/** After a booking payment succeeds (called by payment.settle). The organiser's payment confirms the booking
 *  and turns its hold into the booking's court time; if the hold ran out and the court went to someone else,
 *  the booking is cancelled and the payment refunded in full. Quiet: one court of several paid together, whose
 *  confirmation is one message for them all (the caller sends it); a court lost still says so on its own. */
export async function afterBookingPayment(ctx: ApplyCtx, pay: { id: string; amount_cents: number; booking_player_id: string | null }, o: { quiet?: boolean } = {}): Promise<"confirmed" | "lost" | null> {
  const bp = await ctx.trx.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id")
    .select(["booking.id", "booking.status", "booking.organiser_id", "booking_player.person_id", "booking_player.removed_at", "booking_player.held_until", "booking_player.replaces"])
    .where("booking_player.id", "=", pay.booking_player_id!).executeTakeFirstOrThrow();
  if (bp.status === "cancelled") { await refundPayment(ctx, pay.id, pay.amount_cents); return null; }
  if (bp.person_id !== bp.organiser_id) {
    // A player's place: paid after it was let go (too late), all of it back; otherwise it's theirs now.
    if (bp.removed_at) { await refundPayment(ctx, pay.id, pay.amount_cents); return null; }
    // A sub taking over someone's place: theirs now, unless the offer was taken back meanwhile.
    if (bp.replaces) {
      if (!(await takeOverOfferedPlace(ctx, pay.booking_player_id!, bp.replaces))) {
        await ctx.update("booking_player", pay.booking_player_id!, { removed_at: ctx.now });
        await refundPayment(ctx, pay.id, pay.amount_cents);
      }
      return null;
    }
    if (bp.held_until) await ctx.update("booking_player", pay.booking_player_id!, { held_until: null });
    await takeOverLeavingPlace(ctx, bp.id, bp.person_id!);
    // How many places are left now, for the host's message (it's written a moment later).
    const seated = await ctx.trx.selectFrom("booking_player").select(sql<string>`count(*)`.as("n")).where("booking_id", "=", bp.id).where("removed_at", "is", null).where("leaving_at", "is", null)
      .where("replaces", "is", null).executeTakeFirstOrThrow();
    const size = await ctx.trx.selectFrom("booking").select("players").where("id", "=", bp.id).executeTakeFirstOrThrow();
    await ctx.emit("booking.player_paid", { booking_id: bp.id, booking_player_id: pay.booking_player_id, left: Math.max(0, size.players - Number(seated.n)) });
    return null;
  }
  if (bp.status !== "held") return null;
  for (const t of await ctx.trx.selectFrom("court_time").select(["id", "court_id", "active"]).where("booking_id", "=", bp.id).execute()) {
    await ctx.trx.selectFrom("court").select("id").where("id", "=", t.court_id).forUpdate().execute();
    // A savepoint, so a court that's gone can be answered with a refund rather than failing the payment.
    await sql`SAVEPOINT keep_court`.execute(ctx.trx);
    try {
      await ctx.update("court_time", t.id, { kind: "booking", hold_until: null, active: true });
      await sql`RELEASE SAVEPOINT keep_court`.execute(ctx.trx);
    } catch (e: any) {
      if (e?.code !== "23P01") throw e;
      await sql`ROLLBACK TO SAVEPOINT keep_court`.execute(ctx.trx);
      await ctx.update("booking", bp.id, { status: "cancelled", cancelled_at: ctx.now, cancel_reason: "hold_lost" });
      await refundPayment(ctx, pay.id, pay.amount_cents);
      await ctx.emit("booking.lost", { booking_id: bp.id });
      return "lost";
    }
  }
  await ctx.update("booking", bp.id, { status: "confirmed" });
  if (!o.quiet) await ctx.emit("booking.confirmed", { booking_id: bp.id });
  return "confirmed";
}

// ---- Cancelling: what comes back is the booking's own rules (rule 2: staff can choose otherwise) ----
/** What each payment gets back. In an open match, under the rule, the players who joined get everything
 *  back whatever the timing (the host called it off, not them); the late rule is for the host's own payment. */
export async function cancelRefunds(db: Db | Trx, bookingId: string, now: Date, choice: "rule" | "full" | "none") {
  const b = await db.selectFrom("booking").select(["id", "policy_id", "organiser_id"]).where("id", "=", bookingId).executeTakeFirstOrThrow();
  const start = await db.selectFrom("court_time").select(sql<Date>`min(lower(during))`.as("s")).where("booking_id", "=", bookingId).executeTakeFirst();
  const policy = b.policy_id ? await db.selectFrom("booking_policy").selectAll().where("id", "=", b.policy_id).executeTakeFirstOrThrow() : await currentPolicy(db);
  // A place let go was already paid back (or never paid): only the players still in it.
  const paid = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .select(["payment.id", "payment.amount_cents", "booking_player.person_id"]).where("booking_player.booking_id", "=", bookingId).where("booking_player.removed_at", "is", null)
    .where("payment.status", "=", "succeeded").execute();
  const early = start?.s ? new Date(start.s).getTime() - now.getTime() >= policy.free_cancel_hours * 3600_000 : true;
  const percent = choice === "full" ? 100 : choice === "none" ? 0 : early ? 100 : policy.late_refund_percent;
  const open = choice === "rule" && Boolean(await openMatchOf(db, bookingId));
  const refunds = paid.map((p) => {
    const joiner = open && p.person_id !== b.organiser_id;
    return { payment_id: p.id, cents: Math.round(p.amount_cents * (joiner ? 100 : percent) / 100), joiner };
  });
  return { percent, early, hours: policy.free_cancel_hours, refunds };
}
export const bookingCancel = defineAction({
  name: "booking.cancel", version: 1,
  input: z.object({ booking_id: z.uuid(), reason: z.optional(z.string().check(z.maxLength(200))), refund: z.optional(z.enum(["rule", "full", "none"])) }),
  async plan(ctx, i) {
    const { row: b, read } = await readRow(ctx.db, "booking", i.booking_id, "thing.booking");
    if (b.status === "cancelled") throw new KumiError("error.already_cancelled");
    // Choosing what comes back instead of the rule is for the club (rule 2), not the player cancelling.
    if (i.refund && !(await deskOrUp(ctx.db, ctx.actor.personId))) throw new KumiError("error.refund_choice_staff", {}, 403);
    // A lesson the coach or the club calls off: the players get everything back. The coach can't choose less.
    // A junior's lesson is the junior's booking: their parents cancel it as its organiser would.
    const lesson = b.kind === "lesson", byCoach = lesson && ctx.actor.personId === b.coach_id, organisers = await withManagers(ctx.db, [b.organiser_id]);
    const choice = byCoach ? "full" : i.refund ?? (lesson && !organisers.includes(ctx.actor.personId ?? "") ? "full" : "rule");
    const r = await cancelRefunds(ctx.db, b.id, ctx.now, choice), total = r.refunds.reduce((n, x) => n + x.cents, 0);
    const joiners = r.refunds.filter((x) => x.joiner).reduce((n, x) => n + x.cents, 0), host = total - joiners, hours = both("count.hours", { count: r.hours });
    const money = !r.refunds.length ? both("refund.nothing_paid")
      : joiners ? both(host ? "plan.booking.refund_open" : "plan.booking.no_refund_open", { host: usd(host), others: usd(joiners), hours })
      : total ? both("plan.booking.refund", { amount: usd(total) }) : both("plan.booking.no_refund", { hours });
    return { title: both("action.booking.cancel"), summary: both(lesson ? "plan.lesson.cancel_refund" : "plan.booking.cancel_refund", { code: b.code, refund: money }), reads: [read], locationId: b.location_id,
      ownerIds: [...organisers, lesson ? b.coach_id : null].filter((x): x is string => Boolean(x)), moneyCents: total, undo: { kind: r.refunds.length ? "compensating" : "reversible" }, details: { refunds: r.refunds } };
  },
  async apply(ctx, i, plan) {
    await cancelBooking(ctx, i.booking_id, (plan.details as { refunds: { payment_id: string; cents: number }[] }).refunds, i.reason ?? null);
    return null;
  },
});
/** Call a booking off: its court time is free, the refunds chosen in the plan go back, shares not paid yet can't
 *  be paid any more, and its players are told. Also for a repeating block that cancels bookings in its way. */
export async function cancelBooking(ctx: ApplyCtx, bookingId: string, refunds: { payment_id: string; cents: number }[], reason: string | null) {
  await ctx.update("booking", bookingId, { status: "cancelled", cancelled_at: ctx.now, cancel_reason: reason });
  for (const t of await ctx.trx.selectFrom("court_time").select("id").where("booking_id", "=", bookingId).where("active", "=", true).execute()) await ctx.update("court_time", t.id, { active: false });
  for (const r of refunds) await refundPayment(ctx, r.payment_id, r.cents);
  // Shares not paid yet can't be paid any more.
  for (const p of await ctx.trx.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id")
    .where("booking_player.booking_id", "=", bookingId).where("payment.status", "=", "pending").execute()) await ctx.update("payment", p.id, { status: "failed" });
  await ctx.emit("booking.cancelled", { booking_id: bookingId, by: ctx.actor.personId });
}
/** Owners, managers and front desk: who may choose a refund other than the rule. */
export async function deskOrUp(db: Db | Trx, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  return Boolean(await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id").where("person_role.person_id", "=", personId)
    .where("person_role.active", "=", true).where("role.key", "in", ["owner", "manager", "front_desk"]).executeTakeFirst());
}

// ---- The jobs ----
/** Holds nobody paid for in time: the booking lapses and the court is free (it already is, to new bookings). */
export async function expireHolds(db: Db, now = new Date()) {
  const lapsed = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").select("booking.id").distinct()
    .where("booking.status", "=", "held").where("court_time.kind", "=", "hold").where("court_time.hold_until", "<=", now).execute();
  for (const b of lapsed) await runAsSystem(db, "booking.lapse", { booking_id: b.id }, "jobs", { now });
  return { lapsed: lapsed.length };
}
export const bookingLapse = defineAction({
  name: "booking.lapse", version: 1, system: true, internal: true,
  input: z.object({ booking_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "booking", i.booking_id, "thing.booking");
    return { title: both("action.booking.lapse"), summary: both("plan.booking.lapse", { code: row.code }), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const b = await ctx.trx.selectFrom("booking").select("status").where("id", "=", i.booking_id).forUpdate().executeTakeFirstOrThrow();
    if (b.status !== "held") return { already: b.status };
    await ctx.update("booking", i.booking_id, { status: "cancelled", cancelled_at: ctx.now, cancel_reason: "not_paid" });
    for (const t of await ctx.trx.selectFrom("court_time").select("id").where("booking_id", "=", i.booking_id).where("active", "=", true).execute()) await ctx.update("court_time", t.id, { active: false });
    return null;
  },
});

export const bookingSettleShares = defineAction({
  name: "booking.settle_shares", version: 1, system: true, internal: true,
  input: z.object({ booking_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "booking", i.booking_id, "thing.booking");
    return { title: both("action.booking.settle_shares"), summary: both("plan.booking.settle_shares", { code: row.code }), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const b = await ctx.trx.selectFrom("booking").selectAll().where("id", "=", i.booking_id).forUpdate().executeTakeFirstOrThrow();
    if (b.settled_at || b.status !== "confirmed") return { already: true };
    if (await openMatchOf(ctx.trx, b.id) && await paidPlaces(ctx.trx, b.id) < b.players) return cancelUnfilled(ctx, b.id);
    // What's been paid for the places still taken (a place let go was paid back, if it was paid at all).
    const paid = await ctx.trx.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
      .select((eb) => eb.fn.sum<string>("payment.amount_cents").as("c")).where("booking_player.booking_id", "=", b.id).where("booking_player.removed_at", "is", null)
      .where("payment.status", "=", "succeeded").executeTakeFirst();
    const unpaid = b.price_cents - Number(paid?.c ?? 0);
    // Seats taken and never paid for open again (the organiser covers the place, not a no-show's seat);
    // friends' shares not paid by now can't be paid any more: the organiser covers them.
    for (const p of await ctx.trx.selectFrom("booking_player").select("id").where("booking_id", "=", b.id).where("removed_at", "is", null).where("held_until", "is not", null).execute())
      await ctx.update("booking_player", p.id, { removed_at: ctx.now });
    for (const p of await ctx.trx.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id")
      .where("booking_player.booking_id", "=", b.id).where("payment.status", "=", "pending").execute()) await ctx.update("payment", p.id, { status: "failed" });
    if (unpaid <= 0) { await ctx.update("booking", b.id, { settled_at: ctx.now }); return { charged: 0 }; }
    const organiserPay = await ctx.trx.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
      .select(["payment.saved_customer", "payment.saved_method", "payment.provider_account", "booking_player.id as bp"])
      .where("booking_player.booking_id", "=", b.id).where("booking_player.person_id", "=", b.organiser_id).where("payment.save_card", "=", true).where("payment.status", "=", "succeeded").executeTakeFirst();
    const club = await ctx.trx.selectFrom("club").select("currency").executeTakeFirstOrThrow();
    const charge = organiserPay?.saved_customer && organiserPay.saved_method
      ? await paymentProvider().chargeSaved({ customer: organiserPay.saved_customer, paymentMethod: organiserPay.saved_method, amountCents: unpaid, currency: club.currency,
          description: `Court booking ${b.code}: unpaid shares`, idempotencyKey: `settle:${b.id}`, account: organiserPay.provider_account })
      : { ref: "", status: "failed" as const, failure: "no saved card" };
    if (charge.status === "succeeded") {
      await ctx.insert("payment", { id: uuidv7(), person_id: b.organiser_id!, amount_cents: unpaid, method: "card", provider: paymentProvider().name, provider_ref: charge.ref,
        provider_account: organiserPay?.provider_account ?? null, status: "succeeded", booking_player_id: organiserPay!.bp });
      await post(ctx.trx, ctx.runId, "payment", "court booking: unpaid shares", [
        { account: await account(ctx.trx, "provider_clearing"), cents: unpaid }, { account: await account(ctx.trx, "revenue", { revenueType: b.kind === "lesson" ? "lessons" : "courts" }), cents: -unpaid }]);
      await ctx.update("booking", b.id, { settled_at: ctx.now });
      await ctx.emit("booking.shares_charged", { booking_id: b.id, cents: unpaid });
      return { charged: unpaid };
    }
    await ctx.update("booking", b.id, { settled_at: ctx.now, balance_cents: unpaid });
    await ctx.emit("booking.balance_due", { booking_id: b.id, cents: unpaid, failure: charge.failure ?? null });
    return { owed: unpaid, failure: charge.failure };
  },
});

/** Places paid for by players still coming (a player who can't make it doesn't fill one). */
async function paidPlaces(trx: Trx, bookingId: string): Promise<number> {
  const r = await trx.selectFrom("booking_player").select(sql<string>`count(*)`.as("n")).where("booking_id", "=", bookingId).where("removed_at", "is", null).where("leaving_at", "is", null)
    .where((eb) => eb.exists(eb.selectFrom("payment").select("payment.id").whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "succeeded")))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/** An open match not full at the deadline: it's off, the court is free, and everyone gets back all they paid. */
async function cancelUnfilled(ctx: ApplyCtx, bookingId: string) {
  await ctx.update("booking", bookingId, { status: "cancelled", cancelled_at: ctx.now, cancel_reason: "not_filled" });
  for (const t of await ctx.trx.selectFrom("court_time").select("id").where("booking_id", "=", bookingId).where("active", "=", true).execute()) await ctx.update("court_time", t.id, { active: false });
  for (const p of await ctx.trx.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id")
    .where("booking_player.booking_id", "=", bookingId).where("payment.status", "=", "pending").execute()) await ctx.update("payment", p.id, { status: "failed" });
  // Who hears it, with what comes back to each (worked out now, not when the message is written).
  const seats = await ctx.trx.selectFrom("booking_player").select(["id", "person_id"]).where("booking_id", "=", bookingId).where("removed_at", "is", null).execute();
  const players: { person_id: string; cents: number }[] = [];
  for (const s of seats) {
    let cents = 0;
    for (const p of await ctx.trx.selectFrom("payment").select(["id", "amount_cents"]).where("booking_player_id", "=", s.id).where("status", "=", "succeeded").execute()) {
      await refundPayment(ctx, p.id, p.amount_cents);
      cents += p.amount_cents;
    }
    if (s.person_id) players.push({ person_id: s.person_id, cents });
  }
  await ctx.emit("booking.not_filled", { booking_id: bookingId, players });
  return { cancelled: true };
}

// ---- Reminders: a few hours before, once ----
export const REMINDER_HOURS = 3;
/** Confirmed bookings starting within the next few hours that haven't been reminded. A booking made inside
 *  that window isn't: its players already know. */
export async function remindBookings(db: Db, now = new Date()) {
  const soon = new Date(now.getTime() + REMINDER_HOURS * 3600_000);
  const due = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").select("booking.id").distinct()
    .where("booking.status", "=", "confirmed").where("booking.reminded_at", "is", null).where("court_time.active", "=", true)
    .where(sql<boolean>`lower(court_time.during) > ${now}`).where(sql<boolean>`lower(court_time.during) <= ${soon}`)
    .where(sql<boolean>`booking.created_at <= lower(court_time.during) - make_interval(hours => ${REMINDER_HOURS})`).execute();
  for (const b of due) await runAsSystem(db, "booking.remind", { booking_id: b.id }, "jobs", { now });
  return { reminded: due.length };
}
export const bookingRemind = defineAction({
  name: "booking.remind", version: 1, system: true, internal: true,
  input: z.object({ booking_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "booking", i.booking_id, "thing.booking");
    return { title: both("action.booking.remind"), summary: both("plan.booking.remind", { code: row.code }), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const b = await ctx.trx.selectFrom("booking").select("reminded_at").where("id", "=", i.booking_id).forUpdate().executeTakeFirstOrThrow();
    if (b.reminded_at) return { already: true };
    await ctx.update("booking", i.booking_id, { reminded_at: ctx.now });
    await ctx.emit("booking.reminder", { booking_id: i.booking_id });
    return null;
  },
});

// ---- Paid at the desk: cash, the club's own card reader, or another way ----
export const bookingRecordPayment = defineAction({
  name: "booking.record_payment", version: 1,
  input: z.object({ booking_id: z.uuid(), cents: z.number().check(z.int(), z.minimum(1)), method: z.enum(["cash", "terminal", "other"]), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const { row: b, read } = await readRow(ctx.db, "booking", i.booking_id, "thing.booking");
    if (b.status === "cancelled") throw new KumiError("error.already_cancelled");
    return { title: both("action.booking.record_payment"), summary: both("plan.booking.record_payment", { amount: usd(i.cents), code: b.code, how: both(`paid_by.${i.method}` as Key) }),
      reads: [read], locationId: b.location_id, moneyCents: i.cents, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const b = await ctx.trx.selectFrom("booking").selectAll().where("id", "=", i.booking_id).forUpdate().executeTakeFirstOrThrow();
    const player = await ctx.trx.selectFrom("booking_player").select(["id", "person_id"]).where("booking_id", "=", b.id).where("removed_at", "is", null)
      .orderBy(sql`person_id = ${b.organiser_id}`, "desc").orderBy("id").executeTakeFirstOrThrow();
    const id = uuidv7();
    // A walk-in has no person: the payment is recorded against the organiser, or whoever runs the desk.
    await ctx.insert("payment", { id, person_id: player.person_id ?? b.organiser_id ?? ctx.actor.personId!, amount_cents: i.cents, method: i.method, provider: "none", provider_ref: null, status: "succeeded", booking_player_id: player.id });
    await post(ctx.trx, ctx.runId, "payment", `court booking paid at the desk (${i.method})${i.note ? `: ${i.note}` : ""}`, [
      { account: await account(ctx.trx, i.method === "cash" ? "cash_drawer" : "provider_clearing"), cents: i.cents },
      { account: await account(ctx.trx, "revenue", { revenueType: b.kind === "lesson" ? "lessons" : "courts" }), cents: -i.cents }]);
    if (b.balance_cents) await ctx.update("booking", b.id, { balance_cents: Math.max(0, b.balance_cents - i.cents) });
    await ctx.emit("booking.paid_at_desk", { booking_id: b.id, payment_id: id });
    return { payment_id: id };
  },
});
