// The court camera plugin (plugins/court-camera, a separate program) against the real club: installed through the door
// with the documented manifest (the sample catalog's), a camera's highlight posted to the club's
// /plugins/court-camera/hook and passed on, checked against the vendor's secret read from the vault, matched to the
// booking on that court at that time through the `day` read its manifest opens, and its card shown on that game for
// its players and staff (in both languages) and nobody else. A forged notice is refused at the club's address too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { checkManifestAtClub, manifestRows, parseManifest, run, runAsSystem, stageVaultUpload, type Actor, type Db } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { plugin, type Plugin } from "../../../plugins/court-camera/src/server.ts";
import { memoryStore } from "../../../plugins/court-camera/src/store.ts";
import { signAsVendor } from "../../../plugins/court-camera/src/adapters/generic_http.ts";
import { pack } from "../../../plugins/court-camera/tools/pack.ts";
import { unpack } from "../src/plugin_service.ts";

const BASE = "https://club.example.test", TZ = "America/Los_Angeles", SECRET = "camsec_from_the_vault_7Q2B";
const EXAMPLE = JSON.parse(readFileSync(new URL("../../../docs/plugins/examples/court-camera/openpadel-plugin.json", import.meta.url), "utf8"));
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, cams: Plugin, server: Server;
let annGame = "", beaGame = "";
const people: Record<string, string> = {}, cookies: Record<string, string> = {}, logs: string[] = [];
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
/** The game's hour: it ended 20 minutes ago. */
const gameStart = () => new Date(Date.now() - 80 * 60_000), gameEnd = () => new Date(Date.now() - 20 * 60_000);

async function session(name: string, id: string) {
  const tok = `${name}-session`;
  await db.insertInto("web_session").values({ token_hash: sha(tok), person_id: id, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey" }).execute();
  cookies[name] = `kumi_session=${tok}`;
}
const get = async (who: string, path: string, lang = "en") => { const r = await app.request(`${BASE}${path}`, { headers: { cookie: cookies[who]!, "accept-language": lang } }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
/** What the camera system posts to the club's own address. */
const postHook = (notice: unknown, secret = SECRET) => {
  const body = JSON.stringify(notice);
  return app.request(`${BASE}/plugins/court-camera/hook`, { method: "POST", body, headers: { "content-type": "application/json", "camera-signature": signAsVendor(secret, body) } });
};

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  const loc = ((await run(db, "location.create", { name: "Main", time_zone: TZ }, owner)).result as any).location_id;
  const c1 = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  const c2 = ((await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner)).result as any).court_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "00:00", closes: "24:00" })) }, owner);
  for (const name of ["Ann", "Bea", "Cal", "Dee"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Dee!, role: "front_desk" }, owner);
  for (const n of ["Ann", "Bea", "Cal", "Dee"]) await session(n, people[n]!);
  // Ann's game on Court 2 and Bea's on Court 1, at the same hour. Made for tomorrow, then moved to the hour just gone
  // (a booking can't be made in the past).
  const tomorrow = new Date(Date.now() + 2 * 864e5);
  tomorrow.setUTCMinutes(0, 0, 0);
  annGame = ((await run(db, "booking.create", { court_id: c2, starts_at: tomorrow.toISOString(), minutes: 60, person_id: people.Ann }, owner)).result as any).booking_id;
  beaGame = ((await run(db, "booking.create", { court_id: c1, starts_at: tomorrow.toISOString(), minutes: 60, person_id: people.Bea }, owner)).result as any).booking_id;
  for (const b of [annGame, beaGame]) await sql`UPDATE court_time SET during = tstzrange(${gameStart()}, ${gameEnd()}) WHERE booking_id = ${b}`.execute(db);
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
  // The plugin reaches the club (its door, its key) through the app; the club reaches the plugin over the loopback.
  const viaApp = (async (url: string | URL | Request, init?: RequestInit) => (String(url).startsWith(BASE) ? app.request(String(url), init) : fetch(url, init))) as typeof fetch;
  cams = plugin({ store: memoryStore(), log: (level, msg, f = {}) => { logs.push(JSON.stringify({ level, msg, ...f })); }, fetch: viaApp, timers: false });
  server = await cams.listen(0, "127.0.0.1");
});
after(async () => { cams.stop(); server.close(); await drop(); });

test("the manifest: the sample catalog's, and the install preview says what goes to the camera system and who posts to the club", async () => {
  const m = parseManifest(JSON.stringify(EXAMPLE));
  await checkManifestAtClub(db, m);
  const sample = JSON.parse(readFileSync(new URL("../../../packages/core/src/plugin_catalog.sample.json", import.meta.url), "utf8"));
  const { $schema: _, ...bare } = EXAMPLE;
  assert.deepEqual(sample.plugins.find((p: any) => p.manifest.name === "court-camera").manifest, bare, "the sample catalog has the documented example");
  const rows = manifestRows(m).map((r) => `${r.label.en}: ${r.text.en}`);
  assert.ok(rows.some((r) => r.startsWith("It sends: Only when the club turns it on: each booking's court") && r.includes("No names, emails or phone numbers") && r.includes("kept by the camera system")), rows.join("\n"));
  assert.ok(rows.some((r) => r.includes("CAMERA_API_KEY") && r.includes("only when")), rows.join("\n"));
  assert.ok(rows.some((r) => r.includes("/plugins/court-camera/hook")), rows.join("\n"));
  assert.ok(manifestRows(m).every((r) => !/[—–]/.test(r.text.en + r.text.es)));
});

