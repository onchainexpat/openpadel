// Events leave through the outbox after their change commits (ground rule 8). Each event is
// claimed by one worker (SKIP LOCKED), handled, and marked delivered; a failure is retried later.
import { sql } from "kysely";
import type { Db } from "./db.ts";
import { runAsSystem } from "./actions.ts";
import { paymentProvider } from "./money.ts";

export interface OutboxEvent { id: string; topic: string; payload: any; created_at: Date }
export type Handler = (db: Db, payload: any, event?: OutboxEvent) => Promise<void>;
export const MAX_ATTEMPTS = 8;

export async function processOutbox(db: Db, handlers: Record<string, Handler>, limit = 100): Promise<{ delivered: number; failed: number }> {
  let delivered = 0, failed = 0;
  const tried = new Set<string>();
  while (delivered + failed < limit) {
    const ev = await db.transaction().execute(async (trx) => {
      const e = await trx.selectFrom("event_outbox").selectAll().where("delivered_at", "is", null).where("topic", "in", Object.keys(handlers))
        .where("attempts", "<", MAX_ATTEMPTS).$if(tried.size > 0, (q) => q.where("id", "not in", [...tried])).orderBy("id").limit(1).forUpdate().skipLocked().executeTakeFirst();
      if (e) await trx.updateTable("event_outbox").set({ attempts: sql`attempts + 1` }).where("id", "=", e.id).execute();
      return e;
    });
    if (!ev) break;
    tried.add(ev.id);
    try { await handlers[ev.topic]!(db, ev.payload, ev as OutboxEvent); await db.updateTable("event_outbox").set({ delivered_at: new Date() }).where("id", "=", ev.id).execute(); delivered++; }
    catch (err) { failed++; console.error(`outbox ${ev.topic} ${ev.id}:`, (err as Error).message); }
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
export const moneyHandlers: Record<string, Handler> = {
  async "refund.requested"(db, payload: { refund_id: string }) {
    const r = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id")
      .select(["refund.id", "refund.status", "refund.amount_cents", "payment.provider_ref", "payment.provider_account"]).where("refund.id", "=", payload.refund_id).executeTakeFirstOrThrow();
    if (r.status !== "pending") return;
    // Back through the Stripe account the payment was taken on, even if the club has changed accounts since.
    const out = await paymentProvider().refund({ paymentRef: r.provider_ref ?? "", amountCents: r.amount_cents, idempotencyKey: r.id, account: r.provider_account });
    await runAsSystem(db, "refund.settle", { refund_id: r.id, ok: out.ok, provider_ref: out.ref || undefined, failure: out.failure }, "outbox");
  },
};
