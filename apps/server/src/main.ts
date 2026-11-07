import { playersWanted, readPlaytomicPlayers, loadClubFormat, checkMoneyAfterRestore, dropForeignFound, plainStoredText, reviewFound, checkKeptFound, tidyChats, eraseAfterRestore, resealAll, remindLeaving, setSecretKeys, tidyVaultUploads, expireSupport, alertUnanswered, decidePrograms, sendBroadcasts, clubStripeAccount, confirmScores, connect, endLapsedMemberships, remindMembershipEnds, expireHolds, expireOffers, migrate, registerMessageTopics, releaseSeats, remindBookings, renewMemberships, tidyPresales, settleShares, PlaytomicClient, processOutbox, reconcilePayments, sendPushes, tidyFamilyCards, refreshStripeAccount, sendEmails, setPaymentProvider, StripeProvider, comparePlaytomic, syncMirror, syncMirrorFar, sendTexts, dropWaitingTexts, setTexting, setAnswerer, setStaffAddress, issueReceipts, paymentProvider, closeUnfinishedPayments, lapseUnpaidPlaces, extendBlockSeries, bookSeriesWeeks, registeredSender, textingOn, TextError, jobFailed, jobWorked, countAi, parsePrices, setPrices, type Texter } from "@kumi/core";
import { makeApp } from "./app.ts";
import { memberUrl, walletDomainOf } from "./addresses.ts";
import { MemoryMailer, MeteredMailer, PracticeMailer, ResendMailer, type Mailer } from "./mailer.ts";
import { hasSender, PracticeTexter, TwilioTexter, twilioFromEnv, type TwilioConfig } from "./twilio.ts";
import { checkTextingNumber, refreshTexting } from "./texting.ts";
import { watchHealth } from "./health.ts";
import { newJobsState, runJobs, type JobStep } from "./jobs.ts";
import { TwilioApi } from "./twilio_admin.ts";
import { handlers } from "./outbox.ts";
import { tidySignIns } from "./oauth.ts";
import { answererFromEnv, answerModels } from "./answerer.ts";
import { setTranslator, translatorFromEnv } from "./translate.ts";
import { describeListen, listen, listenFrom, type Listen } from "./listen.ts";

// The server's key for the secrets it keeps (authenticators, the push key, the vault: sealed.ts). Production
// refuses to start without one; elsewhere secrets are kept as they are, and it says so.
const production = process.env.NODE_ENV === "production";
if (!process.env.KUMI_SECRET_KEY?.trim()) {
  if (production) { console.error("KUMI_SECRET_KEY isn't set: make one (head -c 32 /dev/urandom | base64) and put it in the server's settings"); process.exit(1); }
  console.warn("no KUMI_SECRET_KEY: secrets are kept unsealed (fine for development, never for a club)");
}
try { setSecretKeys({ current: process.env.KUMI_SECRET_KEY, previous: process.env.KUMI_SECRET_KEY_PREVIOUS }); }
catch (e) { console.error(`KUMI_SECRET_KEY: ${(e as Error).message}`); process.exit(1); }
// What AI, texts and email cost, for the club's monthly meter (usage.ts): list prices unless KUMI_PRICES says
// otherwise (a host's own prices, or a club's deal with its providers).
try { setPrices(parsePrices(process.env.KUMI_PRICES)); }
catch (e) { console.error((e as Error).message); process.exit(1); }

