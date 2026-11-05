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
  // First Stripe is asked for a refund it already has with Kumi's id for this one (none here), then it's sent, with that id.
  assert.deepEqual([s.calls[0]!.method, s.calls[0]!.path], ["GET", "/v1/refunds"]);
  const sent = s.calls[1]!;
  assert.equal(sent.headers["idempotency-key"], "refund:ref-1");
  assert.equal(sent.body.get("payment_intent"), "pi_1"); assert.equal(sent.body.get("amount"), "1000");
  assert.equal(sent.body.get("metadata[kumi_refund_id]"), "ref-1");
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
  // A declined card: the bank's reason, when Stripe gives one, says more than "declined".
  const broke = new StripeProvider({ secretKey: "sk_test_abc", fetch: fakeStripe(() => ({ status: 402, json: { error: { code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } } })).fetch });
  assert.deepEqual(await broke.chargeSaved({ customer: "cus_1", paymentMethod: "pm_1", amountCents: 3000, currency: "USD", description: "x", idempotencyKey: "b3" }), { ref: "", status: "failed", failure: "insufficient_funds" });
});

test("a saved-card charge asked again (after a restore) is found past the newest 100, with what's been refunded of it", async () => {
  const others = Array.from({ length: 100 }, (_, n) => ({ id: `pi_o${n}`, status: "succeeded", metadata: { kumi_charge_id: `other:${n}` } }));
  const first = { id: "pi_first", status: "succeeded", metadata: { kumi_charge_id: "week:w1" }, latest_charge: { id: "ch_1", amount_refunded: 6000, refunds: { data: [{ id: "re_1" }] } } };
  const s = fakeStripe((c) => c.path === "/v1/payment_intents/search" ? { json: { data: [first] } } : c.method === "GET" ? { json: { data: others, has_more: true } } : { json: { id: "pi_new", status: "succeeded" } });
  const p = new StripeProvider({ secretKey: "sk_test_abc", fetch: s.fetch });
  assert.deepEqual(await p.chargeSaved({ customer: "cus_1", paymentMethod: "pm_1", amountCents: 6000, currency: "USD", description: "weekly court", idempotencyKey: "week:w1" }),
    { ref: "pi_first", status: "succeeded", refundedCents: 6000, refundRef: "re_1" });
  assert.equal(s.calls.filter((c) => c.method === "POST").length, 0, "never charged a second time");
  // Search not there to ask (or refusing): it's charged as before, under the same key.
  const noSearch = fakeStripe((c) => c.path === "/v1/payment_intents/search" ? { status: 400, json: { error: { message: "search isn't available" } } }
    : c.method === "GET" ? { json: { data: others, has_more: true } } : { json: { id: "pi_new", status: "succeeded" } });
  assert.deepEqual(await new StripeProvider({ secretKey: "sk_test_abc", fetch: noSearch.fetch }).chargeSaved({ customer: "cus_1", paymentMethod: "pm_1", amountCents: 6000, currency: "USD", description: "x", idempotencyKey: "week:w2" }),
    { ref: "pi_new", status: "succeeded" });
  assert.equal(noSearch.calls.at(-1)!.headers["idempotency-key"], "charge:week:w2");
});

test("Apple Pay and Google Pay: the members' domain is registered once, switched back on, or checked again", async () => {
  let existing: any = null;
  const s = fakeStripe((c) => {
    if (c.method === "GET") return { json: { data: existing ? [existing] : [] } };
    if (c.path === "/v1/payment_method_domains") return { json: (existing = { id: "pmd_1", domain_name: c.body.get("domain_name"), enabled: true, apple_pay: { status: "active" }, google_pay: { status: "active" } }) };
    if (c.path === "/v1/payment_method_domains/pmd_1") return { json: (existing = { ...existing, enabled: c.body.get("enabled") === "true" }) };
    if (c.path === "/v1/payment_method_domains/pmd_1/validate") return { json: (existing = { ...existing, apple_pay: { status: "active" } }) };
    return { status: 400, json: {} };
  });
  const p = new StripeProvider({ secretKey: "sk_test_abc", fetch: s.fetch });
  assert.equal(await p.walletDomain("kestrelpadel.com"), null);
  assert.deepEqual(await p.registerWalletDomain("kestrelpadel.com"), { id: "pmd_1", domain: "kestrelpadel.com", enabled: true, applePay: "active", googlePay: "active", problem: null });
  assert.equal(s.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(s.calls.find((c) => c.method === "POST")!.headers["idempotency-key"], "pmd:kestrelpadel.com");
  await p.registerWalletDomain("kestrelpadel.com");   // already there and active: nothing more
  assert.equal(s.calls.filter((c) => c.method === "POST").length, 1);
  existing = { ...existing, enabled: false, apple_pay: { status: "inactive" } };   // switched off in the dashboard
  const back = (await p.registerWalletDomain("kestrelpadel.com"))!;
  assert.deepEqual([back.enabled, back.applePay], [true, "active"]);
  assert.deepEqual(s.calls.filter((c) => c.method === "POST").slice(1).map((c) => c.path), ["/v1/payment_method_domains/pmd_1", "/v1/payment_method_domains/pmd_1/validate"]);
  // Under Connect, on the club's own account; before it has one, nothing.
  let acct: string | null = null;
  const c = new StripeProvider({ secretKey: "sk_test_abc", fetch: s.fetch, connect: async () => ({ id: acct, ready: false }) });
  assert.equal(await c.registerWalletDomain("kestrelpadel.com"), null);
  acct = "acct_9";
  await c.walletDomain("kestrelpadel.com");
  assert.equal(s.calls.at(-1)!.headers["stripe-account"], "acct_9");
});
