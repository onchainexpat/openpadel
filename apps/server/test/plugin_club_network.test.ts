// One address on the club's own network a local plugin may reach (club_network.ts, decided 17 Nov 2026): a manifest
// marks at most one string setting `club_network`; a private address there is said in the preview's words, kept when
// the owner says yes, and let through in the plugin's service unit, and nothing else on the club's network is. This
// server, "every address", multicast and a name with several addresses are refused in words; a public address and a
// remote plugin need nothing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { apply, clubNetworkIp, hostOfSetting, ipKind, parseManifest, plan, run, runAsSystem, setNetworkIo, type Actor, type Db } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { servicePlan, unitFile } from "../src/plugin_service.ts";

const ROOT = new URL("../../../", import.meta.url);
const EXAMPLE = JSON.parse(readFileSync(new URL("docs/plugins/examples/court-lights/openpadel-plugin.json", ROOT), "utf8"));
const LOCAL = { mode: "local", release_url: "https://releases.example.test/court-lights.tgz", sha256: "a".repeat(64), entry: "bin/start" };
const local = (name = "lights-lan") => ({ ...EXAMPLE, $schema: undefined, name, run: LOCAL });
const PATHS = { root: "/opt/p", envDir: "/etc/p", unitDir: "/tmp" };
let db: Db, drop: () => Promise<void>, owner: Actor, manager: Actor, court = "";

before(async () => {
  ({ db, drop } = await freshDb());
  const setup = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (setup.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Main", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  court = ((await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  const jordan = ((await run(db, "person.create", { display_name: "Jordan Park", email: "jordan@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: jordan, role: "manager" }, owner);
  manager = { personId: jordan, via: "test", lang: "en" };
  setNetworkIo({
    own: () => ["127.0.0.1", "10.0.0.5", "::1"],
    resolve: async (h) => ({ "ha.club.lan": ["192.168.1.20"], "ha.public.test": ["203.0.113.9"], "both.club.lan": ["192.168.1.20", "192.168.1.21"], "me.club.lan": ["10.0.0.5"] } as Record<string, string[]>)[h] ?? Promise.reject(new Error("ENOTFOUND")),
  });
});
after(async () => { setNetworkIo(null); await drop(); });

test("a manifest may mark one string setting as its address on the club's network, and not two", () => {
  const m = parseManifest(local());
  assert.equal(m.settings.find((f) => f.key === "home_assistant_url" && f.type === "string" && f.club_network)?.key, "home_assistant_url");
  const two = local(); two.settings = [...two.settings, { key: "camera_url", type: "string", label: { en: "Camera", es: "Cámara" }, club_network: true }];
  assert.throws(() => parseManifest(two), (e: any) => e.code === "error.plugin_manifest" && /only one may be club_network/.test(e.text.en));
  const onInt = local(); onInt.settings = [...onInt.settings, { key: "n", type: "integer", label: { en: "N", es: "N" }, club_network: true }];
  assert.throws(() => parseManifest(onInt), (e: any) => e.code === "error.plugin_manifest");
});

