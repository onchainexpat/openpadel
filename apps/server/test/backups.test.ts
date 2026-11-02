// Backups against a real Postgres 17: the dump and its manifest from one snapshot, restoring into a scratch
// database, the restore test (local and offsite), and the nightly job's records. These need pg_dump and
// pg_restore 17 (KUMI_PG_BIN, or /usr/lib/postgresql/17/bin); without them they're skipped, unless
// KUMI_REQUIRE_PG_TOOLS=1 says they must run (CI installs the tools).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { heartbeat, jobWorked, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { compareCounts, isSameDatabase, lastSlot, makeBackup, newestLocal, offsitePrunes, offsitePush, RestoreFailed, RestoreRefused, safeRestore, offsiteLatest, readOpsRecords, writeOpsRecords, nightlyBackup, openBackup, pgTool, restoreInto, restoreTest, scheduledDue, scratchUrl, SCHEDULE, tidyLocal, type Manifest } from "../src/backups.ts";
import { S3Client } from "../src/s3.ts";
import { fakeS3, type FakeS3 } from "./fake_s3.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const tools = existsSync(pgTool("pg_dump")) && existsSync(pgTool("pg_restore"));
if (!tools && process.env.KUMI_REQUIRE_PG_TOOLS === "1") throw new Error(`pg_dump and pg_restore 17 are required here (looked for ${pgTool("pg_dump")})`);
const skip = tools ? false : "needs pg_dump and pg_restore 17 (set KUMI_PG_BIN)";

let db: Db, drop: () => Promise<void>, owner: Actor, url: string, s3: FakeS3, dir: string;
const KEY = Buffer.alloc(32, 11), env = { ...process.env, KUMI_BACKUP_KEY: KEY.toString("base64"), KUMI_OFFSITE_PREFIX: "club/" };
const creds = { bucket: "kestrel-backups", accessKeyId: "AKTEST", secretAccessKey: "test-secret", region: "auto" };
const NOW = new Date("2026-11-30T11:17:00Z");

before(async () => {
  if (skip) return;
  ({ db, drop } = await freshDb());
  url = ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d}`);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  for (const name of ["Ann", "Ben", "Cy"]) await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner);
  s3 = await fakeS3(creds);
  dir = mkdtempSync(join(tmpdir(), "kumi-backups-"));
});
after(async () => { if (skip) return; await s3.close(); await drop(); });

test("a backup is a dump with a manifest of every table's rows, from one snapshot", { skip }, async () => {
  const r = await makeBackup(db, { url, dir, now: NOW, env });
  assert.equal(r.file, join(dir, "kumi-2026-11-30T0317.dump"));   // the club's date and time (Los Angeles)
  const m = JSON.parse(readFileSync(r.manifestFile, "utf8")) as Manifest;
  assert.equal(m.kind, "kumi-backup");
  assert.equal(m.tables.person, Number((await sql<{ n: string }>`SELECT count(*) AS n FROM person`.execute(db)).rows[0]!.n));
  assert.ok(m.tables.schema_migration! > 40);
  assert.equal(readFileSync(r.file).subarray(0, 5).toString(), "PGDMP");
  // Only the server's own user can read it, even made again over a file someone opened up.
  chmodSync(r.file, 0o644);
  const again = await makeBackup(db, { url, dir, now: NOW, env });
  for (const f of [again.file, again.manifestFile]) assert.equal(statSync(f).mode & 0o777, 0o600, f);
  // A second backup in the same minute gets a name of its own: nothing is ever written over.
  assert.equal(again.file, join(dir, "kumi-2026-11-30T0317-2.dump"));
  assert.equal(statSync(r.file).mode & 0o777, 0o644);   // the first is untouched
  rmSync(again.file); rmSync(again.manifestFile);
  // A labelled one (before an update) is named for it and left alone by the tidying.
  const labelled = await makeBackup(db, { url, dir, now: NOW, label: "update-abc-to-def", env });
  assert.equal(labelled.file, join(dir, "kumi-update-abc-to-def.dump"));
});

test("nightly files older than 14 days are tidied; others are left", { skip }, () => {
  writeFileSync(join(dir, "kumi-2026-11-01.dump"), "old"); writeFileSync(join(dir, "kumi-2026-11-01.json"), "{}");
  writeFileSync(join(dir, "kumi-2026-11-02T0317.dump"), "old, named to the minute");
  writeFileSync(join(dir, "kumi-2026-11-20.dump"), "recent");
  assert.deepEqual(tidyLocal(dir, NOW).sort(), ["kumi-2026-11-01.dump", "kumi-2026-11-01.json", "kumi-2026-11-02T0317.dump"]);
  assert.ok(readdirSync(dir).includes("kumi-2026-11-20.dump") && readdirSync(dir).includes("kumi-update-abc-to-def.dump"));
});

test("restoring into a scratch database brings back every table and row", { skip }, async () => {
  const scratch = await freshDb();   // a migrated database: the restore empties it first
  try {
    const scratchUrl = ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(scratch.db)).rows[0]!.d}`);
    await restoreInto(scratchUrl, join(dir, "kumi-2026-11-30T0317.dump"), env);
    const names = await scratch.db.selectFrom("person").select("display_name").orderBy("display_name").execute();
    assert.deepEqual(names.map((n) => n.display_name), ["Ann", "Ben", "Cy", "Robin Hale"]);
  } finally { await scratch.drop(); }
});

