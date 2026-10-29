import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, uuidv7, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const BASE = "https://club.example.test";
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;
const mailer = new MemoryMailer();
const OWNER = "robin@example.test";
const b64 = (b: Buffer) => b.toString("base64url");
const req = (path: string, init: RequestInit = {}) => app.request(path.startsWith("http") ? path : `${BASE}${path}`, init);
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

/** The whole sign-in an assistant does: authorize, sign in on the consent page, allow, swap the code. */
async function connect(email: string, clientId: string, redirect: string, opts: { sendVerifier?: string; resource?: string } = {}) {
  const verifier = b64(randomBytes(32)), challenge = b64(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "kumi", resource: `${BASE}/mcp` });
  const authorize = `/oauth/authorize?${q}`;
  assert.match(await (await req(authorize)).text(), /Email me a code/);
  const r1 = await req("/oauth/sign-in", form({ back: authorize, email }));
  assert.equal(r1.status, 303);
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r2 = await req("/oauth/sign-in", form({ back: authorize, email, code }));
  const cookie = r2.headers.get("set-cookie")!.split(";")[0]!;
  const consent = await (await req(r2.headers.get("location")!, { headers: { cookie } })).text();
  const id = consent.match(/name="req" value="([^"]+)"/)![1]!;
  const r3 = await req("/oauth/decide", { ...form({ req: id, decision: "allow" }), headers: { "content-type": "application/x-www-form-urlencoded", cookie } });
  const back = new URL(r3.headers.get("location")!);
  assert.equal(back.searchParams.get("state"), "s1"); assert.equal(back.searchParams.get("iss"), BASE);
  const tok = await req("/oauth/token", form({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: opts.sendVerifier ?? verifier, client_id: clientId, redirect_uri: redirect, resource: opts.resource ?? `${BASE}/mcp` }));
  return { status: tok.status, body: await tok.json() as any, consent };
}
async function mcp(accessToken: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } }, fetch: async (u, init) => req(String(u), init) }));
  return client;
}
const textOf = (r: any) => JSON.parse(r.content[0].text);

before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: OWNER, owner_name: "Robin Hale" }, "setup");
  app = makeApp({ db, mailer, publicUrl: BASE, secureCookies: false, fetchMetadata: async (url) => url === CLAUDE ? { client_id: CLAUDE, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" } : null });
});
after(async () => drop());

test("discovery: 401 points at the resource metadata, which points at the sign-in server", async () => {
  const r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate")!, /resource_metadata="https:\/\/club\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await (await req("/.well-known/oauth-protected-resource/mcp")).json() as any;
  assert.equal(prm.resource, `${BASE}/mcp`); assert.equal(prm.resource_name, "Kestrel Padel");
  const as = await (await req("/.well-known/oauth-authorization-server")).json() as any;
  assert.equal(as.issuer, BASE); assert.equal(as.client_id_metadata_document_supported, true);
});

test("Claude's published identity: no registration, consent, then preview and confirm a change", async () => {
  const { status, body, consent } = await connect(OWNER, CLAUDE, "https://claude.ai/api/mcp/auth_callback");
  assert.match(consent, /Connect Claude to Kestrel Padel/);
  assert.equal(status, 200, JSON.stringify(body));
  const client = await mcp(body.access_token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("club_update_preview") && names.includes("club_update_confirm") && names.includes("whoami"));
  const p = textOf(await client.callTool({ name: "club_update_preview", arguments: { name: "Kestrel Padel Club" } }));
  assert.equal(p.summary, "Change the name.");
  assert.equal((await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name, "Kestrel Padel", "a preview changes nothing");
  assert.equal(textOf(await client.callTool({ name: "club_update_confirm", arguments: { run_id: p.run_id } })).done, true);
  assert.equal((await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name, "Kestrel Padel Club");
  const via = await db.selectFrom("action_run").select("via").where("id", "=", p.run_id).executeTakeFirstOrThrow();
  assert.equal(via.via, "mcp:Claude");
  await client.close();
});

test("a registered client; a member sees only their own tools, in Spanish, and can't confirm someone else's preview", async () => {
  const reg = await (await req("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test Agent", redirect_uris: ["http://localhost:9999/cb"], token_endpoint_auth_method: "none" }) })).json() as any;
  assert.ok(reg.client_id);
  const email = "ana@example.test", id = uuidv7();
  await db.insertInto("person").values({ id, display_name: "Ana", email, locale: "es", created_via: "desk" }).execute();
  const member = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: member.id, location_id: null }).execute();
  const { body } = await connect(email, reg.client_id, "http://localhost:9999/cb");
  const client = await mcp(body.access_token);
  const tools = (await client.listTools()).tools;
  assert.ok(!tools.some((t) => t.name.startsWith("club_update")), "no club tools for a member");
  const profile = tools.find((t) => t.name === "person_update_profile_preview")!;
  assert.equal(profile.title, "Cambiar tu perfil (vista previa)");
  const ownerRun = (await db.selectFrom("action_run").select("id").where("action", "=", "club.update").where("status", "=", "applied").executeTakeFirstOrThrow()).id;
  const stolen = await client.callTool({ name: "club_update_confirm", arguments: { run_id: ownerRun } });
  assert.equal(stolen.isError, true, "a tool that isn't listed for you can't be called");
  assert.equal((await db.selectFrom("action_run").select("status").where("id", "=", ownerRun).executeTakeFirstOrThrow()).status, "applied");
  const p = textOf(await client.callTool({ name: "person_update_profile_preview", arguments: { person_id: id, display_name: "Ana R." } }));
  assert.equal(p.summary, "Cambiar tu nombre visible en tu perfil.");
  await client.close();
});

test("PKCE, resource binding and refresh rotation; a reused refresh token ends the chain", async () => {
  const bad = await connect(OWNER, CLAUDE, "https://claude.ai/api/mcp/auth_callback", { sendVerifier: "not-the-verifier-the-challenge-came-from" });
  assert.equal(bad.status, 400); assert.equal(bad.body.error, "invalid_grant");
  const elsewhere = await connect(OWNER, CLAUDE, "https://claude.ai/api/mcp/auth_callback", { resource: "https://other.example.test/mcp" });
  assert.equal(elsewhere.body.error, "invalid_target");
  const { body } = await connect(OWNER, CLAUDE, "https://claude.ai/api/mcp/auth_callback");
  const r1 = await (await req("/oauth/token", form({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: CLAUDE }))).json() as any;
  assert.ok(r1.access_token);
  const replay = await req("/oauth/token", form({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: CLAUDE }));
  assert.equal(replay.status, 400);
  const after = await req("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${r1.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(after.status, 401, "the whole family is revoked");
});

test("redirect URIs must be https or localhost", async () => {
  const r = await req("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(r.status, 400);
});
