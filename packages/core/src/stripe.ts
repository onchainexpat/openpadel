// Stripe, through its REST API: card payments into the club's own account, and refunds back to the
// card. No SDK; three calls and a signature check. Connect (a club linking its own account to a hosted
// Kumi) adds the account header later.
import { createHmac, timingSafeEqual } from "node:crypto";
import { KumiError } from "./errors.ts";
import type { IntentStatus, PaymentProvider } from "./money.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/** Pinned, so Stripe can't change an answer's shape under us; moved on deliberately. */
export const STRIPE_API_VERSION = "2024-06-20";

export class StripeError extends Error {
  readonly code: string | null; readonly status: number;
  /** A declined card's reason from the bank (insufficient_funds, expired_card, ...), when Stripe gives one. */
  readonly decline: string | null;
  constructor(message: string, code: string | null, status: number, decline: string | null = null) { super(message); this.code = code; this.status = status; this.decline = decline; }
}

/** Stripe's form encoding, including nested keys: { metadata: { a: "1" } } is metadata[a]=1. */
export function stripeForm(params: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(params).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) return [];
    if (typeof v === "object") return stripeForm(v as Record<string, unknown>, key);
    return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`];
  });
}

/** The club's own Stripe account, under Connect: its id, and whether Stripe lets it take payments yet. */
export type ConnectedAccount = () => Promise<{ id: string | null; ready: boolean }>;

/**
 * Two ways to run. Direct (self-hosting): the key is the club's own, and payments land in its account.
 * Connect (the hosted service): the key is Kumi's platform key, and every payment is made on the club's
 * own connected account (a direct charge), so the money, the fees and any dispute are the club's.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  private readonly o: { secretKey: string; fetch: Fetch; baseUrl: string; connect?: ConnectedAccount };
  constructor(o: { secretKey: string; fetch?: Fetch; baseUrl?: string; connect?: ConnectedAccount }) {
    if (!/^(sk|rk)_(test|live)_/.test(o.secretKey)) throw new Error("that isn't a Stripe secret key");
    this.o = { fetch: globalThis.fetch.bind(globalThis), baseUrl: "https://api.stripe.com", ...o };
  }
  get live() { return this.o.secretKey.includes("_live_"); }
  get connect() { return Boolean(this.o.connect); }

  private async call(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string, account?: string | null): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.o.secretKey}`, "stripe-version": STRIPE_API_VERSION };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    // Only under Connect: run directly, the key is the club's own account's. A club that moved here from a hosted
    // Kumi (its payments remember the account they were made on) reaches them with its own key, no header.
    if (account && this.o.connect) headers["stripe-account"] = account;
    let body: string | undefined;
    if (params) { headers["content-type"] = "application/x-www-form-urlencoded"; body = stripeForm(params).join("&"); }
    const r = await this.o.fetch(`${this.o.baseUrl}${path}`, { method, headers, body });
    const d = await r.json().catch(() => ({})) as any;
    if (!r.ok) throw new StripeError(d?.error?.message ?? `stripe ${r.status}`, d?.error?.code ?? d?.error?.type ?? null, r.status, d?.error?.decline_code ?? null);
    return d;
  }

  /** Which account a new payment is made on: none in direct mode; the club's, once it's ready, under Connect. */
  private async payingAccount(): Promise<string | null> {
    if (!this.o.connect) return null;
    const a = await this.o.connect();
    if (!a.id || !a.ready) throw new KumiError("error.payments_not_set_up", {}, 409);
    return a.id;
  }

  async createIntent(i: { amountCents: number; currency: string; description: string; idempotencyKey: string; metadata?: Record<string, string>; customer?: string; saveCard?: boolean }) {
    const account = await this.payingAccount();
    // Cards only, whatever else the Stripe account has switched on: Apple Pay and Google Pay are cards
    // underneath, so every payment refunds the same way, straight back to the card. A card saved for a
    // later charge is saved, never held: nothing is reserved on it.
    const d = await this.call("POST", "/v1/payment_intents", { amount: i.amountCents, currency: i.currency.toLowerCase(), description: i.description,
      payment_method_types: ["card"], metadata: i.metadata, customer: i.customer, ...(i.saveCard ? { setup_future_usage: "off_session" } : {}) }, `intent:${i.idempotencyKey}`, account);
    return { ref: String(d.id), clientSecret: String(d.client_secret), account };
  }

  async getIntent(ref: string, account?: string | null) {
    const d = await this.call("GET", `/v1/payment_intents/${encodeURIComponent(ref)}`, undefined, undefined, account);
    const id = (v: unknown) => (typeof v === "string" ? v : (v as { id?: string } | null)?.id ?? null);
    return { status: intentStatus(d.status), clientSecret: String(d.client_secret), paymentMethod: id(d.payment_method), customer: id(d.customer) };
  }

  async createSetup(i: { customer: string; idempotencyKey: string; metadata?: Record<string, string> }) {
    const account = await this.payingAccount();
    // A card saved for charging later without the person present; nothing is charged or held now.
    const d = await this.call("POST", "/v1/setup_intents", { customer: i.customer, payment_method_types: ["card"], usage: "off_session", metadata: i.metadata },
      `setup:${i.idempotencyKey}`, account);
    return { ref: String(d.id), clientSecret: String(d.client_secret), account };
  }

  async getSetup(ref: string, account?: string | null) {
    const d = await this.call("GET", `/v1/setup_intents/${encodeURIComponent(ref)}`, undefined, undefined, account);
    const id = (v: unknown) => (typeof v === "string" ? v : (v as { id?: string } | null)?.id ?? null);
    return { status: intentStatus(d.status), clientSecret: String(d.client_secret), paymentMethod: id(d.payment_method), customer: id(d.customer) };
  }

  async cancelIntent(ref: string, account?: string | null) {
    try {
      const d = await this.call("POST", `/v1/payment_intents/${encodeURIComponent(ref)}/cancel`, {}, `cancel:${ref}`, account);
      return { status: intentStatus(d.status) };
    } catch (e) {
      // Too late to cancel (it went through, or is going through): say where it stands.
      if (e instanceof StripeError && e.status === 400) return { status: (await this.getIntent(ref, account)).status };
      throw e;
    }
  }

  async ensureCustomer(i: { key: string; email?: string | null; name?: string }) {
    const account = await this.payingAccount();
    const d = await this.call("POST", "/v1/customers", { email: i.email ?? undefined, name: i.name, metadata: { kumi_person_id: i.key } }, `customer:${i.key}`, account);
    return { id: String(d.id), account };
  }

  async chargeSaved(i: { customer: string; paymentMethod: string; amountCents: number; currency: string; description: string; idempotencyKey: string; account?: string | null }) {
    try {
      // Stripe remembers an idempotency key for a day. Asked again later (the database restored to before this
      // charge, from a backup or a minute in the archive; a club's export restored on another server), the charge
      // Stripe already has for this one, by Kumi's own id for it, is the answer: never a second. The key is the
      // same for a retry of the same charge (a renewal's period and attempt, a booking's deadline).
      // Its charge comes too, so one found says what's been refunded of it since (a week charged and then given
      // back before the copy was taken isn't paid).
      const had = await this.call("GET", `/v1/payment_intents?customer=${encodeURIComponent(i.customer)}&limit=100&expand[]=data.latest_charge`, undefined, undefined, i.account);
      const mine = (p: any) => p?.metadata?.kumi_charge_id === i.idempotencyKey;
      let found = (had?.data ?? []).find(mine);
      // Beyond the newest 100 (someone who pays often, a copy from long ago): Stripe's search by Kumi's id for it.
      // Search can be slow to see a new payment, but one that new is in the 100. If search isn't there to ask,
      // the idempotency key still holds for a day.
      if (!found && had?.has_more) {
        const q = encodeURIComponent(`metadata['kumi_charge_id']:'${i.idempotencyKey}'`);
        found = (await this.call("GET", `/v1/payment_intents/search?query=${q}&expand[]=data.latest_charge`, undefined, undefined, i.account).catch(() => null))?.data?.find(mine);
      }
      const d = found ?? await this.call("POST", "/v1/payment_intents", { amount: i.amountCents, currency: i.currency.toLowerCase(), description: i.description, customer: i.customer,
        payment_method: i.paymentMethod, payment_method_types: ["card"], off_session: true, confirm: true, metadata: { kumi_charge_id: i.idempotencyKey } }, `charge:${i.idempotencyKey}`, i.account);
      const charge = typeof d.latest_charge === "object" && d.latest_charge ? d.latest_charge : null, refunded = Number(charge?.amount_refunded ?? 0);
      return { ref: String(d.id), status: intentStatus(d.status), ...(d.status === "succeeded" ? {} : { failure: String(d.status) }),
        ...(found && refunded > 0 ? { refundedCents: refunded, ...(charge?.refunds?.data?.[0]?.id ? { refundRef: String(charge.refunds.data[0].id) } : {}) } : {}) };
    } catch (e) {
      // A declined card, or one that needs its owner to confirm: a failed charge, for the desk to settle.
      if (e instanceof StripeError && e.status >= 400 && e.status < 500 && e.status !== 429) return { ref: "", status: "failed" as const, failure: e.decline ?? e.code ?? e.message };
      throw e;
    }
  }

  async refund(i: { paymentRef: string; amountCents: number; idempotencyKey: string; account?: string | null }) {
    // "pending" is normal for some cards: Stripe has it and will send it.
    const answer = (d: any) => { const ok = ["succeeded", "pending", "requires_action"].includes(d.status); return { ref: String(d.id), ok, ...(ok ? {} : { failure: String(d.failure_reason ?? d.status) }) }; };
    try {
      // Stripe remembers an idempotency key for a day. Asked again later (a club's export restored on another server
      // while the old one sent it, or the staff sending it again), the refund Stripe already has for this one, by
      // Kumi's own id for it, is the answer: never a second. One that failed or was cancelled can go again.
      const had = await this.call("GET", `/v1/refunds?payment_intent=${encodeURIComponent(i.paymentRef)}&limit=100`, undefined, undefined, i.account);
      const found = (had?.data ?? []).find((r: any) => r?.metadata?.kumi_refund_id === i.idempotencyKey && !["failed", "canceled"].includes(r.status));
      if (found) return answer(found);
      return answer(await this.call("POST", "/v1/refunds", { payment_intent: i.paymentRef, amount: i.amountCents, metadata: { kumi_refund_id: i.idempotencyKey } }, `refund:${i.idempotencyKey}`, i.account));
    } catch (e) {
      // Stripe said no (already refunded, more than was paid...): a failed refund for staff to see.
      // Anything else (the network, Stripe down) is thrown, so the outbox tries again later.
      if (e instanceof StripeError && e.status >= 400 && e.status < 500 && e.status !== 429) return { ref: "", ok: false, failure: e.code ?? e.message };
      throw e;
    }
  }

  /** Payments and refunds made since a time, on the account payments are made on (after a restore: what the club's
   *  database may have no record of). Every page back to the time (up to 20,000 of each, newest first); `cut` says when
   *  that limit was reached, so the caller can say plainly that older ones weren't looked at. */
  async listSince(since: Date, account?: string | null) {
    let cut = false;
    const page = async (path: string) => {
      const out: any[] = [];
      let after: string | null = null;
      for (let i = 0; ; i++) {
        if (i === 200) { cut = true; break; }
        const d = await this.call("GET", `${path}?created[gte]=${Math.floor(since.getTime() / 1000)}&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`, undefined, undefined, account);
        out.push(...(d?.data ?? []));
        if (!d?.has_more || !d.data?.length) break;
        after = String(d.data[d.data.length - 1].id);
      }
      return out;
    };
    const status = (x: string): IntentStatus => x === "succeeded" ? "succeeded" : x === "canceled" ? "failed" : "pending";
    const intents = (await page("/v1/payment_intents")).map((d) => ({ ref: String(d.id), status: status(String(d.status)), amountCents: Number(d.amount_received ?? d.amount ?? 0),
      created: new Date(Number(d.created) * 1000), kumiPaymentId: d.metadata?.kumi_payment_id ?? null, kumiChargeId: d.metadata?.kumi_charge_id ?? null, email: d.receipt_email ?? null, description: d.description ?? null,
      currency: typeof d.currency === "string" ? d.currency.toUpperCase() : null }));
    const refunds = (await page("/v1/refunds")).map((d) => ({ ref: String(d.id), paymentRef: String(d.payment_intent ?? ""), amountCents: Number(d.amount ?? 0),
      ok: ["succeeded", "pending", "requires_action"].includes(String(d.status)), created: new Date(Number(d.created) * 1000), kumiRefundId: d.metadata?.kumi_refund_id ?? null }));
    return { intents, refunds, cut };
  }

  /** The card a payment went through on (its latest charge), for the receipt: brand and last four only. */
  async cardOf(ref: string, account?: string | null) {
    const d = await this.call("GET", `/v1/payment_intents/${encodeURIComponent(ref)}?expand[]=latest_charge`, undefined, undefined, account);
    const c = d?.latest_charge?.payment_method_details?.card;
    return c?.brand && /^\d{4}$/.test(String(c.last4 ?? "")) ? { brand: String(c.brand), last4: String(c.last4) } : null;
  }

  // ---- Apple Pay and Google Pay: the members' web address, registered with Stripe ----
  /** The account a domain is registered on: the one payments are made on (the club's own under Connect, since
   *  they're direct charges). Undefined while a connected club's account isn't there yet. */
  private async domainAccount(): Promise<string | null | undefined> {
    if (!this.o.connect) return null;
    const a = await this.o.connect();
    return a.id ?? undefined;
  }
  /** Where a web domain stands for the wallets on the card form (null: not registered, or no account yet). */
  async walletDomain(domain: string): Promise<WalletDomain | null> {
    const account = await this.domainAccount();
    if (account === undefined) return null;
    const d = await this.call("GET", `/v1/payment_method_domains?domain_name=${encodeURIComponent(domain)}&limit=1`, undefined, undefined, account);
    const pmd = (d?.data ?? [])[0];
    return pmd ? walletDomainOf(pmd) : null;
  }
  /** Register a web domain so the card form can offer Apple Pay and Google Pay there (Stripe needs each domain that
   *  shows it; it does Apple's merchant check itself, so there's no file to host). Safe to repeat: a registered
   *  domain is switched back on if it was off, and checked again if Apple Pay isn't active on it yet. */
  async registerWalletDomain(domain: string): Promise<WalletDomain | null> {
    const account = await this.domainAccount();
    if (account === undefined) return null;
    const found = (await this.call("GET", `/v1/payment_method_domains?domain_name=${encodeURIComponent(domain)}&limit=1`, undefined, undefined, account))?.data?.[0];
    let pmd = found ?? await this.call("POST", "/v1/payment_method_domains", { domain_name: domain }, `pmd:${domain}`, account);
    if (!pmd.enabled) pmd = await this.call("POST", `/v1/payment_method_domains/${encodeURIComponent(pmd.id)}`, { enabled: true }, undefined, account);
    if (found && pmd.apple_pay?.status !== "active") pmd = await this.call("POST", `/v1/payment_method_domains/${encodeURIComponent(pmd.id)}/validate`, {}, undefined, account);
    return walletDomainOf(pmd);
  }

  // ---- Connect: the club's own Stripe account ----
  /** A new Standard account for the club: its own Stripe account, dashboard and payouts. */
  async createAccount(i: { country: string; email?: string | null; idempotencyKey: string }): Promise<string> {
    const d = await this.call("POST", "/v1/accounts", { type: "standard", country: i.country, email: i.email ?? undefined, metadata: { kumi: "club" } }, `account:${i.idempotencyKey}`);
    return String(d.id);
  }
  /** A one-time link to Stripe's own setup pages for that account; it expires within minutes. */
  async accountLink(account: string, urls: { refresh: string; return: string }): Promise<string> {
    const d = await this.call("POST", "/v1/account_links", { account, refresh_url: urls.refresh, return_url: urls.return, type: "account_onboarding" });
    return String(d.url);
  }
  /** The currency the account pays out in (the club's own account under Connect, else the key's account), or null if
   *  Stripe doesn't say. Reading only: the doctor compares it with the club's currency. */
  async defaultCurrency(): Promise<string | null> {
    let path = "/v1/account";
    if (this.o.connect) { const a = await this.o.connect(); if (!a.id) return null; path = `/v1/accounts/${encodeURIComponent(a.id)}`; }
    const d = await this.call("GET", path);
    return typeof d.default_currency === "string" ? d.default_currency.toUpperCase() : null;
  }

  async getAccount(account: string): Promise<AccountState> {
    const d = await this.call("GET", `/v1/accounts/${encodeURIComponent(account)}`);
    return { id: String(d.id), chargesEnabled: Boolean(d.charges_enabled), detailsSubmitted: Boolean(d.details_submitted),
      name: d.settings?.dashboard?.display_name ?? d.business_profile?.name ?? null };
  }
}

