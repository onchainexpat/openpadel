// Card money the payment provider has that the club's database doesn't: after a restore, a copy from before a payment
// or a refund doesn't know of it. A payment it has no row for would go unnoticed (the money taken, nothing booked); a
// refund it has no row for could be paid a second time (a new refund, a new id, and the provider's room for it). So
// after every restore the server, as it next starts, asks the provider for what was made since the copy's newest
// payment (restore_check): a refund is recorded against its payment (so nothing goes back twice); a payment with no
// row is kept in payment_found for the staff to refund in full or record as paid elsewhere, and the owner and managers
// hear once. Nothing is refunded by itself. The provider's webhook for a paid payment Kumi has no row for lands there
// too, said the same way. A charge Kumi made by itself (a renewal, a weekly week, an unpaid share, a family card
// charge: they carry kumi_charge_id) is one the jobs make again by its key, find at the provider and record: it waits
// (status waiting) until they have run, is closed as recorded once a payment row for it appears, and only if none does
// is it listed, as a charge Kumi made that this copy doesn't know. Nothing with a payment row is ever refunded here.
// One the staff keep as paid elsewhere counts in the books as other income on the day it was paid (so Kumi's revenue
// matches the provider's), once; a refund the provider made of it takes its part back out, each refund once; and if
// Kumi records a payment row for it later (a charge of its own made again by its key), the rest comes out again, so
// the money never counts twice. After a restore it's like any other card payment: a copy from before the staff kept
// it has it open again (or finds it again at the provider), with nothing in its books, for the staff to decide again.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, money, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { account, paymentProvider, post, type FoundIntent, type FoundRefund } from "./money.ts";
import { leftOf, revenueType } from "./desk_pay.ts";
import { fitWords, jobFailed, jobWorked } from "./ops.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A payment row for this provider reference: Kumi records it (so nothing here may refund it as unknown). */
const recordedRef = (db: Db, ref: string) => db.selectFrom("payment").select("id").where("provider_ref", "=", ref).executeTakeFirst();

/** Is a payment provider account this club's? A Connect webhook endpoint hears every connected account's events
 *  (Stripe can't send a club only its own), so a payment on any other account is another club's: never kept, listed
 *  or refunded here. Under Connect: the club's connected account, or one the club's own payments were made on (a club
 *  that moved to a new account). Without Connect (direct keys, or the test provider): no account at all, since
 *  direct charges carry none. */
export async function clubsAccount(db: Db | Trx, account: string | null | undefined): Promise<boolean> {
  if (!(paymentProvider() as { connect?: boolean }).connect) return !account;
  if (!account) return false;
  if ((await db.selectFrom("club").select("stripe_account_id").executeTakeFirst())?.stripe_account_id === account) return true;
  return Boolean(await db.selectFrom("payment").select("id").where("provider_account", "=", account).limit(1).executeTakeFirst());
}

/** Rows on another club's account, kept before Kumi checked whose a webhook's event was (clubsAccount). What no staff
 *  acted on goes: it was never this club's, and it names another club's payer. What they did act on stays, as the
 *  record of it, without the payer's email or what was bought. As the server starts; nothing to do is the usual. */
export async function dropForeignFound(db: Db): Promise<{ removed: number; scrubbed: number }> {
  let removed = 0, scrubbed = 0;
  for (const f of await db.selectFrom("payment_found").select(["id", "account", "status", "email", "description"]).execute()) {
    if (await clubsAccount(db, f.account)) continue;
    if (["waiting", "open", "refund_asked"].includes(f.status)) { await forgetFound(db, f.id); removed++; } else if (f.email !== null || f.description !== null) {
      await db.updateTable("payment_found").set({ email: null, description: null, version: sql`version + 1` }).where("id", "=", f.id).execute();
      scrubbed++;
    }
  }
  return { removed, scrubbed };
}

async function forgetFound(db: Db, id: string) {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("payment_found_refund").where("payment_found_id", "=", id).execute();
    await trx.deleteFrom("payment_found").where("id", "=", id).execute();
  });
}

