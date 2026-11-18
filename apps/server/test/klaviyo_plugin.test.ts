// The club's side of the Klaviyo plugin, and the plugin itself against the real club: the club-news list (club_news) is
// filtered on the server for whoever reads it (only members whose latest answer to club news by email is yes, adults,
// not deleted; each one's id, email, first name and language and nothing else), staff read it in the app and, through
// the door, with emails shortened, a coach and a plugin that doesn't declare it can't, and only a plugin whose manifest
// reads club_news gets the emails whole. Saying yes or no, an unsubscribe link, STOP and a deleted account each tell
// the plugin (club_news.joined / club_news.left), and the plugin (plugins/klaviyo) installed at the club keeps a fake
// Klaviyo's list to match.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { checkManifestAtClub, clubNewsList, fanOutWebhooks, manifestRows, parseManifest, run, runAsSystem, sendWebhooks, stageVaultUpload, uuidv7, unsubscribe, type Actor, type Db } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { plugin, type Plugin } from "../../../plugins/klaviyo/src/server.ts";
import { memoryStore } from "../../../plugins/klaviyo/src/store.ts";
import { fakeKlaviyo } from "../../../plugins/klaviyo/test/fakes.ts";

const BASE = "https://club.example.test", MCP = `${BASE}/mcp`, CLIENT = "test-client", TZ = "America/Los_Angeles", LIST = "Xy12Ab";
const EXAMPLE = JSON.parse(readFileSync(new URL("../../../docs/plugins/examples/klaviyo/openpadel-plugin.json", import.meta.url), "utf8"));
const LIGHTS = JSON.parse(readFileSync(new URL("../../../docs/plugins/examples/court-lights/openpadel-plugin.json", import.meta.url), "utf8"));
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
let kl: Awaited<ReturnType<typeof fakeKlaviyo>>, p: Plugin, server: Server, clock = Date.now();
let lightsToken = "";
const who: Record<string, string> = {}, cookies: Record<string, string> = {}, logs: string[] = [];
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const as = (id: string): Actor => ({ personId: id, via: "test", lang: "en", auth: "passkey" });