export interface AccountState { id: string; chargesEnabled: boolean; detailsSubmitted: boolean; name: string | null }
/** A domain registered for the wallets: Stripe's id, whether it's on, and Apple Pay's and Google Pay's state
 *  ("active", or "inactive" with Stripe's reason). */
export interface WalletDomain { id: string; domain: string; enabled: boolean; applePay: string; googlePay: string; problem: string | null }
function walletDomainOf(d: any): WalletDomain {
  return { id: String(d.id), domain: String(d.domain_name), enabled: Boolean(d.enabled), applePay: String(d.apple_pay?.status ?? "inactive"), googlePay: String(d.google_pay?.status ?? "inactive"),
    problem: d.apple_pay?.status_details?.error_message ?? d.google_pay?.status_details?.error_message ?? null };
}

/** Only a payment that went through is paid, and only a cancelled intent has failed: after a declined
 *  card the person can still try another. */
export function intentStatus(s: string): IntentStatus {
  return s === "succeeded" ? "succeeded" : s === "canceled" ? "failed" : "pending";
}

/** A webhook really came from Stripe: the Stripe-Signature header's HMAC over "timestamp.body", recent. */
export function verifyStripeSignature(payload: string, header: string | null | undefined, secret: string, now = Date.now(), toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest();
  return parts.filter(([k]) => k === "v1").some(([, v]) => {
    const got = Buffer.from(v ?? "", "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
