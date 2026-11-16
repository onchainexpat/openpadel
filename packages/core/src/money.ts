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
  createIntent(i: { amountCents: number; currency: string; description: string; idempotencyKey: string; metadata?: Record<string, string>; customer?: string; saveCard?: boolean }): Promise<{ ref: string; clientSecret: string; account: string | null }>;
  /** Where an intent stands now, asked of the provider: how a missed webhook is caught. A declined
   *  card isn't a failure (the person can try another); only a cancelled intent is. `processing`: still pending, but
   *  the card was confirmed and the provider is finishing it (it can't be called off any more). */
  getIntent(ref: string, account?: string | null): Promise<{ status: IntentStatus; clientSecret: string; paymentMethod?: string | null; customer?: string | null; processing?: boolean }>;
  /** Call off a payment nobody finished, so it can't go through later. If it already went through, says
   *  so: then it's paid, not cancelled. */
  cancelIntent(ref: string, account?: string | null): Promise<{ status: IntentStatus }>;
  /** A customer record for a person, so a card can be saved for a later charge. Same key, same customer. */
  ensureCustomer(i: { key: string; email?: string | null; name?: string }): Promise<{ id: string; account: string | null }>;
  /** Save a card for later without charging it (a presale: the first charge is on the start date).
   *  The same key always gives back the same setup. */
  createSetup(i: { customer: string; idempotencyKey: string; metadata?: Record<string, string> }): Promise<{ ref: string; clientSecret: string; account: string | null }>;
  /** Where a card setup stands: succeeded once the card is saved, with the card. */
  getSetup(ref: string, account?: string | null): Promise<{ status: IntentStatus; clientSecret: string; paymentMethod: string | null; customer: string | null }>;
  /** Charge a saved card without the person present (the deadline for unpaid shares). Never throws for a
   *  declined or authentication-needed card: that comes back as failed, with why. A charge the provider already
   *  had for this key (asked again after a restore) comes back as it is now: with what's been refunded of it. */
  chargeSaved(i: { customer: string; paymentMethod: string; amountCents: number; currency: string; description: string; idempotencyKey: string; account?: string | null }): Promise<{ ref: string; status: IntentStatus; failure?: string; refundedCents?: number; refundRef?: string }>;
  /** Send a refund. Retrying with the same key never refunds twice. */
  refund(i: { paymentRef: string; amountCents: number; idempotencyKey: string; account?: string | null }): Promise<{ ref: string; ok: boolean; failure?: string }>;
  /** Card payments and refunds made since a time (after a restore, to find what the club's database has no record
   *  of). Optional: a provider without it isn't checked. */
  listSince?(since: Date, account?: string | null): Promise<{ intents: FoundIntent[]; refunds: FoundRefund[]; cut?: boolean }>;
  /** One payment's refunds as the provider has them now, and whether it's disputed (a payment found after a restore
   *  and kept: what has gone back of it since, made in the provider's dashboard, say). Optional. */
  refundsOf?(paymentRef: string, account?: string | null): Promise<{ refunds: FoundRefund[]; disputed: boolean }>;
  /** The card a payment was made with, for its receipt: the brand and the last four digits, never more. */
  cardOf?(ref: string, account?: string | null): Promise<{ brand: string; last4: string } | null>;
  /** A saved card as the person sees it on file: its brand, last four digits and expiry, never more. Optional. */
  methodOf?(method: string, account?: string | null): Promise<CardFacts | null>;
  /** Take a saved card off its customer, so it can't be charged again. Optional; never throws for one already gone. */
  detachMethod?(method: string, account?: string | null): Promise<void>;
  /** The club's latest payouts (the provider sending the club's money to its bank), newest first, at most `limit`.
   *  Null while the club has no account there yet. Read only, for the Money page. Optional. */
  listPayouts?(limit: number): Promise<Payout[] | null>;
}
/** A payout as the provider has it: how much, where it stands, and the day it's due in the bank (a date, no time). */
export interface Payout { ref: string; amountCents: number; currency: string; status: "paid" | "pending" | "in_transit" | "failed" | "canceled";
  arrivesOn: string; created: Date; bank: { name: string | null; last4: string } | null }
