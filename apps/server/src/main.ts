import { serve } from "@hono/node-server";
import { alertUnanswered, sendBroadcasts, clubStripeAccount, combine, confirmScores, connect, endLapsedMemberships, expireHolds, expireOffers, messageHandlers, migrate, registerMessageTopics, releaseSeats, remindBookings, renewMemberships, tidyPresales, settleShares, moneyHandlers, PlaytomicClient, processOutbox, reconcilePayments, sendPushes, tidyFamilyCards, refreshStripeAccount, sendEmails, setPaymentProvider, StripeProvider, syncMirror } from "@kumi/core";
import { makeApp } from "./app.ts";
import { MemoryMailer, PracticeMailer, ResendMailer, type Mailer } from "./mailer.ts";

const db = connect();
const applied = await migrate(db);
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
const newTopics = await registerMessageTopics(db);   // before any event is handled: see message_topic
if (newTopics.length) console.log(`messages: now telling people about ${newTopics.join(", ")}`);
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
// Email: with a Resend key, from the club's own domain (KUMI_MAIL_FROM, like "Kestrel Padel <hello@kestrelpadel.com>").
// Outside production, or with KUMI_PRACTICE=1, it only reaches KUMI_MAIL_TEST_TO (comma-separated); without a key it stays in the log.
let mailer: Mailer = new MemoryMailer(true);
if (process.env.KUMI_RESEND_API_KEY) {
  const from = process.env.KUMI_MAIL_FROM;
  if (!from) { console.error("KUMI_RESEND_API_KEY needs KUMI_MAIL_FROM, the address on the club's own domain"); process.exit(1); }
  const resend = new ResendMailer({ apiKey: process.env.KUMI_RESEND_API_KEY, from, replyTo: process.env.KUMI_MAIL_REPLY_TO });
  const testTo = (process.env.KUMI_MAIL_TEST_TO ?? "").split(",");
  // A trial server runs in production mode (HTTPS cookies) but still in practice until the club switches over.
  const practice = !production || process.env.KUMI_PRACTICE === "1";
  mailer = practice ? new PracticeMailer(resend, testTo) : resend;
  console.log(`email: resend from ${from}${practice ? `, practice: only to ${testTo.filter(Boolean).length} test addresses` : ""}`);
}
serve({ fetch: makeApp({ db, mailer, publicUrl, secureCookies: production, production, stripe: stripeConfig }).fetch, port });
console.log(`kumi server on http://127.0.0.1:${port}`);

// The jobs, every 30 seconds: refunds and messages leave through the outbox, and due emails go out;
// waitlist offers that ran out pass on; card payments nobody told us about are checked with the provider.
const handlers = combine(moneyHandlers, messageHandlers);
const pushContact = process.env.KUMI_PUSH_CONTACT ?? (publicUrl.startsWith("https://") ? publicUrl : "mailto:owner@localhost");
const jobs = async () => {
  try {
    const sent = await processOutbox(db, handlers);
    if (sent.delivered || sent.failed) console.log(`outbox: ${sent.delivered} delivered, ${sent.failed} to retry`);
    // Scheduled broadcasts whose time has come: their messages are written for whoever matches now.
    const bc = await sendBroadcasts(db);
    if (bc.sent) console.log(`broadcasts: ${bc.sent} sent`);
    // A club news email's unsubscribe link: a page on this server, no sign-in (unsubscribe.ts).
    const mail = await sendEmails(db, mailer, new Date(), 50, { unsubscribeUrl: (token) => `${publicUrl}/unsubscribe/${token}` });
    // Push services want a contact for whoever sends: the club's address on the web, or the owner's email.
    const push = await sendPushes(db, { subject: pushContact });
    if (push.sent || push.failed) console.log(`push: ${push.sent} sent, ${push.dropped} dropped, ${push.failed} to retry`);
    if (mail.sent || mail.dropped || mail.failed) console.log(`email: ${mail.sent} sent, ${mail.dropped} dropped, ${mail.failed} to retry`);
    const r = await expireOffers(db);
    if (r.expired) console.log(`waitlist offers: ${r.expired} ran out, ${r.offered} passed on`);
    const h = await expireHolds(db);
    if (h.lapsed) console.log(`court holds: ${h.lapsed} not paid in time, released`);
    const seats = await releaseSeats(db);
    if (seats.released) console.log(`open matches: ${seats.released} seats not paid in time, open again`);
    const sh = await settleShares(db);
    if (sh.settled) console.log(`shared bookings: ${sh.settled} settled at their deadline, ${sh.charged} charged to the organiser, ${sh.failed} left owing`);
    const sc = await confirmScores(db);
    if (sc.confirmed) console.log(`scores: ${sc.confirmed} counted after nobody answered in time`);
    const qa = await alertUnanswered(db);
    if (qa.alerted) console.log(`questions: front desk told about ${qa.alerted} waiting past the club's setting`);
    const rem = await remindBookings(db);
    if (rem.reminded) console.log(`court reminders: ${rem.reminded} bookings`);
    const ended = await endLapsedMemberships(db);
    if (ended) console.log(`memberships: ${ended} reached their end date`);
    const ps = await tidyPresales(db);
    if (ps.saved || ps.released) console.log(`membership presales: ${ps.saved} cards saved, ${ps.released} places let go (no card in time)`);
    const mr = await renewMemberships(db);
    if (mr.renewed || mr.failed || mr.ended) console.log(`membership renewals: ${mr.renewed} renewed, ${mr.failed} card declined (tried again later), ${mr.ended} ended`);
    const p = await reconcilePayments(db);
    if (p.settled) console.log(`payments: ${p.settled} settled by checking with the provider`);
    const fc = await tidyFamilyCards(db);
    if (fc.saved) console.log(`family cards: ${fc.saved} saved (found by checking with the provider)`);
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
