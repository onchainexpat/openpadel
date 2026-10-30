// Card payments: the members' app opens a card form for a payment it owes, and the news that it went
// through can arrive three ways (the app checking, Stripe's webhook, the minute job). Each one asks the
// provider rather than trusting the message, so the order and repeats don't matter.
import { Hono, type Context } from "hono";
import { checkCardSetup, checkFamilyCard, checkPayment, connectStripe, kidOf, KumiError, manages, openCardSetup, openFamilyCardSetup, openPayment, payWithFamilyCard, paymentProvider, refreshStripeAccount, verifyStripeSignature, StripeProvider, type Actor, type Db } from "@kumi/core";

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
    // Their own, or one for a junior they manage.
    if (!pay || (pay.person_id !== who(c) && !(await manages(db, who(c), pay.person_id)))) throw new KumiError("error.not_found", { thing: { en: "payment", es: "el pago" } }, 404);
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
    const id = await mine(c), pid = who(c);
    // A kid's own payment goes on the family card, never a card form: paid now, or waiting for a parent.
    const pay = await db.selectFrom("payment").select(["person_id", "parent_to_pay_at", "status"]).where("id", "=", id).executeTakeFirstOrThrow();
    if (pay.person_id === pid && await kidOf(db, pid)) {
      if (pay.status === "pending" && pay.parent_to_pay_at) return c.json({ family: "parent" });
      const f = await payWithFamilyCard(db, id, new Date());
      if (f) return c.json({ family: f.status, cents: f.cents });
    }
    const r = await openPayment(db, id, pid);
    return c.json({ provider: r.provider, client_secret: r.clientSecret, publishable_key: r.provider === "stripe" ? stripe.publishableKey ?? null : null, stripe_account: r.account });
  });
  app.post("/my/payments/:id/check", async (c) => c.json({ status: await checkPayment(db, await mine(c)) }));
  // Saving the card for a membership joined before its plan starts: a card setup, nothing charged.
  app.post("/my/memberships/:id/card", async (c) => {
    const r = await openCardSetup(db, c.req.param("id"), who(c));
    return c.json({ provider: r.provider, client_secret: r.clientSecret, publishable_key: r.provider === "stripe" ? stripe.publishableKey ?? null : null, stripe_account: r.account });
  });
  app.post("/my/memberships/:id/card/check", async (c) => {
    const m = await db.selectFrom("membership").select(["id", "person_id"]).where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!m || m.person_id !== who(c)) throw new KumiError("error.not_found", { thing: { en: "membership", es: "la membresía" } }, 404);
    return c.json({ status: await checkCardSetup(db, m.id) });
  });

  // A parent saving the family card (a card setup, nothing charged), for their kids with a login of their own.
  app.post("/my/family/card", async (c) => {
    const r = await openFamilyCardSetup(db, actor(c));
    return c.json({ card_id: r.cardId, provider: r.provider, client_secret: r.clientSecret, publishable_key: r.provider === "stripe" ? stripe.publishableKey ?? null : null, stripe_account: r.account });
  });
  app.post("/my/family/card/:id/check", async (c) => {
    const card = await db.selectFrom("family_card").select(["id", "saved_by"]).where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!card || card.saved_by !== who(c)) throw new KumiError("error.not_found", { thing: { en: "family card", es: "la tarjeta familiar" } }, 404);
    return c.json({ status: await checkFamilyCard(db, card.id) });
  });

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
    const setup = ev.data?.object?.object === "setup_intent" ? ev.data.object.id : null;
    if (setup) {
      const m = await db.selectFrom("membership").select("id").where("provider_ref", "=", setup).executeTakeFirst();
      if (m) await checkCardSetup(db, m.id, "webhook:stripe");
      const f = await db.selectFrom("family_card").select("id").where("provider_ref", "=", setup).executeTakeFirst();
      if (f) await checkFamilyCard(db, f.id, "webhook:stripe");
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