// Live with no email key, sign-in codes would only be written to the log, readable by anyone who can read it:
// refuse to start instead. In practice (and development) the log is how the owner signs in before email is set up.
if (!process.env.KUMI_RESEND_API_KEY && production && process.env.KUMI_PRACTICE !== "1") {
  console.error("email isn't set up (KUMI_RESEND_API_KEY and KUMI_MAIL_FROM): live, members' sign-in codes would only go to the log. Set up email (docs/setup/accounts/resend.md), or keep KUMI_PRACTICE=1 until it is.");
  process.exit(1);
}
const db = connect();
const applied = await migrate(db);
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
const newTopics = await registerMessageTopics(db);   // before any event is handled: see message_topic
if (newTopics.length) console.log(`messages: now telling people about ${newTopics.join(", ")}`);
// Seal what isn't sealed yet (a server from before the key) and move what's under the previous key to this one.
// The club's currency and formats for every amount and date this server writes (format.ts).
await loadClubFormat(db);
// Names and gift card words saved before typed text was made plain as it's saved (0.3.0): made plain now.
try { const pt = await plainStoredText(db); if (pt.names || pt.giftCards) console.log(`names: ${pt.names} people's and ${pt.giftCards} gift cards' words made plain (control or invisible characters taken out)`); }
catch (e) { console.error("names: couldn't make saved names plain:", (e as Error).message); }
const sealed = await resealAll(db);
if (sealed.sealed || sealed.resealed) console.log(`secrets: ${sealed.sealed} sealed, ${sealed.resealed} moved to the current key`);
if (sealed.unreadable) console.error(`secrets: ${sealed.unreadable} sealed under a key this server doesn't have (set KUMI_SECRET_KEY_PREVIOUS to the old key)`);
// Accounts a restore brought back (an update's snapshot put back by release.sh queues them): deleted again (privacy.ts).
const erasedAgain = await eraseAfterRestore(db);
if (erasedAgain.erased) console.log(`privacy: ${erasedAgain.erased} account${erasedAgain.erased === 1 ? "" : "s"} deleted before a restore deleted again`);
// Where it listens (listen.ts): 127.0.0.1 and PORT unless the settings say otherwise.
let listenAt: Listen;
try { listenAt = listenFrom(process.env); } catch (e) { console.error((e as Error).message); process.exit(1); }
const port = "port" in listenAt ? listenAt.port : 8790;
const publicUrl = process.env.KUMI_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
// What members are sent: the members' app's address, not the staff app's (addresses.ts).
const membersUrl = memberUrl(publicUrl);
// Someone given a staff role is told by email where the staff app is (messages.ts).
setStaffAddress(publicUrl);

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
// Apple Pay and Google Pay show on the members' card form only on a domain registered with Stripe (on the club's own
// account under Connect). The jobs below register it until it's done: at start, or once a connected club's
// account exists. Nothing to do on a laptop or a name Stripe can't register.
const walletHost = walletDomainOf(membersUrl);
let walletDone: string | null = null, walletNext = 0;   // the account (or "direct") it's registered on; tried at most hourly
const registerWallets = async () => {
  if (!stripe || !walletHost || Date.now() < walletNext) return;
  const where = stripe.connect ? (await db.selectFrom("club").select("stripe_account_id").executeTakeFirst())?.stripe_account_id ?? null : "direct";
  if (!where || walletDone === where) return;
  walletNext = Date.now() + 3600_000;
  const d = await stripe.registerWalletDomain(walletHost);
  if (!d) return;
  walletDone = where;
  console.log(`payments: ${walletHost} registered for Apple Pay (${d.applePay}) and Google Pay (${d.googlePay})${d.problem ? `: ${d.problem}` : ""}`);
};
// Email: with a Resend key, from the club's own domain (KUMI_MAIL_FROM, like "Kestrel Padel <hello@kestrelpadel.com>").
// Outside production, or with KUMI_PRACTICE=1, it only reaches KUMI_MAIL_TEST_TO (comma-separated); without a key it stays in the log.
let mailer: Mailer = new MemoryMailer(true);
if (process.env.KUMI_RESEND_API_KEY) {
  const from = process.env.KUMI_MAIL_FROM;
  if (!from) { console.error("KUMI_RESEND_API_KEY needs KUMI_MAIL_FROM, the address on the club's own domain"); process.exit(1); }
  // Each email Resend takes counts on the club's monthly meter (usage.ts); held practice email doesn't.
  const resend = new MeteredMailer(new ResendMailer({ apiKey: process.env.KUMI_RESEND_API_KEY, from, replyTo: process.env.KUMI_MAIL_REPLY_TO }), db);
  const testTo = (process.env.KUMI_MAIL_TEST_TO ?? "").split(",");
  // A trial server runs in production mode (HTTPS cookies) but still in practice until the club switches over.
  const practice = !production || process.env.KUMI_PRACTICE === "1";
  mailer = practice ? new PracticeMailer(resend, testTo) : resend;
  console.log(`email: resend from ${from}${practice ? `, practice: only to ${testTo.filter(Boolean).length} test addresses` : ""}`);
}
// Texts: through the club's own Twilio account when it's set up (twilio.ts). In practice, like email, only the
// club's test numbers (KUMI_SMS_TEST_TO, comma-separated) get them; the rest are held and logged.
// Who texts are from: the settings file's sender, or else the Messaging Service `kumi texting` registered, from
// the moment Twilio approves it (texting.ts asks every hour while the review runs).
let twilio: ReturnType<typeof twilioFromEnv> = null;
try { twilio = twilioFromEnv(process.env); } catch (e) { console.error(`texts: ${(e as Error).message}`); process.exit(1); }
let sending: Texter | null = null;
const startTexts = (cfg: TwilioConfig) => {
  const practice = !production || process.env.KUMI_PRACTICE === "1", testTo = (process.env.KUMI_SMS_TEST_TO ?? "").split(",");
  sending = practice ? new PracticeTexter(new TwilioTexter(cfg), testTo) : new TwilioTexter(cfg);
  setTexting(true);
  console.log(`texts: twilio${cfg.messagingServiceSid && !process.env.KUMI_TWILIO_MESSAGING_SERVICE_SID ? ", from the registered Messaging Service" : ""}${practice ? `, practice: only to ${testTo.filter((n) => n.trim()).length} test numbers` : ""}`);
};
const twilioApi = twilio ? new TwilioApi(twilio.accountSid, twilio.authToken) : null;
if (twilio) {
  const registered = hasSender(twilio) ? null : await registeredSender(db);
  if (hasSender(twilio)) startTexts(twilio);
  else if (registered) startTexts({ ...twilio, messagingServiceSid: registered });
  else console.log("texts: the Twilio account is set, but no sender yet; texts are off until `kumi texting` is approved");
}
// The routes get one texter for good; it sends through whichever is set up, once one is.
let textingNext = 0;   // when to ask Twilio about the texting registration again
let watchNext = 0, numberNext = 0, tidyNext = 0;     // when to look at texts and ask the club's answers again (every 5 minutes)
const texter: Texter | null = twilio ? { send: (x) => { if (!sending) throw new TextError("no_sender", "texts aren't set up to send yet", false); return sending.send(x); } } : null;
// Ask the club: with a decision model's key (KUMI_TYPESAFE_API_KEY for Jev, KUMI_ANTHROPIC_API_KEY for Claude
// Haiku, or both), Kumi answers a new question from the club's facts, word for word, or hands it to the staff
// (answerer.ts). The club can still switch it off in Settings. Without a key every question goes to the staff.
// Each model's answer counts on the club's monthly meter (usage.ts).
const answerer = answererFromEnv(process.env, undefined, (u) => countAi(db, "ai_decisions", u.model, u.tokens));
if (answerer) { setAnswerer(answerer); console.log(`ask the club: answered by ${answerer.name}`); }
// Drafts of the club's own words in its other language, for staff to check (translate.ts): the same Anthropic key.
setTranslator(translatorFromEnv(process.env));
// Bot protection on sign-up, sign-in codes and checkout. KUMI_BOT_CHECK=0 leaves it off on a practice
// machine (scripts that sign in over the API); production refuses to start that way.
const botCheck = process.env.KUMI_BOT_CHECK !== "0";
if (!botCheck && production) { console.error("KUMI_BOT_CHECK=0 isn't allowed in production"); process.exit(1); }
// The session cookie's old name, still read (and moved) over HTTPS for one release (session_cookie.ts).
const legacySessionCookie = process.env.KUMI_LEGACY_SESSION_COOKIE !== "0";
const server = await listen(makeApp({ db, mailer, publicUrl, memberUrl: membersUrl, secureCookies: production, legacySessionCookie, production, stripe: stripeConfig, botCheck, databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/kumi",
  emailEvents: { secret: process.env.KUMI_RESEND_WEBHOOK_SECRET || null, from: process.env.KUMI_MAIL_FROM || null },
  ...(texter && twilio ? { texts: { texter, authToken: twilio.authToken } } : {}) }).fetch, listenAt);
