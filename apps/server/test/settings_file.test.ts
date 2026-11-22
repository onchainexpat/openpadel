import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupName, renameSettings, renameSettingsFile } from "../src/settings_file.ts";

// Fake values only: nothing here is a real key.
const SAMPLE = [
  "NODE_ENV=production",
  "# Email (docs/setup/accounts/resend.md):",
  "KUMI_RESEND_API_KEY=re_fake_0000000000004f2a",
  "KUMI_MAIL_FROM=\"Kestrel Padel <hello@kestrel.example>\"",
  "export KUMI_PRACTICE=1",
  "KUMI_SECRET_KEY=ZmFrZS1zZWNyZXQta2V5LWZvci10ZXN0cy1vbmx5PT0=",
  "OPENPADEL_LANG=es",
  "KUMI_LANG=es",
  "OPENPADEL_PUBLIC_URL=https://staff.kestrel.example",
  "KUMI_PUBLIC_URL=https://old.kestrel.example",
  "# KUMI_TWILIO_AUTH_TOKEN=  (a comment stays a comment)",
  "",
].join("\n");

test("renaming: old names to new, every value and comment as it was, a name set both ways keeps the new line", () => {
  const r = renameSettings(SAMPLE);
  assert.equal(r.text, [
    "NODE_ENV=production",
    "# Email (docs/setup/accounts/resend.md):",
    "OPENPADEL_RESEND_API_KEY=re_fake_0000000000004f2a",
    "OPENPADEL_MAIL_FROM=\"Kestrel Padel <hello@kestrel.example>\"",
    "export OPENPADEL_PRACTICE=1",
    "OPENPADEL_SECRET_KEY=ZmFrZS1zZWNyZXQta2V5LWZvci10ZXN0cy1vbmx5PT0=",
    "OPENPADEL_LANG=es",
    "OPENPADEL_PUBLIC_URL=https://staff.kestrel.example",
    "# OPENPADEL_PUBLIC_URL is set too, and is the one used; the old line, as it was:",
    "# KUMI_PUBLIC_URL=https://old.kestrel.example",
    "# KUMI_TWILIO_AUTH_TOKEN=  (a comment stays a comment)",
    "",
  ].join("\n"));
  assert.deepEqual(r.renamed, ["KUMI_RESEND_API_KEY", "KUMI_MAIL_FROM", "KUMI_PRACTICE", "KUMI_SECRET_KEY"]);
  assert.deepEqual(r.dropped, ["KUMI_LANG"]);
  assert.deepEqual(r.kept_old, ["KUMI_PUBLIC_URL"]);
  assert.equal(renameSettings(r.text).text, r.text, "again: nothing changes");
  assert.equal(renameSettings("KUMI_PORT_X=1\r\nPORT=2\r\n").text, "OPENPADEL_PORT_X=1\r\nPORT=2\r\n", "Windows line endings kept");
  assert.equal(backupName("/etc/kumi/kumi.env", new Date("2026-11-22T15:30:05Z")), "/etc/kumi/kumi.env.before-rename-20261122-153005");
});

test("the file: a dated copy beside it, its mode kept, and running it again changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-settings-"));
  try {
    const file = join(dir, "kumi.env");
    writeFileSync(file, SAMPLE); chmodSync(file, 0o640);
    const r = renameSettingsFile(file, new Date("2026-11-22T15:30:05Z"))!;
    assert.equal(r.changed, true);
    assert.equal(r.backup, `${file}.before-rename-20261122-153005`);
    assert.equal(readFileSync(r.backup!, "utf8"), SAMPLE, "the copy is the file as it was");
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.equal(statSync(r.backup!).mode & 0o777, 0o640, "the copy is no easier to read than the file");
    assert.equal(readFileSync(file, "utf8"), renameSettings(SAMPLE).text);
    const again = renameSettingsFile(file, new Date("2026-11-22T15:31:00Z"))!;
    assert.deepEqual(again, { changed: false, backup: null, renamed: [], dropped: [], kept_old: [] });
    assert.equal(readdirSync(dir).length, 2, "no second copy");
    assert.equal(renameSettingsFile(join(dir, "missing.env")), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("openpadel settings rename: names only, never a value, in English, Spanish and --json", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "kumi-settings-"));
  try {
    const file = join(dir, "kumi.env"), go = (...a: string[]) => spawnSync(process.execPath, [cli, "settings", "rename", `--file=${file}`, ...a], { encoding: "utf8", env: { PATH: process.env.PATH! } });
    const secrets = ["re_fake_0000000000004f2a", "ZmFrZS1zZWNyZXQ", "kestrel.example"];
    writeFileSync(file, SAMPLE);
    const en = go();
    assert.equal(en.status, 0, en.stderr);
    for (const s of secrets) assert.ok(!(en.stdout + en.stderr).includes(s), s);
    assert.match(en.stdout, /^KUMI_RESEND_API_KEY is now OPENPADEL_RESEND_API_KEY$/m);
    assert.match(en.stdout, /KUMI_LANG: taken out, since OPENPADEL_LANG is already set to the same value/);
    assert.match(en.stdout, /KUMI_PUBLIC_URL: kept as a comment/);
    assert.match(en.stdout, /The file as it was is kept as .*kumi\.env\.before-rename-\d{8}-\d{6}\./);
    const es = go("--lang=es");
    assert.equal(es.status, 0);
    assert.match(es.stdout, /ya usa los nombres nuevos de los ajustes \(OPENPADEL_\)\. No hay nada que hacer\./);
    writeFileSync(file, SAMPLE);
    const j = go("--json");
    assert.equal(j.status, 0, j.stderr);
    for (const s of secrets) assert.ok(!j.stdout.includes(s), s);
    const v = JSON.parse(j.stdout);
    assert.equal(v.ok, true); assert.equal(v.changed, true);
    assert.deepEqual(v.renamed, ["KUMI_RESEND_API_KEY", "KUMI_MAIL_FROM", "KUMI_PRACTICE", "KUMI_SECRET_KEY"]);
    const none = spawnSync(process.execPath, [cli, "settings", "rename", `--file=${join(dir, "nope.env")}`], { encoding: "utf8", env: { PATH: process.env.PATH! } });
    assert.equal(none.status, 2); assert.match(none.stderr, /There's no settings file at/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
