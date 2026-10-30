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
  constructor(message: string, code: string | null, status: number) { super(message); this.code = code; this.status = status; }
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
    if (account) headers["stripe-account"] = account;
    let body: string | undefined;
    if (params) { headers["content-type"] = "application/x-www-form-urlencoded"; body = stripeForm(params).join("&"); }
    const r = await this.o.fetch(`${this.o.baseUrl}${path}`, { method, headers, body });
    const d = await r.json().catch(() => ({})) as any;
    if (!r.ok) throw new StripeError(d?.error?.message ?? `stripe ${r.status}`, d?.error?.code ?? d?.error?.type ?? null, r.status);
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
      const d = await this.call("POST", "/v1/payment_intents", { amount: i.amountCents, currency: i.currency.toLowerCase(), description: i.description, customer: i.customer,
        payment_method: i.paymentMethod, payment_method_types: ["card"], off_session: true, confirm: true }, `charge:${i.idempotencyKey}`, i.account);
      return { ref: String(d.id), status: intentStatus(d.status), ...(d.status === "succeeded" ? {} : { failure: String(d.status) }) };
    } catch (e) {
      // A declined card, or one that needs its owner to confirm: a failed charge, for the desk to settle.
      if (e instanceof StripeError && e.status >= 400 && e.status < 500 && e.status !== 429) return { ref: "", status: "failed" as const, failure: e.code ?? e.message };
      throw e;
    }
  }

  async refund(i: { paymentRef: string; amountCents: number; idempotencyKey: string; account?: string | null }) {
    try {
      const d = await this.call("POST", "/v1/refunds", { payment_intent: i.paymentRef, amount: i.amountCents }, `refund:${i.idempotencyKey}`, i.account);
      // "pending" is normal for some cards: Stripe has it and will send it.
      const ok = ["succeeded", "pending", "requires_action"].includes(d.status);
      return { ref: String(d.id), ok, ...(ok ? {} : { failure: String(d.failure_reason ?? d.status) }) };
    } catch (e) {
      // Stripe said no (already refunded, more than was paid...): a failed refund for staff to see.
      // Anything else (the network, Stripe down) is thrown, so the outbox tries again later.
      if (e instanceof StripeError && e.status >= 400 && e.status < 500 && e.status !== 429) return { ref: "", ok: false, failure: e.code ?? e.message };
      throw e;
    }
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
  async getAccount(account: string): Promise<AccountState> {
    const d = await this.call("GET", `/v1/accounts/${encodeURIComponent(account)}`);
    return { id: String(d.id), chargesEnabled: Boolean(d.charges_enabled), detailsSubmitted: Boolean(d.details_submitted),
      name: d.settings?.dashboard?.display_name ?? d.business_profile?.name ?? null };
  }
}

export interface AccountState { id: string; chargesEnabled: boolean; detailsSubmitted: boolean; name: string | null }

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