test("which addresses count: private and link-local let through; this server, every address and multicast refused; public needs nothing", async () => {
  assert.equal(ipKind("192.168.1.20"), "private"); assert.equal(ipKind("172.31.0.1"), "private"); assert.equal(ipKind("169.254.3.4"), "private");
  assert.equal(ipKind("fd12::1"), "private"); assert.equal(ipKind("fe80::1"), "private"); assert.equal(ipKind("::ffff:10.1.2.3"), "private");
  assert.equal(ipKind("8.8.8.8"), "public"); assert.equal(ipKind("2001:db8::1"), "public");
  assert.equal(ipKind("127.0.0.53"), "loopback"); assert.equal(ipKind("::1"), "loopback");
  assert.equal(ipKind("0.0.0.0"), "unspecified"); assert.equal(ipKind("::"), "unspecified");
  assert.equal(ipKind("224.0.0.251"), "multicast"); assert.equal(ipKind("255.255.255.255"), "multicast"); assert.equal(ipKind("ff02::1"), "multicast");
  assert.equal(hostOfSetting("http://192.168.1.20:8123"), "192.168.1.20");
  assert.equal(hostOfSetting("192.168.1.20:8123"), "192.168.1.20");
  assert.equal(hostOfSetting("http://[fd12::1]:8123/"), "fd12::1");
  const m = parseManifest(local());
  const ip = (v: string) => clubNetworkIp(m, { home_assistant_url: v });
  assert.deepEqual((await ip("http://192.168.1.20:8123"))?.ip, "192.168.1.20");
  assert.deepEqual((await ip("http://ha.club.lan:8123"))?.ip, "192.168.1.20", "a name is resolved when the plan is made");
  assert.equal(await ip("https://ha.public.test"), null, "a public address needs nothing");
  assert.equal(await ip("https://203.0.113.9"), null);
  assert.equal(await clubNetworkIp({ ...m, run: { mode: "remote", url: "https://lights.example.test" } } as any, { home_assistant_url: "http://192.168.1.20" }), null, "a remote plugin isn't sandboxed here");
  const refused = async (v: string, why: RegExp) => {
    await assert.rejects(ip(v), (e: any) => e.code === "error.plugin_club_network" && why.test(e.text.en) && e.text.es.length > 10, v);
  };
  await refused("http://127.0.0.1:8123", /this server itself/);
  await refused("http://10.0.0.5", /this server itself/);
  await refused("http://me.club.lan", /this server itself/);
  await refused("http://[::1]:8123", /this server itself/);
  await refused("http://0.0.0.0:8123", /one device's address/);
  await refused("http://224.0.0.251", /one device's address/);
  await refused("http://both.club.lan", /more than one address/);
  await refused("http://nowhere.club.lan", /can't find that name/);
});

test("the unit lets the service through to that one IP and keeps the rest of the club's network shut; nothing else gets in", () => {
  const m = parseManifest(local());
  const shut = servicePlan(m, 47101, false, PATHS).unit;
  assert.ok(!/IPAddressAllow/.test(shut));
  const lines = servicePlan(m, 47101, false, PATHS, "192.168.1.20").unit.split("\n");
  assert.ok(lines.includes("IPAddressAllow=192.168.1.20/32"));
  assert.ok(lines.some((l) => l.startsWith("IPAddressDeny=10.0.0.0/8 ")), "the rest of the club's network stays denied");
  assert.equal(lines.filter((l) => l.startsWith("IPAddress")).length, 2);
  assert.ok(unitFile(m, "/opt/p", "/etc/p/x.env", 1, "fd12::1").split("\n").includes("IPAddressAllow=fd12::1/128"));
  for (const bad of ["192.168.1.20\nExecStartPre=+/bin/sh", "192.168.1.20/0", "8.8.8.8", "127.0.0.1", "0.0.0.0", "fe80::1%eth0\nUser=root", "any", ""]) {
    assert.throws(() => unitFile(m, "/opt/p", "/etc/p/x.env", 1, bad), /not a private IP/, JSON.stringify(bad));
  }
});

test("install, configure and update say it in words; the owner's yes keeps it; a manager asks; changing it says to write the service again", async () => {
  const m = local();
  const p = await plan(db, "plugin.install", { manifest: JSON.stringify(m), settings: { home_assistant_url: "http://192.168.1.20:8123", courts: [court] } }, owner);
  assert.match(p.plan.summary.en, /On the club's network: It can reach 192\.168\.1\.20 on the club's own network \(Home Assistant address\), and nothing else there\./);
  assert.match(p.plan.summary.es, /Puede llegar a 192\.168\.1\.20 en la red del propio club \(Dirección de Home Assistant\)/);
  await apply(db, p.runId, owner);
  const row = () => db.selectFrom("plugin").select(["club_network_ip", "settings"]).where("name", "=", "lights-lan").where("status", "!=", "removed").executeTakeFirstOrThrow();
  assert.equal((await row()).club_network_ip, "192.168.1.20");
  // Refused at the plan, in words, before anything is kept.
  await assert.rejects(plan(db, "plugin.configure", { plugin: "lights-lan", settings: { home_assistant_url: "http://127.0.0.1:8123" } }, owner), (e: any) => e.code === "error.plugin_club_network");
  // A manager asks; the owner's yes is what changes it.
  const asked = await plan(db, "plugin.configure", { plugin: "lights-lan", settings: { home_assistant_url: "http://ha.club.lan:8124" } }, manager);
  assert.notEqual(asked.status, "planned", "a manager's change to a plugin waits for the owner");
  const c = await plan(db, "plugin.configure", { plugin: "lights-lan", settings: { home_assistant_url: "http://192.168.1.30:8123" } }, owner);
  assert.match(c.plan.summary.en, /It can reach 192\.168\.1\.30 on the club's own network .* run sudo openpadel plugin service lights-lan --apply on the server and restart it\./);
  await apply(db, c.runId, owner);
  assert.equal((await row()).club_network_ip, "192.168.1.30");
  // Moving it to a public address takes it off the club's network, and says so.
  const pub = await plan(db, "plugin.configure", { plugin: "lights-lan", settings: { home_assistant_url: "https://ha.public.test" } }, owner);
  assert.match(pub.plan.summary.en, /It no longer reaches anything on the club's own network\./);
  await apply(db, pub.runId, owner);
  assert.equal((await row()).club_network_ip, null);
  // An update that keeps the setting keeps the address, and says nothing new about it.
  const back = await plan(db, "plugin.configure", { plugin: "lights-lan", settings: { home_assistant_url: "http://192.168.1.20:8123" } }, owner);
  await apply(db, back.runId, owner);
  const u = await plan(db, "plugin.update", { plugin: "lights-lan", manifest: JSON.stringify({ ...m, version: "0.2.0" }) }, owner);
  assert.doesNotMatch(u.plan.summary.en, /club's own network/);
  await apply(db, u.runId, owner);
  assert.equal((await row()).club_network_ip, "192.168.1.20");
  // An update whose new version drops the mark takes it off the club's network.
  const unmarked = { ...m, version: "0.3.0", settings: m.settings.map((f: any) => ({ ...f, club_network: undefined })) };
  const u2 = await plan(db, "plugin.update", { plugin: "lights-lan", manifest: JSON.stringify(unmarked) }, owner);
  assert.match(u2.plan.summary.en, /It no longer reaches anything on the club's own network\./);
  await apply(db, u2.runId, owner);
  assert.equal((await row()).club_network_ip, null);
});
