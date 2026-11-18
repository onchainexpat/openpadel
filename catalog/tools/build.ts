// Builds openPadel's reviewed plugin catalog: every plugins/<name>/ folder's manifest checked with the club server's
// own parser (packages/core plugin_manifest.ts, the same check `openpadel plugin install` makes), its pinned release
// checked against it, and catalog.json written: the index a club's server reads (KUMI_PLUGIN_CATALOG_URL, by default
// https://plugins.openpadel.org/catalog.json). The same files in, the same bytes out (sorted by name, no dates), so
// `--check` can say whether catalog.json is current.
//
//   node catalog/tools/build.ts            writes catalog/catalog.json
//   node catalog/tools/build.ts --check    fails if it isn't current (for a pull request's checks)
//   node catalog/tools/build.ts pin <name> --release-url https://.../<name>-<version>.tar.gz
//                                          packs plugins/<name> (this repo's own plugins) with its tools/pack.ts and
//                                          writes catalog/plugins/<name>/release.json with that file's SHA-256
//
// A folder holds `openpadel-plugin.json` (the manifest, as its author ships it) and `release.json`:
//   { "version": "0.1.0", "url": "https://.../court-lights-0.1.0.tar.gz", "sha256": "<64 hex>",
//     "reviewed": { "by": "openPadel", "on": "2026-11-18", "checklist": 1 } }
// The version is the manifest's; a local manifest (`run.mode` "local") pins the same address and SHA-256 in its `run`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseManifest, MANIFEST_FILE } from "@kumi/core";

export const CATALOG = fileURLToPath(new URL("..", import.meta.url));
/** The review checklist's version (CONTRIBUTING.md): a listing reviewed against an older one is said to be. */
export const CHECKLIST = 1;
const NAME = { en: "openPadel's reviewed plugin catalog", es: "El catálogo de plugins revisado de openPadel" };

export interface Release { version: string; url: string; sha256: string; reviewed: { by: string; on: string; checklist: number } }
export interface Entry { manifest: Record<string, unknown>; release: { url: string; sha256: string }; reviewed: Release["reviewed"] }

/** One plugin's folder, checked: its manifest by the server's parser, its release against it. Problems in words. */
export function readPlugin(dir: string, name: string): { entry: Entry | null; problems: string[] } {
  const problems: string[] = [], at = (s: string) => `${name}: ${s}`;
  const mf = join(dir, MANIFEST_FILE), rf = join(dir, "release.json");
  if (!existsSync(mf)) return { entry: null, problems: [at(`no ${MANIFEST_FILE}`)] };
  if (!existsSync(rf)) return { entry: null, problems: [at("no release.json")] };
  let raw: Record<string, unknown>, release: Release;
  try { raw = JSON.parse(readFileSync(mf, "utf8")); } catch (e) { return { entry: null, problems: [at(`${MANIFEST_FILE} isn't JSON: ${(e as Error).message}`)] }; }
  try { release = JSON.parse(readFileSync(rf, "utf8")); } catch (e) { return { entry: null, problems: [at(`release.json isn't JSON: ${(e as Error).message}`)] }; }
  let m: ReturnType<typeof parseManifest>;
  try { m = parseManifest(raw); } catch (e) {
    const t = (e as { text?: { en?: string } }).text?.en ?? (e as Error).message;
    return { entry: null, problems: [at(`the manifest doesn't check: ${t}`)] };
  }
  if (m.name !== name) problems.push(at(`the folder is ${name} but the manifest's name is ${m.name}`));
  if (release.version !== m.version) problems.push(at(`release.json is version ${release.version} but the manifest is ${m.version}`));
  if (typeof release.url !== "string" || !/^https:\/\/[^\s]+\.tar\.gz$/.test(release.url)) problems.push(at("release.json's url must be an https address of a .tar.gz"));
  if (typeof release.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(release.sha256)) problems.push(at("release.json's sha256 must be 64 lowercase hex characters"));
  const r = release.reviewed;
  if (!r || typeof r.by !== "string" || !r.by || typeof r.on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.on) || r.checklist !== CHECKLIST)
    problems.push(at(`release.json's reviewed must say by whom, on what date (YYYY-MM-DD), against checklist ${CHECKLIST}`));
  if (m.run.mode === "local" && (m.run.release_url !== release.url || m.run.sha256 !== release.sha256))
    problems.push(at("a local manifest's run.release_url and run.sha256 must be the release.json's"));
  if (problems.length) return { entry: null, problems };
  const { $schema: _, ...manifest } = raw;
  return { entry: { manifest, release: { url: release.url, sha256: release.sha256 }, reviewed: r }, problems };
}

/** Every plugin, checked, and the index's text (or what's wrong). */
export function build(root = CATALOG): { json: string; names: string[]; problems: string[] } {
  const dir = join(root, "plugins"), problems: string[] = [], entries: Entry[] = [];
  const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const n of names) {
    const r = readPlugin(join(dir, n), n);
    problems.push(...r.problems);
    if (r.entry) entries.push(r.entry);
  }
  const json = JSON.stringify({ catalog: 1, name: NAME, checklist: CHECKLIST, plugins: entries }, null, 2) + "\n";
  return { json, names, problems };
}

async function pin(name: string, releaseUrl: string): Promise<void> {
  const packer = join(CATALOG, "..", "plugins", name, "tools", "pack.ts");
  if (!existsSync(packer)) throw new Error(`plugins/${name}/tools/pack.ts isn't in this repo: write release.json by hand, with the SHA-256 of the published file`);
  const { pack } = await import(pathToFileURL(packer).href) as { pack: (o: { releaseUrl: string; out: string }) => { file: string; sha256: string; manifest: { version: string } } };
  const r = pack({ releaseUrl, out: join(CATALOG, "..", "plugins", name, "dist") });
  const rf = join(CATALOG, "plugins", name, "release.json");
  const had = existsSync(rf) ? JSON.parse(readFileSync(rf, "utf8")) as Release : null;
  const release: Release = { version: r.manifest.version, url: releaseUrl, sha256: r.sha256, reviewed: had?.reviewed ?? { by: "openPadel", on: new Date().toISOString().slice(0, 10), checklist: CHECKLIST } };
  writeFileSync(rf, JSON.stringify(release, null, 2) + "\n");
  console.log(`${rf}\npublish ${r.file} at ${releaseUrl}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args[0] === "pin") {
    const i = args.indexOf("--release-url"), url = i > 0 ? args[i + 1] : undefined;
    if (!args[1] || !url || !/^https:\/\//.test(url)) { console.error("Give: pin <name> --release-url https://..."); process.exit(2); }
    await pin(args[1], url);
  } else {
    const b = build(), out = join(CATALOG, "catalog.json");
    if (b.problems.length) { console.error(b.problems.join("\n")); process.exit(1); }
    if (args.includes("--check")) {
      const have = existsSync(out) ? readFileSync(out, "utf8") : "";
      if (have !== b.json) { console.error("catalog.json isn't current: run node catalog/tools/build.ts"); process.exit(1); }
      console.log(`catalog.json is current (${b.names.length} plugins)`);
    } else { writeFileSync(out, b.json); console.log(`wrote ${out} (${b.names.length} plugins: ${b.names.join(", ")})`); }
  }
}
