// The usage meter after a restore (after_restore.ts): a copy's counts are older, so what was spent since stays
// counted (the host's bill and the owner's cap), and an 80% or cap message said since isn't said again. When the
// database before can't vouch, the gap is kept and `kumi usage` and `kumi doctor` say so. Each restore path:
//   - kumi restore of a backup, an offsite copy or a minute (restore --to ends in the same file restore);
//   - an import onto the server the club ran on before (export.ts);
//   - an update's snapshot going back (deploy/release.sh, in release.test.ts).
// The real restores need pg_dump and pg_restore 17, like the backup tests.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { countUsage, runAsSystem, setSecretKeys, usageMonth, type Db } from "@kumi/core";
import { afterRestore, readSentBefore } from "../src/after_restore.ts";
import { makeBackup, pgTool, safeRestore } from "../src/backups.ts";
import { doctor } from "../src/doctor.ts";
import { importExport, makeExport } from "../src/export.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const tools = existsSync(pgTool("pg_dump")) && existsSync(pgTool("pg_restore"));
if (!tools && process.env.KUMI_REQUIRE_PG_TOOLS === "1") throw new Error(`pg_dump and pg_restore 17 are required here (looked for ${pgTool("pg_dump")})`);
const skip = tools ? false : "needs pg_dump and pg_restore 17 (set KUMI_PG_BIN)";
const ENV = { KUMI_PG_BIN: process.env.KUMI_PG_BIN, KUMI_PUBLIC_URL: "https://staff.kestrel.example" };

const MONTH = "2026-11-01", COPY_AT = new Date("2026-11-10T18:00:00Z"), SINCE = new Date("2026-11-20T18:00:00Z"), NOW = new Date("2026-11-25T18:00:00Z");
const urlOf = async (db: Db) => ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d}`);
const made: Array<() => Promise<void>> = [];
let dir: string | null = null;
after(async () => { setSecretKeys({}); if (dir) rmSync(dir, { recursive: true, force: true }); for (const d of made) await d(); });
const scratch = () => (dir ??= mkdtempSync(join(tmpdir(), "kumi-usage-restore-test-")));

async function club() {
  const { db, drop } = await freshDb();
  made.push(drop);
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  return { db, url: await urlOf(db) };
}
/** $10 of the $50 cap when the copy is made; $43 by the restore, so the owner heard at 80%. */
const atCopy = (db: Db) => countUsage(db, "texts", { segments: 8, cents: 1000 }, COPY_AT);
const since = (db: Db) => countUsage(db, "ai_decisions", { count: 30, input_tokens: 90_000, cents: 3300 }, SINCE);
const total = async (db: Db) => (await usageMonth(db, MONTH)).total_cents;
const notices = async (db: Db) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM event_outbox WHERE topic = 'usage.cap'`.execute(db)).rows[0]!.n);
const alert = (db: Db) => db.selectFrom("usage_alert").selectAll().where("month", "=", MONTH).executeTakeFirst();

/** The database as the copy had it: its meter, and no 80% message (that came after it). */
async function backToCopy(db: Db, copy: { months: any[]; alerts: any[] }) {
  await db.deleteFrom("usage_month").execute();
  if (copy.months.length) await db.insertInto("usage_month").values(copy.months).execute();
  await db.deleteFrom("usage_alert").execute();
  if (copy.alerts.length) await db.insertInto("usage_alert").values(copy.alerts).execute();
  await sql`DELETE FROM event_outbox WHERE topic = 'usage.cap'`.execute(db);
}
const copyOf = async (db: Db) => ({ months: await db.selectFrom("usage_month").selectAll().execute(), alerts: await db.selectFrom("usage_alert").selectAll().execute() });

test("kumi restore over the same club: the meter keeps what was spent since the copy, and the 80% message isn't said again", async () => {
  const { db, url } = await club();
  await atCopy(db);
  const copy = await copyOf(db);
  await since(db);
  assert.equal(await notices(db), 1, "at 86% the owner heard once");
  const before = await readSentBefore(url);
  await backToCopy(db, copy);
  assert.equal(await total(db), 1000);
  const r = await afterRestore(url, before, NOW);
  assert.deepEqual(r.usage, { months: [MONTH], gap: false });
  const m = await usageMonth(db, MONTH);
  assert.equal(m.total_cents, 4300, "the bill and the cap count what was spent after the copy");
  assert.equal(m.kinds.texts.segments, 8);
  assert.equal(m.kinds.ai_decisions.count, 30);
  assert.equal(m.kinds.ai_decisions.input_tokens, 90_000);
  assert.deepEqual(m.gaps, []);
  assert.equal((await alert(db))?.near_cap, 5000, "the 80% message stays said");
  await countUsage(db, "email", { cents: 9 }, NOW);
  assert.equal(await notices(db), 0, "counting on past 80% doesn't say it again");
  await countUsage(db, "email", { cents: 800 }, NOW);
  assert.equal(await notices(db), 1, "at the cap: once");
  assert.equal((await alert(db))?.reached_cap, 5000);
});

