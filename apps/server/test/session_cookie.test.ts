import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

// The session cookie (session_cookie.ts). Over HTTPS it's `__Host-kumi_session`, which the browser keeps to the one
// host: clubs on a host's shared domain (<slug>.kumi.club) can't set it for each other. Found in the 3 Nov 2026
// security review: under the plain name one club's server could set a `kumi_session` for the whole domain and sign
// another club's visitors in as someone of its choosing. The old name is read for one release, so the update signs
// nobody out, unless the host turns that off. Over plain http (a computer of one's own) the plain name stays.
let db: Db, drop: () => Promise<void>, personId = "";
const mailer = new MemoryMailer();
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
async function session() {
  const token = randomBytes(24).toString("base64url");
  await db.insertInto("web_session").values({ token_hash: sha(token), person_id: personId, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  return token;
}
const me = async (app: ReturnType<typeof makeApp>, cookie: string) => {
  const r = await app.request("/me", { headers: { cookie } });
  return { signedIn: r.status === 200, cookies: r.headers.getSetCookie() };
};

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  const owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" as const, auth: "passkey" as const };
  personId = ((await run(db, "person.create", { display_name: "Mia", email: "mia@example.test" }, owner)).result as any).person_id;
});
after(async () => { await drop(); });

test("over HTTPS a sign-in sets __Host-kumi_session: Secure, Path=/, no Domain, HttpOnly", async () => {
  const app = makeApp({ db, mailer, secureCookies: true });
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "mia@example.test" }) });
  const code = mailer.last("mia@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "mia@example.test", code }) });
  const set = r.headers.getSetCookie().find((x) => x.startsWith("__Host-kumi_session="))!;
  assert.ok(set, "the new name");
  assert.match(set, /; Secure/); assert.match(set, /; Path=\/(;|$)/); assert.match(set, /; HttpOnly/);
  assert.doesNotMatch(set, /Domain=/i);
  assert.ok(!r.headers.getSetCookie().some((x) => x.startsWith("kumi_session=") && !/Max-Age=0/.test(x)), "never the plain name over HTTPS");
  const token = set.split(";")[0]!.split("=")[1]!;
  assert.ok((await me(app, `__Host-kumi_session=${token}`)).signedIn);
});

test("a session under the old name is read for one release, and moved to the new one", async () => {
  const app = makeApp({ db, mailer, secureCookies: true }), token = await session();
  const r = await me(app, `kumi_session=${token}`);
  assert.ok(r.signedIn, "nobody is signed out by the update");
  assert.ok(r.cookies.some((x) => x.startsWith(`__Host-kumi_session=${token}`) && /; Secure/.test(x)), "moved to the new name");
  assert.ok(r.cookies.some((x) => x.startsWith("kumi_session=;") && /Max-Age=0/.test(x)), "the old one cleared");
  // Both: the new name is the one believed.
  const other = await session();
  assert.ok((await me(app, `kumi_session=nonsense; __Host-kumi_session=${other}`)).signedIn);
});

test("with the old name turned off (a host whose clubs never had it), a kumi_session set by another club signs nobody in", async () => {
  const app = makeApp({ db, mailer, secureCookies: true, legacySessionCookie: false }), token = await session();
  // What a hostile club on the same domain would set: a real session of its choosing, under the plain name.
  const r = await me(app, `kumi_session=${token}`);
  assert.equal(r.signedIn, false);
  assert.ok(!r.cookies.some((x) => x.startsWith("__Host-kumi_session=")), "and it isn't moved to the new name");
});

test("over plain http (one's own computer) the plain name, without Secure, as before", async () => {
  const app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false }), token = await session();
  assert.ok((await me(app, `kumi_session=${token}`)).signedIn);
  assert.equal((await me(app, `__Host-kumi_session=${token}`)).signedIn, false, "browsers don't keep the prefix over http");
  const r = await app.request("/auth/sign-out", { method: "POST", headers: { cookie: `kumi_session=${token}` } });
  const out = r.headers.getSetCookie();
  assert.ok(out.some((x) => x.startsWith("kumi_session=;") && !/; Secure/.test(x)));
  assert.equal((await me(app, `kumi_session=${token}`)).signedIn, false, "signed out");
});

test("signing out over HTTPS clears both names", async () => {
  const app = makeApp({ db, mailer, secureCookies: true }), token = await session();
  const r = await app.request("/auth/sign-out", { method: "POST", headers: { cookie: `__Host-kumi_session=${token}; kumi_session=${token}` } });
  const out = r.headers.getSetCookie();
  assert.ok(out.some((x) => x.startsWith("__Host-kumi_session=;") && /Max-Age=0/.test(x)));
  assert.ok(out.some((x) => x.startsWith("kumi_session=;") && /Max-Age=0/.test(x)));
  assert.equal((await me(app, `__Host-kumi_session=${token}`)).signedIn, false);
});
