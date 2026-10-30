// Someone else takes a player's place in a match. Up to the start, a player who can't make it offers their
// place to a friend, or makes a link for anyone inside the band; the sub pays in the app, and only then is
// the place theirs and the player paid back (afterBookingPayment). After the deadline, staff fill the place
// of a player who backed out without a sub: open it in the app, or give it to someone free. What the player
// gets back is the club's rule for each case, which staff can set aside (rule 9: leaving and refunding are
// separate decisions).
import { randomBytes } from "node:crypto";
import * as z from "zod/mini";
import { both, money, type Text } from "@kumi/i18n";
import { defineAction, readRow } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { paymentProvider } from "./money.ts";
import { HOLD_MINUTES, pastDeadline, policyOf, refundTarget, refundUpTo } from "./booking_pay.ts";
import { endOffer, matchFacts, paidBy, seatOf } from "./open_matches.ts";
import { areFriends } from "./friends.ts";
import { band, joinRule, levelOf } from "./match_rules.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const NOTHING: Text = { en: "", es: "" };
const nameOf = async (db: Db | Trx, personId: string) => (await readRow(db, "person", personId, "thing.person")).row.display_name as string;
const notStarted = (m: { status: string; start: Date }, now: Date) => {
  if (m.status !== "confirmed" || new Date(m.start) <= now) throw new KumiError("error.match_started");
};
/** A level as players see it, or "no level yet". */
const levelText = (level: number | null): Text => level === null ? both("plan.booking.no_level") : { en: level.toFixed(2), es: level.toFixed(2) };

/** An offer's place, with the match it's in. */
async function offerFacts(db: Db | Trx, by: { code?: string; id?: string }) {
  const o = await db.selectFrom("place_offer").selectAll().$if(Boolean(by.code), (q) => q.where("code", "=", by.code!)).$if(Boolean(by.id), (q) => q.where("id", "=", by.id!)).executeTakeFirst();
  if (!o) throw new KumiError("error.offer_unknown", {}, 404);
  const place = await db.selectFrom("booking_player").selectAll().where("id", "=", o.booking_player_id).executeTakeFirstOrThrow();
  return { o, place, m: await matchFacts(db, place.booking_id), from: await nameOf(db, place.person_id!) };
}

/** Someone paying to take over this place right now (their seat held while they pay). */
async function subPaying(db: Db | Trx, placeId: string, now: Date) {
  return (await db.selectFrom("booking_player").select(["id", "person_id"]).where("replaces", "=", placeId).where("removed_at", "is", null).where("held_until", ">", now).executeTakeFirst()) ?? null;
}