test("a restore never leaves the club empty: a bad file changes nothing; a failed restore puts the copy back", { skip }, async () => {
  const scratch = await freshDb();
  const dir2 = mkdtempSync(join(tmpdir(), "kumi-restore-"));
  try {
    const sUrl = ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(scratch.db)).rows[0]!.d}`);
    await runAsSystem(scratch.db, "club.setup", { name: "Osprey Padel", time_zone: "America/Los_Angeles", owner_email: "pat@example.test", owner_name: "Pat Lee" }, "setup");
    const tables = async () => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'`.execute(scratch.db)).rows[0]!.n);
    const before = await tables();
    // A manifest passed as if it were the dump: refused before anything is dropped (it used to empty the database).
    await assert.rejects(safeRestore(sUrl, join(dir, "kumi-2026-11-30T0317.json"), { dir: dir2, env }), RestoreRefused);
    assert.equal(await tables(), before);
    assert.deepEqual(readdirSync(dir2), []);
    // A dump that reads but fails halfway (cut short): the database goes back as it was, from the copy made first.
    const whole = readFileSync(join(dir, "kumi-2026-11-30T0317.dump"));
    const cut = join(dir2, "cut.dump"); writeFileSync(cut, whole.subarray(0, Math.floor(whole.length * 0.6)));
    const err = await safeRestore(sUrl, cut, { dir: dir2, env, now: NOW }).then(() => null, (e) => e);
    if (err instanceof RestoreRefused) assert.ok(true);   // pg_restore --list may already catch a short file: also fine
    else {
      assert.ok(err instanceof RestoreFailed, String(err)); assert.equal(err.putBack, true);
      assert.match(basename(err.safetyCopy), /^kumi-20261130T1117Z-before-restore\.dump$/);
      assert.equal(await tables(), before);
      assert.equal((await scratch.db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name, "Osprey Padel");
    }
    // A good one: restored, with the copy of the database as it was kept beside the backups.
    const r = await safeRestore(sUrl, join(dir, "kumi-2026-11-30T0317.dump"), { dir: dir2, env, now: new Date("2026-11-30T12:00:00Z") });
    assert.equal(basename(r.safetyCopy), "kumi-20261130T1200Z-before-restore.dump");
    assert.equal((await scratch.db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name, "Kestrel Padel");
    assert.equal(statSync(r.safetyCopy).mode & 0o777, 0o600);
  } finally { await scratch.drop(); rmSync(dir2, { recursive: true, force: true }); }
});

test("the restore test checks a local backup against its manifest, and records it", { skip }, async () => {
  const r = await restoreTest(db, { liveUrl: url, dir, s3: null, key: null, prefix: "club/", env: { ...env, KUMI_RESTORE_TEST_DATABASE_URL: ADMIN.replace(/\/[^/]*$/, `/kumi_rt_${process.pid}`) }, now: NOW });
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.equal(r.compared, "manifest");
  assert.ok(r.tables > 40 && r.rows > 40);
  assert.equal((await heartbeat(db, "restore_test"))!.last_error, null);
  // The scratch database this run made is gone again.
  assert.equal((await sql<{ n: string }>`SELECT count(*) AS n FROM pg_database WHERE datname = ${`kumi_rt_${process.pid}`}`.execute(db)).rows[0]!.n, "0");
});

