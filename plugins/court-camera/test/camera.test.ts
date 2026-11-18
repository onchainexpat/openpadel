// The court camera plugin against a fake club and a fake camera vendor: a signed registration (a forged one refused), a
// highlight matched to the right game and shown on its card, one for an empty court ignored, a late clip, a forged
// vendor signature and a notice that didn't come through the club refused, notices waiting while the club's door is
// down, the vendor told each booking's times (and nothing else) and the vendor down, and its state kept across a restart
// without a secret in a log.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { plugin, type Plugin } from "../src/server.ts";
import { fileStore, memoryStore, type Store } from "../src/store.ts";
import { cameraFor, matchBooking, parseSettings, sessionId } from "../src/match.ts";
import { cardFor, length } from "../src/words.ts";
import { genericHttp } from "../src/adapters/generic_http.ts";
import { B1, B2, B3, C1, C2, fakeClub, fakeVendor, local, ms, VENDOR_SECRET } from "./fakes.ts";

let club: Awaited<ReturnType<typeof fakeClub>>, vendor: Awaited<ReturnType<typeof fakeVendor>>;
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
  return { status: r.status, json: await r.json() as any };
}
async function register() {
  const r = club.registration(clock);
  assert.equal((await post("/register", r.body, { "openpadel-signature-ed25519": r.header })).status, 200);
  await idle();
}
/** A camera's notice, through the club's /plugins/court-camera/hook (as the club passes it on). */
async function hook(notice: unknown, o: { vendorSecret?: string; clubSecret?: string } = {}) {
  const h = club.hook(clock, notice, o);
  return post("/hook", h.body, h.headers);
}
const highlight = (camera: string, startHH: number, startMM: number, o: Record<string, unknown> = {}) => ({ type: "highlight.ready", id: `clip_${camera}_${startHH}${startMM}`, camera_id: camera,
  started_at: local(startHH, startMM), ended_at: new Date(ms(startHH, startMM) + 45_000).toISOString(), url: `https://clips.example/${camera}/${startHH}${startMM}.mp4`, duration_seconds: 45, ...o });
async function tickAt(t: number) { clock = t; await runner().serial(() => runner().tick(clock)); }
async function readAt(t: number) { clock = t; await runner().serial(() => runner().reconcile(clock)); }

before(async () => { club = await fakeClub(); vendor = await fakeVendor(); });
after(() => { club.close(); vendor.close(); });
beforeEach(() => {
  club.state.items = [
    { court_id: C1, start: local(18), end: local(19, 30), kind: "booking", status: "confirmed", booking_id: B1 },
    { court_id: C2, start: local(18), end: local(19, 30), kind: "booking", status: "confirmed", booking_id: B2 },
    { court_id: C2, start: local(19, 30), end: local(21), kind: "booking", status: "confirmed", booking_id: B3 },
  ];
  club.state.settings = { courts: [C1, C2], cameras: "Court 2 = cam-02" };
  club.state.secrets = { CAMERA_WEBHOOK_SECRET: VENDOR_SECRET, CAMERA_API_KEY: "cam-api-key-0042" };
  club.state.cards = true; club.state.down = false; club.state.calls = []; club.state.shown.clear();
  vendor.state.mode = "ok"; vendor.state.calls = []; vendor.state.sessions.clear();
  logs.length = 0;
  clock = ms(20, 0);
});

