// An account Kumi made for support access (support.ts) can't connect an assistant: no consent screen for it, and a
// token one got anyway doesn't open the assistant door. Once the club gives that person a role of their own, it can.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, supportOnly, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { bearerPerson } from "../src/oauth.ts";

const BASE = "https://club.example.test", MCP = `${BASE}/mcp`, CLIENT = "client-1", REDIRECT = "https://assistant.example.test/callback";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, ada = "", ben = "";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const session = async (personId: string) => {
  const token = randomBytes(16).toString("hex");
  await db.insertInto("web_session").values({ token_hash: sha(token), person_id: personId, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey", second_factor: null }).execute();
  return `kumi_session=${token}`;
};
const authorize = (cookie: string) => {
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, code_challenge: randomBytes(32).toString("base64url"), code_challenge_method: "S256", state: "s1", scope: "kumi", resource: MCP });
  return app.request(`${BASE}/oauth/authorize?${q}`, { headers: { cookie } });
};
/** A token for this person's assistant, as one connected before the refusal would have. */
const tokenFor = async (personId: string) => {
  const grant = uuidv7(), access = randomBytes(24).toString("hex");
  await db.insertInto("oauth_grant").values({ id: grant, person_id: personId, client_id: CLIENT, scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0 }).execute();
  await db.insertInto("oauth_token").values({ token_hash: sha(access), kind: "access", grant_id: grant, family: grant, resource: MCP, expires_at: new Date(Date.now() + 3600_000), used_at: null, revoked_at: null }).execute();
  return `Bearer ${access}`;
};

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  await run(db, "support.grant", { email: "ada@help.test", name: "Ada", reason: "Checking the booking rules", level: "view", hours: 4 }, owner);
  ada = (await db.selectFrom("person").select("id").where("email", "=", "ada@help.test").executeTakeFirstOrThrow()).id;
  ben = ((await run(db, "person.create", { display_name: "Ben", email: "ben@example.test" }, owner)).result as { person_id: string }).person_id;
  await db.insertInto("oauth_client").values({ client_id: CLIENT, kind: "registered", name: "An assistant", redirect_uris: [REDIRECT], auth_method: "none", secret_hash: null, metadata: null }).execute();
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
});
after(async () => drop());

test("an account made for support access gets no consent screen, in either language; a member does", async () => {
  assert.equal(await supportOnly(db, ada), true);
  const r = await authorize(await session(ada));
  assert.equal(r.status, 403);
  const page = await r.text();
  assert.match(page, /made for support access to Kestrel Padel, so it can(&#39;|')t connect an assistant/);
  assert.doesNotMatch(page, /name="req"/, "no way to allow");
  const member = await authorize(await session(ben));
  assert.equal(member.status, 200);
  assert.match(await member.text(), /name="req"/);
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", ada).execute();
  // In their own language, which is the profile's once signed in.
  assert.match(await (await authorize(await session(ada))).text(), /se creó para el acceso de soporte a Kestrel Padel, así que no puede conectar un asistente/);
});

test("a token a support-only account already had doesn't open the assistant door; a member's does", async () => {
  const now = new Date();
  assert.equal(await bearerPerson(db, await tokenFor(ada), [MCP], now), null);
  assert.equal((await bearerPerson(db, await tokenFor(ben), [MCP], now))?.id, ben);
  const r = await app.request(MCP, { method: "POST", headers: { authorization: await tokenFor(ada), "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
  assert.equal(r.status, 401);
});

test("once the club gives that person a role of their own, they're staff like any other and can connect one", async () => {
  const desk = await db.selectFrom("role").select("id").where("key", "=", "front_desk").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: ada, role_id: desk.id, location_id: null, active: true }).execute();
  assert.equal(await supportOnly(db, ada), false);
  assert.ok(await bearerPerson(db, await tokenFor(ada), [MCP], new Date()));
});
