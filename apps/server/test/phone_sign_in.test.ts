import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, setTexting, TestTexter, TextError, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

// Signing in, or joining, by a code texted to a US or Canadian number; then an email added to that account.
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), texter = new TestTexter();
const post = async (path: string, body: unknown, cookie = "") => {
  const r = await app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
};
const get = async (path: string, cookie = "") => {
  const r = await app.request(path, { headers: { cookie } });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
const lastCode = (to: string) => texter.last(to)!.body.match(/\b(\d{6})\b/)![1]!;
const texts = (to: string) => texter.sent.filter((x) => x.to === to).length;
/** The sign-in codes asked for this hour are an hour old: these tests ask for more than a number may. */
const anHourOn = () => db.updateTable("auth_challenge").set({ created_at: new Date(Date.now() - 2 * 3600_000) }).where("kind", "in", ["phone_sign_in", "phone_code"]).execute();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  setTexting(true);
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://staff.kestrel.example", memberUrl: "https://kestrel.example", texts: { texter, authToken: "0123456789abcdef0123456789abcdef" } });
});
after(async () => drop());

test("a number new to the club joins by a texted code: no email needed, and the code text is plain", async () => {
  assert.equal((await get("/club")).json.phone_sign_in, true);
  assert.equal((await post("/auth/phone/start", { phone: "+44 20 7946 0958" })).status, 400);
  const r = await post("/auth/phone/start", { phone: "(503) 555-0170" });
  assert.deepEqual([r.status, r.json], [200, { sent: true }]);
  assert.match(texter.last("+15035550170")!.body, /^Kestrel Padel: Your code is \d{6}\. It works for 10 minutes\. Reply STOP to stop\.$/);
  const wrong = lastCode("+15035550170") === "000000" ? "111111" : "000000";
  assert.equal((await post("/auth/phone/verify", { phone: "503-555-0170", code: wrong })).status, 401);
  const v = await post("/auth/phone/verify", { phone: "503-555-0170", code: lastCode("+15035550170") });
  assert.deepEqual([v.json.sign_up, v.json.by], [true, "phone"]);
  const j = await post("/auth/sign-up", { ticket: v.json.ticket, display_name: "Pat Rivera", locale: "es", club_news: true });
  assert.equal(j.status, 200);
  const me = (await get("/me", j.cookie)).json;
  assert.deepEqual([me.person.display_name, me.signed_in_with, me.has_email], ["Pat Rivera", "phone_code", false]);
  const p = await db.selectFrom("person").select(["email", "phone", "locale"]).where("id", "=", me.person.id).executeTakeFirstOrThrow();
  assert.deepEqual(p, { email: null, phone: "+15035550170", locale: "es" });
  assert.equal((await db.selectFrom("auth_identity").select("kind").where("person_id", "=", me.person.id).where("verified_at", "is not", null).execute()).map((x) => x.kind).join(), "phone");
  // There's no email to send club news to, so they weren't asked: no answer is kept (and none counts as a no).
  assert.equal((await db.selectFrom("channel_consent").select("id").where("person_id", "=", me.person.id).execute()).length, 0);
  // Nor does a code to sign in need their yes to texts: it's a text they asked for.
  assert.equal((await get("/my/texts", j.cookie)).json.answer, null);
});

test("the same number signs into the same account next time, and the answer never says whether a number has one", async () => {
  const before = await post("/auth/phone/start", { phone: "503 555 0170" });
  const v = await post("/auth/phone/verify", { phone: "+15035550170", code: lastCode("+15035550170") });
  assert.equal(v.json.signed_in, true);
  assert.equal((await get("/me", v.cookie)).json.person.display_name, "Pat Rivera");
  // A club that has closed sign-up: a number with an account gets its code, one without gets nothing, and both
  // are answered alike.
  await db.updateTable("club").set({ sign_up_open: false }).execute();
  const sentBefore = texter.sent.length;
  const stranger = await post("/auth/phone/start", { phone: "503 555 0171" });
  assert.deepEqual([stranger.status, stranger.json], [before.status, before.json]);
  assert.equal(texter.sent.length, sentBefore);
  await db.updateTable("club").set({ sign_up_open: true }).execute();
  await anHourOn();
});