/** One the provider took that nothing here records: kept once. Kumi's own charges (kumiChargeId) wait for the jobs;
 *  the rest are open for the staff, who hear once. True when it's new. One on another club's account is never kept. */
export async function noteFound(db: Db, it: Omit<FoundIntent, "status" | "kumiPaymentId">, account: string | null, now = new Date(), o: { tell?: boolean } = {}): Promise<boolean> {
  if (!(await clubsAccount(db, account))) return false;
  const kumi = Boolean(it.kumiChargeId);
  const r = await db.insertInto("payment_found").values({ id: uuidv7(now.getTime()), provider: paymentProvider().name, provider_ref: it.ref, account, amount_cents: it.amountCents,
    paid_at: it.created, email: it.email, description: it.description?.slice(0, 300) ?? null, note: null, done_at: null, kind: kumi ? "kumi_charge" : "payment", status: kumi ? "waiting" : "open",
    currency: it.currency && /^[a-z]{3}$/i.test(it.currency) ? it.currency.toUpperCase() : null })
    .onConflict((oc) => oc.column("provider_ref").doNothing()).returning("id").executeTakeFirst();
  if (r && !kumi && o.tell !== false) await tellFound(db, now);
  return Boolean(r);
}
/** The staff hear once while anything is left for them (one alert; later ones join the same list on Payments, not a
 *  new alert each). It closes by itself once nothing is left (reviewFound). `stillBooked` adds what a restore's check
 *  found besides. */
async function tellFound(db: Db, now: Date, more: { stillBooked?: number } = {}) {
  const open = await db.selectFrom("payment_found").select((eb) => [eb.fn.countAll<string>().as("n")]).where("status", "=", "open").executeTakeFirstOrThrow();
  const n = Number(open.n), booked = more.stillBooked ?? 0;
  if (!n && !booked) return;
  // Both lists are on Reports. Whole sentences, the most important first: the last is left off if they don't all fit.
  const words = fitWords([n ? both("ops.why_restore_found", { count: n }) : null, booked ? both("ops.why_restore_still_booked", { count: booked }) : null,
    both("ops.why_restore_confirmations")].filter((x): x is Text => Boolean(x)));
  await jobFailed(db, "restore_money", words.en, now, words).catch((e) => console.error(`payments: couldn't tell the staff (${(e as Error).message})`));
}
/** The provider's list was cut short (20,000 of each): older card payments since the backup weren't looked at, and
 *  no later check will. An alert of its own, said once for this restore, that stays on Today until someone marks it
 *  handled: not the one above, which closes by itself when Payments has nothing left. */
async function tellUnchecked(db: Db, now: Date) {
  const words = { en: "Only the newest 20,000 card payments since the backup were checked: older ones weren't. Look for them in the payment provider's own dashboard.",
    es: "Solo se revisaron los 20.000 pagos con tarjeta más recientes desde la copia: los anteriores no. Búscalos en el panel del propio proveedor de pagos." };
  await runAsSystem(db, "ops.report_failure", { job: "restore_unchecked", error: words.en, words }, "jobs", { now }).catch((e) => console.error(`payments: couldn't tell the staff (${(e as Error).message})`));
}

/** Each job run: Kumi's own charges waiting are closed as recorded once their payment row is there, or opened for the
 *  staff once the jobs have had time to make them (15 minutes); any open one Kumi has recorded since is closed too.
 *  When nothing is left for the staff, the alert closes. */
