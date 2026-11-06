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
import { atLocal, connect, heartbeat, jobFailed, jobWorked, localParts, migrate, parseSecretKey, type Db, type OpsJob } from "@kumi/core";
import { S3Client, type S3Config } from "./s3.ts";
import { expectedShape, putSettingsBack, schemaShape, settingsNow, shapeDifferences, type Shape } from "./shape.ts";

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
export const dbNameOf = (url: string) => decodeURIComponent(/^[a-z]+:\/\/[^/]*\/([^?]*)/.exec(url)?.[1] ?? "");
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
/** redacted: the accounts deleted as of the backup, so a restore whose database before it can't vouch still deletes
 *  them again (after_restore.ts). */
export interface Manifest { kind: "kumi-backup"; created_at: string; file: string; bytes: number; sha256: string; migrations: number; tables: Record<string, number>; redacted?: Array<{ id: string; at: string }> }

async function tableCounts(db: Kysely<any>): Promise<Record<string, number>> {
  const tables = (await sql<{ t: string }>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`.execute(db)).rows.map((r) => r.t);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(t)}`.execute(db)).rows[0]!.n);
  return out;
}
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** A backup's name on the club's clock, to the minute: kumi-2026-11-01T2139. Every backup keeps its own file (a
 *  second one in the same minute gets -2, -3...), so one run by hand never replaces the night's. Names from before
 *  this (kumi-2026-11-01, one a day) are still read everywhere. */
export function backupStem(now: Date, tz: string): string {
  const p = localParts(now, tz);
  return `kumi-${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}${pad(p.min)}`;
}
/** A nightly backup's name taken apart: its club date, and a key that sorts backups oldest first. */
const STEM = /^kumi-(\d{4}-\d{2}-\d{2})(?:T(\d{4})(?:-(\d+))?)?$/;
export function parseStem(stem: string): { date: string; sortKey: string } | null {
  const m = STEM.exec(stem);
  return m ? { date: m[1]!, sortKey: `${m[1]}T${m[2] ?? "0000"}#${pad(Number(m[3] ?? 1), 4)}` } : null;
}
const stemOf = (name: string) => name.replace(/\.(dump|json)(\.enc)?$/, "");
const byAge = (a: string, b: string) => parseStem(stemOf(basename(a)))!.sortKey.localeCompare(parseStem(stemOf(basename(b)))!.sortKey);
export async function clubTimeZone(db: Db): Promise<string> {
  return (await db.selectFrom("club").select("time_zone").executeTakeFirst())?.time_zone ?? "UTC";
}

/** Dump the database (custom format) with a manifest of every table's rows, from one snapshot. `label` names a
 *  dump made for something else (an update): those aren't the nightly files and aren't tidied with them. */
export async function makeBackup(db: Db, o: { url: string; dir: string; now?: Date; label?: string; env?: Env; tz?: string }): Promise<{ file: string; manifestFile: string; manifest: Manifest }> {
  const now = o.now ?? new Date(), env = o.env ?? process.env;
  mkdirSync(o.dir, { recursive: true });
  let name = o.label ? `kumi-${o.label}` : backupStem(now, o.tz ?? await clubTimeZone(db));
  if (!o.label) for (let n = 2; existsSync(join(o.dir, `${name}.dump`)) || existsSync(join(o.dir, `${name}.json`)); n++) name = `${name.replace(/-\d+$/, "")}-${n}`;
  const file = join(o.dir, `${name}.dump`), manifestFile = join(o.dir, `${name}.json`), part = `${file}.part`;
  const target = toolTarget(o.url);
  let tables: Record<string, number> = {}, redacted: Array<{ id: string; at: string }> = [];
  // A dump holds every member's details: only this server's user reads it, wherever the folder is (Docker's
  // ./backups is a plain folder the owner made). pg_dump keeps the mode of a file that's already there.
  const owner = (f: string) => { if (existsSync(f)) chmodSync(f, 0o600); };
  writeFileSync(part, "", { mode: 0o600 }); owner(part);
  // Repeatable read: the counts and pg_dump (handed the same snapshot) see exactly the same rows. A dump that fails
  // (a table this user can't read, say) leaves nothing behind.
  try {
    await db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      const snapshot = (await sql<{ s: string }>`SELECT pg_export_snapshot() AS s`.execute(trx)).rows[0]!.s;
      tables = await tableCounts(trx);
      redacted = (await sql<{ id: string; at: string }>`SELECT id::text AS id, redacted_at::text AS at FROM person WHERE redacted_at IS NOT NULL`.execute(trx).catch(() => ({ rows: [] }))).rows;
      await runTool(pgTool("pg_dump", env), ["-Fc", "--no-owner", "--no-acl", `--snapshot=${snapshot}`, "-f", part, "-d", target.url], target.env);
    });
  } catch (e) { rmSync(part, { force: true }); throw e; }
  const bytes = readFileSync(part);
  writeFileSync(file, bytes, { mode: 0o600 }); owner(file);
  rmSync(part, { force: true });
  const manifest: Manifest = { kind: "kumi-backup", created_at: now.toISOString(), file: basename(file), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    migrations: tables.schema_migration ?? 0, tables, redacted };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 }); owner(manifestFile);
  return { file, manifestFile, manifest };
}

