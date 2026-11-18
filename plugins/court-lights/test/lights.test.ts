// The court lights plugin against a fake club and a fake Home Assistant: a signed registration (and a forged one
// refused), lights on before a booking and off after it, back-to-back bookings, a cancellation, a booking whose event
// never came caught by the next read, a forged event refused, Home Assistant down (retried, never turned off by an
// error), the court's tile, and its state kept across a restart without its token in a log.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { plugin, type Plugin } from "../src/server.ts";
import { fileStore, memoryStore, type Store } from "../src/store.ts";
import { at, entitiesFor, parseSettings, windows } from "../src/schedule.ts";
import { verifyWebhook } from "../src/signatures.ts";
import { fakeClub, fakeHomeAssistant, local, ms } from "./fakes.ts";

let club: Awaited<ReturnType<typeof fakeClub>>, ha: Awaited<ReturnType<typeof fakeHomeAssistant>>;
let p: Plugin, server: Server, base = "", clock = 0;
const logs: string[] = [];
const log = (level: string, msg: string, f: Record<string, unknown> = {}) => { logs.push(JSON.stringify({ level, msg, ...f })); };

async function start(store: Store = memoryStore()) {
  p = plugin({ store, log, allowHttp: true, timers: false, now: () => clock });
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
/** Moves the clock and lets the plugin act, as its 30-second tick does. */
async function tickAt(t: number) { clock = t; await runner().serial(() => runner().tick(clock)); }
async function readAt(t: number) { clock = t; await runner().serial(() => runner().reconcile(clock)); }

before(async () => { club = await fakeClub(); ha = await fakeHomeAssistant(); });
after(() => { club.close(); ha.close(); });
beforeEach(async () => {
  club.state.items = [];
  club.state.settings = { home_assistant_url: ha.url, courts: ["c1", "c2"], minutes_before: 10, minutes_after: 5, lights: "Court 2 = light.c2_north light.c2_south" };
  club.state.haToken = "ha-secret-token-0001"; club.state.cards = true; club.state.down = false; club.state.calls = []; club.state.shown.clear();
  ha.state.mode = "ok"; ha.state.calls = [];
  logs.length = 0;
  clock = ms(17, 0);
});

test("the schedule: minutes before and after, back-to-back joined, blocks and holds not lit, entities from the settings", () => {
  const ws = windows([{ start: local(18), end: local(19, 30), kind: "booking" }, { start: local(19, 30), end: local(21), kind: "booking" },
    { start: local(22), end: local(23), kind: "block" }, { start: local(16), end: local(17), kind: "hold" }, { start: local(8), end: local(9), kind: "booking", status: "cancelled" }], 10, 5);
  assert.deepEqual(ws, [{ start: ms(17, 50), end: ms(21, 5) }]);
  assert.equal(at(ws, ms(17, 49)).on, false);
  assert.equal(at(ws, ms(17, 50)).on, true);
  assert.equal(at(ws, ms(19, 30)).until, ms(21, 5));
  assert.equal(at(ws, ms(21, 5)).on, false);
  // Two bookings 10 minutes apart with 10 before and 5 after: the gap is covered, so the lights stay on.
  assert.equal(windows([{ start: local(18), end: local(19), kind: "booking" }, { start: local(19, 15), end: local(20), kind: "session" }], 10, 5).length, 1);
  assert.equal(windows([{ start: local(18), end: local(19), kind: "booking" }, { start: local(19, 30), end: local(20), kind: "mirror" }], 10, 5).length, 2);
  const s = parseSettings({ courts: ["c1"], lights: "Court 1 = light.one, Cancha Ñ = switch.cancha_n; bad line, Court 9 = rm -rf", minutes_before: 99 });
  assert.equal(s.before, 10, "out of range falls back to the default");
  assert.equal(s.problems.length, 2);
  assert.deepEqual(entitiesFor({ id: "c1", name: "Court 1" }, s), ["light.one"]);
  assert.deepEqual(entitiesFor({ id: "cx", name: "cancha ñ" }, s), ["switch.cancha_n"]);
  assert.deepEqual(entitiesFor({ id: "c3", name: "Pista Central 3" }, s), ["light.pista_central_3"]);
});

test("a registration is kept only when the club's key signs it; then the lights follow the bookings, back to back", async () => {
  await start();
  try {
    const forged = club.registration(clock, { stranger: true });
    assert.equal(await post("/register", forged.body, { "openpadel-signature-ed25519": forged.header }), 401);
    assert.equal(await post("/register", club.registration(clock).body, {}), 401, "no signature");
    const old = club.registration(clock - 3600_000);
    assert.equal(await post("/register", old.body, { "openpadel-signature-ed25519": old.header }), 401, "an old one replayed");
    assert.equal(p.runners.size, 0);

    club.state.items = [{ court_id: "c1", start: local(18), end: local(19, 30), kind: "booking" }, { court_id: "c1", start: local(19, 30), end: local(21), kind: "booking" }];
    await register();
    assert.equal(p.runners.size, 1);
    assert.equal(ha.state.calls.length, 0, "nothing before its time");
    await tickAt(ms(17, 49));
    assert.equal(ha.state.calls.length, 0);
    await tickAt(ms(17, 50));
    assert.deepEqual(ha.state.calls.map((c) => [c.service, c.entities]), [["light.turn_on", ["light.court_1"]]]);
    assert.equal(ha.state.calls[0]!.auth, "Bearer ha-secret-token-0001", "the key read through the door");
    for (const t of [ms(18, 30), ms(19, 30), ms(19, 31), ms(20, 0), ms(21, 0)]) await readAt(t);
    await tickAt(ms(21, 4));
    assert.equal(ha.offs().length, 0, "on through the change of booking");
    await tickAt(ms(21, 5));
    assert.deepEqual(ha.offs().map((c) => c.entities), [["light.court_1"]]);
    await tickAt(ms(21, 10));
    assert.equal(ha.state.calls.length, 2, "told once each way");
  } finally { await stop(); }
});

test("a cancelled booking turns its lights off; a booking whose event never came is caught by the next read", async () => {
  await start();
  try {
    club.state.items = [{ court_id: "c2", start: local(18), end: local(19), kind: "booking" }];
    await register();
    await tickAt(ms(17, 55));
    assert.deepEqual(ha.ons().map((c) => c.entities), [["light.c2_north", "light.c2_south"]], "court 2's lights from the settings");
    club.state.items = [];
    clock = ms(18, 5);
    assert.equal(await send("booking.cancelled", { booking_id: "b1" }), 200);
    assert.deepEqual(ha.offs().map((c) => c.entities), [["light.c2_north", "light.c2_south"]]);

    // A booking made with no event reaching the plugin: the read every few minutes finds it.
    club.state.items = [{ court_id: "c1", start: local(18, 30), end: local(19, 30), kind: "booking" }];
    await tickAt(ms(18, 21));
    assert.equal(ha.ons().length, 1, "not known yet");
    await readAt(ms(18, 22));
    assert.deepEqual(ha.ons().at(-1)!.entities, ["light.court_1"]);
  } finally { await stop(); }
});

test("events: a forged signature is refused, the same event twice is handled once, new settings take effect", async () => {
  await start();
  try {
    await register();
    const calls = () => club.state.calls.filter((c) => c.tool === "day").length;
    const before_ = calls();
    assert.equal(await send("booking.created", {}, { secret: "whsec_wrong" }), 401);
    assert.equal(calls(), before_, "a forged event reads nothing");
    const e = club.event(clock, "booking.created", {}, { id: "evt_1" });
    assert.equal(verifyWebhook("whsec_" + "w".repeat(32), e.header, e.body, Math.floor(clock / 1000)), true);
    assert.equal(await post("/events", e.body, { "openpadel-signature": e.header }), 200); await idle();
    const once = calls();
    assert.ok(once > before_);
    assert.equal(await post("/events", e.body, { "openpadel-signature": e.header }), 200, "a retry still gets its 2xx"); await idle();
    assert.equal(calls(), once, "and isn't handled again");
    const stale = club.event(clock - 3600_000, "booking.created");
    assert.equal(await post("/events", stale.body, { "openpadel-signature": stale.header }), 401, "replayed an hour later");

    // The club changes the settings: court 1 only, 20 minutes before.
    club.state.items = [{ court_id: "c1", start: local(18), end: local(19), kind: "booking" }];
    club.state.settings = { ...club.state.settings, courts: ["c1"], minutes_before: 20 };
    assert.equal(await send("plugin.configured", { plugin: "court-lights", settings: club.state.settings }), 200);
    await tickAt(ms(17, 40));
    assert.deepEqual(ha.ons().map((c) => c.entities), [["light.court_1"]]);
  } finally { await stop(); }
});

test("Home Assistant down: tried again with waits that grow, never turned off by an error, and the tile says so", async () => {
  await start();
  try {
    club.state.items = [{ court_id: "c1", start: local(18), end: local(19), kind: "booking" }];
    await register();
    ha.state.mode = "down";
    await tickAt(ms(17, 50));
    await tickAt(ms(17, 50, ) + 2_000);
    assert.equal(ha.state.calls.length, 0);
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 503, "health says it isn't working");
    const hb = await h.json() as any;
    assert.equal(hb.home_assistant.reachable, false);
    assert.ok(!JSON.stringify(hb).includes("Kestrel"), "health names no club");
    assert.equal(club.state.shown.get("c1").tone, "warn");
    assert.match(club.state.shown.get("c1").rows.find((r: any) => r.label.en === "Home Assistant").text.es, /No responde/);
    ha.state.mode = "ok";
    await readAt(ms(17, 50) + 6_000);
    assert.equal(ha.ons().length, 1, "on at the next try");
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal(club.state.shown.get("c1").tone, "ok");
    assert.deepEqual(club.state.shown.get("c1").rows[0], { label: { en: "Now", es: "Ahora" }, text: { en: "On until 7:05 PM", es: "Encendidas hasta las 7:05 p.m." } });

    // The club's door goes quiet during the booking: past its end the lights stay on (the last read is old), and go
    // off once the club answers again.
    await readAt(ms(18, 10));
    club.state.down = true;
    await readAt(ms(18, 40));
    await tickAt(ms(19, 6));
    assert.equal(ha.offs().length, 0, "an old schedule turns nothing off");
    club.state.down = false;
    await readAt(ms(19, 8));
    assert.equal(ha.offs().length, 1);
    assert.equal(club.state.shown.get("c1").tone, "off");
  } finally { await stop(); }
});