console.log(`kumi server on ${describeListen(listenAt, server)}`);

// The jobs, every 30 seconds: refunds and messages leave through the outbox, and due emails go out;
// waitlist offers that ran out pass on; card payments nobody told us about are checked with the provider.
// Each runs on its own (jobs.ts): one that throws doesn't stop the rest, and one that keeps failing is said once.
const pushContact = process.env.KUMI_PUSH_CONTACT ?? (publicUrl.startsWith("https://") ? publicUrl : "mailto:owner@localhost");
const jobsState = newJobsState();
const jobSteps: JobStep[] = [
  // A change to the club's currency or formats reaches every message within a round.
  ["club_format", () => loadClubFormat(db)],
  ["outbox", async () => {
    const sent = await processOutbox(db, handlers);
    if (sent.delivered || sent.failed) console.log(`outbox: ${sent.delivered} delivered, ${sent.failed} to retry`);
  }],
  ["broadcasts", async () => {
    // Scheduled broadcasts whose time has come: their messages are written for whoever matches now.
    const bc = await sendBroadcasts(db);
    if (bc.sent) console.log(`broadcasts: ${bc.sent} sent`);
  }],
  ["email and push", async () => {
    // A club news email's unsubscribe link: a page on this server, no sign-in (broadcasts.ts), at the members' address.
    const mail = await sendEmails(db, mailer, new Date(), 50, { unsubscribeUrl: (token) => `${membersUrl}/unsubscribe/${token}` });
    // Push services want a contact for whoever sends: the club's address on the web, or the owner's email.
    const push = await sendPushes(db, { subject: pushContact });
    if (push.sent || push.failed) console.log(`push: ${push.sent} sent, ${push.dropped} dropped, ${push.failed} to retry`);
    if (mail.sent || mail.dropped || mail.failed) console.log(`email: ${mail.sent} sent, ${mail.dropped} dropped, ${mail.failed} to retry`);
  }],
  ["texts", async () => {
    // Texts, with Twilio's delivery reports coming back to this server; with texts switched off, none wait.
    if (texter && textingOn()) {
      const tx = await sendTexts(db, texter, { memberUrl: membersUrl, ...(publicUrl.startsWith("https://") ? { statusCallback: `${publicUrl.replace(/\/$/, "")}/webhooks/twilio/status` } : {}) });
      if (tx.sent || tx.dropped || tx.failed) console.log(`texts: ${tx.sent} sent, ${tx.dropped} dropped, ${tx.failed} failed or to retry`);
    } else if (await dropWaitingTexts(db)) console.log("texts: switched off, so the ones waiting were dropped");
  }],
  ["waitlist offers", async () => {
    const r = await expireOffers(db);
    if (r.expired) console.log(`waitlist offers: ${r.expired} ran out, ${r.offered} passed on`);
  }],
  ["unpaid places", async () => {
    const up = await lapseUnpaidPlaces(db);
    if (up.reminded || up.lapsed) console.log(`program places not paid: ${up.reminded} reminded, ${up.lapsed} freed for the waitlist`);
  }],
  ["court holds", async () => {
    const h = await expireHolds(db);
    if (h.lapsed) console.log(`court holds: ${h.lapsed} not paid in time, released`);
  }],
  ["open match seats", async () => {
    const seats = await releaseSeats(db);
    if (seats.released) console.log(`open matches: ${seats.released} seats not paid in time, open again`);
  }],
  ["weekly courts", async () => {
    // Weekly courts members book themselves: each week once it's inside their booking window (then charged with the rest below).
    const wk = await bookSeriesWeeks(db);
    if (wk.booked || wk.missed || wk.ended) console.log(`weekly courts: ${wk.booked} weeks booked, ${wk.missed} left out (the member told), ${wk.ended} never paid and closed`);
  }],
  ["shared bookings", async () => {
    const sh = await settleShares(db);
    if (sh.settled) console.log(`shared bookings: ${sh.settled} settled at their deadline, ${sh.charged} charged to the organiser, ${sh.failed} left owing`);
  }],
  ["scores", async () => {
    const sc = await confirmScores(db);
    if (sc.confirmed) console.log(`scores: ${sc.confirmed} counted after nobody answered in time`);
  }],
  ["program minimums", async () => {
    // Programs with a minimum: staff hear first if one is short, then at its decision time it runs or is cancelled.
    const mins = await decidePrograms(db);
    if (mins.cancelled || mins.ran || mins.warned) console.log(`program minimums: ${mins.warned} short (staff told), ${mins.ran} running, ${mins.cancelled} cancelled and paid back`);
  }],
  ["questions", async () => {
    const qa = await alertUnanswered(db);
    if (qa.alerted) console.log(`questions: front desk told about ${qa.alerted} waiting past the club's setting`);
  }],
  ["court reminders", async () => {
    const rem = await remindBookings(db);
    if (rem.reminded) console.log(`court reminders: ${rem.reminded} bookings`);
  }],
  ["leaving", async () => {
    // The day the club's Kumi ends (leaving.ts): the owner's reminders a week and a day before, in the daytime.
    const lv = await remindLeaving(db);
    if (lv) console.log(`leaving: the owner reminded (${lv === "week" ? "a week" : "a day"} before)`);
  }],
  ["membership ends", async () => {
    const ended = await endLapsedMemberships(db);
    if (ended) console.log(`memberships: ${ended} reached their end date`);
  }],
  ["desk memberships", async () => {
    // Paid at the desk, so nothing renews by itself: the member hears a week before it ends.
    const ending = await remindMembershipEnds(db);
    if (ending) console.log(`memberships: ${ending} paid at the desk reminded they end within a week`);
  }],
  ["membership presales", async () => {
    const ps = await tidyPresales(db);
    if (ps.saved || ps.released) console.log(`membership presales: ${ps.saved} cards saved, ${ps.released} places let go (no card in time)`);
  }],
  ["membership renewals", async () => {
    const mr = await renewMemberships(db);
    if (mr.renewed || mr.failed || mr.ended) console.log(`membership renewals: ${mr.renewed} renewed, ${mr.failed} card declined (tried again later), ${mr.ended} ended`);
  }],
  ["payments", async () => {
    const p = await reconcilePayments(db);
    if (p.settled) console.log(`payments: ${p.settled} settled by checking with the provider`);
  }],
  ["payments found after a restore", async () => {
    // Kumi's own charges noted after a restore close once the jobs record them; the staff's alert closes when nothing is left.
    const f = await reviewFound(db);
    if (f.recorded || f.opened) console.log(`payments after a restore: ${f.recorded} recorded by the jobs, ${f.opened} left for the staff`);
    // Kept ones, a few at a time: refunds made of them since (in the provider's dashboard, say) and disputes.
    const k = await checkKeptFound(db);
    if (k.unbooked || k.disputed) console.log(`payments after a restore: ${k.unbooked} refunds of kept payments taken out of the books, ${k.disputed} disputed (staff told)`);
  }],
  ["unfinished payments", async () => {
    const uf = await closeUnfinishedPayments(db);
    if (uf.closed || uf.paid) console.log(`payments: ${uf.closed} membership payments left unfinished for a day called off${uf.paid ? `, ${uf.paid} had gone through` : ""}`);
  }],
  ["receipts", async () => {
    // A receipt for each payment that went through and each refund sent (receipts.ts), with the card from the provider.
    const rc = await issueReceipts(db, { card: async (ref, account) => (await paymentProvider().cardOf?.(ref, account)) ?? null });
    if (rc.issued) console.log(`receipts: ${rc.issued} written`);
  }],
  ["court blocks", async () => {
    // Repeating court blocks are made a year ahead: as days pass, each gets its dates for the new days.
    const bs = await extendBlockSeries(db);
    if (bs.dates) console.log(`court blocks: ${bs.dates} more dates of repeating blocks made`);
  }],
  ["uploads", async () => {
    await tidyVaultUploads(db);
  }],
  ["hourly tidy", async () => {
    if (Date.now() >= tidyNext) {   // sign-in leftovers, hourly
      tidyNext = Date.now() + 3600_000;
      const ts = await tidySignIns(db);
      if (ts.challenges || ts.clients) console.log(`sign-in: ${ts.challenges} old codes and ${ts.clients} assistants never connected tidied`);
      // Players' chats go 90 days after their game (chat.ts).
      const ch = await tidyChats(db);
      if (ch.deleted) console.log(`chats: ${ch.deleted} chats 90 days after their game deleted`);
    }
  }],
  ["family cards", async () => {
    const fc = await tidyFamilyCards(db);
    if (fc.saved) console.log(`family cards: ${fc.saved} saved (found by checking with the provider)`);
  }],
  ["support access", async () => {
    // Support access whose time ran out (it already stopped working on time): the owner hears it ended.
    const sx = await expireSupport(db);
    if (sx) console.log(`support access: ${sx} ended, the owner told`);
  }],
  ["wallets", async () => {
    await registerWallets().catch((e) => console.error("payments: registering the members' domain for Apple Pay and Google Pay:", (e as Error).message));
  }],
  ["texting registration", async () => {
    // The texting registration under review: asked about hourly; texts start when it's approved (if nothing else is set).
    if (twilioApi && Date.now() >= textingNext) {
      textingNext = Date.now() + 3600_000;
      const status = await refreshTexting(db, twilioApi).catch((e) => { console.error("texts: asking Twilio about the registration:", (e as Error).message); return null; });
      if (status === "approved" && !sending && twilio) {
        const mg = await registeredSender(db);
        if (mg) startTexts({ ...twilio, messagingServiceSid: mg });
      }
    }
  }],
  ["health watch", async () => {
    // Texts getting through and ask the club's model answering: staff hear once when either starts failing.
    if (Date.now() >= watchNext) {
      watchNext = Date.now() + 300_000;
      await watchHealth(db, { texting: Boolean(texter) && textingOn(), models: answerModels(process.env) });
    }
  }],
  ["texting number", async () => {
    // Once approved, the club's texting number is checked hourly too (it can stop working after approval).
    if (twilioApi && Date.now() >= numberNext) {
      numberNext = Date.now() + 3600_000;
      const n = await checkTextingNumber(db, twilioApi).catch((e) => { console.error("texts: checking the club's number:", (e as Error).message); return null; });
      if (n?.ok) await jobWorked(db, "texting_number");
      else if (n) await jobFailed(db, "texting_number", n.error, new Date(), n.words);
    }
  }],
  ["stripe account", async () => {
    // While the club is still setting up its Stripe account, ask Stripe whether it's ready (a webhook says so too).
    if (stripe?.connect) {
      const club = await db.selectFrom("club").select(["stripe_account_id", "stripe_charges_enabled"]).executeTakeFirstOrThrow();
      if (club.stripe_account_id && !club.stripe_charges_enabled) await refreshStripeAccount(db, stripe);
    }
  }],
];
// Before any job can let a payment go: every pending card payment is asked about, whatever its age (a restore's copy
// can hold one paid since as pending), and after a restore what the provider has from after the copy is looked up
// (payments_after_restore.ts): refunds recorded, payments with no record kept for the staff.
try { const r = await reconcilePayments(db, new Date(), 500, { all: true }); if (r.settled) console.log(`payments: ${r.settled} pending at start settled with the provider`); }
catch (e) { console.error("payments: couldn't check the pending ones at start:", (e as Error).message); }
// Payments found on another club's Stripe account, kept before Kumi checked whose a webhook's event was: gone, or
// kept without the payer's details where the staff already acted on one.
try { const f = await dropForeignFound(db); if (f.removed || f.scrubbed) console.warn(`payments: ${f.removed} found on another club's Stripe account removed, ${f.scrubbed} kept without the payer's details`); }
catch (e) { console.error("payments: couldn't look for found payments on another club's account:", (e as Error).message); }
try { const m = await checkMoneyAfterRestore(db); if (m.checked) console.log(`payments after a restore: ${m.found} paid with nothing here (for the staff), ${m.refunds} refunds recorded`); }
catch (e) { console.error("payments: couldn't check the provider after a restore (tried again at the next start):", (e as Error).message); }
const jobs = async () => {
  try { await runJobs(db, jobSteps, jobsState); }
  catch (e) { console.error("jobs:", (e as Error).message); }
  finally { setTimeout(jobs, 30_000); }
};
void jobs();

