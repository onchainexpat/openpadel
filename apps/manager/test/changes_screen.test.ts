// Changes and Approvals (round staff-14, 15 Nov 2026): who made a change and how it came in, in words; how long ago an
// ask was made; Undo still previews before anything changes; and Roles in the staff menu, in both languages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en } from "../../../packages/i18n/src/en.ts";
import { es } from "../../../packages/i18n/src/es.ts";
import { agoParts, viaWords } from "../src/made_via.ts";

const src = (f: string) => readFileSync(join(import.meta.dirname, "../src", f), "utf8");

test("how a change came in, in words: the app, an assistant on /mcp, setup, a job, the Playtomic copy", () => {
  assert.deepEqual(viaWords("web"), { word: "web", params: {} });
  assert.deepEqual(viaWords("mcp:Claude"), { word: "mcp", params: { name: "Claude" } });
  assert.deepEqual(viaWords("setup"), { word: "setup", params: {} });
  assert.deepEqual(viaWords("job:receipts"), { word: "job", params: {} });
  assert.deepEqual(viaWords("jobs"), { word: "job", params: {} });
  assert.deepEqual(viaWords("mirror:playtomic"), { word: "playtomic", params: {} });
  assert.deepEqual(viaWords("parent:0190"), { word: "parent", params: {} });
  assert.equal(viaWords("test"), null);
  assert.equal(viaWords(null), null);
  // Every one of them is in both languages.
  for (const v of ["web", "mcp:x", "setup", "cli", "import", "household", "signup", "support", "staff", "restore", "job", "mirror:playtomic", "parent:x", "text"]) {
    const k = `ui.made_via_${viaWords(v)!.word}`;
    assert.ok(k in en && k in es, k);
  }
});

test("how long ago, to the nearest minute, hour or day; under a minute is just now", () => {
  const now = Date.parse("2026-11-15T18:00:00Z");
  assert.equal(agoParts("2026-11-15T17:59:30Z", now), null);
  assert.deepEqual(agoParts("2026-11-15T17:56:00Z", now), [-4, "minute"]);
  assert.deepEqual(agoParts("2026-11-15T15:00:00Z", now), [-3, "hour"]);
  assert.deepEqual(agoParts("2026-11-13T18:00:00Z", now), [-2, "day"]);
});

test("Undo still previews first, then confirms; the detail pane opens beside the list", () => {
  const c = src("Changes.tsx");
  assert.match(c, /api<\{ run_id: string; status: string; summary: string \}>\("\/actions\/action\.undo\/plan\?ask=hold", \{ run_id: id \}\)/);
  assert.match(c, /await api\(`\/runs\/\$\{open\.runId\}\/apply`, \{\}, \{ "idempotency-key": open\.runId \}\)/);
  assert.match(c, /<SidePanel narrow onClose=\{\(\) => setPicked\(null\)\}>/);
  assert.match(c, /api<Detail>\(`\/staff\/changes\/\$\{id\}`\)/);
});

test("Roles is in the menu in both presets, in English and Spanish", () => {
  assert.equal(en["ui.nav_roles"], "Roles and permissions");
  assert.equal(es["ui.nav_roles"], "Roles y permisos");
  assert.match(src("App.tsx"), /roles: link\(show\("settings"\) && mayCreate\("role\.create"\) && !me\.value\?\.support, "\/roles", label\("ui\.nav_roles"\)\)/);
});