test("a copy newer than the database it replaces (the safety copy put back): nothing goes down", async () => {
  const { db, url } = await club();
  await atCopy(db);
  const before = await readSentBefore(url);
  await since(db);
  const r = await afterRestore(url, before, NOW);
  assert.deepEqual(r.usage, { months: [], gap: false });
  assert.equal(await total(db), 4300);
  assert.equal((await alert(db))?.near_cap, 5000);
});

test("a database from before the meter (0.1.0) still vouches: nothing to carry", async () => {
  const { db, url } = await club();
  await sql`DROP TABLE usage_alert, usage_month`.execute(db);
  const before = await readSentBefore(url);
  assert.ok(before, "it vouches for its own copies");
  assert.deepEqual(before!.usage, { months: [], alerts: [] });
});

test("nothing to carry the meter over from (a new server after losing the old one): the gap is kept, and kumi usage and doctor say so", async () => {
  const { db, url } = await club();
  await countUsage(db, "texts", { segments: 8, cents: 1000 }, new Date("2026-10-28T18:00:00Z"));   // the copy's last count, in October
  const r = await afterRestore(url, null, NOW);
  assert.deepEqual(r.usage, { months: [], gap: true });
  const gap = await db.selectFrom("usage_gap").selectAll().executeTakeFirstOrThrow();
  assert.equal(gap.restored_at.toISOString(), NOW.toISOString());
  assert.equal(gap.counted_until?.toISOString(), "2026-10-28T18:00:00.000Z");
  // Both months it touches say so (kumi usage --json); the month after doesn't.
  assert.equal((await usageMonth(db, "2026-10-01")).gaps.length, 1);
  assert.deepEqual((await usageMonth(db, MONTH)).gaps, [{ restored_at: NOW.toISOString(), counted_until: "2026-10-28T18:00:00.000Z" }]);
  assert.equal((await usageMonth(db, "2026-12-01")).gaps.length, 0);
  const said = (await doctor(db, { KUMI_BACKUP_DIR: "/nonexistent" }, { now: NOW })).filter((c) => c.id === "usage" && c.state === "warn");
  assert.ok(said.some((c) => /may be short.*November 25, 2026/.test(c.text.en) && /puede quedarse corto/.test(c.text.es)), JSON.stringify(said));
  const nextMonth = (await doctor(db, { KUMI_BACKUP_DIR: "/nonexistent" }, { now: new Date("2026-12-05T18:00:00Z") })).filter((c) => c.id === "usage");
  assert.ok(!nextMonth.some((c) => /may be short/.test(c.text.en)), "next month's meter is whole again");
});

test("kumi restore of a real backup file: the meter is carried over through pg_restore", { skip }, async () => {
  const { db, url } = await club();
  await atCopy(db);
  const backup = await makeBackup(db, { url, dir: scratch(), env: ENV, now: COPY_AT, label: `usage-${Date.now()}` });
  await since(db);
  // What `kumi restore <file> --yes` does (cli.ts): read, restore, carry over.
  const before = await readSentBefore(url);
  await safeRestore(url, backup.file, { dir: scratch(), env: ENV, now: NOW });
  const r = await afterRestore(url, before, NOW);
  assert.deepEqual(r.usage, { months: [MONTH], gap: false });
  assert.equal(await total(db), 4300);
  assert.equal((await alert(db))?.near_cap, 5000);
});

test("an export put back onto the server the club ran on: the meter keeps what that server had counted; onto a new one, the export's", { skip }, async () => {
  setSecretKeys({ current: Buffer.alloc(32, 7).toString("base64") });
  const { db, url } = await club();
  await atCopy(db);
  const file = await makeExport(db, { url, env: ENV, now: COPY_AT });
  await since(db);
  const back = await importExport({ url, file: file.file, passphrase: file.passphrase!, dir: scratch(), env: ENV, now: NOW });
  assert.deepEqual(back.usage_carried, [MONTH]);
  assert.equal(await total(db), 4300);
  assert.equal((await alert(db))?.near_cap, 5000);
  const elsewhere = await freshDb();
  made.push(elsewhere.drop);
  const moved = await importExport({ url: await urlOf(elsewhere.db), file: file.file, passphrase: file.passphrase!, dir: scratch(), env: ENV, now: NOW });
  assert.deepEqual(moved.usage_carried, []);
  assert.equal(await total(elsewhere.db), 1000, "a new server has the export's meter; what the old one spent after is the old host's to bill");
});
