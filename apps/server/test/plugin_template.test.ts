// The "write a plugin" template (plugins/template, docs/plugins/writing.md) can't rot: copied out of this repository
// as a builder would copy it, its own tests pass there with nothing of openPadel's; its manifest checks with the club's
// own parser; installed at a real club it registers, reads through the door and shows its card on Connectors; and its
// release packs into a local manifest that checks too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { cardsFor, checkManifestAtClub, parseManifest, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { plugin, type Plugin } from "../../../plugins/template/src/plugin.ts";
import { pack } from "../../../plugins/template/tools/pack.ts";

const TEMPLATE = fileURLToPath(new URL("../../../plugins/template/", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(TEMPLATE, "openpadel-plugin.json"), "utf8"));
const BASE = "https://club.example.test", TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, p: Plugin, server: Server;

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  await run(db, "location.create", { name: "Main", time_zone: TZ }, owner);
  app = makeApp({ db, mailer: new MemoryMailer(), publicUrl: BASE, secureCookies: false });
  const viaApp = (async (url: string | URL | Request, init?: RequestInit) => { const u = String(url); return u.startsWith(BASE) ? app.request(u, init) : fetch(url, init); }) as typeof fetch;
  p = plugin({ log: () => {}, fetch: viaApp });
  server = await p.listen(0, "127.0.0.1");
});
after(async () => { p.stop(); server.close(); await drop(); });

test("copied out of the repository, the template's own tests pass with nothing of openPadel's", () => {
  const dir = mkdtempSync(join(tmpdir(), "my-plugin-"));
  try {
    cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !src.includes(`${join(TEMPLATE, "dist")}`) && !src.includes("node_modules") });
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;   // its own run, reporting as it would for a builder
    const r = spawnSync(process.execPath, ["--test", "test/plugin.test.ts"], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /# fail 0|ℹ fail 0/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("its manifest checks, and installed at a real club it registers, reads through the door and shows its card", async () => {
  const m = parseManifest(JSON.stringify(MANIFEST));
  await checkManifestAtClub(db, m);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const r = await run(db, "plugin.install", { manifest: JSON.stringify({ ...MANIFEST, run: { mode: "remote", url } }) }, owner);
  assert.equal((r.result as any).registered, true, JSON.stringify(r.result));
  const runner = p.runners.get(BASE)!;
  await runner.idle();
  assert.equal(runner.error, null);
  const card = (await cardsFor(db, "connectors", null, "en")).find((c) => c.plugin === "bookings-today");
  assert.deepEqual(card?.rows, [{ label: "Main", text: "0 bookings today" }], JSON.stringify(card));
});

test("its release packs into a local manifest that checks", async () => {
  const out = mkdtempSync(join(tmpdir(), "template-release-"));
  try {
    const r = pack({ releaseUrl: "https://example.com/releases/bookings-today-0.1.0.tar.gz", out });
    const m = parseManifest(readFileSync(r.manifestFile, "utf8"));
    await checkManifestAtClub(db, m);
    assert.equal(m.run.mode, "local");
  } finally { rmSync(out, { recursive: true, force: true }); }
});