export async function reviewFound(db: Db, now = new Date()): Promise<{ recorded: number; opened: number }> {
  let recorded = 0, opened = 0;
  for (const f of await db.selectFrom("payment_found").select(["id", "provider_ref", "status", "found_at"]).where("status", "in", ["waiting", "open"]).execute()) {
    if (await recordedRef(db, f.provider_ref)) {
      await db.updateTable("payment_found").set({ status: "recorded", done_at: now, version: sql`version + 1` }).where("id", "=", f.id).where("status", "=", f.status).execute();
      recorded++;
    } else if (f.status === "waiting" && new Date(f.found_at).getTime() <= now.getTime() - 15 * 60_000) {
      await db.updateTable("payment_found").set({ status: "open", version: sql`version + 1` }).where("id", "=", f.id).where("status", "=", "waiting").execute();
      opened++;
    }
  }
  // Kept as paid elsewhere and in the books, and Kumi records a payment for it by now (a charge of its own made again
  // by its key): that payment counts it, so it comes out of other income.
  for (const f of await db.selectFrom("payment_found").select(["id", "provider_ref"]).where("status", "=", "handled").where("booked_cents", ">", 0).execute()) {
    if (!(await recordedRef(db, f.provider_ref))) continue;
    const r = await runAsSystem(db, "payment_found.unbook", { id: f.id }, "jobs", { now });
    if ((r.result as { unbooked?: number } | null)?.unbooked) recorded++;
  }
  if (opened) await tellFound(db, now);
  const left = await db.selectFrom("payment_found").select("id").where("status", "in", ["waiting", "open", "refund_asked"]).executeTakeFirst();
  const stillBooked = await stillBookedSeen(db, now);
  if (!left && !stillBooked) await jobWorked(db, "restore_money", {}, now).catch(() => undefined);
  return { recorded, opened };
}

/** Refunds seen after a restore whose booking or place is still active here: for the staff to settle. */
export async function refundedStillBooked(db: Db, now = new Date()) {
  const bookings = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .innerJoin("booking", "booking.id", "booking_player.booking_id").innerJoin("person", "person.id", "payment.person_id")
    .select(["refund.id", "refund.amount_cents", "booking.code", "booking.id as booking_id", "person.id as person_id", "person.display_name"]).where("refund.seen_after_restore", "=", true)
    .where("booking.status", "!=", "cancelled").where(sql<boolean>`EXISTS (SELECT 1 FROM court_time ct WHERE ct.booking_id = booking.id AND ct.active AND upper(ct.during) > ${now})`).execute();
  const places = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("enrolment", "enrolment.id", "payment.enrolment_id")
    .innerJoin("program", "program.id", "enrolment.program_id").innerJoin("person", "person.id", "enrolment.person_id")
    .select(["refund.id", "refund.amount_cents", "program.name as program", "program.id as program_id", "enrolment.id as enrolment_id", "person.id as person_id", "person.display_name"]).where("refund.seen_after_restore", "=", true)
    .where("enrolment.status", "=", "booked").execute();
  return { bookings, places };
}
async function stillBookedSeen(db: Db, now: Date) { const r = await refundedStillBooked(db, now).catch(() => ({ bookings: [], places: [] })); return r.bookings.length + r.places.length; }

