// Open matches, the parts around joining: a player outside the band asks the host, who says yes (their
// seat is then held an hour while they pay) or no; seats taken and not paid for open again; and at the
// club's deadline, what's unpaid goes on the host's card. A payment whose card form was opened is called
// off at the provider before it's given up, so a late payment can't go through unrecorded.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, money, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { paymentProvider } from "./money.ts";
import { abandonPayment } from "./programs.ts";
import { shares } from "./booking_pay.ts";
import { band, levelOf, openMatchOf } from "./match_rules.ts";

/** How long a player the host said yes to has to pay before the seat opens again. */
export const APPROVED_HOLD_MINUTES = 60;
const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });

/** The match a booking is, with when and where, its host, and who's in it now. */
async function matchFacts(db: Db | Trx, bookingId: string) {
  const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
    .innerJoin("location", "location.id", "court.location_id").leftJoin("person", "person.id", "booking.organiser_id")
    .select(["booking.id", "booking.status", "booking.players", "booking.price_cents", "booking.settled_at", "booking.organiser_id", "booking.location_id", "court.name as court", "location.time_zone",
      "person.display_name as host", sql<Date>`lower(court_time.during)`.as("start")])
    .where("booking.id", "=", bookingId).where("court_time.active", "=", true).executeTakeFirst();
  if (!b) throw new KumiError("error.not_found", { thing: both("thing.booking") }, 404);
  const om = await openMatchOf(db, bookingId);
  if (!om) throw new KumiError("error.not_open_match");
  const seated = Number((await db.selectFrom("booking_player").select(sql<string>`count(*)`.as("n")).where("booking_id", "=", bookingId).where("removed_at", "is", null).executeTakeFirstOrThrow()).n);
  const when: Text = { en: dateTime(new Date(b.start), "en", b.time_zone), es: dateTime(new Date(b.start), "es", b.time_zone) };
  return { ...b, om, seated, when, share: shares(b.price_cents, b.players).each };
}
const isOpen = (m: { status: string; settled_at: Date | null; start: Date }, now: Date) => m.status === "confirmed" && !m.settled_at && new Date(m.start) > now;

export const bookingAsk = defineAction({
  name: "booking.ask", version: 1,
  input: z.object({ booking_id: z.uuid(), person_id: z.uuid(), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
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

/** "Pay my part" bookings (open matches among them) at their deadline: whatever is unpaid goes on the
 *  organiser's saved card, once. Card forms still open are called off first. */
export async function settleShares(db: Db, now = new Date()) {
  const due = await db.selectFrom("booking").innerJoin("booking_policy", "booking_policy.id", "booking.policy_id").innerJoin("court_time", "court_time.booking_id", "booking.id")
    .select(["booking.id"]).distinct().where("booking.pay_mode", "=", "split").where("booking.status", "=", "confirmed").where("booking.settled_at", "is", null).where("court_time.active", "=", true)
    .where(sql<boolean>`lower(court_time.during) - make_interval(hours => booking_policy.split_deadline_hours) <= ${now}`).execute();
  let charged = 0, failed = 0;
  for (const b of due) {
    for (const pay of await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id")
      .where("booking_player.booking_id", "=", b.id).where("payment.status", "=", "pending").where("payment.provider_ref", "is not", null).execute())
      await abandonPayment(db, pay.id, "job:settle", now);
    const r = await runAsSystem(db, "booking.settle_shares", { booking_id: b.id }, "jobs", { now });
    if ((r.result as { charged?: number })?.charged) charged++; else if ((r.result as { owed?: number })?.owed) failed++;
  }
  return { settled: due.length, charged, failed };
}
