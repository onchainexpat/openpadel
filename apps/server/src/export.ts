// Everything a club needs to run its Kumi somewhere else, in one file (hosted.md, item 2: a club can always
// leave). The owner downloads it from the staff app ("Download everything"), or the server's owner runs
// `kumi export`; `kumi restore <file>` puts it into another install, the same Kumi or a newer one.
//
// Inside: the database (as a backup's dump), the secrets the database keeps sealed with this server's own key
// (staff authenticators, the push key, the vault), opened so another server can seal them with its key, the
// club's settings that aren't secret, the names of the ones that are, and club.yaml. Nothing else is kept
// outside the database (photos and documents are in it). The whole file is sealed with a passphrase: one
// Kumi makes and shows once, or one the server's owner types. This server's own keys never leave it.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scryptSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connect, holdPending, isSealedText, loadClubFormat, migrate, openBytes, openSupportCount, openText, rehashKeyed, runAsSystem, sealBytes, sealText, SEALED_COLUMNS, SealedError, type Db, type HeldCounts } from "@kumi/core";
import { carryGoneAfterImport, carryMeterAfterImport, readGoneBefore, readMeterBefore } from "./after_restore.ts";
import { makeBackup, readOpsRecords, safeRestore, writeOpsRecords, type Manifest } from "./backups.ts";
import { REVISION, VERSION } from "./version.ts";
import { setting } from "@kumi/core";
import { productName } from "@kumi/i18n";

type Env = Record<string, string | undefined>;
export const EXPORT_MAGIC = Buffer.from("KUMIEX1\n");

/** Settings carried as they are: where the club is on the web and how it writes. None is secret. */
const CARRIED = ["OPENPADEL_PUBLIC_URL", "OPENPADEL_MEMBER_URL", "OPENPADEL_LANG", "OPENPADEL_MAIL_FROM", "OPENPADEL_MAIL_REPLY_TO", "OPENPADEL_STRIPE_CONNECT", "OPENPADEL_PLAYTOMIC_TENANT_ID"];
/** Settings only named: the new server's owner sets up their own (keys are the old server's, or its host's). */
const NAMED = ["OPENPADEL_RESEND_API_KEY", "OPENPADEL_RESEND_WEBHOOK_SECRET", "OPENPADEL_TWILIO_ACCOUNT_SID", "OPENPADEL_TWILIO_MESSAGING_SERVICE_SID", "OPENPADEL_TWILIO_FROM", "OPENPADEL_STRIPE_SECRET_KEY", "OPENPADEL_STRIPE_WEBHOOK_SECRET",
  "OPENPADEL_TYPESAFE_API_KEY", "OPENPADEL_ANTHROPIC_API_KEY", "OPENPADEL_PLAYTOMIC_CLIENT_ID", "OPENPADEL_OFFSITE_ENDPOINT", "OPENPADEL_BACKUP_KEY"];
/** Secrets in tables that only last minutes (an authenticator being set up): not carried, cleared on the way in. */
const PASSING = new Set(["auth_challenge"]);

export interface ExportManifest {
  kind: "kumi-export"; format: 1; created_at: string; kumi: { version: string; revision: string };
  club: { name: string; time_zone: string }; addresses: { public_url: string | null; member_url: string | null };
  migrations: string[]; database: { file: string; bytes: number; sha256: string; tables: Record<string, number> };
  secrets: { carried: number; unreadable: number }; settings: Record<string, string>; set_elsewhere: string[]; files: string[];
}
type Secret = { table: string; key: string; column: string; kind: "text" | "bytes"; k: unknown; v: string };

/** Something about the file or the passphrase: nothing was changed. */
export class ExportRefused extends Error {}

// ---- The passphrase ----
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O or 1/I to mix up when it's written down
/** A passphrase Kumi makes: 30 characters (150 bits) in six groups, shown once. */
export function newPassphrase(): string {
  const chars = Array.from({ length: 30 }, () => ALPHABET[randomInt(ALPHABET.length)]!);
  return Array.from({ length: 6 }, (_, g) => chars.slice(g * 5, g * 5 + 5).join("")).join("-");
}
/** One Kumi made reads the same however it's typed back (any case, spaces or dashes). */
const normal = (p: string, made: boolean) => (made ? p.toUpperCase().replace(/[\s-]/g, "") : p.normalize("NFC").trim());
export const PASSPHRASE_MIN = 12;
/** scrypt's work for new files: 2^17 (OWASP's minimum), about 128 MB for a moment. A passphrase the owner chooses
 *  is the weak point; one Kumi makes (150 bits) would be safe with far less. */
