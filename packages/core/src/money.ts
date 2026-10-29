// Payments go through a provider (Stripe, or the stand-in for development and tests). The ledger
// is double-entry: debits positive, credits negative, every transaction summing to zero.
import { randomBytes } from "node:crypto";
import type { Trx } from "./db.ts";
import { uuidv7 } from "./ids.ts";

export type IntentStatus = "pending" | "succeeded" | "failed";

export interface PaymentProvider {
  readonly name: "test" | "stripe";
  /** Ask for a payment. Nothing is charged until the person confirms it and the provider says so.
   *  The same key always gives back the same intent, so a retry never asks twice. */
  createIntent(i: { amountCents: number; currency: string; description: string; idempotencyKey: string; metadata?: Record<string, string> }): Promise<{ ref: string; clientSecret: string; account: string | null }>;
  /** Where an intent stands now, asked of the provider: how a missed webhook is caught. A declined
   *  card isn't a failure (the person can try another); only a cancelled intent is. */
  getIntent(ref: string, account?: string | null): Promise<{ status: IntentStatus; clientSecret: string }>;
  /** Send a refund. Retrying with the same key never refunds twice. */
  refund(i: { paymentRef: string; amountCents: number; idempotencyKey: string; account?: string | null }): Promise<{ ref: string; ok: boolean; failure?: string }>;
}

/** A stand-in for Stripe: records what was asked, and can be told to fail. */
export class TestProvider implements PaymentProvider {
  readonly name = "test" as const;
  intents = new Map<string, { amountCents: number; description: string; status: IntentStatus; clientSecret: string }>();
  private byKey = new Map<string, string>();
  refunds = new Map<string, { paymentRef: string; amountCents: number; ref: string }>();
  failNextRefund = false;
  async createIntent(i: { amountCents: number; currency: string; description: string; idempotencyKey: string }) {
    const known = this.byKey.get(i.idempotencyKey);
    if (known) return { ref: known, clientSecret: this.intents.get(known)!.clientSecret, account: null };
    const ref = `pi_test_${randomBytes(6).toString("hex")}`, clientSecret = `${ref}_secret_${randomBytes(6).toString("hex")}`;
    this.intents.set(ref, { amountCents: i.amountCents, description: i.description, status: "pending", clientSecret });
    this.byKey.set(i.idempotencyKey, ref);
    return { ref, clientSecret, account: null };
  }
  async getIntent(ref: string) {
    const it = this.intents.get(ref);
    if (!it) throw new Error(`no such intent: ${ref}`);
    return { status: it.status, clientSecret: it.clientSecret };
  }
  /** What a card form and the provider would do: the person pays, or the intent is cancelled. */
  settle(ref: string, status: IntentStatus) { const it = this.intents.get(ref); if (it) it.status = status; }
  async refund(i: { paymentRef: string; amountCents: number; idempotencyKey: string }) {
    const seen = this.refunds.get(i.idempotencyKey);
    if (seen) return { ref: seen.ref, ok: true };
    if (this.failNextRefund) { this.failNextRefund = false; return { ref: "", ok: false, failure: "card_declined" }; }
    const ref = `re_test_${randomBytes(6).toString("hex")}`;
    this.refunds.set(i.idempotencyKey, { paymentRef: i.paymentRef, amountCents: i.amountCents, ref });
    return { ref, ok: true };
  }
}

let provider: PaymentProvider = new TestProvider();
export function setPaymentProvider(p: PaymentProvider): void { provider = p; }
export function paymentProvider(): PaymentProvider { return provider; }

export type AccountKind = "member_credit" | "receivable" | "revenue" | "provider_clearing" | "cash_drawer" | "refunds_payable" | "adjustment";

export async function account(trx: Trx, kind: AccountKind, opts: { personId?: string; revenueType?: string } = {}): Promise<string> {
  const found = await trx.selectFrom("ledger_account").select("id").where("kind", "=", kind)
    .where("person_id", opts.personId ? "=" : "is", opts.personId ?? null).where("revenue_type", opts.revenueType ? "=" : "is", opts.revenueType ?? null).executeTakeFirst();
  if (found) return found.id;
  const id = uuidv7();
  await trx.insertInto("ledger_account").values({ id, kind, person_id: opts.personId ?? null, revenue_type: opts.revenueType ?? null }).onConflict((oc) => oc.doNothing()).execute();
  return (await trx.selectFrom("ledger_account").select("id").where("kind", "=", kind).where("person_id", opts.personId ? "=" : "is", opts.personId ?? null)
    .where("revenue_type", opts.revenueType ? "=" : "is", opts.revenueType ?? null).executeTakeFirstOrThrow()).id;
}

/** One balanced ledger transaction. The database rejects it at commit if it doesn't sum to zero. */
export async function post(trx: Trx, runId: string, kind: string, memo: string, entries: { account: string; cents: number }[]): Promise<string> {
  const id = uuidv7();
  await trx.insertInto("ledger_txn").values({ id, kind, action_run_id: runId, memo }).execute();
  await trx.insertInto("ledger_entry").values(entries.filter((e) => e.cents !== 0).map((e) => ({ txn_id: id, account_id: e.account, amount_cents: String(e.cents) }))).execute();
  return id;
}

export async function creditBalance(db: Trx | import("./db.ts").Db, personId: string): Promise<number> {
  const r = await db.selectFrom("member_credit_balance").select("cents").where("person_id", "=", personId).executeTakeFirst();
  return Number(r?.cents ?? 0);
}
