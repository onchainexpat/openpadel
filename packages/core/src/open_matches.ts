// Open matches, the parts around joining: a player outside the band asks the host, who says yes (their
// seat is then held an hour while they pay) or no; seats taken and not paid for open again; and at the
// club's deadline, a match that isn't full is cancelled and everyone gets their money back. A payment whose
// card form was opened is called off at the provider before it's given up, so a late payment can't go
// through unrecorded.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, money, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { paymentProvider } from "./money.ts";
import { abandonPayment } from "./programs.ts";
import { deadlineSql, notOwing, pastDeadline, policyOf, refundPayment, refundTarget, refundUpTo, shares } from "./booking_pay.ts";
import { band, levelOf, openMatchOf } from "./match_rules.ts";
import { notJunior, requireWaiver } from "./households.ts";
import { areFriends } from "./friends.ts";

/** How long a player the host said yes to has to pay before the seat opens again. */
export const APPROVED_HOLD_MINUTES = 60;
const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });

/** The match a booking is, with when and where, its host, and who's in it now. */
export async function matchFacts(db: Db | Trx, bookingId: string) {
  const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
    .innerJoin("location", "location.id", "court.location_id").leftJoin("person", "person.id", "booking.organiser_id")
    .select(["booking.id", "booking.status", "booking.players", "booking.price_cents", "booking.settled_at", "booking.organiser_id", "booking.location_id", "court.name as court", "location.time_zone",
      "person.display_name as host", sql<Date>`lower(court_time.during)`.as("start")])
    .where("booking.id", "=", bookingId).where("court_time.active", "=", true).executeTakeFirst();
  if (!b) throw new KumiError("error.not_found", { thing: both("thing.booking") }, 404);
  const om = await openMatchOf(db, bookingId);
  if (!om) throw new KumiError("error.not_open_match");
  // Seats taken (a player who said after the deadline that they can't make it doesn't fill one, and a sub
  // paying to take over someone's place isn't a place of its own).
  const seated = Number((await db.selectFrom("booking_player").select(sql<string>`count(*)`.as("n")).where("booking_id", "=", bookingId).where("removed_at", "is", null).where("leaving_at", "is", null)
    .where("replaces", "is", null).executeTakeFirstOrThrow()).n);
  const when: Text = { en: dateTime(new Date(b.start), "en", b.time_zone), es: dateTime(new Date(b.start), "es", b.time_zone) };
  return { ...b, om, seated, when, share: shares(b.price_cents, b.players).each };
}
export const isOpen = (m: { status: string; settled_at: Date | null; start: Date }, now: Date) => m.status === "confirmed" && !m.settled_at && new Date(m.start) > now;

