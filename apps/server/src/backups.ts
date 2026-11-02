// Backups: the nightly dump with a manifest of every table's rows, an encrypted copy offsite, restoring one,
// and the monthly test that a backup really restores. The dump and the counts come from one snapshot of the
// database, so a restore can be checked against the manifest exactly.
//
// Offsite copies are sealed with KUMI_BACKUP_KEY, a key of their own, not the server's: a lost server takes its
// key with it, and the backups must still open. The owner keeps the backup key somewhere safe away from the
// server (a password manager). Secrets inside the database (vault, authenticators, push key) stay sealed with
// the server's key; restored without that key, those few need setting up again, and everything else is whole.
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { sql, type Kysely } from "kysely";
import { connect, jobFailed, jobWorked, parseSecretKey, type Db } from "@kumi/core";
import { S3Client, type S3Config } from "./s3.ts";

export const LOCAL_DAYS = 14, OFFSITE_DAILY = 30, OFFSITE_MONTHLY = 12;
type Env = Record<string, string | undefined>;

// ---- The Postgres tools ----
/** pg_dump, pg_restore: from KUMI_PG_BIN, else Postgres 17's own folder, else the PATH. */
export function pgTool(name: "pg_dump" | "pg_restore", env: Env = process.env): string {
  if (env.KUMI_PG_BIN) return join(env.KUMI_PG_BIN, name);
  const v17 = `/usr/lib/postgresql/17/bin/${name}`;
  return existsSync(v17) ? v17 : name;
}
/** A connection URL for the tools, with its password moved to PGPASSWORD (so it isn't in the process list). A
 *  local socket URL (postgresql://kumi@/kumi?host=/var/run/postgresql, the one-server install's) has none. */
function toolTarget(url: string): { url: string; env: Env } {
  const m = /^([a-z]+:\/\/)([^:@/]*)(?::([^@/]*))?@(.*)$/.exec(url);
  if (!m || m[3] === undefined) return { url, env: {} };
  return { url: `${m[1]}${m[2]}@${m[4]}`, env: { PGPASSWORD: decodeURIComponent(m[3]) } };
}
/** The database a connection URL names, and the same URL naming another one. */
const dbNameOf = (url: string) => decodeURIComponent(/^[a-z]+:\/\/[^/]*\/([^?]*)/.exec(url)?.[1] ?? "");
const withDbName = (url: string, name: string) => url.replace(/^([a-z]+:\/\/[^/]*\/)([^?]*)/, `$1${name}`);
function runTool(cmd: string, args: string[], env: Env): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += String(d); });
    p.on("error", (e) => reject(new Error(`${basename(cmd)}: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${basename(cmd)} failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`))));
  });
}

// ---- Making a backup ----
export interface Manifest { kind: "kumi-backup"; created_at: string; file: string; bytes: number; sha256: string; migrations: number; tables: Record<string, number> }

async function tableCounts(db: Kysely<any>): Promise<Record<string, number>> {
  const tables = (await sql<{ t: string }>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`.execute(db)).rows.map((r) => r.t);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(t)}`.execute(db)).rows[0]!.n);
  return out;
}
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Dump the database (custom format) with a manifest of every table's rows, from one snapshot. `label` names a
 *  dump made for something else (an update): those aren't the nightly files and aren't tidied with them. */
