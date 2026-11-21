// A production server with no catalog set reads openPadel's own catalog online, and the bundled sample when that
// address can't be reached or answers something that isn't a catalog. A set catalog is never swapped for either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPENPADEL_CATALOG_URL, pluginCatalog, pluginIo, setPluginIo } from "@kumi/core";

const published = readFileSync(new URL("../../../catalog/catalog.json", import.meta.url), "utf8");
const base = { ...pluginIo() };

test("unset and online: openPadel's own catalog, fetched from its address", async () => {
  const asked: string[] = [];
  setPluginIo({ ...base, catalogUrl: null, ownCatalogOnline: true, fetchText: async (url) => { asked.push(url); return published; } });
  const c = await pluginCatalog(true);
  assert.deepEqual(asked, [OPENPADEL_CATALOG_URL]);
  assert.equal(c.source, OPENPADEL_CATALOG_URL);
  assert.deepEqual(c.entries.map((e) => e.manifest.name).sort(), JSON.parse(published).plugins.map((p: { manifest: { name: string } }) => p.manifest.name).sort());
  assert.deepEqual(c.skipped, []);
});

test("unset and offline, or an answer that isn't JSON: the bundled sample", async () => {
  setPluginIo({ ...base, catalogUrl: null, ownCatalogOnline: true, fetchText: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  const off = await pluginCatalog(true);
  assert.equal(off.source, "sample");
  assert.ok(off.entries.length > 0);
  setPluginIo({ fetchText: async () => "<html>parked</html>" });
  assert.equal((await pluginCatalog(true)).source, "sample");
});

test("development and tests read the sample without going online; a set catalog is read as set", async () => {
  let fetched = 0;
  setPluginIo({ ...base, catalogUrl: null, ownCatalogOnline: false, fetchText: async () => { fetched++; return published; } });
  assert.equal((await pluginCatalog(true)).source, "sample");
  assert.equal(fetched, 0);
  setPluginIo({ catalogUrl: "https://catalog.example.org/catalog.json", ownCatalogOnline: true, fetchText: async (url) => { assert.equal(url, "https://catalog.example.org/catalog.json"); fetched++; return published; } });
  assert.equal((await pluginCatalog(true)).source, "https://catalog.example.org/catalog.json");
  assert.equal(fetched, 1);
  setPluginIo(base);
});
