// Promo codes: the owner or a manager makes one (a percentage or an amount off), for court bookings, program places or
// a membership's first payment, between dates if the club wants, with a total number of uses, uses per person and a
// smallest spend. Never on a gift card or a pass, never on a renewal. One code per payment, applied before its card
// form opens (a card form already open can't change): the payment is asked again for the lower amount, a new
// payment, so the card is never asked for the old one; all of it off, it goes through with nothing to pay. The
// discount shows on the receipt. A code is used one change at a time (a lock per code), so two checkouts at once
// can't both take its last use; a use whose payment is never paid doesn't count.
import * as z from "zod/mini";
import { sql } from "kysely";
import type { Selectable } from "kysely";
import { both, money, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow } from "./actions.ts";
import type { DB, Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { kidOf, paymentWhat } from "./kids.ts";
import { askAgain, paidNow } from "./programs.ts";
import { bookingRevenue } from "./desk_pay.ts";
import { oneAtATime } from "./gift_cards.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const AREAS = ["courts", "lessons", "programs", "memberships"] as const;
type Area = typeof AREAS[number];

async function lockCode(trx: Trx, id: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`promo:${id}`}, 0))`.execute(trx);
}
const normal = (code: string) => code.trim().toUpperCase();

/** What a payment is, for a code, or why no code can lower it. */
async function areaOf(db: Db | Trx, pay: Selectable<DB["payment"]>): Promise<Area | { why: Key }> {
  if (pay.status !== "pending") return { why: "error.promo_paid" };
  if (pay.provider_ref) return { why: "error.promo_card_open" };
  if (pay.promo_code_id) return { why: "error.promo_one" };
  if (pay.gift_card_id || pay.pass_id) return { why: "error.promo_not_for_this" };
  if (pay.group_id || pay.membership_id) return { why: "error.promo_not_for_this" };
  if (pay.family_card_id || pay.parent_to_pay_at || await kidOf(db, pay.person_id)) return { why: "error.promo_not_for_this" };
  // One code for a place or a court's player, whichever payment it's on: asked again, the code stays on the new one.
  if (pay.enrolment_id || pay.booking_player_id) {
    const used = await db.selectFrom("promo_use").innerJoin("payment", "payment.id", "promo_use.payment_id").select("promo_use.id").where("payment.status", "!=", "failed")
      .where((w) => pay.enrolment_id ? w("payment.enrolment_id", "=", pay.enrolment_id) : w("payment.booking_player_id", "=", pay.booking_player_id!)).executeTakeFirst();
    if (used) return { why: "error.promo_one" };
  }
  if (pay.membership_plan_id) return "memberships";
  if (pay.enrolment_id) return "programs";
  // A court booking's or a coach's lesson's: lessons are their own (their price is the coach's).
  if (pay.booking_player_id) return await bookingRevenue(db, pay.booking_player_id);
  return { why: "error.promo_not_for_this" };
}
/** What a code's percentage and smallest spend are worked out on: the whole price of what's paid for, before part of
 *  it was paid another way (club credit, the desk), not the rest still asked. The discount is capped by that rest. */
async function priceOf(db: Db | Trx, pay: Selectable<DB["payment"]>): Promise<number> {
  if (pay.enrolment_id) return (await db.selectFrom("enrolment").select("price_cents").where("id", "=", pay.enrolment_id).executeTakeFirstOrThrow()).price_cents;
  if (pay.booking_player_id) {
    const r = await db.selectFrom("payment").select(sql<string>`coalesce(sum(amount_cents), 0)`.as("c")).where("booking_player_id", "=", pay.booking_player_id).where("status", "=", "succeeded").executeTakeFirstOrThrow();
    return pay.amount_cents + Number(r.c);
  }
  return pay.amount_cents;
}
/** Uses that count: those whose payment went through or may still. */
async function usesOf(db: Db | Trx, codeId: string, personId?: string) {
  const r = await db.selectFrom("promo_use").innerJoin("payment", "payment.id", "promo_use.payment_id").select(sql<string>`count(*)`.as("n"))
    .where("promo_use.promo_code_id", "=", codeId).where("payment.status", "!=", "failed").$if(Boolean(personId), (q) => q.where("promo_use.person_id", "=", personId!)).executeTakeFirstOrThrow();
  // And those made after the copy a restore brought back (their payments aren't here): they still count.
  const before = await db.selectFrom("promo_use_before_restore").select(sql<string>`coalesce(sum(n), 0)`.as("n")).where("promo_code_id", "=", codeId)
    .$if(Boolean(personId), (q) => q.where("person_id", "=", personId!)).executeTakeFirstOrThrow();
  return Number(r.n) + Number(before.n);
}
/** The code and what it takes off this payment, or why it can't. A code that isn't for this payment, or that this
 *  person has used up, gets the same answer as one that doesn't exist: a private code can't be found by guessing. */
async function discountFor(db: Db | Trx, pay: Selectable<DB["payment"]>, code: string, now: Date) {
  const area = await areaOf(db, pay);
  if (typeof area !== "string") throw new KumiError(area.why);
  const c = await db.selectFrom("promo_code").selectAll().where(sql<string>`upper(code)`, "=", normal(code)).executeTakeFirst();
  if (!c || !c.active || !c.applies_to.includes(area)) throw new KumiError("error.promo_unknown");
  if ((c.starts_at && now < c.starts_at) || (c.ends_at && now >= c.ends_at)) throw new KumiError("error.promo_dates");
  const price = await priceOf(db, pay);
  if (price < c.min_spend_cents) throw new KumiError("error.promo_min_spend", { amount: usd(c.min_spend_cents) });
  if (c.max_uses != null && await usesOf(db, c.id) >= c.max_uses) throw new KumiError("error.promo_used_up");
  if (await usesOf(db, c.id, pay.person_id) >= c.max_per_person) throw new KumiError("error.promo_unknown");
  const off = Math.min(pay.amount_cents, c.kind === "percent" ? Math.floor(price * c.percent! / 100) : c.amount_cents!);
  if (off <= 0) throw new KumiError("error.promo_unknown");
  // A payment that saves the card for later (a membership's first, a split court's organiser) can't be made free:
  // the card is needed for what comes after (renewals, the deadline charge).
  if (pay.save_card && off >= pay.amount_cents) throw new KumiError("error.promo_saves_card", { max: usd(Math.max(0, pay.amount_cents - 50)) });
  return { code: c, off };
}
/** Wrong codes a person may try in an hour before codes are refused for a while (as gift card codes are). */
export const PROMO_TRIES_PER_HOUR = 10;
/** One person's tries at a code, one at a time: refused past PROMO_TRIES_PER_HOUR wrong ones in an hour, and a code
 *  that doesn't exist (or is off) counts as one, kept even though the preview is refused. */
async function countTry(db: Db | Trx, personId: string, code: string, now: Date) {
  const r = await oneAtATime(db, `promo_try:${personId}`, async (trx) => {
    const n = await trx.selectFrom("promo_try").select(sql<string>`count(*)`.as("n")).where("person_id", "=", personId).where("at", ">", new Date(now.getTime() - 3600_000)).executeTakeFirstOrThrow();
    if (Number(n.n) >= PROMO_TRIES_PER_HOUR) return "tries" as const;
    const c = await trx.selectFrom("promo_code").select(["id", "active"]).where(sql<string>`upper(code)`, "=", normal(code)).executeTakeFirst();
    if (!c || !c.active) { await trx.insertInto("promo_try").values({ person_id: personId, at: now }).execute(); return "unknown" as const; }
    return "ok" as const;
  });
  if (r === "tries") throw new KumiError("error.promo_tries");
  if (r === "unknown") throw new KumiError("error.promo_unknown");
}

/** A member (or the desk for them) applies a code to a payment before its card form opens: asked again for what's
 *  left, or paid, all of it off. */
export const paymentUsePromo = defineAction({
  name: "payment.use_promo", version: 1,
  input: z.object({ payment_id: z.uuid(), code: z.string().check(z.minLength(2), z.maxLength(40)) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "payment", i.payment_id, "thing.payment");
    const pay = await ctx.db.selectFrom("payment").selectAll().where("id", "=", i.payment_id).executeTakeFirstOrThrow();
    await countTry(ctx.db, ctx.actor.personId ?? pay.person_id, i.code, ctx.now);
    const { code, off } = await discountFor(ctx.db, pay, i.code, ctx.now);
    const left = pay.amount_cents - off;
    return { title: both("action.payment.use_promo"), reads: [read], ownerIds: [pay.person_id], undo: { kind: "none", note: both("undo.none", { reason: both("reason.refund_sent") }) },
      summary: both(left > 0 ? "plan.payment.use_promo" : "plan.payment.use_promo_free", { code: code.code, off: usd(off), left: usd(left), what: await paymentWhat(ctx.db, pay) }),
      details: { code_id: code.id, off } };
  },
  async apply(ctx, i, plan) {
    const planned = plan.details as { code_id: string; off: number };
    await lockCode(ctx.trx, planned.code_id);
    const pay = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", i.payment_id).forUpdate().executeTakeFirstOrThrow();
    // Again under the locks: another checkout may have taken the code's last use, or the card form opened, meanwhile.
    let now;
    try { now = await discountFor(ctx.trx, pay, i.code, ctx.now); } catch { throw new KumiError("error.changed"); }
    if (now.code.id !== planned.code_id || now.off !== planned.off) throw new KumiError("error.changed");
    const left = pay.amount_cents - now.off;
    if (left <= 0) {
      await ctx.update("payment", pay.id, { promo_code_id: now.code.id, discount_cents: now.off });
      await ctx.insert("promo_use", { id: uuidv7(), promo_code_id: now.code.id, payment_id: pay.id, person_id: pay.person_id, discount_cents: now.off, at: ctx.now });
      await paidNow(ctx, { ...pay, promo_code_id: now.code.id, discount_cents: now.off }, { from: "promo" });
      return { paid: true, payment_id: pay.id };
    }
    const id = await askAgain(ctx, pay.id, left);
    await ctx.update("payment", id!, { promo_code_id: now.code.id, discount_cents: now.off });
    await ctx.insert("promo_use", { id: uuidv7(), promo_code_id: now.code.id, payment_id: id!, person_id: pay.person_id, discount_cents: now.off, at: ctx.now });
    return { paid: false, payment_id: id, rest_cents: left };
  },
});

const codeInput = {
  code: z.string().check(z.regex(/^[A-Za-z0-9_-]{3,24}$/)), kind: z.enum(["percent", "amount"]),
  percent: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(100)))), amount_cents: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1)))),
  applies_to: z.array(z.enum(AREAS)).check(z.minLength(1)), starts_at: z.optional(z.nullable(z.iso.datetime({ offset: true }))), ends_at: z.optional(z.nullable(z.iso.datetime({ offset: true }))),
  max_uses: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1)))), max_per_person: z.optional(z.number().check(z.int(), z.minimum(1))),
  min_spend_cents: z.optional(z.number().check(z.int(), z.minimum(0))), active: z.optional(z.boolean()),
};
/** The owner or a manager makes a promo code, changes one, or turns it off. */
export const promoCodeSet = defineAction({
  name: "promo_code.set", version: 1, clubWide: true,
  input: z.object({ promo_code_id: z.optional(z.uuid()), ...codeInput }),
  async plan(ctx, i) {
    if (i.kind === "percent" ? !i.percent : !i.amount_cents) throw new KumiError("error.promo_amount");
    if (i.starts_at && i.ends_at && new Date(i.ends_at) <= new Date(i.starts_at)) throw new KumiError("error.promo_dates_order");
    const same = await ctx.db.selectFrom("promo_code").select("id").where(sql<string>`upper(code)`, "=", normal(i.code)).executeTakeFirst();
    if (same && same.id !== i.promo_code_id) throw new KumiError("error.promo_taken");
    const reads = i.promo_code_id ? [(await readRow(ctx.db, "promo_code", i.promo_code_id, "thing.promo_code")).read] : [];
    const off = i.kind === "percent" ? `${i.percent}%` : usd(i.amount_cents!);
    return { title: both("action.promo_code.set"), reads, undo: { kind: "compensating" },
      summary: both(i.active === false ? "plan.promo_code.off" : i.promo_code_id ? "plan.promo_code.change" : "plan.promo_code.make",
        { code: normal(i.code), off: typeof off === "string" ? { en: off, es: off } : off, uses: i.max_uses ? String(i.max_uses) : "∞" }) };
  },
  async apply(ctx, i) {
    const row = { code: normal(i.code), kind: i.kind, percent: i.kind === "percent" ? i.percent ?? null : null, amount_cents: i.kind === "amount" ? i.amount_cents ?? null : null,
      applies_to: [...new Set(i.applies_to)], starts_at: i.starts_at ? new Date(i.starts_at) : null, ends_at: i.ends_at ? new Date(i.ends_at) : null, max_uses: i.max_uses ?? null,
      max_per_person: i.max_per_person ?? 1, min_spend_cents: i.min_spend_cents ?? 0, active: i.active ?? true };
    if (i.promo_code_id) { await ctx.update("promo_code", i.promo_code_id, row); return { promo_code_id: i.promo_code_id }; }
    const id = uuidv7();
    await ctx.insert("promo_code", { id, ...row });
    return { promo_code_id: id };
  },
});

/** The club's codes, for staff: each with the uses that count so far. */
export async function clubPromoCodes(db: Db | Trx) {
  const rows = await db.selectFrom("promo_code").selectAll().orderBy("created_at", "desc").limit(200).execute();
  return Promise.all(rows.map(async (c) => ({ ...c, used: await usesOf(db, c.id) })));
}
/** Whether any code could be used now (the pay sheet then asks for one). */
export async function promosOn(db: Db | Trx, now: Date) {
  return Boolean(await db.selectFrom("promo_code").select("id").where("active", "=", true).where((w) => w.or([w("ends_at", "is", null), w("ends_at", ">", now)])).executeTakeFirst());
}