test("the nightly job: the backup, then the sealed offsite copy; the restore test can use that copy", { skip }, async () => {
  const s3cfg = { endpoint: s3.url, bucket: creds.bucket, accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, region: creds.region, pathStyle: true };
  const r = await nightlyBackup(db, { url, dir, s3: s3cfg, env, now: NOW });
  assert.equal(r.offsite!.key, "club/daily/kumi-2026-11-30T0317-2.dump.enc");   // 03:17's own file was already there
  assert.equal(r.offsite!.monthly, "club/monthly/kumi-2026-11.dump.enc");
  const sealed = s3.objects.get("club/daily/kumi-2026-11-30T0317-2.dump.enc")!;
  assert.ok(!sealed.includes(Buffer.from("PGDMP")));
  assert.equal(openBackup(sealed, KEY).subarray(0, 5).toString(), "PGDMP");
  assert.equal((await heartbeat(db, "backup"))!.last_error, null);
  assert.equal(((await heartbeat(db, "offsite"))!.details as any).bucket, creds.bucket);
  const rt = await restoreTest(db, { liveUrl: url, dir, s3: new S3Client(s3cfg), key: KEY, prefix: "club/", env: { ...env, KUMI_RESTORE_TEST_DATABASE_URL: ADMIN.replace(/\/[^/]*$/, `/kumi_rt2_${process.pid}`) }, now: NOW });
  assert.equal(rt.ok, true, rt.problems.join("; "));
  assert.equal(rt.source, "club/daily/kumi-2026-11-30T0317-2.dump.enc");
});

test("two backups on one day both survive, here and offsite; the month keeps its first", { skip }, async () => {
  const s3cfg = { endpoint: s3.url, bucket: creds.bucket, accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, region: creds.region, pathStyle: true };
  const evening = new Date("2026-12-01T05:39:00Z");   // 21:39 on Nov 30 in Los Angeles, after the 03:17 ones
  const first = s3.objects.get("club/monthly/kumi-2026-11.dump.enc")!;
  const r = await nightlyBackup(db, { url, dir, s3: s3cfg, env, now: evening });
  assert.equal(basename(r.file), "kumi-2026-11-30T2139.dump");
  for (const f of ["kumi-2026-11-30T0317.dump", "kumi-2026-11-30T0317-2.dump", "kumi-2026-11-30T2139.dump"]) assert.ok(readdirSync(dir).includes(f), f);
  const daily = [...s3.objects.keys()].filter((k) => k.startsWith("club/daily/kumi-2026-11-30") && k.endsWith(".dump.enc")).sort();
  assert.deepEqual(daily, ["club/daily/kumi-2026-11-30T0317-2.dump.enc", "club/daily/kumi-2026-11-30T2139.dump.enc"]);
  assert.equal(r.offsite!.monthly, null);   // November's monthly copy is the first good backup of the club's month
  assert.ok(s3.objects.get("club/monthly/kumi-2026-11.dump.enc")!.equals(first));
  // The newest is the evening's, here and offsite, and an old one-a-day name still reads.
  writeFileSync(join(dir, "kumi-2026-11-29.dump"), "PGDMP old");
  assert.equal(basename(newestLocal(dir)!.file), "kumi-2026-11-30T2139.dump");
  assert.equal((await offsiteLatest(new S3Client(s3cfg), "club/"))!.dump, "club/daily/kumi-2026-11-30T2139.dump.enc");
  rmSync(join(dir, "kumi-2026-11-29.dump"));
});