test("matching: inside a booking, a little early or late, back to back, an empty court, the session sent back", () => {
  const items = club.state.items.filter((i) => i.court_id === C2).map(({ court_id: _, ...i }) => i);
  assert.equal(matchBooking(items, ms(18, 40)), B2);
  assert.equal(matchBooking(items, ms(17, 56)), B2, "the camera starts a few minutes early");
  assert.equal(matchBooking(items, ms(17, 50)), null, "too early: nobody had the court");
  assert.equal(matchBooking(items, ms(19, 30)), B3, "on the change of booking: the one starting");
  assert.equal(matchBooking(items, ms(19, 29)), B2);
  assert.equal(matchBooking(items, ms(21, 10)), B3, "the last point, after the hour");
  assert.equal(matchBooking(items, ms(21, 20)), null);
  assert.equal(matchBooking([...items, { start: local(22), end: local(23), kind: "booking", status: "cancelled", booking_id: B1 }], ms(22, 30)), null, "a cancelled booking isn't a game");
  assert.equal(matchBooking([{ start: local(22), end: local(23), kind: "session" }, { start: local(22), end: local(23), kind: "block" }], ms(22, 30)), null);
  assert.equal(matchBooking(items, ms(19, 25), { session: sessionId("k", B3), key: "k" }), B3, "the session the camera was told wins");
  assert.match(sessionId("k", B3), /^ses_[0-9a-f]{32}$/);
  assert.ok(!sessionId("k", B3).includes(B3.replace(/-/g, "").slice(0, 8)), "the booking's own id isn't sent");

  const s = parseSettings({ courts: [C1], cameras: "Court 1 = cam-01; Cancha Ñ = cam.n:2, bad line, Court 9 = rm -rf /", tell_cameras: true, vendor_url: "ftp://x" });
  assert.equal(s.problems.length, 3, s.problems.join("; "));
  assert.equal(s.vendorUrl, null);
  assert.equal(cameraFor({ id: C1, name: "Court 1" }, s), "cam-01");
  assert.equal(cameraFor({ id: "x", name: "cancha ñ" }, s), "cam.n:2");
  assert.equal(cameraFor({ id: "y", name: "Pista Central 3" }, s), "pista_central_3");
});

test("the card's words, in both languages: clips and their length, stats with openPadel's words or the vendor's, no dashes", () => {
  assert.equal(length(45), "0:45"); assert.equal(length(130), "2:10"); assert.equal(length(3723), "1:02:03");
  const one = cardFor([{ id: "a", url: "https://v/a", seconds: 45, start: 1 }], null);
  assert.deepEqual(one.rows, [{ label: { en: "Highlights", es: "Jugadas destacadas" }, text: { en: "1 clip, 0:45", es: "1 video, 0:45" } }]);
  assert.deepEqual(one.link, { url: "https://v/a", label: { en: "Watch the highlight", es: "Ver la jugada destacada" } });
  const many = cardFor([{ id: "a", url: "https://v/a", seconds: 45, start: 2 }, { id: "b", url: "https://v/b", seconds: 85, start: 1 }],
    { id: "s", url: "https://v/game", stats: [{ key: "rallies", value: 54 }, { key: "longest_rally_shots", value: 23 }, { key: "distance_m", value: 1840 },
      { key: "lobs", value: 7, label: { en: "Lobs — all", es: "Globos" } }, { key: "mystery", value: 3 }, { key: "top_speed_kmh", value: 112 }, { key: "smashes", value: 4 }] });
  const en = many.rows.map((r) => `${r.label.en}: ${r.text.en}`), es = many.rows.map((r) => `${r.label.es}: ${r.text.es}`);
  assert.deepEqual(en, ["Highlights: 2 clips, 2:10 in all", "Rallies: 54", "Longest rally: 23 shots", "Distance run: 1.8 km", "Lobs, all: 7", "Fastest shot: 112 km/h"]);
  assert.deepEqual(es.slice(0, 3), ["Jugadas destacadas: 2 videos, 2:10 en total", "Peloteos: 54", "Peloteo más largo: 23 golpes"]);
  assert.equal(many.rows.length, 6, "at most six rows; a stat without words in both languages is left out");
  assert.deepEqual(many.link, { url: "https://v/game", label: { en: "Watch the highlights", es: "Ver las jugadas destacadas" } });
  assert.ok(many.rows.every((r) => !/[–—]/.test(r.label.en + r.label.es + r.text.en + r.text.es)));
  assert.equal(cardFor([], { id: "s", url: "https://v/g", stats: [] }).link!.label.es, "Ver las estadísticas del partido");
});