/** After a restore (restore_check), as the server starts: what the provider has from after the copy. */
export async function checkMoneyAfterRestore(db: Db, now = new Date()): Promise<{ found: number; refunds: number; checked: number }> {
  const marks = await db.selectFrom("restore_check").selectAll().where("done_at", "is", null).orderBy("id").execute().catch(() => []);
  let found = 0, refunds = 0, cut = false;
  const provider = paymentProvider();
  for (const m of marks) {
    if (provider.listSince) {
      const acct = (await db.selectFrom("payment").select("provider_account").where("provider", "=", provider.name).orderBy("created_at", "desc").limit(1).executeTakeFirst())?.provider_account ?? null;
      const since = new Date(new Date(m.since).getTime() - 3600_000);
      const list = await provider.listSince(since, acct);
      cut ||= Boolean(list.cut);
      for (const it of list.intents.filter((x) => x.status === "succeeded")) {
        const known = await db.selectFrom("payment").select("id").where((w) => w.or([w("provider_ref", "=", it.ref), ...(it.kumiPaymentId && UUID.test(it.kumiPaymentId) ? [w("id", "=", it.kumiPaymentId)] : [])])).executeTakeFirst();
        if (!known && await noteFound(db, it, acct, now, { tell: false }) && !it.kumiChargeId) found++;
      }
      for (const rf of list.refunds) {
        // A refund of a payment nothing here records (it's in payment_found), as it stands: kept counted as income, its
        // part comes out of the books once it has gone through; still to decide, it's remembered, so keeping it later
        // counts only what's left.
        if (await db.selectFrom("payment_found").select("id").where("provider_ref", "=", rf.paymentRef).executeTakeFirst()
          && !(await db.selectFrom("payment").select("id").where("provider_ref", "=", rf.paymentRef).executeTakeFirst())) {
          if (await noteFoundRefund(db, rf.paymentRef, rf, now)) refunds++;
          continue;
        }
        if (!rf.ok) continue;
        const had = await db.selectFrom("refund").select("id").where((w) => w.or([w("provider_ref", "=", rf.ref), ...(rf.kumiRefundId && UUID.test(rf.kumiRefundId) ? [w("id", "=", rf.kumiRefundId)] : [])])).executeTakeFirst();
        if (had) continue;
        const pay = await db.selectFrom("payment").select("id").where("provider_ref", "=", rf.paymentRef).where("status", "=", "succeeded").orderBy("id").executeTakeFirst();
        if (!pay) continue;   // its payment is one nothing here records, and not one found either
        const r = await runAsSystem(db, "payment.refund_seen", { payment_id: pay.id, cents: rf.amountCents, provider_ref: rf.ref, refund_id: rf.kumiRefundId && UUID.test(rf.kumiRefundId) ? rf.kumiRefundId : null }, "jobs", { now });
        if ((r.result as { recorded?: boolean } | null)?.recorded) refunds++;
      }
    }
    await db.updateTable("restore_check").set({ done_at: now }).where("id", "=", m.id).execute();
  }
  if (marks.length) await tellFound(db, now, { stillBooked: await stillBookedSeen(db, now) });
  if (cut) await tellUnchecked(db, now);
  return { found, refunds, checked: marks.length };
}

/** A refund the provider made that this database has no row for (made after the copy a restore brought back):
 *  recorded as sent, with its move in the books, so it counts against the payment and nothing goes back twice. */
export const paymentRefundSeen = defineAction({
  name: "payment.refund_seen", version: 1, system: true, internal: true,
  input: z.object({ payment_id: z.uuid(), cents: z.number().check(z.int(), z.minimum(1)), provider_ref: z.string(), refund_id: z.nullable(z.uuid()) }),
  async plan() { return { title: both("action.payment.refund_seen"), summary: both("plan.payment.refund_seen"), reads: [], undo: { kind: "none" } }; },
  async apply(ctx, i) {
    const pay = await ctx.trx.selectFrom("payment").select(["id", "booking_player_id", "enrolment_id", "membership_plan_id", "membership_id", "gift_card_id", "pass_id"]).where("id", "=", i.payment_id).forUpdate().executeTakeFirstOrThrow();
    if (await ctx.trx.selectFrom("refund").select("id").where((w) => w.or([w("provider_ref", "=", i.provider_ref), ...(i.refund_id ? [w("id", "=", i.refund_id)] : [])])).executeTakeFirst()) return { recorded: false };
    const cents = Math.min(i.cents, await leftOf(ctx.trx, i.payment_id));
    if (cents <= 0) return { recorded: false };
    // It counts against the place (paidFor) as against the payment, and is marked seen after a restore: the
    // cancellation it went with may be one this copy doesn't have, so a cancel by the rule gives nothing more for it.
    await ctx.insert("refund", { id: i.refund_id ?? uuidv7(), payment_id: i.payment_id, enrolment_id: pay.enrolment_id ?? null, amount_cents: cents, destination: "card", status: "sent", provider_ref: i.provider_ref, seen_after_restore: true });
    await post(ctx.trx, ctx.runId, "refund", "refund to card (made before a restore, found at the provider)", [
      { account: await account(ctx.trx, "revenue", { revenueType: await revenueType(ctx.trx, pay) }), cents },
      { account: await account(ctx.trx, "provider_clearing"), cents: -cents }]);
    return { recorded: true, cents };
  },
});

