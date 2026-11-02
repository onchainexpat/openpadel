import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, setTexting, TestTexter, TextError, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { PracticeTexter, TwilioTexter, twilioFromEnv, twilioSignature, validSignature } from "../src/twilio.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, cookie: string;
const mailer = new MemoryMailer(), texter = new TestTexter();
const TOKEN = "0123456789abcdef0123456789abcdef", STAFF = "https://staff.kestrel.example", MEMBERS = "https://kestrel.example";
const call = async (path: string, body?: unknown) => {
  const r = await app.request(path, { method: body ? "POST" : "GET", headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
/** A post as Twilio makes it: a form, signed with the auth token over the full address. */
const fromTwilio = async (path: string, form: Record<string, string>, token = TOKEN) => {
  const r = await app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(token, `${STAFF}${path}`, form) },
    body: new URLSearchParams(form).toString() });
  return { status: r.status, text: await r.text() };
};
const lastCode = (to: string) => texter.last(to)!.body.match(/\b(\d{6})\b/)![1]!;

before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  setTexting(true);
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: STAFF, memberUrl: MEMBERS, texts: { texter, authToken: TOKEN } });
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test" }) });
  const code = mailer.last("robin@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  cookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
});
after(async () => drop());

test("a number confirmed by a texted code, then the member's own yes; the code text is plain and says how to stop", async () => {
  const before = (await call("/my/texts")).json;
  assert.deepEqual([before.on, before.phone, before.answer], [true, null, null]);
  assert.match(before.form.words, /^Yes, Kestrel Padel may text me/);
  assert.equal((await call("/my/phone/start", { phone: "+44 20 7946 0958" })).status, 400);
  assert.equal((await call("/my/phone/start", { phone: "876 555 0100" })).status, 400);   // Jamaica: +1, but not ours
  const r = await call("/my/phone/start", { phone: "(503) 555-0142" });
  assert.deepEqual([r.status, r.json.phone], [200, "(503) 555-0142"]);
  assert.match(texter.last("+15035550142")!.body, /^Kestrel Padel: Your code is \d{6}\. It works for 10 minutes\. Reply STOP to stop\.$/);
  assert.equal((await call("/my/texts")).json.waiting_code_for, "(503) 555-0142");
  assert.equal((await call("/my/phone/verify", { code: "000000" === lastCode("+15035550142") ? "111111" : "000000" })).status, 401);
  assert.equal((await call("/my/phone/verify", { code: lastCode("+15035550142") })).status, 200);
  assert.equal((await call("/my/texts")).json.phone, "(503) 555-0142");
  // Their yes: previewed, then confirmed, with the words they saw and what they said it on.
  const p = await call("/actions/consent.texts/plan", { person_id: (await call("/me")).json.person.id, granted: true, form_version: before.form.version, app: "member", device: "Mozilla/5.0 (Android)" });
  assert.equal(p.status, 200);
  assert.equal((await app.request(`/runs/${p.json.run_id}/apply`, { method: "POST", headers: { cookie, "content-type": "application/json", "idempotency-key": p.json.run_id }, body: "{}" })).status, 200);
  assert.equal((await call("/my/texts")).json.answer, true);
});

test("codes can't be used to run up the club's bill: three a number and five a person an hour", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await call("/my/phone/start", { phone: "503 555 0143" })).status, 200, `code ${i + 1}`);
  assert.equal((await call("/my/phone/start", { phone: "503 555 0143" })).status, 429);
  assert.equal((await call("/my/phone/start", { phone: "503 555 0146" })).status, 200);   // their fifth this hour
  assert.equal((await call("/my/phone/start", { phone: "503 555 0147" })).status, 429);   // a sixth
  await db.updateTable("auth_challenge").set({ created_at: new Date(Date.now() - 2 * 3600_000) }).where("kind", "=", "phone_code").execute();   // an hour on
  // A number that can't take texts is said so; one that replied STOP to the club is told how to undo it.
  texter.failNext = new TextError("21614", "not a mobile number", true);
  assert.equal((await call("/my/phone/start", { phone: "503 555 0144" })).json.error, "error.phone_cant_text");
  texter.failNext = new TextError("21610", "unsubscribed", true);
  assert.equal((await call("/my/phone/start", { phone: "503 555 0145" })).json.error, "error.phone_stopped");
});

test("from Twilio: only signed posts; STOP turns everything off with nothing more said; START and HELP are answered", async () => {
  const form = { From: "+15035550142", To: "+15035550000", Body: "STOP", MessageSid: "SMx" };
  assert.equal((await app.request("/webhooks/twilio/sms", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() })).status, 403);
  assert.equal((await fromTwilio("/webhooks/twilio/sms", form, "f".repeat(32))).status, 403);   // signed with another token
  const stop = await fromTwilio("/webhooks/twilio/sms", form);
  assert.deepEqual([stop.status, stop.text], [200, `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`]);
  const me = (await call("/me")).json.person.id;
  const off = await db.selectFrom("channel_consent").select(["channel", "purpose"]).where("person_id", "=", me).where("source", "=", "text_stop").where("granted", "=", false).execute();
  assert.equal(off.length, 12);   // every channel, every purpose
  assert.equal((await call("/my/texts")).json.answer, false);
  const start = await fromTwilio("/webhooks/twilio/sms", { ...form, Body: "Start" });
  assert.match(start.text, /<Message>Kestrel Padel: Texts are back on\. Reply STOP to stop\.<\/Message>/);
  assert.equal((await call("/my/texts")).json.answer, true);
  const help = await fromTwilio("/webhooks/twilio/sms", { ...form, Body: "help" });
  assert.match(help.text, /<Message>Kestrel Padel: Texts about your bookings and places\. For help, write to us in the app: https:\/\/kestrel\.example Reply STOP to stop\.<\/Message>/);
  // Anything else: told once a day that replies aren't read here, so two machines can't text each other forever.
  assert.match((await fromTwilio("/webhooks/twilio/sms", { ...form, Body: "see you at 6!" })).text, /Replies here aren't read/);
  assert.doesNotMatch((await fromTwilio("/webhooks/twilio/sms", { ...form, Body: "ok" })).text, /<Message>/);
  const near = await fromTwilio("/webhooks/twilio/sms", { ...form, From: "+15035550190", Body: "please stop sending me these" });
  assert.match(near.text, /To stop all messages from us, reply STOP\./);
});