export interface CardFacts { brand: string; last4: string; expMonth: number | null; expYear: number | null }

/** A stand-in for Stripe: records what was asked, and can be told to fail. */
export interface FoundIntent { ref: string; status: IntentStatus; amountCents: number; created: Date; kumiPaymentId: string | null; kumiChargeId?: string | null; email: string | null; description: string | null;
  /** The payment's own currency (ISO 4217), when the provider says it. */
  currency?: string | null }
export interface FoundRefund { ref: string; paymentRef: string; amountCents: number; ok: boolean; created: Date; kumiRefundId: string | null;
  /** Where it stands at the provider: gone through, still on its way (pending, or waiting on the bank), or failed. */
  status?: "succeeded" | "pending" | "failed" }
export class TestProvider implements PaymentProvider {
  readonly name = "test" as const;
  intents = new Map<string, { amountCents: number; currency?: string; description: string; status: IntentStatus; clientSecret: string; customer?: string; saveCard?: boolean; paymentMethod?: string; created?: Date; metadata?: Record<string, string>; processing?: boolean }>();
  customers = new Map<string, string>();
  charges: { customer: string; paymentMethod: string; amountCents: number; ref: string }[] = [];
  failNextCharge: string | null = null;
  setups = new Map<string, { status: IntentStatus; clientSecret: string; customer: string; paymentMethod: string | null }>();
  private byKey = new Map<string, string>();
  refunds = new Map<string, { paymentRef: string; amountCents: number; ref: string; created?: Date; status?: "succeeded" | "pending" | "failed" }>();
  /** Payments disputed at the stand-in provider (by reference). */
  disputes = new Set<string>();
  failNextRefund = false;
  /** Payouts at the stand-in provider: none until a test adds some (a club in practice has had none). */
  payouts: Payout[] = [];
  async createIntent(i: { amountCents: number; currency: string; description: string; idempotencyKey: string; customer?: string; saveCard?: boolean; metadata?: Record<string, string> }) {
    const known = this.byKey.get(i.idempotencyKey);
    if (known) return { ref: known, clientSecret: this.intents.get(known)!.clientSecret, account: null };
    const ref = `pi_test_${randomBytes(6).toString("hex")}`, clientSecret = `${ref}_secret_${randomBytes(6).toString("hex")}`;
    this.intents.set(ref, { amountCents: i.amountCents, currency: i.currency, description: i.description, status: "pending", clientSecret, customer: i.customer, saveCard: i.saveCard, created: new Date(), metadata: i.metadata });
    this.byKey.set(i.idempotencyKey, ref);
    return { ref, clientSecret, account: null };
  }
  async getIntent(ref: string) {
    const it = this.intents.get(ref);
    if (!it) throw new Error(`no such intent: ${ref}`);
    return { status: it.status, clientSecret: it.clientSecret, paymentMethod: it.paymentMethod ?? null, customer: it.customer ?? null, ...(it.processing && it.status === "pending" ? { processing: true } : {}) };
  }
  async cancelIntent(ref: string) {
    const it = this.intents.get(ref);
    if (!it) throw new Error(`no such intent: ${ref}`);
    if (it.status === "pending") it.status = "failed";
    return { status: it.status };
  }
  /** What a card form and the provider would do: the person pays (a card used, and kept if asked), or the intent is cancelled. */
  settle(ref: string, status: IntentStatus) {
    const it = this.intents.get(ref);
    if (it) { it.status = status; if (status === "succeeded") it.paymentMethod = `pm_test_${randomBytes(4).toString("hex")}`; }
  }
  /** The card was confirmed and the provider is still finishing it (Stripe's "processing"). */
  processing(ref: string) {
    const it = this.intents.get(ref);
    if (it) it.processing = true;
  }
  async createSetup(i: { customer: string; idempotencyKey: string }) {
    const known = this.byKey.get(`setup:${i.idempotencyKey}`);
    if (known) return { ref: known, clientSecret: this.setups.get(known)!.clientSecret, account: null };
    const ref = `seti_test_${randomBytes(6).toString("hex")}`, clientSecret = `${ref}_secret_${randomBytes(6).toString("hex")}`;
    this.setups.set(ref, { status: "pending", clientSecret, customer: i.customer, paymentMethod: null });
    this.byKey.set(`setup:${i.idempotencyKey}`, ref);
    return { ref, clientSecret, account: null };
  }
  async getSetup(ref: string) {
    const s = this.setups.get(ref);
    if (!s) throw new Error(`no such setup: ${ref}`);
    return { status: s.status, clientSecret: s.clientSecret, paymentMethod: s.paymentMethod, customer: s.customer };
  }
  /** What the card form does for a setup: the card is saved. */
  settleSetup(ref: string, status: IntentStatus = "succeeded") {
    const s = this.setups.get(ref);
    if (s) { s.status = status; if (status === "succeeded") s.paymentMethod = `pm_test_${randomBytes(4).toString("hex")}`; }
  }
  async ensureCustomer(i: { key: string }) {
    if (!this.customers.has(i.key)) this.customers.set(i.key, `cus_test_${randomBytes(4).toString("hex")}`);
    return { id: this.customers.get(i.key)!, account: null };
  }
  private chargesByKey = new Map<string, { asked: string; answer: { ref: string; status: IntentStatus; failure?: string } }>();
  /** As Stripe does: a key used again gets the first answer back (a decline included), and a key used again
   *  for a different charge is refused. */
  async chargeSaved(i: { customer: string; paymentMethod: string; amountCents: number; idempotencyKey: string }) {
    const asked = `${i.customer} ${i.paymentMethod} ${i.amountCents}`, seen = this.chargesByKey.get(i.idempotencyKey);
    if (seen) {
      if (seen.asked !== asked) return { ref: "", status: "failed" as const, failure: "idempotency_error" };
      // As Stripe's own record of it is now: what has been refunded of it since.
      const back = [...this.refunds.values()].filter((r) => r.paymentRef === seen.answer.ref);
      const refunded = back.reduce((n, r) => n + r.amountCents, 0);
      return refunded ? { ...seen.answer, refundedCents: refunded, refundRef: back[0]!.ref } : seen.answer;
    }
    const ref = `pi_test_${randomBytes(6).toString("hex")}`;
    let answer: { ref: string; status: IntentStatus; failure?: string };
    if (this.failNextCharge) { answer = { ref, status: "failed", failure: this.failNextCharge }; this.failNextCharge = null; }
    else { this.charges.push({ customer: i.customer, paymentMethod: i.paymentMethod, amountCents: i.amountCents, ref }); answer = { ref, status: "succeeded" }; }
    this.chargesByKey.set(i.idempotencyKey, { asked, answer });
    return answer;
  }
  /** Every card the stand-in takes is Stripe's test Visa. */
  async cardOf(ref: string) { return this.intents.has(ref) || this.charges.some((c) => c.ref === ref) ? { brand: "visa", last4: "4242" } : null; }
  /** Cards taken off their customer (detachMethod). */
  detached = new Set<string>();
  async methodOf(method: string) { return method.startsWith("pm_test_") && !this.detached.has(method) ? { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 } : null; }
  async detachMethod(method: string) { this.detached.add(method); }
  async refund(i: { paymentRef: string; amountCents: number; idempotencyKey: string }) {
    const seen = this.refunds.get(i.idempotencyKey);
    if (seen) return { ref: seen.ref, ok: true };
    if (this.failNextRefund) { this.failNextRefund = false; return { ref: "", ok: false, failure: "card_declined" }; }
    const ref = `re_test_${randomBytes(6).toString("hex")}`;
    this.refunds.set(i.idempotencyKey, { paymentRef: i.paymentRef, amountCents: i.amountCents, ref, created: new Date() });
    return { ref, ok: true };
  }
  /** As Stripe lists them: payments and refunds made since a time, with Kumi's own ids for them. */
  async listSince(since: Date) {
    const intents: FoundIntent[] = [...this.intents.entries()].filter(([, it]) => (it.created ?? new Date(0)) >= since)
      .map(([ref, it]) => ({ ref, status: it.status, amountCents: it.amountCents, created: it.created ?? new Date(0), kumiPaymentId: it.metadata?.kumi_payment_id ?? null, kumiChargeId: it.metadata?.kumi_charge_id ?? null, email: null, description: it.description, currency: it.currency ?? null }));
    const refunds: FoundRefund[] = [...this.refunds.entries()].filter(([, r]) => (r.created ?? new Date(0)) >= since)
      .map(([key, r]) => ({ ref: r.ref, paymentRef: r.paymentRef, amountCents: r.amountCents, ok: r.status !== "failed", created: r.created ?? new Date(0), kumiRefundId: key, status: r.status ?? "succeeded" }));
    return { intents, refunds };
  }
  async listPayouts(limit: number) {
    return [...this.payouts].sort((a, b) => b.created.getTime() - a.created.getTime()).slice(0, limit);
  }
  async refundsOf(paymentRef: string) {
    const refunds: FoundRefund[] = [...this.refunds.entries()].filter(([, r]) => r.paymentRef === paymentRef)
      .map(([key, r]) => ({ ref: r.ref, paymentRef: r.paymentRef, amountCents: r.amountCents, ok: r.status !== "failed", created: r.created ?? new Date(0), kumiRefundId: key, status: r.status ?? "succeeded" }));
    return { refunds, disputed: this.disputes.has(paymentRef) };
  }
}