export async function makeBackup(db: Db, o: { url: string; dir: string; now?: Date; label?: string; env?: Env }): Promise<{ file: string; manifestFile: string; manifest: Manifest }> {
  const now = o.now ?? new Date(), env = o.env ?? process.env;
  mkdirSync(o.dir, { recursive: true });
  const name = o.label ? `kumi-${o.label}` : `kumi-${day(now)}`;
  const file = join(o.dir, `${name}.dump`), manifestFile = join(o.dir, `${name}.json`), part = `${file}.part`;
  const target = toolTarget(o.url);
  let tables: Record<string, number> = {};
  // A dump holds every member's details: only this server's user reads it, wherever the folder is (Docker's
  // ./backups is a plain folder the owner made). pg_dump keeps the mode of a file that's already there.
  const owner = (f: string) => { if (existsSync(f)) chmodSync(f, 0o600); };
  writeFileSync(part, "", { mode: 0o600 }); owner(part);
  // Repeatable read: the counts and pg_dump (handed the same snapshot) see exactly the same rows.
  await db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    const snapshot = (await sql<{ s: string }>`SELECT pg_export_snapshot() AS s`.execute(trx)).rows[0]!.s;
    tables = await tableCounts(trx);
    await runTool(pgTool("pg_dump", env), ["-Fc", "--no-owner", "--no-acl", `--snapshot=${snapshot}`, "-f", part, "-d", target.url], target.env);
  });
  const bytes = readFileSync(part);
  writeFileSync(file, bytes, { mode: 0o600 }); owner(file);
  rmSync(part, { force: true });
  const manifest: Manifest = { kind: "kumi-backup", created_at: now.toISOString(), file: basename(file), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    migrations: tables.schema_migration ?? 0, tables };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 }); owner(manifestFile);
  return { file, manifestFile, manifest };
}

/** Nightly files older than LOCAL_DAYS go. Update snapshots and anything else are left alone. */
export function tidyLocal(dir: string, now = new Date()): string[] {
  const gone: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return gone; }
  for (const f of names) {
    const m = /^kumi-(\d{4}-\d{2}-\d{2})\.(dump|json)$/.exec(f);
    if (m && now.getTime() - new Date(`${m[1]}T00:00:00Z`).getTime() > LOCAL_DAYS * 86400_000) { rmSync(join(dir, f), { force: true }); gone.push(f); }
  }
  return gone;
}
/** The newest nightly dump in the folder (and its manifest, if there is one). */
export function newestLocal(dir: string): { file: string; manifestFile: string | null } | null {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return null; }
  const dumps = names.filter((f) => /^kumi-\d{4}-\d{2}-\d{2}\.dump$/.test(f)).sort();
  const last = dumps.at(-1);
  if (!last) return null;
  const m = join(dir, last.replace(/\.dump$/, ".json"));
  return { file: join(dir, last), manifestFile: existsSync(m) ? m : null };
}

// ---- Sealing a backup for offsite ----
const MAGIC = Buffer.from("KUMIBK1\n");
export function backupKey(env: Env = process.env): Buffer | null { return env.KUMI_BACKUP_KEY?.trim() ? parseSecretKey(env.KUMI_BACKUP_KEY) : null; }
export function sealBackup(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}
export function openBackup(sealed: Buffer, key: Buffer): Buffer {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a Kumi offsite backup");
  const at = MAGIC.length, d = createDecipheriv("aes-256-gcm", key, sealed.subarray(at, at + 12));
  d.setAuthTag(sealed.subarray(at + 12, at + 28));
  try { return Buffer.concat([d.update(sealed.subarray(at + 28)), d.final()]); }
  catch { throw new Error("this backup doesn't open with KUMI_BACKUP_KEY (a different key, or the file is damaged)"); }
}

// ---- Offsite ----
export const offsitePrefix = (env: Env = process.env) => { const p = (env.KUMI_OFFSITE_PREFIX ?? "kumi/").replace(/^\/+/, ""); return p && !p.endsWith("/") ? `${p}/` : p; };

/** Upload a dump (and its manifest), sealed, as tonight's daily copy and, if this month has none yet, its monthly
 *  copy; then drop daily copies past OFFSITE_DAILY days and monthly ones past OFFSITE_MONTHLY months. */