test("Twilio's delivery reports find the text they're about", async () => {
  const me = (await call("/me")).json.person.id;
  await db.insertInto("outbound_message").values({ id: "01900000-0000-7000-8000-000000000001", event_id: null, person_id: me, kind: "booking_cancelled", channel: "sms", purpose: "account", essential: true,
    lang: "en", subject: "x", body: "x", link: null, status: "sent", send_after: new Date(), stale_at: null, provider_ref: "SM00000000000000000000000000000001" }).execute();
  assert.equal((await fromTwilio("/webhooks/twilio/status", { MessageSid: "SM00000000000000000000000000000001", MessageStatus: "undelivered", ErrorCode: "30003" })).status, 204);
  const row = await db.selectFrom("outbound_message").select(["status", "failure"]).where("provider_ref", "=", "SM00000000000000000000000000000001").executeTakeFirstOrThrow();
  assert.deepEqual(row, { status: "failed", failure: "twilio undelivered 30003" });
});

test("Twilio's settings, its signature and the practice sender", async () => {
  assert.equal(twilioFromEnv({}), null);
  assert.throws(() => twilioFromEnv({ KUMI_TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, KUMI_TWILIO_AUTH_TOKEN: TOKEN }), /who they're from/);
  assert.throws(() => twilioFromEnv({ KUMI_TWILIO_ACCOUNT_SID: "AC123", KUMI_TWILIO_AUTH_TOKEN: TOKEN, KUMI_TWILIO_FROM: "+15035550000" }), /ACCOUNT_SID/);
  assert.deepEqual(twilioFromEnv({ KUMI_TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, KUMI_TWILIO_AUTH_TOKEN: TOKEN, KUMI_TWILIO_MESSAGING_SERVICE_SID: `MG${"b".repeat(32)}` }),
    { accountSid: `AC${"a".repeat(32)}`, authToken: TOKEN, messagingServiceSid: `MG${"b".repeat(32)}` });
  // Twilio's own examples: its security docs (+12349013030) and its Node library's tests (+14158675309).
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2", call = (n: string) => ({ CallSid: "CA1234567890ABCDE", Caller: n, Digits: "1234", From: n, To: "+18005551212" });
  assert.equal(twilioSignature("12345", url, call("+12349013030")), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  assert.equal(twilioSignature("12345", url, call("+14158675309")), "RSOYDt4T1cUTdK1PDd93/VVr8B8=");
  assert.equal(validSignature("12345", url, call("+14158675309"), "RSOYDt4T1cUTdK1PDd93/VVr8B8="), true);
  assert.equal(validSignature("12345", url, { ...call("+14158675309"), Digits: "1235" }, "RSOYDt4T1cUTdK1PDd93/VVr8B8="), false);
  assert.equal(validSignature("12345", url, call("+14158675309"), undefined), false);
  // What goes to Twilio, and how its refusals come back.
  const seen: { url: string; body: string }[] = [];
  const fake = (status: number, json: object) => async (url: string, init: RequestInit) => { seen.push({ url, body: String(init.body) }); return new Response(JSON.stringify(json), { status }); };
  const cfg = { accountSid: `AC${"a".repeat(32)}`, authToken: TOKEN, from: "+15005550006" };
  assert.deepEqual(await new TwilioTexter(cfg, fake(201, { sid: "SMabc", status: "queued" })).send({ to: "+15035550100", body: "Hi", statusCallback: `${STAFF}/webhooks/twilio/status` }), { ref: "SMabc" });
  assert.equal(seen[0]!.url, `https://api.twilio.com/2010-04-01/Accounts/AC${"a".repeat(32)}/Messages.json`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seen[0]!.body)), { To: "+15035550100", Body: "Hi", From: "+15005550006", StatusCallback: `${STAFF}/webhooks/twilio/status` });
  await assert.rejects(new TwilioTexter(cfg, fake(400, { code: 21211, message: "Invalid 'To' Phone Number" })).send({ to: "+15005550001", body: "Hi" }), (e: unknown) => e instanceof TextError && e.code === "21211" && e.permanent);
  await assert.rejects(new TwilioTexter(cfg, fake(503, {})).send({ to: "+15035550100", body: "Hi" }), (e: unknown) => e instanceof TextError && !e.permanent);
  const inner = new TestTexter(), practice = new PracticeTexter(inner, ["+15035550100"]);
  await practice.send({ to: "+15035550100", body: "to a test number" }); await practice.send({ to: "+15035550199", body: "to a member" });
  assert.deepEqual([inner.sent.length, practice.held.length], [1, 1]);
});

test("a server without texts: the card says so and Twilio's posts aren't taken", async () => {
  const plain = makeApp({ db, mailer, secureCookies: false, publicUrl: STAFF });
  setTexting(false);
  try {
    assert.equal((await (await plain.request("/my/texts", { headers: { cookie } })).json() as any).on, false);
    assert.equal((await plain.request("/webhooks/twilio/sms", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "From=%2B15035550142&Body=STOP" })).status, 404);
  } finally { setTexting(true); }
});