const foundPlan = async (ctx: { db: Db }, id: string) => {
  const { row, read } = await readRow(ctx.db, "payment_found", id, "thing.payment");
  // Another club's (kept before whose it was was checked): not this club's to refund or keep, nor to know of.
  if (!(await clubsAccount(ctx.db, row.account))) throw new KumiError("error.not_found", { thing: both("thing.payment") }, 404);
  if (row.status !== "open") throw new KumiError("error.changed");
  if (await recordedRef(ctx.db, row.provider_ref)) throw new KumiError("error.payment_found_recorded");
  return { row, read };
};
/** Under the row's lock: still open, and still nothing here records it (a job may have made it again by its key). */
async function stillUnknown(ctx: { trx: Db; now: Date }, id: string): Promise<boolean> {
  const f = await ctx.trx.selectFrom("payment_found").select(["status", "provider_ref"]).where("id", "=", id).forUpdate().executeTakeFirstOrThrow();
  if (f.status !== "open") throw new KumiError("error.changed");
  if (!(await recordedRef(ctx.trx, f.provider_ref))) return true;
  await ctx.trx.updateTable("payment_found").set({ status: "recorded", done_at: ctx.now, version: sql`version + 1` }).where("id", "=", id).execute();
  return false;
}
/** The staff refund one in full (owner and manager, in the app; never support access or an assistant). It goes out
 *  through the outbox, once, under its own id at the provider. */
