// Makes the plugin's release for a club's own server (`openpadel plugin service`): a .tar.gz of what it runs (bin/,
// src/, package.json, README.md), the same bytes every time from the same files (sorted, no dates, no owners), and the
// manifest that pins it by its SHA-256. Usage:
//
//   node tools/pack.ts --release-url https://github.com/openpadel/plugin-court-camera/releases/download/v0.1.0/court-camera-0.1.0.tar.gz [--out dist]
//
// Publish the .tar.gz at that address, then install with the printed manifest (or add it to the catalog).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = join(ROOT, "..", "..", "docs", "plugins", "examples", "court-camera", "openpadel-plugin.json");
const PARTS = ["bin", "src", "package.json", "README.md"];

/** The files in the release, sorted, with their modes (the entry executable, the rest read-only). */
function files(): { path: string; mode: number; data: Buffer | null }[] {
  const out: { path: string; mode: number; data: Buffer | null }[] = [];
  const walk = (abs: string) => {
    const rel = relative(ROOT, abs).split(sep).join("/");
    if (statSync(abs).isDirectory()) {
      out.push({ path: `${rel}/`, mode: 0o755, data: null });
      for (const f of readdirSync(abs).sort()) walk(join(abs, f));
    } else out.push({ path: rel, mode: rel.startsWith("bin/") ? 0o755 : 0o644, data: readFileSync(abs) });
  };
  for (const p of PARTS) walk(join(ROOT, p));
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A POSIX tar (ustar) of the files: owner 0, time 0. */
export function tar(list: { path: string; mode: number; data: Buffer | null }[]): Buffer {
  const blocks: Buffer[] = [];
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  for (const f of list) {
    if (Buffer.byteLength(f.path) > 100) throw new Error(`${f.path}: path too long for the release`);
    const h = Buffer.alloc(512);
    h.write(f.path, 0, 100, "utf8");
    h.write(octal(f.mode, 8), 100); h.write(octal(0, 8), 108); h.write(octal(0, 8), 116);
    h.write(octal(f.data?.length ?? 0, 12), 124); h.write(octal(0, 12), 136);
    h.write("        ", 148);
    h.write(f.data ? "0" : "5", 156);
    h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(octal(sum, 7) + " ", 148);
    blocks.push(h);
    if (f.data) { blocks.push(f.data); const pad = (512 - (f.data.length % 512)) % 512; if (pad) blocks.push(Buffer.alloc(pad)); }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function pack(o: { releaseUrl: string; out: string }): { file: string; sha256: string; manifest: Record<string, unknown>; manifestFile: string } {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, any>;
  const name = `court-camera-${m.version}.tar.gz`;
  const gz = gzipSync(tar(files()), { level: 9 });
  const sha256 = createHash("sha256").update(gz).digest("hex");
  mkdirSync(o.out, { recursive: true });
  const file = join(o.out, name);
  writeFileSync(file, gz);
  const manifest = { ...m, run: { mode: "local", release_url: o.releaseUrl, sha256, entry: "bin/start" } };
  const manifestFile = join(o.out, "openpadel-plugin.local.json");
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  return { file, sha256, manifest, manifestFile };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const releaseUrl = arg("--release-url");
  if (!releaseUrl || !/^https:\/\//.test(releaseUrl)) { console.error("Give --release-url https://... (where the .tar.gz will be published)"); process.exit(2); }
  const r = pack({ releaseUrl, out: arg("--out") ?? join(ROOT, "dist") });
  console.log(`${r.file}\nsha256 ${r.sha256}\nmanifest ${r.manifestFile}`);
}