test("codes are limited: three a number an hour, five wrong tries, ten minutes", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await post("/auth/phone/start", { phone: "503 555 0172" })).status, 200, `code ${i + 1}`);
  assert.equal((await post("/auth/phone/start", { phone: "503 555 0172" })).json.error, "error.too_many_codes");
  assert.equal(texts("+15035550172"), 3);
  await anHourOn();
  await post("/auth/phone/start", { phone: "503 555 0172" });
  const right = lastCode("+15035550172"), wrong = right === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) assert.equal((await post("/auth/phone/verify", { phone: "503 555 0172", code: wrong })).json.error, "error.bad_code");
  assert.equal((await post("/auth/phone/verify", { phone: "503 555 0172", code: wrong })).json.error, "error.too_many_attempts");
  assert.equal((await post("/auth/phone/verify", { phone: "503 555 0172", code: right })).json.error, "error.too_many_attempts");   // locked, even with the right one
  await post("/auth/phone/start", { phone: "503 555 0172" });
  await db.updateTable("auth_challenge").set({ expires_at: new Date(Date.now() - 1000) }).where("target", "=", "+15035550172").where("consumed_at", "is", null).execute();
  assert.equal((await post("/auth/phone/verify", { phone: "503 555 0172", code: lastCode("+15035550172") })).json.error, "error.code_expired");
  await anHourOn();
  // A number that replied STOP to the club is told how to undo it; one that can't take texts is said so.
  texter.failNext = new TextError("21610", "unsubscribed", true);
  assert.equal((await post("/auth/phone/start", { phone: "503 555 0173" })).json.error, "error.phone_stopped");
  texter.failNext = new TextError("21614", "not a mobile number", true);
  assert.equal((await post("/auth/phone/start", { phone: "503 555 0174" })).json.error, "error.phone_cant_text");
});

test("a junior's number signs them in only once their parents have given them a login; a staff member still owes the second step", async () => {
  // A junior with a login their parents gave, who confirmed a number: it signs them in.
  const kid = ((await run(db, "person.create", { display_name: "Kid Rivera", email: "kid@example.test" }, owner)).result as any).person_id as string;
  await db.updateTable("person").set({ junior: true, own_login: true, phone: "+15035550175" }).where("id", "=", kid).execute();
  await db.insertInto("auth_identity").values({ id: "00000000-0000-7000-8000-0000000000a1", person_id: kid, kind: "phone", value: "+15035550175", verified_at: new Date() }).execute();
  await post("/auth/phone/start", { phone: "503 555 0175" });
  assert.equal((await post("/auth/phone/verify", { phone: "503 555 0175", code: lastCode("+15035550175") })).json.signed_in, true);
  // Their parents take the login away (kid.remove_login clears the number but may leave an old identity row):
  // nothing is sent, and the answer is the same.
  await db.updateTable("person").set({ email: null, phone: null, own_login: false }).where("id", "=", kid).execute();
  const sent = texter.sent.length;
  assert.deepEqual((await post("/auth/phone/start", { phone: "503 555 0175" })).json, { sent: true });
  assert.equal(texter.sent.length, sent);
  // The owner, with a confirmed number, at a club where owners and managers sign in with two steps.
  await db.updateTable("person").set({ phone: "+15035550176" }).where("id", "=", owner.personId!).execute();
  await db.insertInto("auth_identity").values({ id: "00000000-0000-7000-8000-0000000000a2", person_id: owner.personId!, kind: "phone", value: "+15035550176", verified_at: new Date() }).execute();
  await db.updateTable("club").set({ two_factor: "owner_manager" }).execute();
  await post("/auth/phone/start", { phone: "503 555 0176" });
  const v = await post("/auth/phone/verify", { phone: "503 555 0176", code: lastCode("+15035550176") });
  const me = (await get("/me", v.cookie)).json;
  assert.deepEqual([me.signed_in_with, me.gate], ["phone_code", "setup"]);
  assert.equal((await get("/changes", v.cookie)).json.error, "error.two_step_needed");
  await db.updateTable("club").set({ two_factor: "off" }).execute();
});

