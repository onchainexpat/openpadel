import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { apply, plan, runAsSystem, uuidv7, KumiError, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const BASE = "https://club.example.test";
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;
const mailer = new MemoryMailer();
const OWNER = "robin@example.test";
const b64 = (b: Buffer) => b.toString("base64url");
const req = (path: string, init: RequestInit = {}) => app.request(path.startsWith("http") ? path : `${BASE}${path}`, init);
const reqMain = req;
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

/** The whole sign-in an assistant does: authorize, sign in on the consent page, allow, swap the code. */
async function connect(email: string, clientId: string, redirect: string, opts: { sendVerifier?: string; resource?: string; cap?: string; askFor?: string; via?: { req: typeof req; base: string } } = {}) {
  const req = opts.via?.req ?? reqMain, base = opts.via?.base ?? BASE;
  const verifier = b64(randomBytes(32)), challenge = b64(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "kumi", resource: opts.askFor ?? `${base}/mcp` });
  const authorize = `/oauth/authorize?${q}`;
  assert.match(await (await req(authorize)).text(), /Email me a code/);
  const r1 = await req("/oauth/sign-in", form({ back: authorize, email }));
  assert.equal(r1.status, 303);
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r2 = await req("/oauth/sign-in", form({ back: authorize, email, code }));
  const cookie = r2.headers.get("set-cookie")!.split(";")[0]!;
  const consent = await (await req(r2.headers.get("location")!, { headers: { cookie } })).text();
  const id = consent.match(/name="req" value="([^"]+)"/)![1]!;
  const r3 = await req("/oauth/decide", { ...form({ req: id, decision: "allow", ...(opts.cap !== undefined ? { cap: opts.cap } : {}) }), headers: { "content-type": "application/x-www-form-urlencoded", cookie } });
  const back = new URL(r3.headers.get("location")!);
  assert.equal(back.searchParams.get("state"), "s1"); assert.equal(back.searchParams.get("iss"), base);
  const tok = await req("/oauth/token", form({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: opts.sendVerifier ?? verifier, client_id: clientId, redirect_uri: redirect, resource: opts.resource ?? opts.askFor ?? `${base}/mcp` }));
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
  assert.ok(names.includes("location_create_preview") && names.includes("location_create_confirm") && names.includes("whoami"));
  for (const strong of ["club_update_preview", "role_assign_preview", "vault_add_preview"]) assert.ok(!names.includes(strong), `${strong}: a strong sign-in's change is the app's alone`);
  const p = textOf(await client.callTool({ name: "location_create_preview", arguments: { name: "Westside", time_zone: "America/Los_Angeles" } }));
  assert.equal(p.summary, "Add the location Westside (America/Los_Angeles).");
  assert.equal((await db.selectFrom("location").select("id").where("name", "=", "Westside").execute()).length, 0, "a preview changes nothing");
  assert.equal(textOf(await client.callTool({ name: "location_create_confirm", arguments: { run_id: p.run_id } })).done, true);
  assert.equal((await db.selectFrom("location").select("id").where("name", "=", "Westside").execute()).length, 1);
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
  const ownerRun = (await db.selectFrom("action_run").select("id").where("action", "=", "location.create").where("status", "=", "applied").executeTakeFirstOrThrow()).id;
  const stolen = await client.callTool({ name: "location_create_confirm", arguments: { run_id: ownerRun } });
  assert.equal(stolen.isError, true, "a tool that isn't listed for you can't be called");
  assert.equal((await db.selectFrom("action_run").select("status").where("id", "=", ownerRun).executeTakeFirstOrThrow()).status, "applied");
  const p = textOf(await client.callTool({ name: "person_update_profile_preview", arguments: { person_id: id, display_name: "Ana R." } }));
  assert.equal(p.summary, "Cambiar tu nombre visible en tu perfil.");
  // Only the player's tools, and only what an assistant may do: the person's own say stays in the app.
  const names = tools.map((t) => t.name);
  for (const appOnly of ["waiver_accept_preview", "level_self_adjust_preview", "privacy_export_preview", "family_card_remove_preview", "family_card_start_preview", "assistant_set_cap_preview"])
    assert.ok(!names.includes(appOnly), appOnly);
  assert.ok(names.includes("booking_request_preview") && names.includes("level_request_review_preview"));
  assert.match(tools.find((t) => t.name === "consent_texts_preview")!.description!, /Only to turn it off: saying yes is done in the club's app\.$/);
  const yes = await client.callTool({ name: "consent_club_news_preview", arguments: { person_id: id, granted: true } });
  assert.equal(yes.isError, true);
  assert.match((yes as any).content[0].text, /Hazlo en la app del club/);
  // A short list: no validation patterns, no default fields, short descriptions.
  const json = JSON.stringify(tools);
  assert.ok(!json.includes("[0-9a-fA-F]{8}") && !json.includes("(?:0[13578]") && !json.includes("$schema") && !json.includes("taskSupport"), "the long patterns stay on the server");
  assert.ok(json.length < 70_000, `member tool list is ${json.length} bytes`);
  const book = tools.find((t) => t.name === "booking_request_preview")!;
  assert.deepEqual((book.inputSchema as any).properties.court_id, { type: "string", format: "uuid" });
  assert.equal(book.description, "Book a court: preview. Gives a summary to show the person and a run_id; nothing changes until booking_request_confirm.");
  const bad = await client.callTool({ name: "booking_request_preview", arguments: { court_id: "not-an-id", starts_at: "x", minutes: 90, pay: "whole", person_id: id } });
  assert.equal(bad.isError, true, "the full check still runs when the tool is called");
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

test("connecting sets a weekly spending limit, $0 unless the person picks more; the assistant can read what's left", async () => {
  const email = "cara@example.test", id = uuidv7();
  await db.insertInto("person").values({ id, display_name: "Cara", email, locale: "en", created_via: "desk" }).execute();
  const member = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: member.id, location_id: null }).execute();
  const { body, consent } = await connect(email, CLAUDE, "https://claude.ai/api/mcp/auth_callback", { cap: "5000" });
  assert.match(consent, /How much may it spend for you each week\?/);
  assert.match(consent, /<option value="0">Nothing: anything that costs money, I&#39;ll do in the app<\/option>/);
  const client = await mcp(body.access_token);
  const me = textOf(await client.callTool({ name: "whoami", arguments: {} }));
  assert.deepEqual(me.spending, { weekly_limit: "$50.00", spent_this_week: "$0.00", left: "$50.00" });
  assert.deepEqual(me.roles.map((r: any) => r.key), ["member"]);   // whoami's own query works (it named an ambiguous column before)
  await client.close();
  const odd = await connect(email, CLAUDE, "https://claude.ai/api/mcp/auth_callback", { cap: "999999" });   // not one of the choices
  const grants = await db.selectFrom("oauth_grant").select("weekly_cap_cents").where("person_id", "=", id).orderBy("created_at", "desc").execute();
  assert.ok(odd.body.access_token);
  assert.deepEqual(grants.map((g) => g.weekly_cap_cents), [0, 5000]);
});

