// Plugins (plugins.ts, plugin_manifest.ts) through the door: a manifest checked strictly, an install whose preview says
// in words everything it asks for (and loudly when it isn't from the catalog), its token going straight to the plugin in
// a registration signed with the club's key and never to whoever installed it or into the change log, a role capped to
// the manifest, settings checked against its schema, an update listing what's new, keys asked of the owner and read by
// the plugin alone, /plugins/<name>/hook passed on, pause, removal, the processors list and doctor. The plugin is a fake
// HTTP server on 127.0.0.1 (development allows the loopback).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, createPublicKey, verify as edVerify } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, checkManifestAtClub, messageHandlers, parseManifest, plan, processOutbox, run, runAsSystem, sendWebhooks, stageVaultUpload, verifyWebhookSignature, type Actor, type Db } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { doctor } from "../src/doctor.ts";
import { fetchRelease, servicePlan, writeService } from "../src/plugin_service.ts";
import { webhookPost } from "../src/webhooks.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { localPluginEnv } from "@kumi/core";

const BASE = "https://club.example.test", MCP = `${BASE}/mcp`, TZ = "America/Los_Angeles";
const ROOT = new URL("../../../", import.meta.url);
const EXAMPLE = JSON.parse(readFileSync(new URL("docs/plugins/examples/court-lights/openpadel-plugin.json", ROOT), "utf8"));
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, ownerCookie = "", server: Server, PLUGIN = "", courtId = "";
const got: { path: string; headers: Record<string, string>; body: string }[] = [];
let healthStatus = 200, release = Buffer.alloc(0);
const sha = (v: string) => createHash("sha256").update(v).digest("hex"), sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The example's manifest pointed at the fake plugin, with changes. */
const manifest = (over: Record<string, unknown> = {}) => ({ ...EXAMPLE, run: { mode: "remote", url: `${PLUGIN}/p` }, ...over });
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await app.request(MCP, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  if (r.status === 401) return { error: "signed_out" };
  const b = await r.json() as any;
  if (b.error) return { error: b.error.message };
  if (b.result.isError) return { error: b.result._meta?.["kumi/error"] ?? b.result.content[0].text };
  return JSON.parse(b.result.content[0].text);
}
const noTool = (r: any) => typeof r.error === "string" && /not found/.test(r.error);
const staff = async (path: string) => { const r = await app.request(`${BASE}${path}`, { headers: { cookie: ownerCookie } }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
const registrationOf = (name: string) => got.filter((g) => g.path === "/p/register").map((g) => JSON.parse(g.body)).filter((b) => b.plugin.name === name).at(-1);

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      got.push({ path: req.url ?? "", headers: req.headers as Record<string, string>, body });
      if (req.url === "/p/health") { res.writeHead(healthStatus); return res.end("ok"); }
      if (req.url === "/release.tgz") { res.writeHead(200); return res.end(release); }
      if (req.url === "/p/hook") { res.writeHead(202, { "content-type": "application/json" }); return res.end(JSON.stringify({ seen: body.length })); }
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  PLUGIN = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ({ db, drop } = await freshDb());
  const setup = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (setup.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Main", time_zone: TZ }, owner)).result as any).location_id;
  courtId = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner);
  const token = "owner-session";
  await db.insertInto("web_session").values({ token_hash: sha(token), person_id: owner.personId!, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  ownerCookie = `kumi_session=${token}`;
  // A catalog of the example, pointed at the fake plugin.
  const dir = mkdtempSync(join(tmpdir(), "plugin-catalog-"));
  writeFileSync(join(dir, "catalog.json"), JSON.stringify({ catalog: 1, plugins: [{ manifest: manifest({ $schema: undefined }) }] }));
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false, pluginCatalogUrl: join(dir, "catalog.json") });
});
after(async () => { await drop(); server.close(); });

