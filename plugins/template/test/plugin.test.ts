// The plugin against a fake club: a forged registration refused and the club's kept, its card shown, an event read
// again (once, however many times it comes), a forged event refused, a club without cards yet, and its health.
// Keep these as you change the plugin: openPadel's own test suite runs them on this template.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { plugin, REFRESH_MS, type Plugin } from "../src/plugin.ts";
import { fakeClub } from "./fake_club.ts";

let club: Awaited<ReturnType<typeof fakeClub>>, p: Plugin, server: Server, base = "", clock = Date.now();
const stateDir = mkdtempSync(join(tmpdir(), "plugin-state-"));
const post = (path: string, m: { body: string; header: string }, header: string) =>
  fetch(`${base}${path}`, { method: "POST", body: m.body, headers: { "content-type": "application/json", [header]: m.header } }).then((r) => r.status);
const idle = () => p.runners.get(club.url)!.idle();
const rows = () => club.state.card.rows.map((r: any) => `${r.label.en}: ${r.text.en} / ${r.text.es}`);

before(async () => {
  club = await fakeClub();
  p = plugin({ log: () => {}, allowHttp: true, now: () => clock, stateDir });
  server = await p.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
after(() => { p.stop(); server.close(); club.close(); });

test("a registration is kept only when the club's key signs it, and then the card shows", async () => {
  assert.equal(await post("/register", club.registration(clock, { stranger: true }), "openpadel-signature-ed25519"), 401);
  assert.equal(await post("/register", club.registration(clock - 3600_000), "openpadel-signature-ed25519"), 401, "an old one replayed");
  assert.equal(p.runners.size, 0);
  club.state.items = [{ kind: "booking" }, { kind: "booking", status: "cancelled" }, { kind: "block" }];
  assert.equal(await post("/register", club.registration(clock), "openpadel-signature-ed25519"), 200);
  await idle();
  assert.deepEqual(rows(), ["Main: 1 booking today / 1 reserva hoy"]);
  assert.equal(club.state.card.slot, "connectors");
  assert.equal(statSync(join(stateDir, "clubs.json")).mode & 0o777, 0o600, "its token kept for its user alone");
});

test("an event reads the club again, once; a forged one is refused", async () => {
  club.state.items.push({ kind: "booking" });
  club.state.calls = [];
  assert.equal(await post("/events", club.event(clock, "booking.created", {}, { id: "evt_1" }), "openpadel-signature"), 200);
  await idle();
  assert.deepEqual(rows(), ["Main: 2 bookings today / 2 reservas hoy"]);
  const reads = club.state.calls.length;
  assert.equal(await post("/events", club.event(clock, "booking.created", {}, { id: "evt_1" }), "openpadel-signature"), 200);
  await idle();
  assert.equal(club.state.calls.length, reads, "the same event twice is handled once");
  assert.equal(await post("/events", club.event(clock, "booking.created", {}, { secret: "whsec_forged" }), "openpadel-signature"), 401);
  // Its settings, when the club changes them.
  club.state.settings = { label: "games" };
  assert.equal(await post("/events", club.event(clock, "plugin.configured", { settings: club.state.settings }), "openpadel-signature"), 200);
  await idle();
  assert.deepEqual(rows(), ["Main: 2 games today / 2 games hoy"]);
});

test("a club without cards yet, and the door down: it carries on, and its health says so", async () => {
  club.state.cards = false;
  club.state.items.push({ kind: "booking" });
  await post("/events", club.event(clock, "booking.cancelled"), "openpadel-signature");
  await idle();
  assert.equal((await fetch(`${base}/health`)).status, 200);
  club.state.down = true;
  clock += 3 * REFRESH_MS;
  await post("/events", club.event(clock, "booking.cancelled"), "openpadel-signature");
  await idle();
  const h = await fetch(`${base}/health`);
  assert.equal(h.status, 503);
  assert.ok(!JSON.stringify(await h.json()).includes(club.url), "health names no club");
  club.state.down = false; club.state.cards = true;
});
