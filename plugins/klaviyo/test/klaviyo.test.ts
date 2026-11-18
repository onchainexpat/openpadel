// The Klaviyo plugin against a fake club and a fake Klaviyo: a signed registration (and a forged one refused), the
// club's list on Klaviyo with each member's email, first name and language and nothing else, a member saying yes (on
// the list), saying no (off it at once), deleted (off it, and their profile deleted in Klaviyo), the daily check catching
// what no event said (and someone put on the list by hand), Klaviyo down (the removal kept and done first when it's
// back), a forged event refused, the Connectors card, and its state on disk with no member's details or key in it.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { plugin, type Plugin } from "../src/server.ts";
import { FULL_MS, SYNC_MS } from "../src/club.ts";
import { fileStore, memoryStore, type Store } from "../src/store.ts";
import { redact } from "../src/log.ts";
import { fakeClub, fakeKlaviyo, pid, type ClubMember } from "./fakes.ts";

const LIST = "Xy12Ab";
let club: Awaited<ReturnType<typeof fakeClub>>, kl: Awaited<ReturnType<typeof fakeKlaviyo>>;
let p: Plugin, server: Server, base = "", clock = 0;
const logs: string[] = [];
const log = (level: string, msg: string, f: Record<string, unknown> = {}) => { logs.push(JSON.stringify({ level, msg, ...f })); };
const ann: ClubMember = { id: pid(1), email: "ann@example.test", first_name: "Ann", language: "en" };
const bea: ClubMember = { id: pid(2), email: "bea@example.test", first_name: "Bea", language: "es" };
const cal: ClubMember = { id: pid(3), email: "cal@example.test", first_name: "Cal", language: "en" };