export const bookingAsk = defineAction({
  name: "booking.ask", version: 1,
  input: z.object({ booking_id: z.uuid(), person_id: z.uuid(), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    await notJunior(ctx.db, i.person_id);
    await notOwing(ctx.db, i.person_id, ctx.actor.personId, ctx.now);
    await requireWaiver(ctx, i.person_id);
    const m = await matchFacts(ctx.db, i.booking_id);
    if (!isOpen(m, ctx.now)) throw new KumiError("error.invite_closed");
    if (m.om.outside_band !== "ask") throw new KumiError("error.match_closed_outside");
    if (m.seated >= m.players) throw new KumiError("error.booking_full");
    if (await ctx.db.selectFrom("booking_player").select("id").where("booking_id", "=", i.booking_id).where("person_id", "=", i.person_id).where("removed_at", "is", null).executeTakeFirst())
      throw new KumiError("error.already_in_booking");
    if (await ctx.db.selectFrom("join_request").select("id").where("booking_id", "=", i.booking_id).where("person_id", "=", i.person_id).where("status", "=", "requested").executeTakeFirst())
      throw new KumiError("error.already_asked");
    return { title: both("action.booking.ask"), summary: both("plan.booking.ask", { host: m.host ?? "", court: m.court, when: m.when, share: usd(m.share), hours: both("count.hours", { count: APPROVED_HOLD_MINUTES / 60 }) }),
      reads: [], locationId: m.location_id, ownerIds: [i.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const level = await levelOf(ctx.trx, i.person_id), id = uuidv7();
    try { await ctx.insert("join_request", { id, booking_id: i.booking_id, person_id: i.person_id, level: level === null ? null : level.toFixed(2), note: i.note ?? null }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.already_asked"); throw e; }
    await ctx.emit("booking.asked", { request_id: id });
    return { request_id: id };
  },
});

export const bookingWithdrawAsk = defineAction({
  name: "booking.withdraw_ask", version: 1,
  input: z.object({ request_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: r, read } = await readRow(ctx.db, "join_request", i.request_id, "thing.join_request");
    if (r.status !== "requested") throw new KumiError("error.request_answered");
    const m = await matchFacts(ctx.db, r.booking_id);
    return { title: both("action.booking.withdraw_ask"), summary: both("plan.booking.withdraw_ask", { court: m.court, when: m.when }), reads: [read], locationId: m.location_id,
      ownerIds: [r.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("join_request", i.request_id, { status: "withdrawn", decided_at: ctx.now }); return null; },
});

export const bookingAnswerAsk = defineAction({
  name: "booking.answer_ask", version: 1,
  input: z.object({ request_id: z.uuid(), approve: z.boolean() }),
  async plan(ctx, i) {
    const { row: r, read } = await readRow(ctx.db, "join_request", i.request_id, "thing.join_request");
    if (r.status !== "requested") throw new KumiError("error.request_answered");
    const m = await matchFacts(ctx.db, r.booking_id);
    const person = (await readRow(ctx.db, "person", r.person_id, "thing.person")).row.display_name as string;
    const level = r.level === null ? both("plan.booking.no_level") : Number(r.level).toFixed(2);
    if (i.approve && (!isOpen(m, ctx.now) || m.seated >= m.players)) throw new KumiError(isOpen(m, ctx.now) ? "error.booking_full" : "error.invite_closed");
    return { title: both("action.booking.answer_ask"), reads: [read], locationId: m.location_id, ownerIds: m.organiser_id ? [m.organiser_id] : [], undo: { kind: "compensating" },
      summary: i.approve ? both("plan.booking.approve_ask", { person, level, band: band(m.om), share: usd(m.share), hours: both("count.hours", { count: APPROVED_HOLD_MINUTES / 60 }) })
        : both("plan.booking.decline_ask", { person }) };
  },
  async apply(ctx, i) {
    const r = await ctx.trx.selectFrom("join_request").selectAll().where("id", "=", i.request_id).forUpdate().executeTakeFirstOrThrow();
    if (r.status !== "requested") throw new KumiError("error.request_answered");
    await ctx.update("join_request", r.id, { status: i.approve ? "approved" : "declined", decided_at: ctx.now });
    if (i.approve) {
      await ctx.trx.selectFrom("booking").select("id").where("id", "=", r.booking_id).forUpdate().execute();   // one seat at a time
      const m = await matchFacts(ctx.trx, r.booking_id);
      if (!isOpen(m, ctx.now) || m.seated >= m.players) throw new KumiError("error.changed");
      const bp = uuidv7();
      await ctx.insert("booking_player", { id: bp, booking_id: r.booking_id, person_id: r.person_id, share_cents: m.share, held_until: new Date(ctx.now.getTime() + APPROVED_HOLD_MINUTES * 60_000) });
      await ctx.insert("payment", { id: uuidv7(), person_id: r.person_id, amount_cents: m.share, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", booking_player_id: bp });
    }
    await ctx.emit("booking.ask_answered", { request_id: r.id });
    return null;
  },
});

/** Kumi opens a seat nobody paid for in time (its payment, if a card form was opened, already called off). */
export const bookingReleaseSeat = defineAction({
  name: "booking.release_seat", version: 1, system: true, internal: true,
  input: z.object({ booking_player_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "booking_player", i.booking_player_id, "thing.booking");
    return { title: both("action.booking.release_seat"), summary: both("action.booking.release_seat"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const p = await ctx.trx.selectFrom("booking_player").selectAll().where("id", "=", i.booking_player_id).forUpdate().executeTakeFirstOrThrow();
    if (p.removed_at || !p.held_until || p.held_until > ctx.now) return { already: true };
    const paid = await ctx.trx.selectFrom("payment").select("id").where("booking_player_id", "=", p.id).where("status", "=", "succeeded").executeTakeFirst();
    if (paid) { await ctx.update("booking_player", p.id, { held_until: null }); return { paid: true }; }
    for (const pay of await ctx.trx.selectFrom("payment").select("id").where("booking_player_id", "=", p.id).where("status", "=", "pending").where("provider_ref", "is", null).execute())
      await ctx.update("payment", pay.id, { status: "failed" });
    await ctx.update("booking_player", p.id, { removed_at: ctx.now });
    await ctx.emit("booking.seat_released", { booking_player_id: p.id });
    return null;
  },
});

/** The job: seats held past their time without a payment open again. */
export async function releaseSeats(db: Db, now = new Date()) {
  const due = await db.selectFrom("booking_player").select("id").where("removed_at", "is", null).where("held_until", "is not", null).where("held_until", "<=", now).execute();
  let released = 0;
  for (const p of due) {
    for (const pay of await db.selectFrom("payment").select("id").where("booking_player_id", "=", p.id).where("status", "=", "pending").where("provider_ref", "is not", null).execute())
      await abandonPayment(db, pay.id, "job:seats", now);
    const r = await runAsSystem(db, "booking.release_seat", { booking_player_id: p.id }, "jobs", { now });
    if (!r.result) released++;
  }
  return { released };
}

/** "Pay my part" bookings at their deadline: whatever is unpaid goes on the organiser's saved card, once;
 *  an open match that isn't full is cancelled instead, with everyone paid back. Card forms still open are
 *  called off first (one that went through counts as paid). */
export async function settleShares(db: Db, now = new Date()) {
  const due = await db.selectFrom("booking").innerJoin("booking_policy", "booking_policy.id", "booking.policy_id").innerJoin("court_time", "court_time.booking_id", "booking.id")
    .leftJoin("open_match", "open_match.booking_id", "booking.id")
    .select(["booking.id"]).distinct().where("booking.pay_mode", "=", "split").where("booking.status", "=", "confirmed").where("booking.settled_at", "is", null).where("court_time.active", "=", true)
    .where(sql<boolean>`${deadlineSql} <= ${now}`).execute();
  let charged = 0, failed = 0, cancelled = 0;
  for (const b of due) {
    for (const pay of await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id")
      .where("booking_player.booking_id", "=", b.id).where("payment.status", "=", "pending").where("payment.provider_ref", "is not", null).execute())
      await abandonPayment(db, pay.id, "job:settle", now);
    const r = await runAsSystem(db, "booking.settle_shares", { booking_id: b.id }, "jobs", { now });
    const res = r.result as { charged?: number; owed?: number; cancelled?: boolean } | null;
    if (res?.cancelled) cancelled++; else if (res?.charged) charged++; else if (res?.owed) failed++;
  }
  return { settled: due.length, charged, failed, cancelled };
}

// ---- When plans change: saved places, can't make it, running late, no-shows ----
/** A person's seat (one who said after the deadline that they can't make it still has theirs). */
export async function seatOf(db: Db | Trx, bookingId: string, personId: string) {
  return (await db.selectFrom("booking_player").selectAll().where("booking_id", "=", bookingId).where("person_id", "=", personId).where("removed_at", "is", null).executeTakeFirst()) ?? null;
}
export async function paidBy(db: Db | Trx, bookingPlayerId: string): Promise<number> {
  const r = await db.selectFrom("payment").select(sql<string>`coalesce(sum(amount_cents), 0)`.as("c")).where("booking_player_id", "=", bookingPlayerId).where("status", "=", "succeeded").executeTakeFirstOrThrow();
  return Number(r.c);
}

export const bookingSavePlace = defineAction({
  name: "booking.save_place", version: 1,
  input: z.object({ booking_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const m = await matchFacts(ctx.db, i.booking_id);
    if (!isOpen(m, ctx.now)) throw new KumiError("error.invite_closed");
    if (m.seated >= m.players) throw new KumiError("error.booking_full");
    if (i.person_id === m.organiser_id || await seatOf(ctx.db, i.booking_id, i.person_id)) throw new KumiError("error.already_in_booking");
    // A same-day match has no time to wait for a saved place: each player pays when they join.
    if (m.om.cutoff_at) throw new KumiError("error.same_day_no_saving");
    // Only for a friend (each has added the other): a host can't put a stranger's name on a match.
    if (!m.organiser_id || !(await areFriends(ctx.db, m.organiser_id, i.person_id))) throw new KumiError("error.not_friends");
    const friend = (await readRow(ctx.db, "person", i.person_id, "thing.person")).row.display_name as string;
    const policy = await ctx.db.selectFrom("booking").innerJoin("booking_policy", "booking_policy.id", "booking.policy_id").select("booking_policy.split_deadline_hours").where("booking.id", "=", i.booking_id).executeTakeFirstOrThrow();
    return { title: both("action.booking.save_place"), summary: both("plan.booking.save_place", { friend, share: usd(m.share), hours: both("count.hours", { count: policy.split_deadline_hours }) }),
      reads: [], locationId: m.location_id, ownerIds: m.organiser_id ? [m.organiser_id] : [], undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    await ctx.trx.selectFrom("booking").select("id").where("id", "=", i.booking_id).forUpdate().execute();   // one seat at a time
    const m = await matchFacts(ctx.trx, i.booking_id);
    if (m.seated >= m.players || await seatOf(ctx.trx, i.booking_id, i.person_id)) throw new KumiError("error.changed");
    const id = uuidv7();
    // Saved, not held: it stays the friend's until the deadline (unpaid then, it's an empty place, and a match
    // that isn't full is cancelled).
    await ctx.insert("booking_player", { id, booking_id: i.booking_id, person_id: i.person_id, share_cents: m.share, saved_by: m.organiser_id });
    await ctx.insert("payment", { id: uuidv7(), person_id: i.person_id, amount_cents: m.share, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", booking_player_id: id });
    await ctx.emit("booking.place_saved", { booking_player_id: id });
    return { booking_player_id: id };
  },
});

export const bookingDropSavedPlace = defineAction({
  name: "booking.drop_saved_place", version: 1,
  input: z.object({ booking_player_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "booking_player", i.booking_player_id, "thing.booking");
    if (!p.saved_by || p.removed_at || await paidBy(ctx.db, p.id)) throw new KumiError("error.place_not_saved");
    const m = await matchFacts(ctx.db, p.booking_id);
    const friend = (await readRow(ctx.db, "person", p.person_id, "thing.person")).row.display_name as string;
    return { title: both("action.booking.drop_saved_place"), summary: both("plan.booking.drop_saved_place", { friend }), reads: [read], locationId: m.location_id,
      ownerIds: m.organiser_id ? [m.organiser_id] : [], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    await ctx.update("booking_player", i.booking_player_id, { removed_at: ctx.now });
    // A card form the friend opened stays as it is: paid after this, it's refunded (afterBookingPayment).
    for (const p of await ctx.trx.selectFrom("payment").select("id").where("booking_player_id", "=", i.booking_player_id).where("status", "=", "pending").where("provider_ref", "is", null).execute())
      await ctx.update("payment", p.id, { status: "failed" });
    await ctx.emit("booking.place_dropped", { booking_player_id: i.booking_player_id });
    return null;
  },
});

/** A place's open "take my place" offer ends (its player left, or took it back): a sub still paying for it
 *  loses the seat, and a payment of theirs that goes through later is refunded (afterBookingPayment). */
export async function endOffer(ctx: ApplyCtx, placeId: string) {
  for (const o of await ctx.trx.selectFrom("place_offer").select("id").where("booking_player_id", "=", placeId).where("status", "=", "offered").execute())
    await ctx.update("place_offer", o.id, { status: "withdrawn", decided_at: ctx.now });
  for (const sub of await ctx.trx.selectFrom("booking_player").select("id").where("replaces", "=", placeId).where("removed_at", "is", null).execute()) {
    await ctx.update("booking_player", sub.id, { removed_at: ctx.now });
    for (const p of await ctx.trx.selectFrom("payment").select("id").where("booking_player_id", "=", sub.id).where("status", "=", "pending").where("provider_ref", "is", null).execute())
      await ctx.update("payment", p.id, { status: "failed" });
  }
}

/** What a player who can't make it after the deadline gets back, as money, under the booking's own rules. */
export async function lateTerms(db: Db | Trx, bookingId: string, seatId: string) {
  const policy = await policyOf(db, bookingId);
  const at = async (percent: number) => usd((await refundTarget(db, seatId, percent)).total);
  // What comes back now stays theirs, so a filled place is never worth less than an empty one.
  return { empty: await at(policy.late_empty_refund_percent), filled: await at(Math.max(policy.late_filled_refund_percent, policy.late_empty_refund_percent)),
    sub: await at(policy.late_sub_refund_percent), policy };
}

export const bookingLeave = defineAction({
  name: "booking.leave", version: 1,
  input: z.object({ booking_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const m = await matchFacts(ctx.db, i.booking_id);
    if (i.person_id === m.organiser_id) throw new KumiError("error.host_cancels");
    const seat = await seatOf(ctx.db, i.booking_id, i.person_id);
    if (!seat || seat.leaving_at) throw new KumiError("error.not_in_match");
    if (m.status !== "confirmed" || new Date(m.start) <= ctx.now) throw new KumiError("error.match_started");
    // Before the deadline a paid player gets it all back at once: a match that isn't full by then is
    // cancelled with everyone paid back anyway. After it, it's a late cancellation: what comes back is the
    // club's rule (some now; more if the club fills the place with a paying player).
    const paid = await paidBy(ctx.db, seat.id), late = await pastDeadline(ctx.db, i.booking_id, ctx.now);
    const p = { court: m.court, when: m.when, share: usd(paid) };
    const summary = !paid ? both("plan.booking.leave_unpaid", p) : !late ? both("plan.booking.leave_paid", p)
      : await (async () => { const { empty, filled, sub } = await lateTerms(ctx.db, i.booking_id, seat.id); return both("plan.booking.leave_late", { ...p, empty, filled, sub }); })();
    return { title: both("action.booking.leave"), summary, reads: [], locationId: m.location_id, ownerIds: [i.person_id], undo: { kind: "none" }, details: { seat: seat.id, paid, late } };
  },
  async apply(ctx, i, plan) {
    const { seat, paid, late } = plan.details as { seat: string; paid: number; late: boolean };
    await endOffer(ctx, seat);
    let refunded = 0;
    if (paid && late) {
      await ctx.update("booking_player", seat, { leaving_at: ctx.now, late_leave: true });
      refunded = await refundUpTo(ctx, seat, (await policyOf(ctx.trx, i.booking_id)).late_empty_refund_percent);
    } else {
      await ctx.update("booking_player", seat, { removed_at: ctx.now, late_leave: late });
      for (const p of await ctx.trx.selectFrom("payment").select("id").where("booking_player_id", "=", seat).where("status", "=", "pending").where("provider_ref", "is", null).execute())
        await ctx.update("payment", p.id, { status: "failed" });
      refunded = await refundUpTo(ctx, seat, 100);
    }
    await ctx.emit("booking.player_left", { booking_player_id: seat, paid: paid > 0, late, refunded });
    return null;
  },
});

export const bookingRunningLate = defineAction({
  name: "booking.running_late", version: 1,
  input: z.object({ booking_id: z.uuid(), person_id: z.uuid(), minutes: z.number().check(z.int(), z.minimum(5), z.maximum(60)) }),
  async plan(ctx, i) {
    const m = await matchFacts(ctx.db, i.booking_id).catch(() => null) ?? await plainBooking(ctx.db, i.booking_id);
    const seat = await seatOf(ctx.db, i.booking_id, i.person_id);
    if (!seat || seat.leaving_at) throw new KumiError("error.not_in_match");
    const start = new Date(m.start).getTime();
    if (ctx.now.getTime() < start - 3 * 3600_000 || ctx.now.getTime() > start + 30 * 60_000) throw new KumiError("error.not_now_late");
    return { title: both("action.booking.running_late"), summary: both("plan.booking.running_late", { court: m.court, when: m.when, minutes: i.minutes }),
      reads: [], locationId: m.location_id, ownerIds: [i.person_id], undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) { await ctx.emit("booking.running_late", { booking_id: i.booking_id, person_id: i.person_id, minutes: i.minutes }); return null; },
});
/** Any booking with players (running late works for a plain shared booking too). */
async function plainBooking(db: Db | Trx, bookingId: string) {
  const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id")
    .select(["booking.location_id", "court.name as court", "location.time_zone", sql<Date>`lower(court_time.during)`.as("start")]).where("booking.id", "=", bookingId).where("court_time.active", "=", true).executeTakeFirst();
  if (!b) throw new KumiError("error.not_found", { thing: both("thing.booking") }, 404);
  return { ...b, when: { en: dateTime(new Date(b.start), "en", b.time_zone), es: dateTime(new Date(b.start), "es", b.time_zone) } as Text };
}

export const bookingMarkNoShow = defineAction({
  name: "booking.mark_no_show", version: 1,
  input: z.object({ booking_player_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "booking_player", i.booking_player_id, "thing.booking");
    const b = await ctx.db.selectFrom("booking").select(["organiser_id", "location_id"]).where("id", "=", p.booking_id).executeTakeFirstOrThrow();
    const m = await plainBooking(ctx.db, p.booking_id);
    if (p.removed_at || !p.person_id || p.person_id === b.organiser_id) throw new KumiError("error.not_in_match");
    if (p.no_show) throw new KumiError("error.already_no_show");
    const start = new Date(m.start).getTime();
    if (ctx.now.getTime() < start || ctx.now.getTime() > start + 48 * 3600_000) throw new KumiError("error.no_show_window");
    const person = (await readRow(ctx.db, "person", p.person_id, "thing.person")).row.display_name as string;
    return { title: both("action.booking.mark_no_show"), summary: both("plan.booking.mark_no_show", { person, court: m.court, when: m.when }), reads: [read], locationId: b.location_id,
      ownerIds: b.organiser_id ? [b.organiser_id] : [], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.update("booking_player", i.booking_player_id, { no_show: true, no_show_by: ctx.actor.personId, no_show_at: ctx.now });
    await ctx.emit("booking.no_show", { booking_player_id: i.booking_player_id });
    return null;
  },
});

/** Each person's record over the last 90 days: matches, lessons and program dates they didn't come to, and
 *  places they gave up after the deadline. A coach's "didn't come" (attendance) counts like a host's no-show;
 *  a lesson marked both ways counts once. */
export async function playerRecord(db: Db | Trx, personIds: string[], now = new Date()): Promise<Map<string, { no_shows: number; late_leaves: number }>> {
  if (!personIds.length) return new Map();
  const since = new Date(now.getTime() - 90 * 86400_000);
  const rows = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id")
    .select(["booking_player.person_id", sql<string>`count(*) FILTER (WHERE booking_player.no_show)`.as("no_shows"), sql<string>`count(*) FILTER (WHERE booking_player.late_leave)`.as("late_leaves")])
    .where("booking_player.person_id", "in", personIds).where("booking.created_at", ">=", since).groupBy("booking_player.person_id").execute();
  const out = new Map(rows.map((r) => [r.person_id!, { no_shows: Number(r.no_shows), late_leaves: Number(r.late_leaves) }]));
  const missed = await db.selectFrom("attendance").select(["attendance.person_id", sql<string>`count(*)`.as("n")])
    .where("attendance.person_id", "in", personIds).where("attendance.came", "=", false).where("attendance.marked_at", ">=", since)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("booking_player").select("booking_player.id").whereRef("booking_player.booking_id", "=", "attendance.booking_id")
      .whereRef("booking_player.person_id", "=", "attendance.person_id").where("booking_player.no_show", "=", true))))
    .groupBy("attendance.person_id").execute();
  for (const m of missed) {
    const r = out.get(m.person_id) ?? { no_shows: 0, late_leaves: 0 };
    out.set(m.person_id, { ...r, no_shows: r.no_shows + Number(m.n) });
  }
  return out;
}