test("without the club's cards, and without its key yet, it carries on; with the key it acts", async () => {
  await start();
  try {
    club.state.cards = false; club.state.haToken = null;
    club.state.items = [{ court_id: "c1", start: local(18), end: local(19), kind: "booking" }];
    await register();
    await readAt(ms(17, 50));
    assert.equal(ha.state.calls.length, 0, "no key, nothing sent");
    assert.equal(runner().health().home_assistant.problem, "no_token");
    assert.equal((await fetch(`${base}/health`)).status, 200, "waiting for a key isn't down: doctor says which key");
    club.state.haToken = "ha-secret-token-0002";
    await readAt(ms(17, 52));
    assert.equal(ha.ons().length, 1);
    assert.equal(ha.ons()[0]!.auth, "Bearer ha-secret-token-0002");
    assert.ok(logs.some((l) => /doesn't show plugin cards yet/.test(l)));
    assert.equal(club.state.shown.size, 0);
  } finally { await stop(); }
});

test("kept across a restart in a file only it reads, with no token or key in its log", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "court-lights-")), "state");
  await start(fileStore(dir));
  try {
    club.state.items = [{ court_id: "c1", start: local(18), end: local(19), kind: "booking" }];
    await register();
    await tickAt(ms(17, 55));
    assert.equal(ha.ons().length, 1);
  } finally { await stop(); }
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.equal(statSync(join(dir, files[0]!)).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(dir, files[0]!), "utf8").includes(club.state.token), "the token is kept, for the restart");

  // Down through the booking's end; back up after it: it remembers turning them on, and turns them off.
  await start(fileStore(dir));
  try {
    assert.equal(p.runners.size, 1, "the registration kept");
    await readAt(ms(19, 30));
    assert.equal(ha.offs().length, 1);
  } finally { await stop(); }
  const all = logs.join("\n");
  for (const secret of [club.state.token, "whsec_", "opps_", "ha-secret-token"]) assert.ok(!all.includes(secret), `no ${secret.slice(0, 8)} in the log`);
});