/** Nightly files older than LOCAL_DAYS go. Update snapshots and anything else are left alone. */
export function tidyLocal(dir: string, now = new Date()): string[] {
  const gone: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return gone; }
  for (const f of names) {
    const m = /\.(dump|json)$/.test(f) ? parseStem(stemOf(f)) : null;
    if (m && now.getTime() - new Date(`${m.date}T00:00:00Z`).getTime() > LOCAL_DAYS * 86400_000) { rmSync(join(dir, f), { force: true }); gone.push(f); }
  }
  return gone;
}
/** The newest nightly dump in the folder (and its manifest, if there is one). */
export function newestLocal(dir: string): { file: string; manifestFile: string | null } | null {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return null; }
  const dumps = names.filter((f) => f.endsWith(".dump") && parseStem(stemOf(f))).sort(byAge);
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
/** Whether Kumi removes old offsite copies itself (the default), or leaves that to the storage's own lifecycle
 *  rules (KUMI_OFFSITE_PRUNE=0): then the server's key needs no right to delete, so whoever takes the server
 *  can't wipe the offsite copies with it. */
export const offsitePrunes = (env: Env = process.env) => env.KUMI_OFFSITE_PRUNE?.trim() !== "0";
export async function offsitePush(s3: S3Client, o: { file: string; manifestFile: string | null; key: Buffer; prefix: string; now?: Date; tz?: string; prune?: boolean }) {
  const now = o.now ?? new Date(), dump = readFileSync(o.file), stem = basename(o.file).replace(/\.dump$/, "");
  const sealedDump = sealBackup(dump, o.key), sealedManifest = o.manifestFile ? sealBackup(readFileSync(o.manifestFile), o.key) : null;
  const daily = `${o.prefix}daily/${stem}`;
  await s3.put(`${daily}.dump.enc`, sealedDump);
  if (sealedManifest) await s3.put(`${daily}.json.enc`, sealedManifest);
  // The month on the club's clock: the first good backup of the club's month is kept as its monthly copy, never replaced.
  const lp = localParts(now, o.tz ?? "UTC"), month = `${lp.y}-${pad(lp.m)}`, monthly = `${o.prefix}monthly/kumi-${month}`;
  const monthlies = await s3.list(`${o.prefix}monthly/`);
  let monthlyMade = false;
  if (!monthlies.some((x) => x.key === `${monthly}.dump.enc`)) {
    await s3.put(`${monthly}.dump.enc`, sealedDump);
    if (sealedManifest) await s3.put(`${monthly}.json.enc`, sealedManifest);
    monthlyMade = true;
  }
  const dropped = o.prune === false ? [] : await offsiteRetention(s3, o.prefix);
  return { key: `${daily}.dump.enc`, bytes: sealedDump.length, monthly: monthlyMade ? `${monthly}.dump.enc` : null, dropped };
}

/** Keep the daily copies of the newest OFFSITE_DAILY days (every copy made on those days) and the newest
 *  OFFSITE_MONTHLY monthly ones, by the club date in their names. */