export const paymentFoundRefund = defineAction({
  name: "payment_found.refund", version: 1, clubWide: true,
  input: z.object({ id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await foundPlan(ctx, i.id);
    // What's left of it: a refund the provider made of it already (seen here) isn't asked for again.
    const left = await refundable(ctx.db, row as { id: string; amount_cents: number }), back = row.amount_cents - left;
    if (left <= 0) throw new KumiError("error.payment_found_nothing_left");
    const summary = back > 0 ? both("plan.payment_found.refund_left", { left: amountOf(left), amount: amountOf(row.amount_cents), back: amountOf(back) })
      : both("plan.payment_found.refund", { amount: amountOf(row.amount_cents) });
    return { title: both("action.payment_found.refund"), summary, reads: [read], moneyCents: left, undo: { kind: "none", note: both("reason.refund_sent") } };
  },
  async apply(ctx, i) {
    if (!(await stillUnknown(ctx as any, i.id))) return { recorded: true };
    await ctx.update("payment_found", i.id, { status: "refund_asked" });
    await ctx.emit("payment_found.refund", { id: i.id });
    return null;
  },
});
/** The club's currency: the books are in it. A found payment in another (the provider said so) stays out of them. */
const clubCurrency = async (db: Db | Trx) => (await db.selectFrom("club").select("currency").executeTakeFirst())?.currency ?? "USD";
const inBooks = (currency: string | null, club: string) => !currency || currency === club;
/** Refunds of a found payment seen here: those gone through, and those still on their way. */
async function seenBack(db: Db | Trx, id: string) {
  const r = await db.selectFrom("payment_found_refund").select([sql<string>`coalesce(sum(cents) FILTER (WHERE status = 'succeeded'), 0)`.as("done"),
    sql<string>`coalesce(sum(cents) FILTER (WHERE status = 'pending'), 0)`.as("pending")]).where("payment_found_id", "=", id).executeTakeFirstOrThrow();
  return { done: Number(r.done), pending: Number(r.pending) };
}
/** What of a found payment counts when it's kept: what was paid, less refunds of it that have gone through. One still
 *  on its way comes out of the books when it goes through (refund_seen). */
async function keepable(db: Db | Trx, f: { id: string; amount_cents: number }) { return Math.max(0, f.amount_cents - (await seenBack(db, f.id)).done); }
/** What's left to refund of it: what was paid, less every refund of it gone through or on its way (the provider never
 *  refunds more than that). */
async function refundable(db: Db | Trx, f: { id: string; amount_cents: number }) { const b = await seenBack(db, f.id); return Math.max(0, f.amount_cents - b.done - b.pending); }
const OTHER_INCOME = "after_restore";   // a revenue line of its own: Reports' "Card payments recorded after a restore"
const amountOf = (cents: number, c?: string) => ({ en: money(cents, "en", c), es: money(cents, "es", c) });

/** Or record it as paid elsewhere (it was for something the staff have put right by hand), and say how it's kept:
 *  "income", added to the books as other income on the day it was paid, once (under the row's lock), so Kumi's
 *  revenue matches the provider's; or "already", when what put it right is in the books already (a court booked again
 *  at the desk and its payment recorded there, say): nothing is added, so the same money never counts twice. */
export const paymentFoundPaidElsewhere = defineAction({
  name: "payment_found.paid_elsewhere", version: 2, clubWide: true,
  input: z.object({ id: z.uuid(), books: z.enum(["income", "already"]), note: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const { row, read } = await foundPlan(ctx, i.id);
    const club = await clubCurrency(ctx.db), cur = (row as { currency?: string | null }).currency ?? null;
    const summary = i.books === "already" ? both("plan.payment_found.paid_elsewhere_already", { amount: amountOf(row.amount_cents, cur ?? undefined) })
      : inBooks(cur, club) ? both("plan.payment_found.paid_elsewhere", { amount: amountOf(await keepable(ctx.db, row as { id: string; amount_cents: number })) })
      : both("plan.payment_found.paid_elsewhere_other_currency", { amount: amountOf(row.amount_cents, cur!), currency: { en: club, es: club } });
    return { title: both("action.payment_found.paid_elsewhere"), summary, reads: [read], moneyCents: 0, undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    if (!(await stillUnknown(ctx as any, i.id))) return { recorded: true };
    const f = await ctx.trx.selectFrom("payment_found").select(["id", "amount_cents", "paid_at", "currency"]).where("id", "=", i.id).executeTakeFirstOrThrow();
    const cents = i.books === "income" && inBooks(f.currency, await clubCurrency(ctx.trx)) ? await keepable(ctx.trx, f) : 0;
    if (cents > 0) await post(ctx.trx, ctx.runId, "payment", "card payment found after a restore, kept as paid elsewhere and counted as income", [
      { account: await account(ctx.trx, "provider_clearing"), cents },
      { account: await account(ctx.trx, "revenue", { revenueType: OTHER_INCOME }), cents: -cents }], { at: new Date(f.paid_at) });
    await ctx.update("payment_found", i.id, { status: "handled", note: i.note ?? null, done_at: ctx.now, booked_cents: cents, kept_as: i.books });
    return { booked_cents: cents };
  },
});
/** Out of other income: up to `cents` of what the books count of a found payment, dated `at` (a refund on its own day;
 *  a payment Kumi records later on the day it was paid, so the day it was counted on comes out even). */
async function unbook(ctx: { trx: Trx; runId: string }, f: { id: string; booked_cents: number }, cents: number, memo: string, at: Date) {
  const out = Math.min(cents, f.booked_cents);
  if (out <= 0) return 0;
  await post(ctx.trx, ctx.runId, "refund", memo, [
    { account: await account(ctx.trx, "revenue", { revenueType: OTHER_INCOME }), cents: out },
    { account: await account(ctx.trx, "provider_clearing"), cents: -out }], { at });
  await ctx.trx.updateTable("payment_found").set({ booked_cents: f.booked_cents - out, version: sql`version + 1` }).where("id", "=", f.id).execute();
  return out;
}
/** A refund the provider has of a found payment, as it stands now (seen after a restore, or asked again of a kept one):
 *  remembered once, and its status followed. When it has gone through and the payment is kept counted as income, its
 *  part comes out of the books, once, on the refund's own day. One still on its way takes nothing out until it goes
 *  through; one that failed never does. Not kept yet, it's remembered, so keeping it counts only what's left. */
export const paymentFoundRefundSeen = defineAction({
  name: "payment_found.refund_seen", version: 2, system: true, internal: true,
  input: z.object({ payment_ref: z.string(), refund_ref: z.string(), cents: z.number().check(z.int(), z.minimum(0)),
    status: z.enum(["succeeded", "pending", "failed"]), at: z.iso.datetime({ offset: true }) }),
  async plan() { return { title: both("action.payment_found.refund_seen"), summary: both("plan.payment_found.refund_seen"), reads: [], undo: { kind: "none" } }; },
  async apply(ctx, i) {
    const f = await ctx.trx.selectFrom("payment_found").select(["id", "status", "booked_cents"]).where("provider_ref", "=", i.payment_ref).forUpdate().executeTakeFirst();
    if (!f) return { unbooked: 0 };
    const prev = await ctx.trx.selectFrom("payment_found_refund").select(["status", "cents"]).where("provider_ref", "=", i.refund_ref).forUpdate().executeTakeFirst();
    // Gone through is where a refund ends: seen again (or said otherwise), nothing changes.
    if (prev && (prev.status === "succeeded" || (prev.status === i.status && prev.cents === i.cents))) return { unbooked: 0 };
    if (prev) await ctx.trx.updateTable("payment_found_refund").set({ status: i.status, cents: i.cents }).where("provider_ref", "=", i.refund_ref).execute();
    else await ctx.trx.insertInto("payment_found_refund").values({ provider_ref: i.refund_ref, payment_found_id: f.id, cents: i.cents, status: i.status }).execute();
    if (i.status !== "succeeded" || f.status !== "handled") return { unbooked: 0 };
    const out = await unbook(ctx as any, f, i.cents, "refund of a card payment kept as paid elsewhere (at the provider)", new Date(i.at));
    if (out) await ctx.trx.updateTable("payment_found_refund").set({ out_cents: out }).where("provider_ref", "=", i.refund_ref).execute();
    return { unbooked: out };
  },
});
/** Kept as paid elsewhere, and Kumi records a payment for it by now: that payment counts the money, so all of it comes
 *  out of other income (on the day it was paid, where it was counted), and it's closed as recorded. */
export const paymentFoundUnbook = defineAction({
  name: "payment_found.unbook", version: 1, system: true, internal: true,
  input: z.object({ id: z.uuid() }),
  async plan() { return { title: both("action.payment_found.unbook"), summary: both("plan.payment_found.unbook"), reads: [], undo: { kind: "none" } }; },
  async apply(ctx, i) {
    const f = await ctx.trx.selectFrom("payment_found").select(["id", "status", "provider_ref", "booked_cents", "paid_at"]).where("id", "=", i.id).forUpdate().executeTakeFirstOrThrow();
    if (f.status !== "handled" || !(await recordedRef(ctx.trx as any, f.provider_ref))) return { unbooked: 0 };
    const out = await unbook(ctx as any, f, f.booked_cents, "card payment kept as paid elsewhere, recorded by Kumi since (counted there)", new Date(f.paid_at));
    await ctx.trx.updateTable("payment_found").set({ status: "recorded", done_at: ctx.now, version: sql`version + 1` }).where("id", "=", f.id).execute();
    return { unbooked: out };
  },
});
/** A refund the provider has of a found payment, to remember (refund_seen), unless it's as already seen. */
async function noteFoundRefund(db: Db, paymentRef: string, rf: FoundRefund, now: Date): Promise<number> {
  const status = rf.status ?? (rf.ok ? "succeeded" : "failed");
  const prev = await db.selectFrom("payment_found_refund").select(["status", "cents"]).where("provider_ref", "=", rf.ref).executeTakeFirst();
  if (prev && (prev.status === "succeeded" || (prev.status === status && prev.cents === rf.amountCents))) return 0;
  const r = await runAsSystem(db, "payment_found.refund_seen", { payment_ref: paymentRef, refund_ref: rf.ref, cents: rf.amountCents, status, at: new Date(rf.created).toISOString() }, "jobs", { now });
  return (r.result as { unbooked?: number } | null)?.unbooked ?? 0;
}
/** A kept one is disputed at the provider: the owner and managers hear once (it stays on Today until handled). Kumi's
 *  books still count it; the dispute is answered in the provider's own dashboard. */
async function tellDisputed(db: Db, f: { amount_cents: number; provider_ref: string; currency: string | null }, now: Date) {
  const a = amountOf(f.amount_cents, f.currency ?? undefined);
  const words = { en: `A card payment kept as paid elsewhere after a restore (${a.en}, ${f.provider_ref}) is disputed at the payment provider. Answer the dispute in the provider's own dashboard: Kumi's books still count the payment.`,
    es: `Un pago con tarjeta conservado como pagado por otra vía tras una restauración (${a.es}, ${f.provider_ref}) tiene una disputa en el proveedor de pagos. Respóndela en el panel del propio proveedor: la contabilidad de Kumi aún cuenta el pago.` };
  await runAsSystem(db, "ops.report_failure", { job: "restore_disputed", error: words.en.slice(0, 300), words: fitWords([words]) }, "jobs", { now })
    .catch((e) => console.error(`payments: couldn't tell the staff (${(e as Error).message})`));
}
const KEPT_CHECK_HOURS = 6, KEPT_CHECK_DAYS = 365, KEPT_CHECK_EACH_RUN = 10;
/** Each job run, a few at a time: kept found payments asked of the provider again (each at most every 6 hours, for a
 *  year after it was paid) for refunds made of them since (in its dashboard, say: "Refund it" is gone once kept, and
 *  nothing else here would see one) and for a dispute. */
export async function checkKeptFound(db: Db, now = new Date(), o: { limit?: number } = {}): Promise<{ checked: number; unbooked: number; disputed: number }> {
  const provider = paymentProvider();
  if (!provider.refundsOf) return { checked: 0, unbooked: 0, disputed: 0 };
  const rows = await db.selectFrom("payment_found").select(["id", "provider_ref", "account", "amount_cents", "currency", "disputed_at"]).where("status", "=", "handled")
    .where("paid_at", ">", new Date(now.getTime() - KEPT_CHECK_DAYS * 864e5))
    .where((w) => w.or([w("checked_at", "is", null), w("checked_at", "<", new Date(now.getTime() - KEPT_CHECK_HOURS * 3600_000))]))
    .orderBy(sql`checked_at NULLS FIRST`).orderBy("id").limit(o.limit ?? KEPT_CHECK_EACH_RUN).execute();
  let unbooked = 0, disputed = 0;
  for (const f of rows) {
    try {
      const r = await provider.refundsOf(f.provider_ref, f.account);
      for (const rf of r.refunds) if (await noteFoundRefund(db, f.provider_ref, rf, now)) unbooked++;
      if (r.disputed && !f.disputed_at) {
        const first = await db.updateTable("payment_found").set({ disputed_at: now }).where("id", "=", f.id).where("disputed_at", "is", null).returning("id").executeTakeFirst();
        if (first) { await tellDisputed(db, f, now); disputed++; }
      }
      await db.updateTable("payment_found").set({ checked_at: now }).where("id", "=", f.id).execute();
    } catch (e) { console.error(`payments: couldn't ask the payment provider about ${f.provider_ref} (${(e as Error).message})`); }
  }
  return { checked: rows.length, unbooked, disputed };
}
/** The outbox's: the refund to the provider, once (its id is the idempotency key), then the outcome. What's asked for is
 *  what's left of it: refunds of it the provider has made already (seen here) are never asked for again. */
export async function sendFoundRefund(db: Db, payload: { id: string }) {
  const f = await db.selectFrom("payment_found").selectAll().where("id", "=", payload.id).executeTakeFirst();
  if (!f || f.status !== "refund_asked") return;
  // Never on another club's account, whatever was asked: the row goes (it was never this club's).
  if (!(await clubsAccount(db, f.account))) { await forgetFound(db, f.id); return; }
  // Kumi records it by now (a charge made again by its key, or a webhook that came in): not refunded here.
  if (await recordedRef(db, f.provider_ref)) {
    await db.updateTable("payment_found").set({ status: "recorded", done_at: new Date(), version: sql`version + 1` }).where("id", "=", f.id).execute();
    return;
  }
  const left = await refundable(db, f);
  const r = left > 0 ? await paymentProvider().refund({ paymentRef: f.provider_ref, amountCents: left, idempotencyKey: f.id, account: f.account }) : { ok: true as const, failure: undefined };
  await db.updateTable("payment_found").set({ status: r.ok ? "refunded" : "refund_failed", note: r.ok ? f.note : (r.failure ?? "failed").slice(0, 300), done_at: new Date(), version: sql`version + 1` }).where("id", "=", f.id).execute();
}