test("the club's door down for good: lights stay on through the last known booking, and go off 2 hours after they were due off", async () => {
  await start();
  try {
    club.state.items = [{ court_id: "c1", start: local(18), end: local(19), kind: "booking" }, { court_id: "c2", start: local(21), end: local(22), kind: "booking" }];
    await register();
    await readAt(ms(17, 50));
    assert.equal(ha.ons().length, 1, "Court 1 on for its booking");
    club.state.down = true;
    await readAt(ms(18, 30));
    await tickAt(ms(19, 6));
    await tickAt(ms(21, 4));
    assert.equal(ha.offs().length, 0, "on for 2 hours after 7:05 PM, while the door doesn't answer");
    // Court 2's booking is still in the last schedule it read: its lights come on and stay on through it.
    assert.equal(ha.ons().length, 2);
    await tickAt(ms(21, 6));
    assert.deepEqual(ha.offs().map((c) => c.entities), [["light.court_1"]], "Court 1 off at the cutoff; Court 2 is mid-booking and stays on");
    await tickAt(ms(22, 30));
    assert.equal(ha.offs().length, 1, "Court 2 within 2 hours of its booking: still on");
    await tickAt(ms(24, 4));
    assert.equal(ha.offs().length, 1, "Court 2 still within 2 hours of 10:05 PM");
    await tickAt(ms(24, 6));
    assert.equal(ha.offs().length, 2, "Court 2 off at its own cutoff, past midnight");
    assert.ok(logs.some((l) => /cutoff/.test(l)), "it says why, once per court");
  } finally { await stop(); }
});