test("the generic HTTP adapter: its signature, its shapes, and what it refuses", () => {
  const body = JSON.stringify(highlight("cam-02", 18, 30)), t = Math.floor(ms(20) / 1000);
  const sig = club.hook(ms(20), JSON.parse(body)).headers["camera-signature"];
  assert.ok(genericHttp.verify({ "camera-signature": sig }, body, VENDOR_SECRET, t));
  assert.ok(!genericHttp.verify({ "camera-signature": sig }, body + " ", VENDOR_SECRET, t), "a changed body");
  assert.ok(!genericHttp.verify({ "camera-signature": sig }, body, "camsec_other", t), "another secret");
  assert.ok(!genericHttp.verify({ "camera-signature": sig }, body, VENDOR_SECRET, t + 3600), "an old one replayed");
  assert.ok(!genericHttp.verify({}, body, VENDOR_SECRET, t));
  const [n] = genericHttp.parse(body);
  assert.deepEqual([n!.kind, n!.camera, n!.seconds, n!.url, n!.end! - n!.start], ["highlight", "cam-02", 45, "https://clips.example/cam-02/1830.mp4", 45_000]);
  assert.equal(genericHttp.parse(JSON.stringify({ type: "ping" })).length, 0, "a ping is answered and ignored");
  assert.equal(genericHttp.parse(JSON.stringify({ notices: [highlight("cam-02", 18, 30), { type: "game_stats.ready", id: "s1", camera_id: "cam-02", started_at: local(18), stats: [{ key: "rallies", value: 3 }, { key: "Bad Key", value: 1 }] }] }))[1]!.stats.length, 1);
  for (const bad of ["not json", JSON.stringify(highlight("cam-02", 18, 30, { url: "http://clips.example/x.mp4" })), JSON.stringify(highlight("cam-02", 18, 30, { url: "javascript:alert(1)" })),
    JSON.stringify({ type: "highlight.ready", id: "x", camera_id: "c" }), JSON.stringify(highlight("cam-02", 18, 30, { url: undefined }))])
    assert.throws(() => genericHttp.parse(bad), (e: any) => e.status === 400, bad);
});

test("a registration is kept only when the club's key signs it; then a highlight finds its game, and its card shows for the players", async () => {
  await start();
  try {
    const forged = club.registration(clock, { stranger: true });
    assert.equal((await post("/register", forged.body, { "openpadel-signature-ed25519": forged.header })).status, 401);
    assert.equal(p.runners.size, 0);
    await register();
    assert.equal(runner().health().cameras, 2, "Court 1 by its name (court_1), Court 2 by the setting (cam-02)");

    // Both courts were busy at 18:30: the camera on Court 2 is Court 2's game.
    const r = await hook(highlight("cam-02", 18, 30));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.results, [{ id: "clip_cam-02_1830", result: "shown" }]);
    assert.deepEqual([...club.state.shown.keys()], [B2]);
    const card = club.state.shown.get(B2);
    assert.equal(card.slot, "game");
    assert.deepEqual(card.rows[0], { label: { en: "Highlights", es: "Jugadas destacadas" }, text: { en: "1 clip, 0:45", es: "1 video, 0:45" } });
    assert.equal(card.link.url, "https://clips.example/cam-02/1830.mp4");

    // Another clip of the same game, the same clip again (re-cut), then the game's stats: one card, kept up to date.
    await hook(highlight("cam-02", 19, 10, { duration_seconds: 85 }));
    await hook(highlight("cam-02", 19, 10, { duration_seconds: 85 }));
    await hook({ type: "game_stats.ready", id: "stats_b2", camera_id: "cam-02", started_at: local(18), ended_at: local(19, 30), url: "https://clips.example/games/b2",
      stats: [{ key: "rallies", value: 54 }, { key: "longest_rally_shots", value: 23 }] });
    const after = club.state.shown.get(B2);
    assert.deepEqual(after.rows.map((x: any) => x.text.en), ["2 clips, 2:10 in all", "54", "23 shots"]);
    assert.deepEqual(after.link, { url: "https://clips.example/games/b2", label: { en: "Watch the highlights", es: "Ver las jugadas destacadas" } });
    assert.equal(club.state.shown.size, 1);
    // Court 1's camera, by its name: Court 1's game.
    assert.deepEqual((await hook(highlight("court_1", 18, 45))).json.results[0].result, "shown");
    assert.ok(club.state.shown.has(B1));
    assert.equal(runner().health().games_shown, 2);
  } finally { await stop(); }
});

