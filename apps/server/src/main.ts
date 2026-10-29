import { serve } from "@hono/node-server";
import { clubStripeAccount, connect, expireOffers, migrate, moneyHandlers, PlaytomicClient, processOutbox, reconcilePayments, refreshStripeAccount, setPaymentProvider, StripeProvider, syncMirror } from "@kumi/core";
import { makeApp } from "./app.ts";
import { MemoryMailer } from "./mailer.ts";

const db = connect();
const applied = await migrate(db);
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
const port = Number(process.env.PORT ?? 8790);
const publicUrl = process.env.KUMI_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const production = process.env.NODE_ENV === "production";

// Card payments go through Stripe when a key is set (from the environment, never the database or the
// code); otherwise the stand-in. Self-hosted, the key is the club's own. Hosted (KUMI_STRIPE_CONNECT=1),
// it's Kumi's platform key and payments go into the club's own connected account. A live key is
// refused outside production.
const stripeKey = process.env.KUMI_STRIPE_SECRET_KEY, connectMode = process.env.KUMI_STRIPE_CONNECT === "1";
let stripe: StripeProvider | null = null;
if (stripeKey) {
  stripe = new StripeProvider({ secretKey: stripeKey, ...(connectMode ? { connect: clubStripeAccount(db) } : {}) });
  if (stripe.live && !production) { console.error("refusing a LIVE Stripe key outside production; use a test key (sk_test_)"); process.exit(1); }
  setPaymentProvider(stripe);
  console.log(`payments: stripe (${stripe.live ? "live" : "test mode"}${connectMode ? ", the club's connected account" : ""})`);
}
const stripeConfig = { publishableKey: process.env.KUMI_STRIPE_PUBLISHABLE_KEY, webhookSecret: process.env.KUMI_STRIPE_WEBHOOK_SECRET };
serve({ fetch: makeApp({ db, mailer: new MemoryMailer(true), publicUrl, secureCookies: production, production, stripe: stripeConfig }).fetch, port });
console.log(`kumi server on http://127.0.0.1:${port}`);

// The jobs, every 30 seconds: refunds and other events leave through the outbox; waitlist offers that
// ran out pass on; card payments nobody told us about are checked with the provider.
const jobs = async () => {
  try {
    const sent = await processOutbox(db, moneyHandlers);
    if (sent.delivered || sent.failed) console.log(`outbox: ${sent.delivered} delivered, ${sent.failed} to retry`);
    const r = await expireOffers(db);
    if (r.expired) console.log(`waitlist offers: ${r.expired} ran out, ${r.offered} passed on`);
    const p = await reconcilePayments(db);
    if (p.settled) console.log(`payments: ${p.settled} settled by checking with the provider`);
    // While the club is still setting up its Stripe account, ask Stripe whether it's ready (a webhook says so too).
    if (stripe?.connect) {
      const club = await db.selectFrom("club").select(["stripe_account_id", "stripe_charges_enabled"]).executeTakeFirstOrThrow();
      if (club.stripe_account_id && !club.stripe_charges_enabled) await refreshStripeAccount(db, stripe);
    }
  } catch (e) { console.error("jobs:", (e as Error).message); }
  finally { setTimeout(jobs, 30_000); }
};
void jobs();

// The read-only Playtomic mirror, when the club has given Kumi its Third Party API keys (through the
// environment, never the database or the code). One sync at a time, then a rest; pages are a minute apart.
const pt = { clientId: process.env.KUMI_PLAYTOMIC_CLIENT_ID, secret: process.env.KUMI_PLAYTOMIC_SECRET, tenantId: process.env.KUMI_PLAYTOMIC_TENANT_ID };
if (pt.clientId && pt.secret && pt.tenantId) {
  const client = new PlaytomicClient({ clientId: pt.clientId, secret: pt.secret, tenantId: pt.tenantId });
  const every = Number(process.env.KUMI_MIRROR_EVERY_MINUTES ?? 10) * 60_000, daysAhead = Number(process.env.KUMI_MIRROR_DAYS_AHEAD ?? 30);
  const loop = async () => {
    try {
      const r = await syncMirror(db, client, { daysAhead });
      console.log(r.ok ? `playtomic mirror: ${r.fetched} read, ${r.changes} changed, ${r.unmapped.length} courts to link` : `playtomic mirror failed: ${r.error}`);
    } catch (e) { console.error("playtomic mirror:", (e as Error).message); }
    finally { setTimeout(loop, every); }
  };
  void loop();
  console.log("playtomic mirror on");
}