export const KDF = { N: 131072, r: 8, p: 1 };
type Kdf = { N: number; r: number; p: number };
/** What a file's header may ask for: files made with 2^15 still open; nothing that would take the server's memory. */
function kdfOf(h: Partial<Kdf>): Kdf {
  const { N, r, p } = h;
  const pow2 = typeof N === "number" && Number.isInteger(N) && N >= 16384 && N <= 1048576 && (N & (N - 1)) === 0;
  if (!pow2 || !Number.isInteger(r) || r! < 1 || r! > 16 || !Number.isInteger(p) || p! < 1 || p! > 4 || 128 * N! * r! * p! > 512 * 1024 * 1024)
    throw new ExportRefused(`this file asks for a passphrase stretching ${productName()} doesn't use (it may be damaged)`);
  return { N: N!, r: r!, p: p! };
}
const keyFor = (p: string, made: boolean, salt: Buffer, kdf: Kdf = KDF) =>
  scryptSync(normal(p, made), salt, 32, { ...kdf, maxmem: 128 * kdf.N * kdf.r * kdf.p + 32 * 1024 * 1024 });

// ---- The file: a header anyone can read, then the sealed contents ----
export function packExport(entries: { name: string; data: Buffer }[]): Buffer {
  const index = Buffer.from(JSON.stringify(entries.map((e) => ({ name: e.name, bytes: e.data.length, sha256: createHash("sha256").update(e.data).digest("hex") }))));
  const len = Buffer.alloc(4); len.writeUInt32BE(index.length);
  return Buffer.concat([len, index, ...entries.map((e) => e.data)]);
}
function unpack(payload: Buffer): Map<string, Buffer> {
  const n = payload.readUInt32BE(0), index = JSON.parse(payload.subarray(4, 4 + n).toString("utf8")) as { name: string; bytes: number; sha256: string }[];
  const out = new Map<string, Buffer>();
  let at = 4 + n;
  for (const e of index) {
    const data = payload.subarray(at, at + e.bytes); at += e.bytes;
    if (data.length !== e.bytes || createHash("sha256").update(data).digest("hex") !== e.sha256) throw new ExportRefused(`${e.name} in the file is damaged`);
    out.set(e.name, data);
  }
  return out;
}
interface Header { format: 1; kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string }; cipher: "aes-256-gcm"; iv: string; passphrase: "made" | "chosen"; created_at: string; kumi: string }

export function sealExport(payload: Buffer, passphrase: string, made: boolean, now: Date): Buffer {
  const salt = randomBytes(16), iv = randomBytes(12);
  const header: Header = { format: 1, kdf: { name: "scrypt", ...KDF, salt: salt.toString("base64") }, cipher: "aes-256-gcm", iv: iv.toString("base64"),
    passphrase: made ? "made" : "chosen", created_at: now.toISOString(), kumi: VERSION };
  const h = Buffer.from(JSON.stringify(header)), len = Buffer.alloc(4); len.writeUInt32BE(h.length);
  const front = Buffer.concat([EXPORT_MAGIC, len, h]);
  const c = createCipheriv("aes-256-gcm", keyFor(passphrase, made, salt), iv);
  c.setAAD(front);   // the header can't be changed without the file failing to open
  const body = Buffer.concat([c.update(payload), c.final()]);
  return Buffer.concat([front, body, c.getAuthTag()]);
}
export function isExport(bytes: Buffer): boolean { return bytes.subarray(0, EXPORT_MAGIC.length).equals(EXPORT_MAGIC); }
export function isExportFile(path: string): boolean {
  try { return isExport(readFileSync(path).subarray(0, EXPORT_MAGIC.length)); } catch { return false; }
}
/** The header of a file, without the passphrase: when it was made, by which Kumi, and which kind of passphrase. */
export function exportHeader(file: Buffer): Header {
  if (!isExport(file)) throw new ExportRefused(`this isn't an export from ${productName()}`);
  const n = file.readUInt32BE(EXPORT_MAGIC.length);
  return JSON.parse(file.subarray(EXPORT_MAGIC.length + 4, EXPORT_MAGIC.length + 4 + n).toString("utf8")) as Header;
}
export function openExport(file: Buffer, passphrase: string): { manifest: ExportManifest; entries: Map<string, Buffer> } {
  const header = exportHeader(file);
  if (header.format !== 1 || header.cipher !== "aes-256-gcm" || header.kdf.name !== "scrypt") throw new ExportRefused(`this export was made by a newer ${productName()}: update this one first`);
  const start = EXPORT_MAGIC.length + 4 + file.readUInt32BE(EXPORT_MAGIC.length);
  // The stretching the file was made with: its header says, within kdfOf's bounds (and the header is checked with the
  // contents, so a changed one fails to open).
  const d = createDecipheriv("aes-256-gcm", keyFor(passphrase, header.passphrase === "made", Buffer.from(header.kdf.salt, "base64"), kdfOf(header.kdf)), Buffer.from(header.iv, "base64"));
  d.setAAD(file.subarray(0, start));
  d.setAuthTag(file.subarray(file.length - 16));
  let payload: Buffer;
  try { payload = Buffer.concat([d.update(file.subarray(start, file.length - 16)), d.final()]); }
  catch { throw new ExportRefused("the passphrase doesn't open this file (or the file is damaged)"); }
  const entries = unpack(payload), m = entries.get("manifest.json");
  if (!m || !entries.has("database.dump")) throw new ExportRefused("the file is missing its database");
  const manifest = JSON.parse(m.toString("utf8")) as ExportManifest;
  if (manifest.kind !== "kumi-export") throw new ExportRefused(`this isn't an export from ${productName()}`);
  return { manifest, entries };
}