export async function offsitePush(s3: S3Client, o: { file: string; manifestFile: string | null; key: Buffer; prefix: string; now?: Date }) {
  const now = o.now ?? new Date(), dump = readFileSync(o.file), stem = basename(o.file).replace(/\.dump$/, "");
  const sealedDump = sealBackup(dump, o.key), sealedManifest = o.manifestFile ? sealBackup(readFileSync(o.manifestFile), o.key) : null;
  const daily = `${o.prefix}daily/${stem}`;
  await s3.put(`${daily}.dump.enc`, sealedDump);
  if (sealedManifest) await s3.put(`${daily}.json.enc`, sealedManifest);
  const month = now.toISOString().slice(0, 7), monthly = `${o.prefix}monthly/kumi-${month}`;
  const monthlies = await s3.list(`${o.prefix}monthly/`);
  let monthlyMade = false;
  if (!monthlies.some((x) => x.key === `${monthly}.dump.enc`)) {
    await s3.put(`${monthly}.dump.enc`, sealedDump);
    if (sealedManifest) await s3.put(`${monthly}.json.enc`, sealedManifest);
    monthlyMade = true;
  }
  const dropped = await offsiteRetention(s3, o.prefix);
  return { key: `${daily}.dump.enc`, bytes: sealedDump.length, monthly: monthlyMade ? `${monthly}.dump.enc` : null, dropped };
}

/** Keep the newest OFFSITE_DAILY daily copies and OFFSITE_MONTHLY monthly ones (by the date in their names). */
export async function offsiteRetention(s3: S3Client, prefix: string): Promise<string[]> {
  const dropped: string[] = [];
  for (const [folder, keep, re] of [["daily/", OFFSITE_DAILY, /kumi-(\d{4}-\d{2}-\d{2})\.(dump|json)\.enc$/], ["monthly/", OFFSITE_MONTHLY, /kumi-(\d{4}-\d{2})\.(dump|json)\.enc$/]] as const) {
    const objects = (await s3.list(`${prefix}${folder}`)).filter((x) => re.test(x.key));
    const stamps = [...new Set(objects.map((x) => re.exec(x.key)![1]!))].sort().reverse();
    const old = new Set(stamps.slice(keep));
    for (const x of objects) if (old.has(re.exec(x.key)![1]!)) { await s3.delete(x.key); dropped.push(x.key); }
  }
  return dropped;
}

/** The newest daily copy offsite: its dump and manifest keys. */
export async function offsiteLatest(s3: S3Client, prefix: string): Promise<{ dump: string; manifest: string | null } | null> {
  const objects = await s3.list(`${prefix}daily/`);
  const dumps = objects.map((x) => x.key).filter((k) => /kumi-\d{4}-\d{2}-\d{2}\.dump\.enc$/.test(k)).sort();
  const last = dumps.at(-1);
  if (!last) return null;
  const m = last.replace(/\.dump\.enc$/, ".json.enc");
  return { dump: last, manifest: objects.some((x) => x.key === m) ? m : null };
}

// ---- Restoring ----
/** Empty a database's public schema and restore a dump into it. The server must not be using it (stop it first). */
export async function restoreInto(url: string, dumpFile: string, env: Env = process.env) {
  const db = connect(url);
  try {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
  } finally { await db.destroy(); }
  const target = toolTarget(url);
  await runTool(pgTool("pg_restore", env), ["--no-owner", "--no-acl", "--exit-on-error", "-d", target.url, dumpFile], target.env);
}