test("a clip for an empty court, or from a camera the club didn't set up, is answered and dropped; a late clip still finds its game", async () => {
  await start();
  try {
    await register();
    const empty = await hook(highlight("court_1", 17, 0));
    assert.deepEqual(empty.json.results, [{ id: "clip_court_1_170", result: "empty" }], "Court 1 was free at 17:00");
    assert.deepEqual((await hook(highlight("cam-99", 18, 30))).json.results[0].result, "unknown_camera");
    assert.equal(club.state.shown.size, 0);
    assert.deepEqual(runner().rec.games, {}, "nothing kept about an empty court");

    // The clip from the last point (10 minutes after the hour) comes the next morning: still the 19:30 to 21:00 game.
    clock = ms(24 + 9, 0);
    const late = await hook(highlight("cam-02", 21, 10));
    assert.deepEqual(late.json.results[0].result, "shown");
    assert.ok(club.state.shown.has(B3));
    assert.ok(club.state.calls.some((c) => c.tool === "day" && c.args.date === "2026-11-17"), "it read the day the game was played");
    // Past the grace: nobody's.
    assert.deepEqual((await hook(highlight("cam-02", 21, 30))).json.results[0].result, "empty");
    // Weeks later: dropped as too old; and a clip from the future is no game's.
    clock = ms(24 * 20, 0);
    assert.deepEqual((await hook(highlight("cam-02", 18, 30))).json.results[0].result, "too_old");
    clock = ms(18, 0);
    assert.deepEqual((await hook(highlight("cam-02", 19, 0))).json.results[0].result, "future");
  } finally { await stop(); }
});

