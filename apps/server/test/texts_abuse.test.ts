// Texts nobody can turn into a bill: HELP and START answered only for US and Canadian numbers, once a day each,
// and texted codes asked for all at once still kept to the club's hourly limit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, setTexting, TestTexter, textUsage, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { twilioSignature } from "../src/twilio.ts";
import { PER_CLUB } from "../src/texts.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;
const texter = new TestTexter(), TOKEN = "0123456789abcdef0123456789abcdef", STAFF = "https://staff.kestrel.example", MEMBERS = "https://kestrel.example";
const fromTwilio = async (form: Record<string, string>) => {
  const path = "/webhooks/twilio/sms";
  const r = await app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(TOKEN, `${STAFF}${path}`, form) }, body: new URLSearchParams(form).toString() });
  return (await r.text()).includes("<Message>");
};
before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  await db.updateTable("club").set({ sign_up_open: true }).execute();
  setTexting(true);
  app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false, publicUrl: STAFF, memberUrl: MEMBERS, texts: { texter, authToken: TOKEN } });
});
after(async () => drop());

test("HELP and START: answered for US and Canadian numbers once a day each, never for others", async () => {
  let n = 0;
  const say = (From: string, Body: string) => fromTwilio({ From, To: "+15035550000", Body, MessageSid: `SM${n++}` });
  for (let i = 0; i < 20; i++) assert.equal(await say("+447700900123", "HELP"), false);   // a UK number: never
  assert.equal(await say("+15035550142", "HELP"), true);
  assert.equal(await say("+15035550142", "HELP"), false);   // once a day
  assert.equal(await say("+15035550142", "START"), true);
  assert.equal(await say("+15035550142", "START"), false);
  const u = await textUsage(db);
  assert.ok(u!.current.code_segments <= 4, `only the answers sent count: ${u!.current.code_segments}`);
});

test("texted codes asked for all at once: never more than the club's hourly limit", async () => {
  const one = (k: number) => Promise.resolve(app.request("/auth/phone/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: `(503) 555-${String(2000 + k)}` }) })).then((r: Response) => r.status);
  const before = texter.sent.length;
  const st = await Promise.all(Array.from({ length: 60 }, (_, k) => one(k)));
  assert.ok(texter.sent.length - before <= PER_CLUB, `${texter.sent.length - before} codes sent`);
  assert.ok(st.filter((s: number) => s === 429).length >= 60 - PER_CLUB);
});
