// Point-in-time backups. Postgres writes every change to its write-ahead log (WAL) first; pgBackRest copies each
// finished piece of it away, at least once a minute while the club is busy (archive_timeout), and takes a base
// backup of the whole database every night (a full one once a week). Together they can bring the database back as
// it was at any minute since the oldest base backup kept: a mistake at 14:06 is undone by going back to 14:05.
//
// The stated target (docs/setup/accounts/offsite-backups.md): lose at most about a minute of the club's changes,
// and be back within an hour. The monthly test measures the second (how long a restore took).
//
// Two copies of the archive ("repositories"):
//   1. on this server (/var/lib/pgbackrest): the quick one, for mistakes, the common case;
//   2. offsite, beside the nightly dumps (<prefix>pitr/ in the same bucket), sealed with a key derived from
//      OPENPADEL_BACKUP_KEY, so the key the owner already keeps opens it too, and it survives losing the server.
// pgBackRest expires old backups and WAL itself, so the key it uses offsite must be able to delete: with
// OPENPADEL_OFFSITE_PRUNE=0 (a key that can't), the offsite archive stays off and only the local one runs.
//
// Restoring goes through a scratch copy: pgBackRest recovers the archive into a folder of its own, a private
// Postgres starts on it and stops replaying at the chosen minute, the club's database is dumped from it, and that
// dump goes in through the usual safe restore (a copy of the database as it is now is made first). The live
// database is never touched by pgBackRest. These commands run as the postgres user, who owns the archive.
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { atLocal, localParts } from "@kumi/core";
import { s3FromEnv } from "./s3.ts";
import { setting } from "@kumi/core";

type Env = Record<string, string | undefined>;

export const STANZA = "kumi";
/** How long after the first base backup the point-in-time test can run: it goes back to a minute at least one minute
 *  after that backup and at least ten minutes ago (pitrTestRun), so eleven minutes. doctor says the time it can from. */
export const PITR_TEST_WAIT_MS = 11 * 60_000;
export const PITR_CONF = "/etc/pgbackrest/pgbackrest.conf";
/** How far back each copy reaches, in days: pgBackRest keeps the base backups needed to go back this far (so the
 *  oldest one kept can be up to a week older, with weekly full backups). */
export const LOCAL_DAYS = 14, OFFSITE_DAYS = 30;
/** The nightly base backup at 3:37 on the club's clock (20 minutes after the nightly dump), a full one when the
 *  newest full backup in that copy is FULL_EVERY_DAYS old or more. */
export const BASE_AT = { hour: 3, minute: 37 }, FULL_EVERY_DAYS = 6.5;

/** Where things are, and the name of Postgres's superuser (pgBackRest's, and a scratch copy's): `postgres` on a
 *  one-server install, `kumi` in Docker, where the Postgres image names it after POSTGRES_USER. */
export interface PitrPaths { pgPath: string; socket: string; repoPath: string; spool: string; log: string; pgBin: string; superuser: string }
export const DEFAULT_PATHS: PitrPaths = {
  pgPath: "/var/lib/postgresql/17/main", socket: "/var/run/postgresql", repoPath: "/var/lib/pgbackrest",
  spool: "/var/spool/pgbackrest", log: "/var/log/pgbackrest", pgBin: "/usr/lib/postgresql/17/bin", superuser: "postgres",
};
/** This server's paths: the defaults, or what Docker's pitr service says (its data folder, Postgres's own programs and
 *  superuser are the Postgres image's). */
export const pitrPaths = (env: Env): PitrPaths => ({
  ...DEFAULT_PATHS,
  ...(setting("PITR_PG_PATH", env)?.trim() ? { pgPath: setting("PITR_PG_PATH", env)!.trim() } : {}),
  ...(setting("PITR_PG_SOCKET", env)?.trim() ? { socket: setting("PITR_PG_SOCKET", env)!.trim() } : {}),
  ...(setting("PG_BIN", env)?.trim() ? { pgBin: setting("PG_BIN", env)!.trim() } : {}),
  ...(setting("PITR_PG_USER", env)?.trim() ? { superuser: setting("PITR_PG_USER", env)!.trim() } : {}),
});

/** The passphrase the offsite archive is sealed with: from OPENPADEL_BACKUP_KEY, so the key that opens the nightly
 *  offsite copies opens this too, and nothing new needs keeping. */