export const bookingOfferPlace = defineAction({
  name: "booking.offer_place", version: 1,
  // To a friend by name, or (no friend) as a link for anyone inside the band.
  input: z.object({ booking_id: z.uuid(), person_id: z.uuid(), to_person_id: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const m = await matchFacts(ctx.db, i.booking_id);
    if (i.person_id === m.organiser_id) throw new KumiError("error.host_cancels");
    const seat = await seatOf(ctx.db, i.booking_id, i.person_id);
    if (!seat || seat.leaving_at || seat.replaces) throw new KumiError("error.not_in_match");
    notStarted(m, ctx.now);
    if (!(await paidBy(ctx.db, seat.id))) throw new KumiError("error.offer_unpaid");
    let friend = "";
    if (i.to_person_id) {
      if (!(await areFriends(ctx.db, i.person_id, i.to_person_id))) throw new KumiError("error.sub_not_friend");
      friend = await nameOf(ctx.db, i.to_person_id);
      if (await seatOf(ctx.db, i.booking_id, i.to_person_id)) throw new KumiError("error.sub_in_match", { name: friend });
      const level = await levelOf(ctx.db, i.to_person_id);
      if (joinRule(m.om, level) !== "join") throw new KumiError("error.sub_outside_band", { name: friend, level: levelText(level), band: band(m.om) });
    }
    // What comes back when the sub pays: all of it before the deadline; after it, the club's rule for a sub.
    const policy = await policyOf(ctx.db, i.booking_id), late = await pastDeadline(ctx.db, i.booking_id, ctx.now);
    const back = usd((await refundTarget(ctx.db, seat.id, late ? policy.late_sub_refund_percent : 100)).total);
    const later = !late && policy.late_sub_refund_percent < 100
      ? both("plan.booking.offer_after_deadline", { amount: usd((await refundTarget(ctx.db, seat.id, policy.late_sub_refund_percent)).total) }) : NOTHING;
    const p = { friend, court: m.court, when: m.when, share: usd(seat.share_cents), back, later, band: band(m.om) };
    return { title: both("action.booking.offer_place"), summary: both(i.to_person_id ? "plan.booking.offer_place_friend" : "plan.booking.offer_place_link", p),
      reads: [], locationId: m.location_id, ownerIds: [i.person_id], undo: { kind: "reversible" }, details: { seat: seat.id } };
  },
  async apply(ctx, i, plan) {
    const { seat } = plan.details as { seat: string };
    await ctx.trx.selectFrom("booking").select("id").where("id", "=", i.booking_id).forUpdate().execute();
    await endOffer(ctx, seat);   // a new offer replaces an old one
    const id = uuidv7(), code = randomBytes(9).toString("base64url");
    await ctx.insert("place_offer", { id, booking_player_id: seat, to_person_id: i.to_person_id ?? null, code });
    await ctx.emit("booking.place_offered", { offer_id: id });
    return { offer_id: id, code };
  },
});

export const bookingWithdrawOffer = defineAction({
  name: "booking.withdraw_offer", version: 1,
  input: z.object({ offer_id: z.uuid() }),
  async plan(ctx, i) {
    const { o, place, m } = await offerFacts(ctx.db, { id: i.offer_id });
    if (o.status !== "offered") throw new KumiError("error.offer_closed");
    return { title: both("action.booking.withdraw_offer"), summary: both("plan.booking.withdraw_offer", { court: m.court, when: m.when }), reads: [{ entity: "place_offer" as const, id: o.id, version: o.version }],
      locationId: m.location_id, ownerIds: [place.person_id!], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const o = await ctx.trx.selectFrom("place_offer").select("booking_player_id").where("id", "=", i.offer_id).executeTakeFirstOrThrow();
    await endOffer(ctx, o.booking_player_id);
    return null;
  },
});

export const bookingTakePlace = defineAction({
  name: "booking.take_place", version: 1,
  input: z.object({ code: z.string().check(z.minLength(8), z.maxLength(40)), person_id: z.uuid() }),
  async plan(ctx, i) {
    const { o, place, m, from } = await offerFacts(ctx.db, { code: i.code });
    if (o.status !== "offered" || place.removed_at) throw new KumiError("error.offer_closed");
    if (o.to_person_id && o.to_person_id !== i.person_id) throw new KumiError("error.offer_not_yours");
    notStarted(m, ctx.now);
    if (await seatOf(ctx.db, place.booking_id, i.person_id)) throw new KumiError("error.already_in_booking");
    const level = await levelOf(ctx.db, i.person_id);
    if (joinRule(m.om, level) !== "join") throw new KumiError("error.take_outside_band", { level: levelText(level), band: band(m.om) });
    if (await subPaying(ctx.db, place.id, ctx.now)) throw new KumiError("error.offer_being_taken");
    return { title: both("action.booking.take_place"), summary: both("plan.booking.take_place", { name: from, court: m.court, when: m.when, share: usd(place.share_cents) }),
      reads: [], locationId: m.location_id, ownerIds: [i.person_id], moneyCents: place.share_cents, undo: { kind: "compensating" }, details: { place: place.id, booking_id: place.booking_id, share: place.share_cents } };
  },
  async apply(ctx, i, plan) {
    const { place, booking_id, share } = plan.details as { place: string; booking_id: string; share: number };
    await ctx.trx.selectFrom("booking").select("id").where("id", "=", booking_id).forUpdate().execute();   // one at a time
    const o = await ctx.trx.selectFrom("place_offer").select("status").where("booking_player_id", "=", place).where("status", "=", "offered").executeTakeFirst();
    if (!o || await subPaying(ctx.trx, place, ctx.now)) throw new KumiError("error.changed");
    // The sub's seat is held while they pay, in place of the other player's: theirs once paid.
    const bp = uuidv7(), payment = uuidv7();
    await ctx.insert("booking_player", { id: bp, booking_id, person_id: i.person_id, share_cents: share, held_until: new Date(ctx.now.getTime() + HOLD_MINUTES * 60_000), replaces: place });
    await ctx.insert("payment", { id: payment, person_id: i.person_id, amount_cents: share, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", booking_player_id: bp });
    return { booking_id, payment_id: payment };
  },
});

// ---- Staff fill a late leaver's place ----
const refundChoice = z.optional(z.enum(["rule", "full", "none"]));
/** A place its player gave up after the deadline (still theirs on paper, and empty). */
async function emptyPlace(db: Db | Trx, seatId: string, now: Date) {
  const { row: p, read } = await readRow(db, "booking_player", seatId, "thing.booking");
  if (p.removed_at || !p.leaving_at) throw new KumiError("error.place_not_empty");
  const m = await matchFacts(db, p.booking_id);
  notStarted(m, now);
  return { p, read, m, person: await nameOf(db, p.person_id) };
}
/** What staff chose for the player's money: the club's rule for this case, everything, or nothing more. */
async function refundFor(db: Db | Trx, bookingId: string, seatId: string, choice: "rule" | "full" | "none", rule: "late_filled_refund_percent" | "late_empty_refund_percent") {
  const policy = await policyOf(db, bookingId);
  const percent = choice === "full" ? 100 : choice === "none" ? 0 : policy[rule];
  const why = choice === "rule" ? both(rule === "late_filled_refund_percent" ? "refund.why_filled" : "refund.why_empty", { percent }) : both(choice === "full" ? "refund.why_full" : "refund.why_none");
  return { percent, why, total: usd((await refundTarget(db, seatId, percent)).total) };
}

export const bookingReopenPlace = defineAction({
  name: "booking.reopen_place", version: 1,
  input: z.object({ booking_player_id: z.uuid(), refund: refundChoice }),
  async plan(ctx, i) {
    const { p, read, m, person } = await emptyPlace(ctx.db, i.booking_player_id, ctx.now);
    if (p.fill_refund_percent !== null) throw new KumiError("error.place_open_already");
    const r = await refundFor(ctx.db, p.booking_id, p.id, i.refund ?? "rule", "late_filled_refund_percent");
    return { title: both("action.booking.reopen_place"), reads: [read], locationId: m.location_id, undo: { kind: "reversible" }, details: { percent: r.percent },
      summary: both("plan.booking.reopen_place", { person, court: m.court, when: m.when, band: band(m.om), share: usd(p.share_cents), total: r.total, why: r.why }) };
  },
  async apply(ctx, i, plan) {
    await ctx.update("booking_player", i.booking_player_id, { fill_refund_percent: (plan.details as { percent: number }).percent });
    return null;
  },
});

export const bookingGivePlace = defineAction({
  name: "booking.give_place", version: 1,
  input: z.object({ booking_player_id: z.uuid(), person_id: z.uuid(), refund: refundChoice }),
  async plan(ctx, i) {
    const { p, read, m, person } = await emptyPlace(ctx.db, i.booking_player_id, ctx.now);
    const to = await readRow(ctx.db, "person", i.person_id, "thing.person");
    if (to.row.status !== "active" || to.row.redacted_at) throw new KumiError("error.not_found", { thing: both("thing.person") }, 404);
    if (await seatOf(ctx.db, p.booking_id, i.person_id)) throw new KumiError("error.sub_in_match", { name: to.row.display_name });
    const r = await refundFor(ctx.db, p.booking_id, p.id, i.refund ?? "rule", "late_empty_refund_percent");
    return { title: both("action.booking.give_place"), reads: [read], locationId: m.location_id, undo: { kind: "none" }, details: { percent: r.percent, booking_id: p.booking_id },
      summary: both("plan.booking.give_place", { person, to: to.row.display_name, court: m.court, when: m.when, total: r.total, why: r.why }) };
  },
  async apply(ctx, i, plan) {
    const { percent, booking_id } = plan.details as { percent: number; booking_id: string };
    await ctx.trx.selectFrom("booking").select("id").where("id", "=", booking_id).forUpdate().execute();
    const seat = uuidv7();
    await ctx.insert("booking_player", { id: seat, booking_id, person_id: i.person_id, share_cents: 0 });
    await ctx.update("booking_player", i.booking_player_id, { removed_at: ctx.now });
    const refunded = await refundUpTo(ctx, i.booking_player_id, percent);
    await ctx.emit("booking.place_given", { from_seat: i.booking_player_id, to_seat: seat, refunded });
    return { booking_player_id: seat };
  },
});
