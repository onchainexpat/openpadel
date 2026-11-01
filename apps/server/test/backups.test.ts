// Backups against a real Postgres 17: the dump and its manifest from one snapshot, restoring into a scratch
// database, the restore test (local and offsite), and the nightly job's records. These need pg_dump and
// pg_restore 17 (KUMI_PG_BIN, or /usr/lib/postgresql/17/bin); without them they're skipped, unless
// KUMI_REQUIRE_PG_TOOLS=1 says they must run (CI installs the tools).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { heartbeat, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { compareCounts, makeBackup, nightlyBackup, openBackup, pgTool, restoreInto, restoreTest, scratchUrl, tidyLocal, type Manifest } from "../src/backups.ts";
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
  assert.equal(r.file, join(dir, "kumi-2026-11-30.dump"));
  const m = JSON.parse(readFileSync(r.manifestFile, "utf8")) as Manifest;
  assert.equal(m.kind, "kumi-backup");
  assert.equal(m.tables.person, Number((await sql<{ n: string }>`SELECT count(*) AS n FROM person`.execute(db)).rows[0]!.n));
  assert.ok(m.tables.schema_migration! > 40);
  assert.equal(readFileSync(r.file).subarray(0, 5).toString(), "PGDMP");
  // A labelled one (before an update) is named for it and left alone by the tidying.
  const labelled = await makeBackup(db, { url, dir, now: NOW, label: "update-abc-to-def", env });
  assert.equal(labelled.file, join(dir, "kumi-update-abc-to-def.dump"));
});

test("nightly files older than 14 days are tidied; others are left", { skip }, () => {
  writeFileSync(join(dir, "kumi-2026-11-01.dump"), "old"); writeFileSync(join(dir, "kumi-2026-11-01.json"), "{}");
  writeFileSync(join(dir, "kumi-2026-11-20.dump"), "recent");
  assert.deepEqual(tidyLocal(dir, NOW).sort(), ["kumi-2026-11-01.dump", "kumi-2026-11-01.json"]);
  assert.ok(readdirSync(dir).includes("kumi-2026-11-20.dump") && readdirSync(dir).includes("kumi-update-abc-to-def.dump"));
});

test("restoring into a scratch database brings back every table and row", { skip }, async () => {
  const scratch = await freshDb();   // a migrated database: the restore empties it first
  try {
    const scratchUrl = ADMIN.replace(/\/[^/]*$/, `/${(await sql<{ d: string }>`SELECT current_database() AS d`.execute(scratch.db)).rows[0]!.d}`);
    await restoreInto(scratchUrl, join(dir, "kumi-2026-11-30.dump"), env);
    const names = await scratch.db.selectFrom("person").select("display_name").orderBy("display_name").execute();
    assert.deepEqual(names.map((n) => n.display_name), ["Ann", "Ben", "Cy", "Robin Hale"]);
  } finally { await scratch.drop(); }
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
  assert.equal(r.offsite!.key, "club/daily/kumi-2026-11-30.dump.enc");
  assert.equal(r.offsite!.monthly, "club/monthly/kumi-2026-11.dump.enc");
  const sealed = s3.objects.get("club/daily/kumi-2026-11-30.dump.enc")!;
  assert.ok(!sealed.includes(Buffer.from("PGDMP")));
  assert.equal(openBackup(sealed, KEY).subarray(0, 5).toString(), "PGDMP");
  assert.equal((await heartbeat(db, "backup"))!.last_error, null);
  assert.equal(((await heartbeat(db, "offsite"))!.details as any).bucket, creds.bucket);
  const rt = await restoreTest(db, { liveUrl: url, dir, s3: new S3Client(s3cfg), key: KEY, prefix: "club/", env: { ...env, KUMI_RESTORE_TEST_DATABASE_URL: ADMIN.replace(/\/[^/]*$/, `/kumi_rt2_${process.pid}`) }, now: NOW });
  assert.equal(rt.ok, true, rt.problems.join("; "));
  assert.equal(rt.source, "club/daily/kumi-2026-11-30.dump.enc");
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
