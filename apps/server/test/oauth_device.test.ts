// The device sign-in (oauth.ts, RFC 8628), against a code someone else started and sent: the code is typed, never
// carried by a link; the consent screen says when and from where it was started; an owner or a manager gives a fresh
// second step to allow it; and codes from many addresses can't fill it up. Also: an assistant connected before a
// person was given a staff role is disconnected (from the independent review of 012eb4e, its finding 3, its three
// checks that came out fine, and two of its suspicions).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { base32Decode, run, runAsSystem, totp, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { DEVICE_GRANT, DEVICE_PER_ADDRESS } from "../src/oauth.ts";

const BASE = "https://club.example.test", MCP = `${BASE}/mcp`, TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, kimId = "";
let clock = new Date(), from = "203.0.113.7";
const mailer = new MemoryMailer();
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const req = (path: string, init: RequestInit = {}) => app.request(path.startsWith("http") ? path : `${BASE}${path}`, init);
const form = (o: Record<string, string>, cookie?: string) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(o).toString() });
/** A staff-app session, as a person has in their browser: by a passkey (both steps) unless said otherwise. */
async function session(personId: string, method = "passkey", createdAt = new Date()) {
  const token = randomBytes(16).toString("hex");
  await db.insertInto("web_session").values({ token_hash: sha(token), person_id: personId, created_at: createdAt, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method, second_factor: null } as any).execute();
  return `kumi_session=${token}`;
}
async function mcp(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await req("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return { status: r.status, body: r.status === 200 ? JSON.parse(((await r.json()) as any).result.content[0].text) : null };
}
/** Someone starts a device sign-in under a name of their choosing. */
async function startDevice(name: string) {
  const reg = await (await req("/oauth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: ["http://127.0.0.1/kumi-device"], token_endpoint_auth_method: "none", software_id: "kumi-cli" }) })).json() as any;
  const r = await req("/oauth/device_authorization", form({ client_id: reg.client_id, resource: MCP, scope: "kumi" }));
  return { status: r.status, client_id: reg.client_id as string, ...(await r.json() as any) };
}
/** The consent screen for a typed code, and its form's fields. */
async function consent(code: string, cookie: string) {
  const page = await (await req("/oauth/device", form({ code }, cookie))).text();
  return { page, code: page.match(/name="code" value="([^"]+)"/)?.[1], id: page.match(/name="req" value="([^"]+)"/)?.[1] };
}
const tokenOf = async (d: { device_code: string; client_id: string }) => (await (await req("/oauth/token", form({ grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: d.client_id }))).json()) as any;

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const [n, e] of [["Ann Lee", "ann.lee@example.test"], ["Ben Ruiz", "ben@example.test"]]) await run(db, "person.create", { display_name: n, email: e }, owner);
  kimId = ((await run(db, "person.create", { display_name: "Kim Park", email: "kim@example.test" }, owner)).result as any).person_id;
  app = makeApp({ db, mailer, publicUrl: BASE, secureCookies: false, now: () => clock, clientIp: () => from });
});
after(async () => drop());

test("a code is typed, never carried by a link: one someone else sent opens an empty form, not the consent", async () => {
  const d = await startDevice("kumi (front-desk-pc)");
  assert.equal(d.status, 200);
  assert.equal(d.verification_uri, `${BASE}/oauth/device`);
  assert.equal(d.verification_uri_complete, undefined, "no link with the code in it");
  const robin = await session(owner.personId!);
  const linked = await (await req(`/oauth/device?code=${d.user_code}`, { headers: { cookie: robin } })).text();
  assert.doesNotMatch(linked, /name="req"/, "following a link shows no consent screen");
  assert.doesNotMatch(linked, new RegExp(`value="${d.user_code}"`), "and the code isn't filled in");
  assert.match(linked, /Type the code your device shows you/);
  // Typed, the consent says when and from where it was started, and that the name is the device's own.
  const c = await consent(d.user_code, robin);
  assert.ok(c.id, c.page);
  assert.match(c.page, /Started just now from 203\.0\.113\.7\./);
  assert.match(c.page, /is the name the device gave itself/);
});

