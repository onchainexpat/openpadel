import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { base32Decode, run, runAsSystem, totp, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

// Real time: sessions take the database clock when they start.
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, clock = new Date();
const mailer = new MemoryMailer(), people: Record<string, string> = {};
let secret = "", codes: string[] = [];
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const req = async (path: string, cookie: string, body?: unknown) => {
  const r = await app.request(path, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
/** An emailed code sign-in: the session cookie. */
async function signIn(email: string) {
  await db.deleteFrom("auth_challenge").where("target", "=", email).execute();   // these tests sign in more than five times an hour
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
/** A session signed in with a passkey (the WebAuthn part has its own tests). */
async function passkeySession(name: string) {
  const token = `pk-${name}-${Math.random()}`;
  await db.insertInto("web_session").values({ token_hash: sha(token), person_id: people[name]!, expires_at: new Date(clock.getTime() + 864e5), last_seen_at: clock, user_agent: null, revoked_at: null, method: "passkey" }).execute();
  return `kumi_session=${token}`;
}
const step = () => { clock = new Date(clock.getTime() + 30_000); return totp(base32Decode(secret), clock); };

before(async () => {
  ({ db, drop } = await freshDb({ twoFactor: true }));
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  people.Robin = owner.personId!;
  for (const name of ["Mia", "Sam"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Mia, role: "manager" }, owner);
  app = makeApp({ db, mailer, secureCookies: false, now: () => clock });
});
after(async () => drop());

test("a manager signed in by emailed code can't do anything until a second step is set up", async () => {
  const mia = await signIn("mia@example.test");
  const me = await req("/me", mia);
  assert.deepEqual([me.status, me.json.gate, me.json.signed_in_with], [200, "setup", "email_code"]);
  for (const path of ["/staff/people", "/my/inbox", "/staff/changes"]) assert.deepEqual([(await req(path, mia)).status, (await req(path, mia)).json.error], [403, "error.two_step_needed"], path);
  assert.equal((await req("/actions/club.update/plan", mia, { name: "X" })).json.error, "error.two_step_needed");
  // A member isn't asked.
  assert.equal((await req("/me", await signIn("sam@example.test"))).json.gate, null);
});

test("setting up an authenticator: a QR code and the key, the first code, then ten recovery codes; the session is two-step", async () => {
  const mia = await signIn("mia@example.test");
  const s = await req("/auth/totp/setup", mia, {});
  assert.equal(s.status, 200);
  assert.match(s.json.qr, /^data:image\/svg\+xml;base64,/);
  assert.match(s.json.uri, /^otpauth:\/\/totp\/Kestrel%20Padel%3Amia%40example\.test\?secret=[A-Z2-7]{32}&issuer=Kestrel%20Padel/);
  secret = s.json.key.replaceAll(" ", "");
  assert.equal((await req("/auth/totp/confirm", mia, { challenge_id: s.json.challenge_id, code: "000000" })).json.error, "error.bad_factor_code");
  const c = await req("/auth/totp/confirm", mia, { challenge_id: s.json.challenge_id, code: totp(base32Decode(secret), clock) });
  codes = c.json.codes;
  assert.equal(codes.length, 10);
  assert.match(mailer.last("mia@example.test")!.subject, /An authenticator app was set up/);
  const me = await req("/me", mia);
  assert.deepEqual([me.json.gate, me.json.signed_in_with], [null, "two_factor"]);
  assert.equal((await req("/staff/people", mia)).status, 200);
  assert.deepEqual((await req("/my/two-factor", mia)).json, { required: true, authenticator: true, passkeys: 0, recovery_left: 10, two_step_now: true });
});

test("next time: the emailed code, then the app's code (a wrong one counts, five of them wait)", async () => {
  const mia = await signIn("mia@example.test");
  assert.equal((await req("/me", mia)).json.gate, "verify");
  assert.equal((await req("/auth/totp/verify", mia, { code: "123456" })).status, 401);
  assert.equal((await req("/auth/totp/verify", mia, { code: step() })).status, 200);
  assert.equal((await req("/me", mia)).json.signed_in_with, "two_factor");
  // Someone guessing: five wrong codes in 15 minutes, then a wait, even with the right one.
  const other = await signIn("mia@example.test");
  for (let i = 0; i < 4; i++) await req("/auth/totp/verify", other, { code: "000001" });
  assert.equal((await req("/auth/totp/verify", other, { code: step() })).status, 429);
  clock = new Date(clock.getTime() + 16 * 60_000);
});

test("a recovery code works once, and the person hears it was used", async () => {
  const a = await signIn("mia@example.test");
  const r = await req("/auth/recovery", a, { code: codes[0] });
  assert.deepEqual([r.status, r.json.left], [200, 9]);
  assert.match(mailer.last("mia@example.test")!.text, /You have 9 left/);
  assert.equal((await req("/me", a)).json.gate, null);
  const b = await signIn("mia@example.test");
  assert.equal((await req("/auth/recovery", b, { code: codes[0] })).json.error, "error.bad_recovery_code");
});

test("a passkey is both steps: no second code, and sensitive changes are allowed", async () => {
  const mia = await passkeySession("Mia");
  const me = await req("/me", mia);
  assert.deepEqual([me.json.gate, me.json.signed_in_with], [null, "passkey"]);
  assert.equal((await req("/staff/people", mia)).status, 200);
});

test("an emailed-code session from a while ago can't start setting one up; agents can't be connected on half a sign-in", async () => {
  const token = "old-sam";
  await db.insertInto("web_session").values({ token_hash: sha(token), person_id: people.Sam!, created_at: new Date(clock.getTime() - 3600_000), expires_at: new Date(clock.getTime() + 864e5), last_seen_at: clock, user_agent: null, revoked_at: null }).execute();
  assert.equal((await req("/auth/totp/setup", `kumi_session=${token}`, {})).json.error, "error.recent_sign_in");
  const mia = await signIn("mia@example.test");
  assert.equal((await app.request("/oauth/decide", { method: "POST", headers: { cookie: mia, "content-type": "application/x-www-form-urlencoded" }, body: "req=x&decision=allow" })).status, 403);
});

test("a half sign-in only gives its second step: no passkey or authenticator of its own can be added on it", async () => {
  clock = new Date();   // sessions start on the database's clock
  // Mia has an authenticator: whoever has her mailbox gets the emailed code, and nothing more.
  const half = await signIn("mia@example.test");
  assert.equal((await req("/me", half)).json.gate, "verify");
  for (const path of ["/auth/passkey/add/options", "/auth/passkey/add/verify", "/auth/totp/setup", "/auth/totp/confirm", "/my/phone/start", "/my/email/start"])
    assert.equal((await req(path, half, {})).json?.error, "error.two_step_needed", path);
  assert.equal((await req("/auth/passkey/sign-in/options", half, {})).status, 200);
  // Sam, a member with a passkey: an emailed code alone can't add a second one, or an authenticator; the passkey can.
  await db.insertInto("passkey").values({ credential_id: "sam-key", person_id: people.Sam!, public_key: Buffer.from("x"), counter: "0", transports: null, name: "Phone" }).execute();
  const sam = await signIn("sam@example.test");
  assert.equal((await req("/auth/totp/setup", sam, {})).json.error, "error.second_step_first");
  assert.equal((await req("/auth/passkey/add/options", sam, {})).json.error, "error.second_step_first");
  assert.equal((await req("/auth/passkey/add/options", await passkeySession("Sam"), {})).status, 200);
  await db.updateTable("passkey").set({ revoked_at: clock }).where("credential_id", "=", "sam-key").execute();
});

test("the assistant's sign-in page counts wrong authenticator codes with the apps' sign-in: five in all, then a wait", async () => {
  clock = new Date();
  const lou = ((await run(db, "person.create", { display_name: "Lou", email: "lou@example.test" }, owner)).result as any).person_id as string;
  const c = await signIn("lou@example.test");
  const st = await req("/auth/totp/setup", c, {});
  const key = base32Decode(st.json.key.replaceAll(" ", ""));
  assert.equal((await req("/auth/totp/confirm", c, { challenge_id: st.json.challenge_id, code: totp(key, clock) })).status, 200);   // 1
  const twoStep = (code: string) => app.request("/oauth/two-step", { method: "POST", headers: { cookie: c, "content-type": "application/x-www-form-urlencoded" }, body: `back=${encodeURIComponent("/oauth/authorize?x=1")}&code=${code}` });
  assert.equal((await req("/auth/totp/verify", c, { code: "000000" })).status, 401);   // 2
  assert.equal((await req("/auth/totp/verify", c, { code: "000001" })).status, 401);   // 3
  assert.equal((await twoStep("000002")).status, 401);                                   // 4
  assert.equal((await twoStep("000003")).status, 401);                                   // 5
  assert.equal((await twoStep("000004")).status, 429);
  assert.equal((await req("/auth/totp/verify", c, { code: totp(key, new Date(clock.getTime() + 60_000)) })).status, 429);
  assert.ok(lou);
});

test("the owner starts the manager's second step over: every session ends, and the next sign-in sets it up again", async () => {
  const mia = await passkeySession("Mia"), robin = await passkeySession("Robin");
  const p = await req("/actions/person.reset_sign_in/plan", robin, { person_id: people.Mia });
  assert.equal(p.status, 200);
  assert.match(p.json.summary, /^Start Mia's second sign-in step over: their authenticator app, 0 passkeys and 9 recovery codes stop working/);
  assert.equal((await req(`/runs/${p.json.run_id}/apply`, robin, {})).status, 200);
  assert.equal((await req("/me", mia)).status, 401);
  assert.equal((await req("/me", await signIn("mia@example.test"))).json.gate, "setup");
  // A manager can't do it to anyone (the owner has a passkey to reset).
  await db.insertInto("passkey").values({ credential_id: "robin-key", person_id: people.Robin!, public_key: Buffer.from("x"), counter: "0", transports: null, name: "Phone" }).execute();
  assert.equal((await req("/actions/person.reset_sign_in/plan", await passkeySession("Mia"), { person_id: people.Robin })).status, 403);
});
