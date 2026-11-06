// Card money the payment provider has that the club's database doesn't: after a restore, a copy from before a payment
// or a refund doesn't know of it. A payment it has no row for would go unnoticed (the money taken, nothing booked); a
// refund it has no row for could be paid a second time (a new refund, a new id, and the provider's room for it). So
// after every restore the server, as it next starts, asks the provider for what was made since the copy's newest
// payment (restore_check): a refund is recorded against its payment (so nothing goes back twice); a payment with no
// row is kept in payment_found for the staff to refund in full or record as paid elsewhere, and the owner and managers
// hear once. Nothing is refunded by itself. The provider's webhook for a paid payment Kumi has no row for lands there
// too, said the same way.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, money } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem } from "./actions.ts";
import type { Db } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { account, paymentProvider, post, type FoundIntent } from "./money.ts";
import { leftOf, revenueType } from "./desk_pay.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One the provider took that nothing here records: kept once, and the staff told (the alert is said once while any
 *  is open). True when it's new. */
export async function noteFound(db: Db, it: Omit<FoundIntent, "status" | "kumiPaymentId">, account: string | null, now = new Date()): Promise<boolean> {
  const r = await db.insertInto("payment_found").values({ id: uuidv7(now.getTime()), provider: paymentProvider().name, provider_ref: it.ref, account, amount_cents: it.amountCents,
    paid_at: it.created, email: it.email, description: it.description?.slice(0, 300) ?? null, note: null, done_at: null }).onConflict((oc) => oc.column("provider_ref").doNothing()).returning("id").executeTakeFirst();
  if (r) await tellFound(db, now);
  return Boolean(r);
}
async function tellFound(db: Db, now: Date) {
  const open = await db.selectFrom("payment_found").select((eb) => [eb.fn.countAll<string>().as("n"), eb.fn.sum<string>("amount_cents").as("cents")]).where("status", "=", "open").executeTakeFirstOrThrow();
  if (!Number(open.n)) return;
  const en = `${open.n} card payment(s) the payment provider took have no record here (Payments, "Paid with nothing here"): refund each or record it as paid elsewhere. Confirmations sent after a backup may refer to bookings or gift card codes this copy doesn't have.`;
  const es = `${open.n} pago(s) con tarjeta que el proveedor cobró no constan aquí (Pagos, "Pagado sin registro"): devuelve cada uno o regístralo como pagado por otra vía. Las confirmaciones enviadas después de una copia pueden referirse a reservas o códigos que esta copia no tiene.`;
  await runAsSystem(db, "ops.report_failure", { job: "restore_money", error: en.slice(0, 300), words: { en: en.slice(0, 300), es: es.slice(0, 300) } }, "jobs", { now })
    .catch((e) => console.error(`payments: couldn't tell the staff (${(e as Error).message})`));
}

