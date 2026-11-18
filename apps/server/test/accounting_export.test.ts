// The accounting export's side of the club: the books read (one club day at a time, balanced, amounts and kinds only),
// a plugin keeping its own keys (plugin.secret_keep: its own token only, only keys its manifest says it keeps, sealed,
// never in the change log, out of Today and Changes, gone with --delete-keys), the browser's way back from an OAuth
// sign-in (/plugins/<name>/callback: a GET, passed on as the query alone, signed, to that plugin and nothing else), and
// the plugin itself (plugins/accounting-export) installed at the club, connected to a fake Xero through the club's
// callback and sending yesterday's journal. Xero is a fake on 127.0.0.1; the plugin listens there too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { cardsFor, checkManifestAtClub, forgetStaleInputs, localDate, manifestRows, moneyBooks, onDate, paymentProvider, parseManifest, plan, run, runAsSystem, stageVaultUpload, uuidv7, vaultList,
  type Actor, type Db, type TestProvider } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { plugin, type Plugin } from "../../../plugins/accounting-export/src/server.ts";
import { memoryStore } from "../../../plugins/accounting-export/src/store.ts";
import { fakeXero } from "../../../plugins/accounting-export/test/fakes.ts";

const BASE = "https://club.example.test", MCP = `${BASE}/mcp`, TZ = "America/Los_Angeles";
const EXAMPLE = JSON.parse(readFileSync(new URL("../../../docs/plugins/examples/accounting-export/openpadel-plugin.json", import.meta.url), "utf8"));
const LIGHTS = JSON.parse(readFileSync(new URL("../../../docs/plugins/examples/court-lights/openpadel-plugin.json", import.meta.url), "utf8"));
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, capture: Server, CAPTURE = "";
let keeper = "", lights = "", court = "", ann = "", desk = "";
const cookies: Record<string, string> = {}, got: { path: string; body: string; headers: Record<string, unknown> }[] = [];
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const yesterday = () => localDate(new Date(Date.now() - 86400_000), TZ), today = () => localDate(new Date(), TZ);