test("an account that joined by phone adds an email with a code; an address someone else uses gets the same answer", async () => {
  await anHourOn();
  await post("/auth/phone/start", { phone: "503 555 0170" });
  const { cookie } = await post("/auth/phone/verify", { phone: "503 555 0170", code: lastCode("+15035550170") });
  // The profile's codes to confirm a number count with the sign-in codes: three to a number an hour, whichever asked.
  assert.equal((await post("/my/phone/start", { phone: "503 555 0170" }, cookie)).status, 200);
  assert.equal((await post("/my/phone/start", { phone: "503 555 0170" }, cookie)).status, 200);
  assert.equal((await post("/my/phone/start", { phone: "503 555 0170" }, cookie)).json.error, "error.phone_too_many");
  // The owner's address: the same answer as a free one; the owner hears someone tried, and no code that works exists.
  assert.deepEqual((await post("/my/email/start", { email: "robin@example.test" }, cookie)).json, { sent: true });
  assert.equal(mailer.last("robin@example.test")!.subject, "Someone tried to use this email at Kestrel Padel");
  assert.doesNotMatch(mailer.last("robin@example.test")!.text, /\b\d{6}\b/);
  assert.equal((await post("/my/email/start", { email: "pat@example.test" }, cookie)).status, 200);
  const code = mailer.last("pat@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  assert.match(mailer.last("pat@example.test")!.subject, /^Tu código para agregar este correo en Kestrel Padel: \d{6}$/);   // in their language
  assert.deepEqual((await post("/my/email/verify", { code }, cookie)).json, { email: "pat@example.test" });
  assert.equal((await get("/me", cookie)).json.has_email, true);
  // Now the address signs them in too.
  await post("/auth/email/start", { email: "pat@example.test" });
  const v = await post("/auth/email/verify", { email: "pat@example.test", code: mailer.last("pat@example.test")!.text.match(/\b(\d{6})\b/)![1]! });
  assert.equal((await get("/me", v.cookie)).json.person.display_name, "Pat Rivera");
});

test("an assistant's sign-in page offers the texted code too; only a number already on an account is texted", async () => {
  await anHourOn();
  const reg = await (await app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Agent", redirect_uris: ["http://localhost:9999/cb"], token_endpoint_auth_method: "none" }) })).json() as any;
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://localhost:9999/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", scope: "kumi" });
  const authorize = `https://staff.kestrel.example/oauth/authorize?${q}`;
  const first = await (await app.request(authorize)).text();
  assert.match(first, /Use my mobile number instead/);
  const byPhone = await (await app.request(`${authorize}&by=phone`)).text();
  assert.match(byPhone, /Your mobile number/); assert.match(byPhone, /Text me a code/); assert.match(byPhone, /Use my email instead/);
  const form = (o: Record<string, string>, cookie = "") => app.request("https://staff.kestrel.example/oauth/sign-in", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams(o).toString() });
  const before = texter.sent.length;
  const stranger = await form({ back: authorize, phone: "503 555 0199" });
  assert.equal(stranger.status, 303);
  assert.equal(texter.sent.length, before, "a number with no account isn't texted (no joining here)");
  const r1 = await form({ back: authorize, phone: "503 555 0170" });
  assert.equal(r1.status, 303);
  const sentPage = await (await app.request(`https://staff.kestrel.example${r1.headers.get("location")}`)).text();
  assert.match(sentPage, /The 6-digit code we texted you/);
  const r2 = await form({ back: authorize, phone: "503 555 0170", code: lastCode("+15035550170") });
  assert.equal(r2.status, 303);
  const cookie = r2.headers.get("set-cookie")!.split(";")[0]!;
  const consent = await (await app.request(`https://staff.kestrel.example${r2.headers.get("location")}`, { headers: { cookie } })).text();
  assert.match(consent, /Conectar Agent con Kestrel Padel/);   // Pat reads Spanish
  assert.match(consent, /Pat Rivera/);
});

test("a club that doesn't text doesn't offer it", async () => {
  const plain = makeApp({ db, mailer, secureCookies: false });
  setTexting(false);
  assert.equal((await (await plain.request("/club")).json() as any).phone_sign_in, false);
  const r = await plain.request("/auth/phone/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "503 555 0177" }) });
  assert.deepEqual([r.status, ((await r.json()) as any).error], [409, "error.phone_sign_in_off"]);
  setTexting(true);
});