// The read-only Playtomic mirror, when the club has given Kumi its Third Party API keys (through the
// environment, never the database or the code). One sync at a time, then a rest; pages are a minute apart.
// Each sync reads the near window, then at most one 30-day slice of what's further ahead (as far as Kumi has
// anything on a court, or members can book), each slice again after KUMI_MIRROR_FAR_EVERY_HOURS.
const pt = { clientId: process.env.KUMI_PLAYTOMIC_CLIENT_ID, secret: process.env.KUMI_PLAYTOMIC_SECRET, tenantId: process.env.KUMI_PLAYTOMIC_TENANT_ID };
if (pt.clientId && pt.secret && pt.tenantId) {
  const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d; };
  const client = new PlaytomicClient({ clientId: pt.clientId, secret: pt.secret, tenantId: pt.tenantId, pageDelayMs: num(process.env.KUMI_MIRROR_PAGE_SECONDS, 60) * 1000 });
  const every = num(process.env.KUMI_MIRROR_EVERY_MINUTES, 10) * 60_000, daysAhead = num(process.env.KUMI_MIRROR_DAYS_AHEAD, 30);
  const farEvery = num(process.env.KUMI_MIRROR_FAR_EVERY_HOURS, 6) * 3600_000, farRead = new Map<number, number>();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const loop = async () => {
    try {
      const r = await syncMirror(db, client, { daysAhead });
      console.log(r.ok ? `playtomic mirror: ${r.fetched} read, ${r.changes} changed, ${r.unmapped.length} courts to link` : `playtomic mirror failed: ${r.error}`);
      const f = r.ok && farEvery > 0 ? await syncMirrorFar(db, client, { daysAhead, everyMs: farEvery, lastRead: farRead }) : null;
      if (f) console.log(f.ok ? `playtomic mirror, ${day(f.from)} to ${day(f.to)}: ${f.fetched} read, ${f.changes} changed` : `playtomic mirror, ${day(f.from)} to ${day(f.to)}, failed (tried again next time): ${f.error}`);
      // Once a club day: Playtomic and Kumi compared, and any new difference told to the owners (playtomic_archive.ts).
      const cmp = r.ok ? await comparePlaytomic(db).catch((e: Error) => { console.error("playtomic comparison:", e.message); return null; }) : null;
      if (cmp?.ran) console.log(`playtomic comparison: ${cmp.differences} differences, ${cmp.told} new told to the owners`);
      // Staff asked for Playtomic's players (moving in, brought_in.ts): read them all, at the same pace.
      if (await playersWanted(db)) {
        const p = await readPlaytomicPlayers(db, client);
        console.log(p.ok ? `playtomic players: ${p.read} read, ${p.changed} changed` : `playtomic players failed: ${p.error}`);
      }
    } catch (e) { console.error("playtomic mirror:", (e as Error).message); }
    finally { setTimeout(loop, every); }
  };
  void loop();
  console.log("playtomic mirror on");
}
