// The court lights plugin (plugins/court-lights, a separate program) against the real club: installed through the door,
// its registration checked with the club's key, its settings and Home Assistant key read through its own tools, the
// day's bookings read with the role its manifest gave it, a cancellation's webhook acted on, and the club's lack of
// plugin cards (Round C) taken in its stride. Home Assistant is a fake on 127.0.0.1; the plugin listens there too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkManifestAtClub, fanOutWebhooks, localDate, parseManifest, run, runAsSystem, sendWebhooks, stageVaultUpload, type Actor, type Db } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { plugin, type Plugin } from "../../../plugins/court-lights/src/server.ts";
import { memoryStore } from "../../../plugins/court-lights/src/store.ts";
import { pack } from "../../../plugins/court-lights/tools/pack.ts";
import { unpack } from "../src/plugin_service.ts";
import { fakeHomeAssistant } from "../../../plugins/court-lights/test/fakes.ts";

const BASE = "https://club.example.test", TZ = "America/Los_Angeles";
const EXAMPLE = JSON.parse(readFileSync(new URL("../../../docs/plugins/examples/court-lights/openpadel-plugin.json", import.meta.url), "utf8"));
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, court = "", booking = "";
let lights: Plugin, server: Server, ha: Awaited<ReturnType<typeof fakeHomeAssistant>>, clock = Date.now();
const logs: string[] = [];
const tomorrow = () => localDate(new Date(Date.now() + 86400_000), TZ);
/** 10:00 tomorrow at the club, give or take minutes. */
const tenTomorrow = (min = 0) => new Date(new Date(`${tomorrow()}T10:00:00-08:00`).getTime() + min * 60_000).getTime();

before(async () => {
  ha = await fakeHomeAssistant();
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Main", time_zone: TZ }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  await run(db, "court.create", { location_id: loc, name: "Court 2" }, owner);
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "08:00", closes: "22:00" })) }, owner);
  const ann = ((await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner)).result as any).person_id;
  booking = ((await run(db, "booking.create", { court_id: court, starts_at: `${tomorrow()}T10:00:00-08:00`, minutes: 60, person_id: ann }, owner)).result as any).booking_id;
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
  // The plugin reaches the club (its door, its key) through the app; Home Assistant over the loopback.
  const viaApp = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    return u.startsWith(BASE) ? app.request(u, init) : fetch(url, init);
  }) as typeof fetch;
  lights = plugin({ store: memoryStore(), log: (level, msg, f = {}) => { logs.push(JSON.stringify({ level, msg, ...f })); }, fetch: viaApp, timers: false, now: () => clock });
  server = await lights.listen(0, "127.0.0.1");
});
after(async () => { lights.stop(); server.close(); ha.close(); await drop(); });

test("installed at the club, it reads its settings, key and the day through the door, and follows a booking and its cancellation", async () => {
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const up = await stageVaultUpload(db, owner.personId!, { kind: "secret", value: "ha-token-from-the-vault-4F2A" });
  await run(db, "vault.add", { name: "court-lights/HA_TOKEN", upload_id: up.upload_id }, { ...owner, auth: "passkey" });
  const r = await run(db, "plugin.install", { manifest: JSON.stringify({ ...EXAMPLE, run: { mode: "remote", url } }),
    settings: { home_assistant_url: ha.url, courts: "Court 1", minutes_before: 10, minutes_after: 5 } }, owner);
  assert.equal((r.result as any).registered, true, JSON.stringify(r.result));
  const runner = lights.runners.get(BASE)!;
  assert.ok(runner, "the registration checked with the club's key, and kept");
  await runner.idle();
  assert.equal(runner.health().reconcile_error, null, logs.join("\n"));
  assert.equal(runner.health().courts, 1);
  assert.equal(runner.health().home_assistant.reachable, true, "its key read through plugin_secret");

  clock = tenTomorrow(-11);
  await runner.serial(() => runner.tick(clock));
  assert.equal(ha.state.calls.length, 0);
  clock = tenTomorrow(-10);
  await runner.serial(() => runner.tick(clock));
  assert.deepEqual(ha.state.calls.map((c) => [c.service, c.entities, c.auth]), [["light.turn_on", ["light.court_1"], "Bearer ha-token-from-the-vault-4F2A"]]);

  // Cancelled at the desk: the club's webhook, signed, reaches the plugin, which reads the day again and turns them off.
  await run(db, "booking.cancel", { booking_id: booking, refund: "none" }, owner);
  await fanOutWebhooks(db);
  clock = tenTomorrow(5);
  const sent: number[] = [];
  await sendWebhooks(db, async (to, body, headers) => {
    const res = await fetch(to, { method: "POST", body, headers });
    sent.push(res.status);
    return res.status;
  }, new Date(clock));
  assert.ok(sent.length >= 1 && sent.every((s) => s === 200), JSON.stringify(sent));
  await runner.idle();
  assert.deepEqual(ha.state.calls.at(-1)!.service, "light.turn_off");
  assert.ok(logs.some((l) => /doesn't show plugin cards yet/.test(l)) || logs.every((l) => !/couldn't show/.test(l)), logs.join("\n"));
  assert.ok(!logs.join("\n").includes("opa_") && !logs.join("\n").includes("ha-token-from"), "no token or key in its log");
});

test("its release for a club's own server passes the club's manifest check and unpacks as plugin service does", async () => {
  const out = mkdtempSync(join(tmpdir(), "court-lights-release-"));
  const r = pack({ releaseUrl: "https://github.com/openpadel/plugin-court-lights/releases/download/v0.1.0/court-lights-0.1.0.tar.gz", out });
  const m = parseManifest(readFileSync(r.manifestFile, "utf8"));
  await checkManifestAtClub(db, m);
  assert.equal(m.run.mode, "local");
  const dir = join(out, "unpacked");
  unpack(readFileSync(r.file), dir, "bin/start");
  assert.ok(statSync(join(dir, "bin/start")).mode & 0o100, "its entry runs");
  assert.ok(statSync(join(dir, "src/main.ts")).isFile());
});