let provider: PaymentProvider = new TestProvider();
export function setPaymentProvider(p: PaymentProvider): void { provider = p; }
export function paymentProvider(): PaymentProvider { return provider; }

export type AccountKind = "member_credit" | "receivable" | "revenue" | "provider_clearing" | "cash_drawer" | "refunds_payable" | "adjustment" | "gift_cards" | "passes" | "brought_in";

export async function account(trx: Trx, kind: AccountKind, opts: { personId?: string; revenueType?: string } = {}): Promise<string> {
  // A gift card sold isn't revenue: it's owed until it's redeemed (gift_cards.ts). The paths every payment takes
  // (settle, refunds, the desk) ask for "revenue of type gift_cards"; it's the liability they get.
  if (kind === "revenue" && opts.revenueType === "gift_cards") return account(trx, "gift_cards");
  // A pass sold is owed too, until each use is taken (passes.ts).
  if (kind === "revenue" && opts.revenueType === "passes") return account(trx, "passes");
  const found = await trx.selectFrom("ledger_account").select("id").where("kind", "=", kind)
    .where("person_id", opts.personId ? "=" : "is", opts.personId ?? null).where("revenue_type", opts.revenueType ? "=" : "is", opts.revenueType ?? null).executeTakeFirst();
  if (found) return found.id;
  const id = uuidv7();
  await trx.insertInto("ledger_account").values({ id, kind, person_id: opts.personId ?? null, revenue_type: opts.revenueType ?? null }).onConflict((oc) => oc.doNothing()).execute();
  return (await trx.selectFrom("ledger_account").select("id").where("kind", "=", kind).where("person_id", opts.personId ? "=" : "is", opts.personId ?? null)
    .where("revenue_type", opts.revenueType ? "=" : "is", opts.revenueType ?? null).executeTakeFirstOrThrow()).id;
}

/** One balanced ledger transaction. The database rejects it at commit if it doesn't sum to zero. `at` dates it when
 *  the money moved earlier than now (a card payment found after a restore counts on the day it was paid). */
export async function post(trx: Trx, runId: string, kind: string, memo: string, entries: { account: string; cents: number }[], o: { at?: Date } = {}): Promise<string> {
  const id = uuidv7();
  await trx.insertInto("ledger_txn").values({ id, kind, action_run_id: runId, memo, ...(o.at ? { at: o.at } : {}) }).execute();
  await trx.insertInto("ledger_entry").values(entries.filter((e) => e.cents !== 0).map((e) => ({ txn_id: id, account_id: e.account, amount_cents: String(e.cents) }))).execute();
  return id;
}

export async function creditBalance(db: Trx | import("./db.ts").Db, personId: string): Promise<number> {
  const r = await db.selectFrom("member_credit_balance").select("cents").where("person_id", "=", personId).executeTakeFirst();
  return Number(r?.cents ?? 0);
}