// ---- Making one ----
/** The secrets the database keeps sealed with this server's key, opened. One already unreadable here is counted. */
async function openSecrets(db: Db): Promise<{ secrets: Secret[]; unreadable: number }> {
  const secrets: Secret[] = [];
  let unreadable = 0;
  for (const c of SEALED_COLUMNS) {
    if (PASSING.has(c.table)) continue;
    const rows = (await sql<{ k: unknown; v: string | Buffer }>`SELECT ${sql.ref(c.key)} AS k, ${sql.ref(c.column)} AS v FROM ${sql.table(c.table)}`.execute(db)).rows;
    for (const r of rows) {
      try {
        const v = c.kind === "text" ? openText(r.v as string) : openBytes(r.v as Buffer).toString("base64");
        secrets.push({ table: c.table, key: c.key, column: c.column, kind: c.kind, k: r.k, v });
      } catch (e) { if (e instanceof SealedError) unreadable++; else throw e; }
    }
  }
  return { secrets, unreadable };
}

/** Make the club's export. With no passphrase, Kumi makes one (returned, to show once). */
export async function makeExport(db: Db, o: { url: string; env?: Env; now?: Date; passphrase?: string }): Promise<{ file: Buffer; name: string; manifest: ExportManifest; passphrase: string | null }> {
  const env = o.env ?? process.env, now = o.now ?? new Date();
  if (o.passphrase !== undefined && normal(o.passphrase, false).length < PASSPHRASE_MIN) throw new ExportRefused(`the passphrase needs at least ${PASSPHRASE_MIN} characters`);
  const club = await db.selectFrom("club").select(["name", "time_zone"]).executeTakeFirst();
  if (!club) throw new ExportRefused("there's no club here yet");
  const dir = mkdtempSync(join(tmpdir(), "kumi-export-"));
  try {
    const made = await makeBackup(db, { url: o.url, dir, label: "export", env, now, tz: club.time_zone });
    const dump = readFileSync(made.file), { secrets, unreadable } = await openSecrets(db);
    const migrations = (await sql<{ name: string }>`SELECT name FROM schema_migration ORDER BY name`.execute(db)).rows.map((r) => r.name);
    const clubFile = setting("CLUB_FILE", env) && existsSync(setting("CLUB_FILE", env)!) ? readFileSync(setting("CLUB_FILE", env)!) : null;
    const settings = Object.fromEntries(CARRIED.filter((k) => setting(k, env)?.trim()).map((k) => [k, setting(k, env)!.trim()]));
    const files = ["manifest.json", "database.dump", "secrets.json", ...(clubFile ? ["club.yaml"] : [])];
    const manifest: ExportManifest = {
      kind: "kumi-export", format: 1, created_at: now.toISOString(), kumi: { version: VERSION, revision: REVISION }, club,
      addresses: { public_url: setting("PUBLIC_URL", env)?.trim() || null, member_url: setting("MEMBER_URL", env)?.trim() || null }, migrations,
      database: { file: "database.dump", bytes: made.manifest.bytes, sha256: made.manifest.sha256, tables: (made.manifest as Manifest).tables },
      secrets: { carried: secrets.length, unreadable }, settings, set_elsewhere: NAMED.filter((k) => setting(k, env)?.trim()), files,
    };
    const payload = packExport([{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) }, { name: "database.dump", data: dump },
      { name: "secrets.json", data: Buffer.from(JSON.stringify(secrets)) }, ...(clubFile ? [{ name: "club.yaml", data: clubFile }] : [])]);
    const passphrase = o.passphrase ?? newPassphrase();
    const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "");
    return { file: sealExport(payload, passphrase, o.passphrase === undefined, now), name: `kumi-export-${stamp}Z.kumi`, manifest, passphrase: o.passphrase === undefined ? passphrase : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- Putting one into this server ----
/** The migrations this Kumi knows: an export that has any other comes from a newer one. */
function knownMigrations(): Set<string> {
  return new Set(readdirSync(new URL("../../../migrations/", import.meta.url)).filter((f) => /^\d{3}_.+\.sql$/.test(f)));
}
const hostOf = (url: string | null | undefined) => { try { return url ? new URL(url).hostname : null; } catch { return null; } };

export interface ImportReport {
  club: string; from: { version: string; created_at: string }; safety_copy: string; migrations_run: string[]; secrets: number; secrets_lost: number;
  passkeys_retired: number; was_read_only: boolean; was_leaving: string | null; was_moved: boolean; held: HeldCounts; support_ended: number;
  /** Club months whose usage meter kept what this server's database had counted (the club ran here before). */
  usage_carried: string[]; gone_carried: { erased: number; other: number }; settings: Record<string, string>; set_elsewhere: string[]; club_file: Buffer | null;
  stripe_account: string | null; texting_registered: boolean;
}

/** Replace this server's database with an export, then bring it up to this Kumi: its migrations, the secrets
 *  sealed with this server's key, passkeys retired if the club's address changed (a passkey belongs to its web
 *  address), what was still waiting to go out held (held.ts: the old server may still send it), and read-only and
 *  any day its Kumi was to end there taken off (this server's owner decides those). The server must be stopped, as for a restore;
 *  the database as it was is kept first (safeRestore), and put back if the restore fails. */
export async function importExport(o: { url: string; file: Buffer; passphrase: string; dir: string; env?: Env; now?: Date }): Promise<ImportReport> {
  const env = o.env ?? process.env, now = o.now ?? new Date();
  const { manifest, entries } = openExport(o.file, o.passphrase);
  const known = knownMigrations(), newer = manifest.migrations.filter((m) => !known.has(m));
  if (newer.length) throw new ExportRefused(`this export comes from a newer ${productName()} (${manifest.kumi.version}, ${newer.length} changes this one doesn't have): update this server first`);
  const tmp = mkdtempSync(join(tmpdir(), "kumi-import-"));
  let safetyCopy: string, kept: Awaited<ReturnType<typeof readOpsRecords>> = [], meter: Awaited<ReturnType<typeof readMeterBefore>> = null, gone: Awaited<ReturnType<typeof readGoneBefore>> = null;
  try {
    const dumpFile = join(tmp, "database.dump");
    writeFileSync(dumpFile, entries.get("database.dump")!, { mode: 0o600 });
    kept = await readOpsRecords(o.url);
    meter = await readMeterBefore(o.url);
    gone = await readGoneBefore(o.url);
    ({ safetyCopy } = await safeRestore(o.url, dumpFile, { dir: o.dir, env, now }));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const db = connect(o.url);
  try {
    // The old server's records of its own backups describe that server, not this one: this one's are kept.
    await sql`DELETE FROM ops_heartbeat`.execute(db).catch(() => undefined);
    await writeOpsRecords(o.url, kept);
    const migrationsRun = await migrate(db);
    // The imported club's currency and formats, before anything below writes an amount (what's deleted again, for the
    // staff): a club in euros reads euros, not the dollars this process started with (as `kumi restore` does).
    await loadClubFormat(db);
    // Back on a server the club ran on before: what this one's meter had counted stays counted (after_restore.ts).
    const usageCarried = await carryMeterAfterImport(db, meter);
    // What was still waiting to go out on the old server, which may still be sending it: held here until this
    // server's owner says (held.ts). First, so nothing below (read-only and the leaving day going off) is held.
    // Unless the old server had been told the club moved before the file was made (club_exit.ts): it sends members
    // nothing since, so what waited is this server's to send, once, and nothing is held.
    const moved = (await db.selectFrom("club").select("moved_at").executeTakeFirstOrThrow()).moved_at;
    const held = moved ? { messages: 0, events: 0 } : await holdPending(db, now);
    if (moved) await runAsSystem(db, "club.moved_host", { on: false }, "import", { now });
    // Support access given on the old server is that server's: it ends here, and the owners hear (support.ts).
    const supportOpen = await openSupportCount(db, now);
    if (supportOpen) await runAsSystem(db, "support.end_all", { why: "moved" }, "import", { now });
    // Key material, written as resealAll writes it: sealed again with this server's key.
    const secrets = JSON.parse(entries.get("secrets.json")?.toString("utf8") ?? "[]") as Secret[];
    let carried = 0;
    for (const s of secrets) {
      const c = SEALED_COLUMNS.find((x) => x.table === s.table && x.column === s.column && x.key === s.key);
      if (!c) continue;
      const value = c.kind === "text" ? sealText(s.v) : sealBytes(Buffer.from(s.v, "base64"));
      const r = await sql`UPDATE ${sql.table(c.table)} SET ${sql.ref(c.column)} = ${value} WHERE ${sql.ref(c.key)} = ${s.k}`.execute(db);
      carried += Number(r.numAffectedRows ?? 0);
    }
    // Gift card fingerprints under this server's key, now (not only at the next start): its cards can be redeemed at once.
    await rehashKeyed(db);
    // And what it had taken away on request since the file was made (an account deleted, words taken back) stays away.
    // After the keys above: an authenticator set up again on this server since keeps this server's secret.
    const goneCarried = await carryGoneAfterImport(db, gone, now);
    for (const c of SEALED_COLUMNS.filter((x) => PASSING.has(x.table))) await sql`DELETE FROM ${sql.table(c.table)} ${c.where ? sql.raw(`WHERE ${c.where}`) : sql``}`.execute(db);
    // Whatever is still sealed under the old server's key can't be opened here: count it (kumi doctor shows it too).
    let lost = 0;
    for (const c of SEALED_COLUMNS) {
      for (const r of (await sql<{ v: string | Buffer }>`SELECT ${sql.ref(c.column)} AS v FROM ${sql.table(c.table)}`.execute(db)).rows) {
        try { if (c.kind === "text") { if (isSealedText(r.v as string)) openText(r.v as string); } else openBytes(r.v as Buffer); } catch { lost++; }
      }
    }
    // A passkey works only at the web address it was made on: at a new one, people sign in with a code and add one again.
    const from = hostOf(manifest.addresses.public_url), to = hostOf(setting("PUBLIC_URL", env) ?? "http://127.0.0.1:8790");
    let retired = 0;
    if (from !== to) retired = Number((await sql`UPDATE passkey SET revoked_at = ${now}, version = version + 1 WHERE revoked_at IS NULL`.execute(db)).numAffectedRows ?? 0);
    const club = await db.selectFrom("club").select(["name", "read_only_since", "stripe_account_id", "leaving_on"]).executeTakeFirstOrThrow();
    if (club.read_only_since) await runAsSystem(db, "club.read_only", { on: false }, "import", { now });
    // Nor the day its Kumi was to end there: that was the old server's. Nobody is told; this server's owner decides.
    if (club.leaving_on) await runAsSystem(db, "club.leaving", { on: null, tell: false }, "import", { now });
    const texting = await db.selectFrom("texting_registration").select("id").executeTakeFirst();
    return { club: club.name, from: { version: manifest.kumi.version, created_at: manifest.created_at }, safety_copy: safetyCopy, migrations_run: migrationsRun, secrets: carried,
      secrets_lost: lost, passkeys_retired: retired, was_read_only: Boolean(club.read_only_since), was_leaving: club.leaving_on, was_moved: Boolean(moved), held, support_ended: supportOpen, usage_carried: usageCarried, gone_carried: goneCarried, settings: manifest.settings, set_elsewhere: manifest.set_elsewhere,
      club_file: entries.get("club.yaml") ?? null, stripe_account: club.stripe_account_id, texting_registered: Boolean(texting) };
  } finally { await db.destroy(); }
}
