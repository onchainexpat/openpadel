// What docs/plugins/ promises: the registration check a plugin's author copies accepts the club's own signature (and
// refuses a changed body, another club's key or an old time), and the manifest reference names every field the checker
// takes, and nothing it doesn't.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { manifestSchema, pluginKey, signForPlugin, type Db } from "@kumi/core";
import { freshDb } from "../../../packages/core/test/helpers.ts";

const DOCS = join(import.meta.dirname, "../../../docs/plugins");
const dir = mkdtempSync(join(tmpdir(), "kumi-plugin-doc-"));
let db: Db, drop: () => Promise<void>;
before(async () => { ({ db, drop } = await freshDb()); });
after(async () => { rmSync(dir, { recursive: true, force: true }); await drop(); });

test("the registration check in README.md accepts the club's signature, and refuses a changed body, another key or an old time", async () => {
  const md = readFileSync(join(DOCS, "README.md"), "utf8");
  const sample = /<!-- registration-sample[^>]*-->\s*```js\n([\s\S]*?)```/.exec(md)?.[1];
  assert.ok(sample, "the marked sample is there");
  const file = join(dir, "verify.mjs");
  writeFileSync(file, sample);
  const { verifyRegistration } = await import(pathToFileURL(file).href) as { verifyRegistration: (h: string, b: string, f: (u: string) => Promise<unknown>, now?: number) => Promise<boolean> };
  const url = "https://club.example.com", body = JSON.stringify({ type: "plugin.registered", club: { url, key_url: `${url}/.well-known/openpadel-plugin-key` }, door: { token: "opa_x" } });
  const t = Math.floor(Date.now() / 1000), header = await signForPlugin(db, body, t), jwk = (await pluginKey(db)).jwk;
  const served = async (u: string) => { assert.equal(u, `${url}/.well-known/openpadel-plugin-key`); return { keys: [jwk] }; };
  assert.equal(await verifyRegistration(header, body, served), true);
  assert.equal(await verifyRegistration(header, body.replace("opa_x", "opa_y"), served), false);
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  assert.equal(await verifyRegistration(header, body, async () => ({ keys: [other] })), false, "another club's key");
  assert.equal(await verifyRegistration(await signForPlugin(db, body, t - 600), body, served), false, "replayed later");
  const elsewhere = body.replace(`${url}/.well-known`, "https://evil.example/.well-known");
  assert.equal(await verifyRegistration(await signForPlugin(db, elsewhere, t), elsewhere, served), false, "a key from somewhere other than the club's own address");
});

test("manifest.md names every field the manifest checker takes", () => {
  const md = readFileSync(join(DOCS, "manifest.md"), "utf8");
  const fields = Object.keys((manifestSchema as unknown as { shape: Record<string, unknown> }).shape);
  for (const f of fields) assert.ok(md.includes(`| \`${f}\` |`), `${f} isn't in manifest.md's table`);
  const top = md.slice(0, md.indexOf("## `settings`"));
  const documented = [...top.matchAll(/^\| `([a-z_$]+)` \|/gm)].map((m) => m[1]!);
  for (const f of documented) assert.ok(fields.includes(f), `manifest.md documents ${f}, which the checker doesn't take`);
  for (const ty of ["string", "integer", "boolean", "choice", "courts"]) assert.ok(md.includes(`| \`${ty}\` |`), ty);
  assert.ok(!/[\u2014\u2013]/.test(md + readFileSync(join(DOCS, "README.md"), "utf8")), "no em or en dashes");
});