export async function offsiteRetention(s3: S3Client, prefix: string): Promise<string[]> {
  const dropped: string[] = [];
  for (const [folder, keep, re] of [["daily/", OFFSITE_DAILY, /kumi-(\d{4}-\d{2}-\d{2})(?:T\d{4}(?:-\d+)?)?\.(dump|json)\.enc$/], ["monthly/", OFFSITE_MONTHLY, /kumi-(\d{4}-\d{2})\.(dump|json)\.enc$/]] as const) {
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
  const dumps = objects.map((x) => x.key).filter((k) => k.endsWith(".dump.enc") && parseStem(stemOf(basename(k)))).sort(byAge);
  const last = dumps.at(-1);
  if (!last) return null;
  const m = last.replace(/\.dump\.enc$/, ".json.enc");
  return { dump: last, manifest: objects.some((x) => x.key === m) ? m : null };
}

// ---- Restoring ----
/** Read a dump's table of contents (pg_restore --list) without changing anything: a file that isn't a backup, or
 *  is cut short, is refused here, before the live database is touched. */
export async function checkDump(dumpFile: string, env: Env = process.env) {
  try { await runTool(pgTool("pg_restore", env), ["--list", dumpFile], {}); }
  catch (e) { throw new RestoreRefused(`${basename(dumpFile)} isn't a backup that can be restored (${(e as Error).message})`); }
}
/** Nothing was changed: the file was refused, or the copy of the database as it is couldn't be made. */
export class RestoreRefused extends Error {}
/** The restore failed after the database was emptied. `putBack` says whether the copy made just before went back in. */
export class RestoreFailed extends Error {
  readonly safetyCopy: string; readonly putBack: boolean;
  constructor(message: string, safetyCopy: string, putBack: boolean) { super(message); this.safetyCopy = safetyCopy; this.putBack = putBack; }
}

/** Replace the live database with a backup, without ever leaving the club empty: the file is checked first, a
 *  copy of the database as it is now is made (kumi-<time>-before-restore.dump, kept, not tidied), and if the
 *  restore fails that copy is put back. What the file brings besides rows must be what Kumi's own migrations make
 *  (shape.ts): a file with a function, trigger, rule, view, policy or setting of anyone else's is refused, and the
 *  database goes back as it was. The server must not be using the database (stop it first). The restored copy
 *  leaves here with this Kumi's migrations applied. */
export async function safeRestore(url: string, dumpFile: string, o: { dir: string; now?: Date; env?: Env }): Promise<{ safetyCopy: string }> {
  const env = o.env ?? process.env, now = o.now ?? new Date();
  await checkDump(dumpFile, env);
  const label = `${now.toISOString().slice(0, 16).replace(/[-:]/g, "")}Z-before-restore`;
  const db = connect(url);
  let safetyCopy: string, before: Shape, settings: Awaited<ReturnType<typeof settingsNow>>;
  try {
    safetyCopy = (await makeBackup(db, { url, dir: o.dir, label, env, now })).file;
    // What this server's database already has that Kumi doesn't make (a managed Postgres's own schema, say) isn't
    // the file's doing: it's allowed back.
    before = await schemaShape(db); settings = await settingsNow(db);
  }
  catch (e) { throw new RestoreRefused(`a copy of the database as it is couldn't be made first, so nothing was changed (${(e as Error).message})`); }
  finally { await db.destroy(); }
  const putBack = async (why: string): Promise<never> => {
    try { await restoreInto(url, safetyCopy, env); }
    catch (e2) { throw new RestoreFailed(`${why}; putting the database back failed too: ${(e2 as Error).message}`, safetyCopy, false); }
    finally { const d = connect(url); try { await putSettingsBack(d, settings); } finally { await d.destroy(); } }
    throw new RestoreFailed(why, safetyCopy, true);
  };
  try { await restoreInto(url, dumpFile, env); }
  catch (e) { return putBack((e as Error).message); }
  let foreign: string[];
  try { foreign = await foreignShape(url, before); }
  catch (e) { return putBack((e as Error).message); }
  if (foreign.length) {
    await putBack("refused").catch((e: unknown) => { if (!(e instanceof RestoreFailed) || !e.putBack) throw e; });
    throw new RestoreRefused(`${basename(dumpFile)} holds things Kumi's own migrations don't make, so it wasn't restored and the database is as it was: ${foreign.slice(0, 6).join("; ")}${foreign.length > 6 ? ` (and ${foreign.length - 6} more)` : ""}`);
  }
  return { safetyCopy };
}

/** Rules, triggers and functions earlier Kumis made and a later migration took away: a copy from before then has them. */
const EARLIER_KUMI = new Set(["rule public.rating_event.rating_event_no_update"]);
/** What the restored copy has that's neither Kumi's nor this server's own (shape.ts): first by name, before Kumi's
 *  migrations run on it, then in full once they have. Empty when it's Kumi's. */
async function foreignShape(url: string, before: Shape): Promise<string[]> {
  const db = connect(url);
  try {
    const name = (l: string) => l.split(" | ")[0]!;
    const want = expectedShape(), here = new Set(before.objects);
    const known = new Set([...want.objects, ...before.objects].map(name));
    const early = (await schemaShape(db)).objects.map(name).filter((n) => !known.has(n) && !EARLIER_KUMI.has(n));
    if (early.length) return early.map((n) => `not Kumi's: ${n}`);
    await migrate(db);
    const got = await schemaShape(db);
    // Definitions compare on the Postgres shape.json was recorded on; this server's own objects, exactly as they were.
    const key = got.postgres === want.postgres ? (l: string) => l : name;
    const should = new Set(want.objects.map(key)), have = new Set(got.objects.map(key));
    return [...got.objects.filter((l) => !should.has(key(l)) && !here.has(l)).map((l) => `not Kumi's: ${name(l)}`),
      ...want.objects.filter((l) => !have.has(key(l))).map((l) => `missing: ${name(l)}`)];
  } finally { await db.destroy(); }
}

/** Empty a database's public schema and restore a dump into it. The server must not be using it (stop it first).
 *  `kumi restore` goes through safeRestore; the restore test uses this on its scratch database. */
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
    if (!created && await isSameDatabase(db, url)) throw new Error("the restore test's scratch database is the live database: KUMI_RESTORE_TEST_DATABASE_URL must name another one");
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

/** Whether a URL reaches the very database `db` is connected to: the same name, the same database id, on a server
 *  started at the same moment. The restore test empties its scratch database, so it must never be the live one,
 *  however the two URLs are written (a socket and 127.0.0.1, another user). */
export async function isSameDatabase(db: Kysely<any>, url: string): Promise<boolean> {
  const who = async (d: Kysely<any>) => (await sql<{ name: string; id: string; started: string }>`SELECT current_database() AS name,
    (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS id, pg_postmaster_start_time()::text AS started`.execute(d)).rows[0]!;
  const other = connect(url);
  try {
    const [a, b] = [await who(db), await who(other)];
    return a.name === b.name && a.id === b.id && a.started === b.started;
  } finally { await other.destroy(); }
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

// ---- The server's own records across a restore ----
type OpsRecord = { name: string; last_run_at: Date | null; last_ok_at: Date | null; last_error: string | null; details: unknown };
/** The server's job records (when the backup, offsite copy and restore test last ran). They describe this server,
 *  not the club's data, so `kumi restore` reads them first and writes them back after: otherwise doctor would
 *  report the night the backup was made ("the restore test hasn't run yet"). */
export async function readOpsRecords(url: string): Promise<OpsRecord[]> {
  const db = connect(url);
  try { return await db.selectFrom("ops_heartbeat").selectAll().execute(); } catch { return []; } finally { await db.destroy(); }
}
export async function writeOpsRecords(url: string, rows: OpsRecord[]): Promise<void> {
  if (!rows.length) return;
  const db = connect(url);
  try {
    for (const r of rows) {
      const v = { last_run_at: r.last_run_at, last_ok_at: r.last_ok_at, last_error: r.last_error, details: JSON.stringify(r.details ?? {}) };
      await db.insertInto("ops_heartbeat").values({ name: r.name, ...v }).onConflict((oc) => oc.column("name").doUpdateSet(v)).execute();
    }
  } catch { /* a backup from before these records existed: the server sets them again as its jobs run */ } finally { await db.destroy(); }
}

// ---- When they run ----
/** The nightly backup at 3:17, the restore test on the 1st at 4:17 and the point-in-time test on the 1st at 5:17,
 *  all on the club's clock. The server's timer (or the Docker backup service) ticks every hour; each tick asks
 *  whether its job is due. */
export type ScheduledJob = "backup" | "restore_test" | "pitr_test";
export const SCHEDULE: Record<ScheduledJob, { hour: number; monthDay?: number }> = { backup: { hour: 3 }, restore_test: { hour: 4, monthDay: 1 }, pitr_test: { hour: 5, monthDay: 1 } };

/** The latest time a job was meant to run, on the club's clock: today's (or this month's) slot once it has come,
 *  otherwise the one before. A job is due when it hasn't run since then, so a server that was off at 3 AM catches
 *  up at its next tick, and a backup someone ran by hand after the slot counts as that night's. */
export function lastSlot(now: Date, tz: string, at: { hour: number; monthDay?: number }): Date {
  const p = localParts(now, tz);
  if (at.monthDay) {
    const thisMonth = atLocal(p.y, p.m, at.monthDay, at.hour, tz);
    return thisMonth <= now ? thisMonth : atLocal(p.m === 1 ? p.y - 1 : p.y, p.m === 1 ? 12 : p.m - 1, at.monthDay, at.hour, tz);
  }
  const today = atLocal(p.y, p.m, p.d, at.hour, tz);
  return today <= now ? today : atLocal(p.y, p.m, p.d - 1, at.hour, tz);
}

/** Is the nightly backup (or a monthly test) due now? The club's time zone, or UTC before a club exists. */
export async function scheduledDue(db: Db, job: ScheduledJob, now = new Date()): Promise<{ due: boolean; tz: string; slot: Date }> {
  const tz = await clubTimeZone(db);
  const slot = lastSlot(now, tz, SCHEDULE[job]);
  const last = (await heartbeat(db, job as OpsJob))?.last_run_at ?? null;
  return { due: !last || last < slot, tz, slot };
}

// ---- The nightly job ----
/** The nightly backup: dump with its manifest, tidy old local files, then the offsite copy if it's set up. Each
 *  part is recorded (/health/deep, kumi doctor), and the owner and managers hear once if one starts failing. */
export async function nightlyBackup(db: Db, o: { url: string; dir: string; s3: S3Config | null; env?: Env; now?: Date; fetch?: (u: string, i?: RequestInit) => Promise<Response> }) {
  const env = o.env ?? process.env, now = o.now ?? new Date(), tz = await clubTimeZone(db);
  let made: Awaited<ReturnType<typeof makeBackup>>;
  try {
    made = await makeBackup(db, { url: o.url, dir: o.dir, now, env, tz });
    const tidied = tidyLocal(o.dir, now);
    await jobWorked(db, "backup", { file: basename(made.file), bytes: made.manifest.bytes, tables: Object.keys(made.manifest.tables).length, tidied: tidied.length }, now);
  } catch (e) { await jobFailed(db, "backup", (e as Error).message, now); throw e; }
  if (!o.s3) return { file: made.file, offsite: null };
  try {
    const key = backupKey(env);
    if (!key) throw new Error("KUMI_BACKUP_KEY isn't set, so nothing can go offsite");
    const s3 = new S3Client(o.s3, o.fetch ? { fetch: o.fetch } : {});
    const prune = offsitePrunes(env);
    const r = await offsitePush(s3, { file: made.file, manifestFile: made.manifestFile, key, prefix: offsitePrefix(env), now, tz, prune });
    await jobWorked(db, "offsite", { key: r.key, bytes: r.bytes, monthly: r.monthly, dropped: r.dropped.length, bucket: o.s3.bucket, prune }, now);
    return { file: made.file, offsite: r };
  } catch (e) { await jobFailed(db, "offsite", (e as Error).message, now); throw e; }
}

/** How old the newest local dump is, for doctor and /health/deep. */
export function newestLocalAge(dir: string, now = new Date()): number | null {
  const n = newestLocal(dir);
  return n ? (now.getTime() - statSync(n.file).mtimeMs) / 3600_000 : null;
}