test("a manifest is checked strictly: the example passes, the bundled catalog has it, and anything off is refused in words", async () => {
  const m = parseManifest(JSON.stringify(EXAMPLE));
  assert.equal(m.name, "court-lights");
  await checkManifestAtClub(db, m);
  const sample = JSON.parse(readFileSync(new URL("packages/core/src/plugin_catalog.sample.json", ROOT), "utf8"));
  const { $schema: _, ...bare } = EXAMPLE;
  assert.deepEqual(sample.plugins[0].manifest, bare, "the sample catalog's plugin is the documented example");
  const bad = (over: Record<string, unknown>, why: RegExp) => {
    assert.throws(() => parseManifest({ ...EXAMPLE, ...over }), (e: any) => e.code === "error.plugin_manifest" && why.test(e.text.en), JSON.stringify(over).slice(0, 80));
  };
  bad({ surprise: true }, /surprise|Unrecognized/i);
  bad({ name: "Court Lights" }, /name/);
  bad({ data_out: undefined }, /data_out/);
  bad({ description: { en: "Lights \u2014 on", es: "Luces" } }, /description/);
  bad({ run: { mode: "local", release_url: "https://x.example/r.tgz", sha256: "abc", entry: "bin/start" } }, /sha256/);
  bad({ run: { mode: "local", release_url: "https://x.example/r.tgz", sha256: "a".repeat(64), entry: "../etc/passwd" } }, /entry/);
  bad({ events: ["booking.created", "booking.created"] }, /twice/);
  bad({ settings: [{ key: "x", type: "integer", label: { en: "X", es: "X" }, minimum: 5, maximum: 1 }] }, /minimum/);
  bad({ secrets: [{ name: "lowercase", label: { en: "K", es: "K" }, where: { en: "W", es: "W" } }] }, /secrets/);
  // One line each: no field can start a new line in anything it's written into (a service's unit file, a header).
  bad({ publisher: "Evil\n[Service]\nExecStartPre=+/bin/sh -c id" }, /publisher.*one line/);
  bad({ description: { en: "Lights\ron", es: "Luces" } }, /description/);
  bad({ secrets: [{ name: "K_K", label: { en: "K\tK", es: "K" }, where: { en: "W", es: "W" } }] }, /secrets/);
  bad({ homepage: "https://example.com/\nx" }, /homepage/);
  bad({ data_out: { en: "Nothing\u0085", es: "Nada" } }, /data_out/);
  // Checked at the club: real actions a club's role may hold, never one no plugin gets, and events it can read.
  const atClub = async (over: Record<string, unknown>, why: RegExp) =>
    assert.rejects(checkManifestAtClub(db, parseManifest({ ...EXAMPLE, ...over })), (e: any) => e.code === "error.plugin_manifest" && why.test(e.text.en));
  await atClub({ grants: [{ action: "court.fly", mode: "allow" }] }, /isn't an openPadel action/);
  await atClub({ grants: [{ action: "agent.revoke", mode: "allow" }] }, /never a plugin's/);
  await atClub({ grants: [{ action: "waiver.accept", mode: "allow" }] }, /never a plugin's/);
  await atClub({ reads: [], events: ["payment.failed"] }, /needs reads of money/);
});

test("the install preview lists what the manifest asks in words, and says loudly when it isn't from the catalog", async () => {
  const p = await plan(db, "plugin.install", { name: "court-lights" }, owner);
  const s = p.plan.summary.en;
  for (const w of ["Install the plugin court-lights 0.1.0.", "From: openPadel's reviewed catalog", "It will be able to: change nothing at the club.", "It reads: bookings, courts and hours.",
    "It sends: Each booking's court, start and end go to the club's own Home Assistant.", "Needs: Home Assistant access token (HA_TOKEN).", "Cost: its service doesn't charge.",
    "never to you or your agent"]) assert.ok(s.includes(w), `missing "${w}" in: ${s}`);
  assert.ok(p.plan.summary.es.includes("Envía: La cancha, el inicio y el fin de cada reserva"), p.plan.summary.es);
  assert.ok(!s.includes("NOT"), "from the catalog, nothing loud");
  assert.ok(p.plan.rows!.some((r) => r.label.en === "Settings" && /Home Assistant address, Courts with lights/.test(r.text.en)), "required settings still to give");
  const u = await plan(db, "plugin.install", { manifest: JSON.stringify(manifest({ name: "lights-fork" })) }, owner);
  assert.match(u.plan.summary.en, /^Install the plugin lights-fork 0\.1\.0, which is NOT from openPadel's reviewed catalog\. NOT REVIEWED: .*nobody at openPadel has looked at it/);
  assert.match(u.plan.summary.es, /NO es del catálogo revisado de openPadel\. SIN REVISAR:/);
  await assert.rejects(plan(db, "plugin.install", { name: "court-lights", manifest: "{}" }, owner), (e: any) => e.code === "error.plugin_source");
  await assert.rejects(plan(db, "plugin.install", { name: "no-such" }, owner), (e: any) => e.code === "error.plugin_not_in_catalog");
});

let token = "", agentId = "", hookSecret = "";
test("installing: the token goes straight to the plugin, signed by the club, and never to the installer or the change log", async () => {
  const r = await run(db, "plugin.install", { name: "court-lights", settings: { home_assistant_url: "https://ha.kestrel.test", courts: "Court 1" } }, owner);
  const res = r.result as any;
  assert.equal(res.name, "court-lights");
  assert.equal(res.registered, true, JSON.stringify(res));
  assert.equal(res.status, "on");
  assert.deepEqual(res.keys_needed, ["HA_TOKEN"]);
  assert.ok(!JSON.stringify(res).includes("opa_"), "no token in what the installer gets");
  const reg = registrationOf("court-lights"), raw = got.filter((g) => g.path === "/p/register").at(-1)!;
  token = reg.door.token; hookSecret = reg.hooks.secret;
  assert.match(token, /^opa_[A-Za-z0-9_-]{43}$/);
  assert.equal(reg.door.mcp, MCP);
  assert.deepEqual(reg.settings, { home_assistant_url: "https://ha.kestrel.test", courts: [courtId], minutes_before: 10 });
  // Signed with the club's key, published at its own address.
  const key = (await (await app.request(`${BASE}/.well-known/openpadel-plugin-key`)).json() as any).keys[0];
  const [, t, sig] = /^t=(\d+),ed25519=([A-Za-z0-9_-]+)$/.exec(raw.headers["openpadel-signature-ed25519"] ?? "")!.map(String) as [string, string, string];
  assert.ok(edVerify(null, Buffer.from(`${t}.${raw.body}`), createPublicKey({ key, format: "jwk" }), Buffer.from(sig, "base64url")), "the registration's signature checks");
  assert.ok(!edVerify(null, Buffer.from(`${t}.${raw.body} `), createPublicKey({ key, format: "jwk" }), Buffer.from(sig, "base64url")));
  // Nowhere in the change log, the run, or the plugin's row once delivered.
  const runs = await db.selectFrom("action_run").select(["input", "plan", "result"]).execute();
  const log = await db.selectFrom("entity_change").select(["before", "after"]).execute();
  assert.ok(!JSON.stringify(runs).includes(token) && !JSON.stringify(log).includes(token), "the token is in no run or change");
  assert.ok(!JSON.stringify(log).includes(hookSecret), "nor the hook secret");
  const row = await db.selectFrom("plugin").selectAll().where("name", "=", "court-lights").executeTakeFirstOrThrow();
  assert.equal(row.registration_sealed, null, "cleared once it arrived");
  agentId = row.agent_id!;
  assert.equal((await db.selectFrom("oauth_token").innerJoin("agent", "agent.grant_id", "oauth_token.grant_id").select("token_hash").where("agent.id", "=", agentId).executeTakeFirstOrThrow()).token_hash, sha(token));
  // It works at the door as the plugin's agent, which reads its own settings and nothing past its manifest.
  const who = await call(token, "whoami");
  assert.equal(who.agent.name, "court-lights (plugin)");
  const mine = await call(token, "plugin_settings");
  assert.deepEqual(mine.keys, [{ name: "HA_TOKEN", added: false, last4: null }]);
  assert.equal((await call(token, "courts")).error, undefined, "courts it reads");
  assert.ok(typeof (await call(token, "people")).error === "string", "the members' area isn't its");
  assert.ok(noTool(await call(token, "webhook_subscribe_preview", { url: "https://x.example/in", topics: ["booking.created"] })), "no webhooks of its own");
  assert.ok(noTool(await call(token, "plugin_install_preview", { name: "x" })), "never installs plugins");
  assert.ok(noTool(await call(token, "tag_create_preview", { name: "x" })), "no actions it didn't ask for");
  // Installed twice: no.
  await assert.rejects(plan(db, "plugin.install", { name: "court-lights" }, owner), (e: any) => e.code === "error.plugin_installed");
});

test("its role is the manifest's, outright or asking, and changes only with the plugin", async () => {
  const m = manifest({ name: "tagger", grants: [{ action: "tag.create", mode: "allow" }, { action: "tag.update", mode: "ask" }], reads: [], events: ["person.created"], secrets: [], settings: [] });
  await run(db, "plugin.install", { manifest: JSON.stringify(m) }, owner);
  const t = registrationOf("tagger").door.token;
  const p = await call(t, "tag_create_preview", { name: "Lights crew" });
  assert.equal(p.status, "planned", JSON.stringify(p));
  assert.equal((await call(t, "tag_create_confirm", { run_id: p.run_id })).done, true);
  const tag = ((await run(db, "tag.create", { name: "Juniors" }, owner)).result as any).tag_id;
  assert.equal((await call(t, "tag_update_preview", { tag_id: tag, name: "Juniors 2027" })).status, "awaiting_approval");
  const pl = await db.selectFrom("plugin").innerJoin("role", "role.id", "plugin.role_id").select(["role.key", "role.for_plugin", "plugin.agent_id", "plugin.subscription_id"]).where("plugin.name", "=", "tagger").executeTakeFirstOrThrow();
  assert.equal(pl.for_plugin, true);
  const grants = await db.selectFrom("role_grant").innerJoin("role", "role.id", "role_grant.role_id").select(["pattern", "mode"]).where("role.key", "=", pl.key).where("role_grant.active", "=", true).orderBy("pattern").execute();
  assert.deepEqual(grants, [{ pattern: "tag.create", mode: "allow" }, { pattern: "tag.update", mode: "ask" }]);
  // Nobody else gets its role; its agent, role and webhook change only through the plugin.
  const someone = ((await run(db, "person.create", { display_name: "Sam Desk", email: "sam@example.test" }, owner)).result as any).person_id;
  await assert.rejects(plan(db, "role.assign", { person_id: someone, role: pl.key }, owner), (e: any) => e.code === "error.not_found");
  await assert.rejects(plan(db, "role.update", { role: pl.key, grants: [] }, owner), (e: any) => e.code === "error.role_plugins");
  await assert.rejects(plan(db, "agent.revoke", { agent_id: pl.agent_id }, owner), (e: any) => e.code === "error.agent_is_plugin");
  await assert.rejects(plan(db, "webhook.update", { subscription_id: pl.subscription_id, url: "https://elsewhere.example/in" }, owner), (e: any) => e.code === "error.webhook_is_plugins");
  // A manager asks to install; the owner says yes.
  const mgr = ((await run(db, "person.create", { display_name: "Mo Manager", email: "mo@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: mgr, role: "manager" }, owner);
  const asked = await plan(db, "plugin.install", { manifest: JSON.stringify(manifest({ name: "asked-for", secrets: [], settings: [] })) }, { personId: mgr, via: "test", lang: "en" });
  assert.equal(asked.status, "awaiting_approval");
});

test("settings are checked against the manifest's schema, previewed, and sent to the plugin signed", async () => {
  const no = async (settings: Record<string, unknown>, why: RegExp) => assert.rejects(plan(db, "plugin.configure", { plugin: "court-lights", settings }, owner), (e: any) => e.code === "error.plugin_settings" && why.test(e.text.en));
  await no({ colour: "red" }, /no setting called colour/);
  await no({ minutes_before: 45 }, /Minutes before a booking isn't right/);
  await no({ courts: "Court 9" }, /Courts with lights: one of those isn't a court here/);
  await assert.rejects(plan(db, "plugin.configure", { plugin: "court-lights", settings: { courts: [courtId] } }, owner), (e: any) => e.code === "error.nothing_changed");
  const p = await plan(db, "plugin.configure", { plugin: "court-lights", settings: { courts: "Court 1, Court 2", minutes_before: "15" } }, owner);
  assert.match(p.plan.summary.en, /Set up court-lights: Home Assistant address: https:\/\/ha\.kestrel\.test; Courts with lights: Court 1, Court 2; Minutes before a booking: 15\./);
  await apply(db, p.runId, owner);
  const delivered: { url: string; body: string; headers: Record<string, string> }[] = [];
  await sendWebhooks(db, async (url, body, headers) => { delivered.push({ url, body, headers }); return 200; });
  const cfg = delivered.find((d) => d.headers["openpadel-event"] === "plugin.configured")!;
  assert.equal(cfg.url, `${PLUGIN}/p/events`);
  assert.ok(verifyWebhookSignature(registrationOf("court-lights").webhooks.secret, cfg.headers["openpadel-signature"]!, cfg.body), "signed with its webhook secret");
  assert.equal(JSON.parse(cfg.body).data.settings.minutes_before, 15);
});

test("keys: the owner hears what's needed, adds it in the vault, and only the plugin reads it, by its declared name", async () => {
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["person_id", "subject", "body", "link"]).where("kind", "=", "plugin_secrets_owner").execute();
  assert.ok(told.some((m) => m.person_id === owner.personId && /court-lights needs keys/.test(m.subject) && /HA_TOKEN/.test(m.body) && m.link === "/vault"), JSON.stringify(told));
  const vault = await staff("/staff/vault");
  assert.equal(vault.status, 200);
  const ask = vault.json.requests.find((r: any) => r.plugin === "court-lights");
  assert.deepEqual(ask.keys.map((k: any) => [k.name, k.vault_name]), [["HA_TOKEN", "court-lights/HA_TOKEN"]]);
  assert.match(ask.keys[0].where, /Long-lived access tokens/);
  const up = await stageVaultUpload(db, owner.personId!, { kind: "secret", value: "ha-secret-value-4F2A" });
  await run(db, "vault.add", { name: "court-lights/HA_TOKEN", upload_id: up.upload_id }, { ...owner, auth: "passkey" });
  // The club's own key of the same name isn't the plugin's.
  const club = await stageVaultUpload(db, owner.personId!, { kind: "secret", value: "club-own-value-9999" });
  await run(db, "vault.add", { name: "HA_TOKEN", upload_id: club.upload_id }, { ...owner, auth: "passkey" });
  assert.deepEqual((await call(token, "plugin_settings")).keys, [{ name: "HA_TOKEN", added: true, last4: "4F2A" }]);
  const k = await call(token, "plugin_secret", { name: "HA_TOKEN" });
  assert.equal(k.value, "ha-secret-value-4F2A");
  assert.equal((await call(token, "plugin_secret", { name: "STRIPE_SECRET_KEY" })).error, "error.plugin_secret_undeclared");
  assert.equal((await call(registrationOf("tagger").door.token, "plugin_secret", { name: "HA_TOKEN" })).error, "error.plugin_secret_undeclared");
  assert.ok((await db.selectFrom("vault_access").select("id").execute()).length >= 1, "each read is kept");
  // What the installer sees: added, and its last four.
  const list = await staff("/staff/plugins");
  const cl = list.json.find((p: any) => p.name === "court-lights");
  assert.deepEqual(cl.keys.map((k: any) => [k.name, k.added, k.last4]), [["HA_TOKEN", true, "4F2A"]]);
  assert.ok(!JSON.stringify(list.json).includes("ha-secret-value"));
  assert.equal(cl.health.state, "ok");
  assert.ok(!(await staff("/staff/vault")).json.requests.some((r: any) => r.plugin === "court-lights"), "asked no more");
});

const NEXT = () => manifest({ version: "0.2.0", grants: [{ action: "court.block", mode: "ask" }], reads: ["bookings", "courts", "money"], events: [...EXAMPLE.events, "payment.failed"],
    secrets: [...EXAMPLE.secrets, { name: "HA_WEBHOOK_ID", label: { en: "Home Assistant webhook id", es: "Id del webhook de Home Assistant" }, where: { en: "In Home Assistant, Automations.", es: "En Home Assistant, Automatizaciones." } }] });
test("an update lists what the new version asks for that the old one didn't", async () => {
  const next = NEXT();
  const p = await plan(db, "plugin.update", { plugin: "court-lights", manifest: JSON.stringify(next) }, owner);
  const s = p.plan.summary.en;
  for (const w of ["Update court-lights from 0.1.0 to 0.2.0.", "NOT REVIEWED", "Now it will also be able to: block courts (asks a person first).", "Now it also reads: money.",
    "Now it's also told when: payment.failed.", "It also needs: Home Assistant webhook id (HA_WEBHOOK_ID)."]) assert.ok(s.toLowerCase().includes(w.toLowerCase()), `missing "${w}" in: ${s}`);
  await assert.rejects(plan(db, "plugin.update", { plugin: "court-lights", manifest: JSON.stringify(manifest({ name: "other" })) }, owner), (e: any) => e.code === "error.plugin_other_name");
  await run(db, "plugin.update", { plugin: "court-lights", manifest: JSON.stringify(next) }, owner);
  const pl = await db.selectFrom("plugin").selectAll().where("name", "=", "court-lights").where("status", "!=", "removed").executeTakeFirstOrThrow();
  assert.equal(pl.release, "0.2.0");
  const sub = await db.selectFrom("webhook_subscription").select("topics").where("id", "=", pl.subscription_id!).executeTakeFirstOrThrow();
  assert.ok(sub.topics.includes("payment.failed"));
  assert.ok(await db.selectFrom("role_grant").select("id").where("role_id", "=", pl.role_id!).where("pattern", "=", "court.block").where("mode", "=", "ask").where("active", "=", true).executeTakeFirst());
  assert.equal(((await db.selectFrom("event_outbox").select("payload").where("topic", "=", "plugin.secrets_needed").orderBy("id", "desc").executeTakeFirstOrThrow()).payload as { names: string[] }).names[0], "HA_WEBHOOK_ID");
});

test("/plugins/<name>/hook is passed on to the plugin, signed with its own secret, without the club's cookies", async () => {
  // Declaring a hook comes with the manifest.
  assert.equal((await app.request(`${BASE}/plugins/court-lights/hook`, { method: "POST", body: "{}" })).status, 404, "court-lights declares none");
  await run(db, "plugin.update", { plugin: "court-lights", manifest: JSON.stringify({ ...NEXT(), version: "0.3.0", hook: { from: { en: "Home Assistant", es: "Home Assistant" } } }) }, owner);
  const body = JSON.stringify({ event: "lights_on", court: "Court 1" });
  const r = await app.request(`${BASE}/plugins/court-lights/hook`, { method: "POST", body, headers: { "content-type": "application/json", cookie: ownerCookie, "x-vendor-signature": "abc" } });
  assert.equal(r.status, 202);
  assert.equal(r.headers.get("content-type"), "application/json");
  assert.deepEqual(await r.json(), { seen: body.length });
  const h = got.filter((g) => g.path === "/p/hook").at(-1)!;
  assert.equal(h.body, body);
  assert.equal(h.headers.cookie, undefined, "the club's cookies stay here");
  assert.equal(h.headers["x-vendor-signature"], "abc", "the sender's own headers go on");
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h.headers["openpadel-signature"]!)!;
  assert.equal(v1, createHmac("sha256", hookSecret).update(`${t}.${body}`).digest("hex"));
  assert.equal((await app.request(`${BASE}/plugins/court-lights/hook`, { method: "POST", body: "x".repeat(1_000_001) })).status, 413);
  assert.equal((await app.request(`${BASE}/plugins/nobody-here/hook`, { method: "POST", body: "{}" })).status, 404);
});

test("pausing stops its token, events and hooks until it's turned back on", async () => {
  await run(db, "plugin.pause", { plugin: "court-lights" }, owner);
  assert.equal((await call(token, "whoami")).error, "signed_out");
  assert.equal((await app.request(`${BASE}/plugins/court-lights/hook`, { method: "POST", body: "{}" })).status, 404);
  const checks = await doctor(db, { NODE_ENV: "development" });
  assert.equal(checks.find((c) => c.id === "plugin:court-lights")?.state, "off");
  await run(db, "plugin.resume", { plugin: "court-lights" }, owner);
  assert.equal((await call(token, "whoami")).agent.name, "court-lights (plugin)");
});

test("doctor checks each plugin's health, and keys still needed", async () => {
  healthStatus = 503;
  let c = (await doctor(db, { NODE_ENV: "development" })).find((x) => x.id === "plugin:court-lights")!;
  assert.equal(c.state, "warn", "HA_WEBHOOK_ID is still needed");
  assert.match(c.text.en, /HA_WEBHOOK_ID/);
  const up = await stageVaultUpload(db, owner.personId!, { kind: "secret", value: "webhook-id-0000-ABCD" });
  await run(db, "vault.add", { name: "court-lights/HA_WEBHOOK_ID", upload_id: up.upload_id }, { ...owner, auth: "passkey" });
  c = (await doctor(db, { NODE_ENV: "development" })).find((x) => x.id === "plugin:court-lights")!;
  assert.equal(c.state, "fail");
  assert.match(c.text.en, /HTTP 503/);
  healthStatus = 200;
  c = (await doctor(db, { NODE_ENV: "development" })).find((x) => x.id === "plugin:court-lights")!;
  assert.equal(c.state, "ok", c.text.en);
});

test("the processors list and the privacy policy's rows take each installed plugin's data out", async () => {
  const r = await staff("/staff/processors");
  assert.equal(r.status, 200);
  const row = r.json.rows.find((x: any) => x.plugin === "court-lights");
  assert.equal(row.service, "openPadel examples (the plugin court-lights)");
  assert.match(row.gets, /Home Assistant/);
  assert.ok(r.json.rows.some((x: any) => x.service === "Stripe"));
  assert.match(r.json.markdown, /^\| Company \| What for \| What it gets \|\n\|---\|---\|---\|\n/);
  assert.match(r.json.markdown, /\| openPadel examples \(the plugin court-lights\) \|/);
  const es = await app.request(`${BASE}/staff/processors`, { headers: { cookie: ownerCookie, "accept-language": "es" } });
  assert.ok(es.status === 200);
  // Through the door too, for the owner's agent.
  const cat = await staff("/staff/plugins/catalog?q=lights");
  assert.deepEqual(cat.json.plugins.map((p: any) => [p.name, p.installed]), [["court-lights", true]]);
  // Its agent and webhook are listed with the plugin, not among the club's own agents and webhooks.
  const agents = await staff("/staff/agents");
  assert.ok(!agents.json.agents.some((a: any) => /\(plugin\)$/.test(a.name)) && !agents.json.webhooks.some((h: any) => h.url.startsWith(PLUGIN)), "plugins are listed as plugins");
  const info = await staff("/staff/plugins/catalog/court-lights");
  assert.equal(info.json.keys[0].name, "HA_TOKEN");
  assert.ok(info.json.words.some((w: any) => w.label === "It sends"));
});

test("removing revokes its token, ends its webhook and role, and deletes its keys only when asked", async () => {
  const p = await plan(db, "plugin.remove", { plugin: "court-lights" }, owner);
  assert.match(p.plan.summary.en, /Its keys stay in the vault \(court-lights\/HA_TOKEN, court-lights\/HA_WEBHOOK_ID\)/);
  await apply(db, p.runId, owner);
  assert.equal((await call(token, "whoami")).error, "signed_out");
  const pl = await db.selectFrom("plugin").select(["status", "subscription_id", "role_id", "agent_id"]).where("name", "=", "court-lights").orderBy("installed_at", "desc").executeTakeFirstOrThrow();
  assert.equal(pl.status, "removed");
  assert.equal((await db.selectFrom("webhook_subscription").select("active").where("id", "=", pl.subscription_id!).executeTakeFirstOrThrow()).active, false);
  assert.equal((await db.selectFrom("role").select("active").where("id", "=", pl.role_id!).executeTakeFirstOrThrow()).active, false);
  assert.ok((await db.selectFrom("agent").select("revoked_at").where("id", "=", pl.agent_id!).executeTakeFirstOrThrow()).revoked_at);
  assert.equal((await db.selectFrom("vault_item").select("id").where("name", "=", "court-lights/HA_TOKEN").where("active", "=", true).execute()).length, 1, "kept");
  // Another one, removed with its keys.
  const t = await plan(db, "plugin.remove", { plugin: "tagger", delete_keys: true }, owner);
  assert.doesNotMatch(t.plan.summary.en, /keys/, "it had none");
  await apply(db, t.runId, owner);
  // Installed again, and removed with its keys.
  await run(db, "plugin.install", { name: "court-lights" }, owner);
  const again = await plan(db, "plugin.remove", { plugin: "court-lights", delete_keys: true }, owner);
  assert.match(again.plan.summary.en, /Its keys are deleted from the vault too: court-lights\/HA_TOKEN, court-lights\/HA_WEBHOOK_ID/);
  await apply(db, again.runId, owner);
  assert.equal((await db.selectFrom("vault_item").select("id").where("name", "like", "court-lights/%").where("active", "=", true).execute()).length, 0);
  assert.equal((await db.selectFrom("vault_item").select("id").where("name", "=", "HA_TOKEN").where("active", "=", true).execute()).length, 1, "the club's own key stays");
});

test("a local plugin: no registration POST; its release is checked against its SHA-256, and its token goes only into its service's environment", async () => {
  const src = mkdtempSync(join(tmpdir(), "plugin-release-"));
  mkdirSync(join(src, "bin"));
  writeFileSync(join(src, "bin", "start"), "#!/bin/sh\necho lights\n", { mode: 0o755 });
  execFileSync("tar", ["-czf", join(src, "r.tgz"), "-C", src, "bin"]);
  release = readFileSync(join(src, "r.tgz"));
  const m = { ...EXAMPLE, name: "lights-local", run: { mode: "local", release_url: `${PLUGIN}/release.tgz`, sha256: sha256(release), entry: "bin/start" } };
  const p = await plan(db, "plugin.install", { manifest: JSON.stringify(m) }, owner);
  assert.match(p.plan.summary.en, /It runs: on the club's own server as its own service, from 127\.0\.0\.1:\d+ \(checked against its fingerprint [0-9a-f]{12}\)/);
  assert.match(p.plan.summary.en, /written into its service's settings on the server by `openpadel plugin service lights-local`/);
  const before = got.length;
  const r = (await apply(db, p.runId, owner)) as any;
  assert.equal(r.status, "waiting");
  assert.equal(got.length, before, "nothing is POSTed to a local plugin");
  const row = await db.selectFrom("plugin").selectAll().where("name", "=", "lights-local").where("status", "!=", "removed").executeTakeFirstOrThrow();
  assert.ok(row.local_port! >= 47100);
  assert.equal((await db.selectFrom("webhook_subscription").select("url").where("id", "=", row.subscription_id!).executeTakeFirstOrThrow()).url, `http://127.0.0.1:${row.local_port}/events`);
  // The release, checked; a different one refused.
  assert.ok((await fetchRelease(m as any, false)).equals(release));
  await assert.rejects(fetchRelease({ ...m, run: { ...m.run, sha256: "0".repeat(64) } } as any, false), /not installed/);
  // What `openpadel plugin service` writes, into a scratch place here: the unpacked release, its environment (root's alone) and its unit.
  const root = mkdtempSync(join(tmpdir(), "plugin-service-"));
  const sp = servicePlan(m as any, row.local_port!, false, { root: join(root, "opt"), envDir: join(root, "env"), unitDir: root });
  assert.match(sp.unit, /DynamicUser=yes/);
  assert.match(sp.unit, /InaccessiblePaths=.*-\/var\/lib\/caddy .*-\/run\/caddy/);
  // Even a manifest that never went through the checks can't add a line to the unit: only its name and version go in.
  const hostile = { ...m, publisher: "x\n[Service]\nExecStartPre=+/bin/sh -c id", name: "evil\nExecStartPre=+/bin/sh", version: "1\nUser=root" };
  const u = servicePlan(hostile as any, 47999, true, { root: "/opt/p", envDir: "/etc/p", unitDir: "/tmp" });
  const lines = u.unit.split("\n");
  assert.ok(!lines.some((l) => /^(ExecStartPre|User)\b/.test(l)), u.unit);
  assert.equal(lines.filter((l) => l === "[Service]").length, 1);
  assert.equal(lines.filter((l) => l.startsWith("ExecStart")).length, 1);
  assert.ok(!u.compose!.split("\n").some((l) => /^\s*(ExecStartPre|User)\b/.test(l)));
  assert.match(sp.unit, /InaccessiblePaths=.*\/etc\/kumi/);
  assert.match(sp.unit, /IPAddressDeny=10\.0\.0\.0\/8 .*169\.254\.0\.0\/16/);
  const env = await localPluginEnv(db, "lights-local");
  writeService(sp, release, "bin/start", env);
  assert.equal(statSync(sp.envFile).mode & 0o777, 0o600);
  assert.match(readFileSync(sp.envFile, "utf8"), new RegExp(`^OPENPADEL_TOKEN=${env.OPENPADEL_TOKEN}$`, "m"));
  assert.equal(readFileSync(join(sp.dir, "bin", "start"), "utf8"), "#!/bin/sh\necho lights\n");
  assert.equal((await call(env.OPENPADEL_TOKEN!, "whoami")).agent.name, "lights-local (plugin)");
  assert.equal((await db.selectFrom("plugin").select(["status", "registration_sealed"]).where("id", "=", row.id).executeTakeFirstOrThrow()).registration_sealed, null);
  // In production, events reach the loopback only at a local plugin's own port (main.ts gives webhookPost that rule).
  const port = new URL(PLUGIN).port;
  await assert.rejects(webhookPost(true)(`${PLUGIN}/p/events`, "{}", {}), /https only/);
  await assert.rejects(webhookPost(true, async (u) => u.port === "1")(`${PLUGIN}/p/events`, "{}", {}), /https only/);
  assert.equal(await webhookPost(true, async (u) => u.port === port)(`${PLUGIN}/p/events`, "{}", { "content-type": "application/json" }), 200);
  // Asked again, it's a new token, and the old one stops.
  const again = await localPluginEnv(db, "lights-local");
  assert.notEqual(again.OPENPADEL_TOKEN, env.OPENPADEL_TOKEN);
  assert.equal((await call(env.OPENPADEL_TOKEN!, "whoami")).error, "signed_out");
  assert.ok(!JSON.stringify(await db.selectFrom("entity_change").select("after").execute()).includes(again.OPENPADEL_TOKEN!));
});

