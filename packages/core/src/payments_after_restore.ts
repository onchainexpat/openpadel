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
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, money, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem } from "./actions.ts";
import type { Db } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { account, paymentProvider, post, type FoundIntent } from "./money.ts";
import { leftOf, revenueType } from "./desk_pay.ts";
import { fitWords, jobFailed, jobWorked } from "./ops.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A payment row for this provider reference: Kumi records it (so nothing here may refund it as unknown). */
const recordedRef = (db: Db, ref: string) => db.selectFrom("payment").select("id").where("provider_ref", "=", ref).executeTakeFirst();

/** One the provider took that nothing here records: kept once. Kumi's own charges (kumiChargeId) wait for the jobs;
 *  the rest are open for the staff, who hear once. True when it's new. */
export async function noteFound(db: Db, it: Omit<FoundIntent, "status" | "kumiPaymentId">, account: string | null, now = new Date(), o: { tell?: boolean } = {}): Promise<boolean> {
  const kumi = Boolean(it.kumiChargeId);
  const r = await db.insertInto("payment_found").values({ id: uuidv7(now.getTime()), provider: paymentProvider().name, provider_ref: it.ref, account, amount_cents: it.amountCents,
    paid_at: it.created, email: it.email, description: it.description?.slice(0, 300) ?? null, note: null, done_at: null, kind: kumi ? "kumi_charge" : "payment", status: kumi ? "waiting" : "open" })
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
    .where("booking.status", "!=", "cancelled").where(sql<boolean>`EXISTS (SELECT 1 FROM court_time ct WHERE ct.booking_id = booking.id AND upper(ct.during) > ${now})`).execute();
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
      for (const rf of list.refunds.filter((x) => x.ok)) {
        const had = await db.selectFrom("refund").select("id").where((w) => w.or([w("provider_ref", "=", rf.ref), ...(rf.kumiRefundId && UUID.test(rf.kumiRefundId) ? [w("id", "=", rf.kumiRefundId)] : [])])).executeTakeFirst();
        if (had) continue;
        const pay = await db.selectFrom("payment").select("id").where("provider_ref", "=", rf.paymentRef).where("status", "=", "succeeded").orderBy("id").executeTakeFirst();
        if (!pay) continue;   // its payment is one nothing here records: it's in payment_found already
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
    return { title: both("action.payment_found.refund"), summary: both("plan.payment_found.refund", { amount: { en: money(row.amount_cents, "en"), es: money(row.amount_cents, "es") } }),
      reads: [read], moneyCents: row.amount_cents, undo: { kind: "none", note: both("reason.refund_sent") } };
  },
  async apply(ctx, i) {
    if (!(await stillUnknown(ctx as any, i.id))) return { recorded: true };
    await ctx.update("payment_found", i.id, { status: "refund_asked" });
    await ctx.emit("payment_found.refund", { id: i.id });
    return null;
  },
});
/** Or record it as paid elsewhere (it was for something the staff have put right by hand). */
export const paymentFoundPaidElsewhere = defineAction({
  name: "payment_found.paid_elsewhere", version: 1, clubWide: true,
  input: z.object({ id: z.uuid(), note: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const { row, read } = await foundPlan(ctx, i.id);
    return { title: both("action.payment_found.paid_elsewhere"), summary: both("plan.payment_found.paid_elsewhere", { amount: { en: money(row.amount_cents, "en"), es: money(row.amount_cents, "es") } }),
      reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    if (!(await stillUnknown(ctx as any, i.id))) return { recorded: true };
    await ctx.update("payment_found", i.id, { status: "handled", note: i.note ?? null, done_at: ctx.now });
    return null;
  },
});
/** The outbox's: the refund to the provider, once (its id is the idempotency key), then the outcome. */
export async function sendFoundRefund(db: Db, payload: { id: string }) {
  const f = await db.selectFrom("payment_found").selectAll().where("id", "=", payload.id).executeTakeFirst();
  if (!f || f.status !== "refund_asked") return;
  // Kumi records it by now (a charge made again by its key, or a webhook that came in): not refunded here.
  if (await recordedRef(db, f.provider_ref)) {
    await db.updateTable("payment_found").set({ status: "recorded", done_at: new Date(), version: sql`version + 1` }).where("id", "=", f.id).execute();
    return;
  }
  const r = await paymentProvider().refund({ paymentRef: f.provider_ref, amountCents: f.amount_cents, idempotencyKey: f.id, account: f.account });
  await db.updateTable("payment_found").set({ status: r.ok ? "refunded" : "refund_failed", note: r.ok ? f.note : (r.failure ?? "failed").slice(0, 300), done_at: new Date(), version: sql`version + 1` }).where("id", "=", f.id).execute();
}