export function pitrCipherPass(backupKey: Buffer): string {
  return createHmac("sha256", backupKey).update("kumi point-in-time archive v1").digest("base64url");
}

export interface PitrRepo { n: 1 | 2; where: "local" | "offsite" }
export interface PitrConfig { text: string; repos: PitrRepo[]; offsite: "on" | "off" | "no_prune" | "no_key" | "not_https" }

/** pgBackRest's settings for this server, from the server's own: where offsite copies go and the backup key.
 *  Written to /etc/pgbackrest/pgbackrest.conf (root's, the postgres user reads it) by setup and every update. */
/** The offsite archive's folder: one per Postgres cluster (its system id), so a server set up again after losing
 *  the old one starts an archive of its own beside the old one's, which stays there to go back into. */
export const offsiteArchivePath = (env: Env, systemId?: string | null) => {
  const prefix = (setting("OFFSITE_PREFIX", env) ?? "kumi/").replace(/^\/+/, "").replace(/\/?$/, "/");
  return `/${prefix}pitr${systemId ? `/${systemId}` : ""}`;
};

export function pitrConf(env: Env, o: { backupKey: Buffer | null; paths?: PitrPaths; stanza?: string; localDays?: number; offsiteDays?: number; systemId?: string | null } ): PitrConfig {
  const p = o.paths ?? DEFAULT_PATHS, stanza = o.stanza ?? STANZA;
  const s3 = s3FromEnv(env), prunes = setting("OFFSITE_PRUNE", env)?.trim() !== "0";
  let offsite: PitrConfig["offsite"] = "off";
  let endpoint: URL | null = null;
  if (s3) {
    try { endpoint = new URL(s3.endpoint); } catch { endpoint = null; }
    offsite = !prunes ? "no_prune" : !o.backupKey ? "no_key" : endpoint?.protocol !== "https:" ? "not_https" : "on";
  }
  const lines = [
    "# Point-in-time backups (openPadel's apps/server/src/pitr.ts). Written from the server's settings (/etc/kumi/kumi.env,",
    "# or Docker's .env) by setup, every update and Docker's pitr service: change those settings, not this file.",
    `# offsite: ${offsite}`,
    "[global]",
    `repo1-path=${p.repoPath}`,
    "repo1-retention-full-type=time",
    `repo1-retention-full=${o.localDays ?? LOCAL_DAYS}`,
  ];
  const repos: PitrRepo[] = [{ n: 1, where: "local" }];
  if (offsite === "on" && s3 && endpoint && o.backupKey) {
    lines.push(
      "repo2-type=s3",
      `repo2-path=${offsiteArchivePath(env, o.systemId)}`,
      `repo2-s3-endpoint=${endpoint.hostname}`,
      // A storage on its own port (MinIO's 9000, say): pgBackRest takes the port as a setting of its own.
      ...(endpoint.port ? [`repo2-storage-port=${endpoint.port}`] : []),
      `repo2-s3-bucket=${s3.bucket}`,
      `repo2-s3-region=${s3.region}`,
      `repo2-s3-key=${s3.accessKeyId}`,
      `repo2-s3-key-secret=${s3.secretAccessKey}`,
      `repo2-s3-uri-style=${s3.pathStyle ? "path" : "host"}`,
      "repo2-cipher-type=aes-256-cbc",
      `repo2-cipher-pass=${pitrCipherPass(o.backupKey)}`,
      "repo2-retention-full-type=time",
      `repo2-retention-full=${o.offsiteDays ?? OFFSITE_DAYS}`,
    );
    repos.push({ n: 2, where: "offsite" });
  }
  lines.push(
    // WAL goes out in the background, so a slow bucket never holds Postgres up; past 2 GiB waiting (the bucket down
    // for a long time), pieces are let go rather than fill the disk, and doctor says the archive has a gap.
    "archive-async=y",
    `spool-path=${p.spool}`,
    "archive-push-queue-max=2GiB",
    "process-max=2",
    "compress-type=zst",
    "start-fast=y",
    `log-path=${p.log}`,
    "log-level-console=warn",
    "log-level-file=info",
    "",
    `[${stanza}]`,
    `pg1-path=${p.pgPath}`,
    `pg1-socket-path=${p.socket}`,
    // pgBackRest asks Postgres's own questions (in the postgres database) as its superuser, postgres unless named.
    ...(p.superuser !== "postgres" ? [`pg1-user=${p.superuser}`] : []),
    "",
  );
  return { text: lines.join("\n"), repos, offsite };
}