/** A local file to restore from: a dump as it is, or a sealed offsite copy opened with the backup key. */
export function readableDump(path: string, env: Env = process.env): { file: string; cleanup: () => void } {
  const head = readFileSync(path).subarray(0, MAGIC.length);
  if (!head.equals(MAGIC)) return { file: path, cleanup: () => {} };
  const key = backupKey(env);
  if (!key) throw new Error("this is a sealed offsite backup: set KUMI_BACKUP_KEY to open it");
  const dir = join(tmpdir(), `kumi-restore-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, basename(path).replace(/\.enc$/, ""));
  writeFileSync(file, openBackup(readFileSync(path), key), { mode: 0o600 });
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A copy fetched from offsite to a private temporary folder, opened. */
export async function fetchOffsite(s3: S3Client, key: string, backupK: Buffer): Promise<{ file: string; cleanup: () => void }> {
  const dir = join(tmpdir(), `kumi-restore-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, basename(key).replace(/\.enc$/, ""));
  writeFileSync(file, openBackup(await s3.get(key), backupK), { mode: 0o600 });
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- The restore test ----
export interface RestoreCheck { ok: boolean; source: string; compared: "manifest" | "live"; tables: number; rows: number; problems: string[] }

/** Compare a restored database's tables and rows with what the backup's manifest says (exactly), or, without a
 *  manifest, with the live database (every restored table is a live one, and no more migrations than live). */
export function compareCounts(restored: Record<string, number>, against: Record<string, number>, exact: boolean): string[] {
  const problems: string[] = [];
  for (const t of Object.keys(against)) if (exact && !(t in restored)) problems.push(`${t} is missing`);
  for (const [t, n] of Object.entries(restored)) {
    if (!(t in against)) problems.push(exact ? `${t} isn't in the manifest` : `${t} isn't in the live database`);
    else if (exact && against[t] !== n) problems.push(`${t} has ${n} rows, the manifest says ${against[t]}`);
  }
  if (!exact && (restored.schema_migration ?? 0) > (against.schema_migration ?? 0)) problems.push("the backup has more migrations than the live database");
  return problems;
}

/** The scratch database's URL: KUMI_RESTORE_TEST_DATABASE_URL, or the live one's server with the database kumi_restore_test. */
export function scratchUrl(liveUrl: string, env: Env = process.env): string {
  return env.KUMI_RESTORE_TEST_DATABASE_URL || withDbName(liveUrl, "kumi_restore_test");
}

/** Restore the newest backup (offsite if it's set up, else the newest local one) into the scratch database, check
 *  it, and empty it again. Records the result; the owner and managers hear once if it starts failing. */
export async function restoreTest(db: Db, o: { liveUrl: string; dir: string; s3: S3Client | null; key: Buffer | null; prefix: string; env?: Env; now?: Date }): Promise<RestoreCheck> {
  const env = o.env ?? process.env, now = o.now ?? new Date();
  let source = "", cleanup = () => {};
  try {
    let dumpFile: string, manifest: Manifest | null = null;
    if (o.s3) {
      if (!o.key) throw new Error("offsite backups need KUMI_BACKUP_KEY to be opened");
      const latest = await offsiteLatest(o.s3, o.prefix);
      if (!latest) throw new Error("there's no offsite backup yet");
      source = latest.dump;
      const got = await fetchOffsite(o.s3, latest.dump, o.key);
      dumpFile = got.file; cleanup = got.cleanup;
      if (latest.manifest) manifest = JSON.parse(openBackup(await o.s3.get(latest.manifest), o.key).toString("utf8")) as Manifest;
    } else {
      const local = newestLocal(o.dir);
      if (!local) throw new Error(`there's no backup in ${o.dir} yet`);
      source = local.file; dumpFile = local.file;
      if (local.manifestFile) manifest = JSON.parse(readFileSync(local.manifestFile, "utf8")) as Manifest;
    }
    if (manifest && manifest.sha256 !== createHash("sha256").update(readFileSync(dumpFile)).digest("hex")) throw new Error("the backup doesn't match its manifest's checksum");
    const url = scratchUrl(o.liveUrl, env), created = await ensureScratch(db, url);
    let restored: Record<string, number> = {};
    try {
      await restoreInto(url, dumpFile, env);
      const scratch = connect(url);
      try { restored = await tableCounts(scratch); } finally { await scratch.destroy(); }
    } finally { await dropScratch(db, url, created); }
    const live = manifest ? null : await tableCounts(db);
    const problems = compareCounts(restored, manifest ? manifest.tables : live!, Boolean(manifest));
    const check: RestoreCheck = { ok: problems.length === 0, source, compared: manifest ? "manifest" : "live", tables: Object.keys(restored).length, rows: Object.values(restored).reduce((a, b) => a + b, 0), problems };
    if (check.ok) await jobWorked(db, "restore_test", { source, compared: check.compared, tables: check.tables, rows: check.rows }, now);
    else await jobFailed(db, "restore_test", `restored ${source} but: ${problems.slice(0, 3).join("; ")}`, now);
    return check;
  } catch (e) {
    await jobFailed(db, "restore_test", (e as Error).message, now);
    throw e;
  } finally { cleanup(); }
}

/** The scratch database: there already (the one-server install makes it), or made now if this server may. */
async function ensureScratch(db: Db, url: string): Promise<boolean> {
  const name = dbNameOf(url);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`the scratch database name ${name} isn't a plain name`);
  if ((await sql<{ n: string }>`SELECT count(*) AS n FROM pg_database WHERE datname = ${name}`.execute(db)).rows[0]!.n !== "0") return false;
  try { await sql.raw(`CREATE DATABASE ${name}`).execute(db); return true; }
  catch (e) { throw new Error(`there's no ${name} database to test restoring into, and this server can't make one (${(e as Error).message}). Make it once: sudo -u postgres createdb -O kumi ${name}`); }
}
/** Drop the scratch database if this run made it; otherwise empty it (the server may not be allowed to make it again). */
async function dropScratch(db: Db, url: string, created: boolean) {
  if (created) { await sql.raw(`DROP DATABASE IF EXISTS ${dbNameOf(url)} WITH (FORCE)`).execute(db); return; }
  const scratch = connect(url);
  try { await sql`DROP SCHEMA IF EXISTS public CASCADE`.execute(scratch); await sql`CREATE SCHEMA public`.execute(scratch); } finally { await scratch.destroy(); }
}

