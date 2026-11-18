// The catalog repository's files (catalog/): every plugin's manifest checks with the club server's own parser, each
// pinned release matches its manifest, catalog.json is what the build makes, the manifests are the documented examples
// (and the bundled sample's), the club's server reads catalog.json as its catalog, and a broken listing is refused in
// words.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginCatalog, pluginIo, setPluginIo } from "@kumi/core";
import { build, CATALOG } from "../../../catalog/tools/build.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, ROOT), "utf8"));
const saved = pluginIo().catalogUrl;
after(() => { setPluginIo({ catalogUrl: saved }); });

test("every listed plugin checks, catalog.json is current, and the manifests are the documented ones", () => {
  const b = build();
  assert.deepEqual(b.problems, []);
  assert.ok(["accounting-export", "court-lights", "klaviyo"].every((n) => b.names.includes(n)), b.names.join());
  assert.equal(readFileSync(join(CATALOG, "catalog.json"), "utf8"), b.json, "catalog.json is current: run node catalog/tools/build.ts");
  const sample = read("packages/core/src/plugin_catalog.sample.json");
  for (const n of b.names) {
    const mine = read(`catalog/plugins/${n}/openpadel-plugin.json`), docs = read(`docs/plugins/examples/${n}/openpadel-plugin.json`);
    assert.deepEqual(mine, docs, `${n}: the catalog's manifest is docs/plugins/examples' own`);
    const { $schema: _, ...bare } = mine;
    assert.deepEqual(sample.plugins.find((p: any) => p.manifest.name === n)?.manifest, bare, `${n}: and the bundled sample's`);
    const rel = read(`catalog/plugins/${n}/release.json`);
    assert.equal(rel.version, mine.version);
    assert.ok(rel.url.startsWith("https://") && rel.url.endsWith(`/${n}-${mine.version}.tar.gz`), `${n}: ${rel.url}`);
  }
  const index = JSON.parse(b.json);
  assert.deepEqual(index.plugins.map((p: any) => p.manifest.name), b.names, "sorted by name");
  assert.ok(index.plugins.every((p: any) => !("$schema" in p.manifest) && /^[0-9a-f]{64}$/.test(p.release.sha256) && p.reviewed.checklist === index.checklist));
});

test("the club's server reads catalog.json as its catalog, every entry kept", async () => {
  setPluginIo({ catalogUrl: join(CATALOG, "catalog.json") });
  const c = await pluginCatalog(true);
  assert.deepEqual(c.skipped, []);
  assert.deepEqual(c.entries.map((e) => e.manifest.name).sort(), build().names);
});

test("a broken listing is refused, and says why", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-"));
  try {
    cpSync(join(CATALOG, "plugins"), join(dir, "plugins"), { recursive: true });
    const kl = join(dir, "plugins", "klaviyo"), m = JSON.parse(readFileSync(join(kl, "openpadel-plugin.json"), "utf8"));
    writeFileSync(join(kl, "openpadel-plugin.json"), JSON.stringify({ ...m, reads: ["club_news", "secrets"] }));
    const rel = JSON.parse(readFileSync(join(dir, "plugins", "court-lights", "release.json"), "utf8"));
    writeFileSync(join(dir, "plugins", "court-lights", "release.json"), JSON.stringify({ ...rel, version: "9.9.9", sha256: "nope" }));
    cpSync(join(dir, "plugins", "accounting-export"), join(dir, "plugins", "renamed"), { recursive: true });
    const b = build(dir);
    assert.ok(b.problems.some((p) => /^klaviyo: the manifest doesn't check/.test(p)), b.problems.join("\n"));
    assert.ok(b.problems.includes("court-lights: release.json is version 9.9.9 but the manifest is 0.1.0"));
    assert.ok(b.problems.includes("court-lights: release.json's sha256 must be 64 lowercase hex characters"));
    assert.ok(b.problems.includes("renamed: the folder is renamed but the manifest's name is accounting-export"));
    assert.equal(JSON.parse(b.json).plugins.length, readdirSync(join(dir, "plugins")).length - 3, "only what checks is listed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