test("a forged vendor signature, or a notice that didn't come through the club, is refused; with no secret in the vault it says so", async () => {
  await start();
  try {
    await register();
    const forged = await hook(highlight("cam-02", 18, 30), { vendorSecret: "camsec_" + "x".repeat(32) });
    assert.equal(forged.status, 401);
    assert.equal(forged.json.error, "bad_signature");
    const around = await hook(highlight("cam-02", 18, 30), { clubSecret: "opps_" + "z".repeat(32) });
    assert.equal(around.status, 401, "posted straight to the plugin, not through the club");
    assert.equal(club.state.shown.size, 0);
    assert.ok(logs.some((l) => /signature didn't check/.test(l)));

    // The owner puts a new secret in the vault: the plugin reads it again once, and takes notices signed with it.
    club.state.secrets.CAMERA_WEBHOOK_SECRET = "camsec_" + "n".repeat(32);
    assert.equal((await hook(highlight("cam-02", 18, 30), { vendorSecret: "camsec_" + "n".repeat(32) })).status, 200);
    club.state.secrets.CAMERA_WEBHOOK_SECRET = null;
    p.runners.get(club.url)!.replace({ ...runner().rec });   // forgets the secret it read, as a reinstall does
    const none = await hook(highlight("cam-02", 18, 40));
    assert.deepEqual([none.status, none.json.error], [503, "not_set_up"]);
  } finally { await stop(); }
});

test("notices that come while the club's door is down wait, and are shown on the next read that works", async () => {
  await start();
  try {
    await register();
    await hook(highlight("cam-02", 18, 30));   // reads the vendor's secret while the door answers
    club.state.down = true;
    const r = await hook(highlight("cam-02", 19, 45));
    assert.deepEqual([r.status, r.json.results[0].result], [200, "waiting"]);
    assert.equal(runner().health().waiting, 1);
    await readAt(ms(20, 5));
    assert.equal(runner().health().waiting, 1, "still down");
    assert.ok(runner().health().reconcile_error);
    club.state.down = false;
    await readAt(ms(20, 10));
    assert.equal(runner().health().waiting, 0);
    assert.ok(club.state.shown.has(B3), "the 19:45 clip is the 19:30 game's");

    // A club whose openPadel shows no plugin cards: the clip is kept, and shown once it does.
    club.state.cards = false;
    assert.equal((await hook(highlight("court_1", 18, 15))).json.results[0].result, "matched");
    assert.ok(!club.state.shown.has(B1));
    club.state.cards = true;
    await readAt(ms(21, 30));   // an hour later it asks again
    assert.ok(club.state.shown.has(B1));
  } finally { await stop(); }
});

test("told the cameras: each booking's camera, start and end, and nothing else; moved, cancelled, and the vendor down then back", async () => {
  await start();
  try {
    club.state.settings = { courts: [C1, C2], cameras: "Court 2 = cam-02", tell_cameras: true, vendor_url: vendor.url };
    clock = ms(17, 0);
    await register();
    assert.deepEqual(vendor.state.calls.map((c) => [c.method, c.body?.camera_id]), [["PUT", "court_1"], ["PUT", "cam-02"], ["PUT", "cam-02"]]);
    const put = vendor.state.calls.find((c) => c.body?.camera_id === "court_1")!;
    assert.deepEqual(Object.keys(put.body).sort(), ["camera_id", "ends_at", "session_id", "starts_at"], "court, times and an id: no names");
    assert.deepEqual([put.body.starts_at, put.body.ends_at, put.auth], [local(18), local(19, 30), "Bearer cam-api-key-0042"]);
    assert.equal(put.body.session_id, sessionId("opps_" + "h".repeat(32), B1));
    await readAt(ms(17, 5));
    assert.equal(vendor.state.calls.length, 3, "told once");

    // The highlight the camera tags with the session it was told: that game, even a minute into the next one.
    clock = ms(19, 40);
    assert.equal((await hook(highlight("cam-02", 19, 31, { session_id: sessionId("opps_" + "h".repeat(32), B2) }))).json.results[0].result, "shown");
    assert.ok(club.state.shown.has(B2) && !club.state.shown.has(B3));
    clock = ms(17, 5);

    // The vendor goes down; B1 moves to 18:30 and B3 is cancelled.
    vendor.state.mode = "down";
    club.state.items[0] = { ...club.state.items[0]!, start: local(18, 30), end: local(20) };
    club.state.items.splice(2, 1);
    const e = club.event(clock, "booking.moved", { booking_id: B1 });
    assert.equal((await post("/events", e.body, { "openpadel-signature": e.header })).status, 200);
    await idle();
    assert.equal(runner().health().vendor.reachable, false);
    assert.equal(runner().health().vendor.problem, "unreachable");
    assert.equal((await fetch(`${base}/health`)).status, 503);
    const before = vendor.state.calls.length;
    await tickAt(ms(17, 5) + 1_000);
    assert.equal(vendor.state.calls.length, before, "it waits before trying again");
    vendor.state.mode = "ok";
    await tickAt(ms(17, 5) + 6_000);
    const now = vendor.state.calls.slice(before).map((c) => [c.method, c.body?.starts_at ?? null]);
    assert.deepEqual(now, [["PUT", local(18, 30)], ["DELETE", null]], "the move, then the cancellation, once the vendor answers");
    assert.equal(runner().health().vendor.reachable, true);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.deepEqual([...vendor.state.sessions.values()].map((s) => s.camera_id).sort(), ["cam-02", "court_1"]);

    // A key the vendor refuses: said, and read again from the vault.
    vendor.state.mode = "refuse";
    club.state.items.push({ court_id: C1, start: local(21), end: local(22), kind: "booking", status: "confirmed", booking_id: B3 });
    await readAt(ms(17, 10));
    assert.equal(runner().health().vendor.problem, "refused");

    // Turned off: what it told the cameras is taken back.
    vendor.state.mode = "ok";
    club.state.settings = { ...club.state.settings, tell_cameras: false };
    await readAt(ms(17, 20));
    assert.equal(vendor.state.sessions.size, 0);
    assert.deepEqual(runner().rec.told, {});
    assert.ok(!logs.some((l) => l.includes("cam-api-key") || l.includes(VENDOR_SECRET) || l.includes(club.state.token)), "no key in a log");
  } finally { await stop(); }
});

test("its games and what it told the cameras are kept across a restart, readable by its own user only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "court-camera-"));
  await start(fileStore(join(dir, "state")));
  try {
    await register();
    await hook(highlight("cam-02", 18, 30));
  } finally { await stop(); }
  const files = readdirSync(join(dir, "state")).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.equal(statSync(join(dir, "state", files[0]!)).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700);
  await start(fileStore(join(dir, "state")));
  try {
    assert.equal(p.runners.size, 1);
    club.state.shown.clear();
    await hook(highlight("cam-02", 19, 0));
    assert.deepEqual(club.state.shown.get(B2).rows[0].text.en, "2 clips, 1:30 in all", "the first clip remembered");
  } finally { await stop(); }
});