test("an owner with an authenticator gives its code to allow a device; without it, nothing is connected", async () => {
  await db.updateTable("club").set({ two_factor: "owner_manager" } as any).execute();
  try {
    // The owner sets up an authenticator in the staff app.
    await req("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test" }) });
    const code = mailer.last("robin@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
    const cookie = (await req("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
    const setup = await (await req("/auth/totp/setup", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).json() as any;
    const secret = String(setup.key).replaceAll(" ", "");
    const ok = await req("/auth/totp/confirm", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ challenge_id: setup.challenge_id, code: totp(base32Decode(secret), clock) }) });
    assert.equal(ok.status, 200, await ok.text());
    const d = await startDevice("kumi (laptop)");
    const c = await consent(d.user_code, cookie);
    assert.match(c.page, /name="factor_code"/, "the consent asks for the authenticator's code");
    const without = await req("/oauth/device/decide", form({ code: c.code!, req: c.id!, decision: "allow", cap: "0" }, cookie));
    assert.equal(without.status, 401);
    assert.equal((await tokenOf(d)).error, "authorization_pending", "not connected");
    clock = new Date(clock.getTime() + 30_000);
    const c2 = await consent(d.user_code, cookie);
    const allowed = await req("/oauth/device/decide", form({ code: c2.code!, req: c2.id!, decision: "allow", cap: "0", factor_code: totp(base32Decode(secret), clock) }, cookie));
    assert.equal(allowed.status, 200, await allowed.text());
    assert.ok((await tokenOf(d)).access_token);
    await db.updateTable("staff_factor").set({ removed_at: new Date() }).where("person_id", "=", owner.personId!).execute();
  } finally { await db.updateTable("club").set({ two_factor: "off" } as any).execute(); }
});

test("an owner with only a passkey allows a device right after a passkey sign-in, not from a session hours old", async () => {
  await db.updateTable("club").set({ two_factor: "owner_manager" } as any).execute();
  await db.insertInto("passkey").values({ credential_id: "cred-robin", person_id: owner.personId!, public_key: Buffer.from("x"), counter: "0", transports: null, name: "Phone", last_used_at: null, revoked_at: null }).execute();
  try {
    const d = await startDevice("kumi (front-desk-pc)");
    const old = await session(owner.personId!, "passkey", new Date(Date.now() - 3 * 3600_000));
    const stale = await consent(d.user_code, old);
    assert.doesNotMatch(stale.page, /name="decision"/, "no Allow on a sign-in hours old");
    assert.match(stale.page, /only right after signing in with a passkey/);
    const fresh = await session(owner.personId!, "passkey", new Date());
    const c = await consent(d.user_code, fresh);
    // The fresh screen's answer posted from the old session: refused on the server too.
    assert.equal((await req("/oauth/device/decide", form({ code: c.code!, req: c.id!, decision: "allow", cap: "0" }, old))).status, 403);
    assert.equal((await req("/oauth/device/decide", form({ code: c.code!, req: c.id!, decision: "allow", cap: "0" }, fresh))).status, 200);
    assert.ok((await tokenOf(d)).access_token);
  } finally {
    await db.deleteFrom("passkey").where("credential_id", "=", "cred-robin").execute();
    await db.updateTable("club").set({ two_factor: "off" } as any).execute();
  }
});

test("codes from one address are capped, so a few addresses can't keep a club from signing in a device", async () => {
  from = "198.51.100.9";
  const made = [];
  for (let i = 0; i < DEVICE_PER_ADDRESS; i++) made.push(await startDevice(`kumi (x${i})`));
  assert.ok(made.every((d) => d.status === 200));
  assert.equal((await startDevice("kumi (one more)")).status, 429, "one more from the same address waits");
  from = "203.0.113.8";
  assert.equal((await startDevice("kumi (desk)")).status, 200, "another address isn't stopped");
  from = "203.0.113.7";
});