async function tokenFor(personId: string) {
  const grant = uuidv7(), access = randomBytes(24).toString("hex");
  await db.insertInto("oauth_grant").values({ id: grant, person_id: personId, client_id: CLIENT, scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0 }).execute();
  await db.insertInto("oauth_token").values({ token_hash: sha(access), kind: "access", grant_id: grant, family: grant, resource: MCP, expires_at: new Date(Date.now() + 3600_000), used_at: null, revoked_at: null }).execute();
  return access;
}
async function call(tok: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await app.request(MCP, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  if (r.status === 401) return { error: "signed_out" };
  const b = await r.json() as any;
  if (b.error) return { error: b.error.message };
  if (b.result.isError) return { error: b.result._meta?.["kumi/error"] ?? b.result.content[0].text };
  return JSON.parse(b.result.content[0].text);
}
async function session(name: string, id: string) {
  const tok = `${name}-session-${randomBytes(4).toString("hex")}`;
  await db.insertInto("web_session").values({ token_hash: sha(tok), person_id: id, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  cookies[name] = `kumi_session=${tok}`;
}
const get = async (name: string, path: string) => { const r = await app.request(`${BASE}${path}`, { headers: { cookie: cookies[name]!, "accept-language": "en" } }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
async function person(name: string, email: string, news: boolean | null, extra: Record<string, unknown> = {}) {
  who[name] = ((await run(db, "person.create", { display_name: name, email, ...extra }, owner)).result as any).person_id;
  if (news !== null) await run(db, "consent.club_news", { person_id: who[name], granted: news }, as(who[name]!));
  return who[name]!;
}
const topics = async () => (await db.selectFrom("event_outbox").select(["topic", "payload"]).where("topic", "like", "club_news.%").orderBy("id").execute()).map((e) => [e.topic, (e.payload as any).person_id, (e.payload as any).why ?? null]);
/** The club's webhooks, sent: to the plugin's address over the loopback. */
async function deliver() {
  await fanOutWebhooks(db);
  const sent: number[] = [];
  await sendWebhooks(db, async (to, body, headers) => { const res = await fetch(to, { method: "POST", body, headers }); sent.push(res.status); return res.status; }, new Date(Date.now() + 1000));
  for (const r of p.runners.values()) await r.idle();
  return sent;
}

before(async () => {
  kl = await fakeKlaviyo();
  kl.state.lists.set(LIST, { name: "Club news", members: new Set() });
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  await db.insertInto("oauth_client").values({ client_id: CLIENT, kind: "registered", name: "An assistant", redirect_uris: ["https://a.example.test/cb"], auth_method: "none", secret_hash: null, metadata: null }).execute();
  await person("Ann Lee", "ann@example.test", true, { locale: "es" });
  await person("Bo Diaz", "bo@example.test", false);
  await person("Cy Park", "cy@example.test", null);
  await person("Dee Ray", "dee@example.test", true);
  await run(db, "consent.club_news", { person_id: who["Dee Ray"]!, granted: false }, as(who["Dee Ray"]!));   // yes, then no
  await person("Eve Moss", "eve@example.test", true);
  await run(db, "role.assign", { person_id: who["Cy Park"]!, role: "coach" }, owner);
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
  await session("Robin", owner.personId!);
  await session("Cy", who["Cy Park"]!);
  const viaApp = (async (url: string | URL | Request, init?: RequestInit) => { const u = String(url); return u.startsWith(BASE) ? app.request(u, init) : fetch(url, init); }) as typeof fetch;
  p = plugin({ store: memoryStore(), log: (level, msg, f = {}) => { logs.push(JSON.stringify({ level, msg, ...f })); }, fetch: viaApp, timers: false, now: () => clock, klaviyoUrl: kl.url, sleep: async () => {} });
  server = await p.listen(0, "127.0.0.1");
});
after(async () => { p.stop(); server.close(); kl.close(); await drop(); });

test("the manifest: the sample catalog has it, it checks at the club, and its preview says what it reads and sends", async () => {
  const m = parseManifest(JSON.stringify(EXAMPLE));
  await checkManifestAtClub(db, m);
  const sample = JSON.parse(readFileSync(new URL("../../../packages/core/src/plugin_catalog.sample.json", import.meta.url), "utf8"));
  const { $schema: _, ...bare } = EXAMPLE;
  assert.deepEqual(sample.plugins.find((x: any) => x.manifest.name === "klaviyo").manifest, bare, "the sample catalog has the documented example");
  const rows = manifestRows(m).map((r) => `${r.label.en}: ${r.text.en}`);
  assert.ok(rows.includes("It reads: the club news list (members who said yes to club news by email: their email, first name and language)"), rows.join("\n"));
  assert.ok(manifestRows(m).some((r) => r.text.es.startsWith("la lista de novedades del club")));
  // Its events need the list: a manifest asking for them without it doesn't check.
  await assert.rejects(checkManifestAtClub(db, parseManifest(JSON.stringify({ ...EXAMPLE, reads: ["members"] }))), (e: any) => /club_news\.joined needs reads of club_news/.test(e.text.en));
});

test("the club-news list is filtered on the server: only who said yes, with id, email, first name and language", async () => {
  const l = await clubNewsList(db);
  assert.equal(l.total, 2);
  assert.deepEqual(l.members.map((m) => [m.email, m.first_name, m.language]).sort(), [["ann@example.test", "Ann", "es"], ["eve@example.test", "Eve", "en"]]);
  assert.deepEqual(Object.keys(l.members[0]!).sort(), ["email", "first_name", "id", "language"], "nothing else");
  const first = await clubNewsList(db, { limit: 1 });
  assert.equal(first.members.length, 1);
  const second = await clubNewsList(db, { after: first.next, limit: 1 });
  assert.deepEqual([...first.members, ...second.members].map((m) => m.id), l.members.map((m) => m.id));
  assert.equal(second.next, null);

  // In the staff app the owner reads it whole; a coach doesn't read it at all.
  const mine = await get("Robin", "/staff/club-news/list");
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.members.map((m: any) => m.email).sort(), ["ann@example.test", "eve@example.test"]);
  assert.equal((await get("Cy", "/staff/club-news/list")).status, 403);
  // Through the door, a person's assistant gets the same rows with the emails shortened, like every staff read.
  const door = await call(await tokenFor(owner.personId!), "club_news_list");
  assert.deepEqual(door.members.map((m: any) => m.email).sort(), ["a...@example.test", "e...@example.test"]);
  assert.equal((await call(await tokenFor(who["Cy Park"]!), "club_news_list")).error, "error.staff_only", "a coach through the door");
});

test("each answer turning yes or no tells the plugin: the app, an email's link, STOP, a deleted account", async () => {
  const before = (await topics()).length;
  await run(db, "consent.club_news", { person_id: who["Bo Diaz"]!, granted: true }, as(who["Bo Diaz"]!));
  const bo = await db.selectFrom("person").select("news_token").where("id", "=", who["Bo Diaz"]!).executeTakeFirstOrThrow();
  await unsubscribe(db, bo.news_token!, "one_click");
  await run(db, "privacy.erase", { person_id: who["Eve Moss"]! }, owner);
  const fay = await person("Fay Lin", "fay@example.test", true);
  await db.insertInto("auth_identity").values({ id: uuidv7(), person_id: fay, kind: "phone", value: "+14155550142", verified_at: new Date() }).execute();
  await runAsSystem(db, "text.stop", { phone: "+14155550142", said: "STOP" }, "twilio");
  assert.deepEqual((await topics()).slice(before), [["club_news.joined", who["Bo Diaz"], null], ["club_news.left", who["Bo Diaz"], "unsubscribed"], ["club_news.left", who["Eve Moss"], "deleted"],
    ["club_news.joined", fay, null], ["club_news.left", fay, "text_stop"]]);
  assert.deepEqual((await clubNewsList(db)).members.map((m) => m.email), ["ann@example.test"], "the deleted account is off the list");
  await run(db, "consent.club_news", { person_id: who["Eve Moss"]!, granted: true }, owner).then(() => assert.fail("a deleted account says nothing"), () => {});
  await run(db, "consent.club_news", { person_id: who["Bo Diaz"]!, granted: true }, as(who["Bo Diaz"]!));   // back for the plugin's test
});

test("the plugin installed: only its token gets the list's emails whole; it keeps the Klaviyo list to the club's, and a no takes them off at once", async () => {
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const up = await stageVaultUpload(db, owner.personId!, { kind: "secret", value: kl.state.key });
  await run(db, "vault.add", { name: "klaviyo/KLAVIYO_API_KEY", upload_id: up.upload_id }, owner);
  const r = await run(db, "plugin.install", { manifest: JSON.stringify({ ...EXAMPLE, run: { mode: "remote", url } }), settings: { list_id: LIST } }, owner);
  assert.equal((r.result as any).registered, true, JSON.stringify(r.result));
  const runner = p.runners.get(BASE)!;
  await runner.idle();
  await fanOutWebhooks(db);   // the club's webhooks start from here
  assert.equal(runner.health().door_error, null, logs.join("\n"));
  assert.deepEqual(kl.emails(LIST), ["ann@example.test", "bo@example.test"]);
  assert.deepEqual([...kl.state.profiles.values()].find((x) => x.email === "ann@example.test")!.properties, { language: "es" });
  const card = await get("Robin", "/staff/connectors");
  const mine = card.json.plugins.find((x: any) => x.name === "klaviyo");
  assert.ok(mine, JSON.stringify(card.json.plugins.map((x: any) => x.name)));

  // The plugin's own token reads it whole; court lights (no club_news in its manifest) is refused it.
  const whole = await call(runner.rec.door.token, "club_news_list");
  assert.deepEqual(whole.members.map((m: any) => m.email).sort(), ["ann@example.test", "bo@example.test"]);
  const got: string[] = [];
  const capture = createServer((req, res) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { got.push(b); res.writeHead(200); res.end("{}"); }); });
  await new Promise<void>((ok) => capture.listen(0, "127.0.0.1", ok));
  try {
    await run(db, "plugin.install", { manifest: JSON.stringify({ ...LIGHTS, run: { mode: "remote", url: `http://127.0.0.1:${(capture.address() as { port: number }).port}/p` } }) }, owner);
    const lights = lightsToken = got.map((b) => JSON.parse(b)).find((b) => b.plugin?.name === "court-lights").door.token;
    assert.match(String((await call(lights, "club_news_list")).error), /staff_only|not found/, "a plugin that doesn't declare club_news");
  } finally { capture.close(); }

  // Bo says no: the club's webhook, signed, reaches the plugin, and Bo comes off the Klaviyo list at once.
  await run(db, "consent.club_news", { person_id: who["Bo Diaz"]!, granted: false }, as(who["Bo Diaz"]!));
  const sent = await deliver();
  assert.ok(sent.length >= 1 && sent.every((s) => s === 200), JSON.stringify(sent));
  assert.deepEqual(kl.emails(LIST), ["ann@example.test"]);
  // Ann's account deleted: off the list, and her profile deleted in Klaviyo.
  const annProfile = [...kl.state.profiles].find(([, x]) => x.email === "ann@example.test")![0];
  await run(db, "privacy.erase", { person_id: who["Ann Lee"]! }, owner);
  await deliver();
  assert.deepEqual(kl.emails(LIST), []);
  assert.ok(kl.state.deleted.includes(annProfile));
  assert.ok(!logs.join("\n").includes("@example.test") && !logs.join("\n").includes(kl.state.key), "no email or key in its log");
});

test("unsubscribed in Klaviyo: the plugin turns the member's answer to no at the club, for one member it was given; nobody else can", async () => {
  const runner = p.runners.get(BASE)!, token = runner.rec.door.token;
  const gil = await person("Gil Ono", "gil@example.test", true);
  await runner.serial(() => runner.sync(clock, { full: true }));
  assert.deepEqual(kl.emails(LIST), ["gil@example.test"]);
  // Who may: not a person (not even the owner), not a plugin that doesn't read club_news, not for someone off the list.
  assert.equal((await call(await tokenFor(owner.personId!), "club_news_unsubscribed_elsewhere_preview", { person_id: gil })).error, "MCP error -32602: Tool club_news_unsubscribed_elsewhere_preview not found");
  await assert.rejects(run(db, "club_news.unsubscribed_elsewhere", { person_id: gil }, owner), (e: any) => e.code === "error.forbidden_reason");
  assert.equal((await call(lightsToken, "club_news_unsubscribed_elsewhere_preview", { person_id: gil })).error, "error.forbidden_reason");
  assert.equal((await call(token, "club_news_unsubscribed_elsewhere_preview", { person_id: who["Cy Park"]! })).error, "error.nothing_changed", "never answered: not on the list");
  // Gil unsubscribes from a Klaviyo email: the daily check passes it back, and the club's answer is no.
  kl.leaves("gil@example.test");
  await runner.serial(() => runner.sync(clock, { full: true }));
  assert.deepEqual(kl.emails(LIST), []);
  assert.equal((await clubNewsList(db)).members.some((m) => m.id === gil), false);
  const c = await db.selectFrom("channel_consent").select(["granted", "source"]).where("person_id", "=", gil).orderBy("at", "desc").orderBy("id", "desc").executeTakeFirstOrThrow();
  assert.deepEqual(c, { granted: false, source: "plugin" });
  assert.deepEqual((await topics()).at(-1), ["club_news.left", gil, "unsubscribed_elsewhere"]);
  const r = await db.selectFrom("action_run").select(["plan"]).where("action", "=", "club_news.unsubscribed_elsewhere").where("status", "=", "applied").executeTakeFirstOrThrow();
  assert.match((r.plan as any).summary.en, /^klaviyo says Gil Ono unsubscribed in Klaviyo: club news by email turns off/);
  assert.equal((r.plan as any).undo.kind, "none");
});