// ---- The nightly job ----
/** The nightly backup: dump with its manifest, tidy old local files, then the offsite copy if it's set up. Each
 *  part is recorded (/health/deep, kumi doctor), and the owner and managers hear once if one starts failing. */
export async function nightlyBackup(db: Db, o: { url: string; dir: string; s3: S3Config | null; env?: Env; now?: Date; fetch?: (u: string, i?: RequestInit) => Promise<Response> }) {
  const env = o.env ?? process.env, now = o.now ?? new Date();
  let made: Awaited<ReturnType<typeof makeBackup>>;
  try {
    made = await makeBackup(db, { url: o.url, dir: o.dir, now, env });
    const tidied = tidyLocal(o.dir, now);
    await jobWorked(db, "backup", { file: basename(made.file), bytes: made.manifest.bytes, tables: Object.keys(made.manifest.tables).length, tidied: tidied.length }, now);
  } catch (e) { await jobFailed(db, "backup", (e as Error).message, now); throw e; }
  if (!o.s3) return { file: made.file, offsite: null };
  try {
    const key = backupKey(env);
    if (!key) throw new Error("KUMI_BACKUP_KEY isn't set, so nothing can go offsite");
    const s3 = new S3Client(o.s3, o.fetch ? { fetch: o.fetch } : {});
    const r = await offsitePush(s3, { file: made.file, manifestFile: made.manifestFile, key, prefix: offsitePrefix(env), now });
    await jobWorked(db, "offsite", { key: r.key, bytes: r.bytes, monthly: r.monthly, dropped: r.dropped.length, bucket: o.s3.bucket }, now);
    return { file: made.file, offsite: r };
  } catch (e) { await jobFailed(db, "offsite", (e as Error).message, now); throw e; }
}

/** How old the newest local dump is, for doctor and /health/deep. */
export function newestLocalAge(dir: string, now = new Date()): number | null {
  const n = newestLocal(dir);
  return n ? (now.getTime() - statSync(n.file).mtimeMs) / 3600_000 : null;
}