// ---- Running things ----
export interface Ran { code: number; stdout: string; stderr: string }
/** How commands run, and files are made, as the postgres user: here, or (tests) somewhere else. */
export interface Runner {
  run(cmd: string, args: string[], o?: { env?: Env; okCodes?: number[] }): Promise<Ran>;
  write(path: string, text: string, mode: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export const localRunner: Runner = {
  run: (cmd, args, o = {}) => new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...o.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += String(d); });
    p.stderr.on("data", (d) => { stderr += String(d); });
    p.on("error", (e) => reject(new Error(`${cmd}: ${e.message}`)));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  }),
  write: async (path, text, mode) => { writeFileSync(path, text, { mode }); },
  mkdir: async (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }); },
  remove: async (path) => { if (existsSync(path)) rmSync(path, { recursive: true, force: true }); },
};
async function must(r: Runner, cmd: string, args: string[], what: string, env?: Env): Promise<string> {
  const x = await r.run(cmd, args, env ? { env } : {});
  if (x.code !== 0) throw new Error(`${what} failed (${x.code}): ${(x.stderr || x.stdout).trim().split("\n").slice(-3).join(" ")}`);
  return x.stdout;
}

export interface PitrOptions { conf?: string; stanza?: string; paths?: PitrPaths; runner?: Runner; now?: Date }
const bin = (o: PitrOptions) => (name: string) => join((o.paths ?? DEFAULT_PATHS).pgBin, name);
const br = (o: PitrOptions, ...args: string[]) => [`--config=${o.conf ?? PITR_CONF}`, `--stanza=${o.stanza ?? STANZA}`, ...args];

// ---- What's in the archive ----
export interface BackupSet { label: string; type: "full" | "diff" | "incr"; repo: number; start: Date; stop: Date }
export interface ArchiveInfo { status: string; backups: BackupSet[]; repos: Array<{ n: number; ok: boolean; message: string }> }

/** `pgbackrest info --output=json`, taken apart: each base backup (which copy, when) and each copy's state. */
export function parseInfo(json: string, stanza = STANZA): ArchiveInfo {
  const all = JSON.parse(json) as Array<{ name: string; status?: { message?: string }; backup?: Array<{ label: string; type: BackupSet["type"]; database?: { "repo-key"?: number }; timestamp: { start: number; stop: number }; error?: boolean }>; repo?: Array<{ key: number; status?: { code?: number; message?: string } }> }>;
  const s = all.find((x) => x.name === stanza);
  if (!s) return { status: "no stanza", backups: [], repos: [] };
  return {
    status: s.status?.message ?? "",
    backups: (s.backup ?? []).filter((b) => !b.error).map((b) => ({ label: b.label, type: b.type, repo: b.database?.["repo-key"] ?? 1, start: new Date(b.timestamp.start * 1000), stop: new Date(b.timestamp.stop * 1000) })),
    repos: (s.repo ?? []).map((r) => ({ n: r.key, ok: (r.status?.code ?? 0) === 0, message: r.status?.message ?? "" })),
  };
}
export async function archiveInfo(o: PitrOptions & { archivePath?: string } = {}): Promise<ArchiveInfo> {
  const which = o.archivePath ? ["--repo=2", `--repo2-path=${o.archivePath}`] : [];
  return parseInfo(await must(o.runner ?? localRunner, "pgbackrest", br(o, ...which, "--output=json", "info"), "pgbackrest info"), o.stanza ?? STANZA);
}
/** The earliest minute the archive can bring the database back to: the end of the oldest base backup kept. */
export function restorableFrom(info: ArchiveInfo, repo?: number): Date | null {
  const stops = info.backups.filter((b) => repo === undefined || b.repo === repo).map((b) => b.stop.getTime());
  return stops.length ? new Date(Math.min(...stops)) : null;
}

// ---- The nightly base backup ----
/** The latest 3:37 on the club's clock at or before `now`. */
export function baseSlot(now: Date, tz: string): Date {
  const p = localParts(now, tz), today = atLocal(p.y, p.m, p.d, BASE_AT.hour, tz, BASE_AT.minute);
  return today <= now ? today : atLocal(p.y, p.m, p.d - 1, BASE_AT.hour, tz, BASE_AT.minute);
}
/** What each copy needs now: nothing, the nightly differential one, or a full one (none yet, or the newest full one
 *  is a week old). A copy is due when its newest base backup is older than the last 3:37. */
