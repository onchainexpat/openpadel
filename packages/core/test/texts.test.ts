import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkPayment, gsm7, keyword, messageHandlers, openPayment, plan, processOutbox, run, runAsSystem, segments, sendTexts, setPaymentProvider, setTexting, startNumber, stopNumber,
  textable, textStatus, textWords, TEXT_KINDS, TEXTS_FORM, TextError, TestProvider, TestTexter, usPhone, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";
import { t, type Key } from "@kumi/i18n";

let db: Db, drop: () => Promise<void>, owner: Actor, court: string, loc: string;
const stripe = new TestProvider(), texter = new TestTexter();
const TZ = "America/Los_Angeles", NOW = new Date("2026-11-30T16:00:00Z");   // Mon 30 Nov, 8 am
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`).toISOString();
const people: Record<string, string> = {};
const as = (name: string): Actor => ({ personId: people[name]!, via: "test", lang: "en" });
const PHONE = { Ann: "+15035550101", Bo: "+15035550102" } as Record<string, string> & { Ann: string; Bo: string };
const MEMBERS = "https://kestrel.example";
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const sms = (who: string) => db.selectFrom("outbound_message").selectAll().where("person_id", "=", people[who]!).where("channel", "=", "sms").orderBy("created_at", "desc").execute();
const consent = (who: string, channel: string, purpose: string) => db.selectFrom("channel_consent").select(["granted", "source", "form_version", "evidence"]).where("person_id", "=", people[who]!)
  .where("channel", "=", channel).where("purpose", "=", purpose).orderBy("at", "desc").orderBy("id", "desc").executeTakeFirst();
async function sayYes(who: string) {
  await runAsSystem(db, "phone.confirm", { person_id: people[who], phone: PHONE[who] }, "web", { now: NOW });
  await run(db, "consent.texts", { person_id: people[who], granted: true, form_version: TEXTS_FORM, app: "member", device: "Mozilla/5.0 (iPhone)" }, as(who), { now: NOW });
}
async function book(who: string, starts: string) {
  const r = (await run(db, "booking.request", { court_id: court, starts_at: starts, minutes: 90, pay: "whole", person_id: people[who] }, as(who), { now: NOW })).result as { booking_id: string; payment_id: string };
  await openPayment(db, r.payment_id, people[who]!);
  stripe.settle((await db.selectFrom("payment").select("provider_ref").where("id", "=", r.payment_id).executeTakeFirstOrThrow()).provider_ref!, "succeeded");
  await checkPayment(db, r.payment_id, "test");
  return r.booking_id;
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(stripe);
  setTexting(true);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner, { now: NOW });
  await run(db, "price.rule_set", { location_id: loc, name: "Standard", cents_per_hour: 4000 }, owner, { now: NOW });
  await run(db, "club.update", { court_bookings: true }, owner, { now: NOW });
  for (const name of ["Ann", "Bo", "Cy"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner, { now: NOW })).result as { person_id: string }).person_id;
});
after(async () => drop());

test("numbers: US and Canadian mobiles only, however they're typed; not the Caribbean, not toll-free or premium", () => {
  for (const ok of ["(503) 555-0123", "503.555.0123", "+1 503 555 0123", "15035550123", "+1 (416) 555-0199", "+1 787 555 0100"]) assert.ok(usPhone(ok), ok);
  assert.equal(usPhone("503-555-0123"), "+15035550123");
  for (const bad of ["+44 20 7946 0958", "+1 876 555 0100", "+1 809 555 0100", "+1 800 555 0100", "+1 888 555 0100", "+1 900 555 0100", "+1 211 555 0100", "+1 521 555 0100",
    "+1 503 155 0123", "+1 503 911 0123", "555-0123", "phone", "+1 503 555 0123 ext 4"]) assert.equal(usPhone(bad), null, bad);
});

test("texts keep to the plain text alphabet, so a long one is counted right", () => {
  assert.equal(gsm7("Tu código: «está» lista… “sí” — ¿mañana? Él irá"), "Tu codigo: esta lista... \"si\" - ¿mañana? Él ira");
  assert.equal(gsm7("Game on 🎾 tonight"), "Game on tonight");
  assert.deepEqual([segments("x".repeat(160)), segments("x".repeat(161)), segments("€".repeat(80)), segments("ó")], [1, 2, 1, 1]);
});

test("every kind of message that can be a text has its own short words, in both languages", async () => {
  for (const kind of TEXT_KINDS) for (const lang of ["en", "es"] as const) {
    const words = t(lang, `msg.${kind}.sms` as Key, { name: "Winter Clinic", when: "Wed, Dec 2, 6:00 PM", until: "Tue, Dec 1, 6:00 PM", court: "Court 1", code: "K7Q-2M", coach: "Kai Moreno",
      to: "Thu, Dec 3, 7:00 PM", share: "$15.00", amount: "$60.00", dates: "Dec 2, Dec 9" });
    assert.ok(!words.startsWith("msg."), `${lang} ${kind}`);
    assert.ok(!words.includes("—") && !words.includes("{"), `${lang} ${kind}: ${words}`);
    assert.ok(segments(textWords("Kestrel Padel", words, lang, "/places", "https://kestrel.example")) <= 2, `${lang} ${kind}`);
  }
});

test("what a text to the club's number asks for: only the whole message, courtesy aside", () => {
  for (const s of ["STOP", "stop please", "Stop 🙏", "STOP ALL", "Unsubscribe", "cancel", "END", "quit", "Stop messaging me", "Para"]) assert.equal(keyword(s), "stop", s);
  assert.equal(keyword("I need to cancel my booking"), null);
  assert.equal(keyword("can you stop sending these"), "near_stop");
  assert.deepEqual([keyword("START"), keyword("unstop"), keyword("Help"), keyword("ayuda"), keyword("see you at 6")], ["start", "start", "help", "help", null]);
});

test("saying yes: only to a confirmed number, to the wording as it is now, never for anyone else; the proof is kept", async () => {
  await rejects(plan(db, "consent.texts", { person_id: people.Ann, granted: true, form_version: TEXTS_FORM }, as("Ann"), { now: NOW }), "error.phone_not_confirmed");
  await runAsSystem(db, "phone.confirm", { person_id: people.Ann, phone: PHONE.Ann }, "web", { now: NOW });
  await rejects(runAsSystem(db, "phone.confirm", { person_id: people.Bo, phone: PHONE.Ann }, "web", { now: NOW }), "error.phone_taken");
  await rejects(plan(db, "consent.texts", { person_id: people.Ann, granted: true, form_version: "texts-old" }, as("Ann"), { now: NOW }), "error.texts_form_old");
  await rejects(plan(db, "consent.texts", { person_id: people.Ann, granted: true, form_version: TEXTS_FORM }, as("Bo"), { now: NOW }), "error.forbidden_reason");
  const p = await plan(db, "consent.texts", { person_id: people.Ann, granted: true, form_version: TEXTS_FORM, app: "member", device: "Mozilla/5.0 (iPhone)" }, as("Ann"), { now: NOW });
  assert.match(p.plan.summary.en, /^Get texts from Kestrel Padel at \(503\) 555-0101 when something needs you soon/);
  await sayYes("Ann");
  const c = (await consent("Ann", "sms", "account"))!;
  assert.deepEqual([c.granted, c.source, c.form_version], [true, "profile", TEXTS_FORM]);
  assert.deepEqual({ ...(c.evidence as any), words: undefined }, { phone: PHONE.Ann, app: "member", device: "Mozilla/5.0 (iPhone)", via: "test", lang: "en", words: undefined });
  assert.match((c.evidence as any).words, /^Yes, Kestrel Padel may text me about my bookings and places\. Message and data rates may apply\. Reply STOP to stop, HELP for help\.$/);
  assert.deepEqual(await textable(db, people.Ann!), { phone: PHONE.Ann });
  assert.deepEqual(await textable(db, people.Bo!), { why: "no number" });
  // With the club's own terms and privacy policy linked, the proof names the links shown beside the yes.
  await run(db, "consent.texts", { person_id: people.Ann, granted: false }, as("Ann"), { now: NOW });
  await run(db, "club.update", { terms_url: "https://kestrel.example/terms", privacy_policy_url: "https://kestrel.example/privacy" }, owner);
  await sayYes("Ann");
  const yeses = await db.selectFrom("channel_consent").select("evidence").where("person_id", "=", people.Ann!).where("channel", "=", "sms").where("granted", "=", true).execute();
  assert.deepEqual(yeses.map((r) => JSON.stringify([(r.evidence as any).terms_url ?? null, (r.evidence as any).privacy_policy_url ?? null])).sort(),
    ['["https://kestrel.example/terms","https://kestrel.example/privacy"]', "[null,null]"]);
  await run(db, "club.update", { terms_url: null, privacy_policy_url: null }, owner);
});

test("the club cancels a booking: a text, in plain letters, with how to stop; a member who cancels their own gets none", async () => {
  const theirs = await book("Ann", at("2026-12-02", "18:00"));
  await run(db, "booking.cancel", { booking_id: theirs }, as("Ann"), { now: NOW });
  await processOutbox(db, messageHandlers);
  assert.equal((await sms("Ann")).length, 0);
  const club = await book("Ann", at("2026-12-03", "18:00"));
  await run(db, "booking.cancel", { booking_id: club, refund: "full", reason: "rain" }, owner, { now: NOW });
  await processOutbox(db, messageHandlers);
  const [row] = await sms("Ann");
  assert.equal(row!.status, "waiting");
  // A text waits out quiet hours like the email copy (this one is essential, so neither waits).
  const mail = await db.selectFrom("outbound_message").select("send_after").where("event_id", "=", row!.event_id).where("person_id", "=", people.Ann!).where("channel", "=", "email").executeTakeFirstOrThrow();
  assert.equal(row!.send_after.getTime(), mail.send_after.getTime());
  assert.deepEqual(await sendTexts(db, texter, { memberUrl: MEMBERS, statusCallback: "https://staff.kestrel.example/webhooks/twilio/status" }), { sent: 1, dropped: 0, failed: 0 });
  const sent = texter.last(PHONE.Ann)!;
  assert.match(sent.body, /^Kestrel Padel: Booking [A-Z0-9-]+ for Court 1, Thu, Dec 3, 6:00 PM, is cancelled\. https:\/\/kestrel\.example\/places Reply STOP to stop\.$/);
  assert.equal(segments(sent.body), 1);
  assert.equal(sent.statusCallback, "https://staff.kestrel.example/webhooks/twilio/status");
  const after = (await sms("Ann"))[0]!;
  assert.deepEqual([after.status, after.body, after.provider_ref?.startsWith("SM")], ["sent", sent.body, true]);
  // Twilio says it reached the phone.
  assert.equal(await textStatus(db, { ref: after.provider_ref!, status: "delivered", now: NOW }), true);
  assert.ok((await sms("Ann"))[0]!.delivered_at);
  assert.equal(await textStatus(db, { ref: "SMnotours", status: "delivered" }), false);
});

test("a problem that may pass is tried again later; one that won't is given up on; a number that replied STOP is off everywhere", async () => {
  const ids = [];
  for (const kind of ["one", "two", "three"]) {
    const id = uuidv7();
    await db.insertInto("outbound_message").values({ id, event_id: null, person_id: people.Ann!, kind: "booking_cancelled", channel: "sms", purpose: "account", essential: true, lang: "en",
      subject: kind, body: `Test ${kind}.`, link: null, status: "waiting", send_after: NOW, stale_at: null }).execute();
    ids.push(id);
  }
  texter.failNext = new TextError("20429", "Too many requests", false);
  let r = await sendTexts(db, texter, { memberUrl: MEMBERS, now: NOW, limit: 1 });
  const row = await db.selectFrom("outbound_message").select(["status", "attempts", "send_after", "failure"]).where("id", "=", ids[0]!).executeTakeFirstOrThrow();
  assert.deepEqual([r.failed, row.status, row.attempts, row.send_after.getTime() > NOW.getTime()], [1, "waiting", 1, true]);
  texter.failNext = new TextError("21614", "'To' number is not a valid mobile number", true);
  r = await sendTexts(db, texter, { memberUrl: MEMBERS, now: NOW, limit: 1 });
  assert.equal((await db.selectFrom("outbound_message").select("status").where("id", "=", ids[1]!).executeTakeFirstOrThrow()).status, "failed");
  // The number replied STOP to the club's number some time Kumi didn't hear: it's off everywhere now.
  texter.failNext = new TextError("21610", "Attempt to send to unsubscribed recipient", true);
  await sendTexts(db, texter, { memberUrl: MEMBERS, now: NOW, limit: 1 });
  assert.equal((await consent("Ann", "email", "club_news"))!.granted, false);
  assert.deepEqual(await textable(db, people.Ann!), { why: "no consent" });
});

test("STOP turns every channel off at once; START turns texts back on (not the rest), and only for someone who said yes before", async () => {
  await sayYes("Bo");
  assert.equal((await stopNumber(db, PHONE.Bo!, "Stop please", NOW)).people, 1);
  for (const [channel, purpose] of [["sms", "account"], ["email", "club_news"], ["push", "invites"], ["email", "account"]] as const) {
    const c = (await consent("Bo", channel, purpose))!;
    assert.deepEqual([c.granted, c.source], [false, "text_stop"], `${channel} ${purpose}`);
  }
  // A text written before the STOP doesn't go.
  await db.insertInto("outbound_message").values({ id: uuidv7(), event_id: null, person_id: people.Bo!, kind: "booking_cancelled", channel: "sms", purpose: "account", essential: true, lang: "en",
    subject: "x", body: "Late.", link: null, status: "waiting", send_after: NOW, stale_at: null }).execute();
  assert.deepEqual(await sendTexts(db, texter, { memberUrl: MEMBERS, now: NOW }), { sent: 0, dropped: 1, failed: 0 });
  assert.equal((await startNumber(db, PHONE.Bo!, NOW)).people, 1);
  assert.deepEqual([(await consent("Bo", "sms", "account"))!.granted, (await consent("Bo", "email", "club_news"))!.granted], [true, false]);
  assert.equal((await startNumber(db, "+15035550199", NOW)).people, 0);   // nobody's number
});

test("a new number ends a yes given for the old one", async () => {
  await runAsSystem(db, "phone.confirm", { person_id: people.Bo, phone: "+15035550109" }, "web", { now: NOW });
  const c = (await consent("Bo", "sms", "account"))!;
  assert.deepEqual([c.granted, c.source], [false, "number_changed"]);
  assert.equal((await db.selectFrom("person").select("phone").where("id", "=", people.Bo!).executeTakeFirstOrThrow()).phone, "+15035550109");
});

test("texts off on this server: nobody can say yes, and nothing is written to text", async () => {
  setTexting(false);
  try {
    await runAsSystem(db, "phone.confirm", { person_id: people.Cy, phone: "+15035550103" }, "web", { now: NOW });
    await rejects(plan(db, "consent.texts", { person_id: people.Cy, granted: true, form_version: TEXTS_FORM }, as("Cy"), { now: NOW }), "error.texts_off");
  } finally { setTexting(true); }
});