test("restarted with nothing kept (a sandboxed local plugin): a booking that ended a little while ago has its lights turned off", async () => {
  await start();
  try {
    club.state.items = [{ court_id: "c1", start: local(18), end: local(19), kind: "booking" }];
    await register();
    clock = ms(19, 20);
    await readAt(ms(19, 20));
    assert.deepEqual(ha.offs().map((c) => c.entities), [["light.court_1"]]);
    await readAt(ms(23, 0));
    assert.equal(ha.offs().length, 1, "once");
  } finally { await stop(); }
});

test("the release for a club's own server: the same bytes every time, its entry executable, pinned in its manifest", async () => {
  const { pack } = await import("../tools/pack.ts");
  const { execFileSync } = await import("node:child_process");
  const out = mkdtempSync(join(tmpdir(), "court-lights-pack-"));
  const a = pack({ releaseUrl: "https://example.test/court-lights-0.1.0.tar.gz", out: join(out, "a") });
  const b = pack({ releaseUrl: "https://example.test/court-lights-0.1.0.tar.gz", out: join(out, "b") });
  assert.equal(a.sha256, b.sha256, "reproducible");
  assert.deepEqual((a.manifest as any).run, { mode: "local", release_url: "https://example.test/court-lights-0.1.0.tar.gz", sha256: a.sha256, entry: "bin/start" });
  const listing = execFileSync("tar", ["-tvzf", a.file], { encoding: "utf8" });
  assert.match(listing, /^-rwxr-xr-x .* bin\/start$/m);
  assert.match(listing, / src\/main\.ts$/m);
  assert.ok(!/ test\//.test(listing) && !/ dist\//.test(listing), "only what it runs");
});

test("bin/start runs it as a local plugin from the environment the club writes, on the loopback", async () => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const a = (s.address() as { port: number }).port; s.close(() => r(a)); }); });
  club.state.items = [];
  const child = spawn(join(import.meta.dirname, "..", "bin", "start"), [], { stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH, PORT: String(port), OPENPADEL_URL: club.url, OPENPADEL_MCP: `${club.url}/mcp`, OPENPADEL_TOKEN: club.state.token,
      OPENPADEL_WEBHOOK_SECRET: "whsec_" + "w".repeat(32), OPENPADEL_HOOK_SECRET: "opps_x", OPENPADEL_PLUGIN: "court-lights" } });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  try {
    let h: Response | null = null;
    for (let i = 0; i < 50 && !h; i++) { h = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null); if (!h) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(h, err);
    for (let i = 0; i < 30 && !club.state.calls.some((c) => c.tool === "day"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(club.state.calls.some((c) => c.tool === "day"), "read the club's day on start");
    const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as any;
    assert.equal(body.courts, 2);
    assert.match(err, /court lights started/);
    const reg = club.registration(Date.now());
    assert.equal((await fetch(`http://127.0.0.1:${port}/register`, { method: "POST", body: reg.body, headers: { "openpadel-signature-ed25519": reg.header } })).status, 404, "a local plugin takes no registrations");
    assert.ok(!err.includes(club.state.token) && !err.includes("whsec_"), "nothing secret in its log");
  } finally { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); }
});