export function basePlan(info: ArchiveInfo, repos: number[], now: Date, tz: string): Array<{ repo: number; type: "full" | "diff" }> {
  const slot = baseSlot(now, tz), out: Array<{ repo: number; type: "full" | "diff" }> = [];
  for (const n of repos) {
    const mine = info.backups.filter((b) => b.repo === n), fulls = mine.filter((b) => b.type === "full");
    const newest = Math.max(0, ...mine.map((b) => b.stop.getTime())), newestFull = Math.max(0, ...fulls.map((b) => b.stop.getTime()));
    if (!fulls.length || now.getTime() - newestFull >= FULL_EVERY_DAYS * 86400_000) { if (!fulls.length || newest < slot.getTime()) out.push({ repo: n, type: "full" }); }
    else if (newest < slot.getTime()) out.push({ repo: n, type: "diff" });
  }
  return out;
}
/** The repositories this server's settings list (repo1-path, repo2-type...), from the config text. */
export function confRepos(confText: string): number[] {
  return [...new Set([...confText.matchAll(/^repo(\d+)-(?:path|type)=/gm)].map((m) => Number(m[1])))].sort();
}
/** Why the offsite copy is on or off, as the config file says it (its "# offsite:" line). */
export const confOffsite = (confText: string): PitrConfig["offsite"] | "managed" =>
  (/^# offsite: (on|off|no_prune|no_key|not_https|managed)$/m.exec(confText)?.[1] as PitrConfig["offsite"] | "managed" | undefined) ?? "off";
/** Take the base backups that are due (or every copy's, with `force`): what was taken, in which copy. */
export async function baseBackups(due: Array<{ repo: number; type: "full" | "diff" }>, o: PitrOptions = {}): Promise<string[]> {
  const r = o.runner ?? localRunner, done: string[] = [];
  for (const d of due) { await must(r, "pgbackrest", br(o, `--repo=${d.repo}`, `--type=${d.type}`, "backup"), `the ${d.type} base backup (copy ${d.repo})`); done.push(`${d.type}@${d.repo}`); }
  return done;
}

// ---- The archiver, as Postgres sees it ----
export interface ArchiverState { mode: string; archived: number; failed: number; lastArchivedAt: Date | null; lastFailedAt: Date | null; lastFailedWal: string | null }
export async function archiverState(db: Kysely<any>): Promise<ArchiverState> {
  const mode = (await sql<{ m: string }>`SELECT current_setting('archive_mode') AS m`.execute(db)).rows[0]!.m;
  const a = (await sql<{ archived_count: string; failed_count: string; last_archived_time: Date | null; last_failed_time: Date | null; last_failed_wal: string | null }>`SELECT archived_count, failed_count, last_archived_time, last_failed_time, last_failed_wal FROM pg_stat_archiver`.execute(db)).rows[0]!;
  return { mode, archived: Number(a.archived_count), failed: Number(a.failed_count), lastArchivedAt: a.last_archived_time, lastFailedAt: a.last_failed_time, lastFailedWal: a.last_failed_wal };
}
/** Archiving is failing now: the last try failed, after the last one that worked. */
export const archiverFailing = (s: ArchiverState) => Boolean(s.lastFailedAt && (!s.lastArchivedAt || s.lastFailedAt > s.lastArchivedAt));

// ---- Going back to a minute ----
/** "2026-11-03 14:05" on the club's clock, as an instant. Refused: anything else, and a minute that doesn't exist
 *  (the hour skipped when clocks go forward). */
export function clubMinute(text: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new PitrRefused("bad_time", { time: text });
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const at = atLocal(y, mo, d, h, tz, mi), p = localParts(at, tz);
  if (p.y !== y || p.m !== mo || p.d !== d || p.h !== h || p.min !== mi) throw new PitrRefused("no_such_minute", { time: text });
  return at;
}
/** pgBackRest's form of an instant: "2026-11-03 22:05:00+00". */
export const pgTime = (d: Date) => `${d.toISOString().slice(0, 19).replace("T", " ")}+00`;

/** A restore to a minute that can't be done, and why (an i18n key under cli.pitr_, with its values). */
export class PitrRefused extends Error {
  readonly why: string; readonly values: Record<string, string>;
  constructor(why: string, values: Record<string, string> = {}) { super(`${why} ${JSON.stringify(values)}`); this.why = why; this.values = values; }
}

export interface Scratch { dir: string; sock: string; port: number; dbname: string; owner: string }

/** A database's or role's name as it may go into a scratch copy's settings and commands. */
const PG_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/** The archive recovered into a scratch folder as it was at `target`, and a private Postgres started on it (on a
 *  socket in that folder, no network), waiting until it has replayed up to the target and opened. Only the club's
 *  own database is recovered (the others are left empty), so on a server with many clubs it's quick too. */
export async function recoverScratch(target: Date, dbname: string, o: PitrOptions & { repo?: number; base?: string; timeoutSeconds?: number; archivePath?: string } = {}): Promise<Scratch> {
  const r = o.runner ?? localRunner, pg = bin(o), su = (o.paths ?? DEFAULT_PATHS).superuser;
  if (!PG_NAME.test(dbname)) throw new Error(`"${dbname}" isn't a database name the point-in-time restore takes`);
  if (!PG_NAME.test(su)) throw new Error(`"${su}" isn't a role name the point-in-time restore takes`);
  // Postgres's superuser by name where it isn't the postgres user's own (Docker's is kumi): psql asks for it with -U,
  // and the postgres user may be it only through the scratch copy's own ident map.
  const asSu = su === "postgres" ? [] : ["-U", su];
  const dir = join(o.base ?? join((o.paths ?? DEFAULT_PATHS).pgPath, ".."), `kumi-pitr-${randomBytes(4).toString("hex")}`);
  const sock = join(dir, "run"), port = 54000 + Math.floor(Math.random() * 900);
  await r.mkdir(dir);
  try {
    // --archive-mode=off: the scratch copy never sends WAL of its own into the archive.
    // An earlier server's archive (after losing it): the offsite copy, in that server's own folder.
    const which = o.archivePath ? ["--repo=2", `--repo2-path=${o.archivePath}`] : o.repo ? [`--repo=${o.repo}`] : [];
    await must(r, "pgbackrest", br(o, ...which, "--type=time", `--target=${pgTime(target)}`, "--target-action=promote",
      "--archive-mode=off", `--pg1-path=${dir}`, `--db-include=${dbname}`, "--log-level-console=warn", "restore"), "pgbackrest restore");
    await r.mkdir(sock);
    // Debian keeps Postgres's settings outside the data folder, so the scratch copy gets its own. Only the postgres
    // user can reach its socket (a folder of its own, 700). Postgres's superuser only asks Postgres's own questions,
    // in the postgres database; everything in the club's database is read as the role that owns it. The club's
    // database is the club's: a superuser session there would run whatever its role left in it (a trigger, a
    // function, a search_path) with the superuser's rights. No hot standby: nobody reads it before it reaches the
    // target (pg_ctl waits until it has, and opens), and it needn't match the live server's connection limits.
    await r.write(join(dir, "postgresql.conf"), [
      `port = ${port}`, "listen_addresses = ''", `unix_socket_directories = '${sock}'`, "archive_mode = off",
      "shared_buffers = 64MB", "hot_standby = off", "",
    ].join("\n"), 0o600);
    // Postgres's superuser gets the postgres database only: a superuser session in the club's database is refused by
    // Postgres itself, not just never asked for.
    await r.write(join(dir, "pg_hba.conf"), `local postgres ${su} peer${su === "postgres" ? "" : " map=scratch"}\nlocal all ${su} reject\nlocal ${dbname} all trust\n`, 0o600);
    await r.write(join(dir, "pg_ident.conf"), su === "postgres" ? "" : `scratch postgres ${su}\n`, 0o600);
    const started = await r.run(pg("pg_ctl"), ["-D", dir, "-l", join(dir, "recovery.log"), "-w", "-t", String(o.timeoutSeconds ?? 3600), "start"]);
    if (started.code !== 0) throw new Error(await recoveryProblem(r, dir) ?? `the scratch copy didn't start: ${started.stderr.trim()}`);
    // It replays the archive up to the target, then leaves recovery and opens: until then connections are refused.
    const until = Date.now() + (o.timeoutSeconds ?? 3600) * 1000;
    for (;;) {
      const q = await r.run(pg("psql"), ["-X", "-h", sock, "-p", String(port), ...asSu, "-d", "postgres", "-Atc", "SELECT pg_catalog.pg_is_in_recovery()"]);
      if (q.code === 0 && q.stdout.trim() === "f") break;
      if (q.code !== 0 && (await r.run(pg("pg_ctl"), ["-D", dir, "status"])).code !== 0) throw new Error(await recoveryProblem(r, dir) ?? "the scratch copy stopped while replaying the archive");
      if (Date.now() > until) throw new Error("the scratch copy didn't finish replaying the archive in time");
      await new Promise((d) => setTimeout(d, 1000));
    }
    // Who owns the club's database (in the restored copy): the role its checks and its dump run as. Never a
    // superuser: one that is would make those superuser sessions in the club's database after all.
    const who = (await must(r, pg("psql"), ["-X", "-h", sock, "-p", String(port), ...asSu, "-d", "postgres", "-Atc",
      `SELECT r.rolname || ' ' || r.rolsuper::text FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid = d.datdba WHERE d.datname = '${dbname}'`], "finding who owns the club's database")).trim();
    const [owner, superuser] = who.split(" ");
    if (!owner || !PG_NAME.test(owner)) throw new Error(`the restored copy has no database ${dbname}, or its owner's name is unexpected (${who || "none"})`);
    if (superuser !== "false") throw new Error(`${dbname} belongs to ${owner}, a superuser: the point-in-time restore reads a club's database only as an ordinary role (give the database to the club's own role)`);
    return { dir, sock, port, dbname, owner };
  } catch (e) {
    await dropScratch({ dir, sock, port, dbname, owner: "" }, o);
    throw e;
  }
}
/** Why a recovery stopped, in words, from its log: most often the archive doesn't reach that minute yet. */
async function recoveryProblem(r: Runner, dir: string): Promise<string | null> {
  const log = (await r.run("tail", ["-n", "40", join(dir, "recovery.log")])).stdout;
  if (/recovery ended before configured recovery target was reached/.test(log)) return "the archive doesn't reach that minute yet (its newest piece is older): try a minute or two earlier";
  // Refused connections while it replays ("the database system is starting up") aren't why it stopped.
  const fatal = log.split("\n").filter((l) => /FATAL|PANIC/.test(l) && !/the database system is /.test(l)).at(-1);
  return fatal ? `the scratch copy stopped: ${fatal.replace(/^.*?(FATAL|PANIC):\s*/, "")}` : null;
}
/** Stop the scratch Postgres and remove its folder. */
export async function dropScratch(s: Scratch, o: PitrOptions = {}) {
  const r = o.runner ?? localRunner;
  await r.run(bin(o)("pg_ctl"), ["-D", s.dir, "-m", "immediate", "-w", "stop"]).catch(() => undefined);
  await r.remove(s.dir);
}
/** A query in the scratch copy's club database, as the role that owns it (never the superuser), with nothing but
 *  Postgres's own catalog on the search path (a function the club's role made can't stand in for one of Postgres's):
 *  its rows as text. Tables are named with their schema. */
export async function scratchQuery(s: Scratch, query: string, o: PitrOptions = {}): Promise<string[]> {
  return (await must(o.runner ?? localRunner, bin(o)("psql"), ["-X", "-h", s.sock, "-p", String(s.port), "-U", s.owner, "-d", s.dbname, "-v", "ON_ERROR_STOP=1", "-Atc", query], "a check in the scratch copy",
    { PGOPTIONS: "-c search_path=pg_catalog" })).split("\n").filter(Boolean);
}

/** The club's database as it was at `target`, dumped to `out` (custom format, for `kumi restore`). Returns the last
 *  change kept (the newest action at or before the target), so the person can see where it stopped. */
export async function extractAt(target: Date, dbname: string, out: string, o: PitrOptions & { repo?: number; base?: string; archivePath?: string } = {}): Promise<{ lastChange: string | null; seconds: number }> {
  const t0 = Date.now(), s = await recoverScratch(target, dbname, o);
  try {
    const last = (await scratchQuery(s, "SELECT coalesce(max(created_at)::text, '') FROM public.action_run", o))[0] || null;
    // As the database's owner too. The file is the club's whole database: `kumi pitr` runs with umask 077, so only
    // its maker can read it (and the folder it goes in is the postgres user's alone).
    await must(o.runner ?? localRunner, bin(o)("pg_dump"), ["-Fc", "--no-owner", "--no-acl", "-h", s.sock, "-p", String(s.port), "-U", s.owner, "-d", dbname, "-f", out], "pg_dump of the scratch copy");
    return { lastChange: last, seconds: Math.round((Date.now() - t0) / 1000) };
  } finally { await dropScratch(s, o); }
}

/** Whether a restore to `target` can be tried: not in the future (nor the last minute, which may not be archived
 *  yet), and not before the oldest base backup kept. */
export function checkTarget(target: Date, info: ArchiveInfo, now: Date, tz: string, repo?: number) {
  const from = restorableFrom(info, repo);
  const show = (d: Date) => { const p = localParts(d, tz); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`; };
  if (!from) throw new PitrRefused("no_base_backup");
  if (target.getTime() > now.getTime() - 60_000) throw new PitrRefused("too_recent", { time: show(target) });
  if (target < from) throw new PitrRefused("too_old", { time: show(target), from: show(from) });
}

// ---- The monthly test ----
export interface PitrCheck { ok: boolean; target: string; seconds: number; problems: string[]; kept: string | null }
/** A random minute in the last week (at least ten minutes ago, after the oldest base backup), the archive recovered
 *  to it in scratch, and checked against the live database: the last change made a minute before the target is
 *  there, nothing made a minute after it is, and every table is one the live database has. */
export async function pitrTestRun(live: Kysely<any>, dbname: string, info: ArchiveInfo, o: PitrOptions & { repo?: number; base?: string; pick?: number; at?: Date } = {}): Promise<PitrCheck> {
  const now = o.now ?? new Date(), from = restorableFrom(info, o.repo);
  if (!from) throw new PitrRefused("no_base_backup");
  const earliest = Math.max(from.getTime() + 60_000, now.getTime() - 7 * 86400_000), latest = now.getTime() - 10 * 60_000;   // PITR_TEST_WAIT_MS after `from`
  if (!o.at && latest <= earliest) throw new PitrRefused("too_new_to_test");
  const target = o.at ?? new Date(Math.floor((earliest + (o.pick ?? Math.random()) * (latest - earliest)) / 60_000) * 60_000);
  const before = new Date(target.getTime() - 60_000), after = new Date(target.getTime() + 60_000);
  const want = (await sql<{ id: string | null }>`SELECT (SELECT id::text FROM action_run WHERE created_at <= ${before} ORDER BY created_at DESC, id DESC LIMIT 1) AS id`.execute(live)).rows[0]!.id;
  const liveTables = new Set((await sql<{ t: string }>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`.execute(live)).rows.map((r) => r.t));
  const t0 = Date.now(), s = await recoverScratch(target, dbname, o), problems: string[] = [];
  let kept: string | null = null;
  try {
    const has = (await scratchQuery(s, `SELECT count(*) FROM public.action_run WHERE id = '${want ?? "00000000-0000-0000-0000-000000000000"}'`, o))[0];
    if (want && has !== "1") problems.push(`the last change before ${before.toISOString()} (${want}) isn't in the restored copy`);
    const later = (await scratchQuery(s, `SELECT count(*) FROM public.action_run WHERE created_at > '${after.toISOString()}'`, o))[0];
    if (later !== "0") problems.push(`the restored copy has ${later} changes from after ${after.toISOString()}: it didn't stop at the minute asked`);
    for (const t of await scratchQuery(s, "SELECT tablename FROM pg_tables WHERE schemaname = 'public'", o)) if (!liveTables.has(t)) problems.push(`${t} isn't in the live database`);
    kept = (await scratchQuery(s, "SELECT coalesce(max(created_at)::text, '') FROM public.action_run", o))[0] || null;
  } finally { await dropScratch(s, o); }
  return { ok: problems.length === 0, target: target.toISOString(), seconds: Math.round((Date.now() - t0) / 1000), problems, kept };
}

/** Where scratch copies go: OPENPADEL_PITR_SCRATCH (Docker's pitr service: a volume of its own, since the cluster's folder
 *  is mounted read-only there), else beside the cluster (the postgres user's), else the temporary folder. */
export const scratchBase = (paths: PitrPaths = DEFAULT_PATHS, env: Env = {}) =>
  setting("PITR_SCRATCH", env)?.trim() || (existsSync(join(paths.pgPath, "..")) ? join(paths.pgPath, "..") : tmpdir());
