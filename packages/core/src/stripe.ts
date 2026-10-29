// Stripe, through its REST API: card payments into the club's own account, and refunds back to the
// card. No SDK; three calls and a signature check. Connect (a club linking its own account to a hosted
// Kumi) adds the account header later.
import { createHmac, timingSafeEqual } from "node:crypto";
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

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  private readonly o: { secretKey: string; fetch: Fetch; baseUrl: string };
  constructor(o: { secretKey: string; fetch?: Fetch; baseUrl?: string }) {
    if (!/^(sk|rk)_(test|live)_/.test(o.secretKey)) throw new Error("that isn't a Stripe secret key");
    this.o = { fetch: globalThis.fetch.bind(globalThis), baseUrl: "https://api.stripe.com", ...o };
  }
  get live() { return this.o.secretKey.includes("_live_"); }

  private async call(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.o.secretKey}`, "stripe-version": STRIPE_API_VERSION };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let body: string | undefined;
    if (params) { headers["content-type"] = "application/x-www-form-urlencoded"; body = stripeForm(params).join("&"); }
    const r = await this.o.fetch(`${this.o.baseUrl}${path}`, { method, headers, body });
    const d = await r.json().catch(() => ({})) as any;
    if (!r.ok) throw new StripeError(d?.error?.message ?? `stripe ${r.status}`, d?.error?.code ?? d?.error?.type ?? null, r.status);
    return d;
  }

  async createIntent(i: { amountCents: number; currency: string; description: string; idempotencyKey: string; metadata?: Record<string, string> }) {
    const d = await this.call("POST", "/v1/payment_intents", { amount: i.amountCents, currency: i.currency.toLowerCase(), description: i.description,
      automatic_payment_methods: { enabled: true }, metadata: i.metadata }, `intent:${i.idempotencyKey}`);
    return { ref: String(d.id), clientSecret: String(d.client_secret) };
  }

  async getIntent(ref: string) {
    const d = await this.call("GET", `/v1/payment_intents/${encodeURIComponent(ref)}`);
    return { status: intentStatus(d.status), clientSecret: String(d.client_secret) };
  }

  async refund(i: { paymentRef: string; amountCents: number; idempotencyKey: string }) {
    try {
      const d = await this.call("POST", "/v1/refunds", { payment_intent: i.paymentRef, amount: i.amountCents }, `refund:${i.idempotencyKey}`);
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