test("installed at the club, a camera's highlight posted to the club reaches the plugin and shows on the right game, for its players only", async () => {
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const up = await stageVaultUpload(db, owner.personId!, { kind: "secret", value: SECRET });
  await run(db, "vault.add", { name: "court-camera/CAMERA_WEBHOOK_SECRET", upload_id: up.upload_id }, owner);
  const r = await run(db, "plugin.install", { manifest: JSON.stringify({ ...EXAMPLE, run: { mode: "remote", url } }), settings: { courts: "Court 1, Court 2", cameras: "Court 2 = cam-02" } }, owner);
  assert.equal((r.result as any).registered, true, JSON.stringify(r.result));
  const runner = cams.runners.get(BASE)!;
  assert.ok(runner, "the registration checked with the club's key, and kept");
  await runner.idle();
  assert.equal(runner.health().reconcile_error, null, logs.join("\n"));
  assert.equal(runner.health().cameras, 2);

  // The camera on Court 2, 30 minutes into the hour: Ann's game, not Bea's on Court 1.
  const at = new Date(gameStart().getTime() + 30 * 60_000);
  const res = await postHook({ type: "highlight.ready", id: "clip_1", camera_id: "cam-02", started_at: at.toISOString(), ended_at: new Date(at.getTime() + 42_000).toISOString(),
    url: "https://clips.cameras.example/c/clip_1.mp4", duration_seconds: 42 });
  const answer = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(answer) + logs.join("\n"));
  assert.deepEqual(answer.results, [{ id: "clip_1", result: "shown" }]);
  await postHook({ type: "game_stats.ready", id: "stats_1", camera_id: "cam-02", started_at: gameStart().toISOString(), ended_at: gameEnd().toISOString(),
    stats: [{ key: "rallies", value: 61 }, { key: "top_speed_kmh", value: 104 }] });

  const ann = await get("Ann", `/matches/${annGame}/cards`);
  assert.equal(ann.status, 200);
  assert.deepEqual(ann.json.map((c: any) => [c.plugin, c.title, c.rows.map((x: any) => `${x.label}: ${x.text}`), c.link]),
    [["court-camera", "Video and stats", ["Highlights: 1 clip, 0:42", "Rallies: 61", "Fastest shot: 104 km/h"], { url: "https://clips.cameras.example/c/clip_1.mp4", label: "Watch the highlight" }]]);
  // Ann reads the app in Spanish.
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", people.Ann!).execute();
  const es = await get("Ann", `/matches/${annGame}/cards`, "es");
  await db.updateTable("person").set({ locale: "en" }).where("id", "=", people.Ann!).execute();
  assert.deepEqual(es.json.map((c: any) => [c.title, c.rows.map((x: any) => `${x.label}: ${x.text}`), c.link.label]),
    [["Video y estadísticas", ["Jugadas destacadas: 1 video, 0:42", "Peloteos: 61", "Golpe más rápido: 104 km/h"], "Ver la jugada destacada"]]);
  assert.equal((await get("Cal", `/matches/${annGame}/cards`)).status, 404, "not in the game: as if it weren't there");
  assert.deepEqual((await get("Bea", `/matches/${beaGame}/cards`)).json, [], "Bea's game on Court 1 has none");
  assert.equal((await get("Dee", `/staff/bookings/${annGame}/cards`)).json[0].rows[0].text, "1 clip, 0:42", "the desk sees it on the schedule");

  // A notice the vendor's secret didn't sign is refused at the club's own address, and changes nothing.
  const forged = await postHook({ type: "highlight.ready", id: "clip_x", camera_id: "court_1", started_at: at.toISOString(), url: "https://evil.example/x.mp4" }, "camsec_guess");
  assert.equal(forged.status, 401);
  assert.deepEqual((await get("Bea", `/matches/${beaGame}/cards`)).json, []);
  assert.ok(!logs.join("\n").includes("opa_") && !logs.join("\n").includes(SECRET), "no token or secret in its log");
});

test("its release for a club's own server passes the club's manifest check and unpacks as plugin service does", async () => {
  const out = mkdtempSync(join(tmpdir(), "court-camera-release-"));
  const r = pack({ releaseUrl: "https://github.com/onchainexpat/openpadel/releases/download/plugin-court-camera-v0.1.0/court-camera-0.1.0.tar.gz", out });
  const m = parseManifest(readFileSync(r.manifestFile, "utf8"));
  await checkManifestAtClub(db, m);
  assert.equal(m.run.mode, "local");
  const dir = join(out, "unpacked");
  unpack(readFileSync(r.file), dir, "bin/start");
  assert.ok(statSync(join(dir, "bin/start")).mode & 0o100, "its entry runs");
  assert.ok(statSync(join(dir, "src/adapters/generic_http.ts")).isFile());
});