async function start(store: Store = memoryStore()) {
  p = plugin({ store, log, allowHttp: true, timers: false, now: () => clock, klaviyoUrl: kl.url, sleep: async () => {} });
  server = await p.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
async function stop() { p.stop(); await new Promise((r) => server.close(r)); }
const runner = () => p.runners.get(club.url)!;
const idle = () => runner().idle();
async function post(path: string, body: string, headers: Record<string, string>) {
  const r = await fetch(`${base}${path}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  return r.status;
}
async function register() {
  const r = club.registration(clock);
  assert.equal(await post("/register", r.body, { "openpadel-signature-ed25519": r.header }), 200);
  await idle();
}
async function send(type: string, data: Record<string, unknown> = {}, o: { id?: string; secret?: string } = {}) {
  const e = club.event(clock, type, data, o);
  const s = await post("/events", e.body, { "openpadel-signature": e.header });
  await idle();
  return s;
}
/** Moves the clock and runs what the minute's timer would. */
async function tickAt(t: number) { clock = t; if (runner().due(clock)) await runner().serial(() => runner().sync(clock)); }
const health = async () => { const r = await fetch(`${base}/health`); return { status: r.status, body: await r.json() as any }; };
const cardText = () => (club.state.card?.rows ?? []).map((r: any) => `${r.label.en}: ${r.text.en}`).join("\n");

before(async () => { club = await fakeClub(); kl = await fakeKlaviyo(); });
after(() => { club.close(); kl.close(); });
beforeEach(() => {
  club.state.members = [ann, bea];
  club.state.settings = { list_id: LIST };
  club.state.reported = []; club.state.reports = true;
  club.state.key = kl.state.key; club.state.cards = true; club.state.down = false; club.state.calls = []; club.state.card = null;
  kl.state.mode = "ok"; kl.state.busy = 0; kl.state.privacy = true; kl.state.deleted = []; kl.state.calls = [];
  kl.state.lists.clear(); kl.state.profiles.clear();
  kl.state.lists.set(LIST, { name: "Club news", members: new Set() });
  logs.length = 0;
  clock = Date.parse("2026-11-18T17:00:00Z");
});

test("a registration is kept only when the club's key signs it; then the club's list is on Klaviyo, with email, first name and language only", async () => {
  await start();
  try {
    const forged = club.registration(clock, { stranger: true });
    assert.equal(await post("/register", forged.body, { "openpadel-signature-ed25519": forged.header }), 401);
    assert.equal(await post("/register", club.registration(clock).body, {}), 401, "no signature");
    const old = club.registration(clock - 3600_000);
    assert.equal(await post("/register", old.body, { "openpadel-signature-ed25519": old.header }), 401, "an old one replayed");
    assert.equal(p.runners.size, 0);

    club.state.members = [ann, bea, cal];   // three pages of two: the plugin follows `next`
    await register();
    assert.deepEqual(kl.emails(LIST), ["ann@example.test", "bea@example.test", "cal@example.test"]);
    assert.equal(club.state.calls.filter((c) => c.tool === "club_news_list").length, 2, "every page read");
    const bp = [...kl.state.profiles.values()].find((x) => x.email === "bea@example.test")!;
    assert.deepEqual(bp.attributes, ["email", "first_name", "properties"]);
    assert.deepEqual({ first_name: bp.first_name, properties: bp.properties }, { first_name: "Bea", properties: { language: "es" } }, "nothing else about her");
    assert.match(cardText(), /^On the list: 3 members who said yes to club news on Club news$/m);
    assert.equal(club.state.card.slot, "connectors");
    assert.equal(club.state.card.tone, "ok");
    assert.ok(club.state.card.rows.every((r: any) => !/[—–]/.test(r.text.en + r.text.es + r.label.en + r.label.es)), "no dashes");
    const h = await health();
    assert.equal(h.status, 200);
    assert.equal(h.body.members, 3);
    assert.ok(!JSON.stringify(h.body).includes("@"), "health names nobody");
    assert.ok(!logs.join("\n").includes("@example.test") && !logs.join("\n").includes(kl.state.key), "no email or key in a log");

    // Nothing changed: an hour later the club is read again and Klaviyo isn't told anything twice.
    kl.state.calls = [];
    await tickAt(clock + SYNC_MS);
    assert.deepEqual(kl.state.calls.filter((c) => c.method !== "GET"), [], "nothing sent again");
  } finally { await stop(); }
});

test("saying yes puts a member on the list; saying no takes them off at once; a deleted member's profile is deleted in Klaviyo", async () => {
  await start();
  try {
    await register();
    club.state.members = [ann, bea, cal];
    assert.equal(await send("club_news.joined", { person_id: cal.id }), 200);
    assert.deepEqual(kl.emails(LIST), ["ann@example.test", "bea@example.test", "cal@example.test"]);

    club.state.members = [bea, cal];
    assert.equal(await send("club_news.left", { person_id: ann.id, why: "said_no" }), 200);
    assert.deepEqual(kl.emails(LIST), ["bea@example.test", "cal@example.test"]);
    assert.ok([...kl.state.profiles.values()].some((x) => x.email === "ann@example.test"), "saying no takes them off the list; their profile is the club's Klaviyo's");
    assert.deepEqual(kl.state.deleted, []);

    club.state.members = [cal];
    const beaProfile = [...kl.state.profiles].find(([, x]) => x.email === "bea@example.test")![0];
    assert.equal(await send("club_news.left", { person_id: bea.id, why: "deleted" }), 200);
    assert.deepEqual(kl.emails(LIST), ["cal@example.test"]);
    assert.deepEqual(kl.state.deleted, [beaProfile], "a deleted member's profile deleted in Klaviyo");

    // A key without Data Privacy access: off the list all the same, and the card says what to give it.
    club.state.members = [];
    kl.state.privacy = false;
    assert.equal(await send("club_news.left", { person_id: cal.id, why: "deleted" }), 200);
    assert.deepEqual(kl.emails(LIST), []);
    assert.match(cardText(), /Deleted accounts: Taken off the list, but their profile stays in Klaviyo: give the key Data Privacy access/);
    assert.equal(club.state.card.tone, "warn");
    assert.ok(club.state.card.rows.some((r: any) => r.text.es.includes("dale a la clave acceso a Data Privacy")));
  } finally { await stop(); }
});

test("the daily check catches what no event said: a member who left without one, one who joined without one, and someone added by hand", async () => {
  await start();
  try {
    await register();
    // Ann said no and Cal said yes, and neither event reached the plugin; someone was put on the list by hand in Klaviyo.
    club.state.members = [bea, cal];
    kl.byHand(LIST, "stranger@example.test");
    await tickAt(clock + SYNC_MS);
    assert.deepEqual(kl.emails(LIST), ["bea@example.test", "cal@example.test", "stranger@example.test"], "the hourly read: Ann off, Cal on");
    await tickAt(clock + FULL_MS);
    assert.deepEqual(kl.emails(LIST), ["bea@example.test", "cal@example.test"], "the daily check: whoever isn't on the club's list comes off");
    assert.match(cardText(), /Last full check: Nov 19, 10:00\u202fAM|Last full check: Nov 19, 10:00 AM/);

    // A state lost (a restart with nothing kept): a "no" for someone it doesn't remember checks the whole list now.
    runner().rec.synced = {};
    club.state.members = [cal];
    assert.equal(await send("club_news.left", { person_id: bea.id, why: "said_no" }), 200);
    assert.deepEqual(kl.emails(LIST), ["cal@example.test"]);
  } finally { await stop(); }
});

test("Klaviyo down: a removal is kept, said on the card and in health, and done first once Klaviyo answers; a 429 waits and tries again", async () => {
  await start();
  try {
    await register();
    kl.state.mode = "down";
    club.state.members = [bea, cal];
    assert.equal(await send("club_news.left", { person_id: ann.id, why: "said_no" }), 200);
    assert.ok(kl.emails(LIST).includes("ann@example.test"), "still there: Klaviyo didn't answer");
    assert.match(cardText(), /To take off: 1 member who said no or whose account was deleted, waiting for Klaviyo/);
    assert.match(cardText(), /Klaviyo: Not answering/);
    assert.equal((await health()).status, 503);
    assert.equal(logs.filter((l) => l.includes("Klaviyo isn't answering")).length, 1, "said once");
    await tickAt(clock + 60_000);
    assert.equal(logs.filter((l) => l.includes("Klaviyo isn't answering")).length, 1, "still once");

    kl.state.mode = "ok"; kl.state.busy = 2; kl.state.calls = [];
    await tickAt(clock + 60_000);
    assert.deepEqual(kl.emails(LIST), ["bea@example.test", "cal@example.test"]);
    const writes = kl.state.calls.filter((c) => c.method !== "GET");
    assert.equal(writes[0]!.method, "DELETE", "the removal before anything is added");
    assert.equal((await health()).status, 200);
    assert.equal(club.state.card.tone, "ok");
  } finally { await stop(); }
});

test("a forged event is refused and changes nothing; the same event twice is handled once; a key or list missing says so", async () => {
  await start();
  try {
    await register();
    club.state.members = [bea];
    assert.equal(await send("club_news.left", { person_id: ann.id, why: "said_no" }, { secret: "whsec_" + "x".repeat(32) }), 401);
    assert.ok(kl.emails(LIST).includes("ann@example.test"), "a forged event did nothing");
    assert.equal(await send("club_news.left", { person_id: ann.id }, { id: "evt_1" }), 200);
    kl.state.calls = [];
    assert.equal(await send("club_news.left", { person_id: ann.id }, { id: "evt_1" }), 200);
    assert.deepEqual(kl.state.calls, [], "the second copy changed nothing");

    club.state.key = null;
    assert.equal(await send("plugin.configured", { settings: { list_id: LIST } }), 200);
    assert.match(cardText(), /Klaviyo: Waiting for its private API key \(KLAVIYO_API_KEY\) in the vault/);
    assert.equal((await health()).status, 200, "waiting for a key isn't down");
    club.state.key = kl.state.key; club.state.settings = { list_id: "Nope99" };
    assert.equal(await send("plugin.configured", { settings: club.state.settings }), 200);
    assert.match(cardText(), /Klaviyo: Klaviyo has no list with that id/);
    club.state.settings = {};
    assert.equal(await send("plugin.configured", { settings: {} }), 200);
    assert.match(cardText(), /Klaviyo: Waiting for the list's id in the plugin's settings/);
    kl.state.key = "pk_other"; club.state.settings = { list_id: LIST };
    assert.equal(await send("plugin.configured", { settings: club.state.settings }), 200);
    assert.match(cardText(), /It refused the key/);
    kl.state.key = club.state.key!;
  } finally { await stop(); }
});

test("kept on disk across a restart: 0600, with ids and fingerprints only (no email, name, language or key)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "klaviyo-state-"));
  await start(fileStore(dir));
  try { await register(); } finally { await stop(); }
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.equal(statSync(join(dir, files[0]!)).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const raw = readFileSync(join(dir, files[0]!), "utf8");
  for (const m of [ann, bea]) { assert.ok(!raw.includes(m.email), "no email"); assert.ok(!raw.includes(`"${m.first_name}"`), "no name"); }
  assert.ok(!raw.includes(kl.state.key), "no Klaviyo key");
  // Back up with what it kept: nothing sent again.
  kl.state.calls = [];
  await start(fileStore(dir));
  try {
    assert.equal(p.runners.size, 1);
    await runner().serial(() => runner().sync(clock));
    assert.deepEqual(kl.state.calls.filter((c) => c.method !== "GET"), []);
  } finally { await stop(); }
  assert.equal(redact('{"k":"Klaviyo-API-Key pk_abc123","e":"josé@example.test"}'), '{"k":"[hidden]","e":"[hidden]"}');
});

test("someone who unsubscribes from a Klaviyo email is never put back, comes off the list, and the club's answer turns to no", async () => {
  await start();
  try {
    await register();
    assert.deepEqual(kl.emails(LIST), ["ann@example.test", "bea@example.test"]);
    kl.leaves("ann@example.test");
    // The daily check sees it: off the list, and passed back to the club for Ann alone.
    await tickAt(clock + FULL_MS);
    assert.deepEqual(kl.emails(LIST), ["bea@example.test"]);
    assert.deepEqual(club.state.reported, [{ person_id: ann.id, service: "Klaviyo" }]);
    assert.equal([...kl.state.profiles.values()].find((x) => x.email === "ann@example.test")!.marketing!.consent, "UNSUBSCRIBED", "her no in Klaviyo stands");
    // The club not hearing (an older openPadel): still never put back, however often it reads.
    club.state.reports = false;
    club.state.members = [ann, bea];
    await tickAt(clock + SYNC_MS);
    await tickAt(clock + FULL_MS);
    assert.deepEqual(kl.emails(LIST), ["bea@example.test"], "an unsubscribed profile isn't added again");
    // Suppressed (a hard bounce) when it's first sent: not added, and the club told once it can hear.
    club.state.reports = true;
    club.state.members = [bea, cal];
    kl.state.profiles.set("01PRESET", { email: cal.email, first_name: null, properties: {}, attributes: [], marketing: { consent: "SUBSCRIBED", suppression: [{ reason: "HARD_BOUNCE" }] } });
    assert.equal(await send("club_news.joined", { person_id: cal.id }), 200);
    assert.ok(!kl.emails(LIST).includes(cal.email));
    assert.deepEqual(club.state.reported.map((r) => r.person_id).sort(), [ann.id, cal.id].sort());
    assert.ok(kl.state.calls.every((c) => !c.path.includes("subscription")), "no subscribe job, ever");
  } finally { await stop(); }
});