test("an assistant connected as a member is disconnected when they're given a staff role, and they're told why", async () => {
  const grant = uuidv7(), access = randomBytes(24).toString("hex");
  await db.insertInto("oauth_client").values({ client_id: "kim-claude", kind: "registered", name: "Claude", redirect_uris: ["https://a.example.test/cb"], auth_method: "none", secret_hash: null, metadata: null }).execute();
  await db.insertInto("oauth_grant").values({ id: grant, person_id: kimId, client_id: "kim-claude", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0 }).execute();
  await db.insertInto("oauth_token").values({ token_hash: sha(access), kind: "access", grant_id: grant, family: grant, resource: MCP, expires_at: new Date(Date.now() + 3600_000), used_at: null, revoked_at: null }).execute();
  assert.equal((await mcp(access, "whoami")).status, 200, "connected as a member");
  const r = await run(db, "role.assign", { person_id: kimId, role: "manager" }, owner);
  assert.match((r as any).plan.summary.en, /Their connected assistant is disconnected/);
  assert.equal((await mcp(access, "whoami")).status, 401, "the old connection gets no manager's door");
  assert.ok((await db.selectFrom("oauth_grant").select("revoked_at").where("id", "=", grant).executeTakeFirstOrThrow()).revoked_at);
  const ev = await db.selectFrom("event_outbox").select("payload").where("topic", "=", "role.assigned").orderBy("id", "desc").executeTakeFirstOrThrow();
  assert.equal((ev.payload as any).assistants_ended, 1, "the message they get says their assistant was disconnected, and why");
});

// ---- Checked by the review, and still fine ----

test("allow clicked twice at once: one connection", async () => {
  const d = await startDevice("kumi (laptop)");
  const robin = await session(owner.personId!);
  const c = await consent(d.user_code, robin);
  await Promise.all([1, 2].map(() => req("/oauth/device/decide", form({ code: c.code!, req: c.id!, decision: "allow", cap: "0" }, robin))));
  assert.equal((await db.selectFrom("oauth_grant").select("id").where("client_id", "=", d.client_id).execute()).length, 1);
});

test("an owner who still owes the second step gets no device consent, and can't post one", async () => {
  await db.updateTable("club").set({ two_factor: "owner_manager" } as any).execute();
  try {
    const d = await startDevice("kumi (laptop)");
    const emailed = await session(owner.personId!, "email_code");
    const c = await consent(d.user_code, emailed);
    assert.equal(c.id, undefined, "no consent screen on half a sign-in");
    const r = await req("/oauth/device/decide", form({ code: d.user_code, req: "x", decision: "allow", cap: "0" }, emailed));
    assert.ok([400, 401, 403].includes(r.status));
  } finally { await db.updateTable("club").set({ two_factor: "off" } as any).execute(); }
});

test("the weekly limit is one of the consent's choices, scope kumi, and the code is used once", async () => {
  const d = await startDevice("kumi (laptop)");
  const robin = await session(owner.personId!);
  const c = await consent(d.user_code, robin);
  await req("/oauth/device/decide", form({ code: c.code!, req: c.id!, decision: "allow", cap: "999999" }, robin));
  const g = await db.selectFrom("oauth_grant").select(["weekly_cap_cents", "scopes"]).where("client_id", "=", d.client_id).executeTakeFirstOrThrow();
  assert.deepEqual([g.weekly_cap_cents, g.scopes], [0, ["kumi"]]);
  assert.ok((await tokenOf(d)).access_token);
  assert.equal((await tokenOf(d)).error, "expired_token");
  const other = await startDevice("kumi (other)");
  assert.equal((await tokenOf({ device_code: d.device_code, client_id: other.client_id })).error, "expired_token");
});
