// Events leave through the outbox after their change commits (ground rule 8). Each event is
// claimed by one worker (SKIP LOCKED), handled, and marked delivered; a failure is retried later.
import { sql } from "kysely";
import type { Db } from "./db.ts";
import { runAsSystem } from "./actions.ts";
import { paymentProvider } from "./money.ts";

export interface OutboxEvent { id: string; topic: string; payload: any; created_at: Date; attempts: number }
export type Handler = (db: Db, payload: any, event?: OutboxEvent) => Promise<void>;
export const MAX_ATTEMPTS = 8;
/** Money on its way back to a card isn't given up after eight quick tries: it waits 30 seconds, doubling to an
 *  hour, until its handler settles it (a refund that can't reach the provider for an hour is marked failed, so
 *  the staff hear and can send it again). */
export const MONEY_TOPICS = new Set(["refund.requested"]);
export const backoffMs = (attempts: number) => Math.min(3600_000, 30_000 * 2 ** Math.max(0, attempts - 1));

export async function processOutbox(db: Db, handlers: Record<string, Handler>, limit = 100, now = new Date()): Promise<{ delivered: number; failed: number }> {
  let delivered = 0, failed = 0;
  const tried = new Set<string>();
  while (delivered + failed < limit) {
    const ev = await db.transaction().execute(async (trx) => {
      const e = await trx.selectFrom("event_outbox").selectAll().where("delivered_at", "is", null).where("held_at", "is", null).where("topic", "in", Object.keys(handlers))
        .where((w) => w.or([w("attempts", "<", MAX_ATTEMPTS), w("topic", "in", [...MONEY_TOPICS])]))
        .where((w) => w.or([w("next_attempt_at", "is", null), w("next_attempt_at", "<=", now)]))
        .$if(tried.size > 0, (q) => q.where("id", "not in", [...tried])).orderBy("id").limit(1).forUpdate().skipLocked().executeTakeFirst();
      if (e) await trx.updateTable("event_outbox").set({ attempts: sql`attempts + 1` }).where("id", "=", e.id).execute();
      return e;
    });
    if (!ev) break;
    tried.add(ev.id);
    try { await handlers[ev.topic]!(db, ev.payload, ev as OutboxEvent); await db.updateTable("event_outbox").set({ delivered_at: new Date() }).where("id", "=", ev.id).execute(); delivered++; }
    catch (err) {
      failed++; console.error(`outbox ${ev.topic} ${ev.id}:`, (err as Error).message);
      if (MONEY_TOPICS.has(ev.topic)) await db.updateTable("event_outbox").set({ next_attempt_at: new Date(now.getTime() + backoffMs(ev.attempts + 1)) }).where("id", "=", ev.id).execute();
    }
  }
  return { delivered, failed };
}

/** Several sets of handlers on one outbox: an event goes to each that wants it, in order. A failure
 *  retries the whole event, so every handler must be safe to run twice (each checks what it did). */
export function combine(...sets: Record<string, Handler>[]): Record<string, Handler> {
  const topics = [...new Set(sets.flatMap((s) => Object.keys(s)))];
  return Object.fromEntries(topics.map((topic) => [topic, async (db: Db, payload: unknown, ev?: OutboxEvent) => {
    for (const s of sets) await s[topic]?.(db, payload, ev);
  }]));
}

/** The money handlers: send each requested refund to the provider, once, then record the outcome. */
const REFUND_GIVE_UP_TRIES = 8;   // 30 s, 1, 2, 4, 8, 16 and 32 minutes between them: about an hour
export const moneyHandlers: Record<string, Handler> = {
  async "refund.requested"(db, payload: { refund_id: string }, ev) {
    const r = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id")
      .select(["refund.id", "refund.status", "refund.amount_cents", "payment.provider_ref", "payment.provider_account"]).where("refund.id", "=", payload.refund_id).executeTakeFirstOrThrow();
    if (r.status !== "pending") return;
    // Back through the Stripe account the payment was taken on, even if the club has changed accounts since.
    // The refund's own id is the key, so sending it again (here, or by the staff later) never refunds twice.
    let out: Awaited<ReturnType<ReturnType<typeof paymentProvider>["refund"]>>;
    try { out = await paymentProvider().refund({ paymentRef: r.provider_ref ?? "", amountCents: r.amount_cents, idempotencyKey: r.id, account: r.provider_account }); }
    catch (e) {
      // An hour of not reaching the provider (the 8th try, with the waits between): marked failed, so it no longer
      // counts as paid back, the staff hear once, and they can send it again.
      if ((ev?.attempts ?? 0) + 1 >= REFUND_GIVE_UP_TRIES) {
        await runAsSystem(db, "refund.settle", { refund_id: r.id, ok: false, failure: `not sent: ${(e as Error).message}`.slice(0, 200) }, "outbox");
        return;
      }
      throw e;
    }
    await runAsSystem(db, "refund.settle", { refund_id: r.id, ok: out.ok, provider_ref: out.ref || undefined, failure: out.failure }, "outbox");
  },
};
