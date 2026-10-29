// Card payments: the members' app opens a card form for a payment it owes, and the news that it went
// through can arrive three ways (the app checking, Stripe's webhook, the minute job). Each one asks the
// provider rather than trusting the message, so the order and repeats don't matter.
import { Hono, type Context } from "hono";
import { checkPayment, KumiError, openPayment, paymentProvider, verifyStripeSignature, type Db } from "@kumi/core";

type Me = { id: string } | null;
export interface StripeConfig { publishableKey?: string; webhookSecret?: string }

export function paymentRoutes(db: Db, me: (c: Context<any>) => Me, stripe: StripeConfig = {}) {
  const app = new Hono();
  const who = (c: Context<any>) => { const m = me(c); if (!m) throw new KumiError("error.signed_out", {}, 401); return m.id; };
  const mine = async (c: Context<any>) => {
    const pay = await db.selectFrom("payment").select(["id", "person_id"]).where("id", "=", c.req.param("id")!).executeTakeFirst();
    if (!pay || pay.person_id !== who(c)) throw new KumiError("error.not_found", { thing: { en: "payment", es: "el pago" } }, 404);
    return pay.id;
  };

  // Which card form to show. The publishable key is public by design.
  app.get("/payments/config", (c) => c.json({ provider: paymentProvider().name, publishable_key: paymentProvider().name === "stripe" ? stripe.publishableKey ?? null : null }));

  app.post("/my/payments/:id/intent", async (c) => {
    const r = await openPayment(db, await mine(c), who(c));
    return c.json({ provider: r.provider, client_secret: r.clientSecret, publishable_key: r.provider === "stripe" ? stripe.publishableKey ?? null : null });
  });
  app.post("/my/payments/:id/check", async (c) => c.json({ status: await checkPayment(db, await mine(c)) }));

  // Stripe's webhook: only a signed, recent message is read, and it only prompts a check with Stripe.
  app.post("/webhooks/stripe", async (c) => {
    if (!stripe.webhookSecret) return c.json({ error: "not_configured" }, 404);
    const raw = await c.req.text();
    if (!verifyStripeSignature(raw, c.req.header("stripe-signature"), stripe.webhookSecret)) return c.json({ error: "bad_signature" }, 400);
    const ev = JSON.parse(raw) as { type?: string; data?: { object?: { id?: string; object?: string } } };
    const intent = ev.data?.object?.object === "payment_intent" ? ev.data.object.id : null;
    if (intent) {
      const pay = await db.selectFrom("payment").select("id").where("provider", "=", "stripe").where("provider_ref", "=", intent).executeTakeFirst();
      if (pay) await checkPayment(db, pay.id, "webhook:stripe");
    }
    return c.json({ received: true });
  });
  return app;
}
