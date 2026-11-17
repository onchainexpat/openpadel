// Plugin cards (plugin_cards.ts) and the Connectors read (connectors.ts): a plugin puts and clears its own cards
// through the door, only for its manifest's slots, with a preview of what the card will say; nobody else can, not
// even the owner; each slot's cards are read only by who reads that slot (a game's by its players and staff, a
// profile's by its member and staff); a paused plugin's cards don't show; and the Connectors read says what's
// connected and whether it's healthy without ever giving a key away. The plugin is a fake HTTP server on 127.0.0.1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { cardsFor, plan, run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { connectors, forgetConnectorChecks, statusOf, statusOfAll } from "../src/connectors.ts";
import { READS } from "../src/mcp.ts";
import { commands } from "../src/cli_commands.ts";

const BASE = "https://club.example.test", MCP = `${BASE}/mcp`, TZ = "America/Los_Angeles";
const EXAMPLE = JSON.parse(readFileSync(new URL("../../../docs/plugins/examples/court-lights/openpadel-plugin.json", import.meta.url), "utf8"));
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, server: Server, PLUGIN = "";
let token = "", other = "", court = "", booking = "";
const people: Record<string, string> = {}, cookies: Record<string, string> = {};
const got: { path: string; body: string }[] = [];
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const both = (en: string, es = en) => ({ en, es });

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
/** A card put through the door as the plugin would: preview, then confirm. */
async function put(tok: string, args: Record<string, unknown>) {
  const p = await call(tok, "plugin_card_put_preview", args);
  if (p.error) return p;
  const c = await call(tok, "plugin_card_put_confirm", { run_id: p.run_id });
  return { ...c, summary: p.summary };
}
const get = async (who: string, path: string) => { const r = await app.request(`${BASE}${path}`, { headers: { cookie: cookies[who]!, "accept-language": "en" } }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
async function session(name: string, id: string) {
  const tok = `${name}-session`;
  await db.insertInto("web_session").values({ token_hash: sha(tok), person_id: id, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  cookies[name] = `kumi_session=${tok}`;
}
const registrationOf = (name: string) => got.filter((g) => g.path === "/p/register").map((g) => JSON.parse(g.body)).filter((b) => b.plugin.name === name).at(-1);
const row = (label: string, text: string) => ({ label: both(label, `${label} (es)`), text: both(text, `${text} (es)`) });

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => { got.push({ path: req.url ?? "", body }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  PLUGIN = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ({ db, drop } = await freshDb());
  const setup = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (setup.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  const loc = ((await run(db, "location.create", { name: "Main", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" })) }, owner);
  for (const name of ["Ann", "Bea", "Dee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Dee!, role: "front_desk" }, owner);
  for (const n of ["Ann", "Bea", "Dee"]) await session(n, people[n]!);
  await session("Robin", owner.personId!);
  booking = ((await run(db, "booking.create", { court_id: court, starts_at: new Date(Date.now() + 2 * 864e5).toISOString(), minutes: 60, person_id: people.Ann }, owner)).result as any).booking_id;
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
  // Court lights with a card in every slot, and a second plugin with the court's tile only.
  const cards = ["court_tile", "game", "member_profile", "money", "connectors"].map((slot) => ({ slot, title: both(`Lights ${slot}`, `Luces ${slot}`) }));
  const lights = { ...EXAMPLE, $schema: undefined, cards, run: { mode: "remote", url: `${PLUGIN}/p` } };
  await run(db, "plugin.install", { manifest: JSON.stringify(lights) }, owner);
  token = registrationOf("court-lights").door.token;
  await run(db, "plugin.install", { manifest: JSON.stringify({ ...lights, name: "scoreboard", cards: [cards[0]] }) }, owner);
  other = registrationOf("scoreboard").door.token;
});
after(async () => { await drop(); server.close(); });

test("the card tools are a plugin's alone: listed for it, for nobody else, and the owner is refused them", async () => {
  const mine = await tools(token);
  assert.ok(mine.includes("plugin_card_put_preview") && mine.includes("plugin_card_clear_confirm"), "the plugin has them");
  assert.ok(!mine.includes("plugin_install_preview"), "and still no other plugin action");
  // The owner's own assistant: everything the owner holds ("*"), but not these.
  await db.insertInto("oauth_client").values({ client_id: "cards-client", kind: "registered", name: "Claude", redirect_uris: ["https://a.example.test/cb"], auth_method: "none", secret_hash: null, metadata: null }).execute();
  const grant = uuidv7(), access = randomBytes(24).toString("hex");
  await db.insertInto("oauth_grant").values({ id: grant, person_id: owner.personId!, client_id: "cards-client", scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0, second_step: true }).execute();
  await db.insertInto("oauth_token").values({ token_hash: sha(access), kind: "access", grant_id: grant, family: grant, resource: MCP, expires_at: new Date(Date.now() + 3600_000), used_at: null, revoked_at: null }).execute();
  const owners = await tools(access);
  assert.ok(owners.includes("plugin_install_preview") && owners.includes("connectors"), "the owner's assistant has the plugin actions and the Connectors read");
  assert.ok(!owners.some((x) => x.startsWith("plugin_card_")), "but no card tools");
  await assert.rejects(plan(db, "plugin.card_put", { slot: "money", rows: [row("A", "B")] }, owner), (e: any) => e.code === "error.forbidden_reason" && /only a plugin/.test(e.text.en));
  // Nor as a person's command (cli_commands.ts), whatever their role holds.
  assert.ok(!commands().some((c) => c.kind === "action" && c.action?.startsWith("plugin.card_")));
  assert.ok(READS.some((r) => r.name === "connectors" && r.staff), "the Connectors read is the door's too");
});

test("a plugin puts a card in a slot its manifest declares, previewed in words, and putting again replaces it", async () => {
  const r = await put(token, { slot: "court_tile", subject: court, rows: [row("Lights", "On until 21:30")], link: { url: "https://ha.kestrel.test/lights", label: both("Open Home Assistant", "Abrir Home Assistant") } });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.summary, "court-lights shows its card \"Lights court_tile\" on a court's tile in Today (Court 1).");
  let tiles = (await get("Dee", "/staff/grid/cards")).json;
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].court, "Court 1");
  assert.deepEqual(tiles[0].cards.map((c: any) => [c.plugin, c.title, c.tone, c.rows, c.link?.url]), [["court-lights", "Lights court_tile", "ok", [{ label: "Lights", text: "On until 21:30" }], "https://ha.kestrel.test/lights"]]);
  const again = await put(token, { slot: "court_tile", subject: court, tone: "warn", rows: [row("Lights", "Home Assistant unreachable")] });
  assert.match(again.summary, /updates its card/);
  tiles = (await get("Dee", "/staff/grid/cards")).json;
  assert.deepEqual(tiles[0].cards.map((c: any) => [c.tone, c.rows[0].text, c.link]), [["warn", "Home Assistant unreachable", null]], "replaced, one card");
  // Spanish for a Spanish reader.
  const es = await cardsFor(db, "court_tile", [court], "es");
  assert.deepEqual([es[0]!.title, es[0]!.rows[0]!.label, es[0]!.rows[0]!.text], ["Luces court_tile", "Lights (es)", "Home Assistant unreachable (es)"]);
  // Every put is in the change log as the plugin's own change.
  const runs = await db.selectFrom("action_run").select(["status", "agent_id"]).where("action", "=", "plugin.card_put").where("status", "=", "applied").execute();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((x) => x.agent_id), "made by the plugin's agent");
});

test("what a card may say: its slots only, a subject that fits, six rows of one line each without dashes, and https links", async () => {
  const bad = async (tok: string, args: Record<string, unknown>, why: RegExp) => {
    const r = await call(tok, "plugin_card_put_preview", args);
    assert.ok(typeof r.error === "string" && why.test(r.error), `${JSON.stringify(args).slice(0, 90)}: ${JSON.stringify(r)}`);
  };
  await bad(other, { slot: "money", rows: [row("A", "B")] }, /plugin_card_slot/);
  await bad(token, { slot: "court_tile", rows: [row("A", "B")] }, /plugin_card_subject/);
  await bad(token, { slot: "money", subject: court, rows: [row("A", "B")] }, /plugin_card_subject/);
  await bad(token, { slot: "court_tile", subject: people.Ann, rows: [row("A", "B")] }, /plugin_card_subject/);
  await bad(token, { slot: "money", rows: [row("A", "on — off")] }, /invalid|dash/i);
  await bad(token, { slot: "money", rows: [row("A", "line\nbreak")] }, /invalid|line/i);
  await bad(token, { slot: "money", rows: Array.from({ length: 7 }, () => row("A", "B")) }, /invalid|Too big/i);
  await bad(token, { slot: "money", rows: [row("A", "B")], link: { url: "http://ha.kestrel.test", label: both("x") } }, /invalid|https/i);
  await bad(token, { slot: "money", rows: [row("A", "B")], link: { url: "javascript:alert(1)", label: both("x") } }, /invalid|https/i);
});

test("who reads which: a game's card its players and staff, a profile's its member and staff, Money and Connectors staff", async () => {
  assert.equal((await put(token, { slot: "game", subject: booking, rows: [row("Highlights", "3 clips ready")] })).error, undefined);
  assert.equal((await put(token, { slot: "member_profile", subject: people.Ann, rows: [row("Camera rating", "4.1")] })).error, undefined);
  assert.equal((await put(token, { slot: "money", rows: [row("Last export", "Yesterday")] })).error, undefined);
  // The person isn't named to the plugin in its preview.
  const p = await call(token, "plugin_card_put_preview", { slot: "member_profile", subject: people.Bea, rows: [row("A", "B")] });
  assert.ok(!p.summary.includes("Bea"), p.summary);
  assert.equal((await get("Ann", `/matches/${booking}/cards`)).json[0].rows[0].text, "3 clips ready");
  assert.equal((await get("Bea", `/matches/${booking}/cards`)).status, 404, "not in the game: as if it weren't there");
  assert.equal((await get("Dee", `/staff/bookings/${booking}/cards`)).json[0].title, "Lights game");
  assert.equal((await get("Ann", "/my/cards")).json[0].rows[0].text, "4.1");
  assert.deepEqual((await get("Bea", "/my/cards")).json, [], "someone else's profile card isn't theirs");
  assert.equal((await get("Dee", `/staff/people/${people.Ann}/cards`)).json.length, 1);
  assert.equal((await get("Ann", `/staff/people/${people.Ann}/cards`)).status, 403, "a member doesn't read the staff side");
  assert.equal((await get("Dee", "/staff/reports/cards")).json[0].rows[0].text, "Yesterday");
  assert.equal((await get("Ann", "/staff/reports/cards")).status, 403);
});

test("a paused plugin's cards don't show, and come back when it's turned back on; cleared, they're gone", async () => {
  await run(db, "plugin.pause", { plugin: "court-lights" }, owner);
  assert.deepEqual((await get("Ann", "/my/cards")).json, []);
  assert.equal((await call(token, "plugin_card_put_preview", { slot: "money", rows: [row("A", "B")] })).error, "signed_out", "its token stops too");
  await run(db, "plugin.resume", { plugin: "court-lights" }, owner);
  assert.equal((await get("Ann", "/my/cards")).json.length, 1);
  const p = await call(token, "plugin_card_clear_preview", { slot: "member_profile", subject: people.Ann });
  assert.match(p.summary, /takes down its card "Lights member_profile" on a member's profile/);
  await call(token, "plugin_card_clear_confirm", { run_id: p.run_id });
  assert.deepEqual((await get("Ann", "/my/cards")).json, []);
  assert.match((await call(token, "plugin_card_clear_preview", { slot: "member_profile", subject: people.Ann })).error, /nothing_changed/);
});

test("Connectors: built-in services and plugins as one kind of card, with their status and health, never a key", async () => {
  assert.equal((await put(token, { slot: "connectors", rows: [row("Courts", "2 lit")] })).error, undefined);
  forgetConnectorChecks();
  const secret = "re_live_abcdefghijklmnop9F2A", backup = "backup-key-that-nobody-reads-ZZ99";
  const v = await connectors(db, "en", { production: false, env: { KUMI_RESEND_API_KEY: secret, KUMI_MAIL_FROM: "Kestrel <hi@kestrel.test>", KUMI_BACKUP_KEY: backup }, fresh: true });
  assert.deepEqual(v.built_ins.map((b) => b.key), ["stripe", "resend", "twilio", "playtomic", "offsite"]);
  const resend = v.built_ins.find((b) => b.key === "resend")!;
  assert.equal(resend.status, "waiting", "email in practice is waiting for go-live");
  assert.deepEqual(resend.settings.find((s) => s.name === "KUMI_RESEND_API_KEY"), { name: "KUMI_RESEND_API_KEY", added: true, last4: "9F2A" });
  assert.equal(v.built_ins.find((b) => b.key === "stripe")!.status, "off");
  const offsite = v.built_ins.find((b) => b.key === "offsite")!;
  assert.deepEqual(offsite.settings.find((s) => s.name === "KUMI_BACKUP_KEY"), { name: "KUMI_BACKUP_KEY", added: true, last4: null }, "the backup key: there, nothing of it shown");
  const text = JSON.stringify(v);
  assert.ok(!text.includes(secret) && !text.includes(backup) && !text.includes("ZZ99"), "no key in what it says");
  const lights = v.plugins.find((p) => p.name === "court-lights")!;
  assert.equal(lights.connector_status, "attention", "its key isn't added yet");
  assert.deepEqual(lights.cards.map((c) => c.rows[0]!.text), ["2 lit"]);
  assert.ok(v.summary.attention >= 1 && v.summary.off >= 1);
  assert.match(v.ask.prompt, /show me in words what it asks for/);
  // The staff read: owners and managers, as the door's `connectors` tool answers it.
  assert.equal((await get("Robin", "/staff/connectors")).status, 200);
  assert.equal((await get("Dee", "/staff/connectors")).status, 403, "not the front desk's");
});

test("a doctor check reads as a connector's status", () => {
  assert.equal(statusOf({ state: "ok", key: "payments.test" }), "on");
  assert.equal(statusOf({ state: "fail", key: "texts.refused" }), "attention");
  assert.equal(statusOf({ state: "warn", key: "payments.off" }), "off");
  assert.equal(statusOf({ state: "warn", key: "texts.reg_pending" }), "waiting");
  assert.equal(statusOf({ state: "warn", key: "email.practice" }), "waiting");
  assert.equal(statusOf({ state: "warn", key: "wallets.missing" }), "attention");
  assert.equal(statusOfAll([{ state: "ok", key: "payments.live" }, { state: "warn", key: "wallets.missing" }]), "attention");
  assert.equal(statusOfAll([{ state: "off", key: "texts.off" }, { state: "fail", key: "x.y" }]), "off");
  assert.equal(statusOfAll([]), "off");
});
