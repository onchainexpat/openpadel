// Club credit: what the club owes a member, kept in the books as theirs (a member_credit account, money.ts). It comes
// from a staff refund given back as club credit, a program's "credit inside the window" rule, or money paid from
// credit coming back; members never choose credit over their card. It never expires and can't be bought outright.
// A member uses it on a payment before its card form opens ("Use my credit", on by default): all of it, or part of a
// program place (the card pays the rest). The owner or a manager can pay it out at the desk. One person's credit is
// spent one change at a time (a lock per person), so two checkouts at once can't both spend the same dollars.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, money, type Text } from "@kumi/i18n";
import { defineAction, readRow } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { account, creditBalance, post } from "./money.ts";
import { kidOf, paymentWhat } from "./kids.ts";
import { askAgain, paidNow } from "./programs.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });

/** One person's credit, spent or paid out one change at a time: held until this change commits. */
export async function lockCredit(trx: Trx, personId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`credit:${personId}`}, 0))`.execute(trx);
}

/** What a member's credit has been: each time it came or went, newest first, with what the books say it was. */
export async function creditHistory(db: Db | Trx, personId: string, o: { all?: boolean } = {}) {
  const rows = await db.selectFrom("ledger_entry").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id").innerJoin("ledger_txn", "ledger_txn.id", "ledger_entry.txn_id")
    .select(["ledger_txn.at", "ledger_txn.kind", "ledger_txn.memo", "ledger_entry.amount_cents"]).where("ledger_account.kind", "=", "member_credit").where("ledger_account.person_id", "=", personId)
    // The app shows the latest; a member's download has all of it.
    .orderBy("ledger_txn.at", "desc").orderBy("ledger_entry.id", "desc").$if(!o.all, (q) => q.limit(200)).execute();
  // A liability: credit given is a negative entry, credit used a positive one.
  return rows.map((r) => ({ at: r.at, cents: -Number(r.amount_cents), kind: r.kind, memo: r.memo }));
}

/** All the club credit members hold (Reports): what the club owes them. */
export async function outstandingCredit(db: Db | Trx): Promise<{ cents: number; people: number }> {
  const r = await db.selectFrom("member_credit_balance").select([sql<string>`coalesce(sum(cents), 0)`.as("c"), sql<string>`count(*) FILTER (WHERE cents > 0)`.as("n")])
    .where("person_id", "is not", null).executeTakeFirst();
  return { cents: Number(r?.c ?? 0), people: Number(r?.n ?? 0) };
}

/** Why credit can't pay for this payment, if it can't: a membership (it renews from a card), one that saves a card
 *  for a later charge, several paid together, a kid's (the family card pays those), or a card form already open. */
async function whyNot(db: Db | Trx, pay: { person_id: string; status: string; provider_ref: string | null; group_id: string | null; save_card: boolean; membership_id: string | null; membership_plan_id: string | null; family_card_id: string | null; parent_to_pay_at: Date | null; gift_card_id: string | null; pass_id: string | null }) {
  if (pay.status !== "pending") return "error.credit_paid";
  if (pay.gift_card_id) return "error.credit_gift_card";
  if (pay.pass_id) return "error.credit_pass";
  if (pay.provider_ref) return "error.credit_card_open";
  if (pay.membership_id || pay.membership_plan_id) return "error.credit_membership";
  if (pay.save_card) return "error.credit_saves_card";
  if (pay.group_id) return "error.credit_group";
  if (pay.family_card_id || pay.parent_to_pay_at || await kidOf(db, pay.person_id)) return "error.credit_kid";
  return null;
}

/** A member pays (all or part of) one of their payments from their club credit, before its card form opens. All of
 *  it: the payment goes through from credit, as a card's would. Part (a program place only, as at the desk): that part
 *  is paid from credit and the card is asked for the rest, a new payment the app opens next. A court is paid from
 *  credit only all at once: a court held for a card that never comes is let go, and part paid would be stranded. */
export const paymentUseCredit = defineAction({
  name: "payment.use_credit", version: 1,
  input: z.object({ payment_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "payment", i.payment_id, "thing.payment");
    const pay = await ctx.db.selectFrom("payment").selectAll().where("id", "=", i.payment_id).executeTakeFirstOrThrow();
    // Only the member themselves, before anything about their credit is said.
    if (!ctx.actor.personId || ctx.actor.personId !== pay.person_id) throw new KumiError("error.forbidden", {}, 403);
    const why = await whyNot(ctx.db, pay);
    if (why) throw new KumiError(why);
    const have = await creditBalance(ctx.db, pay.person_id);
    if (have <= 0) throw new KumiError("error.credit_none");
    const cents = Math.min(have, pay.amount_cents), full = cents === pay.amount_cents;
    if (!full && !pay.enrolment_id) throw new KumiError("error.credit_part_court", { credit: usd(have), amount: usd(pay.amount_cents) });
    const what = await paymentWhat(ctx.db, pay);
    return { title: both("action.payment.use_credit"), reads: [read], ownerIds: [pay.person_id], moneyCents: cents, undo: { kind: "none", note: both("undo.none", { reason: both("reason.refund_sent") }) },
      summary: full ? both("plan.payment.use_credit", { amount: usd(cents), what }) : both("plan.payment.use_credit_part", { amount: usd(cents), what, rest: usd(pay.amount_cents - cents) }),
      details: { cents, full } };
  },
  async apply(ctx, i, plan) {
    const planned = plan.details as { cents: number; full: boolean };
    const first = await ctx.trx.selectFrom("payment").select("person_id").where("id", "=", i.payment_id).executeTakeFirstOrThrow();
    await lockCredit(ctx.trx, first.person_id);
    const pay = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", i.payment_id).forUpdate().executeTakeFirstOrThrow();
    // Again under the locks: another checkout may have spent the credit, or the card form opened, meanwhile.
    if (await whyNot(ctx.trx, pay)) throw new KumiError("error.changed");
    const have = await creditBalance(ctx.trx, pay.person_id), cents = Math.min(have, pay.amount_cents);
    if (cents !== planned.cents || (cents === pay.amount_cents) !== planned.full) throw new KumiError("error.changed");
    if (planned.full) { await paidNow(ctx, pay, { from: "member_credit" }); return { paid: true, payment_id: pay.id }; }
    // Part of a place: paid from credit (as the desk records part), and the card asked for the rest.
    const id = uuidv7();
    await ctx.insert("payment", { id, person_id: pay.person_id, amount_cents: cents, method: "credit", provider: "none", provider_ref: null, status: "succeeded", enrolment_id: pay.enrolment_id });
    await post(ctx.trx, ctx.runId, "payment", "program place from club credit", [
      { account: await account(ctx.trx, "member_credit", { personId: pay.person_id }), cents },
      { account: await account(ctx.trx, "revenue", { revenueType: "programs" }), cents: -cents }]);
    const rest = await askAgain(ctx, pay.id, pay.amount_cents - cents);
    return { paid: false, credit_payment_id: id, payment_id: rest, rest_cents: pay.amount_cents - cents };
  },
});

/** The owner or a manager pays a member's club credit out at the desk (in cash, or another way): it leaves their
 *  credit and the drawer (or clearing) in the books, and shows on the desk's day as money handed back. Never more
 *  than they hold. Money going back, so it works while the club is read-only. */
export const creditPayOut = defineAction({
  name: "credit.pay_out", version: 1, clubWide: true,
  input: z.object({ person_id: z.uuid(), cents: z.number().check(z.int(), z.minimum(1)), method: z.enum(["cash", "other"]), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const have = await creditBalance(ctx.db, i.person_id);
    if (i.cents > have) throw new KumiError("error.credit_more_than_held", { name: p.display_name, amount: usd(have) });
    // Where their credit came from: gift cards redeemed (and of those, any bought by card) or refunds. Paying out
    // credit from a card-bought gift card in cash is how a stolen card is cashed out: the preview says so, and the
    // owner or manager decides.
    const g = await ctx.db.selectFrom("gift_card").leftJoin("payment", (j) => j.onRef("payment.gift_card_id", "=", "gift_card.id").on("payment.status", "=", "succeeded"))
      .select([sql<string>`coalesce(sum(gift_card.amount_cents), 0)`.as("all"),
        sql<string>`coalesce(sum(gift_card.amount_cents) FILTER (WHERE payment.provider <> 'none' OR payment.method = 'terminal'), 0)`.as("card")])
      .where("gift_card.redeemed_by", "=", i.person_id).where("gift_card.status", "=", "redeemed").executeTakeFirstOrThrow();
    const fromCards = Number(g.all), byCard = Number(g.card);
    const base = both("plan.credit.pay_out", { name: p.display_name, amount: usd(i.cents), how: both(`paid_by.${i.method}`), left: usd(have - i.cents) });
    const notes = [fromCards > 0 ? both("plan.credit.pay_out_gift", { amount: usd(fromCards) }) : null, byCard > 0 ? both("plan.credit.pay_out_card_warn", { amount: usd(byCard) }) : null].filter((x): x is Text => Boolean(x));
    const summary = { en: [base.en, ...notes.map((x) => x.en)].join(" "), es: [base.es, ...notes.map((x) => x.es)].join(" ") };
    return { title: both("action.credit.pay_out"), reads: [read], ownerIds: [i.person_id], moneyCents: i.cents, undo: { kind: "none", note: both("undo.none", { reason: both("reason.refund_sent") }) },
      summary, details: { from_gift_cards: fromCards, gift_cards_by_card: byCard } };
  },
  async apply(ctx, i) {
    await lockCredit(ctx.trx, i.person_id);
    if (i.cents > await creditBalance(ctx.trx, i.person_id)) throw new KumiError("error.changed");
    await ctx.insert("credit_payout", { id: uuidv7(), person_id: i.person_id, amount_cents: i.cents, method: i.method, note: i.note ?? null, action_run_id: ctx.runId, at: ctx.now });
    await post(ctx.trx, ctx.runId, "credit_payout", `club credit paid out at the desk (${i.method})${i.note ? `: ${i.note}` : ""}`, [
      { account: await account(ctx.trx, "member_credit", { personId: i.person_id }), cents: i.cents },
      { account: await account(ctx.trx, i.method === "cash" ? "cash_drawer" : "provider_clearing"), cents: -i.cents }]);
    return null;
  },
});
