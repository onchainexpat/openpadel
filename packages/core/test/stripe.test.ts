import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { intentStatus, stripeForm, verifyStripeSignature, StripeError, StripeProvider, STRIPE_API_VERSION } from "../src/index.ts";

type Call = { method: string; path: string; headers: Record<string, string>; body: URLSearchParams };
/** Stands in for api.stripe.com: records each call and answers from a script. */
function fakeStripe(answer: (c: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const c = { method: init?.method ?? "GET", path: new URL(url).pathname, headers: init?.headers as Record<string, string>, body: new URLSearchParams(String(init?.body ?? "")) };
    calls.push(c);
    const a = answer(c);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

test("Stripe's form encoding nests keys", () => {
  assert.deepEqual(stripeForm({ amount: 2500, metadata: { kumi_payment_id: "p 1" }, payment_method_types: ["card"], skip: undefined }),
    ["amount=2500", "metadata%5Bkumi_payment_id%5D=p%201", "payment_method_types%5B0%5D=card"]);
});

test("a payment intent: the amount, the club's currency, a retry key, and the version pinned", async () => {
  const s = fakeStripe(() => ({ json: { id: "pi_1", client_secret: "pi_1_secret_x", status: "requires_payment_method" } }));
  const p = new StripeProvider({ secretKey: "sk_test_abc", fetch: s.fetch });
  assert.deepEqual(await p.createIntent({ amountCents: 2500, currency: "USD", description: "Friday Americano", idempotencyKey: "pay-1", metadata: { kumi_payment_id: "pay-1" } }), { ref: "pi_1", clientSecret: "pi_1_secret_x", account: null });
  const c = s.calls[0]!;
  assert.equal(c.method, "POST"); assert.equal(c.path, "/v1/payment_intents");
  assert.equal(c.headers.authorization, "Bearer sk_test_abc");
  assert.equal(c.headers["idempotency-key"], "intent:pay-1");
  assert.equal(c.headers["stripe-version"], STRIPE_API_VERSION);
  assert.equal(c.body.get("amount"), "2500"); assert.equal(c.body.get("currency"), "usd");
  assert.equal(c.body.get("metadata[kumi_payment_id]"), "pay-1"); assert.equal(c.body.get("payment_method_types[0]"), "card", "cards only");
});

test("only a payment that went through is paid; a declined card can still be retried", async () => {
  for (const [s, want] of [["succeeded", "succeeded"], ["canceled", "failed"], ["requires_payment_method", "pending"], ["processing", "pending"], ["requires_action", "pending"]] as const)
    assert.equal(intentStatus(s), want);
  const s = fakeStripe(() => ({ json: { id: "pi_1", client_secret: "cs", status: "succeeded" } }));
  assert.deepEqual(await new StripeProvider({ secretKey: "sk_test_abc", fetch: s.fetch }).getIntent("pi_1"), { status: "succeeded", clientSecret: "cs", paymentMethod: null, customer: null });
  assert.equal(s.calls[0]!.method, "GET"); assert.equal(s.calls[0]!.path, "/v1/payment_intents/pi_1");
});

test("refunds: sent, pending, refused by Stripe, or Stripe unreachable (tried again later)", async () => {
  const make = (status: number, json: unknown) => new StripeProvider({ secretKey: "sk_test_abc", fetch: fakeStripe(() => ({ status, json })).fetch });
  const s = fakeStripe(() => ({ json: { id: "re_1", status: "succeeded" } }));
  assert.deepEqual(await new StripeProvider({ secretKey: "sk_test_abc", fetch: s.fetch }).refund({ paymentRef: "pi_1", amountCents: 1000, idempotencyKey: "ref-1" }), { ref: "re_1", ok: true });
  assert.equal(s.calls[0]!.headers["idempotency-key"], "refund:ref-1");
  assert.equal(s.calls[0]!.body.get("payment_intent"), "pi_1"); assert.equal(s.calls[0]!.body.get("amount"), "1000");
  assert.equal((await make(200, { id: "re_2", status: "pending" }).refund({ paymentRef: "pi_1", amountCents: 1, idempotencyKey: "k" })).ok, true);
  assert.deepEqual(await make(400, { error: { code: "charge_already_refunded", message: "already" } }).refund({ paymentRef: "pi_1", amountCents: 1, idempotencyKey: "k" }), { ref: "", ok: false, failure: "charge_already_refunded" });
  await assert.rejects(make(500, { error: { message: "down" } }).refund({ paymentRef: "pi_1", amountCents: 1, idempotencyKey: "k" }), StripeError);
  await assert.rejects(make(429, { error: { message: "slow down" } }).refund({ paymentRef: "pi_1", amountCents: 1, idempotencyKey: "k" }), StripeError);
});

test("keys: test and live are told apart, and anything else is refused", () => {
  assert.equal(new StripeProvider({ secretKey: "sk_test_abc" }).live, false);
  assert.equal(new StripeProvider({ secretKey: "sk_live_abc" }).live, true);
  assert.throws(() => new StripeProvider({ secretKey: "pk_test_abc" }));
});

test("a webhook is read only when Stripe signed it, recently", () => {
  const secret = "whsec_test", body = JSON.stringify({ type: "payment_intent.succeeded" }), now = Date.now(), t = Math.floor(now / 1000);
  const sig = (ts: number, b = body, key = secret) => createHmac("sha256", key).update(`${ts}.${b}`).digest("hex");
  assert.ok(verifyStripeSignature(body, `t=${t},v1=${sig(t)}`, secret, now));
  assert.ok(verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)},v1=${sig(t)}`, secret, now), "any v1 may match (Stripe sends two while a secret rolls)");
  assert.ok(!verifyStripeSignature(body, `t=${t},v1=${sig(t, body, "whsec_other")}`, secret, now), "signed with another secret");
  assert.ok(!verifyStripeSignature(`${body} `, `t=${t},v1=${sig(t)}`, secret, now), "body changed");
  assert.ok(!verifyStripeSignature(body, `t=${t - 600},v1=${sig(t - 600)}`, secret, now), "too old: a replay");
  assert.ok(!verifyStripeSignature(body, null, secret, now));
  assert.ok(!verifyStripeSignature(body, `t=${t},v1=nothex`, secret, now));
});

test("pay my part: a card saved for later (never held), and the one charge at the deadline", async () => {
  const s = fakeStripe((c) => ({ json: c.path === "/v1/customers" ? { id: "cus_1" } : { id: "pi_9", client_secret: "cs", status: "succeeded", payment_method: { id: "pm_1" }, customer: "cus_1" } }));
  const p = new StripeProvider({ secretKey: "sk_test_abc", fetch: s.fetch });
  assert.deepEqual(await p.ensureCustomer({ key: "person-1", email: "ann@example.test", name: "Ann" }), { id: "cus_1", account: null });
  assert.equal(s.calls[0]!.headers["idempotency-key"], "customer:person-1");
  await p.createIntent({ amountCents: 1500, currency: "USD", description: "Court booking KP-AAAA", idempotencyKey: "pay-1", customer: "cus_1", saveCard: true });
  assert.equal(s.calls[1]!.body.get("customer"), "cus_1"); assert.equal(s.calls[1]!.body.get("setup_future_usage"), "off_session");
  assert.equal(s.calls[1]!.body.get("capture_method"), null, "saved, not held");
  assert.deepEqual(await p.getIntent("pi_9"), { status: "succeeded", clientSecret: "cs", paymentMethod: "pm_1", customer: "cus_1" });
  const c = await p.chargeSaved({ customer: "cus_1", paymentMethod: "pm_1", amountCents: 3000, currency: "USD", description: "unpaid shares", idempotencyKey: "b1" });
  assert.deepEqual(c, { ref: "pi_9", status: "succeeded" });
  assert.equal(s.calls.at(-1)!.body.get("off_session"), "true"); assert.equal(s.calls.at(-1)!.headers["idempotency-key"], "charge:b1");
  const declined = new StripeProvider({ secretKey: "sk_test_abc", fetch: fakeStripe(() => ({ status: 402, json: { error: { code: "authentication_required", message: "needs the owner" } } })).fetch });
  assert.deepEqual(await declined.chargeSaved({ customer: "cus_1", paymentMethod: "pm_1", amountCents: 3000, currency: "USD", description: "x", idempotencyKey: "b2" }), { ref: "", status: "failed", failure: "authentication_required" });
});