test("an offsite copy that fails is recorded, and the owner and managers are told once", { skip }, async () => {
  const bad = { endpoint: s3.url, bucket: creds.bucket, accessKeyId: creds.accessKeyId, secretAccessKey: "wrong", region: creds.region, pathStyle: true };
  await assert.rejects(nightlyBackup(db, { url, dir, s3: bad, env, now: NOW }), /SignatureDoesNotMatch/);
  await assert.rejects(nightlyBackup(db, { url, dir, s3: bad, env, now: NOW }), /SignatureDoesNotMatch/);
  assert.match((await heartbeat(db, "offsite"))!.last_error!, /HTTP 403 SignatureDoesNotMatch/);
  assert.equal((await heartbeat(db, "backup"))!.last_error, null);   // the local backup itself worked
  const told = await db.selectFrom("event_outbox").select("topic").where("topic", "=", "ops.failed").execute();
  assert.equal(told.length, 1);
  // Without the backup key, nothing goes offsite.
  await assert.rejects(nightlyBackup(db, { url, dir, s3: bad, env: { ...env, KUMI_BACKUP_KEY: "" }, now: NOW }), /KUMI_BACKUP_KEY isn't set/);
});

test("comparing counts: exact against a manifest, loose against the live database", () => {
  assert.deepEqual(compareCounts({ a: 1, b: 2 }, { a: 1, b: 2 }, true), []);
  assert.deepEqual(compareCounts({ a: 1 }, { a: 2, b: 0 }, true), ["b is missing", "a has 1 rows, the manifest says 2"]);
  assert.deepEqual(compareCounts({ a: 1, schema_migration: 40 }, { a: 5, b: 1, schema_migration: 45 }, false), []);
  assert.deepEqual(compareCounts({ z: 1, schema_migration: 46 }, { schema_migration: 45 }, false), ["z isn't in the live database", "the backup has more migrations than the live database"]);
  void utimesSync;
});

test("the scratch database sits beside the live one, whatever form the URL takes", () => {
  assert.equal(scratchUrl("postgresql://kumi@/kumi?host=/var/run/postgresql", {}), "postgresql://kumi@/kumi_restore_test?host=/var/run/postgresql");
  assert.equal(scratchUrl("postgresql://kumi:p%40ss@db/kumi", {}), "postgresql://kumi:p%40ss@db/kumi_restore_test");
  assert.equal(scratchUrl("postgresql://kumi@db/kumi", { KUMI_RESTORE_TEST_DATABASE_URL: "postgresql://kumi@db/other" }), "postgresql://kumi@db/other");
});

test("the nightly and monthly slots are on the club's clock, whatever the server's is", () => {
  const LA = "America/Los_Angeles";
  // 4:17 AM in Portland is 12:17 UTC: tonight's slot was 3:00 AM there (11:00 UTC), not 3:00 UTC.
  assert.equal(lastSlot(new Date("2026-11-30T12:17:00Z"), LA, SCHEDULE.backup).toISOString(), "2026-11-30T11:00:00.000Z");
  // 2:17 AM there: tonight's hasn't come, so the last one was the night before.
  assert.equal(lastSlot(new Date("2026-11-30T10:17:00Z"), LA, SCHEDULE.backup).toISOString(), "2026-11-29T11:00:00.000Z");
  // Across the clock change: 3 AM is 10:00 UTC in summer time.
  assert.equal(lastSlot(new Date("2026-07-04T10:17:00Z"), LA, SCHEDULE.backup).toISOString(), "2026-07-04T10:00:00.000Z");
  // The restore test: the 1st at 4 AM; before it on New Year's Day, the one before is December's.
  assert.equal(lastSlot(new Date("2026-12-15T00:00:00Z"), LA, SCHEDULE.restore_test).toISOString(), "2026-12-01T12:00:00.000Z");
  assert.equal(lastSlot(new Date("2027-01-01T11:47:00Z"), LA, SCHEDULE.restore_test).toISOString(), "2026-12-01T12:00:00.000Z");
  assert.equal(lastSlot(new Date("2027-01-01T12:47:00Z"), LA, SCHEDULE.restore_test).toISOString(), "2027-01-01T12:00:00.000Z");
});

test("each hourly tick runs a job only when it's due, and a missed night catches up", { skip }, async () => {
  await jobWorked(db, "backup", {}, new Date("2026-11-30T11:17:00Z"));        // last night's, at 3:17 AM club time
  assert.equal((await scheduledDue(db, "backup", new Date("2026-11-30T12:17:00Z"))).due, false);
  assert.equal((await scheduledDue(db, "backup", new Date("2026-12-01T10:17:00Z"))).due, false);   // 2:17 AM: not yet
  const d = await scheduledDue(db, "backup", new Date("2026-12-01T11:17:00Z"));
  assert.deepEqual([d.due, d.tz], [true, "America/Los_Angeles"]);
  // The server was off at 3 AM: its first tick afterwards, at 9:17 AM, catches up.
  assert.equal((await scheduledDue(db, "backup", new Date("2026-12-01T17:17:00Z"))).due, true);
  await jobWorked(db, "restore_test", {}, new Date("2026-11-01T12:47:00Z"));
  assert.equal((await scheduledDue(db, "restore_test", new Date("2026-11-30T12:47:00Z"))).due, false);
  assert.equal((await scheduledDue(db, "restore_test", new Date("2026-12-01T11:47:00Z"))).due, false);   // 3:47 AM on the 1st
  assert.equal((await scheduledDue(db, "restore_test", new Date("2026-12-01T12:47:00Z"))).due, true);
});

test("a restore keeps the server's own job records, not the ones the backup remembered", { skip }, async () => {
  await jobWorked(db, "restore_test", {}, new Date("2026-11-01T12:47:00Z"));
  const made = await makeBackup(db, { url, dir, now: new Date("2026-11-30T11:17:00Z"), env, label: "ops-records" });
  await jobWorked(db, "restore_test", { rows: 1 }, new Date("2026-12-01T12:47:00Z"));   // after the backup was made
  const kept = await readOpsRecords(url);
  await restoreInto(url, made.file);
  assert.equal((await heartbeat(db, "restore_test"))!.last_ok_at!.toISOString(), "2026-11-01T12:47:00.000Z");   // what the dump had
  await writeOpsRecords(url, kept);
  const after = (await heartbeat(db, "restore_test"))!;
  assert.deepEqual([after.last_ok_at!.toISOString(), after.details], ["2026-12-01T12:47:00.000Z", { rows: 1 }]);
});

test("the restore test refuses a scratch database that is the live one, and leaves it alone", { skip }, async () => {
  const people = await db.selectFrom("person").select((e) => e.fn.countAll().as("n")).executeTakeFirstOrThrow();
  await assert.rejects(restoreTest(db, { liveUrl: url, dir, s3: null, key: null, prefix: "club/", env: { ...env, KUMI_RESTORE_TEST_DATABASE_URL: url }, now: NOW }), /is the live database/);
  assert.deepEqual(await db.selectFrom("person").select((e) => e.fn.countAll().as("n")).executeTakeFirstOrThrow(), people);
  assert.equal(await isSameDatabase(db, url), true);
  assert.equal(await isSameDatabase(db, ADMIN), false);
});

test("with KUMI_OFFSITE_PRUNE=0 Kumi never deletes offsite: the storage's own rules expire old copies", async () => {
  const store = await fakeS3(creds);
  const tmp = mkdtempSync(join(tmpdir(), "kumi-prune-"));
  try {
    const s3c = new S3Client({ endpoint: store.url, bucket: creds.bucket, accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, region: creds.region, pathStyle: true });
    // 35 days of daily copies, more than the 30 days Kumi keeps.
    const days = Array.from({ length: 35 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
    for (const d of days) await s3c.put(`p/daily/kumi-${d}T0317.dump.enc`, Buffer.from("old"));
    const file = join(tmp, "kumi-2026-11-30T0317.dump"); writeFileSync(file, "dump");
    const keep = await offsitePush(s3c, { file, manifestFile: null, key: KEY, prefix: "p/", now: NOW, tz: "America/Los_Angeles", prune: false });
    assert.deepEqual(keep.dropped, []);
    assert.equal([...store.objects.keys()].filter((k) => days.some((d) => k.includes(d))).length, 35);
    assert.equal(offsitePrunes({ KUMI_OFFSITE_PRUNE: "0" }), false);
    assert.equal(offsitePrunes({}), true);
    const pruned = await offsitePush(s3c, { file, manifestFile: null, key: KEY, prefix: "p/", now: NOW, tz: "America/Los_Angeles" });
    assert.equal(pruned.dropped.length, 6, "by default Kumi keeps the newest 30 days itself");
  } finally { await store.close(); rmSync(tmp, { recursive: true, force: true }); }
});
