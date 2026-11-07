// Card payments: the members' app opens a card form for a payment it owes, and the news that it went
// through can arrive three ways (the app checking, Stripe's webhook, the minute job). Each one asks the
// provider rather than trusting the message, so the order and repeats don't matter.
import { Hono, type Context } from "hono";
import { sql } from "kysely";
import { RateLimiter } from "./limits.ts";
import { includedTaxOf, noteFound, checkCardSetup, checkFamilyCard, checkPayment, connectStripe, kidOf, KumiError, supportRoleKeys, manages, openCardSetup, openFamilyCardSetup, openPayment, payWithFamilyCard, paymentProvider, refreshStripeAccount, verifyStripeSignature, StripeProvider, type Actor, type Db } from "@kumi/core";

type Me = { id: string } | null;
export interface StripeConfig { publishableKey?: string; webhookSecret?: string }

/** `guard` runs before a card form opens (bot protection, app.ts). */
export function paymentRoutes(db: Db, me: (c: Context<any>) => Me, actor: (c: Context<any>) => Actor, publicUrl: string, stripe: StripeConfig = {}, guard: (c: Context<any>) => Promise<void> = async () => {}) {
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
    await guard(c);
    const r = await openPayment(db, id, pid);
    if (r.paid) return c.json({ paid: true });
    // Prices that include tax: the sheet says how much of it is tax, as the booking and the receipt do.
    const tax = await includedTaxOf(db, id), l = (c as Context<any>).get("lang") === "es" ? "es" : "en";
    return c.json({ ...(tax ? { tax_cents: tax.cents, tax_label: tax.label[l], tax_rate: tax.rate?.[l] ?? null } : {}), provider: r.provider, client_secret: r.clientSecret, publishable_key: r.provider === "stripe" ? stripe.publishableKey ?? null : null, stripe_account: r.account });
  });
  // Each check can be a question to Stripe, so a person gets a few a minute (the app asks 8 times after a card form).
  const checks = new RateLimiter(30, 5 * 60_000);
  app.post("/my/payments/:id/check", async (c) => {
    const id = await mine(c);
    if (!checks.take(who(c))) throw new KumiError("error.too_many_requests", {}, 429);
    return c.json({ status: await checkPayment(db, id, "payments", undefined, { recentOnly: true }) });
  });
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
      // One intent can pay several (courts or dates paid together): one still waiting, if any is.
      const pay = await db.selectFrom("payment").select("id").where("provider", "=", "stripe").where("provider_ref", "=", intent).orderBy(sql`status = 'pending'`, "desc").orderBy("id").executeTakeFirst();
      if (pay) await checkPayment(db, pay.id, "webhook:stripe");
      // Paid, and nothing here records it (made after the copy a restore brought back, say): kept for the staff, who
      // hear once (payments_after_restore.ts). Never refunded by itself.
      else if (ev.type === "payment_intent.succeeded") {
        const o = ev.data!.object as { id: string; amount_received?: number; amount?: number; currency?: string; created?: number; receipt_email?: string | null; description?: string | null; metadata?: { kumi_charge_id?: string } };
        // A charge Kumi made by itself (kumi_charge_id) may simply not have its row yet: it waits for the jobs.
        await noteFound(db, { ref: o.id, amountCents: Number(o.amount_received ?? o.amount ?? 0), created: new Date(Number(o.created ?? Date.now() / 1000) * 1000), email: o.receipt_email ?? null, description: o.description ?? null, kumiChargeId: o.metadata?.kumi_charge_id ?? null, currency: o.currency?.toUpperCase() ?? null }, ev.account ?? null)
          .catch((e) => console.error(`webhook: a paid intent with no record here couldn't be kept (${(e as Error).message})`));
        console.warn(`webhook: Stripe says ${o.id} was paid, and no payment here records it: kept for the staff`);
      }
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
    if (!s && !(await supportRoleKeys(db, id)).length) throw new KumiError("error.staff_only", {}, 403);
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