/** After a restore (restore_check), as the server starts: what the provider has from after the copy. */
export async function checkMoneyAfterRestore(db: Db, now = new Date()): Promise<{ found: number; refunds: number; checked: number }> {
  const marks = await db.selectFrom("restore_check").selectAll().where("done_at", "is", null).orderBy("id").execute().catch(() => []);
  let found = 0, refunds = 0;
  const provider = paymentProvider();
  for (const m of marks) {
    if (provider.listSince) {
      const acct = (await db.selectFrom("payment").select("provider_account").where("provider", "=", provider.name).orderBy("created_at", "desc").limit(1).executeTakeFirst())?.provider_account ?? null;
      const since = new Date(new Date(m.since).getTime() - 3600_000);
      const list = await provider.listSince(since, acct);
      for (const it of list.intents.filter((x) => x.status === "succeeded")) {
        const known = await db.selectFrom("payment").select("id").where((w) => w.or([w("provider_ref", "=", it.ref), ...(it.kumiPaymentId && UUID.test(it.kumiPaymentId) ? [w("id", "=", it.kumiPaymentId)] : [])])).executeTakeFirst();
        if (!known && await noteFound(db, it, acct, now)) found++;
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
  return { found, refunds, checked: marks.length };
}

/** A refund the provider made that this database has no row for (made after the copy a restore brought back):
 *  recorded as sent, with its move in the books, so it counts against the payment and nothing goes back twice. */
export const paymentRefundSeen = defineAction({
  name: "payment.refund_seen", version: 1, system: true, internal: true,
  input: z.object({ payment_id: z.uuid(), cents: z.number().check(z.int(), z.minimum(1)), provider_ref: z.string(), refund_id: z.nullable(z.uuid()) }),
  async plan() { return { title: both("action.payment.refund_seen"), summary: both("plan.payment.refund_seen"), reads: [], undo: { kind: "none" } }; },
  async apply(ctx, i) {
    const pay = await ctx.trx.selectFrom("payment").select(["id", "booking_player_id", "membership_plan_id", "membership_id", "gift_card_id", "pass_id"]).where("id", "=", i.payment_id).forUpdate().executeTakeFirstOrThrow();
    if (await ctx.trx.selectFrom("refund").select("id").where((w) => w.or([w("provider_ref", "=", i.provider_ref), ...(i.refund_id ? [w("id", "=", i.refund_id)] : [])])).executeTakeFirst()) return { recorded: false };
    const cents = Math.min(i.cents, await leftOf(ctx.trx, i.payment_id));
    if (cents <= 0) return { recorded: false };
    await ctx.insert("refund", { id: i.refund_id ?? uuidv7(), payment_id: i.payment_id, enrolment_id: null, amount_cents: cents, destination: "card", status: "sent", provider_ref: i.provider_ref });
    await post(ctx.trx, ctx.runId, "refund", "refund to card (made before a restore, found at the provider)", [
      { account: await account(ctx.trx, "revenue", { revenueType: await revenueType(ctx.trx, pay) }), cents },
      { account: await account(ctx.trx, "provider_clearing"), cents: -cents }]);
    return { recorded: true, cents };
  },
});

const foundPlan = async (ctx: { db: Db }, id: string) => {
  const { row, read } = await readRow(ctx.db, "payment_found", id, "thing.payment");
  if (row.status !== "open") throw new KumiError("error.changed");
  return { row, read };
};
/** The staff refund one in full (owner and manager, in the app; never support access or an assistant). It goes out
 *  through the outbox, once, under its own id at the provider. */
export const paymentFoundRefund = defineAction({
  name: "payment_found.refund", version: 1, clubWide: true,
  input: z.object({ id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await foundPlan(ctx, i.id);
    return { title: both("action.payment_found.refund"), summary: both("plan.payment_found.refund", { amount: { en: money(row.amount_cents, "en"), es: money(row.amount_cents, "es") } }),
      reads: [read], moneyCents: row.amount_cents, undo: { kind: "none", note: both("undo.none", { reason: both("reason.refund_sent") }) } };
  },
  async apply(ctx, i) {
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
    await ctx.update("payment_found", i.id, { status: "handled", note: i.note ?? null, done_at: ctx.now });
    return null;
  },
});
/** The outbox's: the refund to the provider, once (its id is the idempotency key), then the outcome. */
export async function sendFoundRefund(db: Db, payload: { id: string }) {
  const f = await db.selectFrom("payment_found").selectAll().where("id", "=", payload.id).executeTakeFirst();
  if (!f || f.status !== "refund_asked") return;
  const r = await paymentProvider().refund({ paymentRef: f.provider_ref, amountCents: f.amount_cents, idempotencyKey: f.id, account: f.account });
  await db.updateTable("payment_found").set({ status: r.ok ? "refunded" : "refund_failed", note: r.ok ? f.note : (r.failure ?? "failed").slice(0, 300), done_at: new Date(), version: sql`version + 1` }).where("id", "=", f.id).execute();
}
