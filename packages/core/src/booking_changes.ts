// Staff change a booking from the Today view: move it to another time or court, or make it longer or shorter.
// The old court time is let go and the new one taken in one transaction under the courts' locks, so the
// database's own guarantee against two things on a court at once still holds; a lesson also needs its coach
// free then (under the coach's lock, as when it was booked). Money: a move keeps the price paid unless staff
// ask for it to be priced again; more time is owed at the desk; less time can give some back, by the club's
// cancellation rule, all of it, or nothing, as staff choose. Players hear what changed, in their language.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, money, type Text } from "@kumi/i18n";
import { defineAction, type ApplyCtx, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate } from "./clock.ts";
import { MAX_MINUTES, STEP_MINUTES, courtOpening, occupied } from "./bookings.ts";
import { quote } from "./prices.ts";
import { policyOf, refundPayment, REMINDER_HOURS } from "./booking_pay.ts";
import { coachBusy, coachNotFree } from "./lessons.ts";
import { withManagers } from "./households.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const when = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });
const at = (court: string, d: Date, tz: string): Text => { const w = when(d, tz); return { en: `${court}, ${w.en}`, es: `${court}, ${w.es}` }; };
const clockOf = (d: Date, tz: string): Text => ({ en: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d),
  es: new Intl.DateTimeFormat("es-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d) });
const refundChoice = z.optional(z.enum(["rule", "full", "none"]).check(z.describe("What goes back when less is owed: the club's cancellation rule (the default), all of it, or nothing.")));

/** The booking as it stands: its one active court time, its court and location, and what it cost. */
async function facts(db: Db | Trx, bookingId: string) {
  const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
    .innerJoin("location", "location.id", "court.location_id").leftJoin("person as org", "org.id", "booking.organiser_id").leftJoin("person as coach", "coach.id", "booking.coach_id")
    .select(["booking.id", "booking.code", "booking.kind", "booking.status", "booking.coach_id", "booking.organiser_id", "booking.location_id", "booking.price_cents", "booking.tax_cents",
      "booking.balance_cents", "booking.reminded_at", "court_time.id as time_id", "court_time.court_id", "court.name as court", "location.time_zone", "org.display_name as organiser",
      "coach.display_name as coach", sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
    .select((eb) => eb.selectFrom("booking_player").select("guest_name").whereRef("booking_player.booking_id", "=", "booking.id").where("guest_name", "is not", null).limit(1).as("guest"))
    .where("booking.id", "=", bookingId).where("court_time.active", "=", true).where("court_time.kind", "=", "booking").executeTakeFirst();
  if (!b) throw new KumiError("error.not_found", { thing: both("thing.booking") }, 404);
  if (b.status !== "confirmed") throw new KumiError(b.status === "cancelled" ? "error.already_cancelled" : "error.booking_not_confirmed");
  const start = new Date(b.start), end = new Date(b.end);
  return { ...b, start, end, minutes: Math.round((end.getTime() - start.getTime()) / 60_000), who: b.organiser ?? b.guest ?? "" };
}
type Facts = Awaited<ReturnType<typeof facts>>;

/** Card payments for the booking that went through, with what has come back of each already, and what was paid at
 *  the desk (which goes back at the desk). */
async function cardPays(db: Db | Trx, bookingId: string) {
  const rows = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .select(["payment.id", "payment.amount_cents", "payment.person_id", "payment.provider"])
    .select((eb) => eb.selectFrom("refund").select(sql<string>`coalesce(sum(refund.amount_cents), 0)`.as("c")).whereRef("refund.payment_id", "=", "payment.id").where("refund.status", "!=", "failed").as("back"))
    .where("booking_player.booking_id", "=", bookingId).where("payment.status", "=", "succeeded").orderBy("payment.id").execute();
  const all = rows.map((r) => ({ id: r.id, person_id: r.person_id, card: r.provider !== "none", left: r.amount_cents - Number(r.back ?? 0) }));
  return { net: all.reduce((n, p) => n + p.left, 0), card: all.filter((p) => p.card && p.left > 0), desk: all.filter((p) => !p.card && p.left > 0) };
}

/** What comes back when a booking costs less than was paid: `over` is what was paid beyond the new price. */
async function moneyBack(db: Db | Trx, b: Facts, over: number, choice: "rule" | "full" | "none", now: Date) {
  const policy = await policyOf(db, b.id);
  const early = b.start.getTime() - now.getTime() >= policy.free_cancel_hours * 3600_000;
  const percent = choice === "full" ? 100 : choice === "none" ? 0 : early ? 100 : policy.late_refund_percent;
  const pays = await cardPays(db, b.id), cardLeft = pays.card.reduce((n, p) => n + p.left, 0);
  const due = Math.round(over * percent / 100), cards = Math.min(due, cardLeft);
  const why = choice === "rule" ? both("change.why_rule", { percent }) : both(choice === "full" ? "change.why_full" : "change.why_none");
  return { percent, due, cards, desk: due - cards, why };
}

/** Send `cents` back across the card payments, in proportion to what's left of each; who got how much. */
async function giveBack(ctx: ApplyCtx, bookingId: string, cents: number): Promise<Record<string, number>> {
  const pays = (await cardPays(ctx.trx, bookingId)).card, total = pays.reduce((n, p) => n + p.left, 0), out: Record<string, number> = {};
  if (cents <= 0 || !total) return out;
  let left = Math.min(cents, total);
  const parts = pays.map((p) => ({ p, c: Math.min(p.left, Math.floor(Math.min(cents, total) * p.left / total)) }));
  left -= parts.reduce((n, x) => n + x.c, 0);
  for (const x of [...parts].sort((a, b) => b.p.left - a.p.left)) { if (left <= 0) break; const more = Math.min(left, x.p.left - x.c); x.c += more; left -= more; }
  for (const x of parts) if (x.c > 0) { await refundPayment(ctx, x.p.id, x.c); out[x.p.person_id] = (out[x.p.person_id] ?? 0) + x.c; }
  return out;
}
/** What goes back of money paid at the desk waits there to be handed over (desk_pay.ts); who's owed how much. */
async function giveBackAtDesk(ctx: ApplyCtx, bookingId: string, cents: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let rest = cents;
  for (const p of (await cardPays(ctx.trx, bookingId)).desk) {
    const c = Math.min(rest, p.left);
    if (c <= 0) break;
    await refundPayment(ctx, p.id, c);
    out[p.person_id] = (out[p.person_id] ?? 0) + c;
    rest -= c;
  }
  return out;
}

/** The sentence about money in a change's preview. */
function moneyText(o: { owed: number; price?: number; back?: Awaited<ReturnType<typeof moneyBack>> | null; over?: number }): Text {
  if (o.owed > 0) return both(o.price !== undefined ? "change.repriced_owed" : "change.owed", { amount: usd(o.owed), price: usd(o.price ?? 0) });
  if (o.back && (o.over ?? 0) > 0) {
    const parts: Text[] = [];
    if (o.back.cards > 0) parts.push(both("change.back_card", { amount: usd(o.back.cards), why: o.back.why }));
    if (o.back.desk > 0) parts.push(both("change.back_desk", { amount: usd(o.back.desk), why: o.back.why }));
    if (!parts.length) parts.push(both("change.back_none", { why: o.back.why }));
    const lead = o.price !== undefined ? both("change.repriced", { price: usd(o.price) }) : null;
    const all = lead ? [lead, ...parts] : parts;
    return { en: all.map((x) => x.en).join(" "), es: all.map((x) => x.es).join(" ") };
  }
  return o.price !== undefined ? both("change.repriced_same", { price: usd(o.price) }) : both("change.price_stays");
}
const joinText = (...xs: Text[]): Text => ({ en: xs.map((x) => x.en).filter(Boolean).join(" "), es: xs.map((x) => x.es).filter(Boolean).join(" ") });

/** The court and time are free for this booking (its own time aside), the club is open then, and a lesson's coach can do it. */
async function checkTime(ctx: PlanCtx, b: Facts, courtId: string, start: Date, end: Date) {
  const court = await ctx.db.selectFrom("court").select(["id", "name", "location_id", "bookable", "archived_at"]).where("id", "=", courtId).executeTakeFirst();
  if (!court || court.archived_at) throw new KumiError("error.not_found", { thing: both("thing.court") }, 404);
  if (court.location_id !== b.location_id) throw new KumiError("error.one_location");
  if (!court.bookable) throw new KumiError("error.court_not_bookable", { court: court.name });
  if (end <= ctx.now) throw new KumiError("error.in_the_past");
  const open = await courtOpening(ctx.db, court, localDate(start, b.time_zone));
  if (!open || start < open.opens || end > open.closes) throw new KumiError("error.closed_then", { court: court.name, when: when(start, b.time_zone) });
  if ((await occupied(ctx.db, [courtId], start, end, ctx.now)).some((x) => x.booking_id !== b.id)) throw new KumiError("error.court_taken");
  if (b.kind === "lesson" && b.coach_id) {
    const why = await coachNotFree(ctx.db, b.coach_id, court.location_id, start, end, ctx.now, b.id);
    if (why) throw new KumiError(why === "busy" ? "error.coach_busy" : "error.coach_not_then", { coach: b.coach ?? "", when: when(start, b.time_zone) });
  }
  return court;
}

/** Let go of the booking's court time and take the new one, under the courts' locks (and the coach's, for a lesson). */
async function swapTime(ctx: ApplyCtx, b: Facts, courtId: string, start: Date, end: Date) {
  if (b.kind === "lesson" && b.coach_id) {
    await ctx.trx.selectFrom("person").select("id").where("id", "=", b.coach_id).forUpdate().execute();
    if ((await coachBusy(ctx.trx, b.coach_id, start, end, ctx.now, { bookingId: b.id })).length) throw new KumiError("error.changed");
  }
  for (const id of [...new Set([b.court_id, courtId])].sort()) await ctx.trx.selectFrom("court").select("id").where("id", "=", id).forUpdate().execute();
  await ctx.trx.updateTable("court_time").set({ active: false }).where("court_id", "in", [b.court_id, courtId]).where("kind", "=", "hold").where("active", "=", true).where("hold_until", "<=", ctx.now).execute();
  const now = await ctx.trx.selectFrom("court_time").select("id").where("booking_id", "=", b.id).where("active", "=", true).where("kind", "=", "booking").execute();
  if (now.length !== 1 || now[0]!.id !== b.time_id) throw new KumiError("error.changed");
  await ctx.update("court_time", b.time_id, { active: false });
  try { await ctx.insert("court_time", { id: uuidv7(), court_id: courtId, during: sql`tstzrange(${start}, ${end})`, kind: "booking", booking_id: b.id }); }
  catch (e: any) { if (e?.code === "23P01") throw new KumiError("error.court_taken"); throw e; }
}

export const bookingMove = defineAction({
  name: "booking.move", version: 1,
  input: z.object({ booking_id: z.uuid(), court_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }),
    reprice: z.optional(z.boolean().check(z.describe("Price it again at the new time and court (a court booking). Otherwise the price stays as paid."))), refund: refundChoice }),
  async plan(ctx, i) {
    const b = await facts(ctx.db, i.booking_id);
    if (b.start <= ctx.now) throw new KumiError("error.booking_started");
    const start = new Date(i.starts_at), end = new Date(start.getTime() + b.minutes * 60_000);
    if (start.getTime() === b.start.getTime() && i.court_id === b.court_id) throw new KumiError("error.nothing_changed");
    if (start <= ctx.now) throw new KumiError("error.in_the_past");
    const court = await checkTime(ctx, b, i.court_id, start, end);
    // Priced again: what the club's prices say now, for the organiser (a member's price for a member).
    let price = b.price_cents, tax = b.tax_cents, owed = 0, back: Awaited<ReturnType<typeof moneyBack>> | null = null, over = 0;
    const reprice = Boolean(i.reprice) && b.kind === "court";
    if (reprice) {
      const q = await quote(ctx.db, { courtId: i.court_id, start, minutes: b.minutes, personId: b.organiser_id, at: ctx.now });
      if (!q.priced) throw new KumiError("error.no_price");
      price = q.total_cents; tax = q.tax_cents;
      const paid = (await cardPays(ctx.db, b.id)).net;
      if (price > b.price_cents) owed = price - b.price_cents;
      else if (paid > price) { over = paid - price; back = await moneyBack(ctx.db, b, over, i.refund ?? "rule", ctx.now); }
    }
    // Kept, when less comes back than was paid beyond the new price: the price is what the club keeps.
    const kept = back ? over - back.due : 0;
    const summary = joinText(both(b.kind === "lesson" ? "plan.booking.move_lesson" : "plan.booking.move", { code: b.code, who: b.who, coach: b.coach ?? "",
      from: at(b.court, b.start, b.time_zone), to: at(court.name, start, b.time_zone) }), moneyText({ owed, price: reprice ? price : undefined, back, over }), both("change.players_told"));
    return { title: both("action.booking.move"), summary, reads: [], locationId: b.location_id, ownerIds: await withManagers(ctx.db, [b.organiser_id]), moneyCents: back?.due ?? owed,
      undo: { kind: "compensating" }, details: { price: price + kept, tax, owed, back: back ? { cards: back.cards, desk: back.desk } : null, from: at(b.court, b.start, b.time_zone), to: at(court.name, start, b.time_zone) } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { price: number; tax: number; owed: number; back: { cards: number; desk?: number } | null; from: Text; to: Text };
    const b = await facts(ctx.trx, i.booking_id), start = new Date(i.starts_at), end = new Date(start.getTime() + b.minutes * 60_000);
    await swapTime(ctx, b, i.court_id, start, end);
    if (d.price !== b.price_cents || d.tax !== b.tax_cents || d.owed)
      await ctx.update("booking", b.id, { price_cents: d.price, tax_cents: d.tax, balance_cents: (b.balance_cents ?? 0) + d.owed });
    const refunds = d.back ? await giveBack(ctx, b.id, d.back.cards) : {}, desk = d.back ? await giveBackAtDesk(ctx, b.id, d.back.desk ?? 0) : {};
    // A reminder already sent was for the old time: the new one gets its own.
    if (b.reminded_at && start.getTime() - ctx.now.getTime() > REMINDER_HOURS * 3600_000) await ctx.update("booking", b.id, { reminded_at: null });
    await ctx.emit("booking.moved", { booking_id: b.id, from: d.from, to: d.to, owed: d.owed, refunds, desk });
    return { booking_id: b.id };
  },
});

export const bookingExtend = defineAction({
  name: "booking.extend", version: 1,
  input: z.object({ booking_id: z.uuid(), minutes: z.number().check(z.int(), z.describe("How long it runs now, from the same start: longer or shorter.")), refund: refundChoice }),
  async plan(ctx, i) {
    const b = await facts(ctx.db, i.booking_id);
    if (i.minutes === b.minutes) throw new KumiError("error.nothing_changed");
    if (i.minutes % STEP_MINUTES || i.minutes < STEP_MINUTES || i.minutes > MAX_MINUTES) throw new KumiError("error.bad_length");
    if (b.end <= ctx.now) throw new KumiError("error.booking_over");
    const end = new Date(b.start.getTime() + i.minutes * 60_000), longer = i.minutes > b.minutes;
    if (end <= ctx.now) throw new KumiError("error.in_the_past");
    let owed = 0, extraTax = 0, back: Awaited<ReturnType<typeof moneyBack>> | null = null, over = 0, price = b.price_cents;
    if (longer) {
      await checkTime(ctx, b, b.court_id, b.start, end);
      const extra = i.minutes - b.minutes;
      // A court: what the club's prices say for the added time. A lesson: the coach's rate, for the minutes added.
      if (b.kind === "court") {
        const q = await quote(ctx.db, { courtId: b.court_id, start: b.end, minutes: extra, personId: b.organiser_id, at: ctx.now });
        if (!q.priced) throw new KumiError("error.no_price");
        owed = q.total_cents; extraTax = q.tax_cents;
      } else { owed = Math.round(b.price_cents * extra / b.minutes); extraTax = Math.round(b.tax_cents * extra / b.minutes); }
      price = b.price_cents + owed;
    } else {
      // Less time: the price comes down by the share of time taken off; what was paid beyond it can come back.
      price = b.price_cents - Math.round(b.price_cents * (b.minutes - i.minutes) / b.minutes);
      const paid = (await cardPays(ctx.db, b.id)).net;
      if (paid > price) { over = paid - price; back = await moneyBack(ctx.db, b, over, i.refund ?? "rule", ctx.now); }
    }
    const p = { code: b.code, who: b.who, coach: b.coach ?? "", court: b.court, when: when(b.start, b.time_zone), minutes: i.minutes, old: b.minutes, until: clockOf(end, b.time_zone) };
    const money = longer ? both("change.extra_owed", { count: i.minutes - b.minutes, amount: usd(owed) })
      : over > 0 ? moneyText({ owed: 0, back, over }) : both("change.nothing_paid_for_it");
    const summary = joinText(both(longer ? "plan.booking.extend" : "plan.booking.shorten", p), money, both("change.players_told"));
    // Kept, when less comes back than was paid beyond the new price: the price is what the club keeps.
    const kept = back ? over - back.due : 0;
    return { title: both("action.booking.extend"), summary, reads: [], locationId: b.location_id, ownerIds: await withManagers(ctx.db, [b.organiser_id]), moneyCents: back?.due ?? owed,
      undo: { kind: "compensating" }, details: { price: price + kept, tax: longer ? b.tax_cents + extraTax : Math.round(b.tax_cents * (price + kept) / Math.max(b.price_cents, 1)), owed,
        back: back ? { cards: back.cards, desk: back.desk } : null, until: clockOf(end, b.time_zone) } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { price: number; tax: number; owed: number; back: { cards: number; desk?: number } | null; until: Text };
    const b = await facts(ctx.trx, i.booking_id), end = new Date(b.start.getTime() + i.minutes * 60_000);
    await swapTime(ctx, b, b.court_id, b.start, end);
    const balance = i.minutes > b.minutes ? (b.balance_cents ?? 0) + d.owed : Math.max(0, (b.balance_cents ?? 0) - (b.price_cents - d.price));
    await ctx.update("booking", b.id, { price_cents: d.price, tax_cents: d.tax, balance_cents: balance });
    const refunds = d.back ? await giveBack(ctx, b.id, d.back.cards) : {}, desk = d.back ? await giveBackAtDesk(ctx, b.id, d.back.desk ?? 0) : {};
    await ctx.emit("booking.resized", { booking_id: b.id, old: b.minutes, until: d.until, owed: d.owed, refunds, desk });
    return { booking_id: b.id };
  },
});