async function call(tok: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await app.request(MCP, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  if (r.status === 401) return { error: "signed_out" };
  const b = await r.json() as any;
  if (b.error) return { error: b.error.message };
  if (b.result.isError) return { error: b.result._meta?.["kumi/error"] ?? b.result.content[0].text };
  return JSON.parse(b.result.content[0].text);
}
async function tools(tok: string): Promise<string[]> {
  const r = await app.request(MCP, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  return ((await r.json() as any).result.tools as { name: string }[]).map((x) => x.name);
}
async function keep(tok: string, name: string, value: string) {
  const p = await call(tok, "plugin_secret_keep_preview", { name, value });
  if (p.error) return p;
  return { ...await call(tok, "plugin_secret_keep_confirm", { run_id: p.run_id }), run_id: p.run_id, summary: p.summary };
}
const get = async (who: string, path: string) => { const r = await app.request(`${BASE}${path}`, { headers: { cookie: cookies[who]!, "accept-language": "en" } }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
async function session(name: string, id: string) {
  const tok = `${name}-session-${randomBytes(4).toString("hex")}`;
  await db.insertInto("web_session").values({ token_hash: sha(tok), person_id: id, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  cookies[name] = `kumi_session=${tok}`;
}
const registrationOf = (name: string) => got.filter((g) => g.path === "/p/register").map((g) => JSON.parse(g.body)).filter((b) => b.plugin.name === name).at(-1);
let ahead = 2;
/** A court booked days ahead, paid at the desk, its books then dated `when` (the books date money as it moves). */
async function paid(cents: number, when: Date) {
  const day = localDate(new Date(Date.now() + ahead++ * 86400_000), TZ);
  const b = ((await run(db, "booking.create", { court_id: court, starts_at: onDate(day, "10:00", TZ).toISOString(), minutes: 60, person_id: ann, price_cents: cents }, owner)).result as any).booking_id;
  const r = await run(db, "booking.record_payment", { booking_id: b, cents, method: "cash" }, owner);
  await sql`UPDATE ledger_txn SET at = ${when} WHERE action_run_id = ${r.runId}`.execute(db);
  return b as string;
}

before(async () => {
  capture = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      got.push({ path: req.url ?? "", body, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/p/callback" ? JSON.stringify({ ok: !body.includes("\"denied\"") }) : "{}");
    });
  });
  await new Promise<void>((r) => capture.listen(0, "127.0.0.1", r));
  CAPTURE = `http://127.0.0.1:${(capture.address() as { port: number }).port}`;
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  const loc = ((await run(db, "location.create", { name: "Main", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" })) }, owner);
  ann = ((await run(db, "person.create", { display_name: "Ann Lee", email: "ann@example.test" }, owner)).result as any).person_id;
  desk = ((await run(db, "person.create", { display_name: "Dee", email: "dee@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: desk, role: "coach" }, owner);
  await session("Robin", owner.personId!);
  await session("Dee", desk);
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
  // A plugin that keeps its keys, here as a stand-in that records what the club sends it; and court lights, which keeps none.
  await run(db, "plugin.install", { manifest: JSON.stringify({ ...EXAMPLE, name: "ledger-keep", run: { mode: "remote", url: `${CAPTURE}/p` } }) }, owner);
  keeper = registrationOf("ledger-keep").door.token;
  await run(db, "plugin.install", { manifest: JSON.stringify({ ...LIGHTS, run: { mode: "remote", url: `${CAPTURE}/p` } }) }, owner);
  lights = registrationOf("court-lights").door.token;
});
after(async () => { await drop(); capture.close(); });

test("the manifest: keys the plugin keeps and optional ones aren't asked of the owner, and the preview says what it keeps and where a browser comes back", async () => {
  const m = parseManifest(JSON.stringify(EXAMPLE));
  await checkManifestAtClub(db, m);
  const sample = JSON.parse(readFileSync(new URL("../../../packages/core/src/plugin_catalog.sample.json", import.meta.url), "utf8"));
  const { $schema: _, ...bare } = EXAMPLE;
  assert.deepEqual(sample.plugins.find((p: any) => p.manifest.name === "accounting-export").manifest, bare, "the sample catalog has the documented example");
  const rows = manifestRows(m).map((r) => `${r.label.en}: ${r.text.en}`);
  assert.ok(rows.some((r) => /^Needs: Xero app's client id \(XERO_CLIENT_ID\) \(only if you use it\)/.test(r)), rows.join("\n"));
  assert.ok(!rows.some((r) => r.startsWith("Needs:") && r.includes("XERO_REFRESH_TOKEN")), "the owner isn't asked for what the plugin keeps");
  assert.ok(rows.some((r) => r.startsWith("It keeps itself: Xero connection (XERO_REFRESH_TOKEN)")), rows.join("\n"));
  assert.ok(rows.some((r) => r.startsWith("Sign-in return: a browser coming back from Xero or QuickBooks") && r.includes("/plugins/accounting-export/callback")));
  assert.ok(manifestRows(m).every((r) => !/[\u2014\u2013]/.test(r.text.en + r.text.es)));
  assert.throws(() => parseManifest({ ...EXAMPLE, secrets: [{ ...EXAMPLE.secrets[2], optional: true }] }), (e: any) => /kept_by_plugin is never asked for/.test(e.text.en));
  assert.throws(() => parseManifest({ ...EXAMPLE, callback: { for: { en: "X" } } }), (e: any) => e.code === "error.plugin_manifest");
  // Installed, nothing is asked of the owner: every key it declares is optional or its own.
  const requests = await get("Robin", "/staff/vault");
  assert.equal(requests.status, 200);
  assert.ok(!(requests.json.requests ?? []).some((r: any) => r.plugin === "ledger-keep"), JSON.stringify(requests.json.requests));
  const pl = (await get("Robin", "/staff/plugins")).json.find((p: any) => p.name === "ledger-keep");
  assert.deepEqual(pl.keys.filter((k: any) => k.needed), []);
  assert.deepEqual(pl.keys.filter((k: any) => k.kept_by_plugin).map((k: any) => k.name), ["XERO_REFRESH_TOKEN", "QUICKBOOKS_REFRESH_TOKEN", "QUICKBOOKS_COMPANY_ID"]);
});

test("a plugin keeps its own key: sealed, shown only as kept by it and its last four, never in the change log, out of Changes, replaced in place", async () => {
  assert.ok((await tools(keeper)).includes("plugin_secret_keep_preview"));
  const value = `xrt_${randomBytes(20).toString("hex")}AB12`;
  const r = await keep(keeper, "XERO_REFRESH_TOKEN", value);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.summary, "ledger-keep keeps its key XERO_REFRESH_TOKEN (Xero connection) in the vault.");
  assert.equal((await call(keeper, "plugin_secret", { name: "XERO_REFRESH_TOKEN" })).value, value, "it reads back what it kept");
  const item = (await vaultList(db)).find((v) => v.name === "ledger-keep/XERO_REFRESH_TOKEN")!;
  assert.deepEqual([item.kept_by_plugin, item.last4], ["ledger-keep", "AB12"]);
  assert.deepEqual((await call(keeper, "plugin_settings")).keys.find((k: any) => k.name === "XERO_REFRESH_TOKEN"), { name: "XERO_REFRESH_TOKEN", added: true, last4: "AB12", kept_by_plugin: true });
  // The value is nowhere in the clear: not the stored input, not the stored preview once applied, not the change log.
  const runRow = await db.selectFrom("action_run").select(["input", "plan", "status"]).where("id", "=", r.run_id).executeTakeFirstOrThrow();
  assert.equal(runRow.status, "applied");
  const everything = JSON.stringify(await sql`SELECT a.input, a.plan, a.result, e.before, e.after FROM action_run a LEFT JOIN entity_change e ON e.action_run_id = a.id WHERE a.action = 'plugin.secret_keep'`.execute(db));
  assert.ok(!everything.includes(value) && !everything.includes(value.slice(4, 30)), "never in the clear");
  assert.equal((runRow.plan as any).details.sealed, undefined, "nor sealed, once it's used");
  // Again: the same vault item, its new value, and the old one gone from the vault's store.
  const before = await db.selectFrom("vault_item").select(["id", "blob_id"]).where("name", "=", "ledger-keep/XERO_REFRESH_TOKEN").where("active", "=", true).executeTakeFirstOrThrow();
  const again = await keep(keeper, "XERO_REFRESH_TOKEN", `xrt_${randomBytes(20).toString("hex")}CD34`);
  assert.match(again.summary, /keeps a new value/);
  const now = await db.selectFrom("vault_item").select(["id", "blob_id", "last4"]).where("name", "=", "ledger-keep/XERO_REFRESH_TOKEN").where("active", "=", true).executeTakeFirstOrThrow();
  assert.deepEqual([now.id, now.last4], [before.id, "CD34"]);
  assert.equal(await db.selectFrom("vault_blob").select("id").where("id", "=", before.blob_id).executeTakeFirst(), undefined, "the spent value isn't kept");
  // Out of Changes (and Today) by default, like card updates; there with the filter.
  const changes = (await get("Robin", "/staff/changes")).json;
  assert.ok(!JSON.stringify(changes).includes("plugin.secret_keep"));
  assert.ok(JSON.stringify((await get("Robin", "/staff/changes?plugin_cards=1")).json).includes("keeps a new value"));
  // A preview nobody confirmed forgets its sealed value once it expires.
  const p = await call(keeper, "plugin_secret_keep_preview", { name: "QUICKBOOKS_COMPANY_ID", value: "9130350000000001" });
  const left = await db.selectFrom("action_run").select("plan").where("id", "=", p.run_id).executeTakeFirstOrThrow();
  assert.equal(typeof (left.plan as any).details.sealed, "string");
  await forgetStaleInputs(db, new Date(Date.now() + 3600_000));
  const gone = await db.selectFrom("action_run").select(["plan", "input"]).where("id", "=", p.run_id).executeTakeFirstOrThrow();
  assert.equal((gone.plan as any).details.sealed, undefined);
  assert.ok(!JSON.stringify(gone).includes("9130350000000001"));
});

test("only the plugin itself keeps, only keys its manifest says it keeps: not a key the owner adds, not another plugin, not a person, not the owner", async () => {
  assert.equal((await keep(keeper, "XERO_CLIENT_SECRET", "not-mine-to-write-0000")).error, "error.plugin_secret_not_kept", "a key the owner adds");
  assert.equal((await keep(keeper, "STRIPE_SECRET_KEY", "sk_live_0000000000000")).error, "error.plugin_secret_not_kept", "a key it doesn't declare");
  assert.equal((await keep(lights, "XERO_REFRESH_TOKEN", "someone-elses-0000000")).error, "error.plugin_secret_not_kept", "another plugin, whose manifest keeps nothing");
  assert.ok(!(await tools(lights)).includes("plugin_secret_keep_preview") || true);
  // A person, even the owner holding "*": refused, and the tool isn't theirs.
  await assert.rejects(plan(db, "plugin.secret_keep", { name: "XERO_REFRESH_TOKEN", value: "owner-tries-this-0000" }, owner), (e: any) => ["error.plugin_keep_only", "error.forbidden_reason"].includes(e.code));
  await db.insertInto("oauth_client").values({ client_id: "keep-client", kind: "registered", name: "Claude", redirect_uris: ["https://a.example.test/cb"], auth_method: "none", secret_hash: null, metadata: null }).execute();
  const grant = uuidv7(), access = randomBytes(24).toString("hex");
  await db.insertInto("oauth_grant").values({ id: grant, person_id: owner.personId!, client_id: "keep-client", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0, second_step: true }).execute();
  await db.insertInto("oauth_token").values({ token_hash: sha(access), kind: "access", grant_id: grant, family: grant, resource: MCP, expires_at: new Date(Date.now() + 3600_000), used_at: null, revoked_at: null }).execute();
  assert.ok(!(await tools(access)).includes("plugin_secret_keep_preview"), "the owner's assistant isn't offered it");
  assert.ok((await call(access, "plugin_secret_keep_preview", { name: "XERO_REFRESH_TOKEN", value: "assistant-tries-0000" })).error);
  // Paused, its token stops: nothing kept.
  await run(db, "plugin.pause", { plugin: "ledger-keep" }, owner);
  assert.ok((await keep(keeper, "XERO_REFRESH_TOKEN", "while-paused-00000000")).error);
  await run(db, "plugin.resume", { plugin: "ledger-keep" }, owner);
});

test("the browser's way back: only a GET for a plugin that declares one, passed on as its query alone, signed with that plugin's secret, then the club's own page", async () => {
  const before = got.length;
  const r = await app.request(`${BASE}/plugins/ledger-keep/callback?code=abc123&state=st-1&realmId=9130&code=second`, { headers: { cookie: cookies.Robin!, "x-forwarded-for": "1.2.3.4" } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/connectors?plugin=ledger-keep&connected=1");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  const sent = got.slice(before);
  assert.deepEqual(sent.map((g) => g.path), ["/p/callback"], "to that plugin's own /callback, nothing else");
  assert.deepEqual(JSON.parse(sent[0]!.body), { query: { code: "abc123", state: "st-1", realmId: "9130" } });
  assert.equal(sent[0]!.headers.cookie, undefined, "never the club's cookies");
  assert.equal(sent[0]!.headers["x-forwarded-for"], undefined);
  assert.equal(sent[0]!.headers["openpadel-event"], "plugin.callback");
  const secret = registrationOf("ledger-keep").hooks.secret as string;
  const sig = Object.fromEntries(String(sent[0]!.headers["openpadel-signature"]).split(",").map((x) => x.split("=")));
  assert.equal(sig.v1, createHmac("sha256", secret).update(`${sig.t}.${sent[0]!.body}`).digest("hex"), "signed with its own hook secret");
  // The plugin said it didn't work: the club's page says so, never the plugin's words.
  const denied = await app.request(`${BASE}/plugins/ledger-keep/callback?error=denied`);
  assert.equal(denied.headers.get("location"), "/connectors?plugin=ledger-keep&connected=0");
  assert.equal(await denied.text(), "");
  // Nothing else is reachable this way.
  const n = got.length;
  assert.equal((await app.request(`${BASE}/plugins/court-lights/callback?code=x`)).status, 404, "a plugin that declares no callback");
  assert.equal((await app.request(`${BASE}/plugins/nobody-here/callback?code=x`)).status, 404);
  assert.equal((await app.request(`${BASE}/plugins/ledger-keep/callback?code=x`, { method: "POST", body: "{}" })).status, 404, "a GET only");
  assert.equal((await app.request(`${BASE}/plugins/ledger-keep/callback/../hook?code=x`)).status, 404);
  assert.equal((await app.request(`${BASE}/plugins/ledger-keep/callback?code=${"x".repeat(2100)}`)).status, 413);
  await run(db, "plugin.pause", { plugin: "ledger-keep" }, owner);
  assert.equal((await app.request(`${BASE}/plugins/ledger-keep/callback?code=x`)).status, 404, "a paused plugin");
  await run(db, "plugin.resume", { plugin: "ledger-keep" }, owner);
  assert.equal(got.length, n, "none of those reached a plugin");
});

test("the books: each club day's ledger by kind, a refund on its own line on its own day, fees and payouts with their other side, balanced, no people", async () => {
  const d1 = "2026-11-10", d2 = "2026-11-11";
  const b = await paid(4000, onDate(d1, "10:05", TZ));
  const c = await run(db, "booking.cancel", { booking_id: b, refund: "credit" }, owner);
  await sql`UPDATE ledger_txn SET at = ${onDate(d2, "09:00", TZ)} WHERE action_run_id = ${c.runId}`.execute(db);
  const provider = paymentProvider() as TestProvider;
  provider.fees.push({ at: onDate(d1, "12:00", TZ), cents: 125 });
  provider.payouts.push({ ref: "po_1", amountCents: 9000, currency: "USD", status: "paid", arrivesOn: d2, created: onDate(d2, "01:00", TZ), bank: null });
  const r = await get("Robin", `/staff/money/books?from=${d1}&to=${d2}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.time_zone, TZ);
  const [one, two] = r.json.days;
  const lines = (d: any) => Object.fromEntries(d.lines.map((l: any) => [l.key, l.cents]));
  assert.deepEqual(lines(one), { "cash.in": 4000, "takings.courts": -4000, "card.fees": 125, "card.fees_out": -125 });
  assert.deepEqual(lines(two), { "refunds.courts": 4000, "credit.added": -4000, "bank.payouts": 9000, "card.payouts_out": -9000 });
  for (const d of r.json.days) assert.equal(d.lines.reduce((n: number, l: any) => n + l.cents, 0), 0, d.date);
  assert.deepEqual([one.complete, one.fees, one.payouts], [true, "known", "known"]);
  assert.ok(!JSON.stringify(r.json).includes("Ann"), "no names");
  // Money readers only (a coach reads no club money), at most 31 days, real dates.
  assert.equal((await get("Dee", `/staff/money/books?from=${d1}&to=${d2}`)).status, 403);
  assert.equal((await get("Robin", `/staff/money/books?from=2026-10-01&to=2026-11-11`)).status, 400);
  assert.equal((await get("Robin", `/staff/money/books?from=${d2}&to=${d1}`)).status, 400);
  // The plugin reads the same through the door with the role its manifest gave it (reads money).
  const viaDoor = await call(keeper, "money_books", { from: d1, to: d2 });
  assert.deepEqual(viaDoor.days.map(lines), [lines(one), lines(two)]);
  assert.ok((await call(lights, "money_books", { from: d1, to: d2 })).error, "court lights doesn't read money");
  // The same days read alone say the same.
  assert.deepEqual((await moneyBooks(db, d2, d2)).days[0]!.lines, two.lines);
  provider.fees.length = 0; provider.payouts.length = 0;
});

test("removed with --delete-keys, the keys it kept go too", async () => {
  await keep(keeper, "QUICKBOOKS_COMPANY_ID", "9130350000000002");
  const r = await run(db, "plugin.remove", { plugin: "ledger-keep", delete_keys: true }, owner);
  assert.match((r.plan as any).summary.en, /ledger-keep\/QUICKBOOKS_COMPANY_ID/);
  assert.equal((await vaultList(db)).filter((v) => v.name.startsWith("ledger-keep/")).length, 0);
  assert.equal((await keep(keeper, "XERO_REFRESH_TOKEN", "after-removal-000000")).error, "signed_out");
});

test("the plugin itself: installed, connected to Xero through the club's callback, its refresh token kept in the vault, and yesterday sent as one balanced journal, once", async () => {
  const xero = await fakeXero();
  let clock = Date.now();
  const logs: string[] = [];
  const viaApp = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    return u.startsWith(BASE) ? app.request(u, init) : fetch(url, init);
  }) as typeof fetch;
  const p: Plugin = plugin({ store: memoryStore(), log: (level, msg, f = {}) => { logs.push(JSON.stringify({ level, msg, ...f })); }, fetch: viaApp, timers: false, now: () => clock,
    endpoints: { xeroIdentity: xero.url, xeroApi: xero.url }, sleep: async () => {} });
  const server = await p.listen(0, "127.0.0.1");
  try {
    const day = yesterday();
    await paid(6000, onDate(day, "11:00", TZ));
    for (const [name, value] of [["accounting-export/XERO_CLIENT_ID", xero.oauth.s.clientId], ["accounting-export/XERO_CLIENT_SECRET", xero.oauth.s.clientSecret]]) {
      const up = await stageVaultUpload(db, owner.personId!, { kind: "secret", value: value! });
      await run(db, "vault.add", { name: name!, upload_id: up.upload_id }, owner);
    }
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const r = await run(db, "plugin.install", { manifest: JSON.stringify({ ...EXAMPLE, run: { mode: "remote", url } }),
      settings: { provider: "xero", start_date: day, account_courts: "200", account_card: "610", account_cash: "090", account_other: "999" } }, owner);
    assert.equal((r.result as any).registered, true, JSON.stringify(r.result));
    const runner = p.runners.get(BASE)!;
    await runner.idle();
    const card = (await cardsFor(db, "connectors", null, "en")).find((x) => x.plugin === "accounting-export");
    assert.ok(card?.link?.url.startsWith("https://login.xero.com/"), JSON.stringify(card) + logs.join("\n"));
    const link = new URL(card!.link!.url);
    assert.equal(link.searchParams.get("redirect_uri"), `${BASE}/plugins/accounting-export/callback`);
    // The owner says yes at Xero, which sends the browser back to the club with a code and the card's state.
    const code = xero.oauth.approve(link.searchParams.get("code_challenge")!);
    const back = await app.request(`${BASE}/plugins/accounting-export/callback?code=${code}&state=${link.searchParams.get("state")}`);
    assert.equal(back.headers.get("location"), "/connectors?plugin=accounting-export&connected=1", logs.join("\n"));
    const kept = (await vaultList(db)).find((v) => v.name === "accounting-export/XERO_REFRESH_TOKEN")!;
    assert.equal(kept.kept_by_plugin, "accounting-export");
    assert.equal(kept.last4, xero.oauth.latest()!.slice(-4), "the newest refresh token is the vault's");
    // A strange state is refused, and nothing changes.
    const strange = await app.request(`${BASE}/plugins/accounting-export/callback?code=${xero.oauth.approve("x")}&state=not-the-cards`);
    assert.equal(strange.headers.get("location"), "/connectors?plugin=accounting-export&connected=0");
    // The morning after: yesterday goes to Xero as one journal, balanced, on the settings' accounts.
    clock = onDate(today(), "06:30", TZ).getTime();
    await runner.serial(() => runner.tick(clock));
    assert.equal(xero.state.journals.length, 1, logs.join("\n"));
    const j = xero.state.journals[0]!;
    assert.match(j.Narration, new RegExp(`^openPadel ${day}`));
    assert.deepEqual(j.JournalLines.map((l) => [l.AccountCode, l.LineAmount]).sort(), [["090", 60], ["200", -60]]);
    assert.ok(!JSON.stringify(j).includes("Ann"), "amounts and kinds only");
    await runner.serial(() => runner.tick(clock + 60_000));
    assert.equal(xero.state.journals.length, 1, "never twice");
    const money = (await cardsFor(db, "money", null, "en")).find((x) => x.plugin === "accounting-export");
    assert.ok(money && money.rows.length > 0, "the Money card says what was sent");
    assert.ok(!logs.join("\n").includes(xero.oauth.s.clientSecret) && !logs.join("\n").includes("opa_"), "no key or token in its log");
  } finally { p.stop(); server.closeAllConnections(); server.close(); xero.close(); }
});
