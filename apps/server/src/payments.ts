// Card payments: the members' app opens a card form for a payment it owes, and the news that it went
// through can arrive three ways (the app checking, Stripe's webhook, the minute job). Each one asks the
// provider rather than trusting the message, so the order and repeats don't matter.
import { Hono, type Context } from "hono";
import { checkPayment, connectStripe, KumiError, openPayment, paymentProvider, refreshStripeAccount, verifyStripeSignature, StripeProvider, type Actor, type Db } from "@kumi/core";

type Me = { id: string } | null;
export interface StripeConfig { publishableKey?: string; webhookSecret?: string }

export function paymentRoutes(db: Db, me: (c: Context<any>) => Me, actor: (c: Context<any>) => Actor, publicUrl: string, stripe: StripeConfig = {}) {
  const app = new Hono();
  /** The Stripe provider when it runs under Connect (the hosted service), else null. */
  const connect = () => { const p = paymentProvider(); return p instanceof StripeProvider && p.connect ? p : null; };
  const clubAccount = async () => (await db.selectFrom("club").select(["stripe_account_id", "stripe_charges_enabled", "stripe_details_submitted"]).executeTakeFirstOrThrow());
  const who = (c: Context<any>) => { const m = me(c); if (!m) throw new KumiError("error.signed_out", {}, 401); return m.id; };
  const mine = async (c: Context<any>) => {
    const pay = await db.selectFrom("payment").select(["id", "person_id"]).where("id", "=", c.req.param("id")!).executeTakeFirst();
    if (!pay || pay.person_id !== who(c)) throw new KumiError("error.not_found", { thing: { en: "payment", es: "el pago" } }, 404);
    return pay.id;
  };

  // Which card form to show. The publishable key is public by design; under Connect the form also
  // names the club's account, since the payment is made there.
  app.get("/payments/config", async (c) => {
    const stripeOn = paymentProvider().name === "stripe", club = connect() ? await clubAccount() : null;
    return c.json({ provider: paymentProvider().name, publishable_key: stripeOn ? stripe.publishableKey ?? null : null,
      stripe_account: club?.stripe_charges_enabled ? club.stripe_account_id : null, ready: !connect() || Boolean(club?.stripe_charges_enabled) });
  });

  app.post("/my/payments/:id/intent", async (c) => {
    const r = await openPayment(db, await mine(c), who(c));
    return c.json({ provider: r.provider, client_secret: r.clientSecret, publishable_key: r.provider === "stripe" ? stripe.publishableKey ?? null : null, stripe_account: r.account });
  });
  app.post("/my/payments/:id/check", async (c) => c.json({ status: await checkPayment(db, await mine(c)) }));

  // Stripe's webhook: only a signed, recent message is read, and it only prompts a check with Stripe.
  app.post("/webhooks/stripe", async (c) => {
    if (!stripe.webhookSecret) return c.json({ error: "not_configured" }, 404);
    const raw = await c.req.text();
    if (!verifyStripeSignature(raw, c.req.header("stripe-signature"), stripe.webhookSecret)) return c.json({ error: "bad_signature" }, 400);
    const ev = JSON.parse(raw) as { type?: string; account?: string; data?: { object?: { id?: string; object?: string } } };
    const cp = connect();
    if (cp && ev.type === "account.updated") { await refreshStripeAccount(db, cp); return c.json({ received: true }); }
    const intent = ev.data?.object?.object === "payment_intent" ? ev.data.object.id : null;
    if (intent) {
      const pay = await db.selectFrom("payment").select("id").where("provider", "=", "stripe").where("provider_ref", "=", intent).executeTakeFirst();
      if (pay) await checkPayment(db, pay.id, "webhook:stripe");
    }
    return c.json({ received: true });
  });

  // ---- Staff: where the club's card payments go ----
  const staff = async (c: Context<any>) => {
    const id = who(c);
    const s = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", id).where("person_role.active", "=", true).where("role.key", "!=", "member").executeTakeFirst();
    if (!s) throw new KumiError("error.staff_only", {}, 403);
  };
  app.get("/staff/payments", async (c) => {
    await staff(c);
    const p = paymentProvider(), club = await clubAccount();
    const mode = p instanceof StripeProvider ? (p.connect ? "connect" : "direct") : "test";
    return c.json({ mode, live: p instanceof StripeProvider && p.live,
      account: mode === "connect" && club.stripe_account_id ? { tail: club.stripe_account_id.slice(-4), charges_enabled: club.stripe_charges_enabled, details_submitted: club.stripe_details_submitted } : null });
  });
  // "Connect with Stripe" and "Continue with Stripe": Stripe's own setup pages, then back to the Payments page.
  app.post("/staff/payments/connect", async (c) => {
    const cp = connect();
    if (!cp) throw new KumiError("error.payments_not_connect", {}, 409);
    const a = actor(c), base = publicUrl.replace(/\/$/, "");
    const email = (await db.selectFrom("person").select("email").where("id", "=", a.personId!).executeTakeFirst())?.email;
    return c.json(await connectStripe(db, cp, a, { refresh: `${base}/payments?stripe=refresh`, return: `${base}/payments?stripe=return` }, email));
  });
  app.post("/staff/payments/refresh", async (c) => {
    await staff(c);
    const cp = connect();
    if (!cp) throw new KumiError("error.payments_not_connect", {}, 409);
    const a = await refreshStripeAccount(db, cp);
    return c.json(a ? { tail: a.id.slice(-4), charges_enabled: a.chargesEnabled, details_submitted: a.detailsSubmitted } : null);
  });
  return app;
}