test("the members' address works too: each address names itself as the resource, and a token from either works at both", async () => {
  // A club with two addresses, as the installs make them: staff.<host> for the staff app (and sign-in), <host> for members.
  const STAFF = "https://staff.kestrel.example.test", MEMBERS = "https://kestrel.example.test";
  const app2 = makeApp({ db, mailer, publicUrl: STAFF, secureCookies: false, fetchMetadata: async () => null });
  const req2 = (path: string, init: RequestInit = {}) => app2.request(path.startsWith("http") ? path : `${STAFF}${path}`, init);
  const r = await req2(`${MEMBERS}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate")!, /resource_metadata="https:\/\/kestrel\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await (await req2(`${MEMBERS}/.well-known/oauth-protected-resource/mcp`)).json() as any;
  assert.equal(prm.resource, `${MEMBERS}/mcp`, "an assistant checks the resource matches the address it was given");
  assert.deepEqual(prm.authorization_servers, [STAFF]);
  assert.equal((await (await req2(`${STAFF}/.well-known/oauth-protected-resource/mcp`)).json() as any).resource, `${STAFF}/mcp`);
  const reg = await (await req2("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Two Doors", redirect_uris: ["http://localhost:9998/cb"], token_endpoint_auth_method: "none" }) })).json() as any;
  const { status, body } = await connect(OWNER, reg.client_id, "http://localhost:9998/cb", { askFor: `${MEMBERS}/mcp`, via: { req: req2, base: STAFF } });
  assert.equal(status, 200, JSON.stringify(body));
  for (const door of [MEMBERS, STAFF]) {
    const list = await req2(`${door}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${body.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(list.status, 200, door);
  }
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://localhost:9998/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://elsewhere.example.test/mcp" });
  assert.equal((await req2(`/oauth/authorize?${q}`)).status, 400, "another server's address isn't ours");
});

test("an assistant reads what the person reads, can't raise its own limit or change how they sign in, and its previews die with it", async () => {
  const email = "dee@example.test", id = uuidv7();
  await db.insertInto("person").values({ id, display_name: "Dee", email, locale: "en", created_via: "desk" }).execute();
  const member = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: member.id, location_id: null }).execute();
  const { body } = await connect(email, CLAUDE, "https://claude.ai/api/mcp/auth_callback", { cap: "2500" });
  const second = await connect(email, CLAUDE, "https://claude.ai/api/mcp/auth_callback", { cap: "2500" });
  assert.ok(second.body.access_token);
  const [mine, other] = (await db.selectFrom("oauth_grant").select("id").where("person_id", "=", id).orderBy("created_at").execute()).map((g) => g.id);
  const client = await mcp(body.access_token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const hidden of ["assistant_set_cap_preview", "privacy_erase_preview", "person_factor_remove_preview", "person_passkey_remove_preview"]) assert.ok(!names.includes(hidden), hidden);
  for (const shown of ["assistant_disconnect_preview", "booking_options", "free_courts", "open_programs", "my_places", "my_level", "club_answers", "lesson_times"]) assert.ok(names.includes(shown), shown);
  const options = textOf(await client.callTool({ name: "booking_options", arguments: {} }));
  assert.ok(Array.isArray(options.locations) && Array.isArray(options.lengths), "the same answer the app gets");
  const bad = await client.callTool({ name: "free_courts", arguments: { location_id: uuidv7(), date: "2026-13-40", minutes: 60 } });
  assert.equal(bad.isError, true, "a read the app would refuse is refused with its words");
  const oauth = { personId: id, via: "mcp:Claude", lang: "en" as const, auth: "oauth" as const, grantId: mine };
  const inApp = (e: unknown) => e instanceof KumiError && e.code === "error.assistant_in_app";
  await assert.rejects(plan(db, "assistant.set_cap", { grant_id: mine, weekly_cap_cents: 50000 }, oauth), inApp, "an agent can't raise its own limit");
  await assert.rejects(plan(db, "privacy.erase", { person_id: id }, oauth), inApp);
  await assert.rejects(plan(db, "assistant.disconnect", { grant_id: other }, oauth), inApp, "nor touch another assistant");
  const p = textOf(await client.callTool({ name: "question_ask_preview", arguments: { person_id: id, body: "Is there parking at the club?" } }));
  const person = { personId: id, via: "app", lang: "en" as const, auth: "email_code" as const };
  const d = await plan(db, "assistant.disconnect", { grant_id: mine }, person);
  await apply(db, d.runId, person);
  await assert.rejects(apply(db, p.run_id, person), (e: unknown) => e instanceof KumiError && e.code === "error.assistant_disconnected", "its preview died with it");
  await client.close();
});
